import http from "node:http";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { createCore, type CompressionCore, type Config, type CoreMessage, type NudgeDecision, estimateTokensFast, renderNudgeText, deactivateBlock } from "acp-kernel";
import type { ProxyOptions } from "./config.js";
import { loadRoutes } from "./config.js";
import { resolveContextLimit } from "./config.js";
import { contextFromRegistry, loadRegistry } from "./registry.js";
import { fetchWithTimeout, MAX_REQUEST_BYTES } from "./fetch-util.js";
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
    responsesToCore,
    coreToResponses,
    injectResponsesInstructions,
    conversationSignalResponses,
} from "./responses.js";
import { getSession, listSessions, type Session, initSessions, markDirty, flushAllSessions, acquireInFlight, releaseInFlight, withSessionLock } from "./session.js";
import { COMPRESS_TOOL, ACP_TOOLS_ANTHROPIC, ACP_TOOLS_OPENAI, ACP_TOOLS_RESPONSES, COMPRESS_TOOL_NAME, buildCompressSystemPrompt, buildCompressTextSystemPrompt } from "./compress-tool.js";
import { rewriteSseStream, rewriteJsonResponse, type RewriteCtx } from "./stream.js";
import { renderUI, handleConfigGet, handleConfigPut } from "./web.js";
import { reapOrphanBlocks } from "./orphan-gc.js";
import { getStore } from "./persist.js";
import { compressLoopStream } from "./compress-loop.js";
import { log as loggerLog, configureLogger, getLogPath, closeLogger } from "./logger.js";
import { defaultLogFile } from "./paths.js";
import { compressLoopResponsesStream } from "./compress-loop-responses.js";
import { rewriteOpenaiJsonResponse } from "./stream-openai.js";
import { rewriteResponsesSseStream, rewriteResponsesJsonResponse } from "./stream-responses.js";
import { emitStreamError } from "./stream-error.js";
import { deriveSessionId as deriveProxySessionId, affinityToken, clientConversationHeader } from "./session-id.js";
import { setupMitm, readMitmUpstream } from "./mitm.js";

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

export function resolveUpstream(_opts: ProxyOptions, reqUrl: string, req?: http.IncomingMessage): { upstream: string; rewrittenUrl: string } | undefined {
    // MITM mode: the request arrived over a CONNECT tunnel we terminated
    // locally (client set HTTP_PROXY and issued CONNECT host:443). The socket
    // carries the real upstream origin; the request path has no /bili/ prefix
    // — it's a bare /api/anthropic/v1/messages. Reconstruct the full upstream
    // URL so handle()/forward() route to the host the CONNECT targeted. The
    // client's Authorization header (OAuth token for the subscription) is
    // forwarded verbatim → subscription auth preserved, no MITM of creds.
    const mitmUpstream = readMitmUpstream(req?.socket);
    if (mitmUpstream) {
        return { upstream: mitmUpstream, rewrittenUrl: mitmUpstream + (reqUrl ?? "") };
    }
    // Zero-config mode: a request like `/bili/https://open.bigmodel.cn/api/anthropic`
    // embeds the full upstream URL after the `/bili/` prefix. Strip the prefix,
    // take the rest verbatim as the upstream. This is the ONLY routing mode —
    // there are no named providers. The `/bili/` prefix doubles as a signal:
    // client-side billion-context extensions (billion-context-pi / opencode-acp)
    // can detect it in their own baseUrl and self-disable, avoiding double
    // compression.
    if (reqUrl.startsWith("/bili/http://") || reqUrl.startsWith("/bili/https://")) {
        const full = reqUrl.slice(6); // drop "/bili/"
        try {
            const u = new URL(full);
            return { upstream: `${u.protocol}//${u.host}`, rewrittenUrl: full };
        } catch {
            // malformed embedded URL
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
        setupMitm(server, opts.mitm.domains, (msg) => log("info", msg));
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
    body: string;
    session: Session;
    processedMessages: CoreMessage[];
    protocol: "anthropic" | "openai" | "responses";
    stream: boolean;
    compressInjected: boolean;
};

async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
): Promise<void> {
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
    if (req.method === "PUT" && req.url === "/__bili/config") return handleConfigPut(req, res);
    if (req.method === "POST" && req.url === "/__bili/config/reload") return handleConfigReload(opts, res, log);
    let bodyBuffer: Buffer;
    try {
        bodyBuffer = await readBody(req);
    } catch (err) {
        if (err instanceof BodyTooLargeError) {
            log("warn", `413: request body exceeds ${err.limit} bytes`);
            res.writeHead(413, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { type: "request_too_large", message: err.message } }));
            return;
        }
        log("warn", `read body failed: ${String(err)}`);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_request", message: String(err) } }));
        return;
    }
    const url = req.url ?? "";
    // Strip query string before matching path suffixes: a request like
    // `/v1/responses?foo=1` must still be detected as the responses protocol.
    const urlPath = url.split("?", 2)[0];
    const protocol: "anthropic" | "openai" | "responses" | null =
        req.method === "POST" && bodyBuffer.length > 0
            ? urlPath.endsWith("/chat/completions")
                ? "openai"
                : urlPath.endsWith("/v1/messages") || urlPath.endsWith("/messages")
                  ? "anthropic"
                  : urlPath.endsWith("/responses")
                    ? "responses"
                    : null
            : null;
    // Resolve the upstream route once here so both the session id (needs the
    // upstream ORIGIN for cross-provider isolation) and forward() (needs the
    // full rewritten URL) use the same decision. Computed before prepare() so
    // the session can embed the provider origin.
    const route = resolveUpstream(opts, req.url ?? "", req);
    const upstreamOrigin = route ? route.upstream : opts.upstream;
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
        const conversation =
            protocol === "anthropic"
                ? conversationSignalAnthropic(parsed as AnthropicRequestBody, sessionHeader)
                : protocol === "openai"
                  ? conversationSignalOpenai(parsed as OpenAIRequestBody, sessionHeader)
                  : conversationSignalResponses(parsed as ResponsesRequestBody, sessionHeader);
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
        const affinity = affinityToken(req.headers, conversation);
        const clientLabel = clientConversationHeader(req.headers);
        const session = getSession(sessionId, { protocol, upstreamOrigin, label: clientLabel ?? undefined });
        // Serialize per-session: prepare (processTurn mutates state) + forward
        // (stream rewriter mutates state via compress/decompress) must not
        // interleave across concurrent requests on the same session.
        await withSessionLock(session, async () => {
            prepared =
                protocol === "anthropic"
                    ? prepareAnthropic(parsed as AnthropicRequestBody, req, opts, core, reqConfig, log, session)
                    : protocol === "openai"
                      ? prepareOpenai(parsed as OpenAIRequestBody, req, opts, core, reqConfig, log, session)
                      : prepareResponses(parsed as ResponsesRequestBody, req, opts, core, reqConfig, log, session);
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
            log("warn", `unrecognized path ${url} — not a known protocol (/chat/completions, /v1/messages, /responses); forwarding unchanged`);
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
    let rebuiltMessages = parsed.messages;
    let systemOut = parsed.system;
    let toolsOut = parsed.tools;

    try {
        const { msgs, cacheControls } = anthropicToCore(parsed);
        const tokenCount = estimateTokensFast(msgs.map((m) => m.text ?? "").join("\n"));
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
        rebuiltMessages = coreToAnthropic(processedMessages, cacheControls);

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
    return { body: JSON.stringify(rebuilt), session, processedMessages, protocol: "anthropic", stream, compressInjected: opts.compress.injectTool } as Prepared;
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
        const tokenCount = estimateTokensFast(msgs.map((m) => m.text ?? "").join("\n"));
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
        rebuiltMessages = coreToOpenai(processedMessages);

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
    markDirty(session);
    return { body: JSON.stringify(rebuilt), session, processedMessages, protocol: "openai", stream, compressInjected: shouldInject } as Prepared;
}

function prepareResponses(
    parsed: ResponsesRequestBody,
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
    let rebuiltInput: ResponseInputItem[] | string = parsed.input;
    let toolsOut = parsed.tools;

    const shouldInject = opts.compress.injectTool;

    try {
        const { msgs, systemParts, preamble, customToolCallIds } = responsesToCore(parsed);
        if (process.env.ACP_DEBUG) {
            log("info", `[${sessionId}] input items: ${Array.isArray(parsed.input) ? parsed.input.map((i: ResponseInputItem) => i.type).join(",") : "(string)"}`);
        }
        const tokenCount = estimateTokensFast(msgs.map((m) => m.text ?? "").join("\n"));
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
        // Rebuild input preserving the responses_lite contract:
        //   input[0]   = additional_tools (host directive, verbatim)
        //   input[1]   = developer message (base instructions + compress prompt)
        //   input[2..] = conversation history (compressed)
        //   top-level `instructions` is NEVER touched — it must stay empty for
        //   responses_lite. Setting it non-empty breaks code_mode tool exposure.
        const conversationItems = coreToResponses(processedMessages, customToolCallIds);
        if (preamble.length > 0) {
            log("info", `[${sessionId}] preserved ${preamble.length} opaque preamble item(s): ${preamble.map((p) => p.type).join(",")}`);
        }

        const inputItems: ResponseInputItem[] = [...preamble];
        if (shouldInject && !process.env.ACP_NO_COMPRESS_PROMPT) {
            const sysParts = [...systemParts, buildCompressSystemPrompt()];
            inputItems.push({ type: "message", role: "developer", content: sysParts.join("\n\n---\n\n") });
            if (!process.env.ACP_NO_INJECT_TOOL) {
                toolsOut = injectResponsesTool(parsed.tools);
            }
        } else if (systemParts.length > 0) {
            // No compress injection, but still restore the base instructions
            // that responsesToCore lifted out of the input.
            inputItems.push({ type: "message", role: "developer", content: systemParts.join("\n\n---\n\n") });
        }
        inputItems.push(...conversationItems);
        if (process.env.ACP_DEBUG) {
            const ctcs = conversationItems.filter((i) => i.type === "custom_tool_call").length;
            const ctcos = conversationItems.filter((i) => i.type === "custom_tool_call_output").length;
            log("info", `[${sessionId}] rebuilt: msgs=${msgs.length} -> conv=${conversationItems.length} (custom_tool_call=${ctcs} custom_tool_call_output=${ctcos})`);
        }
        if (turn.nudge?.shouldInject && shouldInject) {
            try {
                const rendered = renderNudgeText(turn.nudge);
                if (rendered.text) {
                    inputItems.push({ type: "message", role: "user", content: rendered.text });
                }
            } catch {
            }
        }
        rebuiltInput = inputItems;
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    const rebuilt: ResponsesRequestBody = { ...parsed, input: rebuiltInput, tools: toolsOut };
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
    return { body: JSON.stringify(rebuilt), session, processedMessages, protocol: "responses", stream, compressInjected: shouldInject } as Prepared;
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
const TEXT_PROTOCOL = process.env.ACP_COMPRESS_PROTOCOL === "text";
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
    const upstreamUrl = route ? route.rewrittenUrl : opts.upstream + (req.url ?? "");
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
            if (process.env.ACP_DUMP_REQ === "1") {
                const out = `${tmpdir()}/acp-proxy-debug-req-${Date.now()}.json`;
                fs.writeFileSync(out, body.slice(0, 50000));
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
    // Inject a synthesized session-affinity header for clients that send none
    // (pi). opencode already sends x-session-affinity (passed through above);
    // codex carries identity in body.session_id (passes through in the body).
    // pi sends nothing, so upstream sticky-routing/cache pools would fall back
    // to content fingerprinting — give them a stable key instead. Only inject
    // when the client sent NO session header at all (don't shadow opencode's).
    if (affinity && !clientConversationHeader(req.headers)) {
        headers["x-session-id"] = affinity;
    }
    const init: RequestInit = {
        method: req.method ?? "GET",
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    };
    const { response: upstream, clearTimer: clearUpstreamTimer } = await fetchWithTimeout(upstreamUrl, init);
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
        return;
    }
    const ctx: RewriteCtx = {
        core,
        config,
        messages: prepared.processedMessages,
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
        if (prepared.protocol === "openai") {
            const parsedReq = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
            const reqHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(headers)) {
                if (k.toLowerCase() === "content-length" || k.toLowerCase() === "host") continue;
                reqHeaders[k] = v;
            }
            reqHeaders["content-type"] = "application/json";
            const loop = compressLoopStream(
                streamToRead,
                { core, config, messages: prepared.processedMessages, session: prepared.session, log: ctx.log },
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
                { core, config, messages: prepared.processedMessages, session: prepared.session, log: ctx.log },
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
            const rewriter = rewriteSseStream(streamToRead, ctx);
            for await (const chunk of rewriter) {
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
        const buf = await upstream.arrayBuffer();
        const text = Buffer.from(buf).toString("utf8");
        try {
            const json = JSON.parse(text);
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
        clearUpstreamTimer();
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
        cacheHitPct: s.stats.cacheSamples > 0 ? Math.round(s.stats.cachedTokens / s.stats.inputTokens * 100) : null,
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
