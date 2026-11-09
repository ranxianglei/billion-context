# Codex 原生安装、真实请求验证与移除（Windows）

本文用于在本机验证 `bili plugin install codex` 写入的**原生 Codex 配置路由**。它与 `bili codex` 启动器测试不同：验证时会直接运行 `codex`，让 Codex 自己读取 `CODEX_HOME/config.toml`，并让模型请求经过本机 bili 代理。

先完成临时目录流程；它不会使用或修改日常 `~/.codex` 配置。临时目录里的 Codex 登录状态与日常登录隔离。若你希望复用现有 ChatGPT 登录，请看后面的“使用日常 CODEX_HOME”。

## 前提

- Windows PowerShell。
- 已安装 `bili`，并确认 `bili --version` 能运行。
- 已安装 Codex CLI，确认 `codex --version` 能运行。
- 要验证真实请求，必须有当前 Codex 支持的认证方式和可用模型。临时 `CODEX_HOME` 不继承日常登录；需要在该临时 home 自行完成官方 Codex 登录，或使用它所支持的其他本机认证方式。不要复制 `auth.json`、cookie 或 token 到临时目录。
- 测试会真实调用模型，可能消耗账户额度。先选用适合的模型和短提示。

## A. 临时 CODEX_HOME：安装、请求验证、移除

在一个新的 PowerShell 窗口按顺序执行。此流程会创建 `$env:TEMP\bili-codex-native-test`，安装 bili MCP + 模型路由；请不要在测试过程中手动修改该目录里的 `config.toml`。

```powershell
$testRoot = Join-Path $env:TEMP 'bili-codex-native-test'
$env:CODEX_HOME = Join-Path $testRoot 'codex-home'
New-Item -ItemType Directory -Force -Path $env:CODEX_HOME | Out-Null

bili --version
codex --version
bili plugin install codex
bili plugin list | Select-String codex
```

安装器应报告四个面：`mcp: installed ...`、`model route: ... routed through bili`、`hook: SessionStart hook added`、`skill: ACP skill installed`。检查实际写入内容：

```powershell
Get-Content (Join-Path $env:CODEX_HOME 'config.toml')
Get-Content (Join-Path $env:CODEX_HOME 'skills\bili\SKILL.md')
```

预期根级配置包含类似下面的 URL（端口可能不同）：

```toml
openai_base_url = "http://127.0.0.1:<port>/bili/https://api.openai.com/v1"
```

同时应看到一个 hook 条目（脚本路径指向你本机 bili 的 `dist/codex/bootstrap-hook.js`）：

```toml
[[hooks.SessionStart]]
hooks = [{ type = "command", command = "node \".../dist/codex/bootstrap-hook.js\"", timeout = 15 }]
```

**必须是 `[[hooks.SessionStart]]` 数组表形式，且 handler 必须嵌在 `hooks = [...]` 数组里。** 这两点各自对应一种失败，互不相同：

1. **响的失败**：Codex 把 `hooks` 反序列化为序列，写成 `[hooks.SessionStart]` 加 `hooks = [{...}]`（map 形式）会让配置无法加载，进而导致 Codex 桌面端打不开——而且报错文本可能完全不指向这里（实测只显示 `AbsolutePathBuf deserialized without a base path in model_catalog json`）。
2. **哑的失败**：每个条目是 `MatcherGroup`——`{ matcher?, hooks = [ { type, command, timeout } ] }`。把 `type`/`command`/`timeout` 直接写在条目上，这些字段会被 Codex **静默丢弃**：配置能加载、`codex mcp list` 也成功，但 hook 从不注册。这种失败**任何"配置能否加载"的检查都发现不了**——只有 Codex 自己的 `hooks/list` app-server RPC 能看见。

安装器在写入前会做结构自检，拒绝任何一种已知会失败的形状，并把发现的旧扁平条目就地升级。想确认配置仍可加载，用 `codex mcp list`（`codex --version` 不加载配置，查不出来）；想确认 hook 真的被注册，要看 Codex 自己的 hook 列表（待确认钩子列表里应出现 `bootstrap-hook.js`）。

这个数组可以共存多个条目：若你已经用 lean-ctx 之类的工具写过 SessionStart hook，bili 会**追加**自己的条目并保留你的，卸载时也只删自己那一条。

Codex 只有在 `[features] hooks = true` 时才会执行 hook。若你的配置里没有这一项（或显式设为 `false`），bili 会写入 hook 条目并明确提示，但不会替你改写该开关；需要时自行加上 `[features]` 下的 `hooks = true`。hook 只做 attach：代理没在运行时它直接退出 0，不影响 Codex 启动。

不要手动将它改成模型厂商 URL；这条 loopback 地址确保代理不可用时请求失败关闭，不会悄悄绕过 bili。

启动持久代理。如果希望用 per-user 登录计划任务：

```powershell
bili service install
bili service status
```

`bili service install` 会在 Codex 稳定端口注册并启动 per-user 代理任务。若已有 `bili start` 进程，只有在它监听的端口与上面 `openai_base_url` 中的端口一致时才能复用；否则应安装此服务，或让现有进程监听该端口。用 `bili doctor` 检查状态：健康端口只会显示 `proxy-ready` 或 `configured`，这还不代表观察到了模型请求。

现在直接调用本机 Codex CLI，而不是 `bili codex`：

```powershell
codex exec --skip-git-repo-check --model gpt-5-codex "请只回复：native-route-ok"
```

模型名按你的账户可用模型调整。也可以在启动前先明确指定短时覆盖：

```powershell
$env:BILI_MCP_PROXY = 'http://127.0.0.1:<port>'
codex exec --skip-git-repo-check --model gpt-5-codex "请只回复：native-route-ok"
Remove-Item Env:BILI_MCP_PROXY
```

`BILI_MCP_PROXY` 只用于 MCP 工具连接；模型路由由 `config.toml` 决定。替换示例端口时使用安装器写入的真实代理端口。若当前 Codex 配置使用自定义 provider，安装器仅在检测到 CC Switch 明确处于 Direct 模式时，才会把当前选中的 `[model_providers.<name>].base_url` 包装到 bili；不会更改 CC Switch 数据库、provider 选择或其他配置。CC Switch 切换 provider/模式或同步配置时可能重写该字段；bili 不运行 watcher 与其抢写。若安装报告冲突，先查看 CC Switch 当前模式及 provider，不要手工覆盖字段。

成功响应后，再检查：

```powershell
bili doctor
```

只有代理统计里观察到 Codex 模型请求，Codex 集成才会报告 `verified`。`configured` 表示配置存在但还没有观察到请求；`proxy-ready` 只表示代理健康；`bypassed` 表示路由被其他设置遮蔽或绕过。若请求失败，先检查 `bili doctor`、代理是否仍在运行、`config.toml` 中 provider 的 `base_url`，以及 Codex CLI 的认证状态；不要为了“让它能通”把路由直接改到上游。

测试结束，先移除插件，再查看代理服务状态：

```powershell
bili plugin remove codex
bili service status
```

只有状态显示这个 bili 计划任务已注册时，才执行：

```powershell
bili service disable
bili service remove
```

若代理由另一个 `bili start` 进程启动，用那个终端的 Ctrl+C 停止它；不要结束其他用户服务。验证移除结果：

```powershell
Get-Content (Join-Path $env:CODEX_HOME 'config.toml')
bili plugin list | Select-String codex
```

MCP block、bili 写入的 `[hooks.SessionStart]` 条目和 `skills\bili\SKILL.md` 都应已移除；若原配置没有 `openai_base_url`，bili 写入的根级路由也应还原。原先已有的非 bili 字段应仍在：这包括别人写的 hook 条目（bili 只删自己的那一条）以及同名但非 bili 所有的 skill 文件（bili 完全不碰）。只有确认 `$testRoot` 是本次创建的测试目录后，才执行下方清理；这会删除该临时目录中的 Codex 配置和可能存在的临时数据：

```powershell
$expectedRoot = Join-Path $env:TEMP 'bili-codex-native-test'
if ($testRoot -eq $expectedRoot -and (Test-Path -LiteralPath $testRoot)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
```

若 `bili service install` 实际创建了计划任务，`bili service remove` 会移除它；若 `bili service status` 报告有同名但非 bili 所有的任务，安装/移除操作会拒绝触碰它。不要用 `schtasks /Delete /F` 手动删除未知任务。

## B. 使用日常 CODEX_HOME（保留现有登录）

仅当你明确想用日常 Codex 登录时使用此流程。它会修改真实 Codex 的 `config.toml`，但不应读取、复制或覆盖登录凭据。先关闭 Codex，备份配置，再让 bili 安装/卸载：

```powershell
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$config = Join-Path $codexHome 'config.toml'
$backup = "$config.before-bili-test.bak"
if (Test-Path -LiteralPath $config) {
    Copy-Item -LiteralPath $config -Destination $backup -ErrorAction Stop
}

bili plugin install codex
bili plugin list | Select-String codex
bili service status
```

如果这是由 CC Switch 管理的 Direct 配置，安装输出应明确显示 `CC Switch Direct provider <name> routed through bili`。保持 Direct 模式和同一 provider 完成测试；切换 provider 或模式后，CC Switch 可能重写 `base_url`，此时 bili 会报告冲突并保留新值。Routing/Aggregation 模式不会被此安装器自动改写。

启动代理后，在同一用户环境直接运行 `codex exec`，按上面的方式发出一条短请求；确认 `bili doctor` 显示 `verified` 后，原生路由测试才算完成。若安装报告 conflict、没有本机认证或模型不可用，就停止测试并保留原配置，不要删除/覆盖已有 provider 的 `base_url`。

清理时先运行 `bili plugin remove codex`。安装器按 sidecar 记录恢复之前的路由值；如果你在安装后自己改过该字段，卸载会保留你的修改。核对备份和当前配置后，再自行决定是否恢复备份：

```powershell
bili plugin remove codex
Get-Content -LiteralPath $config
if (Test-Path -LiteralPath $backup) {
    Compare-Object (Get-Content -LiteralPath $backup) (Get-Content -LiteralPath $config)
}
```

只有确认测试期间没有需要保留的 Codex 配置变更时，才手动恢复备份。**不要删除整个 `$CODEX_HOME`，也不要删除 `auth.json` 或其他登录状态文件。**如果安装了代理服务，按 A 节执行 `bili service disable` 和 `bili service remove`。

## 结果判定

- **通过原生路由验证：** 直接执行 `codex exec` 收到模型响应，且随后 `bili doctor` 将 Codex 集成标为 `verified`。
- **安装成功、请求未验证：** 插件列表显示 route installed，但 doctor 仍是 `configured`。这不算模型请求已接入。
- **只测了启动器：** 执行的是 `bili codex ...`。它能验证 Codex launcher lane，但不能替代本指南中的原生命令测试。
- **代理不可用：** 原生 Codex 请求应失败在 loopback，不应回退到直连上游。
- **CC Switch Direct：** 对当前选中的自定义 provider，安装器可在 Codex `config.toml` 中建立可撤销的 bili `base_url` 路由；CC Switch 后续同步仍可能重写它。**Routing/Aggregation：** 仅检测并报告，不自动改写。安装器不会修改 CC Switch 数据库或增加 watcher。
