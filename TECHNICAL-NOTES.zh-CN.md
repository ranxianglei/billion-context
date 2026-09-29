# 技术细节

README 三种使用方式背后的机制级说明。README 里每种方式只保留简洁的用法;「它到底怎么工作」的内容都放在这里,而不是夹在三种方式中间。

## 原生插件生命周期(方式 1)

插件加载时**自拉起自己的代理**(已有健康实例则直接复用 —— 父进程 pid 看门狗在客户端退出时收掉它),把模型流量改写到 `<proxy>/bili/<上游URL>`,把 `compress` / `decompress` / `acp_status` 注册为客户端原生工具(plugin 模式),并把 `/acp` 面板绑定到当前会话。插件还会把客户端**自己的模型配置**上报给代理(runtime-info 协议,#955),压缩预算用真实窗口而不是注册表猜测。退出开关:`BILI_NATIVE_PI=0`、`BILI_NATIVE_OMP=0`、`BILI_NATIVE_OPENCODE=0`、`BILI_NATIVE_DSH=0`、`BILI_NATIVE_KIMI=0`、`BILI_NATIVE_HERMES=0`、`BILI_NATIVE_ZCODE=0`。

## DSH 输出预算交接

DSH 的 OpenAI 请求可以发送 `x-bili-output-budget: <原始要求>:<按原始输入缩减后的值>`。代理只接受正的安全整数，第二个值必须与请求体的预算一致，第一个值不得更小；若插件上报了模型输出上限，恢复值不得超过该上限。代理在准备请求前恢复本次请求的上限，再应用已有的重建输入输出限额检查。两值相等时，保留用户明确指定的小额度，不从会话高水位恢复。其他客户端或模型不匹配的请求不使用此交接。该头在转发前移除；直连请求仍保持原始输入限额。不改变会话存储数据或压缩设置。

## 代理复用与附着门禁(#1225、#1335、#1232)

原生 hook 可以附着到已在运行的代理而不自己拉起 —— 仅当通过下面的生命周期门禁。复用基于身份(#1225):只有当既有代理运行的是**同一份代码**(入口脚本 sha256,记录在实例文件里)、**lane 兼容**(每个启动器声明其客户端 lane,两个*不同声明的* lane 永不共享;未声明 lane 的实例在该轴上通配)、**且拥有会话生命周期**(健康端点报告 armed 父进程 pid 看门狗 `watchdog.armed == true`,即由带父 pid 的启动器拉起、随最后一个附着会话消亡)时才附着。#1225 之前写入的实例没有代码指纹,因此永不附着:重建或更新后的安装下次启动总会拉起新代理,修复立即生效而不是静默服务旧代码。

| 监听者 | 附着? | 原因 |
|---|---|---|
| 本会话拉起的代理 | ✅ | 出生即 armed |
| 其他会话的 armed 共享代理(watcher 集,#1186) | ✅ | 共享本就是设计 |
| 手工 `bili start` 常驻守护进程 | ❌ 默认不附着 | 无生命周期属主(拒绝 watcher 注册、不随会话退出、常是旧版本代码 —— #1322 的成因) |

hook 附着前先探测候选者 `/__bili/health` 里的 `watchdog.armed`:armed → 附着并注册 watcher(现状不变);unarmed、或 pre-#1330 构建根本不报 `watchdog` 字段(不可验证,按 unarmed 处理)→ **不附着**,本会话自拉起一个临时代理(临时端口、出生即 armed、随最后一个会话消亡,#1186 watcher 语义)。顺带修掉版本偏斜:每个会话跑的都是**当前安装的** bili,而不是陈旧守护进程携带的旧代码。代价:无 armed 代理时每会话多一个短命代理进程(会话状态在磁盘上共享,压缩连续性不受影响);多实例告警(#394)相应变多。**逃生舱:** 刻意用常驻守护进程承载原生 hook → 配置文件设 `"native": { "attachExternal": true }` 或 `BILI_NATIVE_ATTACH_EXTERNAL=1`,恢复对任何 code/lane 兼容监听者的附着(守护进程的寿命与版本由你自己负责)。kimi/dsh 的显式用户指定附着(`BILLION_CONTEXT_ATTACH` / 预置 `BILLION_CONTEXT_PROXY`)完全不经过发现路径,构造上豁免。

附着发现在**所有**存活实例间是 lane 感知的(#1232):启动器探测实例注册表里的每一条存活记录,而不只是单个实例文件(last-writer-wins —— 并发多客户端下它可能指向别的客户端的代理),并对每个候选应用上面的门禁。兼容候选中,lane 与启动器自身声明一致的最新实例胜出;未声明 lane 的实例在 lane 轴上通配(仍受门禁约束)。`another bili instance is running` 告警(#394)也是 lane 感知的:同 lane 或无 lane 共存时触发,两个*不同声明* lane 之间保持沉默(它们的会话文件互不相交)。

## Runtime-info 协议(#955)

原生插件就在客户端进程里,因此能读到客户端自己将要使用的模型配置。它通过两个通道把真相推给代理,代理在上下文窗口解析链里优先采用它而不是 models.dev 注册表/内置表:

| 通道 | 时机 | 字段 |
|---|---|---|
| 逐请求头(门控在 `x-bili-plugin`) | 每次模型请求 | `x-bili-plugin-context-window`、`x-bili-plugin-max-output`、`x-bili-plugin-model` |
| `POST /__bili/plugin/runtime-info`(回环地址) | 插件自举 + 任一上报字段变更 | `{agent, model, contextWindow?, maxOutput?, baseURL?, conversationId?, source}` |

窗口解析顺序:`anthropic-beta` 协商 > 逐请求 plugin 头 > runtime-info > launcher 环境变量 > 路由配置 > models.dev 注册表 > 内置表。runtime-info 这一步:带 `x-bili-plugin` 头的请求读**按 agent 的条目**(agent+model 必须匹配);不带该头的请求解析以 `conversationId` 记录的**会话级条目**,键与会话绑定的同一会话信号一致(客户端会话头、自定义 session 头或请求体的 `prompt_cache_key`)—— 无论哪种,model 都必须匹配(#1531:omp 打 `prompt_cache_key` 但不打 plugin 头,且主/子代理会话共用 agent 名却跑不同模型)。上报的 `maxOutput` 仅在请求体自带输出预算缺席时兜底。现有实现:`src/agent/pi.ts`(覆盖 pi 与 omp)、`src/agent/opencode-native.ts`(v1)、`src/agent/opencode-v2.ts`、`src/agent/dsh-native.ts`、`src/kimi/native-mcp.ts`(仅自举时上报 —— kimi 的 provider `custom_headers` 是静态的,逐请求头会在模型切换后过期)、`hermes-plugin/__init__.py`(Python 插件:经 `llm_request` 中间件打逐请求头,`pre_api_request` hook 捕获最大输出)—— 其他客户端接入请遵循同一协议。

launcher 环境变量这档覆盖纯代理客户端(无进程内插件):`bili <client>` 启动时读客户端自己的模型配置(codex 的 `model_context_window` / `model_max_output_tokens`,pi / omp 的 `contextWindow` / `maxTokens`,opencode 的 `limit.context` / `limit.output`,codebuddy 的 `maxInputTokens` / `maxOutputTokens`),经 `BILI_LAUNCHER_MODEL_WINDOWS` / `BILI_LAUNCHER_MODEL_MAX_OUTPUTS` 交给代理(#971)。插件上报 —— 若存在 —— 永远优先于它。

首次模型请求之前会话尚不存在,`/acp` 面板会探测 `GET /__bili/plugin/status?conversationId=<agent>&fallback=latest`,代理从 runtime-info 表应答(`phase: "pre-first-request"`)而不是返回 404 —— 上报的配置立即可见,流量落地后由真实会话接管。

## Claude 原生姿态(#964)

Claude Code 没有进程内扩展点,所以 `bili plugin install claude` 往 `~/.claude/settings.json` 写一个受管块(env `ANTHROPIC_BASE_URL=http://127.0.0.1:48787/bili/<upstream>`、`DISABLE_AUTO_COMPACT=1`、`SessionStart` hook),外加同样指向该稳定端口的用户级 MCP shell。hook 在首个模型请求前触发:附着到端口上健康的代理,或拉起一个 pid 看门狗追踪 claude 本身的代理 —— 代理随会话生灭。端口覆盖:`BILI_CLAUDE_NATIVE_PORT` > config `claude.nativePort` > 48787;上游覆盖:`BILI_CLAUDE_UPSTREAM`(或既有 `claude.anthropicBaseUrl`)。`BILI_NATIVE_CLAUDE=0` 退出 —— hook 改为拉起同端口的 **passthrough** 代理(原样转发、关闭压缩)。块是纯 JSON merge/strip:外部键从不触碰,`bili plugin remove claude` 精确还原。装有原生块的机器上 `bili claude` 仍可用 —— 它用自身临时代理覆盖静态 URL,hook 保持休眠。

## 注入优先级 —— 能不写文件就不写(#535)

bili 永不拥有用户数据:每个被启动的客户端都跑在**真实 home** 上,运行期写入落在用户预期的位置。把客户端指向代理时,启动器按优先级选择——**优先 env 变量**(hermes/dsh/codex 的代理/CA env;pi/omp 的 `BILI_PROVIDER_REWRITES` URL 清单,由扩展加载时经 `registerProvider` 消费),其次 **CLI 参数或扩展 API**(codex `-c key=value`、opencode 插件),最后才是**生成文件**——目前仅剩 opencode 的临时 `opencode.json`(退出即删)和 dsh 的回环例外:dsh 的 fetch 栈对回环目标无条件绕过代理 env,所以本地上游保留持久 `~/.dsh-bili` overlay 改写,直到 dsh 提供 settings-path env 或上游支持回环 opt-out。旧版本创建的 overlay 目录原地保留,绝不合并回真实 home。

## 两种压缩模式 —— 谁执行 `compress`

代理有两种工作模式,**模式决定谁来执行 `compress`,进而决定摘要以什么形式("载体")到达模型**。这一区分是 #377 的根源。

| | **启动器 / 插件模式**(`bili pi`、`bili codex`、…) | **代理模式**(普通客户端 → `/bili/`) |
|---|---|---|
| 客户端 | 带 bili 扩展的 ACP 原生 agent(pi/omp) | 任意 OpenAI/Anthropic 客户端,无扩展 |
| 谁执行 `compress` | **agent**(pi 在本地执行) | **代理**(服务端压缩循环) |
| 重发历史里有 `compress` 工具调用吗? | 有 —— agent 自己对话的一部分 | 没有 —— 临时性的代理循环流量 |
| 预检块(没有工具调用时)? | 最后防线 —— agent 通常靠自己的 `compress` 调用压缩,但仅输入就超窗时 `src/preflight.ts` 仍会触发(两种模式都如此,#470) | 有 —— `src/preflight.ts` 在客户端背后压缩 |
| **线上摘要载体** | **`compress` 工具调用本身** | **一条 `acp_summary` user 消息** |
| 线上的 system 消息 | 恒为 1 条(客户端 + prompt) | 恒为 1 条(客户端 + prompt)—— 摘要走 user 消息 |
| SGLang「单 system」400(#377) | 不可能发生 | 不可能发生(摘要是 user 消息,不是 system) |
| 代理注入的 `compress` 工具 | 无 —— agent 原生注册 4 个 ACP 工具 | 4 个上下文工具(启用时) |
| 代理注入的 nudge | **有** —— agent 自己没有 nudge 通道,代理侧 nudge 就是主动压缩触发器(仅预检只在硬上限才触发;#451) | 有(启用时) |

**为什么载体不同。** 插件模式下 agent 拥有压缩权:`compress` 调用 + 结果都在 agent 自己的历史里、每轮重发,所以摘要搭在工具调用上,agent 视图从不渲染内核的 `acp_summary` 兜底(`billion-context-pi` 的 `src/messages.ts` 跳过 `acp_summary_*`)。代理模式下客户端不是 ACP 原生的,由代理在服务端执行 `compress`;工具调用从不进入客户端历史,预检块则根本没有工具调用 —— 于是内核的 `acp_summary` 消息成为唯一载体。内核把它渲染为 role `system`,但严格的 OpenAI 兼容后端(SGLang)要求 index 0 处恰好一条 system 消息,所以 `systemToUser`(`src/util.ts`)把它改声为 `user` 消息,留在原锚点位置。这使头部 system 消息(前缀缓存锚点)在压缩轮之间保持字节稳定,新块不会使整段对话前缀失效。

**为什么是 `user`,而不是 `system` 或伪造的工具调用。** 流中间的 `system` 消息正是 SGLang 拒绝的东西(#377)。伪造一个 `compress` 工具调用是「更纯粹」的载体,但在代理模式下需要按 id 捏造 assistant `tool_calls` + user `tool_result` 对、在请求里声明该工具、还要处理没有真实调用的预检块 —— 远比改声一条独立笔记侵入得多。`user` 消息允许出现在对话任何位置,是同时满足 SGLang 单 system 规则与前缀缓存稳定的最小改动。接受的取舍:摘要是被折叠历史的替身,把它改声成 user 回合是一种模型能容忍的语义错位(它被明确标记为 `[Compressed conversation section]`)。

**两种模式能共存吗?**

- **同一代理实例:可以,且是设计使然。** 一个代理同时服务插件客户端与普通客户端;`pluginMode` 按请求判定(`x-bili-plugin` header)、按会话绑定(`session.metadata.pluginAgent`)。启动器复用已在跑的代理。
- **同一会话:模式是粘滞的。** 插件模式创建的会话保持插件模式(metadata 继承);普通会话只能被*升级*为插件模式 —— 当带匹配会话 id 的插件请求到来(header 优先)—— 且永不降级。实际上 plain→plugin 升级要求插件客户端的会话 id 与既有普通会话 id 相同,而这不会发生(各客户端自生成 id)。
- **跨模式块风险:仅理论存在。** 它需要同一个会话 id 跨越一次模式切换。plugin→proxy 安全(工具调用在共享历史里);proxy→plugin 可能孤立代理创建的块摘要(其工具调用不在 agent 历史里,而 agent 视图跳过 `acp_summary`)—— 但那需要上述的 id 匹配,实际不会发生。

**如何验证一次压缩真的落地了。** 执行 `compress` 后,代理以纯 assistant 文本发出确认标记(`📦 [ACP] Compressed …`)—— 但在持续上下文压力下曾观察到模型*自行写出该标记格式*却从未调用工具(#717):约 2 小时内 17 次假「压缩」,真实用量一路涨到 89%。因此转录中可见的标记行不是持久化的证明 —— 先以 `acp_status`(块数增加、可压缩区间起点前移)核实再采信。作为兜底,代理会剥离模型自行发出的任何形似标记的行并记 `[marker-echo]` 警告,nudge 与注入提示也都明确声明标记只由代理发出。

## 单写者:哪份拷贝归谁管(#991)

一台机器上每一份 bili 存在物恰好有**一个写者** —— 装它的那个东西负责更新它,其他任何东西都不就地覆盖那份拷贝:

| Lane | 拷贝住在哪里 | 由谁更新 |
|------|---------------|------------|
| 全局 `bili` | npm global(`npm i -g billion-context`) | `bili update` / 后台自动更新 |
| **pi** | pi 的包管理器(npm 形态) | **`pi update`** —— bili 从不覆盖 |
| **opencode** | opencode 的插件目录 | **opencode 的插件管理器** —— bili 从不覆盖 |
| **dsh** | 每个 profile 的 pnpm store | 周期性检查按 profile 重跑 dsh 插件通道 —— 由全局 bili 自更新驱动,**或在全局没跑时由 profile 拷贝自己的代理驱动**(dsh 市场安装,#1196);手动:`dsh plugin add billion-context@latest`。pnpm 硬链接 store 绝不可就地覆盖拷贝 |
| omp / claude / codex / kimi / zcode | 无拷贝 —— 条目指向全局 bili 安装 | 随全局拷贝一起更新 |
| **hermes** | `~/.hermes/plugins/billion-context/`(拷贝文件 + 指向全局 dist 的 `bili.json` sidecar) | **`bili plugin update hermes`** 重新拷文件;sidecar 跟随全局安装 |

这在代码里强制,不只是约定:自更新器(`src/update.ts` → `hostManagedInstall`)识别 pnpm 虚拟 store(`.pnpm`)或宿主 agent 树(pi / opencode / dsh / kimi / omp home)下的安装目录并**跳过**它们;`installViaTarball` 从结构上拒绝它们,直接调用方也无法损坏 store。混用*命令*没问题(`dsh plugin add` ≡ `bili plugin install dsh` —— 同一通道、同一记录);混用*写者*才是守卫禁止的事。`bili plugin update [client]` 是唯一能驱动每条 lane 走各自 owner 的命令,并打印逐 lane 更新路径(`bili plugin list` 显示同样的逐 lane 通道)。
