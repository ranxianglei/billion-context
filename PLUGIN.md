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
    "conversation": "x-bili-plugin-conversation"
  },
  "toolEndpoint": "/__bili/plugin/tool"
}
```

Register the four tools natively with your agent, in whichever wire format your agent speaks. If `protocolVersion` is higher than you know, still register the tools — extra fields in schemas are ignored by agents.

### 2. Request headers

On **every model request** the plugin sends:

- `x-bili-plugin: <agent-name>` — announces plugin mode for this session.
- `x-bili-plugin-conversation: <conversation-id>` — the agent's real conversation/session id, stable for the whole conversation.

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

### 4. Lifecycle of one compression (what the plugin does)

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
