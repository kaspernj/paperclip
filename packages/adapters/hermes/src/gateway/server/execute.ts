import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  isPaperclipRecoveryWakePayload,
  selectPaperclipTaskMarkdown,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ADAPTER_TYPE,
  DEFAULT_EVENT_RECONNECT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STOP_ACK_SEC,
  DEFAULT_TIMEOUT_SEC,
} from "../shared/constants.js";
import {
  allowsInsecureRemoteHttp,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";

type SessionKeyStrategy = "issue" | "agent" | "run" | "none";

type SseFrame = {
  event: string | null;
  data: string;
};

type HermesHttpError = Error & {
  status?: number;
  code?: string;
  retryNotBefore?: string | null;
  body?: unknown;
  /** OS error code of the underlying network failure (e.g. ECONNREFUSED). */
  causeCode?: string | null;
};

type TerminalState = {
  runId: string;
  status: string;
  eventName?: string | null;
  payload?: Record<string, unknown> | null;
  output?: string | null;
  observedAt?: string;
};

/** Authoritative observation of the remote Hermes run's terminal state. */
type RemoteTerminalEvidence = {
  status: string;
  source: "event" | "poll" | "stop_verification";
  observedAt: string;
};

type ExecutionState = {
  runId: string;
  outputChunks: string[];
  lastEventName: string | null;
  terminal: TerminalState | null;
  resolveTerminal: (state: TerminalState) => void;
  terminalPromise: Promise<TerminalState>;
};

type TextRedactor = (value: string) => string;

const CRITICAL_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "idempotency-key",
  "x-hermes-session-key",
]);

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(auth|authorization|token|secret|password|api[_-]?key|private[_-]?key)([_-]|$)/i;
const BEARER_TOKEN_PATTERN = /Bearer\s+\S+/gi;
const HERMES_SESSION_KEY_HEADER_PATTERN = /(X-Hermes-Session-Key\s*[:=]\s*)([^\s,;]+)/gi;
const PAPERCLIP_SESSION_KEY_PATTERN =
  /\bpaperclip:(?:company:[A-Za-z0-9-]+:agent:[A-Za-z0-9-]+(?::(?:issue|run):[A-Za-z0-9-]+)?|run:[A-Za-z0-9-]+)\b/gi;

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "stopped",
  "interrupted",
]);

const FAILURE_STATUSES = new Set(["failed", "error"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "stopped", "interrupted"]);
const DEFAULT_HERMES_DASHBOARD_PORT = "9119";
const HERMES_DASHBOARD_API_PATHS = new Set(["", "/", "/chat"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const raw = asString(value, "issue").trim().toLowerCase();
  if (raw === "agent" || raw === "run" || raw === "none") return raw;
  return "issue";
}

function normalizeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    if (
      url.port === DEFAULT_HERMES_DASHBOARD_PORT &&
      HERMES_DASHBOARD_API_PATHS.has(normalizedPath)
    ) {
      url.pathname = "/api";
    } else {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function apiUrl(baseUrl: URL, path: string): string {
  const base = baseUrl.toString().replace(/\/+$/, "");
  return `${base}${path}`;
}

function issueIdFromContext(ctx: AdapterExecutionContext): string | null {
  return nonEmpty(ctx.context.taskId) ?? nonEmpty(ctx.context.issueId);
}

export function resolveSessionKey(input: {
  strategy: SessionKeyStrategy;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
}): string | null {
  if (input.strategy === "none") return null;
  if (input.strategy === "agent") {
    return `paperclip:company:${input.companyId}:agent:${input.agentId}`;
  }
  if (input.strategy === "run") {
    return `paperclip:run:${input.runId}`;
  }
  const issuePart = input.issueId ? `issue:${input.issueId}` : `run:${input.runId}`;
  return `paperclip:company:${input.companyId}:agent:${input.agentId}:${issuePart}`;
}

function stringifyForLog(value: unknown, maxChars = 4_000): string {
  const text = JSON.stringify(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function sanitizeSensitiveText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(HERMES_SESSION_KEY_HEADER_PATTERN, "$1[redacted]")
    .replace(PAPERCLIP_SESSION_KEY_PATTERN, "[redacted-session-key]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createTextRedactor(secrets: Array<string | null | undefined>): TextRedactor {
  const exactSecrets = [...new Set(secrets.filter((secret): secret is string => typeof secret === "string" && secret.length >= 4))]
    .sort((a, b) => b.length - a.length)
    .map((secret) => ({
      secret,
      regex: new RegExp(escapeRegExp(secret), "g"),
    }));

  return (value: string) => {
    let result = sanitizeSensitiveText(value);
    for (const entry of exactSecrets) {
      result = result.replace(entry.regex, `[redacted len=${entry.secret.length}]`);
    }
    return result;
  };
}

function redactForLog(value: unknown, keyPath: string[] = [], depth = 0, redactText: TextRedactor = sanitizeSensitiveText): unknown {
  const key = keyPath[keyPath.length - 1] ?? "";
  if (typeof value === "string") {
    if (SENSITIVE_KEY_PATTERN.test(key)) return `[redacted len=${value.length}]`;
    const sanitized = redactText(value);
    return sanitized.length > 500
      ? `${sanitized.slice(0, 500)}... [truncated ${sanitized.length - 500} chars]`
      : sanitized;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth > 5) return "[array-truncated]";
    return value.slice(0, 40).map((entry, index) => redactForLog(entry, [...keyPath, String(index)], depth + 1, redactText));
  }
  if (typeof value === "object") {
    if (depth > 5) return "[object-truncated]";
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      out[entryKey] = redactForLog(entryValue, [...keyPath, entryKey], depth + 1, redactText);
    }
    return out;
  }
  return redactText(String(value));
}

function parseHeaders(value: unknown): Record<string, string> {
  const source =
    typeof value === "string" && value.trim().length > 0
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return {};
          }
        })()
      : value;
  const parsed = parseObject(source);
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    const normalized = key.trim();
    if (!normalized || CRITICAL_HEADERS.has(normalized.toLowerCase())) continue;
    if (typeof entry === "string") headers[normalized] = entry;
  }
  return headers;
}

function buildHeaders(input: {
  apiKey: string;
  sessionKey: string | null;
  runId: string;
  extraHeaders: Record<string, string>;
  accept: string;
  contentType?: string;
}): Record<string, string> {
  return {
    ...input.extraHeaders,
    Authorization: `Bearer ${input.apiKey}`,
    Accept: input.accept,
    ...(input.contentType ? { "Content-Type": input.contentType } : {}),
    "Idempotency-Key": input.runId,
    ...(input.sessionKey ? { "X-Hermes-Session-Key": input.sessionKey } : {}),
  };
}

function buildInput(ctx: AdapterExecutionContext, paperclipApiUrl: string | null): string {
  // Stable session keys (issue/agent strategy) resume the same remote Hermes
  // conversation across runs; a stored session id from a prior run means that
  // conversation already received the task brief, so pick the compact
  // task-context variant under the shared resume rules.
  const sessionKeyStrategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);
  const resumedSession =
    (sessionKeyStrategy === "issue" || sessionKeyStrategy === "agent") &&
    Boolean(nonEmpty(ctx.runtime?.sessionId));
  const taskMarkdown = nonEmpty(selectPaperclipTaskMarkdown(ctx.context, { resumedSession }));
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake, {
    conversationMode: ctx.context.conversationMode === true,
    // The task-context markdown is the authoritative brief on this lane; keep
    // the wake prompt's description copy out so the prompt carries it once.
    suppressIssueDescription: Boolean(taskMarkdown),
  });
  const wakePayloadJson = stringifyPaperclipWakePayload(ctx.context.paperclipWake, {
    omitIssueDescription: Boolean(taskMarkdown),
  });
  const sessionHandoff = nonEmpty(ctx.context.paperclipSessionHandoffMarkdown);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(ctx.context);
  const lines = [
    `You are ${ctx.agent.name}, an AI agent employee in a Paperclip-managed company.`,
    "",
    "Paperclip runtime identity:",
    `- Agent ID: ${ctx.agent.id}`,
    `- Company ID: ${ctx.agent.companyId}`,
    `- Run ID: ${ctx.runId}`,
    ...(paperclipApiUrl ? [`- Paperclip API URL: ${paperclipApiUrl}`] : []),
    ...(issueWorkMode ? [`- Issue work mode: ${issueWorkMode}`] : []),
    "",
    ...(ctx.context.conversationMode === true || isPaperclipRecoveryWakePayload(ctx.context.paperclipWake)
      ? []
      : [
          "Execution contract:",
          "- Take concrete action in this run when the task is actionable.",
          "- Do not stop at a plan unless the issue asks for planning only.",
          "- Leave durable progress and update the issue to a clear final disposition.",
          "- Use X-Paperclip-Run-Id on mutating Paperclip API requests when a Paperclip API key is available.",
          "",
        ]),
    wakePrompt,
    ...(sessionHandoff ? ["", sessionHandoff] : []),
    ...(taskMarkdown ? ["", taskMarkdown] : []),
    ...(wakePayloadJson
      ? [
          "",
          "Structured wake payload JSON:",
          "```json",
          wakePayloadJson,
          "```",
        ]
      : []),
  ];
  return lines.filter((line) => line !== null && line !== undefined).join("\n").trim();
}

function buildRunBody(ctx: AdapterExecutionContext, sessionKey: string | null): Record<string, unknown> {
  const paperclipApiUrl = nonEmpty(ctx.config.paperclipApiUrl);
  const payloadTemplate = parseObject(ctx.config.payloadTemplate);
  const configuredInput = nonEmpty(payloadTemplate.input);
  const input = configuredInput && ctx.context.conversationMode === true
    ? `${configuredInput}\n\n${buildInput(ctx, paperclipApiUrl)}`
    : configuredInput ?? buildInput(ctx, paperclipApiUrl);
  const instructions =
    nonEmpty(ctx.config.instructions) ??
    nonEmpty(payloadTemplate.instructions) ??
    "Follow the Paperclip wake instructions exactly. Do not expose secrets in logs, comments, or final output.";
  return {
    ...payloadTemplate,
    input,
    instructions,
    ...(sessionKey ? { session_id: sessionKey } : {}),
  };
}

async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function classifyHttpError(status: number): { code: string; family: AdapterExecutionResult["errorFamily"] | null } {
  if (status === 401 || status === 403) return { code: "hermes_gateway_auth_failed", family: null };
  if (status === 404) return { code: "hermes_gateway_runs_unsupported", family: null };
  if (status === 429) return { code: "hermes_gateway_rate_limited", family: "transient_upstream" };
  if (status >= 500) return { code: "hermes_gateway_upstream_error", family: "transient_upstream" };
  return { code: "hermes_gateway_protocol_error", family: null };
}

function fetchFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
  if (!cause || typeof cause !== "object") return message;

  const causeRecord = cause as { code?: unknown; message?: unknown };
  const causeMessage = typeof causeRecord.message === "string" ? causeRecord.message : "";
  const causeCode = typeof causeRecord.code === "string" ? causeRecord.code : "";
  if (!causeMessage || causeMessage === message) return causeCode ? `${message} (${causeCode})` : message;
  return causeCode ? `${message} (${causeCode}: ${causeMessage})` : `${message} (${causeMessage})`;
}

/** Connection failures that prove the request never reached the gateway. */
const CREATE_NO_START_NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** Whether a failed create proves the gateway never started remote work.
 * The Idempotency-Key is correlation only (Hermes v0.16.0 does not dedupe),
 * so anything that could have started a run — a 5xx after the request
 * arrived, a post-connect reset, an unknown failure — must stay a
 * reconciliation candidate instead of claiming no remote run exists. */
function createProvedNoRemoteStart(err: unknown): boolean {
  const hermesErr = err as HermesHttpError;
  if (typeof hermesErr.status === "number") {
    // A 4xx rejection (auth, validation, unsupported, rate limit) is the
    // gateway's answer before any run starts.
    return hermesErr.status >= 400 && hermesErr.status < 500;
  }
  return hermesErr.code === "hermes_gateway_connect_failed" &&
    typeof hermesErr.causeCode === "string" && CREATE_NO_START_NETWORK_CODES.has(hermesErr.causeCode);
}

async function fetchJson(input: RequestInfo | URL, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (err) {
    const fetchErr = new Error(`Hermes gateway request failed: ${fetchFailureMessage(err)}`) as HermesHttpError;
    fetchErr.code = "hermes_gateway_connect_failed";
    const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
    fetchErr.causeCode = cause && typeof cause === "object" &&
      typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : null;
    throw fetchErr;
  }
  const body = await readResponseJson(response);
  if (!response.ok) {
    const classified = classifyHttpError(response.status);
    const err = new Error(`Hermes gateway HTTP ${response.status}`) as HermesHttpError;
    err.status = response.status;
    err.code = classified.code;
    err.retryNotBefore = response.headers.get("retry-after");
    err.body = body;
    throw err;
  }
  return body;
}

function extractRunId(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.run_id) ?? nonEmpty(record?.runId) ?? nonEmpty(record?.id);
}

function eventNameFromData(data: unknown, fallback: string | null): string | null {
  const record = asRecord(data);
  return nonEmpty(record?.event) ?? nonEmpty(record?.type) ?? fallback;
}

function parseJsonData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return { text: data };
  }
}

export function parseSseFramesForTest(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames: SseFrame[] = [];
  let offset = 0;
  while (true) {
    const idx = normalized.indexOf("\n\n", offset);
    if (idx < 0) break;
    const rawFrame = normalized.slice(offset, idx);
    offset = idx + 2;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of rawFrame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
  }
  return { frames, rest: normalized.slice(offset) };
}

function createExecutionState(runId: string): ExecutionState {
  let resolveTerminal!: (state: TerminalState) => void;
  const terminalPromise = new Promise<TerminalState>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    runId,
    outputChunks: [],
    lastEventName: null,
    terminal: null,
    resolveTerminal,
    terminalPromise,
  };
}

function markTerminal(state: ExecutionState, terminal: TerminalState): void {
  if (state.terminal) return;
  state.terminal = { ...terminal, observedAt: terminal.observedAt ?? new Date().toISOString() };
  state.resolveTerminal(state.terminal);
}

function terminalSource(terminal: TerminalState): "event" | "poll" {
  return terminal.eventName ? "event" : "poll";
}

function naturalTerminalEvidence(terminal: TerminalState): RemoteTerminalEvidence {
  return {
    status: terminal.status,
    source: terminalSource(terminal),
    observedAt: terminal.observedAt ?? new Date().toISOString(),
  };
}

function extractStatus(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.status)?.toLowerCase() ?? null;
}

function extractOutput(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const direct =
    nonEmpty(record.output) ??
    nonEmpty(record.result) ??
    nonEmpty(record.text) ??
    nonEmpty(record.summary) ??
    nonEmpty(record.message);
  if (direct) return direct;
  const nested = asRecord(record.data) ?? asRecord(record.payload);
  return nested ? extractOutput(nested) : null;
}

async function handleEvent(
  ctx: AdapterExecutionContext,
  state: ExecutionState,
  frame: SseFrame,
  redactText: TextRedactor = sanitizeSensitiveText,
): Promise<void> {
  const parsed = parseJsonData(frame.data);
  const record = asRecord(parsed);
  const eventName = eventNameFromData(parsed, frame.event);
  state.lastEventName = eventName;
  await ctx.onLog(
    "stdout",
    `[hermes-gateway:event] run=${state.runId} event=${eventName ?? "message"} data=${stringifyForLog(redactForLog(parsed, [], 0, redactText), 8_000)}\n`,
  );

  const delta = nonEmpty(record?.delta) ?? nonEmpty(record?.text_delta);
  if (eventName === "message.delta" && delta) {
    const sanitizedDelta = redactText(delta);
    state.outputChunks.push(sanitizedDelta);
    await ctx.onLog("stdout", sanitizedDelta);
  }

  const status = extractStatus(parsed) ?? (eventName?.startsWith("run.") ? eventName.slice(4) : null);
  if (status && TERMINAL_STATUSES.has(status)) {
    markTerminal(state, {
      runId: state.runId,
      status,
      eventName,
      payload: record,
      output: extractOutput(parsed),
    });
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function pollStatus(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  state: ExecutionState;
  signal: AbortSignal;
  intervalMs: number;
  redactText?: TextRedactor;
}): Promise<void> {
  while (!input.signal.aborted && !input.state.terminal) {
    await delay(input.intervalMs, input.signal);
    if (input.signal.aborted || input.state.terminal) break;
    try {
      const status = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.state.runId)}`), {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
      });
      const normalized = extractStatus(status);
      if (normalized && TERMINAL_STATUSES.has(normalized)) {
        markTerminal(input.state, {
          runId: input.state.runId,
          status: normalized,
          payload: asRecord(status),
          output: extractOutput(status),
        });
      }
    } catch (err) {
      if (input.signal.aborted) return;
      await input.ctx.onLog("stderr", `[hermes-gateway] status poll failed: ${redactErrorMessage(err, input.redactText)}\n`);
    }
  }
}

async function consumeEvents(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  state: ExecutionState;
  signal: AbortSignal;
  reconnectMs: number;
  redactText?: TextRedactor;
}): Promise<void> {
  while (!input.signal.aborted && !input.state.terminal) {
    try {
      const response = await fetch(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.state.runId)}/events`), {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
      });
      if (!response.ok) {
        await input.ctx.onLog("stderr", `[hermes-gateway] event stream HTTP ${response.status}; falling back to polling\n`);
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      if (!response.body) {
        await input.ctx.onLog("stderr", "[hermes-gateway] event stream response had no body; falling back to polling\n");
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!input.signal.aborted && !input.state.terminal) {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer.trim().length > 0) {
            const parsed = parseSseFramesForTest(`${buffer}\n\n`);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
              await handleEvent(input.ctx, input.state, frame, input.redactText);
              if (input.state.terminal) break;
            }
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFramesForTest(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          await handleEvent(input.ctx, input.state, frame, input.redactText);
          if (input.state.terminal) break;
        }
      }
    } catch (err) {
      if (input.signal.aborted || input.state.terminal) return;
      await input.ctx.onLog("stderr", `[hermes-gateway] event stream disconnected: ${redactErrorMessage(err, input.redactText)}\n`);
    }
    if (!input.state.terminal) await delay(input.reconnectMs, input.signal);
  }
}

function parseUsage(value: unknown): UsageSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const source = asRecord(record.usage) ?? record;
  const inputTokens = asNumber(source.input_tokens ?? source.inputTokens ?? source.input, 0);
  const outputTokens = asNumber(source.output_tokens ?? source.outputTokens ?? source.output, 0);
  const cachedInputTokens = asNumber(source.cached_input_tokens ?? source.cachedInputTokens, 0);
  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

function parseCostUsd(value: unknown): number | null {
  const record = asRecord(value);
  const raw = record?.cost_usd ?? record?.costUsd ?? asRecord(record?.usage)?.cost_usd ?? asRecord(record?.usage)?.costUsd;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function extractSessionId(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.session_id) ?? nonEmpty(record?.sessionId) ?? nonEmpty(asRecord(record?.data)?.session_id);
}

function extractModel(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.model) ?? nonEmpty(asRecord(record?.usage)?.model);
}

function extractErrorMessage(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.error) ?? nonEmpty(record?.message) ?? nonEmpty(record?.detail) ?? extractOutput(value);
}

function terminalResultCode(status: string): { exitCode: number; signal: string | null; errorCode: string | null } {
  if (status === "completed") return { exitCode: 0, signal: null, errorCode: null };
  if (FAILURE_STATUSES.has(status)) return { exitCode: 1, signal: null, errorCode: "hermes_gateway_run_failed" };
  if (CANCELLED_STATUSES.has(status)) return { exitCode: 1, signal: "SIGTERM", errorCode: "hermes_gateway_cancelled" };
  return { exitCode: 1, signal: null, errorCode: "hermes_gateway_protocol_error" };
}

export function mapFinalResultForTest(input: {
  terminal: TerminalState;
  outputChunks: string[];
  sessionKey: string | null;
  strategy: SessionKeyStrategy;
  redactText?: TextRedactor;
  remoteTerminal?: RemoteTerminalEvidence | null;
  executionCancellation?: Record<string, unknown> | null;
}): AdapterExecutionResult {
  const redactText = input.redactText ?? sanitizeSensitiveText;
  const payload = input.terminal.payload ?? {};
  const output = redactText(
    input.terminal.output ?? extractOutput(payload) ?? input.outputChunks.join("").trim(),
  );
  const sessionId = extractSessionId(payload) ?? input.sessionKey;
  const sessionDisplayId = sessionId ? redactText(sessionId) : null;
  const mapped = terminalResultCode(input.terminal.status);
  const usage = parseUsage(payload);
  const costUsd = parseCostUsd(payload);
  const errorMessage = mapped.errorCode
    ? redactText(extractErrorMessage(payload) ?? `Hermes run ${input.terminal.status}`)
    : null;
  return {
    exitCode: mapped.exitCode,
    signal: mapped.signal,
    timedOut: false,
    provider: "hermes_gateway",
    model: extractModel(payload),
    ...(mapped.errorCode ? { errorCode: mapped.errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage } : {}),
    ...(costUsd !== null ? { costUsd } : {}),
    ...(output ? { summary: output.slice(0, 2_000) } : {}),
    sessionId: sessionDisplayId,
    sessionParams: {
      hermesRunId: input.terminal.runId,
      ...(sessionId && sessionDisplayId === sessionId ? { hermesSessionId: sessionId } : {}),
      strategy: input.strategy,
    },
    sessionDisplayId,
    resultJson: {
      run_id: input.terminal.runId,
      status: input.terminal.status,
      session_id: sessionDisplayId,
      last_event: input.terminal.eventName ?? null,
      output: output ?? "",
      usage: usage ?? null,
      cost_usd: costUsd,
      ...(input.remoteTerminal ? { hermesRemoteTerminal: input.remoteTerminal } : {}),
      ...(input.executionCancellation ? { executionCancellation: input.executionCancellation } : {}),
    },
  };
}

async function stopRun(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
  deadlineMs: number;
  redactText?: TextRedactor;
}): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.deadlineMs);
  try {
    const stopped = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}/stop`), {
      method: "POST",
      headers: input.headers,
      signal: controller.signal,
    });
    await input.ctx.onLog("stdout", `[hermes-gateway] stop requested for run ${input.runId}\n`);
    return asRecord(stopped);
  } catch (err) {
    if (controller.signal.aborted) {
      await input.ctx.onLog("stderr", `[hermes-gateway] stop request timed out after ${Math.round(input.deadlineMs / 1000)}s for run ${input.runId}\n`);
    } else {
      await input.ctx.onLog("stderr", `[hermes-gateway] stop request failed: ${redactErrorMessage(err, input.redactText)}\n`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFinalStatus(input: {
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
  deadlineMs: number;
}): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + input.deadlineMs;
  while (Date.now() < deadline) {
    try {
      const status = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}`), {
        method: "GET",
        headers: input.headers,
      });
      const record = asRecord(status);
      const normalized = extractStatus(status);
      if (normalized && TERMINAL_STATUSES.has(normalized)) return record;
    } catch (err) {
      // A 4xx rejection (auth, unknown run, unsupported) will not become a
      // terminal by retrying. Transient failures (network blips, 5xx) are
      // retried at the poll interval until the window expires.
      const hermesErr = err as HermesHttpError;
      if (typeof hermesErr.status === "number" && hermesErr.status >= 400 && hermesErr.status < 500) return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

/** Dispatch the remote stop and wait (bounded) for the authoritative terminal.
 * A missing or non-terminal confirmation stays unverified; it is never
 * upgraded to a successful cancellation. */
async function reconcileRemoteStop(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  state: ExecutionState;
  deadlineMs: number;
  redactText?: TextRedactor;
}): Promise<{
  terminal: RemoteTerminalEvidence | null;
  terminalPayload: Record<string, unknown> | null;
  stopDispatched: boolean;
  stopFailed: boolean;
  requestedAt: string;
}> {
  const requestedAt = new Date().toISOString();
  const deadline = Date.now() + input.deadlineMs;
  const stop = await stopRun({
    ctx: input.ctx,
    baseUrl: input.baseUrl,
    headers: input.headers,
    runId: input.state.runId,
    deadlineMs: input.deadlineMs,
    redactText: input.redactText,
  });
  if (input.state.terminal) {
    // A natural terminal was observed while the stop was dispatched; it is
    // authoritative evidence that the remote run ended.
    const terminal = input.state.terminal;
    return {
      terminal: naturalTerminalEvidence(terminal),
      terminalPayload: terminal.payload ?? null,
      stopDispatched: true,
      stopFailed: stop === null,
      requestedAt,
    };
  }
  const finalStatus = await fetchFinalStatus({
    baseUrl: input.baseUrl,
    headers: input.headers,
    runId: input.state.runId,
    deadlineMs: Math.max(0, deadline - Date.now()),
  });
  const normalized = extractStatus(finalStatus);
  const verified = finalStatus !== null && normalized !== null && TERMINAL_STATUSES.has(normalized)
    ? { status: normalized, source: "stop_verification" as const, observedAt: new Date().toISOString() }
    : null;
  return {
    terminal: verified,
    terminalPayload: verified ? (asRecord(finalStatus) ?? null) : null,
    stopDispatched: true,
    stopFailed: stop === null,
    requestedAt,
  };
}

function redactErrorMessage(err: unknown, redactText: TextRedactor = sanitizeSensitiveText): string {
  if (err instanceof Error) return redactText(err.message);
  return redactText(String(err));
}

function errorResult(err: unknown, redactText: TextRedactor = sanitizeSensitiveText, options?: {
  executionRecovery?: AdapterExecutionResult["executionRecovery"];
}): AdapterExecutionResult {
  const hermesError = err as HermesHttpError;
  const code = hermesError.code ?? "hermes_gateway_protocol_error";
  const classified = hermesError.status ? classifyHttpError(hermesError.status) : null;
  const errorMessage = code === "hermes_gateway_auth_failed"
    ? `${redactErrorMessage(err, redactText)}. Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY for the running gateway.`
    : redactErrorMessage(err, redactText);
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    ...(options?.executionRecovery ? { executionRecovery: options.executionRecovery } : {}),
    errorCode: code,
    errorFamily: classified?.family ?? (code === "hermes_gateway_connect_failed" ? "transient_upstream" : null),
    retryNotBefore: hermesError.retryNotBefore ?? null,
    errorMessage,
    errorMeta: {
      ...(hermesError.status ? { status: hermesError.status } : {}),
      ...(hermesError.body ? { body: redactForLog(hermesError.body, [], 0, redactText) as Record<string, unknown> } : {}),
    },
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const apiBaseUrlValue = asString(ctx.config.apiBaseUrl ?? ctx.config.url, "").trim();
  if (!apiBaseUrlValue) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_base_url_missing",
      errorMessage: "Hermes gateway adapter requires apiBaseUrl.",
    };
  }

  const baseUrl = normalizeBaseUrl(apiBaseUrlValue);
  if (!baseUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_base_url_invalid",
      errorMessage: `Invalid Hermes gateway apiBaseUrl: ${apiBaseUrlValue}`,
    };
  }
  if (isRemotePlainHttp(baseUrl) && !allowsInsecureRemoteHttp(ctx.config)) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_plain_http_remote_denied",
      errorMessage: remotePlainHttpDeniedMessage(baseUrl.hostname),
    };
  }

  const apiKey = nonEmpty(ctx.config.apiKey) ?? nonEmpty(ctx.config.token);
  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_key_missing",
      errorMessage: "Hermes gateway adapter requires apiKey.",
    };
  }

  const timeoutSec = parseNonNegativeNumber(ctx.config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const timeoutMs = timeoutSec > 0 ? Math.ceil(timeoutSec * 1000) : 0;
  const reconnectMs = Math.floor(clamp(parseNonNegativeNumber(ctx.config.eventReconnectMs, DEFAULT_EVENT_RECONNECT_MS), 250, 30_000));
  const pollIntervalMs = Math.floor(clamp(parseNonNegativeNumber(ctx.config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS), 250, 10_000));
  const strategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);
  const sessionKey = resolveSessionKey({
    strategy,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    runId: ctx.runId,
    issueId: issueIdFromContext(ctx),
  });
  const extraHeaders = parseHeaders(ctx.config.headers);
  const runHeaders = buildHeaders({
    apiKey,
    sessionKey,
    runId: ctx.runId,
    extraHeaders,
    accept: "application/json",
    contentType: "application/json",
  });
  const eventHeaders = buildHeaders({
    apiKey,
    sessionKey,
    runId: ctx.runId,
    extraHeaders,
    accept: "text/event-stream",
  });
  const redactText = createTextRedactor([
    apiKey,
    sessionKey,
    runHeaders.Authorization,
    runHeaders["X-Hermes-Session-Key"],
  ]);
  const body = buildRunBody(ctx, sessionKey);
  const createRunUrl = apiUrl(baseUrl, "/v1/runs");
  const stopAckSec = clamp(parseNonNegativeNumber(ctx.config.stopAckSec, DEFAULT_STOP_ACK_SEC), 1, 55);
  const stopAckMs = Math.ceil(stopAckSec * 1000);
  const sessionDisplayId = sessionKey ? redactText(sessionKey) : null;

  // Register stop control before provider work so an operator Stop reaches
  // this adapter through ctx.signal (the ACPX engine contract).
  await ctx.onCancellationReady?.();

  const baseSession = {
    sessionParams: { strategy },
    sessionDisplayId,
  };

  if (ctx.signal?.aborted) {
    // Stopped before dispatch: no remote work started. Acknowledge; there is
    // nothing to reconcile remotely.
    return {
      exitCode: 1,
      signal: "SIGTERM",
      timedOut: false,
      errorCode: "hermes_gateway_cancelled",
      errorMessage: `Paperclip stopped run ${ctx.runId} before the remote Hermes run was created; no provider work started.`,
      provider: "hermes_gateway",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      resultJson: {
        executionCancellation: {
          state: "acknowledged",
          acknowledgedAt: new Date().toISOString(),
          reason: "before_dispatch",
        },
      },
      ...baseSession,
    };
  }

  await ctx.onMeta?.({
    adapterType: ADAPTER_TYPE,
    command: "POST /v1/runs",
    commandArgs: [createRunUrl],
    context: {
      runId: ctx.runId,
      timeoutSec,
      eventReconnectMs: reconnectMs,
      sessionKeyStrategy: strategy,
      hasSessionKey: Boolean(sessionKey),
      stopAckSec,
    },
  });
  await ctx.onLog("stdout", `[hermes-gateway] creating run at ${createRunUrl} (timeout=${timeoutSec}s, stopAck=${stopAckSec}s, session=${strategy})\n`);
  await ctx.onLog("stdout", `[hermes-gateway] request headers (redacted): ${stringifyForLog(redactForLog(runHeaders, [], 0, redactText), 3_000)}\n`);

  const createInFlightResult = (requestedAt: string): AdapterExecutionResult => ({
    exitCode: 1,
    signal: "SIGTERM",
    timedOut: false,
    errorCode: "hermes_gateway_cancelled",
    errorMessage: `Paperclip stopped run ${ctx.runId} while the remote create was in flight. The remote run state is unknown (idempotency key ${ctx.runId}); verify the gateway state and reconcile this run before continuing.`,
    provider: "hermes_gateway",
    resultJson: {
      executionCancellation: {
        state: "requested",
        requestedAt,
        reason: "create_in_flight",
        remoteRunId: null,
      },
    },
    ...baseSession,
  });

  let created: unknown;
  try {
    // This adapter has no local child process, so crossing into the first
    // remote create request is its dispatch boundary. Report it before the
    // request can block so continuation gates may release their issue lock.
    ctx.onDispatch?.();
    // The create observes the operator stop. A stop in flight fails closed
    // instead of retrying: the Idempotency-Key is reserved before work
    // starts, so a post-stop retry could start fresh remote work.
    created = await fetchJson(createRunUrl, {
      method: "POST",
      headers: runHeaders,
      body: JSON.stringify(body),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (err) {
    if (ctx.signal?.aborted) return createInFlightResult(new Date().toISOString());
    // A failed create does not prove the gateway never started a remote run:
    // the Idempotency-Key is correlation only (Hermes v0.16.0 does not
    // dedupe), so 5xx and post-connect network failures leave the remote
    // state unknown and keep this row a reconciliation candidate. Only
    // unambiguous no-start failures record bootstrap evidence.
    return errorResult(err, redactText, {
      ...(createProvedNoRemoteStart(err)
        ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }
        : {}),
    });
  }

  const runId = extractRunId(created);
  if (!runId) {
    if (ctx.signal?.aborted) return createInFlightResult(new Date().toISOString());
    // The gateway answered without a run id, so a remote run may exist with
    // an unknown id: no bootstrap claim, and no stop target to dispatch to.
    // This stays a reconciliation candidate.
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_protocol_error",
      errorMessage: `Hermes /v1/runs response for run ${ctx.runId} did not include run_id. Verify whether the gateway started a remote run for this request and reconcile the run before continuing.`,
      errorMeta: { response: redactForLog(created, [], 0, redactText) as Record<string, unknown> },
    };
  }

  await ctx.onLog("stdout", `[hermes-gateway] run created: ${runId}\n`);

  const state = createExecutionState(runId);
  const controller = new AbortController();
  void consumeEvents({
    ctx,
    baseUrl,
    headers: eventHeaders,
    state,
    signal: controller.signal,
    reconnectMs,
    redactText,
  }).catch(() => undefined);
  void pollStatus({
    ctx,
    baseUrl,
    headers: eventHeaders,
    state,
    signal: controller.signal,
    intervalMs: pollIntervalMs,
    redactText,
  }).catch(() => undefined);

  // Operator stop: dispatch the remote stop promptly and wait for the
  // authoritative terminal acknowledgement within the acknowledgement window.
  // An unverified stop fails closed (requested, never a manufactured
  // cancellation).
  type StopSettlement = Awaited<ReturnType<typeof reconcileRemoteStop>>;
  let stopSettlement: Promise<StopSettlement> | null = null;
  let resolveStopGate: (() => void) | null = null;
  const stopGate = new Promise<void>((resolve) => {
    resolveStopGate = resolve;
  });
  const operatorStop = () => {
    if (stopSettlement) return;
    stopSettlement = reconcileRemoteStop({
      ctx,
      baseUrl,
      headers: eventHeaders,
      state,
      deadlineMs: stopAckMs,
      redactText,
    }).finally(() => resolveStopGate?.());
  };
  // The assignment happens only inside operatorStop; the outer flow's type
  // view would otherwise stay pinned to the null initializer.
  const getStopSettlement = () => stopSettlement;
  if (ctx.signal) {
    if (ctx.signal.aborted) operatorStop();
    else ctx.signal.addEventListener("abort", operatorStop, { once: true });
  }

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    if (timeoutMs <= 0) return;
    timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const outcome = await Promise.race([
    state.terminalPromise.then((terminal) => ({ kind: "terminal" as const, terminal })),
    timeoutPromise.then(() => ({ kind: "timeout" as const })),
    stopGate.then(() => ({ kind: "stop" as const })),
  ]);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  controller.abort();
  ctx.signal?.removeEventListener("abort", operatorStop);

  if (outcome.kind === "timeout") {
    // The adapter's own timeout: reconcile the remote run exactly like an
    // operator stop, reusing an in-flight stop settlement when present.
    const pending = getStopSettlement();
    const settlement = pending ? await pending : null;
    let verified: RemoteTerminalEvidence | null = settlement?.terminal ?? null;
    let finalStatus = verified ? settlement!.terminalPayload : null;
    if (!verified) {
      const deadline = Date.now() + stopAckMs;
      await stopRun({ ctx, baseUrl, headers: eventHeaders, runId, deadlineMs: stopAckMs, redactText });
      finalStatus = await fetchFinalStatus({ baseUrl, headers: eventHeaders, runId, deadlineMs: Math.max(0, deadline - Date.now()) });
      const normalized = extractStatus(finalStatus);
      if (finalStatus !== null && normalized !== null && TERMINAL_STATUSES.has(normalized)) {
        verified = { status: normalized, source: "stop_verification", observedAt: new Date().toISOString() };
      }
    }
    const operatorStopped = ctx.signal?.aborted === true;
    const cancellation = operatorStopped
      ? verified
        ? {
            state: "acknowledged",
            remoteRunId: runId,
            remoteStatus: verified.status,
            acknowledgedAt: verified.observedAt,
            proof: "remote_terminal_status",
          }
        : {
            state: "requested",
            remoteRunId: runId,
            requestedAt: settlement?.requestedAt ?? new Date().toISOString(),
            reason: settlement && settlement.stopFailed ? "stop_failed" : "ack_timeout",
          }
      : null;
    return {
      exitCode: 1,
      signal: operatorStopped ? "SIGTERM" : null,
      timedOut: true,
      errorCode: operatorStopped && !verified ? "hermes_gateway_stop_unverified" : "hermes_gateway_timeout",
      errorMessage: verified
        ? `Hermes gateway run timed out after ${timeoutSec}s; remote run ${runId} reached terminal status '${verified.status}'.`
        : `Hermes gateway run timed out after ${timeoutSec}s and the remote terminal state of run ${runId} could not be verified within ${stopAckSec}s. Verify the run at the gateway (authenticated GET /v1/runs/${runId}) and reconcile it before continuing.`,
      provider: "hermes_gateway",
      resultJson: {
        run_id: runId,
        status: verified?.status ?? "timeout",
        last_event: state.lastEventName,
        ...(verified ? { hermesRemoteTerminal: verified } : {}),
        ...(cancellation ? { executionCancellation: cancellation } : {}),
        ...(finalStatus !== null ? { final_status: redactForLog(finalStatus, [], 0, redactText) } : {}),
      },
      sessionParams: { hermesRunId: runId, strategy },
      sessionDisplayId,
    };
  }

  if (ctx.signal?.aborted === true) {
    // Operator stop: an observed remote terminal (any source) acknowledges it;
    // nothing observed within the window stays requested.
    const pending = getStopSettlement();
    const settlement = pending ? await pending : null;
    const verified =
      settlement?.terminal ?? (state.terminal ? naturalTerminalEvidence(state.terminal) : null);
    if (verified) {
      const base = state.terminal ?? { runId, status: verified.status };
      return mapFinalResultForTest({
        terminal: {
          ...base,
          status: verified.status,
          payload: base.payload ?? settlement?.terminalPayload ?? null,
          output: base.output ?? extractOutput(settlement?.terminalPayload),
          observedAt: verified.observedAt,
        },
        outputChunks: state.outputChunks,
        sessionKey,
        strategy,
        redactText,
        remoteTerminal: verified,
        executionCancellation: {
          state: "acknowledged",
          remoteRunId: runId,
          remoteStatus: verified.status,
          acknowledgedAt: verified.observedAt,
          proof: "remote_terminal_status",
        },
      });
    }
    return {
      exitCode: 1,
      signal: "SIGTERM",
      timedOut: false,
      errorCode: "hermes_gateway_stop_unverified",
      errorMessage: `Hermes gateway stop was dispatched for run ${runId} but the remote terminal state was not confirmed within ${stopAckSec}s. Verify the run at the gateway (authenticated GET /v1/runs/${runId}) and reconcile it through the task's recovery action before continuing.`,
      provider: "hermes_gateway",
      resultJson: {
        run_id: runId,
        status: "stopping",
        last_event: state.lastEventName,
        executionCancellation: {
          state: "requested",
          remoteRunId: runId,
          requestedAt: settlement?.requestedAt ?? new Date().toISOString(),
          reason: settlement?.stopFailed ? "stop_failed" : "ack_timeout",
        },
      },
      sessionParams: { hermesRunId: runId, strategy },
      sessionDisplayId,
    };
  }

  const terminal = outcome.kind === "terminal" ? outcome.terminal : state.terminal;
  if (!terminal) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_protocol_error",
      errorMessage: `Hermes gateway run ${runId} ended without an observable terminal state. Verify the run at the gateway and reconcile it before continuing.`,
      provider: "hermes_gateway",
      resultJson: { run_id: runId, status: "unknown", last_event: state.lastEventName },
      sessionParams: { hermesRunId: runId, strategy },
      sessionDisplayId,
    };
  }

  return mapFinalResultForTest({
    terminal,
    outputChunks: state.outputChunks,
    sessionKey,
    strategy,
    redactText,
    remoteTerminal: naturalTerminalEvidence(terminal),
  });
}
