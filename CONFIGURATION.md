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
- **Description:** Network interface the proxy binds to. `127.0.0.1` (default) listens only on localhost — safe for a local sidecar. Use `::` for IPv4 + IPv6 dual-stack. Use `0.0.0.0` inside a container to expose the proxy on all interfaces (ensure the surrounding network is trusted). Overridden by `ACP_HOST` / `--host`.

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
- **Description:** Maps a model name to its context-window declaration. The LLM `/models` endpoint does **not** return context windows (verified across OpenAI, Anthropic, zhipu, comfly), so the proxy cannot discover them at runtime — you must declare them here. `context` is the model's context window in tokens; `output` is the max output size. When a model is not declared, the proxy falls back to its built-in context table or the models.dev registry. Each model entry may also carry a per-model `compress` block (see [Compression Tuning](#compression-tuning)).

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

#### `minCompressRange`

- **Type:** `number`
- **Default:** *(kernel default, typically `5000`)*
- **Status:** ACTIVE
- **Description:** Minimum token count for a message range to be eligible for compression; smaller ranges are skipped. Maps to the kernel field `compress.minCompressRange`.

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
