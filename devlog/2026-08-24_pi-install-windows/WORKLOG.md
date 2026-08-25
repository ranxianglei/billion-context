# pi plugin install 打通 + Windows 全链路验证

## 需求

用户（2026-08-24）：

> 现在你把pi 需要install的搞定 一切方法搞定.然后需要在windows测试.远程有windows的
> test环境. 确保bili 命令是支持的工作的

拆解：
1. `bili plugin install pi` 端到端可用，pi 的所有接入方法（install 持久注册、launcher、
   wire 兜底）都工作。
2. 在远程 Windows 10 测试机（win10-vm，见 ~/system/win10-vm.md）验证 `bili` 命令可用。

## 修复：install 不清理旧 billion-context-pi 条目

- 现象：`isPiEntry`（src/plugin-install.ts）只认 `npm:billion-context`、
  `^npm:billion-context@`、`node_modules/billion-context` 三种形态，不认：
  - `npm:billion-context-pi`（0.1.x 时代的独立包，win10-vm 和很多老环境的
    settings.json 里就是它）→ install 后新旧两个插件并存、重复注册同名工具。
  - dev checkout 路径（不以 node_modules 结尾的 billion-context 目录）。
  - Windows 反斜杠路径（旧正则只处理 `/`）。
- 修复（commit 2d86955）：`isPiEntry` 扩为四种形态（root 相等 / `npm:billion-context(-pi)?(@|$)` /
  `node_modules[/\]billion-context(-pi)?([/\]|$)` / `(^|[/\])billion-context(-pi)?$`），
  install 时全部替换为当前安装的 root，保证只有一份活插件。
  `piStatus` 收紧为严格匹配当前 root（旧条目残留不再误报 installed）。
- 测试：tests/plugin-agent.test.ts roundtrip 用例扩展——预置 6 个条目
  （含 `npm:billion-context-pi`、`npm:billion-context-pi@0.1.48`、dev 路径、
  Windows 反斜杠路径、无关包），断言 install 后只剩 `[无关包, root]`，remove 后只剩无关包。

## Linux 验证（本机，qwen GLM vllm @127.0.0.1:18081）

- `bili plugin remove pi` + `install pi`：settings.json 从
  `["npm:billion-context-pi","/home/dog/projects/billion-context"]` 变为单一 root 条目。
- `bili pi -- -p ...`（launcher，注意 opts 必须在 client 名之前，`--` 之后全是 client args）：
  - MITM 域发现（open.bigmodel.cn、coding.dashscope）+ 7 个 HTTP /bili/ 重写 ✓
  - 插件加载（pi 0.83.5 via packages 路径条目）→ proxyBase 检测 ✓ → manifest 获取 ✓
  - 临时调试行确认 `ctx.model.baseUrl` = 重写后的 /bili/ URL，检测链正确
  - round 1 wire 注入（设计内：toolsReady 竞态守卫），真实工具调用后的第二个请求
    盖上 `x-bili-plugin: pi` + conversation id + context-window=1000000 → 插件原生接管 ✓

## Follow-up 2: `bili pi` 原生体验开箱即用（-e 注入，无需先 install）

用户确认目标：其他客户端 `bili omp`/`bili opencode` 都开箱即原生，pi 是唯一要手动
install 的缺口。补齐：

- `src/launcher.ts` pi 分支：未 install 时给 clientArgs 前置 `pi -e <selfDistFile("agent/pi.js")>`
  （pi 官方开关，仅本次运行加载扩展，不写 settings.json）；已 install 则不加
  （互斥——pi 按解析后路径做扩展身份，install 条目（包根）与 -e（文件）路径不同，
  同时加载会双份注册同名工具/命令，必须二选一）。新增 `piPluginInstalled()` helper，
  复用与 install 相同的 `isPiEntry` 判定。
- `src/plugin-install.ts`：`isPiEntry` 改 export。
- `tests/launcher.test.ts` 新增 "runLaunch pi: native -e plugin injected only when not
  installed"（未装→args 前两项 `[-e, dist/agent/pi.js]`；已装→无 `-e`）。踩坑：
  makeFakeChild 不触发 exit 事件，runClient 的 promise 永不 resolve→测试挂起；
  需包一层 on，注册 exit listener 后 setTimeout 异步触发；代理子进程保持原样。
- 全量 516/516 ✅，typecheck ✅，build ✅（dist/index.js 2.45MB）。
- 真实 e2e（本机未安装状态）：`bili plugin remove pi` 后 `bili pi -- -p "read ..."`
  → 第一个真实工具请求即带 `"x-bili-plugin":"pi"` + conversation +
  context-window=1000000（/tmp/bili-proxy-34117.log 验证），退出后重 install 恢复。

## Follow-up 3: Windows VM 验证 -e 注入（全通）

- npm pack 当前分支 → bili-fix2.tgz scp → `npm install -g`（VM 现为 0.1.50+双修复）。
- `bili plugin remove pi`（未安装态）→ `bili pi -- -p "read C:\\Users\\dog\\note-e2e.txt ..."`
  → EXITCODE=0，逐字复述正确，上游请求头 `"x-bili-plugin":"pi"` + context-window=1000000
  （Temp\\bili-proxy-8787.log 验证）→ Windows 上 -e 注入原生接管 ✓。
- 结束后 `bili plugin install pi` 恢复安装态（install 路径在 Windows 再次验证 ✓），
  临时文件已清理。
- 坑：写 .bat 必须 CRLF（LF 行尾会让 cmd 错拆 %VAR% 报 `'PDATAPATH"' 不是内部或外部命令`）。

## Windows 验证（win10-vm，Node 22.23.2 / npm 10.9.8 / pi 0.84.1 / GLM）

| 步骤 | 结果 |
|------|------|
| `npm install -g billion-context@latest`（0.1.39→0.1.50） | ✅ 13s |
| `bili --version` | ✅ 0.1.50 |
| `npm install -g bili-fix.tgz`（npm pack 产物，含修复） | ✅ |
| `bili plugin install pi` | ✅ 旧 `npm:billion-context-pi` 被替换为 `C:\Users\dog\AppData\Roaming\npm\node_modules\billion-context`（唯一条目；settings.json.bili-bak 自动备份） |
| `bili plugin list` | ✅ pi: installed |
| `bili pi -- -p ...`（GLM cert-MITM open.bigmodel.cn） | ✅ acp_status 全量输出 + DONE |
| 插件原生接管 | ✅ 上游请求头含 `x-bili-plugin: pi` + conversation + context-window=1000000（Windows 首请求即接管，manifest 在首请求前完成注册） |
| `bili start --port 18901` | ✅ 监听/persist/状态日志(`~/.local/state/billion-context/bili.log`)/auto-update/web UI/health 全通 |

Windows 踩坑记录（沿用 win10-vm.md 的既有结论）：
- SSH 会话 PATH 缓存：每条命令前 `set "PATH=C:\Program Files\nodejs\;%APPDATA%\npm;%PATH%"`。
- 嵌套引号（cmd over ssh + powershell）不可靠：看文件直接 scp 回来，多步操作写 .bat。
- `start /b` 起的后台进程随 SSH 会话退出而死：同会话 bat 内 start + curl + netstat/taskkill。
- VM 的 pi 没有 bash 工具（Windows），测真实工具回转用 read/ls。

## 其他

- 本机全局 bili 重装为 registry 0.1.50（原为指向 repo 的 symlink）；
  后又 `npm install -g ~/projects/billion-context`（symlink 回 repo，dist 即当前构建）。
- 系统文档 ~/system/win10-vm.md 已更新（commit c38c6f5）。
- VM 临时文件（bili-fix.tgz、vm-start-test.bat、bili-start.log）已清理；
  VM 保留 tgz 版 0.1.50（含修复），后续 0.1.51 发版后 auto-update 接管。
