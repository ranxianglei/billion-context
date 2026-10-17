# BiliTray

一个独立的系统托盘指示器,用于运行中的 [billion-context](../README.zh-CN.md) 代理。默认每 5 秒轮询一次本机管理接口,把实时会话数、上下文压力、缓存命中率显示在托盘悬停提示和点击菜单里。无窗口:不弹窗口、不嵌 webview。

## 为什么独立分发

- **只**通过 GitHub Releases 分发(tag 命名空间 `tray-v*`,由 [.github/workflows/ci-tray.yml](../.github/workflows/ci-tray.yml) 构建)。它不属于 `billion-context` npm 包(`files` 白名单不含 `tray/`),也永远不会进入任何宿主插件通道(dsh/opencode/pi)。效果:npm 安装体积零变化、没有 postinstall、任何包仓库/插件仓库里都没有二进制文件。
- 代理本身完全不动:BiliTray 只读 `http://127.0.0.1:<port>/__bili/status` 和 `/__bili/stats`。

## 安装

从最新 release(tag `tray-v*`)下载:

| 平台 | 产物 | 安装方式 |
|------|------|----------|
| macOS(Intel + Apple Silicon)| `BiliTray-vX.Y.Z-macOS-universal.dmg` | 拖进「应用程序」 |
| Windows x64 | `BiliTray-vX.Y.Z-Windows-x64-setup.exe` | NSIS 安装包,按用户安装(无需管理员) |
| Linux x64 | `BiliTray-vX.Y.Z-Linux-amd64.deb` | `sudo dpkg -i …`(需要 libwebkit2gtk-4.1 / GTK3) |

> **签名状态(v1):** 当前构建未签名、未做公证。macOS Gatekeeper 首次启动会警告(右键 → 打开);Windows SmartScreen 可能提示「更多信息」。代码签名/公证待 owner 提供凭据(Apple Developer ID、MS 代码签名证书、Tauri updater key)。

## 使用

- 悬停提示:例如 `bili v0.1.197 — 3 sessions · peak ctx 412K/1M · cache 62%`;代理没运行时显示 `bili offline — 127.0.0.1:8787: unreachable`。
- 点击图标打开菜单:
  - 头部行:bili 版本;若 bili 已下载待重启的更新会显示 `restart pending (disk v…)`;有 advisory 时显示其 reason;
  - 最多 8 行会话:`name · ctx 412K/1M · cache 62%`(上下文压力 ≥ 85% 时追加 `⚠ near limit`);超出部分折叠为 `…and N more in the dashboard`;
  - **Open Dashboard** —— 用默认浏览器打开 `http://127.0.0.1:<port>/__bili/`;
  - 端口行,最后是 **Quit BiliTray**。

## 配置

配置文件(按需创建;内容写坏时回退默认值,不会崩溃):

- macOS:`~/Library/Application Support/bili-tray/config.json`
- Windows:`%APPDATA%\bili-tray\config.json`
- Linux:`$XDG_CONFIG_HOME/bili-tray/config.json`(或 `~/.config/bili-tray/config.json`)

```json
{
  "port": 8787,
  "pollMs": 5000,
  "timeoutMs": 1500
}
```

| 键 | 默认值 | 钳制范围 | 含义 |
|----|--------|----------|------|
| `port` | 8787 | 1–65535 | 正在运行的 bili 代理的本机端口 |
| `pollMs` | 5000 | 1000–60000 | 轮询间隔(毫秒) |
| `timeoutMs` | 1500 | 200–30000 | 单次请求超时(毫秒) |

修改后重启生效;未知字段忽略。本应用**不新增任何 billion-context 配置键**。

## 更新

v1 手动更新:下载新安装包覆盖旧的即可。Tauri 自动更新器计划在后续版本加入,前提是 owner 在本仓库 CI secrets 中配置 `TAURI_SIGNING_PRIVATE_KEY`(minisign 密钥对)。

## 开发

目录结构:

```
tray/
├── Cargo.toml          # workspace: core + app
├── core/               # bili-tray-core —— 纯 Rust(仅依赖 serde):config/net/format/stats/platform
├── app/                # bili-tray-app —— 无窗口 Tauri 外壳;icons/ 为生成物
├── ui/index.html       # 占位页(无窗口构建永远不会显示它)
└── tools/gen_icons.py  # 无外部依赖重新生成全部图标
```

- 测试:`cargo test -p bili-tray-core` —— 纯 Rust,任何环境可跑;含针对真实 loopback mock 服务端的集成测试。
- 风格门禁(CI 强制):`cargo fmt --all --check` 与 `cargo clippy -p bili-tray-core --all-targets -- -D warnings`。
- 图标:`python3 tray/tools/gen_icons.py`(纯标准库;改设计后重跑)。
- CI:`.github/workflows/ci-tray.yml` —— 每个触碰 `tray/**` 的 PR 跑 core 门禁;tag `tray-v*` 触发 dmg/nsis/deb 三端构建并发布 GitHub Release。
- 版本同步:`app/Cargo.toml` 与 `app/tauri.conf.json` 的 version 需保持一致(手动同步)。
