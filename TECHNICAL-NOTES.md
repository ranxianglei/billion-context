# Technical notes

Mechanism-level details behind the three usage options in the README. The
README keeps each option concise; the "how it actually works" material lives
here instead of between the options.

## Native plugin lifecycle (Option 1)

At load the plugin **spawns its own proxy** (or attaches to a healthy
running one that passes the attach gate below — a parent-pid watchdog tears
it down when the client exits), rewrites model traffic to
`<proxy>/bili/<upstream-url>`, registers
`compress` / `decompress` / `acp_status` as native client tools (plugin
mode), and binds the `/acp` panel to the current session. It also reports
the client's **own model config** to the proxy (runtime-info protocol,
#955) so compression budgets use the real window instead of a registry
guess. Opt-out envs: `BILI_NATIVE_PI=0`, `BILI_NATIVE_OMP=0`,
`BILI_NATIVE_OPENCODE=0`, `BILI_NATIVE_DSH=0`, `BILI_NATIVE_KIMI=0`.

## Native attach gate — health contract (#1335/#1338)

A native hook may attach to an existing proxy only when it can prove the
proxy's lifecycle is session-managed. A manually started `bili start` daemon
has no such owner — attaching pins the session to a process that outlives it,
swallows watcher-registration 409s, and may run an older bili build (#1322).
The proof is the health endpoint, and this table is the contract **both**
implementations are reviewed against so they cannot drift:

| Contract point | Value |
|---|---|
| Endpoint | `GET /__bili/health` (loopback-only management namespace) |
| Field | `watchdog.armed` (boolean) — exposed since #1330; absent on older builds |
| Gate rule | attach iff `watchdog.armed === true`; missing field, non-boolean value, or unreachable/malformed health = **unverifiable → refuse** (default-deny) |
| Escape hatch | env `BILI_NATIVE_ATTACH_EXTERNAL` (`1`/`true` opens, `0`/`false` closes, anything else falls through) > config file `native.attachExternal` (must be exactly `true`) > default `false`; env wins over file |
| Exempt paths | explicit user-directed attach (`BILLION_CONTEXT_ATTACH`, launcher-preset `BILLION_CONTEXT_PROXY`) bypasses discovery and the gate entirely |
| Refusal behavior | log loudly once per origin per bring-up, then fall through to spawning a session-owned proxy (ephemeral port, armed from birth, dies with the last session per #1186) |

Implementations (behavior must stay identical):

- TypeScript lanes — `attachGateAllows` / `pickAttachable` (`src/launcher.ts`) +
  `resolveNativeAttachExternal` (`src/config.ts`); covers claude-native, kimi, dsh,
  omp, opencode (V1+native), pi, zcode, and the MCP entries.
- Hermes (Python) — `attach_gate_allows` / `discover_instance` /
  `resolve_attach_external` (`hermes-plugin/__init__.py`); separate implementation
  because hermes' plugin API is Python-only.

Why default-deny on a missing field: pre-#1330 builds never report watchdog
state, and those are exactly the stale manual daemons behind #1322 — attaching
to them would keep pinning sessions to possibly-old code.

## Runtime-info protocol (#955)

A native plugin lives inside the client process, so it can read the model
config the client itself will use. It pushes that truth to the proxy on two
channels, and the proxy prefers it over the models.dev registry / built-in
table in the context-window chain:

| Channel | When | Fields |
|---|---|---|
| Per-request headers (gated on `x-bili-plugin`) | every model request | `x-bili-plugin-context-window`, `x-bili-plugin-max-output`, `x-bili-plugin-model` |
| `POST /__bili/plugin/runtime-info` (loopback) | plugin bootstrap + model switch | `{agent, model, contextWindow?, maxOutput?, baseURL?, source}` |

Resolution order for the window: `anthropic-beta` negotiation > per-request
plugin header > runtime-info table (agent+model must match) > launcher
env > route config > models.dev registry > built-in table. A reported
`maxOutput` only stands in when the request body carries no output budget
of its own. Implementations: `src/agent/pi.ts` (covers pi and omp),
`src/agent/opencode-native.ts` (v1), `src/agent/opencode-v2.ts`,
`src/agent/dsh-native.ts`, `src/kimi/native-mcp.ts` (bootstrap-time report
only — kimi's provider `custom_headers` are static, so per-request headers
would go stale on model switch), `hermes-plugin/__init__.py` (Python plugin:
per-request headers via an `llm_request` middleware, max output captured by a
`pre_api_request` hook) — other client integrations should follow the same
protocol.

The launcher env tier covers pure-proxy clients (no in-process plugin):
`bili <client>` reads the client's own model config at launch
(`model_context_window` / `model_max_output_tokens` for codex,
`contextWindow` / `maxTokens` for pi / omp, `limit.context` / `limit.output`
for opencode, `maxInputTokens` / `maxOutputTokens` for codebuddy) and hands
it to the proxy via `BILI_LAUNCHER_MODEL_WINDOWS` / `BILI_LAUNCHER_MODEL_MAX_OUTPUTS`
(#971). A plugin report — when present — always outranks it.

Before the first model request there is no session yet, so the `/acp` panel
probes `GET /__bili/plugin/status?conversationId=<agent>&fallback=latest`,
which answers from the runtime table (`phase: "pre-first-request"`) instead
of 404ing — the reported config is visible immediately, and the real session
takes over once traffic lands.

## Claude native posture (#964)

Claude Code has no in-process extension point, so `bili plugin install
claude` writes a managed block into `~/.claude/settings.json` (env
`ANTHROPIC_BASE_URL=http://127.0.0.1:48787/bili/<upstream>`,
`DISABLE_AUTO_COMPACT=1`, and a `SessionStart` hook) plus the same
user-scope MCP shell as before, now pinned to that stable port. The hook
(fired before claude's first model request) attaches to a healthy proxy on
the port or spawns one whose pid watchdog tracks claude itself, so the
proxy lives and dies with the session. Port override:
`BILI_CLAUDE_NATIVE_PORT` > config `claude.nativePort` > 48787; upstream
override: `BILI_CLAUDE_UPSTREAM` (or the existing `claude.anthropicBaseUrl`
config). Opt out with `BILI_NATIVE_CLAUDE=0` — the hook then brings up a
**passthrough** proxy on the same port (verbatim forward, compression off)
so claude keeps working. The block is pure JSON merge/strip: foreign keys
are never touched, `bili plugin remove claude` restores exactly. `bili
claude` still works on a machine with the native block installed — it
overrides the static URL with its own ephemeral proxy and the hook stays
dormant.

## Injection priority — no files unless unavoidable (#535)

bili never owns user data: every launched client runs on its **real home**, so
runtime writes land where the user expects them. When pointing a client at the
proxy, the launcher picks by priority — **env vars first** (proxy/CA envs for
hermes/dsh/codex; the `BILI_PROVIDER_REWRITES` URL manifest for pi/omp,
consumed by their extension's `registerProvider` at load), then **CLI flags or
extension APIs** (codex `-c key=value`, opencode plugin), and **generated files
last** — today only opencode's temp `opencode.json` (deleted on exit) and dsh's
loopback exception: dsh's fetch stack bypasses proxy envs for loopback targets
unconditionally, so local upstreams keep the persistent `~/.dsh-bili` overlay
rewrite until dsh gains a settings-path env or an upstream loopback opt-out.
Overlay dirs created by older versions are left in place and never merged back
into the real home.
