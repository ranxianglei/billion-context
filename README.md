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
- **Explicit context overrides:** declare per-URL context windows in a config
  file (or the web UI) for endpoints the registry doesn't know about, or when
  you want to pin an exact value. Routing is the same `/bili/` prefix either
  way — the config only changes which context window the proxy uses.

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

#### Examples by client

**OpenCode** — edit `~/.config/opencode/opencode.json`, change the provider's `baseURL`:
```jsonc
// before:
"baseURL": "https://open.bigmodel.cn/api/coding/paas/v4"
// after (just prepend the proxy origin + /bili/):
"baseURL": "http://localhost:8787/bili/https://open.bigmodel.cn/api/coding/paas/v4"
```

**Codex** — edit `~/.codex/config.toml`, change the provider's `base_url`:
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

**Other clients (Cursor / Aider / Continue …)** — wherever the upstream URL is
configured, prepend `http://localhost:8787/bili/` to it. Nothing else changes.

### Option B — Explicit context windows (config file)

Zero-config (Option A) already auto-detects context windows from
[models.dev](https://models.dev). You only need a config file when you want to
**override** that — e.g. a private relay behind a fixed limit, or a model that
isn't in the registry yet.

Three steps: **start the proxy → declare context overrides → point your client at it**.

### Step 1 — Start the proxy

```bash
bili
```

It listens on `http://127.0.0.1:8787`. Keep this terminal open (or run in the
background; see [Running the proxy](#running-the-proxy)).

Click [http://localhost:8787/__bili/](http://localhost:8787/__bili/) to add your models:
<img width="2908" height="1787" alt="image" src="https://github.com/user-attachments/assets/cacf4b64-e5c6-41f2-b270-fd2be02eab0c" />

On first run `bili` **auto-creates an empty config file** and tells you where,
so you don't have to invent the schema from scratch. The startup banner prints
the web UI URL too:

```
acp-proxy listening on http://localhost:8787 — web UI: http://localhost:8787/__bili/
```

### How routing works

There is **one** routing mode: the `/bili/` prefix. The client embeds the
full upstream URL right there, and the proxy forwards to it verbatim:

```
client baseURL:  http://localhost:8787/bili/https://open.bigmodel.cn/api/coding/paas/v4
                  └──────────┬──────────┘└────┬────┘└────────────────┬───────────────────────┘
                      proxy host       /bili/        upstream URL (forwarded as-is)
```

The config file does **not** change routing. It only tells the proxy the
context window for a given upstream URL + model, so it knows when to compress.
The key is the same upstream URL string the client puts after `/bili/`:

```jsonc
{
  "providers": {
    "https://open.bigmodel.cn/api/coding/paas/v4": {
      "models": { "glm-5.2": { "context": 1000000 } }
    }
  }
}
```

A request matches a key when the client's embedded URL **equals the key or
starts with it** (longest key wins). A shallow key like
`https://open.bigmodel.cn` overrides every path on that host; a deep key like
`https://open.bigmodel.cn/api/anthropic` overrides only that endpoint. Models
not listed in any matching key fall back to models.dev, then the built-in
prefix table.

### Step 2 — Declare context overrides

The web UI's **Providers** tab lets you add an upstream URL and its per-model
context windows in a form, then **Save** (writes the config file) and **Apply**
(hot-reload into the running proxy, no restart).
<img width="2931" height="1519" alt="image" src="https://github.com/user-attachments/assets/c02278be-bc7a-4f14-8f58-0f2d83784d54" />

> Prefer editing the JSON directly? See [Manual config file](#manual-config-file).
Full schema is in [Configuration](#configuration).

After Save + Apply the startup banner reflects it:

```
acp-proxy listening on http://localhost:8787 — web UI: http://localhost:8787/__bili/ — context overrides for 2 upstream URL(s)
```

### Step 3 — Point your client at the proxy

Edit the client's own config file so it sends requests to
`http://localhost:8787/bili/<full-upstream-url>`. Put your **real** API key in
the client's config too — the proxy passes it through untouched.

#### Pi (billion-context-pi)

Open `~/.pi/agent/models.json` and change your existing provider's **`baseUrl` line** — just prepend the proxy origin + `/bili/` to the real URL, leave every other field alone:

```jsonc
// before:
"baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
// after:
"baseUrl": "http://localhost:8787/bili/https://open.bigmodel.cn/api/coding/paas/v4",
```

`http://localhost:8787/bili/` is the proxy; everything after it is the real
upstream URL, forwarded as-is. `apiKey`, `api`, and `models` stay unchanged.

| `api` value | upstream |
|---|---|
| `openai-completions` | an OpenAI-compatible endpoint (GLM/DeepSeek/OpenAI) |
| `anthropic-messages` | an Anthropic-compatible endpoint |

> If you use the `billion-context-pi` extension, run Pi in an isolated agent
dir (`PI_CODING_AGENT_DIR=…`) so the client-side extension doesn't double-
compress alongside the proxy. The `bili-test-pi` helper does this for you.

#### OpenCode

Open `~/.config/opencode/opencode.json` and change your existing provider's **`baseURL` line** — prepend the proxy origin + `/bili/`:

```jsonc
// before:
"baseURL": "https://open.bigmodel.cn/api/coding/paas/v4"
// after:
"baseURL": "http://localhost:8787/bili/https://open.bigmodel.cn/api/coding/paas/v4"
```

Everything else (`apiKey`, `models`) stays unchanged.

#### Codex

Open `~/.codex/config.toml` and change your existing provider's **`base_url` line** — prepend the proxy origin + `/bili/`:

```toml
# before:
base_url = "https://open.bigmodel.cn/api/coding/paas/v4"
# after:
base_url = "http://localhost:8787/bili/https://open.bigmodel.cn/api/coding/paas/v4"
```

Everything else (`name`, `wire_api`, `env_key`) stays unchanged.

> Codex's Responses API needs an upstream that speaks the Responses protocol.
> Most regional OpenAI-compatible endpoints only speak `/chat/completions`; if
> yours 404s on `/responses`, use a relay that speaks Responses, or the
> official OpenAI API.

#### Other clients (Cursor / Aider / Continue …)

If the client lets you set a base URL, prepend `http://localhost:8787/bili/`
to it. The proxy speaks the Anthropic, OpenAI chat-completions, and OpenAI
Responses protocols — any client using one of those works. A client using a
different protocol or a non-standard auth header won't work yet.

### Web UI

Open `http://localhost:8787/__bili/` in a browser while the proxy is running. You can:

- **Edit providers** in a form (add/remove providers and per-model context windows) and save — this writes to `billion-context.json` directly.
- **Generate client URLs** — pick an upstream URL, get ready-to-copy config snippets for Pi / OpenCode / Codex (the `baseUrl`/`baseURL`/`base_url` line with the proxy origin + `/bili/` + the URL filled in).
- **View sessions** — live table of active sessions (requests, tokens saved, last seen), auto-refreshing.

Use the **Apply** button to hot-reload provider routes into the running
process without restarting (only `port`/`host` require a restart, since the
listen socket is already bound).

### Manual config file

Prefer editing JSON by hand — for git-managed configs, scripted deployments, or
if you just don't want to use the browser? The web UI writes to the same file,
so you can edit it directly with identical results.

Open `~/.config/billion-context/billion-context.json` and edit the `providers`
block. **The key is the upstream URL** — the same string the client puts after
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

After saving, click **Apply** in the web UI (or **restart `bili`**). (Full
schema — per-model context windows, optional fields — is in
[Configuration](#configuration).)

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

Routing is always the `/bili/` prefix (see [How routing works](#how-routing-works)).
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
