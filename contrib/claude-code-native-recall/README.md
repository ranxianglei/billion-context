# billion-claude-recall

Claude Code 本地插件：可找回的上下文压缩。纯 hook + MCP，不改 URL、不经过网络代理。

## 安装
需要 Python 3（只用标准库）。
```
claude plugin marketplace add zhou1736948757-cpu/billion-claude-recall
claude plugin install billion-claude-recall@billion-claude-recall-marketplace
```
然后在 `~/.claude/settings.json` 里设 `"autoCompactWindow": 150000`（与 `RECALL_SOFT` 相同），开新会话生效。

Windows：插件默认用 `python3` 启动；Windows 上的 `python3` 常常是应用商店占位程序或无法直接执行的脚本，MCP 服务会启动失败。请在 settings 的 `env` 里加 `"RECALL_PYTHON": "python"`（或 Python 可执行文件的完整路径）。hook 在 `python3` 不可用时会自动退回 `python`，MCP 服务没有这种退路。另外 hook 命令是 POSIX shell 语法：macOS/Linux 无需额外依赖，Windows 上需要 Git Bash（随 Git for Windows 安装），否则 Claude Code 会用 PowerShell 执行 hook、这些命令会失败（MCP 服务不经过 shell，不受影响）。

v0.2.0 起复刻了 [billion-context](https://github.com/ranxianglei/billion-context) / [acp-kernel](https://github.com/ranxianglei/acp-kernel) v0.0.99（MIT）的压缩规则、提醒文本、分层摘要、规则与 absorb 提示；模型可见的文本逐字取自 acp-kernel，仅按本插件机制做了替换（见 `plugin/recall/prompts.py` 注释）。版权与许可见 `NOTICE`。

## 工作方式
- 上下文达到 150k 后，Claude Code 的自动压缩会尝试触发。PreCompact hook 会拦截，直到模型调用 `compact_ready`（必须是真实的工具调用，文本里出现工具名不算）才放行；达到强制线时强制放行。手动 `/compact` 总是放行。
- 强制线按最新一轮主对话的模型取：模型名含 `haiku` 时为 180k（Haiku 只有 200K 窗口），其他模型为 300k。下文的 225k / 285k 是 300k 时的值，Haiku 下为 135k / 171k。
- 如果记录里最近一次请求是"Prompt is too long"报错（模型窗口比强制线小，例如 200K 窗口的 Sonnet/Opus），下一次自动压缩直接放行，不会卡死。
- 提醒分三层（UserPromptSubmit + PostToolUse）：
  - growth：150k 起每涨 50k 提醒一次，附完整的 HOW TO COMPRESS 规则；
  - pressure：225k（HARD 的 75%）起每次 hook 调用都提醒（OVER-LIMIT）；
  - emergency：285k（HARD 的 95%）起改用紧急文本。
  - 本压缩周期内已调用 `compact_ready` 后不再提醒。
- absorb：上下文过软线后，内置工具（非 `mcp__`）单次输出 ≥ 4000 tokens（字符数/4）时，提醒模型立刻把要点记成笔记。原始输出在下次压缩前仍留在上下文里，压缩后可找回。
- 压缩前（PreCompact 放行时）：
  - 把完整对话按轮存档到 `~/.claude/recall/<session_id>/turns.jsonl`；
  - 把 `compact_ready` 的 `summary` 连同轮次范围追加到 `summaries.jsonl`；
  - 把 `recall_rule` 规则写入 `rules.json`；
  - 把最新的待办清单（TodoWrite 或 TaskCreate/TaskUpdate）写入 `todos.json`。Claude Code 自身压缩后不会补回待办，只留在原生摘要文字里。
- 压缩后（SessionStart compact，9 个 hook，每个 ≤ 9.5k 字符）：
  - 槽 0：存档索引和状态锚；
  - 槽 1–5：最近 5 轮原文，超长轮次保留头尾，中间用 `recall_get` 取回；
  - 槽 6：历史摘要，格式为 `[Compressed conversation section]`；
  - 槽 7：规则；
  - 槽 8：未完成的待办。
- 分层摘要：生效摘要超过槽 6 容量的 75% 时，提醒里附 TIER 2（distill）或 TIER 3（condense）请求。模型在下次 `compact_ready` 的 `prior_digest` 里交汇总，汇总替换旧摘要，旧摘要原文仍可搜索。

## MCP 工具
- `recall_search(query, session_id?, scope?="session"|"all", limit?=8)`
  - 在存档轮次和 `compact_ready` 摘要里搜索，关键词空格分隔，全部命中才算；
  - `scope="all"` 搜索所有会话，命中项标注 `[会话 id 日期]`。
- `recall_get(turn, to_turn?, session_id?, offset?=0, length?=8000)`
  - 取一轮原文（支持分段）；
  - 给 `to_turn` 则取整段范围；超过 1 万字符时写入 `~/.claude/recall/tmp/`（最多 50 个，最旧的先删），返回路径、开头片段和总大小。
- `compact_ready(summary, focus?, prior_digest?)`
  - `summary` 必填，覆盖上次压缩以来所有轮次的自包含摘要；
  - 工具描述里带完整压缩规则。
- `recall_status(session_id?)`：上下文用量和各阈值、所处层级、是否已 ready、压缩次数、存档轮数、摘要数与规则数。
- `recall_rule(action="add"|"list"|"delete"|"clear", text?, id?, session_id?)`
  - 语义同 acp-kernel rules：最多 50 条，每条 ≤ 300 字符，重复的拒绝，id 为 ruleN 且删除后不复用。

`recall_status` 和 `recall_rule` 需要找到当前会话的 transcript：
- 传了 `session_id` 就用它；
- 否则取 `~/.claude/projects/<项目路径把非字母数字换成 ->/` 下最新的 `*.jsonl`，项目路径取 `CLAUDE_PROJECT_DIR` 或 MCP 进程的 cwd（Claude Code 在项目目录启动 MCP 服务器）；
- 同一项目并行多个会话时要显式传 `session_id`。
- 规则不单独存状态，而是由 transcript 里已完成的 `recall_rule` 调用重放得出。

## 调参
环境变量（可写进 `~/.claude/settings.json` 的 `env`）：
- `RECALL_SOFT`、`RECALL_STEP`、`RECALL_HARD`，默认值依次是 150000、50000、300000。pressure 和 emergency 线分别取强制线的 75% 和 95%。`RECALL_HARD` 必须小于所用模型的窗口；200K 窗口的非 Haiku 模型请设为 180000 左右。
- `RECALL_HARD_HAIKU`：Haiku 的强制线，默认 180000。
- `RECALL_PYTHON`：启动 hook 和 MCP 服务的 Python 命令，默认 `python3`（Windows 见"安装"）。
- `RECALL_HOME`：存档目录，默认 `~/.claude/recall`。
- `RECALL_PROJECTS`：transcript 根目录，默认 `~/.claude/projects`，主要用于测试。

`autoCompactWindow` 必须等于 `RECALL_SOFT`，因为它决定自动压缩从什么时候开始尝试。

## 修改代码后
已安装的插件是复制到 `~/.claude/plugins/cache` 的副本。版本号不变时更新会被跳过，所以要先把 `plugin/.claude-plugin/plugin.json` 和 `.claude-plugin/marketplace.json` 里的 version 同步加一，再执行：
`claude plugin marketplace update billion-claude-recall-marketplace`，然后执行 `claude plugin update billion-claude-recall@billion-claude-recall-marketplace`，再开新会话。

## 测试
`python -X utf8 -m unittest discover -s tests`

## 停用与卸载
- 临时停用：`claude plugin disable billion-claude-recall@billion-claude-recall-marketplace`，同时删除 settings 里的 `autoCompactWindow`，自动压缩就恢复原样。
- 彻底卸载：先执行 `claude plugin uninstall billion-claude-recall@billion-claude-recall-marketplace`，再执行 `claude plugin marketplace remove billion-claude-recall-marketplace`，最后删除 `autoCompactWindow`。

## 事件日志

每个会话一份 `~/.claude/recall/<session_id>/events.log`，每行一条 JSON，都带 `ts`、`event`，多数带 `ctx`（上下文 tokens）：
- `nudge`：发出提醒，字段 `bucket`、`layer`（growth / pressure / emergency）。
- `absorb`：大输出提醒，字段 `tool`、`tokens`。
- `block`：拦截自动压缩。
- `allow`：放行并存档。字段有：
  - `trigger`；
  - `reason`（ready / hard / overflow / manual）；
  - `turns`；
  - `summaries`（本次新存的摘要 id）；
  - `rules`（规则条数）；
  - `todos`（待办条数）。
- `restore`：压缩后补回。
- `error`：hook 异常，字段 `hook`、`trace`。

无动作的检查不记录。

## 存储与隐私
存档（对话原文、摘要、规则、待办、日志）以明文保存在本机 `~/.claude/recall/`，不会上传，也不会自动清理；不需要时手动删除对应会话目录即可。

## 致谢
本插件使用了 acp-kernel 与 billion-context 的提示词与设计：<https://github.com/ranxianglei/acp-kernel>、<https://github.com/ranxianglei/billion-context>。
