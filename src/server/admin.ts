// Ops-admin surface of the bili proxy (the /__bili/ management endpoints plus
// the loopback/trusted-origin gate protecting them). Extracted verbatim from
// src/server.ts — #1440 P2 four-cut disassembly, cut 1 (pure move, zero logic
// change). handle() calls handleAdminRequest() first; a true return means the
// request was an admin/root path and was fully answered here.

import http from "node:http";
import { loadOptions, loadRoutes, type ProxyOptions } from "../config.js";
import { fetchWithTimeout } from "../fetch-util.js";
import { getBlindTunnelStats } from "../mitm.js";
import { listSessions, totalInFlight } from "../session.js";
import { buildSessionCacheReport } from "../cache-ledger.js";
import { summarizeConflicts } from "../conflict-watch.js";
import { detectStaleInstall } from "../update.js";
import { PACKAGE_NAME, VERSION } from "../version.js";
import { formatUpstreamError, getUpstreamConnectionStatus, proxyDispatcher, recordUpstreamConnection, resolveProxyDecision, resetProxyCache } from "../upstream-proxy.js";
import { BILI_TUNNEL_HEADER, localMachineIps, normalizeIpLiteral } from "../tunnel-guard.js";
import { headerValue, isLoopbackAddress } from "../util.js";
import { getUnrecognizedPathStats } from "./observability.js";
import { handleConfigGet, handleConfigPut, renderUI } from "../web/index.js";

/** True for bili's own management prefixes (#346): never forwarded upstream. */
export function adminPathMatches(url: string | null | undefined): boolean {
    const u = url ?? "";
    return u === "/__bili/" || u.startsWith("/__bili/") || u === "/__acp/" || u.startsWith("/__acp/");
}

export async function handleAdminRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts: ProxyOptions,
    log: (level: string, msg: string) => void,
    ctx: {
        instanceId: string;
        instanceStartedAt: number;
        proxyWatchers: Set<number>;
        initialWatcherPid: number | null;
    },
): Promise<boolean> {
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
    const isAdminPath = adminPathMatches(req.url);
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
        return true;
    }
    if (isAdminPath && !isLoopbackAddress(req.socket.remoteAddress)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "management endpoints are loopback-only; access denied for " + (req.socket.remoteAddress ?? "unknown") }));
        return true;
    }
    // localPort, not opts.port: when listening on port 0 (dynamic assignment,
    // programmatic embedding, tests) the real port differs from opts.port and
    // pinning to the configured value would 403 every admin request.
    if (isAdminPath && !isTrustedAdminOrigin(req.headers.origin, req.headers.host, adminTrustedHosts(opts.host, req.socket.localPort ?? opts.port))) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "management request origin does not match the local bili UI" }));
        return true;
    }
    if (req.method === "GET" && req.url === "/__bili/stats") {
        sendStats(res);
        return true;
    }
    if (req.method === "GET" && req.url?.startsWith("/__bili/cache-report")) {
        sendCacheReport(res, req.url);
        return true;
    }
    if (req.method === "GET" && req.url === "/__bili/status") {
        await sendStatus(res, opts);
        return true;
    }
    if (req.method === "GET" && req.url === "/") {
        // Browser visits root → redirect to the web UI. curl / health probes
        // (Accept: */* or no Accept) still get the JSON health check so
        // existing scripts and Docker-style health probes keep working.
        const accept = req.headers.accept ?? "";
        if (accept.includes("text/html")) {
            res.writeHead(302, { location: "/__bili/" });
            res.end();
            return true;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, upstream: opts.upstream }));
        return true;
    }
    if (req.method === "GET" && req.url === "/__bili/health") {
        res.writeHead(200, { "content-type": "application/json" });
        // #1322: watchdog state is part of the health contract — attachers and
        // operators can see whether this proxy dies with its sessions (armed)
        // or outlives them all (daemon squatting a stable port).
        res.end(JSON.stringify({ ok: true, upstream: opts.upstream, instanceId: ctx.instanceId, pid: process.pid, startedAt: ctx.instanceStartedAt, blindTunnels: getBlindTunnelStats(), watchdog: { armed: ctx.initialWatcherPid !== null, parentPid: ctx.initialWatcherPid ?? undefined, watchers: [...ctx.proxyWatchers] } }));
        return true;
    }
    // Web config UI (served as HTML, separate from the JSON health check above).
    if (req.method === "GET" && req.url === "/__bili/") {
        const origin = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderUI(origin));
        return true;
    }
    if (req.method === "GET" && req.url === "/__bili/config") {
        handleConfigGet(res);
        return true;
    }
    if (req.method === "PUT" && req.url === "/__bili/config") {
        handleConfigPut(req, res, () => {
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
        }, opts.port);
        return true;
    }
    if (req.method === "POST" && req.url === "/__bili/config/reload") {
        handleConfigReload(opts, res, log);
        return true;
    }
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
        return true;
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
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, status: result.response.status, target: targetUrl, proxy: proxyUrl ?? null }));
        } catch (error) {
            recordUpstreamConnection(targetUrl, proxyUrl, error);
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: formatUpstreamError(error, targetUrl, proxyUrl) }));
        }
        return true;
    }

    return false;
}

export function selfAdminProbePath(reqUrl: string, localPort: number | undefined): string | undefined {
    if (!reqUrl.startsWith("http://") && !reqUrl.startsWith("https://")) return undefined;
    if (localPort === undefined) return undefined;
    try {
        const u = new URL(reqUrl);
        const port = u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
        if (port !== localPort) return undefined;
        const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        const mine = host === "0.0.0.0" || host === "::" || host === "localhost" || localMachineIps().has(normalizeIpLiteral(host));
        if (!mine) return undefined;
        const p = u.pathname;
        if (p === "/__bili/" || p.startsWith("/__bili/") || p === "/__acp/" || p.startsWith("/__acp/")) return p + u.search;
    } catch {
        // malformed absolute URL — not a probe
    }
    return undefined;
}

function isTrustedAdminOrigin(origin: string | undefined, host: string | undefined, trustedHosts: Set<string>): boolean {
    // Host must be one of OUR listen identities regardless of whether an
    // Origin header is present. A same-origin browser GET/fetch (the DNS
    // rebinding read path: evil.com → 127.0.0.1) often carries NO Origin
    // header, so gating on Origin alone would leave config reads exposed.
    if (!host || !trustedHosts.has(host.toLowerCase())) return false;
    if (!origin) return true; // non-browser client (curl, CLI UI) on a trusted Host
    try {
        const parsed = new URL(origin);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
        return trustedHosts.has(parsed.host.toLowerCase());
    } catch {
        return false;
    }
}

/** The set of Host header values we accept on management endpoints. DNS
 *  rebinding (attacker resolves evil.com → 127.0.0.1) can make a browser
 *  request carry Origin == Host == evil.com:port and still reach loopback;
 *  only pinning Host to our own listen address defeats it. */
function adminTrustedHosts(bindHost: string, port: number): Set<string> {
    const p = String(port);
    const names = ["localhost", "127.0.0.1", "[::1]"];
    if (bindHost && bindHost !== "0.0.0.0" && bindHost !== "::" && !names.includes(bindHost)) {
        names.push(bindHost);
    }
    const set = new Set<string>();
    for (const n of names) {
        set.add(`${n}:${p}`.toLowerCase());
        if (p === "80") set.add(n.toLowerCase());
    }
    return set;
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
    const reloaded = loadOptions();
    opts.compress = reloaded.compress;
    opts.compat = reloaded.compat;
    opts.imageBilling = reloaded.imageBilling;
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
    res.end(JSON.stringify({ reports: sessions.map((s) => ({ id: s.id, report: buildSessionCacheReport(s) })) }, null, 2));
}

function sendStats(res: http.ServerResponse): void {
    const all = listSessions();
    const sessions = all.map((s) => ({
        id: s.id,
        protocol: s.meta.protocol,
        upstream: s.meta.upstreamOrigin,
        label: s.meta.label,
        title: s.meta.title,
        requests: s.stats.requests,
        contextTokens: s.stats.contextTokens,
        inputTokens: s.stats.inputTokens,
        cachedTokens: s.stats.cachedTokens,
        outputTokens: s.stats.outputTokens,
        cacheSamples: s.stats.cacheSamples,
        cacheHitPct: s.stats.cacheSamples > 0 && s.stats.inputTokens > 0 ? Math.round(s.stats.cachedTokens / s.stats.inputTokens * 100) : null,
        // #901: window credibility — trusted (configured/registry) window vs the
        // largest input recent successful turns actually got through. A wide gap
        // means the provider overstates its window.
        contextWindow: typeof s.metadata.effectiveContextLimit === "number" ? s.metadata.effectiveContextLimit : undefined,
        lastSeen: new Date(s.lastSeen).toISOString(),
        restored: s.restored === true,
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions, blindTunnels: getBlindTunnelStats(), unrecognizedPaths: getUnrecognizedPathStats(), conflicts: summarizeConflicts(all) }, null, 2));
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
    res.end(JSON.stringify({ version: VERSION, diskVersion, stale, autoRestartOnUpdate: opts.autoRestartOnUpdate, inFlight: totalInFlight(), conflicts: summarizeConflicts(listSessions()) }, null, 2));
}
