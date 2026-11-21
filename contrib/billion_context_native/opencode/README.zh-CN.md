# billion_context_native：OpenCode V2 原生归档薄适配器

这是 billion_context_native 本地归档适配器，使用经过源码核对的 **OpenCode V2.2.5** 插件接口。未启用时不订阅事件、不读取 session、不创建档案目录。当前只接受这一已核实版本；V1 不适用，其他 V2 版本需重新核对并验证，不能直接视为兼容。

本层不替换模型请求路径、不设置 provider/model、不改变 OAuth/代理，也不主动触发 compaction。它把显式选择的根 session 的宿主 JSON 对象写入既有 `events.jsonl` 事实档案；SQLite 与阅读视图仍可由该事实源重建。原生事件、prompt、当前消息快照、工具 before/after 对象均保留来源与身份。没有通过伪造 Claude Code transcript 来充当原生事件。

## 安装与选择范围

保留完整源树中的 `plugin/billion_context_native/` 和本 `opencode/` 目录，Python 3 使用标准库，无需 npm 安装。将 `opencode.example.jsonc` 的本地 plugin、MCP 路径合并到**明确要启用的项目**配置，不改现有 provider、主模型或登录设置。配置仅供合并参考，不应覆盖整个现有配置。

必需的 opt-in 是 `enabled:true`、`projects` 精确绝对路径和 `sessions` 原生 session ID 列表三者同时满足。项目路径使用 realpath 比较；每次采集都会重新核对 `session.get` 的 location 与 parentID，避免移动后的 session 跨项目采集。子 session 不混入主会话。没有扫描“最近会话”、全量用户目录或其他项目；未选择的 session 不写事实档案。

`archiveHome` 为明文私人存档目录。建议放在代码仓库外，不要提交或同步它；默认是项目内 `.recall-opencode`，使用默认路径时应自行加入忽略。MCP 的 `BILLION_CONTEXT_NATIVE_HOME` 必须与它相同，并使用空的独立 `BILLION_CONTEXT_NATIVE_PROJECTS`，避免发现无关 Claude Code transcript。并行会话的 search/get 应明确传原生 `session_id`。

MCP server key 为 `billion_context_native`。示例权限先对 `billion_context_native_*` deny，再只允许 `billion_context_native_recall_search` 和 `billion_context_native_recall_get`。功能操作名仍是 `recall_search` / `recall_get`，不改存储身份或 locator。迁移时替换旧 server key、权限命名空间和源码路径，不要同时加载新旧适配器；见 [迁移说明](../MIGRATION.md)。

共享核心的七项配置环境变量优先使用 `BILLION_CONTEXT_NATIVE_*`，未设置时兼容旧 `RECALL_*` 同后缀变量，显式空值不回退；解释器仍使用 adapter 的 `python` 字段，CC 启动器保留 `RECALL_PYTHON`（没有新名别名）；默认 `.recall-opencode`、既有 `archiveHome` 和存档字节不因改名而改变。

本示例只开放 `recall_search/get`。共享 MCP 中的 `compact_ready/status/rule` 仍有 Claude Code 专用语义，不是 OpenCode 的压缩控制或 veto；不能用它们声称阻止了 OpenCode compaction。

## 支持点与持久化顺序

- `session.prompt`：支持的可等待准入 hook 中，先保存该 hook 接收到的 prompt 对象与 message ID，明确标记 before-admission，再快照既有上下文并取得持久 ACK。这一观察不冒充宿主已提交/交付的用户消息；仅有未准入观察时阅读视图应保留 pending 标记。
- `session.context`：每次主模型上下文构造前保存 `ctx.session.context({sessionID})` 返回的当前原生消息；不修改模型输入。
- `tool.execute.before/after`：保存真实 hook 的输入、结果或错误，关联 messageID/call ID，Python bridge 在 `events.jsonl` flush/fsync 和派生索引提交后才回 ACK。归档失败只把 Recall 标为 degraded/not-ready；before/after hook 均正常返回，让宿主继续原有工具行为，不回滚或改变工具副作用。
- `session.compaction`：在官方模型摘要 hook 中 await 当前快照和归档 barrier，不设置 `event.result`，不生成假摘要。归档失败在适配器内部捕获、记录 degraded 后返回，不抛出阻止宿主摘要或主请求，也不设置假的摘要结果；这不是 PreCompact veto。某些 provider-native compact 路径可能不经过该模型 hook。
- `experimental.idle`：模型工作完成时保存最终当前消息并等待归档。官方说明 interruption/failure/control-only compaction 不一定触发此 hook。
- `ctx.event.subscribe`：只订阅已核实的 V2 session durable 边界类型（包括 `session.tool.input.ended` 原 JSON 字符串、工具成功、完整文本结束）。只处理已选择根 session。事件订阅是异步观察，不是宿主事务参与者。

bridge 使用进程 stdin JSON，一次请求只针对一个 session；不通过 shell 解释命令。子进程只继承最小 PATH/locale/temp 环境与指定归档目录环境变量，不继承 provider key。ACK 必须具有正确 `session_id`、`host=opencode`、`main_session=true` 和 `durable=true`。不明确的 ACK、timeout、失败退出或超过容量时不会伪称成功，也不会截断后标“完整”。

## 必须保留的保证边界

保存的是官方接口实际暴露的 **JSON 对象/字符串**，不是 provider 的网络原始字节。其他插件可能在本 hook 之前转换对象。通用 tool-after 位于宿主通用归一化之前，但工具自身可能已截断或仅返回 `outputPath`；当前不会自动读取该路径、下载 URL 或抓取附件，因此不能保证每种工具的执行端原始字节都完整。引用仅按原对象保存；应结合事实记录中的来源和输出形态判断。

`session.context` 只返回当前 active 上下文；压缩完成后再启动的 adapter 不能凭它补回已丢弃内容。插件事件订阅是宿主 bus，不是带 `server.connected` 的 HTTP/SSE client stream，也没有 `after` 重播游标；流中断、崩溃或插件停用期间的事件，不能承诺完整补偿。每次插件激活返回后，仅逐一快照已选择 session 并留诊断，不能将该快照当成旧原始事件的重播。工具 hooks 已同步 ACK 的记录及此前持久化事实可在进程重启后恢复；尚未被观察/ACK 的原始对象没有无损保证。

同一内容/身份/原生版本重复观察由共享归档幂等处理。新版本与冲突版本追加保留，不以到达时间覆盖。观察时间不是宿主版本；durable 原生事件的 aggregate/seq/version 和 message 的原生 time 字段会分别保留。

## 故障、恢复与停用

桥超时、磁盘满/只读、非法 JSON、索引/归档拒绝等会将当前插件实例的该 session 标记 degraded。故障闩锁后 Recall 不再确认该实例的 barrier ready；但 prompt/context/tool/compaction/idle hooks 都捕获归档或 session 查询异常后正常返回，宿主主请求、压缩与工具按原流程继续。异步订阅出错同样只降级 Recall，不能回滚宿主已经发生的操作。诊断文件 `opencode-adapter-status.jsonl` 只含操作/计数/身份，以及 bridge 失败的安全枚举、退出码、错误类别；不保存 raw stderr 或错误 message，也不写消息内容或 provider key。卸载期间 ACK 不明标为 `shutdown_unacknowledged`；如果诊断本身写失败，内存 not-ready 闩锁仍生效，但磁盘诊断未必存在；该闩锁不用于阻断宿主。

遇 degraded 时应检查/修复档案存储与 bridge，再重启插件/会话；宿主已获准继续的这段时间可能产生无法补回的归档缺口，不能以之后一次成功快照把旧缺口标为完整。档案已 fsync 但 ACK 丢失的结果不明时，可通过同一身份幂等重放核查，不应删除事实档案或把索引当事实源。重启可重建已持久事实的索引；不能修复停用/故障期间未捕获的宿主原文，必须保留缺口说明。

禁用：把该 plugin 配置中的 `enabled` 改为 false，或从 `plugins` 中移除这一本地目录，并重启/确认卸载已生效；取消相应 MCP 配置与仅为本插件添加的权限。插件不会自动删除用户档案。彻底卸载时，在确认无需数据后手动移除专用存档目录；不需要改变 OAuth、主模型或其他宿主插件。

## 可选边界参数

`python` 是单个解释器命令（默认 `python3`）；`bridgePath` 可指定明确绝对脚本路径。`bridgeTimeoutMs` 默认 20000，允许 100–60000。`maxEnvelopeBytes` 默认 32 MiB，允许 1 KiB–128 MiB；超过即失败，不截断。项目与 session 配置错误不采用宽泛 fallback。配置/版本校验失败由 [V2.2.5 官方插件 loader](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin.ts#L63-L104) 隔离：清理该次激活已注册的 hooks，插件标为 failed，宿主继续；不把配置错误吞成“插件已正常归档”。

实际兼容性、真实事件/compaction/模型证据和未验证项，以交付的测试报告为准，不能仅凭本 README 将未运行的验收项目标为通过。官方接口依据另见 `API_CONTRACT.zh-CN.md`。

## 本地故障检查

`node opencode/test-local.mjs` 使用临时合成项目与假 bridge 检查默认 no-op、首条空 session 准入顺序、子进程不继承 provider key、失败安全诊断、错 session ACK 不被 Recall 接受但宿主 hook 继续、事件流关闭/session 查询失败不阻断宿主，以及卸载后不新增启动快照。不发网络或模型请求，不把它当作真实宿主 hooks/compaction 验收。独立 Python/Node 审查测试与真实 native harness 验证另见交付报告。

本页中的既有真实宿主验证及交付报告属于改名前历史证据，不代表改名后完整验收。改名后的真实 DeepSeek 测试状态见 [验证说明](../VALIDATION.md)。
