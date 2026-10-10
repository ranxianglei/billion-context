# 客户端集成详解

[README 快速上手](README.zh-CN.md#快速上手)里一行带不过来的客户端细节都在这里:各模式(启动器 / `/bili/` URL 前缀 / 原生插件)如何把流量接进代理、往哪儿写了什么、已知局限有哪些。只想知道「该敲哪条命令」的话,从 [README](README.zh-CN.md) 开始 —— 这个文件是给「行为不对劲、想知道为什么」的场景准备的。

---


## dsh(deepseek-harness)

两条通道，同一个插件(#941):

- **启动器:** `bili dsh` 经 `--patch` overlay(`~/.dsh-bili/.bili-acp.patch.yml`)注入完整原生插件 —— 每个 profile 启动即注册 bili 工具，模型请求盖 `x-bili-plugin` + dsh 会话 id(plugin 模式)，`/acp` 会话绑定。同一份 patch 同时禁用 dsh 原生自动压缩(`compaction-basic` → `auto: false`);手动 `/compact` 仍可用。
- **Profile 安装(免启动器)——统一泳道(#966):** `bili plugin install dsh` 对每个已存在的 profile 执行 `dsh plugin --profile <name> add billion-context` —— pnpm 把包装进各 profile 自己的 `node_modules`,dsh 自动挂载包内 patch 层(`dsh.bundle.patch.yml`)。装哪个源取决于 bili 自身的安装形态(#925):npm 安装传注册表名,checkout/dev 构建传绝对路径(`link:` 依赖,本地改动实时生效)。旧版受管块(`# bili begin` / `# bili end`,#966 之前的安装所写)在安装与卸载时都会被剥离 —— 用户条目与注释保留,清空的文件还原占位 `[]`。先在每个 profile 里跑过一次 dsh 让目录存在。插件加载时自拉起代理(已有健康实例则附看，不重复拉;父进程 pid 看门狗)，经全局 fetch 补丁把模型流量改写为 `<proxy>/bili/<上游URL>`，原样注册清单工具，并按工具就绪门控 plugin 模式头(第一轮走 wire 模式)。退出开关:`BILI_NATIVE_DSH=0`。卸载:`bili plugin remove dsh` 或 `dsh plugin --profile <name> remove billion-context` —— 两者走同一通道。经注册表安装要求 npm 上已发布含 `dsh.bundle.patch.yml` 的版本;请装 npm 形态 —— 直接填 GitHub 地址装到的是没有 `dist/` 的源码(入口悬空、dsh 静默跳过该 bundle;安装期守卫现在会响亮失败并给出正确装法,#2471)。若 add 后 dsh 启动即报 `billion-context/dsh` 的 `ERR_MODULE_NOT_FOUND`,说明 profile 从陈旧的包元数据缓存里解析到了不含 bundle 子路径导出的旧版本(#953)——固定版本重装:`dsh plugin --profile <name> add billion-context@latest`。
- **桌面应用(Electron 宿主):** 同一插件也运行在 deepseek-harness **desktop** 应用内(经其应用内插件管理器安装)。此时 bootstrap 在应用进程内拉起代理:该进程的 `process.execPath` 是 Electron 二进制而非 Node,GUI 的 PATH 又不含常规安装目录 —— `resolveNodeRuntime`(#819/#1429)先探测众所周知的安装位置(`/opt/homebrew/bin`、`/usr/local/bin`、Volta 等),再回退到以纯 Node 方式运行应用自身二进制(`ELECTRON_RUN_AS_NODE=1`,强制注入子进程 env),于是无需 PATH 里有独立 Node 也能零配置压缩;设 `BILLION_CONTEXT_NODE` 可强制指定某个 Node(优先于两者)。#1429 之前该路径在 spawn 前抛错,所有会话静默降级为直连(不压缩),只能从 bili.log 里发现。
- **自动更新保持各 profile 同步:** 刷新有两个触发器 —— 全局自更新完成后,以及**profile 自己的代理**在周期检查里发现注册表有新版本时(全局 bili 从不运行也一样刷新,#1196 —— 插件市场安装的用户往往根本没有全局安装)。两种触发器都扫描 `~/.dsh/profiles/*/package.json`,把注册表钉住的 `billion-context` 依赖刷新到目标版本(全局触发器刷到新全局版本,自触发刷到注册表最新),统一经 dsh 自己的 `plugin add` 通道,绝不在位覆盖 —— 加载的插件与代理从此不再漂移(#953);钉在本地源的 profile 不动。刷新是尽力而为,失败下个周期重试,绝不会让代理或更新本身失败。
- **已报告:Profile 安装下部分传输零代理流量(#1158,调查中):** dsh `llm-pi-ai` 层的部分传输服务会话**从未有任何模型请求到达代理**(日志无 `processTurn`,调用 bili 工具返回 404 "no model request has arrived"),而同宿主的其他 provider 正常。根因仍在用运行时证据定性 —— 候选:传输层 fetch 形态(SDK 注入 fetch / 非全局 dispatcher)或宿主侧归属缺口导致流量未被 takeover gate 认领。检测:此类情况会打一次性 `[plugin] NO MODEL REQUESTS seen for conversation …` 告警,dsh 插件还会把归属 gate 放行的每个端点各记一条日志(每进程一次)。期间可靠规避:改用 `bili dsh` 启动 —— 启动器的 settings overlay 会把那些 provider 的 `baseURL` 重写为 `/bili/` URL,无论传输层使用哪种 fetch、归属状态如何,流量都必然过代理。
- **Web profile 说明(#1772,#2474 修正):** 当 profile 的 bundles 含 `@deepseek-ai/dsh-web-app` 时,真正运行的 `compaction-basic` 实例位于 agent preset(`preset-standard.config.plugins`)内部 —— dsh 的 patch 引擎只按 id 索引顶层条目与真 group(`group: true` 且 config 为数组)的子项,preset 内的嵌套行任何 patch 层都无法**按 id 直寻**。于是 bundle 里的 `auto: false` 落在 web-app 已禁用的宿主平面行上,preset 实例保持自动压缩开启。但 `preset-standard` 本身是 bundle 层的普通顶层条目:profile 层 patch(你 profile 自己的 `cordis.patch.yml`,在所有 bundle 之后生效)可用同 id + **完整快照** `config` 整体覆盖它 —— 从 `dsh --profile <name> --dump-config` 抄下完整的 preset config,在其 `compaction-basic` 行下加 `config.auto: false`,把结果追加进 `cordis.patch.yml`。Config 替换是**整体语义**(片段会静默丢掉一切未重述的键 —— 不只是其他插件,连 preset 自己的 `id`/`order` 身份也会丢,可能使 roster 无法识别该 preset);`- insert:` 同 id 则是在末尾追加一条死行而非合并。dsh 升级 preset 后快照冻结 roster、需重抄一次。此类 profile 启动时插件打一条一次性 `[dsh-client]` 告警并给出该配方;ACP 压缩不受影响。

`bili dsh` 启动下插件**附看**(attach)启动器的代理(不二次拉起)。裸上游 URL 与 spawn 模式一样重写为 `<proxy>/bili/<url>`(回环代理目标永不被代理 env 拦截，等于直接绕开 MITM)；已经路由的 `/bili/` 前缀请求原样放行、只盖章。已知局限:手动 `/compact` 没有 dsh 侧事件钩子，其边界交给内核的自然 ingest diff(非 web profile 下自动压缩已关，影响罕见;web profile 见上方 #1772 说明)。

## Kimi Code(Moonshot)

三种对齐模式:`bili kimi`(启动器,证书 MITM —— README 快速上手 方式 2)、`/bili/` URL 前缀,以及原生插件模式(`bili plugin install kimi`,#963)。Kimi Code v2 的插件体系是纯声明式的(`kimi.plugin.json`:MCP server、hooks、skills —— 没有进程内 JS 执行),所以 bili 无法像 pi/opencode/dsh 那样补丁客户端的 fetch 栈。取而代之,插件带两个小型 node 脚本,在客户端外围完成工作:

- **安装:** `bili plugin install kimi` 写 `$KIMI_CODE_HOME/plugins/managed/billion-context/kimi.plugin.json`,声明一个 stdio MCP server(`node <root>/dist/kimi/native-mcp.js`)加一个 `SessionStart` hook(`node <root>/dist/kimi/bootstrap-hook.js`,超时 30 s),并在 `$KIMI_CODE_HOME/plugins/installed.json` 注册该插件。安装器要求 `kimi --version` ≥ 2.0.0,低于此版本拒绝安装(启动器模式不受影响)。卸载:`bili plugin remove kimi`(managed 目录 + 注册表记录 + 配置还原)。
- **每会话自举:** kimi 为每个会话把 MCP server 作为直接子进程拉起;启动时它先附上健康的现有代理(`BILLION_CONTEXT_PROXY`),否则在临时端口自拉起一个,然后用幂等的逐行受管块改写 `~/.kimi-code/config.toml` 的路由:自有 provider `[providers.bili]`(`base_url = http://127.0.0.1:<port>/bili/<上游>`,原样克隆当前 provider 的 `oauth` / `api_key` 引用)、`[models.bili-kimi]` 别名、顶层 `default_model` 重定向(原值记录在块内)。原文件一次性快照到 `config.toml.bili-bak`;每次写入都在 mkdir 锁文件下进行,块外的用户内容绝不被触碰。Kimi 的配置热重载会把变更应用到存活会话。`SessionStart` hook 机会性地跑同样的自举(仅 attach —— 永不拉起代理);它的非阻塞竞态在设计上被容忍:第一轮可能走直连/wire 模式,不变量是绝不把 `base_url` 指向死端口。
- **Plugin 模式盖章:** 只有当 ACP 工具清单已在存活代理上验证通过后,块里才会写入 `custom_headers = { x-bili-plugin = "kimi" }` —— 此前流量走 wire 模式。由于 `custom_headers` 按 provider 静态生效,无法承载逐请求的窗口/模型头(会在模型切换后过期),所以 runtime-info 上报只在自举时发生(客户端配置里有模型 + 上下文窗口 + 最大输出就一并上报)。
- **看门狗与生命周期:** MCP 子进程每 30 s 探测一次代理。attach 模式下永远等待(绝不碰用户自己的代理);spawn 模式下代理死亡则重新拉起并把路由改写到新 origin。恢复失败时移除受管块,让流量退回直连上游而不是打到死端口。会话结束时 kimi 杀掉 MCP 子进程,父进程 pid 看门狗随之收掉拉起的代理。多个并发 TUI 共享第一个拉起的代理;它消失后其余会话自动重新拉起并改路。
- **已知局限:** 子代理会话各自得到独立的派生代理会话(kimi 不暴露稳定的会话 id;工具调用经每次调用的 `conversation_id` 参数绑定);kimi 的原生自动压缩**没有**被推后 —— ACP 压缩只是先触发,与启动器模式一致。退出开关:`BILI_NATIVE_KIMI=0`。

## Gemini 系(Gemini CLI / iFlow CLI / Qwen Code / Antigravity)

面向 gemini-cli 架构家族的四个启动器(#1043 第一梯队)。四者中三个有 base-URL 环境变量钩子,一个没有:

- **`bili gemini`** —— Gemini CLI(`@google/gemini-cli`)。设置
  `GOOGLE_GEMINI_BASE_URL=<proxy>/bili/<upstream>`(默认上游
  `https://generativelanguage.googleapis.com`;如果你自己导出了
  `GOOGLE_GEMINI_BASE_URL`,该值会被中继经过代理)。客户端切换到
  `gateway` 认证模式,把 Google 原生 wire 请求直接发给回环代理 —— 无 MITM、
  无需装 CA,`~/.gemini` 零改动。代理本身原生支持这条 wire(模型名在 URL
  path 里)。局限:headless `-p` 运行需要已保存的认证选择(例如 settings 里
  `security.auth.selectedType = "gemini-api-key"` + `GEMINI_API_KEY`),因为
  gemini-cli 在非交互模式下拒绝纯环境变量推导的 gateway 认证;使用 OAuth
  个人登录(CodeAssist)的用户完全不走这条路 —— 该路径无视 base-URL 钩子。
- **`bili iflow`** —— iFlow CLI(`@iflow-ai/iflow-cli`)。同样的模式,走
  `IFLOW_BASE_URL`(默认 `https://apis.iflow.cn/v1`,你设置过则中继);
  OpenAI chat-completions wire。
- **`bili qwen`** —— Qwen Code(`QwenLM/qwen-code`)。这个 fork 移除了
  base-URL 钩子(`DASHSCOPE_PROXY_BASE_URL` 只是头部调优旋钮,不是路由),
  但它遵循标准代理环境变量,所以启动器走证书 MITM:`HTTPS_PROXY=<proxy>` +
  `NODE_EXTRA_CA_CERTS=<bili CA>`,并把默认模型主机(DashScope / Qwen 网关 /
  常见第三方端点)静态加白。自建中转主机用 `--mitm-domain <host>` 追加。
   尽力而为的路由 —— 日志里出现 `BLIND TUNNEL WARNING` 说明有主机没进白名单。
- **`bili antigravity`** —— Google Antigravity(#2115)。启动器驱动官方 CLI
  二进制 **`agy`**(Gemini CLI 的继任者,Gemini CLI 已于 2026-06 退役;在
  `PATH` 或 `~/.local/bin/agy`,Windows 为 `%LOCALAPPDATA%\agy\bin`)。其模型
  通道在闭源 Go `language_server` 内部,该进程遵循一个**未公开的**
  `CLOUD_CODE_URL` 环境变量覆盖(已在 v2.19.1 二进制中验证:*"Overriding
  CloudCodeServerURL via CLOUD_CODE_URL environment variable"*),形态与
  gemini-cli 的 base-URL 钩子相同。启动器设置
  `CLOUD_CODE_URL=<proxy>/bili/<upstream>`(默认上游
  `https://cloudcode-pa.googleapis.com`;如果你自己导出了 `CLOUD_CODE_URL`,
  该值会被中继经过代理)。无 MITM、无需装 CA。代理**按 path 识别 wire**:
  `:streamGenerateContent` / `:generateContent` / `:countTokens` 请求走
  Google 原生适配器,与 `bili gemini` 一样被压缩。若服务端改用 gRPC 方法
  path(`/google.internal.cloud.code.v1internal.CloudCode/*`),这些请求不被
  识别、原样透传不压缩 —— 属优雅降级,确认后可用按 lane 的 `protocol`
  声明(#1909)修复。若 Google 将来移除该环境钩子,退路是证书 MITM:
  language_server 遵循 `HTTPS_PROXY` 且不锁定证书,把
  `cloudcode-pa.googleapis.com` 加进 `"mitm".domains` 并信任 bili 根 CA
  即可。桌面端与 IDE 扩展共用同一条 language_server 通道;启动器只驱动
  CLI —— 桌面用户可手动导出 `CLOUD_CODE_URL`,或直接用上面的 MITM 配方。

四者都没有 native 模式:均无环内工具注入接缝(gemini-cli 扩展只到自定义命令,
fork 继承同一面;Antigravity 自带用户插件系统 —— `plugins/<name>/` 下的
`plugin.json`、`hooks.json`、`mcp_config.json`、`skills/`、JS sidecar ——
但每个面都只能追加:工具、提示词、UI、事件回调,没有任何一个能拦截或改写
模型请求/响应流,那条流完全留在闭源 language_server 内部,所以 wire-only
是 v1 的上限)。按设计保持 launcher-only。

## Hermes（Nous Research）

三种对齐模式:`bili hermes`(启动器,证书 MITM —— README 快速上手 方式 2)、`/bili/` URL 前缀、原生插件模式(`bili plugin install hermes`,#958)。hermes CLI agent 的插件 API 只有 Python(`desktop/plugin.js` SDK 属于另一个 Desktop app),所以原生插件是随 npm 包分发的一个纯标准库 Python 模块:

- **安装:** `bili plugin install hermes` 把 `plugin.yaml` + `__init__.py` 拷进 `~/.hermes/plugins/billion-context/`,写一个机器自管的 `bili.json` sidecar(指向全局 bili 安装的 `dist/index.js` + node 路径),并经 hermes 自己的通道启用插件(`hermes plugins enable billion-context` —— CLI 不在 PATH 上时改为打印同一条命令)。新开一个 hermes 会话生效。卸载:`bili plugin remove hermes`;全局更新后刷新:`bili plugin update hermes`。
- **生命周期:** 加载时插件先附着到健康的运行中代理,否则在临时端口自拉起(父进程 pid 看门狗在 hermes 退出时收掉它;并发启动走与启动器相同的 starting-marker 仲裁协议)。只有代理确认健康后,才用 `HTTPS_PROXY` / `https_proxy` + `SSL_CERT_FILE`(bili 组合 CA bundle —— 当前 hermes 经此解析环境信任;`HERMES_CA_BUNDLE` 保留给旧版本)把 hermes 的 httpx 栈指向它 —— **从不改动** `~/.hermes/config.yaml`。provider 的 https 域名从 hermes 配置读出并加入 MITM 白名单;其余域名与启动器模式一样盲隧道。拉不出健康代理时插件静默退场,流量直连(不压缩、无死端口)。
- **Plugin 模式盖章:** `llm_request` 中间件打 `x-bili-plugin: hermes` + 会话 id(= hermes session id,gateway 多会话安全)+ 模型,已知后再加 `x-bili-plugin-max-output` —— 且只在 ACP 工具已对着存活代理清单注册完之后;第一轮走 wire 模式。`pre_api_request` hook 捕获生效的 `max_tokens`,把 runtime-info(模型 + 最大输出)推给代理。`compress` / `decompress` / `acp_status` 注册为真正的 hermes 工具,由代理既有的插件端点提供。
- **已知局限:** 走 hermes Codex-wire 传输发出的请求可能丢掉逐请求头面,这类配置在该传输暴露头之前停留在 wire 模式。`BILLION_CONTEXT_PROXY` 已设置(启动器管着代理)或定义了 `BILI_PROVIDER_REWRITES` 时插件整体退场。退出开关:`BILI_NATIVE_HERMES=0`。

## ZCode（Z.ai / bigmodel coding plan）

三种对齐模式:`/bili/` URL 前缀、GUI「设置 → 网络」证书 MITM(HTTP 代理 + 根 CA 路径)、原生插件模式(`bili plugin install zcode`,#1145)。ZCode 的扩展面是 Claude-Code 形状但纯声明式:`~/.zcode/cli/config.json` 里的用户级 hooks 与 stdio MCP server,没有进程内 JS 接缝。所以原生通道随包带两个小 node 脚本,在客户端外围干活:

- **安装:** `bili plugin install zcode` 写 `~/.zcode/cli/config.json`:置 `hooks.enabled = true`、追加一条 `SessionStart` process hook(`node <root>/dist/zcode/bootstrap-hook.js`)、注册 stdio MCP server `mcp.servers.bili`(`node <root>/dist/zcode/mcp-entry.js`)。已存在的用户自有 `mcp.servers.bili` 条目**绝不覆盖** —— 安装器会响亮地拒绝。安装时不冻结任何 URL;路由按会话发生。卸载:`bili plugin remove zcode`(只剥离 bili 自己的条目、由 bili 启用的 `hooks.enabled` 予以还原、provider store 从快照恢复)。
- **卸载后的已开会话(#2155):**`bili plugin remove zcode` 无法触及已开着的客户端窗口 —— 它们的 MCP 子进程已死,但代理侧的会话绑定(session metadata)仍在。这类僵尸会话在连续 5 轮“有 nudge、无插件头、线上无 bili 工具、零压缩”后被检测到,随即**自愈降级为代理模式** —— ACP 工具改由代理线上回注、压缩重新由代理接管(nudge 保留)。若线上注入不可用(`compress.injectTool=false`)则改为静默 nudge,直到出现一次压缩缩减自动解除。插件头重现(客户端重启/重装)即在同一请求内恢复 plugin 模式。remove 命令在近 10 分钟内见过活跃会话时会打印提示;web UI 会为这类会话挂“自愈”徽标。
- **每会话自举:** 每个 ZCode 会话把 MCP 子进程作为直接子进程拉起;启动时附着到健康代理(`BILLION_CONTEXT_PROXY`)或在临时端口自拉起,然后在 mkdir 锁文件下对生效的 provider store 做幂等 JSON 手术:每个可路由 provider 条目的 `baseURL` 变为 `http://127.0.0.1:<port>/bili/<上游>`(你设的自定义 baseURL 原样保留在包装之内)。两代 store 都处理:legacy `~/.zcode/v2/config.json`(`provider.<id>.options.baseURL`)与 v3.14+ personal store `~/.zcode/v2/provider_config.json`(`config.providerConfigRules.providerRules[].config.api.baseUrl`)—— 两者并存时以新 store 为准(其中哪些条目路由、哪些被跳过见下方路由范围)。原始文件按每次用户编辑快照到 `<file>.bili-bak`(快照永远反映你最后一次真实状态,绝不记录 bili 自己的写入);其余所有键逐字节保留。旧世代客户端在启动时加载 provider 配置 —— 安装后重启一次 ZCode;新版构建可在会话中途感知路由变化(约 1 s 轮询)。`SessionStart` hook 机会性地跑同一套自举(仅附着 —— 绝不 spawn);它的非阻塞竞态被设计为可容忍:第一轮可以走 wire 模式,不变量是 `baseURL` 永不指向死端口。
- **Plugin 模式盖章:** MCP 子进程对着存活代理清单核验 ACP 工具列表之后,才给路由条目加 `headers["x-bili-plugin"] = "zcode"` —— 此前流量走 wire 模式。工具调用经每次调用的 `conversation_id` 参数绑定(#760)。
- **清洗什么、绝不动什么(统一 ACP 不变量):** 模型正文中 bili 渲染标签回声 / marker 行 / 退化残骸可在传输中被剥离;**思考通道**(anthropic `thinking`、google `thought`、openai `reasoning_content`/`reasoning`、responses reasoning summaries)、**工具调用参数**(模型写往文件的内容)与**用户消息**逐字节原样透传。
- **路由范围(#1622):** 原生模式包装**每一个**有可用 http(s) `baseURL` 的 provider 条目 —— 与进程内原生(pi/dsh)的「所有 provider 都吃压缩」语义一致 —— 而不是只包 bigmodel coding-plan 账号。无法安全包装的条目会被跳过并记录原因,而非静默丢弃:
  - **客户端签名账号(#1621):** v3.14+ personal store 上的 coding-plan 账号保持直连(见已知局限);其余 provider 照常路由。
  - **环回目标(#809):** http 环回 `baseURL`(localhost / 127.x.x.x / ::1)永不二次代理 —— 包装它会把 bili 叠在自己或你自己的本地中继上。
  - **`direct` 豁免:** `providers` 表(以上游 URL 为键,见 CONFIGURATION.zh-CN.md)里声明 `"direct": true` 的路由保持直连 —— 任何 lane 都能遵守的同一套豁免机制。
  通道把代理拉在自管端口区(#1660):基准口 `18787`,每 lane 粘性记录(自动跟随历史上的 +1 阶梯漂移),碰撞由子进程 +1 阶梯解决,漂移时共享 store 改写到存活 origin —— 即使没有交接,包装也能跨会话重启存活。`BILI_ZCODE_PORT` 钉死一个确切端口(严格模式:占用者被大声拒绝,不跳口)。`BILI_ZCODE_ROUTE`(`plans`/`none`)是兼容逃生舱;`BILI_ZCODE_SIGNING_FIXED=1` 在 ZCode 发布签名修复后关掉 #1621 跳过。
- **看门狗与生命周期:** MCP 子进程每 30 s 探测一次代理。attach 模式下永远等待(绝不碰用户自己的代理);spawn 模式下代理死亡则重新拉起并把路由改写到新 origin。恢复失败时移除受管改写,让流量退回直连上游而不是打到死端口。会话结束时 ZCode 杀掉 MCP 子进程,父进程 pid 看门狗随之收掉拉起的代理;MCP 子进程退出前(SIGTERM/SIGINT/正常退出)在锁下交接:若共享 provider store 仍指向它自己的代理,优先改写到另一个存活兼容实例,没有则移除受管改写退回直连(#1623)——实例死后共享配置不留死端口。看门狗每个 tick 同时检查共享 store:若残留着其他实例的死端口(硬杀场景,上述交接没跑成——如 Windows TerminateProcess 跳过 JS handler),接管修复(优先改到存活实例,否则回退直连);只在 store 指向死端口时动手,绝不从存活实例手里抢路由。多个并发会话共享第一个拉起的代理;它消失后其余会话自动重新拉起并改路。边界:ZCode 按会话缓存 provider baseURL,上述修复只对「之后的新读取」(新会话/新查询)生效,在途会话仍会重试缓存的旧端口直到重读;要结构性规避,把 `BILLION_CONTEXT_PROXY` 钉到一个常驻代理(`bili start`)让所有会话 attach 上去(attach 模式绝不碰用户自己的代理)。
- **已知局限:** ZCode 的反欺诈指纹(#661)作用于 `zcode.z.ai` 登录流量的 MITM 重建 body —— 原生模式不碰那个面(模型流量走 provider store,不走 GUI 代理);若你同时使用 GUI 代理/MITM 配置,请保留 `"mitm://zcode.z.ai": { "passthrough": true }` 路由。v3.14+ 构建上,coding-plan 账号的 ClientRequestSigningV4 在模型创建阶段拒绝非 HTTPS origin,且其握手路径只从 origin 派生(丢弃任何 /bili/ 前缀),因此 /bili/ 包装的 baseURL 会以 "Client signing handshake requires HTTPS." 失败(#1621)。该冲突硬编码在 ZCode 侧,原生模式把这些账号**逐条跳过** —— 记录原因、这些账号保持直连;在这些账号上请用 GUI 证书 MITM 配置获得压缩能力,直到 ZCode 发布签名修复,届时设 `BILI_ZCODE_SIGNING_FIXED=1` 即可恢复路由。默认 `route:"all"` 下只有这些账号被跳过 —— store 上其余 provider 继续路由;整体退场(路由全关)只在 `route:"plans"` 下发生,因为那里 plan 账号本身就是签名账号。pre-3.14 legacy-store 客户端不受影响。`BILLION_CONTEXT_PROXY` 已设置(attach 模式管着代理)或定义了 `BILI_PROVIDER_REWRITES` 时插件整体退场。退出开关:`BILI_NATIVE_ZCODE=0`。

## Codex(OpenAI Codex CLI)

**窗口对齐。** 客户端 plugin/runtime 上报及启动器传递的窗口优先于发布时的 Codex 模型表。没有上报时，本机代理只读其 `CODEX_HOME`（默认 `~/.codex`）下的 `models_cache.json` 和基础 `config.toml`，将 `model_context_window` 限制在匹配模型的 `max_context_window` 内，再应用 `effective_context_window_percent`（Codex 默认 95）；后续请求会跟随缓存更新。元数据缺失、不可读或无效时，保留内置表及未知模型 272K 的既有回退。远程代理或其他客户端 profile 应通过现有启动器/runtime 机制传递实际窗口，或设置既有的 `compress.modelContextLimit`；代理本机缓存不能证明另一台机器的配置。输出预留仍正常生效。

Codex 是唯一一个插件安装无法自给自足的客户端。接缝矩阵可以解释:claude 有 SessionStart hook + 受管 settings 块,zcode 有可改写 `baseURL` 的 provider store —— codex 两者都没有。它的模型流量只能经环境变量路由(`HTTPS_PROXY` / `SSL_CERT_FILE` —— `bili codex` 正是这么做的);默认 ChatGPT-登录 provider 没有可改写的配置缝,managed `model_providers` 块会强制 `env_key` API-key 认证、**废掉订阅登录**;而 MCP 子进程无法向父进程注入 env,所以插件永远路由不了 codex 本体流量。三种姿势:

| 姿势 | 你能得到什么 |
|---|---|
| `bili codex`(启动器) | 全功能零配置:自管 lane 代理(#1660 端口区,粘性口)+ 注入 codex 的证书 MITM env —— 工具与压缩兼得 |
| `bili plugin install codex` + 在跑的 bili + 自行导出 `HTTPS_PROXY` | 自己管 env 的 power user:工具 + 压缩 |
| 只装 `bili plugin install codex` | codex 里出现四个工具但没有对话被代理、无话可操作;全不可达时 `tools/list` 报 -32003(`bili proxy unreachable … — start bili or set BILI_MCP_PROXY`) |

安装写入 `~/.codex/config.toml` 单个 `[mcp_servers.bili]` 块(command = node,args = dist/mcp.js)。#1660 去掉了安装时烘焙 origin(#403:烘焙的 URL 在漂移/重启后变成死端口,工具永远指向它);shell 在会话启动时解析代理 —— env `BILI_MCP_PROXY` > 活实例登记(任一 lane 的代理,或 `bili start` 守护)> 8787 用户区默认 —— 漂移或重启后绝不残留死 URL,shell 直接附着到活着的那个。会话绑定是 headless 的:启动器在 spawn 时传 `BILI_CONVERSATION_ID`,插件 shell 否则绑定下一个新会话;逐调用的 `conversation_id` 覆盖与其他客户端一致(#760)。Codex ≥0.160 还在每次 `tools/call` 的 `_meta.threadId` 里盖上真实 thread id;shell 按调用消费(严格校验、绝不写回 spawn 时的全局绑定),优先级高于过期的 `BILI_CONVERSATION_ID` 残留与模型抄写的 `conversation_id`(#2024)。

**Responses 原生链式(一个坑)。** bili 靠重放完整 `input` 来压缩,因此无法跟随 OpenAI 原生的 `previous_response_id` 链式续传:只带增量的续传请求会在上游丢失之前的轮次,却仍返回 200。对 codex 而言今天这不是问题 —— 观察到的构建都发 `store:false` 且从不设置 `previous_response_id`(是观察不是证明;E2E 未覆盖该形态)。若你把走原生链式的 Responses 客户端指向 bili,要么重发完整 input/output 历史,要么设 `ACP_KEEP_RESPONSE_ID=1`;bili 剥掉非空 `previous_response_id` 时现在会记一条 `warn`(#1954)。完整链式支持跟踪在 #1973。见[官方迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses)。

### 运行模式:`bili codex` 钉死 embedded(#1867)

自 ~0.156 起,Codex 可以附着到(或自动拉起)一台机器全局共享的后台 server,其模型流量用的是 **daemon 启动时**存在的环境变量,而不是会话启动时的。启动器的代理是会话级的(端口随进程消亡),所以长寿 daemon 没法安全地经它路由:若 codex 先于 bili env 启动,之后的 `bili codex` 会话会静默附着上去、**完全绕过压缩**;若 bili 先启动,幸存的 daemon 则一直指向死端口。因此启动器显式传 `--no-daemon` —— 先探测 `codex --help` 是否有该 flag(旧版本二进制原样启动),且仅当用户未自行钉死模式(`--no-daemon` 或 `--remote`)时。结果:确定性的 embedded 运行,无逐次启动的回退警告,无静默绕过。#321 的预算 `-c` 参数原样保留(embedded 模式同等生效)。想要共享后台 server 的话,直接跑原生 `codex` —— 没有压缩,但工具仍可通过 `bili plugin install codex` 使用。

### Windows 启动路径:用户 argv 不再重新进入 cmd.exe(#2196)

Windows 上默认 npm 安装把 `codex.cmd` shim 放上 PATH,它的 `%*` 转发会让每个用户参数再经 **cmd.exe 行解析器**解析一遍——该解析器没有任何转义机制:嵌入双引号拆词(`Please say "hello world" exactly` 到达时变成四个参数)、`%VAR%` 被展开、`&|<>^()` 成为命令操作符、空参数消失。普通带空格提示词恰好能幸存,所以 #679 的空格截断修复没有暴露它。#2196 让启动器拒绝把用户 argv 喂进这个解析器:

- **解析顺序(win32 专属):** 每个 PATH 目录内原生 `codex.exe` 优先于 `codex.cmd`/`codex.bat`(最早目录仍整体优先);`.cmd`/`.bat` 命中若位于可信 npm 布局旁——`<dir>/node_modules/@openai/codex`,package.json name 为 `@openai/codex`、有可解析的 `"codex"` bin 条目、且 shim 文本引用该包(放在无关树旁的手写 `codex.cmd` 不得劫持启动)——则升级为 `node <官方 bin/codex.js>`。Node 下运行官方 wrapper 与 shim 行为完全一致——vendor 二进制查找、env 初始化、信号转发——而 Node 自己的 CreateProcess argv 编码逐字无损携带每个参数。未识别布局(yarn-classic `.bin` 树、无本地链接的 pnpm store shim……)保留旧 cmd 路径并遵循下述契约。
- **透传契约:** 其余 cmd 包装启动——任何客户端的 `.cmd`/`.bat`/无扩展名二进制,加上 dsh-channel spawn——只接受行解析器能逐字携带的 argv;其余(嵌入引号、`%VAR%`、元字符、空参数、换行、奇数尾反斜杠)在**任何进程启动之前**以可操作的错误明确失败,而不是损坏到达或执行非预期命令。直接 spawn 的 `.exe` 不受影响:Node 自身无损编码其 argv。
- **绕行 / power-user 旋钮:** `BILI_CLIENT_BIN=<path>` 仍最高优先——指向真实 `codex.exe`(或经 node 运行的脚本入口)即可完全绕开 shim。

已在 windows-latest CI 上对真实全局 `@openai/codex` 安装验证(`tests/win-cmd-argv.test.ts`,`ci-windows-codex.yml` 硬门禁):完整语料——空参数、普通空格、嵌入引号、TOML `-c` 值、JSON、Unicode、尾反斜杠、`%COMSPEC%`、`!VAR!`、`&|<>^()`——逐项与调用方数组相等地到达子进程。

## Pi(pi.dev coding agent)

Pi 有完整原生模式(`bili plugin install pi`,README 快速上手方案 1);这一节只讲一行表格装不下的内容——**原生拦截实际覆盖哪些模型传输**。pi 是唯一把 WebSocket 模型流量带进环路的宿主。

**子代理配置(#2230)。** 内置 `acp_delegate` 面(三个 delegate 工具、角色、fleet 检查器——由 `bili pi` 经内嵌扩展接线)配置在 bili 自己的配置文件:`~/.config/billion-context/billion-context.json` 的 `pi.subagents` 段(布尔简写 `"pi": {"subagents": false}` 可整体关闭)。`~/.pi/acp.json` 的四键(`delegate` / `delegatePrompt` / `displayUsage` / `debug`)是已废弃的回退源——仅当段缺失时读取,段存在后完全忽略。完整字段表与 `PI_ACP_DELEGATE_*` 环境变量见 CONFIGURATION.zh-CN.md 的 [`pi`](CONFIGURATION.zh-CN.md#pi) 段。

**路由机制。** pi 扩展自行拉起(或附着)代理并进程内 patch `globalThis.fetch`:所有模型 API 的 HTTP 请求被改写到 `<proxy>/bili/<upstream-url>`,扩展经 pi 的 `before_provider_headers` 事件盖 `x-bili-plugin*` 头。所有 HTTP 系 provider(Anthropic、OpenAI chat/completions/responses、Gemini、Mistral、OpenRouter、Azure、自定义中转……)走这条路,得到具名 plugin-mode 会话。

**WebSocket 覆盖(#2073,#2111 实现)。** WebSocket 连接从不经过 `globalThis.fetch`,所以原生扩展在加载时(首个模型连接之前)同时包装 `globalThis.WebSocket`(pi 的 Node 分支每次调用都读全局,Bun 分支首次调用时缓存子类——两个运行时的安装时序都因此安全)。只重写受支持的 Codex Responses 模型连接——其余 WebSocket(devtools、第三方库、已路由 URL)原样通过:

| Provider / 传输 | 状态 |
|---|---|
| 全部 HTTP provider | ✅ 覆盖 —— 具名 plugin-mode 会话 |
| `openai-codex-responses`(ChatGPT backend-api),`transport: "sse"` | ✅ 覆盖 —— 与任何 HTTP provider 无异 |
| `openai-codex-responses`,`transport: "auto"`(默认)/ `"websocket"` / `"websocket-cached"` | ✅ 覆盖(#2111)—— 构造器 URL 被重写为 `<proxy-ws>/bili/<https-upstream>`(例:`wss://chatgpt.com/backend-api/codex/responses` → `ws://127.0.0.1:<port>/bili/https://chatgpt.com/backend-api/codex/responses`)。构造器参数、子协议、请求头全部保留,pi 在 SSE 上发的同一个 `session-id` 随升级握手到达,会话标识跨传输字节一致;子代理各用自己的会话 ID。`previous_response_id` 增量续传在该车道可用(代理先展开 delta 再进管线,回上游前再优化回 delta) |
| AWS Bedrock(`bedrock-converse-stream`) | ❌ Bedrock 流量全部走 WS、无 transport 选项、升级握手不带自定义头 —— 仅靠 URL 拦截无法覆盖,需要代理侧专门的 WS codec(不在 #2111 范围,归入 #2073 另行跟踪) |

拦截带来一个拓扑后果:pi 的客户端握手现在指向本地代理(总是成功),因此*上游*拒绝 WS 握手会以流中传输失败的形式暴露,而不再触发 pi 的同轮 SSE 回退——该回退只在客户端握手失败时触发。下面的显式 `sse` 车道仍是确定性绕行手段。

**Codex provider 的绕行办法。** 在 pi 配置里强制 SSE 车道(`~/.pi/agent/settings.json`;项目 `.pi/settings.json` 可覆盖):

```json
{ "transport": "sse" }
```

默认值 `"auto"` 先试 WS、握手失败才回退 SSE;旧布尔键 `"websockets": false` 会自动迁移。该键全局生效,但只有支持多传输的 provider(目前是 codex provider)消费它,纯 HTTP provider 不受影响。Windows + Pi 1.0.2 实机验证(#2063 owner 复现):显式 `sse` 携带正确会话 ID 进入 bili。

该车道已经过端到端实证(`tests/e2e/e2e-pi-codex-ws.test.ts`,真实 pi 对确定性 mock 上游经真实代理):显式 websocket 与 auto 路由、升级握手上 stamp 与 `session-id` == 会话 ID 一致、compress/decompress 往返并反映到后续请求、`previous_response_id` 展开、上游拒绝行为、显式 sse 回归守卫,以及两个并发子代理式会话共享一个代理互不串扰。

### 子代理(pi-subagents)— native 安装覆盖(#2185)

pi-subagents(pi.dev 上的包)为前台/后台子代理运行派生**子会话**。#2185 之前,native 安装(`bili plugin install pi` / `pi install npm:billion-context`)下 bili 扩展并不能可靠地加载进这些子会话:

- **前台 child** 在进程内运行且 ambient 扩展发现关闭(`noExtensions: true`)→ bili 扩展根本不加载;其流量只是借父进程的全局 fetch patch 到达代理,因此每个 child 被记成**匿名 proxy 模式 `pfa-*` 会话**:压缩成立,但没有具名 `x-bili-plugin-conversation` 身份、没有父会话血统,ACP 工具只以代理侧 wire 注入的形式存在;
- **后台 async run** 派生独立 runner,其 child *可能*经 ambient 发现加载扩展——默认配置下靠运气生效,而 agent 定义一旦显式设置 `extensions`(哪怕是 `[]`)或 `denyExtensions`,或遇到 pi-subagents 版本漂移 / npm store 同步问题,就**静默回归直连**(代理侧零可见性)。

**修法。** pi 扩展在 session_start 时向 pi-subagents 的全局 required-child-extension registry 自注册(对 `globalThis[Symbol.for("pi-subagents.required-child-extensions.v1")]` 做特征探测)。注册条目使 bili 成为**该父会话派生的每个 child 的必需扩展**;必需扩展经 `additionalExtensionPaths` 注入,pi 会把它载入 `cliEnabledExtensions` 桶——**即使 `noExtensions: true` 也加载**——所以下面每一格都是确定性加载。注册按父会话粒度,session_shutdown 时释放;同会话已有条目时让位(先写者胜)。刻意**不设置** `requireForAllRunners`:非 pi 的 runner 放置保持现状,而不是被拒绝。registry 不存在或形状不符(新旧 pi-subagents 版本漂移)时,扩展降级回修复前行为并记一次日志。kill switch `BILLION_CONTEXT_PLUGIN=0` / `BILI_NATIVE_PI=0` 同样会抑制注册。不引入任何新配置面。

修复后矩阵(pi 0.83.6 + pi-subagents 0.76.0 实机验证,HTTP 传输;WS 行依据 #2073 记录,无实机格):

| 格子 | 修复前 | 修复后 |
|---|---|---|
| native × 前台 × 默认配置 | 匿名 `pfa-*` proxy 模式;ACP 工具仅靠代理 wire 注入 | **具名 child-sid plugin 模式会话**;ACP 工具首个请求起本地注册;压缩记在 child 自己的 id 下 |
| native × 后台 × 默认配置 | ambient 运气——settings packages 恰好加载时才是具名 plugin 模式 | 同上,但现在是确定性的(child launch-resolved extensions 里 `required: ["bili"]`) |
| native × 后台 × agent 定义 `extensions: []` / `denyExtensions` | **静默直连**——代理零可见性、无压缩 | 确定性必需路径加载;具名 plugin 会话。(若运行时能力上限硬性拒绝扩展,pi-subagents 0.76.0 会让 child 启动大声失败——fail-fast 而非静默) |
| launcher 模式(`bili pi`)× 后台 | child 继承 provider rewrite(#535),但 bili 加载同样靠 ambient 运气 | 注册生效(刻意**不受** `BILI_PROVIDER_REWRITES` 门控);父与子均为具名会话,经继承的 rewrite 路由 |
| 任意 × 纯 WS 传输 | 不在范围——见上方 WS 缺口 | 不变:客户端侧 WS 拦截仍 owner-gated(#2073) |

值得知道的注意事项:

- **限制性 `tools:` 白名单的角色会自动拿回 ACP 通道(#2268)。** frontmatter `tools:` 列表未包含任何 ACP 工具名的角色——全部 7 个内置角色都是如此(如 `delegate` 只列 `read,grep,find,ls,bash,edit,write,contact_supervisor`)——在 #2185 具名 plugin 化之后**不再**丢失交互式压缩。bili 按请求检测这类 child(pi-subagents 会在每个子会话的 system prompt 打上完整的 `<active_agent name="…">` 标记;检测只针对 system prompt 载体,历史消息中仅引用该标记的主会话不受影响(#2694);门控还要求请求的 tools 数组——含 namespace 包装声明——未暴露任何 bili 可注入的工具名),并为其走 **proxy-style 压缩通道**:wire 注入 ACP 工具 + nudge、服务端执行、`acp_summary` carrier——同时保留 #2185 的具名 plugin 会话身份。无需任何配置改动;角色的原白名单在 wire 上原样保留,白名单中途变更会在下一个请求自愈。范围仅限 nicobailon/pi-subagents 的 child(标记是它的),其他 plugin host 不受影响。若上游日后移除该标记,这些角色会退回 #2268 之前的行为(具名会话、无本地 ACP 工具)。
  - 暴露**任一** ACP/bili 可注入名的角色保持纯 plugin 模式(重复的工具声明会被上游拒绝),因此**部分授予不受支持**——要么一个都不给,要么全给(`compress,decompress,search_context,acp_status[,acp_cache]`)。
  - 想让某个特定角色用本地注册(plugin-carrier)的工具?保留手动授权:省略 `tools:` 字段或在其中补上 ACP 工具名即可。
- **后台 child 存在一个请求的注册竞争**(ACP 工具从第二个请求起出现),所有模式下均为既有现象。
- **行为变更披露:** 前台 child 从匿名 proxy 模式(`pfa-*`)升级为具名 plugin 模式(child 会话 id + 父会话血统)。信息严格更多,但任何以 `pfa-*` 身份做键的工具将看到不同的 id。

## 收养未列表的客户端(任何模型 baseURL 可配的客户端)(#2340)

凡是**模型端点可以自己编辑、且用 API key 认证**(而非账号登录)的客户端,今天改一行就能上压缩——无需启动器、无需开发:在 baseURL 前加代理 origin + `/bili/`(`http://127.0.0.1:8787/bili/https://api.example.com/v1`),API key 原样保留,并让代理常驻(`bili start`)。得到的是完整纯代理待遇:压缩 + wire 级工具注入。细节与示例见 [CONFIGURATION.zh-CN.md → `/bili/` 前缀](CONFIGURATION.zh-CN.md#bili-前缀api-key-客户端)。

已核实的入口(社区维护清单——机制本身是通用的):

| 客户端 | baseURL 所在 |
|---|---|
| **Cline / Roo Code / Kilo Code**(VS Code) | provider 设置 —— "OpenAI Compatible" Base URL,或 Anthropic provider 的 base URL |
| **Continue** | `~/.continue/config.yaml` —— 各模型的 `apiBase` |
| **OpenHands** | `llm.base_url`(配置或 env) |
| **Zed** | `settings.json` —— `language_models.openai_compatible.api_url` |
| **Void** | 自定义 OpenAI 兼容端点设置 |
| **Cursor**(单模型通道) | Settings → Models → OpenAI API key → **Override Base URL** |
| **Warp** | 自定义模型 base URL 设置 |

注意:

- **Crush** 已有启动器车道——直接用 `bili crush`(配置零改动,HTTPS 域自动 MITM)。
- **Zed** 也已有启动器车道——直接用 `bili zed`(Linux;配置零改动,模型域自动 MITM,环回 provider 保持直连)。上面的 settings.json `api_url` 路径仍是跨平台替代。
- **账号登录**型客户端(OAuth/订阅)通常焊死端点——前缀技巧不适用,改看[下方 MITM 节](#客户端用-httpproxyconnect接入但从不压缩)。
- 纯 **web 应用**(只在浏览器里的产品)本地没有流量可截。
- VS Code 扩展的 baseURL 字段在明文设置里,密钥在系统钥匙串——这里只需要改 baseURL。

## 客户端用 `http.proxy`(CONNECT)接入但从不压缩

部分客户端(VS Code 系 IDE:CodeBuddy、Cursor、Windsurf……)只提供一个 HTTP **代理**设置(`http.proxy`、`codingcopilot.httpProxyURL` 等),没有可改写的模型 base-URL。这类客户端不走普通的 `/bili/…` 请求,而是把 `CONNECT <模型域名>:443` 发给代理。只有当模型域名在 bili 的 **MITM 白名单**里时这条路径才会被解密;否则 bili 只做盲隧道(不透明转发),永远看不到——也就无法压缩——模型请求(#897)。

该失效模式现在不再静默:

- 日志里对每个目标域名打一次 `BLIND TUNNEL WARNING`,附修复步骤;
- `curl -s http://localhost:8787/__bili/health` 与 `/__bili/stats` 输出 `blindTunnels`(计数 + 精确目标域名,仅 loopback);
- 存在此类隧道时,`acp_status` 输出会多一节 `UNDECRYPTED TRAFFIC (instance-level)`。

要真正压缩这类客户端:把它的模型域名加进 `billion-context.json` 的 `"mitm".domains`(如 `"mitm": { "domains": ["copilot.tencent.com"] }`)或环境变量 `BILI_MITM_DOMAINS`,重启 bili,并让客户端信任 bili 的根 CA(Node 系客户端用 `NODE_EXTRA_CA_CERTS=~/.local/share/billion-context/ca/root-ca.pem`,有 CA 路径设置的用其设置)。`/bili/` 前缀方案在这里不适用——没有 URL 可改。详见 [CONFIGURATION.zh-CN.md → MITM](CONFIGURATION.zh-CN.md#mitm-透明代理登录订阅客户端)。

## 未识别的端点直连、什么都不压缩(#1290)

bili 只压缩路径匹配已知 wire 协议(`/chat/completions`、`/llm_raw_chat`、`/v1/messages`、`/responses`……)的请求。发往其它路径的请求——例如第三方插件的**自定义 wire**(Command Code 的 Go 套餐发 `POST /alpha/generate`)——会逐字节中继,**永不压缩**。目前没有任何配置口可以声明一种任意新 wire;那是一项独立功能,不是一个能打开的开关。

这个结果现在不再静默(#1290):

- 客户端侧 fetch 钩子对每个不同的、以 **POST** 发出的未路由端点每进程记一次日志(`…is not a recognized model endpoint, so bili did not route it through the proxy…`);非 POST 流量——npm 注册表、目录 JSON、git refs——按设计保持静默(#1657:GET 不携带 prompt,不可能是模型流量);
- `curl -s http://localhost:8787/__bili/stats` 输出 `unrecognizedPaths`(按路径计数,仅 loopback);
- 存在此类请求时,`acp_status` 输出会多一节 `UNRECOGNIZED PATHS (instance-level)`。

如果你期望这类端点被压缩,改用 provider 的标准协议端点(Command Code 的 Provider 套餐发 `/provider/v1/chat/completions`,bili 能正常压缩);真正的自定义 wire 需要单独的支持。

## OpenCode

同一个内置插件同时服务两代 OpenCode:agent 文件同时保留 V1 `server()` 与 V2 `setup()` 导出 —— ≥ 1.18.29 的 1.x 宿主加载 V1 形状,2.x 宿主加载 V2 `setup()`。独立扩展 [`opencode-acp`](https://github.com/ranxianglei/opencode-acp) 仅支持 V1,在 2.x 下**不加载** —— 对 OpenCode 2.x,**billion-context 是推荐的上下文管理方案**。以下均在 `@opencode/cli` 2.0.3 上端到端验证过(V1 泳道:1.14.46 与 1.18.31)。

| 路径 | 命令 | 适用 |
|---|---|---|
| 启动器(最省事) | `bili opencode` | 一条命令拉起代理 + 客户端;不碰真实配置 |
| 原生(免启动器) | `bili plugin install opencode` | 自拉起插件写进真实配置;照常启动 `opencode` |
| 纯代理(兜底) | baseURL 加 `/bili/` 前缀 | 无插件 —— wire 级工具注入 |

这三条路径**互斥**——每条都拥有同一批请求的路由权,每个宿主实例只能激活其中一条。手写的 `/bili/` provider baseURL 是纯代理路径的标记;在原生插件已装的情况下写它就是**矛盾配置**(#1958):运行时会每会话警告一次(按 origin 去重)并附修复指引——去掉前缀或卸掉插件——请求则留在其编码的纯代理路径上(无插件会话标记)。受支持的例外是对**同一** origin 的显式钉住——`BILLION_CONTEXT_PROXY` 指向 URL 已经在走的那个代理——保持静默。

### 启动器 —— `bili opencode`

HTTPS 走证书 MITM,HTTP 走临时 `opencode.json` 副本(`/bili/` 改写;JSONC 注释照单接受,合并方式与 opencode 自身一致;相对本地插件路径在副本里重新锚定为绝对路径 —— opencode 按声明所在配置文件目录解析,#826)。宿主代次用 `--version` 探测(探测失败默认按 1.x):**2.x** 宿主注入内置 V2 插件(`dist/agent/opencode.js`),以临时包装目录形式给出(目录入口 `index.js` 再 re-export 插件文件 —— 2.x 拒绝配置 `plugin` 数组里的裸文件路径);**1.x** 宿主直接给裸文件路径。

插件在两代宿主上做的事相同:在宿主内原生注册 bili 工具 —— compress / decompress / search_context / acp_status(另加 absorb)—— 并在每个 provider 请求上盖章代理头,含从宿主自身模型目录(`ctx.catalog.model.list()`,每 60s 刷新)读取的 context-window / max-output,并以 runtime-info 上报给代理(#955)—— 压缩走插件模式,**不做** wire 级工具注入;原生 auto-compaction 自动关闭(`compaction.auto: false`)。所有注册都是防御式的(可选链):任一 2.x build 上接缝缺失或未触发时,插件保持惰性,会话透明回退纯代理模式而不是报错 —— 在相邻的 `dev` build 上观察到过 API 面互不相同(#754 评审探针)。

1.x 细节(1.14.46 + 1.18.31 验证):V1 `.server()` 钩子在进程内把每个 provider 的 `options.baseURL` 改写为 `<proxy>/bili/…` 并设 `compaction.auto: false`;`chat.headers` 每次请求盖章插件头;`tool` 用真实 zod 形状注册 bili 工具(zod 是运行时依赖 —— 解析不到时降级为只改写)。没有显式 `baseURL` 的 provider(SDK 默认值,如裸 `@ai-sdk/openai` → api.openai.com)由全局 `fetch` 补丁兜住(日志:`v1: fetch patch installed`)—— 幂等,`/bili/` 包装过的 URL 原样直通;含 OpenAI Responses 端点端到端验证。

### 原生(免启动器)—— `bili plugin install opencode`

在真实 opencode 配置里注册一个自拉起插件并设 `compaction.auto: false`,之后直接跑 `opencode` 即可。默认不加 MCP 面(原生插件已提供会话绑定的 bili 工具);需要就传 `--with-mcp` —— 该条目不带 origin 钉扎,能扛过插件临时端口的代理重启(#926)。条目形态取决于**本 bili 自身的安装来源**:**npm 安装**写裸包名(`"plugin": ["billion-context"]`)—— 包经 `exports["./server"]` → `dist/agent/opencode-native.js` 暴露插件入口,opencode 用自己的 Npm.add 机制加载、自行管理安装与升级;零绝对路径、可跨机。(这个裸包名条目也可以不经 bili 直接手写进配置 —— 见 README 快速上手 方式 1。)**git checkout / 开发构建**回退到本机 shim 目录(`<configDir>/plugins/billion-context/index.js` → 该 checkout 的 `dist/agent/opencode-native.js`)—— 按构造即机器本地;之后改用 npm 安装再跑一次 install 会把条目迁回裸包名。

加载时插件自拉起自己的代理(健康的已有实例直接复用不重复起;父进程 pid 看门狗在 opencode 退出时收掉它),把模型流量路由到 `<proxy>/bili/<upstream-url>`,暴露与启动器模式相同的原生 bili 工具 —— 无固定端口、无环境变量、免启动器。退出:`BILI_NATIVE_OPENCODE=0`。若没有任何代理能拉到健康状态,请求直连(不压缩)并给一次性告警,之后自动恢复。在 `bili opencode` 启动下该条目整体跳过(代理归启动器管)。

### OpenAI Responses WebSocket(V2)

V2 插件也接管 OpenAI 的 `experimental.ws.handshake` 请求，两端均使用
WebSocket：OpenCode → bili → Responses 上游。支持 OpenAI API Key 及
ChatGPT Pro/Plus browser/headless OAuth；登录方式不决定传输方式。
无需改写 OpenCode 配置或增加 bili 设置。首版只接受本机发起、携带原生
插件身份的连接；普通或未接管的 WebSocket 升级仍立即返回 426。

ACP 处理、原生工具和用量统计保持生效。客户端增量先还原再压缩；只有
处理后的历史确实延续上次响应时，上游才使用增量。压缩后在同一连接上
发送完整压缩上下文，开始新的响应链。引用标签或其它历史变化也可能要求
完整输入，因此复用连接不代表每轮都只发增量。不支持实验钩子的旧宿主
需要使用 OpenCode 已有的 `providers.openai.settings.transport: "http"`。
Realtime、同一连接的并发多路响应及远程 WS 客户端不在本次范围。
验证使用真实 OpenCode V2.0.20 与本地 Responses WS 上游，未使用真实
OpenAI/ChatGPT 凭据。

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

这条路径意味着**无插件**:若同时装了原生插件,运行时每会话警告一次——每个 provider 只选一条路径(#1958)。

### 状态:`/acp` 与 `acp_status`

`/acp` 面板在所有模式下都绑定当前会话,`acp_status` 工具是其宿主内等价手段。在命令编辑器支持新增条目的宿主(2.0.x 稳定版,`editor.add`)上,V2 插件额外注册 `/acp` 斜杠命令 —— 以合成非模型消息渲染,面板优先(与 `acp_status` 工具一致);旧形状上该注册保持惰性。注意 `opencode run` 模式完全不派发斜杠命令(它们会透传给模型)—— 请用 TUI。

同一接缝还承载 `/acp-cache`(#1146)—— prompt-cache 对账报告的人侧入口(输出与 `acp_cache` 工具一致):pi/omp 原生注册(`/acp-cache [full]` 出逐行清单);opencode V1 渲染为一条被忽略的消息,代理在到达 wire 前从模型上下文剥离;opencode V2 渲染为合成消息(报告最多可见 ~8 KB);dsh(两条泳道)显示默认摘要台账——dsh 的命令 API 不传参数,故无 `full`。旧 opencode-acp 会话(#920)收到显式的不可用提示(其流量绕过本代理的压缩状态)。Claude Code 没有进程内命令 API:`bili plugin install claude` 写一个模型中介的 `commands/acp-cache.md` markdown 命令,其 prompt 驱动 `acp_cache` MCP 工具并把报告逐字贴回。codex/kimi/hermes 没有用户可输入的命令接缝——直接让模型调用它的 `acp_cache` 工具。每次折叠的盈亏判定按可选的 `compress.priceProfile`(以输入 token 单价为基准的归一化倍率)计价;任何层级都未设置时,取请求模型在 models.dev 的价格行按绝对 $/Mtok 计(仅无法解析的模型回退内核比率默认值)——因此 breakeven/PAID BACK 开箱即反映你上游的真实经济账;对带自定义加价的中转站可按 provider 覆盖(CONFIGURATION.zh-CN.md,#1279)。

同一接缝还承载 `/acp-rule`(#1251/#1399)—— 持久指令功能的人侧入口(输出与 `acp_rule` 工具一致):pi/omp 原生注册,操作集与工具完全一致 —— 裸 `/acp-rule` 逐字列出全部已记录指令,`/acp-rule <文本>` 直接记录一条(等价于模型调用),`/acp-rule remove <id>` 删除一条,裸 `/acp-rule clear` 清空全部(`clear <文本>` 是记录而非清空——一个手误不该毁掉所有规则)。包裹后的 transcript 消息按内容签名从模型上下文剥离(与缓存报告同机制)—— 已记录的指令本来就每轮经 system prompt 注入。

### 旧 opencode-acp 会话(#920)

在 1.x 宿主上,迁移前的 [`opencode-acp`](https://github.com/ranxianglei/opencode-acp) 旧会话在两条泳道下都继续可用:启动器从临时配置副本中移除 `opencode-acp` 条目(宿主永远不会以激活状态加载它),各泳道把已安装的包作为库吸收(直接从 `node_modules` 导入 —— `.opencode/node_modules`、项目 `node_modules`、全局 npm root、opencode 配置级 modules,先到先得)。会话属于 legacy ⟺ opencode-acp 的持久化状态文件存在(`<XDG_DATA_HOME>/opencode/storage/plugin/acp/<sessionID>.json`,或 `acp.jsonc` 中 `storagePath` 指定的目录):

- **旧会话** —— 压缩由被吸收的 opencode-acp 执行(它自己的引用号与块存储照常工作:`compress` / `decompress` / `search_context` / `acp_status` / `acp_context_recap` 全部在它里面执行)。其模型请求带 `x-bili-plugin-bypass: 1`,代理原样转发 —— 不注入 wire 工具、不注 nudge、不绑定会话。
- **新会话** —— bili 接管:工具调用转发到代理的 plugin 端点(plugin 模式)。执行器按会话分泳道:新会话的 `compress` 发到代理,旧会话的发给 opencode-acp。`acp_context_recap` 没有代理端对应 —— 新会话调用会收到代理的 unknown-tool 消息。

`/acp` 与 `/dcp` 同样路由。新会话被 opencode-acp 注册表收编的可能被其 transform 门控(system / messages / text.complete 都过 legacy 谓词)阻断。退化路径:包缺失、导入失败或不是 v1 时,bili 单独运行,旧会话退化为只读存档(旧标签照常渲染、`decompress` 返回 `[Block … not found]`、新引用号从 m00001 重新开始)。

### 注意事项

- 2.x 系列以 npm 包 `@opencode/cli` 发布,且插件 API 面在不同 build 间仍在变动(相邻 `dev` 通道构建暴露不同 `ctx` 形状)—— 上文钩子/工具细节是针对具体版本的观察,不是稳定契约。
- 设计说明:V2 插件是薄协议客户端(不含 acp-kernel)—— 代理始终是唯一的压缩权威,消除 agent 与代理间的内核版本漂移;它不依赖插件 API 无法改上下文这一事实(该能力随 2.x build 变化)。
