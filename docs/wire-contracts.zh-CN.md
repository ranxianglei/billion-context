# Wire 契约台账（WC ledger）

实现可声明自定义 wire 端点（#1295）过程中发现的**上游 wire 约束永久台账**。
规则（owner policy）：**实现中发现的每一个上游约束都必须成为一条永久 WC
条目** —— 条目只增不删，被取代时标注 `SUPERSEDED by WC-n`。代码内以 `(WC-n)`
引用条目；改动相关路径时两侧必须同步。

## 总则 —— 严格保真（strict fidelity）

已声明端点的请求/响应要么**整体转换**、要么**逐字节原样 relay** —— 绝不做
部分转换。codec 无法转换的任何形状都会拒绝整个 body（每个端点一次性大声
告警，之后静默 relay）。这是 #1284 先例按 wire 落地：同路径的非 LLM 端点，
或 codec 尚不理解的 provider 未来改版，必须大声暴露并原样透传，而不是被
静默篡改。

## commandcode CLI wire（`wire: "commandcode"`）

动机案例：`@mars-sea/dsh-commandcode-provider` Go plan ——
`POST https://api.commandcode.ai/alpha/generate`；请求 = 嵌套 CLI envelope
包着一个 openai-completions 形状的对话；响应 = 裸 JSONL 事件流（每行一个
JSON 对象，不是 SSE）。

| ID | 约束 | bili 中的后果 |
|----|------|--------------|
| WC-1 | `finish` 与 `error` 事件本身就是流终止符。没有 `[DONE]` sentinel、没有 SSE framing、终止事件之后没有任何字节。 | loop 恰好发出一个终止帧（`finish` 或 `error`）后停止。只有当流在终止事件送达**之前**中断时，`emitUpstreamTruncation` 才合成一行 `upstream_stream_truncated` error；已送达则什么都不写（`finished=true`）。 |
| WC-2 | rewrap 绝不允许在转发中途丢内容。 | codec 不认识的角色（例如 compat-roles 改写目标）降级为 `user` 文本消息，而不是丢弃。 |
| WC-3 | 上游可能发出 bili 不认识的行/事件（未来改版风险）。 | 不可解码的行、未知事件类型、畸形事件都逐字节透传 —— 且仅在第一轮（bili 自己的注入内容之前），避免把上游内容与注入混淆。绝不丢弃、绝不改写。 |
| WC-4 | tool-call `arguments` 是用户意图（#1039 不变量），必须语义保真地往返。 | unwrap：`input` 对象 → `JSON.stringify` → `arguments`（非对象 `input` 拒绝整个 body → verbatim relay）。rewrap：`arguments` 字符串 → JSON parse → `input` 对象（畸形 → `{}`）。bili 自己的代理工具（`compress`、`decompress`、`search_context`、`acp_status`、`bili_*`）在 proxy 模式下是临时的 —— 服务端执行，绝不转发给客户端；真实 tool call 从上游原始事件行逐字回放。 |
| WC-5 | 该 wire 没有 visibility marker 的专用通道。 | 注入的 marker 作为 prose 搭载在 `text-delta` 里。host TUI 是否将其隐形渲染属于 host 侧策略（renderTags），不是 wire 关注点。 |
| WC-6 | v1 仅限流式：provider 硬编码 `params.stream: true`，裸 JSONL 响应 codec 以此为前提。 | unwrap 要求 `params.stream === true`；否则不可转换 → 原始字节原样 relay + 一次性告警。 |

### Envelope 映射（unwrap / rewrap）

- 除 `params` 外的所有顶层 envelope key（如 `config`、`memory`、`taste`、
  `skills`、`threadId`）双向逐字透传。
- 未知的 `params.*` key 逐字透传（unwrap 时收集、rewrap 时还原）—— provider
  未来新增字段不得破坏往返。
- `params.system` ↔ system 角色消息：unwrap 提升为首条 `system` 消息；rewrap
  把所有 system 消息折叠回唯一的 `params.system` 槽位，以 `\n\n` 连接
  （原本不存在 ⇒ 省略；存在但为空 ⇒ 保留 `""`）。
- assistant block：`text` → content 字符串，`reasoning` →
  `reasoning_content`，`tool-call {toolCallId,toolName,input}` → OpenAI
  `tool_calls[]`（id/name 映射被记住以保证 rewrap 保真）。
- `user` content 数组只接受 `text` block；`tool` 结果的 `output` 只接受
  `text` 或 `error-text`（字符串）。其余一律拒绝整个 body。
- 已声明的归一化（语义无损，字节级）：多段 `user` text block 在 unwrap 时以 `\n`
  合并、rewrap 时作为单个 block 输出；assistant `content` 在 rewrap 时总是作为
  block 数组输出（字符串 content 变为单个 `text` block）；`tool` result 在 rewrap
  时总是携带 `toolName`（缺失时从配对的 assistant tool-call 推导，无配对时为
  `"unknown"`）；messages 中不含任何非 `system` 角色的 body 会被拒绝（无可压缩内容）。
- usage：`finish.totalUsage.{inputTokens,outputTokens}`（+
  `inputTokenDetails.cacheReadTokens`）映射到 kernel usage 三元组
  `(inputTokens, outputTokens, cachedTokens)`。
- 错误：`{"type":"error","error":<code>,"message"}` —— 客户端抛
  `LlmError`；重试策略属于 CLI 的 HTTP 层，所以 bili 的 preflight/stream
  错误帧只携带 code+message。
