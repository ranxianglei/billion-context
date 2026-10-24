# Architecture Reference

> **Not auto-loaded.** On-demand reference material pulled out of `AGENTS.md`
> to keep the auto-loaded spec lean. The operative rules stay in
> [`AGENTS.md`](../AGENTS.md); this file holds the file-by-file module map.
> This map drifts as modules land — regenerate it when you add/remove a source
> file; don't trust a stale copy.

billion-context/
├── src/
│   ├── index.ts                  # Entry point: runs cli.ts main()
│   ├── cli.ts                    # CLI dispatcher: start/update/export/test/plugin + client launcher
│   ├── server.ts                 # HTTP proxy server, request pipeline (hot file — §7.2)
│   ├── server/                   # Server-side support modules
│   │   ├── admin.ts              #   /__bili/* + /__acp/* admin route surface (stats/status/overview/sessions/detail/logs/config/plugin/watcher/upstream endpoints), loopback + trusted-origin gated (#1440)
│   │   ├── budget.ts             #   chars/4 overhead measure outside the kernel fold space
│   │   ├── chain-artifacts.ts    #   Allocation-free byte pre-filter for chain artifacts (#1421)
│   │   ├── codex-catalog-cache.ts #   Same-credential, bounded offline model metadata for Codex discovery
│   │   ├── context-window.ts     #   Context-window resolution (launcher model channel, beta headers)
│   │   ├── dsh-compaction-guard.ts #   Rejects dsh whole-prefix compaction replays (#1729)
│   │   ├── handle.ts             #   Proxy request pipeline (route triage, compat relay, compress orchestration) (#1440 P2 cut 3)
│   │   ├── headers.ts            #   Client-provided id sanitization for dump filenames (#286)
│   │   ├── inject.ts             #   Per-wire tool-injection wrappers + FORCE_TEXT_PROTOCOL switch (#1440)
│   │   ├── observability.ts      #   Body dumps (dumps/req-*.json, raw/*), unrecognized-path stats
│   │   ├── prepare-anthropic.ts  #   Anthropic request preparation (fold → rebuild → system/nudge injection) (#1440)
│   │   ├── prepare-google.ts     #   Gemini request preparation incl. :countTokens twin (#1440)
│   │   ├── prepare-openai.ts     #   OpenAI chat request preparation (#1440)
│   │   ├── prepare-responses.ts  #   Responses request preparation + codex compact/prompt-cache helpers (#1440)
│   │   ├── relay.ts             #   Upstream relay zone: forward() + fake-completion recovery (#1440 P2 cut 4)
│   │   ├── side-request.ts       #   Tool-surface check for auxiliary side requests
│   │   └── stream-io.ts          #   Small response-body reader for non-2xx inspection
│   ├── knobs.ts                  # Single knob resolver: env > config file > default (#2030)
│   ├── config.ts                 # Config file (billion-context.json) + providers table + loadOptions
│   ├── instance.ts               # Live-instance registry record in the proxy-origin file (#394/#403/#417)
│   ├── port-owner.ts             # Post-bind port-ownership verification + pointer-clobber guard (#2941)
│   ├── paths.ts                  # XDG paths (config/cache/state) + relocation env vars
│   ├── logger.ts                 # Tee logger: state-dir file + stderr
│   ├── log-mask.ts               # Log safety: masks credentials/endpoints (#255)
│   ├── version.ts                # Own version identity from package.json at runtime
│   ├── doctor.ts                 # Read-only advisory evaluation against on-disk version (#1577)
│   ├── discover.ts               # MITM domain auto-discovery from client configs
│   ├── thirdparty-scan.ts        # Co-resident third-party compression plugin scan (#920)
│   ├── conflict-watch.ts         # Per-session compression-conflict ledger (#1206)
│   ├── upstream-proxy.ts         # undici ProxyAgent routing (explicit-direct vs no-preference, SOCKS reject)
│   ├── fetch-util.ts             # Capped body reads, timeout/replay helpers (knob-resolved)
│   ├── request-body-budget.ts   # 接收、解压、发送字节预算与大请求名额
│   ├── fetch-transport.ts        # AsyncLocalStorage fetch-transport override (withFetchTransport)
│   ├── content-encoding.ts       # gzip/deflate decode + decompression-bomb guard (413)
│   ├── wire-body.ts              # Trailing-user-turn append on assembled wire bodies
│   ├── wire-drop-warn.ts         # Warn when a wire codec drops non-text parts (#1205)
│   ├── text-safe.ts              # Surrogate-safe string prefix helper
│   ├── sse-util.ts               # SSE parsing / line-ending normalization
│   ├── stream.ts                 # SSE stream utilities + tag patching
│   ├── stream-openai.ts          # OpenAI-format stream processing
│   ├── stream-responses.ts       # Responses-API stream + non-stream JSON rewriting
│   ├── stream-google.ts          # Google native stream processing
│   ├── stream-error.ts           # Minimal SSE error+finish sequence for failed streams
│   ├── stream-terminal.ts        # Terminal-state observer for native-compaction responses (#321)
│   ├── exit-matrix.ts            # Wire-exit × cross-cutting-concern enumeration matrix (#588)
│   ├── degenerate-retry.ts       # Continuation-nudge retry body builder
│   ├── degenerate-turn.ts        # Degenerate turn (empty/truncated) detection
│   ├── strict-echo.ts            # Strict-echo reasoning upstream handling (#684)
│   ├── fake-completion.ts        # Opt-in fake-completion retry hint (#371)
│   ├── reasoning-drop.ts         # Drops oversized reasoning from closed-round compress calls (#651)
│   ├── reasoning-guard.ts        # Live-fold guard for signed reasoning payloads
│   ├── output-steering.ts        # Output-side compression: verbosity steering / effort routing (#1093)
│   ├── image-tokens.ts           # Image token cost estimation (pixels/bytes modes, #767)
│   ├── image-compress.ts         # Image-compression policy stamping per request
│   ├── image-note.ts             # Image-block placeholder → rich note rendering
│   ├── absorb.ts                 # absorb tool (kernel ACP_TOOL_NAMES extension)
│   ├── compress-loop-responses.ts # Compress loop for Responses API format
│   ├── compress-settings.ts      # Three-level compress config merge (global→provider→model)
│   ├── compress-tool.ts          # ACP tool surface — thin re-export from acp-kernel
│   ├── decompress-shared.ts      # Shared decompress logic + large-decompress tmp retention cap
│   ├── fold-reconcile.ts         # Fold-anchor reconciliation for stable prefix cache
│   ├── generation-boundary.ts    # Standing generation-boundary note for post-switch stale-ref residue (#4305)
│   ├── orphan-gc.ts              # Orphan block garbage collection
│   ├── fork-adoption.ts          # Fork block adoption on mid-history divergence (#629)
│   ├── prefix-affinity.ts        # Anonymous prefix-affinity session resolution (#309)
│   ├── affinity-persist.ts       # Prefix-affinity persistence across proxy restarts (#499)
│   ├── cache-warn.ts             # Upstream prompt-cache collapse warning (#499)
│   ├── cache-ledger.ts           # Per-round cache usage ledger (wire-protocol aware, #1536)
│   ├── acp-status.ts             # acp_status payload (ranges/nudge recomputed live)
│   ├── acp-panel.ts              # Cache report wrapper for transcript display
│   ├── acp-cache-diff.ts         # Offline prefix-diff attribution over dumps (#1266)
│   ├── chain-checkpoint.ts       # Chain-checkpoint digest match / stale verdict split (#1421)
│   ├── store.ts                  # Content retrieval store (CCR) + per-request policy stamping
│   ├── rules-feature.ts          # Model-owned session rules opt-in (#1399)
│   ├── system-anchor.ts          # Stable system anchor fingerprint (volatile-head guard)
│   ├── subagent-sessions.ts      # opencode sub-agent dispatch session keying (#1702)
│   ├── tool-pair-order.ts        # Responses tool pair-order repair for strict backends (#766)
│   ├── tool-ring.ts              # Zero-injection session identity witness ring (#1685)
│   ├── tunnel-guard.ts           # Tunnel admission for /bili/<url> zero-config branch (#409)
│   ├── mitm.ts                   # CONNECT MITM proxying (handshake timeout knob-resolved)
│   ├── ca.ts                     # Lazy root CA generation + OS trust-bundle discovery
│   ├── apig-resign.ts            # APIG SDK-HMAC-SHA256 re-signing after body rewrite (#1884)
│   ├── compat-roles.ts           # Wire-compat role rewrite resolution (learn-on-failure)
│   ├── compat-drop.ts            # compat.dropFields validation
│   ├── codex-compact.ts          # Codex compact mode intercept/pass (knob-resolved)
│   ├── codex-models.ts           # Codex bundled model-table snapshot
│   ├── registry.ts               # models.dev context-window registry (live-first, snapshot floor)
│   ├── registry-snapshot.json    # Bundled full models.dev snapshot (offline floor)
│   ├── session.ts                # Session model + in-memory store (bounded, MAX_SESSIONS)
│   ├── session-id.ts             # Session identity: client value verbatim + persona fork fingerprint
│   ├── session-gc.ts             # Session-file GC, opt-in (sessions.gc.* / BILI_SESSION_GC*) (#1082)
│   ├── persist.ts                # On-disk session persistence (kernel StateStore)
│   ├── persist-eperm.ts          # EPERM/EACCES write-failure alert layer (#362)
│   ├── encrypt.ts                # At-rest encoding: AES-256-GCM (#708) + zstd (#1080), independent
│   ├── export.ts                 # Session export (block summaries + originals)
│   ├── preflight.ts              # Preflight compression gate (hold grace, dead-end cooldown)
│   ├── external-summary.ts       # Isolated summary executor (ordered failover, deadlines, capacity)
│   ├── external-summary-http.ts  # Internal single-attempt HTTP candidates using existing summary codecs
│   ├── external-summary-settings.ts # Global external-summary target and budget validation
│   ├── external-summary-config.ts # Strict external-summary config loading
│   ├── external-summary-credentials.ts # Separate atomic credential store
│   ├── external-summary-runtime.ts # Configured candidate plan and shared executor
│   ├── external-summary-compress.ts # External summary fold coordinator and state checks
│   ├── external-summary-surface.ts # Tool/schema and client-facing summary contract
│   ├── update.ts                 # Self-updater (load-bearing — no-op release protocol) + install lanes
│   ├── advisory.ts               # Critical-defect advisory watcher (#1481)
│   ├── plugin-advisory.ts        # dsh cost-advisory detection + TTL cache (#2462)
│   ├── host-plugin-notice.ts     # Known host-side metering plugin notice + dismiss state (#2861)
│   ├── update-notes.ts           # Tiered release-notes visibility (#1870/#1977)
│   ├── restart.ts                # Opt-in self-restart once newer code is on disk (#811)
│   ├── upstream-alerts.ts        # Upstream connection alert table (#1682)
│   ├── upstream-fail.ts          # Upstream transport failure taxonomy (#1263)
│   ├── error-dump.ts             # Rejected-body dump (diagnostics.dump4xx / BILI_DUMP_4XX)
│   ├── ws-bridge.ts              # Generic WebSocket bridge shell
│   ├── responses-ws.ts           # Codex/OpenCode Responses-over-WebSocket codec (#1844)
│   ├── launcher.ts               # `bili <client>` launcher (auto-proxies both schemes)
│   ├── client-config.ts          # Read-only discovery of each client's own upstream config
│   ├── plugin.ts                 # Cooperative plugin protocol (x-bili-plugin lane, legacy marker #920)
│   ├── plugin-install.ts         # `bili plugin install` driving host channels
│   ├── dsh-channel.ts            # dsh profile bundle management (refreshDshProfileCopy, #1196)
│   ├── pi-channel.ts             # pi npm-copy self-refresh spec form
│   ├── claude-native-bootstrap.ts # Claude native bootstrap hook entry
│   ├── mcp.ts                    # Plugin-in-launcher MCP shell (spawn-time env injection)
│   ├── loop/                     # Unified compress loop (wire-independent core)
│   │   ├── index.ts              #   Stream-failure presentation options (#1455)
│   │   ├── core.ts               #   Protocol-neutral event model + tool adjudication
│   │   ├── adapter-anthropic.ts  #   Anthropic wire adapter
│   │   ├── adapter-openai.ts     #   OpenAI chat adapter
│   │   ├── adapter-responses.ts  #   Responses API adapter (+ over-long id healing)
│   │   ├── adapter-google.ts     #   Google wire adapter
│   │   ├── cache-control.ts      #   Explicit Anthropic cache_control breakpoints (#1637)
│   │   └── tag-echo-filter.ts    #   Streaming-safe stripper for model-echoed render tags (#206); tool args byte-exact
│   ├── agent/                    # Thin agent-side plugins (per-host, each with a -native variant)
│   │   ├── shared.ts             #   Host plan/bootstrap shared helpers (BILLION_CONTEXT_PLUGIN gate)
│   │   ├── media-bytes.ts        #   Shared inline-media byte accounting for native direct-send refusal gates
│   │   ├── native-bootstrap.ts   #   dist/agent/<entry>.js → dist/index.js resolution
│   │   ├── native-intercept.ts   #   Model-API fetch routing, attribution and proxy recovery
│   │   ├── fetch-chain/
│   │   │   └── index.ts          #   Fetch guard, re-entry cutoff and pi-web-access coexistence
│   │   ├── native-ws-intercept.ts #  WebSocket-companion intercept: Codex Responses upgrades → /bili/ lane (#2111)
│   │   ├── opencode-acp-command.ts #  /acp + /acp-cache command hooks (V1+V2)
│   │   ├── opencode.ts           #   opencode V1 plugin (attach respawn + test seam)
│   │   ├── opencode-v2.ts        #   opencode V2 plugin (ModelApi probe, #1569)
│   │   ├── opencode-native.ts    #   opencode native bootstrap gate
│   │   ├── opencode-legacy.ts    #   Legacy DCP hooks table
│   │   ├── pi.ts                 #   pi plugin factory (session derivation, #1333/#1362)
│   │   ├── pi-subagents.ts       #   Inlined acp_delegate sub-agent surface (markEmbedded wiring, #2186)
│   │   ├── pi-host-stub.ts     #   esbuild alias stub for @earendil-works/pi-coding-agent (→ ".pi" fallback, #2186)
│   │   ├── pi-native.ts          #   pi native bootstrap gate
│   │   ├── omp.ts                #   omp plugin = createBiliPlugin("omp") re-export of pi factory
│   │   ├── omp-native.ts         #   omp native bootstrap gate
│   │   ├── dsh-native.ts         #   dsh native bootstrap gate (+ persona fingerprint, #1916)
│   │   ├── dsh-acp.ts            #   dsh /acp command panel
│   │   ├── dsh-native-client.ts  #   Poll host live-origin route until armed (#1809)
│   │   └── dsh-native-client-react-shim.d.ts #  Ambient "react" types for the dsh bundle (#1590)
│   ├── kimi/                     # Kimi native lane
│   │   ├── bootstrap-hook.ts     #   SessionStart attach-only bootstrap (#963)
│   │   ├── native-mcp.ts         #   Per-session native MCP entry
│   │   ├── native.ts             #   config.toml origin routing rewrite (idempotent)
│   │   └── toml-edit.ts          #   Managed TOML block add/remove
│   ├── zcode/                    # ZCode native lane
│   │   ├── bootstrap-hook.ts     #   SessionStart attach-only bootstrap (#1145)
│   │   ├── json-edit.ts          #   Provider config JSON managed edit
│   │   ├── mcp-entry.ts          #   Idle/degraded entry candidate proxies (#1892)
│   │   └── native.ts             #   Routing scope/exemptions policy (#1622)
│   └── web/                      # Web UI (config editor, sessions, logs)
│       ├── api.ts                #   REST handlers (config get/put with parse-state guard)
│       ├── blogfeed.ts           #   Panel blog/articles feed from bundled markdown (#4587)
│       ├── changelog.ts          #   GitHub Releases feed for the panel changelog (#3719)
│       ├── sessions-data.ts      #   Read-only session browsing (live pool + on-disk, #1420); tier tree + lazy block content (#3917)
│       ├── logs-query.ts         #   GET /__bili/logs selection engine
│       ├── markdown.ts           #   Escape-safe Markdown → HTML (#1420)
│       ├── page.ts               #   Server-rendered HTML page shell (CA cert hint, i18n)
│       ├── client.ts             #   Web UI client JS bundle
│       ├── styles.ts             #   Web UI CSS
│       ├── i18n.ts               #   Locale message tables (zh-CN/en)
│       └── index.ts              #   Web UI mount (bundle-safe VERSION reuse, #1426)
 ├── kernel/                       # In-repo acp-kernel source (#2092): the compression engine
 │   ├── src/                      #   ~30 modules: processTurn pipeline, wire codecs, persist, panel, filter
 │   ├── tests/                    #   Kernel unit suite (`npm --prefix kernel test`, runs on TS source)
 │   └── package.json              #   Own name/version (npm `acp-kernel`), own build chain (tsup → dist + d.ts)
 ├── pi-subagents/                 # In-repo billion-context-pi-subagents source (#2384): acp_delegate tools for the pi lane
 │   ├── src/                      #   14 modules: delegate tool/lifecycle, fleet inspector/widget, config, events
 │   ├── tests/                    #   Component unit suite (`npm --prefix pi-subagents test`, runs on TS source)
 │   └── package.json              #   Own name/version (npm `billion-context-pi-subagents`), own build chain (tsup → dist + d.ts)
 ├── tests/                        # 614 test files (+ hermetic e2e lanes under tests/e2e/)
 ├── tsup.config.ts                # Build config (inlines acp-kernel + billion-context-pi-subagents; zod external)
 └── package.json                  # npm manifest (consumes kernel via `"acp-kernel": "file:./kernel"`, pi-subagents via `"billion-context-pi-subagents": "file:./pi-subagents"`; version bumped ONLY on release branches)

## Orientation cheat-sheet

When navigating this codebase, these are the load-bearing entry points:

- **Request pipeline** — `src/server.ts` is the single HTTP entry; everything flows through `createServer()` → route matching → `forward()`. The file is large by design (one pipeline, many wire shapes).
- **Loop core** — `src/loop/core.ts` owns the protocol-neutral event model and all tool-call adjudication. Wire adapters (`adapter-*.ts`) translate between wire events and the core's event vocabulary.
- **Knobs** — every behavior knob resolves through `src/knobs.ts` (env > config file > default, #2030). Never add a new `process.env` read in a leaf module — see AGENTS.md "Environment Variable Discipline".
- **Update path** — `src/update.ts` is deliberately self-contained and conservative; it installs via tarball extraction (not `npm install`) to avoid lifecycle-script surprises on user machines. It is load-bearing infrastructure: changes require a no-op validation release first (§5).
- **Agent plugins** — `src/agent/*.ts` are thin host-specific adapters; shared logic lives in `src/agent/shared.ts`. Each host has a `-native.ts` bootstrap gate variant.
- **Persistence** — `src/persist.ts` wraps the acp-kernel `StateStore`; `src/session.ts` holds the in-memory session pool. Session identity rules: `src/session-id.ts`.
- **会话派生缓存** — `Session.transient` 持有插件工具视图与诊断请求副本；随会话淘汰释放，也纳入会话对象图的字节计量。它不写入持久化记录或上游协议；诊断截段独立复制 UTF-16 内容，避免保留完整请求底层字符串（#2920）。
- **Wire fidelity** — `src/stream-*.ts` files handle per-protocol streaming transformation. The invariant: never alter upstream protocol shape beyond intended injection (§7.3).
- **E2E regression** — `tests/e2e/` contains real-client suites (codex, opencode, pi, dsh) plus hermetic lanes (registry, advisory-rollback, release-canary, opencode WS, image billing); each carries its own skip gate — read the test header for the exact env var.
- **Compression kernel** — `kernel/` (in-repo acp-kernel, #2092). Human-gated boundary; see `AGENTS.md` "Kernel Boundary".
- **Pi sub-agent surface** — `pi-subagents/` (in-repo billion-context-pi-subagents, #2384); wired into the pi lane by `src/agent/pi-subagents.ts`. Lighter-gated boundary than the kernel; see `AGENTS.md` "Pi-Subagents Boundary".
