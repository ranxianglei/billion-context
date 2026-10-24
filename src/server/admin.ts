import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { CompressionCore, Config } from "acp-kernel";
import { APIG_RESIGN_SCHEME, KNOWN_SIGNATURE_SCHEMES, readPendingRefusals, unresolvedRefusals } from "../apig-resign.js";
import { handleAcpCache, readKeySwitchStats, readModelSwitchStats, readProjSwitchStats, readPromptSwitchStats } from "../cache-ledger.js";
import type { ProxyOptions } from "../config.js";
import { loadNamedProviders, loadOptions, loadRoutes, resolveResignSettings } from "../config.js";
import { applyCompressSettings, resolveCompressSurfaceDetailed } from "../compress-settings.js";
import { clearConflictEvents, summarizeConflicts } from "../conflict-watch.js";
import { cannotResolveTarget, getAdvisoryState } from "../advisory.js";
import { detectCostAdvisories } from "../plugin-advisory.js";
import { fetchWithTimeout } from "../fetch-util.js";
import { log as loggerLog, getLogPath } from "../logger.js";
import { getBlindTunnelStats } from "../mitm.js";
import { handlePluginAttribution, handlePluginCompact, handlePluginFork, handlePluginManifest, handlePluginRegister, handlePluginRuntimeInfo, handlePluginSessionName, handlePluginSnapshot, handlePluginStatus, handlePluginTool } from "../plugin.js";
import { parseAgentProviderReport, recordAgentProviders, agentProviderRecipes, sanitizeAgentProviderField } from "../agent-providers.js";
import { defaultLogFile } from "../paths.js";
import { getUpdateVisibility, updateBannerPayload } from "../update-notes.js";
import { installVersionAction, triggerManualCheck, updateActionsAvailable, updateStateSnapshot } from "./update-actions.js";
import { getUnrecognizedPathStats } from "./observability.js";
import { getStore } from "../persist.js";
import { BodyTooLargeError, headerValue, readBody } from "../server.js";
import { dismissHostPlugin, visibleHostPluginNotices } from "../host-plugin-notice.js";
import { listSessions, memoryReport, peekSession, splitSessionWarnings, totalInFlight } from "../session.js";
import { BILI_TUNNEL_HEADER } from "../tunnel-guard.js";
import { isLoopbackAddress } from "../util.js";
import { clearUpstreamAlertsForHost, getUpstreamAlerts } from "../upstream-alerts.js";
import { pckAblations } from "../pck-probe.js";
import { formatUpstreamError, getUpstreamConnectionStatus, proxyDispatcher, recordUpstreamConnection, resetProxyCache, resolveProxyDecision } from "../upstream-proxy.js";
import { detectStaleInstall, getLastInstall } from "../update.js";
import { getPlannedUpgrade, getUpdatePolicyState } from "../update-policy.js";
import { PACKAGE_NAME, VERSION, BUILD_COMMIT } from "../version.js";
import { buildBlockContent, buildMessageContent, buildOverview, buildSessionDetail, buildSessionList, buildSessionPage, buildSessionTree, handleConfigGet, handleConfigPut, hiddenEmptyCount, renderUI, type BlockContentView } from "../web/index.js";
import { handleChangelogGet } from "../web/changelog.js";
import { buildSessionReportMd, buildSessionReportSvg } from "../web/report.js";
import { queryLogLines } from "../web/logs-query.js";
import { buildDiagnostics } from "../web/diagnostics.js";
import { ackSplitBrainContest, storageStatusWire } from "../storage/runtime-status.js";
import { snapshotShadowStatusWire } from "../server/snapshot-render.js";
import { attributionStatusWire } from "./attribution-status.js";

interface AdminCtx {
    opts: ProxyOptions;
    core: CompressionCore;
    config: Config;
    log: (level: string, msg: string) => void;
    instanceId: string;
    instanceStartedAt: number;
    proxyWatchers: Set<number>;
    initialWatcherPid: number | null;
    /** #3544: last-heartbeat timestamps for hb-opted watchers (optional —
     *  absent on contexts built before #3544). */
    watcherLastSeen?: Map<number, number>;
    /** #3544: triggers the server's graceful shutdown (stale-proxy rotation);
     *  optional — absent on contexts built before #3544. */
    requestShutdown?: (reason: string) => void;
    /** #2941: false until startup registration (pointer + registry entry) has
     *  completed — the bind precedes it, so health must not claim readiness
     *  before discovery can find this instance. */
    bootReady: () => boolean;
}

// #1537: reduce a Host-header value or a URL hostname to its bare lowercase
// name — strip a trailing :port and the [..] brackets around an IPv6 literal.
// Returns undefined for empty/unparseable input. The admin-origin gate uses it
// to match on the hostname alone (see isTrustedAdminOrigin).
function normalizeAdminHostname(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const v = value.trim().toLowerCase();
    if (!v) return undefined;
    if (v.startsWith("[")) {
        const end = v.indexOf("]");
        if (end === -1) return undefined;
        return v.slice(1, end);
    }
    // Bare IPv6 literal (no brackets): more than one colon means there is no
    // host:port split to perform — return it untouched.
    if ((v.match(/:/g) ?? []).length > 1) return v;
    const idx = v.lastIndexOf(":");
    if (idx !== -1) return v.slice(0, idx);
    return v;
}

function isTrustedAdminOrigin(origin: string | undefined, host: string | undefined, trustedHostnames: Set<string>): boolean {
    // Host must name one of OUR loopback identities regardless of whether an
    // Origin header is present. A same-origin browser GET/fetch (the DNS
    // rebinding read path: evil.com → 127.0.0.1) often carries NO Origin
    // header, so gating on Origin alone would leave config reads exposed.
    // #1537: match on the bare hostname and IGNORE the port — an SSH forward
    // (ssh -L 18787:127.0.0.1:8787) legitimately presents a different local
    // port while still arriving from loopback. The anti-rebinding property is
    // preserved because an attacker's rebound domain (evil.com) can never equal
    // a loopback NAME; only the port is relaxed.
    const hn = normalizeAdminHostname(host);
    if (!hn || !trustedHostnames.has(hn)) return false;
    if (!origin) return true; // non-browser client (curl, CLI UI) on a trusted Host
    try {
        const parsed = new URL(origin);
        // #3513 (desktop variant): the dsh desktop Electron app renders its
        // settings pane from the custom scheme origin dsh-app://app, not an
        // http origin. Browsers set the Origin header themselves — page
        // content cannot forge it — and the dsh-app scheme exists only inside
        // the dsh Electron app (a registered custom protocol), so a website
        // can never produce a request whose Origin is dsh-app://. Accepting
        // that exact origin (scheme dsh-app, hostname "app") admits the
        // desktop embed probe without weakening the anti-rebinding property:
        // rebinding attacks arrive with http/https attacker hostnames and
        // still fail the hostname check below. Any other custom scheme or a
        // different dsh-app hostname stays rejected.
        if (parsed.protocol === "dsh-app:") {
            return normalizeAdminHostname(parsed.hostname) === "app";
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
        const ohn = normalizeAdminHostname(parsed.hostname);
        return ohn !== undefined && trustedHostnames.has(ohn);
    } catch {
        return false;
    }
}

/** The set of hostnames we accept on management endpoints. DNS rebinding
 *  (attacker resolves evil.com → 127.0.0.1) can make a browser request carry
 *  Origin == Host == evil.com:port and still reach loopback; only pinning the
 *  Host to a loopback NAME defeats it. #1537: the port is deliberately NOT part
 *  of the identity — SSH port-forwarding (ssh -L <local>:127.0.0.1:<remote>)
 *  changes the local port while the connection still arrives from loopback, so
 *  matching the port would reject every forwarded session. Every previously
 *  accepted Host carried a loopback hostname, so dropping the port admits no
 *  non-loopback identity. */
/** #3248: the /__bili/ gate for surfaces handled OUTSIDE handleAdminRoute
 *  (the incremental turn endpoint re-enters the proxy pipeline from
 *  handle.ts, so it cannot ride handleAdminRoute's dispatch — but it must
 *  pass the exact same loopback + trusted-origin + anti-tunnel checks).
 *  Exported for handle.ts; returns an error string, or undefined when the
 *  request may proceed. */
export function adminGateDenial(req: http.IncomingMessage, bindHost: string): string | undefined {
    if (headerValue(req, BILI_TUNNEL_HEADER) !== undefined) {
        return "management endpoints are not reachable through the bili tunnel";
    }
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
        return `management endpoints are loopback-only; access denied for ${req.socket.remoteAddress ?? "unknown"}`;
    }
    if (!isTrustedAdminOrigin(req.headers.origin, req.headers.host, adminTrustedHostnames(bindHost))) {
        return "management request origin does not match the local bili UI";
    }
    return undefined;
}

function adminTrustedHostnames(bindHost: string): Set<string> {
    const names = ["localhost", "127.0.0.1", "::1"];
    const bound = normalizeAdminHostname(bindHost);
    if (bound && bound !== "0.0.0.0" && bound !== "::" && !names.includes(bound)) {
        names.push(bound);
    }
    return new Set(names);
}

/** #3343: the management-plane prefix test — the two internal prefixes the
 *  loopback + trusted-origin + anti-tunnel gate protects (handleAdminRoute).
 *  Shared with the incremental-lane marker divert in handle.ts, which must
 *  never accept these paths: a diverted turn re-enters the pipeline carrying
 *  the ORIGINAL request URL, so an unfiltered divert hands a non-loopback
 *  caller a request onto the management prefixes. */
export function isManagementPath(url: string | undefined): boolean {
    return url !== undefined && (url === "/__bili/" || url.startsWith("/__bili/") || url === "/__acp/" || url.startsWith("/__acp/"));
}

// #2170 split-session canary: one log line per conversation base per process.
const splitWarnedBases = new Set<string>();

/** The proxy an AUX (blind-tunnel) request would take (#1012's inherited tier
 *  included), reported on health so the launcher can hand a child process the
 *  egress the user gives every other shell command. Deliberately not the
 *  model-path decision: /__bili/upstream answers for opts.upstream, where the
 *  provider route and model fallback tiers outrank the env tier and
 *  `explicitDirect` can short-circuit — a different proxy for the same
 *  instance. No target: this answers "what would ANY host resolve to".
 *  Errors resolve to null rather than failing health, which every attacher and
 *  spawn-wait keys on. */
function auxProxyShot(opts: ProxyOptions): { proxy: string | null; source: string | null } {
    try {
        const decision = resolveProxyDecision(opts.routes, opts.proxy, undefined, opts.auxProxyFallback ?? opts.proxyFallback);
        return { proxy: decision.proxy ?? null, source: decision.source };
    } catch {
        return { proxy: null, source: null };
    }
}

export async function handleAdminRoute(req: http.IncomingMessage, res: http.ServerResponse, ctx: AdminCtx): Promise<void> {
    const { opts, core, config, log, instanceId, instanceStartedAt, proxyWatchers, initialWatcherPid, watcherLastSeen } = ctx;
    // SECURITY: the /__bili/ management endpoints (config read/write, reload,
    // session stats) are privileged — a remote caller who can reach them can
    // rewrite upstream routing to exfiltrate API keys (MITM). Restrict them
    // to loopback connections. The proxy default host is 127.0.0.1 (loopback
    // only), but a user can set --host 0.0.0.0 to share the proxy on a LAN —
    // in that case we still must NOT expose management to the LAN. Only the
    // proxy /bili/ and CONNECT (model traffic) endpoints remain open to all.
    // #1073/#3245: self-addressed absolute-form requests arrive already
    // rewritten to origin form by handle() (selfAddressedLocalPath), so the
    // gates below always judge a path, never a full URL.
    const isAdminPath = isManagementPath(req.url);
    // #409: management must never be reachable THROUGH the bili tunnel, not
    // even from a loopback client: the tunnel's inner connection originates
    // from the proxy itself, so the remoteAddress gate alone is satisfied and
    // a `--host 0.0.0.0` peer could otherwise PUT /__bili/config over the
    // tunnel. forward() stamps this marker on every /bili/ absolute-URL
    // forward; clients have no legitimate reason to send it, and a spoofed
    // value only locks the spoofer out of admin paths.
    if (isAdminPath && headerValue(req, BILI_TUNNEL_HEADER) !== undefined) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "management endpoints are not reachable through the bili tunnel" }));
        return;
    }
    if (isAdminPath && !isLoopbackAddress(req.socket.remoteAddress)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "management endpoints are loopback-only; access denied for " + (req.socket.remoteAddress ?? "unknown") }));
        return;
    }
    // localPort, not opts.port: when listening on port 0 (dynamic assignment,
    // programmatic embedding, tests) the real port differs from opts.port and
    // pinning to the configured value would 403 every admin request.
    if (isAdminPath && !isTrustedAdminOrigin(req.headers.origin, req.headers.host, adminTrustedHostnames(opts.host))) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "management request origin does not match the local bili UI" }));
        return;
    }
    if (req.method === "GET" && req.url === "/__bili/stats") return sendStats(res);
    if (req.method === "GET" && req.url?.startsWith("/__bili/cache-report")) return sendCacheReport(res, req.url);
    if (req.method === "GET" && req.url?.startsWith("/__bili/session-report")) return sendSessionReport(res, req.url);
    if (req.method === "GET" && req.url === "/__bili/status") return sendStatus(res, opts);
    if (req.method === "GET" && req.url === "/__bili/resign") return sendResignStatus(res);
    if (req.method === "GET" && req.url === "/__bili/overview") return sendOverview(res, opts);
    if (req.method === "GET" && (req.url === "/__bili/sessions" || req.url?.startsWith("/__bili/sessions?"))) return sendWebSessions(res, req);
    if (req.method === "GET" && req.url?.startsWith("/__bili/logs")) return sendWebLogs(res, req);
    if (req.method === "GET" && req.url?.startsWith("/__bili/diagnostics")) return sendDiagnostics(res, req.url);
    if (req.method === "GET" && req.url?.startsWith("/__bili/sessions/") && req.url.endsWith("/detail")) return sendWebSessionDetail(res, req.url);
    // #4173: compact fold-edge feed for the live tree thumbnail (5s client poll).
    if (req.method === "GET" && req.url?.startsWith("/__bili/sessions/") && req.url.endsWith("/tree")) return sendWebSessionTree(res, req.url);
    // #3917: one block's original text for the 压缩结构 tree — lazy per click, so
    // the detail payload never carries whole originals.
    if (req.method === "GET" && req.url !== undefined && isBlockContentPath(req.url)) return sendWebBlockContent(res, req.url);
    // #3917: one folded message's text, addressed by its mNNNNN ref — the leaf
    // rows of the tier tree fetch their bytes one click at a time.
    if (req.method === "GET" && req.url !== undefined && isSessionMessagePath(req.url)) return sendWebSessionMessage(res, req.url);
    if (req.method === "GET" && req.url === "/") {
        // Browser visits root → redirect to the web UI. curl / health probes
        // (Accept: */* or no Accept) still get the JSON health check so
        // existing scripts and Docker-style health probes keep working.
        const accept = req.headers.accept ?? "";
        if (accept.includes("text/html")) {
            res.writeHead(302, { location: "/__bili/" });
            res.end();
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, upstream: opts.upstream }));
        return;
    }
    // #3536: browsers probing the proxy origin for a favicon (the dsh desktop
    // settings panel frames /__bili/ and the frame fires GET /favicon.ico at
    // the ORIGIN ROOT) must be answered locally with 204 — falling through to
    // the relay would rewrite the host onto the configured upstream, burning a
    // request there and logging a 403 for a static asset no model client ever
    // asks for. The panel page itself also declares an empty icon (page.ts) so
    // well-behaved browsers never send the probe at all; this is the backstop
    // for browsers/timings that still do (probe before redirect, direct visits).
    if (req.method === "GET" && req.url?.split("?", 2)[0] === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
    }
    if (req.method === "GET" && req.url === "/__bili/health") {
        // #2941: 503 while registration is still pending — every consumer
        // (launcher spawn-wait, attach discovery, host-native respawn) keys on
        // HTTP ok, so one gate covers all of them; pre-boot the instance is
        // bound but not yet findable by name.
        if (!ctx.bootReady()) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, reason: "starting" }));
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        // #1322: watchdog state is part of the health contract — attachers and
        // operators can see whether this proxy dies with its sessions (armed)
        // or outlives them all (daemon squatting a stable port).
        const aux = auxProxyShot(opts);
        res.end(JSON.stringify({ ok: true, upstream: opts.upstream, version: VERSION, commit: BUILD_COMMIT, instanceId, pid: process.pid, startedAt: instanceStartedAt, blindTunnels: getBlindTunnelStats(), auxProxy: aux.proxy, auxProxySource: aux.source, watchdog: { armed: initialWatcherPid !== null, parentPid: initialWatcherPid ?? undefined, watchers: [...proxyWatchers] } }));
        return;
    }
    // Web config UI (served as HTML, separate from the JSON health check above).
    // #2321: the bare path also tolerates a query (?embed=1&lang=…) — the dsh
    // settings panel frames exactly this route. Every /__bili/ URL already
    // passed the loopback/trusted-origin/tunnel gates above, so nothing opens.
    if (req.method === "GET" && req.url !== undefined && (req.url === "/__bili/" || req.url.startsWith("/__bili/?"))) {
        const u = new URL(req.url, "http://localhost");
        const origin = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`;
        // #2559: embedding hosts pin the face's palette explicitly (?theme=
        // light|dark) because app-level host themes are invisible to the
        // framed document's prefers-color-scheme.
        const rawTheme = u.searchParams.get("theme");
        const theme = rawTheme === "light" || rawTheme === "dark" ? rawTheme : undefined;
        const headers: Record<string, string> = {
            "content-type": "text/html; charset=utf-8",
            // The entire client bundle ships INLINE in this one document, so
            // without a cache directive the browser's HEURISTIC caching can pin
            // a stale build across a proxy upgrade — the user keeps loading the
            // old UI long after the server moved on (seen live: a fresh deploy
            // of new web features stayed invisible until a hard refresh).
            // Revalidating every load is fine: the shell is stateless HTML.
            "cache-control": "no-cache",
        };
        // #3xxx: the dsh settings pane's #3100 pre-flight fetches this route
        // CROSS-ORIGIN (dsh web serves the page on its own port, the proxy on
        // another — both loopback names, so isTrustedAdminOrigin above accepts
        // the request; the dsh DESKTOP app renders the pane from the custom
        // scheme origin dsh-app://app, which the gate also accepts), but a cors-mode fetch is only readable when the
        // response carries access-control-allow-origin. Without it the probe
        // rejects in the browser, the verdict never lands, and the pane stays
        // on "connecting to the bili proxy…" forever (model proxying and the
        // iframe itself keep working — only the probe is blocked). Echo the
        // requesting origin: this route serves a static HTML shell, no state,
        // and only origins the trusted-origin gate already admitted reach it.
        const reqOrigin = req.headers.origin;
        if (typeof reqOrigin === "string" && reqOrigin.length > 0) headers["access-control-allow-origin"] = reqOrigin;
        res.writeHead(200, headers);
        res.end(renderUI(origin, { embed: u.searchParams.get("embed") === "1", theme }));
        return;
    }
    if (req.method === "GET" && req.url === "/__bili/config") return handleConfigGet(res);
    // #3719: per-release notes for the panel's changelog section — same
    // read-only admin gating as every other /__bili/ GET above (the gates run
    // before dispatch). Always answers 200; offline degrades to empty+error.
    if (req.method === "GET" && req.url === "/__bili/changelog") return handleChangelogGet(res);
    // #3719: dedicated 更新/Updates tab — self-update state plus manual
    // check/install actions. Same gating as every /__bili/ route above (the
    // gates run before dispatch); an unwired process (autoUpdate off) answers
    // the state read normally and the action POSTs with fail-soft error strings.
    if (req.method === "GET" && req.url === "/__bili/update/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(await updateStateSnapshot(VERSION)));
        return;
    }
    if (req.method === "POST" && req.url === "/__bili/update/check") return handleUpdateCheck(res);
    if (req.method === "POST" && req.url === "/__bili/update/install") return handleUpdateInstall(req, res, log);
    if (req.method === "PUT" && req.url === "/__bili/config") {
        return handleConfigPut(req, res, () => {
            const fresh = loadOptions();
            if (fresh.passthrough !== opts.passthrough) {
                log(
                    fresh.passthrough ? "warn" : "info",
                    `[passthrough] ${fresh.passthrough ? "compression turned OFF via web config — forwarding verbatim" : "compression re-enabled via web config"}`,
                );
            }
            opts.passthrough = fresh.passthrough;
            opts.passthroughSource = fresh.passthroughSource;
            opts.proxy = fresh.proxy;
            opts.proxyMode = fresh.proxyMode;
            opts.proxySource = fresh.proxySource;
            opts.proxyFallback = fresh.proxyFallback;
            opts.auxProxyFallback = fresh.auxProxyFallback;
            opts.compress = fresh.compress;
            opts.compat = fresh.compat;
            resetProxyCache();
            for (const k of Object.keys(opts.routes)) delete opts.routes[k];
            Object.assign(opts.routes, loadRoutes());
            opts.namedProviders ??= {};
            for (const k of Object.keys(opts.namedProviders)) delete opts.namedProviders[k];
            Object.assign(opts.namedProviders, loadNamedProviders());
        }, opts.port);
    }
    if (req.method === "POST" && req.url === "/__bili/config/reload") return handleConfigReload(opts, res, log);
    // #2102: wipe the diagnostic conflict ledgers (global, or one session via
    // ?session=<id>). Loopback + trusted-origin gated like every /__bili/ path.
    if (req.method === "POST" && req.url?.startsWith("/__bili/conflicts/clear")) return handleConflictsClear(req.url, res, log);
    // #2861: silence a known host-side plugin notice for this environment.
    if (req.method === "POST" && req.url === "/__bili/host-plugins/dismiss") return handleHostPluginDismiss(req, res, log);
    // #3923/#3959: dismiss the surfaced split-brain notice (body {"sessionId": string}).
    if (req.method === "POST" && req.url === "/__bili/storage/split-brain/ack") return handleSplitBrainAck(req, res, log);
    if (req.method === "GET" && req.url === "/__bili/upstream") {
        const target = opts.upstream;
        const decision = resolveProxyDecision(opts.routes, opts.proxy, target, opts.proxyFallback);
        const connection = getUpstreamConnectionStatus();
        const connectionMatchesTarget = (() => {
            if (!connection.url) return false;
            try { return new URL(connection.url).origin === new URL(target).origin; } catch { return false; }
        })();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            target,
            proxy: decision.proxy ?? null,
            source: decision.source,
            mode: opts.proxyMode ?? "auto",
            autoConfigUrl: decision.autoConfigUrl ?? null,
            connected: connectionMatchesTarget ? connection.connected : undefined,
            error: connectionMatchesTarget ? connection.error : undefined,
            checkedAt: connectionMatchesTarget ? connection.checkedAt : undefined,
            connectionUrl: connection.url,
            connectionProxy: connection.proxy,
        }));
        return;
    }
    if (req.method === "POST" && req.url === "/__bili/upstream/test") {
        const target = opts.upstream;
        const targetUrl = new URL(target).origin;
        // Keep the whole decision: #2809's skippedProxy diagnostic rides on it.
        const decision = resolveProxyDecision(opts.routes, opts.proxy, target, opts.proxyFallback);
        const proxyUrl = decision.proxy;
        try {
            const result = await fetchWithTimeout(targetUrl, {
                method: "HEAD",
                redirect: "follow",
                ...(proxyUrl ? { dispatcher: proxyDispatcher(proxyUrl, 15_000) } : {}),
            }, 15_000);
            result.clearTimer();
            recordUpstreamConnection(targetUrl, proxyUrl);
            // #1682: a successful probe clears active alerts for this host so
            // the banner reflects the fix immediately, without waiting for traffic.
            clearUpstreamAlertsForHost(targetUrl);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, status: result.response.status, target: targetUrl, proxy: proxyUrl ?? null }));
        } catch (error) {
            // #1682: probe failures deliberately do NOT feed the alert table —
            // they are user-initiated diagnostics, not live-traffic evidence.
            recordUpstreamConnection(targetUrl, proxyUrl, error, decision.skippedProxy);
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: formatUpstreamError(error, targetUrl, proxyUrl, decision.skippedProxy) }));
        }
        return;
    }

    // Cooperative plugin protocol (see src/plugin.ts + PLUGIN.md): the
    // manifest serves the exact tool schemas the wire injector uses, and the
    // tool endpoint lets an agent-side plugin execute compress/decompress/
    // search_context/acp_status against the session the plugin drives. Both
    // live under the /__bili/ loopback + trusted-origin gate above.
    if (req.method === "GET" && req.url === "/__bili/plugin/manifest") {
        // [#1271/#1278] kernelConfig carries no file/global compress settings; resolve the
        // GLOBAL view exactly like the request path does (applyCompressSettings) so every
        // opt-in tool — acp_retrieve (#1271), absorb (#1278) — is advertised exactly when the
        // operator enabled it at the global level. Unset fields floor to kernel defaults
        // (DEFAULT_CCR_CONFIG et al. inside applyCompressSettings); per-request/route overrides
        // are still enforced at execution time, so the manifest stays conservative as #1192
        // requires. Do not "simplify" this back to `config`.
        // #3243: pass the pack surface's tool descriptions too — resolved from the SAME
        // global settings (no route/model context exists at manifest time), so registered
        // tool descriptions follow the top-level promptPack while per-request system prompts
        // may still honor deeper provider/model levels.
        const packSurface = resolveCompressSurfaceDetailed(opts.compress ?? {});
        return handlePluginManifest(res, applyCompressSettings(config, opts.modelContextLimit, opts.compress, { ...agentProviderRecipes(), ...opts.namedProviders ?? {} }), packSurface.surface.toolPrompts);
    }
    if (req.method === "GET" && req.url?.split("?")[0] === "/__bili/plugin/snapshot") {
        return await handlePluginSnapshot(new URL(req.url, "http://localhost").searchParams.get("conversationId") ?? "", res);
    }
    if (req.method === "POST" && req.url === "/__bili/plugin/fork") {
        try {
            return await handlePluginFork((await readBody(req)).toString("utf8"), res);
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, code: "INVALID_REQUEST", error: String(err) }));
            return;
        }
    }
    if (req.method === "GET" && req.url?.startsWith("/__bili/plugin/status")) {
        const query = req.url.slice(req.url.indexOf("?") + 1);
        const params = new URLSearchParams(query);
        const conversationId = params.get("conversationId")?.trim() ?? "";
        if (!conversationId) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "conversationId query parameter is required" }));
            return;
        }
        // Web UI origin as the user's browser dials it: the ACTUAL bound port
        // (req.socket.localPort differs from opts.port when listening on port 0).
        const webOrigin = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${req.socket?.localPort ?? opts.port}`;
        // #3862: pass the requesting origin through so the handler can echo it
        // back for cross-origin browser readers (the dsh client Context tab);
        // only origins the gate above admitted ever reach this line.
        const reqOrigin = req.headers.origin;
        return handlePluginStatus(conversationId, res, { core, config, log, webOrigin }, params.get("fallback") === "latest", typeof reqOrigin === "string" && reqOrigin.length > 0 ? reqOrigin : undefined);
    }
    if (req.method === "POST" && req.url === "/__bili/watcher") {
        // #7: an ATTACHING claude session registers its host pid so the shared
        // proxy outlives the first spawner's exit. Only proxies started in
        // parent-watch mode (BILI_PARENT_PID) take watchers — daemons stay
        // daemons, and a rejected registration leaves behavior unchanged.
        try {
            const body = await readBody(req);
            // #3544: hb:true opts the registration into heartbeat liveness —
            // the watchdog may then age the pid out on SILENCE even while its
            // number still exists (recycled). Absent/false keeps legacy
            // kill-0-only semantics for old hosts.
            const parsed = JSON.parse(body.toString("utf8")) as { pid?: unknown; hb?: unknown };
            const pid = parsed.pid;
            if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "expected { pid: <integer>, hb?: true }" }));
            } else if (initialWatcherPid === null) {
                res.writeHead(409, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "watchdog not armed (no parent pid) — this proxy does not take watchers" }));
            } else {
                proxyWatchers.add(pid);
                if (parsed.hb === true) watcherLastSeen?.set(pid, Date.now());
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, watchers: proxyWatchers.size }));
            }
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    // #3544: supervised drain+exit for stale-proxy rotation. A NEWER generation
    // of the same lane asks a strictly-older resident to run its graceful
    // shutdown path (session flush + registry cleanup + port release), then
    // binds the freed port itself. Loopback-gated like every /__bili/ route;
    // the response is immediate — exit completes asynchronously (≤10s backstop).
    if (req.method === "POST" && req.url === "/__bili/shutdown") {
        ctx.requestShutdown?.("rotation-requested (#3544)");
        log("info", `[admin] POST /__bili/shutdown — graceful shutdown requested`);
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    // #3901/#3463: unified-storage GC — age-sweep archive + zero-ref
    // collection + optional vacuum. Loopback-gated like every /__bili/
    // route; 501 in legacy mode (same discipline as /__bili/replicas).
    // #3901 review: the documented form is `?vacuum=full` (CONFIGURATION.md /
    // issue spec), but exact-match routing dropped any query string — accept
    // both, query wins over body.
    if (req.method === "POST" && (req.url === "/__bili/storage/gc" || req.url?.startsWith("/__bili/storage/gc?"))) {
        try {
            const parsed = JSON.parse((await readBody(req)).toString("utf8")) as { archiveAfterDays?: unknown; vacuum?: unknown };
            const store = getStore();
            if (!store.replicasAvailable()) {
                res.writeHead(501, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "storage gc requires the unified store — start this instance with BILI_STORAGE_UNIFIED=shadow|full (or storage.unified in the config file)" }));
                return;
            }
            const qVacuum = (() => { try { return new URL(req.url!, "http://localhost").searchParams.get("vacuum"); } catch { return null; } })();
            const vacuum = qVacuum === "full" || qVacuum === "incremental" ? qVacuum : parsed.vacuum === "full" ? "full" : parsed.vacuum === "incremental" ? "incremental" : undefined;
            const result = await store.unifiedGc({
                archiveAfterDays: typeof parsed.archiveAfterDays === "number" && Number.isFinite(parsed.archiveAfterDays) && parsed.archiveAfterDays >= 0 ? parsed.archiveAfterDays : undefined,
                vacuum,
            });
            if (!result) {
                res.writeHead(503, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "unified store unavailable mid-call" }));
                return;
            }
            log("info", `[admin] POST /__bili/storage/gc — archived=${result.archived} contentRowsDeleted=${result.contentRowsDeleted} vacuum=${vacuum ?? "none"}`);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, ...result }));
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    if (req.method === "POST" && (req.url === "/__bili/storage/backup" || req.url?.startsWith("/__bili/storage/backup?"))) {
        // #4175: online consistent snapshot of the unified store (VACUUM
        // INTO — sqlite only, never blocks WAL writers).
        try {
            const parsed = JSON.parse((await readBody(req)).toString("utf8")) as { dst?: unknown };
            const store = getStore();
            if (!store.replicasAvailable()) {
                res.writeHead(501, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "storage backup requires the unified store — start this instance with BILI_STORAGE_UNIFIED=shadow|full (or storage.unified in the config file)" }));
                return;
            }
            const dst = typeof parsed.dst === "string" && parsed.dst.length > 0 ? parsed.dst : undefined;
            const result = store.unifiedBackup(dst);
            log("info", `[admin] POST /__bili/storage/backup — ok=${result.ok} path=${result.path ?? "-"} bytes=${result.bytes ?? 0}`);
            res.writeHead(result.ok ? 200 : 409, { "content-type": "application/json" });
            res.end(JSON.stringify(result));
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    if (req.method === "POST" && req.url === "/__bili/storage/restore") {
        try {
            const parsed = JSON.parse((await readBody(req)).toString("utf8")) as { sessionId?: unknown; archiveDir?: unknown };
            if (typeof parsed.sessionId !== "string" || !parsed.sessionId) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "expected { sessionId: string, archiveDir?: string }" }));
                return;
            }
            const store = getStore();
            if (!store.replicasAvailable()) {
                res.writeHead(501, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "restore requires the unified store" }));
                return;
            }
            const result = await store.unifiedRestoreArchived(parsed.sessionId, typeof parsed.archiveDir === "string" && parsed.archiveDir ? parsed.archiveDir : undefined);
            log("info", `[admin] POST /__bili/storage/restore ${parsed.sessionId} → ${JSON.stringify(result)}`);
            res.writeHead(result?.ok ? 200 : 404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: result?.ok === true, error: result?.reason ?? (result ? undefined : "unified store unavailable") }));
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    // #2671 Phase 2: replica/checkpoint management over the unified store.
    // Loopback-gated like every /__bili/ route; 501 in legacy mode so the
    // operator knows the knob, not the URL, is what is missing.
    if (req.method === "GET" && (req.url === "/__bili/replicas" || req.url?.startsWith("/__bili/replicas?"))) return await sendReplicasList(res, req.url);
    if (req.method === "GET" && req.url === "/__bili/memory") return await sendMemoryReport(res);
    if (req.method === "POST" && req.url === "/__bili/replicas") {
        try {
            const parsed = JSON.parse((await readBody(req)).toString("utf8")) as { sessionId?: unknown; label?: unknown; pinned?: unknown };
            if (typeof parsed.sessionId !== "string" || !parsed.sessionId) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "expected { sessionId: string, label?: string, pinned?: boolean }" }));
                return;
            }
            const store = getStore();
            if (!store.replicasAvailable()) {
                res.writeHead(501, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "replicas require the unified store — start this instance with BILI_STORAGE_UNIFIED=shadow|full (or storage.unified in the config file)" }));
                return;
            }
            // Freshest snapshot first: a resident session is force-flushed so
            // the checkpoint freezes what the caller just saw, not the last
            // debounced write.
            const resident = peekSession(parsed.sessionId);
            if (resident) await store.writeNow(resident);
            try {
                const row = await store.createReplica(parsed.sessionId, {
                    label: typeof parsed.label === "string" ? parsed.label : undefined,
                    pinned: parsed.pinned === true,
                });
                res.writeHead(201, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, replica: serializeReplica(row) }));
            } catch (err) {
                const msg = String(err);
                res.writeHead(msg.includes("not in the unified index") ? 404 : 500, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: msg }));
            }
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    if (req.method === "GET" && req.url?.startsWith("/__bili/replicas/") && !req.url.endsWith("/restore")) return await sendReplicaDetail(res, req.url);
    if (req.method === "POST" && req.url?.startsWith("/__bili/replicas/") && req.url.endsWith("/restore")) {
        try {
            const cpId = replicaIdFromUrl(req.url, "/restore");
            if (!cpId) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "expected /__bili/replicas/<cpId>/restore" }));
                return;
            }
            const store = getStore();
            if (!store.replicasAvailable()) {
                res.writeHead(501, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "replicas require the unified store — start this instance with BILI_STORAGE_UNIFIED=shadow|full" }));
                return;
            }
            let newSessionId: string | undefined;
            const raw = await readBody(req);
            if (raw.byteLength > 0) {
                const parsed = JSON.parse(raw.toString("utf8")) as { sessionId?: unknown };
                if (parsed.sessionId !== undefined && (typeof parsed.sessionId !== "string" || !parsed.sessionId)) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "sessionId must be a non-empty string" }));
                    return;
                }
                newSessionId = parsed.sessionId as string | undefined;
            }
            try {
                const out = await store.restoreReplica(cpId, { sessionId: newSessionId });
                res.writeHead(201, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, ...out }));
            } catch (err) {
                const msg = String(err);
                const code = msg.includes("checkpoint not found") ? 404 : msg.includes("already exists") ? 409 : 500;
                res.writeHead(code, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: msg }));
            }
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    if (req.method === "DELETE" && req.url?.startsWith("/__bili/replicas/")) {
        const cpId = replicaIdFromUrl(req.url);
        if (!cpId) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "expected /__bili/replicas/<cpId>" }));
            return;
        }
        const store = getStore();
        if (!store.replicasAvailable()) {
            res.writeHead(501, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "replicas require the unified store — start this instance with BILI_STORAGE_UNIFIED=shadow|full" }));
            return;
        }
        const deleted = await store.deleteReplica(cpId);
        res.writeHead(deleted ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: deleted, deleted }));
        return;
    }
    if (req.method === "POST" && req.url === "/__bili/plugin/tool") {
        try {
            const body = await readBody(req);
            const webOrigin = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${req.socket?.localPort ?? opts.port}`;
            return await handlePluginTool(body.toString("utf8"), res, { core, config, log, webOrigin });
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    if (req.method === "POST" && req.url === "/__bili/plugin/register") {
        try {
            const body = await readBody(req);
            handlePluginRegister(body.toString("utf8"), res);
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    if (req.method === "POST" && req.url === "/__bili/agent-providers") {
        // #2336 agent-registry fallback: a plugin host reports its dialing
        // recipes (key bytes resolved in the agent's memory). Names only in
        // the response — the key never crosses a log or GET surface.
        // #2585: intake is per-entry — a refused entry is logged and named in
        // the response instead of discarding the whole report.
        try {
            const body = await readBody(req);
            const report = parseAgentProviderReport(JSON.parse(body.toString("utf8")));
            recordAgentProviders(report.agent, report.registered);
            const names = Object.keys(report.registered).sort();
            log("info", `[agent-providers] ${report.agent} registered: ${names.join(", ") || "(none)"} (#2336)`);
            for (const s of report.skipped) log("warn", `[agent-providers] ${report.agent} skipped ${s.name}: ${s.reason} (this provider stays unresolved) (#2585)`);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, agent: report.agent, registered: names, skipped: report.skipped }));
            return;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log("warn", `[agent-providers] report rejected: ${sanitizeAgentProviderField(msg, 200)} (#2585)`);
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: msg }));
            return;
        }
    }
    if (req.method === "POST" && req.url === "/__bili/plugin/runtime-info") {
        try {
            const body = await readBody(req);
            handlePluginRuntimeInfo(body.toString("utf8"), res);
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    if (req.method === "POST" && req.url === "/__bili/plugin/attribution") {
        // #3581: event-driven takeover-health report from a host plugin (refusal
        // transitions only — healthy lanes never hit this route).
        try {
            const body = await readBody(req);
            handlePluginAttribution(body.toString("utf8"), res);
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    if (req.method === "POST" && req.url === "/__bili/plugin/compact") {
        try {
            const body = await readBody(req);
            handlePluginCompact(body.toString("utf8"), res);
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    if (req.method === "POST" && req.url === "/__bili/plugin/session-name") {
        // #2322: host-provided conversation name (pi /name) — becomes the
        // session's display title in the web UI (clear = empty string).
        try {
            const body = await readBody(req);
            handlePluginSessionName(body.toString("utf8"), res);
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    // Unknown /__bili/ or /__acp/ path → 404 locally. These are bili's own
    // management prefixes; forwarding would leak the internal path to the
    // upstream (which 403s it) — #346. #3100: a frozen pre-update process 404s
    // routes that only exist in newer builds (the query-form UI route landed
    // in v0.1.189), so carry the running vs on-disk version in the body — the
    // skew becomes visible from the error itself instead of log archaeology.
    if (isAdminPath) {
        let diskVersion: string | undefined;
        let stale = false;
        try {
            ({ diskVersion, stale } = await detectStaleInstall(PACKAGE_NAME, VERSION));
        } catch {
            // fs hiccup: report the running version only, never fail the 404
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "not_found", message: "no such management endpoint", version: VERSION, commit: BUILD_COMMIT, diskVersion, stale } }));
        return;
    }
}

function handleConfigReload(opts: ProxyOptions, res: http.ServerResponse, log: (level: string, msg: string) => void): void {
    // Hot-reload routes from the config file into the running process — no
    // restart needed. Routes and the global compress block are re-read;
    // port/host/upstream stay as-is (the listen socket is already bound).
    // Mutates opts.routes in place so all in-flight handle() closures that
    // captured `opts` see the new routes.
    const fresh = loadRoutes();
    // Clear and refill the SAME object reference so resolveUpstream/resolveContextLimit
    // (which read opts.routes) pick up the new entries without needing reassignment.
    for (const k of Object.keys(opts.routes)) delete opts.routes[k];
    Object.assign(opts.routes, fresh);
    opts.namedProviders ??= {};
    for (const k of Object.keys(opts.namedProviders)) delete opts.namedProviders[k];
    Object.assign(opts.namedProviders, loadNamedProviders());
    const reloaded = loadOptions();
    opts.compress = reloaded.compress;
    opts.compat = reloaded.compat;
    opts.imageBilling = reloaded.imageBilling;
    opts.imageTokenCap = reloaded.imageTokenCap;
    // Release cached ProxyAgents so agents for proxy URLs that were
    // removed/changed don't leak for the process lifetime. The next request
    // re-creates the needed agent lazily via proxyDispatcher().
    resetProxyCache();
    const names = Object.keys(fresh);
    log("info", `[acp-web] routes hot-reloaded (${names.length} providers): ${names.join(", ") || "(none)"}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: names.length, routes: names }));
}

function sendCacheReport(res: http.ServerResponse, url: string): void {
    const sessionParam = new URL(url, "http://localhost").searchParams.get("session");
    let sessions = listSessions();
    if (sessionParam !== null) {
        const hit = sessions.filter((s) => s.id === sessionParam);
        if (hit.length === 0) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: `unknown session: ${sessionParam}` }));
            return;
        }
        sessions = hit;
    } else {
        sessions = sessions.slice().sort((a, b) => b.lastSeen - a.lastSeen);
    }
    res.writeHead(200, { "content-type": "application/json" });
    // Same markdown the acp_cache MCP tool emits (handleAcpCache = formatCacheReport),
    // so web copy/download matches /acp-cache output exactly.
    res.end(JSON.stringify({ reports: sessions.map((s) => ({ id: s.id, report: handleAcpCache(s, { detail: "full" }).text })) }, null, 2));
}

// #2102: wipe diagnostic conflict ledgers — global, or one session via ?session=<id>.
// Gated by the /__bili/* admin gate above (loopback + trusted origin only);
// wiping loses no conversation data, only the evidence notes (#1206 design).
function handleConflictsClear(url: string, res: http.ServerResponse, log: (level: string, msg: string) => void): void {
    const sessionId = new URL(url, "http://localhost").searchParams.get("session");
    const sessions = listSessions();
    if (sessionId !== null && sessionId !== "" && !sessions.some((s) => s.id === sessionId)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `unknown session: ${sessionId}` }, null, 2));
        return;
    }
    const cleared = clearConflictEvents(sessions, sessionId || undefined);
    log("info", `[conflict] ledger cleared via web UI: ${cleared.events} event(s) across ${cleared.sessions} session(s)${sessionId ? ` (session ${sessionId})` : ""}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, cleared }, null, 2));
}

// ---- #3719: web 更新/Updates tab actions ---------------------------------

/** POST /__bili/update/check — force one registry check through the shared
 *  update options (same lock/throttle/proxy gates as the background loop).
 *  Always HTTP 200: an unwired process answers {ok:false, error} so the panel
 *  can show the string verbatim instead of failing the fetch. */
async function handleUpdateCheck(res: http.ServerResponse): Promise<void> {
    if (!updateActionsAvailable()) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "self-update not wired in this process" }, null, 2));
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(await triggerManualCheck(), null, 2));
}

/** POST /__bili/update/install {"version":"x.y.z"} — pin a specific version
 *  (upgrade or rollback). Malformed JSON or a version outside plain semver
 *  characters → 400 like the other POSTs; execution always answers 200
 *  {ok, error?} with the updater's own result shape. */
async function handleUpdateInstall(req: http.IncomingMessage, res: http.ServerResponse, log: (level: string, msg: string) => void): Promise<void> {
    let rawVersion: string | undefined;
    try {
        const doc: unknown = JSON.parse((await readBody(req)).toString("utf8"));
        if (doc && typeof doc === "object" && typeof (doc as { version?: unknown })["version"] === "string") rawVersion = (doc as { version: string })["version"];
    } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: 'expected JSON body {"version": "<x.y.z>"}' }, null, 2));
        return;
    }
    const version = rawVersion?.trim();
    if (version === undefined || version.length === 0 || !/^[0-9A-Za-z.+-]+$/.test(version)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "version must be plain semver characters (digits, dots, +, -) only" }, null, 2));
        return;
    }
    log("info", `[update] web panel requested install ${version}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(await installVersionAction(version), null, 2));
}

// #2861: server-side dismissal of a host-plugin notice (body {"id": string}).
async function handleHostPluginDismiss(req: http.IncomingMessage, res: http.ServerResponse, log: (level: string, msg: string) => void): Promise<void> {
    let id = "";
    try {
        const doc: unknown = JSON.parse((await readBody(req)).toString("utf8"));
        if (doc && typeof doc === "object" && typeof (doc as { id?: unknown })["id"] === "string") id = (doc as { id: string })["id"];
    } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: 'expected JSON body {"id": "<notice id>"}' }, null, 2));
        return;
    }
    if (!dismissHostPlugin(id)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `unknown host plugin notice: ${id}` }, null, 2));
        return;
    }
    log("info", `[host-plugin] notice ${id} dismissed via web UI`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }, null, 2));
}

// #3923/#3959: dismiss the surfaced split-brain notice (body {"sessionId": string}).
async function handleSplitBrainAck(req: http.IncomingMessage, res: http.ServerResponse, log: (level: string, msg: string) => void): Promise<void> {
    let sessionId = "";
    try {
        const doc: unknown = JSON.parse((await readBody(req)).toString("utf8"));
        if (doc && typeof doc === "object" && typeof (doc as { sessionId?: unknown })["sessionId"] === "string") sessionId = (doc as { sessionId: string })["sessionId"];
    } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: 'expected JSON body {"sessionId": "<session id>"}' }, null, 2));
        return;
    }
    if (!ackSplitBrainContest(sessionId)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no surfaced split-brain entry for session: ${sessionId}` }, null, 2));
        return;
    }
    log("info", `[storage] split-brain notice for session ${sessionId.slice(0, 8)} acknowledged via web UI`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }, null, 2));
}

// ---- #2671 Phase 2: replica (checkpoint) helpers --------------------------

/** checkpoints row (snake_case) → HTTP payload (camelCase). */
function serializeReplica(row: {
    cp_id: string;
    session_id: string;
    seq_at: number;
    block_set_hash: string;
    kind: string;
    created_at: number;
    pinned: number;
    label: string | null;
}): { cpId: string; sessionId: string; seqAt: number; blockSetHash: string; kind: string; createdAt: number; pinned: boolean; label: string | null } {
    return { cpId: row.cp_id, sessionId: row.session_id, seqAt: row.seq_at, blockSetHash: row.block_set_hash, kind: row.kind, createdAt: row.created_at, pinned: row.pinned === 1, label: row.label };
}

function replicaIdFromUrl(url: string, suffix = ""): string | null {
    const id = url.slice("/__bili/replicas/".length, url.length - suffix.length);
    return id && !id.includes("/") ? decodeURIComponent(id) : null;
}

/** GET /__bili/memory — resident-pool diagnostics (#R3): process numbers plus
 * the per-session resident breakdown (lastMessages / pluginSnapshot /
 * blockContents / contentStore / state / other). Read-only, loopback-gated
 * with the rest of /__bili. Top 25 sessions by bytes. */
async function sendMemoryReport(res: http.ServerResponse): Promise<void> {
    let peakRssBytes: number | null = null;
    try {
        const status = fs.readFileSync("/proc/self/status", "utf8");
        const m = status.match(/VmHWM:\s+(\d+) kB/);
        if (m) peakRssBytes = Number(m[1]) * 1024;
    } catch {
        // non-linux: peak stays null
    }
    const mu = process.memoryUsage();
    const report = memoryReport();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        ok: true,
        process: { rssBytes: mu.rss, heapUsedBytes: mu.heapUsed, heapTotalBytes: mu.heapTotal, externalBytes: mu.external, peakRssBytes },
        pool: report.pool,
        breakdown: report.breakdown,
        sessions: report.sessions.slice(0, 25),
    }, null, 2));
}

async function sendReplicasList(res: http.ServerResponse, url: string): Promise<void> {
    const store = getStore();
    if (!store.replicasAvailable()) {
        res.writeHead(501, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "replicas require the unified store — start this instance with BILI_STORAGE_UNIFIED=shadow|full" }));
        return;
    }
    const q = new URL(url, "http://localhost").searchParams.get("sessionId");
    const rows = await store.listReplicas(q ?? undefined);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, replicas: rows.map(serializeReplica) }, null, 2));
}

async function sendReplicaDetail(res: http.ServerResponse, url: string): Promise<void> {
    const store = getStore();
    if (!store.replicasAvailable()) {
        res.writeHead(501, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "replicas require the unified store — start this instance with BILI_STORAGE_UNIFIED=shadow|full" }));
        return;
    }
    const cpId = replicaIdFromUrl(url);
    if (!cpId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "expected /__bili/replicas/<cpId>" }));
        return;
    }
    try {
        const row = (await store.listReplicas()).find((r) => r.cp_id === cpId);
        if (!row) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: `checkpoint not found: ${cpId}` }));
            return;
        }
        const byteLen = await store.replicaByteLen(cpId);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, replica: { ...serializeReplica(row), byteLen } }, null, 2));
    } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
}

function sendStats(res: http.ServerResponse): void {
    const all = listSessions();
    const sessions = all.map((s) => {
        const sw = readModelSwitchStats(s);
        const ks = readKeySwitchStats(s);
        const ps = readPromptSwitchStats(s);
        const js = readProjSwitchStats(s);
        return {
            id: s.id,
            protocol: s.meta.protocol,
            upstream: s.meta.upstreamOrigin,
            label: s.meta.label,
            title: s.meta.hostTitle ?? s.meta.title,
            requests: s.stats.requests,
            contextTokens: s.stats.contextTokens,
            contextTokensSource: s.stats.contextTokensSource,
            inputTokens: s.stats.inputTokens,
            cachedTokens: s.stats.cachedTokens,
            outputTokens: s.stats.outputTokens,
            cacheSamples: s.stats.cacheSamples,
            cacheHitPct: s.stats.cacheSamples > 0 && s.stats.inputTokens > 0 ? Math.round(s.stats.cachedTokens / s.stats.inputTokens * 100) : null,
            lastModel: typeof s.metadata.lastModel === "string" ? s.metadata.lastModel : undefined,
            modelSwitches: sw?.count ?? 0,
            switchMissedTokens: sw?.missedTokens ?? 0,
            keySwitches: ks?.count ?? 0,
            keySwitchMissedTokens: ks?.missedTokens ?? 0,
            promptSwitches: ps?.count ?? 0,
            promptSwitchMissedTokens: ps?.missedTokens ?? 0,
            projSwitches: js?.count ?? 0,
            projSwitchMissedTokens: js?.missedTokens ?? 0,
            // #3671 direction 4: decompress usage — the model side already sees
            // this via acp_status RETRIEVAL QUALITY (#1336); humans never did.
            // `blocks` (same definition as the web list) is the fold-count
            // denominator so the restore:fold ratio is computable from one endpoint.
            wholeBlockRestores: s.stats.wholeBlockRestores ?? 0,
            wholeBlockRestoresPreciseAvailable: s.stats.wholeBlockRestoresPreciseAvailable ?? 0,
            rangeRestores: s.stats.rangeRestores,
            blocks: s.state.blocks.length,
            // #901: window credibility — trusted (configured/registry) window vs the
            // largest input recent successful turns actually got through. A wide gap
            // means the provider overstates its window.
            contextWindow: typeof s.metadata.effectiveContextLimit === "number" ? s.metadata.effectiveContextLimit : undefined,
            lastSeen: new Date(s.lastSeen).toISOString(),
            restored: s.restored === true,
        };
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions, blindTunnels: getBlindTunnelStats(), unrecognizedPaths: getUnrecognizedPathStats(), conflicts: summarizeConflicts(all) }, null, 2));
}

/** #2152: the `advisory` field exposed by BOTH /__bili/status and /__bili/overview —
 *  computed once and shared so the two surfaces cannot drift apart again (that
 *  divergence is what left the web banner dead: overview never carried the field).
 *  null when no advisory is active; otherwise the active entry plus targetFailed
 *  (pinned target unresolvable on the registry → banner falls back to @latest). */
function currentAdvisoryPayload() {
    const adv = getAdvisoryState();
    return adv.active ? { ...adv.active, targetFailed: cannotResolveTarget(adv.lastError) } : null;
}

/** #3619: the `updatePolicy` field exposed by BOTH /__bili/status and
 *  /__bili/overview (same single-source discipline as the advisory payload):
 *  whether auto-upgrades are frozen/pinned right now, which policy source is
 *  in effect, and the staggered upgrade moment when one is pending. */
function updatePolicyPayload() {
    const st = getUpdatePolicyState();
    const planned = getPlannedUpgrade();
    return {
        source: st?.source ?? "unknown",
        fetchedAt: st?.fetchedAt !== undefined ? new Date(st.fetchedAt).toISOString() : null,
        hold: st?.doc?.hold ?? false,
        pinned: st?.doc?.pinned ?? null,
        blocked: st?.doc?.blocked ?? [],
        error: st?.error ?? null,
        plannedUpgrade: planned ? { tag: planned.tag, version: planned.version, at: new Date(planned.at).toISOString() } : null,
    };
}

/** Stale-install state for the web UI badge (#811): whether the on-disk
 *  version is newer than the running process, plus the opt-in flag state and
 *  the live in-flight request count. */
// #1870/#1977 web surface: the /acp panel and acp_status carry the critical
// update payload, but the web UI had NO update notice at all — the browser only
// had the disk-vs-running stale banner. Shared single source (the #2152
// advisory-parity lesson): one helper feeds BOTH /__bili/status and
// /__bili/overview, so the web banner's data source can never drift from the
// panel's. STRUCTURED, not a baked English sentence: the client composes the
// sentence per locale (zh/en) from kind/version/summary, and "available"
// carries the MINIMUM fixed version so every locale can say "v{version} 或更新版本 /
// v{version} or newer". null when the span is invisible (routine/recommended-
// only or clean install — silent by default, #1977).
function updateReadyPayload(): { kind: "available" | "ready"; version: string; summary: string } | null {
    return updateBannerPayload(getUpdateVisibility(VERSION));
}

async function sendStatus(res: http.ServerResponse, opts: ProxyOptions): Promise<void> {
    let diskVersion: string | undefined;
    let stale = false;
    let lastInstall: Awaited<ReturnType<typeof getLastInstall>>;
    try {
        ({ diskVersion, stale } = await detectStaleInstall(PACKAGE_NAME, VERSION));
        // #3754: which channel put the on-disk version there — fresh read per
        // call so installs done by other processes are visible too. Fail-open
        // inside getLastInstall (absent/corrupt → undefined).
        lastInstall = await getLastInstall();
    } catch {
        // fs hiccup: report running state only, never fail the status endpoint
    }
    res.writeHead(200, { "content-type": "application/json" });
    const splitWarnings = splitSessionWarnings(listSessions());
    for (const w of splitWarnings) {
        if (!splitWarnedBases.has(w.base)) {
            splitWarnedBases.add(w.base);
            loggerLog("warn", `split-session canary (#2170): conversation ${w.base} has live traffic under multiple session keys (design persona forks are excluded): ${w.sessions.map((s) => `${s.id} (requests=${s.requests})`).join("; ")}. For a non-persona host this is the #2165 failure shape (stolen anchor / never-compressing split) — investigate if unexpected.`);
        }
    }
    res.end(JSON.stringify({ version: VERSION, commit: BUILD_COMMIT, diskVersion, stale, lastInstall, updateReady: updateReadyPayload(), autoRestartOnUpdate: opts.autoRestartOnUpdate, advisory: currentAdvisoryPayload(), updatePolicy: updatePolicyPayload(), pluginAdvisories: detectCostAdvisories(process.env), inFlight: totalInFlight(), splitSessions: splitWarnings, conflicts: summarizeConflicts(listSessions()), storage: storageStatusWire(), snapshotShadow: snapshotShadowStatusWire(), attribution: attributionStatusWire() }, null, 2));
}

// #2090 plan A — read-only view backing the web UI's "Signed upstreams" card:
// every known/observed signature scheme with its current effective policy,
// plus the remembered refusals and which of them are still unresolved.
function sendResignStatus(res: http.ServerResponse): void {
    const names = new Set<string>([...Object.keys(KNOWN_SIGNATURE_SCHEMES), ...Object.keys(readPendingRefusals())]);
    const schemes: Record<string, { known?: { label: string; source: string; builtIn?: boolean }; builtIn: boolean; enabled: boolean; passthrough: boolean; passthroughApplies: boolean }> = {};
    for (const name of [...names].sort()) {
        const st = resolveResignSettings(process.env, undefined, name);
        schemes[name] = { known: KNOWN_SIGNATURE_SCHEMES[name], builtIn: name === APIG_RESIGN_SCHEME, enabled: st.enabled, passthrough: st.passthrough, passthroughApplies: name === APIG_RESIGN_SCHEME };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        builtinScheme: APIG_RESIGN_SCHEME,
        builtinCredentialSource: "dsh credentials service (jet-hub state.json) — the only scheme bili re-signs itself",
        envOverrides: { BILI_RESIGN: process.env.BILI_RESIGN ?? null, BILI_RESIGN_PASSTHROUGH: process.env.BILI_RESIGN_PASSTHROUGH ?? null },
        schemes,
        pending: readPendingRefusals(),
        unresolved: Object.keys(unresolvedRefusals()),
    }, null, 2));
}

async function sendOverview(res: http.ServerResponse, opts: ProxyOptions): Promise<void> {
    let diskVersion: string | undefined;
    let stale = false;
    let lastInstall: Awaited<ReturnType<typeof getLastInstall>>;
    try {
        ({ diskVersion, stale } = await detectStaleInstall(PACKAGE_NAME, VERSION));
        // #3754: same single-source read as sendStatus (#2152 parity).
        lastInstall = await getLastInstall();
    } catch {
        // fs hiccup: report running state only, never fail the overview endpoint
    }
    let overview;
    try {
        overview = await buildOverview();
    } catch (error) {
        loggerLog("error", `[acp-web] overview failed: ${String(error)}`);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "failed to load session data" }));
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        overview,
        version: VERSION,
        commit: BUILD_COMMIT,
        diskVersion,
        stale,
        lastInstall,
        updateReady: updateReadyPayload(),
        autoRestartOnUpdate: opts.autoRestartOnUpdate,
        advisory: currentAdvisoryPayload(),
        updatePolicy: updatePolicyPayload(),
        pluginAdvisories: detectCostAdvisories(process.env),
        hostPluginNotices: visibleHostPluginNotices(process.env),
        inFlight: totalInFlight(),
        blindTunnels: getBlindTunnelStats(),
        conflicts: summarizeConflicts(listSessions()),
        passthrough: { enabled: !!opts.passthrough, source: opts.passthroughSource },
        alerts: getUpstreamAlerts(),
        pckSuppressions: pckAblations(),
        storage: storageStatusWire(),
        attribution: attributionStatusWire(),
    }, null, 2));
}

/** #3040: generic diagnostics report — copyable blob + prefilled GitHub issue
 *  link. Loopback-gated like every other /__bili/* route; never throws. */
function sendDiagnostics(res: http.ServerResponse, url: string | null): void {
    let topic: string | undefined;
    try {
        topic = new URL(url ?? "/__bili/diagnostics", "http://localhost").searchParams.get("topic") ?? undefined;
    } catch {
        topic = undefined;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(buildDiagnostics(topic), null, 2));
}

/** #1937：携带搜索、协议、客户端、状态或分页参数时，启用服务端筛选分页。
 *  无参数时保留原响应结构，兼容旧界面；每页最多返回 200 条。 */
async function sendWebSessions(res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const u = new URL(req.url ?? "/__bili/sessions", "http://localhost");
    let body: Record<string, unknown>;
    try {
        const paged =
            u.searchParams.has("page") ||
            u.searchParams.has("pageSize") ||
            u.searchParams.has("q") ||
            u.searchParams.has("protocol") ||
            u.searchParams.has("client") ||
            u.searchParams.has("state");
        if (paged) {
            const rawSize = Number(u.searchParams.get("pageSize"));
            const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? Math.min(Math.floor(rawSize), 200) : 50;
            const rawPage = Number(u.searchParams.get("page"));
            const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
            const rawState = u.searchParams.get("state");
            const state = rawState === "live" || rawState === "history" ? rawState : undefined;
            body = {
                ...(await buildSessionPage({
                    q: u.searchParams.get("q") ?? undefined,
                    protocol: u.searchParams.get("protocol") ?? undefined,
                    client: u.searchParams.get("client") ?? undefined,
                    state,
                    page,
                    pageSize,
                })),
                hiddenEmpty: hiddenEmptyCount(),
            };
        } else {
            const sessions = await buildSessionList();
            body = { sessions, hiddenEmpty: hiddenEmptyCount(), total: sessions.length };
        }
    } catch (error) {
        loggerLog("error", `[acp-web] sessions list failed: ${String(error)}`);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "failed to load session data" }));
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
}

/** #1426 web UI run-log viewer: tail of the rotated logger files (bili.log.old
 *  + bili.log), optionally filtered by a case-insensitive substring (?q=).
 *  ?lines= caps the tail at 2000; ?raw=1 streams the same tail as a .txt download. */
async function sendWebLogs(res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const u = new URL(req.url ?? "/__bili/logs", "http://localhost");
    const q = (u.searchParams.get("q") ?? "").trim();
    const fullDownload = u.searchParams.get("raw") === "1" && u.searchParams.get("all") === "1";
    let n = Number(u.searchParams.get("lines") ?? "500");
    if (!Number.isFinite(n) || n <= 0) n = 500;
    // Full download is the forensic escape hatch: ignore `lines`, capped only
    // by the memory guard below so users can export the whole .old + cur pair.
    n = fullDownload ? 100_000 : Math.min(Math.floor(n), 2000);
    // Context expansion (ctx=N rows around each hit) and time window (win=Ss
    // around [firstHit, lastHit]) — selection logic lives in web/logs-query.ts
    // (unit-tested pure function); win wins over ctx when both are given.
    let ctx = Number(u.searchParams.get("ctx") ?? "0");
    if (!Number.isFinite(ctx) || ctx < 0) ctx = 0;
    ctx = Math.min(Math.floor(ctx), 50);
    let win = Number(u.searchParams.get("win") ?? "0");
    if (!Number.isFinite(win) || win < 0) win = 0;
    win = Math.min(Math.floor(win), 3600);
    const logFile = getLogPath() ?? defaultLogFile();
    // Cross-platform dir extraction: a naive "/" split yields "" on Windows
    // paths and the candidates would silently resolve against cwd.
    const dir = logFile ? path.dirname(logFile) + path.sep : "";
    const candidates = [dir + "bili.log.old", dir + "bili.log"];
    const existing = candidates.filter((f) => {
        try { return fs.statSync(f).isFile(); } catch { return false; }
    });
    let all: string[] = [];
    for (const f of existing) {
        let text: string;
        try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
        all = all.concat(text.split("\n").filter((l) => l.length > 0));
    }
    const r = queryLogLines(all, q, { ctx, winSec: win, n });
    if (u.searchParams.get("raw") === "1") {
        res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": `attachment; filename="${fullDownload ? "billion-context-full-log.txt" : "billion-context-log.txt"}"`,
        });
        res.end(r.lines.join("\n"));
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        path: logFile,
        total: r.total,
        shown: r.shown,
        omitted: r.omitted,
        lines: r.lines,
        ...(r.isMatch ? { isMatch: r.isMatch } : {}),
    }, null, 2));
}

async function sendWebSessionDetail(res: http.ServerResponse, url: string): Promise<void> {
    const prefix = "/__bili/sessions/";
    const suffix = "/detail";
    let id = "";
    try {
        id = decodeURIComponent(url.slice(prefix.length, -suffix.length));
    } catch {
        // malformed percent-encoding → treat as unknown session (404 below)
    }
    const detail = await buildSessionDetail(id);
    if (!detail) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `unknown session: ${id}` }));
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(detail, null, 2));
}

// #4173: minimal edge set for the tree thumbnail — see buildSessionTree.
async function sendWebSessionTree(res: http.ServerResponse, url: string): Promise<void> {
    const prefix = "/__bili/sessions/";
    const suffix = "/tree";
    let id = "";
    try {
        id = decodeURIComponent(url.slice(prefix.length, -suffix.length));
    } catch {
        // malformed percent-encoding → unknown session (404 below)
    }
    const tree = await buildSessionTree(id);
    if (!tree) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `unknown session: ${id}` }));
        return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(tree));
}

// #3917: `/__bili/sessions/<id>/block-content?blockId=bN&view=one|full`.
const BLOCK_CONTENT_PATH = "/block-content";

function isBlockContentPath(url: string): boolean {
    const q = url.indexOf("?");
    const path = q === -1 ? url : url.slice(0, q);
    return path.startsWith("/__bili/sessions/") && path.endsWith(BLOCK_CONTENT_PATH);
}

async function sendWebBlockContent(res: http.ServerResponse, url: string): Promise<void> {
    const u = new URL(url, "http://localhost");
    const pathname = u.pathname;
    const prefix = "/__bili/sessions/";
    let id = "";
    try {
        id = decodeURIComponent(pathname.slice(prefix.length, -BLOCK_CONTENT_PATH.length));
    } catch {
        // malformed percent-encoding → unknown session below
    }
    const blockId = u.searchParams.get("blockId") ?? "";
    const view: BlockContentView = u.searchParams.get("view") === "full" ? "full" : "one";
    if (!id || !blockId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing session id or blockId" }));
        return;
    }
    const result = await buildBlockContent(id, blockId, view);
    if (!result.ok) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: result.reason, reason: result.reason, session: id, blockId }));
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
}

// #3917: `/__bili/sessions/<id>/message?ref=mNNNNN` — one folded message's text.
const SESSION_MESSAGE_PATH = "/message";

function isSessionMessagePath(url: string): boolean {
    const q = url.indexOf("?");
    const path = q === -1 ? url : url.slice(0, q);
    return path.startsWith("/__bili/sessions/") && path.endsWith(SESSION_MESSAGE_PATH);
}

async function sendWebSessionMessage(res: http.ServerResponse, url: string): Promise<void> {
    const u = new URL(url, "http://localhost");
    const prefix = "/__bili/sessions/";
    let id = "";
    try {
        id = decodeURIComponent(u.pathname.slice(prefix.length, -SESSION_MESSAGE_PATH.length));
    } catch {
        // malformed percent-encoding → unknown session below
    }
    const ref = u.searchParams.get("ref") ?? "";
    if (!id || !ref) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing session id or ref" }));
        return;
    }
    const result = await buildMessageContent(id, ref);
    if (!result.ok) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: result.reason, reason: result.reason, session: id, ref }));
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
}

async function sendSessionReport(res: http.ServerResponse, url: string): Promise<void> {
    const q = new URL(url, "http://localhost").searchParams;
    const id = q.get("session");
    if (!id) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing session" }));
        return;
    }
    const detail = await buildSessionDetail(id);
    if (!detail) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `unknown session: ${id}` }));
        return;
    }
    const opts = { mask: q.get("mask") !== "off", lang: q.get("lang") === "en" ? "en" : "zh-CN" };
    if (q.get("format") === "svg") {
        const r = buildSessionReportSvg(detail, opts);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ svg: r.svg, w: r.w, h: r.h }));
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ md: buildSessionReportMd(detail, opts) }));
}
