[English](./README.md) | [中文](./README.zh-CN.md)

# billion-context

AI 编程助手的通用上下文压缩代理。

`billion-context` 架在**任意**编程助手与其模型 API 之间,用 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 压缩重写 Anthropic/OpenAI 流。任何能设置 base URL 的助手开箱即用 —— **无需为每个助手写适配代码**。

## 为什么

长编程会话会把上下文撑爆。各家 provider 按 token 计费,一旦超过上下文窗口,会话质量下降甚至崩掉。`billion-context` 把已消耗的对话压缩成分层摘要,让你**一个会话连跑数天** —— 海量 token 穿过同一个上下文窗口。

与宿主自带的摘要器不同,这里的压缩**增量、可逆、对前缀缓存友好**:摘要在小范围内写入,可按需解压,缓存前缀保持完整。

## 工作原理

```
编程助手 (Claude Code / Codex / Cursor / Aider ...)
        │  你把助手的 base URL 指向 proxy
        ▼
┌─────────────────┐
│  billion-context│   1. 解析请求(Anthropic 或 OpenAI 格式)
│     proxy       │   2. 对对话运行 acp-kernel 压缩
│                 │   3. 注入 `compress` 工具 + 压缩哲学
│                 │   4. 转发到真实模型 API
│                 │   5. 重写流式响应
└─────────────────┘
        │
        ▼
   真实模型 API (Anthropic / OpenAI / 兼容厂商)
```

代理向对话注入四个上下文管理工具(`compress`、`decompress`、`search_context`、`acp_status`)。模型在对话增长时调用 `compress`,代理在服务端执行 —— 压缩后的范围在下一轮之前折叠进对话历史。

## 安装

```bash
npm install -g billion-context
```

这会安装 `bili` 命令(`bili-proxy` 保留为别名)。

## 快速上手

三步:**启动代理 → 编辑配置文件 → 把客户端指向它**。
压缩是自动注入的 —— 你只需配置路由,无需配置压缩本身。

### 第 1 步 —— 启动代理

```bash
bili
```

它监听 `http://127.0.0.1:8787`。保持这个终端开着(或后台运行,见[运行代理](#运行代理))。

首次运行 `bili` 会**自动创建一份配置模板**,并告诉你路径,这样你不用凭空搛 schema:

```
[acp-config] created config template at ~/.config/billion-context/billion-context.json — edit it with your providers, then restart
```

### 第 2 步 —— 编辑配置文件

打开第 1 步创建的文件(`~/.config/billion-context/billion-context.json`),
编辑 `providers` 块,填入你付费使用的 provider。每个条目是一个
**名字 → URL** 映射;这个名字就是你在第 3 步里写进客户端 base URL 的东西。

```json
{
  "providers": {
    "anthropic": "https://api.anthropic.com",
    "zhipu": {
      "url": "https://open.bigmodel.cn",
      "models": {
        "glm-5.2": { "context": 1000000, "output": 131072 }
      }
    }
  }
}
```

- 删掉你不用的 provider。
- 添加其他的(例如 `"deepseek": "https://api.deepseek.com"`)。
- API key **不**写在这里 —— key 在客户端那边,代理原样透传。

保存后**重启 `bili`**。启动行列出你的路由:

```
acp-proxy listening on http://127.0.0.1:8787 — routes: anthropic=https://api.anthropic.com, zhipu=https://open.bigmodel.cn
```

这证明代理读到了你的配置。(完整 schema —— 按模型的 context 窗口、可选字段 —— 见[配置](#配置)。)

### 第 3 步 —— 把客户端指向代理

编辑客户端自己的配置文件,让它把请求发到
`http://localhost:8787/<provider>/...`(第 2 步声明的 provider 名作为路径
第一段)。把你的**真实** API key 也填进客户端配置 —— 代理原样透传。

#### Pi(billion-context-pi)

`~/.pi/agent/models.json` —— 声明一个指向你 proxy 路由的 provider,然后在
`settings.json` 里设为默认:

```jsonc
// ~/.pi/agent/models.json
{
  "providers": {
    "bili": {
      "baseUrl": "http://localhost:8787/zhipu/api/coding/paas/v4",
      "api": "openai-completions",                       // 或 "anthropic-messages"
      "apiKey": "<your key>",
      "models": [{ "id": "glm-5.2", "contextWindow": 1000000, "maxTokens": 131072 }]
    }
  }
}
```
```jsonc
// ~/.pi/agent/settings.json
{ "defaultProvider": "bili", "defaultModel": "glm-5.2" }
```

> 如果你装了 `billion-context-pi` 扩展,用隔离的 agent 目录跑 Pi
> (`PI_CODING_AGENT_DIR=…`),免得客户端扩展和 proxy 双重压缩。
> `bili-test-pi` 脚本帮你做好了这层隔离。

#### OpenCode

`~/.config/opencode/opencode.json` —— 在 `provider` 下加一个,然后在 `model`
里引用:

```jsonc
{
  "provider": {
    "bili": {
      "options": {
        "apiKey": "<your key>",
        "baseURL": "http://localhost:8787/zhipu/api/coding/paas/v4"
      },
      "models": {
        "glm-5.2": { "limit": { "context": 1000000, "output": 131072 } }
      }
    }
  },
  "model": "bili/glm-5.2"
}
```

如果要走 Anthropic provider,把 `baseURL` 设为
`http://localhost:8787/anthropic`。

#### Codex

`~/.codex/config.toml` —— 声明一个指向你 proxy 路由的 `model_provider`,
然后选中它:

```toml
model_provider = "bili"
model = "glm-5.2"

[model_providers.bili]
name = "bili"
base_url = "http://localhost:8787/zhipu/api/coding/paas/v4"
wire_api = "responses"
env_key = "OPENAI_API_KEY"   # Codex 从这个环境变量读 key
```

> Codex 的 Responses API 需要上游说 Responses 协议。多数区域性 OpenAI
> 兼容端点只说 `/chat/completions`;如果你的端点在 `/responses` 上 404,
> 用一个说 Responses 的中转,或用官方 OpenAI API。

#### 其他客户端(Cursor / Aider / Continue …)

暂不支持。代理目前说 Anthropic、OpenAI chat-completions、OpenAI Responses
三种协议 —— 如果你的客户端用别的协议或非标准 auth header,还用不了。

### 验证

代理跑着、配置保存了之后,确认它能应答,并且第一个真实请求在日志里显示压缩活动:

```bash
# 健康检查(代理是否在跑 + 转发到哪)
curl -s http://localhost:8787/__acp/health
# → {"ok":true,"upstream":"https://api.anthropic.com"}

# 实时会话统计(发过真实请求后)
curl -s http://localhost:8787/__acp/stats
```

然后从助手发一条消息,观察日志(`~/.local/state/billion-context/bili.log`,
同时也打到 stderr)。每个请求应该看到一行 `processTurn`,等对话变长后
会出现 `[acp-usage] round N input=X cached=Y (cache hit Z%)` + `compress` 事件。

## 运行代理

### 命令行参数

```bash
bili --port 9000              # 改监听端口
bili --host 0.0.0.0           # 监听所有网卡(见下面的 host 说明)
bili --debug                 # 详细日志(也可在配置里设 "debug": true)
bili --passthrough           # 不压缩直接转发(冒烟测试模式)
bili --config ~/my-bili.json # 用别的配置文件
bili update                  # 立即检查并安装新版本(跳过节流)
bili --no-auto-update        # 本次启动禁用自动更新
```

参数优先级高于环境变量和配置文件。`bili --help` 列出全部。

### 调试

三种方式打开详细日志(优先级:参数 > 环境变量 > 配置):

1. **命令行参数**(最快):`bili --debug`
2. **环境变量**:`ACP_DEBUG=1 bili`
3. **配置文件**:在 `billion-context.json` 里设 `"debug": true`

详细模式会打印每次 `processTurn`(标签计数、token 用量)、nudge 决策(growth/usage/pendingT1/shouldInject)、客户端 headers 和 SSE 重写。

### 日志文件

所有日志**默认同时写入文件**:`~/.local/state/billion-context/bili.log`
(XDG state 目录)。同时仍打印到 stderr,所以前台运行 `bili start` 时终端也能看到。

```bash
# 配置: "logFile": "/custom/path.log"
# 环境变量: ACP_LOG_FILE=/custom/path.log   (或 ACP_LOG_FILE=off 关闭文件,只保留 stderr)
```

文件超过 10 MB 自动轮转(重命名为 `bili.log.old`)。每个请求的缓存命中统计会以 `[acp-usage] round N input=X cached=Y (cache hit Z%)` 打印,可直接从日志衡量前缀缓存健康度。

### 自动更新

代理启动时和每 3 分钟检查 npm 是否有新版本。发现新版本就全局安装(`npm install -g`)并打印通知 —— **重启 `bili` 才能生效**。

永久禁用:配置(`"autoUpdate": false`)或环境变量(`ACP_AUTO_UPDATE=0`)。

## 配置

代理通过**环境变量**(大多数场景的推荐方式)**或** JSON 配置文件配置。两者都完全支持,任选其一。优先级(高优先级覆盖低优先级):**命令行参数 > 环境变量 > 配置文件 > 内置默认**。

- **环境变量** —— 最快,适合单 provider,易于脚本化(`.env`、systemd unit、docker `--env`)。`export ACP_…` 然后运行 `bili` 即可。
- **JSON 文件** —— 当你有多个 provider 且需要按模型声明 context 窗口时更合适(这是唯一能声明它们的地方)。少数键(尤其是 `providers.*.models` 的 context 窗口)没有对应的环境变量。

两者可共存:环境变量覆盖文件里的个别键。

### 环境变量(推荐)

每个配置键都有环境变量覆盖。设置后覆盖文件值(或不配文件直接跑)。

| 环境变量 | 默认值 | 说明 |
|-----|---------|-------------|
| `ACP_PORT` / `PORT` | `8787` | 监听端口 |
| `ACP_HOST` | `127.0.0.1` | 监听地址 |
| `ACP_UPSTREAM` | `https://api.anthropic.com` | 默认上游 |
| `ACP_PROVIDERS` | *(无)* | 旧版 providers JSON 文件路径(覆盖配置里的 `providers`) |
| `ACP_MODEL_CONTEXT_LIMIT` | `200000` | 全局兜底 context 窗口(仅当 provider/model 都不匹配时用) |
| `ACP_SESSION_HEADER` | `x-acp-session` | 会话标识 header 名 |
| `ACP_COMPRESS_TOOL` | `1` | 设 `0` 禁止注入 compress 工具 |
| `ACP_COMPRESS_NUDGE` | `1` | 设 `0` 禁止压缩 nudge |
| `ACP_DEBUG` | `0` | 设 `1` 打开详细日志 |
| `ACP_PASSTHROUGH` | `0` | 设 `1` 不压缩直接转发 |
| `ACP_AUTO_UPDATE` | `1` | 设 `0` 禁用后台自动更新 |
| `ACP_LOG_FILE` | *XDG state 路径* | 日志文件路径(`off` 关闭文件,只保留 stderr) |
| `ACP_DUMP_SSE` | *(无)* | 转储 SSE 用于调试的目录 |
| `BILI_PERSIST` | `1` | 设 `0` 禁用会话持久化(纯内存,重启丢失) |
| `BILI_PERSIST_DEBOUNCE_MS` | `500` | 写磁盘的防抖窗口(毫秒) |
| `BILI_MAX_SESSIONS` | `256` | 内存中保留的最大会话数(LRU 淘汰;磁盘是真相源) |
| `BILI_SESSIONS_DIR` | *(XDG data 目录)* | 持久化会话状态的目录 |

### 配置文件(可选)

位置(XDG 基础目录):

- **Linux:** `~/.config/billion-context/billion-context.json`
- 用 `XDG_CONFIG_HOME` 或 `BILI_CONFIG_FILE` 覆盖

配置文件是单个 JSON 对象。示例:

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "providers": {
    "zhipu": {
      "url": "https://open.bigmodel.cn",
      "models": {
        "glm-5.2": { "context": 1000000, "output": 131072 },
        "glm-5.1": { "context": 200000, "output": 131072 }
      }
    },
    "anthropic": "https://api.anthropic.com",
    "deepseek": "https://api.deepseek.com"
  }
}
```

### 顶层键

| 键 | 默认值 | 说明 |
|------|---------|-------------|
| `port` | `8787` | 代理监听端口 |
| `host` | `127.0.0.1` | 代理监听地址 |
| `upstream` | `https://api.anthropic.com` | 无路由匹配时的默认上游 |
| `sessionHeader` | `x-acp-session` | 客户端可发来标识会话的 header 名 |
| `log` | `true` | 启用请求日志 |
| `debug` | `false` | 详细日志(等同 `ACP_DEBUG=1`) |
| `passthrough` | `false` | 不压缩直接转发(等同 `ACP_PASSTHROUGH=1`) |
| `providers` | *(无)* | Provider 路由 —— 见下文 |
| `compress` | *(见默认值)* | `{ injectTool, injectNudge }` |

> **选择 `host`**(IPv6 / 容器):默认 `127.0.0.1` 只听 IPv4 且仅
> loopback。用 `--host ::`(或 `"host": "::"`)可同时听 IPv4 和 IPv6
> ——当你的客户端把 `localhost` 先解析成 `::1` 时(有些 `/etc/hosts`
> 把 `::1` 排在 `127.0.0.1` 前)这就很关键。在**容器**内,`127.0.0.1`
> 绑的是容器自己的 loopback,通过映射端口访问不到——这时用
> `--host 0.0.0.0`。⚠️ `0.0.0.0` / `::` 会把代理暴露到**所有**网卡;
> 确保你在可信网络或防火墙后面。

### Providers(URL 路由 + 按模型 context)

`providers` 把路由名映射到一个纯 URL 字符串(简单)或一个带 `url` + 可选按模型 context 窗口的对象(推荐)。

**简单形式** —— provider 名 → URL:
```json
{ "deepseek": "https://api.deepseek.com" }
```

**完整形式** —— provider 名 → `{ url, models }`:
```json
{
  "zhipu": {
    "url": "https://open.bigmodel.cn",
    "models": {
      "glm-5.2": { "context": 1000000, "output": 131072 },
      "glm-5.1": { "context": 200000 }
    }
  }
}
```

同一个模型在不同 provider 后面可以有不同 context 窗口(例如 relay 把模型包成更大窗口)。`context` 是**输入 context 上限**(压缩器用它判断何时 nudge);`output` 是最大输出 token。两者都可选;缺失值回退到内置模型表,再回退到 `modelContextLimit`。

> **为什么要声明 context?** LLM 的 `/models` API **不返回** context 窗口(已跨 OpenAI、Anthropic、智谱、comfly 验证)。它们是文档级信息。值错了(例如把 GLM-5.2 猜成 128K 而非 1M)会导致频繁误触发压缩。按 provider + 模型声明能让代理匹配客户端自己用的注册表。

**API key 永远不存进代理** —— 助手发什么 key,原样透传给上游。

### 路由

用 provider 名作为路径段把任意助手指向代理。代理剥离该名字并转发到该 provider 的根 URL。完整的助手配置示例见[快速上手,第 2 步](#第-2-步--把助手指向代理);请求 URL 如何重写的机制:

```
助手 baseURL:   http://localhost:8787/zhipu/api/coding/paas/v4
                 └──────────┬──────────┘└────────┬────────┘
                     代理 host            剩余路径
                     + provider 名        (原样转发)
```

**未配置任何 providers**(比如你清空了 `providers` 块)时,provider 名这步被跳过
—— 每个请求按完整原始路径转发到默认 `upstream`。这是个边缘场景;
正常流程是声明 providers 并按名字路由,见快速上手。

### Provider 名注意事项

- 必须以字母开头,只含字母/数字/`-`/`_`。
- 保留字(`v1`、`chat`、`completions`、`messages`、`models`、`api`)被拒绝,以免与真实 API 路径段冲突。
- provider 名可出现在路径任意位置;最长匹配优先。

## 会话机制

代理需要一个稳定的、按会话标识的 ID,以便在多个用户/账号并发时隔离压缩状态。它从四个维度推导一个(见 `src/session-id.ts`):**协议 × 上游 origin × API key × 会话**。前三个防止跨账号 / 跨 provider 串数据;会话维度来自客户端发送的内容。

不同客户端发送的东西不同:

| 客户端 | 发会话 id 吗? | 来源 | 安全性 |
|---|---|---|---|
| **Codex**(0.147+) | ✅ 发 | `body.session_id`(按会话 UUID) | ✅ 安全 |
| **OpenCode** | ✅ 发 | `x-session-affinity` header(`ses_…`) | ✅ 安全 |
| **pi** | ❌ **不发** | 无 | ⚠️ **有碰撞风险** |

客户端发显式 id 时,代理直接用它。不发时(pi),代理回退到对首条用户消息做哈希 —— 于是两个开头相同的会话会塌缩到同一个 session。这**不会损坏数据**(每条消息的 ref 用独立的内容指纹,保持稳定),但会让 nudge/压缩时机跑偏,偶尔过早回收某个 block。它是自愈的:最坏情况是压缩效率降低,绝不丢数据。

用于上游粘性路由时,客户端不发会话 header 时代理会合成一个(`x-session-id: ses_<hash>`),让缓存池 / 负载均衡器仍能拿到稳定 key。

**建议:** Codex 和 OpenCode 可以安全地通过代理并发跑很多会话。pi 单个 agent 没问题,但因碰撞风险**不建议**并发多会话 —— 直到 pi 自己长出 session-id 信号。pi 多 agent 场景下,每个会话发一个显式 `x-acp-session` header 来避免碰撞。

## 状态

早期。协议处理和压缩已通过 mock 测试(141 项通过)。真实模型集成测试是下一里程碑。预期会有粗糙的地方。

pi 扩展模式(进程内、更紧密集成、参考实现)见 [billion-context-pi](https://github.com/ranxianglei/billion-context-pi)。

## 许可证

MIT
