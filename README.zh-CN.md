# billion-context

[English](./README.md) | [中文](./README.zh-CN.md)

<p align="center">
AI 编程助手的<strong>通用上下文压缩代理</strong>
<br />
任何能设置 base URL 的助手 —— <em>无需为每个助手写适配代码</em>。
</p>

---


## 📄 论文 / 预印本

- **[模型驱动的分层增量压缩:面向长寿命编码 Agent 的免训练多代上下文管理](./paper/模型驱动的分层增量压缩-免训练多代上下文管理.md)**(中文版,v0.2)

> 📝 **论文本身与代码一同以 MIT 许可开源(位于 `paper/` 目录),是代码库的一部分 —— 这是一份活文档,任何人都可以编辑,欢迎提 PR 改进。**

生产规模纵向研究:四个半月、三宿主、174,327 次模型调用、187.6 亿累计输入 token(三宿主合计约 247 亿),204,800-token 窗口零违规,马拉松会话 8,584–12,049 次调用。

---

<p align="center">
<a href="https://www.npmjs.com/package/billion-context"><img src="https://img.shields.io/npm/v/billion-context.svg?style=flat-square" alt="npm"></a>
<a href="https://github.com/ranxianglei/billion-context/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/billion-context.svg?style=flat-square" alt="license"></a>
<a href="https://github.com/ranxianglei/billion-context"><img src="https://img.shields.io/badge/GitHub-ranxianglei%2Fbillion--context-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

<p align="center">
<code>npm install -g billion-context</code>
</p>

---

`billion-context` 架在**任意**编程助手与其模型 API 之间,用 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 压缩重写 Anthropic/OpenAI 流。何时压缩、压缩什么 —— <strong>由模型决定</strong>,而非硬截断。

## 社区

交流、求助与更新都在 QQ——同一个群覆盖三个项目(`billion-context`、`billion-context-pi`、`opencode-acp`):

**QQ 群:1056132097**

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

可选的第五个工具 `absorb`(`compress.absorb.enabled: true` —— 见 [CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md))对**各个工具结果即时压缩**:大结果(构建、日志、grep)被附带强制吸收指令,模型将各自蒸馏为紧凑摘要,原配对从下一轮起从线上隐藏 —— 使折叠轮之间的中间会话压力更低(#605)。

**如何确认压缩真的生效了。** 代理执行 `compress` 后会以普通 assistant 文本发出确认标记(`📦 [ACP] Compressed …`)—— 但曾观察到模型在持续上下文压力下*自行书写该标记格式*而从未调用工具(#717):约 2 小时内 17 次假"压缩",真实用量一路爬到 89%。因此对话中看到的标记行本身不是持久化完成的证据 —— 请先用 `acp_status` 复核(块数 +1、可压缩区间起点前移)再采信。作为兜底,代理会剥离模型自发的标记形文本并记录 `[marker-echo]` 警告;注入的 nudge 与系统提示词也明确声明标记只由代理发出。

## 该选哪个?

按客户端选:

| 客户端 | 用这个 |
|---|---|
| **pi** | [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)(进程内扩展) |
| **opencode**(1.x / 2.x) | [`billion-context`](https://github.com/ranxianglei/billion-context) —— `bili opencode`(启动器)或 `bili plugin install opencode`(原生,免启动器);独立 [`opencode-acp`](https://github.com/ranxianglei/opencode-acp) 在 1.x 上仍可用。完整指南:[OpenCode](#opencode) |
| **omp** | [`billion-context`](https://github.com/ranxianglei/billion-context)，`bili omp`（内置插件）或 `bili plugin install omp`（自拉起原生插件，免启动器） |
| **dsh** | [`billion-context`](https://github.com/ranxianglei/billion-context) —— `bili dsh`（启动器，经 `--patch` 注入完整原生插件：工具、会话绑定 `/acp`、fetch 拦截）或 `bili plugin install dsh` ≡ `dsh plugin --profile <name> add billion-context`（统一泳道 —— pnpm 把包装进各 profile、由 dsh 挂载包内 patch 层；bili 形式只是替你按 profile 驱动 dsh 自己的通道，并顺带迁移旧版受管块） |
| **kimi** | `bili plugin install kimi`（自拉起原生插件，免启动器 —— 需 Kimi Code ≥ 2.0.0；每会话在 `~/.kimi-code/config.toml` 写入路由块）或 `bili kimi`（启动器，证书 MITM）或 `/bili/` 前缀 |
| **claude** | `bili claude`(启动器)或 `bili plugin install claude`(原生姿态,#964 —— 受管 settings 块 + 会话自管代理;见下方"注意") |
| **jcode** | [`billion-context`](https://github.com/ranxianglei/billion-context)，`bili jcode`（启动器，cert-MITM）或 `/bili/` 前缀 —— 无法做原生插件：编译型 Rust 二进制、无插件接缝，其静态 provider 配置无法按请求打头（[#962](https://github.com/ranxianglei/billion-context/issues/962)） |
| **其余所有**（没有上下文 hook） | [`billion-context`](https://github.com/ranxianglei/billion-context) —— `bili <client>`（启动器，优先）或 `/bili/` 前缀 |

**原生模式 vs 独立扩展。** 宿主原生插件(`bili plugin install pi` / `opencode` —— 代理在宿主进程内拉起)与独立进程内扩展(`billion-context-pi`、`opencode-acp`)**互斥**:两者同时生效意味着双重压缩。安装器负责切换:`bili plugin install pi` 会替换旧的 `npm:billion-context-pi` 条目;`bili plugin install opencode` 会从全局 opencode.json 里剔除旧的 `opencode-acp` 条目 —— 裸名、`npm:` 别名、带版本号(`opencode-acp@stable`)、路径形式都认,数组/对象两种形态都处理;原配置会快照到 `opencode.json.bili-bak`。**项目级**安装(`opencode plugin opencode-acp` 写的是 `<project>/.opencode/opencode.json`,不是全局配置)不会被碰 —— 需手动移除,安装器输出里会提醒。作为手动安装的运行期安全网,原生入口在加载时同步设置 `BILLION_CONTEXT_NATIVE=<host>`,让独立扩展在动作时自动退出 —— 它自己的加载期 `BILLION_CONTEXT_PROXY` 检查看不见原生模式异步拉起的代理,`/bili/` baseURL 检查也看不见 fetch 层改写。


## 安装

```bash
npm install -g billion-context
```

这会安装 `bili` 命令(`bili-proxy` 保留为别名)。

## 快速上手

3种方式 —— 任选其一:

- **原生插件(免启动器):** `bili plugin install <client>` —— bili 成为客户端内的插件,照常启动客户端即可.
- **启动器(最省事):** `bili <client>` 一条命令拉起代理 + 客户端,不碰任何真实配置文件.
- **改url(持久化):** 在客户端 baseURL 前面加上代理地址 + `/bili/`。

三种方式背后的机制细节(插件生命周期、runtime-info 协议、注入优先级)见 [TECHNICAL-NOTES.zh-CN.md](TECHNICAL-NOTES.zh-CN.md)。



### 方式 1 —— 原生插件(native,`bili plugin install pi` / `omp` / `opencode` / `dsh` / `kimi`)

代理住进客户端:装一次,之后照常启动客户端 —— 不用启动器命令、不用环境变量、不用固定端口、不用改 URL。目前支持 **pi**、**omp**、**opencode**(1.x 与 2.x)、**dsh** 与 **kimi**:

```bash
bili plugin install pi          # 在 pi 的 settings 里注册 billion-context 条目(bili 自身为 npm 安装时写 npm 条目)
bili plugin install omp         # 在 omp 的 config.yml(~/.omp/agent/config.yml)注册 extensions 条目
bili plugin install opencode    # 在 opencode 真实配置里注册插件 + 关闭原生自动压缩
bili plugin install dsh         # 对每个已存在的 profile 执行 'dsh plugin --profile <name> add billion-context'
bili plugin install kimi        # 写 $KIMI_CODE_HOME/plugins/managed/billion-context/kimi.plugin.json(+ installed.json 记录);每会话路由块在首次启动时落到 config.toml(需 Kimi Code >= 2.0.0)
bili plugin remove <client>     # 卸载(dsh 经同一通道移除;配置快照存 .bili-bak)
```

客户端有自己的插件通道时,也可以原生安装、完全不用 bili 命令:

- **dsh:** `dsh plugin --profile <name> add billion-context` 正是 `bili plugin install dsh` 按 profile 驱动的那条命令 —— 两种走法终态一致(pnpm 装进 profile、patch 层由 dsh 自己挂载);经同一通道卸载。见下文 dsh 段。
- **opencode:** 把裸 npm 包名直接写进你真实配置的插件列表 —— `"plugin": ["billion-context"]`(仅 npm 形态;git checkout 没有已发布入口)。包通过 `exports["./server"]` → `dist/agent/opencode-native.js` 暴露插件入口,opencode 用自己的 Npm.add 机制加载,插件自拉起的行为与 bili 安装的形态完全一致。另外要做两件 bili 安装器会替你做的事:在同一份配置里设 `"compaction": { "auto": false }`(否则 OpenCode 的原生自动压缩会双重压缩),并先手工备份该配置文件。

pi / omp / kimi / claude 没有客户端侧通道 —— 它们的配置条目由 `bili plugin install <client>` 代写(kimi 的声明式 `kimi.plugin.json` + 注册记录、claude 的受管 settings 块等)。

插件加载时**自拉起自己的代理**(已有健康实例则直接复用;父进程 pid 看门狗在客户端退出时收掉它),把模型流量改写到 `<proxy>/bili/<上游URL>`,注册 `compress` / `decompress` / `acp_status` 为客户端原生工具(plugin 模式),并把客户端**自己的模型配置**上报给代理让压缩预算用真实窗口而不是注册表猜测。退出开关:`BILI_NATIVE_PI=0`、`BILI_NATIVE_OMP=0`、`BILI_NATIVE_OPENCODE=0`、`BILI_NATIVE_DSH=0`、`BILI_NATIVE_KIMI=0`。完整机制:[TECHNICAL-NOTES.zh-CN.md](TECHNICAL-NOTES.zh-CN.md)。

**Runtime-info 协议(#955)。** 原生插件读取客户端自己将要使用的模型配置并推给代理(逐请求头 + 自举上报);代理解析上下文窗口时优先采用这份真相,而不是 models.dev 注册表/内置表。协议细节、解析顺序与现有实现:[TECHNICAL-NOTES.zh-CN.md](TECHNICAL-NOTES.zh-CN.md)。

注意:

- 原生模式与独立进程内扩展(`billion-context-pi`、`opencode-acp`)**互斥** —— 安装器负责换条目并把原配置快照(`.bili-bak`);迁移细节见上方客户端表(pi 需 `billion-context-pi` 0.1.72+ 才能干净退让)。
- OpenCode:legacy `opencode-acp` 会话、V1/V2 插件形态与全部注意事项已并入 [OpenCode](#opencode) 一节。
- `kimi` 仅在自举时上报 runtime-info(静态 `custom_headers` 无法承载逐请求的窗口/模型头,否则会在模型切换后过期),子代理会话按每次调用的 `conversation_id` 绑定 —— 完整机制见下文「Kimi Code」小节。
- `claude` 有**原生姿态**(#964):`bili plugin install claude` 写入受管 settings 块(静态 `/bili/` URL + `SessionStart` hook)+ 指向稳定端口的 MCP shell —— 代理随会话生灭。`BILI_NATIVE_CLAUDE=0` 退出(passthrough)。机制细节:[TECHNICAL-NOTES.zh-CN.md](TECHNICAL-NOTES.zh-CN.md)。
- `codex` / `omp` 也有配套安装(MCP shell 与轻量扩展),但它们需要一个在跑的代理 —— 不属于原生模式。
- `jcode` 则完全没有原生模式:它是编译型 Rust 二进制、无插件/扩展接缝,唯一的 provider 级请求头是静态 TOML 表(对每个请求原样附加),MCP server 又是跨所有会话共享的全局池 —— 既无法在进程内改写模型流量,也无法打上 plugin 模式所需的按请求头(`x-bili-plugin`、会话 id、runtime-info)。完整源码级分析见 [#962](https://github.com/ranxianglei/billion-context/issues/962)(已按 wontfix 关闭)。请用 `bili jcode`(启动器)。

### 方式 2 —— 启动器(`bili pi` / `bili codex` / `bili claude` / `bili omp` / `bili opencode` / `bili hermes` / `bili dsh` / `bili codebuddy` / `bili qoder` / `bili trae` / `bili jcode` / `bili kimi`)

启动器把客户端包进一条命令:在独立端口拉起一个代理(总是全新实例,绝不复用端口),再按客户端支持的机制把它指向代理 —— 能吃代理/CA 环境变量的走**证书 MITM**,不吃的走隔离的**`/bili/` 配置重写**。真实配置文件从不被修改;客户端自己的配置只被**读取**,用来发现它实际连接的 HTTPS 上游主机,把这些主机加入 MITM 白名单 —— 代理只 TLS 终结它们,其余流量盲透传。

```bash
bili pi                               # 拉起 pi,走代理 —— file-free(#535):环境变量 + 扩展 registerProvider,真实 ~/.pi 不动
bili codex                            # 拉起 codex
bili claude                           # 拉起 claude
bili omp                              # pi 同款,file-free(#535):环境变量 + 扩展 registerProvider + 压缩取消,真实 ~/.omp 不动
bili opencode                         # OpenCode(1.x 与 2.x):完整指南见下文 [OpenCode](#opencode) 一节
bili hermes                           # file-free(#535):hermes 代理环境变量(HTTPS_PROXY + HERMES_CA_BUNDLE)—— https 走 CONNECT MITM,http 走绝对形式转发;真实 ~/.hermes 不动
bili dsh                              # deepseek-harness:经 --patch 注入完整原生插件(#941) —— compress/decompress/acp_status 注册为真实 dsh 工具，请求盖 dsh 会话 id(plugin 模式)，/acp 会话绑定；非回环上游走代理 env(https MITM、http absolute-form)，回环上游保留 overlay DSH_HOME(~/.dsh-bili)改写(#535)，内置 deepseek 路由走 DEEPSEEK_BASE_URL；dsh 原生自动压缩被禁用(compaction-basic auto:false)
bili codebuddy                        # Tencent CodeBuddy Code CLI:CODEBUDDY_BASE_URL /bili/ 重写(OpenAI chat completions wire),预算对齐走 CODEBUDDY_AUTO_COMPACT_WINDOW;真实 ~/.codebuddy 不动
bili qoder                            # qoder:模型端点硬编码 https(无法 /bili/ 改写)—— 证书 MITM(HTTPS_PROXY + NODE_EXTRA_CA_CERTS),默认模型主机已加白名单(#653)
bili trae                             # Trae CLI(字节跳动,闭源 Go 二进制,无 base-URL 覆盖)—— 证书 MITM(HTTPS_PROXY + SSL_CERT_FILE),模型主机取 TRAE_CLI_API_HOST 或默认企业网关(#655)
bili jcode                            # jcode(Rust 终端编码 agent)—— 环境变量式证书 MITM 启动:HTTPS_PROXY + SSL_CERT_FILE,模型主机 api.z.ai 默认加白,本地回环 provider 走 NO_PROXY 直连
bili kimi                             # Kimi Code CLI(Moonshot):除无条件回环绕过外,所有流量遵循标准代理环境变量——非回环 https 走证书 MITM(HTTPS_PROXY + NODE_EXTRA_CA_CERTS/SSL_CERT_FILE),非回环 http 走绝对形式转发;provider/model 主机取 ~/.kimi-code/config.toml(遵循 KIMI_CODE_HOME)或未声明时的托管 OAuth 端点;回环端点编目并附手动 /bili/ 前缀提示(#757)
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

### dsh(deepseek-harness)

两条通道，同一个插件(#941):

- **启动器:** `bili dsh` 经 `--patch` overlay(`~/.dsh-bili/.bili-acp.patch.yml`)注入完整原生插件 —— 每个 profile 启动即注册 bili 工具，模型请求盖 `x-bili-plugin` + dsh 会话 id(plugin 模式)，`/acp` 会话绑定。同一份 patch 同时禁用 dsh 原生自动压缩(`compaction-basic` → `auto: false`);手动 `/compact` 仍可用。
- **Profile 安装(免启动器)——统一泳道(#966):** `bili plugin install dsh` 对每个已存在的 profile 执行 `dsh plugin --profile <name> add billion-context` —— pnpm 把包装进各 profile 自己的 `node_modules`,dsh 自动挂载包内 patch 层(`dsh.bundle.patch.yml`)。装哪个源取决于 bili 自身的安装形态(#925):npm 安装传注册表名,checkout/dev 构建传绝对路径(`link:` 依赖,本地改动实时生效)。旧版受管块(`# bili begin` / `# bili end`,#966 之前的安装所写)在安装与卸载时都会被剥离 —— 用户条目与注释保留,清空的文件还原占位 `[]`。先在每个 profile 里跑过一次 dsh 让目录存在。插件加载时自拉起代理(已有健康实例则附看，不重复拉;父进程 pid 看门狗)，经全局 fetch 补丁把模型流量改写为 `<proxy>/bili/<上游URL>`，原样注册清单工具，并按工具就绪门控 plugin 模式头(第一轮走 wire 模式)。退出开关:`BILI_NATIVE_DSH=0`。卸载:`bili plugin remove dsh` 或 `dsh plugin --profile <name> remove billion-context` —— 两者走同一通道。经注册表安装要求 npm 上已发布含 `dsh.bundle.patch.yml` 的版本。
- **自动更新保持各 profile 同步:** 全局自更新完成后,bili 会扫描 `~/.dsh/profiles/*/package.json`,把注册表钉住的 `billion-context` 依赖刷新回新的全局版本 —— 加载的插件与代理从此不再漂移(#953);钉在本地源的 profile 不动。刷新是尽力而为,绝不会让更新本身失败。

`bili dsh` 启动下插件**附看**(attach)启动器的代理(不二次拉起)。裸上游 URL 与 spawn 模式一样重写为 `<proxy>/bili/<url>`(回环代理目标永不被代理 env 拦截，等于直接绕开 MITM)；已经路由的 `/bili/` 前缀请求原样放行、只盖章。已知局限:手动 `/compact` 没有 dsh 侧事件钩子，其边界交给内核的自然 ingest diff(自动压缩已关，影响罕见)。

### Kimi Code(Moonshot)

三种对齐模式:`bili kimi`(启动器,证书 MITM —— 方式 2)、`/bili/` URL 前缀,以及原生插件模式(`bili plugin install kimi`,#963)。Kimi Code v2 的插件体系是纯声明式的(`kimi.plugin.json`:MCP server、hooks、skills —— 没有进程内 JS 执行),所以 bili 无法像 pi/opencode/dsh 那样补丁客户端的 fetch 栈。取而代之,插件带两个小型 node 脚本,在客户端外围完成工作:

- **安装:** `bili plugin install kimi` 写 `$KIMI_CODE_HOME/plugins/managed/billion-context/kimi.plugin.json`,声明一个 stdio MCP server(`node <root>/dist/kimi/native-mcp.js`)加一个 `SessionStart` hook(`node <root>/dist/kimi/bootstrap-hook.js`,超时 30 s),并在 `$KIMI_CODE_HOME/plugins/installed.json` 注册该插件。安装器要求 `kimi --version` ≥ 2.0.0,低于此版本拒绝安装(启动器模式不受影响)。卸载:`bili plugin remove kimi`(managed 目录 + 注册表记录 + 配置还原)。
- **每会话自举:** kimi 为每个会话把 MCP server 作为直接子进程拉起;启动时它先附上健康的现有代理(`BILLION_CONTEXT_PROXY`),否则在临时端口自拉起一个,然后用幂等的逐行受管块改写 `~/.kimi-code/config.toml` 的路由:自有 provider `[providers.bili]`(`base_url = http://127.0.0.1:<port>/bili/<上游>`,原样克隆当前 provider 的 `oauth` / `api_key` 引用)、`[models.bili-kimi]` 别名、顶层 `default_model` 重定向(原值记录在块内)。原文件一次性快照到 `config.toml.bili-bak`;每次写入都在 mkdir 锁文件下进行,块外的用户内容绝不被触碰。Kimi 的配置热重载会把变更应用到存活会话。`SessionStart` hook 机会性地跑同样的自举(仅 attach —— 永不拉起代理);它的非阻塞竞态在设计上被容忍:第一轮可能走直连/wire 模式,不变量是绝不把 `base_url` 指向死端口。
- **Plugin 模式盖章:** 只有当 ACP 工具清单已在存活代理上验证通过后,块里才会写入 `custom_headers = { x-bili-plugin = "kimi" }` —— 此前流量走 wire 模式。由于 `custom_headers` 按 provider 静态生效,无法承载逐请求的窗口/模型头(会在模型切换后过期),所以 runtime-info 上报只在自举时发生(客户端配置里有模型 + 上下文窗口 + 最大输出就一并上报)。
- **看门狗与生命周期:** MCP 子进程每 30 s 探测一次代理。attach 模式下永远等待(绝不碰用户自己的代理);spawn 模式下代理死亡则重新拉起并把路由改写到新 origin。恢复失败时移除受管块,让流量退回直连上游而不是打到死端口。会话结束时 kimi 杀掉 MCP 子进程,父进程 pid 看门狗随之收掉拉起的代理。多个并发 TUI 共享第一个拉起的代理;它消失后其余会话自动重新拉起并改路。
- **已知局限:** 子代理会话各自得到独立的派生代理会话(kimi 不暴露稳定的会话 id;工具调用经每次调用的 `conversation_id` 参数绑定);kimi 的原生自动压缩**没有**被推后 —— ACP 压缩只是先触发,与启动器模式一致。退出开关:`BILI_NATIVE_KIMI=0`。

### 客户端用 `http.proxy`(CONNECT)接入但从不压缩

部分客户端(VS Code 系 IDE:CodeBuddy、Cursor、Windsurf……)只提供一个 HTTP **代理**设置(`http.proxy`、`codingcopilot.httpProxyURL` 等),没有可改写的模型 base-URL。这类客户端不走普通的 `/bili/…` 请求,而是把 `CONNECT <模型域名>:443` 发给代理。只有当模型域名在 bili 的 **MITM 白名单**里时这条路径才会被解密;否则 bili 只做盲隧道(不透明转发),永远看不到——也就无法压缩——模型请求(#897)。

该失效模式现在不再静默:

- 日志里对每个目标域名打一次 `BLIND TUNNEL WARNING`,附修复步骤;
- `curl -s http://localhost:8787/__bili/health` 与 `/__bili/stats` 输出 `blindTunnels`(计数 + 精确目标域名,仅 loopback);
- 存在此类隧道时,`acp_status` 输出会多一节 `UNDECRYPTED TRAFFIC (instance-level)`。

要真正压缩这类客户端:把它的模型域名加进 `billion-context.json` 的 `"mitm".domains`(如 `"mitm": { "domains": ["copilot.tencent.com"] }`)或环境变量 `BILI_MITM_DOMAINS`,重启 bili,并让客户端信任 bili 的根 CA(Node 系客户端用 `NODE_EXTRA_CA_CERTS=~/.local/share/billion-context/ca/root-ca.pem`,有 CA 路径设置的用其设置)。`/bili/` 前缀方案在这里不适用——没有 URL 可改。详见 [CONFIGURATION.zh-CN.md → MITM](CONFIGURATION.zh-CN.md#mitm-透明代理登录客户端)。

## OpenCode

同一个内置插件同时服务两代 OpenCode:agent 文件同时保留 V1 `server()` 与 V2 `setup()` 导出 —— ≥ 1.18.29 的 1.x 宿主加载 V1 形状,2.x 宿主加载 V2 `setup()`。独立扩展 [`opencode-acp`](https://github.com/ranxianglei/opencode-acp) 仅支持 V1,在 2.x 下**不加载** —— 对 OpenCode 2.x,**billion-context 是推荐的上下文管理方案**。以下均在 `@opencode/cli` 2.0.3 上端到端验证过(V1 泳道:1.14.46 与 1.18.31)。

| 路径 | 命令 | 适用 |
|---|---|---|
| 启动器(最省事) | `bili opencode` | 一条命令拉起代理 + 客户端;不碰真实配置 |
| 原生(免启动器) | `bili plugin install opencode` | 自拉起插件写进真实配置;照常启动 `opencode` |
| 纯代理(兜底) | baseURL 加 `/bili/` 前缀 | 无插件 —— wire 级工具注入 |

### 启动器 —— `bili opencode`

HTTPS 走证书 MITM,HTTP 走临时 `opencode.json` 副本(`/bili/` 改写;JSONC 注释照单接受,合并方式与 opencode 自身一致;相对本地插件路径在副本里重新锚定为绝对路径 —— opencode 按声明所在配置文件目录解析,#826)。宿主代次用 `--version` 探测(探测失败默认按 1.x):**2.x** 宿主注入内置 V2 插件(`dist/agent/opencode.js`),以临时包装目录形式给出(目录入口 `index.js` 再 re-export 插件文件 —— 2.x 拒绝配置 `plugin` 数组里的裸文件路径);**1.x** 宿主直接给裸文件路径。

插件在两代宿主上做的事相同:在宿主内原生注册 bili 工具 —— compress / decompress / search_context / acp_status(另加 absorb)—— 并在每个 provider 请求上盖章代理头,含从宿主自身模型目录(`ctx.catalog.model.list()`,每 60s 刷新)读取的 context-window / max-output,并以 runtime-info 上报给代理(#955)—— 压缩走插件模式,**不做** wire 级工具注入;原生 auto-compaction 自动关闭(`compaction.auto: false`)。所有注册都是防御式的(可选链):任一 2.x build 上接缝缺失或未触发时,插件保持惰性,会话透明回退纯代理模式而不是报错 —— 在相邻的 `dev` build 上观察到过 API 面互不相同(#754 评审探针)。

1.x 细节(1.14.46 + 1.18.31 验证):V1 `.server()` 钩子在进程内把每个 provider 的 `options.baseURL` 改写为 `<proxy>/bili/…` 并设 `compaction.auto: false`;`chat.headers` 每次请求盖章插件头;`tool` 用真实 zod 形状注册 bili 工具(zod 是运行时依赖 —— 解析不到时降级为只改写)。没有显式 `baseURL` 的 provider(SDK 默认值,如裸 `@ai-sdk/openai` → api.openai.com)由全局 `fetch` 补丁兜住(日志:`v1: fetch patch installed`)—— 幂等,`/bili/` 包装过的 URL 原样直通;含 OpenAI Responses 端点端到端验证。

### 原生(免启动器)—— `bili plugin install opencode`

在真实 opencode 配置里注册一个自拉起插件并设 `compaction.auto: false`,之后直接跑 `opencode` 即可。默认不加 MCP 面(原生插件已提供会话绑定的 bili 工具);需要就传 `--with-mcp` —— 该条目不带 origin 钉扎,能扛过插件临时端口的代理重启(#926)。条目形态取决于**本 bili 自身的安装来源**:**npm 安装**写裸包名(`"plugin": ["billion-context"]`)—— 包经 `exports["./server"]` → `dist/agent/opencode-native.js` 暴露插件入口,opencode 用自己的 Npm.add 机制加载、自行管理安装与升级;零绝对路径、可跨机。(这个裸包名条目也可以不经 bili 直接手写进配置 —— 见方式 1。)**git checkout / 开发构建**回退到本机 shim 目录(`<configDir>/plugins/billion-context/index.js` → 该 checkout 的 `dist/agent/opencode-native.js`)—— 按构造即机器本地;之后改用 npm 安装再跑一次 install 会把条目迁回裸包名。

加载时插件自拉起自己的代理(健康的已有实例直接复用不重复起;父进程 pid 看门狗在 opencode 退出时收掉它),把模型流量路由到 `<proxy>/bili/<upstream-url>`,暴露与启动器模式相同的原生 bili 工具 —— 无固定端口、无环境变量、免启动器。退出:`BILI_NATIVE_OPENCODE=0`。若没有任何代理能拉到健康状态,请求直连(不压缩)并给一次性告警,之后自动恢复。在 `bili opencode` 启动下该条目整体跳过(代理归启动器管)。

### 纯代理(无插件)

与其它客户端一样,把 provider baseURL 指向代理:

```json
{
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:8787/bili/http://upstream.example/v1",
        "apiKey": "sk-any"
      }
    }
  }
}
```

注意:2.0 AI-SDK provider 即使本地端点从不校验也要求 `apiKey` 字段 —— 随便填个非空值。

### 状态:`/acp` 与 `acp_status`

`/acp` 面板在所有模式下都绑定当前会话,`acp_status` 工具是其宿主内等价手段。在命令编辑器支持新增条目的宿主(2.0.x 稳定版,`editor.add`)上,V2 插件额外注册 `/acp` 斜杠命令 —— 以合成非模型消息渲染,面板优先(与 `acp_status` 工具一致);旧形状上该注册保持惰性。注意 `opencode run` 模式完全不派发斜杠命令(它们会透传给模型)—— 请用 TUI。

### 旧 opencode-acp 会话(#920)

在 1.x 宿主上,迁移前的 [`opencode-acp`](https://github.com/ranxianglei/opencode-acp) 旧会话在两条泳道下都继续可用:启动器从临时配置副本中移除 `opencode-acp` 条目(宿主永远不会以激活状态加载它),各泳道把已安装的包作为库吸收(直接从 `node_modules` 导入 —— `.opencode/node_modules`、项目 `node_modules`、全局 npm root、opencode 配置级 modules,先到先得)。会话属于 legacy ⟺ opencode-acp 的持久化状态文件存在(`<XDG_DATA_HOME>/opencode/storage/plugin/acp/<sessionID>.json`,或 `acp.jsonc` 中 `storagePath` 指定的目录):

- **旧会话** —— 压缩由被吸收的 opencode-acp 执行(它自己的引用号与块存储照常工作:`compress` / `decompress` / `search_context` / `acp_status` / `acp_context_recap` 全部在它里面执行)。其模型请求带 `x-bili-plugin-bypass: 1`,代理原样转发 —— 不注入 wire 工具、不注 nudge、不绑定会话。
- **新会话** —— bili 接管:工具调用转发到代理的 plugin 端点(plugin 模式)。执行器按会话分泳道:新会话的 `compress` 发到代理,旧会话的发给 opencode-acp。`acp_context_recap` 没有代理端对应 —— 新会话调用会收到代理的 unknown-tool 消息。

`/acp` 与 `/dcp` 同样路由。新会话被 opencode-acp 注册表收编的可能被其 transform 门控(system / messages / text.complete 都过 legacy 谓词)阻断。退化路径:包缺失、导入失败或不是 v1 时,bili 单独运行,旧会话退化为只读存档(旧标签照常渲染、`decompress` 返回 `[Block … not found]`、新引用号从 m00001 重新开始)。

### 注意事项

- 2.x 系列以 npm 包 `@opencode/cli` 发布,且插件 API 面在不同 build 间仍在变动(相邻 `dev` 通道构建暴露不同 `ctx` 形状)—— 上文钩子/工具细节是针对具体版本的观察,不是稳定契约。
- 设计说明:V2 插件是薄协议客户端(不含 acp-kernel)—— 代理始终是唯一的压缩权威,消除 agent 与代理间的内核版本漂移;它不依赖插件 API 无法改上下文这一事实(该能力随 2.x build 变化)。

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

默认绑定 `127.0.0.1`，只接受本机连接。要给其他机器上的 agent 用，绑定非 loopback 地址:

```bash
bili --host 0.0.0.0           # 所有网卡(或直接用局域网 IP)
```

- 远程 agent 把模型 `baseURL` 指向 `http://<本机IP>:<端口>/bili/…`。
- MITM 模式的 `CONNECT` 也会接受远程客户端 —— 但仅限**白名单内的模型域名**;
  到任意主机的盲隧道仍仅限本机，代理不会沦为开放中继。
- **没有任何鉴权**: 只应在可信局域网或防火墙内使用。`/__bili/` 管理
  端点仍仅限本机访问。
- 启动时的 `[security]` 警告会提醒上述事项。


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

完整的配置参考 —— 配置文件位置、顶层键、providers、压缩调参、环境变量 ——
见 **[CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md)**。

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
- **按 URL 的 `proxy`** 对匹配的 provider URL 优先级最高。
- 其余优先级为:`BILI_UPSTREAM_PROXY` → Web UI 手动代理 → 顶层 `proxy` →
  `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` → Windows 系统代理 → 直连。
- 空字符串 `""` 表示**明确直连**(覆盖并禁用)。
- 自动模式会让环境/系统 fallback 遵守 `NO_PROXY` 与 Windows 绕过列表。
  指回 bili 自己本地端口的代理会被跳过或拒绝,防止自环。
- 支持 HTTP 和 HTTPS 代理 origin。SOCKS5（`socks5`/`socks5h`）暂不支持：显式
  的 `BILI_UPSTREAM_PROXY` / 配置 `proxy` 使用此类 scheme 会在启动时报出可操作
  的错误；环境变量/系统代理（`HTTPS_PROXY` 等）使用此类 scheme 时会被忽略并打
  一次警告日志（流量随后回退为直连）。Clash/mihomo 用户请改用同一 mixed 端口
  的 HTTP 形式（如 `http://127.0.0.1:7890`）。
- 两条出站路径都覆盖:`/bili/` 路径模式(fetch)和 MITM CONNECT 隧道(代理连接真实上游的链路走 HTTP CONNECT 代理)。

环境变量覆盖:`BILI_UPSTREAM_PROXY=http://127.0.0.1:20172`(优先于配置文件)。
Windows 下会自动发现常见 Clash/Mihomo 静态系统代理;Web UI 会显示实际来源,
以及 Internet Settings 中检测到的 PAC URL。

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

### Windows：把会话目录加入杀软排除项（#362）

代理把每个会话的压缩状态持久化到会话目录（默认 `%USERPROFILE%\.local\share\billion-context\`），长会话每一轮都会重写该文件。在 Windows 上，实时杀毒（Windows Defender）、搜索索引器或同步工具（OneDrive）可能在写入中途锁住该目录，导致 rename 以 `EPERM` 失败，在锁解除前该会话的每次持久化都会失败。

当同一会话连续 N 次写失败（默认 `5`）时，代理会打一条一次性、可操作的告警，明确指出要排除的目录。要从根上修复：把 `%USERPROFILE%\.local\share\billion-context\` 加入杀软**排除项**（Windows Defender：设置 → 病毒和威胁防护 → 管理设置 → 排除项 → 添加排除 → 文件夹），并确认没有同步工具（OneDrive / Dropbox / …）在同步该路径。完整步骤见 [CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md) 的「Windows：把会话目录加入杀软排除项」章节。

## 状态

早期。协议处理和压缩已通过 mock 测试(500+ 项通过)。真实模型集成测试是下一里程碑。预期会有粗糙的地方。

针对 pi / omp / opencode 的客户端插件随 `billion-context` 一起发布(`dist/agent/*.js`),用于协作代理路径。三者(`billion-context`、独立的 `billion-context-pi`、`opencode-acp`)如何取舍,见上文「该选哪个?」一节。

## 社区

QQ 群 —— 三个项目共用一个群（[`billion-context`](https://github.com/ranxianglei/billion-context)、[`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)、[`opencode-acp`](https://github.com/ranxianglei/opencode-acp)）：**1056132097**

## 许可证

MIT
