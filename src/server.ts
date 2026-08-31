import http from "node:http";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createCore, type CompressionCore, type CompressionState, type Config, type CoreMessage, type NudgeDecision, type Prompts, defaultPrompts, defaultCountTokens, estimateTokensFast, renderNudgeText, deactivateBlock, viableRanges } from "acp-kernel";
import { resolveCompress, resolveCompressPrompts, resolveRequestConfig } from "./compress-settings.js";
import type { ProxyOptions } from "./config.js";
import { loadOptions, loadRoutes } from "./config.js";
import { resetProxyCache } from "./upstream-proxy.js";
import { FALLBACK_EFFECTIVE_WINDOW_FLOOR, lookupContextLimit, resolveConfiguredContextLimit, resolveCompressProtocol } from "./config.js";
import { contextFromRegistry, loadRegistry, peekRegistryContext } from "./registry.js";
import { codexAlignedWindow } from "./codex-models.js";
import { fetchWithTimeout, MAX_REQUEST_BYTES } from "./fetch-util.js";
import { formatUpstreamError, getUpstreamConnectionStatus, recordUpstreamConnection, resolveProxy, resolveProxyDecision, proxyDispatcher, type UpstreamProxyDecision } from "./upstream-proxy.js";
import { maskHeaderForLog, maskHeadersForLog, maskHostPortForLog, maskUrlForLog, maskUrlsInText } from "./log-mask.js";
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
import { COMPRESS_TOOL, ACP_TOOLS_ANTHROPIC, ACP_TOOLS_OPENAI, ACP_TOOLS_RESPONSES, ACP_READONLY_TOOLS_RESPONSES, COMPRESS_TOOL_NAME, buildCompressSystemPrompt, buildCompressHybridSystemPrompt, withStagedCompressGuidance } from "./compress-tool.js";
import { rewriteSseStream, rewriteJsonResponse, type RewriteCtx } from "./stream.js";
import { applyRanges } from "./stream.js";
import { preflightCompress, estimateCoreMessages } from "./preflight.js";
import { renderUI, handleConfigGet, handleConfigPut } from "./web/index.js";
import { reapOrphanBlocks } from "./orphan-gc.js";
import { getStore } from "./persist.js";
import { log as loggerLog, configureLogger, getLogPath, closeLogger } from "./logger.js";
import { defaultLogFile, stateDir, proxyOriginFile } from "./paths.js";
import { compressLoopResponsesJson } from "./compress-loop-responses.js";
import { runCompressLoop, pickAdapter } from "./loop/index.js";
import { containsToolCallXmlFragment } from "./loop/tag-echo-filter.js";
import { sanitizeResponsesInputIds, dropWhitespaceResponsesMessages, normalizeResponsesMessageItems } from "./loop/adapter-responses.js";
import { codexCompactMode, isCodexClient, hasCompactionTrigger, stripBiliCompactionItems, replaceBiliCompactionItems, codexCompactGate, buildTriggerForgeBody, mergeForgedSummaries } from "./codex-compact.js";
import { rewriteOpenaiJsonResponse } from "./stream-openai.js";
import { rewriteResponsesJsonResponse } from "./stream-responses.js";
import { observeResponsesTerminalState } from "./stream-terminal.js";
import { emitStreamError } from "./stream-error.js";
import { affinityToken, clientConversationHeader, codexTurnIdentity, preferPromptCacheKeyIdentity, type ConversationIdentity } from "./session-id.js";
import { prefixAffinity, type AnonymousAffinity } from "./prefix-affinity.js";
import { consumePluginRegisterFor, flushConversations, handlePluginManifest, handlePluginRegister, handlePluginStatus, handlePluginTool, loadConversations, pipePluginJson, pipePluginResponsesWithStrip, pipeThroughWithUsage, pluginAgentHeader, pluginConversationHeader, pluginReportedContextWindow, recordPluginSession, rememberPluginMessages, takePendingPluginRegister } from "./plugin.js";
import { setupMitm, readMitmUpstream } from "./mitm.js";
import type { BiliMessage } from "acp-kernel/wire";
import { hoistMidSystemMessages, isLoopbackAddress, inspectContextOverflow, reserveOutputHeadroom, shouldReserveOutputHeadroom, usageTotals } from "./util.js";

import { decodeRequestBody } from "./content-encoding.js";

// Body dumps (dumps/req-*.json, raw/*-REQ.txt, raw/*-RES.txt, raw/*-INCOMING.txt,
// req-*-REREQUEST.json) write the full plaintext request body and are off by
// default. They are decoupled from --debug (verbose logging) and enabled only
// with ACP_DUMP_BODY=1 so `bili <client>` users don't leak conversation bodies
// to disk by default (#276).
function bodyDumpEnabled(): boolean {
    return process.env.ACP_DUMP_BODY === "1";
}

// Raw dumps are best-effort: a failure (disk full, locked dir, EPERM) must not
// break the request, but a silently-stopped dump hides real problems (#362).
// Rate-limited so a stuck dir doesn't spam the log.
let dumpFailCount = 0;
let lastDumpFailLog = 0;
export function logDumpFailure(where: string, err: unknown): void {
    dumpFailCount++;
    const now = Date.now();
    if (dumpFailCount === 1 || now - lastDumpFailLog >= 60_000) {
        lastDumpFailLog = now;
        const msg = err instanceof Error ? err.message : String(err);
        loggerLog("warn", `[dump] ${where} failed (total ${dumpFailCount}x): ${msg}`);
    }
}

// Non-protocol paths (client telemetry like /api/v1/event/report, ...) are
// forwarded unchanged — expected, not an error. Logging every hit spammed the
// log (~20k lines in one user's capture, #362). Per-path: first 3 at warn, one
// "suppressed" notice, then silent.
const unrecognizedPathCounts = new Map<string, number>();
export function logUnrecognizedPath(log: (level: string, msg: string) => void, url: string): void {
    // Strip the query before masking: a varying query (?ts=…) would otherwise
    // split one endpoint into unbounded keys and defeat the rate limit.
    const key = maskUrlsInText(url.split("?")[0]);
    const n = (unrecognizedPathCounts.get(key) ?? 0) + 1;
    unrecognizedPathCounts.set(key, n);
    if (n <= 3) {
        log("warn", `unrecognized path ${key} — not a known protocol (/chat/completions, /v1/messages, /responses, /responses/compact); forwarding unchanged`);
    } else if (n === 4) {
        log("info", `unrecognized path ${key}: forwarding unchanged; further occurrences suppressed`);
    }
}

// #300: bili→bili chain marker. When a bili instance forwards a request it has
// processed upstream, it stamps this header with its own instance id. A bili
// instance that RECEIVES a request already carrying it knows an upstream bili
// already ran the compression pipeline on this request — processing it again
// would double-compress and corrupt session state (issue #292). Clients never
// send this header, so its presence on an inbound request always means "came
// from a bili instance".
export const BILI_HOP_HEADER = "x-bili-hop";

// Per-model context windows handed over by a `bili <client>` launcher
// (BILI_LAUNCHER_MODEL_WINDOWS, JSON model-id → window), read from the
// client's OWN config (pi models.json / omp models.yml / …) at launch time.
// Ranked between the plugin report and the models.dev registry in the
// native-window chain — the client's own number is authoritative for its
// deployment (it is what the client itself truncates at), unlike the generic
// registry.
export function parseLauncherModelWindows(raw: string | undefined): Record<string, number> {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const out: Record<string, number> = {};
        for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v) && v > 0) out[id] = Math.floor(v);
        }
        return out;
    } catch {
        return {};
    }
}

const LAUNCHER_MODEL_WINDOWS: Readonly<Record<string, number>> = parseLauncherModelWindows(process.env.BILI_LAUNCHER_MODEL_WINDOWS);

function launcherContextWindow(model: string): number | undefined {
    return LAUNCHER_MODEL_WINDOWS[model];
}

/** Parse an `anthropic-beta` header for a larger-context beta (e.g.
 *  `context-1m-2025-08-07` → 1,000,000). The beta lets the CLIENT negotiate a
 *  window beyond the model's standard size, so it is the most direct per-request
 *  evidence of the window the upstream will actually serve — it outranks the
 *  model table / registry (which list the STANDARD window, e.g. 200K for claude)
 *  and must be re-read on every request (the header may appear/disappear between
 *  requests of the same session, #302). `context-Nm` generalizes to future
 *  larger-context betas (N × 1,000,000). Returns the largest requested window,
 *  or undefined when no context beta is present. */
export function anthropicBetaContextWindow(headers: Record<string, string | string[] | undefined>): number | undefined {
    const raw = headers["anthropic-beta"];
    if (raw === undefined) return undefined;
    const list = Array.isArray(raw) ? raw.join(",") : raw;
    let best: number | undefined;
    for (const part of list.split(",")) {
        const m = /^context-(\d+)m\b/.exec(part.trim().toLowerCase());
        if (!m) continue;
        const n = Number.parseInt(m[1], 10);
        if (!Number.isFinite(n) || n <= 0) continue;
        const w = n * 1_000_000;
        if (best === undefined || w > best) best = w;
    }
    return best;
}

/** Session ids are client-provided verbatim (#286) — sanitize before using
 *  one in a debug-dump FILENAME so a hostile value cannot escape the dir. */
function safeSessionId(id: string | undefined): string {
    return (id ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** 400 body for requests carrying no client-provided conversation identity
 *  AND no usable replayed history. Anonymous requests with a real message
 *  history are resolved by prefix affinity (#309); only degenerate probes
 *  (empty / system-only, or a fingerprint-sized history) fail explicitly. */
const NO_IDENTITY_MESSAGE =
    "Missing stable conversation identity. Send one of the headers: x-session-id, x-session-affinity, x-acp-session, x-opencode-session, x-claude-code-session-id, session-id — or body session_id / prompt_cache_key (responses/openai/anthropic). Requests replaying a conversation history are matched by content prefix affinity (#309); this one carries no usable history signal.";

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
    // #300: per-server identity stamped into the x-bili-hop marker on outbound
    // forwards. Per-server (not module-level) so two servers in one process
    // (tests) are distinct instances; a restart changing the id is harmless
    // (the chain check only compares against the other running instance).
    const instanceId = randomUUID();
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
            await handle(req, res, opts, core, config, log, instanceId);
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
        log("info", `[ws] rejected ${req.method} ${maskUrlsInText(req.url ?? "")} host=${req.headers.host ? maskHostPortForLog(req.headers.host) : "?"} with 426`);
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
        // Non-loopback bind (--host 0.0.0.0 / LAN IP) opts into serving
        // remote clients: CONNECT is then allowed for non-loopback clients
        // (whitelisted model hosts only — see setupMitm). Loopback binds
        // keep the strict loopback-only CONNECT gate (#240).
        const allowRemoteConnect = opts.host === "0.0.0.0" || opts.host === "::" || !isLoopbackAddress(opts.host);
        setupMitm(server, opts.mitm.domains, (msg) => log("info", msg), (host) => resolveProxy(opts.routes, opts.proxy, `https://${host}`, opts.proxyFallback), allowRemoteConnect);
    }
    server.listen(opts.port, opts.host, () => {
        const nonLoopbackBind = opts.host === "0.0.0.0" || opts.host === "::" || !isLoopbackAddress(opts.host);
        // Honest bind display: a wildcard bind shows as 0.0.0.0 (the user
        // chose to expose the proxy — hiding it behind "localhost" made
        // remote setups look broken in the log, see #240).
        const displayHost = nonLoopbackBind ? opts.host : opts.host === "0.0.0.0" ? "localhost" : opts.host;
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
        if (nonLoopbackBind) {
            log(
                "warn",
                `[security] bound to ${opts.host} — proxy endpoints (/bili/, CONNECT for whitelisted model hosts) are reachable from the network with NO authentication; /__bili/ management endpoints stay loopback-only. Restrict access with a firewall on untrusted networks. Remote agents: point baseURL at http://<this-host>:${opts.port}/bili/`,
            );
        }
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
    /** Set when a codex native-compaction request was intercepted and a
     *  success response was forged locally (BILI_CODEX_COMPACT=intercept +
     *  gate passed). forward() serves `body` without contacting upstream. */
    codexForge?: { kind: "endpoint" | "trigger"; body: string; contentType: string };
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
    instanceId: string,
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
        const params = new URLSearchParams(query);
        const conversationId = params.get("conversationId")?.trim() ?? "";
        if (!conversationId) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "conversationId query parameter is required" }));
            return;
        }
        return handlePluginStatus(conversationId, res, params.get("fallback") === "latest");
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
    // Unknown /__bili/ or /__acp/ path → 404 locally. These are bili's own
    // management prefixes; forwarding would leak the internal path to the
    // upstream (which 403s it) — #346.
    if (isAdminPath) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "not_found", message: "no such management endpoint" } }));
        return;
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
    // #300: bili→bili chain detection. If the inbound request already carries
    // the x-bili-hop marker, an upstream bili instance already ran the
    // compression pipeline on it. Processing it again would double-compress
    // and corrupt session state (#292). Skip ALL processing (no tool/tag
    // injection, no acp-loop, no session state) and pass the request through
    // verbatim. Clients never send this header, so its presence on an inbound
    // request always means "came from a bili instance".
    const hopMarker = headerValue(req, BILI_HOP_HEADER);
    if (hopMarker !== undefined) {
        const selfLoop = hopMarker === instanceId;
        log("warn", selfLoop
            ? `[chain] inbound request carries THIS instance's ${BILI_HOP_HEADER} marker (${hopMarker}) — self-loop detected. Passing through without processing; check your upstream config (it may point back to this instance).`
            : `[chain] inbound request carries ${BILI_HOP_HEADER} from another bili instance (${hopMarker}) — bili→bili chain detected. Passing through without processing to avoid double compression; keep only one bili instance in the chain.`);
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
        const p = parsed as Record<string, unknown>;
        const hasPrev = p.previous_response_id !== undefined;
        const inLen = Array.isArray(p.input) ? p.input.length : 0;
        log("info", `[debug] INCOMING previous_response_id=${hasPrev ? String(p.previous_response_id).slice(0, 16) : "absent"} input_items=${inLen} instructions=${p.instructions !== undefined ? "present" : "absent"}`);
    }
    if (bodyDumpEnabled() && parsed && typeof parsed === "object") {
        try {
            const rawDir = process.env.ACP_RAW_DUMP_DIR || `${stateDir()}/raw`;
            try { fs.mkdirSync(rawDir, { recursive: true }); } catch { /* best-effort */ }
            const hdrs = maskHeadersForLog(
                Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)])),
            );
            const hdrText = Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join("\n");
            fs.writeFileSync(`${rawDir}/${Date.now()}-INCOMING.txt`, `${req.method} ${maskUrlsInText(req.url ?? "")}\n${hdrText}\n\n${bodyBuffer.toString("utf8")}`);
        } catch (err) { logDumpFailure("INCOMING dump", err); }
    }
    // Per-request context limit + compression tuning: look up body.model against
    // the per-route model declaration first, then the built-in table / registry.
    // Compress settings (global → provider → model) merge deepest-field-wins and
    // are applied on top of the resolved limit. `compress.contextLimit` (an
    // absolute number, a "70%" string of the native window, or unset → native)
    // overrides the table.
    let reqConfig = config;
    // True when the resolved native window came from a low-confidence fallback
    // (built-in table / env default) instead of an authoritative source — such
    // windows get an effective-floor after output-headroom reservation (see
    // FALLBACK_EFFECTIVE_WINDOW_FLOOR). Cleared if a learned overflow limit or
    // an async registry hit replaces the value.
    let nativeFromFallback = false;
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
            // Native-window resolution order: (0) the client's `anthropic-beta`
            // larger-context negotiation (context-1m-… → 1,000,000) — the most
            // direct per-request evidence of the window the upstream will serve,
            // so it outranks every static source (the model table / registry
            // list the STANDARD window, e.g. 200K for claude); (1) a cooperative
            // plugin's report (the agent's own config — most authoritative, gated
            // on the x-bili-plugin marker so a plain client cannot rewrite the
            // nudge denominator by name); (1b) the launcher's per-model
            // windows (BILI_LAUNCHER_MODEL_WINDOWS — the client's own
            // models.json/models.yml contextWindow, authoritative for this
            // deployment, no header trust needed since only the launcher
            // sets the env); (2) the user's per-route per-model declaration —
            // operator-controlled and deployment-specific: the same model name
            // can have different windows behind different relays (a private
            // relay may serve gpt-5.6-sol at 272K while models.dev lists the
            // official 1M), so an explicit declaration always outranks the
            // auto-fetched registry (#344); (3) a WARM models.dev registry
            // cache (daily refresh — outranks the static table whenever
            // already resident; peek never fetches, cold start skips to (4)
            // without blocking); (4) the built-in CONTEXT_LIMIT_TABLE
            // fallback. Operator tuning via compress.modelContextLimit still
            // outranks everything inside resolveRequestConfig.
            const host = (() => { try { return embeddedUrl ? new URL(embeddedUrl).host : undefined; } catch { return undefined; } })();
            const betaWindow = anthropicBetaContextWindow(req.headers);
            const pluginWindow = pluginReportedContextWindow(req.headers);
            const launcherWindow = launcherContextWindow(model);
            const configuredWindow = resolveConfiguredContextLimit(opts.routes, embeddedUrl, model);
            const peekWindow = host ? peekRegistryContext(model, host) : undefined;
            let native = betaWindow
                ?? pluginWindow
                ?? launcherWindow
                ?? configuredWindow
                ?? peekWindow
                ?? lookupContextLimit(model);
            // Fallback = no authoritative source AND the operator did not
            // explicitly tune the window via compress.modelContextLimit (an
            // explicit tuning is owned by the operator — never floored). The
            // beta window is authoritative (the client's own runtime
            // negotiation), so it also clears the fallback flag.
            const operatorWindowTuned = resolveCompress(opts.routes, embeddedUrl, model, opts.compress).modelContextLimit !== undefined;
            nativeFromFallback = !betaWindow && !pluginWindow && !launcherWindow && !peekWindow && !configuredWindow && !operatorWindowTuned;
            if (!native && host) {
                native = await contextFromRegistry(model, host);
                if (native) nativeFromFallback = false;
            }
            reqConfig = resolveRequestConfig(config, opts.routes, embeddedUrl, model, native, opts.compress);
            // #321 PR-E1: a codex client carries its OWN window perception
            // (bundled model table + 272K unknown-model fallback) and
            // auto-compacts at 90% of it. If bili's budget exceeds what codex
            // believes, codex's native compaction fires first — the #292
            // misalignment. Cap the effective window at codex's perception.
            // An operator's explicit compress.modelContextLimit is exempt
            // (operator tuning is owned by the operator — never floored and
            // never clamped); the clamped value is authoritative for this
            // client (codex's own config), so it also clears the
            // low-confidence fallback flag.
            const aligned = operatorWindowTuned
                ? { limit: reqConfig.modelContextLimit, clamped: false }
                : codexAlignedWindow(reqConfig.modelContextLimit, model, req.headers);
            if (aligned.clamped) {
                const before = reqConfig.modelContextLimit;
                reqConfig = { ...reqConfig, modelContextLimit: aligned.limit };
                nativeFromFallback = false;
                log("info", `[codex] effective window clamped ${before} → ${aligned.limit} (codex's own perception for model=${model}; ACP now compresses before codex's native auto-compact)`);
            }
            reqPrompts = resolveCompressPrompts(resolveCompress(opts.routes, embeddedUrl, model, opts.compress));
        }
    }
    let prepared: Prepared | null = null;
    // #300: `hopMarker !== undefined` means an upstream bili already processed
    // this request — skip the whole pipeline (prepared stays null) so the
    // passthrough path below forwards it verbatim.
    if (!opts.passthrough && hopMarker === undefined && protocol && parsed && typeof parsed === "object") {
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
        // Codex turn-metadata partitioning (#316 / PR-A): when the explicit
        // Codex turn metadata is present and cross-checked against the
        // thread-id header, partition compression state by thread_source.
        // Root ("user") turns keep the session-id header (current semantics,
        // stable across turns); subagents get their own thread-id (fresh
        // independent state per thread, #150). Untrusted metadata (absent /
        // unparseable / mismatched / unknown thread_source) → undefined, and
        // the legacy chain below is unchanged.
        const codexTurn = protocol === "responses" ? codexTurnIdentity(req.headers) : undefined;
        const responsesIdentity = protocol === "responses"
            ? (codexTurn
                ? { value: codexTurn.value, source: "header" as const, clientProvided: true }
                : preferPromptCacheKeyIdentity(
                      conversationIdentityResponses(parsed as ResponsesRequestBody, convHeader),
                      parsed as ResponsesRequestBody,
                  ))
            : undefined;
        // OpenAI chat mirrors the responses pck promotion: clients that replay
        // full history statelessly (omp chat-completions via a relay) send NO
        // conversation headers, so the kernel's openai signal falls to a hash of
        // the first user message that never matches the session id the agent
        // plugin registered (identity register is keyed by the omp session
        // uuid). prompt_cache_key (stamped by the omp plugin, or sent natively)
        // is the client's own stable per-conversation id — promote it over the
        // fingerprint only; a real conversation header stays stronger.
        const openaiSignal = protocol === "openai"
            ? conversationSignalOpenai(parsed as OpenAIRequestBody, convHeader)
            : "";
        const openaiIdentity = protocol === "openai"
            ? preferPromptCacheKeyIdentity(
                  convHeader
                    ? { value: openaiSignal, source: "header" as const, clientProvided: true }
                    : { value: openaiSignal, source: "content-fingerprint" as const, clientProvided: false },
                  parsed as { prompt_cache_key?: unknown },
              )
            : undefined;
        // Anthropic mirrors the openai pck promotion (#268): the omp plugin
        // stamps prompt_cache_key on every chat-shaped payload — it cannot
        // tell the anthropic wire apart by shape (both carry max_tokens). The
        // proxy consumes the field on this wire too (identity + mapping);
        // prepareAnthropic strips it before the real Anthropic sees it.
        const anthropicSignal = protocol === "anthropic"
            ? conversationSignalAnthropic(parsed as AnthropicRequestBody, convHeader)
            : "";
        const anthropicIdentity = protocol === "anthropic"
            ? preferPromptCacheKeyIdentity(
                  convHeader
                    ? { value: anthropicSignal, source: "header" as const, clientProvided: true }
                    : { value: anthropicSignal, source: "content-fingerprint" as const, clientProvided: false },
                  parsed as { prompt_cache_key?: unknown },
              )
            : undefined;
        const conversation = protocol === "anthropic"
            ? anthropicIdentity?.value ?? anthropicSignal
            : protocol === "openai"
              ? openaiIdentity?.value ?? openaiSignal
              : codexTurn
                // Trusted Codex turn id enters the verbatim session chain
                // directly — do NOT route it through subagentNamespace (the
                // kernel's empty-instructions non-anchoring path is left
                // untouched for metadata-less clients).
                ? codexTurn.value
                : subagentNamespace(
                      responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader),
                      (parsed as ResponsesRequestBody).instructions,
                  );
        // The session ID is the client-provided conversation value VERBATIM —
        // no hash, no protocol/credential/upstream dimensions (#286): those
        // are all mutable mid-conversation (bearer rotation, relay switching,
        // protocol translation), and only the client's own conversation id is
        // bound to the conversation. Requests without a client-provided
        // identity are rejected: content-fingerprint sessions have a real
        // collision surface and would silently orphan state.
        const clientProvided = protocol === "responses"
            ? (responsesIdentity?.clientProvided ?? false)
            : protocol === "openai"
              ? (openaiIdentity?.clientProvided ?? false)
              : protocol === "anthropic"
                ? (anthropicIdentity?.clientProvided ?? false)
                : !!convHeader;
        // Anonymous fallback (#309): clients with no identity signal at all
        // (no headers, no session_id/prompt_cache_key) still replay their full
        // history — resolve them by longest-prefix affinity instead of the
        // #286 hard 400. Resolution is content-only (#286 lesson): protocol,
        // upstream and credentials are mutable mid-conversation and MUST NOT
        // fork the session. Requests with no usable conversation signal
        // (empty / system-only) keep the explicit 400.
        let anonAffinity: AnonymousAffinity | null = null;
        if (!clientProvided) {
            const anonMessages = protocol === "responses"
                ? (parsed as { input?: unknown }).input ?? []
                : (parsed as { messages?: unknown }).messages ?? [];
            anonAffinity = prefixAffinity.resolve(Array.isArray(anonMessages) ? anonMessages : []);
            if (!anonAffinity) {
                log("warn", `400: no stable conversation identity on ${protocol} request → ${upstreamOrigin}; refusing to create a content-fingerprint session (#286)`);
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify(protocol === "anthropic"
                    ? { type: "error", error: { type: "invalid_request_error", message: NO_IDENTITY_MESSAGE } }
                    : { error: { type: "invalid_request_error", message: NO_IDENTITY_MESSAGE } }));
                return;
            }
            if (anonAffinity.via === "tail-window") {
                log("info", `[prefix-affinity] anonymous ${protocol} request → session ${anonAffinity.sessionId} (tail-window reattach window=${anonAffinity.matchedDepth}/${anonAffinity.incomingDepth}, tail=${anonAffinity.tailHash.slice(0, 8)}; truncated replay reattached, kernel reconciles by message id)`);
                loggerLog("info", `[prefix-affinity] session ${anonAffinity.sessionId} reattached via tail-window (window ${anonAffinity.matchedDepth}/${anonAffinity.incomingDepth}, tail=${anonAffinity.tailHash.slice(0, 8)})`);
            } else if (anonAffinity.matchedDepth > 0) {
                log("info", `[prefix-affinity] anonymous ${protocol} request → session ${anonAffinity.sessionId} (prefix match depth=${anonAffinity.matchedDepth}/${anonAffinity.incomingDepth}, tail=${anonAffinity.tailHash.slice(0, 8)}; fork semantics: diverged histories split on their next request)`);
                loggerLog("info", `[prefix-affinity] session ${anonAffinity.sessionId} matched at depth ${anonAffinity.matchedDepth}/${anonAffinity.incomingDepth} (tail=${anonAffinity.tailHash.slice(0, 8)})`);
            } else {
                const lineage = anonAffinity.lineage ? `; lineage=${anonAffinity.lineage.reason} of ${anonAffinity.lineage.parents.join(",")}` : "";
                log("info", `[prefix-affinity] new anonymous session ${anonAffinity.sessionId} (depth=${anonAffinity.incomingDepth}, tail=${anonAffinity.tailHash.slice(0, 8)}${lineage})`);
                loggerLog("info", `[prefix-affinity] new session ${anonAffinity.sessionId} at depth ${anonAffinity.incomingDepth} (tail=${anonAffinity.tailHash.slice(0, 8)}${lineage})`);
            }
        }
        const sessionId = anonAffinity ? anonAffinity.sessionId : conversation;
        // Two separate uses of the conversation signal:
        //  - `affinity`: header value forwarded upstream for sticky-routing /
        //    cache pools. Synthesized as ses_<conversation> when the client
        //    sent none (pi), so upstream still gets a stable key.
        //  - `label`: human-readable display in the web UI / stats. We store
        //    ONLY the client's own value (opencode x-session-affinity, codex
        //    body.session_id) — never the synthetic one — so a user can tell
        //    at a glance which client owns a session. pi sends nothing, so its
        //    label stays empty (shown as "—" in the UI).
        const bodyIdentity = responsesIdentity ?? openaiIdentity ?? anthropicIdentity;
        const affinity = affinityToken(bodyIdentity ?? {
            value: clientConv ?? conversation,
            source: clientConv ? "header" : "generated",
            clientProvided: !!clientConv,
        });
        const clientLabel = bodyIdentity?.clientProvided
            ? bodyIdentity.value
            : clientConversationHeader(req.headers);
        const session = getSession(sessionId, { protocol, upstreamOrigin, label: clientLabel ?? (anonAffinity ? "prefix-affinity" : undefined) });
        if (anonAffinity) {
            prefixAffinity.note(sessionId, anonAffinity.incomingDepth, anonAffinity.tailHash, anonAffinity.itemHashes);
            session.metadata.anonymousPrefixAffinity = {
                depth: anonAffinity.incomingDepth,
                tailHash: anonAffinity.tailHash,
                via: anonAffinity.via,
                ...(anonAffinity.lineage ? { lineage: anonAffinity.lineage } : {}),
            };
        }
        // Launcher-mode binding (#162): prefer identity — claude code sends
        // x-claude-code-session-id on every request, equal to the
        // CLAUDE_CODE_SESSION_ID the MCP shell registered, so binding is
        // race-free. Fall back to the headless pending queue (codex spawn)
        // for the first request that creates a new session.
        if (!pluginAgent && !anonAffinity) {
            const identityAgent = consumePluginRegisterFor(clientConv ?? conversation);
            if (identityAgent) {
                pluginAgent = identityAgent;
                pluginConversation = clientConv ?? conversation;
            }
        }
        if (!pluginAgent && session.stats.requests === 0 && codexTurnIdentity(req.headers) === undefined) {
            // A codex subagent thread mints a fresh session too, but it must
            // not claim the ROOT conversation's pending register (the plugin
            // binding belongs to the root session, #317).
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
        // Responses, OpenAI-chat AND Anthropic-wire clients that send their
        // own session id as `prompt_cache_key` (omp) get that conversation
        // recorded even WITHOUT the x-bili-plugin header, so the /acp command
        // — which looks the session up by the client's session id — can find
        // it. The session id itself now ALSO derives from prompt_cache_key (the
        // preferPromptCacheKeyIdentity calls above, which only kick in when the
        // kernel would have fallen to a per-request content fingerprint) — this
        // lookup binding remains for clients that send a real conversation
        // header or session_id.
        if (protocol === "responses" || protocol === "openai" || protocol === "anthropic") {
            const pck = (parsed as { prompt_cache_key?: unknown }).prompt_cache_key;
            if (typeof pck === "string" && pck.trim().length > 0) {
                recordPluginSession(pck.trim(), session.id);
            }
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
            // A learned limit is ground truth from a real overflow — it must
            // not be floored back up (that would undo the self-heal).
            nativeFromFallback = false;
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
            let reserved = reserveOutputHeadroom(reqConfig.modelContextLimit, maxOutput);
            // Fallback-derived windows are optimistic guesses: never let the
            // output-headroom reservation push the effective window below the
            // floor (issue #282: 128k table − 64k max_tokens → 64k effective
            // for a 1M-window model). If the real window is smaller, the first
            // upstream overflow self-heals it.
            if (nativeFromFallback && reserved < FALLBACK_EFFECTIVE_WINDOW_FLOOR) {
                log("info", `[${session.id}] fallback context window floored: ${reserved} → ${FALLBACK_EFFECTIVE_WINDOW_FLOOR} (model=${String(p.model ?? "?")} not authoritatively identified; self-heal corrects it if the real window is smaller)`);
                reserved = FALLBACK_EFFECTIVE_WINDOW_FLOOR;
            }
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
                const runPrepare = (): Prepared =>
                    countTokens
                        ? prepareCountTokens(parsed as AnthropicRequestBody, core, reqConfig, log, session)
                        : protocol === "anthropic"
                          ? prepareAnthropic(parsed as AnthropicRequestBody, req, opts, core, reqConfig, reqPrompts, log, session, pluginMode)
                          : protocol === "openai"
                            ? prepareOpenai(parsed as OpenAIRequestBody, req, opts, core, reqConfig, reqPrompts, log, session, pluginMode)
                            : responsesCompact
                               ? prepareResponsesCompact(bodyBuffer, parsed as ResponsesRequestBody, session, req, core, reqConfig, log)
                              : prepareResponses(parsed as ResponsesRequestBody, req, opts, core, reqConfig, reqPrompts, log, session, responsesIdentity!, pluginMode, upstreamOrigin);
                prepared = runPrepare();
                if (!countTokens && !responsesCompact) {
                    const outcome = await preflightCompressIfNeeded(
                        prepared,
                        runPrepare,
                        req,
                        res,
                        opts,
                        core,
                        reqConfig,
                        (parsed as { model?: string }).model,
                        route,
                        affinity,
                        log,
                        instanceId,
                    );
                    if (isPreflightFailFast(outcome)) {
                        // #301: the payload still overflows the window and
                        // preflight could not fix it — answer with a
                        // structured error instead of forwarding.
                        if (outcome.respond && !res.headersSent && !res.destroyed) {
                            // Retry-After on the 503 (rate-limited) path: gives
                            // well-behaved clients a backoff signal instead of
                            // hammering the rate-limited upstream (#301).
                            res.writeHead(outcome.status, {
                                "content-type": "application/json",
                                ...(outcome.status === 503 ? { "retry-after": "30" } : {}),
                            });
                            res.end(JSON.stringify({
                                error: {
                                    type: "server_error",
                                    code: "preflight_compress_failed",
                                    message: outcome.message,
                                    retryable: outcome.retryable,
                                },
                            }));
                        }
                        return;
                    }
                    prepared = outcome;
                }
                await forward(req, res, opts, prepared!.body, prepared!, core, reqConfig, log, route, instanceId, affinity);
                // Remember for ALL modes (not just plugin): wire clients (dsh,
                // hermes, unplug'd pi) read the same panel via /__bili/plugin/status
                // and need the nudge/breakdown sections too.
                if (prepared) {
                    rememberPluginMessages(sessionId, prepared.processedMessages, prepared.originalMessages, prepared.nudge);
                }
            });
        } finally {
            releaseInFlight(session);
        }
    }
    if (!prepared) {
        if (protocol === null && !opts.passthrough) {
            logUnrecognizedPath(log, req.url ?? "");
        }
        await forward(req, res, opts, bodyBuffer, null, core, reqConfig, log, route, instanceId, undefined);
    }
}

const ACP_TAG_MARK = "\x3cacp ";

// acp-kernel injects an in-place `acp_summary_*` at the compressed range as a
// generic-library fallback. This host strips it ONLY when it is redundant: the
// block's compress tool-call also carries the summary (hideConsumedCompressCalls
// keeps active-block calls), and a mid-stream insertion would shift the upstream
// prefix-cache breakpoint. Blocks created without a tool call (preflight
// compression, src/preflight.ts — #247) have NO other carrier: their anchor is
// the only place the summary reaches the model, so it must survive.
function stripKernelSummaries(messages: BiliMessage[], state: CompressionState): BiliMessage[] {
    const carried = new Set<string>();
    for (const b of state.blocks) {
        if (!b.active || !b.compressCallId) continue;
        if (messages.some((m) => m.contentType === "tool-call" && m.toolCallId === b.compressCallId)) {
            carried.add(`acp_summary_${b.blockId}`);
        }
    }
    return messages.filter((m) => !(m.id ?? "").startsWith("acp_summary_") || !carried.has(m.id));
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

    if (isAutoModeClassifier(parsed)) {
        log("info", `[${sessionId}] auto-mode classifier passthrough (skipping compress injection)`);
        return { body: JSON.stringify(parsed), session, processedMessages: [], originalMessages: [], anthropicSystem: parsed.system, protocol: "anthropic", stream, compressInjected: false, pluginMode, nudge: undefined, prompts } as Prepared;
    }

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
        // The fold from last turn's compress has now materialized in state —
        // future usage reports are post-fold reality, drop the credit.
        session.stats.compressCreditTokens = 0;
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
        processedMessages = stripKernelSummaries(turn.messages, turn.state);
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
                    rebuiltMessages = [...rebuiltMessages, { role: "user", content: withStagedCompressGuidance(rendered.text) }];
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
    // prompt_cache_key is the omp plugin's session id stamped for the proxy's
    // identity chain (#268), not part of the Anthropic Messages API — strip it
    // so the real upstream never sees a field it doesn't know.
    delete (rebuilt as Record<string, unknown>).prompt_cache_key;
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
        // The fold from last turn's compress has now materialized in state —
        // future usage reports are post-fold reality, drop the credit.
        session.stats.compressCreditTokens = 0;
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
        processedMessages = stripKernelSummaries(turn.messages, turn.state);
        reapOrphanBlocks(session, msgs, deactivateBlock);
        rebuiltMessages = hoistMidSystemMessages(coreToOpenai(processedMessages as BiliMessage[]));

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
                    rebuiltMessages = [...rebuiltMessages, { role: "user", content: withStagedCompressGuidance(rendered.text) }];
                }
            } catch {
            }
        }
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    const rebuilt: OpenAIRequestBody = { ...parsed, messages: rebuiltMessages, tools: toolsOut as OpenAITool[] | undefined };
    // prompt_cache_retention is an OpenAI-host-only cache directive; the dsh
    // launcher forces PI_CACHE_RETENTION=long (for the session-id
    // prompt_cache_key) which makes the client also emit it. Third-party
    // OpenAI-compatible upstreams may reject unknown fields, and cache policy
    // is the upstream's business — strip it. prompt_cache_key itself passes
    // through: upstreams that ignore it lose nothing, upstreams that use it
    // get a per-conversation routing hint.
    delete (rebuilt as Record<string, unknown>).prompt_cache_retention;
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
    upstreamOrigin: string,
): Prepared {
    const sessionId = session.id;
    const stream = parsed.stream === true;
    ++session.stats.requests;
    if (reconcileNativeCompactionBoundary(session)) {
        log("info", `[${sessionId}] reconciled ACP state after native Responses compact boundary`);
    }

    // A codex client echoes our forged compaction item back in the next
    // request; replace it with a plain summary-carrying user message so the
    // handoff rides the replayable history (kernel-compressible, retained by
    // codex's own user-message rule) instead of a foreign opaque blob. Real
    // OpenAI blobs carry no bili marker and pass through untouched.
    let echoReplaced = false;
    if (Array.isArray(parsed.input)) {
        const { items, replaced, dropped } = replaceBiliCompactionItems(parsed.input);
        if (replaced > 0 || dropped > 0) {
            echoReplaced = true;
            log("info", `[${sessionId}] replaced ${replaced} echoed bili compaction item(s) with summary handoff message(s)${dropped > 0 ? `, dropped ${dropped} legacy marker item(s)` : ""}`);
            parsed.input = items as typeof parsed.input;
        }
    }

    let processedMessages: CoreMessage[] = [];
    let originalMessages: CoreMessage[] = [];
    let nudge: NudgeDecision | undefined;
    let responsesProjection: ResponsesProjection | undefined;
    let rebuiltInput: ResponseInputItem[] | string = parsed.input;
    let toolsOut = parsed.tools;
    let transformOk = false;

    // #242: over-long input item ids (poisoned rollouts) 400 upstream on every
    // request; rewrite them to short deterministic ids before anything reads
    // or replays the input.
    // omp-style type-less user items must be typed before the projection
    // drops them (see normalizeResponsesMessageItems) — before id sanitize and
    // whitespace drop so those see the canonical form.
    const typedItems = normalizeResponsesMessageItems(parsed.input);
    if (typedItems > 0) {
        log("info", `[${sessionId}] stamped type:"message" on ${typedItems} type-less input item(s) before projection (omp wire form)`);
    }
    sanitizeResponsesInputIds(parsed.input);

    const droppedEmpty = dropWhitespaceResponsesMessages(parsed.input);
    if (droppedEmpty > 0) {
        log("info", `[${sessionId}] dropped ${droppedEmpty} whitespace-only message item(s) before projection (flattened-turn artifact)`);
    }

    const shouldInject = opts.compress.injectTool;
    const injectTools = shouldInject && !pluginMode;
    // Codex native remote-compact request: no compress prompt/tools (the model
    // produces the compaction itself), no acp tags, plain passthrough so the
    // response terminal state can gate the rebase marker.
    const isCompactionTrigger = hasCompactionTrigger(parsed.input);
    // Route config is keyed by the upstream THIS request goes to (#286: a
    // session can outlive its first relay — session.meta.upstreamOrigin is
    // first-wins and would silently ignore the new relay's route settings).
    const responsesTextProtocol = FORCE_TEXT_PROTOCOL ||
        resolveCompressProtocol(opts.routes, upstreamOrigin) === "marker";

    try {
        const projection = responsesToCore(parsed);
        responsesProjection = projection;
        const { msgs } = projection;
        originalMessages = msgs;
        if (process.env.ACP_DEBUG) {
            log("info", `[${sessionId}] input items: ${Array.isArray(parsed.input) ? parsed.input.map((i: ResponseInputItem) => i.type).join(",") : "(string)"}`);
        }
        const tokenCount = session.stats.lastInputTokens;
        const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount, renderTags: process.env.ACP_RENDER_NONE || isCompactionTrigger ? "none" : "text-only" });
        session.state = turn.state;
        // The fold from last turn's compress has now materialized in state —
        // future usage reports are post-fold reality, drop the credit.
        session.stats.compressCreditTokens = 0;
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
        processedMessages = stripKernelSummaries(turn.messages, turn.state);
        reapOrphanBlocks(session, msgs, deactivateBlock);
        rebuiltInput = patchResponsesInput(projection, processedMessages);
        // Fallback path: when the echo did NOT come back this turn (client
        // dropped it / restarted), the history-borne handoff is absent and the
        // forge-time captured summaries are re-injected into the developer
        // message so the pre-compaction content is never lost. When the echo
        // DID come back, the replacement message carries the summaries and
        // the injection is suppressed to avoid duplicating them.
        const forgedSummaries = echoReplaced
            ? []
            : (session.metadata.codexForgedSummaries as string[] | undefined) ?? [];
        if (shouldInject && !isCompactionTrigger && !process.env.ACP_NO_COMPRESS_PROMPT) {
            const prompt = responsesTextProtocol ? buildCompressHybridSystemPrompt(prompts) : buildCompressSystemPrompt(prompts);
            const devContent = [...projection.systemParts, ...forgedSummaries, prompt].join("\n\n---\n\n");
            rebuiltInput = injectResponsesDeveloperMessage(rebuiltInput, devContent);
            if (!process.env.ACP_NO_INJECT_TOOL && injectTools) {
                toolsOut = responsesTextProtocol
                    ? injectResponsesTool(parsed.tools, ACP_READONLY_TOOLS_RESPONSES)
                    : injectResponsesTool(parsed.tools);
            }
        } else if (projection.systemParts.length > 0 || forgedSummaries.length > 0) {
            const devContent = [...projection.systemParts, ...forgedSummaries].join("\n\n---\n\n");
            rebuiltInput = injectResponsesDeveloperMessage(rebuiltInput, devContent);
        }
        // A nudge appended after a trailing `compaction_trigger` would break
        // the upstream's "must be the final input item" requirement and is
        // redundant — the native compact IS the compression.
        if (opts.compress.injectNudge && turn.nudge?.shouldInject && shouldInject && !isCompactionTrigger) {
            try {
                const rendered = renderNudgeText(turn.nudge, prompts);
                if (rendered.text) {
                    const inputItems: ResponseInputItem[] = typeof rebuiltInput === "string"
                        ? [{ type: "message", role: "user", content: rebuiltInput }]
                        : rebuiltInput;
                    inputItems.push({ type: "message", role: "user", content: withStagedCompressGuidance(rendered.text) });
                    rebuiltInput = inputItems;
                }
            } catch {
            }
        }
        transformOk = true;
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    // E2 trigger form: codex's native remote-compaction request (final input item
    // is compaction_trigger). When the kill-switch is on, the client is codex, and
    // the safety gate passes, forge a success SSE (one compaction item +
    // response.completed) and skip upstream — a deterministic handoff to the ACP
    // state instead of a foreign compaction blob.
    let codexForge: Prepared["codexForge"] | undefined;
    if (transformOk
        && codexCompactMode() === "intercept"
        && isCodexClient(req.headers)
        && hasCompactionTrigger(parsed.input)
        && codexCompactGate(session, config.modelContextLimit, transformOk)) {
        const summaries = session.state.blocks.filter((b) => b.active).map((b) => b.summary);
        const prevForged = session.metadata.codexForgedSummaries as string[] | undefined;
        const captured = mergeForgedSummaries(prevForged, session.state.blocks);
        if (captured.length !== (prevForged?.length ?? 0)) {
            session.metadata.codexForgedSummaries = captured;
            markDirty(session);
        }
        // Codex recomputes its ledger from the next real request, but the
        // usage we mint here must not read as an empty context: fall back to
        // estimating the trigger payload itself when lastInputTokens is
        // stale/zero. The reply honors parsed.stream (JSON body when not
        // streaming).
        const est = defaultCountTokens(typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input ?? ""));
        const total = Math.max(session.stats.lastInputTokens, est, 1);
        codexForge = {
            kind: "trigger",
            ...buildTriggerForgeBody(summaries.join("\n\n"), { inputTokens: total, outputTokens: 0, totalTokens: total }, stream),
        };
        log("info", `[${sessionId}] codex compact intercepted (trigger); forged SSE with ${summaries.length} block summary(s), upstream not contacted`);
    }

    const rebuilt: ResponsesRequestBody = { ...parsed, input: rebuiltInput, tools: toolsOut };
    // Route with the upstream THIS request goes to — session.meta.upstreamOrigin
    // is first-wins and would keep injecting pck toward a relay we switched
    // away from (same class of bug as the compressProtocol fix above, #286).
    const promptCacheKey = resolvePromptCacheKey(
        rebuilt.prompt_cache_key,
        identity,
        opts.promptCache.routing,
        upstreamOrigin,
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
    // Same rationale as prepareOpenai: strip the OpenAI-host-only cache
    // directive; keep prompt_cache_key. Sent by hermes' codex transport and
    // by any PI_CACHE_RETENTION=long client.
    delete (rebuilt as Record<string, unknown>).prompt_cache_retention;
    // Log the final tools we forward upstream so we can confirm ACP tools are
    // present. Distinguishes "compress" (top-level function) from Codex
    // namespace items (type:namespace/custom).
    if (process.env.ACP_DEBUG) {
        const fwdTools = (Array.isArray(toolsOut) ? toolsOut : []).map((t) => {
            const r = t as Record<string, unknown>;
            const sub = Array.isArray(r.tools) ? `(${r.tools.length} sub)` : "";
            return `${r.type as string}:${(r.name as string) ?? "?"}${sub}`;
        });
        log("info", `[${sessionId}] responses forward tools=[${fwdTools.join(",")}] injectTool=${injectTools}${pluginMode ? " (plugin mode: wire injection suppressed)" : ""} NO_INJECT_TOOL=${!!process.env.ACP_NO_INJECT_TOOL} NO_COMPRESS_PROMPT=${!!process.env.ACP_NO_COMPRESS_PROMPT}`);
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
        compressInjected: injectTools && !isCompactionTrigger,
        pluginMode,
        responsesTextProtocol,
        nudge,
        prompts,
        resetAfterSuccess: isCompactionTrigger,
        codexForge,
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
        const stripped = stripKernelSummaries(turn.messages as BiliMessage[], turn.state);
        const rebuiltMessages = coreToAnthropic(stripped, cacheControls);
        log("info", `[${sessionId}] count_tokens pruned: ${msgs.length} → ${stripped.length} msgs`);
        const rebuilt: AnthropicRequestBody = { ...parsed, messages: rebuiltMessages };
        delete (rebuilt as Record<string, unknown>).prompt_cache_key;
        return {
            body: JSON.stringify(rebuilt),
            session,
            processedMessages: [],
            originalMessages: msgs,
            protocol: "anthropic",
            stream: false,
            compressInjected: false,
        };
    } catch (err) {
        log("warn", `[${sessionId}] count_tokens prune failed, forwarding unchanged: ${String(err)}`);
        const fallback: AnthropicRequestBody = { ...parsed };
        delete (fallback as Record<string, unknown>).prompt_cache_key;
        return {
            body: JSON.stringify(fallback),
            session,
            processedMessages: [],
            originalMessages: [],
            protocol: "anthropic",
            stream: false,
            compressInjected: false,
        };
    }
}

function prepareResponsesCompact(
    body: Buffer,
    parsed: ResponsesRequestBody,
    session: Session,
    req: http.IncomingMessage,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
): Prepared {
    ++session.stats.requests;
    // A bili-forged compaction item is never for the upstream (it carries our
    // sentinel blob) — strip it on every forwarding path, same as the normal
    // /responses pipeline does.
    const cleaned = Array.isArray(parsed.input) ? stripBiliCompactionItems(parsed.input) : parsed.input;
    const stripped = Array.isArray(parsed.input) && cleaned.length !== parsed.input.length;
    const forgeBody: ResponsesRequestBody = { ...parsed, input: cleaned };
    const base: Prepared = {
        body: stripped ? Buffer.from(JSON.stringify(forgeBody)) : body,
        session,
        processedMessages: [],
        originalMessages: [],
        protocol: "responses",
        stream: parsed.stream === true,
        compressInjected: false,
        resetAfterSuccess: true,
    };
    if (codexCompactMode() !== "intercept" || !isCodexClient(req.headers) || !Array.isArray(parsed.input)) {
        return base;
    }
    // The state commit below is all-or-nothing: every non-forge path restores
    // the pre-turn state so a passthrough compact is not raced against a
    // half-applied fold (the upstream's own compaction boundary is handled by
    // markNativeCompactionBoundary + rebase instead).
    const prevState = session.state;
    // E2 endpoint form: /responses/compact. When the gate passes, run the same
    // fold pipeline as a normal turn and forge the compacted history as
    // {"output": [...]} — a deterministic handoff to the ACP state instead of a
    // foreign compaction blob.
    let transformOk = false;
    try {
        const projection = responsesToCore(forgeBody);
        const turn = core.processTurn({ messages: projection.msgs, state: session.state, config, tokenCount: session.stats.lastInputTokens, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only" });
        session.state = turn.state;
        transformOk = true;
        if (!codexCompactGate(session, config.modelContextLimit, transformOk)) {
            session.state = prevState;
            return base;
        }
        const processed = stripKernelSummaries(turn.messages, turn.state);
        const output = patchResponsesInput(projection, processed);
        if (typeof output === "string") {
            session.state = prevState;
            return base;
        }
        snapshotMessages(session, projection.msgs);
        markDirty(session);
        log("info", `[${session.id}] codex compact intercepted (endpoint); forged history with ${output.length} item(s), upstream not contacted`);
        return { ...base, codexForge: { kind: "endpoint", body: JSON.stringify({ output }), contentType: "application/json" } };
    } catch (err) {
        session.state = prevState;
        log("warn", `[${session.id}] codex compact forge failed (${String(err)}); passing through to upstream`);
        return base;
    }
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

// Claude Code's auto-mode safety classifier one-shots expect a strict XML
// verdict — the default `xml_2stage` mode stops the response at `</severity>`
// or `</block>`. These are not compressible conversations: the compress
// system-prompt + ACP tools (or the kernel round-trip) derailed the small model
// from that verdict, so the classifier reported "could not evaluate" (#353).
// The magic stop sequences are the only in-body signal; forward them untouched.
const AUTO_MODE_CLASSIFIER_STOPS = new Set(["</severity>", "</block>"]);

function isAutoModeClassifier(parsed: AnthropicRequestBody): boolean {
    const stops = parsed.stop_sequences;
    if (!Array.isArray(stops)) return false;
    return stops.some((s) => typeof s === "string" && AUTO_MODE_CLASSIFIER_STOPS.has(s));
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

type ForwardTarget = {
    upstreamUrl: string;
    headers: Record<string, string>;
    proxyUrl: string | undefined;
};

// Log each unique (host, proxy, source) upstream-proxy decision once so the
// proxy choice is visible without per-request spam. Catches the "silent proxy"
// case where an env/system proxy is picked up unexpectedly.
const loggedUpstreamProxyDecisions = new Set<string>();
function logUpstreamProxyDecision(opts: ProxyOptions, upstreamUrl: string | undefined, decision: UpstreamProxyDecision): void {
    if (!upstreamUrl) return;
    let host = upstreamUrl;
    try {
        host = new URL(upstreamUrl).host;
    } catch {
        /* keep the raw url as the key */
    }
    // Dedup key uses the real host (internal, never logged); the log line masks
    // non-public hosts (#255) so a private upstream/proxy address never leaks.
    const key = `${host}|${decision.proxy ?? ""}|${decision.source}`;
    if (loggedUpstreamProxyDecisions.has(key)) return;
    loggedUpstreamProxyDecisions.add(key);
    const via = decision.proxy ? `via ${maskUrlForLog(decision.proxy)}` : "direct";
    logMsg(opts, "info", `[upstream-proxy] ${maskHostPortForLog(host)} ${via} (source=${decision.source})`);
}

function buildForwardTarget(
    req: http.IncomingMessage,
    opts: ProxyOptions,
    route: ReturnType<typeof resolveUpstream>,
    affinity?: string,
    hopMarker?: string,
): ForwardTarget {
    // rewrittenUrl may use a `mitm://` scheme (for config-lookup distinction
    // — see resolveUpstream). fetch needs the real https:// scheme, so strip
    // mitm:// back to https:// for the actual upstream request.
    const reqUrl = req.url ?? "";
    const isAbsoluteUrl = /^https?:\/\//i.test(reqUrl);
    const rewritten = route ? route.rewrittenUrl : isAbsoluteUrl ? reqUrl : opts.upstream + reqUrl;
    const upstreamUrl = rewritten.replace(/^mitm:\/\//, "https://");
    const headers: Record<string, string> = {};
    const reqConnNamed = connectionNamedHeaders(req.headers["connection"]);
    for (const [k, v] of Object.entries(req.headers)) {
        const lower = k.toLowerCase();
        if (UPSTREAM_HOP_HEADERS.has(lower) || reqConnNamed.has(lower) || v === undefined) continue;
        headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    // #300: stamp the chain marker AFTER copying inbound headers so it wins
    // over any inbound value (only set when this instance processed the
    // request; a passthrough leaves the inbound marker — if any — intact so it
    // keeps propagating down the chain).
    if (hopMarker !== undefined) headers[BILI_HOP_HEADER] = hopMarker;
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
    const decision = resolveProxyDecision(opts.routes, opts.proxy, route?.rewrittenUrl ?? upstreamUrl, opts.proxyFallback);
    logUpstreamProxyDecision(opts, upstreamUrl, decision);
    return { upstreamUrl, headers, proxyUrl: decision.proxy };
}

// #247: context exceeds the (new) model's window — usually right after a
// mid-session model switch. The payload would overflow at forward time and
// the reactive nudge could never fire (the request itself is rejected before
// the model sees it), so the session would be stuck. Compress oldest
// compressible ranges first (summarization calls sized to fit the smaller
// window), then rebuild the payload.
/** Fail-fast outcome (#301): the payload still overflows the window and
 *  preflight could not fix it, so the proxy answers with a structured error
 *  instead of forwarding a guaranteed-400 payload (wasted quota + retry
 *  storms). */
interface PreflightFailFast {
    failFast: true;
    status: number;
    message: string;
    retryable: boolean;
    /** False when the client already disconnected — there is nothing to write. */
    respond: boolean;
}

function isPreflightFailFast(outcome: Prepared | PreflightFailFast): outcome is PreflightFailFast {
    return "failFast" in outcome;
}

async function preflightCompressIfNeeded(
    prepared: Prepared,
    runPrepare: () => Prepared,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    model: string | undefined,
    route: ReturnType<typeof resolveUpstream>,
    affinity: string | undefined,
    log: (level: string, msg: string) => void,
    instanceId: string,
): Promise<Prepared | PreflightFailFast> {
    const session = prepared.session;
    const limit = config.modelContextLimit;
    // A fresh session (id rotated, e.g. after a model switch) has
    // lastInputTokens = 0 while still carrying a full raw history; size the
    // trigger on the real post-fold payload too.
    const payloadEstimate = estimateCoreMessages(prepared.processedMessages);
    const tokenCount = Math.max(session.stats.lastInputTokens, payloadEstimate);
    if (limit <= 0 || !model || tokenCount < limit) return prepared;
    // #301: forwarding as-is is safe ONLY when the payload's own estimate
    // fits the window. The trigger (and the loop's fit check) floor on
    // session.stats.lastInputTokens, which can be stale — e.g. a
    // double-counted usage report (#300) — and must not turn a fitting
    // payload into a fail-fast false positive.
    const failFast = (status: number, detail: string, retryable: boolean): PreflightFailFast => {
        const message =
            `context ~${tokenCount} tokens exceeds the model window ${limit} (model=${model}) ` +
            `and preflight compression could not bring it under: ${detail}. ` +
            `The over-window payload was NOT forwarded.`;
        log("error", `[${session.id}] preflight fail-fast ${status} (retryable=${retryable}): ${message}`);
        return { failFast: true, status, message, retryable, respond: !res.writableEnded };
    };
    if ((prepared.nudge?.compressibleRanges ?? []).length === 0) {
        if (payloadEstimate < limit) {
            log("warn", `[${session.id}] preflight trigger fired on a stale baseline (~${tokenCount}) but the payload fits (~${payloadEstimate}/${limit}); forwarding as-is`);
            return prepared;
        }
        return failFast(502, "no part of the conversation is compressible (nothing left to fold)", false);
    }
    log("warn", `[${session.id}] context ${tokenCount} tokens exceeds model window ${limit} (model=${model}); preflight compressing before forward`);
    // #300: stamp the chain marker so a downstream bili skips these
    // summarization calls too (preflight always processes).
    const { upstreamUrl, headers, proxyUrl } = buildForwardTarget(req, opts, route, affinity, instanceId);
    const clientAbort = new AbortController();
    res.on("close", () => {
        if (!res.writableEnded) clientAbort.abort();
    });
    const started = Date.now();
    const result = await preflightCompress(
        {
            core,
            session,
            config,
            prompts: prepared.prompts ?? defaultPrompts,
            protocol: prepared.protocol,
            url: upstreamUrl,
            headers,
            model,
            proxyUrl,
            signal: clientAbort.signal,
            log,
        },
        prepared.originalMessages,
    );
    if (result.payloadEstimate < limit) {
        if (result.compressedRanges > 0) {
            log("info", `[${session.id}] preflight compressed ${result.compressedRanges} range(s), ~${result.savedTokens} tokens saved (${tokenCount} → ${session.stats.lastInputTokens}) in ${Date.now() - started}ms; rebuilding payload`);
            const rebuilt = runPrepare();
            // runPrepare re-incremented stats.requests; the rebuild is internal
            // to this single client request.
            session.stats.requests -= 1;
            return rebuilt;
        }
        log("warn", `[${session.id}] preflight made no progress but the payload fits (~${result.payloadEstimate}/${limit}); forwarding as-is`);
        return prepared;
    }
    // The payload still overflows the window: fail fast with a diagnostic
    // error instead of forwarding a guaranteed-400 payload (#301).
    const f = result.failure;
    if (f?.kind === "aborted") {
        log("warn", `[${session.id}] preflight aborted (${f.detail}); not forwarding`);
        return { failFast: true, status: 0, message: f.detail, retryable: false, respond: false };
    }
    const status = f?.kind === "upstream" && f.status === 429 ? 503 : 502;
    return failFast(status, f?.detail ?? "unknown reason", status === 503);
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
    instanceId: string,
    affinity?: string,
): Promise<void> {
    // E2: a codex native-compaction request intercepted in prepare() carries a
    // forged success response — serve it without contacting upstream.
    if (prepared?.codexForge) {
        log("info", `[${prepared.session.id}] codex compact served locally (${prepared.codexForge.kind}); upstream not contacted`);
        res.writeHead(200, { "content-type": prepared.codexForge.contentType });
        res.end(prepared.codexForge.body);
        return;
    }
    // #300: stamp the chain marker ONLY when this instance actually processed
    // the request (prepared !== null). A passthrough forward (prepared === null)
    // must NOT claim processing — otherwise a downstream processing bili would
    // wrongly skip and the user loses compression. When prepared is null any
    // inbound marker (from an upstream bili) is preserved verbatim by
    // buildForwardTarget, so the marker keeps propagating down the chain.
    const { upstreamUrl, headers, proxyUrl } = buildForwardTarget(req, opts, route, affinity, prepared !== null ? instanceId : undefined);
    // Show the final proxied URL (where the request actually lands) as the
    // primary signal. The provider label is appended only for named routes —
    // zero-config requests have a single routing mode now, so the final
    // proxied URL is the only useful signal in the log.
    log("info", `forward ${req.method} → ${maskUrlForLog(upstreamUrl)}`);
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
    if (typeof body === "string" && (opts.debug || bodyDumpEnabled())) {
        try {
            const parsed = JSON.parse(body);
            if (opts.debug) {
                const toolNames = (parsed.tools ?? []).map((t: Record<string, unknown>) => {
                    const fn = t.function as { name?: string } | undefined;
                    // chat completions nests under `function`; Responses API is flat.
                    return fn?.name ?? (t.name as string | undefined) ?? "?";
                });
                log("info", `[debug] tools=[${toolNames.join(",")}] msgs=${parsed.messages?.length ?? 0} stream=${parsed.stream ?? false} system_len=${JSON.stringify(parsed.messages?.find((m: Record<string, string>) => m.role === "system")?.content ?? "").length}`);
            }
            if (bodyDumpEnabled() && process.env.ACP_DUMP_REQ !== "0") {
                const dumpDir = process.env.ACP_DUMP_DIR || `${stateDir()}/dumps`;
                try { fs.mkdirSync(dumpDir, { recursive: true }); } catch { /* best-effort */ }
                const sid = prepared?.session.id ?? "unknown";
                const out = `${dumpDir}/req-${Date.now()}-${safeSessionId(sid)}.json`;
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
    if (opts.debug) {
        const hdrLog: Record<string, string> = {};
        for (const [hk, hv] of Object.entries(headers)) {
            if (typeof hv === "string") {
                const masked = maskHeaderForLog(hk, hv);
                hdrLog[hk] = masked.length > 200 ? masked.slice(0, 200) + "..." : masked;
            }
        }
        log("info", `[${prepared?.session.id ?? "unknown"}] → upstream headers: ${JSON.stringify(hdrLog)}`);
    }
    // Raw HTTP capture: dump the COMPLETE exchange (request method/URL/all
    // headers/exact body bytes; response status+headers) so two consecutive
    // requests can be byte-diffed to locate a cache-breaker that the JSON body
    // dump (which re-formats and omits headers) may hide. Enabled with
    // ACP_DUMP_BODY=1 (credential header values + non-public hosts masked).
    const rawBase =
        bodyDumpEnabled()
            ? (() => {
                  try {
                      const rawDir = process.env.ACP_RAW_DUMP_DIR || `${stateDir()}/raw`;
                      fs.mkdirSync(rawDir, { recursive: true });
                      return `${rawDir}/${Date.now()}-${safeSessionId(prepared?.session.id)}`;
                  } catch {
                      return "";
                  }
              })()
            : "";
    if (rawBase) {
        try {
            const hdrText = Object.entries(maskHeadersForLog(headers))
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n");
            const bodyText =
                req.method === "GET" || req.method === "HEAD"
                    ? ""
                    : typeof body === "string"
                      ? body
                      : Buffer.from(body).toString("utf8");
            const reqPath = `${rawBase}-REQ.txt`;
            fs.writeFileSync(reqPath, `${req.method ?? "POST"} ${maskUrlForLog(upstreamUrl)}\n${hdrText}\n\n${bodyText}`);
            log("info", `[debug] RAW request dump: ${reqPath}`);
        } catch (err) { logDumpFailure("REQ dump", err); }
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
            const masked = maskHeaderForLog(k, v);
            respLog[k] = masked.length > 300 ? masked.slice(0, 300) + "..." : masked;
        });
        log("info", `[${prepared?.session.id ?? "unknown"}] ← upstream response headers: ${JSON.stringify(respLog)}`);
    }
    if (rawBase) {
        try {
            const hdrText = Object.entries(maskHeadersForLog(respHeaders))
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n");
            const resPath = `${rawBase}-RES.txt`;
            fs.writeFileSync(resPath, `${upstream.status}\n${hdrText}\n`);
            log("info", `[debug] RAW response dump: ${resPath}`);
        } catch (err) { logDumpFailure("RES dump", err); }
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
                    // No window number in the body (e.g. Codex's
                    // "context_window_exceeded" error). The rejected payload's
                    // size is a safe upper bound on the real window — learn it
                    // so the next turn re-centers the limit and the pre-flight
                    // compresses below it. Only shrink, never grow: a previously
                    // learned (smaller) value is the tighter bound.
                    const payloadEstimate = estimateCoreMessages(prepared.processedMessages);
                    const prev = (reqModel ? learnedMap[reqModel] : undefined) ?? (s.metadata.learnedContextLimit as number | undefined);
                    if (payloadEstimate >= 1000 && (prev === undefined || payloadEstimate < prev)) {
                        if (reqModel) learnedMap[reqModel] = payloadEstimate;
                        else s.metadata.learnedContextLimit = payloadEstimate;
                        s.metadata.learnedContextLimits = learnedMap;
                        log("warn", `[${s.id}] upstream context overflow (window not parseable) — learned conservative window ${payloadEstimate} for ${reqModel ?? "(unknown model)"} from rejected payload size (was ${prev ?? "unset"}); arming emergency shrink`);
                    } else {
                        log("warn", `[${s.id}] upstream context overflow (window not parseable): ${info.message}`);
                    }
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
            log("warn", `[${prepared.session.id}] native compact response had no body; rebase NOT scheduled`);
        }
        return;
    }
    // Plugin mode: the agent's native loop owns the tool surface — pass the
    // response through VERBATIM (a model-emitted compress call must reach the
    // plugin untouched) while sniffing usage so lastInputTokens (the input to
    // the next nudge decision) keeps tracking reality.
    if (prepared?.pluginMode) {
        if (prepared.stream) {
            if (prepared.protocol === "responses") {
                await pipePluginResponsesWithStrip(upstream.body as ReadableStream<Uint8Array>, res, prepared.session, (msg) => log("info", `[${prepared.session.id}] ${msg}`));
            } else {
                await pipeThroughWithUsage(upstream.body as ReadableStream<Uint8Array>, res, prepared.session, prepared.protocol);
            }
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
        if (prepared && prepared.resetAfterSuccess) {
            const [toClient, toObserve] = upstream.body.tee();
            const observed = observeResponsesTerminalState(toObserve, prepared.stream);
            await pipeThrough(toClient, res);
            clearUpstreamTimer();
            const terminal = await observed;
            if (terminal === "completed") {
                markNativeCompactionBoundary(prepared.session);
                log("info", `[${prepared.session.id}] native Responses compact completed; rebase scheduled for next Responses turn`);
            } else {
                log("warn", `[${prepared.session.id}] native compact response terminal=${terminal}; rebase NOT scheduled`);
            }
        } else {
            await pipeThrough(upstream.body, res);
            clearUpstreamTimer();
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
            dumpRaw = dumpStreamToFile(b, opts.dumpSse, `${Date.now()}-${safeSessionId(prepared.session.id)}-raw.sse`);
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
            let protocolFragmentWarned = false;
            for await (const chunk of loop) {
                if (res.destroyed || res.writableEnded) break;
                {
                    const s = chunk.toString("utf8");
                    if (s.includes("\x3cacp ") || s.includes("\x3c/acp")) {
                        log("warn", `[${prepared.session.id}] tag echo: ${prepared.protocol} response stream contains \x3cacp tag`);
                    } else if (!protocolFragmentWarned && containsToolCallXmlFragment(s)) {
                        protocolFragmentWarned = true;
                        log("warn", `[${prepared.session.id}] tag echo: ${prepared.protocol} response stream contains tool-call XML fragment (possible tag echo; not stripped)`);
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
                    // lastInputTokens = true TOTAL context (protocol-correct),
                    // net of this turn's compress savings (see stream.ts
                    // applyRanges — the fold lands on the NEXT request).
                    prepared.session.stats.lastInputTokens = Math.max(
                        0,
                        total - (prepared.session.stats.compressCreditTokens ?? 0),
                    );
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
        ws.on("error", (e) => { logDumpFailure("SSE stream dump", e); });
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
    } catch (err) {
        logDumpFailure("SSE stream dump", err);
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
