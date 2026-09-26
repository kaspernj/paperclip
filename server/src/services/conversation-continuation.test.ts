import { describe, expect, it } from "vitest";
import {
  CONVERSATION_ADAPTER_TYPES,
  conversationContinuationEligibleForOutcome,
  getConversationOwnershipBlocker,
  hasVerifiedGatewayRemoteTerminal,
  hasVerifiedHermesRemoteTerminal,
  isConversationAdapter,
} from "./conversation-continuation.js";

describe("adapter classification", () => {
  it("treats the Hermes gateway as a conversation adapter", () => {
    expect(isConversationAdapter("hermes_gateway")).toBe(true);
    expect(CONVERSATION_ADAPTER_TYPES).toContain("hermes_gateway");
    expect(isConversationAdapter("hermes_local")).toBe(true);
  });
});

describe("verified remote terminal evidence", () => {
  it("accepts only a terminal remote status recorded in the run evidence", () => {
    for (const status of [
      "completed", "failed", "error", "cancelled", "canceled", "stopped", "interrupted",
    ]) {
      expect(hasVerifiedHermesRemoteTerminal({
        hermesRemoteTerminal: { status, source: "stop_verification", observedAt: "2026-09-25T15:03:41Z" },
      })).toBe(true);
    }
    expect(hasVerifiedHermesRemoteTerminal(undefined)).toBe(false);
    expect(hasVerifiedHermesRemoteTerminal({})).toBe(false);
    expect(hasVerifiedHermesRemoteTerminal({ hermesRemoteTerminal: {} })).toBe(false);
    expect(hasVerifiedHermesRemoteTerminal({ hermesRemoteTerminal: { status: "stopping" } })).toBe(false);
    expect(hasVerifiedHermesRemoteTerminal({ hermesRemoteTerminal: { status: "running" } })).toBe(false);
    expect(hasVerifiedHermesRemoteTerminal({ hermesRemoteTerminal: { status: 7 } })).toBe(false);
  });

  it("accepts an acknowledged gateway cancellation as verified", () => {
    expect(hasVerifiedGatewayRemoteTerminal({
      status: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged", remoteRunId: "run-ack-1", remoteStatus: "cancelled" } },
    })).toBe(true);
    // A local-adapter acknowledgement (no remote run id) is a different
    // contract and never verifies a remote terminal.
    expect(hasVerifiedGatewayRemoteTerminal({
      status: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged", remoteStatus: "cancelled" } },
    })).toBe(false);
    expect(hasVerifiedGatewayRemoteTerminal({
      status: "cancelled",
      resultJson: { executionCancellation: { state: "requested" } },
    })).toBe(false);
    expect(hasVerifiedGatewayRemoteTerminal({
      status: "timed_out",
      resultJson: { executionCancellation: { state: "acknowledged", remoteStatus: "cancelled" } },
    })).toBe(false);
    expect(hasVerifiedGatewayRemoteTerminal({
      status: "failed",
      resultJson: { hermesRemoteTerminal: { status: "failed", source: "poll" } },
    })).toBe(true);
  });
});

describe("conversationContinuationEligibleForOutcome", () => {
  const eligible = (input: Record<string, unknown>) =>
    conversationContinuationEligibleForOutcome(input as never);

  it("stamps gateway outcomes only with verified remote terminals", () => {
    expect(eligible({
      adapterType: "hermes_gateway", outcome: "cancelled", conversationContinuationEligible: true,
      result: {
        executionCancellation: { state: "acknowledged", remoteRunId: "run-1", remoteStatus: "cancelled" },
        hermesRemoteTerminal: { status: "cancelled", source: "stop_verification" },
      },
    })).toBe(true);
    expect(eligible({
      adapterType: "hermes_gateway", outcome: "cancelled", conversationContinuationEligible: true,
      result: { executionCancellation: { state: "acknowledged", remoteRunId: "run-1", remoteStatus: "cancelled" } },
    })).toBe(true);
    expect(eligible({
      adapterType: "hermes_gateway", outcome: "cancelled", conversationContinuationEligible: true,
      result: { executionCancellation: { state: "acknowledged" } },
    })).toBe(false);
    expect(eligible({
      adapterType: "hermes_gateway", outcome: "cancelled", conversationContinuationEligible: true,
      result: { executionCancellation: { state: "requested" } },
    })).toBe(false);
    expect(eligible({
      adapterType: "hermes_gateway", outcome: "timed_out", conversationContinuationEligible: true,
      result: { hermesRemoteTerminal: { status: "cancelled", source: "stop_verification" } },
    })).toBe(true);
    expect(eligible({
      adapterType: "hermes_gateway", outcome: "timed_out", conversationContinuationEligible: true,
      result: {},
    })).toBe(false);
    expect(eligible({
      adapterType: "hermes_gateway", outcome: "failed", conversationContinuationEligible: true,
      result: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    })).toBe(false);
    expect(eligible({
      adapterType: "hermes_gateway", outcome: "succeeded", conversationContinuationEligible: true,
      result: { hermesRemoteTerminal: { status: "completed", source: "event" } },
    })).toBe(false);
  });

  it("keeps the existing decision for non-gateway adapters", () => {
    expect(eligible({
      adapterType: "claude_local", outcome: "cancelled", conversationContinuationEligible: true,
      result: { executionCancellation: { state: "acknowledged" } },
    })).toBe(true);
    expect(eligible({
      adapterType: "claude_local", outcome: "cancelled", conversationContinuationEligible: true,
      result: {},
    })).toBe(false);
    expect(eligible({
      adapterType: "claude_local", outcome: "timed_out", conversationContinuationEligible: true,
      result: {},
    })).toBe(true);
    expect(eligible({
      adapterType: "claude_local", outcome: "succeeded", conversationContinuationEligible: true,
      result: {},
    })).toBe(false);
    expect(eligible({
      adapterType: "paperclip_runner", outcome: "timed_out", conversationContinuationEligible: true,
      result: {},
    })).toBe(false);
    expect(eligible({
      adapterType: "claude_local", outcome: "timed_out", conversationContinuationEligible: false,
      result: {},
    })).toBe(false);
  });
});

describe("conversation ownership blocker", () => {
  function blockerDb(rows: unknown[]) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => rows.map((row) => ({ run: row, activeLease: false })),
          }),
        }),
      }),
    } as unknown as Parameters<typeof getConversationOwnershipBlocker>[0];
  }

  const gatewayRun = (resultJson: Record<string, unknown>) => ({
    id: "run-gw-1", agentId: "agent-1", companyId: "company-1",
    processPid: null, processGroupId: null, processStartedAt: null,
    runnerProfileJson: { adapterDispatch: { adapterType: "hermes_gateway" } },
    resultJson, status: "cancelled",
  });

  it("blocks an unverified gateway remote state with an actionable cause", async () => {
    const blocker = await getConversationOwnershipBlocker(
      blockerDb([gatewayRun({ executionCancellation: { state: "requested" } })]),
      "company-1", "issue-1",
    );
    expect(blocker).toMatchObject({
      runId: "run-gw-1", agentId: "agent-1", cause: "remote_state_unverified",
    });
    expect(blocker!.nextAction).toMatch(/recovery action/);
    expect(blocker!.nextAction).toMatch(/reconcile|reconciliation/i);
  });

  it("releases a gateway run once the remote terminal is verified", async () => {
    const db = (rows: unknown[]) => blockerDb(rows);
    expect(await getConversationOwnershipBlocker(
      db([gatewayRun({ hermesRemoteTerminal: { status: "cancelled", source: "stop_verification" } })]),
      "company-1", "issue-1",
    )).toBeNull();
    expect(await getConversationOwnershipBlocker(
      db([gatewayRun({ executionCancellation: { state: "acknowledged", remoteRunId: "run-1", remoteStatus: "cancelled" } })]),
      "company-1", "issue-1",
    )).toBeNull();
  });

  it("releases a gateway run that never started provider work", async () => {
    expect(await getConversationOwnershipBlocker(
      blockerDb([gatewayRun({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } })]),
      "company-1", "issue-1",
    )).toBeNull();
  });

  it("keeps the existing process proof for local runs", async () => {
    const live = {
      id: "run-local-1", agentId: "agent-1", companyId: "company-1",
      processPid: process.pid, processGroupId: null, processStartedAt: null,
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } }, resultJson: {},
    };
    const blocker = await getConversationOwnershipBlocker(
      blockerDb([live]), "company-1", "issue-1",
    );
    expect(blocker).toMatchObject({ cause: "execution_owner_active" });
    const dead = { ...live, processPid: 999999999 };
    expect(await getConversationOwnershipBlocker(
      blockerDb([dead]), "company-1", "issue-1",
    )).toBeNull();
  });
});
