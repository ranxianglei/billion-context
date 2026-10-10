import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { CompressionCore, Config } from "acp-kernel";
import { getAuditOfflineReport } from "../audit-offline.js";
import { APIG_RESIGN_SCHEME, KNOWN_SIGNATURE_SCHEMES, readPendingRefusals, unresolvedRefusals } from "../apig-resign.js";
import { handleAcpCache, readKeySwitchStats, readModelSwitchStats, readPromptSwitchStats } from "../cache-ledger.js";
import type { ProxyOptions } from "../config.js";
import { loadNamedProviders, loadOptions, loadRoutes, resolveResignSettings } from "../config.js";
import { applyCompressSettings } from "../compress-settings.js";
import { clearConflictEvents, summarizeConflicts } from "../conflict-watch.js";
import { cannotResolveTarget, getAdvisoryState } from "../advisory.js";
import { detectCostAdvisories } from "../plugin-advisory.js";
import { fetchWithTimeout } from "../fetch-util.js";
import { log as loggerLog, getLogPath } from "../logger.js";
import { getBlindTunnelStats } from "../mitm.js";
import { handlePluginCompact, handlePluginFork, handlePluginManifest, handlePluginRegister, handlePluginRuntimeInfo, handlePluginSessionName, handlePluginSnapshot, handlePluginStatus, handlePluginTool } from "../plugin.js";
import { parseAgentProviderReport, recordAgentProviders, agentProviderRecipes } from "../agent-providers.js";
import { defaultLogFile } from "../paths.js";
import { getUnrecognizedPathStats } from "./observability.js";
import { BodyTooLargeError, headerValue, readBody, selfAdminProbePath } from "../server.js";
import { listSessions, splitSessionWarnings, totalInFlight } from "../session.js";
import { BILI_TUNNEL_HEADER } from "../tunnel-guard.js";
import { isLoopbackAddress } from "../util.js";
import { clearUpstreamAlertsForHost, getUpstreamAlerts } from "../upstream-alerts.js";
import { formatUpstreamError, getUpstreamConnectionStatus, proxyDispatcher, recordUpstreamConnection, resetProxyCache, resolveProxyDecision } from "../upstream-proxy.js";
import { detectStaleInstall } from "../update.js";
import { PACKAGE_NAME, VERSION, BUILD_COMMIT } from "../version.js";
import { buildOverview, buildSessionDetail, buildSessionList, buildSessionPage, handleConfigGet, handleConfigPut, hiddenEmptyCount, renderUI } from "../web/index.js";
import { queryLogLines } from "../web/logs-query.js";

interface AdminCtx {
    opts: ProxyOptions;
    core: CompressionCore;
    config: Config;
    log: (level: string, msg: string) => void;
    instanceId: string;
    instanceStartedAt: number;
    proxyWatchers: Set<number>;
    initialWatcherPid: number | null;
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
function adminTrustedHostnames(bindHost: string): Set<string> {
    const names = ["localhost", "127.0.0.1", "::1"];
    const bound = normalizeAdminHostname(bindHost);
    if (bound && bound !== "0.0.0.0" && bound !== "::" && !names.includes(bound)) {
        names.push(bound);
    }
    return new Set(names);
}

// #2170 split-session canary: one log line per conversation base per process.
const splitWarnedBases = new Set<string>();

export async function handleAdminRoute(req: http.IncomingMessage, res: http.ServerResponse, ctx: AdminCtx): Promise<void> {
    const { opts, core, config, log, instanceId, instanceStartedAt, proxyWatchers, initialWatcherPid } = ctx;
    // SECURITY: the /__bili/ management endpoints (config read/write, reload,
    // session stats) are privileged — a remote caller who can reach them can
    // rewrite upstream routing to exfiltrate API keys (MITM). Restrict them
    // to loopback connections. The proxy default host is 127.0.0.1 (loopback
    // only), but a user can set --host 0.0.0.0 to share the proxy on a LAN —
    // in that case we still must NOT expose management to the LAN. Only the
    // proxy /bili/ and CONNECT (model traffic) endpoints remain open to all.
    // #1073: an absolute-form request addressed to THIS instance's own endpoint
    // is a fetch of us, not a tunnel — strip the authority so the admin gate
    // below sees a normal origin-form request and answers with real health
    // state instead of 403ing via the tunnel path.
    const selfProbePath = selfAdminProbePath(req.url ?? "", req.socket.localPort);
    if (selfProbePath !== undefined) req.url = selfProbePath;
    const isAdminPath = req.url === "/__bili/" || req.url?.startsWith("/__bili/") || req.url === "/__acp/" || req.url?.startsWith("/__acp/");
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
    if (req.method === "GET" && req.url === "/__bili/status") return sendStatus(res, opts);
    if (req.method === "GET" && req.url === "/__bili/resign") return sendResignStatus(res);
    if (req.method === "GET" && req.url === "/__bili/audit/offline") return sendAuditOffline(res);
    if (req.method === "GET" && req.url === "/__bili/overview") return sendOverview(res, opts);
    if (req.method === "GET" && (req.url === "/__bili/sessions" || req.url?.startsWith("/__bili/sessions?"))) return sendWebSessions(res, req);
    if (req.method === "GET" && req.url?.startsWith("/__bili/logs")) return sendWebLogs(res, req);
    if (req.method === "GET" && req.url?.startsWith("/__bili/sessions/") && req.url.endsWith("/detail")) return sendWebSessionDetail(res, req.url);
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
    if (req.method === "GET" && req.url === "/__bili/health") {
        res.writeHead(200, { "content-type": "application/json" });
        // #1322: watchdog state is part of the health contract — attachers and
        // operators can see whether this proxy dies with its sessions (armed)
        // or outlives them all (daemon squatting a stable port).
        res.end(JSON.stringify({ ok: true, upstream: opts.upstream, version: VERSION, commit: BUILD_COMMIT, instanceId, pid: process.pid, startedAt: instanceStartedAt, blindTunnels: getBlindTunnelStats(), watchdog: { armed: initialWatcherPid !== null, parentPid: initialWatcherPid ?? undefined, watchers: [...proxyWatchers] } }));
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
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderUI(origin, { embed: u.searchParams.get("embed") === "1", theme }));
        return;
    }
    if (req.method === "GET" && req.url === "/__bili/config") return handleConfigGet(res);
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
            if (fresh.allowDshCompaction !== opts.allowDshCompaction) {
                log(
                    fresh.allowDshCompaction ? "warn" : "info",
                    `[dsh-compaction] ${fresh.allowDshCompaction ? "dsh native compaction ALLOWED via web config — landed checkpoints durably shadow the raw history (#2028)" : "dsh native compaction interception restored via web config (#2028)"}`,
                );
            }
            opts.allowDshCompaction = fresh.allowDshCompaction;
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
        const proxyUrl = resolveProxyDecision(opts.routes, opts.proxy, target, opts.proxyFallback).proxy;
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
            recordUpstreamConnection(targetUrl, proxyUrl, error);
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: formatUpstreamError(error, targetUrl, proxyUrl) }));
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
        return handlePluginManifest(res, applyCompressSettings(config, opts.modelContextLimit, opts.compress, { ...agentProviderRecipes(), ...opts.namedProviders ?? {} }));
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
        return handlePluginStatus(conversationId, res, { core, config, log, webOrigin }, params.get("fallback") === "latest");
    }
    if (req.method === "POST" && req.url === "/__bili/watcher") {
        // #7: an ATTACHING claude session registers its host pid so the shared
        // proxy outlives the first spawner's exit. Only proxies started in
        // parent-watch mode (BILI_PARENT_PID) take watchers — daemons stay
        // daemons, and a rejected registration leaves behavior unchanged.
        try {
            const body = await readBody(req);
            const parsed = JSON.parse(body.toString("utf8")) as { pid?: unknown };
            const pid = parsed.pid;
            if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "expected { pid: <integer> }" }));
            } else if (initialWatcherPid === null) {
                res.writeHead(409, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "watchdog not armed (no parent pid) — this proxy does not take watchers" }));
            } else {
                proxyWatchers.add(pid);
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
        try {
            const body = await readBody(req);
            const report = parseAgentProviderReport(JSON.parse(body.toString("utf8")));
            recordAgentProviders(report.agent, report.providers);
            log("info", `[agent-providers] ${report.agent} registered: ${Object.keys(report.providers).sort().join(", ")} (#2336)`);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, agent: report.agent, providers: Object.keys(report.providers) }));
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
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
    // upstream (which 403s it) — #346.
    if (isAdminPath) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "not_found", message: "no such management endpoint" } }));
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

function sendStats(res: http.ServerResponse): void {
    const all = listSessions();
    const sessions = all.map((s) => {
        const sw = readModelSwitchStats(s);
        const ks = readKeySwitchStats(s);
        const ps = readPromptSwitchStats(s);
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

/** Stale-install state for the web UI badge (#811): whether the on-disk
 *  version is newer than the running process, plus the opt-in flag state and
 *  the live in-flight request count. */
async function sendStatus(res: http.ServerResponse, opts: ProxyOptions): Promise<void> {
    let diskVersion: string | undefined;
    let stale = false;
    try {
        ({ diskVersion, stale } = await detectStaleInstall(PACKAGE_NAME, VERSION));
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
    res.end(JSON.stringify({ version: VERSION, commit: BUILD_COMMIT, diskVersion, stale, autoRestartOnUpdate: opts.autoRestartOnUpdate, advisory: currentAdvisoryPayload(), pluginAdvisories: detectCostAdvisories(process.env), inFlight: totalInFlight(), splitSessions: splitWarnings, conflicts: summarizeConflicts(listSessions()) }, null, 2));
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

// #2504 switch A — counts-only readout for the offline audit lane. Inherits
// every gate above (loopback + trusted origin + tunnel marker); content never
// leaves the sessions dir — only token/file counts are reported here.
function sendAuditOffline(res: http.ServerResponse): void {
    const report = getAuditOfflineReport();
    if (report === null) {
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "pending", note: "offline audit scan not completed yet for this process (audit.offline.enabled off, or scan still running)" }, null, 2));
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(report, null, 2));
}

async function sendOverview(res: http.ServerResponse, opts: ProxyOptions): Promise<void> {
    let diskVersion: string | undefined;
    let stale = false;
    try {
        ({ diskVersion, stale } = await detectStaleInstall(PACKAGE_NAME, VERSION));
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
        autoRestartOnUpdate: opts.autoRestartOnUpdate,
        advisory: currentAdvisoryPayload(),
        pluginAdvisories: detectCostAdvisories(process.env),
        inFlight: totalInFlight(),
        blindTunnels: getBlindTunnelStats(),
        conflicts: summarizeConflicts(listSessions()),
        passthrough: { enabled: !!opts.passthrough, source: opts.passthroughSource },
        alerts: getUpstreamAlerts(),
    }, null, 2));
}

/** #1937: optional ?q= / ?page= / ?pageSize= (≤200) switch the endpoint to
 *  server-side filtered paging. Without params the response shape is unchanged
 *  ({sessions, hiddenEmpty} + additive total) so older UIs keep working. */
async function sendWebSessions(res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const u = new URL(req.url ?? "/__bili/sessions", "http://localhost");
    let body: Record<string, unknown>;
    try {
        if (u.searchParams.has("page") || u.searchParams.has("pageSize") || u.searchParams.has("q")) {
            const rawSize = Number(u.searchParams.get("pageSize"));
            const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? Math.min(Math.floor(rawSize), 200) : 50;
            const rawPage = Number(u.searchParams.get("page"));
            const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
            body = { ...(await buildSessionPage({ q: u.searchParams.get("q") ?? undefined, page, pageSize })), hiddenEmpty: hiddenEmptyCount() };
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
