// #3278: in-process compression engine — the SAME per-request pipeline
// startServer() serves over HTTP, driven directly inside this process. The pi
// inline lane is the first consumer: model and tool-management requests are
// routed here through a pseudo-origin instead of a spawned proxy. Deliberately
// skipped vs startServer(): auto-update/advisory (the engine updates with its
// host package), port bind + announce, request watchdog (in-process callers
// are bounded by upstream timeouts). The WebSocket bridge is NO longer
// skipped: the engine boots a loopback-only listener (inline-ws.ts) so the
// codex Responses WS lane can be intercepted in-process too (#3278 follow-up).
import http from "node:http";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { ensureConfigTemplate, loadOptions } from "./config.js";
import { ensureSqliteEngine } from "./storage/engine-bootstrap.js";
import { recordEngineBootstrap } from "./storage/runtime-status.js";
import { resolveProxy, resolveProxyDecision } from "./upstream-proxy.js";
import { startInlineWsBridge } from "./inline-ws.js";
import { createEngineContext, type EngineContext } from "./server.js";
import { handle } from "./server/handle.js";
import { withFetchTransport } from "./fetch-transport.js";
import type { FetchOptions } from "./fetch-util.js";
import { log as loggerLog, muteStderrLeg } from "./logger.js";
import { buildProxyFailureResponse, isExpectedFailFast } from "./upstream-fail.js";

/** Pseudo-origin of the inline lane. Never DNS-resolved: any request reaching
 *  this host is served in-process by installInlineTransport before egress. */
export const INLINE_ORIGIN = "http://billion-context.inline";
const INLINE_HOSTNAME = new URL(INLINE_ORIGIN).hostname;

type FetchInput = string | URL | Request;
type BodyLike = string | URLSearchParams | Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface InlineEngine {
    origin: string;
    /** Run one request through the shared pipeline. `rawFetch` is the host's
     *  pre-patch fetch: it becomes this engine's upstream transport (via
     *  withFetchTransport) so pipeline egress never re-enters the patched
     *  fetch chain. */
    dispatch(input: FetchInput, init?: RequestInit, rawFetch?: typeof globalThis.fetch): Promise<Response>;
    /** Bare HTTP-shaped pipeline drive for WS-bridge envelopes (real or
     *  synthetic req/res). NO transport wrap of its own: the WS session wraps
     *  this call in withFetchTransport(its WS-backed fetch) and an inner wrap
     *  would override the session's upstream egress. */
    dispatchHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
    /** Loopback WS-bridge origin once the listener is up, or undefined if the
     *  bridge failed to boot (the native WS wrapper then degrades the codex
     *  lane to DIRECT, warned — same posture as an unsettled bootstrap). */
    wsOrigin: Promise<string | undefined>;
    /** Loopback WEB listener origin (http://127.0.0.1:<port>) serving the
     *  built-in Web UI + admin API for a real BROWSER, or undefined when the
     *  bind failed (panel then hides the Web UI line). Same loopback-only,
     *  unref'd, fail-soft posture as the WS bridge. */
    webOrigin: Promise<string | undefined>;
}

type HeaderPair = [string, string];

function normalizeHeaderPairs(value: Record<string, string | number | string[]> | [string, string][]): HeaderPair[] {
    if (Array.isArray(value)) return value.map(([k, v]) => [k, String(v)]);
    const out: HeaderPair[] = [];
    for (const [k, v] of Object.entries(value)) {
        if (v === undefined) continue;
        out.push([k, Array.isArray(v) ? v.join(", ") : String(v)]);
    }
    return out;
}

/** Hop-by-hop / framing headers that must not ride a reconstructed Response:
 *  undici recomputes length and framing from the actual stream. */
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

async function bodyToBuffer(body: BodyLike | null | undefined): Promise<Buffer> {
    if (body === null || body === undefined) return Buffer.alloc(0);
    if (typeof body === "string") return Buffer.from(body);
    if (body instanceof URLSearchParams) return Buffer.from(body.toString());
    if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    const iterator = (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
    if (typeof iterator === "function") {
        const parts: Buffer[] = [];
        for await (const chunk of body as AsyncIterable<Uint8Array>) parts.push(Buffer.from(chunk));
        return Buffer.concat(parts);
    }
    throw new Error(`inline engine: unsupported request body type ${Object.prototype.toString.call(body)}`);
}

/** Minimal duck-type of http.IncomingMessage covering everything the pipeline
 *  reads: url/method/headers/socket identity plus the readBody event surface.
 *  Body delivery is LAZY (microtask after listener registration) — readBody
 *  attaches its data/end handlers after construction, so emitting eagerly
 *  would resolve nothing and hang the request. */
/** Real port of the loopback web listener once it is up (0 until then). The
 *  fake sockets below report it as localPort so admin routes compute a REAL
 *  browser-clickable webOrigin (http://127.0.0.1:<port>) for panel links —
 *  pre-#4571 they hardcoded 0 and the panel printed a dead :0 URL. */
let webPort = 0;
/** The current listener (tracked so a re-boot closes the previous one
 *  instead of leaking an ephemeral port that serves a stale engine). */
let webServer: http.Server | undefined;

class InlineReq extends EventEmitter {
    url: string;
    method: string;
    headers: Record<string, string | string[] | undefined> = {};
    socket = { get localPort() { return webPort; }, remoteAddress: "127.0.0.1" };
    private chunks: Buffer[];
    private deliveryScheduled = false;

    constructor(url: string, method: string, headers: Record<string, string | string[] | undefined>, body: Buffer) {
        super();
        this.url = url;
        this.method = method;
        this.headers = headers;
        this.chunks = body.length > 0 ? [body] : [];
    }

    override on(event: string, fn: (...args: unknown[]) => void): this {
        super.on(event, fn);
        if (event === "data" || event === "end" || event === "error") this.scheduleDelivery();
        return this;
    }

    destroy(): void {}

    private scheduleDelivery(): void {
        if (this.deliveryScheduled) return;
        this.deliveryScheduled = true;
        queueMicrotask(() => {
            for (const c of this.chunks) this.emit("data", c);
            this.emit("end");
        });
    }
}

/** Minimal duck-type of http.ServerResponse: writeHead/write/end plus the
 *  finish/close events the pipeline arms, and a socket surface (bytesWritten,
 *  destroyed) read by registerRequestAbort/beginStreamKeepalive/observability.
 *  The body streams into a web ReadableStream so SSE responses reach the
 *  caller incrementally instead of arriving in one buffered blob. */
class InlineRes extends EventEmitter {
    statusCode = 200;
    statusMessage = "";
    headersSent = false;
    writableEnded = false;
    destroyed = false;
    socket = { get localPort() { return webPort; }, remoteAddress: "127.0.0.1", destroyed: false, bytesWritten: 0 };
    readonly bodyStream: ReadableStream<Uint8Array>;
    headHeaders: HeaderPair[] = [];
    private controller: ReadableStreamDefaultController<Uint8Array> | undefined;

    constructor() {
        super();
        this.bodyStream = new ReadableStream<Uint8Array>({
            start: (c) => { this.controller = c; },
        });
    }

    writeHead(status: number, reasonOrHeaders?: string | Record<string, string | number | string[]> | [string, string][]): this {
        if (this.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT: Cannot change headers after they are sent to the client");
        this.statusCode = status;
        if (typeof reasonOrHeaders === "string") this.statusMessage = reasonOrHeaders;
        else if (reasonOrHeaders !== undefined) this.headHeaders.push(...normalizeHeaderPairs(reasonOrHeaders));
        this.headersSent = true;
        return this;
    }

    write(chunk: string | Uint8Array, cb?: () => void): boolean {
        if (this.destroyed) { cb?.(); return false; }
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
        this.socket.bytesWritten += buf.length;
        this.controller?.enqueue(buf);
        cb?.();
        return true;
    }

    end(chunk?: string | Uint8Array, cb?: () => void): void {
        if (this.destroyed) { cb?.(); return; }
        if (chunk !== undefined) this.write(chunk);
        if (!this.writableEnded) {
            this.writableEnded = true;
            try { this.controller?.close(); } catch { /* stream already errored */ }
            this.emit("finish");
            this.emit("close");
            cb?.();
        }
    }

    /** Socket-death semantics, mirroring http.ServerResponse: destroy does NOT
     *  set writableEnded — the pipeline's res "close" listeners use
     *  `!res.writableEnded` to mean "client vanished mid-stream" and abort the
     *  upstream round trip (relay's clientAbort). Marking the response ended
     *  here would look like normal completion and let the upstream run to
     *  completion, burning tokens after the caller already went away. */
    destroy(err?: Error): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.socket.destroyed = true;
        try { this.controller?.error(err ?? new Error("client aborted")); } catch { /* already closed */ }
        if (!this.writableEnded) this.emit("close");
    }
}

async function toInlineReq(input: FetchInput, init?: RequestInit): Promise<InlineReq> {
    let url: string;
    let baseHeaders: Headers | [string, string][] | Record<string, string> | undefined;
    let requestMethod: string | undefined;
    let requestBody: BodyLike | null | undefined;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else {
        url = input.url;
        baseHeaders = input.headers;
        requestMethod = input.method;
        requestBody = await input.arrayBuffer().catch(() => null);
    }
    const headers = new Headers(baseHeaders);
    if (init?.headers !== undefined) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    const headerMap: Record<string, string | string[] | undefined> = {};
    headers.forEach((value, key) => {
        const existing = headerMap[key];
        headerMap[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
    });
    const method = (init?.method ?? requestMethod ?? "GET").toUpperCase();
    const bodySource = init?.body !== undefined ? init.body as BodyLike | null : requestBody;
    const body = await bodyToBuffer(bodySource);
    // The pipeline reads req.url as an ORIGIN-FORM request target ("/bili/…" —
    // what node:http hands a server for a normal connection). An absolute-form
    // URL would fall into resolveUpstream's forward-proxy branch and be routed
    // to its own authority — the pseudo-origin — instead of the embedded host.
    const parsed = new URL(url);
    // Pseudo-origin traffic is same-process by definition — present the
    // loopback identity so the admin surface's DNS-rebinding Host gate passes
    // without weakening the gate itself. Other origins keep their real host.
    if (headerMap["host"] === undefined) headerMap["host"] = parsed.hostname === INLINE_HOSTNAME ? "127.0.0.1" : parsed.host;
    return new InlineReq(parsed.pathname + parsed.search, method, headerMap, body);
}

function responseFrom(res: InlineRes): Response {
    const headers = new Headers();
    for (const [k, v] of res.headHeaders) {
        if (HOP_HEADERS.has(k.toLowerCase())) continue;
        headers.append(k, v);
    }
    return new Response(res.bodyStream, { status: res.statusCode, statusText: res.statusMessage || undefined, headers });
}

function makeDispatcher(ctx: EngineContext): InlineEngine["dispatch"] {
    return async (input, init, rawFetch) => {
        const req = await toInlineReq(input, init);
        const res = new InlineRes();
        // Spawn-mode cancel parity (#3278 review): honor the caller's
        // AbortSignal. Destroying res drives the pipeline's own close plumbing
        // (handle()'s decodingAbort, relay's clientAbort) exactly like a real
        // socket close does over HTTP, stopping the upstream round trip; the
        // raced promise makes the caller reject with the abort reason like
        // undici would instead of running to completion and burning tokens.
        const signal = init?.signal;
        let onAbort: (() => void) | undefined;
        let abortPromise: Promise<never> | undefined;
        if (signal != null) {
            abortPromise = new Promise<never>((_, reject) => {
                onAbort = () => {
                    try { res.destroy(new Error("client aborted")); } catch { /* already closed */ }
                    reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
                };
                if (signal.aborted) onAbort();
                else signal.addEventListener("abort", onAbort, { once: true });
            });
            void abortPromise.catch(() => { /* consumed by the race below when the abort wins */ });
        }
        try {
            // The whole dispatch runs under the host's PRE-PATCH fetch: every
            // upstream call the pipeline makes (forward, count-tokens,
            // registry…) takes this transport instead of globalThis.fetch,
            // which in the inline lane is bili's own patch chain — following
            // it would rewrite the upstream URL back onto the pseudo-origin
            // and loop forever.
            const transport = (url: string, options: FetchOptions): Promise<Response> => (rawFetch ?? globalThis.fetch)(url, options as RequestInit);
            const pipeline = withFetchTransport(
                transport,
                () => handle(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, ctx.opts, ctx.core, ctx.config, ctx.log, ctx.instanceId, ctx.instanceStartedAt, ctx.proxyWatchers, ctx.initialWatcherPid, ctx.adminCtx),
            );
            if (abortPromise !== undefined) await Promise.race([pipeline, abortPromise]);
            else await pipeline;
        } catch (err) {
            // Mirror of startServer()'s dispatch catch (server.ts): same
            // client-abort classification, same error shape on the wire.
            const msg = String(err);
            const e = err as { name?: string; message?: string };
            const clientAbort = (e?.name === "AbortError" || /abort/i.test(String(e?.message ?? ""))) && (res.destroyed || res.writableEnded);
            if (clientAbort) ctx.log("info", `client aborted mid-stream: ${msg}`);
            // #4254: a deliberate circuit-breaker fail-fast logs nothing here — the
            // throttled [warn] at the throw site is the canonical record.
            else if (!isExpectedFailFast(err)) {
                if (err instanceof Error && err.stack) ctx.log("error", `${msg}\n${err.stack.split("\n").slice(1, 8).join("\n")}`);
                else ctx.log("error", msg);
            }
            // A destroyed res belongs to an aborted caller whose promise
            // carries the abort reason — the body stream is errored, so writing
            // an error frame here would throw on the dead controller; rethrow
            // so the caller sees the abort instead of a phantom response.
            if (res.destroyed) throw err;
            if (!res.headersSent) {
                // #4254: shared egress builder — renders identically to startServer
                // (this lane now also emits the structured upstreamFailure diag).
                const { status, headers, body } = buildProxyFailureResponse(msg, err);
                res.writeHead(status, headers);
                res.end(body);
            } else {
                res.end();
            }
        } finally {
            if (signal != null && onAbort != null) signal.removeEventListener("abort", onAbort);
        }
        if (!res.writableEnded) res.end();
        return responseFrom(res);
    };
}

/** HTTP-shaped pipeline drive for the loopback WS bridge. Bare by design —
 *  see InlineEngine.dispatchHttp. Error classification mirrors makeDispatcher
 *  (same client-abort split, same error frames on the wire). */
function makeHttpDispatch(ctx: EngineContext): InlineEngine["dispatchHttp"] {
    return async (req, res) => {
        try {
            await handle(req, res, ctx.opts, ctx.core, ctx.config, ctx.log, ctx.instanceId, ctx.instanceStartedAt, ctx.proxyWatchers, ctx.initialWatcherPid, ctx.adminCtx);
        } catch (err) {
            const msg = String(err);
            const e = err as { name?: string; message?: string };
            const clientAbort = (e?.name === "AbortError" || /abort/i.test(String(e?.message ?? ""))) && (res.destroyed || res.writableEnded);
            if (clientAbort) ctx.log("info", `client aborted mid-stream: ${msg}`);
            else if (err instanceof Error && err.stack) ctx.log("error", `${msg}\n${err.stack.split("\n").slice(1, 8).join("\n")}`);
            else ctx.log("error", msg);
            if (res.destroyed) return;
            if (!res.headersSent) {
                const status = msg.includes("exceeds") ? 413 : 502;
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "acp-proxy failure", detail: msg }));
            } else {
                res.end();
            }
        }
    };
}

let engineFactory: () => Promise<InlineEngine> = startInlineEngine;

/** Test seam: replace the bootstrap (fake engine) without touching config or
 *  storage. Pass undefined to restore. */
export function _setEngineFactoryForTest(fn: (() => Promise<InlineEngine>) | undefined): void {
    engineFactory = fn ?? startInlineEngine;
}

let enginePromise: Promise<InlineEngine> | undefined;
let failedAt = 0;
const RETRY_COOLDOWN_MS = 30_000;

/** Memoized engine startup. A failed bootstrap stays cached for
 *  RETRY_COOLDOWN_MS so a broken environment degrades fast instead of
 *  re-attempting (and re-logging) on every model request; after the cooldown
 *  the next request retries once. */
export function getInlineEngine(): Promise<InlineEngine> {
    if (enginePromise !== undefined) {
        if (failedAt !== 0 && Date.now() - failedAt >= RETRY_COOLDOWN_MS) enginePromise = undefined;
        else return enginePromise;
    }
    enginePromise = engineFactory().catch((err) => {
        failedAt = Date.now();
        loggerLog("error", `[inline] compression engine bootstrap failed (retry in ${RETRY_COOLDOWN_MS / 1000}s): ${String(err)}`);
        throw err;
    });
    return enginePromise;
}

/** Test seam: drop the memo so the next getInlineEngine() restarts. */
export function _resetInlineEngineForTest(): void {
    enginePromise = undefined;
    failedAt = 0;
    closeWebListener();
}

function closeWebListener(): void {
    if (webServer !== undefined) {
        webServer.close();
        webServer = undefined;
    }
    webPort = 0;
}

async function startInlineEngine(): Promise<InlineEngine> {
    // The engine runs INSIDE the host agent's process (#3278 inline lane),
    // and that process's stderr IS the interactive TUI terminal (pi, dsh,
    // …). The tee logger's stderr leg would print every engine line —
    // storage mode, persist warm-up, the background index scan 1-2 s after
    // boot — straight onto the TUI, scrolling the input box away (field
    // report: "启动的时候都是日志 输入框没了"). Keep the durable bili.log file
    // leg, mute the terminal leg; the logger re-enables stderr itself if the
    // file leg ever dies (#2864), and BILI_INLINE_DEBUG=1 opts back in for
    // live troubleshooting.
    if (!process.env.BILI_INLINE_DEBUG) muteStderrLeg();
    // Same pre-flight as the CLI server path (cli.ts `start`): template
    // config, resolved options, sqlite engine self-bootstrap (#2833).
    ensureConfigTemplate();
    const opts = loadOptions();
    // Mark every downstream consumer of these options (admin router, plugin
    // status panel) that THIS engine is the in-process inline lane — the
    // status panel appends " · inline" so a screenshot says which mode it is.
    opts.inlineLane = true;
    const bootstrapOutcome = await ensureSqliteEngine({
        resolveProxy: (url) => resolveProxy(opts.routes, opts.proxy, url, opts.proxyFallback),
    });
    recordEngineBootstrap(bootstrapOutcome);
    const ctx = await createEngineContext(opts);
    // No bind/announce step exists inline — ready the moment context is up.
    ctx.markBootReady();
    ctx.log("info", `[inline] compression engine running in-process (${INLINE_ORIGIN}) — no proxy spawned`);
    const dispatchHttp = makeHttpDispatch(ctx);
    // Codex Responses WS lane (#3278 follow-up): boot the loopback-only WS
    // bridge alongside the engine. Failure is non-fatal — the native WS
    // wrapper degrades that lane to DIRECT (warned) while HTTP compression
    // keeps running in-process.
    const bridge = startInlineWsBridge({
        dispatchHttp,
        log: ctx.log,
        isEgressProxied: (url) => resolveProxyDecision(opts.routes, opts.proxy, url, opts.proxyFallback).proxy !== undefined,
        instanceId: ctx.instanceId,
    });
    const wsOrigin = bridge
        .then(b => b.origin)
        .catch((err: unknown) => {
            ctx.log("warn", `[inline] WS bridge failed to start — codex WebSocket traffic goes DIRECT (uncompressed): ${String(err)}`);
            return undefined;
        });
    // Loopback WEB listener (#4571 follow-up): the Web UI deep links the
    // status panel prints need a port a BROWSER can dial — the pseudo-origin
    // only exists inside this process. Binds 127.0.0.1:0 (ephemeral, unref'd,
    // fail-soft like the WS bridge) and serves ONLY the /__bili/ + /__acp/
    // admin/web routes through the same pipeline drive; model lanes (/bili/…)
    // are intentionally NOT exposed on it.
    const webOrigin = new Promise<string | undefined>((resolve) => {
        closeWebListener();
        const web = http.createServer((req, res) => {
            const url = req.url ?? "/";
            if (url !== "/__bili/" && !url.startsWith("/__bili/") && url !== "/__acp/" && !url.startsWith("/__acp/")) {
                res.writeHead(404, { "content-type": "text/plain" });
                res.end("inline web listener serves /__bili/ only");
                return;
            }
            void dispatchHttp(req, res);
        });
        web.once("error", (err: NodeJS.ErrnoException) => {
            ctx.log("warn", `[inline] web listener failed to start — the Web UI link stays hidden: ${String(err)}`);
            resolve(undefined);
        });
        web.listen(0, "127.0.0.1", () => {
            const addr = web.address();
            const port = typeof addr === "object" && addr !== null ? addr.port : 0;
            if (typeof port === "number" && port > 0) {
                webPort = port;
                webServer = web;
                web.unref();
                ctx.log("info", `[inline] web UI listening on http://127.0.0.1:${port} (loopback only)`);
                resolve(`http://127.0.0.1:${port}`);
            } else {
                ctx.log("warn", "[inline] web listener bound without a port — the Web UI link stays hidden");
                resolve(undefined);
            }
        });
    });
    return { origin: INLINE_ORIGIN, dispatch: makeDispatcher(ctx), dispatchHttp, wsOrigin, webOrigin };
}
