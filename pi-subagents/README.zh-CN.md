

# billion-context-pi-subagents

[English](./README.md) | [中文](./README.zh-CN.md)

[Pi coding agent](https://pi.dev) 的 `acp_delegate` 子代理工具 — 从 [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) 中拆分而来（[#612](https://github.com/ranxianglei/billion-context-pi/issues/612)）。将一个自包含的任务交给一个运行在**干净上下文**中的全新 pi 进程；结果以文件路径的形式返回，保持主会话的轻量。

<p align="center">
<code>pi install npm:billion-context-pi-subagents</code>
</p>

## 与其他包的关系

| 包 | 职责 |
|---|---|
| [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) | 上下文压缩（`compress` / `decompress` / `search_context` / `acp_status`） |
| **billion-context-pi-subagents**（本包） | 子代理委派（`acp_delegate*` + 集群检查器） |
| [billion-context](https://github.com/ranxianglei/billion-context) | 多主机代理启动器（opencode/omp/…）— 与本包无代码共享；其"subagent"支持仅跟踪 opencode 原生任务会话 |

**billion-context-pi 已内置本包。** 拆分（#612）之后，billion-context-pi 将本包以精确版本钉死为 devDependency，并在构建时内联进其 dist（与内联 acp-kernel 同一机制）。如果你在使用 billion-context-pi，就已经拥有 `acp_delegate` —— **请勿再单独安装本包**。若两者同时被加载，独立副本会在会话开始时检测到内置副本并自动让位（不会重复注册工具或提示词段落）。

只有当你想**不装** billion-context-pi 而单独使用委派功能时才直接安装本包：此时委派的子进程依赖 Pi 的原生上下文管理而非 ACP 压缩，且没有 `/acp-subagents` 命令可用。

两包同时运行时共存于同一个 Pi 进程中：相同的 `acp.json` 约定（各自只读取自己的键）和同一个日志文件（`~/.pi/acp.log`）。

## 安装

**billion-context-pi 用户：跳过此步 —— 已内置。** 此安装仅适用于不装 billion-context-pi 的独立使用：

```bash
pi install npm:billion-context-pi-subagents
```

无需配置 — 委派功能默认启用。安装后重启 Pi。

> ⚠️ **v0.1.x 没有自动更新。** 独立安装需手动升级（`pi install npm:billion-context-pi-subagents@latest` 或重新安装）；内置于 billion-context-pi 的副本随 billion-context-pi 发版更新。

## 面向模型的工具

| 工具 | 功能 |
|------|------|
| `acp_delegate` | 为任务（审查 / 调研 / 实现 / 规划 / 咨询）生成一个干净上下文的子代理 |
| `acp_delegate_wait` | 阻塞直到委派运行完成（返回其结果；超时则返回超时信息） |
| `acp_delegate_cancel` | 按 runId 取消正在运行的委派 |

### 角色

五个内置角色，每个角色都有系统提示词和**软性工具护栏**：

| 角色 | 工具 | 适用场景 |
|------|------|----------|
| `reviewer` | read, bash, grep, find, ls + ACP | 只读代码审查（缺陷、风险、file:line） |
| `researcher` | read, bash, grep, find, ls + ACP | 只读代码库调研 |
| `worker` | read, edit, write, bash | 进行代码修改 |
| `planner` | read, bash, grep, find, ls + ACP | 分析并提出分步计划 |
| `oracle` | read, bash, grep, find, ls + ACP | 回答问题 / 提供建议 |

只读角色会收到受限的工具允许列表加上 ACP 上下文工具，以便管理自身上下文。这可以防止意外的文件修改，但 `bash` 可以绕过它 — **它是护栏，不是安全边界**。Worker 使用 Pi 的完整默认工具集（任何已加载的扩展或自定义工具仍然可用）。

### 执行模型

- **交互模式（TUI）& RPC 模式**：`async:true`（默认）在后台运行子进程；完成时会向聊天注入一条简短的完成通知 — **除非模型在运行结束后已经读取了结果文件**（通过 `read` 工具或引用该文件的 bash 命令检测到），此时通知会被跳过：模型已有结果，再次注入只会浪费上下文。在 `acp.json` 中设置 `delegate: { notifyIfRead: "always" }` 可恢复始终注入的行为。
- **Print / JSON 模式**（`pi -p`、SDK）：`async:true` 自动降级为**同步** — 结果在同一轮次中作为工具结果返回。
- **失败必须显式可见，绝不静默。** 失败的运行（非零退出码、spawn 错误、看门狗超时）会注入一条携带简短错误摘要的 `FAILED ⚠️` 通知。如果通知完全无法送达，一条恢复提示会附加到下一条委派通知或工具结果上。
- **结果投递**：完整的委派输出保存到 `$TMPDIR/acp-delegate/<runId>.out`；工具结果和通知仅携带**任务标题 + 文件路径**（无预览）— 使用 `read` 查看详情。
- **实时可见性（TUI）**：异步运行会在编辑器下方显示状态组件，并在底部栏显示累计 token/费用用量；子进程静默超过 2 分钟时，运行中的行会追加 `⚠ no activity Nm` 标记。`/acp-fleet`（或 `ctrl+alt+d` 快捷键）打开交互式集群检查器：实时列表 + 转录叠加层。在 RPC/print/JSON 模式下自动禁用。
- **紧凑工具块（TUI）**：当宿主支持自定义工具渲染时（pi-coding-agent ≥ 0.62；无边框自渲染外壳自 0.67.3 起），`acp_delegate*` 调用以紧凑块呈现——调用行显示代理名 + 任务首行，结果行显示状态图标、退出码、耗时和最多 3 行输出预览（`Ctrl+O` 展开至 40 行）。预览仅用于屏幕显示：传给模型的文本不变（任务标题 + 文件路径）。更旧的宿主忽略这些渲染器，使用默认工具输出。
- **可恢复的运行**：运行可以从其保存的会话（结果文件旁的 `.session.jsonl`）中恢复 — 之前的工具调用会被还原而非重放。

## 配置

与 billion-context-pi 相同的文件约定：`~/.pi/acp.json`（全局）和 `<project>/.pi/acp.json`（项目覆盖全局）。本包只读取以下键；同一文件中的所有其他键属于其他包，在此被忽略。

```json
{ "delegate": false }
```


或对象形式：

```json
{
  "delegate": {
    "enabled": true,
    "maxDepth": 2,
    "maxConcurrent": 3,
    "syncTimeoutMinutes": 5,
    "idleTimeoutMinutes": 5,
    "asyncTimeoutMinutes": 30,
    "thinkingLevel": "medium",
    "notifyIfRead": "skip",
    "displayUsage": "separate",
    "forceEnable": false,
    "fleetShortcut": "ctrl+alt+d",
    "agents": {
      "reviewer": { "model": "anthropic/claude-sonnet-4-5", "thinkingLevel": "high" },
      "worker":   { "model": "zhipu/glm-4.7" }
    }
  }
}
```

| 键 | 类型 | 默认值 | 说明 |
|-----|------|---------|---------|
| `delegate` | `boolean \| object` | enabled | 主开关。设为 `false` 将移除三个工具、系统提示词段落及 fleet 快捷键（需新开会话）。 |
| `delegate.enabled` | boolean | `true` | 同上，对象形式。 |
| `delegate.forceEnable` | boolean | `false` | 即使项目级 pi-subagents 安装本应使其停用，仍保持 `acp_delegate` 激活（#415）。环境变量 `PI_ACP_DELEGATE_FORCE_ENABLE=true/false` 可覆盖。 |
| `delegate.displayUsage` | `"separate" \| "merged"` | `"separate"` | `"separate"`：委托 token 在主会话总量之外单独统计（独立页脚块）。`"merged"`：合并到工具结果的 usage 字段中。旧版扁平别名：顶层 `"displayUsage"`。 |
| `delegate.maxDepth` | number | `2` | 最大嵌套深度（主 → 子 → 孙）。`1` = 不允许嵌套委托。通过 `PI_ACP_DELEGATE_MAX_DEPTH` 传递给子代理。环境变量覆盖：`PI_ACP_DELEGATE_MAX_DEPTH`。 |
| `delegate.syncTimeoutMinutes` | number \| null | `5` | 同步委托的硬性超时。`0`/`null` 表示禁用。环境变量：`PI_ACP_DELEGATE_SYNC_TIMEOUT_MINUTES`。 |
| `delegate.idleTimeoutMinutes` | number \| null | `5` | 异步委托的空闲看门狗（无输出时终止）。`0`/`null` 表示禁用（会发出警告——挂起的子代理此后必须通过 `acp_delegate_cancel` 手动取消）。环境变量：`PI_ACP_DELEGATE_IDLE_TIMEOUT_MINUTES`。 |
| `delegate.asyncTimeoutMinutes` | number \| null | `30` | 异步委托的硬性时间上限。`0`/`null` 表示禁用。环境变量：`PI_ACP_DELEGATE_ASYNC_TIMEOUT_MINUTES`。 |
| `delegate.maxConcurrent` | number | unlimited | 并发后台委托数量上限（`1` = 严格串行；超出部分排队）。无效值回退为无限制并发并给出警告。环境变量：`PI_ACP_DELEGATE_MAX_CONCURRENT`。 |
| `delegate.thinkingLevel` | string | unset | 全局默认思考级别（off\|minimal\|low\|medium\|high\|xhigh\|max）。优先级：单次调用 > 角色 > 全局 > Pi 默认值。 |
| `delegate.agents` | object | unset | 按角色设置默认值：`{ "<role>": { "model": "provider/id", "thinkingLevel": "…" } }`。无效模型回退到父模型并给出警告（不会导致失败）。 |
| `delegate.notifyIfRead` | `"skip" \| "always"` | `"skip"` | 若模型在运行结束后已读取结果文件，则跳过完成通知。 |
| `delegate.fleetShortcut` | string | `"ctrl+alt+d"` | fleet 检查器的 TUI 快捷键。`""` 禁用键盘注册（`/acp-fleet` 仍然可用）。已从 `ctrl+alt+f` 移开，因为 pi-subagents 也占用了该组合键（#412）。 |
| `delegatePrompt` | string \| null | built-in | 替换（字符串）或移除（`null`）系统提示词附录中的 `ACP_DELEGATE NOTIFICATIONS` 部分。 |
| `debug` | boolean | `false` | 在 `~/.pi/acp.log` 中记录调试级别事件（与 billion-context-pi 共享）。也可通过环境变量 `ACP_DEBUG=1` 开启。 |

无效值永远不会导致会话失败——它们会在 `~/.pi/acp.log` 中发出警告并回退到默认值。优先级：环境变量 > 项目 acp.json > 全局 acp.json > 默认值。

任何 `delegate.*` 键的修改在**新会话**中生效（工具在会话启动时注册）。

## 使用自己的子代理替代

如果你同时运行了 [pi-subagents](https://github.com/nicobailon/pi-subagents)（或类似插件），两套重叠的子代理系统会使模型的选择更加混乱。检测发生在会话启动时：

- **项目级安装**（`<cwd>/.pi/npm/node_modules/pi-subagents` 或 `<cwd>/.pi/extensions/pi-subagents`）→ `acp_delegate` 对该项目**自动停用**（跳过工具、快捷键和提示词段落）；会有一条提醒指向 `/acp-subagents`（来自 billion-context-pi），使第三方代理仍能获得 ACP 压缩。
- **仅用户级安装**（`~/.pi/npm`、用户扩展目录）→ `acp_delegate` 保持激活；改为记录一条警告。
- 两者都保留：`{ "delegate": { "forceEnable": true } }`。
- 完全移除本包：`pi remove npm:billion-context-pi-subagents`。

Pi 的 `--exclude-tools acp_delegate,acp_delegate_wait,acp_delegate_cancel` **不能**替代 `delegate: false`：它只是隐藏了工具，但模型仍会收到描述其无法调用的工具的 `ACP_DELEGATE NOTIFICATIONS` 段落。

## 宿主支持

专为 **Pi**（`@earendil-works/pi-coding-agent` >= 0.83）构建。在不具备 Pi 的 `buildContextEntries()` 会话 API 的宿主上（如 OMP），不会注册任何内容，每个进程仅打印一次警告；兼容 Pi 的分支可通过 `PI_ACP_FORK_HOST=1` 选择加入（与 billion-context-pi 的 [docs/host-adapter.md](https://github.com/ranxianglei/billion-context-pi/blob/master/docs/host-adapter.md) 相同契约）。

## 日志

写入共享 ACP 日志 `~/.pi/acp.log`（可用 `ACP_LOG_FILE` 覆盖），格式与 billion-context-pi 相同：

```sh
tail -f ~/.pi/acp.log                 # 实时查看会话日志
grep '\[error\]' ~/.pi/acp.log        # 列出所有记录的失败
```

委托生命周期事件（spawn/done/fail/cancel、停用决策、配置警告）始终开启；`debug: true` 增加详细诊断信息。

## 许可证

MIT。
