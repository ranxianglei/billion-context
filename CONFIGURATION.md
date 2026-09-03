# billion-context Configuration Reference

[English](./CONFIGURATION.md) | [中文](./CONFIGURATION.zh-CN.md)

`billion-context` is an HTTP proxy that injects [ACP](https://github.com/ranxianglei/acp-kernel) (Active Context Pruning) context compression into LLM API streams. Every option below lives in a single JSON config file (or an equivalent environment variable / CLI flag).

---

## Config File Locations

| Scope | Path | Notes |
|-------|------|-------|
| **Config file (Linux)** | `~/.config/billion-context/billion-context.json` | XDG Base Directory — the canonical, user-editable config |
| **Config file (override)** | value of `XDG_CONFIG_HOME` | relocates the whole config dir |
| **Config file (explicit)** | value of `BILI_CONFIG_FILE` | points directly at any JSON file |
| **CLI flag** | `--config <FILE>` | same as `BILI_CONFIG_FILE`; highest precedence for the file path |
| **Session data** | `~/.local/share/billion-context/sessions/` | persisted compression state, grows over time |

On first run, `billion-context` seeds an empty template (`{ "providers": {} }`) at the config path so you have something to edit. It never overwrites an existing file.

The config file is a pure override layer — every field is optional. Anything unset falls through to the built-in default.

---

## Quick Start

```jsonc
// ~/.config/billion-context/billion-context.json
{
  // Server
  "port": 8787,
  "host": "127.0.0.1",

  // Route two providers
  "providers": {
    "https://api.anthropic.com": {
      "models": {
        "claude-sonnet-4-5": { "context": 200000, "output": 8192 }
      }
    },
    "https://generativelanguage.googleapis.com": {
      "models": {
        "gemini-2.5-pro": { "context": 1000000 }
      }
    }
  },

  // Global compression tuning (applies to every request)
  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%"
  }
}
```

---

## Parameter Reference

Status legend: **ACTIVE** = currently used | **DEPRECATED** = accepted but no effect | **EXPERIMENTAL** = may change

---

## Server Settings

Top-level keys that control how the proxy listens and behaves globally.

### `port`

- **Type:** `number`
- **Default:** `8787`
- **Status:** ACTIVE
- **Description:** TCP port the proxy listens on. Must be an integer between 1 and 65535. Overridden by the `ACP_PORT` (or `PORT`) environment variable, or the `--port` CLI flag. An invalid value aborts startup.

### `host`

- **Type:** `string`
- **Default:** `127.0.0.1`
- **Status:** ACTIVE
- **Description:** Network interface the proxy binds to. `127.0.0.1` (default) listens only on localhost — safe for a local sidecar. Use `::` for IPv4 + IPv6 dual-stack. Use `0.0.0.0` (or a LAN IP) to expose the proxy to other machines — typically inside a container or on a trusted LAN: remote agents then point their model `baseURL` at `http://<this-host>:<port>/bili/…`, and MITM-mode `CONNECT` accepts remote clients for whitelisted model hosts only (blind tunnels stay loopback-only, and `/__bili/` management endpoints remain loopback-only). There is no authentication — ensure the surrounding network is trusted. Overridden by `ACP_HOST` / `--host`.

### `sessionHeader`

- **Type:** `string`
- **Default:** `x-acp-session`
- **Status:** ACTIVE
- **Description:** Name of the HTTP request header clients may send to identify a conversation. Requests carrying the same value share compression state across calls. Overridden by `ACP_SESSION_HEADER`.

### `log`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** Enable per-request logging. Set `false` (or `ACP_LOG=0`) to silence the standard request log.

### `debug`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** Verbose logging — equivalent to setting `ACP_DEBUG=1`. Useful for diagnosing routing or compression behaviour.

### `passthrough`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** Forward every request to the upstream **without** compression, tool injection, or nudging. Equivalent to `ACP_PASSTHROUGH=1`. Handy for A/B comparison against the uncompressed baseline.

### `proxy`

- **Type:** `string`
- **Default:** *(none — no upstream proxy)*
- **Status:** ACTIVE
- **Description:** Upstream HTTP proxy (`http://host:port`) used for the proxy's **own** outbound connections to model providers. SOCKS5 is not supported. A per-URL `proxy` set inside a `providers` entry overrides this for that provider. An empty string means "explicitly direct" — it disables any environment/system proxy fallback for all providers.

---

## Providers

The `providers` block maps **upstream URLs** to per-provider configuration. Each key is a URL prefix; each value can declare model context windows, a per-provider proxy, a compression protocol, and compression overrides.

```jsonc
{
  "providers": {
    "https://api.anthropic.com": {
      "models": {
        "claude-sonnet-4-5": { "context": 200000, "output": 8192 }
      },
      "proxy": "http://10.0.0.1:7890",
      "compressProtocol": "tools",
      "compress": { "maxContextLimit": "70%" }
    }
  }
}
```

### URL key matching

Keys are matched against the request's upstream URL by **longest-prefix wins**. A key matches if the request URL equals the key, or starts with `key + "/"`. This makes matching boundary-safe: a key `https://api.example.com` matches `https://api.example.com/v1/chat` but does **not** match `https://api.example.com.evil` (an attacker-controlled lookalike host).

A shallow key (`https://open.bigmodel.cn`) matches every path on that host. A deep key (`https://open.bigmodel.cn/api/anthropic`) matches only that endpoint. When two keys both match, the longest (most specific) one wins. Trailing slashes on keys are stripped automatically.

### `models`

- **Type:** `Record<string, { context?: number; output?: number; compress?: CompressSettings }>`
- **Default:** *(none)*
- **Status:** ACTIVE
- **Description:** Maps a model name to its context-window declaration. The LLM `/models` endpoint does **not** return context windows (verified across OpenAI, Anthropic, zhipu, comfly), so the proxy cannot discover them at runtime. `context` is the model's context window in tokens; `output` is the max output size.

  **Resolution order (first match wins):** (1) per-request sources — the client's `anthropic-beta` larger-context negotiation, a cooperative plugin's report, and the launcher's per-model windows; (2) this per-model `context` declaration; (3) the **warm** models.dev registry cache, when the model is listed (relay/private hosts match the bare model name against the registry's provider-prefixed entries); (4) the built-in context table. So this per-model `context` declaration **outranks the registry** — set it to the window your relay/private deployment actually serves, and it wins even when models.dev lists a different (usually larger) window for the model. `compress.modelContextLimit` remains the highest-priority source (always wins) when you want to pin the window across every route. Each model entry may also carry a per-model `compress` block (see [Compression Tuning](#compression-tuning)).

### `proxy`

- **Type:** `string`
- **Default:** *(inherits top-level `proxy`)*
- **Status:** ACTIVE
- **Description:** Per-provider upstream HTTP proxy (`http://host:port`). Overrides the top-level `proxy` for this provider only. An empty string means "explicitly direct" — override the global proxy with no proxy for this one provider.

### `compressProtocol`

- **Type:** `"tools" | "marker"`
- **Default:** `"tools"`
- **Status:** ACTIVE
- **Description:** How compression tools are injected into the request. `"tools"` (default) injects them as native function-call tools. `"marker"` uses a text-trigger protocol instead — use this for upstreams that cannot coexist with a declared `tools` field.

### `compress`

- **Type:** `CompressSettings`
- **Default:** *(inherits global `compress`)*
- **Status:** ACTIVE
- **Description:** Per-provider compression overrides. This is **level 2 of 3** in the merge hierarchy — see [Compression Tuning](#compression-tuning).

---

## Compression Tuning

Compression behaviour is controlled by the `compress` block, which can appear at three levels. They merge **per-field, deepest wins**: a field set at a deeper level overrides the same field higher up, but an *unset* field at a deeper level never clears a value set higher up. In other words, the child covers the parent field-by-field — it never replaces the whole object.

The three levels, from broadest to most specific:

1. **Global** — a top-level `"compress": { … }` key. Applies to every request. This is the only level where the `injectTool` / `injectNudge` toggles are honoured.
2. **Per-provider** — a `"compress": { … }` block inside a `providers[url]` entry.
3. **Per-model** — a `"compress": { … }` block inside a `providers[url].models[model]` entry.

For each request, the proxy resolves the settings by longest-URL-prefix match (to find the provider) and the request's model name (to find the model entry), then merges global → provider → model.

### CompressSettings fields

#### `modelContextLimit`

- **Type:** `number | string`
- **Default:** *(the model's native window)*
- **Status:** ACTIVE
- **Description:** The context window size, in tokens. This is the **denominator** the engine uses for its usage ratio (`usage = tokens / modelContextLimit`) — it is **not** a truncation cap. Accepts an absolute number (`200000`) or a percent string (`"80%"` = 80% of the model's native window, resolved from the built-in table or models.dev registry). When omitted at every level, the native window is used. This is the highest-priority source for the model limit; it overrides the built-in table, the legacy per-model `context` field, and the top-level `modelContextLimit`.

#### `maxContextLimit`

- **Type:** `number | string`
- **Default:** `"75%"`
- **Status:** ACTIVE
- **Description:** Context-usage threshold that triggers **forced compression** nudges. Once usage crosses this ratio, the engine fires a nudge that bypasses the growth-gate and cadence checks. Accepts a ratio (`0.75`) or a percent string (`"75%"`). Lower values compress earlier. Maps to the kernel field `nudge.maxContextLimitPct`.

#### `emergencyThresholdPercent`

- **Type:** `number | string`
- **Default:** `"95%"`
- **Status:** ACTIVE
- **Description:** Context-usage threshold that triggers **emergency truncation** of large tool outputs. Accepts a ratio or a percent string. Must be greater than or equal to `maxContextLimit`. Maps to the kernel fields `nudge.emergencyThresholdPct` and `truncate.threshold`.

#### `nudgeGrowthTokens`

- **Type:** `number`
- **Default:** `50000`
- **Status:** ACTIVE
- **Description:** Token-growth step for soft compression nudges. A nudge fires roughly every time this many tokens become compressible. Lower values produce more frequent nudges. Maps to the kernel fields `nudge.growthFloor` and `nudge.growthCap` (it flattens the engine's adaptive band to this fixed step).

#### `preserveRecentMessages`

- **Type:** `number`
- **Default:** *(kernel default, typically `5`)*
- **Status:** ACTIVE
- **Description:** Number of most-recent messages that are never offered for compression. Protects the active working set so the model retains the latest turns verbatim. Maps to the kernel field `preserveRecentMessages`.

#### `preserveRecentTokens`

- **Type:** `number`
- **Default:** *(kernel default, typically `5000`)*
- **Status:** ACTIVE
- **Description:** Token budget reserved for recent-message protection. Maps to the kernel field `preserveRecentTokens`.

#### `minCompressRangeChars`

- **Type:** `number`
- **Default:** *(kernel default, typically `5000`)*
- **Status:** ACTIVE
- **Description:** Minimum range size, in **characters** (not tokens), for a message range to be eligible for compression; smaller ranges are skipped. English/code averages ~4 chars per token, CJK ~1-2, so the same number reads ~4× more permissive for English text than a token-based mental model. Maps to the kernel field `compress.minCompressRange`.

#### `minCompressRange`

- **Type:** `number`
- **Status:** DEPRECATED (alias of `minCompressRangeChars`, kept for backward compatibility)
- **Description:** Legacy name for `minCompressRangeChars` — same kernel mapping (`compress.minCompressRange`), same unit (characters). When both keys are set at the same level the canonical name wins; across levels the deeper level wins regardless of which name it uses.

#### `tiers`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** Enable multi-tier compression — tier-2 distillation of old summaries and tier-3 condensation. Set `false` to run in tier-1-only mode (every summary is a flat tier-1 summary). Maps to the kernel field `tiers.enabled`.

#### `prompts`

- **Type:** `object` (`{ compressPhilosophy?, howToCompressRules?, tier2DistillRules?, tier3CondenseRules? }`, all strings)
- **Default:** *(kernel defaults — see `acp-kernel` `defaultPrompts`)*
- **Status:** ACTIVE
- **Description:** Override the compression prompt text injected into the system prompt and nudge messages. Every field is **load-bearing**: the kernel rules were tuned over months of production use, and overriding them can degrade summary quality (lost paths / signatures / decisions → broken retrieval). Overrides only take effect when `acknowledgePromptsRisk: true` is set at the same (winning) level; otherwise they are ignored and a one-time warning is logged. Non-string fields are silently dropped (a malformed partial never clobbers a good default). Useful mainly for non-English or small-model tuning — see issue #156.

#### `acknowledgePromptsRisk`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** Must be `true` for `prompts` overrides to take effect. Setting it acknowledges the summary-quality risk documented above.

### Injection toggles (global only)

These two toggles are honoured only at the **global** level. Setting them inside a per-provider or per-model `compress` block has no effect.

#### `injectTool`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** Inject the `compress` / `decompress` / `search_context` tools and the compression system prompt into each request. Set `false` (or `ACP_COMPRESS_TOOL=0`) to disable tool injection entirely.

#### `injectNudge`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** Inject automatic compression-nudge messages when usage thresholds are crossed. Set `false` (or `ACP_COMPRESS_NUDGE=0`) to disable nudge injection. Disabling both `injectTool` and `injectNudge` is functionally similar to `passthrough`, except the proxy still tracks token usage.

### Three-level merge example

This example shows global defaults, a per-provider override, and a per-model override all stacking per-field:

```jsonc
{
  // Level 1 — global: applies to every request
  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%",
    "nudgeGrowthTokens": 50000,
    "tiers": true,
    "injectTool": true,
    "injectNudge": true
  },

  "providers": {
    "https://api.anthropic.com": {
      // Level 2 — per-provider: overrides global fields for this provider
      "compress": {
        "maxContextLimit": "70%",          // compress a bit earlier here
        "preserveRecentMessages": 8        // keep more recent turns
      },
      "models": {
        "claude-sonnet-4-5": {
          "context": 200000,
          // Level 3 — per-model: the deepest, highest priority
          "compress": {
            "modelContextLimit": 180000,   // treat window as 180k (leaves headroom)
            "emergencyThresholdPercent": "90%"
          }
        }
      }
    }
  }
}
```

For a request to `https://api.anthropic.com/v1/messages` with model `claude-sonnet-4-5`, the resolved settings are:

| Field | Resolved from | Value |
|-------|---------------|-------|
| `maxContextLimit` | provider (level 2) | `"70%"` |
| `emergencyThresholdPercent` | model (level 3) | `"90%"` |
| `nudgeGrowthTokens` | global (level 1) | `50000` |
| `preserveRecentMessages` | provider (level 2) | `8` |
| `modelContextLimit` | model (level 3) | `180000` |
| `tiers` | global (level 1) | `true` |

---

## Environment Variables

Environment variables take precedence over the config file. They are useful for environment-specific overrides (CI, containers) without editing the file.

| Variable | Effect |
|----------|--------|
| `ACP_DEBUG` | Set to `1` for verbose logging (same as `"debug": true`). |
| `ACP_PASSTHROUGH` | Set to `1` to forward without compression (same as `"passthrough": true`). |
| `ACP_COMPRESS_TOOL` | Set to `0` to disable tool injection (same as `"compress.injectTool": false`). |
| `ACP_COMPRESS_NUDGE` | Set to `0` to disable nudge injection (same as `"compress.injectNudge": false`). |
| `ACP_MODEL_CONTEXT_LIMIT` | Override the context limit globally (absolute token count). |
| `BILI_CONFIG_FILE` | Override the config file path (point at any JSON file). |
| `ACP_PORT` / `PORT` | Override the listen port. |
| `ACP_HOST` | Override the listen host. |
| `ACP_UPSTREAM` | Override the default upstream base URL. |
| `ACP_LOG` | Set to `0` to disable request logging. |
| `ACP_AUTO_UPDATE` | Set to `0` to disable auto-update checks. |
| `ACP_PROVIDERS` | Path to an external `providers.json` (legacy / shared file). |
| `BILI_REPLAY_RETRY_BASE_MS` | Base backoff delay (ms) for acp-loop replay retries after a transient upstream rejection (default `1500`; set `0` to disable the delay). See #189. |
| `BILI_REPLAY_RETRY_MAX` | Total attempts for acp-loop replay retries (default `3`; set `1` to disable retries entirely — legacy fail-fast behavior). See #189. |
| `ACP_SESSION_HEADER` | Conversation-id header name (default `x-acp-session`). |
| `ACP_REASONING_KEEP` | Responses API only: set `none` to drop all reasoning items. Default routes reasoning through the compression pipeline so it is hidden automatically once its turn is summarized (prevents the unbounded accumulation that broke Codex's prompt-cache prefix). |
| `ACP_LOG_FILE` | Log file path (default XDG state path; `off` disables the file, keeps stderr). Auto-rotates at 10 MB. |
| `ACP_DUMP_SSE` | Directory to dump raw SSE frames for debugging. |
| `BILI_UPSTREAM_PROXY` | Upstream proxy for the proxy's own outbound connections — highest priority, above per-URL/per-provider config. See the README *Upstream proxy* section. |
| `BILI_PERSIST` | Set `0` to disable session persistence (in-memory only, lost on restart). |
| `BILI_PERSIST_DEBOUNCE_MS` | Debounce window for persistence writes to disk, in ms (default `500`). |
| `BILI_TUNNEL_ALLOWED_HOSTS` | `/bili/<absolute-url>` tunnel admission for **remote clients** (#409): comma-separated `host` or `host:port` entries that unlock loopback/private destinations (e.g. a LAN relay or the machine's own sglang) for non-loopback clients. The proxy itself and link-local/metadata addresses are always denied; local (loopback) clients always pass. |
| `BILI_MAX_SESSIONS` | Max sessions held in memory (default `256`; LRU eviction — disk is the source of truth). |
| `BILI_SESSIONS_DIR` | Directory for persisted session state (default XDG data dir). |
| `BILLION_CONTEXT_PROXY` | Exported by the launcher; client-side bili plugins/extensions detect it and self-disable their own compression (no double compression). |
| `BILLION_CONTEXT_PLUGIN` | Set `0` to disable plugin mode entirely (wire-level tool injection resumes). |
| `BILI_LAUNCHER_MODEL_WINDOWS` | Internal: the launcher hands the client's own per-model context windows (pi `models.json`, omp `models.yml`, opencode `models.<id>.limit`, codex `model_context_window`) to the spawned proxy as JSON, so the nudge denominator matches the real window for self-hosted models. Only the launcher sets it — no user configuration. |
| `BILI_LAUNCHER_PLUGIN` | Set `0` to disable the launcher's bili MCP server injection for claude/codex (pure wire mode); `1` forces plugin mode. Default: injected — except codex with a local/private upstream (sglang/vllm/ollama cannot parse codex's namespace tool type, so bili auto-falls back to wire tools there). See [Launcher Reference](#launcher-reference). |
| `BILI_LAUNCHER_DIRECT` | Set `1` for direct-URL routing in the launcher (drop MITM/CA trust). See [Launcher Reference](#launcher-reference). |
| `BILI_CLAUDE_UPSTREAM` | claude direct mode: your relay endpoint, when `ANTHROPIC_BASE_URL` already points at a relay the launcher would otherwise bypass. |
| `BILI_CODEX_COMPACT` | Codex native-compaction handling. Default `intercept`: bili intercepts codex's compaction requests and forges a local handoff to the ACP state when the safety gate passes (transform ok + steady-state usage < 90% of the window + at least one active compressed block) — trigger form forges a 2-frame SSE, endpoint form forges `{output}` — and never contacts upstream. Forged ACP summaries are re-injected as a history-borne handoff message (developer-message fallback) so compressed content stays visible after codex truncates its history. Set `pass` to opt out and forward codex's compaction requests upstream (native compaction backstops). On any gate failure the request passes through untouched. |

---

## CLI Reference

Full command surface (`bili --help` prints an abridged version). Precedence everywhere: **CLI flag > env var > config file > built-in default**.

| Command | What it does |
|---|---|
| `bili [start] [options]` | Start the proxy (reads the XDG config file by default) |
| `bili pi [opts --] [args]` | Start a proxy + launch **pi** against it |
| `bili pi-test [opts --] [args]` | Like `bili pi`, but adds `--no-extensions` (clean-room test — the proxy owns compression) |
| `bili codex [opts --] [args]` | Proxy + **codex** |
| `bili claude [opts --] [args]` | Proxy + **claude** (Claude Code CLI) |
| `bili omp [opts --] [args]` | Proxy + **omp** (pi-based) |
| `bili opencode [opts --] [args]` | Proxy + **opencode** |
| `bili hermes [opts --] [args]` | Proxy + **hermes-agent** (`/bili/` rewrite) |
| `bili dsh [opts --] [args]` | Proxy + **deepseek-harness** (`/bili/` rewrite; args like `--profile web "task"` pass through) |
| `bili test pi` | Non-polluting end-to-end smoke test of the pi path |
| `bili export [session] [--full] [--output FILE]` | List persisted sessions / export one as a Markdown handoff — see [Sessions & Migration](#sessions--migration) |
| `bili update` | Check for & install a newer version now (bypasses the 3-minute throttle) |
| `bili plugin install <agent>` | Install the native-tool plugin / MCP bridge into a host — see [Plugin Mode](#plugin-mode-native-tools) |
| `bili plugin remove <agent>` | Remove it again |
| `bili plugin list` | Show install status for every host |
| `bili mcp` | Run the bili MCP server standalone on stdio |
| `bili plugin-register <id> [--origin URL] [--agent name]` | Pre-bind a conversation id to plugin mode (advanced) |
| `bili --version` / `bili --help` | Print version / help |

Anything after `--` in a launcher command is passed through to the client verbatim (`bili pi -- print "hi"`).

### Options

| Flag | Effect |
|---|---|
| `--port <N>` | Listen port (default `8787`) |
| `--host <ADDR>` | Listen host (default `127.0.0.1`) |
| `--config <FILE>` | Path to config JSON (default: XDG location) |
| `--debug` | Verbose logging |
| `--passthrough` | Forward without compression |
| `--no-passthrough` | Force compression on (overrides config) |
| `--no-auto-update` | Disable background self-update for this run |
| `--mitm-domain <domain>` | Extra MITM whitelist entry (repeatable; launcher only) |

---

## Client Integration

Two ways to point a client at the proxy without the launcher: the **`/bili/` prefix** (API-key clients) and **MITM transparent mode** (login clients with hardcoded endpoints).

### `/bili/` prefix (API-key clients)

Clients you configure with an **API key** (not a login) let you change the upstream URL. Prepend the proxy origin + `/bili/` to it — that's the only change. The API key stays in the client config and is passed through untouched.

**OpenCode** — edit `~/.config/opencode/opencode.json`, change the provider's `baseURL`:

```jsonc
// before:
"baseURL": "https://open.bigmodel.cn/api/coding/paas/v4"
// after (prepend the proxy origin + /bili/):
"baseURL": "http://localhost:8787/bili/https://open.bigmodel.cn/api/coding/paas/v4"
```

**Codex (API key)** — edit `~/.codex/config.toml`, change the provider's `base_url`:

```toml
# before:
base_url = "https://api.openai.com/v1"
# after:
base_url = "http://localhost:8787/bili/https://api.openai.com/v1"
```

**Codex (ChatGPT login)** — set the top-level `openai_base_url` field (keeps `model_provider = "openai"` and OAuth login intact):

```toml
# ~/.codex/config.toml (top-level field, not a section)
model_provider = "openai"
openai_base_url = "http://localhost:8787/bili/https://chatgpt.com/backend-api/codex"
```

Run `codex login` as usual; the OAuth token travels in the `Authorization` header, which the proxy forwards untouched.

**Pi** — edit `~/.pi/agent/models.json`, change the provider's `baseUrl`:

```jsonc
// before:
"baseUrl": "https://api.anthropic.com"
// after:
"baseUrl": "http://localhost:8787/bili/https://api.anthropic.com"
```

**Claude Code** — set the `ANTHROPIC_BASE_URL` env var to the `/bili/` URL. (claude's undici fetch ignores `HTTPS_PROXY`, so the `/bili/` URL form is the only manual option — cert MITM cannot intercept it.)

```bash
export ANTHROPIC_BASE_URL="http://localhost:8787/bili/https://api.anthropic.com"
```

> **Auto-compact alignment (manual mode only).** The `bili claude` launcher automatically sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to bili's effective window for your model, so claude's own auto-compact threshold lines up with bili's compression budget. In manual `/bili/` mode you must do this yourself — otherwise claude may run its own local auto-compact (a "summarize the conversation" turn) on a threshold that doesn't match bili's window. That is usually harmless (same session-id, so bili re-derives state from the truncation) but noisier than needed. Set it to bili's effective window for your model:
>
> ```bash
> export CLAUDE_CODE_AUTO_COMPACT_WINDOW=<bili effective window in tokens>
> ```
>
> claude clamps this value **down** to the window it perceives for the model (never up), so over-setting is safe. You can also set it persistently via claude's settings (`autoCompactWindow`).

**Other API-key clients** (Cursor / Aider / Continue …) — wherever the upstream URL is configured, prepend `http://localhost:8787/bili/`. Nothing else changes.

The `/bili/` prefix doubles as a **self-detection signal**: billion-context client extensions (billion-context-pi / opencode-acp) recognize it in their own baseUrl and self-disable, so you never get double compression.

### MITM transparent proxy (login clients)

Clients you sign **into an account** (ChatGPT Plus/Pro, Claude, ZCode coding plan, …) authenticate via OAuth and often **hardcode the endpoint** — if you can't change the baseURL, the prefix trick doesn't work. These use MITM mode instead.

How it works: the client only offers an **HTTP proxy** setting, so it sends `CONNECT <host>:443`; billion-context terminates the TLS locally (with a locally-generated root CA), injects compression into the cleartext, re-encrypts and forwards. The OAuth token travels in the client's `Authorization` header, which is forwarded untouched — so the subscription discount is preserved.

Supported MITM clients:

| Client | Login | Endpoint hardcoded | Status |
|---|---|---|---|
| **ZCode** | bigmodel coding plan (OAuth) | `open.bigmodel.cn` (builtin provider) | ✅ tested |
| **Claude Code** | Claude subscription (OAuth) | `api.anthropic.com` | ❓ untested (may not work — needs verification) |

> **Codex exception:** Codex exposes a top-level `openai_base_url` config field, so the ChatGPT login version CAN use the `/bili/` prefix (see above). MITM is not needed for Codex.

MITM is scoped to a **whitelist** of model hosts (`open.bigmodel.cn`, `api.anthropic.com`, `api.openai.com`, `chatgpt.com`). All other HTTPS hosts are blind-tunnelled — billion-context never decrypts non-model traffic.

One-time setup (trust the root CA in the client):

1. Start the proxy once to generate the root CA:

   ```bash
   bili start
   ls ~/.local/share/billion-context/ca/root-ca.pem   # exists now
   ```

2. In the client's **Settings → Network / Proxy** set:
   - **HTTP Proxy**: `http://127.0.0.1:8787`
   - **Proxy CA certificate path**: the CA file bili actually generated on this machine — `~/.local/share/billion-context/ca/root-ca.pem` on Linux/macOS, `%USERPROFILE%\.local\share\billion-context\ca\root-ca.pem` on Windows. The ZCode card on the web UI's routing page shows the real path on this machine with a copy button — just paste it.
   - (optional) **No-proxy list**: `localhost,127.0.0.1`
   - (For ZCode specifically: **Settings → Network**. For Claude Code, set the `HTTPS_PROXY` env var and `NODE_EXTRA_CA_CERTS` to the CA path.)

   > **Windows note:** ZCode on Windows does **not** expand `~` — a `~/...` path is not found (independent of the current working directory). Enter the full absolute path, e.g. `C:\Users\<user>\.local\share\billion-context\ca\root-ca.pem` (#342).

3. Restart the client. Its model traffic now flows through billion-context with compression injected. Send a message and check the proxy log (`~/.local/state/billion-context/bili.log`) for `mitm <host>:443 tunnel established`.

> The root CA is generated locally and lives only on this machine; it is **not** a system-wide install. Only the client you configure (via its CA-path setting) trusts it, so no other app is affected. Deleting the CA files and restarting the proxy regenerates them.

To give a MITM login client its **own upstream proxy** (firewall/GFW) without affecting API-key clients on the same host, use the `mitm://` scheme key — see the README's *Upstream proxy* section.

---

## Launcher Reference

`bili <client>` brings up a proxy on an independent port (a **fresh instance every launch** — an already-running `bili start` is never reused, #216), then runs the client pointed at it. **No config-file edits**: the client's own config is **read** (never edited) to discover which upstream hosts it talks to; those hosts are auto-whitelisted for MITM so the proxy TLS-terminates exactly the hosts the client uses. When the client exits, a proxy the launcher started is stopped.

Both upstream schemes are covered automatically, with no config edits:

- **HTTPS upstreams → cert MITM.** The client is pointed at the proxy via `HTTPS_PROXY` and trusts the proxy's MITM root CA (`~/.local/share/billion-context/ca/root-ca.pem`, generated lazily). Compression is injected on the intercepted TLS stream.
- **HTTP / localhost upstreams → `/bili/` baseURL rewrite** (plaintext can't be MITM'd). The launcher rewrites the client's base URL through the client's own mechanism, via an isolated temp copy of its config — the real config files are never touched (details below).

How each client is pointed at the proxy (set automatically in the child env):

| Client | Redirect | CA trust |
|---|---|---|
| pi | `HTTPS_PROXY` + isolated `PI_CODING_AGENT_DIR` | `NODE_EXTRA_CA_CERTS` |
| omp | `HTTPS_PROXY` + isolated `PI_CODING_AGENT_DIR` | `NODE_EXTRA_CA_CERTS` |
| codex | `HTTPS_PROXY` + `-c key=value` overrides | `SSL_CERT_FILE` → `combined-ca.pem` |
| claude | `ANTHROPIC_BASE_URL` = `/bili/` URL | none needed |
| opencode | `HTTPS_PROXY` + isolated `OPENCODE_CONFIG` | `NODE_EXTRA_CA_CERTS` |
| hermes | isolated `HERMES_HOME`; **all** upstreams `/bili/` | none (certifi ignores `SSL_CERT_FILE`) |
| dsh | isolated `DSH_HOME` + `DEEPSEEK_BASE_URL`; **all** upstreams `/bili/` | none (plain fetch, no proxy/CA knobs) |

`NODE_EXTRA_CA_CERTS` *appends* to the built-in trust store, so it points at the MITM root alone (`root-ca.pem`). `SSL_CERT_FILE` *replaces* the default CA bundle, so for codex it points at `combined-ca.pem` — a bundle containing the MITM root **plus** the system/Node public roots — keeping pip/git/curl style TLS (blind-tunnelled, real certificates) working inside the child env (#152).

Claude Code's undici fetch ignores `HTTPS_PROXY`, so cert MITM cannot intercept it. Every claude upstream — including a pre-configured `ANTHROPIC_BASE_URL` relay — is routed through the `/bili/` URL form via `ANTHROPIC_BASE_URL` instead; no CA trust is required.

Where upstreams are discovered from (read-only):

| Client | Read from |
|---|---|
| Pi | `~/.pi/agent/models.json` — each provider's `baseUrl` |
| omp | `~/.omp/agent/models.yml` — each provider's `baseUrl` |
| Codex | `~/.codex/config.toml` — each `[model_providers.<name>]` `base_url` (+ top-level `openai_base_url`) |
| Claude Code | `ANTHROPIC_BASE_URL` env var, else hardcoded `api.anthropic.com` |
| OpenCode | `~/.config/opencode/opencode.json` — each provider's `baseURL` |
| hermes | `~/.hermes/config.yaml` — each provider's endpoint lines |
| dsh | `~/.dsh/settings.yaml` — every `baseURL`/`baseUrl`/`base_url` value; plus the built-in `deepseek-official` route via `$DEEPSEEK_BASE_URL` |

### Isolated temp config (what gets written)

The `/bili/` rewrite modes write a **temp copy** — the real config is never edited — and the temp dir is removed when the client exits:

- **pi / omp** — an isolated `PI_CODING_AGENT_DIR` (under `/tmp`) containing only a rewritten `models.json` / `models.yml` with the `/bili/`-wrapped plaintext baseUrls. Everything else (`settings.json`, `sessions/`, `auth.json`, extensions…) is **symlinked** to the real pi/omp home, so sessions and logins are shared: a conversation started under the launcher continues seamlessly in a bare client, and vice versa.
- **opencode** — a temp `opencode.json` pointed at by `OPENCODE_CONFIG`, with `/bili/`-rewritten baseURLs **plus the thin `/acp` plugin appended** (native tools out of the box; the standalone `opencode-acp` plugin self-disables via `BILLION_CONTEXT_PROXY`).
- **hermes** — an isolated `HERMES_HOME` with a rewritten `config.yaml` routing **every** upstream (HTTP and HTTPS) through `/bili/` (httpx builds its own CA bundle and ignores `SSL_CERT_FILE`, so cert MITM is impossible). `skills/`, `memories/`, `sessions/` are symlinked through. If no providers are configured — or `config.yaml` can't be rewritten — the launcher prints a warning and hermes runs **unproxied** (compression off).
- **dsh** — an isolated `DSH_HOME` (persistent overlay `~/.dsh-bili`) with a rewritten `settings.yaml` routing every configured upstream through `/bili/` (plain `fetch`, no proxy/CA knobs, so cert MITM is impossible). `profiles/`, credentials and sessions are symlinked through. The built-in `deepseek-official` route is captured separately via `$DEEPSEEK_BASE_URL` (dsh resolves `settings llm-deepseek.baseURL` ?? env ?? default, so a rewritten user setting wins and the env is the zero-config fallback) — with no custom providers the deepseek route is still proxied out of the box.

### Native tools in the launcher

- **pi** — if the plugin is NOT installed, the launcher rides pi's `-e <file>` flag to load `dist/agent/pi.js` for that run only (nothing is written): native tools + the `/acp` command out of the box. If it IS installed, the symlinked `settings.json` already loads it — no `-e` is added.
- **omp** — does NOT ship the plugin; the launcher auto-injects `-e dist/agent/omp.js` when the config carries no loadable bili entry (same zero-config ride as pi). Two omp-specific mechanics make the plugin fully native there: omp 17.x mounts extension tools that omit `loadMode` under its `xd://` device URLs (invisible to the model's main turn), so the plugin registers its tools with `loadMode: "essential"` — the model gets the four ACP tools natively; and since omp's fork emits no `before_provider_headers`, the plugin binds the conversation via the launcher identity register (`POST /__bili/plugin/register`, keyed by omp's session id = `prompt_cache_key`/`x-session-id`) — bound sessions run in plugin mode (wire injection suppressed) with the native `/acp` command.
- **opencode** — the temp config appends the thin plugin automatically.
- **claude / codex** — on by default: the launcher injects a single `bili` MCP server (`--mcp-config` for claude, `-c mcp_servers.bili.*` for codex — both ephemeral, nothing written to host config), so the host gets native tools out of the box (verified with claude 2.1.227 / codex 0.147.0). `BILI_LAUNCHER_PLUGIN=0` falls back to plain wire mode — for hosts older than the verified builds that have not been tested against the injection flags.
- **codex + self-hosted upstream auto-fallback** — codex 0.147 ships MCP tools to the model as a `namespace` tool type; self-hosted servers (sglang/vllm/ollama/llama.cpp) do not parse it, leaving the tools silently invisible. When the codex upstream host is loopback/private (`127.0.0.1`, RFC1918, ULA, `.local`, …) and `BILI_LAUNCHER_PLUGIN` is unset, bili automatically uses wire mode instead (flat tools every server understands) and says so on stderr. `BILI_LAUNCHER_PLUGIN=1` forces plugin mode regardless.
- **hermes** — no plugin API; always wire mode.
- **dsh** — the launcher always splices a `--patch <file>` flag into dsh's argv (written to `~/.dsh-bili/.bili-acp.patch.yml`), inserting `dist/agent/dsh-acp.js` into the profile's loader tree: the native `/acp` command, same shape as dsh's own `/compact`. Works on every profile that composes the commands service (web/tui interactive surfaces; the `headless` one-shot driver sends its task straight to the model and parses no commands — `/compact` behaves the same there). Subcommand forms are handled: `dsh web` gets the flag after `web`, `dsh plugin`/`--dump-default-config` take none.

Launcher-mode matrix:

| Mode | Tools surface | Setup |
|---|---|---|
| Launcher + MCP (default for claude/codex) | native MCP tools | none — just `bili claude` / `bili codex` |
| Launcher wire mode (claude/codex, `BILI_LAUNCHER_PLUGIN=0`) | proxy-injected wire tools | one env var |
| Launcher `-e` / auto-plugin (pi, opencode; omp built-in) | native plugin tools | none |
| Manual plugin (`bili plugin install`) | agent-side plugin | run install |
| Manual baseURL (`/bili/` prefix) | proxy-injected wire tools | edit client config |

### Direct-URL mode (opt-in)

`BILI_LAUNCHER_DIRECT=1` drops MITM/CA trust entirely — claude's `ANTHROPIC_BASE_URL` / codex's provider `base_url` point at the `/bili/` prefix directly. Warnings:

- **codex direct mode**: the LLM traffic does **not** go through the proxy, so compression is not applied — only the bili MCP tool calls do. For full compression use the default MITM mode (unset `BILI_LAUNCHER_DIRECT`).
- **claude direct mode**: `ANTHROPIC_BASE_URL` is overridden to the proxy; a pre-configured relay is bypassed unless `BILI_CLAUDE_UPSTREAM=<relay>` is set. OAuth-subscription traffic requires the default MITM mode.

`--mitm-domain <domain>` (repeatable) adds extra domains to the MITM whitelist beyond what auto-discovery finds — useful for hosts the client fetches at runtime rather than from its config file. The launcher picks a free port automatically if the default is taken; `--passthrough` / `--debug` / `--no-auto-update` work like plain `bili`.

---

## Plugin Mode (native tools)

For a native-plugin experience, an agent can run a small cooperative plugin alongside the proxy: the plugin registers the four ACP tools (`compress` / `decompress` / `search_context` / `acp_status`) natively with the agent and drives the agent's own tool loop, while the proxy stays the compression authority (state, history folding, philosophy prompt, nudges). Tool schemas are served by the proxy itself (`GET /__bili/plugin/manifest`), so plugin and proxy can never drift. Protocol spec: [PLUGIN.md](PLUGIN.md).

Plugin-equipped sessions are detected automatically via request headers — wire-level tool injection is then suppressed for them (no double compression, native tool UX). Works in both proxy modes: the `/bili/` prefix baseURL **and** MITM transparent mode. The plugin can also report the agent's own model context window (`x-bili-plugin-context-window`) and read live context usage via `GET /__bili/plugin/status`.

### install / remove / list

```bash
bili plugin install pi      # add this billion-context install to pi's settings.json (packages)
bili plugin install omp     # same for omp (config.yml extensions)
bili plugin install claude  # register the bili MCP server (claude mcp add, user scope)
bili plugin install codex   # append [mcp_servers.bili] to ~/.codex/config.toml
bili plugin install opencode  # add mcp.bili to ~/.config/opencode/opencode.json
bili plugin list            # install status for every supported host
bili plugin remove pi       # undo (original files backed up to *.bili-bak once)
```

`install pi` also replaces any **legacy** billion-context entries (old `npm:billion-context-pi` references, stale `npm:billion-context@x.y.z`, leftover dev-checkout paths) so exactly one bili plugin stays live.

The installed plugin is a **thin** one (~5 KB, zero runtime deps): it detects the proxy (from the `/bili/` baseURL or `BILLION_CONTEXT_PROXY`), fetches tool schemas from the proxy, registers native tools, and forwards executions — the proxy remains the single compression authority, so plugin and proxy always match versions. Hosts without a plugin API (claude, codex, opencode) install the MCP bridge (`dist/mcp.js`) instead — same protocol underneath, though MCP has no slash-commands (no `/acp` panel command).

Kill switch: `BILLION_CONTEXT_PLUGIN=0` disables plugin mode entirely (wire-level injection resumes).

**When do you need `plugin install` at all?** Launcher users mostly don't (see [Launcher Reference](#launcher-reference) — pi/omp get `-e` auto-injected, opencode auto-injects, claude/codex get the MCP server auto-injected, dsh gets the native `/acp` command via `--patch`, hermes is wire-only). It's for a manually-configured client (`/bili/` prefix or MITM) where you want the native panel: pi/omp/opencode get native tools + `/acp` (on omp the fork hides extension tools from the model — the plugin's value there is the `/acp` command); claude/codex get native MCP tools (no `/acp`); dsh gets `/acp` through the launcher's `--patch` (a manually-configured dsh can add the same patch itself); hermes can't (wire only). Without any plugin everything still works — compression runs via wire-injected tools, and the model can be asked to call `acp_status` to check live usage.

---

## Sessions & Migration

### Compression state lives in the proxy (#151)

Compression state (blocks, summaries, original message cache) lives **in the proxy**, not in the client. The client's own local history is the full uncompressed view. Two consequences:

- If you point the client back at the real upstream (or stop the proxy), the client replays its **full local history** every turn. After a long compressed session this can exceed the model's context window (`context_window_exceeded`).
- There is no way to "unpack" a compression block into the client's local history — the client never saw the compressed form.

### Migrating off the proxy

Export the session and paste it into a fresh conversation as a handoff:

```bash
bili export                      # list persisted sessions (id, label, blocks)
bili export <id|label>           # print a Markdown handoff (block summaries)
bili export <id> --full          # include the original messages per block
bili export <id> --full --output handoff.md
```

Then start a new conversation in the client (direct to upstream) and paste the handoff doc as the opening context.

### Codex subagents get their own compression namespace (#150)

Codex subagents (e.g. the `guardian_subagent` approval reviewer) reuse the main conversation's `session_id`, so on the wire they look like the same session. Without care their requests inherit the main conversation's compression state — a subagent turn can get its context folded (losing the verbatim user authorization it must read back) and the two roles' usage estimates pollute each other.

billion-context detects this via the `instructions` field: subagent requests carry their own role prompt. The **first** instructions seen for a conversation anchor the main namespace (stable even if the main prompt drifts); any other instructions value maps to a separate `|sub:` namespace with its own empty compression state. Subagent requests are self-contained replays, so the fresh namespace is lossless — and the web UI's session list shows the two namespaces as separate sessions sharing the same client label.
