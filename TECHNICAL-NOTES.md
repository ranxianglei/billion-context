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
| Manually started `bili start` daemon (user zone, #1660) | ✅ by default | **user-zone** instance (no lane, no launch token): deliberately maintained by the user — you own its lifetime and version; refused only when `BILI_NATIVE_ATTACH_EXTERNAL=0/false` explicitly closes the gate |
| Unarmed **lane'd** proxy (crashed-session orphan; pre-#1330 unverifiable) | ❌ loudly refused | lifecycle-drift symptom (#1335): riding it would silently reuse a proxy no live session owns |

The hook probes each candidate's `/__bili/health` before attaching: armed → attach and register a watcher (unchanged); a **user-zone** candidate attaches by default regardless of watchdog state (#1660) — the user deliberately maintains that daemon; an unarmed **lane'd** candidate (a crashed session's orphan, or a pre-#1330 build that reports no `watchdog` field at all — unverifiable, treated as unarmed) is refused **loudly**, and the session spawns its own proxy in the self-managed port zone (base `18787`, or the lane's sticky drift record; armed at birth, dies with the last session, #1186 watcher semantics). Version skew stays fixed: the code-fingerprint check runs first, so a rebuilt or updated install never rides a stale daemon even through the user-zone exemption. Cost: one extra short-lived proxy process per session when nothing attachable exists (session state is shared on disk, so compression continuity is unaffected); the multi-instance warning (#394) becomes correspondingly more common. **Escape hatch:** `native.attachExternal: true` in the config file or `BILI_NATIVE_ATTACH_EXTERNAL=1` extends attaching to *lane'd* listeners regardless of watchdog state (including pre-#1330 builds) — you then own those daemons' lifetimes and versions; `0`/`false` closes the gate for everyone, including user-zone daemons, forcing fresh zone spawns. Explicit user-directed attaches (`BILLION_CONTEXT_ATTACH` / preset `BILLION_CONTEXT_PROXY` for kimi/dsh) bypass discovery entirely and are exempt by construction.

Attach discovery is lane-aware across **all** live instances (#1232): the launcher probes every live entry in the instance registry, not just the single instance file (last-writer-wins — under concurrent multi-client use it can point at another client's proxy), and applies the gate above to every candidate. Among compatible candidates the newest instance with the launcher's own declared lane wins; an instance without a lane (a user-zone daemon) is wildcard-compatible on the lane axis and gate-exempt by default (#1660). The `another bili instance is running` warning (#394) is lane-aware too: it fires for same-lane or lane-less coexistence, but stays silent between two *different* declared lanes, whose session files are disjoint.

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
