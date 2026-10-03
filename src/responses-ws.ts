import http from "node:http";
import { WebSocket as UpstreamWebSocket, type Dispatcher } from "undici";
import WebSocket from "ws";
import { MAX_REQUEST_BYTES, type FetchOptions } from "./fetch-util.js";
import { withFetchTransport } from "./fetch-transport.js";
import { connectionNamedHeaders, UPSTREAM_HOP_HEADERS } from "./server/headers.js";
import { normalizeSseLineEndings } from "./sse-util.js";
import type { WsBridgeCodec, WsBridgeContext, WsBridgeSession } from "./ws-bridge.js";

type JsonObject = Record<string, unknown>;
type DiagnosticLog = (level: "debug" | "warn", message: string) => void;

function closeCode(event: Event): number | "none" {
    return "code" in event && typeof event.code === "number" ? event.code : "none";
}

function object(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
}

function comparable(item: unknown): unknown {
    if (!object(item)) return item;
    const result = { ...item };
    delete result.status;
    if (!result.type && typeof result.role === "string") result.type = "message";
    return result;
}

interface Checkpoint {
    id: string;
    request: JsonObject;
    output: unknown[];
}

class ResponsesWsOutput {
    private items = new Map<number, { item: JsonObject; bytes: number }>();
    private bytes = 0;

    observe(frame: JsonObject): JsonObject | undefined {
        if (frame.type === "response.created") {
            this.items.clear();
            this.bytes = 0;
        }
        if (frame.type === "response.output_item.done" && object(frame.item) && Number.isSafeInteger(frame.output_index) && (frame.output_index as number) >= 0) {
            const index = frame.output_index as number;
            const bytes = Buffer.byteLength(JSON.stringify(frame.item));
            this.bytes += bytes - (this.items.get(index)?.bytes ?? 0);
            if (this.bytes > MAX_REQUEST_BYTES) throw new Error("Responses WebSocket checkpoint buffer limit exceeded");
            this.items.set(index, { item: frame.item, bytes });
        }
        if (frame.type !== "response.completed" || !object(frame.response)) return undefined;
        // Terminal output can be sparse; retain items already delivered by the stream.
        const response = frame.response;
        const output = new Map<number, unknown>([...this.items].map(([index, value]) => [index, value.item]));
        const indexes = new Map([...this.items].flatMap(([index, value]) => typeof value.item.id === "string" ? [[value.item.id, index] as const] : []));
        if (Array.isArray(response.output)) {
            response.output.forEach((item: unknown, index: number) => {
                const slot = object(item) && typeof item.id === "string" ? indexes.get(item.id) : undefined;
                output.set(slot ?? index, item);
            });
        }
        return { ...response, output: [...output].sort(([a], [b]) => a - b).map(([, item]) => item) };
    }
}

export class ResponsesWsHistory {
    private checkpoint?: Checkpoint;

    expand(frame: JsonObject): JsonObject {
        const { type: _type, previous_response_id: previous, ...request } = frame;
        if (typeof request.input === "string") request.input = [{ type: "message", role: "user", content: request.input }];
        if (!Array.isArray(request.input)) throw new Error("response.create requires an input array");
        if (previous !== undefined && previous !== null) {
            if (previous !== this.checkpoint?.id) throw new Error("previous_response_not_found");
            const prior = this.checkpoint;
            if (!prior || !Array.isArray(prior.request.input)) throw new Error("previous_response_not_found");
            return { ...prior.request, ...request, input: [...prior.request.input, ...prior.output, ...request.input] };
        }
        return request;
    }

    continuation(request: JsonObject): JsonObject {
        const prior = this.checkpoint;
        if (!prior || !Array.isArray(request.input) || !Array.isArray(prior.request.input)) return request;
        const { input: _input, ...fields } = request;
        const items = request.input;
        const { input: _priorInput, ...priorFields } = prior.request;
        if (canonical(fields) !== canonical(priorFields)) return request;
        const baseline = [...prior.request.input, ...prior.output];
        if (items.length <= baseline.length || !baseline.every((item, i) => canonical(comparable(item)) === canonical(comparable(items[i])))) return request;
        return { ...fields, input: items.slice(baseline.length), previous_response_id: prior.id };
    }

    commit(request: JsonObject, response: unknown): void {
        if (!object(response) || response.status !== "completed" || typeof response.id !== "string" || !Array.isArray(response.output)) return;
        if (Buffer.byteLength(JSON.stringify(request)) + Buffer.byteLength(JSON.stringify(response.output)) > MAX_REQUEST_BYTES) {
            this.clear();
            return;
        }
        this.checkpoint = { id: response.id, request, output: response.output };
    }

    clear(): void {
        this.checkpoint = undefined;
    }

    /** #1926 observability: bytes retained by the live checkpoint. */
    bytes(): number {
        const checkpoint = this.checkpoint;
        if (!checkpoint) return 0;
        return Buffer.byteLength(JSON.stringify(checkpoint.request)) + Buffer.byteLength(JSON.stringify(checkpoint.output));
    }
}

// The pipeline emits JSON bodies as strings (prepare* re-serialization) or
// Buffers (#388 side passthrough forwards the inbound buffer verbatim) —
// normalize both here; a string-only contract 502s every side request.
function bodyToText(body: RequestInit["body"]): string | undefined {
    if (typeof body === "string") return body;
    if (Buffer.isBuffer(body)) return body.toString("utf8");
    if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
    if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
    return undefined;
}

export class ResponsesWsUpstream {
    private socket?: InstanceType<typeof UpstreamWebSocket>;
    private key?: string;
    private history = new ResponsesWsHistory();
    private active?: { fail: (error: Error, reason?: string) => void };

    constructor(private readonly log: DiagnosticLog = () => {}) {}

    private resetHistory(reason: string): void {
        this.history.clear();
        this.log("debug", `upstream checkpoint reset reason=${reason}`);
    }

    /** #1926 observability: bytes retained by the upstream-leg checkpoint. */
    retainedBytes(): number {
        return this.history.bytes();
    }

    close(reason = "transport-close"): void {
        const socket = this.socket;
        this.socket = undefined;
        this.key = undefined;
        if (this.active) this.active.fail(new Error("Responses WebSocket closed"), reason);
        else if (socket) this.resetHistory(reason);
        else this.history.clear();
        if (socket && socket.readyState < UpstreamWebSocket.CLOSING) socket.close();
    }

    private async connect(url: string, options: FetchOptions): Promise<InstanceType<typeof UpstreamWebSocket>> {
        const headers = Object.fromEntries(new Headers(options.headers).entries());
        for (const key of Object.keys(headers)) if (UPSTREAM_HOP_HEADERS.has(key) || key.startsWith("sec-websocket-")) delete headers[key];
        const wsUrl = url.replace(/^http/, "ws");
        const key = `${wsUrl}:${canonical(headers)}`;
        if (this.key === key && this.socket?.readyState === UpstreamWebSocket.OPEN) return this.socket;
        this.close(this.key !== key ? "connection-key-changed" : "reconnect");
        this.log("debug", "upstream connecting phase=handshake");
        const socket = new UpstreamWebSocket(wsUrl, { headers, dispatcher: options.dispatcher as Dispatcher | undefined });
        this.socket = socket;
        this.key = key;
        await new Promise<void>((resolve, reject) => {
            const clean = (): void => {
                socket.removeEventListener("open", opened);
                socket.removeEventListener("error", failed);
                socket.removeEventListener("close", failed);
                options.signal?.removeEventListener("abort", aborted);
            };
            const opened = (): void => { clean(); this.log("debug", "upstream connected phase=handshake"); resolve(); };
            const failed = (event: Event): void => {
                clean();
                this.log("warn", `upstream failed phase=handshake event=${event.type} close_code=${closeCode(event)}`);
                reject(new Error("Responses WebSocket handshake failed"));
            };
            const aborted = (): void => { clean(); this.log("debug", "upstream aborted phase=handshake"); this.close("handshake-abort"); reject(new DOMException("Aborted", "AbortError")); };
            socket.addEventListener("open", opened, { once: true });
            socket.addEventListener("error", failed, { once: true });
            socket.addEventListener("close", failed, { once: true });
            if (options.signal?.aborted) aborted();
            else options.signal?.addEventListener("abort", aborted, { once: true });
        });
        return socket;
    }

    async fetch(url: string, options: FetchOptions, rotateRetry = true): Promise<Response> {
        const bodyText = bodyToText(options.body);
        if (options.method !== "POST" || !new URL(url).pathname.endsWith("/responses") || bodyText === undefined) throw new Error("Unsupported request in Responses WebSocket transport");
        const parsed: unknown = JSON.parse(bodyText);
        if (!object(parsed) || !Array.isArray(parsed.input)) throw new Error("Invalid Responses WebSocket request");
        const { stream, stream_options: _streamOptions, background: _background, previous_response_id: _previous, type: _type, ...body } = parsed;
        const socket = await this.connect(url, options);
        if (this.active) throw new Error("Responses WebSocket exchange already active");
        const request = this.history.continuation(body);
        this.log("debug", `upstream request mode=${request.previous_response_id === undefined ? "full" : "delta"}`);
        return new Promise<Response>((resolve, reject) => {
            const output = new ResponsesWsOutput();
            let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
            let settled = false;
            let ended = false;
            let retryFull = request.previous_response_id !== undefined;
            let receivedEvents = 0;
            const encoder = new TextEncoder();
            const clean = (): void => {
                ended = true;
                socket.removeEventListener("message", message);
                socket.removeEventListener("error", failed);
                socket.removeEventListener("close", failed);
                options.signal?.removeEventListener("abort", aborted);
                this.active = undefined;
            };
            const fail = (error: Error, reason = "transport-close"): void => {
                if (ended) return;
                this.resetHistory(reason);
                clean();
                if (settled) controller?.error(error);
                else reject(error);
            };
            const failed = (event: Event): void => {
                this.log("warn", `upstream failed phase=${receivedEvents > 0 ? "stream" : "await-first-event"} event=${event.type} close_code=${closeCode(event)} received_events=${receivedEvents}`);
                fail(new Error("Responses WebSocket upstream disconnected before completion"), "upstream-disconnect");
            };
            const aborted = (): void => {
                this.log("debug", `upstream aborted phase=${receivedEvents > 0 ? "stream" : "await-first-event"}`);
                fail(new DOMException("Aborted", "AbortError"), "request-abort");
                this.close("request-abort");
            };
            const message = (event: { data: unknown }): void => {
                if (ended) return;
                try {
                    if (typeof event.data !== "string" || Buffer.byteLength(event.data) > MAX_REQUEST_BYTES) throw new Error("Invalid or oversized Responses WebSocket frame");
                    const frame: unknown = JSON.parse(event.data);
                    if (!object(frame) || typeof frame.type !== "string") throw new Error("Invalid Responses WebSocket event");
                    receivedEvents++;
                    const completed = output.observe(frame);
                    if (frame.type === "error" && !settled) {
                        const error = object(frame.error) ? frame.error : {};
                        if (rotateRetry && error.code === "websocket_connection_limit_reached") {
                            this.log("debug", "upstream retry reason=connection-limit action=reconnect-full");
                            clean();
                            this.close("connection-limit");
                            resolve(this.fetch(url, options, false));
                            return;
                        }
                        if (retryFull && (error.code === "previous_response_not_found" || frame.status === 400 && (error.code === undefined || error.code === "invalid_request_error"))) {
                            retryFull = false;
                            this.resetHistory("continuation-rejected");
                            this.log("debug", "upstream retry reason=continuation-rejected action=resend-full");
                            socket.send(JSON.stringify({ ...body, type: "response.create" }));
                            return;
                        }
                        clean();
                        this.resetHistory("upstream-error");
                        const status = typeof frame.status === "number" && frame.status >= 400 && frame.status <= 599 ? frame.status : 400;
                        this.log("warn", `upstream rejected phase=await-first-event status=${status}`);
                        resolve(new Response(JSON.stringify(frame), { status, headers: { "content-type": "application/json" } }));
                        return;
                    }
                    if (stream !== true) {
                        if (frame.type === "response.completed" || frame.type === "response.failed" || frame.type === "response.incomplete") {
                            clean();
                            if (completed) this.history.clear();
                            else this.resetHistory(frame.type);
                            this.history.commit(body, completed);
                            resolve(new Response(JSON.stringify(completed ?? frame.response), { headers: { "content-type": "application/json" } }));
                        } else if (frame.type === "error") fail(new Error("Responses WebSocket upstream error"), "upstream-error");
                        return;
                    }
                    if (!settled) {
                        settled = true;
                        const readable = new ReadableStream<Uint8Array>({
                            start: c => { controller = c; },
                            cancel: () => { fail(new DOMException("Aborted", "AbortError"), "response-cancel"); this.close("response-cancel"); },
                        }, { highWaterMark: MAX_REQUEST_BYTES, size: chunk => chunk.byteLength });
                        resolve(new Response(readable, { headers: { "content-type": "text/event-stream" } }));
                    }
                    if ((controller?.desiredSize ?? 0) < 0) throw new Error("Responses WebSocket upstream buffer limit exceeded");
                    controller?.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${event.data}\n\n`));
                    if (frame.type === "response.completed" || frame.type === "response.failed" || frame.type === "response.incomplete" || frame.type === "error") {
                        clean();
                        if (completed) this.history.clear();
                        else this.resetHistory(String(frame.type));
                        this.history.commit(body, completed);
                        controller?.close();
                    }
                } catch (error) {
                    fail(error instanceof Error ? error : new Error("Invalid Responses WebSocket event"), "invalid-event");
                    this.close("invalid-event");
                }
            };
            this.active = { fail };
            socket.addEventListener("message", message);
            socket.addEventListener("error", failed);
            socket.addEventListener("close", failed);
            options.signal?.addEventListener("abort", aborted, { once: true });
            if (options.signal?.aborted) aborted();
            else {
                try { socket.send(JSON.stringify({ ...request, type: "response.create" })); }
                catch (error) { fail(error instanceof Error ? error : new Error("Responses WebSocket send failed"), "send-failed"); }
            }
        });
    }
}

function errorFrame(code: string, message: string, status = 400): string {
    return JSON.stringify({ type: "error", status, error: { type: "invalid_request_error", code, message } });
}

class ResponsesWsResponse extends http.ServerResponse {
    private ended = false;
    private sent = false;
    private buffer = "";
    private readonly decoder = new TextDecoder();
    private readonly output = new ResponsesWsOutput();
    response?: JsonObject;
    restoredOutputItems = 0;
    terminal = false;

    constructor(req: http.IncomingMessage, private readonly peer: WebSocket) {
        super(req);
        Object.defineProperty(this, "headersSent", { get: () => this.sent });
        Object.defineProperty(this, "writableEnded", { get: () => this.ended });
        Object.defineProperty(this, "socket", { get: () => req.socket });
    }

    override write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean;
    override write(chunk: string | Uint8Array, encoding: BufferEncoding, callback?: (error?: Error | null) => void): boolean;
    override write(chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
        this.sent = true;
        const cb = typeof encoding === "function" ? encoding : callback;
        this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
        if (this.buffer.length > MAX_REQUEST_BYTES) throw new Error("Responses WebSocket output buffer limit exceeded");
        this.buffer = normalizeSseLineEndings(this.buffer);
        let index: number;
        while ((index = this.buffer.indexOf("\n\n")) >= 0) {
            const block = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 2);
            const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data || data === "[DONE]") continue;
            const frame: unknown = JSON.parse(data);
            if (object(frame)) {
                const completed = this.output.observe(frame);
                if (completed) {
                    this.response = completed;
                    const terminal = object(frame.response) && Array.isArray(frame.response.output) ? frame.response.output.length : 0;
                    this.restoredOutputItems = (completed.output as unknown[]).length - terminal;
                }
                if (["response.completed", "response.failed", "response.incomplete", "error"].includes(String(frame.type))) this.terminal = true;
            }
            if (this.peer.readyState === WebSocket.OPEN) this.peer.send(data, { binary: false });
        }
        cb?.();
        if (this.peer.bufferedAmount > MAX_REQUEST_BYTES) {
            this.peer.close(1013, "Output buffer limit exceeded");
            this.destroy();
        }
        return true;
    }

    override end(callback?: () => void): this;
    override end(chunk: unknown, callback?: () => void): this;
    override end(chunk: unknown, encoding: BufferEncoding, callback?: () => void): this;
    override end(chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void): this {
        if (this.ended) return this;
        if (typeof chunk === "string" || chunk instanceof Uint8Array) this.write(chunk);
        if (!this.terminal && this.peer.readyState === WebSocket.OPEN) {
            let details: unknown;
            try { details = JSON.parse(this.buffer); } catch { details = undefined; }
            this.peer.send(object(details)
                ? JSON.stringify({ ...details, type: "error", status: this.statusCode >= 400 ? this.statusCode : 502 })
                : errorFrame("incomplete_response", "Responses exchange ended without a terminal event", 502));
        }
        this.ended = true;
        this.emit("finish");
        this.emit("close");
        const cb = typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : callback;
        if (typeof cb === "function") cb();
        return this;
    }
}


// Responses protocol codec over the generic WebSocket bridge (ws-bridge.ts).
// Protocol-specific pieces live here: frame validation, the client-side
// history contract (previous_response_id expansion), the upstream WebSocket
// transport with its continuation checkpoints, and the SSE response sink that
// re-frames pipeline output for the client.

class ResponsesWsSession implements WsBridgeSession {
    private readonly transport: ResponsesWsUpstream;
    private readonly history = new ResponsesWsHistory();
    private active?: ResponsesWsResponse;
    private busy = false;

    constructor(private readonly context: WsBridgeContext) {
        this.transport = new ResponsesWsUpstream(context.log);
        context.log("info", "Responses socket connected (ACP request pipeline)");
    }

    stats(): { retainedBytes: number; inFlight: boolean } {
        return { retainedBytes: this.history.bytes() + this.transport.retainedBytes(), inFlight: this.busy };
    }

    onMessage(data: Buffer, binary: boolean): void {
        const peer = this.context.peer;
        if (binary) { peer.close(1003, "Responses requires text frames"); return; }
        if (this.busy) { this.context.log("warn", "client rejected reason=response-in-progress"); peer.send(errorFrame("response_in_progress", "Only one active response is supported", 409)); return; }
        let frame: unknown;
        let body: JsonObject;
        try {
            frame = JSON.parse(data.toString());
            if (!object(frame) || frame.type !== "response.create") throw new Error("Unsupported Responses client event");
            const badStreamFlag = this.context.codec.allowStreamFlag ? (frame.stream !== undefined && frame.stream !== true) : frame.stream !== undefined;
            if (frame.stream_id !== undefined || badStreamFlag || frame.background !== undefined || frame.stream_options !== undefined) throw new Error("Unsupported Responses transport options");
            body = { ...this.history.expand(frame), stream: true };
            if (Buffer.byteLength(JSON.stringify(body)) > MAX_REQUEST_BYTES) throw new Error("request_too_large");
        } catch (error) {
            const code = error instanceof Error && ["previous_response_not_found", "request_too_large"].includes(error.message) ? error.message : "invalid_request";
            this.context.log("warn", `client rejected reason=${code}`);
            peer.send(errorFrame(code, code === "previous_response_not_found" ? "Send full input without previous_response_id" : "Invalid or oversized response.create event", code === "request_too_large" ? 413 : 400));
            return;
        }
        this.busy = true;
        const source = this.context.source;
        const handshakeHeaders: Record<string, string> = {};
        const connectionHeaders = connectionNamedHeaders(source.headers.connection);
        for (const [key, value] of Object.entries(source.headers)) {
            if (!UPSTREAM_HOP_HEADERS.has(key) && !connectionHeaders.has(key) && !key.startsWith("sec-websocket-") && key !== "content-encoding") handshakeHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
        }
        // Prewarm probes (empty input, generate:false) are transport-layer
        // noise, not conversation turns. Codex sends one on every new
        // connection and expects only a terminal event back. Routing them
        // through the ACP pipeline would normalize the empty input into a
        // synthesized message (#1862) and record a phantom turn in the
        // kernel's ref sequence, shifting every later fold anchor; injecting
        // tools and compression prompts into a no-generation request is pure
        // byte inflation. Forward verbatim on the upstream transport.
        if (Array.isArray(body.input) && body.input.length === 0 && body.generate === false) {
            void (async () => {
                try {
                    const response = await this.transport.fetch(this.context.upstreamUrl, { method: "POST", headers: { ...handshakeHeaders, "content-type": "application/json" }, body: JSON.stringify(body) });
                    if (response.body === null) {
                        peer.send(await response.text());
                        return;
                    }
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = "";
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        for (;;) {
                            const index = buffer.indexOf("\n\n");
                            if (index < 0) break;
                            const block = buffer.slice(0, index);
                            buffer = buffer.slice(index + 2);
                            for (const line of block.split("\n")) if (line.startsWith("data: ")) peer.send(line.slice(6));
                        }
                    }
                } catch {
                    this.context.log("warn", "probe relay failed");
                    peer.send(errorFrame("invalid_request", "Probe relay failed", 502));
                } finally {
                    this.active = undefined;
                    this.busy = false;
                }
            })();
            return;
        }
        const req = new http.IncomingMessage(source.socket);
        req.complete = true;
        req.method = "POST";
        req.url = source.url;
        Object.assign(req.headers, handshakeHeaders);
        req.headers["content-type"] = "application/json";
        req.push(Buffer.from(JSON.stringify(body)));
        req.push(null);
        const res = new ResponsesWsResponse(req, peer);
        res.on("error", () => {});
        this.active = res;
        void withFetchTransport((url, options) => this.transport.fetch(url, options), async () => {
            try {
                await this.context.dispatch(req, res);
                if (res.response) {
                    this.history.commit(body, res.response);
                    if (res.restoredOutputItems > 0) this.context.log("debug", `checkpoint restored ${res.restoredOutputItems} streamed output item(s) absent from terminal output`);
                }
            } catch {
                this.context.log("warn", `exchange failed phase=dispatch terminal=${res.terminal}`);
                if (!res.writableEnded) res.end();
            } finally {
                this.active = undefined;
                this.busy = false;
            }
        });
    }

    onClose(code: number): void {
        this.context.log("debug", `client closed phase=${this.busy ? "active" : "idle"} close_code=${code}`);
        this.active?.destroy();
        this.transport.close("client-close");
        this.history.clear();
        this.context.log("debug", "client checkpoint reset reason=client-close");
    }

    shutdown(reason: string): void {
        this.transport.close(reason);
        this.history.clear();
        this.active?.destroy();
    }
}

export const responsesCodec: WsBridgeCodec = {
    name: "responses-ws",
    pluginMarker: "opencode",
    matchUpgrade: url => /^\/bili\/responses\/(https?:\/\/.*\/responses(?:\?.*)?)$/.exec(url ?? "")?.[1],
    createSession: context => new ResponsesWsSession(context),
};

// Codex CLI (0.147+, provider `supports_websockets = true`, feature flag
// `responses_websockets`) swaps its HTTP SSE lane for a WebSocket that speaks
// the same Responses event vocabulary, one JSON text frame per event, with
// sequential `response.create` requests over one connection (first a probe
// with `input: []` + `generate: false`, then one full-history-replay request
// per turn — codex never sends previous_response_id). Captured from a real
// 0.147.0 client: handshake carries `openai-beta: responses_websockets=…`,
// `session-id`/`thread-id`, and `x-codex-turn-metadata`; the body carries
// `store: false`, `stream: true`, `include: [reasoning.encrypted_content]`,
// `prompt_cache_key`, and `client_metadata`, all of which ride the envelope
// unchanged. Admission is prefix-lane (no plugin marker): the path is the
// ordinary prefix-mode shape `/bili/<upstream>/responses` — disjoint from the
// opencode plugin lane above — keyed on codex's own `session-id` header, so
// the pipeline resolves the same conversation the HTTP lane would. A foreign
// client hitting this shape gets a protocol error frame, never silent
// corruption, and the tunnel guard still gates the upstream.
export const codexResponsesCodec: WsBridgeCodec = {
    name: "codex-responses-ws",
    conversationHeader: "session-id",
    matchUpgrade: url => /^\/bili\/(https?:\/\/.*\/responses(?:\?.*)?)$/.exec(url ?? "")?.[1],
    // Captured codex_cli 0.147.0 frames always carry stream:true; the
    // response.create body is otherwise the Responses API shape verbatim.
    allowStreamFlag: true,
    createSession: context => new ResponsesWsSession(context),
};
