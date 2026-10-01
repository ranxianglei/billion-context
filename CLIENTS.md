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
  (`compaction-basic` → `auto: false`); manual `/compact` stays available.
- **Profile install (no launcher) — one lane (#966):** `bili plugin install
  dsh` runs `dsh plugin --profile <name> add billion-context` for every
  existing profile — pnpm installs the package into each profile's own
  `node_modules`, and dsh mounts the bundled patch layer
  (`dsh.bundle.patch.yml`) automatically. The spec follows how bili itself
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
  require a published release that carries `dsh.bundle.patch.yml`. If dsh
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
 - **Web-profile caveat (#1772):** when a profile's bundles include
   `@deepseek-ai/dsh-web-app`, the running `compaction-basic` instance lives
   inside an agent preset (`preset-standard.config.plugins`) that no patch
   layer can reach by id — dsh's patch engine indexes only top-level rows and
   true group children — so the bundled `auto: false` lands on web-app's
   already-disabled host-plane row and the preset instance keeps
   auto-compaction ON. The plugin logs a one-time `[dsh-client]` warning at
   boot in such profiles; ACP compression is unaffected.

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
(#760).

## Gemini family (Gemini CLI / iFlow CLI / Qwen Code)

Three launchers for the gemini-cli architecture family (#1043 tier 1). Two of
the three have a base-URL env hook; one doesn't:

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

None of the three has a native mode: none exposes an in-loop tool injection
seam (gemini-cli extensions reach custom commands only; the forks inherit
that surface). Launcher-only by design.

## Client uses `http.proxy` (CONNECT) but nothing compresses

Some clients (VS Code-based IDEs: CodeBuddy, Cursor, Windsurf, …) only offer an HTTP **proxy** setting (`http.proxy`, `codingcopilot.httpProxyURL`, …) — no model base-URL to rewrite. Such clients send `CONNECT <model-host>:443` through the proxy instead of plain `/bili/…` requests. That path is only decrypted when the model host is on bili's **MITM whitelist**; otherwise bili blind-tunnels the TLS bytes (opaque relay) and can never see — or compress — the model requests (#897).

This failure mode is now loud instead of silent:

- a one-time `BLIND TUNNEL WARNING` per target host in the log, with the fix steps;
- `blindTunnels` (count + exact target hosts) in `curl -s http://localhost:8787/__bili/health` and `/__bili/stats` (loopback-only);
- an `UNDECRYPTED TRAFFIC (instance-level)` section in `acp_status` output while such tunnels exist.

To actually compress such a client: add its model domain to `"mitm".domains` in `billion-context.json` (e.g. `"mitm": { "domains": ["copilot.tencent.com"] }`) or via `BILI_MITM_DOMAINS`, restart bili, and make the client trust bili's root CA (`NODE_EXTRA_CA_CERTS=~/.local/share/billion-context/ca/root-ca.pem` for Node-based clients, or the client's own CA-path setting). The `/bili/` prefix trick does not apply here — there is no URL to change. Details: [CONFIGURATION.md → MITM](CONFIGURATION.md#mitm-transparent-proxy-login-clients).

## An unrecognized endpoint goes direct and nothing compresses (#1290)

bili only compresses requests whose path matches a known wire protocol (`/chat/completions`, `/llm_raw_chat`, `/v1/messages`, `/responses`, …). A request to any other path — e.g. a third-party plugin's **custom wire** such as Command Code's Go plan posting to `/alpha/generate` — is relayed byte-for-byte and **never compressed**. There is no config seam to declare an arbitrary new wire today; adding one is a separate feature, not a switch you can flip.

That outcome is now loud instead of silent (#1290):

- the client-side fetch hook logs each distinct unrouted **POST** endpoint once per process (`…is not a recognized model endpoint, so bili did not route it through the proxy…`); non-POST traffic — npm registries, catalog JSONs, git refs — is silent by design (#1657: a GET cannot carry a prompt);
- `unrecognizedPaths` (per-path counts) in `curl -s http://localhost:8787/__bili/stats` (loopback-only);
- an `UNRECOGNIZED PATHS (instance-level)` section in `acp_status` output while such requests exist.

If you expected compression at such an endpoint, use the provider's standard protocol endpoint instead (Command Code's Provider plan posts to `/provider/v1/chat/completions`, which bili does compress); a genuinely custom wire needs its own support.

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

