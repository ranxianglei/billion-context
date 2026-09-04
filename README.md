# billion-context

[English](./README.md) | [中文](./README.zh-CN.md)

<p align="center">
<strong>Universal context-compression proxy</strong> for AI coding agents
<br />
Any agent that can set a base URL — <em>zero per-agent adapter code</em>.
</p>

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

### Two compression modes — who executes `compress`

The proxy runs in one of two modes, and **the mode decides who executes
`compress`, which in turn decides how the summary travels to the model** (the
"carrier"). This distinction is the root of #377.

| | **Launcher / plugin mode** (`bili pi`, `bili codex`, …) | **Proxy mode** (plain client → `/bili/`) |
|---|---|---|
| Client | ACP-native agent with the bili extension (pi/omp) | Any OpenAI/Anthropic client, no extension |
| Who executes `compress` | **The agent** (pi runs it locally) | **The proxy** (server-side compress loop) |
| `compress` tool call in the re-sent history? | Yes — part of the agent's own conversation | No — ephemeral proxy-loop traffic |
| Preflight blocks (no tool call)? | No — overflow forces the model to call `compress` | Yes — `src/preflight.ts` compresses behind the client's back |
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

## Which do I need?

Pick by your client:

| Client | Use |
|---|---|
| **pi** | [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) (in-process extension) |
| **opencode** | [`opencode-acp`](https://github.com/ranxianglei/opencode-acp) (in-process extension) |
| **omp** | [`billion-context`](https://github.com/ranxianglei/billion-context) via `bili omp` (built-in plugin) |
| **everything else** (no context hook) | [`billion-context`](https://github.com/ranxianglei/billion-context) — `bili <client>` (launcher, preferred) or `/bili/` prefix |

## Install

```bash
npm install -g billion-context
```

This installs the `bili` command (`bili-proxy` is kept as an alias).

## Quickstart

Two ways to use it — pick one:

- **Launcher (easiest):** one `bili <client>` command brings up the proxy and
  the client together — no real config file is ever touched.
- **URL change (persistent):** prefix your client's baseURL with the proxy
  origin + `/bili/`.

### Option 1 — Launcher (`bili pi` / `bili codex` / `bili claude` / `bili omp` / `bili opencode` / `bili hermes` / `bili dsh`)

The launcher wraps a client in one command: it starts a proxy on an
independent port (a fresh instance is always spawned — a port is never
reused), then points the client at it — **certificate-based MITM** where the
client honors proxy/CA env vars, or an isolated **`/bili/` config rewrite**
where it doesn't. No real config file is ever edited; the client's own
config is READ to discover which HTTPS upstream hosts it talks to, and those
hosts are whitelisted for MITM so the proxy can TLS-terminate exactly them
and blind-tunnel everything else.

```bash
bili pi                               # launch pi through the proxy
bili codex                            # launch codex through the proxy
bili claude                           # launch claude through the proxy
bili omp                              # pi-style: MITM env + persistent overlay home (~/.omp/agent-bili, real config untouched)
bili opencode                         # MITM for HTTPS + temp opencode.json (/bili/ for HTTP) + thin /acp plugin
bili hermes                           # no MITM possible (certifi CA) — persistent overlay home (~/.hermes-bili), all traffic /bili/
bili dsh                              # deepseek-harness: built-in deepseek route via DEEPSEEK_BASE_URL + overlay DSH_HOME (~/.dsh-bili), all traffic /bili/, native /acp command injected via --patch
bili pi --mitm-domain api.foo.com     # add a domain to the MITM whitelist
```

### Option 2 — URL change (`/bili/` prefix)

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

### Verify

With the proxy running and your config saved, check it answers and that your
first real request shows compression activity in the log:

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
- HTTP and HTTPS proxy origins are supported. SOCKS5 is not supported yet.
- Both outbound paths are covered: `/bili/` path-mode (fetch) AND MITM CONNECT
  tunnels (the proxy's connection to the real upstream goes through the HTTP
  CONNECT proxy).

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

## Status

Early. Protocol handling and compression work against mock tests (500+ passing). Real-model integration testing is the next milestone. Expect rough edges.

Client-side plugins for pi / omp / opencode ship inside `billion-context` (`dist/agent/*.js`) for the cooperative-proxy path. See the **"Which do I need?"** section above for how `billion-context`, the standalone `billion-context-pi`, and `opencode-acp` relate.

## License

MIT
