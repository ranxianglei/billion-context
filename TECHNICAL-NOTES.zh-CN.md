# 技术细节

README 三种使用方式背后的机制级说明。README 里每种方式只保留简洁的用法;「它到底怎么工作」的内容都放在这里,而不是夹在三种方式中间。

## 原生插件生命周期(方式 1)

插件加载时**自拉起自己的代理**(已有健康实例则直接复用 —— 父进程 pid 看门狗在客户端退出时收掉它),把模型流量改写到 `<proxy>/bili/<上游URL>`,把 `compress` / `decompress` / `acp_status` 注册为客户端原生工具(plugin 模式),并把 `/acp` 面板绑定到当前会话。插件还会把客户端**自己的模型配置**上报给代理(runtime-info 协议,#955),压缩预算用真实窗口而不是注册表猜测。退出开关:`BILI_NATIVE_PI=0`、`BILI_NATIVE_OMP=0`、`BILI_NATIVE_OPENCODE=0`、`BILI_NATIVE_DSH=0`、`BILI_NATIVE_KIMI=0`、`BILI_NATIVE_HERMES=0`、`BILI_NATIVE_ZCODE=0`。

## 代理复用与附着门禁(#1225、#1335、#1232、#1660)

原生 hook 可以附着到已在运行的代理而不自己拉起 —— 仅当通过下面的生命周期门禁。复用基于身份(#1225):只有当既有代理运行的是**同一份代码**(入口脚本 sha256,记录在实例文件里)、**lane 兼容**(每个启动器声明其客户端 lane,两个*不同声明的* lane 永不共享;未声明 lane 的实例是手工拉起的用户主权区守护进程,在该轴上通配)、**且通过生命周期门禁**(见下:armed 父进程 pid 看门狗 `watchdog.armed == true`,即由带父 pid 的启动器拉起、随最后一个附着会话消亡;**或**属用户主权区实例 —— 无 lane、无 launch token —— 按定义豁免,#1660)时才附着。#1225 之前写入的实例没有代码指纹,因此永不附着:重建或更新后的安装下次启动总会拉起新代理,修复立即生效而不是静默服务旧代码。

| 监听者 | 附着? | 原因 |
|---|---|---|
| 本会话拉起的代理 | ✅ | 出生即 armed |
| 其他会话的 armed 共享代理(watcher 集,#1186) | ✅ | 共享本就是设计 |
| 手工 `bili start` 常驻守护进程(用户主权区,#1660) | ✅ 默认附着 | **用户主权区**实例(无 lane、无 launch token):用户刻意维护 —— 其寿命与版本由你自己负责;仅当 `BILI_NATIVE_ATTACH_EXTERNAL=0/false` 显式关门时才拒绝 |
| 未武装的 **lane 型**代理(崩溃会话孤儿;pre-#1330 不可验证) | ❌ 大声拒绝 | 生命周期漂移症状(#1335):搭乘等于静默复用无人管理的代理 |

hook 附着前先探测候选者的 `/__bili/health`:armed → 附着并注册 watcher(现状不变);**用户主权区**候选无论看门狗状态默认附着(#1660)—— 用户刻意维护该守护进程;未武装的 **lane 型**候选(崩溃会话孤儿,或 pre-#1330 构建根本不报 `watchdog` 字段 —— 不可验证,按 unarmed 处理)被**大声拒绝**,本会话在自管端口区自拉起代理(基准口 `18787` 或该 lane 粘性漂移记录;出生即 armed、随最后一个会话消亡,#1186 watcher 语义)。版本偏斜仍被修住:代码指纹检查先行,重建/更新后的安装即使经用户主权区豁免也永不搭乘陈旧守护进程。代价:无可附着实例时每会话多一个短命代理进程(会话状态在磁盘上共享,压缩连续性不受影响);多实例告警(#394)相应变多。**逃生舱:** 配置文件 `"native": { "attachExternal": true }` 或 `BILI_NATIVE_ATTACH_EXTERNAL=1` 把附着扩展到 *lane 型*监听者(无论看门狗状态,含 pre-#1330 构建)—— 那些守护进程的寿命与版本由你自己负责;`0`/`false` 对所有人关门,包括用户主权区守护进程,强制各 lane 自拉新代理。kimi/dsh 的显式用户指定附着(`BILLION_CONTEXT_ATTACH` / 预置 `BILLION_CONTEXT_PROXY`)完全不经过发现路径,构造上豁免。

附着发现在**所有**存活实例间是 lane 感知的(#1232):启动器探测实例注册表里的每一条存活记录,而不只是单个实例文件(last-writer-wins —— 并发多客户端下它可能指向别的客户端的代理),并对每个候选应用上面的门禁。兼容候选中,lane 与启动器自身声明一致的最新实例胜出;未声明 lane 的实例(用户主权区守护进程)在 lane 轴上通配,且门禁默认豁免(#1660)。`another bili instance is running` 告警(#394)也是 lane 感知的:同 lane 或无 lane 共存时触发,两个*不同声明* lane 之间保持沉默(它们的会话文件互不相交)。

## 共享 state 目录与多实例安全边界(#394、#1724)

同一台 host 上的每个 bili 实例读写的是**同一组** per-host 存储:XDG data 目录(`~/.local/share/billion-context/` —— 会话记录、CCR content-store、prefix-affinity)加 state 目录(`~/.local/state/billion-context/` —— 日志、实例注册表)。控制面是 lane 感知的(#1232:附着发现与 #394 共存告警都尊重已声明 lane),但**数据面没有分区** —— 既无按会话的属主,也无按 lane 的磁盘隔离。由此带来两个后果:

- **跨实例会话可见。** 每个实例的 Web UI(`__bili/sessions` list / detail / logs)都会重新扫描整个共享存储,因此任何经回环可达的实例都能枚举并读取*任意*会话 —— 原始报文、content-store 载荷、压缩块 —— 无论它由该 host 上哪个其他实例/lane 创建。
- **重启 drain 竞态。** 重启时新进程在旧进程完成 flush 之前就 hydrate 了存储,last-writer-wins 可能丢掉旧进程的最终写入:tail 更新丢失,以及 provider 前缀缓存击穿(出站 body 与 provider 已缓存的前缀分叉)。#1724 的缓解措施:#405 快照计数器守卫(拒绝陈旧会话写入)、prefix-affinity union-on-write 守卫(#1737:一个实例的 flush 永不覆盖兄弟 chain)、自重启顺序修复(#1742:durable state 在替换进程 spawn 之前落盘)。host 驱动的重启(dsh 等,#991)仍依赖这些数据层守卫,因为其 kill/spawn 顺序不受 bili 控制。

**安全边界:** 共享 state 面目前**仅**由管理端点的回环门禁(非回环源地址被拒绝)+ 用户 home 树下这些目录的文件系统权限保护(两个目录都在 $HOME 下)—— 没有按会话的鉴权。对**单用户 host** 这已足够。对**多用户 host** 则不够:任何能触达代理回环端口的本地账户都能读取所有用户的所有会话。这类 host 必须给这组 per-host 存储分区(按用户/按 lane 子目录)—— 即 #1724 指出的根因修复(direction #1),目前仍作为架构决策开放;Web UI scoping(#1724 direction #4)能减少跨实例浏览,但不改变这一边界。

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

Claude Code 没有进程内扩展点,所以 `bili plugin install claude` 往 `~/.claude/settings.json` 写一个受管块(env `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/bili/<upstream>`、`DISABLE_AUTO_COMPACT=1`、`SessionStart` hook),外加同样的用户级 MCP shell。hook 在首个模型请求前触发,端口解析与所有 lane 一致(#1660):显式钉死(`BILI_CLAUDE_NATIVE_PORT` > config `claude.nativePort`)→ 该确切端口**严格端口**启动(占用者被大声拒绝,#964 保留);否则骑自管区 —— 该 lane 粘性记录优先,否则基准口 `18787` —— 非严格,子进程 EADDRINUSE +1 阶梯解决碰撞,落定端口粘性记录。阶梯有一个例外(#1723):lane 端口的持有者是**不同构建**的同 lane 实例(升级重启重叠——旧版本还在排水)时,子进程等它释放(最多 5 秒)后复用*同一*端口,而不是漂移;持有者永不退出则等待预算耗尽,照旧走 +1 阶梯。代理就绪后 hook 每会话把受管 `ANTHROPIC_BASE_URL` 重钉到存活 origin(`repinClaudeManagedBaseUrl`),跳口后下次启动自愈,烘进 URL 永不与运行中代理失步。上游覆盖:`BILI_CLAUDE_UPSTREAM`(或既有 `claude.anthropicBaseUrl`)。install 不再持久化 `claude.nativePort`。`BILI_NATIVE_CLAUDE=0` 退出 —— hook 改为在同一解析端口上拉起 **passthrough** 代理(原样转发、关闭压缩)。块是纯 JSON merge/strip:外部键从不触碰,`bili plugin remove claude` 精确还原。装有原生块的机器上 `bili claude` 仍可用 —— 它用自身代理覆盖静态 URL,hook 保持休眠。

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
