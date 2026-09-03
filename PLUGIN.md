# billion-context Cooperative Plugin Protocol

> Status: protocol v1, experimental. Implemented by the proxy (`src/plugin.ts`), exercised by `tests/plugin-protocol.test.ts`. Issue: dog/billion-context#1 ("内外呼应" — inside/outside cooperation).

## Why

Pure proxy mode works with any agent but is blind inside the agent: tools are injected at the wire level, the compress tool-call loop is emulated by intercepting and re-requesting SSE streams, and session identity has to be guessed from headers or content fingerprints. Pure extension mode (see billion-context-pi) has native integration but needs one adapter per agent.

The cooperative plugin mode splits the job:

| Concern | Owner |
|---|---|
| Tool registration (native UI, permissions, audit) | **plugin** (inside) |
| The agent's own tool loop (multi-round calls) | **plugin / agent** (inside) |
| Session identity | **plugin** (inside) — sends the real conversation id |
| Compression engine + state + blocks | **proxy** (outside) |
| History folding / ref tags / nudges | **proxy** (outside) |
| Tool schemas + compression philosophy prompt | **proxy** — single source of truth, served to the plugin |

The plugin is deliberately a thin pipe: it registers whatever tools the manifest serves, forwards executions to the proxy, and returns the result text as a native tool result. Schema/prompt content always comes from the running proxy, so proxy and plugin can never drift.

## Protocol

All endpoints live under the proxy's admin gate (loopback + trusted-origin only).

### 1. `GET /__bili/plugin/manifest`

Fetch once at plugin startup.

```json
{
  "ok": true,
  "protocolVersion": 1,
  "proxy": "billion-context",
  "version": "0.1.42",
  "toolNames": ["compress", "decompress", "search_context", "acp_status"],
  "tools": {
    "anthropic": [ /* Anthropic tool schemas */ ],
    "openai":    [ /* OpenAI function schemas */ ],
    "responses": [ /* Responses API schemas */ ]
  },
  "headers": {
    "agent": "x-bili-plugin",
    "conversation": "x-bili-plugin-conversation",
    "contextWindow": "x-bili-plugin-context-window"
  },
  "toolEndpoint": "/__bili/plugin/tool",
  "statusEndpoint": "/__bili/plugin/status"
}
```

Register the four tools natively with your agent, in whichever wire format your agent speaks. If `protocolVersion` is higher than you know, still register the tools — extra fields in schemas are ignored by agents.

### 2. Request headers

On **every model request** the plugin sends:

- `x-bili-plugin: <agent-name>` — announces plugin mode for this session.
- `x-bili-plugin-conversation: <conversation-id>` — the agent's real conversation/session id, stable for the whole conversation.
- `x-bili-plugin-context-window: <tokens>` (optional but recommended) — the model's context window as configured inside the agent (e.g. a pinned/overridden `contextWindow`). This becomes the authoritative "native" window for nudge decisions — it outranks the proxy's built-in table and the models.dev registry (most valuable for private relays and MITM mode), while operator tuning (`compress.modelContextLimit`) still outranks it.

Effects on the proxy for that session:

- Wire-level tool injection is **suppressed** (tools are native; no duplicates).
- The compress loop **never intercepts** proxy-named tool calls — a model-emitted `compress` call is forwarded to the agent verbatim, as a normal native tool call.
- Session identity is keyed by the conversation id (strongest signal, ahead of all legacy session headers). This also fixes multi-session safety for agents that send no session headers at all.
- The compression philosophy system prompt, ref tags and nudges keep flowing from the proxy, exactly as in wire mode.

### 3. `POST /__bili/plugin/tool`

Execute a tool against the conversation's compression state.

```json
{
  "conversationId": "the same value you send as x-bili-plugin-conversation",
  "tool": "compress",
  "args": { "content": [{ "startId": "m00001", "endId": "m00042", "summary": "...", "topic": "..." }] }
}
```

Response:

```json
{ "ok": true, "tool": "compress", "conversationId": "...", "result": "[Compressed m00001–m00042 → 1 block(s), ~1742 tokens saved.]" }
```

Return `result` verbatim as the native tool result content.

Notes:

- Execution happens **under the session lock**, against the same view the model was shown on the last request (refs match what the model sees).
- `compress` mutates state; `decompress` / `search_context` / `acp_status` are read-only.
- Errors: `400` invalid JSON / missing `conversationId` / unknown tool, `404` unknown conversation (no model request has arrived with that conversation id yet), `500` execution failure.

### 4. `GET /__bili/plugin/status?conversationId=<id>`

Context-level visibility for plugin UIs (status bars / slash commands):

```json
{
  "ok": true,
  "conversationId": "...",
  "sessionId": "...",
  "pluginAgent": "pi",
  "contextLimit": 200000,
  "contextTokens": 138211,
  "inputTokens": 251000,
  "outputTokens": 40021,
  "cachedTokens": 180000,
  "requests": 42,
  "blocks": [{ "id": "b3", "tier": 1, "active": true }],
  "lastSeen": 1755300000000
}
```

`contextTokens` is the last reported context size (input + cache-read) — the same value the nudge decision reads. Errors: `400` missing `conversationId`, `404` unknown conversation.

### 5. `POST /__bili/plugin/compact`

Notify the proxy that the agent performed an **in-session native compaction** (e.g. omp's `/compact` or its auto threshold): the next model request re-sends a shortened history (compaction summary + retained tail) under the SAME conversation id. Fire-and-forget is fine — a failed notification must never break the agent's compaction.

```json
{ "conversationId": "the same value you send as x-bili-plugin-conversation" }
```

Effect: the proxy marks a one-shot compaction boundary on the session. On the next model request, blocks that were active before the compaction but no longer anchor into the shortened history are downgraded to a pre-compaction archive (listed by `acp_status` with a reason; `decompress` on one returns an explicit "unavailable" error instead of failing silently), and stale `byRaw`/`byRef` mappings are pruned to the live ids. Errors: `400` invalid JSON / missing `conversationId`, `404` unknown conversation.

### 6. MITM transparent-proxy mode

The `/bili/` prefix is absent in MITM mode, so URL-based detection cannot work. Instead the proxy's own launcher (`bili pi` / `bili codex` / `bili claude`) exports `BILLION_CONTEXT_PROXY=http://127.0.0.1:<port>` in the child env, next to the `HTTPS_PROXY` + CA vars it already sets. A plugin detects cooperative mode by reading that env var (the proxy origin for all `/__bili/plugin/*` calls); everything else (headers, tool forwarding, status) is identical — the `x-bili-plugin*` headers pass through the MITM tunnel into the same pipeline. This is also where `x-bili-plugin-context-window` matters most: MITM upstreams are often private relays the models.dev registry doesn't know.

### 7. Lifecycle of one compression (what the plugin does)

1. Model replies with a native `compress` tool call (args contain `startId`/`endId` refs it read from the tag-annotated context).
2. The agent ends the assistant turn; the plugin's tool handler fires.
3. Plugin POSTs `{conversationId, tool: "compress", args}` to `/__bili/plugin/tool`.
4. Plugin returns `result` as the tool result; the agent appends it to history and re-requests.
5. The next model request carries the tool call + result in history; the proxy's `processTurn` hides the consumed call and folds the compressed range out of the wire body. The summary lives in block state, retrievable via `search_context` / `decompress` — the same as wire mode.

No special handling is needed for decompression: `decompress` results come back through the same endpoint.

## Security

- The tool endpoints sit behind the `/__bili/` admin gate: loopback-only + trusted-origin. A plugin on the same machine as the proxy can call them; nothing else can.
- Plugins only need to talk to the proxy on localhost; no extra credentials. Do NOT expose the proxy's plugin endpoints through reverse proxies.

## Obligations of a plugin

1. Register the four tools from the manifest (all of them; the model relies on the full set).
2. Send both headers on every model request through the proxy.
3. Forward tool executions verbatim; return `result` as the tool result.
4. Self-disable when not running behind bili (e.g. the agent's baseURL does not point at the proxy) — same convention as billion-context-pi / opencode-acp extensions.

## Reference

- Proxy implementation: `src/plugin.ts`, wiring in `src/server.ts` (search `pluginMode`).
- Tests: `tests/plugin-protocol.test.ts`.
