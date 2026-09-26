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

### `compat`

- **Type:** `{ roles?: Record<string, string> }`
- **Default:** `{}` (disabled)
- **Status:** ACTIVE
- **Description:** Global wire-compat role map. `roles` maps message roles to the role name your upstream accepts, e.g. `{"compat":{"roles":{"developer":"system"}}}` rewrites `developer` → `system` on the final forwarded body for upstreams that reject the `developer` role (#552, newer codex clients). Applies to `openai` chat-completions and `responses` requests; exact-match roles only, everything else in the body is untouched; re-sent compress-retry bodies carry the same rewrite. Per-provider `compat.roles` entries (see [Providers](#providers)) win per key. Default `{}` forwards bodies byte-for-byte unchanged.
- **Learn-on-failure:** with no compat configured, an upstream `400 Invalid role: …` is auto-fixed — bili rewrites the offending role to `system`, retries once, and remembers the mapping **session-scoped** (in-memory on the session; never written to config). Later requests in that session skip the 400 round-trip. The info log emitted when the fix fires carries the permanent per-provider snippet.

### `proxy`

- **Type:** `string`
- **Default:** *(none — no upstream proxy)*
- **Status:** ACTIVE
- **Description:** Upstream HTTP proxy (`http://host:port`) used for the proxy's **own** outbound connections to model providers. SOCKS5 is not supported: an explicit `proxy` value with a `socks5`/`socks5h` scheme fails startup with an actionable error, while env/system proxies (`HTTPS_PROXY`, …) using such a scheme are ignored with a one-time log warning (traffic falls through to direct). For Clash/mihomo, use the same mixed port over `http://` (e.g. `http://127.0.0.1:7890`). A per-URL `proxy` set inside a `providers` entry overrides this for that provider. An empty string means "explicitly direct" — it disables any environment/system proxy fallback for all providers.

### `imageBilling`

- **Type:** `"auto" | "pixels" | "bytes"`
- **Default:** `"auto"`
- **Status:** ACTIVE
- **Description:** How inline (base64) images are charged by the preflight size gate and output clamp (#488/#496/#767). `"bytes"` charges each image at `base64 length / 4` tokens — conservative, and correct for byte-billing relays. `"pixels"` parses the image header (PNG/JPEG/WebP/GIF/BMP) without decoding the body and charges first-party pixel-tile billing (OpenAI high-detail model: 512px tiles, short side scaled up to 768px, long side capped at 2048px → 765–2805 tokens per image; unparsable formats fall back to a flat 16384). Remote (`https://`) images always charge a flat 4096 in either mode. A per-provider `providers.<url>.imageBilling` wins over this global, and the `BILI_IMAGE_BILLING` env var wins over both (live-read, no restart).

---

## Providers

The `providers` block maps **upstream URLs** to per-provider configuration. Each key is a URL prefix; each value can declare model context windows, a per-provider proxy, a compression protocol, compression overrides, an image billing mode, and a per-route passthrough.

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
- **Description:** Maps a model name to its context-window declaration. The LLM `/models` endpoint does **not** return context windows (verified across OpenAI, Anthropic, zhipu, comfly), so the proxy cannot discover them at runtime. `context` is the model's context window in tokens; `output` is the max output size and serves as the output-headroom fallback when a request carries no output-budget field at all (see [`outputHeadroomMaxPct`](#outputheadroommaxpct)).

  **Resolution order (first match wins):** (1) per-request sources — the client's `anthropic-beta` larger-context negotiation, a cooperative plugin's report, and the launcher's per-model windows; (2) this per-model `context` declaration; (3) the **warm** models.dev registry cache, when the model is listed (relay/private hosts match the bare model name against the registry's provider-prefixed entries); (4) the built-in context table. So this per-model `context` declaration **outranks the registry** — set it to the window your relay/private deployment actually serves, and it wins even when models.dev lists a different (usually larger) window for the model. `compress.modelContextLimit` remains the highest-priority source (always wins) when you want to pin the window across every route. Each model entry may also carry a per-model `compress` block (see [Compression Tuning](#compression-tuning)).

  The built-in context table (step 4) is static data shipped with each release and can go stale — e.g. DeepSeek's canonical request id `deepseek-flash` is not listed on models.dev under that name (its window is listed under `deepseek-v4-flash`), so only the table answered for it (#852). The log records which source won, once per model per process (`[window] ... fallback=true` means the value came from the built-in table). If the resolved window looks wrong, declare `models.<name>.context` as above — it outranks both the registry and the table — or pin `compress.modelContextLimit`; and remember the provider key must carry the traffic's scheme (`mitm://<host>` for MITM login-client traffic, `https://<host>` for `/bili/` traffic).

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

### `compat`

- **Type:** `{ roles?: Record<string, string> }`
- **Default:** `{}` (disabled)
- **Status:** ACTIVE
- **Description:** Per-provider wire-compat overrides. `roles` maps message roles to the role name this upstream accepts, e.g. `{"developer": "system"}` for upstreams that reject the `developer` role newer codex clients send (#552). Applied to the final forwarded `openai`/`responses` body — client-sent roles and bili's own injected prompt alike — and to every body the compress-retry loops re-send. Wins per key over the global `compat` block (see [Server Settings](#server-settings)). Default `{}` forwards byte-for-byte unchanged.

### `passthrough`

- **Type:** `boolean`
- **Default:** *(none — compression active)*
- **Status:** ACTIVE
- **Description:** Per-route override of the global [`passthrough`](#passthrough) setting. When `true`, every request matching this route is forwarded **byte-for-byte**: no kernel round-trip (no message re-serialization, no ACP render tags, no `prompt_cache_key` removal), the response is piped through untouched, and no session state is created for that route. Use this for upstreams whose anti-fraud fingerprinting rejects bili's rewritten bodies — e.g. ZCode's `405 / 3012` ("request has been blocked due to unusual activity") on the kernel-rebuilt `messages` body (#661). A `mitm://` key targets only the MITM (login-client) traffic of that host, while a plain `https://` key targets only `/bili/` (API-key) traffic — the two schemes never overlap:

  ```jsonc
  {
    "providers": {
      "mitm://zcode.z.ai": { "passthrough": true }
    }
  }
  ```

### `imageBilling`

- **Type:** `"auto" | "pixels" | "bytes"`
- **Default:** *(global `imageBilling`, then `"auto"`)*
- **Status:** ACTIVE
- **Description:** Per-route override of how inline images are charged by the size gate (#767). Set `"pixels"` for official Codex/OpenAI/Anthropic endpoints (pixel-tile billing) and keep `"bytes"` for byte-counting relays — under byte billing, a stale over-window baseline plus large base64 screenshots fails preflight with 502 forever even though the images bill only a few thousand tokens upstream. When unset at both levels, billing is auto-selected from the upstream host: hosts ending in `openai.com`, `openai.azure.com`, `chatgpt.com`, or `api.anthropic.com` → `pixels`; everything else → `bytes`. The `BILI_IMAGE_BILLING` env var overrides both config levels:

  ```jsonc
  {
    "providers": {
      "https://chatgpt.com/backend-api/codex": { "imageBilling": "pixels" }
    }
  }
  ```

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
- **Description:** The context window size, in tokens. This is the **denominator** the engine uses for its usage ratio (`usage = tokens / modelContextLimit`) — it is **not** a truncation cap. Accepts an absolute number (`200000`) or a percent string (`"80%"` = 80% of the model's native window, resolved from the built-in table or models.dev registry). When omitted at every level, the native window is used. This is the highest-priority source for the model limit; it overrides the built-in table, the legacy per-model `context` field, and the top-level `modelContextLimit`. Note it also serves as the **hard preflight wall**: once a payload reaches this value the proxy proactively folds context before forwarding, and if folding cannot bring it under, the request fails fast instead of being sent upstream. To keep day-to-day context small while still letting large reads burst up to the native window, keep `modelContextLimit` at its native value and use `maxContextLimit` as the soft target instead (see [Soft target with elastic headroom](#soft-target-with-elastic-headroom-1122)).

#### `outputHeadroomMaxPct`

- **Type:** `number | string`
- **Default:** `0.25`
- **Status:** ACTIVE
- **Description:** Cap on the output-headroom reservation, as a fraction of the context window: reserved amount = `min(max_tokens, pct × window)`. **Budget source:** when the request carries no output-budget field at all (`max_tokens` / `max_completion_tokens` / `max_output_tokens`) — e.g. Codex's native Responses path sends no `max_output_tokens` (#924) — the proxy falls back to the model's declared max output: the per-route `providers[url].models[model].output` configuration first, then the models.dev registry output ceiling (bundled snapshot as offline floor); if neither exists, no reservation is made. The same cap applies to the fallback value. The reservation keeps the engine's nudge/truncate bands below `window − reserved`, so long replies can't push "input + output" past the window — it applies to APIs that count output against the window (Anthropic Messages is exempt: its input limit is enforced independently of `max_tokens`, so it is excluded). Without a cap, models whose registered max output takes a large share of the window (e.g. `maxTokens` 131072 on a 262144 window) lose most of their input budget and the 75% force-compress threshold fires at about a third of the full window. The `0.25` default bounds that loss while still guaranteeing no overflow at the 95% emergency threshold for any single-turn reply up to 25% of the window; longer replies overflow once and are recovered by the next turn's overflow self-heal. Note the cap only relaxes oversized reservations: when `max_tokens` is already ≤ `pct × window`, the reservation stays the full `max_tokens` (byte-identical to the legacy behavior). Accepts a ratio (`0.25`) or percent string (`"25%"`); set `0` to disable the reservation entirely; `>= 1` restores the legacy full-capability reservation (input + a full-budget reply always fits — what strict backends like SGLang/vLLM enforce). Negative or unparseable values reject the whole `compress` block. Example: 262144-token window, `max_tokens = 131072` → default `0.25` reserves 65536 → effective window 196608 (legacy full reservation: 131072); `max_tokens = 65536` → reserves 65536 → 196608 unchanged (65536 ≤ 25% of the window). Aligned with billion-context-pi (`#207`) via #896.

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

#### `protectedLatestTools`

- **Type:** `string[]` (tool-name patterns, e.g. `["todo_list"]`)
- **Default:** `[]` *(none — opt in per client, tool names are client-specific)*
- **Status:** ACTIVE
- **Description:** Tool-name patterns whose **latest** tool-call + paired result are never compressed (kernel `protectedLatestTools`, requires `acp-kernel` >= 0.0.80). Built for cumulative-snapshot tools — e.g. an agent's todo/task list, where every newer result supersedes the older ones: only the newest instance is the source of truth, so protecting **all** instances (via `protectedTools`) would make that tool's history grow unboundedly, while protecting the **latest** keeps the live snapshot in context and lets every superseded instance fold normally. This solves the "agent forgets its task list after compression" failure (#639). Protection is a HARD exclusion: the latest instance is unaddressable (its refs render as `BLOCKED`), so neither suggested nor explicit compress ranges can cover it; it applies identically in both compression modes and on every wire. Patterns match like kernel tool patterns (exact name or `*` glob, e.g. `"todo_list"`, `"TodoWrite"`, `"todo*"`). Whole-array replace at the deepest defined level. Example: `{ "compress": { "protectedLatestTools": ["todo_list", "TodoWrite"] } }`.

#### `protectedTools`

- **Type:** `string[]` (tool-name patterns, e.g. `["skill"]`)
- **Default:** `[]` *(none — opt in per client, tool names are client-specific)*
- **Status:** ACTIVE
- **Description:** Tool-name patterns whose tool-calls AND paired results are **never compressed — every instance, full history** (kernel `protectedTools`). Protection is a HARD exclusion: all matching refs render as `BLOCKED`, so neither suggested nor explicit compress ranges can cover any instance; it applies identically in both compression modes and on every wire. Patterns match like kernel tool patterns (exact name or `*` glob, e.g. `"skill"`, `"skill_*"`). Whole-array replace at the deepest defined level. Example: `{ "compress": { "protectedTools": ["skill"] } }`.
- **⚠ When to use which knob (read before configuring):** choose by how a tool's results relate to each other:
  - **Independent content** — each instance carries unique information no later result supersedes (opencode/pi `skill` loads, one-shot references): use `protectedTools`. Folding an old load loses its content permanently; protection keeps every load in context (#1109).
  - **Cumulative snapshots** — each newer result supersedes the older ones (a client's todo/task list): use `protectedLatestTools`. Protecting **all** instances of such a tool makes its history grow unboundedly — the exact failure #639 worked around by protecting only the latest.
  - Rule of thumb: low-frequency, high-value tools → `protectedTools`; chatty tools → never full-history protect (context grows without bound); cumulative-snapshot tools → `protectedLatestTools`.

#### `neverPreserveRecentTools`

- **Type:** `string[]` (tool-name patterns)
- **Default:** unset → kernel built-in `["decompress", "search_context", "read", "bash"]` (requires `acp-kernel` >= 0.0.92)
- **Status:** ACTIVE
- **Description:** Tool-name patterns EXCLUDED from the soft-protected recent zone (`preserveRecentMessages`/`preserveRecentTokens`): matching tool results inside the recent window become compressible immediately instead of aging out first. The kernel default keeps `read`/`bash` compressible because they are the largest reclaimable mass — but that same default is what makes batch-read workflows fold freshly-read files right away and descend into the fold→re-read death loop (#1198/#1277). **Recommended remedy: remove only `read`** — `{ "compress": { "neverPreserveRecentTools": ["decompress", "search_context", "bash"] } }` — so fresh read results stay in the recent zone and age out by position later (unlike `protectedLatestTools`, which would pin the newest read forever). Prefer the simpler positive form `preserveRecentTools: ["read"]` when you don't need verbatim-replace semantics — see the next section. Keep `decompress`/`search_context` in the list: re-including them pins just-restored blocks in the recent zone where they become unreclaimable — a different disease. **⚠ Empty array `[]` is VALID and excludes nothing** (max-protection escape hatch) — unlike `protectedTools`/`protectedLatestTools` an empty array is not rejected; an explicit array replaces the default verbatim, whole-array replace at the deepest defined level.

#### `preserveRecentTools`

- **Type:** `string[]` (tool-name patterns)
- **Default:** unset → no subtraction (the `neverPreserveRecentTools` ?? built-in list governs verbatim; requires `acp-kernel` >= 0.0.93)
- **Status:** ACTIVE
- **Description:** The **positive-facing** counterpart of `neverPreserveRecentTools`: tool-name patterns **removed** from the effective recent-zone exclusion list. The #1198/#1277 batch-read fold→re-read remedy becomes a one-entry config — `{ "compress": { "preserveRecentTools": ["read"] } }` — that protects fresh read results without restating (or freezing a stale hand-copy of) the built-in list, and keeps following built-in evolution. Effective exclusion = `(neverPreserveRecentTools ?? built-in) minus preserveRecentTools`; composable with an explicit `neverPreserveRecentTools` (subtraction applies to the explicit list too); glob-suffix patterns subtract matching entries (`"bash*"` removes `bash`). Prefer this knob over editing the never-list unless you genuinely need verbatim-replace semantics. **⚠ Empty array `[]` is rejected** — it is a pure no-op here, so a bare `[]` is almost certainly a typo for `neverPreserveRecentTools: []` (the max-protection escape hatch). Whole-array replace at the deepest defined level, like the sibling knobs.

#### `prompts`
- **Default:** *(kernel defaults — see `acp-kernel` `defaultPrompts`)*
- **Status:** ACTIVE
- **Description:** Override the compression prompt text injected into the system prompt and nudge messages. Every field is **load-bearing**: the kernel rules were tuned over months of production use, and overriding them can degrade summary quality (lost paths / signatures / decisions → broken retrieval). Overrides only take effect when `acknowledgePromptsRisk` resolves to `true` after the three-level merge — the flag resolves independently at its own deepest defined level and gates **all** `prompts` overrides regardless of which level each piece lives at (a global-level flag activates model-level `prompts`); otherwise they are ignored and a one-time warning is logged. Non-string fields are silently dropped (a malformed partial never clobbers a good default). Useful mainly for non-English or small-model tuning — see issue #156.

#### `acknowledgePromptsRisk`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** Must be `true` for `prompts` overrides to take effect. Resolves like every other field (deepest defined level wins) and gates all `prompts` overrides regardless of which level each piece lives at — it does not need to sit in the same block as the `prompts` it unlocks. Setting it acknowledges the summary-quality risk documented above.

#### `promptPack`

- **Type:** `string` (pack name, e.g. `"lean"`)
- **Default:** `default` *(unset is equivalent — identity surface, kernel defaults everywhere)*
- **Status:** ACTIVE
- **Description:** Select a named prompt pack — a curated surface preset covering tool descriptions, compress system-prompt sections, and nudge sections — resolved from the kernel's pack chain: **project** `./.billion-context/packs/<name>.json` → **user** `<configDir>/packs/<name>.json` → **builtin** (`default`, `lean`). Built-in `lean` swaps the four ACP tool descriptions for one-liners (no snippet/guideline chrome) while keeping the compression rules default. Unknown names fall back to the identity surface with a one-time warning. Same three-level merge as the other fields; pack-surface sections (tool/section overrides) apply directly, without the `acknowledgePromptsRisk` gate — that gate governs only inline `compress.prompts` rule-text overrides. Note a pack's `prompts` block is ignored by this proxy: rule-text overrides are possible only via inline `compress.prompts`. Requires `acp-kernel` >= 0.0.66.

#### `absorb`

- **Type:** `object` (`{ enabled?, minToolTokens?, contextThresholdPct?, excludeTools?, toolName? }`)
- **Default:** *(disabled — the feature is off unless you set `enabled: true`)*
- **Status:** ACTIVE
- **Description:** Opt-in **instant tool-result compression** (issue #605, via the `acp-kernel` absorb API). When enabled, large tool results get a forced `[ACP absorb]` instruction at result time; the model distills the result into a compact summary via the `absorb` tool, and the original tool-call/tool-result pair is hidden from the wire from the next turn on — keeping mid-session pressure lower between fold rounds. Sub-fields (merged deepest-wins like every other CompressSettings field):
  - `enabled: boolean` — master switch; anything other than `true` keeps the feature fully off (no tool, no prompt, no markers).
  - `minToolTokens: number` — only results at or above this many tokens are prompted (kernel default 1000).
  - `contextThresholdPct: number|percent-string` — only prompt once usage reaches this fraction of `modelContextLimit` (`0` = size gate alone; `"75%"` is accepted).
  - `excludeTools: string[]` — tool-name patterns never absorbed. **Known limitation:** a no-op on tool *results* until [ranxianglei/acp-kernel#213](https://github.com/ranxianglei/acp-kernel/issues/213) ships (wire projections don't carry `toolName` on results, so the kernel's name guard can't fire).
  - `toolName: string` — rename the injected tool (default `"absorb"`); the advertised/injected schema, the system-prompt section and per-session adjudication all follow the name in both lanes. **Lane governance (#1359):** plugin mode governs the *entire* `absorb` block by the **base** config, so a renamed tool is advertised under that name and executed under it (they can never diverge); provider/model-level `absorb.*` overrides are **proxy-lane-only** (the proxy injects and adjudicates the merged name). A load-time warning lists any provider/model `absorb.*` field whose value diverges from base.
  Injection follows the wire's native-tool surface: proxy mode injects the tool (under the per-request resolved name) + a system-prompt section on the anthropic/openai/responses native-tools wires, plugin mode advertises it in the plugin manifest **only while enabled** (hosts register the manifest's tools verbatim — advertising a disabled tool breaks them, #1192; the MCP shell picks it up for free). Responses **marker/text-protocol** routes are not supported (no native tool surface — the REQUIRED absorb instruction would be unsatisfiable), and title-generation requests (`max_tokens ≤ 200`) skip injection like the compress prompt does. Absorbed pairs stay hidden across restarts (persisted in the session state).

#### `ccr`

- **Type:** `object` (`{ enabled?, minToolTokens?, excludeTools?, toolName?, maxHeadChars? }`)
- **Default:** *(on in proxy mode since v2 (#1179) — unset resolves to `enabled: true`; an explicit `enabled: false` at any level opts out. Plugin lanes stay opt-in: they arm only on an explicit global `enabled: true`, #1271/#1273.)*
- **Status:** ACTIVE (v2 — proxy mode by default; plugin mode on the anthropic + openai wires when explicitly enabled)
- **Description:** **Content-addressed message store** / built-in CCR (issue #1097/#1179, via the `acp-kernel` CCR API, acp-kernel >= 0.0.84). Instead of force-distilling oversized tool results (like `absorb`) or carrying them on the wire forever, the kernel ID-references them at arrival (the ccr-store node runs between prune and absorb within `processTurn` — ID-referencing wins over distillation): the wire keeps a deterministic, byte-stable placeholder (`📦 [acp-stored #m00423 · shell output · 4,213 tok] \`npm run build\`\n   → acp_retrieve("m00423") returns the full text`) and the original goes into the session's content store. The model retrieves the full original on demand via the injected `acp_retrieve` tool; a retrieve is ephemeral (it rides the intra-request tool-result channel, never enters fold space, consumes no message ref). Lossless by default: a retrieve not made costs one cheap tool call; a detail distilled away by absorb is gone for good. Sub-fields (merged deepest-wins like every other CompressSettings field):
   - `enabled: boolean` — master switch. **Defaults to `true`** when unset at every level (#1179); an explicit `false` at any level wins and keeps the feature fully off (no placeholders, no tool). Plugin-mode arming additionally requires an explicit global `true` (#1273) — the manifest only advertises what the operator explicitly enabled.
  - `minToolTokens: number` — only tool results at or above this many tokens are ID-referenced (kernel default `4000`); smaller results stay verbatim.
  - `excludeTools: string[]` — tool-name patterns never stored (glob suffixes allowed; kernel default: none).
  - `toolName: string` — rename the retrieval tool (default `"acp_retrieve"`); declaration, dispatch and the placeholder hint all follow the name. Must stay unique against the client's own tool names.
  - `maxHeadChars: number` — head/command preview length inside the placeholder (kernel default `96`).
  **Plugin-lane governance (#1345):** in plugin mode the whole `ccr` block follows the **base** config — sessions arm only on a base-level `enabled: true` and execute with the base `toolName` and thresholds, because the plugin manifest (the host's only declaration of the retrieve surface) is built from the base config alone. Provider/model-level `ccr.*` overrides therefore apply to proxy-mode sessions only (the proxy declares and dispatches per request under the merged block). Every divergent override is logged at config load as a `[acp-config] ccr override ignored in plugin sessions: …` warning naming the level, field, and the value plugin sessions actually use.
  The store persists as a single envelope file (`.content-store.json`) next to the session JSON, using the same at-rest codec as the session file when `BILI_ENCRYPTION_KEY` is set; entries are deduped by content hash and lazily loaded per session. Only the *content* inside a `tool` result shrinks — pairing with the assistant `tool_calls` is untouched. Scope gates: **opt-in on every lane** (#1207 owner decision — `compress.ccr.enabled: true` at any level after local verification): proxy mode arms once enabled, plus plugin mode on the anthropic + openai wires where the plugin manifest advertises `acp_retrieve` while CCR is explicitly enabled globally (#1271); responses marker/text-protocol routes, `ACP_NO_INJECT_TOOL`, and the responses/google wires in plugin mode have no proven request-only round-trip channel to execute the retrieve, so the store disarms itself there instead of losing content. Since v2 (#1179), folds are lossless too: when a compress fold lands, the covered originals are persisted into the store (first-write-wins, reasoning skipped), so `acp_retrieve("mNNNNN")` works for folded content as well; `decompress` accepts optional `startId`/`endId` message refs to restore just a span of a block (ephemeral injection, same channel as retrieves); `search_context` hits carry the covered ref span (`[m00044–m00097 · N msgs]`) alongside block metadata; and `acp_status` lists the block→ref linkage (`BLOCK SPANS`) plus a separate `range-restored` count on the STORE line. Design decision (#1282): **no cap and no eviction, ever** — the envelope grows with the unique originals held and shares the session's lifecycle; the footprint is visible in `acp_status`. Per-session stats (stored bytes, current wire bytes saved, retrieve rate) surface in `acp_status`; each retrieve logs a `[ccr] retrieve …` line.

#### `imageCompression`

- **Type:** `object` (`{ enabled?, minTokens?, maxDimension?, quality?, format? }`)
- **Default:** *(disabled — the feature is off unless you set `enabled: true`)*
- **Status:** ACTIVE (v1 — proxy mode)
- **Description:** Opt-in **image pre-compression** for screenshot-heavy tool results (issue #1095, via the `acp-kernel` image-compression API, acp-kernel >= 0.0.84). Multimodal providers bill images by pixel area, so a phone screenshot costs more than a large code block. When enabled, screenshot-like images (deterministic heuristic classifier: portrait aspect ratio in band + minimum short side) in tool results are downscaled **once at arrival** — before they enter the wire — so the model still sees the UI at a fraction of the billed pixels. Non-screenshot images pass through byte-identical. The routing decision (pass vs downsample + recipe) is made by the kernel per image; the host executes the encode with the optional `sharp` dependency (lazy-loaded; missing or failing ⇒ the original passes through, never blocking the main flow). **Lossy by nature** — unlike text CCR, downscaled pixels can't be retrieved; mitigation: the injected `image_full` tool lets the model restore the original resolution for the rest of the session when it can't read details (sticky, idempotent; the restore persists across restarts with the shrink records). No proxy-side original storage is needed: the client's own history still carries the original bytes (it never saw the shrunk form), so a restored ref simply stops being re-routed and the original rides the wire again. Per-image savings log as `[acp-image] …` lines and aggregate into the `[acp-usage]` suffix (`img-saved=Ntok/MKB xK`). Sub-fields (merged deepest-wins like every other CompressSettings field):
  - `enabled: boolean` — master switch; anything other than `true` keeps the feature fully off (byte-identical pass-through, no `image_full` tool on the wire).
  - `minTokens: number` — only route images whose billing-aware token estimate ≥ this (kernel default `512`).
  - `maxDimension: number` — longest side (px) of the downsample recipe (kernel default `1280`).
  - `quality: number` — lossy encode quality 1–100 of the recipe (kernel default `80`).
  - `format: "webp" | "jpeg" | "png"` — encode format of the recipe (kernel default `"webp"`).
  All four wire carriers are rewritten at the forward boundary: Anthropic `image` blocks, OpenAI `image_url` parts (including single-string data-URL messages; remote URLs are never touched), Responses `input_image`, and Google `inlineData`. Determinism contract (same invariant as CCR #1097): the substituted-at-arrival bytes ARE the standing wire content — a guard refuses to re-route any payload that isn't a known original fingerprint for an already-shrunk ref, so processed messages re-entering the pass (fold re-requests) can't double-shrink and bust the prefix cache. Note the kernel's pixel-tile token estimate is coarse and capped (~2k tokens for large screenshots): a shrink may save real wire bytes while saving zero estimated tokens — both numbers appear in the log. Fingerprint bookkeeping is memory-only (not persisted): after a proxy restart, previously shrunk (non-restored) refs pass through at original resolution until the session resets — the double-shrink guard won't re-route payloads it can't verify as known originals, so savings for those refs pause rather than risk a double-shrink (a reset clears the records, so they re-shrink deterministically on the next arrival); previously restored refs stay restored. v1 scope gate: **proxy mode only** (plugin agents would need `image_full` advertised in their plugin manifest first). Requires `acp-kernel` >= 0.0.84 and the optional `sharp` package for actual shrinking (without it every image passes through unchanged).

#### `rules`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** Opt-in **persistent model reminders** (issue [ranxianglei/billion-context-pi#433](https://github.com/ranxianglei/billion-context-pi/issues/433), via the `acp-kernel` rules API). When enabled, an `acp_rule` tool is injected alongside the ACP tools: calling it with a short `rule` argument records a principle-level reminder that is **hard-protected** from compression (the call + result stay in context across every fold), and omitting the argument lists the recorded rules. Passing `delete` with a rule id (e.g. `"rule3"`) removes that one rule (`Removed ruleN: <text>`); passing `clear: true` removes every rule. The two are mutually exclusive with each other and with `rule` — one operation per call — so a stale or accidentally-recorded rule can be deleted instead of hedged with a counter-rule. Guidance on *when* to record (user-emphasized lessons, behaviors the user asks to remember, major pitfalls hit) lives entirely in the tool description — nothing is added to the system prompt. Kernel limits apply (50 rules × 300 chars each); duplicate text is rejected pointing at the existing id. Injection follows the wire's native-tool surface exactly like `absorb`: proxy mode injects the tool on the anthropic/openai/responses native-tools wires, plugin mode advertises it in the plugin manifest **only while enabled** (hosts register the manifest's tools verbatim — advertising a disabled tool breaks them, #1192; execution gated per session). Recorded rules persist across restarts in the session state; removals persist the same way. Requires `acp-kernel` >= 0.0.70 (>= 0.0.84 for delete/clear). Humans can inspect or record rules without going through the model: pi/omp expose a native `/acp-rule` command — bare `/acp-rule` lists every recorded rule, `/acp-rule <text>` records one directly (#1251).

#### `reasoning`

- **Type:** `object` (`{ drop?, threshold? }`)
- **Default:** `drop: true`, `threshold: 2048` — on
- **Status:** ACTIVE
- **Description:** **Compress-reasoning hygiene** (issue #651, the proxy-side twin of `billion-context-pi` #339/#348 / `opencode-acp` #377). Models that keep their `reasoning`/`thinking` traces on the wire accumulate a permanent uncompressible floor: the anchor of a fold is a `compress` call, and any reasoning messages sitting *before* that call survive every fold as part of the protected prefix — they can never be re-summarized, only stripped. In the storm sessions this floor reached ~50% of the visible context. When on, the proxy removes the reasoning run that immediately precedes a **closed** `compress` call — closed on **round evidence**: the call's tool result (`contentType: "tool-result"`, matching `toolCallId`) has arrived at a later index and at least one message exists after it. No user message is required, so long agentic sessions close rounds too [#348 twin]. Safety gates: the *in-flight* round (result missing, or result still the last message) is never touched; runs of ordinary tool calls (`read`, `bash`, …) keep their reasoning; a run is judged by its summed length so a 2×1200-char run still trips a 2048 gate; non-contiguous reasoning (text between the fragments) is left alone. Sub-fields (merged deepest-wins like every other CompressSettings field):
  - `drop: boolean` — kill-switch; `false` restores the old wire verbatim. Required per-provider for thinking models that mandate `reasoning` round-trip while the request carries `tools` — DeepSeek, GLM thinking and Qwen-QwQ return HTTP 400 when a prior `reasoning_content` is not echoed back. Since #684 this is largely automatic: `deepseek` upstreams **and requests whose body `model` id matches `/deepseek/i`** (#1027 — DeepSeek models served from non-deepseek gateways) are detected statically, and ANY upstream that 400s with a body mentioning `reasoning_content` still teaches the session to keep reasoning (self-healing, session-scoped; the ops log carries `[acp-loop] learned strictReasoningEcho`). The config remains the manual escape hatch for other strict-reasoning upstreams:
    ```jsonc
    "providers": { "https://api.deepseek.com": { "compress": { "reasoning": { "drop": false } } } }
    ```
  - `threshold: number` — character gate; runs **strictly greater** than this are dropped (`0` = drop any non-empty run). Invalid values fall back to the default instead of throwing.

#### `reasoningGuard`

- **Type:** `object` (`{ enabled?, maxContinue?, maxTierN?, markerText?, base?, offset?, debugLog? }`)
- **Default:** *(disabled — off unless you set `enabled: true` at some level)*
- **Status:** ACTIVE
- **Description:** Opt-in guard against gpt-5.x/gpt-6.x **"lattice" reasoning truncation** (issue #739; upstream [openai/codex#30364](https://github.com/openai/codex/issues/30364)). These models intermittently stop at exactly `base*n + offset` reasoning tokens (default `518n−2` → 516, 1034, 1552, …) mid-thought, then answer from a half-finished thought. When an in-scope terminal round hits the lattice **and** carries an `encrypted_content` blob, bili buffers the response, re-sends it replaying its own reasoning plus a continue nudge (up to `maxContinue` continuation rounds), and folds everything into ONE response whose usage is the true summed total. Reasoning streams live to the client during the fold (no full buffering); only the final clean round's non-reasoning output is passed through. Applies to Responses/SSE streaming requests only (bili is SSE-only); compress-injected turns are exempt (the loop owns those). Sub-fields (merged deepest-wins like every other CompressSettings field):
  - `enabled: boolean` — master switch; anything other than `true` keeps the guard fully off. Scope is set by **where** this block sits in the three-level tree (global / provider / model) — there is no separate model list. The strict signature (exact lattice hit + `encrypted_content` + no tool calls) limits which rounds actually trigger recovery.
  - `maxContinue: number` — max continuation rounds after the initial round (default `3`).
  - `maxTierN: number` — highest lattice tier `n` allowed to continue (default `6`); `0` = unlimited. Raise for rare deep-tier truncations (e.g. an `n=11` hit observed on gpt-6-astra).
  - `markerText: string` — nudge text appended as a commentary message each continued round (default `"Continue thinking..."`).
  - `base: number` / `offset: number` — the lattice signature `tokens == base*n + offset` (defaults `518` / `-2`). Override if another model family truncates on a different lattice.
  - `debugLog: boolean` — verbose per-round logging (default `false`).
  ```jsonc
  // enable globally
  { "compress": { "reasoningGuard": { "enabled": true } } }
   // tune per provider (placement scopes it to that provider's traffic)
   { "providers": { "https://your-relay.example": { "compress": { "reasoningGuard": { "enabled": true, "maxContinue": 2 } } } } }
  ```

#### `outputSteering`

- **Type:** `object` (`{ enabled?, verbosityLevel?, effortRouting? }`)
- **Default:** *(disabled — off unless you set `enabled: true` at some level)*
- **Status:** ACTIVE
- **Description:** Opt-in **output-side compression** (issue #1093): two request-time levers that cut *output* tokens, which cost more than input and are billed the instant they stream. The decision logic (turn classification, L0–L4 directive wording, effort clamp) lives in acp-kernel and is shared with the agent side; bili only lands it on the wire, after every other body mutation:
  - **Verbosity steering** — a deterministic conciseness directive appended to the **tail** of the system prompt (never prepended — that would shift the client's prompt bytes and bust the prefix cache). Sentinel-wrapped and idempotent: retries never accumulate it and a level change replaces it in place. Note the wording is byte-stable across releases (a kernel wording edit is a prefix-cache bust for every session at that level).
  - **Effort routing** — classify the last user turn structurally (block composition only, no content pattern-matching); on a *mechanical continuation* (clean tool result, no error, no fresh user signal) an already-present effort field is clamped toward its minimum. Clamp-only: never injects a field the client did not send (models without effort support 400 on it), never toggles `thinking.type`, never raises `minimal`. Wires: OpenAI `reasoning_effort`, Responses `reasoning.effort`, Anthropic `thinking.budget_tokens` (floor 1024), Gemini `generationConfig.thinkingConfig.thinkingBudget` (floor 128; `-1` dynamic untouched).
  - Sub-fields (merged deepest-wins like every other CompressSettings field): `enabled: boolean` master switch; `verbosityLevel: number` 0–4 (0 = no directive, default 2); `effortRouting: boolean` (default on whenever `enabled` is). Out-of-range values fall back to defaults **with a warning** instead of rejecting the block. Applies to all four wires (openai chat / responses / anthropic / google); requests with no system carrier are left untouched (skip-if-absent).
  ```jsonc
  // enable globally
  { "compress": { "outputSteering": { "enabled": true } } }
  // only lower effort, no wording directive
  { "compress": { "outputSteering": { "enabled": true, "verbosityLevel": 0 } } }
  // per provider (placement scopes it to that provider's traffic)
  { "providers": { "https://your-relay.example": { "compress": { "outputSteering": { "enabled": true, "verbosityLevel": 3 } } } } }
  ```

#### `stripImages`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** Opt-in removal of historical image payloads. When `true`, every message **except** the most recent `stripImagesKeepRecent` has its image parts dropped before the wire rebuild; an image-only message collapses to a single `[image]` text placeholder (mixed text+image messages keep their text). Recent-N images are forwarded verbatim, and a freshly-sent image always falls inside that window on the turn it arrives. Off by default — while off, the #488 image-token floor and its overflow `502` stay the opt-in signal for image-heavy payloads. Applies to both compression modes (in plugin mode the agent's own history is untouched; only the upstream-bound wire is slimmed). See issue #617.

#### `stripImagesKeepRecent`

- **Type:** `number`
- **Default:** `5`
- **Status:** ACTIVE
- **Description:** With `stripImages: true`, how many trailing messages keep their images verbatim. Ignored unless `stripImages` is enabled.

#### `visibilityMarkers`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** Controls the 📦/❌ ACP visibility markers emitted after the proxy executes a proxy tool call (`compress` / `decompress` / `search_context` / `acp_status`). When on, each execution appends a marker line to the response stream and/or re-injects a marker message into that round's rebuilt history so the model can see what happened on later turns. Set `false` to suppress both artifacts — for deployments where models imitate or narrate around the markers (outputting their own confirmation lines or commentary; see issue #862). The tool executions themselves are unaffected: calls still run, and paired tool-call/tool-result messages are still recorded as usual; only the marker line/message is omitted. Since #913, `false` also drops the #862 silence clause from the marker-integrity note appended to nudges and the injected compress prompt — an invisible deployment has no marker for the model to imitate or narrate around, so the clause is pure noise there. The #717 anti-forgery segment stays unconditional in every configuration. Same three-level merge as every other field. The #717 anti-forgery stripping of model-emitted fake markers is independent of this flag and stays active.

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

### Soft target with elastic headroom (#1122)

Autonomous agents often want two things at once: keep the *active* context small (cost/latency), while allowing a single task to burst well past that target when it genuinely needs to (e.g., reading a large file). Setting `modelContextLimit` below the model's native window cannot express that — one field plays two roles at once (the usage-ratio denominator **and** the hard preflight wall), so any payload above it gets folded mid-task or fails fast (#1122).

Express it with the existing soft bands instead: keep the limit at the native window, pin the target with `maxContextLimit`:

```jsonc
// model with a 200k native window; keep ~70k active, allow bursts up to the real edge
{
  "compress": {
    "modelContextLimit": 200000,   // = native window → hard wall only at the true edge
    "maxContextLimit": "35%"       // forced-nudge zone starts ≈ 70k (= target ÷ native window)
  }
}
```

How compression actually decides (acp-kernel, verified):

1. **Growth layer (day-to-day driver, absolute tokens):** a proactive nudge fires once cumulative growth since the last anchor (session start / last nudge / post-compression reset) reaches the growth floor **and** enough compressible mass has accumulated. Both numbers are absolute and window-independent by design: adaptive step = `clamp(round(window × 5%), 20k, 50k)` → 20k on windows ≤ ~400k, capped at 50k on ≥1M windows; growth floor ≈ 20k (22.5k on ≥1M). This layer keeps compressing long sessions even far below any percentage band.
2. **Pressure layer (percent of the window):** `usage ≥ maxContextLimit` (default 75%) → a nudge is injected every turn until context drops back under; `usage ≥ emergencyThresholdPercent` (default 95%) → forced nudge + emergency truncation.
3. **Qualification layer (kernel default 45%, not exposed):** gates only the turn-1 cold-start ticket and the block-count floor for T2/T3 tier escalation — not part of the day-to-day path.

Note: setting `maxContextLimit` below the kernel's 45% default works correctly (the layers are independent), but acp-kernel logs a per-turn validation warning (`minContextLimitPct must not exceed maxContextLimitPct`) — log noise only, thresholds are unaffected.

Behavior vs an old low-limit config (e.g., `modelContextLimit: 70000`): the hard wall moves from 70k to the native window (large reads stop being crushed mid-task or failing fast); the forced zone moves from 75%×70k ≈ 52.5k to your chosen %×native; below the forced zone the context drifts per the growth layer instead of being pinned every turn — that drift is the price of elasticity. If you need a strict daily ceiling *and* burst headroom simultaneously, static percentage bands cannot express both; choose the % for the ceiling you accept, or track structure-aware compression (#344).

The same fields work per-provider / per-model (three-level merge), and hot-reload via the web UI.

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
| `BILI_CCR_RETRIEVAL_TTL_MS` | Expiry (ms) for a queued-but-undelivered `acp_retrieve` injection (#1343): if the full text stays queued this long without ever riding an upstream request, it is dropped **loudly** — warn log with refs + reason, `stats.retrieveDropped` bump, and a corrective note on the next request telling the model to re-issue `acp_retrieve`. Default `600000` (10 min); `0` disables expiry. Plugin-lane queue items only; range-restore riders (#1207) are exempt. |
| `BILI_IMAGE_TOKEN_CAP` | Cap the per-image token estimate used by the preflight size gate and output clamp (#488/#496). By default an inline `data:` image counts as `base64 length / 4` tokens with **no cap** — correct for byte-billing relays, but a large over-estimate for pixel-tile upstreams (official Anthropic/OpenAI). For pixel-tile upstreams prefer [`imageBilling`](#imagebilling) (`"pixels"`, or `BILI_IMAGE_BILLING=pixels`) which charges real tile billing instead of capping the byte estimate; the cap still applies on top of both billing modes as a blanket ceiling. Unset = no cap (default). |
| `BILI_IMAGE_BILLING` | Override the image billing mode used by the preflight size gate and output clamp (#767): `pixels` or `bytes`. Live-read per request (no restart); beats the global `imageBilling` and every per-provider `providers.<url>.imageBilling`. Use `bytes` to force conservative billing on a route configured `"pixels"` (e.g. a byte-counting relay behind an OpenAI lookalike host), or `pixels` to enable tile billing process-wide without editing config. See [`imageBilling`](#imagebilling). |
| `BILI_PREFLIGHT_HOLD_MS` | Grace period (ms) before a long preflight compression starts holding the client with keep-alive bytes (default `30000`; see #568 / README "Preflight hold"). |
| `BILI_RECLAIM_FETCH_PATCH` | Set to `0` to disable the native-mode fetch self-heal re-arm (#1158). By default the native fetch intercept installs `globalThis.fetch` as a guarded accessor, so a third-party patch that re-installs `globalThis.fetch` (e.g. dsh-http-proxy's settings refresh writing its frozen pre-bili `originalFetch`) is re-chained as the downstream and model traffic keeps routing through bili. With `0` the classic direct install stays: a third-party re-arm then wins and bili stops seeing model traffic for the session. **Egress note:** while the guard holds, claimed model traffic is dispatched by the bili proxy itself — it no longer rides the third-party chain's egress (e.g. a SOCKS5 proxy configured in dsh-http-proxy; bili's own upstream proxying supports HTTP proxies only). If you need the third-party egress back, set `0` and configure the egress at bili's level (`"proxy": "http://…"`). |
| `BILI_CONFIG_FILE` | Override the config file path (point at any JSON file). |
| `ACP_PORT` / `PORT` | Override the listen port. |
| `ACP_HOST` | Override the listen host. |
| `ACP_UPSTREAM` | Override the default upstream base URL. |
| `ACP_LOG` | Set to `0` to disable request logging. |
| `ACP_AUTO_UPDATE` | Set to `0` to disable auto-update checks. |
| `ACP_UPDATE_TAG` | Dist-tag channel the auto-updater follows (default `latest`, e.g. `dev`). File-config key: `updateTag`. A `pr-N` preview tag is only followed when explicitly configured. |
| `BILI_UPDATE_REGISTRY` | Base URL override for the npm registry used by the auto-updater and `bili update` (default `https://registry.npmjs.org`). Intended for hermetic testing against a loopback registry (the verdaccio instance in the `ACP_TEST_REGISTRY` e2e suite); leave unset in production (#1153). |
| `BILI_UPDATE_CHECK_INTERVAL_MS` | Auto-update check period in milliseconds (default `180000`, i.e. 3 minutes; values ≤ 0 are ignored and the default applies). Shortened by the hermetic e2e suite so it never waits a full cycle (#1153). |
| ~~`BILI_HOST_USAGE_CREDIT`~~ / ~~`hostUsageCredit`~~ | **Removed in #660.** Used to select the host-facing usage mode. The #408 uncompressed-baseline backfill is gone entirely — every host now reports the actually-forwarded (post-fold) request as provider-measured (matches `[acp-usage] input=`). Old values left in env or the config file are ignored; remove them. See the "Bug history lesson" section of PR #691. |
| `ACP_PROVIDERS` | Path to an external `providers.json` (legacy / shared file). |
| `BILI_REPLAY_RETRY_BASE_MS` | Base backoff delay (ms) for acp-loop replay retries after a transient upstream rejection (default `1500`; set `0` to disable the delay). See #189. |
| `BILI_REPLAY_RETRY_MAX` | Total attempts for acp-loop replay retries (default `3`; set `1` to disable retries entirely — legacy fail-fast behavior). See #189. Applies to both transient HTTP failures and #1263 fail-fast network failures (pre-response reset/refused — proxy-recycle class), never to timeout/abort kinds. |
| `BILI_PROXY_KEEPALIVE_MAX_MS` | Keep-alive reuse ceiling (ms) for connections through an upstream proxy (default `55000`). Common proxies recycle idle tunnels on a ~60s cadade; capping our reuse window below that trades a few reconnects for the classic "first request after idle dies with ECONNRESET" failure (#1263). `0` = uncapped (undici defaults). Direct (non-proxied) connections are unaffected. |
| `BILI_UPSTREAM_TIMEOUT_MS` | Idle budget (ms) for upstream requests: time-to-first-byte and time between body chunks (default `720000` = 12 min). A healthy stream that keeps producing chunks is never cut mid-flight; a silent one is. The same value drives the underlying HTTP client's transport timeouts, so this single knob bounds long local-model prefills end-to-end (#551). |
| `ACP_SESSION_HEADER` | Conversation-id header name (default `x-acp-session`). |
| `ACP_REASONING_KEEP` | Responses API only: set `none` to drop all reasoning items. Default routes reasoning through the compression pipeline so it is hidden automatically once its turn is summarized (prevents the unbounded accumulation that broke Codex's prompt-cache prefix). |
| `ACP_RENDER_NONE` | Set to `1` to stop injecting per-message render tags (the `` `<acp>` `` markers carrying `mNNNNN` refs) into outgoing request history — applies to every wire format (OpenAI chat, Anthropic, Responses) and compact rebuilds (#933). Default is `text-only`: the model reads these refs to cite messages in `compress` calls, so only disable them once you've confirmed your workflow doesn't need ref-based compression (e.g. tag echoes leaking into client-visible output). Previously this variable was honored only on the Responses path and compact; #933 extended it to all paths. |
| `ACP_LOG_FILE` | Log file path (default XDG state path; `off` disables the file, keeps stderr). Auto-rotates at 10 MB. |
| `ACP_DUMP_SSE` | Directory to dump raw SSE frames for debugging. |
| `BILI_LOG_MASK_HOSTS` | Set `0` to turn OFF host masking in proxy logs (#897): non-public target hosts (private relays, internal domains) are logged verbatim instead of `<private-host>`. Default is ON (#255 — logs get pasted into public issues); credential-header masking is independent and always on. Real target hosts are always available without touching this flag: `GET /__bili/stats` → `blindTunnels`, `GET /__bili/health` (both loopback-only), and the `acp_status` output. |
| `BILI_SUBAGENT_SPLIT` | Set `0` to turn OFF Claude Code subagent session splitting (#970): by default, anthropic-wire requests carrying the `x-claude-code-agent-id` + `x-claude-code-parent-agent-id` pair (background subagents) get their own `<session>\|sub:<agent-id>` session — own lock chain and compression state — instead of queueing behind the main session's lock. Default is ON. `"subagentSplit": false` in the config file does the same; the env var wins. |
| `BILI_FORK_ADOPTION` | Set `1` to turn ON fork block-adoption (#629): when an anonymous (prefix-affinity) client forks its history mid-conversation (edit-and-resend / regenerate an earlier turn), the new session inherits the parent's compression blocks whose source content is fully present in the forked request — instead of restarting with zero compression state and re-folding the shared prefix from scratch. Default is OFF. `"forkAdoption": true` in the config file does the same; the env var wins. The adoptable inventory is logged on every anonymous fork even while disabled, so you can size the win before flipping it on. |
| `BILI_STABLE_SYSTEM_ANCHOR` | Set `1` to enable stable-system anchoring (#1085) — a **best-effort wire-layer fallback** for prefix caching: the root fix belongs client-side (the client owns its history and decides how to present instruction changes), this only stops the proxy from letting a changed head invalidate the whole cached prefix. **Plain-proxy mode only**: plugin-mode agents (`x-bili-plugin`) own their context management and are never anchored, so clients that already inject cache-friendly updates (e.g. claude-code-style system reminders) are not double-processed. When enabled, bili remembers each session's first-seen head system/instructions block and keeps re-sending those exact bytes even when the client's system prompt later changes. A **localized** change (a file-style edit sharing ≥70% of lines with the version in effect so far) appends a trailing `[System context update] …` user note carrying a compact line diff (`-` removed / `+` added; each note composes sequentially onto the previous one). A **non-localized** change (structural reshuffle, tool-def churn, timestamped banners, heads over 400 lines) is adopted outright — one deliberate cache miss beats appending noise that would mislead the model about its instructions. Churn guard: more than 8 accumulated notes likewise replace the anchor with the newest text and clear the log. The anchor and note log persist with the session and survive compression/compaction (session metadata, not kernel state). Known residual limitation: client-placed `cache_control` breakpoints may still misalign after a head swap. Excluded from anchoring: title-gen micro-requests (OpenAI/Google), Responses compaction-trigger requests, auto-mode classifier requests. Clients implementing their own variant (stable prompt + in-history updates) get zero extra injection — such updates pass through as ordinary history. Default is OFF. `"stableSystemAnchor": true` in the config file does the same; the env var wins. |
| `BILI_CHAIN_CONTENT` | Set `0` to turn OFF the ACP-artifact content fallback of bili→bili chain detection (#1086): when an inbound request carries compression artifacts (render tags / historical `acp_status`+`search_context` tool calls) but neither the `x-bili-hop` header nor local compression state for its session, it is passed through verbatim instead of being processed again (a middlebox may have stripped the hop header from a chained request). Default is ON. `"chainContentDetection": false` in the config file does the same; the env var wins. The `x-bili-hop` signal itself is unaffected by this switch. |
| `BILI_CONFLICT_SCAN` | Set `0` to disable third-party compression plugin detection (#1206). On by default: bili scans the client's own plugin/extension registries — opencode global + project `plugin` arrays, pi global + project `.pi/settings.json` `packages`, omp `config.yml` `extensions`, claude settings `enabledPlugins`/`plugins` + its plugins dir, kimi `plugins/installed.json`, hermes plugins dir, dsh profile dependencies — for another compressor co-resident with bili. Two tiers: **known conflicts** (`opencode-acp`, legacy `billion-context-pi`) and **keyword-suspected** entries (names matching compress / compact / acp / summar* / context*; bili's own entries are always skipped, and non-compression tools like `context7` do not match). Findings surface as launcher stderr lines before client start, a one-time proxy warn log on each session's first request, and the session's conflict ledger — visible in `acp_status`'s `COMPRESSION CONFLICTS` section, aggregated at `GET /__bili/stats` → `conflicts`, and shown as a web-UI banner. Runtime interference evidence (unannounced history rewrites #1001, orphan-block deactivations) feeds the same ledger. The scan is read-only, best-effort, 5-minute cached, and never blocks or modifies client config. |
| `BILI_UPSTREAM_PROXY` | Upstream proxy for the proxy's own outbound connections — highest priority, above per-URL/per-provider config. See the README *Upstream proxy* section. |
| `BILI_INHERITED_HTTP_PROXY` / `BILI_INHERITED_HTTPS_PROXY` / `BILI_INHERITED_ALL_PROXY` / `BILI_INHERITED_NO_PROXY` | Not user-facing — set automatically by the launcher when it spawns the proxy (#1012). The launcher strips the shell's proxy vars from both the client and the proxy child (clients must send to bili; the proxy must not have its model egress hijacked by a shell proxy), but it forwards the user's pre-strip proxy under these names so the proxy's **auxiliary egress** (MITM blind tunnels — client-side MCP/web traffic) can still ride the user's VPN. They feed only the blind-tunnel fallback tier: explicit routes / global `proxy` / `BILI_UPSTREAM_PROXY` / explicit `"upstreamProxyMode": "direct"` all still win, and a value pointing at bili's own port is dropped. Model egress is unaffected (stays direct unless explicitly configured). |
| `BILI_ATTACH_HEALTH_DEADLINE_MS` | Health-wait deadline (ms) for dsh/opencode attach verification when the attach target is down but this process's model channel is **pinned** to it (routed `/bili/…` model traffic was observed against it): bili waits for the target to come back instead of spawning a second instance — a spawn would split the session (model traffic stays pinned, bili tools would 404 against the other instance). When the deadline elapses it fails loudly and keeps re-checking on every model request until the target returns (default `15000`). See #1365. |
| `BILI_ATTACH_EVIDENCE_GRACE_MS` | Grace window (ms) during which a dsh/opencode attach verification probing a dead target waits for routed-channel evidence to appear before falling back to the legacy spawn path (covers the decision-before-first-request race: the probe fails at t≈0 while the first model request lands at t≈1s) (default `5000`). See #1365. |
| `BILI_PERSIST` | Set `0` to disable session persistence (in-memory only, lost on restart). |
| `BILI_PERSIST_DEBOUNCE_MS` | Debounce window for persistence writes to disk, in ms (default `500`). |
| `BILI_PERSIST_TAIL_TOKENS` | Token budget for the persisted conversation snapshot (#401). The disk record stores the **folded view** (block summaries in place of compressed ranges) truncated to the newest messages within this budget — never the raw full history. Default `16384`; `0` disables message persistence entirely (block summaries and compressed originals still persist; `bili export` falls back to block-only rendering). Live in-memory sessions are unaffected — `bili export` of a live session is always complete. |
| `BILI_PERSIST_ZSTD` | Set `1`/`true` to enable zstd compression of session files (#1080, owner decision: **default off** — plain JSON maximizes recoverability: jq/grep-debuggable, and immune to the downgrade tail risk). When enabled, every session file that actually shrinks is written as `BILIZSTD1` — a small header (magic + format version + mode byte) over the JSON body, zstd-compressed on Node ≥ 22.15 and stored raw on older runtimes; readers accept both bodies (native zstd, else the bundled WASM fallback), so files stay readable across runtimes and versions. Payloads the framing cannot shrink (tiny sessions) and key-less raw bodies stay bare JSON on disk. Independent of `BILI_ENCRYPTION_KEY` — with both active, the compression choice is recorded in the mode byte inside `BILIENC1`. Existing plain-JSON files are NEVER rewritten at boot (downgrade safety — a mass re-encode would make rolling back to an older bili read its own writes as "corrupt"); they convert organically on their next save. Note: once a session has been saved as `BILIZSTD1`, an OLDER bili (< 0.1.135) cannot read it — this caveat applies only to deployments that opted in; unset or any other value keeps plain JSON. |
| `BILI_PERSIST_EPERM_ALERT_THRESHOLD` | N consecutive persist write failures (`EPERM`/`EBUSY`/`EACCES`) on one session before the one-time "add this dir to antivirus exclusions" alert fires (default `5`). Windows only. See [Windows: exclude the sessions dir](#windows-exclude-the-sessions-dir-from-antivirus-362). |
| `BILI_PERSIST_EPERM_ALERT_REPEAT_MS` | Re-alert window for the persist EPERM alert, in ms. `0` (default) = alert once then stay silent; `>0` = re-alert at most every that many ms while the failures continue. |
| `BILI_TUNNEL_ALLOWED_HOSTS` | `/bili/<absolute-url>` tunnel admission for **remote clients** (#409): comma-separated `host` or `host:port` entries that unlock loopback/private destinations (e.g. a LAN relay or the machine's own sglang) for non-loopback clients. The proxy itself and link-local/metadata addresses are always denied; local (loopback) clients always pass. |
| `BILI_MAX_SESSIONS` | Max sessions held in memory (default `256`; LRU eviction — disk is the source of truth). |
| `BILI_SESSIONS_DIR` | Directory for persisted session state (default XDG data dir). |
| `BILI_SESSION_GC` | Cleanup of stale session files (#1082) is **opt-in**: set to `1`/`true`/`on` to enable — off by default, because session files are user data (exportable, resumable) and there is no silent deletion policy. When enabled, the sweep (boot + hourly) deletes a file only when BOTH conditions hold: older than `BILI_SESSION_GC_MAX_AGE_DAYS`, AND small in the lossless sense — the session was **never compressed** (zero folded blocks) and its newest request body ≤ the token ceiling below, so resuming it costs one cold rebuild from the client's own history and nothing else. Safety rails: compressed sessions are NEVER deleted (their summaries cannot be rebuilt losslessly); a session still held in memory is skipped unless idle since its last disk write; unreadable/corrupt files are left in place; every deletion is audit-logged individually (path, size, age) plus one summary line per non-empty sweep; only the sessions dir is ever touched; emptied protocol subdirectories are removed. Note the resident guard is per-process: another proxy instance sharing `BILI_SESSIONS_DIR` that does not persist (e.g. `BILI_PERSIST=0`) never refreshes file mtimes, so its still-live session files can age out and be swept — the cost is the same bounded cold rebuild, backstopped by the age gate. CCR content stores (#1097) share the session's lifecycle (#1180): a `<hash>.content-store.json` companion is deleted together with its session file, an orphaned companion (session file already gone) is swept once past the age gate, and an unreadable companion keeps its session file too (never guessed at). |
| `BILI_SESSION_GC_MAX_AGE_DAYS` | Minimum age (days) before a session file becomes a GC candidate (default `7`). Keep it far beyond any plausible resume window: after deletion a resumed session restarts message numbering from m00001 while a resuming agent's transcript may still cite old numbers (kernel contract: ids are never reused). |
| `BILI_SESSION_GC_MAX_TOKENS` | Size ceiling (tokens) for GC eligibility (default `1000000` = 1M, owner-set in #1082). Judged against the **decoded** context, never file bytes (encrypted/zstd files are far smaller on disk): the token estimate of the newest request body (`rawInputTokens`, recorded per turn) wins when present; unrecorded legacy files use `stats.contextTokens`; and the companion content store's footprint (#1097: unique-content via the kernel's CJK-aware `defaultCountTokens`, same estimator as `rawInputTokens`, #1180) is added on top, so a small session carrying a huge store does not slip under the ceiling. Applies only to never-compressed sessions — files with folded blocks are always kept regardless of size, since their summaries cannot be rebuilt losslessly from a re-send. |
| `BILI_SESSION_GC_INTERVAL_MS` | Background GC sweep interval in ms (default `3600000` = 1h). A sweep also runs once at boot. |
| `BILI_ENCRYPTION_KEY` | Encrypt session files at rest (#708) for deployments on untrusted nodes. Exactly 32 bytes, hex (64 chars) or base64; unset = unencrypted plain-JSON files (or `BILIZSTD1` when `BILI_PERSIST_ZSTD=1` — see `BILI_PERSIST_ZSTD`). When set: every session file is written as `BILIENC1` AES-256-GCM over JSON that is zstd-compressed only when `BILI_PERSIST_ZSTD=1` (zstd on Node ≥ 22.15, raw body otherwise) — enabling compression also shrinks the file ~5–10×. Encryption and compression are now independent knobs (#1080). The key comes ONLY from this environment variable — never written to disk or logs — so keep it out of the same filesystem's reach. Invalid values abort startup (fail fast, never silently unencrypted). Booting with the wrong key skips the affected sessions as corrupt (logged, no crash). Losing the key makes encrypted sessions permanently unreadable. Symmetric by design (the same process encrypts and decrypts). Existing unencoded files are never rewritten at boot — they encrypt organically on their next save (downgrade safety; see `BILI_PERSIST_ZSTD`). Threat model (#708, owner-confirmed): it defends against **offline/mechanical** file acquisition — provider disk swaps, offline disk snapshots after node-image drift, stolen volumes, leaked backups, cloud-synced state dirs — where an offline third party cannot read the content without the key. It does NOT defend against targeted adversaries with live access to the node; for that tier move the trust root out of the proxy (KMS / TEE / confidential VMs, hardened permissions) instead of solving it inside the proxy — at that level far more than the key is exposed, so proxy-level key handling is not the boundary to hold (`BILI_PERSIST=0` disables persistence entirely). Double-encrypting the key with a second key from the same process/environment adds nothing: in every offline-theft scenario the attacker lacks exactly one artifact — your off-disk secret — whether it is called the data key or the wrapping key; only a wrapping key in a different trust domain (KMS/TPM/TEE) raises the bar, and that is scenario 2 above. |
| `BILLION_CONTEXT_PROXY` | Exported by the launcher; client-side bili plugins/extensions detect it and self-disable their own compression (no double compression). |
| `BILLION_CONTEXT_PLUGIN` | Set `0` to disable plugin mode entirely (wire-level tool injection resumes). |
| `BILI_LAUNCHER_MODEL_WINDOWS` | Internal: the launcher hands the client's own per-model context windows (pi `models.json`, omp `models.yml`, opencode `models.<id>.limit`, codex `model_context_window`) to the spawned proxy as JSON, so the nudge denominator matches the real window for self-hosted models. Only the launcher sets it — no user configuration. |
 | `BILI_LAUNCHER_LANE` | Internal: the launcher hands its client's lane name (pi / codex / claude / …) to the spawned proxy, which records it in the instance file (#1225). Reuse is identity-based: two instances with *different declared* lanes never attach to each other, while an instance without a declared lane is wildcard-compatible on the lane axis but still subject to the #1335 lifecycle gate (see `BILI_NATIVE_ATTACH_EXTERNAL`). Only the launcher sets it — no user configuration. |
| `BILI_LAUNCHER_PLUGIN` | Set `0` to disable the launcher's bili MCP server injection for claude/codex (pure wire mode); `1` forces plugin mode. Default: injected — except codex with a local/private upstream (sglang/vllm/ollama cannot parse codex's namespace tool type, so bili auto-falls back to wire tools there). See [Launcher Reference](#launcher-reference). |
 | `BILI_LAUNCHER_DIRECT` | Set `1` for direct-URL routing in the launcher (drop MITM/CA trust). See [Launcher Reference](#launcher-reference). |
 | `BILI_NATIVE_ATTACH_EXTERNAL` | Attach-gate escape hatch (#1335). Native hooks attach to a running proxy only when it reports an armed session-lifecycle watchdog (`watchdog.armed == true` in `/__bili/health`) — a manually started `bili start` daemon has no lifecycle owner (refuses watcher registration, never dies with sessions, often runs an older build), so by default each session spawns its own ephemeral proxy instead of attaching to one. Set to `1`/`true` when you deliberately run a resident daemon for your native hooks to ride on: any code/lane-compatible listener becomes attachable again regardless of watchdog state (including pre-#1330 builds that report no `watchdog` field at all) — you then own the daemon's lifetime and version yourself. `"native": { "attachExternal": true }` in the config file does the same; the env var wins (`0`/`false` closes the gate even over a permissive file). Default is closed. See the "The attach gate (#1335)" section of [README.md](README.md). |
 | `BILI_CLAUDE_UPSTREAM` | claude direct mode: your relay endpoint, when `ANTHROPIC_BASE_URL` already points at a relay the launcher would otherwise bypass. |
| `BILI_CODEX_COMPACT` | Codex native-compaction handling. Default `intercept`: bili intercepts codex's compaction requests and forges a local handoff to the ACP state when the safety gate passes (transform ok + steady-state usage < 90% of the window + at least one active compressed block) — trigger form forges a 2-frame SSE, endpoint form forges `{output}` — and never contacts upstream. Forged ACP summaries are re-injected as a history-borne handoff message (developer-message fallback) so compressed content stays visible after codex truncates its history. Set `pass` to opt out and forward codex's compaction requests upstream (native compaction backstops). On any gate failure the request passes through untouched. |

---

## Upstream Failure Diagnostics (proxied upstreams)

Every upstream transport failure is classified into a `kind=` that leads its log line (and the `error:` string clients/status see), each with a remediation hint (`hint=...`). The taxonomy (#1263):

| kind | meaning | bili behavior |
|------|---------|---------------|
| `client-abort` | downstream client disconnected | nothing (request dead by definition) |
| `upstream-timeout` | idle budget expired or connect timed out | **not retried** — never stack wait budgets |
| `proxy-reset` | connection died pre-response **through a proxy** (prime suspect: proxy idle-recycle / payload cap / node churn) | transparent replay, bounded by `BILI_REPLAY_RETRY_MAX` (default 3 total attempts) |
| `upstream-reset` | same, direct connection (suspect upstream/local network) | same (bounded by `BILI_REPLAY_RETRY_MAX`) |
| `connect-refused` | TCP refused (the proxy when configured, else upstream) | same (bounded by `BILI_REPLAY_RETRY_MAX`) |
| `dns` / `tls` / `unknown` | resolution / handshake / unclassified | not retried |

Handshake-class resilience is paired with a keep-alive cap for proxied connections (`BILI_PROXY_KEEPALIVE_MAX_MS`, default 55s) so bili stops offering proxies sockets they are about to recycle.

**Four-step checklist** when long sessions show periodic connection failures (from #1249):
1. Grep `bili.log` for `kind=` — `proxy-reset` clusters implicate the external proxy; `upstream-timeout` implicates upstream health.
2. Align timestamps of the failing requests with the external proxy's own access log (same host clock) — a recycle entry at the same millisecond closes the case.
3. Confirm which hop: `proxy=<url>` vs `proxy=direct` in the same line; check request body size (`content-length` of the forwarded request) against the proxy's documented payload cap.
4. If the proxy is the recycler, either raise its idle timeout or leave bili's 55s reuse cap + one-replay safety net to absorb it.

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
| `bili dsh [opts --] [args]` | Proxy + **deepseek-harness** (non-loopback upstreams via proxy envs, loopback via `/bili/` rewrite — #535; args like `--profile web "task"` pass through) |
| `bili codebuddy [opts --] [args]` | Proxy + **codebuddy** (Tencent CodeBuddy Code CLI) — `CODEBUDDY_BASE_URL` `/bili/` rewrite, OpenAI chat-completions wire; budget via `CODEBUDDY_AUTO_COMPACT_WINDOW` (#640) |
| `bili qoder [opts --] [args]` | Proxy + **qoder** — cert-MITM via `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`; model endpoint hardcoded https so no `/bili/` rewrite (default host map whitelisted) (#653) |
| `bili trae [opts --] [args]` | Proxy + **Trae CLI** (ByteDance, closed Go binary) — cert-MITM via `HTTPS_PROXY` + `SSL_CERT_FILE`; model host from `TRAE_CLI_API_HOST` or the default enterprise gateway (#655) |
| `bili jcode [opts --] [args]` | Proxy + **jcode** (Rust agent harness) — env-only cert-MITM launch via `HTTPS_PROXY` + `SSL_CERT_FILE`; hosted model host (`api.z.ai`) whitelisted, local loopback providers stay direct via `NO_PROXY` |
| `bili kimi [opts --] [args]` | Proxy + **Kimi Code** (Moonshot CLI) — cert-MITM via `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`; provider/model hosts from `~/.kimi-code/config.toml` (`KIMI_CODE_HOME` respected) or the managed OAuth endpoints when none declared; loopback endpoints inventoried with a manual `/bili/` prefix hint (#757) |
| `bili test pi` | Non-polluting end-to-end smoke test of the pi path |
| `bili export [session] [--full] [--output FILE]` | List persisted sessions / export one as a Markdown handoff — see [Sessions & Migration](#sessions--migration) |
| `bili acp-cache diff <dump-dir> [--json] [--log FILE] [--no-log] [--session SID]` | Attribute cache misses from `ACP_DUMP_BODY` dumps — prefix-diffs adjacent requests per session (#1266) |
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
| **CodeBuddy** (VS Code IDE) | IDE account login | `copilot.tencent.com` (reached via `http.proxy`) | ✅ user-verified (#897) |

> **Codex exception:** Codex exposes a top-level `openai_base_url` config field, so the ChatGPT login version CAN use the `/bili/` prefix (see above). MITM is not needed for Codex.

> **ZCode native mode (#1145):** ZCode is the only client in this list that also has a **native plugin mode** — `bili plugin install zcode` routes model traffic through the provider store (`~/.zcode/v2/config.json`, or `provider_config.json` on v3.14+) and needs no GUI proxy/CA setup at all. Native mode does not touch the MITM surface: if you run both, keep the GUI proxy settings (and the `"mitm://zcode.z.ai": { "passthrough": true }` route, #661) for login traffic. Full mechanics: README's *ZCode* section.

MITM is scoped to a **whitelist** of model hosts (`open.bigmodel.cn`, `api.anthropic.com`, `api.openai.com`, `chatgpt.com`). All other HTTPS hosts are blind-tunnelled — billion-context never decrypts non-model traffic.

> **CONNECT-only clients (`http.proxy`):** many IDE-class clients (CodeBuddy, Cursor, Windsurf, …) expose no model base-URL setting — they route all traffic through an HTTP proxy via `CONNECT`. Such a client is only decrypted when its model host is whitelisted above (or discovered/auto-whitelisted by a launcher); otherwise its tunnels are **blind**: no error, but also **no compression**, because billion-context never sees the cleartext. This misconfiguration is surfaced explicitly (#897): the first blind tunnel per host logs a one-time `BLIND TUNNEL WARNING` with the fix steps; `GET /__bili/health` and `/__bili/stats` report `blindTunnels` (count + exact target hosts, loopback-only); and `acp_status` gains an `UNDECRYPTED TRAFFIC (instance-level)` section while such tunnels exist. Fix: add the client's model domain to `"mitm".domains` (or `BILI_MITM_DOMAINS`), restart, and trust the root CA per the steps below. Note proxy logs mask non-public target hosts by default (`<private-host>`, #255) — set `BILI_LOG_MASK_HOSTS=0` to see them verbatim in your local log.

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
| pi | `HTTPS_PROXY` + `BILI_PROVIDER_REWRITES` env manifest (extension `registerProvider`) | `NODE_EXTRA_CA_CERTS` |
| omp | `HTTPS_PROXY` + `BILI_PROVIDER_REWRITES` env manifest (extension `registerProvider`) | `NODE_EXTRA_CA_CERTS` |
| codex | `HTTPS_PROXY` + `-c key=value` overrides | `SSL_CERT_FILE` → `combined-ca.pem` |
| claude | `ANTHROPIC_BASE_URL` = `/bili/` URL | none needed |
| opencode | `HTTPS_PROXY` + isolated `OPENCODE_CONFIG` | `NODE_EXTRA_CA_CERTS` |
| hermes | `HTTPS_PROXY` (plain-http rides absolute-form forward-proxy requests) | `SSL_CERT_FILE` → `combined-ca.pem` (+ legacy `HERMES_CA_BUNDLE` → `root-ca.pem`) |
| dsh | `HTTPS_PROXY` (+ `HTTP_PROXY` for plain-http) + `DEEPSEEK_BASE_URL`; **loopback-only** isolated `DSH_HOME` | `SSL_CERT_FILE` → `combined-ca.pem` |

`NODE_EXTRA_CA_CERTS` *appends* to the built-in trust store, so it points at the MITM root alone (`root-ca.pem`). `SSL_CERT_FILE` *replaces* the default CA bundle, so for codex/dsh/hermes it points at `combined-ca.pem` — a bundle containing the MITM root **plus** the system/Node public roots — keeping pip/git/curl style TLS (blind-tunnelled, real certificates) working inside the child env (#152; hermes since #1375, because current hermes resolves ambient trust only through `SSL_CERT_FILE`).

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
| dsh | `~/.dsh/settings.yaml` — every `baseURL`/`baseUrl`/`base_url` value, split by destination (loopback → `/bili/` rewrite; non-loopback https → MITM whitelist; non-loopback http → `HTTP_PROXY`); plus the built-in `deepseek-official` route via `$DEEPSEEK_BASE_URL` |

### Generated files (what gets written — last resort only, #535)

The launcher prefers file-free injection (env vars > CLI flags/extension APIs > generated files; see TECHNICAL-NOTES.md, “Injection priority” section). Where a file is unavoidable it is a **copy** — the real config is never edited:

- **pi / omp** — nothing is written (#535): provider baseUrls ride the `BILI_PROVIDER_REWRITES` env manifest consumed by the bili extension at load (`registerProvider`), and auto native compaction is cancelled in-extension (`session_before_compact`; omp distinguishes auto vs manual via the `auto_compaction_start` announcement, #851) — but only on positive evidence the proxy actually carries the conversation (the plugin stamped `x-bili-plugin-conversation` for this session id, or omp's identity register succeeded, or `/__bili/plugin/status?conversationId=` confirms it); non-http(s) provider baseUrls (e.g. pi-claude-bridge's literal `"claude-bridge"`) are never cancelled, so their own compaction takeover keeps working (#1382) — manual `/compact` stays user-owned either way. The real `~/.pi` / `~/.omp` homes are untouched.
- **opencode** — a temp `opencode.json` pointed at by `OPENCODE_CONFIG` (removed when the client exits), with `/bili/`-rewritten plaintext baseURLs **plus the thin plugin appended** (`/acp` + `/acp-cache` commands). On OpenCode 1.x the `opencode-acp` entries are stripped from the clone (the host must not load it armed) and the thin plugin imports that same package as a library instead, gated on legacy sessions; the first stripped spec rides along via `BILI_OPENCODE_ACP_SPEC` so the bridge imports the exact copy the host would have loaded (#920). Relative local plugin specs (`./x`, `../x`) are re-anchored to absolute paths in the clone — opencode resolves them against the declaring config file's dir, which the clone no longer is (#826).
- **hermes** — nothing is written (#535): its httpx stack rides `HTTPS_PROXY` (+ `SSL_CERT_FILE` → `combined-ca.pem`; legacy `HERMES_CA_BUNDLE` stays set for older builds, #1375) — https via CONNECT cert-MITM, plain-http via absolute-form forward-proxy requests. If no providers are configured, the launcher prints a warning and hermes runs **unproxied** (compression off).
- **dsh** — split by destination (#535): dsh's fetch stack honors proxy envs except for an unconditional loopback bypass, so **non-loopback** upstreams ride `HTTPS_PROXY` (cert MITM) / `HTTP_PROXY` (absolute-form forward-proxy requests) with `SSL_CERT_FILE` → `combined-ca.pem`; only **loopback** upstreams keep the persistent overlay `DSH_HOME` (`~/.dsh-bili`) with a rewritten `settings.yaml` routing them through `/bili/`. `profiles/`, credentials and sessions are symlinked through; the real `~/.dsh` is never touched. The built-in `deepseek-official` route is captured separately via `$DEEPSEEK_BASE_URL` (dsh resolves `settings llm-deepseek.baseURL` ?? env ?? default, so a user setting wins and the env is the zero-config fallback) — with no custom providers the deepseek route is still proxied out of the box.

### Native tools in the launcher

- **pi** — if the plugin is NOT installed, the launcher rides pi's `-e <file>` flag to load `dist/agent/pi.js` for that run only (nothing is written): native tools + the `/acp`, `/acp-cache` and `/acp-rule` commands out of the box (`/acp-cache` defaults to the summary ledger — totals, verdicts, anomalies; append `full` (or `--full`) for the every-line listing, same as passing `detail: "full"` to the `acp_cache` tool). If it IS installed, the symlinked `settings.json` already loads it — no `-e` is added.
- **omp** — does NOT ship the plugin; the launcher auto-injects `-e dist/agent/omp.js` when the config carries no loadable bili entry (same zero-config ride as pi). Two omp-specific mechanics make the plugin fully native there: omp 17.x mounts extension tools that omit `loadMode` under its `xd://` device URLs (invisible to the model's main turn), so the plugin registers its tools with `loadMode: "essential"` — the model gets the four ACP tools natively; and since omp's fork emits no `before_provider_headers`, the plugin binds the conversation via the launcher identity register (`POST /__bili/plugin/register`, keyed by omp's session id = `prompt_cache_key`/`x-session-id`) — bound sessions run in plugin mode (wire injection suppressed) with the native `/acp`, `/acp-cache` and `/acp-rule` commands.
- **opencode** — the temp config appends the thin plugin automatically.
- **claude / codex** — on by default: the launcher injects a single `bili` MCP server (`--mcp-config` for claude, `-c mcp_servers.bili.*` for codex — both ephemeral, nothing written to host config), so the host gets native tools out of the box (verified with claude 2.1.227 / codex 0.147.0). `BILI_LAUNCHER_PLUGIN=0` falls back to plain wire mode — for hosts older than the verified builds that have not been tested against the injection flags.
- **codex + self-hosted upstream auto-fallback** — codex 0.147 ships MCP tools to the model as a `namespace` tool type; self-hosted servers (sglang/vllm/ollama/llama.cpp) do not parse it, leaving the tools silently invisible. When the codex upstream host is loopback/private (`127.0.0.1`, RFC1918, ULA, `.local`, …) and `BILI_LAUNCHER_PLUGIN` is unset, bili automatically uses wire mode instead (flat tools every server understands) and says so on stderr. `BILI_LAUNCHER_PLUGIN=1` forces plugin mode regardless.
- **hermes** — no plugin API; always wire mode.
- **dsh** — the launcher always splices a `--patch <file>` flag into dsh's argv (written to `~/.dsh-bili/.bili-acp.patch.yml`), inserting `dist/agent/dsh-acp.js` into the profile's loader tree: the native `/acp` and `/acp-cache` commands, same shape as dsh's own `/compact` (`/acp-cache` shows the default summary ledger — dsh's command API passes no arguments, so there is no `full`). Works on every profile that composes the commands service (web/tui interactive surfaces; the `headless` one-shot driver sends its task straight to the model and parses no commands — `/compact` behaves the same there). Subcommand forms are handled: `dsh web` gets the flag after `web`, `dsh plugin`/`--dump-default-config` take none.

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

Plugin-equipped sessions are detected automatically via request headers — wire-level tool injection is then suppressed for them (no double compression, native tool UX). Works in both proxy modes: the `/bili/` prefix baseURL **and** MITM transparent mode. The plugin can also report the agent's own model context window (`x-bili-plugin-context-window`) and read live context usage via `GET /__bili/plugin/status`. One header goes the other way: `x-bili-plugin-bypass: 1` makes the proxy raw-passthrough the request ahead of any pipeline processing (no session binding, injection, or compression) — stamped by the opencode bridge for legacy acp sessions whose compression runs in-process (#920).

### install / remove / list

```bash
bili plugin install pi      # add this billion-context install to pi's settings.json (packages)
                                  # npm installs write the pi-managed npm: spec; dev checkouts keep the abs path
bili plugin install omp     # same for omp (config.yml extensions)
bili plugin install claude  # register the bili MCP server (claude mcp add, user scope) + write
                                   # <configdir>/commands/acp-cache.md (model-mediated /acp-cache)
bili plugin install codex   # append [mcp_servers.bili] to ~/.codex/config.toml
bili plugin install opencode  # self-spawning native plugin (+ tools) in ~/.config/opencode/opencode.json
                                  # --with-mcp also adds the mcp.bili MCP face (no origin pin — live discovery)
bili plugin list            # install status for every supported host
bili plugin remove pi       # undo (original files backed up to *.bili-bak once)
```

`install pi` also replaces any **legacy** billion-context entries (old `npm:billion-context-pi` references, stale `npm:billion-context@x.y.z`, leftover dev-checkout paths) so exactly one bili plugin stays live; when it drops entries the output also reminds you that a **project-scope** entry (`pi install -l`, written to `<project>/.pi/settings.json`) is outside this global settings and must be removed by hand. With an npm-installed bili the written entry is the pi-managed spec `npm:billion-context` — pi installs it into `~/.pi/agent/npm/` automatically (also on startup if missing) and `pi update` upgrades it, so the entry survives node prefix moves across machines; a dev/checkout install keeps the machine-local abs path (pi loads local package dirs directly). Both load the `pi` manifest → `dist/agent/pi-native.js`, the self-spawning native entry — bare `pi` gets full plugin-mode compression with no launcher (#519).

**Coexistence with the standalone `billion-context-pi` extension.** The two are mutually exclusive — both active means double compression. Three nets: the installer strip above (global settings), the `BILLION_CONTEXT_NATIVE=pi` marker the native entry sets synchronously at load (`billion-context-pi` **0.1.72+** re-reads it on every event and refuses; 0.1.71 and older check `BILLION_CONTEXT_PROXY` only at load time, before the native proxy exists), and a runtime scan: once its proxy is up, the pi-native entry reads both pi settings files and warns loudly about any co-resident legacy entry the installer never saw (project scope, or installed after the fact).

The installed plugin is a **thin** one (~5 KB, zero runtime deps): it detects the proxy (from the `/bili/` baseURL or `BILLION_CONTEXT_PROXY`), fetches tool schemas from the proxy, registers native tools, and forwards executions — the proxy remains the single compression authority, so plugin and proxy always match versions. Hosts without a plugin API (claude, codex) install the MCP bridge (`dist/mcp.js`) instead — same protocol underneath, though MCP has no slash-commands (no `/acp` panel command; claude additionally gets a model-mediated `/acp-cache` markdown command written to `<configdir>/commands/acp-cache.md`, whose prompt drives the `acp_cache` MCP tool — the model pastes the report back verbatim). opencode has its own plugin API, so its install adds the native plugin tools and no MCP face by default (`--with-mcp` opts in; the entry carries no `BILI_MCP_PROXY` pin — `dist/mcp.js` discovers the live proxy via the instance file at call time, which survives the native plugin's ephemeral-port restarts, #926).

Kill switch: `BILLION_CONTEXT_PLUGIN=0` disables plugin mode entirely (wire-level injection resumes).

**When do you need `plugin install` at all?** Launcher users mostly don't (see [Launcher Reference](#launcher-reference) — pi/omp get `-e` auto-injected, opencode auto-injects, claude/codex get the MCP server auto-injected, dsh gets the native `/acp` and `/acp-cache` commands via `--patch`, hermes is wire-only). It's for a manually-configured client (`/bili/` prefix or MITM) where you want the native panel: pi/omp/opencode get native tools + `/acp` and `/acp-cache` (pi/omp additionally get `/acp-rule`; on omp the fork hides extension tools from the model — the plugin's value there is those commands); claude/codex get native MCP tools (no `/acp`; claude gets the model-mediated `/acp-cache` markdown command); dsh gets `/acp` and `/acp-cache` through the launcher's `--patch` (a manually-configured dsh can add the same patch itself); hermes can't (wire only). Without any plugin everything still works — compression runs via wire-injected tools, and the model can be asked to call `acp_status` to check live usage.

### Detecting other compression plugins (#1206)

Two compressors on one conversation double-compress and corrupt message refs, so bili actively looks for other compressors co-resident with itself:

- **Scan** (read-only, best-effort, 5-minute cache): opencode global + project config `plugin` arrays; pi global + project `.pi/settings.json` `packages`; omp `config.yml` `extensions`; claude settings `enabledPlugins`/`plugins` keys + `~/.claude/plugins/` dir; kimi `plugins/installed.json`; hermes `~/.hermes/plugins/` dir; dsh profile `package.json` dependencies. Two tiers: **known conflicts** (`opencode-acp`, legacy `billion-context-pi` — deterministic) and **keyword-suspected** entries (names matching compress / compact / acp / summar* / context*; bili's own entries are always skipped, non-compression tools like `context7` do not match).
- **Where findings surface:** launcher stderr before the client starts; a proxy warn log on each session's first request (client identified from the `x-bili-plugin` header or wire headers); and the session's conflict ledger — `acp_status`'s `COMPRESSION CONFLICTS` section, `GET /__bili/stats` → `conflicts`, web-UI banner.
- **Runtime evidence:** unannounced history rewrites (#1001) and orphan-gc deactivations (summarized content deleted out of the client's history) are recorded in the same ledger, so *suspected* coexistence and *observed* interference cross-check each other.
- Under the opencode launcher/native mode a present `opencode-acp` is info-only by design (#920 absorbs it for legacy sessions); everywhere else it warns.
- Disable: `BILI_CONFLICT_SCAN=0`.

---

## Sessions & Migration

### Compression state lives in the proxy (#151)

Compression state (blocks, summaries, original message cache) lives **in the proxy**, not in the client. The client's own local history is the full uncompressed view. Two consequences:

- If you point the client back at the real upstream (or stop the proxy), the client replays its **full local history** every turn. After a long compressed session this can exceed the model's context window (`context_window_exceeded`).
- There is no way to "unpack" a compression block into the client's local history — the client never saw the compressed form.

### Storage lifecycle at boot (#401)

The proxy boots session storage with a **single** directory walk+parse (load and the one-time #286 identity migration run over the same parsed map). Sessions are kept permanently — the design goal is that a year-long conversation is never lost — so there is no retention or size-budget pruning. The #286 migration writes a `.bili-migration-286.done` marker after its first pass, so it never re-scans or re-logs on later boots.

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

### Windows: exclude the sessions dir from antivirus (#362)

billion-context persists each session's compression state to one JSON file per session under the sessions dir (`%USERPROFILE%\.local\share\billion-context\` by default) and rewrites that file on every turn of a long session. On Windows, real-time antivirus (Windows Defender), the search indexer, or a sync tool (OneDrive) can lock that directory mid-write. When the lock holds across several writes, the rename fails with `EPERM` and every persist for that session fails until the lock is cleared.

When the same session fails N consecutive writes (default `5`, tunable via `BILI_PERSIST_EPERM_ALERT_THRESHOLD`), the proxy logs a **one-time, actionable alert** naming the exact directory to exclude. It does not repeat (set `BILI_PERSIST_EPERM_ALERT_REPEAT_MS > 0` to re-alert at most every M minutes while the failures continue).

To stop the failures at the root, add the sessions dir to your antivirus exclusions and keep it out of any sync folder:

1. **Windows Defender exclusions:** Settings → Privacy & security → Windows Security → Virus & threat protection → Manage settings → **Exclusions** → **Add an exclusion** → *Folder* → select `%USERPROFILE%\.local\share\billion-context\`.
2. **Do not sync this directory.** Make sure OneDrive (or Dropbox / Google Drive / similar) is not syncing `%USERPROFILE%\.local\share\billion-context\`. If it lives under a synced folder, relocate it with `BILI_SESSIONS_DIR` to a non-synced path.

High-frequency persist writes otherwise re-trigger the real-time scan on every turn — which is what produces the `EPERM` write failures. Once the directory is excluded, the alerts stop.
