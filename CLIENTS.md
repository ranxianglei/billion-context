# Client integration deep dives

Per-client mechanics for the clients that need more than one line in the
[README Quickstart](README.md#quickstart): how each mode (launcher / `/bili/`
URL prefix / native plugin) wires traffic into the proxy, what gets written
where, and the known limitations. If you just need "which command do I type",
start from the [README](README.md) — this file is for when something doesn't
behave and you want to know why.

---

## dsh (deepseek-harness)

Two lanes, same plugin (#941):

- **Launcher:** `bili dsh` injects the full native plugin through a
  `--patch` overlay (`~/.dsh-bili/.bili-acp.patch.yml`) — every profile
  boots with the bili tools registered natively, model requests carry
  `x-bili-plugin` + the dsh session id (plugin mode), and `/acp` is
  session-bound. dsh's native auto-compaction is disabled in the same patch
  (`compaction-basic` → `auto: false`); manual `/compact` stays available. The
  same patch also adds `MALFORMED_RESPONSE` to the built-in DeepSeek routes'
  retry whitelist, so one sampling flake that breaks a tool-call argument JSON
  retries instead of killing the turn (#2605).
- **Profile install (no launcher) — one lane (#966):** `bili plugin install
  dsh` runs `dsh plugin --profile <name> add billion-context` for every
  existing profile — pnpm installs the package into each profile's own
  `node_modules`, and dsh mounts the bundled patch layer
  (`dsh.bundle.patch.yml`) automatically — besides mounting `bili-native` and
  disabling dsh's auto-compaction, it adds `MALFORMED_RESPONSE` to the built-in
  DeepSeek routes' retry whitelist (#2605); the profile's own
  `cordis.patch.yml` applies later, so a full `retryPolicy` written there
  overrides it. The spec follows how bili itself
  was installed (#925): an npm-form install passes the registry name, a
  checkout/dev build passes its absolute path (a `link:` dependency, so
  local work stays live). Legacy managed blocks (`# bili begin` /
  `# bili end`, written by pre-#966 installs) are stripped on install and
  remove — user entries and comments survive, an emptied file gets its
  placeholder `[]` back. Run dsh once in each profile first so the profile
  dirs exist. The plugin spawns its own proxy at load (attaches to a healthy
  one instead of doubling; parent-pid watchdog), rewrites model-API traffic
  to `<proxy>/bili/<upstream-url>` via a global fetch patch, registers the
  manifest tools verbatim, and gates plugin-mode headers on tool readiness
  (round 1 rides wire mode). Opt-out: `BILI_NATIVE_DSH=0`. Remove with
  `bili plugin remove dsh` or `dsh plugin --profile <name> remove
  billion-context` — both go through the same channel. Registry installs
  require a published release that carries `dsh.bundle.patch.yml`; use the
  npm form — a GitHub source address installs source without `dist/` (the
  entry points dangle and dsh silently skips the bundle; the install-time
  guard fails loudly instead, #2471). If dsh
  fails to boot right after an add with `ERR_MODULE_NOT_FOUND` on
  `billion-context/dsh`, the profile resolved a pre-bundle copy from a stale
  package-metadata cache (#953) — re-add pinned: `dsh plugin --profile
  <name> add billion-context@latest`.
- **Desktop app (Electron host):** the same plugin also runs inside the
  deepseek-harness **desktop** app, installed through its in-app plugin
  manager. There the bootstrap spawns its proxy from within the app process,
  whose `process.execPath` is the Electron binary, not Node, and whose GUI
  PATH omits normal install locations — `resolveNodeRuntime` (#819/#1429)
  probes well-known locations first (`/opt/homebrew/bin`, `/usr/local/bin`,
  Volta, …) and falls back to the app's own binary run as plain Node
  (`ELECTRON_RUN_AS_NODE=1`, forced into the child env), so compression works
  with zero configuration even without a standalone Node on PATH; set
  `BILLION_CONTEXT_NODE` to force a specific Node (it beats both). Before
  #1429 this path threw before spawning and every session silently degraded
  to direct send (uncompressed), visible only in bili.log.
- **Auto-update keeps profiles in lockstep:** the refresh has two triggers —
  after a global self-update, AND from the **profile copy's own proxy** when
  its periodic check sees a newer registry version (so dsh plugin-market
  users with no global bili running still refresh, #1196). Both scan
  `~/.dsh/profiles/*/package.json` and bring any registry-pinned
  `billion-context` dependency to the target version (the new global version
  for the global trigger, registry-latest for the self trigger), always
  through dsh's own `plugin add` channel — never an in-place copy — so the
  loaded plugin and the proxy never drift apart again (#953); profiles
  pinned to a local source are left alone. The refresh is best-effort,
  retries next cycle on failure, and never fails the update or the proxy.
 - **Reported: zero proxy traffic for some transports under profile install
   (#1158, under investigation):** sessions served by some of dsh's
   `llm-pi-ai`-layer transports show NO model request ever reaching the proxy
   (no `processTurn` logged; bili tools 404 with "no model request has
   arrived") while other providers in the same host work normally. The root
   cause is still being pinned down with runtime evidence — candidates: the
   transport-level fetch shape (SDK-injected fetch / non-global dispatcher) or
   a host-side attribution gap leaving the traffic unclaimed by the takeover
   gate. Detection: the proxy logs a one-time `[plugin] NO MODEL REQUESTS seen
   for conversation …` warning, and the dsh plugin logs each distinct endpoint
   the attribution gate lets through unproxied (once per process). Reliable
   workaround meanwhile: launch through `bili dsh` instead — the launcher's
   settings overlay rewrites those providers' `baseURL`s to `/bili/` URLs, so
   the traffic reaches the proxy regardless of which fetch the transport uses
   or what the attribution state is.
 - **Web-profile caveat (#1772, corrected by #2474):** when a profile's
   bundles include `@deepseek-ai/dsh-web-app`, the running `compaction-basic`
   instance lives inside an agent preset (`preset-standard.config.plugins`).
   No patch layer can address that NESTED row by id — dsh's patch engine
   indexes only top-level rows and true group children — so the bundled
   `auto: false` lands on web-app's already-disabled host-plane row and the
   preset instance keeps auto-compaction ON. But `preset-standard` itself is
   an ordinary bundle-layer entry: a profile-level patch (your profile's
   `cordis.patch.yml`, applied after every bundle) overrides it by id with a
   FULL-SNAPSHOT `config` — copy the complete preset config from
   `dsh --profile <name> --dump-config`, add `config.auto: false` under its
   `compaction-basic` row, append the result to `cordis.patch.yml`. Config
   replacement is WHOLESALE: a partial snippet silently drops everything not
   restated — including the preset's own `id`/`order` identity, which can
   leave the preset unrecognized by the roster — and `- insert:` with the
   same id appends a second dead row instead of merging. The snapshot also
   freezes the roster until re-copied after a dsh preset update. The plugin
   logs a one-time `[dsh-client]` warning naming this recipe at boot in such
   profiles; ACP compression is unaffected.

Under a `bili dsh` launch the plugin ATTACHES to the launcher's proxy (no
second spawn). Raw upstream URLs rewrite to `<proxy>/bili/<url>` like
spawn mode (a loopback proxy target is never proxied, so the MITM envs are
simply bypassed); already-routed `/bili/`-prefixed requests pass through
untouched except for header stamping. Known limitation: manual
`/compact` has no dsh-side event hook, so its boundary is left to the
kernel's natural ingest diff (auto-compaction is off in non-web profiles, so
this is rare; see the #1772 caveat above for web profiles).

## Kimi Code (Moonshot)

Three aligned modes: `bili kimi` (launcher, cert-MITM — README Quickstart
Option 2), `/bili/`
URL prefix, and native plugin mode (`bili plugin install kimi`, #963). Kimi
Code v2's plugin system is declarative only (`kimi.plugin.json`: MCP servers,
hooks, skills — no in-process JS execution), so bili cannot patch the client's
fetch stack like it does for pi/opencode/dsh. Instead the plugin ships two
small node scripts that do the work around the client:

- **Install:** `bili plugin install kimi` writes
  `$KIMI_CODE_HOME/plugins/managed/billion-context/kimi.plugin.json`
  declaring a stdio MCP server (`node <root>/dist/kimi/native-mcp.js`) plus a
  `SessionStart` hook (`node <root>/dist/kimi/bootstrap-hook.js`, 30 s
  timeout), and registers the plugin in
  `$KIMI_CODE_HOME/plugins/installed.json`. The installer requires
  `kimi --version` ≥ 2.0.0 and refuses below that (the launcher still works
  either way). Remove with `bili plugin remove kimi` (managed dir + registry
  record + config restore).
- **Per-session bootstrap:** kimi spawns the MCP server as a direct child for
  each session; at startup it attaches to a healthy proxy
  (`BILLION_CONTEXT_PROXY`) or spawns its own on an ephemeral port, then
  rewrites the client's routing with an idempotent, line-surgical managed
  block in `~/.kimi-code/config.toml`: an own provider `[providers.bili]`
  (`base_url = http://127.0.0.1:<port>/bili/<upstream>`, cloning the active
  provider's `oauth` / `api_key` reference verbatim), a `[models.bili-kimi]`
  alias, and a top-level `default_model` redirect with the previous value
  recorded inside the block. The original file is snapshotted to
  `config.toml.bili-bak` once; every write happens under a mkdir lockfile and
  user content outside the block is never touched. Kimi's config hot-reload
  applies the change to live sessions. The `SessionStart` hook runs the same
  bootstrap opportunistically (attach-only — it never spawns); its
  non-blocking race is tolerated by design: round 1 may ride direct/wire mode,
  and the invariant is never pointing `base_url` at a dead port.
- **Plugin-mode stamping:** the block gains
  `custom_headers = { x-bili-plugin = "kimi" }` ONLY after the ACP tool list
  has been verified against the live proxy manifest — until then traffic rides
  wire mode. Because `custom_headers` are static per provider they cannot
  carry per-request window/model headers without going stale on model switch;
  the runtime-info report therefore happens at bootstrap only (model + context
  window + max output from the client's own config whenever present).
- **Watchdog & lifecycle:** the MCP child probes the proxy every 30 s. In
  attach mode it waits forever (it never touches a user-owned proxy); in spawn
  mode a dead proxy is respawned and the routing rewritten to the new origin.
  If recovery fails, the managed block is removed so traffic degrades back to
  direct upstream rather than hitting a dead port. When a session ends, kimi
  kills the MCP child and the parent-pid watchdog tears down the spawned
  proxy. Multiple concurrent TUIs share the first-spawned proxy; when it goes
  away the remaining sessions respawn and re-route automatically.
- **Known limitations:** subagent conversations get their own derived proxy
  sessions (kimi exposes no stable session id; tool calls bind via the
  per-call `conversation_id` argument), and kimi's native auto-compaction is
  NOT pushed out — ACP compression simply fires first, as in launcher mode.
   Opt-out: `BILI_NATIVE_KIMI=0`.

## Hermes (Nous Research)

Three aligned modes: `bili hermes` (launcher, cert-MITM — README Quickstart
Option 2), `/bili/`
URL prefix, and native plugin mode (`bili plugin install hermes`, #958). The
hermes CLI agent's plugin API is Python-only (the `desktop/plugin.js` SDK
belongs to the separate Desktop app), so the native plugin is a small
pure-stdlib Python module shipped inside the npm package:

- **Install:** `bili plugin install hermes` copies `plugin.yaml` +
  `__init__.py` into `~/.hermes/plugins/billion-context/`, writes a
  machine-owned `bili.json` sidecar pointing at the global bili install
  (`dist/index.js` + node path), and enables the plugin through hermes' own
  channel (`hermes plugins enable billion-context` — if the CLI isn't on PATH
  the same command is printed instead). Start a new hermes session to
  activate. Remove with `bili plugin remove hermes`; refresh with
  `bili plugin update hermes` after a global update.
- **Lifecycle:** at load the plugin attaches to a healthy running proxy or
  spawns its own on an ephemeral port (parent-pid watchdog tears it down when
  hermes exits; concurrent starts arbitrate through the same starting-marker
  protocol the launcher uses). Only once the proxy is verified healthy does it
  point hermes' httpx stack at it via `HTTPS_PROXY` / `https_proxy` +
  `SSL_CERT_FILE` (bili's combined CA bundle — current hermes resolves ambient
  trust there; `HERMES_CA_BUNDLE` stays set for older builds) —
  `~/.hermes/config.yaml` is never touched. Provider https hosts are read from hermes' config and whitelisted
  for MITM; everything else blind-tunnels exactly like launcher mode. If no
  proxy can be made healthy, the plugin stands down silently and traffic goes
  direct (no compression, no dead port).
- **Plugin-mode stamping:** an `llm_request` middleware stamps
  `x-bili-plugin: hermes` + conversation id (= the hermes session id, so
  gateway multi-session stays safe) + model, and `x-bili-plugin-max-output`
  once known — ONLY after the ACP tools are registered against the live proxy
  manifest; round 1 rides wire mode. A `pre_api_request` hook captures the
  effective `max_tokens` and pushes runtime-info (model + max output) to the
  proxy. `compress` / `decompress` / `acp_status` are registered as real
  hermes tools served by the proxy's existing plugin endpoints.
- **Known limitations:** requests going out hermes' Codex-wire transport may
  drop the per-request header surface, so such setups stay in wire mode until
  that transport exposes headers. Inert when `BILLION_CONTEXT_PROXY` is set
  (the launcher owns the proxy) or `BILI_PROVIDER_REWRITES` is defined.
  Opt-out: `BILI_NATIVE_HERMES=0`.

## ZCode (Z.ai / bigmodel coding plan)

Three aligned modes: `/bili/` URL prefix, cert-MITM through the GUI's
Settings → Network (HTTP proxy + root-CA path), and native plugin mode
(`bili plugin install zcode`, #1145). ZCode's extension surface is
Claude-Code-shaped but declarative: user-level hooks and stdio MCP servers in
`~/.zcode/cli/config.json`, no in-process JS seam. So the native lane ships
two small node scripts that do the work around the client:

- **Install:** `bili plugin install zcode` writes `~/.zcode/cli/config.json`:
  sets `hooks.enabled = true`, appends a `SessionStart` process hook
  (`node <root>/dist/zcode/bootstrap-hook.js`) and registers a stdio MCP
  server `mcp.servers.bili` (`node <root>/dist/zcode/mcp-entry.js`). A
  pre-existing user-owned `mcp.servers.bili` entry is never overwritten — the
  installer refuses loudly instead. No URL is frozen at install time; routing
  happens per session. Remove with `bili plugin remove zcode` (strips only
  bili's entries, reverts `hooks.enabled` when it was the one to enable it,
  and restores the provider store from its snapshot).
- **Open sessions after removal (#2155):** `bili plugin remove zcode` cannot
  reach into already-open client windows — their MCP child is gone but the
  proxy-side binding (session metadata) survives. Such zombie sessions are
  detected after 5 consecutive nudged rounds with no plugin header, no bili
  tools on the wire, and no compression: the session self-heals by
  **degrading to proxy mode** — the ACP tools are re-injected wire-side and
  the proxy owns compression again (the nudge stays). When wire injection is
  unavailable (`compress.injectTool=false`) the nudge is suppressed instead
  until a compression reduction resumes. A returning plugin header (client
  restarted / reinstalled) restores plugin mode on the first request. The
  remove command prints a note when live sessions were seen in the last 10
  minutes; the web UI badges such sessions ("heal").
- **Per-session bootstrap:** each ZCode session spawns the MCP child as a
  direct process; at startup it attaches to a healthy proxy
  (`BILLION_CONTEXT_PROXY`) or spawns its own on an ephemeral port, then
  rewrites the active provider store with idempotent JSON surgery under a
  mkdir lockfile: each routable provider entry's `baseURL` becomes
  `http://127.0.0.1:<port>/bili/<upstream>` (any custom baseURL you set is
  preserved verbatim behind the wrapper). Both store generations are handled:
  legacy `~/.zcode/v2/config.json` (`provider.<id>.options.baseURL`) and the
  v3.14+ personal store `~/.zcode/v2/provider_config.json`
  (`config.providerConfigRules.providerRules[].config.api.baseUrl`) — when
  both exist, the new store wins (see Routing scope for which entries on it
  route and which are skipped). The original file is
  snapshotted to `<file>.bili-bak` once per user edit (the snapshot always
  reflects your last real state, never bili's own writes); every other key is
  byte-for-byte. Legacy-generation clients load provider config at startup —
  restart ZCode once after installing; newer builds pick up routing changes
  mid-session (~1 s polling). The `SessionStart` hook runs the same bootstrap
  opportunistically (attach-only — it never spawns); its non-blocking race is
  tolerated by design: round 1 may ride wire mode, and the invariant is never
  pointing `baseURL` at a dead port.
- **Plugin-mode stamping:** once the MCP child verifies the ACP tool list
  against the live proxy manifest, the routed entries gain
  `headers["x-bili-plugin"] = "zcode"` — until then traffic rides wire mode.
  Tool calls bind via the per-call `conversation_id` argument (#760).
- **What gets cleaned vs. never touched (unified ACP invariants):** model
  prose may have bili render-tag echoes / marker lines / degenerate residue
  stripped in transit; the **thinking channel** (anthropic `thinking`, google
  `thought`, openai `reasoning_content`/`reasoning`, responses reasoning
  summaries), **tool-call arguments** (model-written file content) and
  **user messages** are byte-for-byte untouched.
- **Routing scope (#1622):** native mode wraps **every** provider entry with
  a usable http(s) `baseURL` — the same "all providers ride compression"
  semantics as the in-process natives (pi/dsh) — not just the bigmodel
  coding-plan accounts. Entries that cannot be wrapped are skipped with a
  logged reason instead of silently dropped:
  - **client-signing accounts (#1621):** on v3.14+ personal stores the
    coding-plan accounts stay direct (see Known limitations); every other
    provider still routes.
  - **loopback targets (#809):** an http loopback `baseURL` (localhost /
    127.x.x.x / ::1) is never re-proxied — wrapping it would stack bili onto
    itself or onto your own local relay.
  - **`direct` exemptions:** a provider route declaring `"direct": true` in
    the `providers` table (keyed by upstream URL — see CONFIGURATION.md)
    stays direct; the same exemption any lane can honor.
  The lane launches its proxy in the self-managed port zone (#1660): zone
  base `18787`, a per-lane sticky record so a past +1-ladder drift is
  followed automatically, collisions resolved by the child's +1 ladder,
  and the shared store rewritten to the live origin on drift — wrappers
  survive session restarts even without handoff. `BILI_ZCODE_PORT` pins an
  exact port instead (strict-port: a squatter is refused loudly, no hop).
  `BILI_ZCODE_ROUTE`
  (`plans`/`none`) is a compat escape hatch, and `BILI_ZCODE_SIGNING_FIXED=1`
  flips the #1621 skips off once a ZCode build ships the signing fix.
- **Watchdog & lifecycle:** the MCP child probes the proxy every 30 s. In
  attach mode it waits forever (it never touches a user-owned proxy); in spawn
  mode a dead proxy is respawned and the routing rewritten to the new origin.
  If recovery fails, the managed rewrite is removed so traffic degrades back
   to direct upstream rather than hitting a dead port. When a session ends,
   ZCode kills the MCP child and the parent-pid watchdog tears down the spawned
   proxy; before the MCP child exits (SIGTERM/SIGINT/normal exit) it hands off
   under the lock — if the shared provider store still points at its own proxy,
   it re-points at another live compatible instance, or removes the managed
   rewrite back to direct when none exists (#1623), so a dead instance never
   leaves a dead port in the shared config. The watchdog also checks the shared
   store on every tick: if a dead port from another instance is left behind
   (hard-kill cases where the handoff never ran — e.g. Windows' TerminateProcess
   skips JS handlers), it takes over the repair (live instance preferred,
   otherwise revert to direct); it only acts while the store points at a dead
   port and never steals routing away from a live instance. Concurrent sessions
   share the first-spawned proxy; when it goes away the remaining sessions
   respawn and re-route automatically. Boundary: ZCode caches the provider
   baseURL per session, so the repairs above only take effect on FRESH reads
   (new sessions/queries) — an in-flight session keeps retrying its cached old
   port until it re-reads. To avoid this structurally, pin `BILLION_CONTEXT_PROXY`
   at a resident proxy (`bili start`) and let every session attach to it
   (attach mode never touches a user-owned proxy).
- **Known limitations:** ZCode's anti-fraud fingerprinting (#661) applies to
  MITM-rebuilt bodies on `zcode.z.ai` login traffic — native mode does not
  touch that surface (model traffic flows through the provider store, not the
  GUI proxy); if you also run the GUI-proxy/MITM setup, keep the
  `"mitm://zcode.z.ai": { "passthrough": true }` route. On v3.14+ builds,
  ClientRequestSigningV4 for coding-plan accounts rejects non-HTTPS origins at
  model creation and derives its handshake path from origin alone (dropping
  any /bili/ prefix), so a /bili/-wrapped baseURL fails with "Client signing
  handshake requires HTTPS." (#1621). The conflict is hardcoded on the ZCode
  side, so native mode detects the v3.14+ store generation and skips the
  rewrite entirely — it logs the reason and leaves traffic direct; use the GUI
  cert-MITM setup for compression on these accounts until ZCode ships a signing
  fix; once it does, set `BILI_ZCODE_SIGNING_FIXED=1` and they route again. Under the default
  `route:"all"` only those accounts are skipped — every other provider on the
  store keeps routing; the whole-store degrade (routing entirely off) now
  only applies under `route:"plans"`, where the plan accounts ARE the signing
  accounts. Pre-3.14 legacy-store clients are unaffected. Inert when
  `BILLION_CONTEXT_PROXY` is set (attach mode owns the proxy) or
  `BILI_PROVIDER_REWRITES` is defined. Opt-out: `BILI_NATIVE_ZCODE=0`.

## Codex (OpenAI Codex CLI)

**Window alignment.** Client-reported plugin/runtime windows and launcher windows
take precedence over the bundled Codex model table. Without a report, a local
proxy reads `models_cache.json` and the base `config.toml` under its `CODEX_HOME`
(default `~/.codex`); `model_context_window` is capped by the matching model's
`max_context_window`, then reduced by `effective_context_window_percent` (Codex's
default is 95). Cache changes are picked up on subsequent requests. Missing,
unreadable or invalid metadata falls back to the bundled table and its existing
272K unknown-model limit. For a remote proxy or a different client profile, pass
the client's window through the existing launcher/runtime reporting mechanism
or set the existing `compress.modelContextLimit`; the proxy's local cache is not
evidence of another machine's configuration. Output headroom still applies.

Codex is the one client a plugin install cannot make self-sufficient. The seam
matrix explains why: claude has a `SessionStart` hook + managed settings block,
zcode has a provider store whose `baseURL` can be rewritten — codex has neither.
Its model traffic routes via environment variables only (`HTTPS_PROXY` /
`SSL_CERT_FILE` — this is how `bili codex` works); the default
ChatGPT-login provider has no config-file routing seam, and a managed
`model_providers` block would force `env_key` API-key auth and **drop the
subscription login**. An MCP server cannot inject env into its parent process,
so the plugin can never route codex's own traffic. Three postures:

| Posture | What you get |
|---|---|
| `bili codex` (launcher) | Full zero-config: a self-managed lane proxy (#1660 zone, sticky port) + cert-MITM env injected into codex — tools *and* compression |
| `bili plugin install codex` + a running bili + self-exported `HTTPS_PROXY` | Tools + compression for power users who manage their own env |
| `bili plugin install codex` alone | The four tools appear in codex but no conversation is proxied, so there is nothing for them to act on; `tools/list` fails with -32003 (`bili proxy unreachable … — start bili or set BILI_MCP_PROXY`) when nothing is reachable |

The install writes a single `[mcp_servers.bili]` block into `~/.codex/config.toml`
(command = node, args = dist/mcp.js). #1660 removed the install-time origin bake
(#403: a baked URL went stale after drift/reboot and left the tools pointing at
a dead port); the shell resolves the proxy at session start — env
`BILI_MCP_PROXY` > the live-instance record (any lane's proxy, or a
`bili start` daemon) > the 8787 user-zone default — so a drifted or rebooted
proxy never strands a dead URL, and the shell simply attaches to whatever is
alive. Session binding is headless: the launcher passes
`BILI_CONVERSATION_ID` at spawn time, and the plugin shell binds the next NEW
session otherwise; per-call `conversation_id` overrides work as everywhere
(#760). Codex ≥0.160 additionally stamps the real thread id on every
`tools/call` via `_meta.threadId`; the shell consumes it per call (strictly
validated, never written back into the spawn-time binding) and it outranks
both a stale `BILI_CONVERSATION_ID` residue and the model-transcribed
`conversation_id` (#2024).

**Responses native chaining (a caveat).** bili compresses by replaying the full
`input`, so it cannot follow OpenAI's native `previous_response_id` chaining: a
delta-only continuation would lose its earlier turns upstream while still
returning 200. Today this is a non-issue for codex — observed builds send
`store:false` and never set `previous_response_id` (an observation, not a proof;
the E2E does not cover that shape). If you point a native-chaining Responses
client through bili, either resend the full input/output history or set
`ACP_KEEP_RESPONSE_ID=1`; when bili strips a non-empty `previous_response_id` it
now logs a `warn` (#1954). Full chaining support is tracked as #1973. See the
[official migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses).

### Run mode: `bili codex` pins embedded (#1867)

Since ~0.156 Codex can attach to (or auto-start) a machine-wide shared
background server whose model traffic uses the environment that was present
**when the daemon started**, not when a session starts. The launcher's proxy is
session-scoped (its port dies with the process), so a long-lived daemon cannot
route through it safely: if codex starts first without bili's env, later
`bili codex` sessions silently attach to it and bypass compression entirely;
if bili starts first, the surviving daemon keeps pointing at a dead port. The
launcher therefore passes `--no-daemon` explicitly — after probing
`codex --help` for the flag (older binaries launch unchanged) and only when the
user has not already pinned a mode (`--no-daemon` or `--remote`). Result:
deterministic embedded runs, no per-launch fallback warning, no silent bypass.
The #321 budget `-c` args are kept verbatim (embedded mode honors them
identically). If you want the shared background server, run native `codex`
directly — no compression, but tools still work via `bili plugin install codex`.

### Windows launch path: user argv never re-enters cmd.exe (#2196)

On Windows the default npm install puts a `codex.cmd` shim on PATH, and its
`%*` forwarding re-parses every user argument through cmd.exe's LINE parser —
which has no escape mechanism: embedded double quotes split tokens
(`Please say "hello world" exactly` arrived as four arguments), `%VAR%`
expands, `&|<>^()` act as command operators, and empty arguments vanish.
Plain spaced prompts survived, which is why the #679 space-truncation fix did
not expose it. #2196 makes the launcher refuse to feed user argv into that
parser:

- **Resolution order (win32 only):** within each PATH directory the native
  `codex.exe` wins over `codex.cmd`/`codex.bat` (earliest directory still wins
  overall); a `.cmd`/`.bat` hit is upgraded to `node <official bin/codex.js>`
  when it sits beside a trusted npm layout — `<dir>/node_modules/@openai/codex`
  whose package.json is named `@openai/codex` with a resolvable `"codex"` bin
  entry, AND shim text referencing that package (a hand-written `codex.cmd`
  placed beside an unrelated tree must not hijack the launch). Running the
  official wrapper under Node reproduces exactly what the shim does — vendor
  binary lookup, env init, signal forwarding — while Node's own CreateProcess
  argv encoding carries every argument verbatim. Unrecognized layouts
  (yarn-classic `.bin` trees, pnpm store shims without the local link, …) keep
  the legacy cmd path under the contract below.
- **Pass-through contract:** the remaining cmd-wrapped launches — any client's
  `.cmd`/`.bat`/extensionless binary, plus dsh-channel spawns — accept only
  argv the line parser can carry verbatim. Anything else (embedded quotes,
  `%VAR%`, metacharacters, empty args, line breaks, odd trailing-backslash
  runs) fails loudly with an actionable error *before* any process starts,
  instead of arriving corrupted or executing unintended commands. Direct-spawn
  `.exe` launches are unaffected: Node encodes their argv losslessly itself.
- **Workaround / power-user knob:** `BILI_CLIENT_BIN=<path>` still outranks
  everything — point it at the real `codex.exe` (or at a script entry run
  under node) to bypass the shim entirely.

Verified on windows-latest CI against the real global `@openai/codex` install
(`tests/win-cmd-argv.test.ts`, hard gate in `ci-windows-codex.yml`): the full
corpus — empty arg, plain spaces, embedded quotes, TOML `-c` values, JSON,
Unicode, trailing backslashes, `%COMSPEC%`, `!VAR!`, `&|<>^()` — arrives at the
child process item-by-item identical to the caller array.

## Gemini family (Gemini CLI / iFlow CLI / Qwen Code / Antigravity)

Four launchers for the gemini-cli architecture family (#1043 tier 1). Three of
the four have a base-URL env hook; one doesn't:

- **`bili gemini`** — Gemini CLI (`@google/gemini-cli`). Sets
  `GOOGLE_GEMINI_BASE_URL=<proxy>/bili/<upstream>` (default upstream
  `https://generativelanguage.googleapis.com`; if you export your own
  `GOOGLE_GEMINI_BASE_URL`, that value is relayed through the proxy instead).
  The client switches to its `gateway` auth mode and sends Google-native-wire
  requests straight to the loopback proxy — no MITM, no CA install, and
  `~/.gemini` is never touched. The proxy speaks this wire natively (model
  name rides in the URL path). Limitations: headless `-p` runs need a saved
  auth selection (e.g. `security.auth.selectedType = "gemini-api-key"` in
  settings + `GEMINI_API_KEY`) because gemini-cli rejects purely-env-derived
  gateway auth in non-interactive mode; users on an OAuth personal login
  (CodeAssist) are not covered by this route at all — that path ignores the
  base-URL hook.
- **`bili iflow`** — iFlow CLI (`@iflow-ai/iflow-cli`). Same pattern via
  `IFLOW_BASE_URL` (default `https://apis.iflow.cn/v1`, relayed when you set
  it); OpenAI chat-completions wire.
- **`bili qwen`** — Qwen Code (`QwenLM/qwen-code`). This fork dropped the
  base-URL hook (`DASHSCOPE_PROXY_BASE_URL` is a header-tuning knob, not
  routing), but it honors standard proxy envs, so the launcher uses cert-MITM:
  `HTTPS_PROXY=<proxy>` + `NODE_EXTRA_CA_CERTS=<bili CA>` with a static
  whitelist of the default model hosts (DashScope / Qwen gateway / common
  third-party endpoints). Custom relay hosts: add them with
   `--mitm-domain <host>`. Best-effort route — a `BLIND TUNNEL WARNING` in the
   log means a host is missing from the whitelist.
- **`bili antigravity`** — Google Antigravity (#2115). The launcher drives the
  official CLI binary **`agy`** (the successor of Gemini CLI, which was
  discontinued in 2026-06; found on `PATH` or at `~/.local/bin/agy`, Windows
  `%LOCALAPPDATA%\agy\bin`). Its model channel lives inside the closed-source
  Go `language_server`, which honors an **undocumented** `CLOUD_CODE_URL` env
  override (verified in the v2.19.1 binary: *"Overriding CloudCodeServerURL
  via CLOUD_CODE_URL environment variable"*) — same shape as the gemini-cli
  base-URL hook. The launcher sets
  `CLOUD_CODE_URL=<proxy>/bili/<upstream>` (default upstream
  `https://cloudcode-pa.googleapis.com`; if you export your own
  `CLOUD_CODE_URL`, that value is relayed through the proxy instead). No MITM,
  no CA install. The proxy recognizes the wire **by path**:
  `:streamGenerateContent` / `:generateContent` / `:countTokens` requests are
  routed to the Google-native adapter and compressed like `bili gemini`. If
  the server instead uses gRPC method paths
  (`/google.internal.cloud.code.v1internal.CloudCode/*`), those requests are
  not recognized and relay verbatim without compression — a graceful degrade,
  fixable with a per-lane `protocol` declaration (#1909) once confirmed.
  Fallback if Google ever removes the env hook: cert-MITM — the
  language_server honors `HTTPS_PROXY` and does not pin certificates, so add
  `cloudcode-pa.googleapis.com` to `"mitm".domains` and trust bili's root CA.
  The desktop app and the IDE extension share this same language_server
  channel; the launcher drives the CLI specifically — desktop users can export
  `CLOUD_CODE_URL` manually or use the MITM recipe.

None of the four has a native mode: none exposes an in-loop tool injection
seam (gemini-cli extensions reach custom commands only; the forks inherit
that surface; Antigravity ships a user-plugin system — `plugins/<name>/`
with `plugin.json`, `hooks.json`, `mcp_config.json`, `skills/`, JS sidecars —
but every surface is additive only: tools, prompts, UI, event callbacks.
Nothing in it can intercept or rewrite the model request/response stream,
which stays entirely inside the closed language_server, so wire-only
integration is the ceiling for v1). Launcher-only by design.

## Pi (pi.dev coding agent)

Pi has a full native mode (`bili plugin install pi`, README quickstart
option 1); this section covers what the one-line table can't — **which model
transports the native intercept actually covers**. Pi is the only host that
brings WebSocket model traffic into the loop.

**Sub-agent config (#2230).** The built-in `acp_delegate` surface (three
delegate tools, roles, fleet inspector — wired by `bili pi` through the
embedded extension) is configured in bili's own config file, the `pi.subagents`
section of `~/.config/billion-context/billion-context.json` (boolean shorthand
`"pi": {"subagents": false}` disables it). The four `~/.pi/acp.json` keys
(`delegate` / `delegatePrompt` / `displayUsage` / `debug`) are a deprecated
fallback — read only while the section is absent, ignored once it exists.
Full field table and the `PI_ACP_DELEGATE_*` env overrides:
CONFIGURATION.md → [`pi`](CONFIGURATION.md#pi).

**How routing works.** The pi extension bootstraps (or attaches to) its own
proxy and patches `globalThis.fetch` in-process: every model-API HTTP request
is rewritten to `<proxy>/bili/<upstream-url>`, and the extension stamps the
`x-bili-plugin*` headers through pi's `before_provider_headers` event. Every
HTTP-based provider (Anthropic, OpenAI chat/completions/responses, Gemini,
Mistral, OpenRouter, Azure, custom relays…) rides this path as a named
plugin-mode session.

**WebSocket coverage (#2073, implemented in #2111).** A WebSocket connection never goes through `globalThis.fetch`, so the native extension also wraps `globalThis.WebSocket` at load time — before pi's first model connection (pi's Node branch reads the global per call; its Bun branch caches a subclass on first call, which is why install-time ordering is safe on both runtimes). Only supported Codex Responses model connections are rewritten — every other WebSocket (devtools, third-party libraries, already-routed URLs) passes through untouched:

| Provider / transport | Status |
|---|---|
| All HTTP providers | ✅ covered — named plugin-mode session |
| `openai-codex-responses` (ChatGPT backend-api), `transport: "sse"` | ✅ covered — identical to any HTTP provider |
| `openai-codex-responses`, `transport: "auto"` (default) or `"websocket"` / `"websocket-cached"` | ✅ covered (#2111) — the constructor URL is rewritten to `<proxy-ws>/bili/<https-upstream>` (e.g. `wss://chatgpt.com/backend-api/codex/responses` → `ws://127.0.0.1:<port>/bili/https://chatgpt.com/backend-api/codex/responses`). Constructor args, subprotocols and request headers are preserved, so the same `session-id` pi sends on SSE rides the upgrade and the session identity is byte-identical across transports; subagents keep their own ids. `previous_response_id` incremental continuation works over the lane (the proxy expands deltas before the pipeline and re-optimizes them back upstream) |
| AWS Bedrock (`bedrock-converse-stream`) | ❌ all Bedrock traffic is WebSocket, with no transport option and no custom headers on the upgrade — not coverable by URL interception alone; it needs a dedicated proxy-side WS codec (out of #2111's scope, tracked separately under #2073) |

One topology consequence of the intercept: pi's client-side handshake now targets the local proxy (which always succeeds), so an *upstream* WS refusal surfaces as a mid-stream transport failure instead of triggering pi's same-turn SSE fallback — that fallback only fires on a client-side handshake failure. The explicit `sse` lane below remains the deterministic escape hatch.

**Workaround for the codex provider.** Force the SSE lane in pi's settings
(`~/.pi/agent/settings.json`; project `.pi/settings.json` overrides):

```json
{ "transport": "sse" }
```

The default `"auto"` tries WebSocket first and falls back to SSE only when
the handshake fails; the legacy boolean key `"websockets": false` migrates
automatically. The key is global but only multi-transport providers (today:
the codex provider) consume it — HTTP-only providers ignore it. Verified on
Windows + Pi 1.0.2 (#2063 owner repro): explicit `sse` enters bili with the
correct session id.

The lane is verified end-to-end (`tests/e2e/e2e-pi-codex-ws.test.ts`, real pi against a deterministic mock upstream through the real proxy): explicit-websocket and auto routing, upgrade-header stamps with `session-id` == conversation id, compress/decompress round trips reflected in subsequent requests, `previous_response_id` expansion, upstream-refusal behavior, the explicit-sse regression guard, and two concurrent subagent-style sessions sharing one proxy without cross-talk.

### Subagents (pi-subagents) — native install coverage (#2185)

pi-subagents (a pi.dev package) spawns **child sessions** for foreground and
background subagent runs. Before #2185, a native install
(`bili plugin install pi` / `pi install npm:billion-context`) did not reliably
load the bili extension into those children:

- **foreground children** run in-process with ambient extension discovery off
  (`noExtensions: true`) → the bili extension never loaded; their traffic only
  reached the proxy through the parent process's global fetch patch, so each
  child was recorded as an **anonymous proxy-mode `pfa-*` conversation**:
  compression worked, but there was no named `x-bili-plugin-conversation`
  identity, no parent lineage, and ACP tools existed only as proxy-side wire
  injection;
- **background async runs** launch a detached runner whose child *may* load
  extensions through ambient discovery — it worked by luck under default
  config and silently regressed to a direct upstream connection (zero proxy
  visibility) whenever the agent definition set `extensions` (even `[]`) or
  `denyExtensions`, or on pi-subagents version drift / npm-store sync issues.

**The fix.** At session start the pi extension self-registers itself into
pi-subagents' global required-child-extension registry (feature-detected on
`globalThis[Symbol.for("pi-subagents.required-child-extensions.v1")]`). The
registry entry makes bili a **required extension of every child launched from
that parent session**; required extensions travel through
`additionalExtensionPaths`, which pi loads into its `cliEnabledExtensions`
bucket **even under `noExtensions: true`** — so loading is deterministic in
every cell below. Registration is per parent session, disposed at session
shutdown, and yields to a pre-existing entry on same-session conflict
(first writer wins). `requireForAllRunners` is deliberately **not** set:
non-pi runner placements keep today's behavior instead of being rejected.
When the registry is absent or has a foreign shape (older/newer
pi-subagents), the extension degrades to the pre-fix behavior and logs once.
Kill switches `BILLION_CONTEXT_PLUGIN=0` / `BILI_NATIVE_PI=0` also suppress
registration. No new configuration surface.

Post-fix matrix (real-machine verified: pi 0.83.6 + pi-subagents 0.76.0,
HTTP transports; WS row documented from #2073, no live cell):

| Cell | Pre-fix | Post-fix |
|---|---|---|
| native × foreground × default config | anonymous `pfa-*` proxy mode; ACP tools only via proxy wire injection | **named child-sid plugin-mode session**; ACP tools registered locally from the first request; compression recorded under the child's own id |
| native × background × default config | ambient luck — named plugin mode when the settings packages happened to load | same, now deterministic (`required: ["bili"]` in the child's launch-resolved extensions) |
| native × background × agent def `extensions: []` / `denyExtensions` | **silent direct connect** — zero proxy visibility, no compression | deterministic required-path load; named plugin session. (If a runtime capability ceiling hard-denies extensions, pi-subagents 0.76.0 fails the child launch loudly instead — fail-fast, not silent) |
| launcher mode (`bili pi`) × background | children inherited the provider rewrite (#535) but loaded bili by ambient luck only | registration active (deliberately **not** gated by `BILI_PROVIDER_REWRITES`); parent and children are named sessions routing through the inherited rewrite |
| any × WebSocket-only transport | out of scope — see the WS gap above | unchanged: client-side WS interception stays owner-gated (#2073) |

Caveats worth knowing:

- **Roles with restrictive `tools:` allowlists get the ACP channel back
  automatically (#2268).** An agent definition whose frontmatter `tools:` list
  omits the ACP tool names — all seven builtin roles ship like this (e.g.
  `delegate` lists `read,grep,find,ls,bash,edit,write,contact_supervisor`) —
  no longer loses interactive compression after the #2185 named-plugin fix.
  bili detects such children per request (pi-subagents stamps every child
  session's system prompt with an `<active_agent name="…">` marker; the gate
  also requires the request's tools array to expose none of the names bili
  would inject) and serves them through the **proxy-style compression
  channel**: wire-injected ACP tools + nudge, server-side execution,
  `acp_summary` carrier — while keeping the named plugin-session identity
  from #2185. No configuration change required; the role's original allowlist
  stays intact on the wire, and a mid-session whitelist change self-heals on
  the next request. Scoped to nicobailon/pi-subagents children only (the
  marker is theirs); every other plugin host is unaffected. If upstream ever
  drops the marker, these roles degrade to pre-#2268 behavior (named session,
  no local ACP tools).
  - A role exposing **any** ACP/bili-injectable name stays in pure plugin
    mode (duplicate tool declarations are rejected by providers), so
    **partial grants are unsupported** — grant none, or grant all
    (`compress,decompress,search_context,acp_status[,acp_cache]`).
  - Want locally registered (plugin-carrier) tools for a specific role? Keep
    the manual grant: omit the `tools:` field or add the ACP names to it.
- **One-request registration race in background children** (ACP tools present
  from the second request on) is pre-existing in all modes.
- **Behavior change disclosure:** foreground children move from anonymous
  proxy mode (`pfa-*`) to named plugin mode (child session id + parent
  lineage). Strictly more information, but anything keyed on `pfa-*`
  identities will observe different ids.

## Adopting unlisted clients (any client with a configurable model base URL) (#2340)

Every client that lets you **edit its model endpoint and carries an API key** (rather than a login) can ride compression today with a one-line change — no launcher, no code: prepend the proxy origin + `/bili/` to the base URL (`http://127.0.0.1:8787/bili/https://api.example.com/v1`), keep the API key as-is, and run the daemon (`bili start`). What you get is the full pure-proxy treatment: compression + wire-level tool injection. Details and examples: [CONFIGURATION.md → `/bili/` prefix](CONFIGURATION.md#bili-prefix-api-key-clients).

Verified entry points (community-maintained list — the mechanism is generic):

| Client | Where the base URL lives |
|---|---|
| **Cline / Roo Code / Kilo Code** (VS Code) | provider settings — "OpenAI Compatible" Base URL, or the Anthropic provider's base URL |
| **Continue** | `~/.continue/config.yaml` — per-model `apiBase` |
| **OpenHands** | `llm.base_url` (config or env) |
| **Zed** | `settings.json` — `language_models.openai_compatible.api_url` |
| **Void** | custom OpenAI-compatible endpoint setting |
| **Cursor** (single-model channel) | Settings → Models → OpenAI API key → **Override Base URL** |
| **Warp** | custom-model base URL setting |

Notes:

- **Crush** is a launcher lane now — prefer `bili crush` (config untouched, HTTPS domains MITM'd automatically).
- **Zed** is a launcher lane too — prefer `bili zed` (Linux; config untouched, model domains MITM'd automatically, loopback providers stay direct). The settings.json `api_url` path above remains the cross-platform alternative.
- Clients you **sign into** (OAuth/subscription) usually hardcode the endpoint — the prefix trick doesn't apply; see the [MITM section below](#client-uses-httpproxy-connect-but-nothing-compresses) instead.
- Plain **web apps** (browser-only products) have no local traffic to intercept.
- VS Code extensions keep their base-URL fields in plain-text settings but secrets in the OS keychain — only the base URL ever needs editing here.

## Client uses `http.proxy` (CONNECT) but nothing compresses

Some clients (VS Code-based IDEs: CodeBuddy, Cursor, Windsurf, …) only offer an HTTP **proxy** setting (`http.proxy`, `codingcopilot.httpProxyURL`, …) — no model base-URL to rewrite. Such clients send `CONNECT <model-host>:443` through the proxy instead of plain `/bili/…` requests. That path is only decrypted when the model host is on bili's **MITM whitelist**; otherwise bili blind-tunnels the TLS bytes (opaque relay) and can never see — or compress — the model requests (#897).

This failure mode is now loud instead of silent:

- a one-time `BLIND TUNNEL WARNING` per target host in the log, with the fix steps;
- `blindTunnels` (count + exact target hosts) in `curl -s http://localhost:8787/__bili/health` and `/__bili/stats` (loopback-only);
- an `UNDECRYPTED TRAFFIC (instance-level)` section in `acp_status` output while such tunnels exist.

To actually compress such a client: add its model domain to `"mitm".domains` in `billion-context.json` (e.g. `"mitm": { "domains": ["copilot.tencent.com"] }`) or via `BILI_MITM_DOMAINS`, restart bili, and make the client trust bili's root CA (`NODE_EXTRA_CA_CERTS=~/.local/share/billion-context/ca/root-ca.pem` for Node-based clients, or the client's own CA-path setting). The `/bili/` prefix trick does not apply here — there is no URL to change. Details: [CONFIGURATION.md → MITM](CONFIGURATION.md#mitm-transparent-proxy-login-clients).

## An unrecognized endpoint goes direct and nothing compresses (#1290)

bili only compresses requests whose path matches a known wire protocol (`/chat/completions`, `/llm_raw_chat`, `/v1/messages`, `/responses`, …). A request to any other path — e.g. a third-party plugin's **custom wire** such as Command Code's Go plan posting to `/alpha/generate` — is relayed byte-for-byte and **never compressed**.

That outcome is now loud instead of silent (#1290):

- the client-side fetch hook logs each distinct unrouted **POST** endpoint once per process (`…is not a recognized model endpoint, so bili did not route it through the proxy…`); non-POST traffic — npm registries, catalog JSONs, git refs — is silent by design (#1657: a GET cannot carry a prompt);
- `unrecognizedPaths` (per-path counts) in `curl -s http://localhost:8787/__bili/stats` (loopback-only);
- an `UNRECOGNIZED PATHS (instance-level)` section in `acp_status` output while such requests exist.

Two seams now cover the "custom path, standard wire" case — an endpoint whose path is nonstandard but whose request/response shape is one of the four known protocols:

1. **Client-side, per client** — set the client's model base URL to the protocol-segment form of the `/bili/` tunnel:

   ```text
   http://127.0.0.1:8787/bili/<protocol>/<upstream-base-url>
   # e.g. http://127.0.0.1:8787/bili/openai/https://relay.example.com/api/custom/complete
   ```

   `<protocol>` is one of `anthropic`, `openai`, `responses`, `google`. It forces the wire protocol regardless of the path — it **outranks** every server-side signal. Use it when you control the client's base URL but the endpoint path is nonstandard.

2. **Server-side, per lane (#1909)** — declare `"protocol"` on the provider key that already routes the host/path (see [CONFIGURATION.md → `protocol`](CONFIGURATION.md#protocol)). Use it when the client's base URL cannot be changed (hardcoded endpoints, MITM-intercepted hosts).

Either way the declaration only *identifies* the wire — a body that does not parse as that protocol still relays verbatim (#1284). A genuinely custom wire (own request/response shape, e.g. Command Code's `/alpha/generate`) still needs its own support; the fix for that is to use the provider's standard protocol endpoint (Command Code's Provider plan posts to `/provider/v1/chat/completions`, which bili does compress).

## OpenCode

One bundled plugin serves **both** OpenCode generations: the agent file keeps
the V1 `server()` export alongside the V2 `setup()`, so hosts ≥ 1.18.29 load
the V1 shape and 2.x hosts load the V2 `setup()`. The standalone
[`opencode-acp`](https://github.com/ranxianglei/opencode-acp) extension is
V1-only and does **not** load under 2.x — for OpenCode 2.x, billion-context
is the recommended context manager. Everything below is verified end-to-end
on `@opencode/cli` 2.0.3 (V1 lane: 1.14.46 and 1.18.31).

| Path | Command | When |
|---|---|---|
| Launcher (easiest) | `bili opencode` | one command brings up proxy + client; real config untouched |
| Native (no launcher) | `bili plugin install opencode` | self-spawning plugin in your real config; start `opencode` as usual |
| Pure proxy (fallback) | baseURL `/bili/` prefix | no plugin — wire-level tool injection |

These paths are **mutually exclusive** — each one owns routing of the same requests, so exactly one may be active per host instance. A hand-written `/bili/` provider baseURL is the pure-proxy path's marker; writing it while the native plugin is installed is a **conflicting configuration** (#1958): the runtime warns once per session (deduplicated per origin) with a fix-it guide — remove the prefix or remove the plugin — and the requests stay on the plain-proxy path they encode (no plugin session markers). The supported exception is an explicit pin of the **same** origin — `BILLION_CONTEXT_PROXY` pointing at the proxy the URLs already ride — which stays silent.

### Launcher — `bili opencode`

HTTPS rides cert-MITM, HTTP a temp `opencode.json` clone with `/bili/`
(JSONC comments accepted, merged the way opencode itself merges them;
relative local plugin specs re-anchored to absolute paths in the clone —
opencode resolves them against the declaring config file's dir, #826). Host
generation is detected with a `--version` probe (failed probe defaults to
1.x): on a **2.x** host the built-in V2 plugin (`dist/agent/opencode.js`) is
injected as a temp wrapper directory whose `index.js` re-exports the plugin
file (2.x rejects bare file paths in the config `plugin` array); **1.x**
hosts get the bare file path.

What the plugin does (both generations): registers the bili tools natively
in-host — compress / decompress / search_context / acp_status (+ absorb) —
and stamps the proxy headers on every outgoing provider request, including
context-window / max-output read from the host's own model catalog
(`ctx.catalog.model.list()`, refreshed every 60s) and reported to the proxy
as runtime-info (#955) — compression runs in plugin mode with **no**
wire-level tool injection. Native auto-compaction is disabled automatically
(`compaction.auto: false`). Every registration is defensive (optional
chaining): on any 2.x build where a seam is missing or never fires, the
plugin stays inert and the session transparently runs in plain proxy mode
instead of breaking — observed across adjacent `dev` builds whose API
surfaces differ from each other (#754 review probes).

1.x specifics (verified 1.14.46 + 1.18.31): the V1 `.server()` hooks rewrite
every provider `options.baseURL` to `<proxy>/bili/…` in-process and set
`compaction.auto: false`; `chat.headers` stamps the plugin headers per
request; `tool` registers the bili tools with real zod shapes (zod is a
runtime dependency — when it cannot be resolved the plugin degrades to
rewrite-only). Providers **without** an explicit `baseURL` (SDK defaults,
e.g. bare `@ai-sdk/openai` → api.openai.com) are caught by a global `fetch`
patch (log: `v1: fetch patch installed`) — idempotent, passes
`/bili/`-wrapped URLs through untouched; verified including the OpenAI
Responses endpoint.

### Native (no launcher) — `bili plugin install opencode`

Registers a self-spawning plugin in your real opencode config and sets
`compaction.auto: false`; afterwards plain `opencode` works as-is. No MCP
face is added by default (the native plugin already provides the bili tools,
session-bound); pass `--with-mcp` to add one — the entry then carries no
origin pin, so it survives the plugin's ephemeral-port proxy restarts (#926).
Entry form depends on how THIS bili was installed: an **npm install** writes
the bare package name (`"plugin": ["billion-context"]`) — the package
publishes `exports["./server"]` → `dist/agent/opencode-native.js`, so
opencode loads it through its own Npm.add machinery; zero absolute paths, portable. (That exact bare-name entry doubles as a hand-install without bili — see README Quickstart Option 1.) A **git checkout / dev build** falls back to a local shim dir
(`<configDir>/plugins/billion-context/index.js` → this checkout's
`dist/agent/opencode-native.js`) — machine-local by construction; re-running
install from an npm install migrates the entry back to the bare name.

At load the plugin bootstraps its own proxy (attaches to a healthy instance
instead of doubling; parent-pid watchdog kills it when opencode exits),
routes model-API traffic to `<proxy>/bili/<upstream-url>`, and exposes the
same native bili tools as launcher mode — no fixed port, no env var, no
launcher. Opt-out: `BILI_NATIVE_OPENCODE=0`. If no proxy can be made
healthy, requests go direct (uncompressed) with a one-time warning and
recover automatically. Under a `bili opencode` launch this entry is skipped
entirely (the launcher owns the proxy).

### OpenAI Responses WebSockets (V2)

The V2 plugin also intercepts OpenAI `experimental.ws.handshake` requests.
Both legs use WebSocket: OpenCode → bili → the Responses upstream. This
includes API-key OpenAI and ChatGPT Pro/Plus browser/headless OAuth; the login
method does not select the transport. No OpenCode configuration rewrite or
new bili setting is required. The socket must originate locally and carry
the cooperative plugin identity; generic or unclaimed upgrades retain 426.

ACP processing, native tools and usage accounting stay active. Client deltas
are expanded before compression. Upstream deltas are used only when the
processed history exactly extends the previous response; a fold starts a new
chain with full compressed input on the same socket. Ref tagging or other
history edits can also require full input, so connection reuse does not imply
every turn is incremental. Older hosts without the experimental hook must
use OpenCode's existing `providers.openai.settings.transport: "http"` setting.
Realtime, multiplexed concurrent responses, and remote WS clients are outside
this integration's scope. Verification: real OpenCode V2.0.20 with a local
Responses WS upstream, not live OpenAI/ChatGPT credentials.

### Pure proxy (no plugin)

Point the provider baseURL at the proxy like any other client:

```json
{
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:8787/bili/http://upstream.example/v1",
        "apiKey": "sk-any"
      }
    }
  }
}
```

Note: 2.0 AI-SDK providers require an `apiKey` field even for local
endpoints that never check it — set any non-empty value.

This path means **no plugin**: if the native plugin is also installed, the
runtime warns once per session — pick one path per provider (#1958).

### Status: `/acp` and `acp_status`

The `/acp` panel is session-bound in all modes, and the `acp_status` tool is
its in-host equivalent everywhere. On 2.0.x stable, where the command editor
supports adding entries (`editor.add`), the V2 plugin additionally registers
an `/acp` slash command — rendered as a synthetic non-model message,
panel-first like the `acp_status` tool; on older shapes the registration
stays inert. Note `opencode run` mode dispatches no slash commands at all
(they pass through to the model) — use the TUI.

The same seam carries `/acp-cache` (#1146) — the human entry point to the
prompt-cache reconciliation report (identical output to the `acp_cache` tool):
pi/omp register it natively (`/acp-cache [full]` for the every-line listing);
opencode V1 renders it as an ignored message the proxy strips from model
context before it reaches the wire; opencode V2 as a synthetic message (report
visible up to ~8 KB); dsh (both lanes) shows the default summary ledger — dsh's
command API passes no arguments, so there is no `full`. Legacy opencode-acp
sessions (#920) get an explicit unavailable notice instead (their traffic
bypasses this proxy's compression state). Claude Code has no in-process command
API: `bili plugin install claude` writes a model-mediated
`commands/acp-cache.md` markdown command whose prompt drives the `acp_cache`
MCP tool and pastes the report back verbatim. codex/kimi/hermes expose no
user-typable command seam — ask the model to call its `acp_cache` tool directly.
Per-fold P&L verdicts are priced by the optional `compress.priceProfile`
(normalized multipliers over the input-token unit); when no level sets it, the
request model's models.dev price row applies in absolute $/Mtok (kernel ratio
defaults only for unresolvable models) — breakeven/PAID BACK therefore reflect
your upstream's actual economics out of the box; override per provider for
relays with custom markup (CONFIGURATION.md, #1279).

The same seam carries `/acp-rule` (#1251/#1399) — the human entry point to
the persistent-rules feature (identical output to the `acp_rule` tool):
pi/omp register it natively with the tool's full operation set — bare
`/acp-rule` lists every recorded rule, `/acp-rule <text>` records one directly
(as if the model had called it), `/acp-rule remove <id>` deletes one, and bare
`/acp-rule clear` wipes all recorded rules (`clear <text>` records instead of
wiping — a typo must not destroy every rule). The wrapped transcript message
is stripped from model context by content signature like the cache report —
recorded rules reach the model every turn via the system-prompt injection
anyway.

### Legacy opencode-acp sessions (#920)

On 1.x hosts, pre-migration [`opencode-acp`](https://github.com/ranxianglei/opencode-acp)
sessions keep working under both lanes: the launcher strips the
`opencode-acp` entry from its temp config clone (the host never loads it
armed), and each lane absorbs the installed package (imported directly from
`node_modules` — `.opencode/node_modules`, project `node_modules`, global npm
root, or opencode's config-scope modules, first hit wins). A session is
legacy iff opencode-acp's persisted state file exists
(`<XDG_DATA_HOME>/opencode/storage/plugin/acp/<sessionID>.json`, or the dir
from `storagePath` in `acp.jsonc`):

- **Legacy session** — compression runs through the absorbed opencode-acp
  (its own refs and block store keep working: `compress` / `decompress` /
  `search_context` / `acp_status` / `acp_context_recap` all execute in it).
  Its model requests carry `x-bili-plugin-bypass: 1`; the proxy forwards
  them VERBATIM — no wire injection, no nudge, no session binding.
- **New session** — bili owns it: tool calls forward to the proxy's plugin
  endpoints (plugin mode). The executor routes by session lane, so a new
  session's `compress` reaches the proxy while a legacy session's reaches
  opencode-acp. `acp_context_recap` has no proxy counterpart — on new
  sessions the proxy answers with its unknown-tool message.

`/acp` and `/dcp` route the same way. Adoption of new sessions into
opencode-acp's registry is prevented by gating its transforms (system /
messages / text.complete) on the legacy predicate. Degradation: when the
package is absent or fails to import (or isn't v1), bili runs alone and
legacy sessions behave as read-only archives (old tags render, `decompress`
returns `[Block … not found]`, new refs restart from m00001).

### Caveats

- The 2.x line publishes as npm package `@opencode/cli`, and its plugin API
  surface is still moving between builds (adjacent `dev`-channel builds
  expose different `ctx` shapes) — the hook/tool details above are
  version-specific observations, not a stable contract.
- Design note: the V2 plugin is a thin protocol client (no acp-kernel
  inside) because the proxy stays the single compression authority — that
  eliminates kernel-version drift between agent and proxy; it does not rely
  on the plugin API being unable to mutate context (that capability varies
  by 2.x build).

