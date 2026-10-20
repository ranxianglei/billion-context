# BiliTray

A standalone system-tray indicator for a running [billion-context](../README.md) proxy. It polls the loopback admin API (every 5 s by default) and shows live session, context-pressure and cache-hit statistics as an OS tray tooltip plus a click menu. Windowless: no window, no webview.

## Why standalone

- Ships **only** via GitHub Releases (tag namespace `tray-v*`, built by [.github/workflows/ci-tray.yml](../.github/workflows/ci-tray.yml)). It is NOT part of the `billion-context` npm package (the `files` allowlist excludes `tray/`) and never enters any host plugin lane (dsh/opencode/pi). Result: no npm install-size change, no postinstall step, no binary inside any package registry or plugin repository.
- The proxy itself is untouched: BiliTray only reads `http://127.0.0.1:<port>/__bili/status` and `/__bili/stats`.

## Install

Download from the latest release (tags `tray-v*`):

| Platform | Artifact | Install |
|----------|----------|---------|
| macOS (Intel + Apple Silicon) | `BiliTray-vX.Y.Z-macOS-universal.dmg` | drag to Applications |
| Windows x64 | `BiliTray-vX.Y.Z-Windows-x64-setup.exe` | NSIS installer, per-user (no admin needed) |
| Linux x64 | `BiliTray-vX.Y.Z-Linux-amd64.deb` | `sudo dpkg -i …` (needs libwebkit2gtk-4.1 / GTK3) |

> **Signing status (v1):** builds are unsigned and un-notarized. macOS Gatekeeper will warn on first launch (right-click → Open); Windows SmartScreen may show More info. Code signing / notarization awaits owner-provided credentials (Apple Developer ID, MS code-signing certificate, Tauri updater key).

## Usage

- Tooltip: e.g. `bili v0.1.197 — 3 sessions · peak ctx 412K/1M · cache 62%`, or `bili offline — 127.0.0.1:8787: unreachable` while no proxy is running.
- Clicking the icon opens the menu:
  - header line: bili version, plus `restart pending (disk v…)` when bili has downloaded an update, plus the advisory reason when set;
  - up to 8 session lines: `name · ctx 412K/1M · cache 62%` (plus `⚠ near limit` when context pressure ≥ 85%); overflow collapses into `…and N more in the dashboard`;
  - **Open Dashboard** — opens `http://127.0.0.1:<port>/__bili/` in the default browser;
  - port line, then **Quit BiliTray**.

## Configuration

Config file (created on demand; malformed content falls back to defaults, never crashes):

- macOS: `~/Library/Application Support/bili-tray/config.json`
- Windows: `%APPDATA%\bili-tray\config.json`
- Linux: `$XDG_CONFIG_HOME/bili-tray/config.json` (or `~/.config/bili-tray/config.json`)

```json
{
  "port": 8787,
  "pollMs": 5000,
  "timeoutMs": 1500
}
```

| Key | Default | Clamped to | Meaning |
|-----|---------|------------|---------|
| `port` | 8787 | 1–65535 | loopback port of the running bili proxy |
| `pollMs` | 5000 | 1000–60000 | poll interval |
| `timeoutMs` | 1500 | 200–30000 | per-request HTTP timeout |

Changes take effect on restart. Unknown fields are ignored. This app adds NO billion-context config keys.

## Updates

v1 updates manually: download the new installer over the old one. A Tauri auto-updater is planned for a later release, pending owner-provisioned `TAURI_SIGNING_PRIVATE_KEY` (minisign pair) in this repo's CI secrets.

## Development

Layout:

```
tray/
├── Cargo.toml          # workspace: core + app
├── core/               # bili-tray-core — pure Rust (serde only): config/net/format/stats/platform
├── app/                # bili-tray-app — windowless Tauri shell; icons/ generated
├── ui/index.html       # placeholder (a windowless build never shows it)
└── tools/gen_icons.py  # regenerates all icons without external dependencies
```

- Tests: `cargo test -p bili-tray-core` — pure Rust, runs anywhere; includes integration tests against a real loopback mock server.
- Style gates (CI-enforced): `cargo fmt --all --check` and `cargo clippy -p bili-tray-core --all-targets -- -D warnings`.
- Icons: `python3 tray/tools/gen_icons.py` (pure stdlib; rerun after any design change).
- CI: `.github/workflows/ci-tray.yml` — core gates run on every PR touching `tray/**`; the dmg/nsis/deb release legs build on tag `tray-v*` and publish the GitHub Release.
- Version sync: keep `app/Cargo.toml` and `app/tauri.conf.json` versions equal (manual sync).
