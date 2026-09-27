export const hermesGatewayAgentConfigurationDoc = `# hermes_gateway agent configuration

Adapter: hermes_gateway

Use when:
- Hermes is already running outside Paperclip and exposes its API server.
- Paperclip should invoke Hermes through the gateway HTTP API instead of spawning Hermes locally.
- The Hermes runtime may live on another host, a private overlay, in Docker, or behind a TLS reverse proxy.

Don't use when:
- Paperclip should start the Hermes CLI directly on the same host. Use the built-in hermes_local adapter for that flow.
- Hermes is the process calling Paperclip APIs after claiming its key. That is Hermes-originated Paperclip API usage, not the gateway adapter transport.

Runtime distinction:
- hermes_local: Paperclip starts Hermes on the Paperclip host through the built-in local adapter.
- hermes_gateway: Paperclip calls an already-running Hermes API server using agentDefaultsPayload.apiBaseUrl.
- Hermes-originated Paperclip API usage: Hermes calls Paperclip with PAPERCLIP_API_URL and the Paperclip API key claimed through the standard join approval flow. Do not use agentDefaultsPayload.apiBaseUrl for Paperclip API calls. For internet-facing Hermes chat/webhook task bridges, use a separate task_bridge key instead of exposing the normal claimed agent key.

Hermes gateway process setup:
- Set API_SERVER_ENABLED=true.
- Set API_SERVER_KEY to a generated secret value. Do not paste a real key into tickets, docs, screenshots, or tests.
- Start Hermes with: hermes gateway run --replace --accept-hooks
- Default Hermes API server port: 8642.
- Default Hermes dashboard port: 9119. If Paperclip is configured with a default dashboard root or chat URL such as http://127.0.0.1:9119 or http://127.0.0.1:9119/chat, it maps the base URL to /api automatically.
- Watch out: /chat and the dashboard root are browser UI routes. Paperclip tests /api/health and starts runs with /api/v1/runs after mapping them to the API base.

Join request minimum:
{
  "requestType": "agent",
  "agentName": "My Hermes Gateway Agent",
  "adapterType": "hermes_gateway",
  "capabilities": "Hermes gateway agent",
  "agentDefaultsPayload": {
    "apiBaseUrl": "http://127.0.0.1:8642",
    "apiKey": "<same-value-as-API_SERVER_KEY>",
    "paperclipApiUrl": "http://localhost:3100"
  }
}

Core fields:
- agentDefaultsPayload.apiBaseUrl (string, required): Base URL for the Hermes API server as reachable from the Paperclip server. A default dashboard root or chat URL such as http://127.0.0.1:9119 or http://127.0.0.1:9119/chat is accepted and maps to http://127.0.0.1:9119/api.
- agentDefaultsPayload.apiKey (string, required unless the adapter package documents another auth field): Hermes API server key matching API_SERVER_KEY. This is the Hermes gateway key, not the claimed Paperclip API key.
- agentDefaultsPayload.paperclipApiUrl (string, strongly recommended): Paperclip base URL as reachable from Hermes for invite, claim, skill bootstrap, and later Paperclip API calls.
- agentDefaultsPayload.timeoutSec or timeoutMs (number, optional): Runtime request timeout when supported by the installed Hermes gateway adapter.
- agentDefaultsPayload.stopAckSec (number, optional, default 30): How long Paperclip waits for the Hermes gateway to confirm a remote stop reached a terminal status. Clamped to 1-55 because it must stay below Paperclip's 60-second stop wait.

Stop and recovery:
- An operator Stop dispatches POST /v1/runs/<run_id>/stop to the exact remote Hermes run immediately and waits for an authoritative terminal acknowledgement within stopAckSec.
- A verified stop records executionCancellation.state "acknowledged" with the remote run id plus hermesRemoteTerminal evidence; the conversation can then continue with a fresh explicit message (exactly one successor, history preserved).
- An unverified stop (gateway unreachable, stop failed, or acknowledgement timeout) fails closed: the run keeps error code hermes_gateway_stop_unverified with executionCancellation.state "requested", and the task stays blocked until an operator verifies the terminal state via authenticated GET /v1/runs/<run_id> and reconciles it through the task's recovery action. Paperclip never manufactures a successful cancellation.

Network examples:
- Local loopback on one host: agentDefaultsPayload.apiBaseUrl = "http://127.0.0.1:8642"; agentDefaultsPayload.paperclipApiUrl = "http://127.0.0.1:3100".
- Local dashboard root or chat URL on one host: agentDefaultsPayload.apiBaseUrl = "http://127.0.0.1:9119" or "http://127.0.0.1:9119/chat"; Paperclip maps it to "http://127.0.0.1:9119/api".
- LAN/private network: agentDefaultsPayload.apiBaseUrl = "http://192.168.1.25:8642"; agentDefaultsPayload.paperclipApiUrl = "http://192.168.1.10:3100". Use private IPs or hostnames reachable from both machines.
- Private overlay: agentDefaultsPayload.apiBaseUrl = "http://hermes-host.tailnet-name.ts.net:8642"; agentDefaultsPayload.paperclipApiUrl = "http://paperclip-host.tailnet-name.ts.net:3100". Add the Paperclip hostname with npx paperclipai allowed-hostname <host> when authenticated/private mode requires it.
- Docker: if Hermes runs on the host and Paperclip runs in Docker, use agentDefaultsPayload.apiBaseUrl = "http://host.docker.internal:8642". If Hermes runs in another container, use the Compose service DNS name such as "http://hermes:8642".
- Reverse proxy/TLS: publish Hermes behind HTTPS and set agentDefaultsPayload.apiBaseUrl = "https://hermes-gateway.example"; set agentDefaultsPayload.paperclipApiUrl = "https://paperclip.example". Keep API_SERVER_KEY required at the origin or proxy.

Security notes:
- Treat API_SERVER_KEY and PAPERCLIP_BRIDGE_API_KEY as secrets.
- When claiming the normal Paperclip agent API key, store the parsed token field from the raw claim response before printing or summarizing it. Hermes/tool displays may redact secrets with literal ... or [redacted]; those previews are not valid keys.
- Never use a normal claimed Paperclip agent API key for internet-facing Hermes-originated task bridge calls; task_bridge keys cannot use company-wide issue list/search/read surfaces and can only mutate bridge-created or assigned issues.
- Prefer private network or TLS for non-loopback gateway access.
- Use placeholders such as <same-value-as-API_SERVER_KEY> in docs and tests.
`;
