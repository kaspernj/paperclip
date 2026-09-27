import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { readProcessStartedAt } from "./hot-restart.js";

// These adapters accept a conversation turn. Retrying a process or webhook can
// replay the action itself, so those adapters retain their recovery contract.
// hermes_gateway runs remotely; its continuation is additionally gated on a
// verified remote terminal (see hasVerifiedGatewayRemoteTerminal).
export const CONVERSATION_ADAPTER_TYPES = [
  "claude_local", "codex_local", "cursor", "gemini_local", "opencode_local",
  "pi_local", "grok_local", "kimi_local", "hermes_local", "hermes_gateway",
] as const;

export function isConversationAdapter(adapterType: string): boolean {
  return (CONVERSATION_ADAPTER_TYPES as readonly string[]).includes(adapterType);
}

export const CONVERSATION_CONTINUATION_POLICY = "continue_conversation_v1";

export function hasConversationContinuationPolicy(result: Record<string, unknown> | null | undefined): boolean {
  return result?.conversationContinuation === CONVERSATION_CONTINUATION_POLICY;
}

/** Remote statuses that prove the Hermes run stopped. "stopping" does not. */
const GATEWAY_TERMINAL_RUN_STATUSES = new Set([
  "completed", "failed", "error", "cancelled", "canceled", "stopped", "interrupted",
]);

/** Authoritative observation of the remote Hermes run's terminal state. */
export function hasVerifiedHermesRemoteTerminal(result: Record<string, unknown> | null | undefined): boolean {
  const terminal = result?.hermesRemoteTerminal as Record<string, unknown> | undefined;
  return typeof terminal?.status === "string" && GATEWAY_TERMINAL_RUN_STATUSES.has(terminal.status);
}

/** A gateway cancellation only releases the turn once the remote terminal is
 * verified: the gateway adapter writes "acknowledged" only after observing a
 * terminal, and it always records the remote run id with the acknowledgement.
 * Local-adapter acknowledgements (no remoteRunId) are a different contract and
 * do not count. */
export function hasVerifiedGatewayRemoteTerminal(
  run: Pick<typeof heartbeatRuns.$inferSelect, "status" | "resultJson">,
): boolean {
  if (hasVerifiedHermesRemoteTerminal(run.resultJson)) return true;
  const cancellation = run.resultJson?.executionCancellation as Record<string, unknown> | undefined;
  return run.status === "cancelled" && cancellation?.state === "acknowledged" &&
    typeof cancellation.remoteRunId === "string";
}

/** Bootstrap evidence proves no remote run was ever created. */
export function gatewayRunNeverDispatched(
  run: Pick<typeof heartbeatRuns.$inferSelect, "resultJson">,
): boolean {
  const recovery = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  return recovery?.kind === "bootstrap" && recovery.providerWorkStarted === false;
}

/** Single decision point for the conversation-continuation stamp. Non-gateway
 * adapters keep the historical conditions; gateway outcomes additionally need
 * a verified remote terminal so an unverified remote state cannot unlock the
 * conversation. */
export function conversationContinuationEligibleForOutcome(input: {
  adapterType: string;
  outcome: "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out";
  result: Record<string, unknown> | null | undefined;
  conversationContinuationEligible?: boolean;
}): boolean {
  if (input.conversationContinuationEligible === false) return false;
  if (input.outcome === "succeeded") return false;
  if (!isConversationAdapter(input.adapterType)) return false;
  const cancellation = input.result?.executionCancellation as Record<string, unknown> | undefined;
  if (input.outcome === "cancelled" && cancellation?.state !== "acknowledged") return false;
  if (input.adapterType === "hermes_gateway") {
    return hasVerifiedGatewayRemoteTerminal({ status: input.outcome, resultJson: input.result ?? null });
  }
  return true;
}

/** Persisted by the server when it claims the run, before remote provisioning. */
export function claimedAdapterType(run: Pick<typeof heartbeatRuns.$inferSelect, "runnerProfileJson">): string | null {
  const dispatch = run.runnerProfileJson?.adapterDispatch as Record<string, unknown> | undefined;
  return typeof dispatch?.adapterType === "string" ? dispatch.adapterType : null;
}

function conversationRunPredicate() {
  return or(
    inArray(sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType'`, [...CONVERSATION_ADAPTER_TYPES]),
    sql`${heartbeatRuns.resultJson}->>'conversationContinuation' = ${CONVERSATION_CONTINUATION_POLICY}`,
    sql`exists (
      select 1 from ${heartbeatRunEvents}
      where ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId}
        and ${heartbeatRunEvents.runId} = ${heartbeatRuns.id}
        and ${heartbeatRunEvents.eventType} = 'adapter.invoke'
        and ${inArray(sql`${heartbeatRunEvents.payload}->>'adapterType'`, [...CONVERSATION_ADAPTER_TYPES])}
    )`,
  );
}

/** Recovery must not infer the old adapter from the agent's mutable settings. */
export async function historicalAdapterType(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<string | null> {
  const selected = claimedAdapterType(run);
  if (selected) return selected;
  const [invocation] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke")))
    .orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const adapterType = invocation?.payload?.adapterType;
  return typeof adapterType === "string" ? adapterType : null;
}

export async function runUsedConversationAdapter(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<boolean> {
  if (hasConversationContinuationPolicy(run.resultJson)) return true;
  const adapterType = await historicalAdapterType(db, run);
  return adapterType !== null && isConversationAdapter(adapterType);
}

/** Only immutable run evidence can retire a historical conversation hold.
 * An agent's current adapter can differ from the one that executed this run.
 * Missing evidence retains the hold; the current agent is never a fallback.
 */
export function conversationRecoveryActionPredicate() {
  return and(
    eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
    sql`exists (
      select 1 from ${heartbeatRuns}
      where ${heartbeatRuns.companyId} = ${issueRecoveryActions.companyId}
        and ${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'
        and coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueRecoveryActions.sourceIssueId}::text
        and ${heartbeatRuns.runtimeMode} = 'legacy'
        and ${inArray(heartbeatRuns.status, ['failed', 'timed_out', 'interrupted', 'cancelled'])}
        and ${conversationRunPredicate()}
        and ${or(
          sql`${heartbeatRuns.resultJson}->>'conversationContinuation' = ${CONVERSATION_CONTINUATION_POLICY}`,
          eq(heartbeatRuns.status, "interrupted"),
          inArray(heartbeatRuns.errorCode, ["process_lost", "server_shutdown_interrupted", "execution_reconciliation_required"]),
          and(eq(heartbeatRuns.status, "cancelled"), sql`${heartbeatRuns.resultJson}->'executionCancellation'->>'state' = 'acknowledged'`),
        )}
    )`,
  );
}

/** OS liveness probes do not signal or stop the process. Unknown ownership holds. */
function processMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** A terminal conversation row does not prove that its execution authority ended.
 * Other adapters keep their existing bootstrap and ownership protocols.
 */
export async function getConversationOwnershipBlocker(db: Db, companyId: string, issueId: string) {
  const activeLease = sql`exists (select 1 from ${environmentLeases}
    where ${environmentLeases.companyId} = "heartbeat_runs"."company_id"
      and ${environmentLeases.heartbeatRunId} = "heartbeat_runs"."id"
      and (${environmentLeases.releasedAt} is null
        or ${environmentLeases.status} = 'pending_cleanup'
        or ${environmentLeases.cleanupStatus} = 'failed'))`;
  const candidates = await db.select({ run: heartbeatRuns, activeLease }).from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.runtimeMode, "legacy"),
      conversationRunPredicate(),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`,
      inArray(heartbeatRuns.status, ["failed", "timed_out", "interrupted", "cancelled"]),
      or(
        isNotNull(heartbeatRuns.processPid),
        isNotNull(heartbeatRuns.processGroupId),
        activeLease,
        // Gateway runs have no local process or lease; their executor is
        // remote, so they are candidates on their own.
        sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType' = 'hermes_gateway'`,
      ),
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  for (const { run, activeLease: leaseHeld } of candidates) {
    if (claimedAdapterType(run) === "hermes_gateway") {
      // Local PID proofs say nothing about a remote executor. Only verified
      // remote terminal evidence (or proof no remote run was created)
      // releases the turn; unknown remote state stays blocked.
      if (gatewayRunNeverDispatched(run) || hasVerifiedGatewayRemoteTerminal(run)) continue;
      return {
        runId: run.id,
        agentId: run.agentId,
        cause: "remote_state_unverified",
        nextAction:
          "The remote Hermes gateway run has not been verified as stopped. Verify its terminal state at the gateway (authenticated GET /v1/runs/<run id>) and reconcile its outcome through the task's recovery action before continuing.",
      };
    }
    let pidAlive = run.processPid !== null && processMayBeAlive(run.processPid);
    if (pidAlive && run.processStartedAt) {
      // A recycled PID cannot keep an old task blocked. An unreadable identity
      // stays conservative; the original process may still own execution.
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) pidAlive = false;
    }
    const groupAlive = run.processGroupId !== null && processMayBeAlive(-run.processGroupId);
    if (pidAlive || groupAlive || leaseHeld) {
      return {
        runId: run.id,
        agentId: run.agentId,
        cause: "execution_owner_active",
        nextAction: pidAlive || groupAlive
          ? "The previous provider process is still running. Stop it before continuing this task."
          : "The previous execution has not released its environment lease. Wait for cleanup before continuing this task.",
      };
    }
  }
  return null;
}
