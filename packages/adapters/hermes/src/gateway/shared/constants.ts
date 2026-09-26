export const ADAPTER_TYPE = "hermes_gateway";
export const ADAPTER_LABEL = "Hermes Gateway";

export const DEFAULT_TIMEOUT_SEC = 600;
export const DEFAULT_EVENT_RECONNECT_MS = 2_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Remote stop acknowledgement window; must stay below Paperclip's 60s stop wait. */
export const DEFAULT_STOP_ACK_SEC = 30;
