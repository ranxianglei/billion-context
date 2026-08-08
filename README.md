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

Three steps: **start the proxy → edit the config file → point your client at it**.
Compression is injected automatically — you only configure routing, never
compression itself.

### Step 1 — Start the proxy

```bash
bili
```

It listens on `http://127.0.0.1:8787`. Keep this terminal open (or run in the
background; see [Running the proxy](#running-the-proxy)).

On first run `bili` **auto-creates a template config file** and tells you where,
so you don't have to invent the schema from scratch:

```
[acp-config] created config template at ~/.config/billion-context/billion-context.json — edit it with your providers, then restart
```

### How routing works

The proxy routes by a **provider name in the URL path** — the first path
segment after the host. It strips the name and forwards the rest to that
provider. Everything after the name is passed through untouched:

```
client baseURL:  http://localhost:8787/zhipu/api/coding/paas/v4
                  └──────────┬──────────┘└────────┬────────┘
                      proxy host           remaining path
                      + provider name      (forwarded as-is)
```

This is why Step 2 has you declare named providers, and Step 3 has you put that
same name at the start of the client's base URL — it's how the proxy knows where
to send each request. In the config below, `zhipu` corresponds to:
```json
    "zhipu": {
      "url": "https://open.bigmodel.cn",
      "models": {
        "glm-5.2": { "context": 1000000, "output": 131072 }
      }
```

### Step 2 — Edit the config file

Open the file from Step 1 (`~/.config/billion-context/billion-context.json`)
and edit the `providers` block to match what you pay for. Each entry is a
**name → URL** mapping; the name is what you'll put in the client's base URL in
Step 3.

```json
{
  "providers": {
    "zhipu": {
      "url": "https://open.bigmodel.cn",
      "models": {
        "glm-5.2": { "context": 1000000, "output": 131072 }
      }
    },
    "anthropic": "https://api.anthropic.com"
  }
}
```

- Delete providers you don't use.
- Add others (e.g. `"deepseek": "https://api.deepseek.com"`).
- The API key is **not** here — it lives in the client; the proxy passes it
  through untouched.

After saving, **restart `bili`**. The startup banner lists your routes:

```
acp-proxy listening on http://127.0.0.1:8787 — routes: anthropic=https://api.anthropic.com, zhipu=https://open.bigmodel.cn
```

That confirms the proxy picked up your config. (Full schema — per-model context
windows, optional fields — is in [Configuration](#configuration).)

### Step 3 — Point your client at the proxy

Edit the client's own config file so it sends requests to
`http://localhost:8787/<provider>/...` (the provider name from Step 2 as the
first path segment). Put your **real** API key in the client's config too —
the proxy passes it through untouched.

#### Pi (billion-context-pi)

Open `~/.pi/agent/models.json` and change your existing provider's **`baseUrl` line** to point at the proxy — leave every other field alone:

```jsonc
// before:
"baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
// after (swap the host for the proxy + the provider name you picked):
"baseUrl": "http://localhost:8787/zhipu/api/coding/paas/v4",
```

`http://localhost:8787` is the proxy, `zhipu` is the name from Step 2, and the remaining path `/api/coding/paas/v4` is forwarded as-is to Zhipu. `apiKey`, `api`, and `models` stay unchanged.

| `api` value | `baseUrl` should point at |
|---|---|
| `openai-completions` | an OpenAI-compatible endpoint (GLM/DeepSeek/OpenAI) → `…/zhipu/...` |
| `anthropic-messages` | an Anthropic-compatible endpoint → `…/anthropic` |

> If you use the `billion-context-pi` extension, run Pi in an isolated agent
dir (`PI_CODING_AGENT_DIR=…`) so the client-side extension doesn't double-
compress alongside the proxy. The `bili-test-pi` helper does this for you.

#### OpenCode

Open `~/.config/opencode/opencode.json` and change your existing provider's **`baseURL` line** to point at the proxy:

```jsonc
// before:
"baseURL": "https://open.bigmodel.cn/api/coding/paas/v4"
// after:
"baseURL": "http://localhost:8787/zhipu/api/coding/paas/v4"
```

Everything else (`apiKey`, `models`) stays unchanged. For an Anthropic provider, change `baseURL` to `http://localhost:8787/anthropic`.

#### Codex

Open `~/.codex/config.toml` and change your existing provider's **`base_url` line** to point at the proxy:

```toml
# before:
base_url = "https://open.bigmodel.cn/api/coding/paas/v4"
# after:
base_url = "http://localhost:8787/zhipu/api/coding/paas/v4"
```

Everything else (`name`, `wire_api`, `env_key`) stays unchanged.

> Codex's Responses API needs an upstream that speaks the Responses protocol.
> Most regional OpenAI-compatible endpoints only speak `/chat/completions`; if
> yours 404s on `/responses`, use a relay that speaks Responses, or the
> official OpenAI API.

#### Other clients (Cursor / Aider / Continue …)

Not yet supported. The proxy currently speaks the Anthropic, OpenAI
chat-completions, and OpenAI Responses protocols — if your client uses a
different protocol or a non-standard auth header, it won't work yet.

### Verify

With the proxy running and your config saved, check it answers and that your
first real request shows compression activity in the log:

```bash
# Health check (proxy up + where it forwards)
curl -s http://localhost:8787/__acp/health
# → {"ok":true,"upstream":"https://api.anthropic.com"}

# Live session stats (after a real request)
curl -s http://localhost:8787/__acp/stats
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
    "zhipu": {
      "url": "https://open.bigmodel.cn",
      "models": {
        "glm-5.2": { "context": 1000000, "output": 131072 },
        "glm-5.1": { "context": 200000, "output": 131072 }
      }
    },
    "anthropic": "https://api.anthropic.com",
    "deepseek": "https://api.deepseek.com"
  }
}
```

### Top-level keys

| Key | Default | Description |
|------|---------|-------------|
| `port` | `8787` | Proxy listen port |
| `host` | `127.0.0.1` | Proxy listen host |
| `upstream` | `https://api.anthropic.com` | Default upstream when no route matches |
| `sessionHeader` | `x-acp-session` | Header name clients may send to identify a conversation |
| `log` | `true` | Enable request logging |
| `debug` | `false` | Verbose logging (same as `ACP_DEBUG=1`) |
| `passthrough` | `false` | Forward without compression (same as `ACP_PASSTHROUGH=1`) |
| `providers` | *(none)* | Provider routes — see below |
| `compress` | *(see defaults)* | `{ injectTool, injectNudge }` |

> **Choosing a `host`** (IPv6 / containers): the default `127.0.0.1` is
> IPv4-only and loopback-only. Use `--host ::` (or `"host": "::"`) to listen
> on **both** IPv4 and IPv6, which matters if your client resolves
> `localhost` to `::1` first (some `/etc/hosts` files list `::1` before
> `127.0.0.1`). Inside a **container**, `127.0.0.1` binds the container's own
> loopback and is unreachable through a published port — use
> `--host 0.0.0.0` there. ⚠️ `0.0.0.0` / `::` expose the proxy on **all**
> interfaces; ensure you're on a trusted network or behind a firewall.

### Providers (URL routing + per-model context)

`providers` maps a route name to either a bare URL string (simple) or an
object with `url` + optional per-model context window (recommended).

**Simple form** — provider name → URL:
```json
{ "deepseek": "https://api.deepseek.com" }
```

**Full form** — provider name → `{ url, models }`:
```json
{
  "zhipu": {
    "url": "https://open.bigmodel.cn",
    "models": {
      "glm-5.2": { "context": 1000000, "output": 131072 },
      "glm-5.1": { "context": 200000 }
    }
  }
}
```

The same model can have a different context window behind different providers
(e.g. relay wraps a model with a larger window). `context` is the **input
context limit** (used by the compressor to decide when to nudge); `output` is
the max output tokens. Both are optional; missing values fall back to the
built-in model table, then to `modelContextLimit`.

> **Why declare context at all?** The LLM `/models` API does **not** return
> context windows (verified across OpenAI, Anthropic, 智谱, comfly). They are
> document-level information. A wrong value (e.g. GLM-5.2 guessed as 128K
> instead of 1M) causes spurious frequent compression. Declaring it per
> provider + model makes the proxy match the registry the client itself uses.

**API keys are never stored in the proxy** — whatever key the agent sends is
passed through untouched to the upstream.

### Provider name rules

- Must start with a letter, contain only letters/digits/`-`/`_`.
- Reserved words (`v1`, `chat`, `completions`, `messages`, `models`, `api`)
  are rejected to avoid colliding with real API path segments.
- The provider name can appear anywhere in the path; the longest match wins.
- With **no providers** declared (e.g. you emptied the `providers` block),
  every request is forwarded to the default `upstream` with its full path —
  an edge case, not the normal flow.

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

Early. Protocol handling and compression work against mock tests (141 passing). Real-model integration testing is the next milestone. Expect rough edges.

See [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) for the pi-extension mode (in-process, tighter integration, the reference implementation).

## License

MIT
