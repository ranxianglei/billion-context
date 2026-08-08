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

## Usage

### Start the proxy

```bash
bili
```

That's it. The proxy reads its config from `~/.config/billion-context/billion-context.json` (XDG) and listens on `127.0.0.1:8787`. If no config file exists yet, it uses sensible defaults and logs where it expects the file.

### Quick overrides (flags)

```bash
bili --port 9000              # change listen port
bili --host 0.0.0.0           # listen on all interfaces
bili --debug                 # verbose logging (also: set "debug": true in config)
bili --passthrough           # forward without compression (smoke-test mode)
bili --config ~/my-bili.json # use a different config file
```

Flags override the config file and env vars. `bili --help` lists them all.

### Point your agent at the proxy

The proxy routes by a **provider name in the URL path**. Set your agent's base URL to `http://localhost:8787/<provider>/...` and the proxy forwards to that provider (see [Configuration](#configuration) for how providers are declared).

#### Claude Code (Anthropic)

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787/anthropic
export ANTHROPIC_API_KEY=sk-ant-...   # real key — passed through as-is
claude
```

#### Codex / any OpenAI-compatible agent (zhipu / openai / deepseek)

```bash
export OPENAI_BASE_URL=http://localhost:8787/zhipu/api/coding/paas/v4
export OPENAI_API_KEY=<your real glm key>   # passed through as-is
codex
```

The `/zhipu/...` prefix tells the proxy to route to the `zhipu` provider; the
remaining path is preserved.

#### Cursor / Aider / others

Set the base URL to `http://localhost:8787/<provider>` in the agent's settings.

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
bili start                # logs → ~/.local/state/billion-context/bili.log + terminal
bili update               # (see below)
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

```bash
bili update          # check & install now (manual, bypasses 3min throttle)
bili --no-auto-update   # disable self-update for this run
```

Disable permanently via config (`"autoUpdate": false`) or env
(`ACP_AUTO_UPDATE=0`).

## Configuration

Configuration is read from a JSON file with env-var overrides. Priority:
**env var > config file > built-in default**.

### Config file

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

### Routing

Point any agent at the proxy using a provider name as a path segment. The
proxy strips the name and forwards to that provider's root URL.

```
agent baseURL:  http://localhost:8787/zhipu/api/coding/paas/v4
                 └──────────┬──────────┘└────────┬────────┘
                     proxy host           remaining path
                     + provider name      (forwarded as-is)
```

#### Claude Code (Anthropic)

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787/anthropic
export ANTHROPIC_API_KEY=sk-ant-...   # real key — passed through as-is
claude
```

#### Codex / any OpenAI-compatible agent (zhipu / openai / deepseek)

```bash
export OPENAI_BASE_URL=http://localhost:8787/zhipu/api/coding/paas/v4
export OPENAI_API_KEY=<your real glm key>   # passed through as-is
codex
```

The `/zhipu/...` prefix tells the proxy to route to the `zhipu` provider; the
remaining `/api/coding/paas/v4/...` path is preserved.

### Environment variables (override the config file)

Every config key has an env-var override. Set to override the file value.

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
| `ACP_CONDENSE_ENABLED` | `1` | Set `0` to disable tool-result condensing |
| `ACP_KEEP_RECENT_TOOL_RESULTS` | `6` | Tool results kept verbatim before condensing |
| `ACP_MIN_CHARS_TO_CONDENSE` | `1500` | Condense tool results longer than this |
| `ACP_MAX_KEPT_CHARS` | `400` | Max chars kept when condensing a tool result |
| `ACP_DEBUG` | `0` | Set `1` for verbose logging |
| `ACP_PASSTHROUGH` | `0` | Set `1` to forward without compression |
| `ACP_DUMP_SSE` | *(none)* | Directory to dump SSE for debugging |
| `BILI_PERSIST` | `1` | Set `0` to disable session persistence (in-memory only, lost on restart) |
| `BILI_PERSIST_DEBOUNCE_MS` | `500` | Debounce window for writes to disk (ms) |
| `BILI_MAX_SESSIONS` | `256` | Max sessions held in memory (LRU eviction; disk is source of truth) |
| `BILI_SESSIONS_DIR` | *(XDG data dir)* | Directory for persisted session state |

### Notes on provider names

- Must start with a letter, contain only letters/digits/`-`/`_`.
- Reserved words (`v1`, `chat`, `completions`, `messages`, `models`, `api`)
  are rejected to avoid colliding with real API path segments.
- The provider name can appear anywhere in the path; the longest match wins.

### Session identity

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
