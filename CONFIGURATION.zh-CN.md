# billion-context 配置参考

[English](./CONFIGURATION.md) | [中文](./CONFIGURATION.zh-CN.md)

`billion-context` 是一个 HTTP 代理，用于将 [ACP](https://github.com/ranxianglei/acp-kernel)（Active Context Pruning，主动上下文剪枝）的上下文压缩注入到 LLM API 流中。下文所有选项都位于同一个 JSON 配置文件中（也可通过等价的环境变量 / CLI 参数设置）。

---

## 配置文件位置

| 范围 | 路径 | 说明 |
|------|------|------|
| **配置文件（Linux）** | `~/.config/billion-context/billion-context.json` | XDG 基础目录规范 —— 标准、用户可编辑的配置 |
| **配置文件（覆盖目录）** | `XDG_CONFIG_HOME` 的值 | 重定位整个配置目录 |
| **配置文件（显式指定）** | `BILI_CONFIG_FILE` 的值 | 直接指向任意 JSON 文件 |
| **CLI 参数** | `--config <FILE>` | 与 `BILI_CONFIG_FILE` 等价，文件路径优先级最高 |
| **会话数据** | `~/.local/share/billion-context/sessions/` | 持久化的压缩状态，会随时间增长 |

首次运行时，`billion-context` 会在配置路径下生成一个空模板（`{ "providers": {} }`），方便你直接编辑。它**不会**覆盖已存在的文件。

配置文件是一个纯粹的覆盖层 —— 每个字段都是可选的。任何未设置的字段都会回退到内置默认值。

---

## 快速开始

```jsonc
// ~/.config/billion-context/billion-context.json
{
  // 服务端
  "port": 8787,
  "host": "127.0.0.1",

  // 路由两个 provider
  "providers": {
    "https://api.anthropic.com": {
      "models": {
        "claude-sonnet-4-5": { "context": 200000, "output": 8192 }
      }
    },
    "https://generativelanguage.googleapis.com": {
      "models": {
        "gemini-2.5-pro": { "context": 1000000 }
      }
    }
  },

  // 全局压缩调优（应用于每个请求）
  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%"
  }
}
```

---

## 参数参考

状态说明：**ACTIVE（启用）** = 当前生效 | **DEPRECATED（已弃用）** = 接受但无效果 | **EXPERIMENTAL（实验性）** = 可能变更

---

## 服务端设置

这些顶层键控制代理的监听方式与全局行为。

### `port`

- **类型：** `number`
- **默认值：** `8787`
- **状态：** ACTIVE
- **说明：** 代理监听的 TCP 端口。必须是 1 到 65535 之间的整数。可由 `ACP_PORT`（或 `PORT`）环境变量或 `--port` CLI 参数覆盖。非法值会导致启动中止。

### `host`

- **类型：** `string`
- **默认值：** `127.0.0.1`
- **状态：** ACTIVE
- **说明：** 代理绑定的网络接口。`127.0.0.1`（默认）仅监听本机 —— 适合本地 sidecar。使用 `::` 可同时监听 IPv4 + IPv6 双栈。使用 `0.0.0.0`（或局域网 IP）可将代理暴露给其他机器 —— 常见于容器或可信局域网: 远程 agent 把模型 `baseURL` 指向 `http://<本机>:<端口>/bili/…`，MITM 模式的 `CONNECT` 仅对白名单内的模型域名接受远程客户端（盲隧道仍仅限本机，`/__bili/` 管理端点也仍仅限本机）。没有任何鉴权 —— 请确保所在网络可信。可由 `ACP_HOST` / `--host` 覆盖。

### `sessionHeader`

- **类型：** `string`
- **默认值：** `x-acp-session`
- **状态：** ACTIVE
- **说明：** 客户端可发送的、用于标识一次会话的 HTTP 请求头名称。携带相同值的请求会在多次调用间共享压缩状态。可由 `ACP_SESSION_HEADER` 覆盖。

### `log`

- **类型：** `boolean`
- **默认值：** `true`
- **状态：** ACTIVE
- **说明：** 启用逐请求日志。设为 `false`（或 `ACP_LOG=0`）可关闭标准请求日志。

### `debug`

- **类型：** `boolean`
- **默认值：** `false`
- **状态：** ACTIVE
- **说明：** 详细日志 —— 等价于设置 `ACP_DEBUG=1`。在排查路由或压缩行为时很有用。

### `passthrough`

- **类型：** `boolean`
- **默认值：** `false`
- **状态：** ACTIVE
- **说明：** 将每个请求**不经过**压缩、工具注入或 nudge，直接转发到上游。等价于 `ACP_PASSTHROUGH=1`。便于与未压缩基线做 A/B 对比。

### `compat`

- **类型：** `{ roles?: Record<string, string> }`
- **默认值：** `{}`（禁用）
- **状态：** ACTIVE
- **说明：** 全局线上兼容角色映射。`roles` 把消息角色映射为上游接受的角色名，例如 `{"compat":{"roles":{"developer":"system"}}}` 把 `developer` → `system`，用于拒绝 `developer` 角色的上游（#552，新版 codex 客户端会发送）。作用于 `openai` chat-completions 与 `responses` 请求；仅精确匹配角色，体内其它内容不动；压缩重试重发的请求体同样携带。按 provider 的 `compat.roles`（见 [Providers](#providers)）按键优先。默认 `{}` 逐字节透明转发。
- **失败自学习：** 未配置 compat 时，上游返回 `400 Invalid role: …` 会被自动修复 —— bili 把被拒角色改写为 `system`，重试一次，并把学到的映射记在**会话上**（仅内存，绝不写入配置）。该会话后续请求免 400 往返。修复生效时打印的 info 日志附带可永久化的 per-provider 片段。

### `proxy`

- **类型：** `string`
- **默认值：** *（无 —— 不使用上游代理）*
- **状态：** ACTIVE
- **说明：** 用于代理**自身**到模型 provider 的出站连接的上游 HTTP 代理（`http://host:port`）。不支持 SOCKS5。在 `providers` 条目内设置的按 URL 的 `proxy` 会针对该 provider 覆盖此项。空字符串表示"显式直连" —— 为所有 provider 禁用任何环境/系统代理回退。

### `imageBilling`

- **类型：** `"auto" | "pixels" | "bytes"`
- **默认值：** `"auto"`
- **状态：** ACTIVE
- **说明：** 预检尺寸门与输出钳制对内联（base64）图片的计费方式（#488/#496/#767）。`"bytes"` 按 `base64 长度 / 4` 计 token —— 保守，且对字节计费 relay 正确。`"pixels"` 只解析图片头（PNG/JPEG/WebP/GIF/BMP）、不解码完整图像，按第一方像素 tile 计费（OpenAI high-detail 模型：512px tile、短边放大到 768px、长边封顶 2048px → 每图 765–2805 token；无法解析的格式回退为固定 16384）。远程（`https://`）图片在两种模式下都固定计 4096。按 provider 的 `providers.<url>.imageBilling` 优先于本全局项，而 `BILI_IMAGE_BILLING` 环境变量优先于两者（实时读取，无需重启）。

---

## Providers

`providers` 块将**上游 URL** 映射到按 provider 的配置。每个键是一个 URL 前缀；每个值可以声明模型上下文窗口、按 provider 的代理、压缩协议、压缩覆盖项、图片计费模式，以及按路由的透传开关。

```jsonc
{
  "providers": {
    "https://api.anthropic.com": {
      "models": {
        "claude-sonnet-4-5": { "context": 200000, "output": 8192 }
      },
      "proxy": "http://10.0.0.1:7890",
      "compressProtocol": "tools",
      "compress": { "maxContextLimit": "70%" }
    }
  }
}
```

### URL 键匹配

键通过**最长前缀胜出**的方式与请求的上游 URL 匹配。当请求 URL 等于该键，或以 `键 + "/"` 开头时，匹配成立。这使得匹配在边界上是安全的：键 `https://api.example.com` 能匹配 `https://api.example.com/v1/chat`，但**不会**匹配 `https://api.example.com.evil`（一个攻击者控制的相似域名）。

浅层键（`https://open.bigmodel.cn`）匹配该主机上的所有路径。深层键（`https://open.bigmodel.cn/api/anthropic`）仅匹配该端点。当两个键都匹配时，最长（最具体）的那个胜出。键末尾的斜杠会被自动去除。

### `models`

- **类型：** `Record<string, { context?: number; output?: number; compress?: CompressSettings }>`
- **默认值：** *（无）*
- **状态：** ACTIVE
- **说明：** 将模型名映射到其上下文窗口声明。LLM 的 `/models` 端点**不会**返回上下文窗口大小（已在 OpenAI、Anthropic、zhipu、comfly 上验证），因此代理无法在运行时发现它们 —— 你必须在此声明。`context` 是模型的上下文窗口（以 token 为单位）；`output` 是最大输出大小，在请求完全不携带输出预算字段时作为 output headroom 预留的回退值（见 [`outputHeadroomMaxPct`](#outputheadroommaxpct)）。当模型未声明时，代理回退到内置上下文表或 models.dev 注册表。每个模型条目还可以携带按模型的 `compress` 块（见[压缩调优](#压缩调优)）。

  内置上下文表是随每个版本发布的静态数据，可能过期 —— 例如 DeepSeek 的规范请求 id `deepseek-flash` 在 models.dev 上没有以该名列出（其窗口列在 `deepseek-v4-flash` 名下），因此只有兜底表能回答它（#852）。日志会为每个模型记录一次胜出来源（`[window] ... fallback=true` 表示值来自内置表）。若解析出的窗口不对，按上文声明 `models.<name>.context`（它优先于注册表和内置表），或固定 `compress.modelContextLimit`；注意 provider 键必须带流量的 scheme（MITM 登录态客户端流量用 `mitm://<host>`，`/bili/` 流量用 `https://<host>`）。

### `proxy`

- **类型：** `string`
- **默认值：** *（继承顶层 `proxy`）*
- **状态：** ACTIVE
- **说明：** 按 provider 的上游 HTTP 代理（`http://host:port`）。仅针对该 provider 覆盖顶层 `proxy`。空字符串表示"显式直连" —— 在这一个 provider 上覆盖全局代理且不使用任何代理。

### `compressProtocol`

- **类型：** `"tools" | "marker"`
- **默认值：** `"tools"`
- **状态：** ACTIVE
- **说明：** 压缩工具注入请求的方式。`"tools"`（默认）将它们作为原生函数调用工具注入。`"marker"` 改用文本触发协议 —— 用于那些无法与已声明的 `tools` 字段共存的下游上游。

### `compress`

- **类型：** `CompressSettings`
- **默认值：** *（继承全局 `compress`）*
- **状态：** ACTIVE
- **说明：** 按 provider 的压缩覆盖项。这是三层合并中的**第 2 层** —— 见[压缩调优](#压缩调优)。

### `compat`

- **类型：** `{ roles?: Record<string, string> }`
- **默认值：** `{}`（禁用）
- **状态：** ACTIVE
- **说明：** 按 provider 的线上兼容覆盖。`roles` 把消息角色映射为该上游接受的角色名，例如 `{"developer": "system"}` —— 用于拒绝 `developer` 角色的上游（#552，新版 codex 客户端会发这个角色）。作用于最终转发的 `openai`/`responses` 请求体 —— 客户端发送的角色和 bili 自己注入的提示一视同仁 —— 压缩重试循环重发的请求体同样携带该改写。按键覆盖全局 `compat` 块（见[服务端设置](#服务端设置)）。默认 `{}` 逐字节透明转发。

### `passthrough`

- **类型：** `boolean`
- **默认值：** *（无 —— 压缩开启）*
- **状态：** ACTIVE
- **说明：** 按路由覆盖全局 [`passthrough`](#passthrough) 设置。设为 `true` 时，匹配该路由的所有请求**逐字节转发**：不走 kernel 往返（不重序列化 messages、不注入 ACP 渲染标签、不删除 `prompt_cache_key`），响应原样 pipe，该路由不建立 session 状态。用于上游反作弊会拒绝 bili 改写后请求体的场景 —— 例如 ZCode 对 kernel 重建的 `messages` 请求体返回 `405 / 3012`（"request has been blocked due to unusual activity"，#661）。`mitm://` 键只命中该 host 的 MITM（登录态客户端）流量，普通 `https://` 键只命中 `/bili/`（API key）流量 —— 两种 scheme 互不重叠：

  ```jsonc
  {
    "providers": {
      "mitm://zcode.z.ai": { "passthrough": true }
    }
  }
  ```

### `imageBilling`

- **类型：** `"auto" | "pixels" | "bytes"`
- **默认值：** *（全局 `imageBilling`，再回退 `"auto"`）*
- **状态：** ACTIVE
- **说明：** 按路由覆盖尺寸门的图片计费方式（#767）。官方 Codex/OpenAI/Anthropic 端点（像素 tile 计费）设 `"pixels"`，字节计数 relay 保持 `"bytes"` —— 字节计费下，历史 baseline 超窗加上大 base64 截图会让 preflight 永远 502，而上游实际每图只收几千 token。两级都未显式设置时，按上游 host 自动选择：以 `openai.com`、`openai.azure.com`、`chatgpt.com`、`api.anthropic.com` 结尾的 host → `pixels`，其余 → `bytes`。`BILI_IMAGE_BILLING` 环境变量覆盖两级配置：

  ```jsonc
  {
    "providers": {
      "https://chatgpt.com/backend-api/codex": { "imageBilling": "pixels" }
    }
  }
  ```

---

## 压缩调优

压缩行为由 `compress` 块控制，它可以出现在三个层级。它们按**逐字段、最深层胜出**的方式合并：在更深层设置的字段会覆盖上层同名字段，但更深层*未设置*的字段**永远不会**清除上层已设置的值。换言之，子级按字段覆盖父级 —— 它绝不是整体替换对象。

三个层级，从最宽泛到最具体：

1. **全局（Global）** —— 顶层 `"compress": { … }` 键。应用于每个请求。这是唯一会生效 `injectTool` / `injectNudge` 开关的层级。
2. **按 provider（Per-provider）** —— `providers[url]` 条目内的 `"compress": { … }` 块。
3. **按模型（Per-model）** —— `providers[url].models[model]` 条目内的 `"compress": { … }` 块。

对于每个请求，代理通过最长 URL 前缀匹配（找到 provider）和请求的模型名（找到模型条目）来解析设置，随后按 全局 → provider → 模型 合并。

### CompressSettings 字段

#### `modelContextLimit`

- **类型：** `number | string`
- **默认值：** *（模型的原始窗口）*
- **状态：** ACTIVE
- **说明：** 上下文窗口大小，以 token 为单位。它是引擎用于计算使用率比例的**分母**（`usage = tokens / modelContextLimit`）—— 它**不是**截断上限。接受绝对数值（`200000`）或百分比字符串（`"80%"` = 模型原始窗口的 80%，从内置表或 models.dev 注册表解析）。在每个层级都省略时，使用原始窗口。这是模型上限的最高优先级来源；它会覆盖内置表、旧版按模型的 `context` 字段以及顶层的 `modelContextLimit`。注意它同时也是**预检压缩的硬墙**：一旦载荷达到该值，代理会在转发前主动折叠上下文；若折叠后仍超出，请求会直接快速失败而不是发往上游。若希望日常上下文保持较小、同时允许大读取任务突发到原始窗口，请让 `modelContextLimit` 保持为原始窗口值，改用 `maxContextLimit` 作为软目标（见[软目标与弹性余量](#软目标与弹性余量-1122)）。

#### `outputHeadroomMaxPct`

- **类型：** `number | string`
- **默认值：** `0.25`
- **状态：** ACTIVE
- **说明：** 输出预留（output headroom）的上限，以上下文窗口的比例为单位：预留量 = `min(max_tokens, pct × window)`。**预算来源：** 当请求完全不带输出预算字段（`max_tokens` / `max_completion_tokens` / `max_output_tokens`）时 —— 例如 Codex native Responses 路径不发送 `max_output_tokens`（#924）—— 代理回退到模型声明的最大输出：先取 per-route 配置 `providers[url].models[model].output`，再取 models.dev registry 的 output ceiling（bundled snapshot 离线兜底）；都拿不到则不预留。同样的 cap 也作用于回退值。该预留让引擎的 nudge/truncate 档位位于 `window − 预留量` 之下，防止长回复把「输入+输出」推进窗口之外 —— 适用于把输出计入窗口的 API（Anthropic Messages 豁免：其 input limit 独立于 `max_tokens` 执行，故排除在外）。不设上限时，注册最大输出占窗口比例大的模型（如 262144 窗口上 maxTokens 131072）会失去大半输入预算，75% 强制压缩阈值会在约三分之一的完整窗口处就触发。默认 0.25 在控制损失的同时保证只要单轮回复不超过窗口的 25%，就不会在 95% 紧急阈值下溢出；更长的回复会溢出一次，由下一轮的 overflow self-heal 恢复。注意该上限只放宽过大的预留：当 `max_tokens` 本身 ≤ `pct × window` 时，预留仍是完整的 `max_tokens`（与旧行为逐字节一致）。接受比例（`0.25`）或百分比字符串（`"25%"`）；设 `0` 完全禁用预留；`>= 1` 恢复旧的完整预留行为（input + 用满预算的响应总能放进窗口 —— SGLang/vLLM 等严格后端的要求）。负数或无法解析的值会拒绝整个 `compress` 块。示例：窗口 262144 token、`max_tokens = 131072` → 默认 `0.25` 预留 65536 → 有效窗口 196608（旧完整预留：131072）；`max_tokens = 65536` → 预留 65536 → 196608 不变（65536 ≤ 窗口的 25%）。与 billion-context-pi（`#207`）对齐，见 #896。

#### `maxContextLimit`

- **类型：** `number | string`
- **默认值：** `"75%"`
- **状态：** ACTIVE
- **说明：** 触发**强制压缩** nudge 的上下文使用率阈值。一旦使用率越过该比例，引擎就会触发一个绕过 growth-gate 与节奏检查的 nudge。接受比例值（`0.75`）或百分比字符串（`"75%"`）。值越小，压缩越早。映射到内核字段 `nudge.maxContextLimitPct`。

#### `emergencyThresholdPercent`

- **类型：** `number | string`
- **默认值：** `"95%"`
- **状态：** ACTIVE
- **说明：** 触发大型工具输出**紧急截断**的上下文使用率阈值。接受比例值或百分比字符串。必须大于或等于 `maxContextLimit`。映射到内核字段 `nudge.emergencyThresholdPct` 和 `truncate.threshold`。

#### `nudgeGrowthTokens`

- **类型：** `number`
- **默认值：** `50000`
- **状态：** ACTIVE
- **说明：** 软压缩 nudge 的 token 增长步长。每当有这么多 token 变为可压缩时，大约就会触发一次 nudge。值越小，nudge 越频繁。映射到内核字段 `nudge.growthFloor` 和 `nudge.growthCap`（它将引擎的自适应区间扁平化为这个固定步长）。

#### `preserveRecentMessages`

- **类型：** `number`
- **默认值：** *（内核默认值，通常为 `5`）*
- **状态：** ACTIVE
- **说明：** 永远不会被纳入压缩的最新消息条数。用于保护活跃工作集，使模型逐字保留最近的几轮对话。映射到内核字段 `preserveRecentMessages`。

#### `preserveRecentTokens`

- **类型：** `number`
- **默认值：** *（内核默认值，通常为 `5000`）*
- **状态：** ACTIVE
- **说明：** 为最近消息保护预留的 token 预算。映射到内核字段 `preserveRecentTokens`。

#### `minCompressRangeChars`

- **类型：** `number`
- **默认值：** *（内核默认值，通常为 `5000`）*
- **状态：** ACTIVE
- **说明：** 一个消息范围可被纳入压缩的最小长度，单位为**字符**（不是 token）；更小的范围会被跳过。英文/代码平均约 4 字符/token，CJK 约 1-2 字符/token，同一数值对英文的实际语义比 token 直觉宽松约 4 倍。映射到内核字段 `compress.minCompressRange`。

#### `minCompressRange`

- **类型：** `number`
- **状态：** DEPRECATED（`minCompressRangeChars` 的弃用别名，向后兼容保留）
- **说明：** `minCompressRangeChars` 的旧名，内核映射（`compress.minCompressRange`）与单位（字符）完全相同。同层两键并存时新名优先；跨层时更深层优先，与键名无关。

#### `tiers`

- **类型：** `boolean`
- **默认值：** `true`
- **状态：** ACTIVE
- **说明：** 启用多层压缩 —— 对旧摘要进行 tier-2 蒸馏，以及 tier-3 凝缩。设为 `false` 可运行在仅 tier-1 模式（每个摘要都是扁平的 tier-1 摘要）。映射到内核字段 `tiers.enabled`。

#### `protectedLatestTools`

- **类型：** `string[]`（工具名模式，如 `["todo_list"]`）
- **默认值：** `[]`（无 —— 按客户端自行开启，工具名因客户端而异）
- **状态：** ACTIVE
- **说明：** 工具名模式列表：匹配工具的**最新**一次 tool-call 及其配对 result 永远不会被压缩（内核 `protectedLatestTools`，需 `acp-kernel` >= 0.0.80）。为累积快照型工具而设 —— 例如 agent 的 todo/任务清单，每条新 result 都取代旧的：只有最新实例是事实源，若用 `protectedTools` 保护**全部**实例会使该工具的历史无限膨胀，而只保护**最新**一条既让活跃快照留在上下文里，又让所有被取代的旧实例照常折叠。这解决了“压缩后 agent 忘掉任务清单”的故障（#639）。保护是硬排除：最新实例不可寻址（其 ref 渲染为 `BLOCKED`），推荐范围与显式范围都无法覆盖它；在两种压缩模式、所有 wire 上一致生效。模式匹配同内核工具模式（精确名或 `*` 通配，如 `"todo_list"`、`"TodoWrite"`、`"todo*"`）。跨层级整体替换（最深层胜出）。示例：`{ "compress": { "protectedLatestTools": ["todo_list", "TodoWrite"] } }`。

#### `protectedTools`

- **类型：** `string[]`（工具名模式，如 `["skill"]`）
- **默认值：** `[]`（无 —— 按客户端自行开启，工具名因客户端而异）
- **状态：** ACTIVE
- **说明：** 工具名模式列表：匹配工具的 tool-call **及其配对 result，全部实例、完整历史**永远不被压缩（内核 `protectedTools`）。保护是硬排除：所有匹配 ref 渲染为 `BLOCKED`，推荐范围与显式范围都无法覆盖任何实例；在两种压缩模式、所有 wire 上一致生效。模式匹配同内核工具模式（精确名或 `*` 通配，如 `"skill"`、`"skill_*"`）。跨层级整体替换（最深层胜出）。示例：`{ "compress": { "protectedTools": ["skill"] } }`。
- **⚠ 两个旋钮何时用哪个（配置前必读）：** 按工具的各次结果之间的关系选择：
  - **独立内容** —— 每个实例携带独特信息，后续结果不会取代它（opencode/pi 的 `skill` 加载、一次性引用资料）：用 `protectedTools`。折叠旧的加载会永久丢失其内容，保护可让每次加载都留在上下文中（#1109）。
  - **累积快照** —— 每条新结果取代旧结果（客户端的 todo/任务清单）：用 `protectedLatestTools`。对这类工具保护**全部**实例会让其历史无限膨胀 —— 正是 #639 通过只保护最新一条来规避的故障。
  - 经验法则：低频高价值工具 → `protectedTools`；高频刷屏工具 → 绝不做全历史保护（上下文无界增长）；累积快照型工具 → `protectedLatestTools`。

#### `neverPreserveRecentTools`

- **类型：** `string[]`（工具名模式）
- **默认值：** 未设置 → 内置 `["decompress", "search_context", "read", "bash"]`（需 `acp-kernel` >= 0.0.92）
- **状态：** ACTIVE
- **说明：** 从软保护的最近区（`preserveRecentMessages`/`preserveRecentTokens`）中**排除**的工具名模式：匹配的工具结果在最近窗口内立即可压缩，不再等待超龄。内核默认让 `read`/`bash` 保持可压（它们是最大的可回收体量）—— 但正是这个默认值让批量读文件的工作流把刚读的文件立刻折掉，陷入「折叠→重读」死循环（#1198/#1277）。**推荐解法：只移除 `read`** —— `{ "compress": { "neverPreserveRecentTools": ["decompress", "search_context", "bash"] } }` —— 让新读的文件留在最近区，之后按位置超龄回归可压（不同于 `protectedLatestTools` 会把最新一次 read 永久钉住）。不需要逐字替换语义时优先用更简单的正向形式 `preserveRecentTools: ["read"]` —— 见下一节。请保留 `decompress`/`search_context` 在列表里：重新纳入它们会把刚恢复的大块内容钉死在最近区无法回收 —— 换一种病。**⚠ 空数组 `[]` 合法且表示什么都不排除**（最大保护逃生门）—— 与 `protectedTools`/`protectedLatestTools` 不同，空数组不会被拒绝；显式数组逐字替换默认列表，跨层级整体替换（最深层胜出）。

#### `preserveRecentTools`

- **类型：** `string[]`（工具名模式）
- **默认值：** 未设置 → 不做减法（`neverPreserveRecentTools` ?? 内置列表逐字生效；需 `acp-kernel` >= 0.0.93）
- **状态：** ACTIVE
- **说明：** `neverPreserveRecentTools` 的**正向配对旋钮**：从生效的最近区排除列表中**移除**的工具名模式。#1198/#1277 批量读文件「折叠→重读」死循环的解法由此变成一条配置 —— `{ "compress": { "preserveRecentTools": ["read"] } }` —— 既不用重述（也不用冻结一份很快过时的手抄）内置列表，还自动跟随内置列表演化。生效排除表 = `(neverPreserveRecentTools ?? 内置) 减 preserveRecentTools`；可与显式 `neverPreserveRecentTools` 组合（减法同样作用于显式列表）；通配后缀模式移除匹配项（`"bash*"` 移除 `bash`）。除非确实需要逐字替换语义，优先用本旋钮而不是改 never-list。**⚠ 空数组 `[]` 会被拒绝** —— 在这里是纯无操作，裸 `[]` 几乎必然是 `neverPreserveRecentTools: []`（最大保护逃生门）的笔误。与同族旋钮一样跨层级整体替换（最深层胜出）。

#### `prompts`

- **类型：** `object`（`{ compressPhilosophy?, howToCompressRules?, tier2DistillRules?, tier3CondenseRules? }`，均为字符串）
- **默认值：** *（内核默认值 —— 见 `acp-kernel` 的 `defaultPrompts`）*
- **状态：** ACTIVE
- **说明：** 覆盖注入到系统提示词与 nudge 消息中的压缩提示词文本。每个字段都是**承重的（load-bearing）**：内核规则经过数月生产调优，覆盖它们可能降低摘要质量（丢失路径 / 签名 / 决策 → 检索失效）。只有当 `acknowledgePromptsRisk` 经三级合并后解析为 `true` 时覆盖才生效 —— 该标志按自身最深层级独立解析，并门控**所有** `prompts` 覆盖，与各覆盖片段所在层级无关（全局层级的标志即可激活模型层级的 `prompts`）；否则会被忽略并记录一次警告。非字符串字段会被静默丢弃（畸形的局部配置不会破坏正常默认值）。主要用于非英文或小模型调优 —— 见 issue #156。

#### `acknowledgePromptsRisk`

- **类型：** `boolean`
- **默认值：** `false`
- **状态：** ACTIVE
- **说明：** 必须为 `true`，`prompts` 覆盖才生效。与其他字段一样按最深层级独立解析（最深层级胜出），并门控所有 `prompts` 覆盖，与各覆盖片段所在层级无关 —— 无需与所解锁的 `prompts` 位于同一层级。设置它即表示知悉上述摘要质量风险。

#### `promptPack`

- **类型：** `string`（包名，如 `"lean"`）
- **默认值：** `default`（未设置等同——恒等表面，全部使用内核默认值）
- **状态：** ACTIVE
- **说明：** 选择一个具名 prompt pack —— 一套策划好的表面预设，覆盖工具描述、压缩系统提示词段落、nudge 段落 —— 从内核的包解析链解析：**项目** `./.billion-context/packs/<name>.json` → **用户** `<configDir>/packs/<name>.json` → **内置**（`default`、`lean`）。内置 `lean` 把四个 ACP 工具描述换成单行版（无 snippet/guideline 包装），压缩规则保持默认。未知包名回退到恒等表面并记录一次警告。与其他字段一样三级级联合并；包的表面覆盖（工具/段落）直接生效，不经 `acknowledgePromptsRisk` 门控——该门控只管内联 `compress.prompts` 的规则文本覆盖。注意：包文件里的 `prompts` 块会被本代理忽略，规则文本只能经内联 `compress.prompts` 设置。需要 `acp-kernel` >= 0.0.66。

#### `absorb`

- **类型：** `object`（`{ enabled?, minToolTokens?, contextThresholdPct?, excludeTools?, toolName? }`）
- **默认值：** *（禁用 — 除非显式设置 `enabled: true`，该特性完全关闭）*
- **状态：** ACTIVE
- **说明：** 可选开启的**即时工具结果压缩**（issue #605，经由 `acp-kernel` absorb API）。启用时，大工具结果在到达即被附带强制的 `[ACP absorb]` 指令；模型通过 `absorb` 工具将结果蒸馏为紧凑摘要，原 tool-call/tool-result 配对从下一轮起在线上隐藏 —— 使折叠轮之间的中间会话压力更低。子字段（按字段最深层级胜出，与其他 CompressSettings 字段一致）：
  - `enabled: boolean` — 主开关；任何值不为 `true` 时特性完全关闭（无工具、无提示、无标记）。
  - `minToolTokens: number` — 仅达到此 token 数的结果被附带提示（内核默认 1000）。
  - `contextThresholdPct: number|percent-string` — 仅当用量达到 `modelContextLimit` 的此比例时附带提示（`0` = 仅尺寸门槛；`"75%"` 接受）。
  - `excludeTools: string[]` — 永不吸收的工具名模式。**已知限制：对工具*结果*目前无效，直到 [ranxianglei/acp-kernel#213](https://github.com/ranxianglei/acp-kernel/issues/213) 修复发布**（wire 投影不把 `toolName` 携带在结果上，内核名称守卫无法命中）。
  - `toolName: string` — 重命名注入工具（默认 `"absorb"`）；声明/注入的模式、系统提示段与按会话裁决在两条车道中都跟随该名称。**车道治理（#1359）：** 插件模式用**基础**配置治理整个 `absorb` 块，因此重命名后的工具既以该名声明、也以该名执行（二者永不背离）；provider/model 层的 `absorb.*` 覆盖**仅限代理车道**（代理注入并裁决合并后的名称）。加载时会输出一条警告，列出任何取值与基础值不同的 provider/model `absorb.*` 字段。
  注入跟随线上原生工具面：代理模式在 anthropic/openai/responses 原生工具线上注入工具（按每请求解析的名称）+ 系统提示段，插件模式在插件清单中广告它（MCP shell 自动拾取）。Responses **marker/文本协议**路由不支持（无原生工具面 — 强制的 absorb 指令不可满足），标题生成请求（`max_tokens ≤ 200`）跳过注入如压缩提示一样。吸收配对在重启后保持隐藏（在会话状态持久化）。

#### `ccr`

- **类型：** `object`（`{ enabled?, minToolTokens?, excludeTools?, toolName?, maxHeadChars? }`）
- **默认值：** *（全车道默认关闭（#1207 决策）— 未设置时保持关闭；在任意层级显式设置 `enabled: true` 方可启用（建议先本地验证）。插件通道同样需全局 `enabled: true` 才武装（#1271/#1273））*
- **状态：** ACTIVE（v2 — 全车道 opt-in；插件通道限 anthropic + openai wire，显式开启后生效）
- **说明：** **内容寻址消息存储**/内置 CCR（issue #1097/#1179，经 `acp-kernel` CCR API，需 acp-kernel >= 0.0.84）。超大工具结果不再被强制蒸馏（如 `absorb`）或永远挂在线上：kernel 在到达时将其 ID 引用（ccr-store 节点位于 `processTurn` 内 prune 与 absorb 之间 —— ID 引用优先于蒸馏），线上保留一个确定性、字节稳定的占位符（`📦 [acp-stored #m00423 · shell output · 4,213 tok] \`npm run build\`\n   → acp_retrieve("m00423") returns the full text`），原文进入该会话的内容存储。模型通过注入的 `acp_retrieve` 工具按需取回完整原文；retrieve 是临时的（走请求内工具结果通道，不进入折叠空间，不占用消息 ref）。默认无损：未执行的 retrieve 只花一次廉价工具调用；而被 absorb 蒸馏掉的细节则永久丢失。子字段（按字段最深层级胜出，与其他 CompressSettings 字段一致）：
   - `enabled: boolean` — 主开关。**全层级均未设置时默认为 `true`**（#1179）；任意层级显式 `false` 优先，特性完全关闭（无占位符、无工具）。插件模式武装还需全局显式 `true`（#1273）——插件清单只广播运维者显式开启的能力。
  - `minToolTokens: number` — 仅达到此 token 数的工具结果被 ID 引用（kernel 默认 `4000`）；更小的结果保持原样。
  - `excludeTools: string[]` — 从不存储的工具名模式（允许 glob 后缀；kernel 默认为空）。
  - `toolName: string` — 重命名检索工具（默认 `"acp_retrieve"`）；声明、分发与占位符提示都跟随名称。必须与客户端自身工具名保持唯一。
  - `maxHeadChars: number` — 占位符中头部/命令预览的长度（kernel 默认 `96`）。
  **插件通道治理（#1345）：**插件模式下整个 `ccr` 块跟随**基础**配置——仅当基础层级显式 `enabled: true` 时武装，并以基础的 `toolName` 与阈值执行；因为插件清单（宿主声明 retrieve 能力的唯一出口）只从基础配置构建。provider/model 层级的 `ccr.*` 覆盖因此只对代理模式会话生效（代理按请求在合并块下自行声明并分发）。每个发生分歧的覆盖都会在配置加载时记录一条 `[acp-config] ccr override ignored in plugin sessions: …` 警告，指明层级、字段以及插件会话实际使用的值。
  存储以单个信封文件（`.content-store.json`）持久化在会话 JSON 旁边，设置 `BILI_ENCRYPTION_KEY` 时使用与会话文件相同的静态加密编解码器；条目按内容哈希去重，按会话懒加载。只有 `tool` 结果*内部的内容*缩小——与 assistant `tool_calls` 的配对不受影响。范围门控：**全车道默认关闭（#1207 决策）— 任意层级显式 `compress.ccr.enabled: true` 方可启用**：代理模式开启即武装；anthropic + openai wire 上的插件模式需全局显式开启（插件清单才会声明 `acp_retrieve`，#1271）；responses marker/文本协议路由、`ACP_NO_INJECT_TOOL`、以及插件模式下的 responses/google wire 没有经过验证的请求内往返通道来执行 retrieve，因此存储在这些场景下自动解除武装，而不是丢失内容。v2 起（#1179），折叠同样无损：compress 折叠落定时，被覆盖的原文会持久化进存储（首次写入优先，跳过 reasoning），因此 `acp_retrieve("mNNNNN")` 对已折叠内容同样有效；`decompress` 接受可选的 `startId`/`endId` 消息 ref，只恢复块内的一个区间（临时注入，与 retrieve 同一通道）；`search_context` 命中条目携带覆盖的 ref 区间（`[m00044–m00097 · N msgs]`）；`acp_status` 列出块→ref 关联（`BLOCK SPANS`），并在 STORE 行单独计数 `range-restored`。设计定案（#1282）：**永不设上限、永不逐出**——信封随持有的唯一原文数量增长，与会话同生命周期；足迹在 `acp_status` 中可见。按会话统计（已存字节、当前线上节省字节、retrieve 率）在 `acp_status` 中展示；每次 retrieve 记录一条 `[ccr] retrieve …` 日志。

#### `imageCompression`

- **类型：** `object`（`{ enabled?, minTokens?, maxDimension?, quality?, format? }`）
- **默认值：** *（关闭 —— 除非你设置 `enabled: true`，否则功能完全关闭）*
- **状态：** ACTIVE（v1 —— 仅代理模式）
- **说明：** 面向截图密集型工具结果的可选**图像预压缩**（issue #1095，经 `acp-kernel` image-compression API，需 acp-kernel >= 0.0.84）。多模态供应商按像素面积计费，一张手机截图比一大段代码更贵。启用后，工具结果中的截图类图像（确定性启发式分类器：竖屏宽高比落在区间内 + 最短边下限）会在**到达时降采样一次**——进入线上之前——模型仍能看到 UI，但计费像素降到原来的零头。非截图图像逐字节原样透传。路由决策（直过 vs 降采样 + recipe）由内核逐图做出；宿主用可选的 `sharp` 依赖执行编码（懒加载；缺失或失败 ⇒ 原图透传，绝不阻塞主链路）。**天然有损**——与文本 CCR 不同，降采样后的像素无法找回；缓解手段：注入的 `image_full` 工具允许模型在看不清细节时为整个会话恢复原始分辨率（粘性、幂等；恢复状态随 shrink 记录跨重启持久化）。无需代理侧存储原图：客户端自己的历史仍持有原始字节（它从未见过降采样形态），因此已恢复的 ref 只需停止被重新路由，原图即重新回到 wire。逐图节省量以 `[acp-image] …` 日志行输出，并汇总进 `[acp-usage]` 后缀（`img-saved=Ntok/MKB xK`）。子字段（按字段最深层级胜出，与其他 CompressSettings 字段一致）：
  - `enabled: boolean` — 总开关；非 `true` 一律保持完全关闭（逐字节透传，线上不出现 `image_full` 工具）。
  - `minTokens: number` — 只对计费感知的 token 估算 ≥ 此值的图像做路由（内核默认 `512`）。
  - `maxDimension: number` — 降采样 recipe 的最长边（px，内核默认 `1280`）。
  - `quality: number` — recipe 的有损编码质量 1–100（内核默认 `80`）。
  - `format: "webp" | "jpeg" | "png"` — recipe 的编码格式（内核默认 `"webp"`）。
  四种 wire 载体都在 forward 边界改写：Anthropic `image` block、OpenAI `image_url` part（含单字符串 data-URL 消息；远程 URL 永不触碰）、Responses `input_image`、Google `inlineData`。确定性契约（与 CCR #1097 同一不变量）：到达时被替换的字节就是长期 wire 内容——守卫拒绝把已 shrink ref 的非已知原图指纹载荷再次路由，因此重新进入 pass 的处理后消息（折叠重请求）不会二次降采样击穿 prefix cache。注意内核的 pixel-tile token 估算是粗粒度且有上限的（大截图约 2k token）：一次缩放可能省下真实 wire 字节但省不下估算 token——两个数字都会出现在日志里。指纹簿记仅存内存（不持久化）：代理重启后，此前已 shrink（未恢复）的 ref 会以原始分辨率透传，直到会话重置——双收缩守卫不会重新路由它无法验证为已知原图的载荷，因此这些 ref 的节省量暂停而非冒险二次降采样（重置会清除记录，下次到达时确定性重新 shrink）；此前已恢复的 ref 保持已恢复状态。v1 范围门控：**仅代理模式**（插件 agent 需要先在插件清单中声明 `image_full`）。要求 `acp-kernel` >= 0.0.84 以及可选的 `sharp` 包才能真正缩放（没有它所有图像原样透传）。

#### `rules`

- **类型：** `boolean`
- **默认值：** `false`
- **状态：** ACTIVE
- **说明：** 可选开启的**持久化模型提醒**（issue [ranxianglei/billion-context-pi#433](https://github.com/ranxianglei/billion-context-pi/issues/433)，经由 `acp-kernel` rules API）。启用后，一个 `acp_rule` 工具随 ACP 工具一同注入：传入简短的 `rule` 参数调用可记录一条**原则级提醒**，该提醒受**硬性保护**免于压缩（调用及结果在每次折叠中都保留在上下文中）；省略参数则列出已记录的规则。传入 `delete`(规则 id,如 `"rule3"`)删除该条规则(返回 `Removed ruleN: <text>`);传入 `clear: true` 清空全部规则。两者互斥,且均与 `rule` 互斥——一次调用只能执行一种操作——因此过时或误记的规则可以直接删除,而无需再写一条"作废声明"对冲。关于*何时*记录（用户强调的教训、用户要求记住的行为、遇到的重大陷阱）的指导完全写在工具描述里——不向系统提示词添加任何内容。受内核限制约束（50 条规则 × 每条 300 字符）；重复文本会被拒绝并指向已有的 id。注入跟随线上原生工具面，与 `absorb` 完全一致：代理模式在 anthropic/openai/responses 原生工具线上注入该工具，插件模式在插件清单中声明（执行按会话门控）。已记录的规则在会话状态中持久化，跨重启保留；删除同样持久化。要求 `acp-kernel` >= 0.0.70（delete/clear 需要 >= 0.0.84）。人也可以不经过模型查看或记录指令：pi/omp 提供原生 `/acp-rule` 命令 —— 裸 `/acp-rule` 列出全部已记录规则，`/acp-rule <文本>` 直接记录一条（#1251）。

#### `reasoning`

- **类型：** `object`（`{ drop?, threshold? }`）
- **默认值：** `drop: true`、`threshold: 2048` — 默认开启
- **状态：** ACTIVE
- **说明：** **压缩回执 reasoning 卫生**（issue #651，对应 `billion-context-pi` #339/#348 / `opencode-acp` #377 的代理侧孪生）。把 `reasoning`/`thinking` 轨迹留在 wire 上的模型会积累一块永久不可压缩的地板：折叠的锚点是一条 `compress` 调用，而它**前方**的 reasoning 消息会作为受保护前缀活过每一次折叠——它们永远无法被重新摘要，只能被剥离。在风暴会话里这块地板曾占到可见上下文的 ~50%。开启后，代理会剥离紧邻**已闭合** `compress` 调用之前的 reasoning 连续段，闭合判定按**回合证据**：该调用的工具结果（`contentType: "tool-result"`、`toolCallId` 匹配）已出现在更晚位置，且其后至少还有一条消息——**不要求用户消息**，长 agent 会话同样能闭合回合（#348 孪生）。安全门：**在飞回合**（结果未返回、或结果仍是最后一条消息）绝不动；普通工具调用（`read`、`bash` …）的 reasoning 保留；连续段按求和后的总长判定（2×1200 字符的段仍会命中 2048 门槛）；不连续的 reasoning（片段之间夹着正文）不动。子字段与其他 CompressSettings 字段一样按“深层覆盖”合并：
  - `drop: boolean` — 总开关；`false` 完整还原旧行为。请求携带 `tools` 时要求 `reasoning` 原样往返的 thinking 模型必须按 provider 关闭——DeepSeek、GLM thinking、Qwen-QwQ 在未回传先前 `reasoning_content` 时返回 HTTP 400。#684 起这一步基本自动：`deepseek` 上游**以及请求体 `model` id 匹配 `/deepseek/i` 的请求**（#1027——经非 deepseek 网关提供的 DeepSeek 模型）静态识别；任何上游以提及 `reasoning_content` 的 400 拒绝时仍会自动学得该会话需保留 reasoning（自愈，会话级；日志携带 `[acp-loop] learned strictReasoningEcho`）。该配置仍作为其他严格 reasoning 上游的手动兜底手段：
    ```jsonc
    "providers": { "https://api.deepseek.com": { "compress": { "reasoning": { "drop": false } } } }
    ```
  - `threshold: number` — 字符门槛；**严格大于**该值的段才被剥离（`0` = 只要非空就剥）。非法值回退默认而不是报错。

#### `reasoningGuard`

- **类型：** `object`（`{ enabled?, maxContinue?, maxTierN?, markerText?, base?, offset?, debugLog? }`）
- **默认值：** *（禁用 —— 除非在某一层设置 `enabled: true`）*
- **状态：** ACTIVE
- **说明：** gpt-5.x/gpt-6.x **"晶格"（lattice）推理截断**守卫（issue #739；上游 [openai/codex#30364](https://github.com/openai/codex/issues/30364)）。这些模型会间歇性地在恰好 `base*n + offset` 个 reasoning token 处（默认 `518n−2` → 516、1034、1552 …）思考到一半就停下，然后基于未完成的思路作答。当作用域内的终止回合落在晶格上**且**携带 `encrypted_content` 块时，bili 会缓冲该响应、带着自己的 reasoning 加一条继续提示重发（最多 `maxContinue` 个续写回合），再把全部折叠成**一个**响应，其 usage 为真实求和值。折叠期间 reasoning 实时流式发给客户端（不做整段缓冲），只有最后一轮干净回合的非 reasoning 输出被透传。仅作用于 Responses/SSE 流式请求（bili 只支持 SSE）；压缩注入的回合被豁免（由循环负责）。子字段与其他 CompressSettings 字段一样按“深层覆盖”合并：
  - `enabled: boolean` — 总开关；非 `true` 时守卫完全关闭。作用域由该块在三级树（全局 / provider / model）**放在哪一层**决定——没有单独模型列表。严格签名（精确晶格命中 + `encrypted_content` + 无工具调用）限制哪些回合真正触发续写。
  - `maxContinue: number` — 首轮之后最多续写的回合数（默认 `3`）。
  - `maxTierN: number` — 允许续写的最高晶格层级 `n`（默认 `6`）；`0` = 不限制。遇到罕见的深层截断时调高（例如在 gpt-6-astra 上观察到一次 `n=11`）。
  - `markerText: string` — 每个续写回合追加的 commentary 提示文本（默认 `"Continue thinking..."`）。
  - `base: number` / `offset: number` — 晶格签名 `tokens == base*n + offset`（默认 `518` / `-2`）。若其他模型家族在不同晶格上截断则覆盖。
  - `debugLog: boolean` — 逐回合详细日志（默认 `false`）。
  ```jsonc
  // 全局开启
  { "compress": { "reasoningGuard": { "enabled": true } } }
   // 按 provider 调参（放在哪一层就作用于哪一层的流量）
   { "providers": { "https://your-relay.example": { "compress": { "reasoningGuard": { "enabled": true, "maxContinue": 2 } } } } }
  ```

#### `outputSteering`

- **类型:** `object`(`{ enabled?, verbosityLevel?, effortRouting? }`)
- **默认:** *(禁用——不在任何层级设 `enabled: true` 就完全关闭)*
- **状态:** ACTIVE
- **描述:** 可选的**输出侧压缩**(issue #1093):两个请求期杠杆,削减的是*输出* token——它比输入贵、且一流出就计费。决策逻辑(轮次分类、L0–L4 指令措辞、effort 钳制)在 acp-kernel 内与 agent 侧共享;bili 只负责落在 wire 上,且在所有其他 body 改写之后:
  - **Verbosity steering** — 确定性的简洁指令追加到 system prompt **尾部**(绝不前置——前移会改变客户端自己的提示词字节、击穿前缀缓存)。哨兵包裹且幂等:重试不会累积,等级切换原地替换。措辞跨版本字节稳定(内核改措辞=所有该等级会话的前缀缓存一次性失效)。
  - **Effort routing** — 按结构分类最后一个 user 轮(只看块组成,不做内容模式匹配);在*机械续答*(干净的工具结果、无错误、无新用户信号)时把**客户端已发送的** effort 字段向最低档钳制。只钳不注:绝不注入客户端没发的字段(不支持 effort 的模型会 400)、绝不切换 `thinking.type`、绝不把 `minimal` 上调。覆盖:OpenAI `reasoning_effort`、Responses `reasoning.effort`、Anthropic `thinking.budget_tokens`(下限 1024)、Gemini `generationConfig.thinkingConfig.thinkingBudget`(下限 128;`-1` 动态档不动)。
  - 子字段(与其他 CompressSettings 字段一样最深层级优先):`enabled: boolean` 总开关;`verbosityLevel: number` 0–4(0=不发指令,默认 2);`effortRouting: boolean`(默认随 `enabled` 开启)。越界值**带警告**回退默认,不会整块拒绝。四条 wire 全覆盖(openai chat / responses / anthropic / google);无 system 载体的请求不动(skip-if-absent)。
  ```jsonc
  // 全局启用
  { "compress": { "outputSteering": { "enabled": true } } }
  // 只降 effort,不发措辞指令
  { "compress": { "outputSteering": { "enabled": true, "verbosityLevel": 0 } } }
  // 按 provider(位置决定只作用于该 provider 的流量)
  { "providers": { "https://your-relay.example": { "compress": { "outputSteering": { "enabled": true, "verbosityLevel": 3 } } } } }
  ```

#### `stripImages`

- **类型：** `boolean`
- **默认值：** `false`
- **状态：** ACTIVE
- **说明：** 可选的历史图像载荷移除。设为 `true` 时，除最近 `stripImagesKeepRecent` 条消息外，所有消息在重建 wire 前都会丢弃其图像部分；纯图像消息折叠为单个 `[image]` 文本占位符（图文混合消息保留其文本）。最近 N 条的图像逐字转发，且新发送的图像在其到达的那一轮必然落在该窗口内。默认关闭 —— 关闭期间，#488 图像 token 下限及其溢出 `502` 仍是图像密集型载荷的显式信号。对两种压缩模式均生效（plugin 模式下 agent 自身历史不受影响，仅精简发往上游的 wire）。见 issue #617。

#### `stripImagesKeepRecent`

- **类型：** `number`
- **默认值：** `5`
- **状态：** ACTIVE
- **说明：** 在 `stripImages: true` 时，末尾多少条消息保留其图像逐字转发。仅在启用 `stripImages` 时生效。

#### `visibilityMarkers`

- **类型：** `boolean`
- **默认值：** `true`
- **状态：** ACTIVE
- **说明：** 控制代理执行 proxy 工具调用（`compress` / `decompress` / `search_context` / `acp_status`）后输出的 📦/❌ ACP 可见标记。开启时，每次执行会在响应流中追加一行标记，并/或把标记消息重新注入该轮重建后的历史，让模型在后续回合看到发生了什么。设为 `false` 可完全抑制这两类产物 —— 适用于模型会模仿或围绕标记进行旁白的部署场景（自行输出确认行或中文旁白；见 issue #862）。工具执行本身不受影响：调用照常执行、成对的 tool-call/tool-result 消息照常记录，只是省略标记行/标记消息。与其他字段相同的三级合并。#717 对模型伪造标记的防伪造剥离逻辑独立于本开关，始终生效。

### 注入开关（仅全局生效）

这两个开关只在**全局**层级生效。在按 provider 或按模型的 `compress` 块中设置它们无效。

#### `injectTool`

- **类型：** `boolean`
- **默认值：** `true`
- **状态：** ACTIVE
- **说明：** 将 `compress` / `decompress` / `search_context` 工具与压缩系统提示注入每个请求。设为 `false`（或 `ACP_COMPRESS_TOOL=0`）可完全禁用工具注入。

#### `injectNudge`

- **类型：** `boolean`
- **默认值：** `true`
- **状态：** ACTIVE
- **说明：** 当使用率越过阈值时注入自动压缩 nudge 消息。设为 `false`（或 `ACP_COMPRESS_NUDGE=0`）可禁用 nudge 注入。同时禁用 `injectTool` 和 `injectNudge` 在功能上类似 `passthrough`，区别在于代理仍会跟踪 token 使用量。

### 软目标与弹性余量 (#1122)

自主 agent 常常同时想要两件事：保持*活跃*上下文小（成本/延迟），又允许单个任务在确实需要时突发远超该目标（例如读一个大文件）。把 `modelContextLimit` 设到模型原生窗口之下表达不了这一点——一个字段同时扮演两个角色（使用率分母**兼**预检硬墙），任何超过它的载荷都会在中途被折叠或直接快速失败（#1122）。

改用现有的软档位来表达：limit 保持在原生窗口，用 `maxContextLimit` 钉住目标：

```jsonc
// 原生窗口 200k 的模型；日常保持 ~70k 活跃，允许突发到真实边缘
{
  "compress": {
    "modelContextLimit": 200000,   // = 原生窗口 → 硬墙只在真实边缘
    "maxContextLimit": "35%"       // 强制 nudge 区从 ≈ 70k 开始（= 目标 ÷ 原生窗口）
  }
}
```

压缩实际如何决策（acp-kernel，已实证）：

1. **增长层（日常主力，绝对 token）**：自上次锚点（会话起点 / 上次 nudge / 压缩后重置）以来的累计增长达到增长地板、且可压缩质量足够时，发出主动 nudge。这两个数都是绝对值、按设计不随窗口放大：自适应步长 = `clamp(round(窗口 × 5%), 20k, 50k)` → ≤~400k 窗口为 20k，≥1M 窗口封顶 50k；增长地板 ≈ 20k（≥1M 为 22.5k）。这一层保证长会话在任何百分比档位之下也持续得到压缩。
2. **压力层（窗口的百分比）**：`usage ≥ maxContextLimit`（默认 75%）→ 每轮注入 nudge，直到上下文回落到线以下；`usage ≥ emergencyThresholdPercent`（默认 95%）→ 强制 nudge + 紧急截断。
3. **资格层（内核默认 45%，未暴露）**：只管第 1 轮冷启动门票和 T2/T3 块数升级地板——不参与日常路径。

注意：把 `maxContextLimit` 设到内核默认 45% 之下功能完全正确（各层相互独立），但 acp-kernel 会每轮打一条校验警告（`minContextLimitPct must not exceed maxContextLimitPct`）——纯日志噪音，阈值不受影响。

与旧的低 limit 配置（如 `modelContextLimit: 70000`）相比的行为差异：硬墙从 70k 移到原生窗口（大读取不再中途被压死或快速失败）；强制区从 75%×70k ≈ 52.5k 移到你选定的 %×原生；强制区之下上下文按增长层漂移而不是每轮被钉住——漂移就是弹性的对价。若既要严格日常上限又要突发余量，静态百分比区间无法两者兼得：为你能接受的上限选 %，或跟踪结构感知压缩（#344）。

同样的字段支持 per-provider / per-model（三层合并），并经 Web UI 热更新。

### 三层合并示例

本示例展示了全局默认值、按 provider 覆盖与按模型覆盖如何逐字段叠加：

```jsonc
{
  // 第 1 层 —— 全局：应用于每个请求
  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%",
    "nudgeGrowthTokens": 50000,
    "tiers": true,
    "injectTool": true,
    "injectNudge": true
  },

  "providers": {
    "https://api.anthropic.com": {
      // 第 2 层 —— 按 provider：为该 provider 覆盖全局字段
      "compress": {
        "maxContextLimit": "70%",          // 在此稍微提前压缩
        "preserveRecentMessages": 8        // 保留更多最近轮次
      },
      "models": {
        "claude-sonnet-4-5": {
          "context": 200000,
          // 第 3 层 —— 按模型：最深层，优先级最高
          "compress": {
            "modelContextLimit": 180000,   // 将窗口视为 18 万（留出余量）
            "emergencyThresholdPercent": "90%"
          }
        }
      }
    }
  }
}
```

对于发往 `https://api.anthropic.com/v1/messages`、模型为 `claude-sonnet-4-5` 的请求，解析出的设置为：

| 字段 | 来源 | 值 |
|------|------|-----|
| `maxContextLimit` | provider（第 2 层） | `"70%"` |
| `emergencyThresholdPercent` | 模型（第 3 层） | `"90%"` |
| `nudgeGrowthTokens` | 全局（第 1 层） | `50000` |
| `preserveRecentMessages` | provider（第 2 层） | `8` |
| `modelContextLimit` | 模型（第 3 层） | `180000` |
| `tiers` | 全局（第 1 层） | `true` |

---

## 环境变量

环境变量优先于配置文件。在不修改文件的情况下，它们适用于环境特定的覆盖（CI、容器）。

| 变量 | 效果 |
|------|------|
| `ACP_DEBUG` | 设为 `1` 开启详细日志（等同 `"debug": true`）。 |
| `ACP_PASSTHROUGH` | 设为 `1` 不经压缩直接转发（等同 `"passthrough": true`）。 |
| `ACP_COMPRESS_TOOL` | 设为 `0` 禁用工具注入（等同 `"compress.injectTool": false`）。 |
| `ACP_COMPRESS_NUDGE` | 设为 `0` 禁用 nudge 注入（等同 `"compress.injectNudge": false`）。 |
| `ACP_MODEL_CONTEXT_LIMIT` | 全局覆盖上下文上限（绝对 token 数）。 |
| `BILI_IMAGE_TOKEN_CAP` | 预检尺寸门与输出钳制用的单图 token 估算上限（#488/#496）。默认内联 `data:` 图片按 `base64 长度 / 4` 计 token、**无上限** —— 对字节计费 relay 正确，但对像素 tile 计费的官方上游（Anthropic/OpenAI）会严重高估（后者无论字节多少，每图约计 1.1K–1.6K token）。像素 tile 上游建议改用 [`imageBilling`](#imagebilling)（`"pixels"`，或 `BILI_IMAGE_BILLING=pixels`），按真实 tile 计费而非截断字节估算；该上限仍在两种计费模式之上作为统一天花板生效。不设置 = 无上限（默认）。 |
| `BILI_IMAGE_BILLING` | 覆盖预检尺寸门与输出钳制的图片计费模式（#767）：`pixels` 或 `bytes`。每次请求实时读取（无需重启）；优先于全局 `imageBilling` 与所有按 provider 的 `providers.<url>.imageBilling`。在配置为 `"pixels"` 的路由上强制保守计费用 `bytes`（例如 OpenAI 同形 host 后面的字节计数 relay），或不想改配置文件就全进程启用 tile 计费用 `pixels`。详见 [`imageBilling`](#imagebilling)。 |
| `BILI_PREFLIGHT_HOLD_MS` | 预压缩超过该宽限期（毫秒）后，代理提前提交响应并用保活字节挂住客户端（默认 `30000`；见 #568 / README「预压缩挂起」）。 |
| `BILI_RECLAIM_FETCH_PATCH` | 设为 `0` 关闭 native 模式 fetch 自愈重武装（#1158）。默认情况下 native fetch 拦截会把 `globalThis.fetch` 装成受保护的访问器：第三方补丁重新赋值 `globalThis.fetch` 时（如 dsh-http-proxy 的 settings 刷新用冻结的 pre-bili `originalFetch` 盲覆盖），会被接链为下游，模型流量继续经过 bili。设 `0` 则回到经典直装：第三方重装生效，bili 将看不到本会话的模型流量。**出口提示：** 自愈生效期间，被认领的模型流量由 bili 代理自身派发——不再走第三方链的出口（例如 dsh-http-proxy 里配置的 SOCKS5；bili 自身的上游代理仅支持 HTTP 形式）。若需要回退第三方出口，设 `0` 并在 bili 层配置出口（`"proxy": "http://…"`）。 |
| `BILI_CONFIG_FILE` | 覆盖配置文件路径（指向任意 JSON 文件）。 |
| `ACP_PORT` / `PORT` | 覆盖监听端口。 |
| `ACP_HOST` | 覆盖监听主机。 |
| `ACP_UPSTREAM` | 覆盖默认上游 base URL。 |
| `ACP_LOG` | 设为 `0` 关闭请求日志。 |
| `ACP_AUTO_UPDATE` | 设为 `0` 禁用自动更新检查。 |
| `ACP_UPDATE_TAG` | 自动更新跟随的 dist-tag 通道（默认 `latest`，如 `dev`）。文件配置键：`updateTag`。`pr-N` 预览 tag 仅在显式配置时才会被跟随。 |
| `BILI_UPDATE_REGISTRY` | 自动更新与 `bili update` 使用的 npm registry base URL 覆盖（默认 `https://registry.npmjs.org`）。仅供 hermetic 测试指向回环 registry（`ACP_TEST_REGISTRY` e2e 套件自带的 verdaccio 实例）；生产环境请勿设置（#1153）。 |
| `BILI_UPDATE_CHECK_INTERVAL_MS` | 自动更新检查周期（毫秒，默认 `180000` 即 3 分钟；≤ 0 的值被忽略，回退默认）。hermetic e2e 套件用它缩短周期，避免等待完整间隔（#1153）。 |
| ~~`BILI_HOST_USAGE_CREDIT`~~ / ~~`hostUsageCredit`~~ | **#660 已移除。** 曾用于选择宿主可见的用量模式。#408 的未折叠基线回补（backfill）已整体删除 —— 所有宿主现在统一上报“实际转发（后折叠）请求”的 provider 实测用量，与 `[acp-usage] input=` 一致。遗留该环境变量 / 配置键的旧值会被忽略，请删除。教训详见 PR #691 的 “Bug 历史教训” 一节。 |
| `ACP_PROVIDERS` | 指向外部 `providers.json` 的路径（旧版 / 共享文件）。 |
| `BILI_REPLAY_RETRY_BASE_MS` | acp-loop 回放重试的基础退避延迟（毫秒）：上游瞬时拒绝后重试（默认 `1500`；设 `0` 关闭延迟）。见 #189。 |
| `BILI_REPLAY_RETRY_MAX` | acp-loop 回放重试的总次数（默认 `3`；设 `1` 彻底关闭重试 —— 旧版 fail-fast 行为）。见 #189。 |
| `ACP_SESSION_HEADER` | 会话 id 请求头名称（默认 `x-acp-session`）。 |
| `ACP_REASONING_KEEP` | 仅 Responses API：设 `none` 丢弃全部 reasoning 项。默认让 reasoning 走压缩管道，其轮次被摘要后自动隐藏（避免无限累积破坏 Codex 的 prompt-cache 前缀）。 |
| `ACP_LOG_FILE` | 日志文件路径（默认 XDG state 路径；`off` 关闭文件只保留 stderr）。10 MB 自动轮转。 |
| `ACP_DUMP_SSE` | 调试用：转储原始 SSE 帧的目录。 |
| `BILI_LOG_MASK_HOSTS` | 设为 `0` 关闭代理日志的 host 脱敏（#897）：非公开目标主机（私有 relay、内网域名）原样记录，而不是 `<private-host>`。默认开启（#255 —— 日志常被整段贴进公开 issue）；凭据头脱敏与之独立、始终开启。真实目标域名不依赖此开关也可查：`GET /__bili/stats` → `blindTunnels`、`GET /__bili/health`（均仅 loopback），以及 `acp_status` 输出。 |
| `BILI_SUBAGENT_SPLIT` | 设为 `0` 关闭 Claude Code subagent 会话分流（#970）：默认情况下，anthropic 线路上同时携带 `x-claude-code-agent-id` + `x-claude-code-parent-agent-id` 头的请求（后台 subagent）会获得独立的 `<session>\|sub:<agent-id>` 会话 —— 独立的锁链与压缩状态 —— 不再排在主会话的锁后面。默认开启。配置文件中设 `"subagentSplit": false` 效果相同；环境变量优先。 |
| `BILI_FORK_ADOPTION` | 设为 `1` 开启 fork 块继承（#629）：匿名（prefix-affinity）客户端在会话中途分叉历史（编辑重发 / 从更早轮次重新生成）时，新会话直接继承父会话中"源内容在分叉请求里完整存在"的压缩块 —— 而不是从零开始、把共享前缀重新折叠一遍。默认关闭。配置文件中设 `"forkAdoption": true` 效果相同；环境变量优先。无论开关如何，匿名 fork 发生时日志都会记录可继承的块清单，便于先评估收益再开启。 |
| `BILI_STABLE_SYSTEM_ANCHOR` | 设为 `1` 开启稳定 system 锚定（#1085）—— **wire 层兜底（best-effort）**：根治在客户端（会话历史与指令变更的呈现方式由客户端决定），本开关只是阻止代理因头部变化而使整个已缓存前缀失效。**仅限 plain-proxy 模式**：plugin-mode agent（`x-bili-plugin`）自管上下文、永不参与锚定，避免对已自带 cache-friendly 更新注入的客户端（如 claude-code 的 system-reminder）做双重处理。开启后，bili 按会话记住客户端首次发送的头部 system/instructions 块并持续原样重发。**局部变更**（文件式编辑，与当前生效版本共享 ≥70% 行）追加末尾 `[System context update] …` user 注记，内含紧凑行级 diff（`-` 删除 / `+` 新增；每条注记顺序叠加在前一条之上）。**非局部变更**（结构性重排、tool 定义增删、带时间戳的 banner、超 400 行的头部）直接采用新文本 —— 一次有意的缓存失效好过追加会误导模型的噪声 diff。防抖保护：累积超过 8 条注记同样直接替换锚点为最新文本并清空日志。锚点与注记日志随会话持久化，不受压缩/compaction 影响（session metadata 而非 kernel state）。已知残留限制：客户端自放的 `cache_control` 断点在换头后仍可能错位。不参与锚定的请求：标题生成微请求（OpenAI/Google）、Responses compaction-trigger 请求、auto-mode classifier 请求。客户端自身已实现同类机制（稳定 prompt + 历史内更新）时零额外注入 —— 这类更新作为普通历史透传。默认关闭。配置文件中设 `"stableSystemAnchor": true` 效果相同；环境变量优先。 |
| `BILI_CHAIN_CONTENT` | 设为 `0` 关闭 bili→bili 链检测的 ACP 产物内容回退（#1086）：当入站请求携带压缩产物（渲染标签 / 历史 `acp_status`+`search_context` 工具调用）但既无 `x-bili-hop` 头、本实例也无该会话的压缩状态时，请求被原样透传而不再次处理（中间设备可能已剥掉链路上的 hop 头）。默认开启。配置文件中设 `"chainContentDetection": false` 效果相同；环境变量优先。`x-bili-hop` 信号本身不受此开关影响。 |
| `BILI_CONFLICT_SCAN` | 设为 `0` 关闭第三方压缩插件检测（#1206）。默认开启：bili 会扫描客户端自身的插件/扩展注册表 —— opencode 全局 + 项目配置的 `plugin` 数组、pi 全局 + 项目 `.pi/settings.json` 的 `packages`、omp `config.yml` 的 `extensions`、claude 设置的 `enabledPlugins`/`plugins` 及其插件目录、kimi `plugins/installed.json`、hermes 插件目录、dsh profile 依赖 —— 查找与 bili 并存的另一个压缩器。两个层级：**已知冲突**（`opencode-acp`、遗留 `billion-context-pi`，确定性判定）和**关键词疑似**条目（名称匹配 compress / compact / acp / summar* / context*；bili 自身条目永远跳过，`context7` 这类非压缩工具不会误报）。发现结果出现在：客户端启动前的 launcher stderr、每个会话首个请求的一次性代理 warn 日志、以及会话冲突台账 —— `acp_status` 的 `COMPRESSION CONFLICTS` 段、`GET /__bili/stats` → `conflicts`、Web UI 横幅。运行时干扰证据（未宣告的历史改写 #1001、孤儿块废弃）记入同一台账。「扫描只读、尽力而为、5 分钟缓存，绝不阻塞或改动客户端配置。」 |
| `BILI_UPSTREAM_PROXY` | 代理自身出站连接的上游代理 —— 优先级最高，高于 per-URL/per-provider 配置。见 README「上游代理」一节。 |
| `BILI_INHERITED_HTTP_PROXY` / `BILI_INHERITED_HTTPS_PROXY` / `BILI_INHERITED_ALL_PROXY` / `BILI_INHERITED_NO_PROXY` | 非用户直接使用 —— launcher 起代理子进程时自动设置（#1012）。launcher 会从客户端和代理子进程两侧剥掉 shell 的代理变量（客户端必须把流量发给 bili；代理的模型出网也不能被 shell 代理劫持），但会把用户剥离前的代理转发到这些变量里，让代理的**辅助出网**（MITM 盲隧道 —— 客户端侧的 MCP/web 流量）仍能走用户的 VPN。它们只作用于盲隧道的 fallback 层：显式路由 / 全局 `proxy` / `BILI_UPSTREAM_PROXY` / 显式 `"upstreamProxyMode": "direct"` 仍然优先，指向 bili 自身端口的值会被丢弃。模型出网不受影响（未显式配置则保持直连）。 |
| `BILI_UPSTREAM_TIMEOUT_MS` | 上游请求的空闲预算（毫秒）：首字节时间（TTFB）与响应体块之间的间隔（默认 `720000` = 12 分钟）。持续产出数据块的健康流永远不会被中途切断；静默的流才会。同一个值同时驱动底层 HTTP 客户端的传输层超时，因此这一个旋钮即可端到端约束本地大模型的超长 prefill（#551）。 |
| `BILI_ATTACH_HEALTH_DEADLINE_MS` | dsh/opencode attach 校验中，attach 目标已挂但本进程模型通道**钉死**在其上（观察到指向它的 `/bili/…` 路由流量）时的健康等待上限（毫秒）：bili 等待目标恢复而不是 spawn 第二实例——spawn 会把会话劈成两半（模型流量保持钉死，bili 工具在另一实例上 404）。超时后大声报错，并在每次模型请求时持续重查直到目标恢复（默认 `15000`）。见 #1365。 |
| `BILI_ATTACH_EVIDENCE_GRACE_MS` | dsh/opencode attach 校验探测到目标已挂时，等待路由通道证据出现的宽限窗口（毫秒），超时才回退到旧的 spawn 路径（覆盖「判定早于首个请求」的竞态：t≈0 时探测失败、t≈1s 时首个模型请求才落地）（默认 `5000`）。见 #1365。 |
| `BILI_PERSIST` | 设 `0` 关闭会话持久化（仅内存，重启即丢）。 |
| `BILI_PERSIST_DEBOUNCE_MS` | 持久化写盘的防抖窗口（毫秒，默认 `500`）。 |
| `BILI_PERSIST_TAIL_TOKENS` | 持久化会话快照的 token 预算（#401）。盘上记录的是**折叠视图**（压缩范围以块摘要替代）并截断到该预算内的最新消息 —— 不再存全量原始历史。默认 `16384`；设 `0` 彻底不持久化消息（块摘要与压缩原件仍会持久化，`bili export` 退回块级渲染）。活会话内存不受影响 —— 活会话的 `bili export` 始终完整。 |
| `BILI_PERSIST_ZSTD` | 设为 `1`/`true` 启用会话文件的 zstd 压缩（#1080，owner 决定：**默认关闭**——纯 JSON 可恢复性最强：可用 jq/grep 调试，且无降级尾部风险）。启用后，每个确实能压缩变小的会话文件均以 `BILIZSTD1` 格式写入——即在 JSON 主体之上附加一个小头部（魔数 + 格式版本 + 模式字节），在 Node ≥ 22.15 上以 zstd 压缩存储，在旧版运行时上则原样存储；读取端兼容两种主体格式（优先使用原生 zstd，否则回退至内置的 WASM 实现），因此文件在不同运行时和版本间均可正常读取。压不小的小会话与无密钥的原始主体以裸 JSON 落盘。与 `BILI_ENCRYPTION_KEY` 相互独立——两者同时生效时，压缩方式会记录在 `BILIENC1` 内部的模式字节中。已有的纯 JSON 文件**永不在启动时改写**（降级安全——批量重编码会让回退到旧版 bili 时把自己的写入当成“损坏文件”）；它们在其下一次保存时自然转换。注意：一旦会话已保存为 `BILIZSTD1`，旧版 bili（< 0.1.135）无法读取——该限制仅对显式启用的部署生效；未设置或其他值均保持纯 JSON。 |
| `BILI_PERSIST_EPERM_ALERT_THRESHOLD` | 同一会话连续 N 次持久化写失败（`EPERM`/`EBUSY`/`EACCES`）后触发一次性「把该目录加入杀软排除项」告警的阈值（默认 `5`）。仅 Windows。见下文「Windows：把会话目录加入杀软排除项」章节。 |
| `BILI_PERSIST_EPERM_ALERT_REPEAT_MS` | persist EPERM 告警的重复窗口（毫秒）。`0`（默认）= 只告警一次后静默；`>0` = 失败持续期间最多每这么久重复告警一次。 |
| `BILI_MAX_SESSIONS` | 内存中最多保留的会话数（默认 `256`；LRU 淘汰 —— 磁盘是事实源）。 |
| `BILI_SESSIONS_DIR` | 会话持久化目录（默认 XDG data 目录）。 |
| `BILI_SESSION_GC` | 过期会话文件清理（#1082）为**可选开启**：设 `1`/`true`/`on` 启用 —— 默认关闭，因为会话文件是用户数据（可导出、可续聊），不应有静默删除策略。启用后，扫描（启动 + 每小时）只在**两个条件同时满足**时删除一个文件：年龄超过 `BILI_SESSION_GC_MAX_AGE_DAYS`，并且"小"到无损 —— 该会话**从未被压缩过**（零折叠块）且最近一次请求体 ≤ 下述 token 上限，这样继续对话只损失一次冷重建（用客户端自己的历史重建），别无其他。安全边界：被压缩过的会话永不删除（其摘要无法无损重建）；内存中仍持有的会话会被跳过，除非该会话自上次落盘后一直空闲；不可读/损坏的文件原地保留；每次删除逐条写审计日志（路径、大小、年龄），另有一次非空扫描的汇总日志；只触碰会话目录；清空后的协议子目录一并删除。注意 resident 守卫是进程内的：共享 `BILI_SESSIONS_DIR` 但不落盘的另一实例（如 `BILI_PERSIST=0`）不会刷新文件 mtime，其仍活跃的会话文件可能老化被扫 —— 代价同样是有限的一次冷重建，且有年龄门兜底。CCR 内容存储（#1097）与会话共享生命周期（#1180）：`<hash>.content-store.json` 伴随文件随其会话文件一起删除；孤儿伴随文件（会话文件已不存在）超过年龄门后被清扫；不可读的伴随文件会连同其会话文件一起保留（绝不猜测）。 |
| `BILI_SESSION_GC_MAX_AGE_DAYS` | 会话文件成为清理候选的最小年龄（天，默认 `7`）。必须远超任何合理续聊窗口：文件删除后同会话再续聊，消息编号会从 m00001 重新分配，而续聊 agent 的转录里可能还引用着旧编号（内核契约：编号永不复用）。 |
| `BILI_SESSION_GC_MAX_TOKENS` | 清理资格的大小上限（token 数，默认 `1000000` = 1M，#1082 owner 拍板）。按**解码后**的上下文判断，绝不看文件字节数（加密/zstd 文件在盘上小得多）：记录了最近一次请求体 token 估算值（`rawInputTokens`，每轮记录）时以它为准；未记录的旧文件用 `stats.contextTokens`；伴随的内容存储占用（#1097：唯一内容经内核 CJK-aware `defaultCountTokens` 计数，与 `rawInputTokens` 同一估算器，#1180）叠加其上，防止小会话携带大存储钻过上限。仅适用于从未被压缩过的会话 —— 含折叠块的文件无论多大都保留，因为其摘要无法从重新发送中无损重建。 |
| `BILI_SESSION_GC_INTERVAL_MS` | 后台清理扫描间隔（毫秒，默认 `3600000` = 1 小时）。启动时会先扫一次。 |
| `BILI_ENCRYPTION_KEY` | 会话文件静态加密（#708），适用于部署在不可信节点的场景。密钥必须恰好 32 字节，hex（64 字符）或 base64；未设置 = 不加密的纯 JSON 文件（设 `BILI_PERSIST_ZSTD=1` 时为 `BILIZSTD1`——参见 `BILI_PERSIST_ZSTD`）。设置后：每个会话文件均以 `BILIENC1` 格式写入，即对 JSON 施加 AES-256-GCM 加密，JSON 仅在 `BILI_PERSIST_ZSTD=1` 时以 zstd 压缩（Node ≥ 22.15 使用 zstd，其余情况写入原始数据）——启用压缩还可将文件体积缩小约 5–10 倍。加密与压缩现为独立的配置项（#1080）。密钥只从该环境变量读取——永不落盘、永不进日志——请确保它不受同一文件系统上的其他进程触及。非法值会导致启动中止（快速失败，绝不静默明文运行）。用错误的密钥启动时，受影响的会话按损坏文件跳过（有日志，不崩溃）。丢失密钥将使已加密的会话永久不可读。对称加密为刻意设计（同一进程既加密又解密）。已有的未编码文件从不在启动时改写——在其下一次保存时自然加密（降级安全；参见 `BILI_PERSIST_ZSTD`）。威胁模型（#708，owner 确认）：防的是**离线/机械性**的文件获取——云厂商换盘、节点镜像漂移后的离线磁盘快照、磁盘镜像失窃、备份泄露、被云同步的状态目录——离线第三方拿不到密钥即无法读取内容。不防御对活节点有访问权的定向攻击者；那一档应把信任根移出 proxy（KMS / TEE / 机密虚拟机 + 强化权限体系），而不是在 proxy 本身想办法——到了那个程度暴露的远不止密钥，proxy 层不是该守的边界（`BILI_PERSIST=0` 可彻底关闭持久化）。用同一进程/环境中的第二把密钥对密钥做二次加密不增加任何安全性：所有离线失窃场景里攻击者缺的始终只有一个工件——你的非落盘秘密——无论它叫数据密钥还是包裹密钥；只有把包裹密钥放进不同信任域（KMS/TPM/TEE）才能提高门槛，而那属于上面的场景 2。 |
| `BILLION_CONTEXT_PROXY` | launcher 会导出它；客户端侧 bili 插件/扩展检测到后自禁用自身压缩（避免双重压缩）。 |
| `BILLION_CONTEXT_PLUGIN` | 设 `0` 彻底关闭插件模式（恢复 wire 层工具注入）。 |
| `BILI_LAUNCHER_MODEL_WINDOWS` | 内部使用：launcher 把客户端自身配置里的逐模型上下文窗口（pi `models.json`、omp `models.yml`、opencode `models.<id>.limit`、codex `model_context_window`）以 JSON 传给自己拉起的代理，让 nudge 分母对自托管模型也用真实窗口。只有 launcher 会设置，无需用户配置。 |
| `BILI_LAUNCHER_PLUGIN` | 设 `0` 关闭 launcher 为 claude/codex 注入 bili MCP 服务器（退回纯 wire 模式）；设 `1` 强制插件模式。默认注入——但 codex 上游为本地/私网地址时自动退回 wire 模式（sglang/vllm/ollama 不解析 codex 的 namespace 工具类型）。见[启动器参考](#启动器参考)。 |
| `BILI_LAUNCHER_DIRECT` | 设 `1` 启用 launcher 直连 URL 路由（放弃 MITM/CA 信任）。见[启动器参考](#启动器参考)。 |
| `BILI_NATIVE_ATTACH_EXTERNAL` | 附着门禁逃生舱（#1335）。原生 hook 只附着于报告了 armed 会话生命周期看门狗（`/__bili/health` 里 `watchdog.armed == true`）的代理——手工 `bili start` 守护进程没有生命周期属主（拒绝 watcher 注册、不随会话退出、常是旧版本），所以默认每会话自拉起临时代理而不附着它。当你刻意运行常驻守护进程给原生 hook 共用时设 `1`/`true`：任何 code/lane 兼容的监听者重新可附着，无论看门狗状态如何（包括根本不报 `watchdog` 字段的 pre-#1330 构建）——此时守护进程的寿命与版本由你自己负责。配置文件里 `"native": { "attachExternal": true }` 等效；环境变量优先（`0`/`false` 即使文件开着也关门禁）。默认关闭。见 [README.zh-CN.md](README.zh-CN.md)「附着门禁(#1335)」。 |
| `BILI_CLAUDE_UPSTREAM` | claude 直连模式：当 `ANTHROPIC_BASE_URL` 已指向某个 relay 时，用它指定你的 relay 端点（否则会被旁路）。 |
| `BILI_CODEX_COMPACT` | codex 原生压缩处理。默认 `intercept`：安全门通过时（transform 成功 + 稳态用量 < 窗口 90% + 至少一个活跃压缩块）拦截 codex 的压缩请求，在本地伪造向 ACP 状态的交接——trigger 形态伪造 2 帧 SSE，endpoint 形态伪造 `{output}`——且不接触上游。伪造的 ACP 摘要经历史承载交接消息注入（缺席时 developer 消息兜底），保证 codex 截断历史后压缩内容仍可见。设为 `pass` 可退出，把 codex 的压缩请求转发给上游（原生压缩兜底）。任一安全门失败则原样透传。 |

---

## CLI 参考

完整命令面（`bili --help` 打印的是精简版）。优先级处处一致：**CLI 参数 > 环境变量 > 配置文件 > 内置默认值**。

| 命令 | 作用 |
|---|---|
| `bili [start] [options]` | 启动代理（默认读取 XDG 配置文件） |
| `bili pi [opts --] [args]` | 启动代理 + 拉起 **pi** 接入它 |
| `bili pi-test [opts --] [args]` | 类似 `bili pi`，但追加 `--no-extensions`（干净测试 —— 压缩完全由代理负责） |
| `bili codex [opts --] [args]` | 代理 + **codex** |
| `bili claude [opts --] [args]` | 代理 + **claude**（Claude Code CLI） |
| `bili omp [opts --] [args]` | 代理 + **omp**（pi 内核） |
| `bili opencode [opts --] [args]` | 代理 + **opencode** |
| `bili hermes [opts --] [args]` | 代理 + **hermes-agent**（`/bili/` 重写） |
| `bili dsh [opts --] [args]` | 代理 + **deepseek-harness**（`/bili/` 重写；`--profile web "task"` 等参数原样透传） |
| `bili codebuddy [opts --] [args]` | 代理 + **codebuddy**（Tencent CodeBuddy Code CLI）—— `CODEBUDDY_BASE_URL` `/bili/` 重写,OpenAI chat-completions wire;预算对齐走 `CODEBUDDY_AUTO_COMPACT_WINDOW`(#640) |
| `bili qoder [opts --] [args]` | 代理 + **qoder** —— 证书 MITM(`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`);模型端点硬编码 https(`/bili/` 改写不可用,默认主机表加白名单)(#653) |
| `bili trae [opts --] [args]` | 代理 + **Trae CLI**（字节跳动,闭源 Go 二进制)—— 证书 MITM(`HTTPS_PROXY` + `SSL_CERT_FILE`);模型主机取 `TRAE_CLI_API_HOST` 或默认企业网关(#655) |
| `bili jcode [opts --] [args]` | 代理 + **jcode**（Rust 终端编码 agent)—— 环境变量式证书 MITM 启动(`HTTPS_PROXY` + `SSL_CERT_FILE`);托管模型主机 `api.z.ai` 默认加白,本地回环 provider 走 `NO_PROXY` 直连 |
| `bili kimi [opts --] [args]` | 代理 + **Kimi Code**(Moonshot CLI)—— 证书 MITM(`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`);provider/model 主机取自 `~/.kimi-code/config.toml`(遵循 `KIMI_CODE_HOME`),未声明时用托管 OAuth 端点;回环端点编目并附手动 `/bili/` 前缀提示(#757) |
| `bili test pi` | 无污染的 pi 链路端到端冒烟测试 |
| `bili export [session] [--full] [--output FILE]` | 列出持久化会话 / 把一个会话导出为 Markdown 交接文档 —— 见[会话与迁移](#会话与迁移) |
| `bili acp-cache diff <dump-dir> [--json] [--log FILE] [--no-log] [--session SID]` | 从 `ACP_DUMP_BODY` dump 归因缓存失效原因 —— 对同会话相邻请求做前缀 diff(#1266) |
| `bili update` | 立即检查并安装新版本（绕过 3 分钟节流） |
| `bili plugin install <agent>` | 把原生工具插件 / MCP 桥装进宿主 —— 见[插件模式（原生工具）](#插件模式原生工具) |
| `bili plugin remove <agent>` | 卸载 |
| `bili plugin list` | 显示每个宿主的安装状态 |
| `bili mcp` | 独立运行 bili MCP 服务器（stdio） |
| `bili plugin-register <id> [--origin URL] [--agent name]` | 预绑定会话 id 到插件模式（高级用法） |
| `bili --version` / `bili --help` | 打印版本 / 帮助 |

launcher 命令里 `--` 之后的参数原样透传给客户端（`bili pi -- print "hi"`）。

### 参数

| 参数 | 作用 |
|---|---|
| `--port <N>` | 监听端口（默认 `8787`） |
| `--host <ADDR>` | 监听主机（默认 `127.0.0.1`） |
| `--config <FILE>` | 配置 JSON 路径（默认： XDG 位置） |
| `--debug` | 详细日志 |
| `--passthrough` | 不经压缩直接转发 |
| `--no-passthrough` | 强制开启压缩（覆盖配置文件） |
| `--no-auto-update` | 本次运行禁用后台自动更新 |
| `--mitm-domain <domain>` | 追加 MITM 白名单域名（可重复；仅 launcher） |

---

## 客户端接入

不用 launcher 时，把客户端指向代理有两种方式：**`/bili/` 前缀**（API-key 客户端）和 **MITM 透明代理**（端点硬编码的登录客户端）。

### `/bili/` 前缀（API-key 客户端）

用 **API key** 配置（不是登录账号）的客户端允许你改上游 URL。只需在前面加上代理地址 + `/bili/`，其他都不用改。API key 仍留在客户端配置里，代理原样透传。

**OpenCode** —— 编辑 `~/.config/opencode/opencode.json`，改 provider 的 `baseURL`：

```jsonc
// 之前：
"baseURL": "https://open.bigmodel.cn/api/coding/paas/v4"
// 之后（前面加上代理地址 + /bili/）：
"baseURL": "http://localhost:8787/bili/https://open.bigmodel.cn/api/coding/paas/v4"
```

**Codex（API key 模式）** —— 编辑 `~/.codex/config.toml`，改 provider 的 `base_url`：

```toml
# 之前：
base_url = "https://api.openai.com/v1"
# 之后：
base_url = "http://localhost:8787/bili/https://api.openai.com/v1"
```

**Codex（ChatGPT 登录）** —— 设顶层 `openai_base_url` 字段（保持 `model_provider = "openai"` 和 OAuth 登录不变）：

```toml
# ~/.codex/config.toml（顶层字段，不是 section）
model_provider = "openai"
openai_base_url = "http://localhost:8787/bili/https://chatgpt.com/backend-api/codex"
```

照常运行 `codex login`；OAuth token 随 `Authorization` 头传输，代理原样转发给上游。

**Pi** —— 编辑 `~/.pi/agent/models.json`，改 provider 的 `baseUrl`：

```jsonc
// 之前：
"baseUrl": "https://api.anthropic.com"
// 之后：
"baseUrl": "http://localhost:8787/bili/https://api.anthropic.com"
```

**Claude Code** —— 把 `ANTHROPIC_BASE_URL` 环境变量设成 `/bili/` URL。（claude 的 undici fetch 忽略 `HTTPS_PROXY`，所以 `/bili/` URL 形式是唯一的手动方式 —— 证书 MITM 拦不到它。）

```bash
export ANTHROPIC_BASE_URL="http://localhost:8787/bili/https://api.anthropic.com"
```

> **自动压缩对齐（仅手动模式）。** `bili claude` launcher 会自动把 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 设成 bili 对你模型的有效窗口，让 claude 自己的自动压缩阈值与 bili 的压缩预算对齐。手动 `/bili/` 模式下需要你自己设 —— 否则 claude 可能在与 bili 窗口不一致的阈值上跑它自己的本地自动压缩（一次“总结对话”轮次）。这通常无害（同一 session-id，bili 会从截断中重新推导状态），但比必要的更吵。把它设成 bili 对你模型的有效窗口：
>
> ```bash
> export CLAUDE_CODE_AUTO_COMPACT_WINDOW=<bili 有效窗口 token 数>
> ```
>
> claude 会把这个值**向下**钳制到它自己感知的模型窗口（不会向上），所以设大了是安全的。也可以持久化到 claude 的 settings（`autoCompactWindow`）里。

**其他 API-key 客户端（Cursor / Aider / Continue ……）** —— 只要配置了上游 URL，前面加 `http://localhost:8787/bili/` 就行，其他都不用改。

`/bili/` 前缀还是个**自检测信号**：billion-context 的客户端扩展（billion-context-pi / opencode-acp）能在自己的 baseUrl 里认出它并自禁用，避免双层压缩。

### MITM 透明代理（登录/订阅客户端）

用**账号登录**的客户端（ChatGPT Plus/Pro、Claude、ZCode coding plan ……）走 OAuth 认证，且通常**硬编码端点** —— 改不了 baseURL 就没法用前缀方式，这类客户端要用 MITM 模式。

原理：这类客户端只提供 **HTTP 代理**设置，所以它发送 `CONNECT <host>:443`；billion-context 在本地终结 TLS（用本地生成的根 CA），把压缩注入明文，再重新加密转发。OAuth token 随客户端的 `Authorization` 头传输、原样转发 —— 订阅折扣得以保留。

支持的 MITM 客户端：

| 客户端 | 登录方式 | 硬编码端点 | 状态 |
|---|---|---|---|
| **ZCode** | bigmodel coding plan（OAuth） | `open.bigmodel.cn`（内置 provider） | ✅ 已测试 |
| **Claude Code** | Claude 订阅（OAuth） | `api.anthropic.com` | ❓ 未测试（可能不可用 —— 待验证） |
| **CodeBuddy**（VS Code IDE） | IDE 账号登录 | `copilot.tencent.com`（经 `http.proxy` 到达） | ✅ 用户验证（#897） |

> **Codex 例外：** Codex 暴露顶层 `openai_base_url` 配置字段，所以 ChatGPT 登录版**可以**用 `/bili/` 前缀（见上文）。Codex 不需要 MITM。

> **ZCode 原生模式（#1145）：** ZCode 是这张表里唯一同时拥有**原生插件模式**的客户端 —— `bili plugin install zcode` 经 provider store（`~/.zcode/v2/config.json`，v3.14+ 为 `provider_config.json`）路由模型流量，完全不需要 GUI 代理/CA 设置。原生模式不碰 MITM 面：若两者并用，请保留 GUI 代理设置（以及 `"mitm://zcode.z.ai": { "passthrough": true }` 路由，#661）供登录流量使用。完整机制：README「ZCode」小节。

MITM 只对一份**白名单**中的模型域名生效（`open.bigmodel.cn`、`api.anthropic.com`、`api.openai.com`、`chatgpt.com`）。其余 HTTPS 主机全部盲转发 —— billion-context 绝不解密非模型流量。

> **只有 `http.proxy` 设置的客户端（CONNECT-only）：** 许多 IDE 系客户端（CodeBuddy、Cursor、Windsurf……）没有模型 base-URL 设置 —— 它们把全部流量经 HTTP 代理以 `CONNECT` 方式发出。这类客户端只有在其模型域名被加进上面的白名单后才会被解密；否则其隧道是**盲**的：不报错，但也**不会压缩**，因为 billion-context 根本看不到明文。该误配置现在会被显式暴露（#897）：每个目标域名的首个盲隧道会在日志打一条一次性 `BLIND TUNNEL WARNING` 并附修复步骤；`GET /__bili/health` 与 `/__bili/stats` 输出 `blindTunnels`（计数 + 精确目标域名，仅 loopback）；存在此类隧道时 `acp_status` 会多一节 `UNDECRYPTED TRAFFIC (instance-level)`。修复：把该客户端的模型域名加进 `"mitm".domains`（或 `BILI_MITM_DOMAINS`），重启，并按下文信任根 CA。注意代理日志默认对非公开目标域名脱敏（`<private-host>`，#255）—— 设 `BILI_LOG_MASK_HOSTS=0` 可在本地日志看到真实域名。

一次性设置（在客户端里信任根 CA）：

1. 启动一次代理以生成根 CA：

   ```bash
   bili start
   ls ~/.local/share/billion-context/ca/root-ca.pem   # 现在存在了
   ```

2. 在客户端的 **设置 → 网络 / 代理** 里设：
   - **HTTP 代理**： `http://127.0.0.1:8787`
   - **代理 CA 证书路径**： 本机 bili 实际生成的 CA 文件 —— Linux/macOS 为 `~/.local/share/billion-context/ca/root-ca.pem`，Windows 为 `%USERPROFILE%\.local\share\billion-context\ca\root-ca.pem`。Web UI「接入」页的 ZCode 卡片直接显示本机实际路径并提供复制按钮，照抄即可。
   - （可选）**No-proxy 列表**： `localhost,127.0.0.1`
   - （ZCode 具体位置：**Settings → Network**。Claude Code 则设 `HTTPS_PROXY` 环境变量、`NODE_EXTRA_CA_CERTS` 指向 CA 路径。）

   > **Windows 注意：** ZCode 在 Windows 上**不会展开 `~`**，填 `~/...` 形式的路径会找不到文件（与当前工作目录无关，每个目录都识别不了）。必须填完整绝对路径，例如 `C:\Users\<用户名>\.local\share\billion-context\ca\root-ca.pem`（#342）。

3. 重启客户端。它的模型流量从此流经 billion-context 并注入压缩。发一条消息，在代理日志（`~/.local/state/billion-context/bili.log`）里找 `mitm <host>:443 tunnel established`。

> 根 CA 在本地生成、只存在于本机 —— **不是**系统级安装。只有你配置的那个客户端（通过它的 CA 路径设置）信任它，其他应用不受影响。删掉 CA 文件并重启代理会重新生成。

要给 MITM 登录客户端配**专属上游代理**（防火墙/GFW）而不影响同一域名上的 API-key 客户端，用 `mitm://` scheme 键 —— 见 README「上游代理」一节。

---

## 启动器参考

`bili <client>` 在一个独立端口拉起代理（**每次启动都是全新实例** —— 不会复用已在运行的 `bili start`，#216），然后把客户端指向它。**不改动任何配置文件**：启动器只**读取**（绝不编辑）客户端自己的配置来发现它访问哪些上游主机；这些主机自动加入 MITM 白名单。客户端退出时，启动器拉起的代理随之停止。

两种上游方案全自动覆盖，无需配置：

- **HTTPS 上游 → 证书 MITM。** 通过 `HTTPS_PROXY` 把客户端指向代理，并让它信任代理的 MITM 根 CA（`~/.local/share/billion-context/ca/root-ca.pem`，惰性生成）。压缩注入在被拦截的 TLS 流上。
- **HTTP / localhost 上游 → `/bili/` baseURL 重写**（明文没法 MITM）。启动器通过客户端自己的机制重写 base URL，走的是配置的隔离临时副本 —— 真实配置文件一个字节都不碰（见下文）。

各客户端如何被指向代理（自动设置在子进程环境里）：

| 客户端 | 重定向方式 | CA 信任 |
|---|---|---|
| pi | `HTTPS_PROXY` + `BILI_PROVIDER_REWRITES` env 清单（扩展 `registerProvider`） | `NODE_EXTRA_CA_CERTS` |
| omp | `HTTPS_PROXY` + `BILI_PROVIDER_REWRITES` env 清单（扩展 `registerProvider`） | `NODE_EXTRA_CA_CERTS` |
| codex | `HTTPS_PROXY` + `-c key=value` 覆盖 | `SSL_CERT_FILE` → `combined-ca.pem` |
| claude | `ANTHROPIC_BASE_URL` = `/bili/` URL | 无需 |
| opencode | `HTTPS_PROXY` + 隔离 `OPENCODE_CONFIG` | `NODE_EXTRA_CA_CERTS` |
| hermes | `HTTPS_PROXY`（明文 http 走 absolute-form 正向代理请求） | `SSL_CERT_FILE` → `combined-ca.pem`（另设旧版 `HERMES_CA_BUNDLE` → `root-ca.pem`） |
| dsh | `HTTPS_PROXY`（明文 http 另加 `HTTP_PROXY`）+ `DEEPSEEK_BASE_URL`；**仅回环**隔离 `DSH_HOME` | `SSL_CERT_FILE` → `combined-ca.pem` |

`NODE_EXTRA_CA_CERTS` 是**追加**到内置信任库，所以只指向 MITM 根证书（`root-ca.pem`）即可。`SSL_CERT_FILE` 会**替换**默认 CA bundle，所以 codex/dsh/hermes 指向 `combined-ca.pem` —— 包含 MITM 根证书**加上**系统/Node 公共根 —— 保证子进程环境里 pip/git/curl 类 TLS（盲转发、真证书）不受影响（#152；hermes 自 #1375 起，因为当前 hermes 只经 `SSL_CERT_FILE` 解析环境信任）。

Claude Code 的 undici fetch 忽略 `HTTPS_PROXY`，所以证书 MITM 拦不到它。claude 的所有上游 —— 包括预先配置的 `ANTHROPIC_BASE_URL` relay —— 一律改走 `/bili/` URL 形式的 `ANTHROPIC_BASE_URL`；无需任何 CA 信任。

上游从哪里发现（只读）：

| 客户端 | 读取位置 |
|---|---|
| Pi | `~/.pi/agent/models.json` —— 各 provider 的 `baseUrl` |
| omp | `~/.omp/agent/models.yml` —— 各 provider 的 `baseUrl` |
| Codex | `~/.codex/config.toml` —— 各 `[model_providers.<name>]` 的 `base_url`（+ 顶层 `openai_base_url`） |
| Claude Code | `ANTHROPIC_BASE_URL` 环境变量，否则硬编码 `api.anthropic.com` |
| OpenCode | `~/.config/opencode/opencode.json` —— 各 provider 的 `baseURL` |
| hermes | `~/.hermes/config.yaml` —— 各 provider 的端点行 |
| dsh | `~/.dsh/settings.yaml` —— 每个 `baseURL`/`baseUrl`/`base_url` 值，按目的地分流（回环 → `/bili/` 重写；非回环 https → MITM 白名单；非回环 http → `HTTP_PROXY`）；内置 `deepseek-official` 路由另经 `$DEEPSEEK_BASE_URL` 接管 |

### 生成文件（写了什么 —— 最后手段，#535）

启动器优先零文件注入（env > CLI 参数/扩展 API > 生成文件；见 [TECHNICAL-NOTES.zh-CN.md —— 注入优先级](TECHNICAL-NOTES.zh-CN.md)）。确实绕不开文件时写的都是**副本** —— 真实配置绝不编辑：

- **pi / omp** —— 不写任何文件（#535）：provider baseUrl 走 `BILI_PROVIDER_REWRITES` env 清单，由 bili 扩展加载时消费（`registerProvider`）；自动原生压缩改由扩展内取消（`session_before_compact`，omp 按 `auto_compaction_start` 预告区分自动/手动，#851）——但仅在代理确实承载该会话有正证据时才取消（插件已为该会话 id 盖章 `x-bili-plugin-conversation`、omp 身份注册成功、或 `/__bili/plugin/status?conversationId=` 确认）；非 http(s) 的 provider baseUrl（如 pi-claude-bridge 的字面量 `"claude-bridge"`）永不取消，其自带的压缩接管继续生效（#1382）——手动 `/compact` 无论如何都保持用户所有。真实 `~/.pi` / `~/.omp` 主目录原样不动。
- **opencode** —— 临时 `opencode.json`（由 `OPENCODE_CONFIG` 指向，客户端退出时删除），明文 `baseURL` 重写为 `/bili/` 形式，**并追加了薄插件**（`/acp` + `/acp-cache` 命令）。OpenCode 1.x 下 `opencode-acp` 条目会从副本中移除（主机不得以激活状态加载它），改由薄插件把同一个包作为库导入、仅对 legacy 会话生效；首个被移除的 spec 经 `BILI_OPENCODE_ACP_SPEC` 传递，保证 bridge 导入的正是主机本会加载的那份拷贝（#920）。
- **hermes** —— 不写任何文件（#535）：其 httpx 栈走 `HTTPS_PROXY`（+ `SSL_CERT_FILE` → `combined-ca.pem`；旧版 `HERMES_CA_BUNDLE` 保留设置，#1375）—— https 经 CONNECT 证书 MITM，明文 http 经 absolute-form 正向代理请求。若没配置任何 provider，启动器打印警告，hermes 将**不经代理**运行（无压缩）。
- **dsh** —— 按目的地分流（#535）：dsh 的 fetch 栈尊重代理 env，但对回环目标无条件绕过，所以**非回环**上游走 `HTTPS_PROXY`（证书 MITM）/ `HTTP_PROXY`（absolute-form 正向代理请求），`SSL_CERT_FILE` → `combined-ca.pem`；仅**回环**上游保留持久 overlay `DSH_HOME`（`~/.dsh-bili`），重写后的 `settings.yaml` 让它们走 `/bili/`。`profiles/`、凭据、会话符号链接共享；真实 `~/.dsh` 绝不触碰。内置 `deepseek-official` 路由另行经 `$DEEPSEEK_BASE_URL` 接管（dsh 解析顺序为 settings `llm-deepseek.baseURL` ?? 环境变量 ?? 默认值，用户配置优先，环境变量作零配置兜底）—— 即便没有任何自定义 provider，内置 deepseek 路由也照样走代理。

### 启动器里的原生工具

- **pi** —— 未安装插件时，启动器借用 pi 的 `-e <file>` 参数为本次运行加载 `dist/agent/pi.js`（不写任何东西）：开箱即原生工具 + `/acp`、`/acp-cache` 与 `/acp-rule` 命令（`/acp-cache` 默认总账摘要 —— 总计、判定、异常行；追加 `full`（或 `--full`）看全量明细，等价于 `acp_cache` 工具传 `detail: "full"`）。已安装则符号链接的 `settings.json` 已加载它 —— 不再加 `-e`。
- **omp** —— 发行版不自带插件；启动器在配置里没有可加载的 bili 条目时自动注入 `-e dist/agent/omp.js`（与 pi 相同的零配置搭车）。两个 omp 专属机制让插件在那里完全原生：omp 17.x 会把未声明 `loadMode` 的扩展工具挂到 `xd://` 设备 URL 下（模型主回合看不到），插件因此用 `loadMode: "essential"` 注册 —— 模型直接拿到四个 ACP 原生工具；omp 分叉不发 `before_provider_headers`，插件改走启动器身份注册（`POST /__bili/plugin/register`，以 omp 会话 id = `prompt_cache_key`/`x-session-id` 为键）绑定会话 —— 绑定后的会话进入插件模式（抑制 wire 注入）并带有原生 `/acp`、`/acp-cache` 与 `/acp-rule` 命令。
- **opencode** —— 临时配置自动追加薄插件。
- **claude / codex** —— 默认开启：启动器注入单个 `bili` MCP 服务器（claude 用 `--mcp-config`，codex 用 `-c mcp_servers.bili.*` —— 都是临时生效，不写宿主配置），开箱即原生工具（已在 claude 2.1.227 / codex 0.147.0 验证）。`BILI_LAUNCHER_PLUGIN=0` 退回纯 wire 模式 —— 适用于早于已验证版本、未针对注入参数测试的宿主。
- **codex + 自建上游自动回退** —— codex 0.147 把 MCP 工具以 `namespace` 工具类型发给模型；自建推理服务（sglang/vllm/ollama/llama.cpp）不解析该类型，工具会静默失明。当 codex 上游主机是环回/私网地址（`127.0.0.1`、RFC1918、ULA、`.local` 等）且未设置 `BILI_LAUNCHER_PLUGIN` 时，bili 自动改用 wire 模式（扁平工具，所有服务都认识）并在 stderr 说明。`BILI_LAUNCHER_PLUGIN=1` 可强制插件模式。
- **hermes** —— 无插件 API；永远 wire 模式。
- **dsh** —— 启动器始终在 dsh 的 argv 里拼接 `--patch <file>`（写入 `~/.dsh-bili/.bili-acp.patch.yml`），把 `dist/agent/dsh-acp.js` 插进 profile 的加载树：原生 `/acp` 与 `/acp-cache` 命令，与 dsh 自带 `/compact` 同一形态（`/acp-cache` 显示默认总账摘要 —— dsh 的命令 API 不传参数，因此没有 `full`）。在任何组合了 commands 服务的 profile（web/tui 交互表面）都可用；`headless` 一次性驱动器把任务直接发给模型、不解析命令（原生 `/compact` 在那里同样不可用）。子命令形态已处理：`dsh web` 的 flag 插在 `web` 之后，`dsh plugin`/`--dump-default-config` 不注入。

启动器模式矩阵：

| 模式 | 工具形态 | 设置 |
|---|---|---|
| 启动器 + MCP（claude/codex 默认） | 原生 MCP 工具 | 无 —— `bili claude` / `bili codex` 即可 |
| 启动器 wire 模式（claude/codex，`BILI_LAUNCHER_PLUGIN=0`） | 代理注入的 wire 工具 | 一个环境变量 |
| 启动器 `-e` / 自动插件（pi、omp、opencode） | 原生插件工具 | 无 |
| 手动插件（`bili plugin install`） | 客户端侧插件 | 执行 install |
| 手动 baseURL（`/bili/` 前缀） | 代理注入的 wire 工具 | 改客户端配置 |

### 直连 URL 模式（可选）

`BILI_LAUNCHER_DIRECT=1` 彻底放弃 MITM/CA 信任 —— claude 的 `ANTHROPIC_BASE_URL` / codex 的 provider `base_url` 直接指向 `/bili/` 前缀。警告：

- **codex 直连模式**：LLM 流量**不**经过代理，压缩不生效 —— 只有 bili MCP 工具调用经过。要完整压缩请用默认 MITM 模式（不设 `BILI_LAUNCHER_DIRECT`）。
- **claude 直连模式**：`ANTHROPIC_BASE_URL` 被覆盖指向代理；预先配置的 relay 被旁路，除非设 `BILI_CLAUDE_UPSTREAM=<relay>`。OAuth 订阅流量需要默认 MITM 模式。

`--mitm-domain <domain>`（可重复）在自动发现之外追加 MITM 白名单域名 —— 适用于客户端在运行时才获取、不写进配置文件的主机。默认端口被占用时启动器自动换空闲端口；`--passthrough` / `--debug` / `--no-auto-update` 与普通 `bili` 用法相同。

---

## 插件模式（原生工具）

想要原生插件体验，可以在客户端里装一个配合代理的插件：插件把四个 ACP 工具（`compress` / `decompress` / `search_context` / `acp_status`）原生注册进客户端、由客户端自己的工具循环驱动，而代理仍然是压缩引擎（状态、历史折叠、压缩哲学 prompt、nudge 全归代理）。工具 schema 由代理统一下发（`GET /__bili/plugin/manifest`），插件与代理永远不会版本漂移。协议规范见 [PLUGIN.md](PLUGIN.md)。

带插件的会话通过请求头自动识别 —— 该会话的 wire 层工具注入自动关闭（不会双重压缩，工具体验原生）。两种代理模式都支持：`/bili/` 前缀 baseURL **和** MITM 透明模式。插件还可以上报客户端自己的模型上下文窗口（`x-bili-plugin-context-window`），并通过 `GET /__bili/plugin/status` 读取实时上下文水位。

### install / remove / list

```bash
bili plugin install pi      # 把本 billion-context 安装加入 pi 的 settings.json（packages）
bili plugin install omp     # omp 同理（config.yml extensions）
bili plugin install claude  # 注册 bili MCP 服务器（claude mcp add，user 作用域）+ 写入
                                   # <configdir>/commands/acp-cache.md（模型中介的 /acp-cache）
bili plugin install codex   # 向 ~/.codex/config.toml 追加 [mcp_servers.bili]
bili plugin install opencode  # 向 ~/.config/opencode/opencode.json 加 mcp.bili
bili plugin list            # 所有受支持宿主的安装状态
bili plugin remove pi       # 撤销（原文件一次性备份为 *.bili-bak）
```

`install pi` 还会替换**遗留的** billion-context 条目（旧的 `npm:billion-context-pi` 引用、过期的 `npm:billion-context@x.y.z`、残留的 dev 目录路径），确保只有恰好一个 bili 插件在生效。

安装的插件是**薄**插件（约 5 KB，零运行时依赖）：它检测代理（从 `/bili/` baseURL 或 `BILLION_CONTEXT_PROXY`）、从代理拉取工具 schema、注册原生工具、转发执行 —— 代理始终是唯一的压缩引擎，所以插件与代理永远版本一致。没有插件 API 的宿主（claude、codex、opencode）改装 MCP 桥（`dist/mcp.js`）—— 底层协议相同，但 MCP 没有斜杠命令（没有 `/acp`；claude 额外获得模型中介的 `/acp-cache` markdown 命令，写入 `<configdir>/commands/acp-cache.md`，其提示词驱动 `acp_cache` MCP 工具 —— 模型把报告原样贴回）。

总开关：`BILLION_CONTEXT_PLUGIN=0` 彻底关闭插件模式（恢复 wire 层注入）。

**到底什么时候需要 `plugin install`？** 用启动器的基本都不需要（见[启动器参考](#启动器参考) —— pi/omp 自动 `-e`、opencode 自动注入、claude/codex 自动注入 MCP、dsh 经 `--patch` 自动获得原生 `/acp` 与 `/acp-cache` 命令、hermes 只能 wire）。它适用于手动配置客户端（`/bili/` 前缀或 MITM）又想要原生面板的场景：pi/omp/opencode 装后获得原生工具 + `/acp` 与 `/acp-cache`（pi/omp 另加 `/acp-rule`）；claude/codex 获得原生 MCP 工具（无 `/acp`；claude 获得模型中介的 `/acp-cache`）；dsh 的 `/acp` 与 `/acp-cache` 由启动器 `--patch` 注入（手动配置的 dsh 可自行添加同一 patch）；hermes 装不了（只能 wire）。不装任何插件一切照常工作 —— 压缩走 wire 注入的工具，让模型调 `acp_status` 即可查看实时用量。

### 检测其他压缩插件（#1206）

两个压缩器作用于同一会话会双压缩、破坏消息引用，所以 bili 会主动查找与自己并存的另一个压缩器：

- **扫描**（只读、尽力而为、5 分钟缓存）：opencode 全局 + 项目配置的 `plugin` 数组；pi 全局 + 项目 `.pi/settings.json` 的 `packages`；omp `config.yml` 的 `extensions`；claude 设置的 `enabledPlugins`/`plugins` 键 + `~/.claude/plugins/` 目录；kimi `plugins/installed.json`；hermes `~/.hermes/plugins/` 目录；dsh profile 的 `package.json` 依赖。两个层级：**已知冲突**（`opencode-acp`、遗留 `billion-context-pi`，确定性判定）和**关键词疑似**条目（名称匹配 compress / compact / acp / summar* / context*；bili 自身条目永远跳过，`context7` 这类非压缩工具不会误报）。
- **发现结果的出口**：客户端启动前的 launcher stderr；每个会话首个请求的一次性代理 warn 日志（client 由 `x-bili-plugin` 头或 wire 头识别）；会话冲突台账 —— `acp_status` 的 `COMPRESSION CONFLICTS` 段、`GET /__bili/stats` → `conflicts`、Web UI 横幅。
- **运行时证据**：未宣告的历史改写（#1001）与孤儿块废弃（被摘要的内容从客户端历史中被删掉）记入同一台账，让「疑似并存」与「实际观测到的干扰」互相印证。
- opencode launcher/native 模式下已存在的 `opencode-acp` 按设计只记 info（#920 有意吸收它处理 legacy 会话）；其他场景一律告警。
- 关闭方式：`BILI_CONFLICT_SCAN=0`。

---

## 会话与迁移

### 压缩状态存在代理里（#151）

压缩状态（块、摘要、原始消息缓存）存在**代理**里，不在客户端。客户端自己的本地历史是完整的未压缩视图。两个后果：

- 把客户端指回真实上游（或停掉代理）后，客户端每轮重放**完整本地历史**。长压缩会话之后这很容易超出模型上下文窗口（`context_window_exceeded`）。
- 没有办法把压缩块「解包」回客户端本地历史 —— 客户端从未见过压缩形态。

### 从代理迁移出去

导出会话，粘贴到新会话里作为交接：

```bash
bili export                      # 列出持久化会话（id、标签、块数）
bili export <id|label>           # 打印 Markdown 交接文档（块摘要）
bili export <id> --full          # 附上每个块的原始消息
bili export <id> --full --output handoff.md
```

然后在客户端里开一个新会话（直连上游），把交接文档粘贴为开场上下文。

### Codex 子代理有独立压缩命名空间（#150）

Codex 子代理（如 `guardian_subagent` 审批 reviewer）复用主会话的 `session_id`，在线路上看起来是同一个会话。若不处理，子代理请求会继承主会话的压缩状态 —— 子代理轮次的上下文可能被折叠（丢失它必须逐字读取的用户授权），两个角色的用量估算也会互相污染。

billion-context 通过 `instructions` 字段识别：子代理请求带自己的角色 prompt。会话**首次**看到的 instructions 锚定主命名空间（即使主 prompt 后来漂移也稳定）；任何其他 instructions 值映射到独立的 `|sub:` 命名空间，拥有自己的空白压缩状态。子代理请求是自包含重放，所以新命名空间无损 —— Web UI 的会话列表会把两个命名空间显示为共享同一客户端标签的独立会话。

### Windows：把会话目录加入杀软排除项（#362）

billion-context 把每个会话的压缩状态持久化为会话目录（默认 `%USERPROFILE%\.local\share\billion-context\`）下「一会话一 JSON 文件」，长会话每一轮都会重写该文件。在 Windows 上，实时杀毒（Windows Defender）、搜索索引器或同步工具（OneDrive）可能在写入中途锁住该目录。当锁跨多次写入持续时，rename 会以 `EPERM` 失败，在锁解除前该会话的每次持久化都会失败。

当同一会话连续 N 次写失败（默认 `5`，可用 `BILI_PERSIST_EPERM_ALERT_THRESHOLD` 调整）时，代理会打一条**一次性、可操作**的告警，明确指出要排除的目录。它不会重复刷屏（设 `BILI_PERSIST_EPERM_ALERT_REPEAT_MS > 0` 可在失败持续期间最多每 M 分钟重复一次）。

要从根上止住失败，把会话目录加入杀软排除项，并确保它不在任何同步文件夹内：

1. **Windows Defender 排除项：** 设置 → 隐私和安全性 → Windows 安全中心 → 病毒和威胁防护 → 管理设置 → **排除项** → **添加排除** → *文件夹* → 选择 `%USERPROFILE%\.local\share\billion-context\`。
2. **不要同步该目录。** 确认 OneDrive（或 Dropbox / Google Drive 等）没有同步 `%USERPROFILE%\.local\share\billion-context\`。若它位于同步文件夹下，用 `BILI_SESSIONS_DIR` 把它迁到非同步路径。

高频 persist 写入否则会在每一轮反复触发实时扫描 —— 这正是产生 `EPERM` 写失败的原因。目录加入排除项后，告警即止。
