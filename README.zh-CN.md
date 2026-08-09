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

两种方式 —— 任选其一:

- **零配置(最简单):** 在客户端 baseURL 前面加上代理地址 + `/bili/`。无需配置文件 —— context 窗口自动从 [models.dev](https://models.dev) registry 查询。`/bili/` 前缀还是个自检测信号:billion-context 的客户端扩展(billion-context-pi / opencode-acp)能在自己的 baseUrl 里认出它并自禁用,避免双层压缩。
- **显式 context 窗口覆盖:** 在配置文件(或网页)里按 URL 声明 context 窗口,用于 registry 不认识的端点,或想钉死一个精确值的场景。两种方式路由都是同一个 `/bili/` 前缀 —— 配置只改变代理用哪个 context 窗口。

压缩是自动注入的 —— 你只需配置路由,无需配置压缩本身。

### 方式 A —— 零配置(`/bili/` 前缀)

启动代理:

```bash
bili
```

然后把客户端现有的 baseURL 前面加上 `http://localhost:8787/bili/` 就行。完整上游 URL 嵌在路径里,proxy 无需任何配置就知道转发到哪:

```
客户端 baseURL 之前:  https://api.openai.com/v1
客户端 baseURL 之后:  http://localhost:8787/bili/https://api.openai.com/v1
```

就这样 —— 真实 API key 照常填在客户端配置里(proxy 原样透传)。context 窗口(gpt-5.1-codex=400K、glm-5.2=1M、claude-opus-4=200K ……)自动从 models.dev 查询。

#### A. API-key 客户端(`/bili/` 前缀)

用 **API key** 配置(不是登录账号)的客户端允许你改上游 URL。只需在前面加 `http://localhost:8787/bili/`,其他都不用改。

**OpenCode** —— 编辑 `~/.config/opencode/opencode.json`,改 provider 的 `baseURL`:
```jsonc
// 之前:
"baseURL": "https://open.bigmodel.cn/api/coding/paas/v4"
// 之后(前面加上代理地址 + /bili/):
"baseURL": "http://localhost:8787/bili/https://open.bigmodel.cn/api/coding/paas/v4"
```

**Codex(API key 模式)** —— 编辑 `~/.codex/config.toml`,改 provider 的 `base_url`:
```toml
# 之前:
base_url = "https://api.openai.com/v1"
# 之后:
base_url = "http://localhost:8787/bili/https://api.openai.com/v1"
```

**Pi** —— 编辑 `~/.pi/agent/models.json`,改 provider 的 `baseUrl`:
```jsonc
// 之前:
"baseUrl": "https://api.anthropic.com"
// 之后:
"baseUrl": "http://localhost:8787/bili/https://api.anthropic.com"
```

**其他 API-key 客户端(Cursor / Aider / Continue ……)** —— 只要配置了上游 URL,前面加 `http://localhost:8787/bili/` 就行,其他都不用改。

#### B. 登录/订阅客户端(MITM 透明代理)

需要 **登录账号**的客户端(ChatGPT Plus/Pro、Claude、ZCode coding plan
……)通过 **OAuth 认证,且硬编码了端点**——你改不了 baseURL,所以 `/bili/`
前缀方式对它们无效。这类客户端要用 **MITM 透明代理模式**。

支持的登录客户端:

| 客户端 | 登录方式 | 硬编码端点 | 状态 |
|---|---|---|---|
| **ZCode** | 智谱 coding plan(OAuth) | `open.bigmodel.cn`(内置 provider) | ✅ 已测试 |
| **Codex** | ChatGPT 账号(OAuth) | `chatgpt.com/backend-api` | ❓ 未测试(可能不支持,需验证) |
| **Claude Code** | Claude 订阅(OAuth) | `api.anthropic.com` | ❓ 未测试(可能不支持,需验证) |

MITM 模式原理:这类客户端只提供 **HTTP 代理**设置,所以它发送
`CONNECT <域名>:443`;billion-context 在本地用自生成的根 CA 终止 TLS,在明文里注入压缩,再重新加密转发。OAuth token 随客户端的
`Authorization` 头原样转发(我们不动它)——订阅折扣保留。

MITM 默认开启,且只对一份 **白名单**中的模型域名(`open.bigmodel.cn`、
`api.anthropic.com`、`api.openai.com`、`chatgpt.com`)生效。所有其他 HTTPS
域名都是盲隧道(billion-context 从不解密非模型流量)。

**一次性设置(在客户端里信任根 CA):**

1. 启动一次 proxy 以生成根 CA:
   ```bash
   bili start
   ls ~/.local/share/billion-context/ca/root-ca.pem   # 现在存在了
   ```

2. 在客户端的 **设置 → 网络/代理** 里填:
   - **HTTP 代理**:`http://127.0.0.1:8787`
   - **代理 CA 证书路径**:`~/.local/share/billion-context/ca/root-ca.pem`
   - (可选)**不走代理列表**:`localhost,127.0.0.1`
   - (ZCode 具体位置:**设置 → 网络**。Codex/Claude Code:设 `HTTPS_PROXY`
     环境变量 + `NODE_EXTRA_CA_CERTS` 指向 CA 路径。)

3. 重启客户端。它的模型流量现在会经过 billion-context 并注入压缩。发一条消息,看 proxy 日志(`~/.local/state/billion-context/bili.log`)应出现
   `mitm <域名>:443 tunnel established`。

> 根 CA 是本地生成的、只存在本机,**不是**系统级安装。只有你配置的那个
> 客户端(通过 CA 路径设置,它会把该路径作为 `NODE_EXTRA_CA_CERTS` 喂给
> Node)信任它,其他应用不受影响。删除 CA 文件并重启 proxy 会重新生成。

**给登录客户端单独配代理(防火墙/GFW)。** 登录客户端(ZCode)和 API-key 客户端可能连同一个域名(`open.bigmodel.cn`)。要给登录客户端配**专属上游代理**而不影响 API-key 客户端,用 `mitm://` scheme 键 —— 见[上游代理(MITM 与 `/bili/`)](#上游代理防火墙gfw)。

### 方式 B 手动配置文件&设置上下文大小

打开 `~/.config/billion-context/billion-context.json`,编辑 `providers` 块。
**key 就是上游 URL** —— 客户端写在 `/bili/` 后面的那个字符串。value 为该
URL 声明按模型的 context 窗口:

```json
{
  "providers": {
    "https://open.bigmodel.cn/api/coding/paas/v4": {
      "models": { "glm-5.2": { "context": 1000000 } }
    },
    "https://api.anthropic.com": {}
  }
}
```

- 一个 key 在客户端嵌入的 URL 等于它或以它开头时匹配(最长 key 优先)。纯 host key 覆盖该 host 上的所有路径。
- 空 value `{}` 表示"这个 URL 存在,无覆盖"(context 窗口来自 models.dev / 前缀表)。
- 删掉你不用的条目;添加其他的(按需)。
- API key **不**写在这里 —— key 在客户端那边,代理原样透传。


### 方式C 网页配置&设置上下文大小

打开 [http://localhost:8787/__bili/](http://localhost:8787/__bili/) 进行配置。

### 验证

代理跑着、配置保存了之后,确认它能应答,并且第一个真实请求在日志里显示压缩活动:

```bash
# 健康检查(代理是否在跑 + 转发到哪)
curl -s http://localhost:8787/__bili/health
# → {"ok":true,"upstream":"https://api.anthropic.com"}

# 实时会话统计(发过真实请求后)
curl -s http://localhost:8787/__bili/stats
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
    "https://open.bigmodel.cn/api/coding/paas/v4": {
      "models": {
        "glm-5.2": { "context": 1000000 },
        "glm-5.1": { "context": 200000 }
      }
    },
    "https://api.deepseek.com": {}
  }
}
```

### 顶层键

| 键 | 默认值 | 说明 |
|------|---------|-------------|
| `port` | `8787` | 代理监听端口 |
| `host` | `127.0.0.1` | 代理监听地址 |
| `sessionHeader` | `x-acp-session` | 客户端可发来标识会话的 header 名 |
| `log` | `true` | 启用请求日志 |
| `debug` | `false` | 详细日志(等同 `ACP_DEBUG=1`) |
| `passthrough` | `false` | 不压缩直接转发(等同 `ACP_PASSTHROUGH=1`) |
| `providers` | *(无)* | 按 URL 的 context 覆盖 —— 见下文 |
| `compress` | *(见默认值)* | `{ injectTool, injectNudge }` |
| `proxy` | *(无)* | 代理自身访问模型提供商时走的上游 HTTP 代理(`http://host:port`)。按 URL 的 `proxy` 会覆盖它。见[上游代理](#上游代理防火墙gfw)。 |

> **选择 `host`**(IPv6 / 容器):默认 `127.0.0.1` 只听 IPv4 且仅
> loopback。用 `--host ::`(或 `"host": "::"`)可同时听 IPv4 和 IPv6
> ——当你的客户端把 `localhost` 先解析成 `::1` 时(有些 `/etc/hosts`
> 把 `::1` 排在 `127.0.0.1` 前)这就很关键。在**容器**内,`127.0.0.1`
> 绑的是容器自己的 loopback,通过映射端口访问不到——这时用
> `--host 0.0.0.0`。⚠️ `0.0.0.0` / `::` 会把代理暴露到**所有**网卡;
> 确保你在可信网络或防火墙后面。

### Providers(按 URL 的 context 覆盖)

路由始终是 `/bili/` 前缀(见[方式 A](#方式-a-零配置bili-前缀))。
`providers` 块只声明**按 URL 的 context 窗口覆盖**,以上游 URL 为 key。
key 就是客户端写在 `/bili/` 后面的那个字符串:

```json
{
  "providers": {
    "https://open.bigmodel.cn/api/coding/paas/v4": {
      "models": {
        "glm-5.2": { "context": 1000000 },
        "glm-5.1": { "context": 200000 }
      }
    },
    "https://api.deepseek.com": {}
  }
}
```

同一个模型在不同上游后面可以有不同 context 窗口(例如 relay 把模型包成更大窗口)。`context` 是**输入 context 上限**(压缩器用它判断何时 nudge)。可选;缺失值回退到 [models.dev](https://models.dev) registry,再回退到内置前缀表。

> **为什么要声明 context?** LLM 的 `/models` API **不返回** context 窗口(已跨 OpenAI、Anthropic、智谱、comfly 验证)。它们是文档级信息。值错了(例如把 GLM-5.2 猜成 128K 而非 1M)会导致频繁误触发压缩。按 URL + 模型声明能让代理匹配客户端自己用的注册表。

### URL key 匹配规则

- 一个请求在客户端嵌入的 URL **等于 key 或以 key 开头**时匹配(最长 key 优先)。
- 浅 key 如 `https://open.bigmodel.cn` 覆盖该 host 上的每条路径;深 key 如 `https://open.bigmodel.cn/api/anthropic` 只覆盖那一个端点。
- key 永不跨 host(边界检查要求 key 后面是 `/` 或字符串结尾),所以 `https://x.com` 不会匹配 `https://x.com.evil`。
- 未被任何匹配 key 覆盖的模型回退到 models.dev,再回退到前缀表,最后回退到 `modelContextLimit`。

**API key 永远不存进代理** —— 助手发什么 key,原样透传给上游。

### 上游代理(防火墙 / GFW)

如果代理自身访问模型提供商的连接被墙(比如 GFW 内访问 `api.openai.com`),配置一个**上游代理**(本地 v2rayA / clash 的 HTTP 端口),让代理能连到提供商:

```jsonc
{
  // 全局默认:所有提供商的出站都走这个代理
  "proxy": "http://127.0.0.1:20172",
  "providers": {
    "https://api.openai.com/v1": {
      // 按 URL 覆盖全局(给这个域名用另一个代理)
      "proxy": "http://127.0.0.1:20173",
      "models": { "gpt-5": { "context": 400000 } }
    },
    "https://open.bigmodel.cn/api/anthropic": {
      // 空字符串 = 明确直连,覆盖全局代理
      "proxy": "",
      "models": { "glm-5.2": { "context": 1000000 } }
    }
  }
}
```

规则:
- **全局 `proxy`**(顶层)对所有提供商的出站生效。
- **按 URL 的 `proxy`** 覆盖该域名的全局设置。
- 空字符串 `""` 表示**明确直连**(覆盖并禁用)。
- 都不配 = 直连。
- 只支持 HTTP 代理(`http://host:port`)。SOCKS5 暂不支持。
- 两条出站路径都覆盖:`/bili/` 路径模式(fetch)和 MITM CONNECT 隧道(代理连接真实上游的链路走 HTTP CONNECT 代理)。

环境变量覆盖:`BILI_UPSTREAM_PROXY=http://127.0.0.1:20172`(等同全局 `proxy`;两者都设时配置文件优先)。

**MITM 与 `/bili/` —— 用 scheme 区分。** 登录客户端(ZCode 走 MITM)和 API-key 客户端可能连同一个域名(`open.bigmodel.cn`)。为了让它们的配置能区分,MITM 流量在查找键里用 `mitm://` scheme,`/bili/` 流量用真实的 `https://`:

| 客户端 | 查找键示例 |
|---|---|
| ZCode(MITM,登录态)| `mitm://open.bigmodel.cn` |
| API-key 客户端(`/bili/`)| `https://open.bigmodel.cn/api/anthropic` |

所以你可以给 ZCode 单独配代理,不影响 API-key 客户端:
```jsonc
{
  "providers": {
    "mitm://open.bigmodel.cn":            { "proxy": "http://127.0.0.1:20173" },
    "https://open.bigmodel.cn/api/anthropic": { "proxy": "http://127.0.0.1:20172" }
  }
}
```

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

早期。协议处理和压缩已通过 mock 测试(146 项通过)。真实模型集成测试是下一里程碑。预期会有粗糙的地方。

pi 扩展模式(进程内、更紧密集成、参考实现)见 [billion-context-pi](https://github.com/ranxianglei/billion-context-pi)。

## 许可证

MIT
