[English](./README.md) | [中文](./README.zh-CN.md)

# billion-context

Universal context-compression proxy for AI coding agents.

`billion-context` sits between **any** agent and its model API, rewriting Anthropic/OpenAI streams with [acp-kernel](https://github.com/ranxianglei/acp-kernel) compression. Any agent that can set a base URL works out of the box — **zero per-agent adapter code**.

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

## Install

```bash
npm install -g billion-context
```

This installs the `bili` command (`bili-proxy` is kept as an alias).

## Quickstart

Two ways to use it — pick one:

- **Zero-config (simplest):** prefix your client's baseURL with the proxy
  origin + `/bili/`. No config file needed — context windows are auto-detected
  from the [models.dev](https://models.dev) registry. The `/bili/` prefix also
  doubles as a self-detection signal: billion-context client extensions
  (billion-context-pi / opencode-acp) can recognize it in their own baseUrl
  and self-disable, so you never get double compression.
- **Explicit context-window overrides:** declare per-URL context windows in a
  config file (or the web UI) for endpoints the registry doesn't know about,
  or when you want to pin an exact value. Routing is the same `/bili/` prefix
  either way — the config only changes which context window the proxy uses.

Compression is injected automatically — you only configure routing, never
compression itself.

### Option A — Zero-config (`/bili/` prefix)

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

#### A. API-key clients (`/bili/` prefix)

Clients you configure with an **API key** (not a login) let you change the
upstream URL. Just prepend `http://localhost:8787/bili/` to it — that's the
only change.

**OpenCode** — edit `~/.config/opencode/opencode.json`, change the provider's `baseURL`:
```jsonc
// before:
"baseURL": "https://open.bigmodel.cn/api/coding/paas/v4"
// after (just prepend the proxy origin + /bili/):
"baseURL": "http://localhost:8787/bili/https://open.bigmodel.cn/api/coding/paas/v4"
```

**Codex (API key)** — edit `~/.codex/config.toml`, change the provider's `base_url`:
```toml
# before:
base_url = "https://api.openai.com/v1"
# after:
base_url = "http://localhost:8787/bili/https://api.openai.com/v1"
```

**Pi** — edit `~/.pi/agent/models.json`, change the provider's `baseUrl`:
```jsonc
// before:
"baseUrl": "https://api.anthropic.com"
// after:
"baseUrl": "http://localhost:8787/bili/https://api.anthropic.com"
```

**Other API-key clients (Cursor / Aider / Continue …)** — wherever the
upstream URL is configured, prepend `http://localhost:8787/bili/` to it.
Nothing else changes.

#### B. Login/subscription clients (MITM transparent proxy)

Clients you sign **into an account** (ChatGPT Plus/Pro, Claude, ZCode coding
plan, …) authenticate via **OAuth and hardcode the endpoint** — you can't
change the baseURL, so the `/bili/` prefix trick doesn't work. These need
**MITM transparent-proxy mode** instead.

Supported login clients:

| Client | Login | Endpoint hardcoded | Status |
|---|---|---|---|
| **ZCode** | bigmodel coding plan (OAuth) | `open.bigmodel.cn` (builtin provider) | ✅ tested |
| **Codex** | ChatGPT account (OAuth) | `chatgpt.com/backend-api` | ❓ untested (may not work — needs verification) |
| **Claude Code** | Claude subscription (OAuth) | `api.anthropic.com` | ❓ untested (may not work — needs verification) |

How MITM mode works: the client only offers an **HTTP proxy** setting, so it
sends `CONNECT <host>:443`; billion-context terminates the TLS locally (with a
locally-generated root CA), injects compression into the cleartext, then
re-encrypts and forwards. The OAuth token travels in the client's
`Authorization` header, which is forwarded untouched — so the subscription
discount is preserved.

MITM is on by default and is scoped to a **whitelist** of model hosts
(`open.bigmodel.cn`, `api.anthropic.com`, `api.openai.com`, `chatgpt.com`).
All other HTTPS hosts are blind-tunnelled — billion-context never decrypts
non-model traffic.

**One-time setup (trust the root CA in the client):**

1. Start the proxy once to generate the root CA:
   ```bash
   bili start
   ls ~/.local/share/billion-context/ca/root-ca.pem   # exists now
   ```

2. In the client's **Settings → Network / Proxy** set:
   - **HTTP Proxy**: `http://127.0.0.1:8787`
   - **Proxy CA certificate path**: `~/.local/share/billion-context/ca/root-ca.pem`
   - (optional) **No-proxy list**: `localhost,127.0.0.1`
   - (For ZCode specifically: **Settings → Network**. For Codex/Claude Code:
     set the `HTTPS_PROXY` env var and `NODE_EXTRA_CA_CERTS` to the CA path.)

3. Restart the client. Its model traffic now flows through billion-context
   with compression injected. Send a message and check the proxy log
   (`~/.local/state/billion-context/bili.log`) for
   `mitm <host>:443 tunnel established`.

> The root CA is generated locally and lives only on this machine; it is
> **not** a system-wide install. Only the client you configure (via the
> CA-path setting, which it feeds to Node as `NODE_EXTRA_CA_CERTS`) trusts it,
> so no other app is affected. Deleting the CA files and restarting the proxy
> regenerates them.

### Option B — Manual config file & context windows

Open `~/.config/billion-context/billion-context.json` and edit the `providers`
block. **The key is the upstream URL** — the string the client puts after
`/bili/`. The value declares per-model context windows for that URL:

```json
{
  "providers": {
    "https://open.bigmodel.cn/api/coding/paas/v4": {
      "models": { "glm-5.2": { "context": 1000000 } }
    },
    "https://api.anthropic.com": {}
  }
}
```

- A key matches when the client's embedded URL equals it or starts with it
  (longest key wins). A bare host key covers every path on that host.
- An empty value `{}` means "this URL exists, no overrides" (context windows
  come from models.dev / the prefix table).
- Delete entries you don't use; add others as needed.
- The API key is **not** here — it lives in the client; the proxy passes it
  through untouched.

### Option C — Web UI & context windows

Open [http://localhost:8787/__bili/](http://localhost:8787/__bili/) to
configure.

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

The proxy is configured via **environment variables** (the recommended way
for most setups) **or** a JSON config file. Both are fully supported; pick one.
Priority (highest wins): **CLI flag > env var > config file > built-in default**.

- **Env vars** — quickest, great for a single provider, easy to script
  (`.env`, systemd unit, docker `--env`). Just `export ACP_…` and run `bili`.
- **JSON file** — better when you have many providers with per-model context
  windows (the only place to declare those). A handful of keys (notably
  `providers.*.models` context windows) have no env equivalent.

Both can coexist: env vars override individual file keys.

### Environment variables (recommended)

Every config key has an env override. Set to override the file value (or to run
with no file at all).

| Env | Default | Description |
|-----|---------|-------------|
| `ACP_PORT` / `PORT` | `8787` | Listen port |
| `ACP_HOST` | `127.0.0.1` | Listen host |
| `ACP_UPSTREAM` | `https://api.anthropic.com` | Default upstream |
| `ACP_PROVIDERS` | *(none)* | Path to a legacy providers JSON file (overrides `providers` in config) |
| `ACP_MODEL_CONTEXT_LIMIT` | `200000` | Global fallback context window (only used when no provider/model match) |
| `ACP_SESSION_HEADER` | `x-acp-session` | Conversation-id header name |
| `ACP_COMPRESS_TOOL` | `1` | Set `0` to disable injecting the compress tool |
| `ACP_COMPRESS_NUDGE` | `1` | Set `0` to disable compression nudges |
| `ACP_DEBUG` | `0` | Set `1` for verbose logging |
| `ACP_PASSTHROUGH` | `0` | Set `1` to forward without compression |
| `ACP_AUTO_UPDATE` | `1` | Set `0` to disable background self-update |
| `ACP_LOG_FILE` | *XDG state path* | Log file path (`off` disables the file, keeps stderr) |
| `ACP_DUMP_SSE` | *(none)* | Directory to dump SSE for debugging |
| `BILI_PERSIST` | `1` | Set `0` to disable session persistence (in-memory only, lost on restart) |
| `BILI_PERSIST_DEBOUNCE_MS` | `500` | Debounce window for writes to disk (ms) |
| `BILI_MAX_SESSIONS` | `256` | Max sessions held in memory (LRU eviction; disk is source of truth) |
| `BILI_SESSIONS_DIR` | *(XDG data dir)* | Directory for persisted session state |

### Config file (optional)

Location (XDG Base Directory):

- **Linux:** `~/.config/billion-context/billion-context.json`
- Override with `XDG_CONFIG_HOME` or `BILI_CONFIG_FILE`

The config file is a single JSON object. Example:

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "providers": {
    "https://open.bigmodel.cn/api/coding/paas/v4": {
      "models": {
        "glm-5.2": { "context": 1000000 },
        "glm-5.1": { "context": 200000 }
      }
    },
    "https://api.deepseek.com": {}
  }
}
```

### Top-level keys

| Key | Default | Description |
|------|---------|-------------|
| `port` | `8787` | Proxy listen port |
| `host` | `127.0.0.1` | Proxy listen host |
| `sessionHeader` | `x-acp-session` | Header name clients may send to identify a conversation |
| `log` | `true` | Enable request logging |
| `debug` | `false` | Verbose logging (same as `ACP_DEBUG=1`) |
| `passthrough` | `false` | Forward without compression (same as `ACP_PASSTHROUGH=1`) |
| `providers` | *(none)* | Per-URL context overrides — see below |
| `compress` | *(see defaults)* | `{ injectTool, injectNudge }` |

> **Choosing a `host`** (IPv6 / containers): the default `127.0.0.1` is
> IPv4-only and loopback-only. Use `--host ::` (or `"host": "::"`) to listen
> on **both** IPv4 and IPv6, which matters if your client resolves
> `localhost` to `::1` first (some `/etc/hosts` files list `::1` before
> `127.0.0.1`). Inside a **container**, `127.0.0.1` binds the container's own
> loopback and is unreachable through a published port — use
> `--host 0.0.0.0` there. ⚠️ `0.0.0.0` / `::` expose the proxy on **all**
> interfaces; ensure you're on a trusted network or behind a firewall.

### Providers (per-URL context overrides)

Routing is always the `/bili/` prefix (see [Option A](#option-a--zero-config-bili-prefix)).
The `providers` block only declares **context-window overrides** keyed by
upstream URL. The key is the same string the client puts after `/bili/`:

```json
{
  "providers": {
    "https://open.bigmodel.cn/api/coding/paas/v4": {
      "models": {
        "glm-5.2": { "context": 1000000 },
        "glm-5.1": { "context": 200000 }
      }
    },
    "https://api.deepseek.com": {}
  }
}
```

The same model can have a different context window behind different upstreams
(e.g. a relay wraps a model with a larger window). `context` is the **input
context limit** (used by the compressor to decide when to nudge). It is
optional; missing values fall back to the [models.dev](https://models.dev)
registry, then the built-in prefix table.

> **Why declare context at all?** The LLM `/models` API does **not** return
> context windows (verified across OpenAI, Anthropic, 智谱, comfly). They are
> document-level information. A wrong value (e.g. GLM-5.2 guessed as 128K
> instead of 1M) causes spurious frequent compression. Declaring it per
> URL + model makes the proxy match the registry the client itself uses.

### URL key matching rules

- A request matches a key when the client's embedded URL **equals the key or
  starts with it** (longest key wins).
- A shallow key like `https://open.bigmodel.cn` overrides every path on that
  host; a deep key like `https://open.bigmodel.cn/api/anthropic` overrides
  only that endpoint.
- Keys never cross hosts (the boundary check requires a `/` or end-of-string
  after the key), so `https://x.com` does not match `https://x.com.evil`.
- Models not covered by any matching key fall back to models.dev, then the
  prefix table, then `modelContextLimit`.

**API keys are never stored in the proxy** — whatever key the agent sends is
passed through untouched to the upstream.

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

Early. Protocol handling and compression work against mock tests (146 passing). Real-model integration testing is the next milestone. Expect rough edges.

See [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) for the pi-extension mode (in-process, tighter integration, the reference implementation).

## License

MIT
