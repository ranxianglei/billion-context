# billion-context

<p align="center"><a href="./README.md">English</a> | <a href="./README.zh-CN.md">中文</a></p>

<p align="center"><strong>Context-compression plugin</strong> — <em>billion-context is all you need.</em></p>

<p align="center"><sub>small context windows (100K is enough) · <em>5× fewer tokens</em> · month-long single sessions (billions of tokens) · high compression quality</sub></p>

<p align="center">
<a href="https://www.npmjs.com/package/billion-context"><img src="https://img.shields.io/npm/v/billion-context.svg?style=flat-square" alt="npm"></a>
<a href="https://github.com/ranxianglei/billion-context/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/billion-context.svg?style=flat-square" alt="license"></a>
<a href="https://github.com/ranxianglei/billion-context"><img src="https://img.shields.io/badge/GitHub-ranxianglei%2Fbillion--context-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

<p align="center">
<code>npm install -g billion-context</code>
</p>

<p align="center">
<a href="https://claude.com/product/claude-code" title="Claude Code"><img src="https://cdn.simpleicons.org/claude/D97757" height="26" alt="Claude Code"></a>&nbsp;
<a href="https://github.com/openai/codex" title="Codex"><picture><source media="(prefers-color-scheme: dark)" srcset="https://api.iconify.design/simple-icons/openai.svg?color=white"><img src="https://api.iconify.design/simple-icons/openai.svg" height="26" alt="Codex"></picture></a>&nbsp;
<a href="https://opencode.ai" title="OpenCode"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/opencode/FFFFFF"><img src="https://cdn.simpleicons.org/opencode/000000" height="26" alt="OpenCode"></picture></a>&nbsp;
<a href="https://pi.dev" title="pi"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/pi/FFFFFF"><img src="https://cdn.simpleicons.org/pi/000000" height="26" alt="pi"></picture></a>&nbsp;
<a href="https://github.com/google-gemini/gemini-cli" title="Gemini CLI"><img src="https://cdn.simpleicons.org/googlegemini/8E75B2" height="26" alt="Gemini CLI"></a>&nbsp;
<a href="https://www.kimi.com" title="Kimi"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/kimi/FFFFFF"><img src="https://cdn.simpleicons.org/kimi/000000" height="26" alt="Kimi"></picture></a>&nbsp;
<a href="https://github.com/QwenLM/qwen-code" title="Qwen Code"><img src="https://cdn.simpleicons.org/qwen/6950EF" height="26" alt="Qwen Code"></a>&nbsp;
<a href="https://github.com/github/copilot-cli" title="GitHub Copilot CLI"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/githubcopilot/FFFFFF"><img src="https://cdn.simpleicons.org/githubcopilot/000000" height="26" alt="GitHub Copilot CLI"></picture></a>&nbsp;
<a href="https://www.trae.ai" title="TRAE"><img src="https://cdn.simpleicons.org/trae/32F08C" height="26" alt="TRAE"></a>&nbsp;
<a href="https://www.codebuddy.cn" title="CodeBuddy"><img src="https://cdn.simpleicons.org/codebuddy/6C4DFF" height="26" alt="CodeBuddy"></a>&nbsp;
<a href="https://qoder.com" title="Qoder"><img src="https://icons.duckduckgo.com/ip3/qoder.com.ico" height="26" alt="Qoder"></a>&nbsp;
<a href="https://iflow.cn" title="iFlow CLI"><img src="https://img.alicdn.com/imgextra/i4/O1CN01yBfg3x1iNi4YggwIt_!!6000000004401-2-tps-72-72.png" height="26" alt="iFlow CLI"></a>&nbsp;
<a href="https://www.minimax.io" title="MiniMax Code (mcode)"><img src="https://cdn.simpleicons.org/minimax/E73562" height="26" alt="MiniMax Code"></a>&nbsp;
<a href="https://www.deepseek.com" title="deepseek-harness (dsh)"><img src="https://cdn.simpleicons.org/deepseek/5786FE" height="26" alt="deepseek-harness"></a>&nbsp;
<a href="https://ampcode.com" title="Amp"><img src="https://icons.duckduckgo.com/ip3/ampcode.com.ico" height="26" alt="Amp"></a>&nbsp;
<a href="https://aider.chat" title="aider"><img src="https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/assets/icons/favicon-32x32.png" height="26" alt="aider"></a>&nbsp;
<a href="https://github.com/aaif-goose/goose" title="goose"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/aaif-goose/goose/main/documentation/static/img/logo_dark.png"><img src="https://raw.githubusercontent.com/aaif-goose/goose/main/documentation/static/img/logo_light.png" height="26" alt="goose"></picture></a>&nbsp;
<a href="https://github.com/NousResearch/hermes-agent" title="hermes"><img src="https://raw.githubusercontent.com/NousResearch/hermes-agent/main/apps/bootstrap-installer/src-tauri/icons/128x128.png" height="26" alt="hermes"></a>&nbsp;
<a href="https://z.ai" title="zcode (Z.ai)"><img src="https://z-cdn.chatglm.cn/z-ai/static/logo.svg" height="26" alt="zcode"></a>&nbsp;
<a href="https://omp.sh" title="omp (oh-my-pi, Stencil Labs)"><img src="https://omp.sh/favicon.svg" height="26" alt="omp"></a>&nbsp;
<a href="https://github.com/1jehuang/jcode" title="jcode"><img src="https://github.com/1jehuang.png" height="26" alt="jcode"></a>
</p>

---

> **Cache health at a glance:** a healthy session keeps a **95–97%** prefix-cache hit rate — compression itself costs ≤2%. Sustained lower? Check attribution with `/acp` or `/acp-cache` (see [FAQ](#faq)); usual causes, in order: upstream cache TTL expiry · model switch · a bili bug (please report) · other/unknown.

## Community

QQ Group:
1056132097 (full)
1108730198 (open)

---

## 📄 Paper / Preprint

- **[Model-Driven Incremental Hierarchical Compression: Training-Free Multi-Generational Context Management for Long-Lived Coding Agents](./paper/model-driven-incremental-hierarchical-compression-training-free-multi-generational-context-management-for-long-lived-coding-agents.md)** (English, v0.2)

> 📝 **The paper itself is open-sourced under the MIT License as part of the codebase (`paper/`). It is a living document — anyone may edit it; improvements are welcome via pull request.**

A production-scale longitudinal study: 4.5 months, three hosts, 174,327 model calls, 18.76B cumulative input tokens (~24.7B across all hosts), zero window violations on 204,800-token models, marathon sessions of 8,584–12,049 calls.

---

`billion-context` sits between **any** agent and its model API, rewriting Anthropic/OpenAI streams with [acp-kernel](https://github.com/ranxianglei/acp-kernel) compression. The model decides **when** and **what** to compress into high-fidelity summaries — not a hard truncation limit.

## Why

Long coding sessions blow up context. Each provider charges per token, and once you pass the context window the session degrades or dies. `billion-context` compresses consumed conversation into layered summaries so you can run a single session for days — billions of tokens through one context window.

Unlike a host's built-in summarizer, compression here is **incremental, reversible, and prefix-cache friendly**: summaries are written in small ranges, can be decompressed on demand, and the cache prefix stays intact.

## How it works

```
Agent (Claude Code / Codex / Cursor / Aider ...)
        │  you point the agent's base URL at the proxy
        ▼
┌─────────────────┐
│  billion-context│   1. parse the request (Anthropic or OpenAI shape)
│     proxy       │   2. run acp-kernel compression on the conversation
│                 │   3. inject a `compress` tool + compression philosophy
│                 │   4. forward to the real model API
│                 │   5. rewrite the streaming response
└─────────────────┘
        │
        ▼
   real model API (Anthropic / OpenAI / compatible)
```

### Context-management tools

The proxy injects four context-management tools into the conversation; the model calls them itself as context grows, and the proxy executes `compress` server-side so folded ranges stay summarized in history until restored:

- **`compress`** — fold a message range into a detailed summary.
- **`decompress`** — restore a compressed range when exact details are needed again.
- **`search_context`** — keyword search over compressed summaries and visible messages.
- **`acp_status`** — context-usage overview plus which ranges are still compressible.

## Which do I need?

Pick by your client:

| Client | Use |
|---|---|
| **pi** | [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) (in-process extension) |
| **opencode** (1.x / 2.x) | [`billion-context`](https://github.com/ranxianglei/billion-context) — `bili opencode` (launcher) or `bili plugin install opencode` (native); standalone [`opencode-acp`](https://github.com/ranxianglei/opencode-acp) remains usable on 1.x — full guide: [OpenCode](CLIENTS.md#opencode) |
| **omp** | [`billion-context`](https://github.com/ranxianglei/billion-context) via `bili omp` (built-in plugin) or `bili plugin install omp` (self-spawning native plugin, no launcher) |
| **dsh** | `bili dsh` (launcher — full native plugin via `--patch`) or `bili plugin install dsh` ≡ `dsh plugin --profile <name> add billion-context` (one unified lane) — details: [CLIENTS.md](CLIENTS.md) |
| **kimi** | `bili plugin install kimi` (self-spawning native, Kimi Code ≥ 2.0.0) or `bili kimi` (cert-MITM) or `/bili/` prefix — details: [CLIENTS.md](CLIENTS.md) |
| **hermes** | `bili plugin install hermes` (self-spawning native, Python plugin #958) or `bili hermes` (cert-MITM) |
| **zcode** (Z.ai / bigmodel coding plan) | `bili plugin install zcode` (self-spawning native, #1145) or cert-MITM via the GUI's Settings → Network or `/bili/` prefix — details: [CLIENTS.md](CLIENTS.md) |
| **claude** | `bili claude` (launcher) or `bili plugin install claude` (native posture, #964 — managed settings block + session-owned proxy; see the notes below) |
| **codex** | `bili codex` (launcher — the full zero-config posture) or `bili plugin install codex` (MCP-shell tools companion: **start bili first** — the shell never spawns a proxy and never routes codex's own traffic) — details: [CLIENTS.md](CLIENTS.md#codex-openai-codex-cli) |
| **jcode** | [`billion-context`](https://github.com/ranxianglei/billion-context) via `bili jcode` (cert-MITM) or `/bili/` prefix — no native mode (compiled Rust binary, no plugin seam, [#962](https://github.com/ranxianglei/billion-context/issues/962)) |
| **gemini** (Gemini CLI) | `bili gemini` (launcher, `GOOGLE_GEMINI_BASE_URL` `/bili/` rewrite) or `/bili/` prefix — launcher-only (no in-loop tool seam, #1043) |
| **iflow** (iFlow CLI) | `bili iflow` (launcher, `IFLOW_BASE_URL` `/bili/` rewrite) or `/bili/` prefix |
| **qwen** (Qwen Code) | `bili qwen` (launcher, cert-MITM) or `/bili/` prefix |
| **mcode** (MiniMax Code) | [`billion-context`](https://github.com/ranxianglei/billion-context) via `bili mcode` (cert-MITM) or `/bili/` prefix — no native mode (event hooks only, no model-request seam, [#1050](https://github.com/ranxianglei/billion-context/issues/1050)) |
| **aider** | [`billion-context`](https://github.com/ranxianglei/billion-context) via `bili aider` (cert-MITM) or `/bili/` prefix — no native mode (shell-command-only hooks, no tool-injection seam, [#1048](https://github.com/ranxianglei/billion-context/issues/1048)) |
| **copilot** (GitHub Copilot CLI) | `bili copilot` (launcher, cert-MITM) — closed Go binary, no plugin seam (#1049) |
| **amp** (Amp CLI) | `bili amp` (launcher, cert-MITM) — closed Go binary, no plugin seam (#1049) |
| **goose** (Goose CLI) | `bili goose` (launcher) — rustls trusts no CA file, so no cert-MITM: openai/anthropic legs via `OPENAI_HOST`/`ANTHROPIC_HOST`, custom providers via a regenerated `GOOSE_PATH_ROOT` overlay (#1049) |
| **everything else** (no context hook) | [`billion-context`](https://github.com/ranxianglei/billion-context) — `bili <client>` (launcher, preferred) or `/bili/` prefix |

**Native mode vs standalone extensions.** The host-native plugins (`bili plugin install …`) and the standalone in-process extensions (`billion-context-pi`, `opencode-acp`) are **mutually exclusive** — both active means double compression. The installer makes the switch: it replaces the legacy entries (bare name, `npm:` alias, versioned, path form; array or object shape) and snapshots the original config to `.bili-bak` once; a **project-local** install is not touched — remove that one by hand. As a runtime safety net for manual installs, the native entries set `BILLION_CONTEXT_NATIVE=<host>` synchronously at load so a standalone extension can stand down at action time. On the pi side the marker needs `billion-context-pi` **0.1.72+**, and the pi-native entry scans both pi settings files once its proxy is up and warns loudly when it spots a co-resident legacy entry the installer never saw — that warning is the only visible signal while an old `billion-context-pi` silently double-compresses.


## Install

```bash
npm install -g billion-context
```

This installs the `bili` command (`bili-proxy` is kept as an alias).

## Quickstart

Three ways to use it — pick one:

- **Native plugin (most native):** `bili plugin install <client>` — bili
  becomes a plugin inside the client; start the client as usual.
- **Launcher (config-free):** one `bili <client>` command brings up the proxy and
  the client together — no real config file is ever touched.
- **URL change (most universal):** prefix your client's baseURL with the proxy
  origin + `/bili/`.

Mechanism details behind these three options (plugin lifecycle, runtime-info
protocol, injection priority) live in [TECHNICAL-NOTES.md](TECHNICAL-NOTES.md).

Ports, briefly (#1660): `bili start` (manual) owns `8787`. Everything a lane
spawns for you (native hooks, launcher lanes) lives in a separate
self-managed zone starting at `18787` — collisions hop +1 and each lane
remembers its drift, so zero-config installs never fight you for a port,
and a deliberate `bili start` daemon is attached by default. An
upgrade-restart that finds the previous build still draining on the lane's
port waits for it to release (up to 5s) and rebinds the SAME port instead of
drifting (#1723); only a genuinely occupied port hops +1 — and that hop is
now logged loudly.

### Option 1 — Native plugin (`bili plugin install pi` / `omp` / `opencode` / `dsh` / `kimi` / `hermes` / `zcode`)

The proxy lives inside the client: install once, then start the client
exactly as you always do — no launcher command, no env vars, no fixed port,
no URL edits. Supported today for **pi**, **omp**, **opencode** (1.x and
2.x), **dsh**, **kimi**, **hermes** and **zcode**:

```bash
bili plugin install pi          # registers a "billion-context" entry in pi's settings (npm form when bili itself was npm-installed)
bili plugin install omp         # registers an extensions entry in omp's config.yml (~/.omp/agent/config.yml)
bili plugin install opencode    # registers the plugin in opencode's real config + disables native auto-compaction
bili plugin install dsh         # runs 'dsh plugin --profile <name> add billion-context' for every existing profile
bili plugin install kimi        # writes $KIMI_CODE_HOME/plugins/managed/billion-context/kimi.plugin.json (+ installed.json record); per-session routing block lands in config.toml on first start (Kimi Code >= 2.0.0)
bili plugin install hermes      # copies the Python plugin into ~/.hermes/plugins/billion-context/ (+ machine-owned bili.json sidecar) and enables it via `hermes plugins enable billion-context`
bili plugin install zcode       # writes hooks.enabled + a SessionStart hook + mcp.servers.bili into ~/.zcode/cli/config.json; per-session routing lands in the bigmodel provider store on first start
bili plugin remove <client>     # undo (dsh removes through the same channel; config snapshots go to .bili-bak)
```

Where a client has its own plugin channel you can also install natively,
skipping bili commands entirely:

- **dsh:** `dsh plugin --profile <name> add billion-context` is the very
  command `bili plugin install dsh` drives per profile — same end state
  either way (pnpm into the profile, bundled patch layer mounted by dsh
  itself); remove through the same channel. See the dsh section below.
- **opencode:** add the bare npm name to your real config's plugin list —
  `"plugin": ["billion-context"]` (npm form only; a git checkout has no
  published entry). The package publishes `exports["./server"]` →
  `dist/agent/opencode-native.js`, so opencode loads it through its own
  Npm.add machinery and the plugin self-spawns exactly like the
  bili-installed form. Do the two things the bili installer would have done
  for you too: set `"compaction": { "auto": false }` in the same config
  (otherwise OpenCode's native auto-compaction double-compresses) and keep a
  manual backup of the file first.

For pi / omp / kimi / claude there is no client-side channel — `bili plugin
install <client>` writes their config entries for you (kimi's declarative
`kimi.plugin.json` + registry record, claude's managed settings block, …).

Notes:

- Native mode is **mutually exclusive** with the standalone in-process extensions (`billion-context-pi`, `opencode-acp`) — the installer swaps the entries and snapshots the original config (`.bili-bak`).
- OpenCode legacy sessions, V1/V2 shapes and caveats: [OpenCode](CLIENTS.md#opencode).
- `kimi` reports runtime-info at bootstrap only (static headers can't carry per-request window/model values); subagent tool calls are routed by the proxy's outbound tool-use witness ring (#1685) — no model-visible conversation id.
- `hermes`'s native plugin is Python: it points hermes' httpx stack at the proxy via env vars after a health check and stamps per-request headers through an `llm_request` middleware.
- `codex` is the one client a plugin install cannot make self-sufficient: codex routes model traffic via env only (no config-file routing seam for the default ChatGPT-login provider — a managed `model_providers` block would force API-key auth and drop subscription login), and an MCP server cannot inject env into its parent. `bili plugin install codex` writes a single `[mcp_servers.bili]` block into `~/.codex/config.toml` (command = node, args = dist/mcp.js) exposing the four ACP tools; at session start the shell resolves a proxy — env `BILI_MCP_PROXY` > the live-instance record (any lane's proxy or a `bili start` daemon) > the 8787 user-zone default (#1660 removed the install-time origin bake, #403) — nothing reachable → `tools/list` fails with -32003. So: start bili first (`bili start` or any client's lane proxy), export HTTPS_PROXY yourself if you also want compression, or use `bili codex` for the zero-config full posture. Mechanics: [CLIENTS.md](CLIENTS.md#codex-openai-codex-cli).
- `claude` has a native posture (#964): managed settings block + `SessionStart` hook + MCP shell; the hook rides the self-managed port zone (#1660) and re-pins the managed URL to the live origin each session, so port drift self-heals. Opt out with `BILI_NATIVE_CLAUDE=0` (passthrough). Mechanics: [TECHNICAL-NOTES.md](TECHNICAL-NOTES.md).
- `zcode` has a native posture (#1145): managed `~/.zcode/cli/config.json` block + per-session provider `baseURL` rewrite. Full mechanics: [CLIENTS.md](CLIENTS.md).
- `jcode` and `aider` have no native mode (no plugin/MCP/tool-injection seam: #962, #1048) — use `bili jcode` / `bili aider`.
- `copilot`, `amp` and `goose` are launcher-only (#1049); goose cannot be cert-MITMed (rustls trusts no CA file) and rides plain-HTTP base-URL redirects instead.

### Option 2 — Launcher (`bili pi` / `bili codex` / `bili claude` / `bili omp` / `bili opencode` / `bili hermes` / `bili dsh` / `bili codebuddy` / `bili qoder` / `bili trae` / `bili jcode` / `bili kimi` / `bili gemini` / `bili iflow` / `bili qwen` / `bili mcode` / `bili aider` / `bili copilot` / `bili amp` / `bili goose`)

The launcher wraps a client in one command: it starts a proxy on an
independent port (a fresh instance is always spawned — a port is never
reused), then points the client at it — **certificate-based MITM** where the
client honors proxy/CA env vars, or an isolated **`/bili/` config rewrite**
where it doesn't. No real config file is ever edited; the client's own
config is READ to discover which HTTPS upstream hosts it talks to, and those
hosts are whitelisted for MITM so the proxy can TLS-terminate exactly them
and blind-tunnel everything else.

```bash
bili pi                               # launch pi through the proxy — file-free (#535): env + extension registerProvider, real ~/.pi untouched
bili codex                            # launch codex through the proxy
bili claude                           # launch claude through the proxy
bili omp                              # pi-style, file-free (#535): env + extension registerProvider + compaction cancel, real ~/.omp untouched
bili opencode                         # OpenCode (1.x & 2.x): full guide in the [OpenCode](CLIENTS.md#opencode) section below
bili hermes                           # file-free (#535): hermes proxy env (HTTPS_PROXY + combined CA bundle via SSL_CERT_FILE) — https via CONNECT MITM, http via absolute-form forward proxy; real ~/.hermes untouched
bili dsh                              # deepseek-harness: full native plugin injected via --patch (#941) — real dsh tools, session-bound /acp + /acp-cache (plugin mode); non-loopback upstreams ride proxy envs, loopback keeps the overlay DSH_HOME rewrite (#535); dsh auto-compaction off
bili codebuddy                        # Tencent CodeBuddy Code CLI: CODEBUDDY_BASE_URL /bili/ rewrite (OpenAI chat completions wire), budget aligned via CODEBUDDY_AUTO_COMPACT_WINDOW; real ~/.codebuddy untouched
bili qoder                            # qoder: model endpoint is hardcoded https (no /bili/ rewrite possible) — cert-MITM via HTTPS_PROXY + NODE_EXTRA_CA_CERTS, default model hosts whitelisted (#653)
bili trae                             # Trae CLI (ByteDance, closed Go binary, no base-URL override) — cert-MITM via HTTPS_PROXY + SSL_CERT_FILE, model host from TRAE_CLI_API_HOST or the default enterprise gateway (#655)
bili jcode                            # jcode (Rust agent harness) — env-only cert-MITM launch: HTTPS_PROXY + SSL_CERT_FILE, model host api.z.ai whitelisted, local loopback providers stay direct via NO_PROXY
bili kimi                             # Kimi Code CLI (Moonshot): standard proxy envs except an unconditional loopback bypass — https via cert-MITM, http via absolute-form forward proxy; loopback endpoints inventoried with a manual /bili/ hint (#757)
bili gemini                           # Gemini CLI (Google): GOOGLE_GEMINI_BASE_URL /bili/ rewrite to generativelanguage.googleapis.com (Google native wire), real ~/.gemini untouched
bili iflow                            # iFlow CLI: IFLOW_BASE_URL /bili/ rewrite to apis.iflow.cn/v1 (OpenAI chat-completions wire), real ~/.iflow untouched
bili qwen                             # Qwen Code (multi-protocol gemini-cli fork, no base-URL hook): cert-MITM via HTTPS_PROXY + NODE_EXTRA_CA_CERTS, default DashScope/Qwen model hosts whitelisted, custom relays via --mitm-domain
bili mcode                            # MiniMax Code CLI: same shape as kimi (proxy envs, unconditional loopback bypass, cert-MITM/absolute-form); session bound via X-Mavis-Session-Id (#1050)
bili aider                            # Aider (Python pair programmer): cert-MITM via HTTPS_PROXY + SSL_CERT_FILE/REQUESTS_CA_BUNDLE; endpoint from OPENAI_API_BASE / ANTHROPIC_BASE_URL / --openai-api-base / .aider.conf.yml (#1048)
bili copilot                          # Copilot CLI (GitHub, closed Go binary) — cert-MITM via HTTPS_PROXY + SSL_CERT_FILE, api.githubcopilot.com + per-plan subdomains whitelisted (#1049)
bili amp                              # Amp CLI (Sourcegraph, closed Go binary) — cert-MITM via HTTPS_PROXY + SSL_CERT_FILE, ampcode.com whitelisted (#1049)
bili goose                            # Goose (Block, Rust/reqwest): rustls release builds trust no CA file — openai/anthropic legs via OPENAI_HOST/ANTHROPIC_HOST, custom providers via a regenerated GOOSE_PATH_ROOT overlay (/bili/ rewrites, real config untouched) (#1049)
bili pi --mitm-domain api.foo.com     # add a domain to the MITM whitelist
```

### Option 3 — URL change (`/bili/` prefix)

Start the proxy:

```bash
bili
```

Then just prefix your client's existing baseURL with `http://localhost:8787/bili/`.
The full upstream URL is embedded in the path, so the proxy knows where to
forward without any config:

```
client baseURL before:  https://api.openai.com/v1
client baseURL after:   http://localhost:8787/bili/https://api.openai.com/v1
```

For more per-client configuration examples, see the web UI guide at [http://localhost:8787](http://localhost:8787).

**Verify.** With the proxy running and your config saved, check it answers
and that your first real request shows compression activity in the log:

```bash
# Health check (proxy up + where it forwards)
curl -s http://localhost:8787/__bili/health
# → {"ok":true,"upstream":"https://api.anthropic.com"}

# Live session stats (after a real request)
curl -s http://localhost:8787/__bili/stats
```

Then send one message from your client and watch the log
(`~/.local/state/billion-context/bili.log`, also printed to stderr). You
should see a `processTurn` line per request, and once the conversation grows,
`[acp-usage] round N input=X cached=Y (cache hit Z%)` + a `compress` event.

### Client deep dives

Everything that doesn't fit in one Quickstart line — how each client's lanes attach, what gets written where, and known limitations — lives in **[CLIENTS.md](CLIENTS.md)**: dsh · Kimi Code · Hermes · ZCode · Gemini family (Gemini CLI / iFlow CLI / Qwen Code) · cert-MITM clients that never compress (CONNECT blind tunnels, #897) · unrecognized endpoints going direct (#1290) · OpenCode (launcher / native / pure proxy, `/acp` status & rules, legacy opencode-acp sessions #920).

## FAQ

**How do I check my cache hit rate?** Don't dig through logs — `/acp-cache`
prints a **text summary report right in the client**, headed by a clickable
**Web UI link**: open it for the web version of the session page — the cache
hit-rate **line chart** plus per-break **attribution**:

![web session page: cache hit-rate chart + attribution](docs/cache-web-session.en.png)
The report has four
blocks that pin things down at a glance: **GRAND LEDGER** (totals + hit% with
an explicit `HEALTHY` verdict; misses decomposed into new content /
compress re-pay / upstream-ttl-or-client-rewrite) · **FOLD ECONOMICS** (per-fold
economics: net tokens saved, paid-back verdicts) · **LINE ITEMS** (anomalies
only: hit<85% or miss≥5000). Rule of thumb: **compression itself costs ≤2%** —
a healthy session sits at **95–97%**. When you see less, the attribution tells
you which of the usual suspects it was, in this order: ① upstream cache TTL
expiry (shows up as stable-prefix misses — the top-spikes line names idle
times), ② a model switch, ③ a bili bug (report it with the page attached),
④ other/unknown. `/acp-cache [full]` lists every fold & line; same report over
Since #1535 the report ends with a `MODEL SWITCHES` section: a mid-session
model change invalidates the provider's prefix cache, so the whole stable
prefix is re-billed on the next request — each switch's unexplained residual
(its `ttl` bucket minus new content) is charged to the switch instead of
masquerading as TTL expiry; per-event `from → to`, hit %, and attributed
tokens are listed (`full` lists every event, the summary the last 8), and
the web sessions table gains a matching model-switch column.
HTTP: `GET /__bili/cache-report`; the raw per-request `[acp-usage]` lines still
land in the log file for deep dives.

**What does `/acp` show?** In clients with the native plugin (opencode, dsh),
`/acp` renders the ACP status panel of the current conversation straight from
the proxy (session, blocks, compressible ranges, usage); before the first model
request it shows an idle notice instead. `/acp-cache [full]` prints the cache
report above.

**Can I query sessions and config over the web?** Yes — open
[http://localhost:8787](http://localhost:8787): an overview dashboard, session
list with per-session detail, live logs, a config editor, and an upstream
connectivity test. Everything is also plain JSON for scripting
(`/__bili/stats`, `/__bili/sessions`, `/__bili/config`, …).

**When does compression happen?** It is model-driven: the injected context
tools are called by the model as context grows, gentle growth nudges
(~50K-token steps by design, adjustable via `compress.nudgeGrowthTokens`)
prompt it along the way, and preflight fires as a hard backstop when the input
alone exceeds the window (#470). Watch it live with `/acp` or the web UI.

**Is bili transparent? How do I turn it off?** Unrecognized endpoints forward
unchanged ([CLIENTS.md](CLIENTS.md)), and every mode reverses cleanly:
`bili plugin remove <client>` for native installs, stop using the launcher
command / env vars / `/bili/` prefix for the other two — traffic goes direct
again immediately.

**Where are logs and session data stored?** Log:
`~/.local/state/billion-context/bili.log` (also mirrored to stderr); session
state: `~/.local/share/billion-context/` (XDG-overridable; Windows AV exclusion
#362, opt-in cleanup #1082) — full paths in [CONFIGURATION.md](CONFIGURATION.md).

## Running the proxy

### Flags

```bash
bili --port 9000              # change listen port
bili --host 0.0.0.0           # listen on all interfaces (see host note below)
bili --debug                 # verbose logging (also: set "debug": true in config)
bili --passthrough           # forward without compression (smoke-test mode)
bili --config ~/my-bili.json # use a different config file
bili update                  # check & install a newer version now (bypasses throttle)
bili --no-auto-update        # disable self-update for this run
bili --auto-restart-on-update   # self-restart when a new version is installed (default off)
```

Flags override env vars and the config file. `bili --help` lists them all.

### Remote agents (`--host`)

By default the proxy binds `127.0.0.1` and only accepts loopback connections. To serve agents on other machines: `bili --host 0.0.0.0` (or your LAN IP); remote agents point their model `baseURL` at `http://<this-host>:<port>/bili/…`.

- MITM-mode `CONNECT` then also accepts remote clients — for **whitelisted model hosts only**. Blind tunnels to arbitrary hosts stay loopback-only, so the proxy can never be used as an open relay.
- `/bili/<absolute-url>` destination admission (#409): the proxy itself and link-local/metadata addresses are always denied; loopback/private destinations are allowed for local clients (self-hosted upstreams) and denied for remote clients unless listed in `BILI_TUNNEL_ALLOWED_HOSTS` (`host` or `host:port`, comma-separated). One exception (#1073): a **local** client relaying a management path (`/__bili/*`, `/__acp/*`) to a **loopback IP-literal** destination is forwarded unmarked; remote peers and hostname destinations keep the internal tunnel marker unconditionally, and management paths stay unreachable through the tunnel even via NAT hairpin. An absolute-form request addressed to the instance's own endpoint on a management path is served locally instead of tunneled (a forward-proxy-style health probe gets a real answer).
- There is **no authentication**: only do this on a trusted LAN or behind a firewall. The `/__bili/` management endpoints remain loopback-only. A startup `[security]` warning reminds you of the above.

### Debugging

`bili --debug` (or env `ACP_DEBUG=1`, or `"debug": true` in config — flag > env > config) logs every `processTurn` (tag counts, token usage), the nudge decision (growth/usage/pendingT1/shouldInject), client headers, and SSE rewrites.

### Log file

All logs tee to `~/.local/state/billion-context/bili.log` by default (XDG state dir) and still print to stderr. Override with `"logFile"` in config or `ACP_LOG_FILE` (`off` disables the file). Auto-rotates at 10 MB (`bili.log.old`). Per-request cache-hit stats log as `[acp-usage] round N input=X cached=Y (cache hit Z%)` so you can measure prefix-cache health directly from the log.

### Self-update

The proxy checks npm on startup and every 3 minutes; a newer version is installed in place and a notice is logged — **restart `bili` to pick it up**, unless you enable opt-in self-restart (`--auto-restart-on-update` flag, env `ACP_AUTO_RESTART_ON_UPDATE=1`, or `"autoRestartOnUpdate": true` in config — default OFF): with zero in-flight requests it verifies the new install, stops accepting connections, drains, spawns a replacement on the same port, and exits once it accepts connections (clients reconnect automatically; session state survives on disk). Safety gates: zero in-flight through the drain window, an install sanity check before re-exec, and a 10-minute cooldown marker so a flapping version can never loop-restart; any failure resumes the original listener and falls back to the plain reminder.

While the running process is behind the on-disk install ("stale"), the web UI shows a banner (running vs installed version, auto-restart state) and `GET /__bili/status` returns `{version, diskVersion, stale, autoRestartOnUpdate, advisory, inFlight}` for scripting (`advisory` is the active critical-defect entry or `null`, see below). Disable permanently via `"autoUpdate": false` in config or `ACP_AUTO_UPDATE=0`.

### Critical-defect advisories (forced updates)

Independent of auto-update (#1481): even with `autoUpdate` off, the proxy polls a small companion npm package (`billion-context-advisories`, published by CI from this repo's [`advisories/`](advisories/) directory) on the same 3-minute cadence. Each advisory names a semver range of broken versions (`affected`), the exact version to install (`target` — which may be *older* than the current one, i.e. a rollback), and a user-facing `reason`. When the local version falls inside `affected`, bili force-installs `target` through the self-updater's full safety chain (cross-process lock, backup + verify + rollback; source checkouts and host-managed installs are refused with manual instructions instead) and warns prominently: a one-time `[advisory] ⚠️ …` log line per process per advisory id, a banner on the web UI showing the reason and the exact manual upgrade command, and the active entry under `advisory` in `/__bili/status`. The check is fail-open by design: an unreachable or malformed advisory source only produces a warning — model traffic is never blocked by it. Disable via config (`"advisoryCheck": false`) or env (`BILI_ADVISORY_CHECK=0`); point at a custom document with `"advisoryUrl"` / `BILI_ADVISORY_URL`.

## Configuration

The full configuration reference — config file location, top-level keys,
providers, compression tuning, environment variables — lives in
**[CONFIGURATION.md](CONFIGURATION.md)**.

Two knobs people look for first:

- **Upstream proxy (firewall/GFW)** — routing the proxy's own outbound traffic through v2rayA/clash: full resolution order, empty-string = explicit direct, SOCKS5 rejection, both egress paths, and the `mitm://` vs `https://` key schemes live in [CONFIGURATION.md](CONFIGURATION.md) (Server Settings → `proxy`; Providers → key schemes).
- **Wire-compat role rewrite (`compat.roles`)** — an upstream that rejects the `developer` role? Covered by [CONFIGURATION.md](CONFIGURATION.md) (Server Settings → `compat`) — including the learn-on-failure auto-fix that needs no configuration at all.

## How sessions work

The proxy keys compression state on **the conversation value the client itself provides, verbatim** (`src/session-id.ts`) — no hashing, no protocol/upstream/API-key dimensions (those mutate mid-conversation and orphaned state exactly when users kept talking, #280/#286). The id stays inside the proxy (state store, persistence, UI label); it is never sent upstream.

Where the value comes from, first hit wins: the plugin's
`x-bili-plugin-conversation` (honored only alongside the `x-bili-plugin`
marker header), then per-client headers (`x-claude-code-session-id`,
`x-grok-session-id`/`x-grok-conv-id`, `x-mavis-session-id`), then generic
headers (`x-session-affinity`, `x-acp-session`, `x-session-id`,
`x-opencode-session`, `session-id`/`session_id`), then body fields:
`session_id` / `metadata.session_id` on the Responses wire, and
`prompt_cache_key` promoted over the content-fingerprint fallback on the
Responses/OpenAI/Anthropic wires.

| Client | Sends conversation id? | Source |
|---|---|---|
| **Codex** | ✅ yes | `body.session_id` / turn-metadata thread id |
| **OpenCode** | ✅ yes | `x-session-affinity` / `x-opencode-session` header (`ses_…`) |
| **Claude Code** | ✅ yes | `x-claude-code-session-id` header |
| **omp** (via plugin) | ✅ yes | `prompt_cache_key` promoted over any fingerprint (#268) |
| **pi** (bare) | ❌ no | nothing → anonymous prefix affinity below |

**Header-less clients (pi-like): anonymous prefix affinity.** With no conversation signal at all, the proxy resolves the session from the replayed history itself (`src/prefix-affinity.ts`, #309): a request reattaches to a stored session only when its history reproduces that session's message chain byte-exactly from position 0; otherwise it gets its own deterministic `pfa-…` session. Consequences (#1262): a **resumed** conversation reattaches to its own session (even after a proxy restart, #499); a **new task with an identical opener does NOT inherit** another conversation's blocks — it mints a fresh, fully separate session; a request with no usable signal at all gets an explicit 400 instead of silently colliding.

Design record and threat model: [SESSION-IDENTITY.md](SESSION-IDENTITY.md). The
message-granularity sibling (why identity is content-derived, not an
assigned id) is [MESSAGE-IDENTITY.md](MESSAGE-IDENTITY.md).

For upstream sticky-routing, the proxy forwards only identity values the
client already supplied (e.g. a body `session_id` is forwarded upstream as
`x-session-id`); it never synthesizes one itself.

**Recommendation:** explicit-id clients are safe to run concurrently. For header-less multi-agent use, prefer the client plugin (stamps a stable id per conversation) or pass an explicit `x-acp-session` header — otherwise prefix affinity still keeps distinct tasks apart (a diverged fork costs one raw resend plus a compression-ladder restart).

### Derived (child) sessions inherit the parent's compressed context (#1333, #1362)

A child session (subagent/fork starting from an empty history) reports its lineage at birth — its identity registration carries `parentConversationId` and the proxy records a read-only `derivedFrom` link — so `decompress` / `search_context` fall back along the parent chain for content the child never saw itself (cycle-guarded, depth cap 8). Nothing is copied into the child, the parent is never modified; if the parent is unknown the child simply starts fresh. Per-lane parent signals (pi/omp `parentSession` header, OpenCode V1/V2 `parentID`): [SESSION-IDENTITY.md](SESSION-IDENTITY.md#derived-child-sessions-lineage-at-birth-1333-1362). claude/codex/dsh need nothing here: they share one session id across subagents or have no child-session concept at all.

### Windows: exclude the sessions dir from antivirus (#362)

The proxy rewrites each session's state file every turn of a long session; on Windows, real-time AV (Defender), the search indexer, or a sync tool (OneDrive) can lock the sessions dir mid-write, so persists fail with `EPERM` until the lock clears. Fix at the root: add `%USERPROFILE%\.local\share\billion-context\` to your antivirus exclusions (Defender steps included) and keep sync tools off that path — [CONFIGURATION.md](CONFIGURATION.md#windows-exclude-the-sessions-dir-from-antivirus-362).

### Session file cleanup (#1082)

Short-lived sessions leave small state files behind that are never resumed. Cleanup is **opt-in** (`BILI_SESSION_GC=1`; off by default — session files are user data, no silent deletion policy): when enabled, bili sweeps the sessions dir at boot and hourly and deletes a file only when BOTH hold — older than `BILI_SESSION_GC_MAX_AGE_DAYS` (default 7 days) AND never compressed with its newest request body ≤ `BILI_SESSION_GC_MAX_TOKENS` tokens (default 1M) — so deletion loses nothing but bytes. CCR content stores follow their session file's lifecycle; compressed sessions are never deleted; every deletion is audit-logged. Full policy: [CONFIGURATION.md](CONFIGURATION.md#environment-variables).

## Status

Early. Protocol handling and compression work against mock tests (500+ passing). Real-model integration testing is the next milestone. Expect rough edges.

Client-side plugins for pi / omp / opencode ship inside `billion-context` (`dist/agent/*.js`) for the cooperative-proxy path. See the **"Which do I need?"** section above for how `billion-context`, the standalone `billion-context-pi`, and `opencode-acp` relate.

## Attribution requirement (one term on top of MIT)

This project is MIT-licensed **plus one additional term**: any product or service (commercial or open source) whose users can see or interact with it and which uses this software must attribute it — stating that it uses billion-context with a link back to this repository — on its home page, documentation, or About/Credits page. Pure server-side/embedded use satisfies this via shipped documentation. See the **Additional Term** at the end of [LICENSE](LICENSE).

If you build on this project, we'd love to hear about it: open an issue (no obligation) so we can track where it's used.

## License

MIT
