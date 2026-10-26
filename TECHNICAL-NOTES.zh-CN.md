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
| 手工 `bili start` 常驻守护进程(用户主权区,#1660) | 🔶 视情况 | **用户主权区**实例(无 lane、无 launch token):一台**已武装**的(受管共享代理,#1225)会被任何兼容 client lane 搭车;一台**未武装**的手动守护在默认(`attachPolicy: own-lane`,#2877)下**不会**被 lane 型 hook 搭车 —— 它自行派生。仅在 `attachPolicy: global-fallback`(pre-#2877)或 `attachExternal=1` 下被搭。无论哪种,寿命与版本由你自己负责 |
| 未武装的 **lane 型**代理(崩溃会话孤儿;pre-#1330 不可验证) | ❌ 大声拒绝 | 生命周期漂移症状(#1335):搭乘等于静默复用无人管理的代理 |

hook 附着前先探测候选者的 `/__bili/health`:armed → 附着并注册 watcher(现状不变);一台**已武装的用户主权区**候选无论 lane 亲和策略都附着(受管共享代理,#1225);一台**未武装的用户主权区**(手动)候选仅在 `attachPolicy: global-fallback`(pre-#2877)或 `attachExternal=1` 下附着 —— 默认(`own-lane`)lane 型 hook 自行派生(#2877);未武装的 **lane 型**候选(崩溃会话孤儿,或 pre-#1330 构建根本不报 `watchdog` 字段 —— 不可验证,按 unarmed 处理)被**大声拒绝**,本会话在自管端口区自拉起代理(基准口 `18787` 或该 lane 粘性漂移记录;出生即 armed、随最后一个会话消亡,#1186 watcher 语义)。版本偏斜仍被修住:代码指纹检查先行,重建/更新后的安装即使经用户主权区豁免也永不搭乘陈旧守护进程。代价:无可附着实例时每会话多一个短命代理进程(会话状态在磁盘上共享,压缩连续性不受影响);多实例告警(#394)相应变多。**逃生舱:** 配置文件 `"native": { "attachExternal": true }` 或 `BILI_NATIVE_ATTACH_EXTERNAL=1` 把附着扩展到 *lane 型*监听者(无论看门狗状态,含 pre-#1330 构建)—— 那些守护进程的寿命与版本由你自己负责;`attachExternal` 只管辖 **lane 型**守护的*生命周期门禁*(它并不开/关对 user-zone 的附着 —— 那个轴是 `attachPolicy`);`attachUrl`(env `BILI_MCP_PROXY` / `--origin`)钉住显式目标 origin。kimi/dsh 的显式用户指定附着(`BILLION_CONTEXT_ATTACH` / 预置 `BILLION_CONTEXT_PROXY`)完全不经过发现路径,构造上豁免。

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

窗口解析顺序:`anthropic-beta` 协商 > 逐请求 plugin 头 > runtime-info > launcher 环境变量 > 路由配置 > models.dev 注册表 > 内置表。runtime-info 这一步:带 `x-bili-plugin` 头的请求读**按 agent 的条目**(agent+model 必须匹配);不带该头的请求解析以 `conversationId` 记录的**会话级条目**,键与会话绑定的同一会话信号一致(客户端会话头、自定义 session 头或请求体的 `prompt_cache_key`)—— 无论哪种,model 都必须匹配(#1531:omp 打 `prompt_cache_key` 但不打 plugin 头,且主/子代理会话共用 agent 名却跑不同模型)。上报的 `maxOutput` 仅在请求体自带输出预算缺席时兜底。现有实现:`src/agent/pi.ts`(覆盖 pi 与 omp)、`src/agent/opencode-native.ts`(v1)、`src/agent/opencode-v2.ts`、`src/agent/dsh-native.ts`、`src/kimi/native-mcp.ts`(仅自举时上报 —— kimi 的 provider `custom_headers` 是静态的,逐请求头会在模型切换后过期)、`hermes-plugin/__init__.py`(Python 插件:经 `llm_request` 中间件打逐请求头,`pre_api_request` hook 捕获最大输出与宿主 per-model 上下文窗口 —— 窗口读自 hermes 自己的 `HERMES_HOME/context_length_cache.yaml`,任何缺失/歧义 fail-open(#3261))—— 其他客户端接入请遵循同一协议。

**omp:当 OMP 的 Cowork 传输接管出口时,不打 `prompt_cache_key`(#2583/#3556)。**native omp 模式下,打上的 `prompt_cache_key` 是唯一的逐请求会话信号,其唯一消费者是 bili 自己的 fetch 层拦截器(把模型 URL 改写成 `<proxy>/bili/<url>` 并在转发前剥掉该字段)。较新的 OMP 构建带有 "Cowork 传输"(2026-07-30 引入,can1357/oh-my-pi `642892ae`;代理处理 `e22a5ff2`):默认 `anthropic`/`anthropic-messages` 请求经 node:https **直发** —— 除非显式代理环境变量(`PI_PROXY` / `PI_PROXY_ANTHROPIC`)把它们推回 Bun 的 fetch,否则根本不经过 `globalThis.fetch`。自 #3556 起,`bili omp` 启动器自行关闭了这一缺口:除非用户已设置 `PI_PROXY` / `PI_PROXY_ANTHROPIC`,否则它会导出 `PI_PROXY_ANTHROPIC=<proxy origin>`,因此在默认启动器通道上,Cowork 走可压缩通道(打上的 key 由代理消费并剥离),而非直发。打戳放弃同时门控 cert-MITM 通道 —— #3556 把它提到了目的地路由检查之上,嵌套放置会完全跳过它。在那条路径上打戳会让字段原样进入 Anthropic 严格 schema(HTTP 400 `prompt_cache_key: Extra inputs are not permitted`)。打戳闸门(`src/agent/pi.ts` 的 `stampPromptCacheKey` → `ompCoworkTransportBypassesFetch`)镜像 OMP 自己的按模型出口选择:证明直发时不打戳,并每进程每模型警告一次。后果:这些直发请求不经压缩、对代理匿名(身份/面板/账单退化 —— 与 #1403 同一取舍);其余 lane(launcher `/bili/` 改写、MITM 白名单、其他 provider/api、配置了代理的宿主)不受影响。已知残留:`NO_PROXY`/`no_proxy` 规则命中模型 host 时,即使设置了 `PI_PROXY` / `PI_PROXY_ANTHROPIC`,OMP 的代理处理也会被静默 —— 请求直发但已打戳(同类 400);这类 host 应从 `NO_PROXY` 中移除而非依赖打戳闸门。反向不对称是 fail-safe 的:OMP 的按形状 fetch 回退(Request 对象入参、非 record headers、不支持的 body)即使没有任何代理环境变量也会走回 `globalThis.fetch`,那里放弃打戳只退化身份、不会硬失败。完整覆盖需要宿主侧变更(Cowork 出口改走 `globalThis.fetch`)—— 作为边界注记记录在 #2583。

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

## 会话卡死自愈 —— 检测常量与补救(#2155)

三种故障形态共享 `src/session-self-heal.ts` 里的同一族检测器,每请求评估一次(prepare 之后,仅有 nudge 的主车道;旁路/侧请求车道不积累信用):

- **D2 僵尸插件车道** —— 插件已卸载(或 MCP 子进程已死)但已开着的客户端窗口仍带着插件绑定(粘滞 `metadata.pluginAgent`)。信号:连续 5 轮(`SELF_HEAL_WINDOW`)被 nudge、**无** `x-bili-plugin` 头、线上**无** bili 工具声明、**零**压缩缩减。补救:**降级为代理模式** —— 单点 `pluginMode` 翻转(`pluginAgent !== undefined && !pluginLaneDegraded(session)`)线上回注 ACP 工具、重新接管压缩 rewriter/CCR 盖章/absorb,并**保留 nudge**(工具回来了)。线上注入不可用时(`compress.injectTool=false` → `degradeAvailable=false`)退为**静默 nudge**。恢复:**活的**插件头(`pluginLaneRestore`,在 `pluginMode` 翻转**之前**调用,首个带头请求即恢复 plugin 模式 —— 恢复信号绝不能用粘滞 `pluginAgent`,否则降级一轮后即被自己清掉)。绑定保留、永不抹除。
- **D1 nudge 空转**(非插件泛化)—— 连续 5 轮被 nudge 却零缩减、零 bili 工具调用。补救:在全部四处 `willInjectNudge` 门加 `&& !nudgeSuppressed(session)`(覆盖 emergency 路径)。恢复:任一次压缩缩减或 bili 工具调用即解除——或者在 `SELF_HEAL_SUPPRESS_CAP_MS`(10 分钟)内两者皆无时,抑制到时自解并重新武装(#3004/#3008:上下文单调增长时永远产生不了恢复证据,纯证据式解除曾把建议通道锁死一个多小时而用量停在 ~75%)。重新武装是有界的:再空转完整一个 `SELF_HEAL_WINDOW`(5 轮)才会再次抑制;决策梯的 fallback 逃逸在抑制期间仍可打出一次性 legacy 建议(`consumeFallback` 重置计数)。
- **D3 网关杀摘要** —— **非流式** preflight 摘要以 HTTP 524/504(Cloudflare 类)死亡时不再原地重试(旧的 transient 重试对着死网关每次烧 ~100 秒);会话在**首次**命中即学习 `metadata.preflightStreamSummary = true` 并改用 SSE 重取摘要 —— 与手动 `compress.streamSummary` 旋钮(#2133)同一学习存储,自动武装。级联双向被尊重:任一级显式 `streamSummary: false`(global → provider → model)即操作员 opt-out —— 两条学习路径都不武装、已学习的旧标志被忽略(`PreflightDeps.streamSummaryOff`)。

可观测:`session.metadata.selfHeal = { detected, action, since }` 进 `/__bili/sessions`、web UI 挂"自愈"徽标、每次转换一行 `[self-heal]` 日志(检测+恢复)。`bili plugin remove <client>` 尽力查询活代理(instance 文件 → `GET /__bili/sessions`,2.5 秒超时,失败静默),该客户端近 **10 分钟**内有活跃会话时打印提示。

## ACP 标签回声统一整治 —— 四条不变量(#2023/#2066/#2190/#2248)

一个 PR 把三条整治腿合并(refs-run 残留 #2023、退化闭名剥离+出口审计网 #2190、emission 整段丢弃+签名思考 verbatim #2066),并统一受四条硬规则约束 —— 覆盖**所有**文本改写面(loop 适配器、插件直通、JSON strip 函数、出口审计):

1. **思考通道逐字节不动。** Anthropic `thinking`、Google `thought`、OpenAI `reasoning_content`/`reasoning`、Responses reasoning summaries 原样透传 —— 哪怕长得像标签回声。理由:reasoning 回放(DeepSeek 式)与签名校验验证的就是这些字节,任何改写都会让它们失步并卡死会话(#1960/KDD#10)。适配器侧走 `createIdentityStreamFilter`,strip 函数(`stripOpenaiChatText`、`stripResponsesText`)同样不动它们(纵深防御)。**注意:这翻转了 #1881 时代的 reasoning 回声剥离 —— 思考通道不再清洗。**
2. **模型的正文输出可以治理。** 渲染标签回声、marker 行、bili 内部文本、退化开/闭名残骸,以及(absorb 受指令时)整段工具调用 emission,只在可见文本通道剥离。
3. **模型写入文件的内容逐字节不变(#1039)。** 工具调用 arguments 无论携带什么字节都不进任何过滤器。
4. **用户发送的消息永不被改写。** 用户自己片段的逐字回声在武装清洗下也保留(#463 豁免,按请求文本匹配,不按形状)。

出口审计网(#2248)保持仅记日志:裸出口(未识别帧、解析失败)原样转发并打 `[tag-echo] raw exit` 日志,新泄漏形状可见而不改线上行为。由 `tests/unified-acp-invariants.test.ts` 钉住(8 个测试,两条 lane)。

## OpenAI 聊天线路的 `prompt_cache_key`:默认处处打戳,严格上游用受控 A/B 保护(#2218/#2645/#3556)

dsh 插件道中,body-keyed 中转站能读到的身份信号只有一个:请求体的 `prompt_cache_key`(会话头 `x-bili-plugin-conversation` 是 bili 内部头、不会以原名转发;读头的中转拿的是 `x-session-id`)。两个相互冲突的群体在这里相遇:严格的直连 API 会对未知 body 字段回 400 —— 而且严格性是**同源按模型**的(#2645:同一个 NVIDIA 网关下,一个模型收这个 key,它的兄弟模型拒收);而号池(包括**远端**中转池)把这个 key 当前缀缓存路由来读,在哪里丢它都会无声地拉低那些会话的缓存命中(#1403 类的反面)。目的地形状的门控裁决不了这件事:只给回环盖章(#2649 的尝试)治好了严格 API,却让两类最大的池子群体(docker 网桥/局域网/VPS/域名池)失去亲和。最终设计 = **默认全盖章 + 实证自愈(probe-and-remember)**,在 #2649 评审中由 owner 定案:

- **打戳**(`resolveRelayAffinityPck`,`src/session-id.ts`)—— 插件道对**一切**目的地默认盖 `prompt_cache_key=<会话 id>`;客户端自带的 key 在其配对被 A/B 证实前原样透传。零配置面:无新配置字段、无环境变量、无 CLI 旗标。
- **探测**(`src/server/relay.ts`,与 #552 兼容阶梯同一 buffered-body 缝)—— 出口体带着该 key 的**第一个** 400 触发:把同一 payload 去掉 `prompt_cache_key` 后重发一次。重试成功 ⇒ 因果坐实:采用该响应,把 `origin(+model)` 记入进程内存(`src/pck-probe.ts` —— **仅内存**,重启重新探测)。重试也失败 ⇒ 不是这字段的锅:丢弃重试,把原始 400 原样转发,什么都不学 —— key 保留,下一轮再探(400 成因很多;只有 A/B 判词可以停用)。每请求至多探一次;无循环。
- **记忆效应** —— 被停用的配对在后续轮次同时停掉 bili 自己的戳和客户端自带的 key(否则每轮都要重付一次 400 往返)。粒度是 origin+model:共享池源上一个严格模型不影响兄弟模型。解析不了的 origin 一律 fail-open(保持盖章)。
- **可见性** —— 首次停用打 WARN 日志,写明 origin/model、受影响会话、以及号池提示(该目的地可能是你的中转/号池,前缀缓存亲和可能下降);`acp_status` 段与网页面板横幅(中英)展示当前停用列表与会话;脚本可经 `GET /__bili/status` 的 `pckSuppressions` 字段读取。全程进程级状态,重启即清空并重新探测。
- **双模式推理** —— 只有插件道(注册 agent / dsh 插件,内部会话头在场)会打戳;纯代理模式双向都是原样透传,逐字节不变。

pi/omp 线路沿用各自的独立打戳门(上文 Responses 线路的 `prompt_cache_key` 提升、Cowork 弃戳)——本节只讲 OpenAI **聊天**线路。
