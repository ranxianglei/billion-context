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

### `proxy`

- **类型：** `string`
- **默认值：** *（无 —— 不使用上游代理）*
- **状态：** ACTIVE
- **说明：** 用于代理**自身**到模型 provider 的出站连接的上游 HTTP 代理（`http://host:port`）。不支持 SOCKS5。在 `providers` 条目内设置的按 URL 的 `proxy` 会针对该 provider 覆盖此项。空字符串表示"显式直连" —— 为所有 provider 禁用任何环境/系统代理回退。

---

## Providers

`providers` 块将**上游 URL** 映射到按 provider 的配置。每个键是一个 URL 前缀；每个值可以声明模型上下文窗口、按 provider 的代理、压缩协议以及压缩覆盖项。

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
- **说明：** 将模型名映射到其上下文窗口声明。LLM 的 `/models` 端点**不会**返回上下文窗口大小（已在 OpenAI、Anthropic、zhipu、comfly 上验证），因此代理无法在运行时发现它们 —— 你必须在此声明。`context` 是模型的上下文窗口（以 token 为单位）；`output` 是最大输出大小。当模型未声明时，代理回退到内置上下文表或 models.dev 注册表。每个模型条目还可以携带按模型的 `compress` 块（见[压缩调优](#压缩调优)）。

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
- **说明：** 上下文窗口大小，以 token 为单位。它是引擎用于计算使用率比例的**分母**（`usage = tokens / modelContextLimit`）—— 它**不是**截断上限。接受绝对数值（`200000`）或百分比字符串（`"80%"` = 模型原始窗口的 80%，从内置表或 models.dev 注册表解析）。在每个层级都省略时，使用原始窗口。这是模型上限的最高优先级来源；它会覆盖内置表、旧版按模型的 `context` 字段以及顶层的 `modelContextLimit`。

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

#### `prompts`

- **类型：** `object`（`{ compressPhilosophy?, howToCompressRules?, tier2DistillRules?, tier3CondenseRules? }`，均为字符串）
- **默认值：** *（内核默认值 —— 见 `acp-kernel` 的 `defaultPrompts`）*
- **状态：** ACTIVE
- **说明：** 覆盖注入到系统提示词与 nudge 消息中的压缩提示词文本。每个字段都是**承重的（load-bearing）**：内核规则经过数月生产调优，覆盖它们可能降低摘要质量（丢失路径 / 签名 / 决策 → 检索失效）。只有当同一（胜出的）层级同时设置了 `acknowledgePromptsRisk: true` 时覆盖才生效；否则会被忽略并记录一次警告。非字符串字段会被静默丢弃（畸形的局部配置不会破坏正常默认值）。主要用于非英文或小模型调优 —— 见 issue #156。

#### `acknowledgePromptsRisk`

- **类型：** `boolean`
- **默认值：** `false`
- **状态：** ACTIVE
- **说明：** 必须为 `true`，`prompts` 覆盖才会生效。设置它即表示知悉上文所述的摘要质量风险。

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
| `BILI_IMAGE_TOKEN_CAP` | 预检尺寸门与输出钳制用的单图 token 估算上限（#488/#496）。默认内联 `data:` 图片按 `base64 长度 / 4` 计 token、**无上限** —— 对字节计费 relay 正确，但对像素 tile 计费的官方上游（Anthropic/OpenAI）会严重高估（后者无论字节多少，每图约计 1.1K–1.6K token）。设为你上游的单图 tile 成本，可让尺寸门反映真实计费；不设置 = 无上限（当前默认）。 |
| `BILI_CONFIG_FILE` | 覆盖配置文件路径（指向任意 JSON 文件）。 |
| `ACP_PORT` / `PORT` | 覆盖监听端口。 |
| `ACP_HOST` | 覆盖监听主机。 |
| `ACP_UPSTREAM` | 覆盖默认上游 base URL。 |
| `ACP_LOG` | 设为 `0` 关闭请求日志。 |
| `ACP_AUTO_UPDATE` | 设为 `0` 禁用自动更新检查。 |
| `ACP_PROVIDERS` | 指向外部 `providers.json` 的路径（旧版 / 共享文件）。 |
| `BILI_REPLAY_RETRY_BASE_MS` | acp-loop 回放重试的基础退避延迟（毫秒）：上游瞬时拒绝后重试（默认 `1500`；设 `0` 关闭延迟）。见 #189。 |
| `BILI_REPLAY_RETRY_MAX` | acp-loop 回放重试的总次数（默认 `3`；设 `1` 彻底关闭重试 —— 旧版 fail-fast 行为）。见 #189。 |
| `ACP_SESSION_HEADER` | 会话 id 请求头名称（默认 `x-acp-session`）。 |
| `ACP_REASONING_KEEP` | 仅 Responses API：设 `none` 丢弃全部 reasoning 项。默认让 reasoning 走压缩管道，其轮次被摘要后自动隐藏（避免无限累积破坏 Codex 的 prompt-cache 前缀）。 |
| `ACP_LOG_FILE` | 日志文件路径（默认 XDG state 路径；`off` 关闭文件只保留 stderr）。10 MB 自动轮转。 |
| `ACP_DUMP_SSE` | 调试用：转储原始 SSE 帧的目录。 |
| `BILI_UPSTREAM_PROXY` | 代理自身出站连接的上游代理 —— 优先级最高，高于 per-URL/per-provider 配置。见 README「上游代理」一节。 |
| `BILI_PERSIST` | 设 `0` 关闭会话持久化（仅内存，重启即丢）。 |
| `BILI_PERSIST_DEBOUNCE_MS` | 持久化写盘的防抖窗口（毫秒，默认 `500`）。 |
| `BILI_MAX_SESSIONS` | 内存中最多保留的会话数（默认 `256`；LRU 淘汰 —— 磁盘是事实源）。 |
| `BILI_SESSIONS_DIR` | 会话持久化目录（默认 XDG data 目录）。 |
| `BILLION_CONTEXT_PROXY` | launcher 会导出它；客户端侧 bili 插件/扩展检测到后自禁用自身压缩（避免双重压缩）。 |
| `BILLION_CONTEXT_PLUGIN` | 设 `0` 彻底关闭插件模式（恢复 wire 层工具注入）。 |
| `BILI_LAUNCHER_MODEL_WINDOWS` | 内部使用：launcher 把客户端自身配置里的逐模型上下文窗口（pi `models.json`、omp `models.yml`、opencode `models.<id>.limit`、codex `model_context_window`）以 JSON 传给自己拉起的代理，让 nudge 分母对自托管模型也用真实窗口。只有 launcher 会设置，无需用户配置。 |
| `BILI_LAUNCHER_PLUGIN` | 设 `0` 关闭 launcher 为 claude/codex 注入 bili MCP 服务器（退回纯 wire 模式）；设 `1` 强制插件模式。默认注入——但 codex 上游为本地/私网地址时自动退回 wire 模式（sglang/vllm/ollama 不解析 codex 的 namespace 工具类型）。见[启动器参考](#启动器参考)。 |
| `BILI_LAUNCHER_DIRECT` | 设 `1` 启用 launcher 直连 URL 路由（放弃 MITM/CA 信任）。见[启动器参考](#启动器参考)。 |
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
| `bili test pi` | 无污染的 pi 链路端到端冒烟测试 |
| `bili export [session] [--full] [--output FILE]` | 列出持久化会话 / 把一个会话导出为 Markdown 交接文档 —— 见[会话与迁移](#会话与迁移) |
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

> **Codex 例外：** Codex 暴露顶层 `openai_base_url` 配置字段，所以 ChatGPT 登录版**可以**用 `/bili/` 前缀（见上文）。Codex 不需要 MITM。

MITM 只对一份**白名单**中的模型域名生效（`open.bigmodel.cn`、`api.anthropic.com`、`api.openai.com`、`chatgpt.com`）。其余 HTTPS 主机全部盲转发 —— billion-context 绝不解密非模型流量。

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
| pi | `HTTPS_PROXY` + 隔离 `PI_CODING_AGENT_DIR` | `NODE_EXTRA_CA_CERTS` |
| omp | `HTTPS_PROXY` + 隔离 `PI_CODING_AGENT_DIR` | `NODE_EXTRA_CA_CERTS` |
| codex | `HTTPS_PROXY` + `-c key=value` 覆盖 | `SSL_CERT_FILE` → `combined-ca.pem` |
| claude | `ANTHROPIC_BASE_URL` = `/bili/` URL | 无需 |
| opencode | `HTTPS_PROXY` + 隔离 `OPENCODE_CONFIG` | `NODE_EXTRA_CA_CERTS` |
| hermes | 隔离 `HERMES_HOME`；**全部**上游走 `/bili/` | 无（certifi 忽略 `SSL_CERT_FILE`） |
| dsh | 隔离 `DSH_HOME` + `DEEPSEEK_BASE_URL`；**全部**上游走 `/bili/` | 无（纯 fetch，无代理/CA 接口） |

`NODE_EXTRA_CA_CERTS` 是**追加**到内置信任库，所以只指向 MITM 根证书（`root-ca.pem`）即可。`SSL_CERT_FILE` 会**替换**默认 CA bundle，所以 codex 指向 `combined-ca.pem` —— 包含 MITM 根证书**加上**系统/Node 公共根 —— 保证子进程环境里 pip/git/curl 类 TLS（盲转发、真证书）不受影响（#152）。

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
| dsh | `~/.dsh/settings.yaml` —— 每个 `baseURL`/`baseUrl`/`base_url` 值；内置 `deepseek-official` 路由另经 `$DEEPSEEK_BASE_URL` 接管 |

### 隔离临时配置（写了什么）

`/bili/` 重写模式写的是**临时副本** —— 真实配置绝不编辑 —— 客户端退出时临时目录一并删除：

- **pi / omp** —— 隔离的 `PI_CODING_AGENT_DIR`（在 `/tmp` 下），里面只有一份重写后的 `models.json` / `models.yml`（明文 baseUrl 包上 `/bili/`）。其余一切（`settings.json`、`sessions/`、`auth.json`、扩展……）都**符号链接**到真实 pi/omp 主目录，所以会话与登录互通：launcher 里开的会话在裸客户端里无缝继续，反之亦然。
- **opencode** —— 临时 `opencode.json`（由 `OPENCODE_CONFIG` 指向），`baseURL` 重写为 `/bili/` 形式，**并追加了薄 `/acp` 插件**（开箱即原生工具；独立的 `opencode-acp` 插件检测到 `BILLION_CONTEXT_PROXY` 后自禁用）。
- **hermes** —— 隔离的 `HERMES_HOME`，重写后的 `config.yaml` 让**所有**上游（HTTP 和 HTTPS）都走 `/bili/`（httpx 自建 CA bundle 且忽略 `SSL_CERT_FILE`，证书 MITM 不可行）。`skills/`、`memories/`、`sessions/` 符号链接共享。若没配置任何 provider —— 或 `config.yaml` 无法重写 —— 启动器打印警告，hermes 将**不经代理**运行（无压缩）。
- **dsh** —— 隔离的 `DSH_HOME`（持久 overlay `~/.dsh-bili`），重写后的 `settings.yaml` 让所有已配置上游都走 `/bili/`（纯 `fetch`，无代理/CA 接口，证书 MITM 不可行）。`profiles/`、凭据、会话符号链接共享。内置 `deepseek-official` 路由另行经 `$DEEPSEEK_BASE_URL` 接管（dsh 解析顺序为 settings `llm-deepseek.baseURL` ?? 环境变量 ?? 默认值，重写过的用户配置优先，环境变量作零配置兜底）—— 即便没有任何自定义 provider，内置 deepseek 路由也照样走代理。

### 启动器里的原生工具

- **pi** —— 未安装插件时，启动器借用 pi 的 `-e <file>` 参数为本次运行加载 `dist/agent/pi.js`（不写任何东西）：开箱即原生工具 + `/acp` 命令。已安装则符号链接的 `settings.json` 已加载它 —— 不再加 `-e`。
- **omp** —— 发行版不自带插件；启动器在配置里没有可加载的 bili 条目时自动注入 `-e dist/agent/omp.js`（与 pi 相同的零配置搭车）。两个 omp 专属机制让插件在那里完全原生：omp 17.x 会把未声明 `loadMode` 的扩展工具挂到 `xd://` 设备 URL 下（模型主回合看不到），插件因此用 `loadMode: "essential"` 注册 —— 模型直接拿到四个 ACP 原生工具；omp 分叉不发 `before_provider_headers`，插件改走启动器身份注册（`POST /__bili/plugin/register`，以 omp 会话 id = `prompt_cache_key`/`x-session-id` 为键）绑定会话 —— 绑定后的会话进入插件模式（抑制 wire 注入）并带有原生 `/acp` 命令。
- **opencode** —— 临时配置自动追加薄插件。
- **claude / codex** —— 默认开启：启动器注入单个 `bili` MCP 服务器（claude 用 `--mcp-config`，codex 用 `-c mcp_servers.bili.*` —— 都是临时生效，不写宿主配置），开箱即原生工具（已在 claude 2.1.227 / codex 0.147.0 验证）。`BILI_LAUNCHER_PLUGIN=0` 退回纯 wire 模式 —— 适用于早于已验证版本、未针对注入参数测试的宿主。
- **codex + 自建上游自动回退** —— codex 0.147 把 MCP 工具以 `namespace` 工具类型发给模型；自建推理服务（sglang/vllm/ollama/llama.cpp）不解析该类型，工具会静默失明。当 codex 上游主机是环回/私网地址（`127.0.0.1`、RFC1918、ULA、`.local` 等）且未设置 `BILI_LAUNCHER_PLUGIN` 时，bili 自动改用 wire 模式（扁平工具，所有服务都认识）并在 stderr 说明。`BILI_LAUNCHER_PLUGIN=1` 可强制插件模式。
- **hermes** —— 无插件 API；永远 wire 模式。
- **dsh** —— 启动器始终在 dsh 的 argv 里拼接 `--patch <file>`（写入 `~/.dsh-bili/.bili-acp.patch.yml`），把 `dist/agent/dsh-acp.js` 插进 profile 的加载树：原生 `/acp` 命令，与 dsh 自带 `/compact` 同一形态。在任何组合了 commands 服务的 profile（web/tui 交互表面）都可用；`headless` 一次性驱动器把任务直接发给模型、不解析命令（原生 `/compact` 在那里同样不可用）。子命令形态已处理：`dsh web` 的 flag 插在 `web` 之后，`dsh plugin`/`--dump-default-config` 不注入。

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
bili plugin install claude  # 注册 bili MCP 服务器（claude mcp add，user 作用域）
bili plugin install codex   # 向 ~/.codex/config.toml 追加 [mcp_servers.bili]
bili plugin install opencode  # 向 ~/.config/opencode/opencode.json 加 mcp.bili
bili plugin list            # 所有受支持宿主的安装状态
bili plugin remove pi       # 撤销（原文件一次性备份为 *.bili-bak）
```

`install pi` 还会替换**遗留的** billion-context 条目（旧的 `npm:billion-context-pi` 引用、过期的 `npm:billion-context@x.y.z`、残留的 dev 目录路径），确保只有恰好一个 bili 插件在生效。

安装的插件是**薄**插件（约 5 KB，零运行时依赖）：它检测代理（从 `/bili/` baseURL 或 `BILLION_CONTEXT_PROXY`）、从代理拉取工具 schema、注册原生工具、转发执行 —— 代理始终是唯一的压缩引擎，所以插件与代理永远版本一致。没有插件 API 的宿主（claude、codex、opencode）改装 MCP 桥（`dist/mcp.js`）—— 底层协议相同，但 MCP 没有斜杠命令（没有 `/acp`）。

总开关：`BILLION_CONTEXT_PLUGIN=0` 彻底关闭插件模式（恢复 wire 层注入）。

**到底什么时候需要 `plugin install`？** 用启动器的基本都不需要（见[启动器参考](#启动器参考) —— pi/omp 自动 `-e`、opencode 自动注入、claude/codex 自动注入 MCP、dsh 经 `--patch` 自动获得原生 `/acp` 命令、hermes 只能 wire）。它适用于手动配置客户端（`/bili/` 前缀或 MITM）又想要原生面板的场景：pi/omp/opencode 装后获得原生工具 + `/acp`；claude/codex 获得原生 MCP 工具（无 `/acp`）；dsh 的 `/acp` 由启动器 `--patch` 注入（手动配置的 dsh 可自行添加同一 patch）；hermes 装不了（只能 wire）。不装任何插件一切照常工作 —— 压缩走 wire 注入的工具，让模型调 `acp_status` 即可查看实时用量。

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
