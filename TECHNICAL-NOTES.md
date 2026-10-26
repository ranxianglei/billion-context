# Technical notes

Mechanism-level details behind the three usage options in the README. The
README keeps each option concise; the "how it actually works" material lives
here instead of between the options.

## Native plugin lifecycle (Option 1)

At load the plugin **spawns its own proxy** (or attaches to a healthy
running one — a parent-pid watchdog tears it down when the client exits),
rewrites model traffic to `<proxy>/bili/<upstream-url>`, registers
`compress` / `decompress` / `acp_status` as native client tools (plugin
mode), and binds the `/acp` panel to the current session. It also reports
the client's **own model config** to the proxy (runtime-info protocol,
#955) so compression budgets use the real window instead of a registry
guess. Opt-out envs: `BILI_NATIVE_PI=0`, `BILI_NATIVE_OMP=0`, `BILI_NATIVE_OPENCODE=0`, `BILI_NATIVE_DSH=0`, `BILI_NATIVE_KIMI=0`, `BILI_NATIVE_HERMES=0`, `BILI_NATIVE_ZCODE=0`.

## Proxy reuse and the attach gate (#1225, #1335, #1232, #1660)

A native hook may attach to an already-running proxy instead of spawning its own — only when it passes the lifecycle gate below. Reuse is identity-based (#1225): an existing proxy is attached only when it runs the **same code** (sha256 of the entry script, recorded in the instance file), its **lane is compatible** — each launcher declares its client's lane, two *different declared* lanes never share, and an instance without a declared lane is a manually started user-zone daemon, wildcard-compatible on that axis — **and it passes the lifecycle gate** (§below): an armed parent-pid watchdog (`watchdog.armed == true`), i.e. it was spawned by a launcher with a parent pid and dies when the last attached session dies, **or** it is a user-zone instance (no lane, no launch token), which is exempt by definition (#1660). Instances written before #1225 carry no code fingerprint and are therefore never attached: a rebuilt or updated install always starts a fresh proxy on the next launch, so fixes take effect immediately instead of silently serving stale code.

| Listener | Attaches? | Why |
|---|---|---|
| Proxy spawned by this session | ✅ | armed at birth |
| Another session's armed shared proxy (watcher set, #1186) | ✅ | sharing is by design |
| Manually started `bili start` daemon (user zone, #1660) | 🔶 conditional | **user-zone** instance (no lane, no launch token): an **armed** one (a managed shared proxy, #1225) is ridden by any compatible client lane; an **unarmed** manual one is, by default (`attachPolicy: own-lane`, #2877), NOT ridden by a LANEd hook — it spawns its own instead. Ridden instead under `attachPolicy: global-fallback` (pre-#2877) or `attachExternal=1`. You own its lifetime and version either way |
| Unarmed **lane'd** proxy (crashed-session orphan; pre-#1330 unverifiable) | ❌ loudly refused | lifecycle-drift symptom (#1335): riding it would silently reuse a proxy no live session owns |

The hook probes each candidate's `/__bili/health` before attaching: armed → attach and register a watcher (unchanged); an **armed user-zone** candidate attaches regardless of the lane-affinity policy (a managed shared proxy, #1225); an **unarmed user-zone** (manual) candidate attaches only under `attachPolicy: global-fallback` (pre-#2877) or `attachExternal=1` — by default (`own-lane`) a LANEd hook spawns its own (#2877); an unarmed **lane'd** candidate (a crashed session's orphan, or a pre-#1330 build that reports no `watchdog` field at all — unverifiable, treated as unarmed) is refused **loudly**, and the session spawns its own proxy in the self-managed port zone (base `18787`, or the lane's sticky drift record; armed at birth, dies with the last session, #1186 watcher semantics). Version skew stays fixed: the code-fingerprint check runs first, so a rebuilt or updated install never rides a stale daemon even through the user-zone exemption. Cost: one extra short-lived proxy process per session when nothing attachable exists (session state is shared on disk, so compression continuity is unaffected); the multi-instance warning (#394) becomes correspondingly more common. **Escape hatch:** `native.attachExternal: true` in the config file or `BILI_NATIVE_ATTACH_EXTERNAL=1` extends attaching to *lane'd* listeners regardless of watchdog state (including pre-#1330 builds) — you then own those daemons' lifetimes and versions; `attachExternal` governs only the *lifecycle gate* for **lane'd** daemons (it does not open or close user-zone attachment — that axis is `attachPolicy`); `attachUrl` (env `BILI_MCP_PROXY` / `--origin`) pins an explicit target origin. Explicit user-directed attaches (`BILLION_CONTEXT_ATTACH` / preset `BILLION_CONTEXT_PROXY` for kimi/dsh) bypass discovery entirely and are exempt by construction.

Attach discovery is lane-aware across **all** live instances (#1232): the launcher probes every live entry in the instance registry, not just the single instance file (last-writer-wins — under concurrent multi-client use it can point at another client's proxy), and applies the gate above to every candidate. Among compatible candidates the newest instance with the launcher's own declared lane wins; an instance without a lane (a user-zone daemon) is wildcard-compatible on the lane axis and gate-exempt by default (#1660) — but whether a LANEd hook actually falls back onto it is governed by `attachPolicy`: `own-lane` (default) does not ride an *unarmed* manual daemon (#2877), while `global-fallback` restores the pre-#2877 wildcard ride. The `another bili instance is running` warning (#394) is lane-aware too: it fires for same-lane or lane-less coexistence, but stays silent between two *different* declared lanes, whose session files are disjoint.

## Shared state dir and multi-instance security boundary (#394, #1724)

Every bili instance on a host reads and writes the **same** per-host
storage: the XDG data dir (`~/.local/share/billion-context/` — session
records, CCR content-store, prefix-affinity) plus the state dir
(`~/.local/state/billion-context/` — log, instance registry). The control
plane is lane-aware (#1232:
attach discovery and the #394 coexistence warning both respect declared
lanes), but the **data plane is not partitioned** — there is no per-session
owner and no per-lane isolation on disk. Two consequences follow:

- **Cross-instance session visibility.** Each instance's Web UI
  (`__bili/sessions` list / detail / logs) re-scans the whole shared store, so
  any instance reachable over loopback can enumerate and read *any* session —
  raw messages, content-store payloads, compressed blocks — created by any
  other instance/lane on that host.
- **Restart drain race.** On a restart the new process hydrates the store
  before the old one finishes flushing, so last-writer-wins can drop the old
  process's final writes: lost tail updates and a provider prefix-cache bust
   (the outbound body diverges from what the provider had cached). The #1724
   mitigations: the #405 snapshot-counter guard (rejects stale session writes),
   the prefix-affinity union-on-write guard (#1737: one instance's flush never
   clobbers a sibling chain), and the self-restart ordering fix (#1742: durable
   state is flushed to disk before the replacement spawns). Host-driven restarts
  (dsh et al., #991) still rely on these data-layer guards, since their
  kill/spawn order is not bili-controlled.

**Security posture:** the shared-state surface is protected *only* by the admin
endpoint's loopback gate (non-loopback source addresses are refused) plus
filesystem permissions on the user's home tree (both dirs live under $HOME) —
there is no per-session authorization. For a **single-user host** that is
sufficient. On a **multi-user host** it is not: any local account able to reach
the proxy's loopback port can read every session of every user. Such hosts must
partition their per-host storage (per-user/per-lane subdirectories) — the root
fix named in #1724
(direction #1), still open as an architecture decision; Web UI scoping
(#1724 direction #4) reduces cross-instance browsing but does not change this
boundary.

## Runtime-info protocol (#955)

A native plugin lives inside the client process, so it can read the model
config the client itself will use. It pushes that truth to the proxy on two
channels, and the proxy prefers it over the models.dev registry / built-in
table in the context-window chain:

| Channel | When | Fields |
|---|---|---|
| Per-request headers (gated on `x-bili-plugin`) | every model request | `x-bili-plugin-context-window`, `x-bili-plugin-max-output`, `x-bili-plugin-model` |
| `POST /__bili/plugin/runtime-info` (loopback) | plugin bootstrap + any reported-config change | `{agent, model, contextWindow?, maxOutput?, baseURL?, conversationId?, source}` |

Resolution order for the window: `anthropic-beta` negotiation > per-request
plugin header > runtime-info > launcher env > route config > models.dev
registry > built-in table. The runtime-info step reads the **per-agent
entry** when the request carries an `x-bili-plugin` header (agent+model must
match); requests without one resolve the **conversation-scoped entry**
recorded with a `conversationId`, keyed by the same conversation signal the
session binds on (client conversation header, custom session header, or the
body's `prompt_cache_key`) — model must match either way (#1531: omp stamps
`prompt_cache_key` but no plugin header, and main/subagent sessions share
the agent name while running different models). A reported `maxOutput` only
stands in when the request body carries no output budget of its own.
Implementations: `src/agent/pi.ts` (covers pi and omp),
`src/agent/opencode-native.ts` (v1), `src/agent/opencode-v2.ts`,
`src/agent/dsh-native.ts`, `src/kimi/native-mcp.ts` (bootstrap-time report
only — kimi's provider `custom_headers` are static, so per-request headers
would go stale on model switch), `hermes-plugin/__init__.py` (Python plugin:
per-request headers via an `llm_request` middleware, max output and the host's
per-model context window — read from hermes' own
`HERMES_HOME/context_length_cache.yaml`, fail-open on any miss (#3261) —
captured by a `pre_api_request` hook) — other client integrations should
follow the same protocol.

**DSH `maxOutput` reporting is declaration-gated — an undeclared custom model empties the whole ceiling chain (#2904).** `src/agent/dsh-native.ts` forwards `maxOutput` **only** when the host's `resolveModelInfo(provider, model)` returns a positive `defaultMaxTokens`, and DSH populates that **only** when the model item explicitly declares `maxTokens` — provider-level output defaults are never reported. For a user-added custom model with no declared `maxTokens`, `defaultMaxTokens` is `undefined`, so BOTH runtime-info channels come back empty. With no models.dev entry and no bili-configured `output` either, the four-source ceiling chain (#1840) resolves to nothing, and `restoreOutputBudget` lifts a client-starved budget to the session high-water mark — which on a long session has decayed through small positives to a poisoned low value. Every turn then runs reasoning-only and stops at `length`/`max-tokens`; switching to a model WITH a known ceiling masks it (the high-water is floored up to the ceiling), so the switch is a trigger, not a cause. The real fix home is **DSH-side**: report its configured provider/model output default instead of `undefined` (the immediate user workaround is setting `maxTokens` on the model item). bili deliberately does not guess a quota floor (#1842); instead #2904 surfaces the degraded state persistently on the `/acp` panel, the Web UI session page (data source `/__bili/sessions/<id>/detail`), and `/__bili/plugin/status?conversationId=` (`outputBudgetDegraded`) — clearing automatically once a healthy value or ceiling arrives — and extends `degenerateTurnWarning` to `length`/max-output terminations so the truncation correlates with its cause in the log.

**omp: the `prompt_cache_key` stamp is withheld when OMP's Cowork transport owns egress (#2583/#3556).** In native omp mode the stamped `prompt_cache_key` is the only per-request session signal, and its sole consumer is bili's own fetch-layer interceptor (it rewrites model URLs to `<proxy>/bili/<url>` and strips the field before forwarding). Recent OMP builds ship a "Cowork transport" (introduced 2026-07-30, can1357/oh-my-pi `642892ae`; proxy handling `e22a5ff2`) that sends default `anthropic`/`anthropic-messages` requests over node:https DIRECTLY — they never touch `globalThis.fetch` unless an explicit proxy env var (`PI_PROXY` / `PI_PROXY_ANTHROPIC`) pushes them back onto Bun's fetch. Since #3556 the `bili omp` launcher closes this gap itself: unless the user has set `PI_PROXY` / `PI_PROXY_ANTHROPIC`, it exports `PI_PROXY_ANTHROPIC=<proxy origin>`, so on the default launcher lane Cowork rides the compressible lane (the stamped key consumed and stripped by the proxy) instead of dialing direct. The withhold also gates the cert-MITM lane — #3556 hoisted it above the destination-routed check, where a nested placement skipped it entirely. Stamping there would ride the field verbatim into Anthropic's strict schema (HTTP 400 `prompt_cache_key: Extra inputs are not permitted`). The stamp gate (`stampPromptCacheKey` → `ompCoworkTransportBypassesFetch` in `src/agent/pi.ts`) mirrors OMP's own per-model egress selection: proven-direct traffic is unstamped, with one loud warning per process per model. Consequence: those direct requests go uncompressed and anonymous to the proxy (identity/panel/billing degrade — the same trade as #1403); every other lane (launcher `/bili/` rewrite, MITM whitelist, other providers/apis, proxy-configured hosts) is unchanged. Known residual: a `NO_PROXY`/`no_proxy` rule matching the model host silences OMP's proxy handling even when `PI_PROXY` / `PI_PROXY_ANTHROPIC` are set — the request then dials direct while still stamped (the same 400 class); remove such hosts from `NO_PROXY` instead. The reverse asymmetry is fail-safe: OMP's shape-based fetch fallbacks (Request-object input, non-record headers, unsupported body) route back onto `globalThis.fetch` even with no proxy envs, where a withheld stamp only degrades identity and never hard-fails. Full coverage would require a host-side change (route Cowork egress through `globalThis.fetch`) — boundary note in #2583.

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
`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/bili/<upstream>`,
`DISABLE_AUTO_COMPACT=1`, and a `SessionStart` hook) plus the same
user-scope MCP shell as before. The hook (fired before claude's first model
request) resolves its port like every lane (#1660): an explicit pin
(`BILI_CLAUDE_NATIVE_PORT` > config `claude.nativePort`) launches
**strict-port** on that exact port (a squatter is refused loudly, #964
preserved); otherwise it rides the self-managed zone — the lane's sticky
record else base `18787` — non-strict, with the child's EADDRINUSE +1
ladder resolving collisions and the settled port recorded sticky. One
exception to the ladder (#1723): when the holder of the lane's port is a
same-lane instance running a **different build** (the upgrade-restart
overlap — the old version still draining), the child waits for it to release
(up to 5s) and rebinds the *same* port instead of drifting; a holder that
never leaves exhausts the wait and gets the plain ladder as before. After the
proxy is up the hook re-pins the managed `ANTHROPIC_BASE_URL` to the live
origin each session (`repinClaudeManagedBaseUrl`), so a hopped port
self-heals on the next launch and the baked URL never stays desynced from
the running proxy. Upstream override: `BILI_CLAUDE_UPSTREAM` (or the
existing `claude.anthropicBaseUrl` config). Install no longer persists
`claude.nativePort`. Opt out with `BILI_NATIVE_CLAUDE=0` — the hook then
brings up a **passthrough** proxy on the same resolved port (verbatim
forward, compression off) so claude keeps working. The block is pure JSON
merge/strip: foreign keys are never touched, `bili plugin remove claude`
restores exactly. `bili claude` still works on a machine with the native
block installed — it overrides the static URL with its own proxy and the
hook stays dormant.

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

## Two compression modes — who executes `compress`

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

### Mode switches change the Responses projection — attribution must not blame the host (#2867)

On the Responses lane the two modes also project mid-history `system`/`developer`
items differently: plugin mode keeps them in place (`__bili_inplace_sysdev`,
#1638 prefix-cache churn fix) — as of #3227 so do Codex clients in native proxy
mode (UA-detected via `isCodexClient`); other proxy clients keep the hoist into
the head developer block (#1085 hoist-and-anchor). A self-heal degrade-to-proxy
(#2155) therefore
re-projects the SAME incoming history into different forwarded bytes — the
forwarded-system fingerprint (#2350) flips even though the host changed nothing,
and a naive ledger would book that under "host rewrote the system prompt".
Fix: the ledger now pairs the projection fingerprint (`systemFp`) with a
mode-independent **canonical** fingerprint of the raw incoming system/developer
stream (`canonicalSysFp`, role + content + order, captured before any
projection). At settle time: projection flipped AND canonical stable → cause
`projection` (its own dimension: `pf` flag, `projSwitches` counters, cold window,
report section — the proxy's own doing); canonical also changed → cause
`prompt` (a genuine host-side rewrite, as #2350 intended); canonical changed
alone (e.g. a mid-history edit while in plugin mode, which never touches the
head block) is recorded observationally (`cf`) without a billing bucket. Unknown
canonical sides never classify (legacy reading). Each sample additionally carries
its mode (`pm`) and prepare-responses logs one transition line with the reason
(self-heal degrade / restore / header absent). Only hash, length, mode and reason
are recorded — never the prompt body. No wire behavior changed: both projections
stay exactly as before; the switch is now *recorded* instead of misattributed.

## Responses native chaining is not supported — history must be replayed (#1954)

The Responses-wire adapter (`prepareResponses` in `src/server.ts`, `buildRequest`
in `src/loop/adapter-responses.ts`) is a **stateless replay compressor**: it
treats `parsed.input` as the *complete* conversation, compresses that, and then
drops `previous_response_id` unless `ACP_KEEP_RESPONSE_ID=1`. It keeps no
response-lineage store, so it **cannot materialize the history a native-chaining
continuation references**.

OpenAI's native chaining (`store:true` + `previous_response_id`, server-held
history) and bili's client-replayed model are mutually exclusive paradigms. A
delta-only continuation (just the new turn + `previous_response_id`, no full
replay) therefore reaches the upstream with **neither the reference nor the
referenced turns** — prior context is silently lost upstream while the request
still returns 200. That is the mechanism behind #1954.

**What ships here (approach A — visibility only).** When a non-empty
`previous_response_id` is stripped, both paths now emit a `warn` naming the id
and stating the consequence. The trigger keys off the id **alone**, not off
explicit `store:true`, because Responses stores responses by default — an omitted
`store` still leaves the referenced response resolvable upstream, so judging on
`store` would miss the common case. Approach A changes no forwarded byte and
closes nothing: the delta request still loses its history and still returns 200.
It only stops the loss from being silent.

**Observation, not proof.** Current builds/tests show codex sends `store:false`
and never sets `previous_response_id`, so this is a no-op for codex *today*. That
is an observation from the existing E2E + traffic, not proof that no client ever
chains — the E2E does not cover the delta-chaining shape. codex is OpenAI's own
CLI against a Responses API that natively supports chaining, so a future version
switching to native continuation to save tokens is a reasonable evolution; until
then this stays a latent high-severity gap.

**Safe options for a chaining client today:** resend the full input/output
history (bili then compresses/forwards normally), or set `ACP_KEEP_RESPONSE_ID=1`
to preserve the id — but under KEEP the referenced history lives server-side and
bili's compression/prefix-cache accounting cannot see it. The real fix
(materialize lineage before compression) is tracked as feature #1973. Official
migration guide: https://developers.openai.com/api/docs/guides/migrate-to-responses

## Single-writer: who owns which copy (#991)

Every bili presence on a machine has exactly **one writer** — the thing
that installed it is the thing that updates it, and nothing else ever
overwrites that copy in place:

| Lane | Copy lives in | Updated by |
|------|---------------|------------|
| global `bili` | npm global (`npm i -g billion-context`) | `bili update` / background auto-update |
| **pi** | pi's package manager (npm form) | **`pi update`** — bili never overwrites it |
| **opencode** | opencode's plugin dir | **opencode's plugin manager** — bili never overwrites it |
| **dsh** | each profile's pnpm store | a periodic check re-runs dsh's plugin channel per profile — driven by the global bili self-update **or by the profile copy's own proxy** when the global isn't running (dsh-market installs, #1196); manual: `dsh plugin add billion-context@latest`. pnpm's hardlinked store must never be copied over in place |
| omp / claude / codex / kimi / zcode | no copy — entries point at the global bili install | they update together with the global copy |
| **hermes** | `~/.hermes/plugins/billion-context/` (copied files + `bili.json` sidecar pointing at the global dist) | **`bili plugin update hermes`** re-copies the files; the sidecar tracks the global install |

This is enforced in code, not just convention: the self-updater
(`src/update.ts` → `hostManagedInstall`) detects install dirs under a pnpm
virtual store (`.pnpm`) or a host agent tree (pi / opencode / dsh / kimi /
omp homes) and **skips** them; `installViaTarball` refuses them structurally
so direct callers cannot corrupt a store either. Mixing *commands* is fine
(`dsh plugin add` ≡ `bili plugin install dsh` — same channel, same records);
mixing *writers* is what the guard forbids. `bili plugin update [client]`
is the one command that drives every lane through its own owner and prints
the per-lane update path (`bili plugin list` shows the same per-lane channel).

## Stuck-session self-heal — detection constants and remedies (#2155)

Three failure shapes share one detector family in `src/session-self-heal.ts`,
evaluated once per request (after `prepare`, on the nudge-carrying lanes only;
bypass and side lanes never earn credit):

- **D2 zombie plugin lane** — the plugin was uninstalled (or its MCP child
  died) but already-open client windows keep the session plugin-bound
  (sticky `metadata.pluginAgent`, `src/server.ts`). Signal: 5 consecutive
  rounds (`SELF_HEAL_WINDOW`) that were nudged, carried **no** `x-bili-plugin`
  header, declared **no** bili tools on the wire, and produced **no**
  compression reduction. Remedy: **degrade to proxy mode** — the single
  `pluginMode` flip (`pluginAgent !== undefined && !pluginLaneDegraded(session)`)
  re-injects the ACP tools wire-side, re-arms the compress rewriter, CCR
  stamping and absorb, and **keeps the nudge** (the tools are back). When wire
  injection is unavailable (`compress.injectTool=false` → `degradeAvailable`
  false) the remedy falls back to **suppress-nudge**. Recovery: the live
  plugin header (`pluginLaneRestore`, hoisted BEFORE the `pluginMode` flip so
  the first header-bearing request is already plugin mode — the sticky
  `pluginAgent` must NOT be used as the restore signal or the degrade clears
  one round after arming). The binding is kept, never erased.
- **D1 nudge idle** (non-plugin generalization) — 5 consecutive nudged rounds
  with zero reduction and zero bili tool uses. "Nudged" means the text was
  ACTUALLY injected — since #3004 the decide gate's verdict is the delivery
  fact (`prepared.nudgeOutcome === "injected"`); a vetoed arm credits no idle
  streak (the pre-gate expression armed suppression on channels the model
  never received). Remedy: suppress the nudge at all four `willInjectNudge`
  gates (`&& !nudgeSuppressed(session)`, covering the emergency path too).
  Two bounds keep the suppression from latching forever (#3004): the decide
  ladder's fallback escape still punches through ONE legacy advisory while
  suppressed (the failure-recovery path outranks suppression;
  `consumeFallback` resets the counter), and the latch expires
  `SELF_HEAL_SUPPRESS_CAP_MS` (10 min) wall-clock after arming — re-arming
  then costs a fresh full `SELF_HEAL_WINDOW` of idle rounds. Recovery: any
  compression reduction or bili tool use lifts the suppression early.
- **D3 gateway-killed summaries** — a **non-streaming** preflight summary that
  dies with HTTP 524/504 (Cloudflare class) is not retried in place (the old
  transient-retry path burned ~100 s per attempt against a dead gateway);
  instead the session learns `metadata.preflightStreamSummary = true` on the
  **first** hit and the summary is re-requested as SSE — the same learned
  store as the manual `compress.streamSummary` knob (#2133), auto-armed.
  The cascade is honored in both directions: an explicit `streamSummary:
  false` anywhere (global → provider → model) is the operator's opt-out —
  neither learn path arms and a stale learned flag is ignored
  (`streamSummaryOff` in `PreflightDeps`).

Observability: `session.metadata.selfHeal = { detected, action, since }` is
exposed in `/__bili/sessions`, badged in the web UI ("heal"), and every
transition logs one `[self-heal]` line (detect + recovery). `bili plugin
remove <client>` best-effort queries the live proxy (instance file →
`GET /__bili/sessions`, 2.5 s timeout, silent on failure) and prints a note
when sessions of that client were active within the last **10 minutes**.

## Unified ACP tag-echo remediation — the four invariants (#2023/#2066/#2190/#2248)

One PR folds the three remediation legs together (refs-run residue #2023,
degenerate-close stripping + egress audit net #2190, emission drop +
signed-thinking verbatim #2066) under a single set of hard rules that govern
EVERY text-rewriting surface (loop adapters, plugin passthrough, JSON strip
functions, exit audits):

1. **The thinking channel is byte-verbatim.** Anthropic `thinking`, Google
   `thought`, OpenAI `reasoning_content`/`reasoning`, and Responses reasoning
   summaries ride as-is — echo-shaped reasoning included. Rationale: reasoning
   replay (DeepSeek-style) and signature verification validate these bytes;
   any rewrite desyncs them and bricks the session (#1960/KDD#10). The
   adapters route these fields through `createIdentityStreamFilter`, and the
   strip functions (`stripOpenaiChatText`, `stripResponsesText`) leave them
   untouched (defense in depth). NOTE: this REVERSES the pre-#1881-era
   reasoning-echo strip — the thinking channel is no longer cleaned.
2. **Model prose is manageable.** Render-tag echoes, marker lines,
   bili-internal text, degenerate open/close residue, and (when
   absorb-instructed) whole tool-call emissions are stripped from the visible
   text channel only.
3. **Model output bound for files is byte-identical (#1039).** Tool-call
   arguments never enter any filter, whatever bytes they carry.
4. **User-sent bytes are never rewritten.** A verbatim echo of the user's own
   fragment survives even when stripping is armed (#463 exemption, keyed on
   the request text, not shape).

The egress audit net (#2248) stays log-only: raw exits (unrecognized frames,
parse failures) forward as-is and log `[tag-echo] raw exit` so new leak shapes
become visible without changing the wire. Pinned by
`tests/unified-acp-invariants.test.ts` (eight tests, both lanes).

## Cache-ledger accrual is coverage-conditioned (#2202)

The ledger books each request against every elapsed fold
(`requestsAfter += 1` per sample), and the panel turns that counter into
`netSaved = Σ (S − σ) × requestsAfter`. Booking is a *claim that this
request benefited from the fold* — which is only true while the fold's
covered bytes actually ride the resent wire. When a host removes them
outside bili's knowledge (dsh native compaction, #2193), the old counter
kept climbing on a destroyed substrate: the #2193 incident showed
netSaved at 355M while 1510 covered ids were permanently gone.

The fix is writer-side, at the claim site: `reconcileFoldCoverage`
already inspects every inbound pass for exactly this evidence, so it now
also records per-block presence into
`session.metadata["foldCoverageByBlock"]` — `{p, r, t, e}` per blockId
(present verbatim / reclaimed via re-anchor / total covered / ever-present
latch). The ledger links each fold to its block with a sparse
`LedgerFold.bid` (set once in `recordCacheFoldsFromBlocks`, the single
choke point for both the eager proxy path and the lazy plugin-mode path),
and scales the increment by the measured fraction `(p + r) / t`:

- **1** — full coverage, or no usable record → byte-identical to the
  pre-#2202 counter (healthy sessions and all legacy entries);
- **f** — partial coverage → proportional accrual;
- **0** — verified coverage-lost → accrual frozen until coverage returns.

Two classes are self-calibrated by the `e` latch: a fold whose covered ids
were *ever* seen present is verifiable, so total absence means loss; a fold
whose ids *never* appeared post-creation is structurally unverifiable
(view-folding hosts that resend folded views instead of raw originals) and
keeps status-quo booking rather than being silently zeroed. Coverage-lost
is live-computed (`e === 1 && p + r === 0`), so recovery resumes accrual
with no sticky state; one warn/info log fires per flip
(`foldCoverageLostLogged` dedup key).

Evidence hygiene mirrors the #1195 guard: side-request-shaped passes
(< 10 inbound messages — title-gen, WebSearch refinement) take NO
evidence at all (no records, no backbone roll, no drift-streak movement,
no resets), because a short pass would skew the next pass's alignment and
manufacture phantom total-loss.

Panel presentation keeps lost folds out of the headline number: the web
sessions view shows them as separate labeled segments (row tooltip,
overview sub-line, detail stat) — frozen pre-loss savings stay visible,
post-loss growth stops.

## OpenAI chat-wire prompt_cache_key: stamp everywhere by default, protect strict upstreams with an A/B probe (#2218/#2645/#3556)

The dsh plugin lane's one identity signal readable by body-keyed relays is the chat body's `prompt_cache_key` (the winning conversation header `x-bili-plugin-conversation` is bili-internal and never travels under that name; header-reading relays get `x-session-id`). Two opposing populations meet there: **strict direct APIs** reject unknown body params with a 400 — and strictness is per MODEL on the SAME origin (#2645: one NVIDIA-gateway model accepts the key, its sibling rejects it) — while **account pools**, including remote relay pools, read the key as their prefix-cache routing signal, so dropping it anywhere silently degrades those sessions' cache affinity (the #1403 class inverted). No destination-shape test can arbitrate: a loopback-only gate (the #2649 attempt) fixes the strict APIs but strips the key from the two biggest pool populations (docker-bridge/LAN/VPS/domain-name pools).

Settled design = **stamp-by-default + empirical self-heal (probe-and-remember)**:

- Stamp (`src/session-id.ts` → `resolveRelayAffinityPck`): the internal conversation header present ⇒ stamp `<conversation id>` on EVERY destination; a client-supplied key passes through verbatim until its pair is ablated, then it is withheld too (so later turns don't re-pay a 400 round trip). Unparseable origins fail open (stay stamped). Zero config surface — no new field, env var, or CLI flag.
- Probe (`src/server/relay.ts`, same buffered-body seam as the #552 compat ladder): the FIRST 400 on an egress body carrying the key re-sends the identical payload once without `prompt_cache_key`. Retry accepted ⇒ causation proven ⇒ remember the `origin(+model)` pair in process memory (`src/pck-probe.ts`) — in-memory ONLY, no persistence, restart re-probes. Retry also failed ⇒ NOT this field's fault ⇒ discard the retry, forward the original 400 untouched, learn nothing (a 400 has many causes; only the A/B verdict may ablate). One probe per request, ever.
- Granularity: origin+model, mirroring #2645's measured strictness — one strict model on a shared pool origin leaves sibling models stamped.
- Visibility (owner requirement): first ablation logs a WARN naming origin/model, the affected session(s), and the account-pool caveat explicitly ("if this destination is your relay/account pool, its prefix-cache affinity may degrade"); `acp_status` carries a section listing current suppressions; the web panel shows a banner (zh/en) with sessions; scripts read `pckSuppressions` from `GET /__bili/status`. All process-local; a restart clears and re-probes.
- Modes: only the plugin lane (registered agent / dsh plugin, internal conversation header present) ever stamps; plain proxy mode stays pure passthrough in both directions, byte-for-byte unchanged.

Tests: `tests/issue2645-pck-probe.test.ts` (strict upstream self-heals turn 1, remembers turn 2, lenient pool never probes, poisoned upstream forwards the 400 and learns nothing, client-owned keys drop after ablation, model-granular pairs) + the rewritten matrix in `tests/issue2218-relay-affinity-signal.test.ts`.

## Uncovered-history audit — honest minimum verdict (#4331)

The "no compressible ranges remain — the context is already at its minimum" stop signal was structurally unverifiable: it fired whenever the PRE-FOLD OFFER was exhausted (`postCompressTail`, #2404 pinning), but nothing ever compared the union of active-block ranges against the session's ref set. A live ZCode session showed the failure at scale — 138 mid-history refs (~65K tok, ~16% of context) in no active block, largest run `m00312`–`m00411` (100 msgs), while the receipt declared the global minimum three times in a row. The kernel DOES find such spans when they are offered (verified by repro on master); what was missing was a GLOBAL coverage audit plus a verdict that only claims "minimum" when one holds.

Design (`src/uncovered.ts`, host-side only, no kernel change):

- `uncoveredHistoryRuns()`: walk the message array for entries outside every active block's coverage (the `collectVisible` predicate), group contiguous runs, then classify each run: skip if any current offer covers part of it (the model can act on it now); otherwise diff TWO `core.processTurn` passes over a `structuredClone(state)` — normal config vs relaxed `{preserveRecentMessages: 0, preserveRecentTokens: 0}` — and treat refs offered only in the relaxed pass as zone-hidden (inside the protected recent window). The empirical zone diff deliberately re-uses the kernel's own protected-zone rules instead of copying them, so it self-maintains as those rules evolve (over-approximation errs toward under-reporting). Runs below `VIABLE_RANGE_MIN_TOKENS` (200) stay silent. A caller that already ran the normal offer pass may pass it via `normalRanges` (array = trust-and-reuse, even empty; undefined = no caller data, audit runs its own pass) so acp_status pays ONE extra `processTurn`, not two. Whole function is advisory: any throw degrades to "no runs found" and never breaks receipts or status.
- **acp_status** gains an additive `UNCOVERED HISTORY` section (top-5 runs by tokens, rest counted) listing mass that sits outside every active block AND is absent from the live Compressible-ranges list above — including isolated sub-gate runs between covered blocks that no merge will ever fold (the permanent-hole class of #4331 / #847). Named for visibility, explicitly not as fold suggestions; rows drill down via `scope:"uncompressed"` unchanged.
- **Tier-2 coverage invariant (reviewed, pinned by P4)**: the audit's covered-set is `coveredMessageIds` = the union of ACTIVE blocks' `effectiveMessageIds` with NO child recursion (kernel/src/state.ts:57-64). That is safe because every block-creation path unions consumed children's `effectiveMessageIds` into the new parent (kernel/src/unit-projection.ts:178-183) and deactivates the children (kernel/src/compress.ts:1578-1581) — a T2/T3 parent therefore carries its full distilled span in the state model, and hydration preserves it (whole state JSON). DB-side walks of `blocks.payload_json` do NOT have that property and need `directBlockIds` recursion (the reason an earlier independent attempt carried one); the state model does not.
- **postCompressTail**: on clean whole-offer exhaustion with no tier distillation, the audit runs before the verdict. Runs found AND totalling ≥ `UNCOVERED_RECEIPT_FLOOR_TOKENS` (10K, receipt-only) → honest text naming them ("not at its minimum", pointer to acp_status). Below the floor — or with no runs — the verbatim #1387 contract string fires byte-stable, exactly as on master: small declined leftovers must not re-nag on every fold (pi #521 rule), while material leaks override it. The floor is deliberately NOT applied to the acp_status section: an explicit inspection surface is not a nag surface, and option 1 of #4331 specified no size gate there. The 10K total is a product value pending owner ack (matches the reviewer's independent pick).

Behavior change (disclosed): old = unconditional "already at its minimum" on offer exhaustion; new = that claim only when the global audit verifies it AND the uncovered mass clears the 10K receipt floor — below the floor the receipt is byte-identical to master (so `tests/compress-success-tail.test.ts` stays at master bytes, zero diff), and its #2404/#1387 sub-floor residue fixtures now double as the floor's pins. Sub-gate residue became visible in acp_status (previously invisible on every surface). No config/env surface added; nudge prompt text untouched (kernel-owned). Known limitation left as a separate observation: the receipt's remaining-calc removes a WHOLE offered batch when any submitted span overlaps it, so a partially-folded merged batch can under-report rather than over-report.

Tests: `tests/issue4331-uncovered-history.test.ts` (hole session → honest verdict + named span; drained session → verbatim contract string; sub-floor silence; tier precedence; **tier-2 distillation coverage pin** — three T1s distilled into one T2 parent via the real host path must not leak child spans into the audit; both acp_status directions; formatter caps) + `tests/compress-success-tail.test.ts` UNCHANGED from master (its < 10K-residue fixtures pin the floor), `tests/issue2029-status-baseline-provenance.test.ts` (every status-reader kernel call feeds the provenance baseline), `tests/issue847-compress-failure-guards.test.ts` (sub-gate residue visible in the diagnostic, still never offered).
