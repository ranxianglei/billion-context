# billion-context

<p align="center"><a href="./README.md">English</a> | <a href="./README.zh-CN.md">中文</a></p>

<p align="center"><strong>上下文压缩插件</strong> — <em>billion-context is all you need。</em></p>

<p align="center"><sub>小窗口（100k 上下文足矣）· <em>省 5 倍 token</em> · 超长会话（十亿级别单会话）· 高压缩质量</sub></p>

<p align="center">
<a href="https://www.npmjs.com/package/billion-context"><img src="https://img.shields.io/npm/v/billion-context.svg?style=flat-square" alt="npm"></a>
<a href="https://github.com/ranxianglei/billion-context/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/billion-context.svg?style=flat-square" alt="license"></a>
<a href="https://github.com/ranxianglei/billion-context"><img src="https://img.shields.io/badge/GitHub-ranxianglei%2Fbillion--context-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

<p align="center">
<code>npm install -g billion-context</code>
</p>

<p align="center">
<a href="https://claude.com/product/claude-code" title="Claude Code"><img src="https://cdn.simpleicons.org/claude/D97757" height="26" alt="Claude Code"></a>&nbsp;
<a href="https://github.com/openai/codex" title="Codex"><picture><source media="(prefers-color-scheme: dark)" srcset="https://api.iconify.design/simple-icons/openai.svg?color=white"><img src="https://api.iconify.design/simple-icons/openai.svg" height="26" alt="Codex"></picture></a>&nbsp;
<a href="https://opencode.ai" title="OpenCode"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/opencode/FFFFFF"><img src="https://cdn.simpleicons.org/opencode/000000" height="26" alt="OpenCode"></picture></a>&nbsp;
<a href="https://pi.dev" title="pi"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/pi/FFFFFF"><img src="https://cdn.simpleicons.org/pi/000000" height="26" alt="pi"></picture></a>&nbsp;
<a href="https://github.com/google-gemini/gemini-cli" title="Gemini CLI"><img src="https://cdn.simpleicons.org/googlegemini/8E75B2" height="26" alt="Gemini CLI"></a>&nbsp;
<a href="https://www.kimi.com" title="Kimi"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/kimi/FFFFFF"><img src="https://cdn.simpleicons.org/kimi/000000" height="26" alt="Kimi"></picture></a>&nbsp;
<a href="https://github.com/QwenLM/qwen-code" title="Qwen Code"><img src="https://cdn.simpleicons.org/qwen/6950EF" height="26" alt="Qwen Code"></a>&nbsp;
<a href="https://github.com/github/copilot-cli" title="GitHub Copilot CLI"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/githubcopilot/FFFFFF"><img src="https://cdn.simpleicons.org/githubcopilot/000000" height="26" alt="GitHub Copilot CLI"></picture></a>&nbsp;
<a href="https://www.trae.ai" title="TRAE"><img src="https://cdn.simpleicons.org/trae/32F08C" height="26" alt="TRAE"></a>&nbsp;
<a href="https://www.codebuddy.cn" title="CodeBuddy"><img src="https://cdn.simpleicons.org/codebuddy/6C4DFF" height="26" alt="CodeBuddy"></a>&nbsp;
<a href="https://qoder.com" title="Qoder"><img src="https://icons.duckduckgo.com/ip3/qoder.com.ico" height="26" alt="Qoder"></a>&nbsp;
<a href="https://iflow.cn" title="iFlow CLI"><img src="https://img.alicdn.com/imgextra/i4/O1CN01yBfg3x1iNi4YggwIt_!!6000000004401-2-tps-72-72.png" height="26" alt="iFlow CLI"></a>&nbsp;
<a href="https://www.minimax.io" title="MiniMax Code (mcode)"><img src="https://cdn.simpleicons.org/minimax/E73562" height="26" alt="MiniMax Code"></a>&nbsp;
<a href="https://www.deepseek.com" title="deepseek-harness (dsh)"><img src="https://cdn.simpleicons.org/deepseek/5786FE" height="26" alt="deepseek-harness"></a>&nbsp;
<a href="https://ampcode.com" title="Amp"><img src="https://icons.duckduckgo.com/ip3/ampcode.com.ico" height="26" alt="Amp"></a>&nbsp;
<a href="https://aider.chat" title="aider"><img src="https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/assets/icons/favicon-32x32.png" height="26" alt="aider"></a>&nbsp;
<a href="https://github.com/aaif-goose/goose" title="goose"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/aaif-goose/goose/main/documentation/static/img/logo_dark.png"><img src="https://raw.githubusercontent.com/aaif-goose/goose/main/documentation/static/img/logo_light.png" height="26" alt="goose"></picture></a>&nbsp;
<a href="https://github.com/NousResearch/hermes-agent" title="hermes"><img src="https://raw.githubusercontent.com/NousResearch/hermes-agent/main/apps/bootstrap-installer/src-tauri/icons/128x128.png" height="26" alt="hermes"></a>&nbsp;
<a href="https://z.ai" title="zcode (Z.ai)"><img src="https://z-cdn.chatglm.cn/z-ai/static/logo.svg" height="26" alt="zcode"></a>&nbsp;
<a href="https://omp.sh" title="omp (oh-my-pi, Stencil Labs)"><img src="https://omp.sh/favicon.svg" height="26" alt="omp"></a>&nbsp;
<a href="https://github.com/1jehuang/jcode" title="jcode"><img src="https://github.com/1jehuang.png" height="26" alt="jcode"></a>
</p>

---

> **缓存健康速览：**健康会话的前缀缓存命中率在 **95–97%** 左右——压缩本身代价 ≤2%。持续低于这个数，用 `/acp` 或 `/acp-cache` 查归因（见[常见问题](#常见问题)）；常见原因依次：上游缓存 TTL 到期 · 切换模型 · bili 的 bug（欢迎提报）· 其他/未知。

## 社区

QQ群:
1056132097(已满)
1108730198(未满)

---

## 📄 论文 / 预印本

- **[模型驱动的分层增量压缩:面向长寿命编码 Agent 的免训练多代上下文管理](./paper/模型驱动的分层增量压缩-免训练多代上下文管理.md)**(中文版,v0.2)

> 📝 **论文本身与代码一同以 MIT 许可开源(位于 `paper/` 目录),是代码库的一部分 —— 这是一份活文档,任何人都可以编辑,欢迎提 PR 改进。**

生产规模纵向研究:四个半月、三宿主、174,327 次模型调用、187.6 亿累计输入 token(三宿主合计约 247 亿),204,800-token 窗口零违规,马拉松会话 8,584–12,049 次调用。

---

`billion-context` 架在**任意**编程助手与其模型 API 之间,用 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 压缩重写 Anthropic/OpenAI 流。何时压缩、压缩什么 —— <strong>由模型决定</strong>,而非硬截断。

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

### 上下文管理工具

代理向对话注入四个上下文管理工具;模型在上下文增长时自行调用,代理在服务端执行 `compress`,折叠后的范围在历史中保持摘要形态、直到被恢复:

- **`compress`** —— 把一段消息范围折叠成详细摘要。
- **`decompress`** —— 需要精确细节时恢复某个已压缩范围。
- **`search_context`** —— 在压缩摘要与可见消息中做关键词检索。
- **`acp_status`** —— 上下文用量概览 + 哪些区间仍可压缩。

模型会自主使用以上工具自主管控上下文，无需人工干预。

## 该选哪个?

按客户端选:

| 客户端 | 用这个 |
|---|---|
| **pi** | [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)(进程内扩展) |
| **opencode**(1.x / 2.x) | [`billion-context`](https://github.com/ranxianglei/billion-context) —— `bili opencode`(启动器)或 `bili plugin install opencode`(原生);独立 [`opencode-acp`](https://github.com/ranxianglei/opencode-acp) 在 1.x 上仍可用 —— 完整指南:[OpenCode](CLIENTS.zh-CN.md#opencode) |
| **omp** | [`billion-context`](https://github.com/ranxianglei/billion-context)，`bili omp`（内置插件）或 `bili plugin install omp`（自拉起原生插件，免启动器） |
| **dsh** | [`billion-context`](https://github.com/ranxianglei/billion-context) —— `bili dsh`(启动器,经 `--patch` 注入完整原生插件)或 `bili plugin install dsh` ≡ `dsh plugin --profile <name> add billion-context`(统一泳道)—— 细节见 [CLIENTS.zh-CN.md](CLIENTS.zh-CN.md) |
| **kimi** | `bili plugin install kimi`(自拉起原生,需 Kimi Code ≥ 2.0.0)或 `bili kimi`(证书 MITM)或 `/bili/` 前缀 —— 细节见 [CLIENTS.zh-CN.md](CLIENTS.zh-CN.md) |
| **hermes** | `bili plugin install hermes`(自拉起原生,Python 插件 #958)或 `bili hermes`(证书 MITM) |
| **zcode**(Z.ai / bigmodel coding plan) | `bili plugin install zcode`(自拉起原生,#1145)或 GUI「设置 → 网络」证书 MITM 或 `/bili/` 前缀 —— 细节见 [CLIENTS.zh-CN.md](CLIENTS.zh-CN.md) |
| **claude** | `bili claude`(启动器)或 `bili plugin install claude`(原生姿态,#964 —— 受管 settings 块 + 会话自管代理;见下方"注意") |
| **codex** | `bili codex`(启动器 —— 全功能零配置姿势)或 `bili plugin install codex`(MCP shell 工具面配套:**先起 bili 再玩** —— shell 不拉代理,也路由不了 codex 本体流量)—— 细节见 [CLIENTS.zh-CN.md](CLIENTS.zh-CN.md#codexopenai-codex-cli) |
| **jcode** | [`billion-context`](https://github.com/ranxianglei/billion-context),`bili jcode`(cert-MITM)或 `/bili/` 前缀 —— 无原生模式(编译型 Rust 二进制、无插件接缝,[#962](https://github.com/ranxianglei/billion-context/issues/962)) |
| **gemini**(Gemini CLI) | `bili gemini`(启动器,`GOOGLE_GEMINI_BASE_URL` `/bili/` 改写)或 `/bili/` 前缀 —— 仅启动器(无环内工具注入接缝,#1043) |
| **iflow**（iFlow CLI） | `bili iflow`（启动器，`IFLOW_BASE_URL` `/bili/` 改写）或 `/bili/` 前缀 |
| **qwen**（Qwen Code） | `bili qwen`（启动器，cert-MITM）或 `/bili/` 前缀 |
| **mcode**(MiniMax Code) | [`billion-context`](https://github.com/ranxianglei/billion-context),`bili mcode`(cert-MITM)或 `/bili/` 前缀 —— 无原生模式(纯声明式事件钩子,无模型请求接缝,[#1050](https://github.com/ranxianglei/billion-context/issues/1050)) |
| **aider** | [`billion-context`](https://github.com/ranxianglei/billion-context),`bili aider`(cert-MITM)或 `/bili/` 前缀 —— 无原生模式(仅 shell 命令钩子,无工具注入接缝,[#1048](https://github.com/ranxianglei/billion-context/issues/1048)) |
| **copilot**(GitHub Copilot CLI) | `bili copilot`(启动器,cert-MITM)—— 闭源 Go 二进制、无插件接缝(#1049) |
| **amp**(Amp CLI) | `bili amp`(启动器,cert-MITM)—— 闭源 Go 二进制、无插件接缝(#1049) |
| **goose**(Goose CLI) | `bili goose`(启动器)—— rustls 不信任任何 CA 文件,无法 cert-MITM:openai/anthropic 腿经 `OPENAI_HOST`/`ANTHROPIC_HOST`,自定义 provider 经重新生成的 `GOOSE_PATH_ROOT` overlay(#1049) |
| **其余所有**（没有上下文 hook） | [`billion-context`](https://github.com/ranxianglei/billion-context) —— `bili <client>`（启动器，优先）或 `/bili/` 前缀 |

**原生模式 vs 独立扩展。** 宿主原生插件(`bili plugin install …`)与独立进程内扩展(`billion-context-pi`、`opencode-acp`)**互斥** —— 两者同时生效意味着双重压缩。安装器负责切换:替换旧条目(裸名、`npm:` 别名、带版本号、路径形式都认,数组/对象两种形态都处理),原配置快照到 `.bili-bak`;**项目级**安装不会被碰 —— 需手动移除。作为手动安装的运行期安全网,原生入口在加载时同步设置 `BILLION_CONTEXT_NATIVE=<host>`,让独立扩展在动作时自动退出。pi 一侧该标记需要 `billion-context-pi` **0.1.72+**。


## 安装

```bash
npm install -g billion-context
```

这会安装 `bili` 命令(`bili-proxy` 保留为别名)。

## 快速上手

3种方式 —— 任选其一:

- **原生插件(最原生):** `bili plugin install <client>` —— bili 成为客户端内的插件,照常启动客户端即可.
- **启动器(免安装):** `bili <client>` 一条命令拉起代理 + 客户端,不碰任何真实配置文件.
- **改url(最通用):** 在客户端 baseURL 前面加上代理地址 + `/bili/`。

三种方式背后的机制细节(插件生命周期、runtime-info 协议、注入优先级)见 [TECHNICAL-NOTES.zh-CN.md](TECHNICAL-NOTES.zh-CN.md)。

端口,一句话(#1660):`bili start`(手工)拥有 `8787`;lane 替你拉起的一切(原生 hook、启动器 lane)住在独立的自管端口区,从 `18787` 起 —— 碰撞 +1 跳口、每个 lane 记住自己的漂移,零配置安装永不抢端口,刻意常驻的 `bili start` 守护进程则默认被附着。升级重启时若旧版本还在该 lane 端口上排水,会最多等 5 秒让它释放并复用同一端口,而不是漂移(#1723);只有真正被占用的端口才 +1 跳口 —— 且这种跳口现在会大声打 warn。

### 方式 1 —— 原生插件(native,`bili plugin install pi` / `omp` / `opencode` / `dsh` / `kimi` / `hermes` / `zcode`)

代理住进客户端:装一次,之后照常启动客户端 —— 不用启动器命令、不用环境变量、不用固定端口、不用改 URL。目前支持 **pi**、**omp**、**opencode**(1.x 与 2.x)、**dsh**、**kimi**、**hermes** 与 **zcode**:

```bash
bili plugin install pi          # 在 pi 的 settings 里注册 billion-context 条目(bili 自身为 npm 安装时写 npm 条目)
bili plugin install omp         # 在 omp 的 config.yml(~/.omp/agent/config.yml)注册 extensions 条目
bili plugin install opencode    # 在 opencode 真实配置里注册插件 + 关闭原生自动压缩
bili plugin install dsh         # 对每个已存在的 profile 执行 'dsh plugin --profile <name> add billion-context'
bili plugin install kimi        # 写 $KIMI_CODE_HOME/plugins/managed/billion-context/kimi.plugin.json(+ installed.json 记录);每会话路由块在首次启动时落到 config.toml(需 Kimi Code >= 2.0.0)
bili plugin install hermes      # 把 Python 插件拷进 ~/.hermes/plugins/billion-context/(+ 机器自管的 bili.json sidecar),并经 `hermes plugins enable billion-context` 启用
bili plugin install zcode       # 写 hooks.enabled + SessionStart hook + mcp.servers.bili 到 ~/.zcode/cli/config.json;每会话路由块在首次启动时落到 bigmodel provider store
bili plugin remove <client>     # 卸载(dsh 经同一通道移除;配置快照存 .bili-bak)
```

客户端有自己的插件通道时,也可以原生安装、完全不用 bili 命令:

- **dsh:** `dsh plugin --profile <name> add billion-context` 正是 `bili plugin install dsh` 按 profile 驱动的那条命令 —— 两种走法终态一致(pnpm 装进 profile、patch 层由 dsh 自己挂载);经同一通道卸载。见下文 dsh 段。
- **opencode:** 把裸 npm 包名直接写进你真实配置的插件列表 —— `"plugin": ["billion-context"]`(仅 npm 形态;git checkout 没有已发布入口)。包通过 `exports["./server"]` → `dist/agent/opencode-native.js` 暴露插件入口,opencode 用自己的 Npm.add 机制加载,插件自拉起的行为与 bili 安装的形态完全一致。另外要做两件 bili 安装器会替你做的事:在同一份配置里设 `"compaction": { "auto": false }`(否则 OpenCode 的原生自动压缩会双重压缩),并先手工备份该配置文件。

pi / omp / kimi / claude 没有客户端侧通道 —— 它们的配置条目由 `bili plugin install <client>` 代写(kimi 的声明式 `kimi.plugin.json` + 注册记录、claude 的受管 settings 块等)。

注意:

- 原生模式与独立进程内扩展(`billion-context-pi`、`opencode-acp`)**互斥** —— 安装器负责换条目并把原配置快照(`.bili-bak`)。
- OpenCode 旧会话、V1/V2 插件形态与全部注意事项:[OpenCode](CLIENTS.zh-CN.md#opencode)。
- `kimi` 仅在自举时上报 runtime-info(静态头无法承载逐请求窗口/模型值);子代理工具调用由代理的出站 tool_use 见证环路由(#1685)——模型看不到任何会话 id。
- `hermes` 的原生插件是 Python:健康检查通过后用环境变量把 hermes 的 httpx 栈指向代理,并经 `llm_request` 中间件打逐请求头。
- `claude` 有**原生姿态**(#964):受管 settings 块 + `SessionStart` hook + MCP shell;hook 骑自管端口区(#1660),每会话把受管 URL 重钉到存活 origin,端口漂移自愈。`BILI_NATIVE_CLAUDE=0` 退出(passthrough)。机制:[TECHNICAL-NOTES.zh-CN.md](TECHNICAL-NOTES.zh-CN.md)。
- `zcode` 有**原生姿态**(#1145):受管 `~/.zcode/cli/config.json` 块 + 每会话 provider `baseURL` 改写。完整机制:[CLIENTS.zh-CN.md](CLIENTS.zh-CN.md)。
- `omp` 是自拉起原生插件;`codex` 性质不同 —— 它是 MCP shell 工具面配套:codex 的模型流量只能经 env 路由(默认 ChatGPT-登录 provider 没有可改写的配置缝 —— managed `model_providers` 块会强制 API-key 认证、废掉订阅登录),而 MCP 子进程无法向父进程注入 env,所以插件安装既不拉代理、也永远路由不了 codex 本体流量。`bili plugin install codex` 在 `~/.codex/config.toml` 写入 `[mcp_servers.bili]`(command = node,args = dist/mcp.js)注册四个 ACP 工具,会话启动时解析代理:env `BILI_MCP_PROXY` > 活实例登记(任一 lane 的代理或 `bili start` 守护)> 8787 用户区默认(#1660 去掉了安装时烘焙 origin,#403)—— 全不可达则 `tools/list` 报 -32003。结论:**先起 bili**(`bili start` 或任一客户端的 lane 代理),想要压缩再自行导出 HTTPS_PROXY;零配置全功能用 `bili codex`。机制:[CLIENTS.zh-CN.md](CLIENTS.zh-CN.md#codexopenai-codex-cli)。
- `jcode`、`aider` 无原生模式(无插件/MCP/工具注入接缝:#962、#1048)—— 用 `bili jcode` / `bili aider`。
- `copilot`、`amp`、`goose` 仅启动器模式(#1049);goose 无法 cert-MITM(rustls 不信任任何 CA 文件),改走纯 HTTP base-URL 重定向。

### 方式 2 —— 启动器(`bili pi` / `bili codex` / `bili claude` / `bili omp` / `bili opencode` / `bili hermes` / `bili dsh` / `bili codebuddy` / `bili qoder` / `bili trae` / `bili jcode` / `bili kimi` / `bili gemini` / `bili iflow` / `bili qwen` / `bili mcode` / `bili aider` / `bili copilot` / `bili amp` / `bili goose`)

启动器把客户端包进一条命令:在独立端口拉起一个代理(总是全新实例,绝不复用端口),再按客户端支持的机制把它指向代理 —— 能吃代理/CA 环境变量的走**证书 MITM**,不吃的走隔离的**`/bili/` 配置重写**。真实配置文件从不被修改;客户端自己的配置只被**读取**,用来发现它实际连接的 HTTPS 上游主机,把这些主机加入 MITM 白名单 —— 代理只 TLS 终结它们,其余流量盲透传。

```bash
bili pi                               # 拉起 pi,走代理 —— file-free(#535):环境变量 + 扩展 registerProvider,真实 ~/.pi 不动
bili codex                            # 拉起 codex
bili claude                           # 拉起 claude
bili omp                              # pi 同款,file-free(#535):环境变量 + 扩展 registerProvider + 压缩取消,真实 ~/.omp 不动
bili opencode                         # OpenCode(1.x 与 2.x):完整指南见下文 [OpenCode](CLIENTS.zh-CN.md#opencode) 一节
bili hermes                           # file-free(#535):hermes 代理环境变量(HTTPS_PROXY + SSL_CERT_FILE 组合 CA bundle)—— https 走 CONNECT MITM,http 走绝对形式转发;真实 ~/.hermes 不动
bili dsh                              # deepseek-harness:经 --patch 注入完整原生插件(#941) —— 真实 dsh 工具、会话绑定 /acp(plugin 模式);非回环上游走代理 env,回环保留 overlay DSH_HOME 改写(#535);dsh 自动压缩关
bili codebuddy                        # Tencent CodeBuddy Code CLI:CODEBUDDY_BASE_URL /bili/ 重写(OpenAI chat completions wire),预算对齐走 CODEBUDDY_AUTO_COMPACT_WINDOW;真实 ~/.codebuddy 不动
bili qoder                            # qoder:模型端点硬编码 https(无法 /bili/ 改写)—— 证书 MITM(HTTPS_PROXY + NODE_EXTRA_CA_CERTS),默认模型主机已加白名单(#653)
bili trae                             # Trae CLI(字节跳动,闭源 Go 二进制,无 base-URL 覆盖)—— 证书 MITM(HTTPS_PROXY + SSL_CERT_FILE),模型主机取 TRAE_CLI_API_HOST 或默认企业网关(#655)
bili jcode                            # jcode(Rust 终端编码 agent)—— 环境变量式证书 MITM 启动:HTTPS_PROXY + SSL_CERT_FILE,模型主机 api.z.ai 默认加白,本地回环 provider 走 NO_PROXY 直连
bili kimi                             # Kimi Code CLI(Moonshot):除无条件回环绕过外遵循标准代理环境变量 —— https 证书 MITM、http 绝对形式转发;回环端点编目并附手动 /bili/ 提示(#757)
bili gemini                           # Gemini CLI(Google):GOOGLE_GEMINI_BASE_URL /bili/ 改写到 generativelanguage.googleapis.com(Google 原生 wire),真实 ~/.gemini 零改动
bili iflow                            # iFlow CLI:IFLOW_BASE_URL /bili/ 改写到 apis.iflow.cn/v1(OpenAI chat-completions wire),真实 ~/.iflow 零改动
bili qwen                             # Qwen Code(多协议 gemini-cli fork,无 base-URL 钩子):HTTPS_PROXY + NODE_EXTRA_CA_CERTS 证书 MITM,默认 DashScope/Qwen 模型主机加白,自建中转用 --mitm-domain 追加
bili mcode                            # MiniMax Code CLI:与 kimi 同构(代理环境变量、无条件回环绕过、证书 MITM/绝对形式);会话经 X-Mavis-Session-Id 绑定(#1050)
bili aider                            # Aider(Python pair programmer):HTTPS_PROXY + SSL_CERT_FILE/REQUESTS_CA_BUNDLE 证书 MITM;端点取自 OPENAI_API_BASE / ANTHROPIC_BASE_URL / --openai-api-base / .aider.conf.yml(#1048)
bili copilot                          # Copilot CLI(GitHub,闭源 Go 二进制)—— 证书 MITM(HTTPS_PROXY + SSL_CERT_FILE),api.githubcopilot.com + 各套餐子域加白(#1049)
bili amp                              # Amp CLI(Sourcegraph,闭源 Go 二进制)—— 证书 MITM(HTTPS_PROXY + SSL_CERT_FILE),ampcode.com 加白(#1049)
bili goose                            # Goose(Block,Rust/reqwest):rustls 发布构建不信任任何 CA 文件 —— openai/anthropic 腿经 OPENAI_HOST/ANTHROPIC_HOST,自定义 provider 经重新生成的 GOOSE_PATH_ROOT overlay(/bili/ 改写,真实配置不动)(#1049)
bili pi --mitm-domain api.foo.com     # 向 MITM 白名单追加域名
```


### 方式 3 —— 改url(`/bili/` 前缀)

启动代理:

```bash
bili
```

然后把客户端现有的 baseURL 前面加上 `http://localhost:8787/bili/` 就行。完整上游 URL 嵌在路径里,proxy 无需任何配置就知道转发到哪:

```
客户端 baseURL 之前:  https://api.openai.com/v1
客户端 baseURL 之后:  http://localhost:8787/bili/https://api.openai.com/v1
```

更多客户端配置参考网页引导: [http://localhost:8787](http://localhost:8787) .

**验证。** 代理跑着、配置保存了之后,确认它能应答,并且第一个真实请求在日志里显示压缩活动:

```bash
# 健康检查(代理是否在跑 + 转发到哪)
curl -s http://localhost:8787/__bili/health
# → {"ok":true,"upstream":"https://api.anthropic.com"}

# 实时会话统计(发过真实请求后)
curl -s http://localhost:8787/__bili/stats
```

然后从助手发一条消息,观察日志(`~/.local/state/billion-context/bili.log`,同时也打到 stderr)。每个请求应该看到一行 `processTurn`,等对话变长后会出现 `[acp-usage] round N input=X cached=Y (cache hit Z%)` + `compress` 事件。

### 客户端深入

一行带不过来的细节 —— 各模式(启动器 / `/bili/` URL 前缀 / 原生插件)如何把流量接进代理、往哪儿写了什么、已知局限有哪些 —— 都在 **[CLIENTS.zh-CN.md](CLIENTS.zh-CN.md)**:dsh · Kimi Code · Hermes · ZCode · Gemini 系(Gemini CLI / iFlow CLI / Qwen Code)· CONNECT 盲隧道接入但从不压缩的客户端(#897)· 未识别端点直连(#1290)· OpenCode(启动器 / 原生 / 纯代理、`/acp` 状态与规则、旧 opencode-acp 会话 #920)。

## 常见问题

**怎么查缓存命中率？** 不用翻日志——`/acp-cache` 直接在客户端里打一份**文字总结报告**，顶部带一个可点击的 **Web UI 链接**，点进去是网页版会话页（**折线图 + 逐断点归因**）：

![网页会话页：缓存命中率折线图 + 归因（中文界面）](docs/cache-web-session.zh-CN.png)
报告四块，一眼定位：**GRAND LEDGER**（总账：总输入/总命中/hit%，直接给出 `HEALTHY` 或异常判定；miss 拆解为 new content 新增内容 / compress re-pay 压缩重付 / upstream-ttl-or-client-rewrite 上游 TTL 或客户端重写）· **FOLD ECONOMICS**（每次折叠的经济账：净省多少、是否回本）· **LINE ITEMS**（只列异常行：hit<85% 或 miss≥5000）。经验值：**压缩本身只吃掉 ≤2%**，健康会话稳在 **95–97%**；低于这个值时，归因按概率排序：①上游缓存 TTL 到期（报告里表现为 stable-prefix miss，top spikes 会点出闲置时长）②切换了模型 ③bili 的 bug（带报告页提 issue）④其他/未知。`/acp-cache [full]` 列每一折每一行；HTTP 同款：`GET /__bili/cache-report`；每个请求的 `[acp-usage]` 行仍会落日志，供深挖。

**`/acp` 显示什么?** 带原生插件的客户端(opencode、dsh)里,`/acp` 直接从代理取当前会话的 ACP 状态面板(会话、块、可压缩区间、用量);首个模型请求到来前显示空闲提示。`/acp-cache [full]` 打印上面的缓存报告。

**能用网页查会话和配置吗?** 能 —— 打开 [http://localhost:8787](http://localhost:8787):总览仪表盘、会话列表(含逐会话详情)、实时日志、配置编辑器、上游连通性测试。全部功能同样以纯 JSON 提供(`/__bili/stats`、`/__bili/sessions`、`/__bili/config`、…),方便脚本化。

**压缩什么时候发生?** 由模型驱动:注入的上下文工具由模型在上下文增长时自行调用,温和的增长 nudge(按设计固定约 50K token 步长,可用 `compress.nudgeGrowthTokens` 调整)沿途提醒它,仅输入就超窗时预检作为硬兜底触发(#470)。用 `/acp` 或网页界面实时观察。

**bili 是透明的吗?怎么关掉?** 未识别端点原样转发([CLIENTS.zh-CN.md](CLIENTS.zh-CN.md)),且每种模式都能干净退出:原生安装用 `bili plugin remove <client>`,另两种模式停掉启动器命令 / 环境变量 / `/bili/` 前缀即可 —— 流量立刻恢复直连。

**日志和会话数据存在哪?** 日志:`~/.local/state/billion-context/bili.log`(同时镜像到 stderr);会话状态:`~/.local/share/billion-context/`(XDG 可覆盖;Windows 杀软排除 #362、可选清理 #1082)—— 完整路径见 [CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md)。

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

### 远程 agent（`--host`）

默认绑定 `127.0.0.1`,只接受本机连接。要给其他机器上的 agent 用:`bili --host 0.0.0.0`(或局域网 IP);远程 agent 把模型 `baseURL` 指向 `http://<本机>:<端口>/bili/…`。

- MITM 模式的 `CONNECT` 也会接受远程客户端 —— 但仅限**白名单内的模型域名**;到任意主机的盲隧道仍仅限本机,代理不会沦为开放中继。
- `/bili/<绝对URL>` 目的地准入(#409):代理自身与 link-local/metadata 地址一律拒绝;loopback/私网目的地对本地客户端放行(自托管上游)、对远程客户端拒绝,除非列入 `BILI_TUNNEL_ALLOWED_HOSTS`(`host` 或 `host:port`,逗号分隔)。一个例外(#1073):**本地**客户端经**loopback IP 字面量**目的地转发管理路径(`/__bili/*`、`/__acp/*`)时不带标记放行;远程 peer 与主机名目的地无条件保留内部隧道标记,管理路径即使经 NAT hairpin 也无法穿过隧道。指向本实例自身管理端点的绝对形式请求会在本地直接应答、而不是经隧道转发(正向代理式健康探测能拿到真实响应)。
- **没有任何鉴权**:只应在可信局域网或防火墙内使用。`/__bili/` 管理端点仍仅限本机访问。启动时的 `[security]` 警告会提醒上述事项。


### 调试

`bili --debug`(或环境变量 `ACP_DEBUG=1`,或配置里 `"debug": true` —— 优先级:参数 > 环境变量 > 配置)会打印每次 `processTurn`(标签计数、token 用量)、nudge 决策(growth/usage/pendingT1/shouldInject)、客户端 headers 和 SSE 重写。

### 日志文件

所有日志**默认同时写入文件**:`~/.local/state/billion-context/bili.log`(XDG state 目录),同时仍打印到 stderr。覆盖用配置的 `"logFile"` 或 `ACP_LOG_FILE`(`off` 关闭文件)。超过 10 MB 自动轮转(`bili.log.old`)。每个请求的缓存命中统计以 `[acp-usage] round N input=X cached=Y (cache hit Z%)` 打印,可直接从日志衡量前缀缓存健康度。

### 自动更新

代理启动时和每 3 分钟检查 npm 是否有新版本。发现新版本就原位安装并打印通知 —— **重启 `bili` 才能生效**,除非启用可选自重启(`--auto-restart-on-update` 参数 / `ACP_AUTO_RESTART_ON_UPDATE=1` 环境变量 / 配置 `"autoRestartOnUpdate": true`,默认关闭):零在途请求时校验新安装、停止接收连接、排空、在同一端口拉起替代进程并在其开始接受连接后退出(客户端自动重连;会话状态在磁盘上保留)。安全门:排空窗口全程零在途、re-exec 前安装完整性检查、10 分钟冷却标记防止版本抖动循环重启;任何失败恢复原监听器并回落到普通提醒。运行进程落后于磁盘安装("stale")时,Web UI 显示横幅,`GET /__bili/status` 返回 `{version, diskVersion, stale, autoRestartOnUpdate, advisory, inFlight}` 供脚本使用(`advisory` 为生效中的严重缺陷公告或 `null`,见下节)。永久禁用:配置(`"autoUpdate": false`)或环境变量(`ACP_AUTO_UPDATE=0`)。

### 严重缺陷公告(强制更新)

独立于自动更新(#1481):即使关闭了 `autoUpdate`,代理也会按同样的 3 分钟节奏轮询一个小的伴生 npm 包(`billion-context-advisories`,由 CI 从本仓库的 [`advisories/`](advisories/) 目录发布)。每条公告指明受缺陷影响的版本范围(`affected`,semver)、应安装的确切版本(`target`,可以比当前版本**更旧**,即回滚),以及面向用户的缺陷说明(`reason`)。当本地版本落入 `affected` 范围时,bili 会走自更新的全套安全链路强制安装 `target`(跨进程锁、备份+校验+回滚;源码检出和宿主托管的安装会被拒绝并给出手动升级指引),并以警告方式呈现:

- 日志中每个进程、每条公告一次性的 `[advisory] ⚠️ …`;
- Web UI 概览页横幅,显示原因与手动升级命令;
- `GET /__bili/status` 在 `advisory` 字段返回生效中的公告。

该检查默认 fail-open:公告源不可达或格式错误只产生警告,绝不阻断模型流量。禁用方式:配置(`"advisoryCheck": false`)或环境变量(`BILI_ADVISORY_CHECK=0`);可用 `"advisoryUrl"` / `BILI_ADVISORY_URL` 指向自定义文档。

## 配置

完整的配置参考 —— 配置文件位置、顶层键、providers、压缩调参、环境变量 ——
见 **[CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md)**。

两个最常找的开关:

- **上游代理(防火墙/GFW)**—— 让代理自身出站流量走 v2rayA/clash:完整解析顺序、空字符串 = 显式直连、SOCKS5 拒绝、两条出站路径都覆盖,以及 `mitm://` vs `https://` 键 scheme 区分,都在 [CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md)(服务端设置 → `proxy`;Providers → key schemes)。
- **线上兼容角色改写(`compat.roles`)**—— 上游拒绝 `developer` 角色?[CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md)(服务端设置 → `compat`)已覆盖 —— 包括零配置即用的失败自学习修复。

## 会话机制

代理以**客户端自己提供的会话值(原样照搬)**为键隔离压缩状态(`src/session-id.ts`)—— 不哈希、不含协议/上游/API key 维度(它们会在会话中途变化,拿它们做 key 恰好在用户继续对话时把状态弄丢,#280/#286)。该 id 只在代理内部使用(状态存储、持久化、UI 标签),绝不上送。

取值来源(按顺序取第一个命中的):插件的 `x-bili-plugin-conversation`(仅当同时带 `x-bili-plugin` 标记 header)、客户端专属 header(`x-claude-code-session-id`、`x-grok-session-id`/`x-grok-conv-id`、`x-mavis-session-id`)、通用 header(`x-session-affinity`、`x-acp-session`、`x-session-id`、`x-opencode-session`、`session-id`/`session_id`)、或 body 字段:Responses wire 的 `session_id`/`metadata.session_id`,以及 Responses/OpenAI/Anthropic wire 上提升替代内容指纹回退的 `prompt_cache_key`。

| 客户端 | 发会话 id 吗? | 来源 |
|---|---|---|
| **Codex** | ✅ 发 | `body.session_id` / turn-metadata thread id |
| **OpenCode** | ✅ 发 | `x-session-affinity` / `x-opencode-session` header(`ses_…`) |
| **Claude Code** | ✅ 发 | `x-claude-code-session-id` header |
| **omp**(经插件)| ✅ 发 | `prompt_cache_key` 提升为稳定身份(#268)|
| **pi**(裸跑)| ❌ 不发 | 无 → 见下方匿名前缀亲和 |

**无 header 客户端(pi 类):匿名前缀亲和。** 当客户端完全不发任何会话信号时,代理从重放的历史本身解析会话(`src/prefix-affinity.ts`,#309):只有当请求历史从第 0 条开始逐字节复现某已存会话的消息链时,才重新挂回该会话;否则获得一个确定性的新 `pfa-…` 会话。后果(#1262):**恢复(resume)** 的对话重新挂回自己的会话(包括代理重启后,#499);**开头相同的新任务不会继承**另一个会话的 block —— 它拿到全新会话,历史一旦分叉就彻底独立;完全没有任何可用信号时,请求会被显式 400 拒绝,而不是静默与他人状态碰撞。

设计记录与威胁模型:[SESSION-IDENTITY.md](SESSION-IDENTITY.md)。消息粒度的对偶文档(为什么身份由内容派生、而非指派 id)是 [MESSAGE-IDENTITY.zh-CN.md](MESSAGE-IDENTITY.zh-CN.md)。

上游粘性路由方面,代理只转发客户端本来就提供的身份值(例如 body 里的 `session_id` 会以 `x-session-id` 上送),绝不自行合成一个。

**建议:** 发显式 id 的客户端可以安全并发。无 header 的多 agent 场景,优先装客户端插件(为每个会话盖稳定 id)或每会话传显式 `x-acp-session` header —— 两者都没有时,前缀亲和也能把不同任务分开(分叉的代价只是一次原始重发加压缩阶梯重启)。

### 派生(子)会话继承父会话的压缩上下文(#1333、#1362)

当 agent 派生子会话(subagent 或 fork,从空历史起步、不重发父会话内容)时,它会在出生时上报这条血缘:身份注册携带父会话 id(`parentConversationId`),代理在子会话上记录一条只读链接(`derivedFrom`)。此后 `decompress` / `search_context` 对子会话自己从未见过的内容沿父链回退(带环检测、深度上限 8);任何东西都不复制进子会话,父会话也绝不被修改;父会话未知时子会话就按全新起步。各 lane 的父信号(pi/omp `parentSession` header、OpenCode V1/V2 `parentID`):[SESSION-IDENTITY.zh-CN.md](SESSION-IDENTITY.zh-CN.md#派生子会话出生时携带血统1333-1362)。claude/codex/dsh 在这里不需要任何信号:它们的子 agent 共享同一个会话 id,或根本没有子会话概念。

### Windows：把会话目录加入杀软排除项（#362）

代理把每个会话的压缩状态持久化到会话目录(默认 `%USERPROFILE%\.local\share\billion-context\`),长会话每一轮都会重写该文件。在 Windows 上,实时杀毒(Defender)、搜索索引器或同步工具(OneDrive)可能在写入中途锁住该目录,导致 rename 以 `EPERM` 失败。同一会话连续 N 次写失败(默认 `5`)时,代理打一条一次性可操作告警,指明要排除的目录。根上修复:把 `%USERPROFILE%\.local\share\billion-context\` 加入杀软**排除项**,并确认没有同步工具在同步该路径 —— 完整步骤见 [CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md) 的「Windows：把会话目录加入杀软排除项」章节。

### 会话文件清理（#1082）

短命会话会留下永远不会再被恢复的小状态文件。清理是**可选开启(opt-in)**的:设 `BILI_SESSION_GC=1` 才启用(默认关闭 —— 会话文件属于用户数据,不应有静默删除策略)。启用且持久化开启时,bili 在启动时和每小时扫描会话目录,只有**两个条件同时满足**才删除一个文件:年龄超过 `BILI_SESSION_GC_MAX_AGE_DAYS`(默认 7 天),并且该会话**从未被压缩过**(没有折叠块)、最近一次请求体 ≤ `BILI_SESSION_GC_MAX_TOKENS` token(默认 1M)—— 删除只丢字节不丢内容。CCR 内容存储遵循其会话文件的生命周期;被压缩过的会话永不删除;每次删除都写审计日志。详见 [CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md)。

## 状态

早期。协议处理和压缩已通过 mock 测试(500+ 项通过)。真实模型集成测试是下一里程碑。预期会有粗糙的地方。

针对 pi / omp / opencode 的客户端插件随 `billion-context` 一起发布(`dist/agent/*.js`),用于协作代理路径。三者(`billion-context`、独立的 `billion-context-pi`、`opencode-acp`)如何取舍,见上文「该选哪个?」一节。

## 额外署名要求（在 MIT 之上的一条附加条款）

本项目采用 MIT 许可**外加一条附加条款**：任何终端用户可见或可交互、且使用了本软件的产品或服务（无论商业或开源），须在其首页、文档或“关于/致谢”页面中注明该产品使用了 billion-context，并附指向本仓库的链接；纯服务端/内嵌用途随附文档声明即可。详见 [LICENSE](LICENSE) 末尾的**附加条款**。

如果你的产品用到了本项目，欢迎提一个 issue 告知（没有强制义务），方便我们了解它被用在哪些地方。

## 许可证

MIT
