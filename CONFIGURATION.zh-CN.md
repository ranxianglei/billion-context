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
- **说明：** 代理绑定的网络接口。`127.0.0.1`（默认）仅监听本机 —— 适合本地 sidecar。使用 `::` 可同时监听 IPv4 + IPv6 双栈。在容器中使用 `0.0.0.0` 可将代理暴露到所有接口（请确保所在网络是可信的）。可由 `ACP_HOST` / `--host` 覆盖。

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

#### `minCompressRange`

- **类型：** `number`
- **默认值：** *（内核默认值，通常为 `5000`）*
- **状态：** ACTIVE
- **说明：** 一个消息范围可被纳入压缩的最小 token 数；更小的范围会被跳过。映射到内核字段 `compress.minCompressRange`。

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
| `BILI_CONFIG_FILE` | 覆盖配置文件路径（指向任意 JSON 文件）。 |
| `ACP_PORT` / `PORT` | 覆盖监听端口。 |
| `ACP_HOST` | 覆盖监听主机。 |
| `ACP_UPSTREAM` | 覆盖默认上游 base URL。 |
| `ACP_LOG` | 设为 `0` 关闭请求日志。 |
| `ACP_AUTO_UPDATE` | 设为 `0` 禁用自动更新检查。 |
| `ACP_PROVIDERS` | 指向外部 `providers.json` 的路径（旧版 / 共享文件）。 |
