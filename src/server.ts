import http from "node:http";
import fs from "node:fs";
import { createCore, type CompressionCore, type Config, type CoreMessage, type NudgeDecision, estimateTokensFast, renderNudgeText, deactivateBlock } from "acp-kernel";
import type { ProxyOptions } from "./config.js";
import { loadOptions, loadRoutes } from "./config.js";
import { resetProxyCache } from "./upstream-proxy.js";
import { resolveContextLimit } from "./config.js";
import { contextFromRegistry, loadRegistry } from "./registry.js";
import { fetchWithTimeout, MAX_REQUEST_BYTES } from "./fetch-util.js";
import { formatUpstreamError, getUpstreamConnectionStatus, recordUpstreamConnection, resolveProxy, resolveProxyDecision, proxyDispatcher } from "./upstream-proxy.js";
import {
    anthropicToCore,
    coreToAnthropic,
    conversationSignalAnthropic,
    extractSystem,
    buildSystem,
    type AnthropicRequestBody,
} from "./anthropic.js";
import {
    openaiToCore,
    coreToOpenai,
    injectOpenaiSystem,
    conversationSignalOpenai,
    type OpenAIRequestBody,
    type OpenAITool,
} from "./openai.js";
import {
    type ResponsesRequestBody,
    type ResponseInputItem,
    type ResponsesProjection,
    responsesToCore,
    patchResponsesInput,
    injectResponsesDeveloperMessage,
    conversationIdentityResponses,
    conversationSignalResponses,
} from "./responses.js";
import { getSession, listSessions, type Session, initSessions, markDirty, flushAllSessions, acquireInFlight, releaseInFlight, withSessionLock, markNativeCompactionBoundary, reconcileNativeCompactionBoundary } from "./session.js";
import { COMPRESS_TOOL, ACP_TOOLS_ANTHROPIC, ACP_TOOLS_OPENAI, ACP_TOOLS_RESPONSES, COMPRESS_TOOL_NAME, buildCompressSystemPrompt, buildCompressTextSystemPrompt } from "./compress-tool.js";
import { rewriteSseStream, rewriteJsonResponse, type RewriteCtx } from "./stream.js";
import { applyRanges } from "./stream.js";
import { renderUI, handleConfigGet, handleConfigPut } from "./web/index.js";
import { reapOrphanBlocks } from "./orphan-gc.js";
import { getStore } from "./persist.js";
import { compressLoopStream } from "./compress-loop.js";
import { compressLoopAnthropicStream } from "./compress-loop-anthropic.js";
import { log as loggerLog, configureLogger, getLogPath, closeLogger } from "./logger.js";
import { defaultLogFile, stateDir } from "./paths.js";
import { compressLoopResponsesJson, compressLoopResponsesStream } from "./compress-loop-responses.js";
import { runCompressLoop, pickAdapter } from "./loop/index.js";
import { rewriteOpenaiJsonResponse } from "./stream-openai.js";
import { rewriteResponsesSseStream, rewriteResponsesJsonResponse } from "./stream-responses.js";
import { emitStreamError } from "./stream-error.js";
import { deriveSessionId as deriveProxySessionId, affinityToken, clientConversationHeader, type ConversationIdentity } from "./session-id.js";
import { setupMitm, readMitmUpstream } from "./mitm.js";
import type { BiliMessage } from "./bili-message.js";

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
]);

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
    if (opts.mitm.enabled) {
        setupMitm(server, opts.mitm.domains, (msg) => log("info", msg), (host) => resolveProxy(opts.routes, opts.proxy, `https://${host}`, opts.proxyFallback));
    }
    server.listen(opts.port, opts.host, () => {
        const displayHost = opts.host === "0.0.0.0" ? "localhost" : opts.host;
        const nOverrides = Object.keys(opts.routes).length;
        log(
            "info",
            `acp-proxy listening on http://${displayHost}:${opts.port}` +
                ` — web UI: http://${displayHost}:${opts.port}/__bili/` +
                ` — zero-config: prefix any baseURL with http://${displayHost}:${opts.port}/bili/` +
                (nOverrides ? ` — context overrides for ${nOverrides} upstream URL(s)` : "")
                + (opts.mitm.enabled ? ` — MITM proxy on (whitelist)${opts.mitm.domains.length ? ` +${opts.mitm.domains.join(",")}` : ""}` : ""),
        );
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
            void flushAllSessions().finally(() => {
                closeLogger();
                process.exit(0);
            });
        });
        // Hard fallback: if connections hang (client never closes), don't
        // block shutdown forever — force-exit after a grace window.
        setTimeout(() => {
            log("warn", "shutdown grace window elapsed; forcing exit");
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
    responsesTextProtocol?: boolean;
    resetAfterSuccess?: boolean;
    responsesProjection?: ResponsesProjection;
    anthropicSystem?: AnthropicRequestBody["system"];
};

/** True if `addr` is a loopback (IPv4 127.x or IPv6 ::1 / ::ffff:127.0.0.1).
 *  Used to gate the management endpoints to local connections only. */
function isLoopback(addr: string | undefined): boolean {
    if (!addr) return false;
    return addr === "::1" || addr === "127.0.0.1" || addr.startsWith("127.") || addr.startsWith("::ffff:127.");
}

function isTrustedAdminOrigin(origin: string | undefined, host: string | undefined): boolean {
    if (!origin) return true;
    if (!host) return false;
    try {
        const parsed = new URL(origin);
        return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
    } catch {
        return false;
    }
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
    if (isAdminPath && !isLoopback(req.socket.remoteAddress)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "management endpoints are loopback-only; access denied for " + (req.socket.remoteAddress ?? "unknown") }));
        return;
    }
    if (isAdminPath && !isTrustedAdminOrigin(req.headers.origin, req.headers.host)) {
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

    // Bili does not support WebSocket — reject any upgrade with 426 so clients
    // with built-in fast-fallback (e.g. Codex supports_websockets=true) retry over HTTP POST.
    if (req.headers.upgrade === "websocket") {
        res.writeHead(426, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "WebSocket upgrades are not supported; use HTTP POST" }));
        return;
    }
    let bodyBuffer: Buffer;
    try {
        bodyBuffer = await readBody(req);
        const decoded = await decodeRequestBody(headerValue(req, "content-encoding"), bodyBuffer, MAX_REQUEST_BYTES);
        bodyBuffer = decoded.body;
        if (decoded.decoded) delete req.headers["content-encoding"];
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
    const url = req.url ?? "";
    // Strip query string before matching path suffixes: a request like
    // `/v1/responses?foo=1` must still be detected as the responses protocol.
    const urlPath = url.split("?", 2)[0];
    const responsesCompact = urlPath.endsWith("/responses/compact");
    const countTokens = isCountTokensRequest(req.method ?? "GET", urlPath, bodyBuffer.length > 0);
    const route = resolveUpstream(opts, req.url ?? "", req);
    const upstreamOrigin = route ? route.upstream : opts.upstream;
    const protocol: "anthropic" | "openai" | "responses" | null =
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
    // Per-request context limit: look up body.model against the per-route
    // model declaration first, then the built-in table.
    let reqConfig = config;
    if (parsed && typeof parsed === "object") {
        const model = (parsed as { model?: string }).model;
        if (model) {
            // Match config by the embedded upstream URL (the /bili/<this> string).
            // The registry is a middle layer when config doesn't cover this URL/model.
            const embeddedUrl = route?.rewrittenUrl;
            let limit = resolveContextLimit(opts.routes, embeddedUrl, model);
            if (!limit && embeddedUrl) {
                const host = (() => { try { return new URL(embeddedUrl).host; } catch { return undefined; } })();
                limit = await contextFromRegistry(model, host);
            }
            if (limit && limit !== config.modelContextLimit) {
                reqConfig = { ...config, modelContextLimit: limit };
            }
        }
    }
    let prepared: Prepared | null = null;
    if (!opts.passthrough && protocol && parsed && typeof parsed === "object") {
        const sessionHeader = headerValue(req, opts.sessionHeader);
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
              : responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader);
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
        // Serialize per-session: prepare (processTurn mutates state) + forward
        // (stream rewriter mutates state via compress/decompress) must not
        // interleave across concurrent requests on the same session.
        await withSessionLock(session, async () => {
            prepared =
                countTokens
                    ? prepareCountTokens(parsed as AnthropicRequestBody, core, reqConfig, log, session)
                    : protocol === "anthropic"
                      ? prepareAnthropic(parsed as AnthropicRequestBody, req, opts, core, reqConfig, log, session)
                      : protocol === "openai"
                        ? prepareOpenai(parsed as OpenAIRequestBody, req, opts, core, reqConfig, log, session)
                        : responsesCompact
                          ? prepareResponsesCompact(bodyBuffer, parsed as ResponsesRequestBody, session)
                          : prepareResponses(parsed as ResponsesRequestBody, req, opts, core, reqConfig, log, session, responsesIdentity!);
            acquireInFlight(session);
            try {
                await forward(req, res, opts, prepared!.body, prepared!, core, reqConfig, log, route, affinity);
            } finally {
                releaseInFlight(session);
            }
        });
    }
    if (!prepared) {
        if (protocol === null && !opts.passthrough) {
            log("warn", `unrecognized path ${url} — not a known protocol (/chat/completions, /v1/messages, /responses, /responses/compact); forwarding unchanged`);
        }
        await forward(req, res, opts, bodyBuffer, null, core, reqConfig, log, route, undefined);
    }
}

const ACP_TAG_MARK = "\x3cacp ";

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

function diagNudge(turn: { nudge?: { shouldInject: boolean; reason: string; contextUsage: number; tier: number | null; breakdown?: Record<string, number> } | null }, sessionId: string, tokenCount: number, limit: number): string {
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
    return `[${sessionId}] nudge ${inject}: usage=${pct} (${tokenCount}/${limit}), growth=${growth}/${floor} (ref=${ref}, interval=${interval}), pendingT1=${pendingT1}/${interval}, reason="${n.reason.slice(0, 120)}"`;
}

function prepareAnthropic(
    parsed: AnthropicRequestBody,
    req: http.IncomingMessage,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
    session: Session,
): Prepared {
    const sessionId = session.id;
    const stream = parsed.stream === true;
    ++session.stats.requests;

    let processedMessages: CoreMessage[] = [];
    let originalMessages: CoreMessage[] = [];
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
        session.stats.contextTokens = tokenCount;
        if (!session.meta.title) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit));
        processedMessages = turn.messages;
        reapOrphanBlocks(session, msgs, deactivateBlock);
        rebuiltMessages = coreToAnthropic(processedMessages as BiliMessage[], cacheControls);

        systemOut = injectSystem(parsed, opts);
        if (opts.compress.injectTool) {
            toolsOut = injectTool(parsed.tools);
        }
        // Nudge as a separate trailing user message (cache-friendly): the
        // system block stays byte-stable so the prefix cache survives.
        if (turn.nudge?.shouldInject) {
            try {
                const rendered = renderNudgeText(turn.nudge);
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

    const rebuilt: AnthropicRequestBody = { ...parsed, messages: rebuiltMessages, system: systemOut, tools: toolsOut };
    markDirty(session);
    return { body: JSON.stringify(rebuilt), session, processedMessages, originalMessages, anthropicSystem: parsed.system, protocol: "anthropic", stream, compressInjected: opts.compress.injectTool } as Prepared;
}

function prepareOpenai(
    parsed: OpenAIRequestBody,
    req: http.IncomingMessage,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
    session: Session,
): Prepared {
    const sessionId = session.id;
    const stream = parsed.stream === true;
    ++session.stats.requests;

    let processedMessages: CoreMessage[] = [];
    let originalMessages: CoreMessage[] = [];
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

    try {
        const { msgs } = openaiToCore(parsed);
        originalMessages = msgs;
        // tokenCount = upstream's real input_tokens from the previous turn
        // (see anthropic branch comment). Never an estimate.
        const tokenCount = session.stats.lastInputTokens;
        const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount, renderTags: "text-only" });
        session.state = turn.state;
        session.stats.contextTokens = tokenCount;
        if (!session.meta.title) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit));
        processedMessages = turn.messages;
        reapOrphanBlocks(session, msgs, deactivateBlock);
        rebuiltMessages = coreToOpenai(processedMessages as BiliMessage[]);

        // ONLY the static compress prompt goes into the system message — the
        // system prompt is the prefix-cache anchor and must be byte-stable
        // across turns. The nudge (which changes every turn: token count,
        // growth %, dynamic example) is appended as a trailing user message
        // instead, mirroring pai-acp's design. Putting the nudge in system
        // would invalidate the cache every turn.
        const sysParts: string[] = [];
        if (shouldInject) sysParts.push(buildCompressSystemPrompt());
        rebuiltMessages = injectOpenaiSystem(rebuiltMessages, sysParts);
        if (shouldInject) {
            toolsOut = injectOpenaiTool(parsed.tools);
        }
        // Nudge as a separate trailing user message (cache-friendly).
        if (turn.nudge?.shouldInject && shouldInject) {
            try {
                const rendered = renderNudgeText(turn.nudge);
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
    markDirty(session);
    return { body: JSON.stringify(rebuilt), session, processedMessages, originalMessages, protocol: "openai", stream, compressInjected: shouldInject } as Prepared;
}

function prepareResponses(
    parsed: ResponsesRequestBody,
    req: http.IncomingMessage,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
    session: Session,
    identity: ConversationIdentity,
): Prepared {
    const sessionId = session.id;
    const stream = parsed.stream === true;
    ++session.stats.requests;
    if (reconcileNativeCompactionBoundary(session)) {
        log("info", `[${sessionId}] reconciled ACP state after native Responses compact boundary`);
    }

    let processedMessages: CoreMessage[] = [];
    let originalMessages: CoreMessage[] = [];
    let responsesProjection: ResponsesProjection | undefined;
    let rebuiltInput: ResponseInputItem[] | string = parsed.input;
    let toolsOut = parsed.tools;

    const shouldInject = opts.compress.injectTool;
    const responsesTextProtocol = FORCE_TEXT_PROTOCOL ||
        isChatGptCodexUpstream(session.meta.upstreamOrigin) ||
        isCodexResponsesLite(req.headers, parsed);

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
        session.stats.contextTokens = tokenCount;
        if (!session.meta.title) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit));
        processedMessages = turn.messages;
        reapOrphanBlocks(session, msgs, deactivateBlock);
        rebuiltInput = patchResponsesInput(projection, processedMessages);
        if (shouldInject && !process.env.ACP_NO_COMPRESS_PROMPT) {
            const prompt = responsesTextProtocol ? buildCompressTextSystemPrompt() : buildCompressSystemPrompt();
            const devContent = [...projection.systemParts, prompt].join("\n\n---\n\n");
            rebuiltInput = injectResponsesDeveloperMessage(rebuiltInput, devContent);
            if (!responsesTextProtocol && !process.env.ACP_NO_INJECT_TOOL) toolsOut = injectResponsesTool(parsed.tools);
        } else if (projection.systemParts.length > 0) {
            rebuiltInput = injectResponsesDeveloperMessage(rebuiltInput, projection.systemParts.join("\n\n---\n\n"));
        }
        if (turn.nudge?.shouldInject && shouldInject) {
            try {
                const rendered = renderNudgeText(turn.nudge);
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
    // Strip Responses' native chaining fields so the upstream does not resolve
    // stored server-side state on top of the input we already sent. Forwarding
    // previous_response_id would make the prefix shift every turn (as the id
    // advances) and duplicate history — breaking prompt-cache. `instructions`
    // was already lifted into the developer message at input[1], so forwarding
    // it again here double-sends it and violates the responses_lite contract
    // (top-level instructions must stay empty for code_mode tool exposure).
    delete rebuilt.previous_response_id;
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
    markDirty(session);
    return {
        body: JSON.stringify(rebuilt),
        session,
        processedMessages,
        originalMessages,
        responsesProjection,
        protocol: "responses",
        stream,
        compressInjected: shouldInject,
        responsesTextProtocol,
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
        const rebuiltMessages = coreToAnthropic(turn.messages as BiliMessage[], cacheControls);
        log("info", `[${sessionId}] count_tokens pruned: ${msgs.length} → ${turn.messages.length} msgs`);
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

export function isCodexResponsesLite(headers: http.IncomingHttpHeaders, body: ResponsesRequestBody): boolean {
    if (headers["x-openai-internal-codex-responses-lite"] !== undefined) return true;
    if (Object.prototype.hasOwnProperty.call(body, "additional_tools")) return true;
    return Array.isArray(body.input) && body.input.some((item) => item.type === "additional_tools");
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
): string | AnthropicRequestBody["system"] {
    // ONLY the static compress prompt goes into the system block — it is the
    // prefix-cache anchor and must stay byte-stable across turns. The nudge
    // (which changes every turn) is appended as a trailing user message by
    // the caller (prepareAnthropic), never merged into system.
    const baseText = extractSystem(parsed.system);
    const parts: string[] = [];
    if (opts.compress.injectTool) parts.push(buildCompressSystemPrompt());
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
function injectResponsesTool(tools: unknown[] | undefined): unknown[] {
    if (!Array.isArray(tools)) return [...ACP_TOOLS_RESPONSES];
    const present = new Set(
        tools
            .map((t) => (t as { name?: string })?.name)
            .filter((n): n is string => typeof n === "string"),
    );
    const additions = ACP_TOOLS_RESPONSES.filter((t) => !present.has(t.name));
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
    const rewritten = route ? route.rewrittenUrl : opts.upstream + (req.url ?? "");
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
    for (const [k, v] of Object.entries(req.headers)) {
        if (UPSTREAM_HOP_HEADERS.has(k.toLowerCase()) || v === undefined) continue;
        headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    headers["host"] = new URL(route ? route.upstream : opts.upstream).host;
    // Forward a client-provided Responses session identity only when it was
    // carried in the body rather than an existing request header.
    if (affinity && !clientConversationHeader(req.headers)) {
        headers["x-session-id"] = affinity;
    }
    const proxyUrl = resolveProxy(opts.routes, opts.proxy, route?.rewrittenUrl ?? upstreamUrl, opts.proxyFallback);
    const dispatcher = proxyDispatcher(proxyUrl);
    const init: Omit<RequestInit, "dispatcher"> & { dispatcher?: object } = {
        method: req.method ?? "GET",
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    };
    if (dispatcher) init.dispatcher = dispatcher;
    let upstreamResult: Awaited<ReturnType<typeof fetchWithTimeout>>;
    try {
        upstreamResult = await fetchWithTimeout(upstreamUrl, init);
        recordUpstreamConnection(upstreamUrl, proxyUrl);
    } catch (error) {
        recordUpstreamConnection(upstreamUrl, proxyUrl, error);
        throw new Error(`upstream request failed: ${formatUpstreamError(error, upstreamUrl, proxyUrl)}`, { cause: error });
    }
    const { response: upstream, clearTimer: clearUpstreamTimer } = upstreamResult;
    const respHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
        if (UPSTREAM_HOP_HEADERS.has(k.toLowerCase())) return;
        respHeaders[k] = v;
    });
    // P1.2: if the upstream returned a non-2xx (auth, rate-limit, context too
    // long, ...), do NOT route the error body through the SSE rewriter — it has
    // no SSE events and would be silently swallowed, leaving the client with
    // an empty stream and no idea why. Pass status + body through verbatim.
    // (writeHead is done HERE, only in the error branch, so we never double-
    // write headers when a later branch would also call writeHead.)
    if (!upstream.ok) {
        res.writeHead(upstream.status, respHeaders);
        if (upstream.body) await pipeThrough(upstream.body, res);
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
        if (process.env.ACP_LOOP_V2 !== "0") {
            const parsedReq = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
            const reqHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(headers)) {
                if (k.toLowerCase() === "content-length" || k.toLowerCase() === "host") continue;
                reqHeaders[k] = v;
            }
            reqHeaders["content-type"] = "application/json";
            const textProtocol = prepared.protocol === "responses" && !!prepared.responsesTextProtocol;
            const systemPrompt = textProtocol ? buildCompressTextSystemPrompt() : buildCompressSystemPrompt();
            const adapter = pickAdapter(prepared.protocol, parsedReq, textProtocol, prepared.responsesProjection, prepared.anthropicSystem);
            const loop = runCompressLoop(
                streamToRead,
                { core, config, messages: prepared.processedMessages.length > 0 ? prepared.processedMessages : prepared.originalMessages, session: prepared.session, log: ctx.log, proxyUrl, textProtocol, debug: opts.debug },
                parsedReq,
                { url: upstreamUrl, headers: reqHeaders },
                adapter,
                systemPrompt,
            );
            for await (const chunk of loop) {
                {
                    const s = chunk.toString("utf8");
                    if (s.includes("\x3cacp ") || s.includes("\x3c/acp")) {
                        log("warn", `[${prepared.session.id}] tag echo: ${prepared.protocol} response stream contains \x3cacp tag`);
                    }
                }
                res.write(chunk);
                if (res.writableNeedDrain) await new Promise<void>((r) => res.once("drain", () => r()));
            }
            res.end();
        } else if (prepared.protocol === "openai") {
            const parsedReq = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
            const reqHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(headers)) {
                if (k.toLowerCase() === "content-length" || k.toLowerCase() === "host") continue;
                reqHeaders[k] = v;
            }
            reqHeaders["content-type"] = "application/json";
            const loop = compressLoopStream(
                streamToRead,
                { core, config, messages: prepared.originalMessages, session: prepared.session, log: ctx.log, proxyUrl },
                parsedReq,
                { url: upstreamUrl, headers: reqHeaders },
            );
            for await (const chunk of loop) {
                {
                    const s = chunk.toString("utf8");
                    if (s.includes("\x3cacp ") || s.includes("\x3c/acp")) {
                        log("warn", `[${prepared.session.id}] tag echo: openai response stream contains <acp tag`);
                    }
                }
                if (!res.write(chunk)) await new Promise<void>((r) => res.once("drain", () => r()));
            }
        } else if (prepared.protocol === "responses") {
            const parsedReq = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
            const reqHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(headers)) {
                if (k.toLowerCase() === "content-length" || k.toLowerCase() === "host") continue;
                reqHeaders[k] = v;
            }
            reqHeaders["content-type"] = "application/json";
            const loop = compressLoopResponsesStream(
                streamToRead,
                { core, config, messages: prepared.originalMessages, session: prepared.session, log: ctx.log, proxyUrl, textProtocol: prepared.responsesTextProtocol },
                parsedReq,
                { url: upstreamUrl, headers: reqHeaders },
            );
            for await (const chunk of loop) {
                {
                    const s = chunk.toString("utf8");
                    if (s.includes("\x3cacp ") || s.includes("\x3c/acp")) {
                        log("warn", `[${prepared.session.id}] tag echo: responses response stream contains <acp tag`);
                    }
                }
                if (!res.write(chunk)) await new Promise<void>((r) => res.once("drain", () => r()));
            }
        } else {
            const parsedReq = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
            const reqHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(headers)) {
                if (k.toLowerCase() === "content-length" || k.toLowerCase() === "host") continue;
                reqHeaders[k] = v;
            }
            reqHeaders["content-type"] = "application/json";
            const loop = compressLoopAnthropicStream(
                streamToRead,
                { core, config, messages: prepared.originalMessages, session: prepared.session, log: ctx.log, proxyUrl },
                parsedReq,
                { url: upstreamUrl, headers: reqHeaders },
            );
            for await (const chunk of loop) {
                {
                    const s = chunk.toString("utf8");
                    if (s.includes("\x3cacp ") || s.includes("\x3c/acp")) {
                        log("warn", `[${prepared.session.id}] tag echo: anthropic response stream contains <acp tag`);
                    }
                }
                if (!res.write(chunk)) await new Promise<void>((r) => res.once("drain", () => r()));
            }
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
                    const requestHeaders: Record<string, string> = {};
                    for (const [key, value] of Object.entries(headers)) {
                        if (key.toLowerCase() === "content-length" || key.toLowerCase() === "host") continue;
                        requestHeaders[key] = value;
                    }
                    requestHeaders["content-type"] = "application/json";
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
                const u = (json.usage ?? {}) as Record<string, unknown>;
                const prompt = u.prompt_tokens ?? u.input_tokens;
                if (typeof prompt === "number") {
                    prepared.session.stats.inputTokens += prompt;
                    const promptDetails = u.prompt_tokens_details as Record<string, unknown> | undefined;
                    const inputDetails = u.input_tokens_details as Record<string, unknown> | undefined;
                    const cached = promptDetails?.cached_tokens ?? inputDetails?.cached_tokens ?? u.cache_read_input_tokens;
                    // tokenCount = TOTAL context (new + cached); see anthropic branch.
                    prepared.session.stats.lastInputTokens = prompt + (typeof cached === "number" ? cached : 0);
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
    // restart needed. Only routes are re-read; port/host/upstream stay as-is
    // (the listen socket is already bound). Mutates opts.routes in place so all
    // in-flight handle() closures that captured `opts` see the new routes.
    const fresh = loadRoutes();
    // Clear and refill the SAME object reference so resolveUpstream/resolveContextLimit
    // (which read opts.routes) pick up the new entries without needing reassignment.
    for (const k of Object.keys(opts.routes)) delete opts.routes[k];
    Object.assign(opts.routes, fresh);
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

/** A thrown BodyTooLargeError lets handle() respond 413 cleanly before
 *  destroying the request. Avoids a bare req.destroy() that would reject
 *  readBody but leave the client connection with no HTTP response. */
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
                // Reject FIRST so handle() can write a 413 and return.
                // Then drain remaining data so the socket can close
                // cleanly instead of lingering mid-request.
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
