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
│   │   ├── handoff-response.ts   #   Retains parsed assistant output for handoff export without changing request snapshots
│   │   ├── headers.ts            #   Client-provided id sanitization for dump filenames (#286)
│   │   ├── inject.ts             #   Per-wire tool-injection wrappers + FORCE_TEXT_PROTOCOL switch (#1440)
│   │   ├── observability.ts      #   Body dumps (dumps/req-*.json, raw/*), unrecognized-path stats
│   │   ├── prepare-anthropic.ts  #   Anthropic request preparation (fold → rebuild → system/nudge injection) (#1440)
│   │   ├── prepare-google.ts     #   Gemini request preparation incl. :countTokens twin (#1440)
│   │   ├── prepare-openai.ts     #   OpenAI chat request preparation (#1440)
│   │   ├── prepare-responses.ts  #   Responses request preparation + codex compact/prompt-cache helpers (#1440)
│   │   ├── relay.ts             #   Upstream relay zone: forward() + fake-completion recovery (#1440 P2 cut 4)
│   │   ├── rejection-diagnostics.ts #   Bounded terminal-cause diagnostic for a relayed upstream rejection: one nested attempts[].details.error.message, scrubbed + bounded, appended to the relay log line (#4452)
│   │   ├── request-cost.ts       #   Per-request local-cost line (outbound measured at the real wire body) + #5408 heartbeat + wall-clock slow-session advisory, facts only (#903/#4528/#5744)
│   │   ├── responses-ordering.ts #   #564 Responses assistant-run ordering repair + producer-owned turn-separator provenance (#2627)
│   │   ├── responses-separator.ts #   Canonical Responses turn-separator literal and carrier predicates (#2627)
│   │   ├── side-request.ts       #   Tool-surface check for auxiliary side requests
│   │   ├── attribution-status.ts #   Takeover-failure visibility from host attribution reports (#3581)
│   │   ├── dsh-authored-compaction.ts #   Bili-authored dsh compaction: answers the summarize call locally (#3733)
│   │   ├── fastpath.ts           #   Watermark fastpath: full-resend turns decode head + tail only (#5403)
│   │   ├── fastpath-scan.ts      #   Zero-decode structural span scan of chat-completions bodies (#5403)
│   │   ├── lane-decisions.ts     #   Single resolver for per-lane gating decisions (#3417)
│   │   ├── pi-subagent-channel.ts #   Channel fallback for pi-subagent children missing ACP tools (#2268)
│   │   ├── snapshot-render.ts    #   Snapshot render: outbound prefix from server transcript (#3756)
│   │   ├── thread-tracking.ts    #   Anthropic Threads previous_message_id repair (#2701)
│   │   ├── threads-lane.ts       #   Anthropic Threads lane: mirror, budget, reforge (#2926)
│   │   ├── thinking-posture.ts   #   Signature-less thinking posture: 400-wording detector + wire strip + session memory (#5998)
│   │   ├── update-actions.ts     #   Web Updates tab actions over the self-updater (#3719)
│   │   └── stream-io.ts          #   Small response-body reader for non-2xx inspection
│   ├── knobs.ts                  # Single knob resolver: env > config file > default (#2030)
│   ├── config.ts                 # Config file (billion-context.json) + providers table + loadOptions
│   ├── model-endpoints.ts         # Declarable custom-wire model endpoints: pattern parse + longest-prefix match, one source feeds proxy classifier + client claim (#1295)
│   ├── instance.ts               # Live-instance registry record in the proxy-origin file (#394/#403/#417)
│   ├── port-owner.ts             # Post-bind port-ownership verification + pointer-clobber guard (#2941) + EADDRINUSE holder diagnostics (#4762)
│   ├── event-loop-watchdog.ts    # Worker-thread event-loop wedge detector: self-exit after 5 min of continuous main-loop silence (#4762)
│   ├── paths.ts                  # XDG paths (config/cache/state) + relocation env vars
│   ├── logger.ts                 # Tee logger: state-dir file + stderr
│   ├── log-retention.ts          # Private-log generations: 48h target under a hard byte budget, 0600, honest coverage
│   ├── log-retention-coverage.ts # Retention coverage reader: measured span from the oldest retained line, continuity always unknown
│   ├── log-file-lines.ts         # Streaming line reader over the retained generations (bounded memory, per-file error reporting)
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
│   ├── egress-transforms.ts      # User-registerable egress request-body rewrite pipeline (#6003)
│   ├── wire-drop-warn.ts         # Warn when a wire codec drops non-text parts (#1205)
│   ├── commandcode-wire.ts       # commandcode CLI envelope codec: nested openai-completions request unwrap + bare JSONL response handling (#1295)
│   ├── text-safe.ts              # Surrogate-safe string prefix helper
│   ├── sse-util.ts               # SSE parsing / line-ending normalization
│   ├── stream.ts                 # SSE stream utilities + tag patching
│   ├── stream-openai.ts          # OpenAI-format stream processing
│   ├── stream-responses.ts       # Responses-API stream + non-stream JSON rewriting
│   ├── stream-google.ts          # Google native stream processing
│   ├── stream-error.ts           # Minimal SSE error+finish sequence for failed streams
│   ├── stream-terminal.ts        # Terminal-state observer for native-compaction responses (#321)
│   ├── exit-matrix.ts            # Wire-exit × cross-cutting-concern enumeration matrix (#588)
│   ├── exit-deadline.ts          # 5s cap on the exit flush path (EXIT_FLUSH_DEADLINE_MS, #5753)
│   ├── degenerate-retry.ts       # Continuation-nudge retry body builder
│   ├── degenerate-turn.ts        # Degenerate turn (empty/truncated) detection
│   ├── strict-echo.ts            # Strict-echo reasoning upstream handling (#684)
│   ├── fake-completion.ts        # Opt-in fake-completion retry hint (#371)
│   ├── reasoning-drop.ts         # Drops oversized reasoning from closed-round compress calls (#651)
│   ├── reasoning-guard.ts        # Live-fold guard for signed reasoning payloads
│   ├── output-steering.ts        # Output-side compression: verbosity steering / effort routing (#1093)
│   ├── image-tokens.ts           # Image token cost estimation (pixels/bytes modes, #767)
│   ├── image-note.ts             # Image-block placeholder → rich note rendering
│   ├── image-rescale.ts          # Deterministic egress image rescale (outbound copy only, restore receipt) (#3400)
│   ├── image-restore.ts          # Recovery channel for folded images by mNNNNN ref, file-first (#1995)
│   ├── absorb.ts                 # absorb tool (kernel ACP_TOOL_NAMES extension)
│   ├── compress-loop-anthropic.ts # Non-stream Anthropic proxy-tool loop (#5957)
│   ├── compress-loop-responses.ts # Compress loop for Responses API format
│   ├── compress-settings.ts      # Three-level compress config merge (global→provider→model)
│   ├── chat-pack.ts              # Bundled chat prompt pack: relationship-first compress philosophy (#5319)
│   ├── compress-tool.ts          # ACP tool surface — thin re-export from acp-kernel
│   ├── decompress-shared.ts      # Shared decompress logic + large-decompress tmp retention cap
│   ├── fold-reconcile.ts         # Fold-anchor reconciliation for stable prefix cache
│   ├── generation-boundary.ts    # Standing generation-boundary note for post-switch stale-ref residue (#4305)
│   ├── orphan-gc.ts              # Orphan block garbage collection
│   ├── foreign-block-sweep.ts    # Legacy cross-session fold-block sweep: covered-ids with zero transcript intersection → reversible archive (#5312)
│   ├── fork-adoption.ts          # Fork block adoption on mid-history divergence (#629)
│   ├── prefix-affinity.ts        # Anonymous prefix-affinity session resolution (#309)
│   ├── affinity-persist.ts       # Prefix-affinity persistence across proxy restarts (#499)
│   ├── affinity-neutral.ts       # Wire-neutral affinity turn projection across protocol switches (#2791)
│   ├── affinity-simhash.ts       # 64-bit simhash + Hamming chain alignment for rewritten histories (#2265)
│   ├── cache-warn.ts             # Upstream prompt-cache collapse warning (#499)
│   ├── cache-ledger.ts           # Per-round cache usage ledger (wire-protocol aware, #1536)
│   ├── billing.ts                # Per-model USD prices (#4899): billing.prices overrides > models.dev; stamps per request, bills session.stats.costUsd; panel $ faces derive live from the current price table incl. a compression payback view
│   ├── acp-status.ts             # acp_status payload (ranges/nudge recomputed live)
│   ├── acp-panel.ts              # Cache report wrapper for transcript display
│   ├── acp-cache-diff.ts         # Offline prefix-diff attribution over dumps (#1266)
│   ├── acp-block-ops.ts          # Block retirement + external rewrite host executors (acp_retire/acp_restore/acp_rewrite): arg parse, receipts, dirty mark (#5765)
│   ├── marker/                   # Inbound marker stripping: one spec table + engine, four wires (#2811)
│   │   ├── anchors.ts            #   Shared marker anchors: integrity note, silence clause, echo match
│   │   ├── engine.ts             #   Raw-stage inbound marker strip: one ordered pipeline (#2811)
│   │   ├── spec.ts               #   Declarative table of marker classes stripped per stage/scope
│   │   ├── status-body.ts        #   Inbound acp_status report-body stripping (#2789)
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
│   ├── codex-models-snapshot.json # Bundled codex model table data (openai/codex main snapshot)
│   ├── registry.ts               # models.dev context-window registry (live-first, snapshot floor)
│   ├── registry-snapshot.json    # Bundled full models.dev snapshot (offline floor)
│   ├── session.ts                # Session model + in-memory store (bounded, MAX_SESSIONS)
│   ├── session-id.ts             # Session identity: client value verbatim + persona fork fingerprint
│   ├── claude-lane-token.ts      # SubagentStart lane-token grammar (mint/extract, #5095)
│   ├── session-resolve.ts        # #2944 order-primary persona resolver (skeleton + fork lanes)
│   ├── session-gc.ts             # Session-file GC, opt-in (sessions.gc.* / BILI_SESSION_GC*) (#1082)
│   ├── persist.ts                # On-disk session persistence (kernel StateStore)
│   ├── persist-eperm.ts          # EPERM/EACCES write-failure alert layer (#362)
│   ├── storage/                  # Unified storage layer (schema, SQLite engine ladder, backends) (#2671)
│   │   ├── backend.ts            #   Storage backend contract: sqlite + mysql operation seam (#3931)
│   │   ├── canonical.ts          #   Shared canonicalization for storage digests (#2671)
│   │   ├── driver.ts             #   SQLite driver ladder: bun/node builtin, host, self-downloaded (#2833)
│   │   ├── engine-bootstrap.ts   #   Self-downloads pinned better-sqlite3 prebuilt when no engine exists
│   │   ├── identity.ts           #   messages-table identity hash: strips position metadata (#4390)
│   │   ├── ingest.ts             #   Legacy → unified row mapping + legacy view rebuild (#2671)
│   │   ├── integrity-check.ts    #   Cached + background quick_check off the boot critical path (#4609)
│   │   ├── mysql.ts              #   MySQL 8.0 backend implementing the storage contract (#3388)
│   │   ├── runtime-status.ts     #   Runtime storage degradation status for status surfaces (#3040)
│   │   ├── schema.ts             #   Unified storage schema DDL + migrations (v11)
│   │   ├── shadow.ts             #   Unified-storage sidecar: shadow double-write / full read flip
│   │   ├── sqlite-errors.ts      #   Corruption-shaped SQLite error classification (#5108)
│   │   ├── store.ts              #   UnifiedStore: index.db (WAL) + content blobs, one txn per mutation
│   ├── encrypt.ts                # At-rest encoding: AES-256-GCM (#708) + zstd (#1080), independent
│   ├── export.ts                 # Session export (block summaries + originals)
│   ├── preflight.ts              # Preflight compression gate (hold grace, dead-end cooldown)
│   ├── external-summary.ts       # Isolated summary executor (ordered failover, deadlines, capacity)
│   ├── external-summary-http.ts  # Internal single-attempt HTTP candidates using existing summary codecs
│   ├── external-summary-settings.ts # Global external-summary target and budget validation
│   ├── external-summary-credentials.ts # Separate atomic credential store
│   ├── external-summary-runtime.ts # Configured candidate plan and shared executor
│   ├── external-summary-compress.ts # External summary fold coordinator and state checks
│   ├── external-summary-surface.ts # Tool/schema and client-facing summary contract
│   ├── external-summary-marker.ts # Zero-import marker contract for externally summarized blocks
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
│   ├── kiro.ts                   # Kiro CLI: model-gateway hosts, built-in developer/system→user roles, kiro:conversation_id identity
│   ├── launcher.ts               # `bili <client>` launcher (auto-proxies both schemes)
│   ├── client-config.ts          # Read-only discovery of each client's own upstream config
│   ├── toml-integer.ts           # Shared strict TOML integer reader for model token limits
│   ├── plugin.ts                 # Cooperative plugin protocol (x-bili-plugin lane, legacy marker #920)
│   ├── plugin-install.ts         # `bili plugin install` driving host channels
│   ├── dsh-channel.ts            # dsh profile bundle management (refreshDshProfileCopy, #1196)
│   ├── pi-channel.ts             # pi npm-copy self-refresh spec form
│   ├── claude-native-bootstrap.ts # Claude native bootstrap hook entry
│   ├── claude-subagent-hook.ts  # Claude SubagentStart hook: mint per-dispatch lane token (#5095)
│   ├── mcp.ts                    # Plugin-in-launcher MCP shell (spawn-time env injection)
│   ├── loop/                     # Unified compress loop (wire-independent core)
│   │   ├── index.ts              #   Stream-failure presentation options (#1455)
│   │   ├── core.ts               #   Protocol-neutral event model + tool adjudication
│   │   ├── adapter-anthropic.ts  #   Anthropic wire adapter
│   │   ├── adapter-commandcode.ts #   commandcode wire adapter: envelope unwrap/re-wrap over the OpenAI-family loop (#1295)
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
│   │   ├── client-build-note.ts  #   Soft note when the in-process client build is newer than tested (#4545)
│   │   ├── conversation-recall.ts #   Fallback identity when host attribution context is missing (#4082)
│   │   ├── dsh-compaction-disable.ts #   Load-time overlay standing dsh basic compaction down (#3354)
│   │   ├── dsh-compaction-gate.ts #   Always-on compaction gate entry, independent of bili-native (#3662)
│   │   ├── fork-adopt.ts         #   Client half of fork adoption: prefix match + receipt (#2399)
│   │   ├── host-log.ts           #   Host-safe log channel: durable record, zero terminal traffic (#2827)
│   │   ├── incremental-client.ts #   Host-process incremental-turn client: diff, ack, resync (#3248)
│   │   ├── opencode-msgids.ts    #   Opencode msgid harvest + wire alignment (#4491)
│   │   ├── opencode-v2-msgids.ts #   Opencode V2 per-turn msgid extraction + header stamp (#5825)
│   │   ├── pf-channel.ts         #   Watermark channel client state machine: learn, capture, emit (#5403)
│   │   ├── pi-inline.ts          #   Pi inline lane: serves INLINE_ORIGIN traffic in-process (#3278)
│   │   ├── pi-msgids.ts          #   Pi wire-branch lockstep walker resolving host msgids (#4491)
│   │   ├── pi-subagent-registry.ts #   Self-registration into pi-subagents required-child extensions (#2185)
│   │   ├── tool-guardrails.ts    #   Tool-output guardrails migrated from billion-context-pi (#3066)
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
│   ├── agent-providers.ts        # In-memory agent-registry provider recipes; file recipes win (#2336)
│   ├── announcements.ts          # Notice surface registry: record schema + gates shared by builtin/remote/local (#5548)
│   ├── anon-provenance.ts        # First-writer producer provenance for anonymous pfa-* sessions (#2879)
│   ├── attach-heartbeat.ts       # Silence alarm for a hot-at-attach session with zero observed requests (#5408)
│   ├── auto-mode-forge.ts        # Local forged verdicts for the Claude Code auto-mode safety classifier (#2740)
│   ├── cache-keepalive.ts        # Idle prompt-cache TTL keepalive pings replaying the last egress body (#3376)
│   ├── claude-mcp-entry.ts       # Per-session Claude native MCP server + mid-session proxy watchdog (#1821)
│   ├── claude-transcript-lineage.ts # Resume lineage from Claude Code transcript forkedFrom markers (#1486)
│   ├── client-ua-registry.ts     # Bounded in-memory registry of recently observed client user-agents (#4649)
│   ├── context-analysis.ts       # Per-session context analysis: init size, nudge cadence, harvest rate, verdict (#5963)
│   ├── context-view.ts           # Machine-readable context view for programmatic consumers (#3862)
│   ├── dead-ranges.ts            # Session memory of structurally empty fold ranges (#2638)
│   ├── dedupe-adjacent-output-config.ts # Collapses adjacent empty system output_config directives at egress (#5688)
│   ├── dsh-ledger.ts             # dsh profile three ledgers (manifest/lockfile/copy) read + converged (#3496)
│   ├── dump-banner.ts            # PLAINTEXT warning header for (and stripped from) body dumps (#4482)
│   ├── durable-message-guards.ts # Projects host durable-state message carriers to virtual tool paths (#2446)
│   ├── duration.ts               # Duration string parsing (1d12h) for update-policy keys (#3619)
│   ├── egress-shed.ts            # Byte-space egress shed: archive/downscale outbound images past lane budget (#3701)
│   ├── fold-decomposition-lookup.ts # Stored message decompositions for fold-anchor backfill (#3301)
│   ├── host-profiles.ts          # Per-agent declared-defaults registry, import-free leaf (#3417)
│   ├── identity-claude.ts        # Identity harvest source: claude-code transcript JSONL uuids (#5825)
│   ├── identity-codebuddy.ts     # Identity harvest source: codebuddy local transcript jsonl (#5825)
│   ├── identity-goose.ts         # Identity harvest source: goose sessions.db message rows (#5825)
│   ├── identity-harvest.ts       # Registry harvesting per-message ids from client local stores (#5825)
│   ├── identity-mcode.ts         # Identity harvest source: mcode (MiniMax Code) runtime sqlite (#5825)
│   ├── identity-qwen.ts          # Identity harvest source: qwen-code transcript, opt-in join key (#5825)
│   ├── identity-sources.ts       # Identity source registry barrel: one import registers every lane (#5825)
│   ├── incremental-lane.ts       # Incremental-turn server lane: delta acks via x-bili-applied-seq (#3248)
│   ├── inline-engine.ts          # In-process compression engine behind the pseudo-origin (#3278)
│   ├── inline-ws.ts              # Loopback-only WS bridge for the inline engine (#3278)
│   ├── integrity-label.ts        # NTFS mandatory integrity label check for EPERM startup failures (#5154)
│   ├── invariant-judge.ts        # Outbound-invariant judge: did bili rewrite client history this request (#3842)
│   ├── lane-credentials.ts       # Per-lane upstream credential override (apiKeyEnv/credentialRef) (#2336)
│   ├── listen-policy.ts          # EADDRINUSE decision table: same-port wait, twin exit, newer adoption (#3044)
│   ├── liveness.ts               # Three-state alive/busy/dead liveness probing (#3654)
│   ├── mitm-domains.ts           # Default MITM domain list + subdomain matcher (cycle-free leaf)
│   ├── msgid-algebra.ts          # Id-set algebra over client-pinned ids: vanish reason + epoch flip (#4491)
│   ├── msgid-pin.ts              # Validates + consumes client biliMsgIds/biliLedgerSeqs parallel arrays (#4491)
│   ├── notice-store.ts           # Notice dismissal receipts in unified kv_store, legacy file fallback (#5548)
│   ├── notices.ts                # Built-in notice registry: activity predicates + i18n key table (#5548)
│   ├── nudge-decide.ts           # Model-decided nudge timing over the already-cached prefix (#2228)
│   ├── order-persist.ts          # Persists session-order skeletons across restarts (#3397)
│   ├── pack-install.ts           # bili pack install|remove|list: npm-distributable prompt packs (#5319)
│   ├── pck-notice.ts             # One-time notice for the prompt_cache.routing default flip (#5079)
│   ├── pck-probe.ts              # Probe-and-remember ablation of prompt_cache_key-rejecting origins (#2645)
│   ├── persona-anchor.ts         # Continuity-aware persona fork trigger: system drift + chain break (#2241)
│   ├── phantom-attachment.ts     # Detects fabricated attachment identifiers in model output (#3456)
│   ├── plugin-compress-salvage.ts # Rescues strict-JSON-failing compress args on the verbatim lane (#2580)
│   ├── plugin-render.ts          # POST /__bili/plugin/render: outbound prefix from server transcript (#4491)
│   ├── private-host.ts           # Private-upstream host detection shared by launcher + trust gates (#2984)
│   ├── proxy-tool-result.ts      # Machine-readable business outcome for proxy tools (#1875)
│   ├── remote-notices.ts         # Remote announcement feed watcher: fail-open polling, last-known-good snapshot (#5548)
│   ├── request-membership.ts     # Settle-side membership probe: is this usage report ours (#4805)
│   ├── resolver-wedge.ts         # Persistent local DNS resolver wedge detector + alarm (#5221)
│   ├── responses-tool-output.ts  # Responses tool-output image parts: projection + patch helpers
│   ├── rollout.ts                # Feature rollout: per-install uuid, basis-point buckets, nested cohorts (#3062)
│   ├── runaway-guard.ts          # Intrinsic stream terminator for runaway tag/codepoint enumeration (#2346)
│   ├── served-markers.ts         # Per-session writer markers: split-brain visibility (#3923)
│   ├── session-self-heal.ts      # Degrades zombie plugin sessions back to proxy mode (#2155)
│   ├── startup-failure-page.ts   # Port-holding failure page when a launcher-spawned proxy dies (#5096)
│   ├── state-gc.ts               # Opt-in retention GC for dump directories (size/age bounds) (#2412)
│   ├── state-hydration.ts        # Single mergeState truth; persisted field list derived mechanically (#4242)
│   ├── storage-maintenance.ts    # bili sessions / bili storage gc CLI over store maintenance APIs (#3911)
│   ├── turn-separator.ts         # Responses turn-separator id helpers, zero-dependency leaf (#2627)
│   ├── uncovered.ts              # Uncovered-history audit: runs no active block can reach (#4331)
│   ├── unprompted-gate.ts        # Gates refusing unprompted model-initiated compress (#5683)
│   ├── update-policy.ts          # Staggered upgrade draw + remote update-policy file (#3619)
│   ├── upstream-ca.ts            # Merges network.caFile into bili's own outbound TLS trust (#3776)
│   ├── upstream-throttle.ts      # Egress-side 429 governor: local hold, backoff, terminal 424 (#4204)
│   ├── util.ts                   # Shared leaf: wire-protocol type, hash/loopback/origin helpers, usage math
│   ├── v1internal.ts             # CloudCode/Antigravity v1internal envelope adapter (#3129)
│   ├── vertex.ts                 # Vertex routing: endpoint host derivation + CLAUDE_CODE_USE_VERTEX detection
│   ├── win-cmd.ts                # cmd.exe argv safety contract for the comspec wrap path (#2196)
│   ├── yield-loop.ts             # Cooperative setImmediate yield for long synchronous turns (#4528)
│   └── web/                      # Web UI (config editor, sessions, logs)
│       ├── api.ts                #   REST handlers (config get/put with parse-state guard)
│       ├── blogfeed.ts           #   Panel blog/articles feed from bundled markdown (#4587)
│       ├── changelog.ts          #   GitHub Releases feed for the panel changelog (#3719)
│       ├── sessions-data.ts      #   Read-only session browsing (live pool + on-disk, #1420); tier tree + lazy block content (#3917)
│       ├── logs-query.ts         #   GET /__bili/logs selection engine
│       ├── markdown.ts           #   Escape-safe Markdown → HTML (#1420) — thin wrapper over mdrender.ts
│       ├── mdrender.ts           #   Shared escape-first Markdown + hand-rolled syntax-highlight core (server render + browser IIFE via .toString() inline, zero deps)
│       ├── page.ts               #   Server-rendered HTML page shell (CA cert hint, i18n)
│       ├── client.ts             #   Web UI client JS bundle
│       ├── styles.ts             #   Web UI CSS
│       ├── i18n.ts               #   Locale message tables (zh-CN/en)
│       ├── blog-refresh.ts       #   GitHub-master blog overlay refresh, fail-soft (#4906)
│       ├── diagnostics.ts        #   Ready-to-paste diagnostics blob + GitHub issue link (#3040)
│       ├── favicon.ts            #   Generated favicon bytes (scripts/gen-favicon.mjs) (#4830)
│       ├── report.ts             #   Dependency-free session-report builders: Markdown + SVG
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
