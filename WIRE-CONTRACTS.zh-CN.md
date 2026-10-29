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
## TRAE SOLO wire（`wire: "trae"`）

动机案例：Trae IDE 自带的 SOLO agent 车道 ——
`POST https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`；请求 = Trae
envelope 包着的 openai-completions 对话（`function: "solo_agent"`，模型 id 同时写在
`config_name`，Max 模式完全靠 body 里的 `mode_type` / `context_window_size` /
`prompt_max_tokens` 表达）；响应 = 帧名自成一派的 SSE 变体。

| ID | 约束 | bili 侧的后果 |
|----|------|---------------|
| WC-12a | 对话是 openai-completions 形状，但 message 的 content 恒为 text parts 数组 —— tool 结果也一样。 | unwrap 把 parts 拼回一个字符串；出现非 text part（图片/音频）即判定整个 body 不可转换 → 原样 relay。rewrap 把每条消息还原成单个 text part。 |
| WC-12b | tool call 保留 OpenAI 外层（`id`、`type: "function"`），但载荷键改名为 `function_call`；带工具调用的 assistant 轮 `content: null`。 | unwrap 改回 `function`；rewrap 改回 `function_call` 并还原工具轮的 `content: null`（`arguments` 按字节语义保真，#1039）。 |
| WC-12c | 流是 `event:<name>` / `data:<json>`，冒号后没有空格，也没有 `[DONE]`；`done` 帧是终止符。帧序：`metadata` → `timing_cost` → N×`output` → (`extra_info`) → `token_usage` → `done`。 | 适配器按该方言解析；`emitCompletion` 写 `token_usage` + `done`。只有 `done` 之前的断流才合成 `error` 帧。 |
| WC-12d | rewrap 绝不允许在转发中途丢内容。 | 该 wire 没有对应槽位的角色（例如 compat-roles 的重写目标）降级为 `user` 文本，而不是被丢弃。 |
| WC-12e | 上游可能发出 bili 不认识的帧（未来改版风险）。 | 未知帧名、无法解析的 `data:` 载荷一律按字节原样转发 —— 只限第一轮，避免 bili 自己的注入被误当成上游内容。 |
| WC-12f | `token_usage` 的真实计数在每请求字段里；所有 `*_total` 字段恒为 0。 | usage 从 `prompt_tokens` / `completion_tokens` / `cache_read_input_tokens` 映射；`*_total` 字段从不读取。 |
| WC-12g | 该 wire 没有 visibility marker 的专用通道。 | 注入的 marker 以散文形式搭在 `output` 帧的 `response` 里；渲染成什么样由宿主策略决定。 |
| WC-12h | `output.reasoning_content` 与 `response` 用同一种帧流式下发（没有独立 reasoning 事件），且 `extra_info` 会重复投递已经流过的 reasoning。 | reasoning 走 reasoning 通道；`extra_info` 原样转发（第一轮），绝不重新注入重建后的对话。 |
| WC-12i | 同一轮内的**并行工具调用**：capture 只钉住了单调用分帧（全信封帧带 `index: 0`，其后只给 `arguments` 增量且 `id` 为空串）。该 wire 如何区分同一轮里的**第二个**调用，尚未捕获。 | 出站方向 `emitToolCall` 按出现顺序编号（0、1 …），与 `adapter-openai` 一致 —— 只有一个调用时与捕获形状逐字节相同，出现两个时不会都撞在 0 上。入站方向：若某帧在已占用的 `index` 上带来**不同的非空 `id`**，则开启一个新调用而不是并入缓冲 —— id 不同即调用不同。 |

### Envelope 映射（unwrap / rewrap）

- `messages`：text parts → 字符串（还原时每条消息一个 part）。
- `tools`：标准 OpenAI 形状，原样透传。
- flat body 装不下的 envelope 键（`function`、`config_name`、`mode_type`、
  `context_window_size`、`prompt_max_tokens`、`model_selection_strategy`、
  `model_auto_selection` …）在 unwrap 时逐字记下，于最终转发边界（以及每次循环
  压缩重发）原样回放。
- 验证边界：上述请求/响应形状来自真机 capture（#1295）。bili 侧往返有单测覆盖；
  但**没有**跑过「压缩后的对话被真实 Trae 客户端回放」的端到端验证 —— 那需要一个
  活的账号席位。单调用分帧已被钉住；并行调用轮（WC-12i）正是该回放要敲定的具体
  fixture（这条 wire 究竟给第二个调用编号，还是复用 `index: 0` 换一个新 `id`）。

