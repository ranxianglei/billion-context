import http from "node:http";
import fs from "node:fs";
import { createCore, type CompressionCore, type Config, type CoreMessage, type NudgeDecision, type Prompts, defaultPrompts, estimateTokensFast, renderNudgeText, deactivateBlock, viableRanges } from "acp-kernel";
import { resolveCompress, resolveCompressPrompts, resolveRequestConfig } from "./compress-settings.js";
import type { ProxyOptions } from "./config.js";
import { loadOptions, loadRoutes } from "./config.js";
import { resetProxyCache } from "./upstream-proxy.js";
import { resolveContextLimit, resolveCompressProtocol } from "./config.js";
import { contextFromRegistry, loadRegistry } from "./registry.js";
import { fetchWithTimeout, MAX_REQUEST_BYTES } from "./fetch-util.js";
import { formatUpstreamError, getUpstreamConnectionStatus, recordUpstreamConnection, resolveProxy, resolveProxyDecision, proxyDispatcher } from "./upstream-proxy.js";
// Protocol codecs live in the kernel now (single source of truth shared with
// the omp/pi adapters): import from "acp-kernel/wire".
import {
    anthropicToCore,
    coreToAnthropic,
    conversationSignalAnthropic,
    extractSystem,
    buildSystem,
    type AnthropicRequestBody,
} from "acp-kernel/wire";
import {
    openaiToCore,
    coreToOpenai,
    injectOpenaiSystem,
    conversationSignalOpenai,
    type OpenAIRequestBody,
    type OpenAITool,
} from "acp-kernel/wire";
import {
    type ResponsesRequestBody,
    type ResponseInputItem,
    type ResponsesProjection,
    responsesToCore,
    patchResponsesInput,
    injectResponsesDeveloperMessage,
    conversationIdentityResponses,
    conversationSignalResponses,
    subagentNamespace,
} from "acp-kernel/wire";
import { getSession, listSessions, type Session, initSessions, markDirty, flushAllSessions, acquireInFlight, releaseInFlight, withSessionLock, markNativeCompactionBoundary, reconcileNativeCompactionBoundary, snapshotMessages } from "./session.js";
import { COMPRESS_TOOL, ACP_TOOLS_ANTHROPIC, ACP_TOOLS_OPENAI, ACP_TOOLS_RESPONSES, ACP_READONLY_TOOLS_RESPONSES, COMPRESS_TOOL_NAME, buildCompressSystemPrompt, buildCompressHybridSystemPrompt } from "./compress-tool.js";
import { rewriteSseStream, rewriteJsonResponse, type RewriteCtx } from "./stream.js";
import { applyRanges } from "./stream.js";
import { renderUI, handleConfigGet, handleConfigPut } from "./web/index.js";
import { reapOrphanBlocks } from "./orphan-gc.js";
import { getStore } from "./persist.js";
import { log as loggerLog, configureLogger, getLogPath, closeLogger } from "./logger.js";
import { defaultLogFile, stateDir, proxyOriginFile } from "./paths.js";
import { compressLoopResponsesJson } from "./compress-loop-responses.js";
import { runCompressLoop, pickAdapter } from "./loop/index.js";
import { rewriteOpenaiJsonResponse } from "./stream-openai.js";
import { rewriteResponsesJsonResponse } from "./stream-responses.js";
import { emitStreamError } from "./stream-error.js";
import { deriveSessionId as deriveProxySessionId, affinityToken, clientConversationHeader, type ConversationIdentity } from "./session-id.js";
import { consumePluginRegisterFor, flushConversations, handlePluginManifest, handlePluginRegister, handlePluginStatus, handlePluginTool, loadConversations, pipePluginJson, pipeThroughWithUsage, pluginAgentHeader, pluginConversationHeader, pluginReportedContextWindow, recordPluginSession, rememberPluginMessages, takePendingPluginRegister } from "./plugin.js";
import { setupMitm, readMitmUpstream } from "./mitm.js";
import type { BiliMessage } from "acp-kernel/wire";
import { isLoopbackAddress, inspectContextOverflow, reserveOutputHeadroom, shouldReserveOutputHeadroom, usageTotals } from "./util.js";

import { decodeRequestBody } from "./content-encoding.js";

const UPSTREAM_HOP_HEADERS = new Set([
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    // Node's fetch transparently decodes compressed responses. Do not
    // forward the upstream encoding marker when the body is rewritten or
    // streamed from fetch, otherwise clients try to decompress plain bytes.
    "content-encoding",
    // RFC 7230 §6.1 hop-by-hop headers. proxy-authorization in particular
    // carries client→proxy credentials that must never reach the model
    // endpoint. (#80)
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "upgrade",
]);

// RFC 7230 §6.1: the Connection header names additional hop-by-hop headers
// that must be stripped per-message. Returns their lowercased names.
function connectionNamedHeaders(conn: string | string[] | undefined): Set<string> {
    const out = new Set<string>();
    if (!conn) return out;
    for (const part of Array.isArray(conn) ? conn : [conn]) {
        for (const name of part.split(",")) {
            const t = name.trim().toLowerCase();
            if (t) out.add(t);
        }
    }
    return out;
}

function buildForwardHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === "content-length" || k.toLowerCase() === "host") continue;
        out[k] = v;
    }
    out["content-type"] = "application/json";
    return out;
}

export function resolveUpstream(_opts: ProxyOptions, reqUrl: string, req?: http.IncomingMessage): { upstream: string; rewrittenUrl: string; explicitProtocol?: "openai" | "anthropic" | "responses" } | undefined {
    // MITM mode: the request arrived over a CONNECT tunnel we terminated
    // locally (client set HTTP_PROXY and issued CONNECT host:443). The socket
    // carries the real upstream origin; the request path has no /bili/ prefix
    // — it's a bare /api/anthropic/v1/messages. Reconstruct the full upstream
    // URL so handle()/forward() route to the host the CONNECT targeted. The
    // client's Authorization header (OAuth token for the subscription) is
    // forwarded verbatim → subscription auth preserved, no MITM of creds.
    const mitmUpstream = readMitmUpstream(req?.socket);
    if (mitmUpstream) {
        // Use a `mitm://` scheme in rewrittenUrl so per-URL config (proxy,
        // context overrides) can DISTINGUISH MITM traffic from /bili/ path
        // traffic to the SAME host. The real upstream stays https:// (in
        // `upstream`) for the actual fetch; forward() strips the mitm:// scheme
        // back to https:// before calling fetch (fetch would reject mitm://).
        // Mapping is bijective: mitm://<host><path> ⟺ https://<host><path>.
        const mitmKey = mitmUpstream.replace(/^https:\/\//, "mitm://");
        return { upstream: mitmUpstream, rewrittenUrl: mitmKey + (reqUrl ?? "") };
    }
    // Zero-config mode: a request like `/bili/https://open.bigmodel.cn/api/anthropic`
    // embeds the full upstream URL after the `/bili/` prefix. Strip the prefix,
    // take the rest verbatim as the upstream. This is the ONLY routing mode —
    // there are no named providers. The `/bili/` prefix doubles as a signal:
    // client-side billion-context extensions (billion-context-pi / opencode-acp)
    // can detect it in their own baseUrl and self-disable, avoiding double
    // compression.
    const KNOWN_PROTOCOLS = ["responses", "anthropic", "openai"] as const;
    if (reqUrl.startsWith("/bili/")) {
        let rest = reqUrl.slice(6);
        let explicitProtocol: "openai" | "anthropic" | "responses" | undefined;
        for (const p of KNOWN_PROTOCOLS) {
            const prefix = `${p}/`;
            if (rest.startsWith(prefix + "http://") || rest.startsWith(prefix + "https://")) {
                explicitProtocol = p;
                rest = rest.slice(prefix.length);
                break;
            }
        }
        if (rest.startsWith("http://") || rest.startsWith("https://")) {
            try {
                const u = new URL(rest);
                return { upstream: `${u.protocol}//${u.host}`, rewrittenUrl: rest, explicitProtocol };
            } catch {
                // malformed embedded URL
            }
        }
    }
    return undefined;
}

export async function startServer(opts: ProxyOptions): Promise<http.Server> {
    // Configure the tee logger (file + stderr) BEFORE any logging so the very
    // first line (persist status) lands in the file too.
    const filePath = configureLogger(opts.logFile ?? defaultLogFile());
    const core = createCore();
    const config: Config = opts.kernelConfig;
    const log = (level: string, msg: string) => logMsg(opts, level, msg);
    // Reload persisted compression state before accepting traffic so sessions
    // that survived a restart keep their folded view (otherwise long sessions
    // re-send oversized raw history and hang).
    await initSessions();
    loadConversations();
    log("info", `[persist] ${getStore().enabled ? "enabled" : "disabled"}`);
    if (filePath) {
        log("info", `[log] writing to ${filePath}`);
    }
    // Pre-fetch the models.dev registry in the background (non-blocking). Used
    // as the context-window source for zero-config `/p/` routes that have no
    // per-model config. A miss falls back to the prefix table + default.
    void loadRegistry();
    const server = http.createServer(async (req, res) => {
        try {
            await handle(req, res, opts, core, config, log);
        } catch (err) {
            const msg = String(err);
            log("error", msg);
            if (!res.headersSent) {
                const status = msg.includes("exceeds") ? 413 : 502;
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "acp-proxy failure", detail: msg }));
            } else {
                res.end();
            }
        }
    });
    // Bili does not support WebSocket. An explicit 'upgrade' listener is
    // required: without one Node's behavior is version-dependent (some
    // versions destroy the socket with no response), delaying clients with
    // built-in fast-fallback (e.g. Codex) that need a clean 426 to switch to
    // HTTP POST immediately.
    server.on("upgrade", (req, socket) => {
        log("info", `[ws] rejected ${req.method} ${req.url ?? ""} host=${req.headers.host ?? "?"} with 426`);
        socket.on("error", () => {}); // client may vanish mid-write; don't let ECONNRESET crash the process
        const body = JSON.stringify({ error: "WebSocket upgrades are not supported; use HTTP POST" });
        socket.end(
            "HTTP/1.1 426 Upgrade Required\r\n" +
                "Connection: close\r\n" +
                "Content-Type: application/json\r\n" +
                `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                "\r\n" +
                body,
        );
    });
    if (opts.mitm.enabled) {
        setupMitm(server, opts.mitm.domains, (msg) => log("info", msg), (host) => resolveProxy(opts.routes, opts.proxy, `https://${host}`, opts.proxyFallback));
    }
    server.listen(opts.port, opts.host, () => {
        const displayHost = opts.host === "0.0.0.0" ? "localhost" : opts.host;
        try {
            fs.mkdirSync(stateDir(), { recursive: true });
            // Discovery origin local MCP shells dial: collapse wildcard
            // binds to loopback (localhost may resolve to ::1, where an
            // IPv4-only listener is absent) and bracket bare IPv6 literals
            // so the file always holds a valid URL.
            const originHost = opts.host === "0.0.0.0" || opts.host === "::" || opts.host === "localhost" ? "127.0.0.1" : opts.host.includes(":") && !opts.host.startsWith("[") ? `[${opts.host}]` : opts.host;
            fs.writeFileSync(proxyOriginFile(), `http://${originHost}:${server.address() === null ? opts.port : (server.address() as { port: number }).port}\n`);
        } catch {
            // best-effort discovery hint for host-spawned MCP shells
        }
        const nOverrides = Object.keys(opts.routes).length;
        log(
            "info",
            `acp-proxy listening on http://${displayHost}:${opts.port}` +
                ` — web UI: http://${displayHost}:${opts.port}/__bili/` +
                ` — zero-config: prefix any baseURL with http://${displayHost}:${opts.port}/bili/` +
                (nOverrides ? ` — context overrides for ${nOverrides} upstream URL(s)` : "")
                + (opts.mitm.enabled ? ` — MITM proxy on (whitelist)${opts.mitm.domains.length ? ` +${opts.mitm.domains.join(",")}` : ""}` : ""),
        );
        if (opts.debug) {
            log("info", `[debug] build features: raw-HTTP-capture(on) | remote_compaction_v2-strip(on) | cert-MITM-launcher(on) | strip-acp-summary(on) — seeing this line confirms the launcher build (not registry 0.1.34)`);
        }
    });
    // Listen errors (EADDRINUSE port taken, EACCES privileged port, EAFNOSUPPORT
    // bad host) surface as an 'error' event on the server. Without a listener
    // Node treats it as an unhandled 'error' and throws, aborting before the
    // graceful-shutdown flush can run. Catch, log a human-readable message,
    // flush sessions, and exit cleanly (exit code 1 so callers/scripts notice).
    server.on("error", (err: NodeJS.ErrnoException) => {
        const hint =
            err.code === "EADDRINUSE"
                ? ` — port ${opts.port} is already in use. Stop the other process or use --port <N>.`
                : err.code === "EACCES"
                  ? ` — port ${opts.port} requires privileges. Use a port >= 1024.`
                  : "";
        log("error", `listen failed: ${err.code ?? ""} ${err.message}${hint}`);
        shuttingDown = true;
        server.close();
        flushConversations();
        void flushAllSessions().finally(() => {
            closeLogger();
            process.exit(1);
        });
    });
    // Catch stray rejections/throws from background work (compress loops,
    // auto-update, initSessions) that escape the per-request try/catch —
    // Node 20+ aborts the process on these by default. Log loudly and flush.
    process.on("uncaughtException", (err) => {
        log("error", `uncaughtException: ${String(err?.stack ?? err)}`);
    });
    process.on("unhandledRejection", (reason) => {
        log("error", `unhandledRejection: ${String(reason)}`);
    });
    // Graceful shutdown: flush all dirty sessions to disk so a restart does
    // not lose recent compression state. SIGKILL/power loss cannot flush, but
    // debounced writes keep disk within ~500ms of in-memory state.
    let shuttingDown = false;
    const shutdown = (sig: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log("info", `${sig} received — flushing sessions…`);
        // Stop accepting new requests BEFORE flushing, otherwise a late request
        // could mutate state after its snapshot is taken and be lost.
        // server.close(cb) waits for all keep-alive connections to drain
        // before invoking cb, so in-flight SSE streams get a chance to finish
        // rather than being yanked mid-chunk.
        server.close(() => {
            flushConversations();
            void flushAllSessions().finally(() => {
                closeLogger();
                process.exit(0);
            });
        });
        // Hard fallback: if connections hang (client never closes), don't
        // block shutdown forever — force-exit after a grace window.
        setTimeout(() => {
            log("warn", "shutdown grace window elapsed; forcing exit");
            flushConversations();
            void flushAllSessions().finally(() => {
                closeLogger();
                process.exit(0);
            });
        }, 10_000).unref?.();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    // Windows never delivers SIGTERM (Node can listen but the kernel won't
    // raise it). Ctrl+Break (and most service managers / `taskkill` / NSSM)
    // raise SIGBREAK, so hook it to the same graceful-shutdown path there.
    if (process.platform === "win32") {
        process.on("SIGBREAK", () => shutdown("SIGBREAK"));
    }
    return server;
}

type Prepared = {
    body: string | Buffer;
    session: Session;
    processedMessages: CoreMessage[];
    /** Original CoreMessages from the protocol conversion, BEFORE processTurn
     *  folded/replaced anything. compress/decompress/acp_status need the raw
     *  text (collectBlockContent reads message text by id); processedMessages
     *  has compressed messages replaced with placeholders → empty content. */
    originalMessages: CoreMessage[];
    protocol: "anthropic" | "openai" | "responses";
    stream: boolean;
    compressInjected: boolean;
    /** True when the session is driven by a cooperative agent-side plugin
     *  (x-bili-plugin header, see src/plugin.ts): tools are native, the
     *  response must pass through verbatim, and usage is sniffed instead of
     *  captured by the compress loop. */
    pluginMode?: boolean;
    responsesTextProtocol?: boolean;
    resetAfterSuccess?: boolean;
    responsesProjection?: ResponsesProjection;
    anthropicSystem?: AnthropicRequestBody["system"];
    /** Original leading system/developer prefix text captured by the kernel's
     *  openai hoist (0.0.37). The fold space no longer carries it, so every
     *  rebuilt payload and compress-loop round must re-inject it. */
    openaiSystemText?: string;
    nudge?: NudgeDecision;
    /** Effective compression prompts for this request (three-level cascade,
     *  defaults to the kernel's defaultPrompts). Carried so the compress loop
     *  in forward() rebuilds the SAME system prompt the request was prepared
     *  with. */
    prompts?: Prompts;
};


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

async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
): Promise<void> {
    // SECURITY: the /__bili/ management endpoints (config read/write, reload,
    // session stats) are privileged — a remote caller who can reach them can
    // rewrite upstream routing to exfiltrate API keys (MITM). Restrict them
    // to loopback connections. The proxy default host is 127.0.0.1 (loopback
    // only), but a user can set --host 0.0.0.0 to share the proxy on a LAN —
    // in that case we still must NOT expose management to the LAN. Only the
    // proxy /bili/ and CONNECT (model traffic) endpoints remain open to all.
    const isAdminPath = req.url === "/__bili/" || req.url?.startsWith("/__bili/") || req.url === "/__acp/" || req.url?.startsWith("/__acp/");
    if (isAdminPath && !isLoopbackAddress(req.socket.remoteAddress)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "management endpoints are loopback-only; access denied for " + (req.socket.remoteAddress ?? "unknown") }));
        return;
    }
    // localPort, not opts.port: when listening on port 0 (dynamic assignment,
    // programmatic embedding, tests) the real port differs from opts.port and
    // pinning to the configured value would 403 every admin request.
    if (isAdminPath && !isTrustedAdminOrigin(req.headers.origin, req.headers.host, adminTrustedHosts(opts.host, req.socket.localPort ?? opts.port))) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "management request origin does not match the local bili UI" }));
        return;
    }
    if (req.method === "GET" && req.url === "/__bili/stats") return sendStats(res);
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
        res.end(JSON.stringify({ ok: true, upstream: opts.upstream }));
        return;
    }
    // Web config UI (served as HTML, separate from the JSON health check above).
    if (req.method === "GET" && req.url === "/__bili/") {
        const origin = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderUI(origin));
        return;
    }
    if (req.method === "GET" && req.url === "/__bili/config") return handleConfigGet(res);
    if (req.method === "PUT" && req.url === "/__bili/config") {
        return handleConfigPut(req, res, () => {
            const fresh = loadOptions();
            opts.proxy = fresh.proxy;
            opts.proxyMode = fresh.proxyMode;
            opts.proxySource = fresh.proxySource;
            opts.proxyFallback = fresh.proxyFallback;
            opts.compress = fresh.compress;
            resetProxyCache();
            for (const k of Object.keys(opts.routes)) delete opts.routes[k];
            Object.assign(opts.routes, loadRoutes());
        }, opts.port);
    }
    if (req.method === "POST" && req.url === "/__bili/config/reload") return handleConfigReload(opts, res, log);
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
                ...(proxyUrl ? { dispatcher: proxyDispatcher(proxyUrl) } : {}),
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
        return;
    }

    // Cooperative plugin protocol (see src/plugin.ts + PLUGIN.md): the
    // manifest serves the exact tool schemas the wire injector uses, and the
    // tool endpoint lets an agent-side plugin execute compress/decompress/
    // search_context/acp_status against the session the plugin drives. Both
    // live under the /__bili/ loopback + trusted-origin gate above.
    if (req.method === "GET" && req.url === "/__bili/plugin/manifest") return handlePluginManifest(res);
    if (req.method === "GET" && req.url?.startsWith("/__bili/plugin/status")) {
        const query = req.url.slice(req.url.indexOf("?") + 1);
        const conversationId = new URLSearchParams(query).get("conversationId")?.trim() ?? "";
        if (!conversationId) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "conversationId query parameter is required" }));
            return;
        }
        return handlePluginStatus(conversationId, res);
    }
    if (req.method === "POST" && req.url === "/__bili/plugin/tool") {
        try {
            const body = await readBody(req);
            return await handlePluginTool(body.toString("utf8"), res, { core, config, log });
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

    // NOTE: WebSocket upgrades are answered by the dedicated 'upgrade' listener
    // in startServer() (above), which is the only reliable path — Node routes
    // upgrade requests there and never to this request handler.
    let bodyBuffer: Buffer;
    let urlPath: string;
    let responsesCompact: boolean;
    let route: ReturnType<typeof resolveUpstream>;
    let upstreamOrigin: string;
    let protocol: "anthropic" | "openai" | "responses" | null;
    try {
        bodyBuffer = await readBody(req);
        const url = req.url ?? "";
        urlPath = url.split("?", 2)[0];
        responsesCompact = urlPath.endsWith("/responses/compact");
        route = resolveUpstream(opts, req.url ?? "", req);
        upstreamOrigin = route ? route.upstream : /^https?:\/\//i.test(url) ? new URL(url).origin : opts.upstream;
        protocol =
            route?.explicitProtocol
            ?? (req.method === "POST" && bodyBuffer.length > 0
                ? urlPath.endsWith("/chat/completions")
                    ? "openai"
                    : urlPath.endsWith("/v1/messages") || urlPath.endsWith("/messages")
                      ? "anthropic"
                      : urlPath.endsWith("/responses") || responsesCompact
                        ? "responses"
                        : null
                : null);
        // Issue #99: decode body only for known protocols — passthrough requests
        // (e.g. GET /models) must forward raw bytes without content-encoding decode.
        if (protocol !== null && bodyBuffer.length > 0) {
            const decoded = await decodeRequestBody(headerValue(req, "content-encoding"), bodyBuffer, MAX_REQUEST_BYTES);
            bodyBuffer = decoded.body;
            if (decoded.decoded) delete req.headers["content-encoding"];
        }
    } catch (err) {
        if (err instanceof BodyTooLargeError) {
            log("warn", `413: request body exceeds ${err.limit} bytes`);
            res.writeHead(413, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { type: "request_too_large", message: err.message } }));
            return;
        }
        log("warn", `read/decode body failed: ${String(err)}`);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_request", message: String(err) } }));
        return;
    }
    const countTokens = isCountTokensRequest(req.method ?? "GET", urlPath, bodyBuffer.length > 0);
    // Per-request context limit: look up body.model against the per-route model
    // declaration in providers.json first (same model can have different
    // windows behind different relays), then the built-in table. Falls back to
    // the global env default if neither matches.
    // Parse body once and reuse everywhere (fixes duplicate JSON.parse).
    let parsed: unknown = null;
    if (protocol && bodyBuffer.length > 0) {
        try {
            parsed = JSON.parse(bodyBuffer.toString("utf8"));
        } catch {
            parsed = null;
        }
    }
    // Capture the CLIENT's raw incoming request (before bili rebuilds) to
    // resolve whether codex sends previous_response_id + full input vs delta.
    if (opts.debug && parsed && typeof parsed === "object") {
        try {
            const p = parsed as Record<string, unknown>;
            const hasPrev = p.previous_response_id !== undefined;
            const inLen = Array.isArray(p.input) ? p.input.length : 0;
            log("info", `[debug] INCOMING previous_response_id=${hasPrev ? String(p.previous_response_id).slice(0, 16) : "absent"} input_items=${inLen} instructions=${p.instructions !== undefined ? "present" : "absent"}`);
            const rawDir = `${stateDir()}/raw`;
            try { fs.mkdirSync(rawDir, { recursive: true }); } catch { /* best-effort */ }
            const hdrs = Object.entries(req.headers)
                .filter(([k]) => !/authorization|x-api-key|cookie/i.test(k))
                .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(",") : v}`).join("\n");
            fs.writeFileSync(`${rawDir}/${Date.now()}-INCOMING.txt`, `${req.method} ${req.url}\n${hdrs}\n\n${bodyBuffer.toString("utf8")}`);
        } catch { /* best-effort dump */ }
    }
    // Per-request context limit + compression tuning: look up body.model against
    // the per-route model declaration first, then the built-in table / registry.
    // Compress settings (global → provider → model) merge deepest-field-wins and
    // are applied on top of the resolved limit. `compress.contextLimit` (an
    // absolute number, a "70%" string of the native window, or unset → native)
    // overrides the table.
    let reqConfig = config;
    // Effective compression prompts for this request: resolved from the same
    // three-level cascade (global → provider → model) as the limit above, then
    // threaded into every prepare* path so the system prompt, the nudge text,
    // and the compress-loop system prompt all use one consistent Prompts set
    // (kernel contract: renderNudgeText and the adapter prompt must match).
    let reqPrompts: Prompts = defaultPrompts;
    if (parsed && typeof parsed === "object") {
        const model = (parsed as { model?: string }).model;
        if (model) {
            const embeddedUrl = route?.rewrittenUrl;
            // A cooperative plugin's reported window (the agent's own config)
            // is the authoritative native window — it outranks the table and
            // the models.dev registry (most valuable in MITM mode where the
            // model may be a private relay), but operator tuning via
            // compress.modelContextLimit still outranks it inside
            // resolveRequestConfig. Gated on the x-bili-plugin marker: the
            // header is protocol-internal, and a plain client must not be
            // able to rewrite the nudge denominator by name.
            let native = pluginReportedContextWindow(req.headers) ?? resolveContextLimit(opts.routes, embeddedUrl, model);
            if (!native && embeddedUrl) {
                const host = (() => { try { return new URL(embeddedUrl).host; } catch { return undefined; } })();
                native = await contextFromRegistry(model, host);
            }
            reqConfig = resolveRequestConfig(config, opts.routes, embeddedUrl, model, native, opts.compress);
            reqPrompts = resolveCompressPrompts(resolveCompress(opts.routes, embeddedUrl, model, opts.compress));
        }
    }
    let prepared: Prepared | null = null;
    if (!opts.passthrough && protocol && parsed && typeof parsed === "object") {
        const sessionHeader = headerValue(req, opts.sessionHeader);
        // Plugin mode (issue #1, "内外呼应"): a cooperative agent-side plugin
        // announces itself with x-bili-plugin. The proxy then treats the
        // session's tool surface as NATIVE (plugin-registered from the
        // manifest) — wire tool injection is suppressed and the compress loop
        // never intercepts proxy-named tool calls. Philosophy prompt + nudge
        // keep flowing from here; state + folding stay proxy-owned.
        //
        // Launcher mode (#162) is the header-less variant: hosts that cannot
        // attach per-request headers (claude/codex spawned by `bili claude`
        // / `bili codex`) POST /__bili/plugin/register first (Claude Code
        // SessionStart hook / codex spawn). The FIRST request that creates a
        // NEW session consumes the pending register — that session is plugin
        // mode from then on, keyed by the registered conversation id, and the
        // binding sticks via session.metadata.pluginAgent. stats.requests
        // increments inside prepare() below, so === 0 here means first sight.
        let pluginAgent = pluginAgentHeader(req.headers);
        let pluginConversation = pluginConversationHeader(req.headers);
        // The client's own conversation header (x-session-id / x-session-affinity
        // / x-opencode-session / x-acp-session) is the STRONGEST signal that two
        // requests belong to the same conversation — much stronger than the
        // content-fingerprint fallback. Prefer it over opts.sessionHeader and
        // over content hashing, so IDE clients (ZCode/Cursor) that inject a
        // fixed system-reminder into every new conversation don't collide on a
        // shared 200-char prefix and leak compression state across sessions.
        const clientConv = clientConversationHeader(req.headers);
        const convHeader = clientConv ?? sessionHeader;
        const responsesIdentity = protocol === "responses"
            ? conversationIdentityResponses(parsed as ResponsesRequestBody, convHeader)
            : undefined;
        const conversation = protocol === "anthropic"
            ? conversationSignalAnthropic(parsed as AnthropicRequestBody, convHeader)
            : protocol === "openai"
              ? conversationSignalOpenai(parsed as OpenAIRequestBody, convHeader)
              : subagentNamespace(
                  responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader),
                  (parsed as ResponsesRequestBody).instructions,
              );
        const sessionId = deriveProxySessionId(req.headers, protocol, upstreamOrigin, conversation);
        // Two separate uses of the conversation signal:
        //  - `affinity`: header value forwarded upstream for sticky-routing /
        //    cache pools. Synthesized as ses_<conversation> when the client
        //    sent none (pi), so upstream still gets a stable key.
        //  - `label`: human-readable display in the web UI / stats. We store
        //    ONLY the client's own value (opencode x-session-affinity, codex
        //    body.session_id) — never the synthetic one — so a user can tell
        //    at a glance which client owns a session. pi sends nothing, so its
        //    label stays empty (shown as "—" in the UI).
        const affinity = affinityToken(responsesIdentity ?? {
            value: clientConv ?? conversation,
            source: clientConv ? "header" : "generated",
            clientProvided: !!clientConv,
        });
        const clientLabel = responsesIdentity?.clientProvided
            ? responsesIdentity.value
            : clientConversationHeader(req.headers);
        const session = getSession(sessionId, { protocol, upstreamOrigin, label: clientLabel ?? undefined });
        // Launcher-mode binding (#162): prefer identity — claude code sends
        // x-claude-code-session-id on every request, equal to the
        // CLAUDE_CODE_SESSION_ID the MCP shell registered, so binding is
        // race-free. Fall back to the headless pending queue (codex spawn)
        // for the first request that creates a new session.
        if (!pluginAgent) {
            const identityAgent = consumePluginRegisterFor(clientConv ?? conversation);
            if (identityAgent) {
                pluginAgent = identityAgent;
                pluginConversation = clientConv ?? conversation;
            }
        }
        if (!pluginAgent && session.stats.requests === 0) {
            const pending = takePendingPluginRegister();
            if (pending) {
                pluginAgent = pending.agent;
                pluginConversation = pending.conversationId;
            }
        }
        if (!pluginAgent && typeof session.metadata.pluginAgent === "string") pluginAgent = session.metadata.pluginAgent;
        if (pluginAgent && !pluginConversation) pluginConversation = conversation;
        if (pluginAgent) {
            if (session.metadata.pluginAgent !== pluginAgent) session.metadata.pluginAgent = pluginAgent;
            session.metadata.effectiveContextLimit = reqConfig.modelContextLimit;
            recordPluginSession(pluginConversation ?? conversation, session.id);
        }
        // Responses clients that carry a client-provided conversation identity
        // (omp sends its own session id as `prompt_cache_key` in the body) get
        // that conversation recorded even WITHOUT the x-bili-plugin header, so
        // the /acp command — which looks the session up by the client's session
        // id — can find it. pi already records via the header path above; this
        // is a no-op duplicate for pi (same key) and the ONLY path for omp.
        if (protocol === "responses" && responsesIdentity?.clientProvided) {
            recordPluginSession(responsesIdentity.value, session.id);
        }
        const pluginMode = pluginAgent !== undefined;
        // Self-heal the context window: a prior upstream overflow may have
        // taught us the real window (forward()'s overflow detection persists it
        // to metadata.learnedContextLimits, keyed by model, or the legacy scalar
        // metadata.learnedContextLimit). If it is smaller than what we resolved this
        // turn (e.g. the 200k fallback for an unknown model on a relay), re-center
        // the kernel on it so the nudge/truncate bands sit below the real limit
        // instead of above it. A limit learned for a DIFFERENT model does not
        // apply — the user can switch models mid-conversation (same session),
        // and a stale smaller window would cap the bigger model prematurely.
        // Spread into a new object — never mutate the shared global config.
        const reqModel = (parsed as { model?: string }).model;
        const learnedMap = session.metadata.learnedContextLimits as Record<string, number> | undefined;
        const learnedLimit =
            (reqModel && learnedMap ? learnedMap[reqModel] : undefined) ??
            (session.metadata.learnedContextLimit as number | undefined);
        if (learnedLimit && learnedLimit > 0 && learnedLimit < reqConfig.modelContextLimit) {
            const resolved = reqConfig.modelContextLimit;
            reqConfig = { ...reqConfig, modelContextLimit: learnedLimit };
            log("info", `[${session.id}] self-healed context window: ${resolved} → ${learnedLimit} (learned from an upstream overflow)`);
        }
        // Reserve the model's OUTPUT budget for this turn from the window so the
        // kernel's nudge/truncate bands sit below (window - maxOutput) and a
        // context+output overflow can't happen on a small window (e.g. 100k with a
        // large max_tokens — the most common "context blew up" cause; none of the
        // three layers reserved room for the output before this). Anthropic is
        // exempt: its input limit is enforced independently of max_tokens
        // (separate output budget), so reserving would shift every band down by
        // maxOutput on every session for no safety gain — see
        // shouldReserveOutputHeadroom. max_tokens is the exact output budget
        // requested for THIS turn, so the reservation is precise and per-request.
        // Only reserve when it leaves a usable window (maxOutput < window);
        // otherwise the request is degenerate (output >= whole window) and the
        // self-heal above handles the resulting overflow. Feeds reqConfig (→
        // processTurn `config`), so diagNudge shows the reserved window (no extra log).
        if (shouldReserveOutputHeadroom(protocol)) {
            const p = parsed as Record<string, unknown>;
            const rawMax = p.max_tokens ?? p.max_completion_tokens ?? p.max_output_tokens;
            const maxOutput = typeof rawMax === "number" ? rawMax : 0;
            const reserved = reserveOutputHeadroom(reqConfig.modelContextLimit, maxOutput);
            if (reserved !== reqConfig.modelContextLimit) reqConfig = { ...reqConfig, modelContextLimit: reserved };
        }
        // acquireInFlight must precede the lock so evictOldest() cannot flush
        // this session between getSession and lock acquisition (inFlight===0
        // window). Released in the outer finally after forward completes.
        acquireInFlight(session);
        try {
            // Serialize per-session: prepare (processTurn mutates state) + forward
            // (stream rewriter mutates state via compress/decompress) must not
            // interleave across concurrent requests on the same session.
            await withSessionLock(session, async () => {
                prepared =
                    countTokens
                        ? prepareCountTokens(parsed as AnthropicRequestBody, core, reqConfig, log, session)
                        : protocol === "anthropic"
                          ? prepareAnthropic(parsed as AnthropicRequestBody, req, opts, core, reqConfig, reqPrompts, log, session, pluginMode)
                          : protocol === "openai"
                            ? prepareOpenai(parsed as OpenAIRequestBody, req, opts, core, reqConfig, reqPrompts, log, session, pluginMode)
                            : responsesCompact
                              ? prepareResponsesCompact(bodyBuffer, parsed as ResponsesRequestBody, session)
                              : prepareResponses(parsed as ResponsesRequestBody, req, opts, core, reqConfig, reqPrompts, log, session, responsesIdentity!, pluginMode);
                await forward(req, res, opts, prepared!.body, prepared!, core, reqConfig, log, route, affinity);
                if (pluginMode && prepared) {
                    rememberPluginMessages(sessionId, prepared.processedMessages, prepared.originalMessages, prepared.nudge);
                }
            });
        } finally {
            releaseInFlight(session);
        }
    }
    if (!prepared) {
        if (protocol === null && !opts.passthrough) {
            log("warn", `unrecognized path ${req.url ?? ""} — not a known protocol (/chat/completions, /v1/messages, /responses, /responses/compact); forwarding unchanged`);
        }
        await forward(req, res, opts, bodyBuffer, null, core, reqConfig, log, route, undefined);
    }
}

const ACP_TAG_MARK = "\x3cacp ";

// acp-kernel injects an in-place `acp_summary_*` at the compressed range as a
// generic-library fallback; this host strips it because the compress tool-call
// already carries the summary (hideConsumedCompressCalls keeps active-block calls),
// and a mid-stream insertion would shift the upstream prefix-cache breakpoint.
function stripKernelSummaries(messages: BiliMessage[]): BiliMessage[] {
    return messages.filter((m) => !(m.id ?? "").startsWith("acp_summary_"));
}

function diagTagSummary(messages: CoreMessage[], sessionId: string, strategy: string): string {
    let textTagged = 0;
    let toolTagged = 0;
    for (const m of messages) {
        const hasTag = (m.text ?? "").includes(ACP_TAG_MARK);
        if (!hasTag) continue;
        if (m.contentType === "tool-call" || m.contentType === "tool-result") toolTagged++;
        else textTagged++;
    }
    return `[${sessionId}] processTurn: ${messages.length} msgs, renderTags=${strategy}, ${textTagged} text tagged, ${toolTagged} tool tagged (should be 0 with text-only)`;
}

function diagNudge(turn: { nudge?: { shouldInject: boolean; reason: string; contextUsage: number; tier: number | null; breakdown?: Record<string, number> } | null }, sessionId: string, tokenCount: number, limit: number, model?: string): string {
    const n = turn.nudge;
    if (!n) return `[${sessionId}] nudge: unavailable`;
    const b = n.breakdown ?? {};
    const pct = limit > 0 ? `${Math.round((tokenCount / limit) * 100)}%` : "?";
    const growth = b["growth"] ?? 0;
    const floor = b["growthFloor"] ?? 0;
    const interval = b["nudgeGrowthTokens"] ?? 0;
    const pendingT1 = b["pendingT1"] ?? 0;
    const ref = b["growthReference"] ?? 0;
    const inject = n.shouldInject ? `INJECT T${n.tier ?? "?"}` : "idle";
    const modelTag = model ? ` model=${model}` : "";
    return `[${sessionId}] nudge ${inject}: usage=${pct} (${tokenCount}/${limit}), growth=${growth}/${floor} (ref=${ref}, interval=${interval}), pendingT1=${pendingT1}/${interval}${modelTag}, reason="${n.reason.slice(0, 120)}"`;
}

function prepareAnthropic(
    parsed: AnthropicRequestBody,
    req: http.IncomingMessage,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    prompts: Prompts,
    log: (level: string, msg: string) => void,
    session: Session,
    pluginMode: boolean,
): Prepared {
    const sessionId = session.id;
    const stream = parsed.stream === true;
    ++session.stats.requests;
    const injectTools = opts.compress.injectTool && !pluginMode;

    let processedMessages: CoreMessage[] = [];
    let originalMessages: CoreMessage[] = [];
    let nudge: NudgeDecision | undefined;
    let rebuiltMessages = parsed.messages;
    let systemOut = parsed.system;
    let toolsOut = parsed.tools;

    try {
        const { msgs, cacheControls } = anthropicToCore(parsed);
        originalMessages = msgs;
        // tokenCount drives the nudge decision ("should we compress?"). It MUST
        // be the real context size, never an estimate — estimates undercount
        // CJK text 3-4x and never trigger compression for Chinese sessions.
        // Use the upstream's own input_tokens from the PREVIOUS turn (known by
        // now — the response came back). First turn has no history → 0 (never
        // triggers anyway). extractSystem is still called so sysText flows into
        // the fallback path below if we ever need it, but we no longer feed
        // estimates to the kernel.
        extractSystem(parsed.system);
        const tokenCount = session.stats.lastInputTokens;
        const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount, renderTags: "text-only" });
        session.state = turn.state;
        // Drop sub-viability fragments before any consumer sees them: a tiny
        // range in the list makes batched compress attempts fail atomically
        // (kernel validates the whole batch). Mirrors billion-context-pi.
        if (turn.nudge) turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
        if (!session.meta.title) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, parsed.model));
        processedMessages = stripKernelSummaries(turn.messages);
        reapOrphanBlocks(session, msgs, deactivateBlock);
        rebuiltMessages = coreToAnthropic(processedMessages as BiliMessage[], cacheControls);

        systemOut = injectSystem(parsed, opts, prompts);
        if (injectTools) {
            toolsOut = injectTool(parsed.tools);
        }
        // Nudge as a separate trailing user message (cache-friendly): the
        // system block stays byte-stable so the prefix cache survives.
        if (opts.compress.injectNudge && turn.nudge?.shouldInject) {
            try {
                const rendered = renderNudgeText(turn.nudge, prompts);
                if (rendered.text) {
                    rebuiltMessages = [...rebuiltMessages, { role: "user", content: rendered.text }];
                }
            } catch {
            }
        }
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }
    snapshotMessages(session, originalMessages);
    markDirty(session);

    const rebuilt: AnthropicRequestBody = { ...parsed, messages: rebuiltMessages, system: systemOut, tools: toolsOut };
    return { body: JSON.stringify(rebuilt), session, processedMessages, originalMessages, anthropicSystem: parsed.system, protocol: "anthropic", stream, compressInjected: injectTools, pluginMode, nudge, prompts } as Prepared;
}

function prepareOpenai(
    parsed: OpenAIRequestBody,
    req: http.IncomingMessage,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    prompts: Prompts,
    log: (level: string, msg: string) => void,
    session: Session,
    pluginMode: boolean,
): Prepared {
    const sessionId = session.id;
    const stream = parsed.stream === true;
    ++session.stats.requests;
    let openaiSystemText = "";
    let processedMessages: CoreMessage[] = [];
    let originalMessages: CoreMessage[] = [];
    let nudge: NudgeDecision | undefined;
    let rebuiltMessages = parsed.messages;
    let toolsOut = parsed.tools;

    const maxTokens = typeof parsed.max_tokens === "number" ? parsed.max_tokens : 8192;
    // Title-generation requests (tiny max_tokens) get no compress tooling so
    // the model produces a clean short title. We do NOT key this off message
    // count: a 2-message request is just turn 1 of a real conversation, and
    // flipping shouldInject false→true between turn 1 and turn 2+ rewrites the
    // system prompt bytes (compress prompt added/removed) — which breaks the
    // provider prefix cache for every subsequent turn.
    const isTitleGen = maxTokens <= 200;
    const shouldInject = opts.compress.injectTool && !isTitleGen;
    const injectTools = shouldInject && !pluginMode;

    try {
        // Kernel 0.0.37 hoists the contiguous leading system/developer prefix
        // OUT of the fold space: system content is host runtime state and
        // must not feed ids/fingerprints. Capture it and re-inject below —
        // otherwise the proxy would forward payloads without any system.
        const { msgs, systemText } = openaiToCore(parsed);
        openaiSystemText = systemText;
        originalMessages = msgs;
        // tokenCount = upstream's real input_tokens from the previous turn
        // (see anthropic branch comment). Never an estimate.
        const tokenCount = session.stats.lastInputTokens;
        const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount, renderTags: "text-only" });
        session.state = turn.state;
        // Drop sub-viability fragments before any consumer sees them: a tiny
        // range in the list makes batched compress attempts fail atomically
        // (kernel validates the whole batch). Mirrors billion-context-pi.
        if (turn.nudge) turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
        if (!session.meta.title) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, parsed.model));
        processedMessages = stripKernelSummaries(turn.messages);
        reapOrphanBlocks(session, msgs, deactivateBlock);
        rebuiltMessages = coreToOpenai(processedMessages as BiliMessage[]);

        // ONLY the static compress prompt goes into the system message — the
        // system prompt is the prefix-cache anchor and must be byte-stable
        // across turns. The nudge (which changes every turn: token count,
        // growth %, dynamic example) is appended as a trailing user message
        // instead, mirroring pai-acp's design. Putting the nudge in system
        // would invalidate the cache every turn.
        const sysParts: string[] = [];
        if (systemText) sysParts.push(systemText);
        if (shouldInject) sysParts.push(buildCompressSystemPrompt(prompts));
        rebuiltMessages = injectOpenaiSystem(rebuiltMessages, sysParts);
        if (injectTools) {
            toolsOut = injectOpenaiTool(parsed.tools);
        }
        // Nudge as a separate trailing user message (cache-friendly).
        if (opts.compress.injectNudge && turn.nudge?.shouldInject && shouldInject) {
            try {
                const rendered = renderNudgeText(turn.nudge, prompts);
                if (rendered.text) {
                    rebuiltMessages = [...rebuiltMessages, { role: "user", content: rendered.text }];
                }
            } catch {
            }
        }
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    const rebuilt: OpenAIRequestBody = { ...parsed, messages: rebuiltMessages, tools: toolsOut as OpenAITool[] | undefined };
    // OpenAI Chat Completions only emits a usage object in the final stream
    // chunk when the client sets stream_options.include_usage=true. Without
    // it, streaming sessions never learn their real input_tokens →
    // lastInputTokens stays 0 → compression never fires. Force it on for any
    // streaming request that doesn't already opt in. (Anthropic/Responses
    // emit usage unconditionally, so this is OpenAI-specific.)
    if (stream && (rebuilt as Record<string, unknown>).stream_options === undefined) {
        (rebuilt as Record<string, unknown>).stream_options = { include_usage: true };
    }
    snapshotMessages(session, originalMessages);
    markDirty(session);
    return { body: JSON.stringify(rebuilt), session, processedMessages, originalMessages, protocol: "openai", stream, compressInjected: injectTools, pluginMode, nudge, prompts, openaiSystemText } as Prepared;
}

function prepareResponses(
    parsed: ResponsesRequestBody,
    req: http.IncomingMessage,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    prompts: Prompts,
    log: (level: string, msg: string) => void,
    session: Session,
    identity: ConversationIdentity,
    pluginMode: boolean,
): Prepared {
    const sessionId = session.id;
    const stream = parsed.stream === true;
    ++session.stats.requests;
    if (reconcileNativeCompactionBoundary(session)) {
        log("info", `[${sessionId}] reconciled ACP state after native Responses compact boundary`);
    }

    let processedMessages: CoreMessage[] = [];
    let originalMessages: CoreMessage[] = [];
    let nudge: NudgeDecision | undefined;
    let responsesProjection: ResponsesProjection | undefined;
    let rebuiltInput: ResponseInputItem[] | string = parsed.input;
    let toolsOut = parsed.tools;

    const shouldInject = opts.compress.injectTool;
    const injectTools = shouldInject && !pluginMode;
    const responsesTextProtocol = FORCE_TEXT_PROTOCOL ||
        resolveCompressProtocol(opts.routes, session.meta.upstreamOrigin) === "marker";

    try {
        const projection = responsesToCore(parsed);
        responsesProjection = projection;
        const { msgs } = projection;
        originalMessages = msgs;
        if (process.env.ACP_DEBUG) {
            log("info", `[${sessionId}] input items: ${Array.isArray(parsed.input) ? parsed.input.map((i: ResponseInputItem) => i.type).join(",") : "(string)"}`);
        }
        const tokenCount = session.stats.lastInputTokens;
        const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only" });
        session.state = turn.state;
        // Drop sub-viability fragments before any consumer sees them: a tiny
        // range in the list makes batched compress attempts fail atomically
        // (kernel validates the whole batch). Mirrors billion-context-pi.
        if (turn.nudge) turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
        if (!session.meta.title) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, parsed.model));
        processedMessages = stripKernelSummaries(turn.messages);
        reapOrphanBlocks(session, msgs, deactivateBlock);
        rebuiltInput = patchResponsesInput(projection, processedMessages);
        if (shouldInject && !process.env.ACP_NO_COMPRESS_PROMPT) {
            const prompt = responsesTextProtocol ? buildCompressHybridSystemPrompt(prompts) : buildCompressSystemPrompt(prompts);
            const devContent = [...projection.systemParts, prompt].join("\n\n---\n\n");
            rebuiltInput = injectResponsesDeveloperMessage(rebuiltInput, devContent);
            if (!process.env.ACP_NO_INJECT_TOOL && injectTools) {
                toolsOut = responsesTextProtocol
                    ? injectResponsesTool(parsed.tools, ACP_READONLY_TOOLS_RESPONSES)
                    : injectResponsesTool(parsed.tools);
            }
        } else if (projection.systemParts.length > 0) {
            rebuiltInput = injectResponsesDeveloperMessage(rebuiltInput, projection.systemParts.join("\n\n---\n\n"));
        }
        if (opts.compress.injectNudge && turn.nudge?.shouldInject && shouldInject) {
            try {
                const rendered = renderNudgeText(turn.nudge, prompts);
                if (rendered.text) {
                    const inputItems: ResponseInputItem[] = typeof rebuiltInput === "string"
                        ? [{ type: "message", role: "user", content: rebuiltInput }]
                        : rebuiltInput;
                    inputItems.push({ type: "message", role: "user", content: rendered.text });
                    rebuiltInput = inputItems;
                }
            } catch {
            }
        }
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    const rebuilt: ResponsesRequestBody = { ...parsed, input: rebuiltInput, tools: toolsOut };
    const promptCacheKey = resolvePromptCacheKey(
        rebuilt.prompt_cache_key,
        identity,
        opts.promptCache.routing,
        session.meta.upstreamOrigin,
    );
    if (promptCacheKey && !rebuilt.prompt_cache_key) rebuilt.prompt_cache_key = promptCacheKey;
    // This adapter is stateless: we replay the FULL conversation in `input`.
    // Strip Responses' native chaining field so the upstream does not resolve
    // stored server-side state ON TOP of the input we already sent (which would
    // duplicate history for clients that use store:true + chaining). Empirically
    // codex sends store:false and never sets previous_response_id, so this is a
    // no-op for codex — kept defensively for any client that does chain. Set
    // ACP_KEEP_RESPONSE_ID=1 to preserve it (diagnostic only). `instructions`
    // was already lifted into the developer message at input[1]; forwarding it
    // again here double-sends it and violates the responses_lite contract
    // (top-level instructions must stay empty for code_mode tool exposure).
    if (process.env.ACP_KEEP_RESPONSE_ID !== "1") delete rebuilt.previous_response_id;
    delete rebuilt.instructions;
    // Log the final tools we forward upstream so we can confirm ACP tools are
    // present. Distinguishes "compress" (top-level function) from Codex
    // namespace items (type:namespace/custom).
    if (process.env.ACP_DEBUG) {
        const fwdTools = (Array.isArray(toolsOut) ? toolsOut : []).map((t) => {
            const r = t as Record<string, unknown>;
            const sub = Array.isArray(r.tools) ? `(${r.tools.length} sub)` : "";
            return `${r.type as string}:${(r.name as string) ?? "?"}${sub}`;
        });
        log("info", `[${sessionId}] responses forward tools=[${fwdTools.join(",")}] injectTool=${shouldInject} NO_INJECT_TOOL=${!!process.env.ACP_NO_INJECT_TOOL} NO_COMPRESS_PROMPT=${!!process.env.ACP_NO_COMPRESS_PROMPT}`);
    }
    snapshotMessages(session, originalMessages);
    markDirty(session);
    return {
        body: JSON.stringify(rebuilt),
        session,
        processedMessages,
        originalMessages,
        responsesProjection,
        protocol: "responses",
        stream,
        compressInjected: injectTools,
        pluginMode,
        responsesTextProtocol,
        nudge,
        prompts,
    };
}

export function isCountTokensRequest(method: string, urlPath: string, hasBody: boolean): boolean {
    return (
        method === "POST" &&
        hasBody &&
        process.env.ACP_COUNT_TOKENS_PASSTHROUGH !== "1" &&
        urlPath.endsWith("/messages/count_tokens")
    );
}

export function prepareCountTokens(
    parsed: AnthropicRequestBody,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
    session: Session,
): Prepared {
    const sessionId = session.id;
    try {
        const { msgs, cacheControls } = anthropicToCore(parsed);
        const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: session.stats.lastInputTokens, renderTags: "text-only" });
        const stripped = stripKernelSummaries(turn.messages as BiliMessage[]);
        const rebuiltMessages = coreToAnthropic(stripped, cacheControls);
        log("info", `[${sessionId}] count_tokens pruned: ${msgs.length} → ${stripped.length} msgs`);
        return {
            body: JSON.stringify({ ...parsed, messages: rebuiltMessages }),
            session,
            processedMessages: [],
            originalMessages: msgs,
            protocol: "anthropic",
            stream: false,
            compressInjected: false,
        };
    } catch (err) {
        log("warn", `[${sessionId}] count_tokens prune failed, forwarding unchanged: ${String(err)}`);
        return {
            body: JSON.stringify(parsed),
            session,
            processedMessages: [],
            originalMessages: [],
            protocol: "anthropic",
            stream: false,
            compressInjected: false,
        };
    }
}

function prepareResponsesCompact(body: Buffer, parsed: ResponsesRequestBody, session: Session): Prepared {
    ++session.stats.requests;
    return {
        body,
        session,
        processedMessages: [],
        originalMessages: [],
        protocol: "responses",
        stream: parsed.stream === true,
        compressInjected: false,
        resetAfterSuccess: true,
    };
}

export function isChatGptCodexUpstream(upstream: string | undefined): boolean {
    if (!upstream) return false;
    try {
        return new URL(upstream).hostname.toLowerCase() === "chatgpt.com";
    } catch {
        return false;
    }
}

export function isCodexResponsesLite(headers: http.IncomingHttpHeaders, _body: ResponsesRequestBody): boolean {
    // additional_tools is NOT a lite signal: codex always sends it and it coexists
    // with injected `tools` (verified end-to-end). Only the explicit header counts.
    if (headers["x-openai-internal-codex-responses-lite"] !== undefined) return true;
    return false;
}

export function shouldInjectPromptCacheKey(
    routing: ProxyOptions["promptCache"]["routing"],
    upstream: string | undefined,
): boolean {
    if (routing === "enabled") return true;
    if (routing === "disabled" || !upstream) return false;
    try {
        return new URL(upstream).hostname.toLowerCase() === "api.openai.com";
    } catch {
        return false;
    }
}

export function resolvePromptCacheKey(
    explicit: string | undefined,
    identity: ConversationIdentity,
    routing: ProxyOptions["promptCache"]["routing"],
    upstream: string | undefined,
): string | undefined {
    if (explicit?.trim()) return explicit;
    if (!identity.clientProvided || !shouldInjectPromptCacheKey(routing, upstream)) return undefined;
    return identity.value;
}

function injectSystem(
    parsed: AnthropicRequestBody,
    opts: ProxyOptions,
    prompts: Prompts = defaultPrompts,
): string | AnthropicRequestBody["system"] {
    // ONLY the static compress prompt goes into the system block — it is the
    // prefix-cache anchor and must stay byte-stable across turns. The nudge
    // (which changes every turn) is appended as a trailing user message by
    // the caller (prepareAnthropic), never merged into system.
    const baseText = extractSystem(parsed.system);
    const parts: string[] = [];
    if (opts.compress.injectTool) parts.push(buildCompressSystemPrompt(prompts));
    if (parts.length === 0) return parsed.system;
    const full = baseText ? `${baseText}\n\n---\n\n${parts.join("\n\n")}` : parts.join("\n\n");
    return buildSystem(full, parsed.system);
}

function injectTool(tools: unknown[] | undefined): unknown[] {
    if (!Array.isArray(tools)) return [...ACP_TOOLS_ANTHROPIC];
    const names = new Set(tools.map((t) => (t as { name?: string })?.name));
    const missing = ACP_TOOLS_ANTHROPIC.filter((t) => !names.has(t.name));
    return missing.length === 0 ? tools : [...tools, ...missing];
}

function injectOpenaiTool(tools: OpenAITool[] | undefined): OpenAITool[] {
    if (!Array.isArray(tools)) return [...ACP_TOOLS_OPENAI] as OpenAITool[];
    const present = new Set(
        tools
            .map((t) => t?.function?.name)
            .filter((n): n is string => typeof n === "string"),
    );
    const additions = ACP_TOOLS_OPENAI.filter((t) => !present.has(t.function.name));
    return [...tools, ...(additions as OpenAITool[])];
}

/** When true, the Responses path teaches compression via a text trigger
 *  instead of a function tool. Used for hosts (OpenAI Codex code_mode) whose
 *  server-side tools are disabled the moment any `tools` entry is declared.
 *  In text mode we keep `tools` untouched (undefined) so code_mode stays
 *  active, and detect the trigger in the output_text stream instead. */
const FORCE_TEXT_PROTOCOL = process.env.ACP_COMPRESS_PROTOCOL === "text";
/** Inject all ACP tools (compress/decompress/search_context/acp_status) in
 *  Responses API flat format, matching the PROXY_TOOL_NAMES set the compress
 *  loop dispatches on. Idempotent. */
function injectResponsesTool(tools: unknown[] | undefined, toolsToAdd: readonly { name: string }[] = ACP_TOOLS_RESPONSES): unknown[] {
    if (!Array.isArray(tools)) return [...toolsToAdd];
    const present = new Set(
        tools
            .map((t) => (t as { name?: string })?.name)
            .filter((n): n is string => typeof n === "string"),
    );
    const additions = toolsToAdd.filter((t) => !present.has(t.name));
    return [...tools, ...additions];
}

async function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts: ProxyOptions,
    body: Buffer | string,
    prepared: Prepared | null,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
    route: ReturnType<typeof resolveUpstream>,
    affinity?: string,
): Promise<void> {
    // rewrittenUrl may use a `mitm://` scheme (for config-lookup distinction
    // — see resolveUpstream). fetch needs the real https:// scheme, so strip
    // mitm:// back to https:// for the actual upstream request.
    const reqUrl = req.url ?? "";
    const isAbsoluteUrl = /^https?:\/\//i.test(reqUrl);
    const rewritten = route ? route.rewrittenUrl : isAbsoluteUrl ? reqUrl : opts.upstream + reqUrl;
    const upstreamUrl = rewritten.replace(/^mitm:\/\//, "https://");
    // Show the final proxied URL (where the request actually lands) as the
    // primary signal. The provider label is appended only for named routes —
    // zero-config requests have a single routing mode now, so the final
    // proxied URL is the only useful signal in the log.
    log("info", `forward ${req.method} → ${upstreamUrl}`);
    if (process.env.ACP_DEBUG && prepared) {
        const sid = prepared.session.id;
        const hdrKeys = Object.keys(req.headers);
        log("info", `[${sid}] client headers: ${hdrKeys.join(",")}`);
        for (const k of ["authorization", "x-api-key", "x-session-id", "x-session-affinity", "x-acp-session", "x-opencode-session", "prompt-cache-key", "anthropic-beta"]) {
            const v = req.headers[k] ?? req.headers[k.toLowerCase()];
            if (v) {
                const s = Array.isArray(v) ? v.join(",") : String(v);
                // Mask all but a short prefix so the header NAME is visible
                // (so we know the key is sent and roughly how) without leaking
                // the credential into the log.
                const masked = /key|auth|token/i.test(k) ? s.slice(0, 8) + "..." + s.slice(-4) + ` (${s.length} chars)` : s.slice(0, 60);
                log("info", `[${sid}] client hdr ${k}=${masked}`);
            }
        }
    }
    if (opts.debug && typeof body === "string") {
        try {
            const parsed = JSON.parse(body);
            const toolNames = (parsed.tools ?? []).map((t: Record<string, unknown>) => {
                const fn = t.function as { name?: string } | undefined;
                // chat completions nests under `function`; Responses API is flat.
                return fn?.name ?? (t.name as string | undefined) ?? "?";
            });
            log("info", `[debug] tools=[${toolNames.join(",")}] msgs=${parsed.messages?.length ?? 0} stream=${parsed.stream ?? false} system_len=${JSON.stringify(parsed.messages?.find((m: Record<string, string>) => m.role === "system")?.content ?? "").length}`);
            if (process.env.ACP_DUMP_REQ !== "0") {
                const dumpDir = process.env.ACP_DUMP_DIR || `${stateDir()}/dumps`;
                try { fs.mkdirSync(dumpDir, { recursive: true }); } catch { /* best-effort */ }
                const sid = prepared?.session.id ?? "unknown";
                const out = `${dumpDir}/req-${Date.now()}-${sid}.json`;
                try {
                    const pretty = JSON.stringify(JSON.parse(body), null, 2);
                    fs.writeFileSync(out, pretty);
                } catch {
                    fs.writeFileSync(out, body);
                }
                log("info", `[debug] forwarded body written to ${out}`);
            }
        } catch { /* best-effort */ }
    }
    const headers: Record<string, string> = {};
    const reqConnNamed = connectionNamedHeaders(req.headers["connection"]);
    for (const [k, v] of Object.entries(req.headers)) {
        const lower = k.toLowerCase();
        if (UPSTREAM_HOP_HEADERS.has(lower) || reqConnNamed.has(lower) || v === undefined) continue;
        headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    headers["host"] = new URL(upstreamUrl).host;
    // codex advertises its own server-side context compaction via this beta
    // feature. It conflicts with bili's client-side compress (bili IS the
    // compression layer) and third-party aggregators reject it with
    // "invalid range / ref not found". Strip it so bili's compress is the
    // sole mechanism.
    const betaKey = Object.keys(headers).find((h) => h.toLowerCase() === "x-codex-beta-features");
    if (betaKey) {
        const kept = headers[betaKey]
            .split(",")
            .map((s) => s.trim())
            .filter((f) => f && f !== "remote_compaction_v2");
        if (kept.length > 0) headers[betaKey] = kept.join(",");
        else delete headers[betaKey];
    }
    // Forward a client-provided Responses session identity only when it was
    // carried in the body rather than an existing request header.
    if (affinity && !clientConversationHeader(req.headers)) {
        headers["x-session-id"] = affinity;
    }
    const proxyUrl = resolveProxy(opts.routes, opts.proxy, route?.rewrittenUrl ?? upstreamUrl, opts.proxyFallback);
    if (opts.debug) {
        const hdrLog: Record<string, string> = {};
        for (const [hk, hv] of Object.entries(headers)) {
            if (typeof hv === "string") hdrLog[hk] = hv.length > 200 ? hv.slice(0, 200) + "..." : hv;
        }
        log("info", `[${prepared?.session.id ?? "unknown"}] → upstream headers: ${JSON.stringify(hdrLog)}`);
    }
    // Raw HTTP capture: dump the COMPLETE exchange (request method/URL/all
    // headers/exact body bytes; response status+headers) so two consecutive
    // requests can be byte-diffed to locate a cache-breaker that the JSON body
    // dump (which re-formats and omits headers) may hide. Enabled with --debug
    // (headers written verbatim minus credential values).
    const rawBase =
        opts.debug
            ? (() => {
                  try {
                      const rawDir = process.env.ACP_RAW_DUMP_DIR || `${stateDir()}/raw`;
                      fs.mkdirSync(rawDir, { recursive: true });
                      return `${rawDir}/${Date.now()}-${prepared?.session.id ?? "unknown"}`;
                  } catch {
                      return "";
                  }
              })()
            : "";
    if (rawBase) {
        try {
            const maskHdr = (k: string, v: string) =>
                /key|auth|token/i.test(k) ? `<masked ${v.length} chars>` : v;
            const hdrText = Object.entries(headers)
                .map(([k, v]) => `${k}: ${maskHdr(k, String(v))}`)
                .join("\n");
            const bodyText =
                req.method === "GET" || req.method === "HEAD"
                    ? ""
                    : typeof body === "string"
                      ? body
                      : Buffer.from(body).toString("utf8");
            const reqPath = `${rawBase}-REQ.txt`;
            fs.writeFileSync(reqPath, `${req.method ?? "POST"} ${upstreamUrl}\n${hdrText}\n\n${bodyText}`);
            log("info", `[debug] RAW request dump: ${reqPath}`);
        } catch { /* best-effort */ }
    }
    const dispatcher = proxyDispatcher(proxyUrl);
    const init: Omit<RequestInit, "dispatcher"> & { dispatcher?: object } = {
        method: req.method ?? "GET",
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    };
    if (dispatcher) init.dispatcher = dispatcher;
    // Must be created before fetchWithTimeout: the signal aborts the upstream
    // request when the client disconnects (IDE cancel), otherwise the proxy
    // keeps reading upstream and holds the per-session lock. Also passed to
    // the rewriter loop below so fetch and loop stop together.
    const clientAbort = new AbortController();
    res.on("close", () => {
        if (!res.writableEnded) clientAbort.abort();
    });
    let upstreamResult: Awaited<ReturnType<typeof fetchWithTimeout>>;
    try {
        upstreamResult = await fetchWithTimeout(upstreamUrl, init, undefined, clientAbort.signal);
        recordUpstreamConnection(upstreamUrl, proxyUrl);
    } catch (error) {
        recordUpstreamConnection(upstreamUrl, proxyUrl, error);
        throw new Error(`upstream request failed: ${formatUpstreamError(error, upstreamUrl, proxyUrl)}`, { cause: error });
    }
    const { response: upstream, clearTimer: clearUpstreamTimer } = upstreamResult;
    const respHeaders: Record<string, string> = {};
    const respConnNamed = connectionNamedHeaders(upstream.headers.get("connection") ?? undefined);
    upstream.headers.forEach((v, k) => {
        const lower = k.toLowerCase();
        if (UPSTREAM_HOP_HEADERS.has(lower) || respConnNamed.has(lower)) return;
        respHeaders[k] = v;
    });
    if (opts.debug) {
        const respLog: Record<string, string> = {};
        upstream.headers.forEach((v, k) => {
            const lower = k.toLowerCase();
            if (UPSTREAM_HOP_HEADERS.has(lower) || respConnNamed.has(lower)) return;
            respLog[k] = v.length > 300 ? v.slice(0, 300) + "..." : v;
        });
        log("info", `[${prepared?.session.id ?? "unknown"}] ← upstream response headers: ${JSON.stringify(respLog)}`);
    }
    if (rawBase) {
        try {
            const maskHdr = (k: string, v: string) =>
                /key|auth|token/i.test(k) ? `<masked ${v.length} chars>` : v;
            const hdrText = Object.entries(respHeaders)
                .map(([k, v]) => `${k}: ${maskHdr(k, v)}`)
                .join("\n");
            const resPath = `${rawBase}-RES.txt`;
            fs.writeFileSync(resPath, `${upstream.status}\n${hdrText}\n`);
            log("info", `[debug] RAW response dump: ${resPath}`);
        } catch { /* best-effort */ }
    }
    // P1.2: if the upstream returned a non-2xx (auth, rate-limit, context too
    // long, ...), do NOT route the error body through the SSE rewriter — it has
    // no SSE events and would be silently swallowed, leaving the client with
    // an empty stream and no idea why. Pass status + body through verbatim.
    // (writeHead is done HERE, only in the error branch, so we never double-
    // write headers when a later branch would also call writeHead.)
    if (!upstream.ok) {
        // Buffer the (small) error body so a context overflow can be detected:
        // when the configured window is wrong (e.g. the 200k fallback for an
        // unknown model on a relay) an upstream 400 is the only reliable signal
        // that the real window is smaller. Learn the window, arm an emergency
        // shrink for the next turn, then pass the error through verbatim.
        let errBody: Buffer | null = null;
        if (upstream.body) {
            try {
                errBody = await readStreamToBuffer(upstream.body);
            } catch {
                errBody = null; // body consumed/broken — respond with status only
            }
        }
        if (prepared?.session && errBody) {
            const s = prepared.session;
            const info = inspectContextOverflow(upstream.status, errBody.toString("utf8"));
            if (info.isOverflow) {
                // The request's model — the learned window only applies to the
                // model that produced the overflow (per-model scoping: a stale
                // limit from another model must not cap this one).
                let reqModel: string | undefined;
                try {
                    const rawBody = typeof prepared.body === "string" ? prepared.body : prepared.body.toString("utf8");
                    reqModel = (JSON.parse(rawBody) as { model?: string }).model;
                } catch {
                    reqModel = undefined; // non-JSON body — fall back to the legacy scalar
                }
                const learnedMap = (s.metadata.learnedContextLimits as Record<string, number> | undefined) ?? {};
                if (info.window) {
                    const prev = (reqModel ? learnedMap[reqModel] : undefined) ?? (s.metadata.learnedContextLimit as number | undefined);
                    // Persist the real window to a STABLE field (effectiveContextLimit
                    // is re-resolved every turn in plugin mode and would be overwritten);
                    // handle() reads it (per model) to re-center the kernel next turn.
                    if (reqModel) learnedMap[reqModel] = info.window;
                    else s.metadata.learnedContextLimit = info.window;
                    s.metadata.learnedContextLimits = learnedMap;
                    log("warn", `[${s.id}] upstream context overflow — learned real window ${info.window} for ${reqModel ?? "(unknown model)"} (was ${prev ?? "unset"}); arming emergency shrink`);
                } else {
                    log("warn", `[${s.id}] upstream context overflow (window not parseable): ${info.message}`);
                }
                // Arm the emergency shrink: force the next turn's usage to >=100%
                // so the kernel's emergency nudge + tool-result truncate fire.
                // lastInputTokens is a lower bound here (the context overflowed,
                // so it is at least the window); a real usage report from the
                // next successful turn overwrites it.
                const floor =
                    info.window ??
                    (reqModel ? learnedMap[reqModel] : undefined) ??
                    (s.metadata.learnedContextLimit as number | undefined) ??
                    (s.metadata.effectiveContextLimit as number | undefined) ??
                    0;
                if (floor > 0) s.stats.lastInputTokens = Math.max(s.stats.lastInputTokens, floor);
                // The learned window (metadata) and the armed emergency
                // (lastInputTokens) live in memory only until scheduled —
                // the error path returns before forward()'s trailing
                // markDirty, so schedule the save HERE or the self-heal is
                // lost on restart and the next overflow must be re-learned.
                markDirty(s);
            }
        }
        // #174: always log a non-2xx upstream response (status + request-id +
        // body snippet) — a 4xx/5xx with zero log trace is a diagnostic
        // black hole (issue #2).
        const errSid = prepared?.session.id ?? "unknown";
        const reqId = upstream.headers.get("x-request-id") ?? upstream.headers.get("request-id");
        const reqIdText = reqId ? ` request-id=${reqId}` : "";
        const bodyText = errBody ? new TextDecoder().decode(errBody) : "";
        let snippet = bodyText.slice(0, 600).replace(/\s+/g, " ").trim();
        if (bodyText.length > 600) snippet += " …";
        if (!snippet) snippet = "(no body)";
        loggerLog("warn", `[${errSid}] ← upstream ${upstream.status}${reqIdText}: ${snippet}`);
        const errHeaders: Record<string, string> = { ...respHeaders };
        // Drop the upstream framing headers unconditionally: when errBody is
        // present a fixed-length write replaces them, and when errBody is
        // null (broken body stream) the response ends with no body — a
        // content-length/transfer-encoding claiming bytes that never arrive
        // would leave the client on a broken response.
        delete errHeaders["content-length"];
        delete errHeaders["transfer-encoding"];
        res.writeHead(upstream.status, errHeaders);
        res.end(errBody ?? undefined);
        clearUpstreamTimer();
        return;
    }
    // 2xx path: now safe to commit the status + headers, then stream the body.
    res.writeHead(upstream.status, respHeaders);
    if (!upstream.body) {
        res.end();
        clearUpstreamTimer();
        if (prepared?.resetAfterSuccess) {
            markNativeCompactionBoundary(prepared.session);
            log("info", `[${prepared.session.id}] native Responses compact completed; rebase scheduled for next Responses turn`);
        }
        return;
    }
    // Plugin mode: the agent's native loop owns the tool surface — pass the
    // response through VERBATIM (a model-emitted compress call must reach the
    // plugin untouched) while sniffing usage so lastInputTokens (the input to
    // the next nudge decision) keeps tracking reality.
    if (prepared?.pluginMode) {
        if (prepared.stream) {
            await pipeThroughWithUsage(upstream.body as ReadableStream<Uint8Array>, res, prepared.session, prepared.protocol);
        } else {
            await pipePluginJson(upstream.body as ReadableStream<Uint8Array>, res, prepared.session, prepared.protocol);
        }
        clearUpstreamTimer();
        return;
    }
    // We only rewrite when THIS request actually had the compress tool
    // injected (per-request). For the OpenAI title-gen path
    // (`compressInjected === false`) we must NOT route the stream into a
    // rewriter — `rewriteSseStream` below is the *Anthropic* SSE rewriter
    // and would mishandle OpenAI `choices[].delta` events. Plain passthrough
    // is correct there.
    const useRewriter =
        prepared !== null &&
        prepared.compressInjected &&
        prepared.processedMessages.length > 0;
    if (!useRewriter || prepared === null) {
        await pipeThrough(upstream.body, res);
        clearUpstreamTimer();
        if (prepared?.resetAfterSuccess) {
            markNativeCompactionBoundary(prepared.session);
            log("info", `[${prepared.session.id}] native Responses compact completed; rebase scheduled for next Responses turn`);
        }
        return;
    }
    const ctx: RewriteCtx = {
        core,
        config,
        messages: prepared.originalMessages,
        session: prepared.session,
        log: (msg: string) => log("info", `[${prepared.session.id}] ${msg}`),
        debug: opts.debug,
    };
    if (prepared.stream) {
        let streamToRead = upstream.body as ReadableStream<Uint8Array>;
        let dumpRaw: Promise<void> | undefined;
        if (opts.dumpSse) {
            const [a, b] = (upstream.body as ReadableStream<Uint8Array>).tee();
            streamToRead = a;
            dumpRaw = dumpStreamToFile(b, opts.dumpSse, `${Date.now()}-${prepared.session.id}-raw.sse`);
        }
        // P1.1: wrap the rewriter loops in try/catch. If a rewriter throws
        // (decompress/search edge case, JSON.parse failure, fetch abort),
        // emitStreamError sends a protocol-appropriate error + finish so the
        // client ends cleanly instead of seeing a bare truncated stream.
        try {
            const parsedReq = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
            const reqHeaders = buildForwardHeaders(headers);
            const textProtocol = prepared.protocol === "responses" && !!prepared.responsesTextProtocol;
            const systemPrompt = textProtocol ? buildCompressHybridSystemPrompt(prepared.prompts ?? defaultPrompts) : buildCompressSystemPrompt(prepared.prompts ?? defaultPrompts);
            const adapter = pickAdapter(prepared.protocol, parsedReq, textProtocol, prepared.responsesProjection, prepared.anthropicSystem, prepared.openaiSystemText);
            const loop = runCompressLoop(
                streamToRead,
                { core, config, messages: prepared.processedMessages.length > 0 ? prepared.processedMessages : prepared.originalMessages, compressMessages: prepared.originalMessages, session: prepared.session, log: ctx.log, proxyUrl, protocol: prepared.protocol, textProtocol, debug: opts.debug, nudge: prepared.nudge },
                parsedReq,
                { url: upstreamUrl, headers: reqHeaders },
                adapter,
                systemPrompt,
                clientAbort.signal,
            );
            for await (const chunk of loop) {
                if (res.destroyed || res.writableEnded) break;
                {
                    const s = chunk.toString("utf8");
                    if (s.includes("\x3cacp ") || s.includes("\x3c/acp")) {
                        log("warn", `[${prepared.session.id}] tag echo: ${prepared.protocol} response stream contains \x3cacp tag`);
                    }
                }
                res.write(chunk);
                if (res.writableNeedDrain) {
                    await Promise.race([
                        new Promise<void>((r) => res.once("drain", () => r())),
                        new Promise<void>((r) => res.once("close", () => r())),
                    ]);
                }
                if (res.destroyed || res.writableEnded) break;
            }
            res.end();
        } catch (e) {
            emitStreamError(res, prepared.protocol, (e as Error)?.message ?? String(e), (m) => log("error", `[${prepared.session.id}] ${m}`));
        } finally {
            clearUpstreamTimer();
            if (dumpRaw) await dumpRaw;
        }
    } else {
        // Wrap the whole non-streaming branch in try/finally so the upstream
        // timer is always cleared and the session is always persisted — even
        // when arrayBuffer() throws (10-min abort, connection reset). Without
        // this, a thrown arrayBuffer() leaks the timeout and skips markDirty(),
        // losing the persistence of any block this turn's compress created.
        try {
            const buf = await upstream.arrayBuffer();
            const text = Buffer.from(buf).toString("utf8");
            try {
                let json = JSON.parse(text) as Record<string, unknown>;
                if (prepared.protocol === "responses" && prepared.responsesTextProtocol) {
                    const requestBody = JSON.parse(typeof body === "string" ? body : body.toString("utf8")) as Record<string, unknown>;
                    const requestHeaders = buildForwardHeaders(headers);
                    json = await compressLoopResponsesJson(
                        json,
                        { core, config, messages: prepared.originalMessages, session: prepared.session, log: ctx.log, proxyUrl, textProtocol: true },
                        requestBody,
                        { url: upstreamUrl, headers: requestHeaders },
                    );
                }
                // Capture upstream usage so tokenCount (which drives nudge +
                // emergency-truncate) reflects reality for non-streaming
                // sessions too. The streaming loops do this in their SSE
                // event handlers; without it here, lastInputTokens stays 0 for
                // any non-streaming session → compression never fires. Field
                // names differ per protocol:
                //   Anthropic: input_tokens / cache_read_input_tokens / output_tokens
                //   OpenAI: prompt_tokens / prompt_tokens_details.cached_tokens / completion_tokens
                //   Responses: input_tokens / input_tokens_details.cached_tokens / output_tokens
                // usageTotals() normalizes the per-protocol semantics so
                // `total` is always the true context size (see util.ts).
                const u = (json.usage ?? {}) as Record<string, unknown>;
                const { total, cached } = usageTotals(prepared.protocol, u);
                if (typeof total === "number") {
                    prepared.session.stats.inputTokens += total;
                    // lastInputTokens = true TOTAL context (protocol-correct).
                    prepared.session.stats.lastInputTokens = total;
                    if (typeof cached === "number") {
                        prepared.session.stats.cachedTokens += cached;
                        prepared.session.stats.cacheSamples += 1;
                    }
                    const out = u.completion_tokens ?? u.output_tokens;
                    if (typeof out === "number") prepared.session.stats.outputTokens += out;
                }
                if (prepared.protocol === "openai") {
                    rewriteOpenaiJsonResponse(json, ctx);
                } else if (prepared.protocol === "responses") {
                    rewriteResponsesJsonResponse(json, ctx);
                } else {
                    rewriteJsonResponse(json, ctx);
                }
                res.end(JSON.stringify(json));
            } catch {
                res.end(text);
            }
        } finally {
            clearUpstreamTimer();
        }
    }
    // State may have mutated during response streaming (compress created a
    // block, decompress deactivated one) — persist the final snapshot.
    markDirty(prepared.session);
}

/** Read a (small) fetch Response body stream fully into a Buffer. Used for the
 *  non-2xx error path, where we inspect the body for a context-overflow before
 *  passing it through. Error bodies are small JSON, so full buffering is safe —
 *  but the read is still CAPPED (maxBytes, default 1 MiB): a misbehaving upstream
 *  that streams a huge error body must not spike memory. The stream is drained
 *  either way (no backpressure deadlock, no discarded keep-alive connection); only
 *  the retained bytes are capped. Overflow markers live in the first few hundred
 *  bytes, so a cap never loses the signal. */
async function readStreamToBuffer(stream: ReadableStream<Uint8Array>, maxBytes = 1 << 20): Promise<Buffer> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let kept = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && kept < maxBytes) {
                // Trim the final chunk so retained bytes never exceed maxBytes.
                const take = Math.min(value.length, maxBytes - kept);
                chunks.push(Buffer.from(value.subarray(0, take)));
                kept += take;
            }
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks);
}

async function pipeThrough(stream: ReadableStream<Uint8Array>, res: http.ServerResponse): Promise<void> {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) {
                await new Promise<void>((r) => res.once("drain", () => r()));
            }
        }
    } finally {
        reader.releaseLock();
        res.end();
    }
}

async function dumpStreamToFile(stream: ReadableStream<Uint8Array>, dir: string, name: string): Promise<void> {
    const { mkdirSync, createWriteStream } = await import("node:fs");
    const { join } = await import("node:path");
    try {
        mkdirSync(dir, { recursive: true });
        const ws = createWriteStream(join(dir, name));
        ws.on("error", (e) => { loggerLog("debug", `[dump] write stream error: ${(e as Error).message ?? e}`); });
        const reader = stream.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                ws.write(Buffer.from(value));
            }
        } finally {
            reader.releaseLock();
            ws.end();
        }
    } catch {
        // best-effort dump
    }
}

/** Derive a short human-readable title from the first user text message.
 *  Used so the web UI can show "Fix auth bug" instead of an opaque hash. */
function deriveTitle(messages: CoreMessage[]): string | undefined {
    for (const m of messages) {
        if (m.role !== "user" || m.contentType !== "text") continue;
        const clean = (m.text ?? "").replace(/\s+/g, " ").trim();
        if (clean) return clean.length > 60 ? clean.slice(0, 57) + "\u2026" : clean;
    }
    return undefined;
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
    opts.compress = loadOptions().compress;
    // Release cached ProxyAgents so agents for proxy URLs that were
    // removed/changed don't leak for the process lifetime. The next request
    // re-creates the needed agent lazily via proxyDispatcher().
    resetProxyCache();
    const names = Object.keys(fresh);
    log("info", `[acp-web] routes hot-reloaded (${names.length} providers): ${names.join(", ") || "(none)"}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: names.length, routes: names }));
}

function sendStats(res: http.ServerResponse): void {
    const sessions = listSessions().map((s) => ({
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
        lastSeen: new Date(s.lastSeen).toISOString(),
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions }, null, 2));
}

function headerValue(req: http.IncomingMessage, name: string): string | undefined {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
    }
    return undefined;
}

/** Thrown by readBody when the request body exceeds MAX_REQUEST_BYTES.
 *  handle() catches this and attempts a 413 response; readBody also destroys
 *  the request socket so a client that keeps streaming a pathological body
 *  cannot hold the connection open. */
export class BodyTooLargeError extends Error {
    constructor(public readonly limit: number) {
        super(`request body exceeds ${limit} bytes`);
        this.name = "BodyTooLargeError";
    }
}

export function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let aborted = false;
        req.on("data", (c: Buffer) => {
            if (aborted) return;
            size += c.length;
            if (size > MAX_REQUEST_BYTES) {
                aborted = true;
                req.destroy();
                reject(new BodyTooLargeError(MAX_REQUEST_BYTES));
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => { if (!aborted) resolve(Buffer.concat(chunks)); });
        req.on("error", (e) => { if (!aborted) reject(e); });
    });
}

function logMsg(opts: ProxyOptions, level: string, msg: string): void {
    if (!opts.log) return;
    loggerLog(level, msg);
}
