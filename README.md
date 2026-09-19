# billion-context

[English](./README.md) | [中文](./README.zh-CN.md)

<p align="center">
<strong>Universal context-compression proxy</strong> for AI coding agents
<br />
Any agent that can set a base URL — <em>zero per-agent adapter code</em>.
</p>

---


## 📄 Paper / Preprint

- **[Model-Driven Incremental Hierarchical Compression: Training-Free Multi-Generational Context Management for Long-Lived Coding Agents](./paper/model-driven-incremental-hierarchical-compression-training-free-multi-generational-context-management-for-long-lived-coding-agents.md)** (English, v0.2)

> 📝 **The paper itself is open-sourced under the MIT License as part of the codebase (`paper/`). It is a living document — anyone may edit it; improvements are welcome via pull request.**

A production-scale longitudinal study: 4.5 months, three hosts, 174,327 model calls, 18.76B cumulative input tokens (~24.7B across all hosts), zero window violations on 204,800-token models, marathon sessions of 8,584–12,049 calls.

---

<p align="center">
<a href="https://www.npmjs.com/package/billion-context"><img src="https://img.shields.io/npm/v/billion-context.svg?style=flat-square" alt="npm"></a>
<a href="https://github.com/ranxianglei/billion-context/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/billion-context.svg?style=flat-square" alt="license"></a>
<a href="https://github.com/ranxianglei/billion-context"><img src="https://img.shields.io/badge/GitHub-ranxianglei%2Fbillion--context-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

<p align="center">
<code>npm install -g billion-context</code>
</p>

---

`billion-context` sits between **any** agent and its model API, rewriting Anthropic/OpenAI streams with [acp-kernel](https://github.com/ranxianglei/acp-kernel) compression. The model decides **when** and **what** to compress into high-fidelity summaries — not a hard truncation limit.

## Community

Discussion, help, and updates on QQ — one group covers all three projects (`billion-context`, `billion-context-pi`, `opencode-acp`):

**QQ Group: 1056132097**

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
| **dsh** | `bili dsh` (launcher — full native plugin via `--patch`: tools, session-bound `/acp`, fetch intercept) or `bili plugin install dsh` ≡ `dsh plugin --profile <name> add billion-context` (one unified lane — pnpm-installs the package into each profile so dsh mounts the bundled patch layer; the bili form just drives dsh's own channel per profile and migrates legacy managed blocks) |
| **kimi** | `bili plugin install kimi` (self-spawning native plugin, no launcher — Kimi Code ≥ 2.0.0; per-session routing block in `~/.kimi-code/config.toml`) or `bili kimi` (launcher, cert-MITM) or `/bili/` prefix |
| **claude** | `bili claude` (launcher) or `bili plugin install claude` (native posture, #964 — managed settings block + session-owned proxy; see the notes below) |
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

### Option 1 — Native plugin (`bili plugin install pi` / `omp` / `opencode` / `dsh` / `kimi`)

The proxy lives inside the client: install once, then start the client
exactly as you always do — no launcher command, no env vars, no fixed port,
no URL edits. Supported today for **pi**, **omp**, **opencode** (1.x and
2.x), **dsh** and **kimi**:

```bash
bili plugin install pi          # registers a "billion-context" entry in pi's settings (npm form when bili itself was npm-installed)
bili plugin install omp         # registers an extensions entry in omp's config.yml (~/.omp/agent/config.yml)
bili plugin install opencode    # registers the plugin in opencode's real config + disables native auto-compaction
bili plugin install dsh         # runs 'dsh plugin --profile <name> add billion-context' for every existing profile
bili plugin install kimi        # writes $KIMI_CODE_HOME/plugins/managed/billion-context/kimi.plugin.json (+ installed.json record); per-session routing block lands in config.toml on first start (Kimi Code >= 2.0.0)
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
| **dsh** | each profile's pnpm store | global bili self-update re-runs dsh's plugin channel per profile (or `dsh plugin add billion-context@latest`); pnpm's hardlinked store must never be copied over in place |
| omp / claude / codex / kimi | no copy — entries point at the global bili install | they update together with the global copy |

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
one if present; a parent-pid watchdog tears it down when the client exits),
rewrites model traffic to `<proxy>/bili/<upstream-url>`, registers
`compress` / `decompress` / `acp_status` as native client tools (plugin
mode), and reports the client's **own model config** to the proxy so
compression budgets use the real window instead of a registry guess.
Opt-out envs: `BILI_NATIVE_PI=0`, `BILI_NATIVE_OMP=0`,
`BILI_NATIVE_OPENCODE=0`, `BILI_NATIVE_DSH=0`, `BILI_NATIVE_KIMI=0`. Full
mechanics: [TECHNICAL-NOTES.md](TECHNICAL-NOTES.md).

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
- `codex` has a companion install too (an MCP shell), but it needs a running
  proxy — it is not native mode.
- `claude` also has a **native posture** (#964): `bili plugin install
  claude` writes a managed settings block (static `/bili/` URL +
  `SessionStart` hook) plus an MCP shell pinned to a stable port — the
  proxy lives and dies with the session. Opt out with
  `BILI_NATIVE_CLAUDE=0` (passthrough). Mechanics:
  [TECHNICAL-NOTES.md](TECHNICAL-NOTES.md).

### Option 2 — Launcher (`bili pi` / `bili codex` / `bili claude` / `bili omp` / `bili opencode` / `bili hermes` / `bili dsh` / `bili codebuddy` / `bili qoder` / `bili trae` / `bili jcode` / `bili kimi`)

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
bili hermes                           # file-free (#535): hermes proxy env (HTTPS_PROXY + HERMES_CA_BUNDLE) — https via CONNECT MITM, http via absolute-form forward proxy; real ~/.hermes untouched
bili dsh                              # deepseek-harness: full native plugin injected via --patch (#941) — compress/decompress/acp_status registered as real dsh tools, requests stamped with the dsh session id (plugin mode), /acp session-bound; non-loopback upstreams ride proxy envs (https MITM, http absolute-form), loopback keeps the overlay DSH_HOME (~/.dsh-bili) rewrite (#535), built-in deepseek route via DEEPSEEK_BASE_URL; dsh native auto-compaction disabled (compaction-basic auto:false)
bili codebuddy                        # Tencent CodeBuddy Code CLI: CODEBUDDY_BASE_URL /bili/ rewrite (OpenAI chat completions wire), budget aligned via CODEBUDDY_AUTO_COMPACT_WINDOW; real ~/.codebuddy untouched
bili qoder                            # qoder: model endpoint is hardcoded https (no /bili/ rewrite possible) — cert-MITM via HTTPS_PROXY + NODE_EXTRA_CA_CERTS, default model hosts whitelisted (#653)
bili trae                             # Trae CLI (ByteDance, closed Go binary, no base-URL override) — cert-MITM via HTTPS_PROXY + SSL_CERT_FILE, model host from TRAE_CLI_API_HOST or the default enterprise gateway (#655)
bili jcode                            # jcode (Rust agent harness) — env-only cert-MITM launch: HTTPS_PROXY + SSL_CERT_FILE, model host api.z.ai whitelisted, local loopback providers stay direct via NO_PROXY
bili kimi                             # Kimi Code CLI (Moonshot): honors standard proxy envs for all traffic EXCEPT an unconditional loopback bypass — non-loopback https via cert-MITM (HTTPS_PROXY + NODE_EXTRA_CA_CERTS/SSL_CERT_FILE), non-loopback http via absolute-form forward proxy; provider/model hosts from ~/.kimi-code/config.toml (KIMI_CODE_HOME respected) or the managed OAuth endpoints when none declared; loopback endpoints inventoried with a manual /bili/ prefix hint (#757)
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
- **Auto-update keeps profiles in lockstep:** after a global self-update,
  bili scans `~/.dsh/profiles/*/package.json` and brings any registry-pinned
  `billion-context` dependency back to the new global version, so the loaded
  plugin and the proxy never drift apart again (#953); profiles pinned to a
  local source are left alone. The refresh is best-effort and never fails the
  update itself.

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

### Client uses `http.proxy` (CONNECT) but nothing compresses

Some clients (VS Code-based IDEs: CodeBuddy, Cursor, Windsurf, …) only offer an HTTP **proxy** setting (`http.proxy`, `codingcopilot.httpProxyURL`, …) — no model base-URL to rewrite. Such clients send `CONNECT <model-host>:443` through the proxy instead of plain `/bili/…` requests. That path is only decrypted when the model host is on bili's **MITM whitelist**; otherwise bili blind-tunnels the TLS bytes (opaque relay) and can never see — or compress — the model requests (#897).

This failure mode is now loud instead of silent:

- a one-time `BLIND TUNNEL WARNING` per target host in the log, with the fix steps;
- `blindTunnels` (count + exact target hosts) in `curl -s http://localhost:8787/__bili/health` and `/__bili/stats` (loopback-only);
- an `UNDECRYPTED TRAFFIC (instance-level)` section in `acp_status` output while such tunnels exist.

To actually compress such a client: add its model domain to `"mitm".domains` in `billion-context.json` (e.g. `"mitm": { "domains": ["copilot.tencent.com"] }`) or via `BILI_MITM_DOMAINS`, restart bili, and make the client trust bili's root CA (`NODE_EXTRA_CA_CERTS=~/.local/share/billion-context/ca/root-ca.pem` for Node-based clients, or the client's own CA-path setting). The `/bili/` prefix trick does not apply here — there is no URL to change. Details: [CONFIGURATION.md → MITM](CONFIGURATION.md#mitm-transparent-proxy-login-clients).

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
  rejects).
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
newer version is found it installs it globally (`npm install -g`) and logs a
notice — **restart `bili` to pick up the new version**.

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

## Status

Early. Protocol handling and compression work against mock tests (500+ passing). Real-model integration testing is the next milestone. Expect rough edges.

Client-side plugins for pi / omp / opencode ship inside `billion-context` (`dist/agent/*.js`) for the cooperative-proxy path. See the **"Which do I need?"** section above for how `billion-context`, the standalone `billion-context-pi`, and `opencode-acp` relate.

## Community

QQ group — one shared group for all three projects ([`billion-context`](https://github.com/ranxianglei/billion-context), [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi), [`opencode-acp`](https://github.com/ranxianglei/opencode-acp)): **1056132097**

## License

MIT
