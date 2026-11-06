# billion_context_native

Claude Code、OpenCode 与 DSH 的本地归档召回：保留宿主原生压缩，通过 hooks/原生适配器与 MCP 找回已归档内容，不改变模型请求 URL 或经过中转代理。

改名前历史验证（2026-11-05，v0.3.2）：为未启用 schema union 重写的官方 Claude Code 去掉 `recall_get` 输入 schema 的根级 `anyOf`，在工具说明和服务端继续校验 turn/locator 组合。官方未修改 CLI 2.1.318、DeepSeek 官方 Flash、low 模式下已实测原生手动 `/compact`、compact/resume hooks、两阶段真实模型搜索与全文分页取回。162 项离线回归通过。最新能力与验证边界见 [验证说明](VALIDATION.md)。本 PR 提供源码更新，不代表已合并、发布到 npm 或安装到用户电脑。

- Claude Code：下文安装及使用说明。
- OpenCode V2.2.5：[安装与显式启用](opencode/README.zh-CN.md)、[原生接口契约](opencode/API_CONTRACT.zh-CN.md)。完整适配器和共享归档核心均在本目录；无需分别覆盖安装两个版本。
- DSH 0.2.0-rc.2：[安装、原生接口与安全边界](dsh/README.zh-CN.md)、[验证记录](dsh/VALIDATION.zh-CN.md)。复用共享归档核心，不改现有 Claude Code 或 OpenCode 安装方式。
- 改名迁移与旧安装清理：[MIGRATION.md](MIGRATION.md)。本次只更换产品/安装身份，不升版本、不移动或重写归档；改名后的真实 DeepSeek 验证尚待完成，以上旧结果不代表新身份验收。
- English overview and verification limits: [VALIDATION.md](VALIDATION.md).

## 安装
需要 Python 3（只用标准库）。使用本 PR 分支的源码目录；上游默认分支和已发布版本在合并/发布前不会自动取得本次修复。使用包含 `.claude-plugin/marketplace.json` 的本地目录作为入口（替换为实际绝对路径）：
```sh
claude plugin marketplace add /absolute/path/to/billion_context_native --scope project
claude plugin install billion_context_native@billion_context_native --scope project
```
在目标项目目录中执行；显式 `--scope project` 避免默认 user 范围安装，仅在希望本地保存历史的项目/会话中启用插件。[官方 scope 参数](https://code.claude.com/docs/en/plugins/cli-reference#plugin-install)。原有 `autoCompactWindow` 设置无需为归档而调整；本插件不关闭宿主压缩。若使用既有提醒阈值配置，请核对所安装 CC 的实际支持范围。

v0.3.1 起默认不请求 readiness veto。核对本机 `claude --version` 后，可在 settings 的 `env` 显式声明 `"BILLION_CONTEXT_NATIVE_CC_VERSION": "2.1.105"`（填写实际版本）启用兼容版本的既有策略。此变量是本插件的操作者声明，不是官方环境变量或运行时版本探测。CC 从 [2.1.105](https://code.claude.com/docs/en/changelog#21105) 才支持 PreCompact 阻止压缩；未知、非法或更旧版本继续归档并放行。readiness veto 本身仅有本地 fixture 验证，未做真实自动压缩阻止验收；真实手动压缩与恢复已另行通过，Windows 集成仍未验证。

Windows：插件默认用 `python3` 启动；Windows 上的 `python3` 常常是应用商店占位程序或无法直接执行的脚本，MCP 服务会启动失败。请在 settings 的 `env` 里加 `"RECALL_PYTHON": "python"`（或 Python 可执行文件的完整路径）。hook 在 `python3` 不可用时会自动退回 `python`，MCP 服务没有这种退路。另外 hook 命令是 POSIX shell 语法：macOS/Linux 无需额外依赖，Windows 上需要 Git Bash（随 Git for Windows 安装），否则 Claude Code 会用 PowerShell 执行 hook、这些命令会失败（MCP 服务不经过 shell，不受影响）。

v0.2.0 起复刻了 [billion-context](https://github.com/ranxianglei/billion-context) / [acp-kernel](https://github.com/ranxianglei/acp-kernel) v0.0.99（MIT）的压缩规则、提醒文本、分层摘要、规则与 absorb 提示；模型可见的文本逐字取自 acp-kernel，仅按本插件机制做了替换（见 `plugin/billion_context_native/prompts.py` 注释）。版权与许可见 `NOTICE`。

当前 CLI 可加载此下划线名称，但非 kebab-case 会触发 `plugin validate` warning，`--strict` 可能失败；claude.ai marketplace 同步要求 kebab-case。本页只描述本地 CLI 安装。见 [官方故障排查](https://code.claude.com/docs/en/plugins/troubleshooting)、[manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference) 及 [迁移说明](MIGRATION.md)。

## 工作方式
- 宿主决定何时压缩。仅在显式声明兼容版本、来源前缀完整且未达到 hard/overflow 放行条件时，PreCompact 可请求推迟自动压缩，直到 `compact_ready` 的真实调用有成功结果；仅文本提及、待完成、失败或冲突调用不算。手动 `/compact` 始终不受 readiness 策略阻止。请求 veto 不等于已观察到宿主执行结果；[官方文档](https://code.claude.com/docs/en/hooks#precompact) 说明，context-limit 恢复路径被 veto 可能使当前请求失败。
- 强制线按最新一轮主对话的模型取：模型名含 `haiku` 时为 180k（Haiku 只有 200K 窗口），其他模型为 300k。下文的 225k / 285k 是 300k 时的值，Haiku 下为 135k / 171k。
- 如果记录里最近一次请求是"Prompt is too long"报错（模型窗口比强制线小，例如 200K 窗口的 Sonnet/Opus），下一次自动压缩直接放行，不会卡死。
- 提醒分三层（UserPromptSubmit + PostToolUse）：
  - growth：150k 起每涨 50k 提醒一次，附完整的 HOW TO COMPRESS 规则；
  - pressure：225k（HARD 的 75%）起每次 hook 调用都提醒（OVER-LIMIT）；
  - emergency：285k（HARD 的 95%）起改用紧急文本。
  - 本压缩周期内已确认 `compact_ready` 成功完成后不再提醒。
- absorb：上下文过软线后，内置工具（非 `mcp__`）单次输出 ≥ 4000 tokens（字符数/4）时，提醒模型立刻把要点记成笔记。原始输出在下次压缩前仍留在上下文里，压缩后可找回。
- UserPromptSubmit、PostToolUse、PostToolUseFailure、Stop、PreCompact 和恢复检查将已落盘 JSONL 完整行增量追加到 `~/.claude/recall/<session_id>/events.jsonl`。当前 hook 原始字段先作为独立 observation 持久化，以覆盖 transcript 异步落盘间隙；不会补造消息 UUID、会话轮次或成功状态。仅能唯一匹配真实工具 id 的 observation 才可补充该工具结果，无法绑定的记录仍保留为观测事实。hook 没有提供或从未被观察到的数据仍是未知。
- 同步 ACK 只确认已提交的来源前缀：校验来源文件身份、字节水位与 SHA256 后读取。空来源、缺失来源、末行无换行或损坏行都不宣称最新历史已完整保存，不触发 readiness veto。归档/恢复失败不向模型注入成功 ACK，也不阻断宿主；日志仅记录错误类别。宿主可以继续压缩，因此未确认的尾部可能无法恢复。
- 压缩前（PreCompact 放行时）：
  - 生成 `turns.jsonl` 派生阅读视图；原始记录始终保存在 `events.jsonl`，宿主压缩或重写记录不会覆盖它；
  - 从已确认成功的 `compact_ready`、`recall_rule`、TodoWrite/TaskCreate/TaskUpdate 调用派生摘要、规则、待办；失败、未完成或多重归属不冒充已执行。
- 压缩后或恢复会话（SessionStart `compact|resume`，9 个 hook，每个 additionalContext ≤ 9.5k 字符，含 JSON 元数据）：
  - 槽 0：存档索引和状态锚；
  - 槽 1–5：最近 5 轮原文，超长轮次保留头尾，中间用 `recall_get` 取回；
  - 槽 6：历史摘要，格式为 `[Compressed conversation section]`；
  - 槽 7：规则；
  - 槽 8：未完成的待办。
  - 所有历史原文、摘要、规则、待办都放在 `recall_history` JSON 数据封套内，标注 `untrusted_historical_data`。它们不是新的系统指令或执行授权；恢复视图截断不影响已保存事实。
- 分层摘要：生效摘要超过槽 6 容量的 75% 时，提醒里附 TIER 2（distill）或 TIER 3（condense）请求。模型在下次 `compact_ready` 的 `prior_digest` 里交汇总，汇总替换旧摘要，旧摘要原文仍可搜索。

## MCP 工具

Claude Code 的插件名与 marketplace 名均为 `billion_context_native`；插件内 MCP key 使用短名 `native`，以确保宿主生成的完整工具名不超过 64 字符。MCP `serverInfo.name` 仍为完整产品名 `billion_context_native`。OpenCode 的 MCP server key 使用完整名 `billion_context_native`，限定工具名为 `billion_context_native_recall_search` / `billion_context_native_recall_get`。以下是保持兼容的功能操作名，不随产品改名而改动；DSH 也继续使用原有功能操作名。
- `recall_search(query, session_id?, scope?="session"|"all", limit?=8)`
  - 在存档轮次和 `compact_ready` 摘要里搜索，关键词空格分隔，全部命中才算；
  - `scope="all"` 搜索所有会话，命中项标注 `[会话 id 日期]`。
- `recall_get(turn, to_turn?, session_id?, offset?=0, length?=8000)`
  - 取一轮原文（支持分段）；
  - 给 `to_turn` 则取整段范围；超过 1 万字符时写入 `~/.claude/recall/tmp/`（最多 50 个，最旧的先删），返回路径、开头片段和总大小。
- CC/OpenCode 原始事实还支持结构化稳定读取：先调用 `recall_search(query, session_id="明确的会话 id", structured=true, limit=8, byte_limit=65536)`。结构化搜索必须显式指定 session_id；多页结果原样传回 `next_cursor` 作为 `cursor`，不得自行改写游标。
  - 从命中项原样取 `locator`，调用 `recall_get(locator=完整定位对象, byte_offset=0, byte_limit=65536)`；locator 固定原文版本，不随 numeric turn 的变化重定向。不要同时传 locator 与 turn/to_turn。
  - 每页按 `returned_range` 和 `next_cursor` 继续；UTF-8 字节分页与旧接口字符 offset 不混用，单次输出硬限 64 KiB。需要完整内容时读到 next_cursor 为空，并核对返回的完整性/长度信息。
  - 使用数字轮次时可传 `session_id`、`turn`、`structured=true` 和搜索返回的 `expected_revision`；版本不匹配会报错，不默默读取新内容。单次结构化读取不接受轮次范围。
  - 旧 `recall_search/get` 文本与字符分页接口继续兼容；legacy 档案没有可证明的原始事实定位时，不能升级承诺不可变 locator。JSONL 是事实源，索引/阅读视图重建不应改变既有 locator 指向的原文。
  - 结构化历史带低信任元数据；SessionStart 恢复另用 JSON 封套。它们提供数据与指令的明确分界，但不能保证模型一定遵守，也不能补回宿主从未提供或未落盘且未观察到的内容。
- `compact_ready(summary, focus?, prior_digest?)`
  - `summary` 必填，覆盖上次压缩以来所有轮次的自包含摘要；
  - 工具描述里带完整压缩规则。
- `recall_status(session_id?)`：上下文用量和各阈值、所处层级、是否已 ready、压缩次数、存档轮数、摘要数与规则数。
- `recall_rule(action="add"|"list"|"delete"|"clear", text?, id?, session_id?)`
  - 语义同 acp-kernel rules：最多 50 条，每条 ≤ 300 字符，重复的拒绝。新规则返回 `rule` 加十进制 UUID 的稳定 ID；删除时原样使用返回值，不要推算编号。旧 `ruleN` 仍兼容，删除后不复用。已存在的重复 ID 历史会报告冲突并暂停规则，不会猜测归属；可显式调用 `recall_rule(action="clear")` 清空全部规则并重置冲突。只有观察到该调用的明确成功结果后才恢复正常操作，旧 ID 不复用，归档原文保留。`recall_status` 仍显示其他状态和冲突提示。

`recall_status` 和 `recall_rule` 需要找到当前会话的 transcript：
- 传了 `session_id` 就用它；
- 否则仅在 `~/.claude/projects/<项目路径把非字母数字换成 ->/` 下会话唯一时自动选择，项目路径取 `CLAUDE_PROJECT_DIR` 或 MCP 进程的 cwd；多个会话时返回错误，不按修改时间猜测；
- 同一项目并行多个会话时要显式传 `session_id`。`recall_search/get` 也遵循这一规则；仅未提供项目环境且本地只有一个存档时保留兼容选择。显式读取历史存档仍可传其会话 id；实时状态与规则只定位当前项目的 transcript。
- 规则不单独存状态，而是由 transcript 里已完成的 `recall_rule` 调用重放得出。

## 调参
环境变量（可写进 `~/.claude/settings.json` 的 `env`）：下面七项配置使用新 `BILLION_CONTEXT_NATIVE_*` 名称优先，旧 `RECALL_*` 同后缀变量在新名称未设置时继续作为 fallback；显式空值也以新名为准。不要为改名迁移数据；默认 `~/.claude/recall` 与既有 `archiveHome` 保持不变。
- `BILLION_CONTEXT_NATIVE_SOFT`、`BILLION_CONTEXT_NATIVE_STEP`、`BILLION_CONTEXT_NATIVE_HARD`，默认值依次是 150000、50000、300000。pressure 和 emergency 线分别取强制线的 75% 和 95%。`BILLION_CONTEXT_NATIVE_HARD` 必须小于所用模型的窗口；200K 窗口的非 Haiku 模型请设为 180000 左右。
- `BILLION_CONTEXT_NATIVE_HARD_HAIKU`：Haiku 的强制线，默认 180000。
- `RECALL_PYTHON`：hook/MCP 启动命令的兼容例外，继续保留旧名，默认 `python3`（Windows 见“安装”）。不提供 `BILLION_CONTEXT_NATIVE_PYTHON` 别名，以避免嵌套变量 fallback 或新增 shell 破坏宿主启动兼容性。
- `BILLION_CONTEXT_NATIVE_HOME`：存档目录，默认 `~/.claude/recall`。
- `BILLION_CONTEXT_NATIVE_PROJECTS`：transcript 根目录，默认 `~/.claude/projects`，主要用于测试。
- `BILLION_CONTEXT_NATIVE_CC_VERSION`：本插件的显式版本声明；仅合法版本 ≥ 2.1.105 启用 readiness veto，默认未知且放行。

阈值影响本插件提醒与 readiness 策略，不保证控制宿主自动压缩时机或扩大模型窗口。

## 修改代码后
已安装插件使用缓存副本，修改源码不代表已运行的会话自动更新。此次改名是新安装身份，按 [迁移说明](MIGRATION.md) 停止旧会话、移除旧作用域的启用项，并从新源码安装；不要让新旧 hooks 同时运行。

本功能分支不修改版本号。对同一新身份做本地源码迭代时，先停止会话，再在原安装 scope 卸载并从正确本地 marketplace 重新安装，检查实际加载路径/源码后开启新会话；若缓存仍旧，不把普通 update 当作已更新证明。发布后的版本更新由正式 release 流程管理，不为刷新开发缓存自行升版本。

## 测试
`python -X utf8 -m unittest discover -s tests`

## 停用与卸载
- 临时停用：`claude plugin disable billion_context_native@billion_context_native --scope project`（若原安装在 user/local 范围，使用该实际 scope）。
- 彻底卸载：先执行 `claude plugin uninstall billion_context_native@billion_context_native --scope project`（使用实际安装 scope），仅在没有其他安装使用该 marketplace 时执行 `claude plugin marketplace remove billion_context_native`。本插件没有修改 `autoCompactWindow`，停用/卸载无需删除该设置；自行配置的宿主选项按自己的需要保留。已有本地档案不会随卸载删除。

## 事件日志

每个会话一份 `~/.claude/recall/<session_id>/events.log`，每行一条 JSON，都带 `ts`、`event`，多数带 `ctx`（上下文 tokens）：
- `nudge`：发出提醒，字段 `bucket`、`layer`（growth / pressure / emergency）。
- `absorb`：大输出提醒，字段 `tool`、`tokens`。
- `block`：已请求 readiness veto，`outcome=requested_not_observed`，不代表宿主已执行。
- `policy_gate_unavailable`：版本未知或不支持，宿主继续。
- `archive_deferred`：来源缺失、为空或不完整，已提交水位可诊断，不确认最新历史完整。
- `hook_observed`：原生工具/Stop observation 已处理；缺失关联保持 unknown。
- `allow`：压缩前存档准备结束，`phase=archive_prepared_not_compaction_completed`，不代表压缩已完成。字段有：
  - `trigger`；
  - `reason`（ready / hard / overflow / manual / capability_unavailable）；
  - `turns`；
  - `summaries`（本次新存的摘要 id）；
  - `rules`（规则条数）；
  - `todos`（待办条数）。
- `restore`：从已持久化历史生成低信任阅读视图，区分 `compact` 与 `resume`。
- `restore_unavailable`：没有可确认的历史，不声称恢复成功。
- `error`：hook 异常，字段 `hook`、`error_type`、`archive_complete=false`、`host_continues=true`；不记录输入或异常全文。

无动作的检查不记录。

默认未注册较新版本的 `PostCompact` / `StopFailure`。确认宿主支持后可选用同一 `hook.py observe` 入口：PostCompact 只保存宿主完成声明与 compact_summary（摘要不等于原文）；StopFailure 只保存失败观测，不提升成成功助手消息。缺少这些事件时完成/失败状态保留 unknown；Stop、PostToolUseFailure 不返回 additionalContext，不设 decision:block，不触发模型循环。

## 归档可靠性（第一阶段）

事实记录为追加式 `events.jsonl`（格式版本 1），完整保留宿主提供的结构、工具输入/输出和内容类型，不再把工具输入截到 2000 字符。每条记录带宿主、项目、会话、分支、事件 id、来源版本和位置。嵌入附件内容保存在记录里；URL、文件路径等只保存引用，不下载附件，也不保证其以后仍可访问。

`index.sqlite3` 只是可删除、可重建的游标与去重索引，属于此插件，**不依赖 bili 数据库**；`turns.jsonl` 是可重建视图。主会话轮次仍由现有 `recall_search/get` 读取；子链原始记录保留在事实档案中，不混入主会话恢复。

第一次同步旧档案时，原 `turns.jsonl` 字节备份到 `turns.legacy-v0.jsonl`，旧内容标为 legacy，不能补回以前已截断或忽略的内容。多进程写同一会话采用锁；先持久化原始记录，再提交索引。尾部损坏保留到 `events.corrupt.*.bin` 后修复；遇到未来格式版本会拒绝操作，不自动降级。损坏来源行会暂停在该位置，后续行不会被悄悄跳过。

为识别任意位置的来源重写，每次仍需校验已读取的来源前缀；因此读取耗时随来源大小增长，只有事实档案写入是增量。检索视图当前也会在内存中重建。不要把这版描述为常数耗时同步或任意磁盘损坏自动恢复。

迁移、回滚、测试和未验证项见 [第一阶段交付报告](PHASE1_REPORT.zh-CN.md)。

## 存储与隐私
存档（对话原文、摘要、规则、待办、日志）以明文保存在本机 `~/.claude/recall/`；本插件不自行发起网络上传。恢复内容与 MCP 返回进入会话后，宿主会按现有模型连接处理这些上下文。存档不会自动清理；不需要时手动删除对应会话目录即可。

## 致谢
本插件使用了 acp-kernel 与 billion-context 的提示词与设计：<https://github.com/ranxianglei/acp-kernel>、<https://github.com/ranxianglei/billion-context>。
