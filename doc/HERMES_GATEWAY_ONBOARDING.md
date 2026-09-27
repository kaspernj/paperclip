# Hermes Gateway Onboarding

Use this guide when a Hermes runtime should join Paperclip as an external
`hermes_gateway` employee. This mirrors the OpenClaw gateway invite path, but
Hermes uses the generic agent invite/onboarding flow instead of the
OpenClaw-specific invite prompt endpoint.

## Choose The Adapter

Paperclip ships both Hermes adapters as built-ins:

- `hermes_local` runs the local `hermes` CLI as a child process on the
  Paperclip host.
- `hermes_gateway` calls an already-running Hermes API server over HTTP/SSE.

No Adapter manager installation is required for normal use. Adapter manager is
only needed when you intentionally install an external
`@paperclipai/hermes-paperclip-adapter` package to override or shadow a built-in
adapter while developing the Hermes package. If the external override is paused
or removed, Paperclip restores the built-in `hermes_local` / `hermes_gateway`
adapter.

## Required Credentials

Keep these credentials distinct:

- Hermes inference provider key: set at least one provider key for Hermes, such
  as `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or `MISTRAL_API_KEY`.
- Hermes gateway key: set `API_SERVER_KEY` before starting Hermes. Paperclip
  stores the same value as `agentDefaultsPayload.apiKey` so it can call Hermes.
- Paperclip agent key: created after the board approves the join request and
  claimed once by the Hermes agent. Hermes uses this key as
  `PAPERCLIP_API_KEY` when it calls Paperclip.

Do not reuse the Hermes gateway key as the Paperclip agent key. The Hermes
gateway key authenticates Paperclip-to-Hermes traffic; the claimed Paperclip key
authenticates Hermes-to-Paperclip traffic.

## Start Hermes Gateway

Install and configure Hermes first:

```sh
pip install hermes-agent
export OPENROUTER_API_KEY='<provider-key>'
export API_SERVER_KEY='<random-gateway-key>'
API_SERVER_ENABLED=true hermes gateway run --replace --accept-hooks
```

The default Hermes API server port is `8642`. For local loopback testing,
Paperclip can usually store `http://127.0.0.1:8642` as the gateway URL. For
Docker, LAN, tailnet, or reverse-proxy setups, use a URL reachable by the
Paperclip server process.

Plain HTTP is accepted for loopback. Non-loopback HTTP is denied by default in
the join flow; use HTTPS for real remote gateways. For private local
development only, the join payload can set
`dangerouslyAllowInsecureRemoteHttp: true`, and the smoke scripts expose the
same escape hatch as `HERMES_GATEWAY_ALLOW_INSECURE_HTTP=1`.

## Invite From Paperclip

In the board UI:

1. Open the target company.
2. Use the add-agent button in the agent sidebar.
3. Generate an agent onboarding prompt/invite.
4. Give the generated onboarding text to the Hermes runtime.

The UI prompt points Hermes at the same machine-readable onboarding endpoints:

- `GET /api/invites/:token`
- `GET /api/invites/:token/onboarding`
- `GET /api/invites/:token/onboarding.txt`
- `GET /api/skills/index`
- `GET /api/skills/paperclip`

For CLI-driven setup, create and inspect the invite directly:

```sh
npx paperclipai invite create --company-id <company-id> --payload-json '{"requestType":"agent"}'
npx paperclipai invite show <token>
npx paperclipai invite onboarding:text <token>
```

Hermes should submit a join request with `requestType: "agent"` and
`adapterType: "hermes_gateway"`:

```json
{
  "requestType": "agent",
  "agentName": "Hermes Gateway Engineer",
  "adapterType": "hermes_gateway",
  "capabilities": "Hermes gateway agent with code, browser, web, and file tools.",
  "agentDefaultsPayload": {
    "apiBaseUrl": "http://127.0.0.1:8642",
    "apiKey": "<same-value-as-API_SERVER_KEY>",
    "paperclipApiUrl": "http://127.0.0.1:3100",
    "sessionKeyStrategy": "issue"
  }
}
```

Important URL roles:

- `agentDefaultsPayload.apiBaseUrl` is the Hermes gateway URL that Paperclip
  calls.
- `agentDefaultsPayload.paperclipApiUrl` is the Paperclip base URL that Hermes
  can call after approval and key claim.
- `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY` are injected runtime values for
  Hermes-originated Paperclip API calls after the agent is approved.

## Approve And Claim

After Hermes submits the join request:

1. In Paperclip, review the pending agent join request.
2. Approve it from the board UI, or use:

   ```sh
   npx paperclipai join list --company-id <company-id> --status pending_approval
   npx paperclipai join approve <request-id> --company-id <company-id>
   ```

3. Hermes claims the one-time agent API key:

   ```sh
   npx paperclipai join claim-key <request-id> --claim-secret <secret>
   ```

4. Store the claimed Paperclip key in Hermes runtime state or secrets. The claim
   secret and claimed key are sensitive and should not be pasted into issue
   comments, logs, or prompt text.

Once the key is claimed, create an issue assigned to the new Hermes gateway
agent and wake it through the normal Paperclip heartbeat path.

## Stop And Recovery

Stopping a `hermes_gateway` run is remote, so Paperclip treats it differently
from local adapters:

- An operator Stop dispatches a remote `POST /v1/runs/<run_id>/stop` to the
  exact Hermes run immediately, then waits up to `stopAckSec` (adapter config,
  default 30, clamped to 1-55) for an authoritative terminal acknowledgement.
  The window must stay below Paperclip's 60-second stop wait.
- A verified stop records `executionCancellation.state: "acknowledged"` with
  the remote run id, plus `hermesRemoteTerminal` evidence, in the run's
  result. The run is terminal and the conversation can continue.
- If the terminal state is not confirmed within the window (gateway
  unreachable, stop request failed, or acknowledgement timed out), the run
  stays blocked with error code `hermes_gateway_stop_unverified` and
  `executionCancellation.state: "requested"`. Paperclip never manufactures a
  successful cancellation; the unknown remote state fails closed.
- A stop that arrives before the remote run is created records bootstrap
  evidence (`providerWorkStarted: false`) and no provider work starts. A stop
  that races an in-flight remote create leaves the remote state unknown
  (the idempotency key is the Paperclip run id); verify the gateway before
  continuing.

To recover an unverified stop, an operator confirms the terminal state at the
gateway with an authenticated `GET /v1/runs/<run_id>` (terminal statuses are
`completed`, `failed`, `cancelled`, `interrupted`, and their aliases), then
records the outcome through the task's recovery action:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/<issue-id>/recovery-actions/resolve" \
  -H "Authorization: Bearer $PAPERCLIP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "actionId": "<recovery-action-id>",
    "outcome": "restored",
    "sourceIssueStatus": "todo",
    "executionReconciliation": {
      "runId": "<paperclip-run-id>",
      "providerStopped": true,
      "actionOutcome": "mixed",
      "outcomeEvidence": "Authenticated GET /v1/runs/<remote-run-id> returned status cancelled at <timestamp> (operator-verified)"
    }
  }'
```

Use `npx paperclipai issue recovery:resolve <issue-id> --action-id <id>
--outcome restored --source-issue-status todo` for a basic resolve; the CLI
does not accept an `executionReconciliation` payload, so use the API call
above when recording verified remote evidence. Find the active recovery
action id with `npx paperclipai issue recovery-actions <issue-id>`.

After a verified terminal gateway run, a fresh explicit message on the task
continues the conversation with history preserved and creates exactly one
successor run. Paperclip does not replay the whole task automatically, and
queued messages are not discarded. Until the remote state is verified,
`hermes_gateway` runs keep the task blocked with an actionable explanation
instead of guessing.

## Local Fresh-State Smoke

For a fresh Docker-backed Hermes gateway and end-to-end Paperclip join/run
verification, use:

```sh
PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_AUTH_HEADER='Bearer <board-token>' \
pnpm smoke:hermes-gateway-e2e
```

The E2E smoke:

- builds a fresh Hermes gateway container
- seeds a minimal non-secret Hermes model config
- passes provider keys from the host environment without printing them
- verifies Hermes `/health`, `/v1/capabilities`, `/v1/runs`, SSE, and stop
- creates and approves a Paperclip agent-only invite
- joins as `hermes_gateway`
- wakes the agent on a smoke issue
- removes Paperclip and Docker test state on success

If a Hermes gateway is already running and you only need to validate the invite
and stored adapter config, use the join-only helper:

```sh
API_SERVER_ENABLED=true API_SERVER_KEY='<gateway-key>' hermes gateway run --replace --accept-hooks

PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_AUTH_HEADER='Bearer <board-token>' \
HERMES_GATEWAY_API_BASE_URL=http://127.0.0.1:8642 \
HERMES_GATEWAY_API_KEY='<gateway-key>' \
pnpm smoke:hermes-gateway-join
```

See [HERMES_GATEWAY_SMOKE.md](./HERMES_GATEWAY_SMOKE.md) for Docker Desktop,
Linux, same-network Docker, LAN/private-network, and reverse-proxy/TLS examples.

## Install Entry Points

Use these entry points depending on who is driving setup:

- Board UI: add-agent button in the agent sidebar, then generate the agent
  onboarding prompt.
- Invite API: `GET /api/invites/:token/onboarding.txt` for the generated
  llm.txt-style setup instructions.
- CLI invite flow: `npx paperclipai invite create`, `invite show`,
  `invite onboarding:text`, `join approve`, and `join claim-key`.
- Smoke helpers: `pnpm smoke:hermes-gateway-e2e` for fresh-state Docker
  verification and `pnpm smoke:hermes-gateway-join` for an already-running
  gateway.
- Adapter development override: Adapter manager can install
  `@paperclipai/hermes-paperclip-adapter` as an external override, but normal
  operators should use the built-in `hermes_local` and `hermes_gateway`
  adapters.
