# OpenCode V2 Responses WebSocket integration (#1844)

## Approved scope

The user authorized implementing the previously discussed two-ended WebSocket
ACP integration on 2026-10-01. OpenCode V2 connects to bili over WebSocket;
bili connects to the selected Responses upstream over WebSocket. This includes
the OpenAI API and ChatGPT OAuth/Codex endpoint. It does not implement Realtime,
generic opaque WebSocket passthrough, or change the user's OpenCode configuration.

## Decision points

- The V2 handshake hook routes supported Responses sockets through the existing
  explicit-protocol tunnel, with plugin identity and model metadata. Other
  protocols, disabled plugins, and older hosts retain their existing behavior.
- Only loopback, cooperative OpenCode Responses upgrades are admitted initially.
  Destination admission reuses the existing tunnel guard. Unclaimed upgrades
  still receive the existing immediate 426, independently of PR #1472.
- Responses frames enter the existing request pipeline through an in-process
  HTTP-shaped envelope, not a network HTTP hop. An async-scoped fetch transport
  executes model requests, retries, and preflight requests over upstream
  WebSocket. Existing ACP policy, tool execution, usage accounting, and prose
  filtering remain the single authority. Tool argument strings are never cleaned.
- Client and upstream continuation checkpoints are separate: the client sees
  its original history and visible output; the upstream sees the ACP-processed
  history. Incoming deltas are expanded before ACP. Outgoing deltas are used only
  when the processed input extends the upstream checkpoint exactly. A fold or
  other history change sends full processed input without previous_response_id.
  This starts a new response chain without requiring a new socket.
  Request-size logs marked `view=ws-expanded` describe reconstructed pipeline
  envelopes, not incremental WebSocket wire bytes.
- Only completed responses establish continuation checkpoints. Disconnect,
  cancellation, failed/incomplete responses, and unknown response IDs do not
  fabricate successful history. Checkpoints and queued payloads are bounded.
- Both checkpoints accumulate `response.output_item.done` items by output index.
  Empty, missing, or partial terminal `response.output` must not erase completed
  tool calls and leave orphaned results on the next delta. Terminal items merge
  by item ID; streaming frames remain unchanged. Debug logs report restored
  checkpoint item counts without recording their contents.
- WS diagnostics identify the local socket and session, failure phase
  (`handshake`, `await-first-event`, `stream`, or `dispatch`), numeric close code,
  full/delta request mode, and checkpoint reset/recovery reason. They omit
  authorization headers, URLs, close-reason text, payloads, and upstream error
  messages. Normal lifecycle/recovery details use debug; failures use warn.
- No configuration field, environment variable, package version, persistence
  format, or acp-kernel version is added or changed. Socket checkpoints are
  connection-local; ACP persistence remains unchanged. The ws implementation is
  a bundled build-time dependency, not an external runtime requirement.

## Architecture: generic WebSocket bridge (#1467 phase-2 shell)

The WebSocket interception is split into a protocol-independent shell and a
per-protocol codec:

- `src/ws-bridge.ts` (shell) owns admission (loopback source, `x-bili-plugin`
  lane marker, `x-bili-plugin-conversation` session header, tunnel-destination
  guard), the upgrade handshake, per-connection bookkeeping, and shutdown
  teardown. It knows nothing about any wire protocol.
- `src/responses-ws.ts` (codec) owns everything Responses-specific: frame
  validation, the `previous_response_id` client history contract, the upstream
  WebSocket transport with its continuation checkpoints, and the SSE response
  sink. It is registered as `responsesCodec` in a codec table at the single
  wiring site (`installWebSocketBridge(server, dispatch, log, [responsesCodec,
  codexResponsesCodec])` in `src/server.ts`).

A second wire protocol is a new codec file plus one table entry — no shell
changes. The shell contract is `WsBridgeCodec` (name, plugin marker, URL claim,
session factory) and `WsBridgeSession` (message/close/shutdown); sessions
receive the labeled logger, the upgraded peer, the upgrade request, the claimed
upstream URL, and the ACP pipeline entry (`dispatch`), and are expected to
rebuild protocol-shaped envelopes in-process. `tests/ws-bridge.test.ts` drives
the shell with a synthetic second codec to keep the codec table honest.

The second real codec is already here: **`codexResponsesCodec`** claims codex
CLI's Responses-over-WebSocket dial (`/bili/<upstream>/responses`, conversation
header `session-id`, `stream:true` frames, per-connection prewarm probe with
`generate:false` relayed verbatim around the pipeline). It is prefix-lane:
no plugin marker on the wire, admission resting on loopback + conversation
header + tunnel guard — the same trust level as prefix-mode HTTP. Codex
replays the full history every turn (`previous_response_id` is never sent),
so the fold simply shrinks the next replay; see `tests/codex-responses-ws.test.ts`.

Unknown protocols cannot be compressed (folding requires knowing where history
lives in the wire format); they stay on the #1472 transparent passthrough lane
and remain untouched by this bridge.

## Idle-socket observability (#1926, option (c))

Idle client peers each pin one live upstream connection plus both checkpoints,
with no reclamation until the client closes (idle-close (a)/(b) awaits
verified retry-full host recovery — see #1926). Until then the lane surfaces
the retention:

- `GET /__bili/stats` gains a `wsBridge` object: per live connection — codec,
  connection id, `idleMs`, `retainedBytes` (client + upstream checkpoints),
  `inFlight`.
- A scan (default every 60s) logs one `warn` per idle episode per connection
  once idle age crosses the threshold (default 30min;
  `BILI_WS_IDLE_WARN_SECONDS` overrides, `0` disables), tagged `(#1926)` and
  reset by client activity. Pure observability — nothing is closed.

## Verification

Use random loopback ports and fake Responses WebSocket upstreams, with no real
credentials or model usage. Prove both directions stay on WebSocket, normal
continuation is incremental, a real ACP fold resets the upstream history,
tool argument payloads survive unchanged, usage reaches the existing session,
and successive tool calls/results still advance history after a fold even when
the terminal output is sparse,
and unknown upgrades retain 426. Verify upstream proxy routing, errors,
cancellation, reconnect, checkpoint misses, and session isolation. Exercise a
real OpenCode V2 binary with an isolated configuration and successful fake
WebSocket upstream; an unavailable socket that merely falls back to HTTP is
not acceptable evidence. Run typecheck, the full unit suite, build, and the
required Responses client E2E before submitting a human-reviewed PR.

Failure-combination coverage includes tool arguments delivered before disconnect,
failed/incomplete terminal events, cancellation followed immediately by a new
connection with rotated synthetic credentials, overlapping creates, repeated
continuation/connection-limit errors with bounded retries, and handshake refusal
followed by recovery. The sparse-output real-fold test also chains a missing
checkpoint, an idle disconnect, and connection-limit rotation, asserting that
summaries survive and each completed call/result appears exactly once upstream.
These are transport/history assertions, not proof of exactly-once execution of
arbitrary host tools or of the real OAuth refresh lifecycle.
