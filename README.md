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

The proxy injects four context-management tools (`compress`, `decompress`, `search_context`, `acp_status`) into the conversation. The model calls `compress` when the conversation grows, and the proxy executes it server-side — the compressed ranges are folded into the conversation history before the next turn.

An opt-in fifth tool, `absorb` (`compress.absorb.enabled: true` — see [CONFIGURATION.md](CONFIGURATION.md)), compresses **individual tool results the moment they arrive**: large results (builds, logs, greps) get a forced absorb instruction, the model distills each into a compact summary, and the original pair is hidden from the wire from the next turn on — keeping mid-session pressure lower between fold rounds (#605).

An opt-in sixth tool, `acp_rule` (`compress.rules: true` — see [CONFIGURATION.md](CONFIGURATION.md)), records **persistent principle-level reminders**: a short rule recorded by the model (user-emphasized lessons, behaviors to remember, major pitfalls hit) is hard-protected from compression — the call and its result stay in context across every fold — and omitting the argument lists the recorded rules; passing `delete` with a rule id (e.g. `"rule3"`) removes one rule and `clear: true` removes all of them ([ranxianglei/billion-context-pi#433](https://github.com/ranxianglei/billion-context-pi/issues/433)).

The seventh tool, `acp_retrieve` (opt-in on every lane — set `compress.ccr.enabled: true` at any level, after local verification; plugin lanes require the explicit global `true` so the manifest advertises the tool, #1271/#1273 — see [CONFIGURATION.md](CONFIGURATION.md)), backs the **content-addressed message store** (built-in CCR, #1097/#1179): oversized tool results are **ID-referenced at arrival instead of force-distilled** — the wire keeps a byte-stable placeholder and the original goes into a per-session content-store envelope (hash-deduped), retrievable on demand via one cheap tool call. V2 makes folds lossless too: covered originals are stored when a fold lands, `decompress` restores ranges (`startId`/`endId` refs) instead of whole blocks, and `search_context` hits carry the covered `mNNNNN` refs so you can fetch exactly what you need. Lossless by default: a retrieve not made costs nothing but the call; a detail distilled away by absorb is gone for good. Scope: proxy mode, plus plugin lanes on the anthropic + openai wires when explicitly enabled (`acp_retrieve` is advertised in the plugin manifest then, #1271); responses marker/text routes and google in plugin mode stay disarmed because no request-only round-trip channel exists there (silent loss, #1097).

An opt-in tool, `image_full` (`compress.imageCompression.enabled: true` — see [CONFIGURATION.md](CONFIGURATION.md)), backs **image pre-compression** (#1095): screenshot-like images in tool results are downscaled once at arrival — the kernel decides routing and recipe, the host encodes via optional `sharp` — cutting billed pixels before they enter the wire (providers bill by pixel area; halving dimensions cuts billed tokens ~4×). Non-screenshot images pass through byte-identical. Lossy by nature: when the model can't read details it calls `image_full` with the message's ref to restore the original resolution for the rest of the session — no proxy-side storage needed, since the client's own history still carries the original bytes (it never saw the shrunk form). Default off.

A sibling protection knob, `compress.protectedLatestTools` (see [CONFIGURATION.md](CONFIGURATION.md)), keeps the **latest** snapshot of a cumulative tool (a client's todo/task list, e.g. `["todo_list", "TodoWrite"]`) un-compressible while older instances fold normally — so the agent never loses its live task list to a fold (#639). Its full-history counterpart `compress.protectedTools` hard-excludes **every** instance of a tool — for independent-content results no later result supersedes (e.g. opencode/pi `skill` loads); protecting all instances of a chatty or cumulative-snapshot tool grows context without bound (#639), so keep it to low-frequency, high-value tools. The inverse-direction knob `compress.neverPreserveRecentTools` (see [CONFIGURATION.md](CONFIGURATION.md), `acp-kernel` >= 0.0.92) removes tools from the soft-protected recent zone so their results fold immediately — by default only `decompress`/`search_context`/`read`/`bash` are exempt from recency; removing just `read` from that list is the recommended remedy for the batch-read fold→re-read death loop (#1198/#1277). Its positive-facing mirror `compress.preserveRecentTools` (see [CONFIGURATION.md](CONFIGURATION.md), `acp-kernel` >= 0.0.93) is the preferred one-entry form of that remedy — `{ "compress": { "preserveRecentTools": ["read"] } }` subtracts `read` from the effective exclusion list without restating or freezing the built-in default.

### Two compression modes — who executes `compress`

The proxy runs in one of two modes, and **the mode decides who executes
`compress`, which in turn decides how the summary travels to the model** (the
"carrier"). This distinction is the root of #377.

| | **Launcher / plugin mode** (`bili pi`, `bili codex`, …) | **Proxy mode** (plain client → `/bili/`) |
|---|---|---|
| Client | ACP-native agent with the bili extension (pi/omp) | Any OpenAI/Anthropic client, no extension |
| Who executes `compress` | **The agent** (pi runs it locally) | **The proxy** (server-side compress loop) |
| `compress` tool call in the re-sent history? | Yes — part of the agent's own conversation | No — ephemeral proxy-loop traffic |
| Preflight blocks (no tool call)? | Last-resort backstop — the agent normally compresses on its own `compress` calls, but `src/preflight.ts` still fires (in both modes) when the input alone exceeds the window (#470) | Yes — `src/preflight.ts` compresses behind the client's back |
| **Summary carrier on the wire** | **the `compress` tool call** | **an `acp_summary` user message** |
| System messages on the wire | always exactly 1 (client + prompt) | always exactly 1 (client + prompt) — summaries ride on user messages |
| SGLang "single system" 400 (#377) | cannot happen | cannot happen (summaries are user messages, not system) |
| Proxy-injected `compress` tools | none — the agent registers the 4 ACP tools natively | the 4 context tools (when enabled) |
| Proxy-injected nudge | **yes** — the agent has no nudge channel of its own, so the proxy-side nudge is the proactive compression trigger (preflight alone only fires at the hard limit; #451) | yes (when enabled) |

**Why the carriers differ.** In plugin mode the agent owns compression: the
`compress` call + result live in the agent's own history and are re-sent every
turn, so the summary rides on the tool call and the agent's view never renders
the kernel's `acp_summary` fallback (`billion-context-pi` `src/messages.ts`
skips `acp_summary_*`). In proxy mode the client is not ACP-native, so the
proxy executes `compress` server-side; the tool call never enters the client's
history, and preflight blocks have no tool call at all — so the kernel's
`acp_summary` message is the only carrier. The kernel renders it as role
`system`, but strict OpenAI-compatible backends (SGLang) require exactly one
system message at index 0, so `systemToUser` (`src/util.ts`) re-voices it as a
`user` message, leaving it at its anchor position. This keeps the head system
message (the prefix-cache anchor) byte-stable across compress turns, so a new
block does not invalidate the whole-conversation prefix.

**Why `user`, not `system` or a forged tool call.** A mid-stream `system`
message is what SGLang rejects (#377). A forged `compress` tool call would be
the "pure" carrier, but in proxy mode it requires fabricating an
assistant `tool_calls` + `user` `tool_result` pair by id, declaring the tool in
the request, and handling preflight blocks that have no authentic call — far
more invasive than re-voicing a standalone note. A `user` message is allowed
anywhere in the conversation, so it is the minimal change that satisfies both
SGLang's one-system rule and prefix-cache stability. The accepted trade-off:
a summary is a stand-in for the folded history, and re-voicing it as a user
turn is a semantic mismatch the model tolerates (it is clearly marked
`[Compressed conversation section]`).

**Do the two modes coexist?**

- **Same proxy instance: yes, by design.** One proxy serves plugin and plain
  clients at once; `pluginMode` is decided per request (`x-bili-plugin` header)
  and bound per session (`session.metadata.pluginAgent`). The launcher reuses a
  running proxy.
- **Same session: the mode is sticky.** A session created in plugin mode stays
  plugin mode (metadata inheritance); a plain session can only be *upgraded* to
  plugin mode if a plugin request arrives with a matching conversation id (the
  header outranks) — and never downgraded. In practice a plain→plugin upgrade
  requires the plugin client's conversation id to match an existing plain
  session id, which doesn't happen (each client generates its own id).
- **Cross-mode block hazard: theoretical only.** It would require the same
  conversation id to span a mode switch. plugin→proxy is safe (the tool call is
  in the shared history); proxy→plugin could orphan proxy-created block
  summaries (their tool call isn't in the agent's history and the agent's view
  skips `acp_summary`) — but that needs the id match above, which doesn't occur.

**Verifying that a compression actually landed.** After executing `compress`,
the proxy emits a confirmation marker (`📦 [ACP] Compressed …`) as plain
assistant text — but under sustained context pressure a model was observed
*writing that marker format itself* without ever calling the tool (#717): 17
fake "compressions" over ~2 hours while real usage climbed to 89%. A marker
line visible in the transcript is therefore not proof of persistence — verify
with `acp_status` (block count increased, compressible-range start advanced)
before trusting it. As a backstop, the proxy strips any marker-shaped line the
model emits on its own and logs a `[marker-echo]` warning, and both the nudge
and the injected prompt state explicitly that markers are proxy-emitted only.


## Which do I need?

Pick by your client:

| Client | Use |
|---|---|
| **pi** | [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) (in-process extension) |
| **opencode** (1.x / 2.x) | [`billion-context`](https://github.com/ranxianglei/billion-context) — `bili opencode` (launcher) or `bili plugin install opencode` (native, no launcher); standalone [`opencode-acp`](https://github.com/ranxianglei/opencode-acp) remains usable on 1.x. Full guide: [OpenCode](#opencode) |
| **omp** | [`billion-context`](https://github.com/ranxianglei/billion-context) via `bili omp` (built-in plugin) or `bili plugin install omp` (self-spawning native plugin, no launcher) |
| **dsh** | `bili dsh` (launcher — full native plugin via `--patch`: tools, session-bound `/acp` + `/acp-cache`, fetch intercept) or `bili plugin install dsh` ≡ `dsh plugin --profile <name> add billion-context` (one unified lane — pnpm-installs the package into each profile so dsh mounts the bundled patch layer; the bili form just drives dsh's own channel per profile and migrates legacy managed blocks) |
| **kimi** | `bili plugin install kimi` (self-spawning native plugin, no launcher — Kimi Code ≥ 2.0.0; per-session routing block in `~/.kimi-code/config.toml`) or `bili kimi` (launcher, cert-MITM) or `/bili/` prefix |
| **hermes** | `bili plugin install hermes` (self-spawning native plugin, no launcher — Python plugin, #958) or `bili hermes` (launcher, cert-MITM) |
| **zcode** (Z.ai / bigmodel coding plan) | `bili plugin install zcode` (self-spawning native plugin, no launcher — per-session routing block in the bigmodel provider store, #1145) or cert-MITM through the GUI's Settings → Network (HTTP proxy + CA path) or `/bili/` prefix |
| **claude** | `bili claude` (launcher) or `bili plugin install claude` (native posture, #964 — managed settings block + session-owned proxy; see the notes below) |
| **jcode** | [`billion-context`](https://github.com/ranxianglei/billion-context) via `bili jcode` (launcher, cert-MITM) or `/bili/` prefix — no native plugin possible: compiled Rust binary with no plugin seam, and its static per-provider config can't stamp per-request headers ([#962](https://github.com/ranxianglei/billion-context/issues/962)) |
| **gemini** (Gemini CLI) | `bili gemini` (launcher, `GOOGLE_GEMINI_BASE_URL` `/bili/` rewrite) or `/bili/` prefix — launcher-only: gemini-cli's extension system reaches custom commands only, no in-loop tool seam (#1043) |
| **iflow** (iFlow CLI) | `bili iflow` (launcher, `IFLOW_BASE_URL` `/bili/` rewrite) or `/bili/` prefix |
| **qwen** (Qwen Code) | `bili qwen` (launcher, cert-MITM) or `/bili/` prefix |
| **mcode** (MiniMax Code) | [`billion-context`](https://github.com/ranxianglei/billion-context) via `bili mcode` (launcher, cert-MITM) or `/bili/` prefix — no native plugin possible: its plugin system is declarative event hooks only (no model-request/history seam), so compression rides the proxy ([#1050](https://github.com/ranxianglei/billion-context/issues/1050)) |
| **aider** | [`billion-context`](https://github.com/ranxianglei/billion-context) via `bili aider` (launcher, cert-MITM) or `/bili/` prefix — no native plugin possible: Python script structure whose hook surface is shell commands around edits/notifications only, no tool-injection seam ([#1048](https://github.com/ranxianglei/billion-context/issues/1048)) |
| **copilot** (GitHub Copilot CLI) | `bili copilot` (launcher, cert-MITM) — closed Go binary, no plugin seam; model hosts (`api.githubcopilot.com` + per-plan subdomains) whitelisted (#1049) |
| **amp** (Amp CLI) | `bili amp` (launcher, cert-MITM) — closed Go binary, no plugin seam; `ampcode.com` whitelisted (#1049) |
| **goose** (Goose CLI) | `bili goose` (launcher) — rustls release builds trust no CA file, so no cert-MITM: built-in openai/anthropic legs redirected via `OPENAI_HOST`/`ANTHROPIC_HOST`, custom providers via a regenerated `GOOSE_PATH_ROOT` overlay (`base_url` → `/bili/`, real config untouched); fixed third-party providers unsupported (#1049) |
| **everything else** (no context hook) | [`billion-context`](https://github.com/ranxianglei/billion-context) — `bili <client>` (launcher, preferred) or `/bili/` prefix |

**Native mode vs standalone extensions.** The host-native plugins (`bili plugin install pi` / `opencode` — they spawn the proxy inside the host process) and the standalone in-process extensions (`billion-context-pi`, `opencode-acp`) are **mutually exclusive**: both active means double compression. The installer makes the switch: `bili plugin install pi` replaces the legacy `npm:billion-context-pi` entry (with a reminder that a project-scope entry in `<project>/.pi/settings.json` from `pi install -l` lives outside the global settings), and `bili plugin install opencode` strips legacy `opencode-acp` entries from the global opencode.json — bare name, `npm:` alias, versioned (`opencode-acp@stable`), or path form, array or object shape; the original config is snapshotted to `.bili-bak` once. A **project-local** install (`opencode plugin opencode-acp` writes `<project>/.opencode/opencode.json`, not the global config) is not touched — remove it by hand; the installer note reminds you. As a runtime safety net for manual installs, the native entries set `BILLION_CONTEXT_NATIVE=<host>` synchronously at load so a standalone extension can stand down at action time — its own load-time `BILLION_CONTEXT_PROXY` check cannot see a proxy that native mode spawns asynchronously, and its `/bili/` baseUrl check never sees the fetch-layer rewrite. On the pi side the marker needs `billion-context-pi` **0.1.72+** (the per-event re-check landed after 0.1.71); the pi-native entry additionally scans both pi settings files once its proxy is up and warns loudly when it spots a co-resident legacy entry the installer never saw — that warning is the only visible signal while an old `billion-context-pi` silently double-compresses.


## Install

```bash
npm install -g billion-context
```

This installs the `bili` command (`bili-proxy` is kept as an alias).

## Quickstart

Three ways to use it — pick one:

- **Native plugin (no launcher):** `bili plugin install <client>` — bili
  becomes a plugin inside the client; start the client as usual.
- **Launcher (easiest):** one `bili <client>` command brings up the proxy and
  the client together — no real config file is ever touched.
- **URL change (persistent):** prefix your client's baseURL with the proxy
  origin + `/bili/`.

Mechanism details behind these three options (plugin lifecycle, runtime-info
protocol, injection priority) live in [TECHNICAL-NOTES.md](TECHNICAL-NOTES.md).

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
bili plugin update [client]     # bring every lane's bili presence up to date, each through its own owner (see below)
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

#### Single-writer: who owns which copy (#991)

Every bili presence on a machine has exactly **one writer** — the thing
that installed it is the thing that updates it, and nothing else ever
overwrites that copy in place:

| Lane | Copy lives in | Updated by |
|------|---------------|------------|
| global `bili` | npm global (`npm i -g billion-context`) | `bili update` / background auto-update |
| **pi** | pi's package manager (npm form) | **`pi update`** — bili never overwrites it |
| **opencode** | opencode's plugin dir | **opencode's plugin manager** — bili never overwrites it |
| **dsh** | each profile's pnpm store | a periodic check re-runs dsh's plugin channel per profile — driven by the global bili self-update **or by the profile copy's own proxy** when the global isn't running (dsh-market installs, #1196); manual: `dsh plugin add billion-context@latest`. pnpm's hardlinked store must never be copied over in place |
| omp / claude / codex / kimi / zcode | no copy — entries point at the global bili install | they update together with the global copy |
| **hermes** | `~/.hermes/plugins/billion-context/` (copied files + `bili.json` sidecar pointing at the global dist) | **`bili plugin update hermes`** re-copies the files; the sidecar tracks the global install |

This is enforced in code, not just convention: the self-updater
(`src/update.ts` → `hostManagedInstall`) detects install dirs under a pnpm
virtual store (`.pnpm`) or a host agent tree (pi / opencode / dsh / kimi /
omp homes) and **skips** them; `installViaTarball` refuses them structurally
so direct callers cannot corrupt a store either. Mixing *commands* is fine
(`dsh plugin add` ≡ `bili plugin install dsh` — same channel, same records);
mixing *writers* is what the guard forbids. `bili plugin update [client]`
is the one command that drives every lane through its own owner and prints
the per-lane update path (`bili plugin list` shows the same per-lane channel).

At load the plugin **spawns its own proxy** (attaches to a healthy running
one only when it passes the attach gate below; a parent-pid watchdog tears
it down when the client exits),
rewrites model traffic to `<proxy>/bili/<upstream-url>`, registers
`compress` / `decompress` / `acp_status` as native client tools (plugin
mode), and reports the client's **own model config** to the proxy so
compression budgets use the real window instead of a registry guess.
Opt-out envs: `BILI_NATIVE_PI=0`, `BILI_NATIVE_OMP=0`,
`BILI_NATIVE_OPENCODE=0`, `BILI_NATIVE_DSH=0`, `BILI_NATIVE_KIMI=0`,
`BILI_NATIVE_HERMES=0`, `BILI_NATIVE_ZCODE=0`. Full
mechanics: [TECHNICAL-NOTES.md](TECHNICAL-NOTES.md).

Reuse is identity-based (#1225) **and lifecycle-gated (#1335)**: an existing
proxy is attached only when it runs the **same code** (sha256 of the entry
script, recorded in the instance file), its **lane is compatible** — each
launcher declares its client's lane, two *different declared* lanes never
share — **and it owns a session lifecycle**: its health endpoint reports an
armed parent-pid watchdog (`watchdog.armed == true`), i.e. it was spawned by
a launcher with a parent pid and dies when the last attached session dies.
An instance without a declared lane is wildcard-compatible on the lane axis,
but that alone no longer makes it attachable (see the gate below).
Instances written before #1225 carry no code fingerprint and are therefore
never attached: a rebuilt or updated install always starts a fresh proxy on
the next launch, so fixes take effect immediately instead of silently
serving stale code.

**The attach gate (#1335).** A native hook attaches to whatever answers on
the port, so the three listener kinds get different treatment (TS lanes and
the hermes Python plugin's discovery path alike, #1338):

| Listener | Lifecycle owner | Attach? |
|---|---|---|
| Its own session-spawned proxy | armed from birth | ✅ yes |
| Another session's armed proxy (shared, watcher set #1186) | watcher set | ✅ yes — sharing stays the design |
| Manually started `bili start` daemon | **none** — refuses watchers, never dies with sessions, often an older build | ❌ not by default |

The hook probes the candidate's `/__bili/health` for `watchdog.armed` before
attaching. Armed → attach + register a watcher (current behavior, README
lifecycle contract holds). Unarmed — or a pre-#1330 build that reports no
`watchdog` field at all (unverifiable, treated as unarmed) → **do not
attach**; the hook spawns its own session-owned proxy (ephemeral port, armed
from birth, dies with the last session). This also fixes version skew: every
session now runs the **currently installed** bili instead of whatever a
stale resident daemon happens to carry. The trade-off is one extra short-lived
proxy process per session when no armed proxy exists (session state is shared
on disk, so compression continuity is unaffected); the multi-instance warning
(#394) becomes correspondingly more common. **Escape hatch:** deliberately
run a resident daemon for your hooks to ride on → set
`native.attachExternal: true` in the config file or
`BILI_NATIVE_ATTACH_EXTERNAL=1`. That restores attaching to any compatible
listener regardless of watchdog state — you then own the daemon's lifetime
and version yourself. Explicit user-directed attaches (`BILLION_CONTEXT_ATTACH`
/ preset `BILLION_CONTEXT_PROXY` for kimi/dsh) bypass discovery entirely and
are exempt by construction.

Attach discovery is lane-aware across **all** live instances (#1232): the
launcher probes every live entry in the instance registry, not just the
single instance file (last-writer-wins — under concurrent multi-client use
it can point at another client's proxy), and applies the gate above to every
candidate. Among compatible candidates the newest instance with the launcher's
own declared lane wins; an instance without a lane is wildcard-compatible on
the lane axis (still subject to the gate). The `another bili instance is
running` warning (#394) is lane-aware too: it fires for same-lane or lane-less
coexistence, but stays silent between two *different* declared lanes, whose
session files are disjoint.

**Runtime-info protocol (#955).** A native plugin reads the model config
the client itself will use and pushes it to the proxy (per-request headers
+ bootstrap report); the proxy prefers that truth over the models.dev
registry / built-in table when resolving the context window. Protocol
details, resolution order, and implementations:
[TECHNICAL-NOTES.md](TECHNICAL-NOTES.md).

Notes:

- Native mode is **mutually exclusive** with the standalone in-process
  extensions (`billion-context-pi`, `opencode-acp`) — the installer swaps
  the entries and snapshots the original config (`.bili-bak`); migration
  details in the client table above (pi needs `billion-context-pi` 0.1.72+
  to stand down cleanly).
- OpenCode: legacy `opencode-acp` sessions, the V1/V2 plugin shapes, and all caveats are consolidated in the [OpenCode](#opencode) section.
- `kimi` reports runtime-info at bootstrap only (static `custom_headers` can't
  carry per-request window/model headers without going stale on model switch)
  and binds subagent conversations by per-call `conversation_id` — full
  mechanics in the "Kimi Code" section below.
- `hermes`'s native plugin is Python (its CLI agent's plugin API is
  Python-only) — instead of patching fetch it points hermes' httpx stack at
  the proxy via env vars after a health check, and stamps per-request headers
  through an `llm_request` middleware; full mechanics in the "Hermes" section
  below.
- `codex` has a companion install too (an MCP shell), but it needs a running
  proxy — it is not native mode.
- `claude` also has a **native posture** (#964): `bili plugin install
  claude` writes a managed settings block (static `/bili/` URL +
  `SessionStart` hook) plus an MCP shell pinned to a stable port — the
  proxy lives and dies with the session. Opt out with
   `BILI_NATIVE_CLAUDE=0` (passthrough). Mechanics:
   [TECHNICAL-NOTES.md](TECHNICAL-NOTES.md).
- `zcode` also has a **native posture** (#1145): `bili plugin install
  zcode` writes `~/.zcode/cli/config.json` (`hooks.enabled` +
  `SessionStart` hook + stdio MCP server) and rewrites the bigmodel
  coding-plan provider's `baseURL` to `<proxy>/bili/<upstream>` per
  session (both store generations: legacy `v2/config.json` and v3.14+
  `provider_config.json`) — full mechanics in the "ZCode" section below.
- `jcode` has no native mode at all: it is a compiled Rust binary with no
  plugin or extension seam, its only per-provider request surface is a static
  TOML header table applied verbatim to every request, and its MCP servers
  run in a global pool shared across all sessions — so there is neither a
  way to rewrite model traffic in-process nor one to stamp the per-request
   headers plugin mode requires (`x-bili-plugin`, conversation id,
   runtime-info). Full source-level analysis: [#962](https://github.com/ranxianglei/billion-context/issues/962)
   (closed wontfix). Use `bili jcode`.
- `aider` has no native mode either: it is a Python script structure whose
  hook surface is limited to shell commands around file edits and idle
  notifications (`--git-commit-verify`, `--notifications-command`) — there is
  no plugin or extension API and no MCP client, so there is no
  tool-injection seam for plugin mode. Use `bili aider`
  ([#1048](https://github.com/ranxianglei/billion-context/issues/1048)).
- `copilot`, `amp` and `goose` are launcher-only (#1049): none exposes a tool-injection seam, so there is no native mode (a codex-style MCP-shell companion remains possible for amp/goose but is not shipped). Goose additionally cannot be cert-MITMed — its release builds run rustls/webpki and trust no CA file — so it rides plain-HTTP base-URL redirects instead of proxy envs.

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
bili opencode                         # OpenCode (1.x & 2.x): full guide in the [OpenCode](#opencode) section below
bili hermes                           # file-free (#535): hermes proxy env (HTTPS_PROXY + combined CA bundle via SSL_CERT_FILE) — https via CONNECT MITM, http via absolute-form forward proxy; real ~/.hermes untouched
bili dsh                              # deepseek-harness: full native plugin injected via --patch (#941) — compress/decompress/acp_status registered as real dsh tools, requests stamped with the dsh session id (plugin mode), /acp + /acp-cache session-bound; non-loopback upstreams ride proxy envs (https MITM, http absolute-form), loopback keeps the overlay DSH_HOME (~/.dsh-bili) rewrite (#535), built-in deepseek route via DEEPSEEK_BASE_URL; dsh native auto-compaction disabled (compaction-basic auto:false)
bili codebuddy                        # Tencent CodeBuddy Code CLI: CODEBUDDY_BASE_URL /bili/ rewrite (OpenAI chat completions wire), budget aligned via CODEBUDDY_AUTO_COMPACT_WINDOW; real ~/.codebuddy untouched
bili qoder                            # qoder: model endpoint is hardcoded https (no /bili/ rewrite possible) — cert-MITM via HTTPS_PROXY + NODE_EXTRA_CA_CERTS, default model hosts whitelisted (#653)
bili trae                             # Trae CLI (ByteDance, closed Go binary, no base-URL override) — cert-MITM via HTTPS_PROXY + SSL_CERT_FILE, model host from TRAE_CLI_API_HOST or the default enterprise gateway (#655)
bili jcode                            # jcode (Rust agent harness) — env-only cert-MITM launch: HTTPS_PROXY + SSL_CERT_FILE, model host api.z.ai whitelisted, local loopback providers stay direct via NO_PROXY
bili kimi                             # Kimi Code CLI (Moonshot): honors standard proxy envs for all traffic EXCEPT an unconditional loopback bypass — non-loopback https via cert-MITM (HTTPS_PROXY + NODE_EXTRA_CA_CERTS/SSL_CERT_FILE), non-loopback http via absolute-form forward proxy; provider/model hosts from ~/.kimi-code/config.toml (KIMI_CODE_HOME respected) or the managed OAuth endpoints when none declared; loopback endpoints inventoried with a manual /bili/ prefix hint (#757)
bili gemini                           # Gemini CLI (Google): GOOGLE_GEMINI_BASE_URL /bili/ rewrite to generativelanguage.googleapis.com (Google native wire), real ~/.gemini untouched
bili iflow                            # iFlow CLI: IFLOW_BASE_URL /bili/ rewrite to apis.iflow.cn/v1 (OpenAI chat-completions wire), real ~/.iflow untouched
bili qwen                             # Qwen Code (multi-protocol gemini-cli fork, no base-URL hook): cert-MITM via HTTPS_PROXY + NODE_EXTRA_CA_CERTS, default DashScope/Qwen model hosts whitelisted, custom relays via --mitm-domain
bili mcode                            # MiniMax Code CLI: honors standard proxy envs for all traffic EXCEPT an unconditional loopback bypass — non-loopback https via cert-MITM (HTTPS_PROXY + NODE_EXTRA_CA_CERTS/SSL_CERT_FILE), non-loopback http via absolute-form forward proxy; provider hosts from ~/.minimax*/config.yaml (MINIMAX_DATA_DIR/MAVIS_DATA_DIR respected) or the official agent.minimax.* endpoints when none declared; loopback endpoints inventoried with a manual /bili/ prefix hint; session bound via the X-Mavis-Session-Id header (#1050)
bili aider                            # Aider (Python pair programmer): cert-MITM via HTTPS_PROXY + SSL_CERT_FILE/REQUESTS_CA_BUNDLE; endpoint from OPENAI_API_BASE / ANTHROPIC_BASE_URL etc., --openai-api-base, or .aider.conf.yml — api.openai.com + api.anthropic.com assumed by default; loopback endpoints stay direct via NO_PROXY (#1048)
bili copilot                          # Copilot CLI (GitHub, closed Go binary) — cert-MITM via HTTPS_PROXY + SSL_CERT_FILE, api.githubcopilot.com + per-plan subdomains whitelisted (#1049)
bili amp                              # Amp CLI (Sourcegraph, closed Go binary) — cert-MITM via HTTPS_PROXY + SSL_CERT_FILE, ampcode.com whitelisted (#1049)
bili goose                            # Goose (Block, Rust/reqwest): rustls release builds trust no CA file — no proxy envs at all; built-in openai/anthropic legs redirected via OPENAI_HOST/ANTHROPIC_HOST, custom declarative providers via a regenerated GOOSE_PATH_ROOT overlay with base_url /bili/ rewrites (real config untouched, user edits merged back); fixed third-party providers get a warning (#1049)
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

That's it — put your real API key in the client config as usual (the proxy
passes it through untouched). Context windows (gpt-5.1-codex=400K,
glm-5.2=1M, claude-opus-4=200K, …) are looked up from models.dev
automatically.

For per-client configuration examples (OpenCode, Codex, Pi, login-client
MITM, …) see the web UI guide at [http://localhost:8787](http://localhost:8787).

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

### dsh (deepseek-harness)

Two lanes, same plugin (#941):

- **Launcher:** `bili dsh` injects the full native plugin through a
  `--patch` overlay (`~/.dsh-bili/.bili-acp.patch.yml`) — every profile
  boots with the bili tools registered natively, model requests carry
  `x-bili-plugin` + the dsh session id (plugin mode), and `/acp` is
  session-bound. dsh's native auto-compaction is disabled in the same patch
  (`compaction-basic` → `auto: false`); manual `/compact` stays available.
- **Profile install (no launcher) — one lane (#966):** `bili plugin install
  dsh` runs `dsh plugin --profile <name> add billion-context` for every
  existing profile — pnpm installs the package into each profile's own
  `node_modules`, and dsh mounts the bundled patch layer
  (`dsh.bundle.patch.yml`) automatically. The spec follows how bili itself
  was installed (#925): an npm-form install passes the registry name, a
  checkout/dev build passes its absolute path (a `link:` dependency, so
  local work stays live). Legacy managed blocks (`# bili begin` /
  `# bili end`, written by pre-#966 installs) are stripped on install and
  remove — user entries and comments survive, an emptied file gets its
  placeholder `[]` back. Run dsh once in each profile first so the profile
  dirs exist. The plugin spawns its own proxy at load (attaches to a healthy
  one instead of doubling; parent-pid watchdog), rewrites model-API traffic
  to `<proxy>/bili/<upstream-url>` via a global fetch patch, registers the
  manifest tools verbatim, and gates plugin-mode headers on tool readiness
  (round 1 rides wire mode). Opt-out: `BILI_NATIVE_DSH=0`. Remove with
  `bili plugin remove dsh` or `dsh plugin --profile <name> remove
  billion-context` — both go through the same channel. Registry installs
  require a published release that carries `dsh.bundle.patch.yml`. If dsh
  fails to boot right after an add with `ERR_MODULE_NOT_FOUND` on
  `billion-context/dsh`, the profile resolved a pre-bundle copy from a stale
  package-metadata cache (#953) — re-add pinned: `dsh plugin --profile
  <name> add billion-context@latest`.
- **Auto-update keeps profiles in lockstep:** the refresh has two triggers —
  after a global self-update, AND from the **profile copy's own proxy** when
  its periodic check sees a newer registry version (so dsh plugin-market
  users with no global bili running still refresh, #1196). Both scan
  `~/.dsh/profiles/*/package.json` and bring any registry-pinned
  `billion-context` dependency to the target version (the new global version
  for the global trigger, registry-latest for the self trigger), always
  through dsh's own `plugin add` channel — never an in-place copy — so the
  loaded plugin and the proxy never drift apart again (#953); profiles
  pinned to a local source are left alone. The refresh is best-effort,
  retries next cycle on failure, and never fails the update or the proxy.
 - **Reported: zero proxy traffic for some transports under profile install
   (#1158, under investigation):** sessions served by some of dsh's
   `llm-pi-ai`-layer transports show NO model request ever reaching the proxy
   (no `processTurn` logged; bili tools 404 with "no model request has
   arrived") while other providers in the same host work normally. The root
   cause is still being pinned down with runtime evidence — candidates: the
   transport-level fetch shape (SDK-injected fetch / non-global dispatcher) or
   a host-side attribution gap leaving the traffic unclaimed by the takeover
   gate. Detection: the proxy logs a one-time `[plugin] NO MODEL REQUESTS seen
   for conversation …` warning, and the dsh plugin logs each distinct endpoint
   the attribution gate lets through unproxied (once per process). Reliable
   workaround meanwhile: launch through `bili dsh` instead — the launcher's
   settings overlay rewrites those providers' `baseURL`s to `/bili/` URLs, so
   the traffic reaches the proxy regardless of which fetch the transport uses
   or what the attribution state is.

Under a `bili dsh` launch the plugin ATTACHES to the launcher's proxy (no
second spawn). Raw upstream URLs rewrite to `<proxy>/bili/<url>` like
spawn mode (a loopback proxy target is never proxied, so the MITM envs are
simply bypassed); already-routed `/bili/`-prefixed requests pass through
untouched except for header stamping. Known limitation: manual
`/compact` has no dsh-side event hook, so its boundary is left to the
kernel's natural ingest diff (auto-compaction is off, so this is rare).

### Kimi Code (Moonshot)

Three aligned modes: `bili kimi` (launcher, cert-MITM — Option 2), `/bili/`
URL prefix, and native plugin mode (`bili plugin install kimi`, #963). Kimi
Code v2's plugin system is declarative only (`kimi.plugin.json`: MCP servers,
hooks, skills — no in-process JS execution), so bili cannot patch the client's
fetch stack like it does for pi/opencode/dsh. Instead the plugin ships two
small node scripts that do the work around the client:

- **Install:** `bili plugin install kimi` writes
  `$KIMI_CODE_HOME/plugins/managed/billion-context/kimi.plugin.json`
  declaring a stdio MCP server (`node <root>/dist/kimi/native-mcp.js`) plus a
  `SessionStart` hook (`node <root>/dist/kimi/bootstrap-hook.js`, 30 s
  timeout), and registers the plugin in
  `$KIMI_CODE_HOME/plugins/installed.json`. The installer requires
  `kimi --version` ≥ 2.0.0 and refuses below that (the launcher still works
  either way). Remove with `bili plugin remove kimi` (managed dir + registry
  record + config restore).
- **Per-session bootstrap:** kimi spawns the MCP server as a direct child for
  each session; at startup it attaches to a healthy proxy
  (`BILLION_CONTEXT_PROXY`) or spawns its own on an ephemeral port, then
  rewrites the client's routing with an idempotent, line-surgical managed
  block in `~/.kimi-code/config.toml`: an own provider `[providers.bili]`
  (`base_url = http://127.0.0.1:<port>/bili/<upstream>`, cloning the active
  provider's `oauth` / `api_key` reference verbatim), a `[models.bili-kimi]`
  alias, and a top-level `default_model` redirect with the previous value
  recorded inside the block. The original file is snapshotted to
  `config.toml.bili-bak` once; every write happens under a mkdir lockfile and
  user content outside the block is never touched. Kimi's config hot-reload
  applies the change to live sessions. The `SessionStart` hook runs the same
  bootstrap opportunistically (attach-only — it never spawns); its
  non-blocking race is tolerated by design: round 1 may ride direct/wire mode,
  and the invariant is never pointing `base_url` at a dead port.
- **Plugin-mode stamping:** the block gains
  `custom_headers = { x-bili-plugin = "kimi" }` ONLY after the ACP tool list
  has been verified against the live proxy manifest — until then traffic rides
  wire mode. Because `custom_headers` are static per provider they cannot
  carry per-request window/model headers without going stale on model switch;
  the runtime-info report therefore happens at bootstrap only (model + context
  window + max output from the client's own config whenever present).
- **Watchdog & lifecycle:** the MCP child probes the proxy every 30 s. In
  attach mode it waits forever (it never touches a user-owned proxy); in spawn
  mode a dead proxy is respawned and the routing rewritten to the new origin.
  If recovery fails, the managed block is removed so traffic degrades back to
  direct upstream rather than hitting a dead port. When a session ends, kimi
  kills the MCP child and the parent-pid watchdog tears down the spawned
  proxy. Multiple concurrent TUIs share the first-spawned proxy; when it goes
  away the remaining sessions respawn and re-route automatically.
- **Known limitations:** subagent conversations get their own derived proxy
  sessions (kimi exposes no stable session id; tool calls bind via the
  per-call `conversation_id` argument), and kimi's native auto-compaction is
  NOT pushed out — ACP compression simply fires first, as in launcher mode.
   Opt-out: `BILI_NATIVE_KIMI=0`.

### Hermes (Nous Research)

Three aligned modes: `bili hermes` (launcher, cert-MITM — Option 2), `/bili/`
URL prefix, and native plugin mode (`bili plugin install hermes`, #958). The
hermes CLI agent's plugin API is Python-only (the `desktop/plugin.js` SDK
belongs to the separate Desktop app), so the native plugin is a small
pure-stdlib Python module shipped inside the npm package:

- **Install:** `bili plugin install hermes` copies `plugin.yaml` +
  `__init__.py` into `~/.hermes/plugins/billion-context/`, writes a
  machine-owned `bili.json` sidecar pointing at the global bili install
  (`dist/index.js` + node path), and enables the plugin through hermes' own
  channel (`hermes plugins enable billion-context` — if the CLI isn't on PATH
  the same command is printed instead). Start a new hermes session to
  activate. Remove with `bili plugin remove hermes`; refresh with
  `bili plugin update hermes` after a global update.
- **Lifecycle:** at load the plugin attaches to a healthy running proxy or
  spawns its own on an ephemeral port (parent-pid watchdog tears it down when
  hermes exits; concurrent starts arbitrate through the same starting-marker
  protocol the launcher uses). Only once the proxy is verified healthy does it
  point hermes' httpx stack at it via `HTTPS_PROXY` / `https_proxy` +
  `SSL_CERT_FILE` (bili's combined CA bundle — current hermes resolves ambient
  trust there; `HERMES_CA_BUNDLE` stays set for older builds) —
  `~/.hermes/config.yaml` is never touched. Provider https hosts are read from hermes' config and whitelisted
  for MITM; everything else blind-tunnels exactly like launcher mode. If no
  proxy can be made healthy, the plugin stands down silently and traffic goes
  direct (no compression, no dead port).
- **Plugin-mode stamping:** an `llm_request` middleware stamps
  `x-bili-plugin: hermes` + conversation id (= the hermes session id, so
  gateway multi-session stays safe) + model, and `x-bili-plugin-max-output`
  once known — ONLY after the ACP tools are registered against the live proxy
  manifest; round 1 rides wire mode. A `pre_api_request` hook captures the
  effective `max_tokens` and pushes runtime-info (model + max output) to the
  proxy. `compress` / `decompress` / `acp_status` are registered as real
  hermes tools served by the proxy's existing plugin endpoints.
- **Known limitations:** requests going out hermes' Codex-wire transport may
  drop the per-request header surface, so such setups stay in wire mode until
  that transport exposes headers. Inert when `BILLION_CONTEXT_PROXY` is set
  (the launcher owns the proxy) or `BILI_PROVIDER_REWRITES` is defined.
  Opt-out: `BILI_NATIVE_HERMES=0`.

### ZCode (Z.ai / bigmodel coding plan)

Three aligned modes: `/bili/` URL prefix, cert-MITM through the GUI's
Settings → Network (HTTP proxy + root-CA path), and native plugin mode
(`bili plugin install zcode`, #1145). ZCode's extension surface is
Claude-Code-shaped but declarative: user-level hooks and stdio MCP servers in
`~/.zcode/cli/config.json`, no in-process JS seam. So the native lane ships
two small node scripts that do the work around the client:

- **Install:** `bili plugin install zcode` writes `~/.zcode/cli/config.json`:
  sets `hooks.enabled = true`, appends a `SessionStart` process hook
  (`node <root>/dist/zcode/bootstrap-hook.js`) and registers a stdio MCP
  server `mcp.servers.bili` (`node <root>/dist/zcode/mcp-entry.js`). A
  pre-existing user-owned `mcp.servers.bili` entry is never overwritten — the
  installer refuses loudly instead. No URL is frozen at install time; routing
  happens per session. Remove with `bili plugin remove zcode` (strips only
  bili's entries, reverts `hooks.enabled` when it was the one to enable it,
  and restores the provider store from its snapshot).
- **Per-session bootstrap:** each ZCode session spawns the MCP child as a
  direct process; at startup it attaches to a healthy proxy
  (`BILLION_CONTEXT_PROXY`) or spawns its own on an ephemeral port, then
  rewrites the active provider store with idempotent JSON surgery under a
  mkdir lockfile: the bigmodel coding-plan provider entries' `baseURL` becomes
  `http://127.0.0.1:<port>/bili/<upstream>` (the builtin default upstream is
  `https://open.bigmodel.cn/api/anthropic`; any custom baseURL you set is
  preserved verbatim behind the wrapper). Both store generations are handled:
  legacy `~/.zcode/v2/config.json` (`provider.<id>.options.baseURL`) and the
  v3.14+ personal store `~/.zcode/v2/provider_config.json`
  (`config.providerConfigRules.providerRules[].config.api.baseUrl`) — when
  both exist, the new store wins. The original file is snapshotted to
  `<file>.bili-bak` once per user edit (the snapshot always reflects your last
  real state, never bili's own writes); every other key is preserved
  byte-for-byte. Legacy-generation clients load provider config at startup —
  restart ZCode once after installing; newer builds pick up routing changes
  mid-session (~1 s polling). The `SessionStart` hook runs the same bootstrap
  opportunistically (attach-only — it never spawns); its non-blocking race is
  tolerated by design: round 1 may ride wire mode, and the invariant is never
  pointing `baseURL` at a dead port.
- **Plugin-mode stamping:** once the MCP child verifies the ACP tool list
  against the live proxy manifest, the routed entries gain
  `headers["x-bili-plugin"] = "zcode"` — until then traffic rides wire mode.
  Tool calls bind via the per-call `conversation_id` argument (#760).
- **Watchdog & lifecycle:** the MCP child probes the proxy every 30 s. In
  attach mode it waits forever (it never touches a user-owned proxy); in spawn
  mode a dead proxy is respawned and the routing rewritten to the new origin.
  If recovery fails, the managed rewrite is removed so traffic degrades back
  to direct upstream rather than hitting a dead port. When a session ends,
  ZCode kills the MCP child and the parent-pid watchdog tears down the spawned
  proxy. Concurrent sessions share the first-spawned proxy; when it goes away
  the remaining sessions respawn and re-route automatically.
- **Known limitations:** ZCode's anti-fraud fingerprinting (#661) applies to
  MITM-rebuilt bodies on `zcode.z.ai` login traffic — native mode does not
  touch that surface (model traffic flows through the provider store, not the
  GUI proxy); if you also run the GUI-proxy/MITM setup, keep the
  `"mitm://zcode.z.ai": { "passthrough": true }` route. Inert when
  `BILLION_CONTEXT_PROXY` is set (attach mode owns the proxy) or
  `BILI_PROVIDER_REWRITES` is defined. Opt-out: `BILI_NATIVE_ZCODE=0`.

### Gemini family (Gemini CLI / iFlow CLI / Qwen Code)

Three launchers for the gemini-cli architecture family (#1043 tier 1). Two of
the three have a base-URL env hook; one doesn't:

- **`bili gemini`** — Gemini CLI (`@google/gemini-cli`). Sets
  `GOOGLE_GEMINI_BASE_URL=<proxy>/bili/<upstream>` (default upstream
  `https://generativelanguage.googleapis.com`; if you export your own
  `GOOGLE_GEMINI_BASE_URL`, that value is relayed through the proxy instead).
  The client switches to its `gateway` auth mode and sends Google-native-wire
  requests straight to the loopback proxy — no MITM, no CA install, and
  `~/.gemini` is never touched. The proxy speaks this wire natively (model
  name rides in the URL path). Limitations: headless `-p` runs need a saved
  auth selection (e.g. `security.auth.selectedType = "gemini-api-key"` in
  settings + `GEMINI_API_KEY`) because gemini-cli rejects purely-env-derived
  gateway auth in non-interactive mode; users on an OAuth personal login
  (CodeAssist) are not covered by this route at all — that path ignores the
  base-URL hook.
- **`bili iflow`** — iFlow CLI (`@iflow-ai/iflow-cli`). Same pattern via
  `IFLOW_BASE_URL` (default `https://apis.iflow.cn/v1`, relayed when you set
  it); OpenAI chat-completions wire.
- **`bili qwen`** — Qwen Code (`QwenLM/qwen-code`). This fork dropped the
  base-URL hook (`DASHSCOPE_PROXY_BASE_URL` is a header-tuning knob, not
  routing), but it honors standard proxy envs, so the launcher uses cert-MITM:
  `HTTPS_PROXY=<proxy>` + `NODE_EXTRA_CA_CERTS=<bili CA>` with a static
  whitelist of the default model hosts (DashScope / Qwen gateway / common
  third-party endpoints). Custom relay hosts: add them with
  `--mitm-domain <host>`. Best-effort route — a `BLIND TUNNEL WARNING` in the
  log means a host is missing from the whitelist.

None of the three has a native mode: none exposes an in-loop tool injection
seam (gemini-cli extensions reach custom commands only; the forks inherit
that surface). Launcher-only by design.

### Client uses `http.proxy` (CONNECT) but nothing compresses

Some clients (VS Code-based IDEs: CodeBuddy, Cursor, Windsurf, …) only offer an HTTP **proxy** setting (`http.proxy`, `codingcopilot.httpProxyURL`, …) — no model base-URL to rewrite. Such clients send `CONNECT <model-host>:443` through the proxy instead of plain `/bili/…` requests. That path is only decrypted when the model host is on bili's **MITM whitelist**; otherwise bili blind-tunnels the TLS bytes (opaque relay) and can never see — or compress — the model requests (#897).

This failure mode is now loud instead of silent:

- a one-time `BLIND TUNNEL WARNING` per target host in the log, with the fix steps;
- `blindTunnels` (count + exact target hosts) in `curl -s http://localhost:8787/__bili/health` and `/__bili/stats` (loopback-only);
- an `UNDECRYPTED TRAFFIC (instance-level)` section in `acp_status` output while such tunnels exist.

To actually compress such a client: add its model domain to `"mitm".domains` in `billion-context.json` (e.g. `"mitm": { "domains": ["copilot.tencent.com"] }`) or via `BILI_MITM_DOMAINS`, restart bili, and make the client trust bili's root CA (`NODE_EXTRA_CA_CERTS=~/.local/share/billion-context/ca/root-ca.pem` for Node-based clients, or the client's own CA-path setting). The `/bili/` prefix trick does not apply here — there is no URL to change. Details: [CONFIGURATION.md → MITM](CONFIGURATION.md#mitm-transparent-proxy-login-clients).

### An unrecognized endpoint goes direct and nothing compresses (#1290)

bili only compresses requests whose path matches a known wire protocol (`/chat/completions`, `/llm_raw_chat`, `/v1/messages`, `/responses`, …). A request to any other path — e.g. a third-party plugin's **custom wire** such as Command Code's Go plan posting to `/alpha/generate` — is relayed byte-for-byte and **never compressed**. There is no config seam to declare an arbitrary new wire today; adding one is a separate feature, not a switch you can flip.

That outcome is now loud instead of silent (#1290):

- the client-side fetch hook logs each distinct unrouted endpoint once per process (`…is not a recognized model endpoint, so bili did not route it through the proxy…`);
- `unrecognizedPaths` (per-path counts) in `curl -s http://localhost:8787/__bili/stats` (loopback-only);
- an `UNRECOGNIZED PATHS (instance-level)` section in `acp_status` output while such requests exist.

If you expected compression at such an endpoint, use the provider's standard protocol endpoint instead (Command Code's Provider plan posts to `/provider/v1/chat/completions`, which bili does compress); a genuinely custom wire needs its own support.

## OpenCode

One bundled plugin serves **both** OpenCode generations: the agent file keeps
the V1 `server()` export alongside the V2 `setup()`, so hosts ≥ 1.18.29 load
the V1 shape and 2.x hosts load the V2 `setup()`. The standalone
[`opencode-acp`](https://github.com/ranxianglei/opencode-acp) extension is
V1-only and does **not** load under 2.x — for OpenCode 2.x, billion-context
is the recommended context manager. Everything below is verified end-to-end
on `@opencode/cli` 2.0.3 (V1 lane: 1.14.46 and 1.18.31).

| Path | Command | When |
|---|---|---|
| Launcher (easiest) | `bili opencode` | one command brings up proxy + client; real config untouched |
| Native (no launcher) | `bili plugin install opencode` | self-spawning plugin in your real config; start `opencode` as usual |
| Pure proxy (fallback) | baseURL `/bili/` prefix | no plugin — wire-level tool injection |

### Launcher — `bili opencode`

HTTPS rides cert-MITM, HTTP a temp `opencode.json` clone with `/bili/`
(JSONC comments accepted, merged the way opencode itself merges them;
relative local plugin specs re-anchored to absolute paths in the clone —
opencode resolves them against the declaring config file's dir, #826). Host
generation is detected with a `--version` probe (failed probe defaults to
1.x): on a **2.x** host the built-in V2 plugin (`dist/agent/opencode.js`) is
injected as a temp wrapper directory whose `index.js` re-exports the plugin
file (2.x rejects bare file paths in the config `plugin` array); **1.x**
hosts get the bare file path.

What the plugin does (both generations): registers the bili tools natively
in-host — compress / decompress / search_context / acp_status (+ absorb) —
and stamps the proxy headers on every outgoing provider request, including
context-window / max-output read from the host's own model catalog
(`ctx.catalog.model.list()`, refreshed every 60s) and reported to the proxy
as runtime-info (#955) — compression runs in plugin mode with **no**
wire-level tool injection. Native auto-compaction is disabled automatically
(`compaction.auto: false`). Every registration is defensive (optional
chaining): on any 2.x build where a seam is missing or never fires, the
plugin stays inert and the session transparently runs in plain proxy mode
instead of breaking — observed across adjacent `dev` builds whose API
surfaces differ from each other (#754 review probes).

1.x specifics (verified 1.14.46 + 1.18.31): the V1 `.server()` hooks rewrite
every provider `options.baseURL` to `<proxy>/bili/…` in-process and set
`compaction.auto: false`; `chat.headers` stamps the plugin headers per
request; `tool` registers the bili tools with real zod shapes (zod is a
runtime dependency — when it cannot be resolved the plugin degrades to
rewrite-only). Providers **without** an explicit `baseURL` (SDK defaults,
e.g. bare `@ai-sdk/openai` → api.openai.com) are caught by a global `fetch`
patch (log: `v1: fetch patch installed`) — idempotent, passes
`/bili/`-wrapped URLs through untouched; verified including the OpenAI
Responses endpoint.

### Native (no launcher) — `bili plugin install opencode`

Registers a self-spawning plugin in your real opencode config and sets
`compaction.auto: false`; afterwards plain `opencode` works as-is. No MCP
face is added by default (the native plugin already provides the bili tools,
session-bound); pass `--with-mcp` to add one — the entry then carries no
origin pin, so it survives the plugin's ephemeral-port proxy restarts (#926).
Entry form depends on how THIS bili was installed: an **npm install** writes
the bare package name (`"plugin": ["billion-context"]`) — the package
publishes `exports["./server"]` → `dist/agent/opencode-native.js`, so
opencode loads it through its own Npm.add machinery; zero absolute paths, portable. (That exact bare-name entry doubles as a hand-install without bili — see Option 1.) A **git checkout / dev build** falls back to a local shim dir
(`<configDir>/plugins/billion-context/index.js` → this checkout's
`dist/agent/opencode-native.js`) — machine-local by construction; re-running
install from an npm install migrates the entry back to the bare name.

At load the plugin bootstraps its own proxy (attaches to a healthy instance
instead of doubling; parent-pid watchdog kills it when opencode exits),
routes model-API traffic to `<proxy>/bili/<upstream-url>`, and exposes the
same native bili tools as launcher mode — no fixed port, no env var, no
launcher. Opt-out: `BILI_NATIVE_OPENCODE=0`. If no proxy can be made
healthy, requests go direct (uncompressed) with a one-time warning and
recover automatically. Under a `bili opencode` launch this entry is skipped
entirely (the launcher owns the proxy).

### Pure proxy (no plugin)

Point the provider baseURL at the proxy like any other client:

```json
{
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:8787/bili/http://upstream.example/v1",
        "apiKey": "sk-any"
      }
    }
  }
}
```

Note: 2.0 AI-SDK providers require an `apiKey` field even for local
endpoints that never check it — set any non-empty value.

### Status: `/acp` and `acp_status`

The `/acp` panel is session-bound in all modes, and the `acp_status` tool is
its in-host equivalent everywhere. On 2.0.x stable, where the command editor
supports adding entries (`editor.add`), the V2 plugin additionally registers
an `/acp` slash command — rendered as a synthetic non-model message,
panel-first like the `acp_status` tool; on older shapes the registration
stays inert. Note `opencode run` mode dispatches no slash commands at all
(they pass through to the model) — use the TUI.

The same seam carries `/acp-cache` (#1146) — the human entry point to the
prompt-cache reconciliation report (identical output to the `acp_cache` tool):
pi/omp register it natively (`/acp-cache [full]` for the every-line listing);
opencode V1 renders it as an ignored message the proxy strips from model
context before it reaches the wire; opencode V2 as a synthetic message (report
visible up to ~8 KB); dsh (both lanes) shows the default summary ledger — dsh's
command API passes no arguments, so there is no `full`. Legacy opencode-acp
sessions (#920) get an explicit unavailable notice instead (their traffic
bypasses this proxy's compression state). Claude Code has no in-process command
API: `bili plugin install claude` writes a model-mediated
`commands/acp-cache.md` markdown command whose prompt drives the `acp_cache`
MCP tool and pastes the report back verbatim. codex/kimi/hermes expose no
user-typable command seam — ask the model to call its `acp_cache` tool directly.

The same seam carries `/acp-rule` (#1251) — the human entry point to the
persistent-rules feature (identical output to the `acp_rule` tool): pi/omp
register it natively — bare `/acp-rule` lists every recorded rule, and
`/acp-rule <text>` records one directly (as if the model had called it). The
wrapped transcript message is stripped from model context by content signature
like the cache report — recorded rules reach the model every turn via the
system-prompt injection anyway. delete/clear subcommands land with #1178;
other lanes get it in follow-up work.

### Legacy opencode-acp sessions (#920)

On 1.x hosts, pre-migration [`opencode-acp`](https://github.com/ranxianglei/opencode-acp)
sessions keep working under both lanes: the launcher strips the
`opencode-acp` entry from its temp config clone (the host never loads it
armed), and each lane absorbs the installed package (imported directly from
`node_modules` — `.opencode/node_modules`, project `node_modules`, global npm
root, or opencode's config-scope modules, first hit wins). A session is
legacy iff opencode-acp's persisted state file exists
(`<XDG_DATA_HOME>/opencode/storage/plugin/acp/<sessionID>.json`, or the dir
from `storagePath` in `acp.jsonc`):

- **Legacy session** — compression runs through the absorbed opencode-acp
  (its own refs and block store keep working: `compress` / `decompress` /
  `search_context` / `acp_status` / `acp_context_recap` all execute in it).
  Its model requests carry `x-bili-plugin-bypass: 1`; the proxy forwards
  them VERBATIM — no wire injection, no nudge, no session binding.
- **New session** — bili owns it: tool calls forward to the proxy's plugin
  endpoints (plugin mode). The executor routes by session lane, so a new
  session's `compress` reaches the proxy while a legacy session's reaches
  opencode-acp. `acp_context_recap` has no proxy counterpart — on new
  sessions the proxy answers with its unknown-tool message.

`/acp` and `/dcp` route the same way. Adoption of new sessions into
opencode-acp's registry is prevented by gating its transforms (system /
messages / text.complete) on the legacy predicate. Degradation: when the
package is absent or fails to import (or isn't v1), bili runs alone and
legacy sessions behave as read-only archives (old tags render, `decompress`
returns `[Block … not found]`, new refs restart from m00001).

### Caveats

- The 2.x line publishes as npm package `@opencode/cli`, and its plugin API
  surface is still moving between builds (adjacent `dev`-channel builds
  expose different `ctx` shapes) — the hook/tool details above are
  version-specific observations, not a stable contract.
- Design note: the V2 plugin is a thin protocol client (no acp-kernel
  inside) because the proxy stays the single compression authority — that
  eliminates kernel-version drift between agent and proxy; it does not rely
  on the plugin API being unable to mutate context (that capability varies
  by 2.x build).

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

By default the proxy binds `127.0.0.1` and only accepts loopback
connections. To serve agents on other machines, bind a non-loopback host:

```bash
bili --host 0.0.0.0           # all interfaces (or use your LAN IP)
```

- Remote agents point their model `baseURL` at `http://<this-host>:<port>/bili/…`.
- MITM-mode `CONNECT` then also accepts remote clients — for **whitelisted
  model hosts only**. Blind tunnels to arbitrary hosts stay loopback-only, so
  the proxy can never be used as an open relay.
- The `/bili/<absolute-url>` tunnel has destination admission (#409): the
  proxy itself and link-local/metadata addresses are **always denied**;
  loopback/private destinations are allowed for local clients (self-hosted
  upstreams) and **denied for remote clients** unless listed in
  `BILI_TUNNEL_ALLOWED_HOSTS` (`host` or `host:port`, comma-separated) — a
   remote peer must not use the proxy as an SSRF pivot into your LAN, and the
   management plane is unreachable through the tunnel even via NAT hairpin
   (tunneled requests carry an internal `x-bili-tunnel` marker that `/__bili/`
   rejects). One exception (#1073): a **local** client relaying a management
   path (`/__bili/*`, `/__acp/*`) to a **loopback IP-literal** destination is
   forwarded unmarked — any same-machine process can already reach that port
   directly, so the marker would add no protection while breaking legitimate
   inter-instance health probes. Remote peers and hostname destinations keep
   the marker unconditionally. An absolute-form request addressed to the
   instance's **own** endpoint on a management path is served locally instead
   of tunneled (a forward-proxy-style health probe gets a real answer).
- There is **no authentication**: only do this on a trusted LAN or behind a
  firewall. The `/__bili/` management endpoints remain loopback-only.
- A startup `[security]` warning reminds you of the above.

### Debugging

Three ways to enable verbose logging (priority: flag > env > config):

1. **CLI flag** (quickest): `bili --debug`
2. **Env var**: `ACP_DEBUG=1 bili`
3. **Config file**: `"debug": true` in `billion-context.json`

Verbose mode logs every `processTurn` (tag counts, token usage), the nudge
decision (growth/usage/pendingT1/shouldInject), client headers, and SSE
rewrites.

### Log file

All logs are **tee'd to a file by default**: `~/.local/state/billion-context/bili.log`
(XDG state dir). They also still print to stderr so a foreground `bili start`
shows them in the terminal.

```bash
# Config:  "logFile": "/custom/path.log"
# Env:     ACP_LOG_FILE=/custom/path.log   (or ACP_LOG_FILE=off to disable the file)
```

The file auto-rotates at 10 MB (renamed to `bili.log.old`). Cache-hit stats
per request are logged as `[acp-usage] round N input=X cached=Y (cache hit Z%)`
so you can measure prefix-cache health directly from the log.

### Self-update

The proxy checks npm for a newer version on startup and every 3 minutes. When a
newer version is found it installs it in place (tarball over the install dir)
and logs a notice — **restart `bili` to pick up the new version**.

While the running process is behind the on-disk install ("stale"), the state is
visible without digging through logs:

- The web UI (`/__bili/`) shows a banner on the overview page: which version is
  running vs installed, and whether auto-restart is enabled.
- `GET /__bili/status` returns `{version, diskVersion, stale,
  autoRestartOnUpdate, inFlight}` for scripting.
- A one-time `[update] … restart bili to activate` warning per version pair
  stays in the log.

**Opt-in self-restart.** With `--auto-restart-on-update` (or env
`ACP_AUTO_RESTART_ON_UPDATE=1`, or `"autoRestartOnUpdate": true` in the config
file — default OFF) the proxy re-execs itself instead of waiting for a human:
when the on-disk version is newer and there are **zero in-flight requests**, it
verifies the new install, stops accepting connections, drains, spawns a
replacement process on the same port, waits until it accepts connections, then
exits. Clients reconnect to the same port automatically; session state survives
(persisted on disk). Safety gates: zero in-flight at decision time *and*
through the drain window; an install sanity check before re-exec; a 10-minute
cooldown marker so a flapping version can never loop-restart. Any failure
resumes the original listener and falls back to the plain reminder.

Disable permanently via config (`"autoUpdate": false`) or env
(`ACP_AUTO_UPDATE=0`).

## Configuration

The full configuration reference — config file location, top-level keys,
providers, compression tuning, environment variables — lives in
**[CONFIGURATION.md](CONFIGURATION.md)**.

### Upstream proxy (firewall / GFW)

If the proxy's own outbound connections to a model provider are blocked
(e.g. `api.openai.com` from inside the GFW), configure an **upstream proxy**
(the local v2rayA / clash HTTP port) so the proxy reaches the provider:

```jsonc
{
  // Global default: ALL providers route through this proxy
  "proxy": "http://127.0.0.1:20172",
  "providers": {
    "https://api.openai.com/v1": {
      // Per-URL overrides global (use a different proxy for this host)
      "proxy": "http://127.0.0.1:20173",
      "models": { "gpt-5": { "context": 400000 } }
    },
    "https://open.bigmodel.cn/api/anthropic": {
      // Empty string = explicitly DIRECT, overriding the global proxy
      "proxy": "",
      "models": { "glm-5.2": { "context": 1000000 } }
    }
  }
}
```

Rules:
- **Per-URL `proxy`** has the highest priority for its matching provider URL.
- Remaining priority is `BILI_UPSTREAM_PROXY` → Web UI manual proxy → top-level
  `proxy` → `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` → Windows system proxy
  → direct.
- Empty string `""` means **explicitly direct** (override-and-disable).
- Auto mode honors `NO_PROXY` and the Windows proxy bypass list for
  environment/system fallbacks. A proxy pointing back to bili's own local port
  is ignored or rejected to prevent a loop.
- HTTP and HTTPS proxy origins are supported. SOCKS5 (`socks5`/`socks5h`) is
  not supported: an explicit `BILI_UPSTREAM_PROXY` / config `proxy` with such
  a scheme fails startup with an actionable error, while env/system proxies
  (`HTTPS_PROXY`, …) with such a scheme are ignored with a one-time warning
  (traffic then falls through to direct). For Clash/mihomo, point bili at the
  same mixed port over `http://` (e.g. `http://127.0.0.1:7890`).
- Both outbound paths are covered: `/bili/` path-mode (fetch) AND MITM CONNECT
  tunnels (the proxy's connection to the real upstream goes through the HTTP
  CONNECT proxy).
- The auto-updater's own egress (npm registry check + tarball download) uses
  the same decision for its hosts, so `bili update` and auto-update work on
  hosts where npm is only reachable through the proxy (#609).

Env override: `BILI_UPSTREAM_PROXY=http://127.0.0.1:20172` (higher priority than
the config file). On Windows, common Clash/Mihomo static system proxies are
discovered automatically; the Web UI shows the effective source and any PAC
URL detected in Internet Settings.

**MITM vs `/bili/` — distinguishing the key scheme.** A login client
(ZCode via MITM) and an API-key client can both hit the same host
(`open.bigmodel.cn`). To let their config differ, MITM traffic uses a
`mitm://` scheme in the lookup key while `/bili/` traffic uses the real
`https://`:

| Client | Lookup key example |
|---|---|
| ZCode (MITM, login) | `mitm://open.bigmodel.cn` |
| API-key client (`/bili/`) | `https://open.bigmodel.cn/api/anthropic` |

So you can give ZCode its own proxy without affecting API-key clients:
```jsonc
{
  "providers": {
    "mitm://open.bigmodel.cn":            { "proxy": "http://127.0.0.1:20173" },
    "https://open.bigmodel.cn/api/anthropic": { "proxy": "http://127.0.0.1:20172" }
  }
}
```

### Wire-compat role rewrite (`compat.roles`)

Some upstreams reject the `developer` role newer codex clients send on the
Responses API (`400 Invalid role: developer`). `compat.roles` maps roles to
what the upstream accepts — applied at the forward boundary to the final
`openai`/`responses` body (client-sent roles **and** bili's own injected
prompt alike), global or per-provider, default off = byte-for-byte:

```jsonc
{
  "compat": { "roles": { "developer": "system" } },
  "providers": {
    "https://picky.example.com": { "compat": { "roles": { "developer": "user" } } }
  }
}
```

**No configuration needed for the common case.** When an upstream answers a
request with `400 Invalid role: …`, bili auto-rewrites the offending role to
`system`, retries the request once, and — if the retry succeeds — remembers
the mapping **for that session only** (nothing is written to your config).
Later requests in the session skip the 400 round-trip. The log line printed
when the auto-fix fires includes a copy-paste per-provider snippet if you
want the mapping permanently.

## How sessions work

The proxy needs a stable per-conversation identifier to isolate compression
state across concurrent users/accounts. It derives one from four dimensions
(see `src/session-id.ts`): **protocol × upstream origin × API key ×
conversation**. The first three prevent cross-account / cross-provider
bleeding; the conversation dimension comes from whatever the client sends.

Clients differ in what they send:

| Client | Sends conversation id? | Source | Safety |
|---|---|---|---|
| **Codex** (0.147+) | ✅ yes | `body.session_id` (per-conversation UUID) | ✅ safe |
| **OpenCode** | ✅ yes | `x-session-affinity` header (`ses_…`) | ✅ safe |
| **pi** | ❌ **no** | nothing | ⚠️ **collision risk** |

When the client sends an explicit id, the proxy uses it directly. When it
does not (pi), the proxy falls back to hashing the first user message — so
two conversations that start with the same opener collapse onto the same
session. This does **not** corrupt data (per-message refs use a separate
content fingerprint that stays stable), but it can skew nudge/compression
timing and occasionally over-eagerly reap a block. It is self-healing: the
worst case is reduced compression efficiency, never data loss.

For upstream sticky-routing, when the client sends no session header the
proxy synthesizes one (`x-session-id: ses_<hash>`) so cache pools / load
balancers still get a stable key.

**Recommendation:** Codex and OpenCode are safe to run many concurrent
conversations through the proxy. pi is fine for a single agent, but is **not
recommended** for many concurrent conversations because of the collision
risk — until pi grows its own session-id signal. For pi multi-agent use,
pass an explicit `x-acp-session` header per conversation to avoid collisions.

### Derived (child) sessions inherit the parent's compressed context (#1333, #1362)

When an agent spawns a child session — a subagent or fork that starts from an
empty history instead of resending the parent's conversation — that child
could not previously `decompress` or `search_context` content that was folded
away in the parent. Each lane now reports the lineage at birth: its identity
registration carries the parent's conversation id (`parentConversationId`),
and the proxy records a read-only link (`derivedFrom`) on the child session.
From then on:

- `decompress` / `search_context` fall back along the parent chain for
  content the child never saw itself (resident or on-disk parents,
  cycle-guarded, depth cap 8);
- nothing is copied into the child's state and the parent is never modified —
  fallback hits are read-only, so a child can never clobber what the parent
  still owns;
- if the parent is unknown to the proxy when the link is recorded, the child
  simply starts fresh.

| Lane | Parent signal |
|---|---|
| **pi** RLM inline spawn | `parentSession` in the session header (path to the parent session file, resolved to its session id) |
| **omp** fork / newSession | `parentSession` in the session header (bare session id or file path — both accepted) |
| **OpenCode V1** (native plugin) | SDK session info `parentID` (resolved once per session, cached) |
| **OpenCode V2** (native plugin) | `session.created` event `data.parentID` |

claude/codex/dsh need nothing here: they share one session id across
subagents or have no child-session concept at all.

### Windows: exclude the sessions dir from antivirus (#362)

The proxy persists each session's compression state to the sessions dir
(`%USERPROFILE%\.local\share\billion-context\` by default) and rewrites the
file every turn of a long session. Persisted per session: the compression
state (block summaries), the compressed originals cache (`blockContents`,
what `bili export --full` recovers), and a bounded folded-view snapshot of
the recent conversation (newest `BILI_PERSIST_TAIL_TOKENS` tokens, default
16k) — the raw full history is never duplicated on disk (#401). On
Windows, real-time antivirus (Windows
Defender), the search indexer, or a sync tool (OneDrive) can lock that
directory mid-write, so the rename fails with `EPERM` and every persist for
that session fails until the lock clears.

When the same session fails N consecutive writes (default `5`), the proxy
logs a one-time, actionable alert naming the directory to exclude. To fix it
at the root: add `%USERPROFILE%\.local\share\billion-context\` to your
antivirus **exclusions** (Windows Defender: Settings → Virus & threat
protection → Manage settings → Exclusions → Add an exclusion → Folder) and
make sure no sync tool (OneDrive / Dropbox / …) is syncing that path. Full
steps in [CONFIGURATION.md](CONFIGURATION.md#windows-exclude-the-sessions-dir-from-antivirus-362).

### Session file cleanup (#1082)

Short-lived sessions leave small state files behind that are never resumed.
Cleanup is **opt-in** — set `BILI_SESSION_GC=1` to enable it (off by default:
session files are user data, so there is no silent deletion policy). When
enabled and persistence is on, bili sweeps the sessions dir at boot and
hourly, and deletes a file only when BOTH hold: it is older than
`BILI_SESSION_GC_MAX_AGE_DAYS` (default 7 days), AND the session was never
compressed (no folded blocks) with its newest request body ≤
`BILI_SESSION_GC_MAX_TOKENS` tokens (default 1M; unrecorded legacy files use
`contextTokens`) — so deletion loses nothing but bytes: resuming rebuilds the
context from the client's own history at the cost of one cold rebuild.
CCR content stores (#1097) live next to their session file as
`<hash>.content-store.json` and follow the same lifecycle (#1180): a store is
deleted together with its session file, an orphaned store (session file
already gone) is swept once past the age gate, and the store's token footprint
(unique-content counted with the kernel's CJK-aware `defaultCountTokens` — the
same estimator as `rawInputTokens`) counts toward the size ceiling above. Compressed
sessions are never deleted (their summaries cannot be rebuilt losslessly). Every deletion is audit-logged individually, plus one summary
line per non-empty sweep. Live sessions, unreadable files, and encrypted
files are handled conservatively (decoded via `BILI_ENCRYPTION_KEY` before
judging). Details in [CONFIGURATION.md](CONFIGURATION.md#environment-variables).

## Status

Early. Protocol handling and compression work against mock tests (500+ passing). Real-model integration testing is the next milestone. Expect rough edges.

Client-side plugins for pi / omp / opencode ship inside `billion-context` (`dist/agent/*.js`) for the cooperative-proxy path. See the **"Which do I need?"** section above for how `billion-context`, the standalone `billion-context-pi`, and `opencode-acp` relate.

## License

MIT
