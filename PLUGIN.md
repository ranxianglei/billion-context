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
    "contextWindow": "x-bili-plugin-context-window",
    "instructionsMutable": "x-bili-plugin-instructions-mutable"
  },
  "toolEndpoint": "/__bili/plugin/tool",
  "statusEndpoint": "/__bili/plugin/status",
  "capabilities": {
    "fork": { "protocolVersion": 1, "endpoint": "/__bili/plugin/fork", "snapshotEndpoint": "/__bili/plugin/snapshot" }
  }
}
```

Register the tools natively with your agent, in whichever wire format your agent speaks — register exactly what `toolNames` lists. `absorb` appears only when the proxy's config enables it; `acp_rule` is advertised only when the proxy's config enables it (`compress.rules: true`, opt-in). Calling a tool that is known but disabled answers `200` with an explanatory `result` instead of an error (#1192). If `protocolVersion` is higher than you know, still register the tools — extra fields in schemas are ignored by agents.

### 2. Request headers

On **every model request** the plugin sends:

- `x-bili-plugin: <agent-name>` — announces plugin mode for this session.
- `x-bili-plugin-conversation: <conversation-id>` — the agent's real conversation/session id, stable for the whole conversation.
- `x-bili-plugin-context-window: <tokens>` (optional but recommended) — the model's context window as configured inside the agent (e.g. a pinned/overridden `contextWindow`). This becomes the authoritative "native" window for nudge decisions — it outranks the proxy's built-in table and the models.dev registry (most valuable for private relays and MITM mode), while operator tuning (`compress.modelContextLimit`) still outranks it.
- `x-bili-plugin-instructions-mutable: 1` (optional; send only if true) — declares that your conversation ids are **persona-scoped**: one id per persona, and the request's system/instructions text may change mid-conversation without changing the persona (e.g. opencode re-renders AGENTS.md into `instructions` on every edit). The proxy now keys plugin conversation ids verbatim by default (#1106), so this flag is vestigial for current proxies — keep stamping it for compatibility with older proxy versions, which use it to stop mixing the instructions text into the compression-namespace fingerprint.

- `x-bili-plugin-agent: main` (optional) — vetoes side-request demotion for this one request. Requests are otherwise demoted to the verbatim side lane when they look like auxiliary traffic (#388: small `max_tokens`, or a known side persona such as opencode's title generator). A full main turn that re-sends the conversation can still trip those heuristics; stamping `main` keeps it on the kernel path so it captures history, stays compressible and remains forkable. Any other value declares the side persona id itself (it is then matched against the known side-request persona set, not treated as `main`).

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
{ "ok": true, "tool": "compress", "conversationId": "...", "outcome": "applied", "blocksCreated": 1, "result": "[Compressed m00001–m00042 → 1 block(s), ~1742 tokens saved.]" }
```

Return `result` verbatim as the native tool result content. `ok` reflects transport + execution only (it stays `true` when the kernel refuses a fold range — the refusal receipt then sits in `result`). The machine-readable business outcome rides in the additive `outcome` field (#1875): for `compress` it is `applied` / `partial` / `refused` plus `blocksCreated`; for every other tool `success` / `failure`. Older proxies omit both fields; the #1192 disabled-note answer stays exactly `{ ok: true, result }`.

Notes:

- Execution happens **under the session lock**, against the same view the model was shown on the last request (refs match what the model sees).
- Optional `expectedRevision` is the opaque `parentRevision` from a snapshot. It requires an explicit `conversationId` and is checked under the same session lock immediately before execution. A stale revision returns `409 PARENT_REVISION_CONFLICT` without executing the tool. This also avoids witness routing to another conversation. Existing callers omitting it retain their routing and execution behavior.
- `compress` mutates state. Inline `decompress` marks a block restored for re-folding; range restores queue content for the next request. Successful restores also update the estimated context footprint. `search_context` / `acp_status` are read-only.
- Errors: `400` invalid JSON / missing `conversationId` / unknown tool, `404` unknown conversation (no model request has arrived with that conversation id yet), `500` execution failure. A **known but disabled** opt-in tool (`absorb` / `acp_rule`) is not an error: it answers `200` with `ok: true` and a `result` explaining that the feature is off on this proxy (#1192).

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
  "contextTokensSource": "usage",
  "contextTokensAt": 1755300000000,
  "contextGeneration": "opaque-generation",
  "sessionRevision": "opaque-revision",
  "model": "claude-sonnet-4",
  "inputTokens": 251000,
  "outputTokens": 40021,
  "cachedTokens": 180000,
  "requests": 42,
  "blocks": [{ "id": "b3", "tier": 1, "active": true }],
  "lastSeen": 1755300000000
}
```

`contextTokens` is the effective current input footprint, not accumulated billing. `contextTokensSource` is `usage` only for a real positive upstream input measurement with no outstanding fold credit, `estimate` for a local projection, or `unavailable` with `contextTokens: null`. Manual `compress` subtracts only its new credit from the previous observation, once; successful `decompress` adds the returned content (or file pointer) and any newly queued range content. Both publish an independent `estimate` observation without replacing the last-usage calibration baseline or changing cumulative `inputTokens` / `cachedTokens`. Never add those billing fields to infer effective context.

Forwarding a new model request replaces the previous observation with an estimate until a real positive usage report arrives. That report restores `usage`; zero/missing usage cannot revive an older measured generation. A real report netted against outstanding fold credit remains an estimate of the effective view, not a measurement of that view. Forks start with independent estimates, not inherited parent usage.

`contextTokensAt` is the observation time in Unix milliseconds (not the status read time), independently of the last usage timestamp. `contextGeneration` is an opaque change detector covering a unique observation id, context, revision, model and limit: successive observations remain distinct even at the same timestamp with identical token counts; repeated status reads do not create observations. Unavailable context has null tokens, timestamp and generation. Legacy persisted sessions without an independently attributed observation are unavailable until another request establishes one. `sessionId` and nullable `sessionRevision` identify the resolved session and its fork state. Pre-first-request/chain-only responses explicitly report unavailable context. Persisted sessions are loaded by the requested id before considering an explicitly requested `fallback=latest`. Errors: `400` missing `conversationId`, `404` unknown conversation.

`compressibleRanges` is the live kernel recommendation as structured `{startRef, endRef, count, ...}` entries for `sessionRevision`, or `null` if it cannot be computed. An empty list means there is no recommended range. Read the exact conversation without `fallback=latest`, match the snapshot revision and ordered refs, and submit manual `compress` with `expectedRevision`; never parse the human panel or guess a fixed prefix. Hosts must exclude their retained first-user anchor from summaries: kernel pruning retains it even if a recommendation spans it. A concurrent mutation is rejected by the revision guard.

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

### 8. Public snapshot and fork (protocol 1)

Discover `capabilities.fork` from the manifest; do not infer support from the package version. No new configuration is required. These endpoints use the same admin gate and request-body limit as the tool API.

`GET /__bili/plugin/snapshot?conversationId=<stable-parent-id>` returns:

```json
{
  "ok": true, "protocolVersion": 1, "status": "exact",
  "conversationId": "parent", "sessionId": "parent",
  "parentRevision": "<opaque SHA-256 revision>",
  "orderHash": "<SHA-256 of the full orderedMessages JSON>",
  "orderedMessages": [{ "rawId": "h_example", "ref": "m00001", "identityHash": "<opaque SHA-256 identity>" }],
  "messages": [{ "rawId": "h_example", "ref": "m00001", "role": "user", "text": "original text", "contentType": "text" }]
}
```

`messages` is in exactly the same order as `orderedMessages`, describes the raw `pluginSnapshot` rather than a folded view, and includes optional `text`, `toolName`, and `toolCallId`. Compare original text and role to establish the longest matching prefix; tool identities/content type must match too. Copy the corresponding ordered identities verbatim; `identityHash` and revisions are opaque and clients do not need a content-hash algorithm. A message the kernel hard-excludes from compression (`compress.protectedTools`) carries `"ref": null` in both arrays — it participates in ordering and identity but has no addressable ref; copy it verbatim like any other prefix entry. Only `mNNNNN` strings or `null` are legal ref values. Multimodal/opaque content that cannot be verified by this text projection returns `409`, `status: unavailable`, `code: SNAPSHOT_UNAVAILABLE`, not a guessed text match. Missing raw snapshots or inconsistent raw/ref/CCR mappings likewise fail closed. Raw snapshot retention is capped (`BILI_PUBLIC_SNAPSHOT_CAP_BYTES`, default 16 MiB, `0` disables): a session whose serialized raw snapshot grows past the cap stops being forkable — snapshot/fork answer `409 SNAPSHOT_UNAVAILABLE` — instead of retaining an unbounded raw copy forever.

`POST /__bili/plugin/fork` body:

```json
{
  "protocolVersion": 1,
  "parentConversationId": "parent", "childConversationId": "new-child",
  "parentRevision": "<snapshot.parentRevision>",
  "branchPoint": { "messageCount": 1, "orderHash": "<prefix order hash>" },
  "orderedMessages": [{ "rawId": "h_example", "ref": "m00001", "identityHash": "<snapshot identity>" }],
  "idempotencyKey": "stable-operation-id"
}
```

The branch is an ordered prefix, including an empty prefix. Compute its existing order hash as lowercase SHA-256 of UTF-8 `JSON.stringify(orderedMessages)` with each identity object's keys in order `rawId`, `ref`, `identityHash`; for a full prefix reuse snapshot `orderHash`. Do not hash descriptors or folded text. Extra child messages, including a final model reply that has not left the proxy yet, may be appended on the child's first model request after copying the matched prefix.

New success is `201`; exact payload replay is `200` with `replayed: true`, even after restart or later parent changes. Both return `status`, `parentRevision`, `childRevision`, `sessionId`, `branchPoint`, `inheritedBlocks`, and `expandedBlocks`. Reusing the child id with another parent, key or payload returns `409 CHILD_CONFLICT`. Invalid shapes/version/identifiers return `400 INVALID_REQUEST`; absent parent returns `404 PARENT_NOT_FOUND`; stale parent returns `409 PARENT_REVISION_CONFLICT`; altered order/raw/ref/identity returns `409 BRANCH_POINT_CONFLICT`. Missing nested originals return `409 PARENT_STATE_INCOMPLETE` with `status: unavailable`. Publication/persistence failure returns `503 FORK_FAILED` with `status: unavailable` and exposes no child; the same request may be retried.

Boundary handling is `exact` when complete blocks fit inside the prefix, `expanded` when a block crosses it (crossing summaries are omitted, affected nested descendants are expanded, matched originals are retained), and `unavailable` when safe reconstruction is impossible. Blocks, nested caches, raw messages, issued ref namespace, token snapshots, rules and prefix CCR payloads are independent copies. Note that the child inherits the parent's ENTIRE issued-ref namespace (dead refs included): refs are never reused, so forks keep allocating fresh refs without colliding with ids a sibling may still hold. The child never reads its parent's later state as a fallback. Registration and first-request resume heuristics do not replace its copied state. With existing persistence enabled, raw snapshots, receipts, nested originals and the child's CCR payloads survive restart; with persistence disabled, durability is not promised. Atomic child publication/idempotency covers concurrent requests to one proxy process; concurrent writers sharing one state directory across processes are not supported by this protocol.

Lineage-only declaration (#2408): a host that cannot drive the full fork protocol (no snapshot matching, e.g. claude `--fork-session`) may still declare the parent by sending a plain identity register — `POST /__bili/plugin/register` with `conversationId` (the fresh child id), `identity: true` and `parentConversationId` — from its SessionStart hook. The declaration scopes the proxy's content-match resume inheritance (#1486) to that parent chain, so a byte-exact replay of the parent's wire history seeds refs/blocks on the child's first request, and a non-matching replay falls back to the read-only parent link (#1333). A later register without `parentConversationId` never erases the declared parent. This is strictly weaker than §8 (no dead-ref namespace, no nudge inheritance, no receipt verification) but needs no snapshot access.

中文集成要点：协议仍为 1；先读取 manifest 能力及 snapshot，按原文、role、工具身份确认匹配前缀，仅提交该前缀的 orderedMessages，不猜测多模态分支点。被 `compress.protectedTools` 硬排除的消息在两个数组中均为 `"ref": null`（参与顺序与身份、无地址 ref），与其他前缀条目一样逐字提交；ref 合法值仅 `mNNNNN` 字符串或 `null`。父 revision 变化必须重新取快照并重新匹配。子会话使用独立稳定 id，首次请求可追加尚未出站的模型回复，不能重置继承的 refs/blocks。手动摘要使用 snapshot 的 refs 和 `expectedRevision: snapshot.parentRevision` 调用公开 tool；摘要期间历史发生变化时返回 409，不执行旧摘要。状态栏读取 `contextTokens`、`contextTokensSource`、`contextTokensAt`、`model`、`contextLimit`、`contextGeneration`、`sessionId` 与 `sessionRevision`，不得用累计账单 input/cache 冒充有效上下文。手动 compress/decompress 后为独立时间及 generation 的 estimate，不改累计账单或 last-usage 基线；下一次正数 usage 才恢复 usage，零值或缺失 usage 不得复活旧观测。未知来源返回 unavailable，tokens/time/generation 为 null。

## Security

- The tool endpoints sit behind the `/__bili/` admin gate: loopback-only + trusted-origin. A plugin on the same machine as the proxy can call them; nothing else can.
- Plugins only need to talk to the proxy on localhost; no extra credentials. Do NOT expose the proxy's plugin endpoints through reverse proxies.

## Obligations of a plugin

1. Register the tools from the manifest (all of them as listed; the model relies on the full set).
2. Send both headers on every model request through the proxy.
3. Forward tool executions verbatim; return `result` as the tool result.
4. Self-disable when not running behind bili (e.g. the agent's baseURL does not point at the proxy) — same convention as billion-context-pi / opencode-acp extensions.
5. Keep tool-call ids byte-stable within one conversation, including when projecting it onto another provider. Tool-message identity keys on `toolCallId` as the protocol-stable pairing factor; a projection that rewrites those ids (e.g. sanitizing stored composite ids for a foreign Responses provider) silently loses fold coverage — compressed tool outputs re-enter the wire unfolded (#2396). Canonicalize ids at the host boundary before the payload reaches the proxy; the proxy detects the shape and names it in the fold-drift log, but never repairs onto guessed pairings (see MESSAGE-IDENTITY.md).

## Reference

- Proxy implementation: `src/plugin.ts`, wiring in `src/server.ts` (search `pluginMode`).
- Tests: `tests/plugin-protocol.test.ts`.
