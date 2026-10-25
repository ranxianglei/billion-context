// #3278: in-process compression engine — the SAME per-request pipeline
// startServer() serves over HTTP, driven directly inside this process. The pi
// inline lane is the first consumer: model and tool-management requests are
// routed here through a pseudo-origin instead of a spawned proxy. Deliberately
// skipped vs startServer(): auto-update/advisory (the engine updates with its
// host package), full port bind + announce (only the loopback-only Codex
// Responses WebSocket bridge binds, #4526), request watchdog (in-process
// callers are bounded by upstream timeouts).
import http from "node:http";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { ensureConfigTemplate, loadOptions, type ProxyOptions } from "./config.js";
import { ensureSqliteEngine } from "./storage/engine-bootstrap.js";
import { recordEngineBootstrap } from "./storage/runtime-status.js";
import { resolveProxy, resolveProxyDecision } from "./upstream-proxy.js";
import { createEngineContext, type EngineContext } from "./server.js";
import { handle } from "./server/handle.js";
import { withFetchTransport } from "./fetch-transport.js";
import type { FetchOptions } from "./fetch-util.js";
import { log as loggerLog } from "./logger.js";
import { buildProxyFailureResponse, isExpectedFailFast } from "./upstream-fail.js";
import { installWebSocketBridge } from "./ws-bridge.js";
import { codexResponsesCodec } from "./responses-ws.js";

/** Pseudo-origin of the inline lane. Never DNS-resolved: any request reaching
 *  this host is served in-process by installInlineTransport before egress. */
export const INLINE_ORIGIN = "http://billion-context.inline";
const INLINE_HOSTNAME = new URL(INLINE_ORIGIN).hostname;

type FetchInput = string | URL | Request;
type BodyLike = string | URLSearchParams | Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface InlineEngine {
    origin: string;
    /** #4526: dialable loopback origin of this engine's Codex Responses
     *  WebSocket bridge ("http://127.0.0.1:<port>"). undefined when the bind
     *  failed — the client-side wrapper then sends that channel direct
     *  (uncompressed, warned) instead of an undialable URL. */
    wsOrigin?: string;
    /** Run one request through the shared pipeline. `rawFetch` is the host's
     *  pre-patch fetch: it becomes this engine's upstream transport (via
     *  withFetchTransport) so pipeline egress never re-enters the patched
     *  fetch chain. */
    dispatch(input: FetchInput, init?: RequestInit, rawFetch?: typeof globalThis.fetch): Promise<Response>;
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
class InlineReq extends EventEmitter {
    url: string;
    method: string;
    headers: Record<string, string | string[] | undefined> = {};
    socket = { localPort: 0, remoteAddress: "127.0.0.1" };
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
    socket = { localPort: 0, remoteAddress: "127.0.0.1", destroyed: false, bytesWritten: 0 };
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

/** The bare per-request pipeline — exactly what startServer's dispatch calls
 *  (server.ts). Shared by the HTTP dispatcher AND the WebSocket bridge: the
 *  WS session wraps it with its own upstream transport via AsyncLocalStorage,
 *  so it must NOT be pre-wrapped here. */
function pipelineFor(ctx: EngineContext): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
    return (req, res) => handle(req, res, ctx.opts, ctx.core, ctx.config, ctx.log, ctx.instanceId, ctx.instanceStartedAt, ctx.proxyWatchers, ctx.initialWatcherPid, ctx.adminCtx);
}

function makeDispatcher(pipeline: ReturnType<typeof pipelineFor>, log: EngineContext["log"]): InlineEngine["dispatch"] {
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
            const run = withFetchTransport(
                transport,
                () => pipeline(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse),
            );
            if (abortPromise !== undefined) await Promise.race([run, abortPromise]);
            else await run;
        } catch (err) {
            // Mirror of startServer()'s dispatch catch (server.ts): same
            // client-abort classification, same error shape on the wire.
            const msg = String(err);
            const e = err as { name?: string; message?: string };
            const clientAbort = (e?.name === "AbortError" || /abort/i.test(String(e?.message ?? ""))) && (res.destroyed || res.writableEnded);
            if (clientAbort) log("info", `client aborted mid-stream: ${msg}`);
            // #4254: a deliberate circuit-breaker fail-fast logs nothing here — the
            // throttled [warn] at the throw site is the canonical record.
            else if (!isExpectedFailFast(err)) {
                if (err instanceof Error && err.stack) log("error", `${msg}\n${err.stack.split("\n").slice(1, 8).join("\n")}`);
                else log("error", msg);
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

interface InlineWsBridge {
    /** Dialable loopback origin, e.g. "http://127.0.0.1:53210". */
    origin: string;
    close(): Promise<void>;
}

/** #4526: the inline lane's own WebSocket bridge. The engine otherwise binds
 *  nothing, but the Codex Responses lane dials a REAL endpoint — so bind a
 *  loopback-only upgrade listener on an ephemeral port and serve the same
 *  per-request pipeline through installWebSocketBridge (the spawn-mode bridge
 *  verbatim: loopback-source admission, tunnel-destination SSRF guard,
 *  session lifecycle). unref'd so it never holds the host process open; a
 *  bind failure degrades ONLY the WS channel direct (warned) — HTTP
 *  compression keeps running and the engine never fails for this. */
async function startInlineWsBridge(
    pipeline: ReturnType<typeof pipelineFor>,
    opts: ProxyOptions,
    log: EngineContext["log"],
    instanceId: string,
): Promise<InlineWsBridge | undefined> {
    const server = http.createServer((_req, res) => {
        // This port exists for WebSocket upgrades only — model HTTP traffic is
        // served in-process by the fetch chain, nothing else should land here.
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "HTTP is not served by the pi inline WebSocket bridge" }));
    });
    // The WS session swallows a rejecting dispatch (warn + bare end), which
    // would leave Codex staring at a truncated stream. Render the failure
    // into the envelope instead — same egress as the spawn-mode dispatch
    // catch (server.ts) and makeDispatcher above: informative error, 503+
    // Retry-After on a circuit-open fail-fast (#4254).
    const guarded: ReturnType<typeof pipelineFor> = async (req, res) => {
        try {
            await pipeline(req, res);
        } catch (err) {
            const msg = String(err);
            const e = err as { name?: string; message?: string };
            const clientAbort = (e?.name === "AbortError" || /abort/i.test(String(e?.message ?? ""))) && (res.destroyed || res.writableEnded);
            if (clientAbort) log("info", `client aborted mid-stream: ${msg}`);
            else if (!isExpectedFailFast(err)) {
                if (err instanceof Error && err.stack) log("error", `${msg}\n${err.stack.split("\n").slice(1, 8).join("\n")}`);
                else log("error", msg);
            }
            if (!res.headersSent) {
                const { status, headers, body } = buildProxyFailureResponse(msg, err);
                res.writeHead(status, headers);
                res.end(body);
            } else {
                res.end();
            }
        }
    };
    const wsUpgrade = installWebSocketBridge(
        server,
        guarded,
        log,
        [codexResponsesCodec],
        (url) => resolveProxyDecision(opts.routes, opts.proxy, url, opts.proxyFallback).proxy !== undefined,
        instanceId,
    );
    // Unclaimed upgrades keep the 426 contract (server.ts parity): Codex's
    // built-in fast-fallback needs a clean 426 to switch to HTTP POST, which
    // still gets compressed through the in-process fetch chain.
    server.on("upgrade", (req, socket, head) => {
        if (wsUpgrade(req, socket, head)) return;
        socket.on("error", () => {});
        const body = JSON.stringify({ error: "WebSocket upgrades are not supported; use HTTP POST" });
        socket.end(
            "HTTP/1.1 426 Upgrade Required\r\n" +
                "Connection: close\r\n" +
                "Content-Type: application/json\r\n" +
                `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                "\r\n" + body,
        );
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => reject(err);
            server.once("error", onError);
            server.listen(0, "127.0.0.1", () => {
                server.removeListener("error", onError);
                resolve();
            });
        });
    } catch (err) {
        log("warn", `[inline] WebSocket bridge bind failed (${String(err)}) — Codex Responses WebSocket traffic will go direct (uncompressed); HTTP compression unaffected (#4526)`);
        try { server.closeAllConnections(); } catch { /* not listening yet */ }
        return undefined;
    }
    server.unref();
    const addr = server.address();
    if (addr === null || typeof addr !== "object") {
        log("warn", "[inline] WebSocket bridge bound without a readable address — treating as unavailable (#4526)");
        return undefined;
    }
    log("info", `[inline] Codex Responses WebSocket bridge listening on 127.0.0.1:${addr.port} (#4526)`);
    return {
        origin: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((resolve) => {
            try { server.closeAllConnections(); } catch { /* already closed */ }
            server.close(() => resolve());
        }),
    };
}

let liveWsBridge: InlineWsBridge | undefined;

/** Test seam: close the real bridge a booted engine bound (unref'd listeners
 *  don't block process exit, but an open client/upstream socket does). */
export async function _closeInlineWsBridgeForTest(): Promise<void> {
    const bridge = liveWsBridge;
    liveWsBridge = undefined;
    await bridge?.close();
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
}

async function startInlineEngine(): Promise<InlineEngine> {
    // Same pre-flight as the CLI server path (cli.ts `start`): template
    // config, resolved options, sqlite engine self-bootstrap (#2833).
    ensureConfigTemplate();
    const opts = loadOptions();
    const bootstrapOutcome = await ensureSqliteEngine({
        resolveProxy: (url) => resolveProxy(opts.routes, opts.proxy, url, opts.proxyFallback),
    });
    recordEngineBootstrap(bootstrapOutcome);
    const ctx = await createEngineContext(opts);
    // No bind/announce step exists inline — ready the moment context is up.
    ctx.markBootReady();
    // #4526: the one real listener the inline lane carries — the Codex
    // Responses WebSocket bridge. A bind failure degrades only that channel;
    // the engine itself stays healthy (HTTP compression is unaffected).
    const pipeline = pipelineFor(ctx);
    const wsBridge = await startInlineWsBridge(pipeline, opts, ctx.log, ctx.instanceId);
    liveWsBridge = wsBridge;
    ctx.log("info", `[inline] compression engine running in-process (${INLINE_ORIGIN})${wsBridge !== undefined ? `, Codex Responses WebSocket bridge at ${wsBridge.origin}` : ""} — no proxy spawned`);
    return { origin: INLINE_ORIGIN, wsOrigin: wsBridge?.origin, dispatch: makeDispatcher(pipeline, ctx.log) };
}
