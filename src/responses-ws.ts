import http from "node:http";
import type { ResponsesRequestBody } from "acp-kernel/wire";
import { WebSocket as UpstreamWebSocket, type Dispatcher } from "undici";
import WebSocket from "ws";
import { fetchWithTimeout, type FetchOptions } from "./fetch-util.js";
import { limitsReceiveBytes } from "./knobs.js";
import { featureEnabled } from "./rollout.js";
import { getStore } from "./persist.js";
import { responsesToCoreWithToolImages } from "./responses-tool-output.js";
import { identitySig, SnapshotAnchorFallbackError, WS_ANCHORED_REQ_PROP } from "./server/snapshot-render.js";
import { markWsLaneTransport, withFetchTransport } from "./fetch-transport.js";
import { BILI_HOP_HEADER } from "./server/context-window.js";
import { connectionNamedHeaders, stripRemoteCompactionBetaFeature, UPSTREAM_HOP_HEADERS } from "./server/headers.js";
import { BILI_TUNNEL_HEADER } from "./tunnel-guard.js";
import { normalizeSseLineEndings, finalizeSseLineEndings } from "./sse-util.js";
import type { WsBridgeCodec, WsBridgeContext, WsBridgeSession } from "./ws-bridge.js";

type JsonObject = Record<string, unknown>;
type DiagnosticLog = (level: "debug" | "info" | "warn", message: string) => void;

function closeCode(event: Event): number | "none" {
    return "code" in event && typeof event.code === "number" ? event.code : "none";
}

// #3342: the ONLY failure that may trigger the HTTP/SSE egress fallback is a
// genuine WS-upgrade refusal in the handshake phase (before any generation
// request is sent). An abort (client cancelled) or any other error propagates
// instead — a generation that already started must never be replayed over HTTP.
function isHandshakeRefusal(error: unknown): boolean {
    return error instanceof Error && error.message === "Responses WebSocket handshake failed";
}

// egressHttp arms fetchWithTimeout's idle watchdog — a ref'd timer defaulting to a
// 10-minute pin when no explicit timeout is passed — but returns the response for the
// caller to stream later, so it cannot clear it itself. Wrap the body to release it
// exactly once on settle (close/error/cancel); every other fetchWithTimeout caller does
// this, and leaking it pins the event loop for the whole watchdog window per fallback
// turn (#552-class hang). The underlying body is already armIdleBody-wrapped, so this
// composes cleanly and re-arms on each chunk until settle.
function releaseUpstreamWatchdog(response: Response, release: () => void): Response {
    const inner = response.body;
    if (!inner) { release(); return response; }
    const reader = inner.getReader();
    let released = false;
    const finish = (): void => { if (!released) { released = true; release(); } };
    const wrapped = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const chunk = await reader.read();
                if (chunk.done) { controller.close(); finish(); return; }
                controller.enqueue(chunk.value);
            } catch (err) { controller.error(err); finish(); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } catch { /* upstream already gone */ } finish(); },
    });
    return new Response(wrapped, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** #3701: typed upstream WS failure carrying the close code and how far the
 *  exchange got, so callers can route by MECHANISM instead of parsing a generic
 *  message. close_code=1009 with receivedEvents=0 is the size-rejection signature
 *  (the gateway answered our frame); anything else keeps the legacy treatment. */
export class ResponsesWsUpstreamError extends Error {
    constructor(
        message: string,
        readonly closeCode: number | "none",
        readonly phase: "handshake" | "await-first-event" | "stream",
        readonly receivedEvents: number,
    ) {
        super(message);
        this.name = "ResponsesWsUpstreamError";
    }
}

function object(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeEventType(frame: unknown): string {
    if (frame === null) return "null";
    if (!object(frame)) return Array.isArray(frame) ? "array" : String(typeof frame);
    return typeof frame.type === "string" ? frame.type : "<missing type>";
}

// #2359: Azure OpenAI caps custom request headers on the WS upgrade (documented
// 10). Bili's forwarded x-bili-* metadata (already consumed at ingress) plus
// OpenCode's own x-* headers push a typical handshake past it, so the gateway
// closes with 1011 before any event. Strip bili-internal headers at final egress
// to *.openai.azure.com ONLY — auth + OpenCode headers stay intact, and every
// other host keeps its existing forwarding/chaining behavior byte-for-byte.
function isAzureOpenAiHost(url: string): boolean {
    try {
        return new URL(url).hostname.toLowerCase().endsWith(".openai.azure.com");
    } catch {
        return false;
    }
}

/** Final wire header set for an upstream Responses WebSocket upgrade: drop
 *  hop-by-hop + sec-websocket- markers, strip codex's own remote-compaction
 *  beta feature (#3073: parity with the HTTP forward path — probe and turn
 *  must present the same surface), then (azure only) the consumed x-bili-*
 *  metadata. Exported so the exact egress decision — including the #2359 azure
 *  custom-header-cap strip — is asserted directly rather than via a permissive
 *  round-trip mock. */
export function finalizeResponsesWsUpstreamHeaders(url: string, rawHeaders: FetchOptions["headers"]): Record<string, string> {
    const headers = Object.fromEntries(new Headers(rawHeaders).entries());
    for (const key of Object.keys(headers)) if (UPSTREAM_HOP_HEADERS.has(key) || key.startsWith("sec-websocket-")) delete headers[key];
    stripRemoteCompactionBetaFeature(headers);
    if (isAzureOpenAiHost(url)) for (const key of Object.keys(headers)) if (key.startsWith("x-bili-")) delete headers[key];
    return headers;
}

// Transport options the WebSocket lane cannot honor. The lane forces stream:true
// and owns streaming itself, so HTTP-side transport controls are refused — but
// only the ones genuinely incompatible with a single WS exchange. stream_options
// is deliberately NOT refused: it carries streaming delivery hints (codex sends
// stream_options.reasoning_summary_delivery) that ride a WS connection fine and
// the upstream transport normalizes it before reaching the real API. Refusing it
// is what broke codex 0.160.0 over WS (#2126).
function unsupportedTransportOptions(frame: JsonObject, allowStreamFlag: boolean | undefined): string[] {
    const offenders: string[] = [];
    if (frame.stream_id !== undefined) offenders.push("stream_id");
    const badStreamFlag = allowStreamFlag ? frame.stream !== undefined && frame.stream !== true : frame.stream !== undefined;
    if (badStreamFlag) offenders.push(allowStreamFlag ? `stream=${JSON.stringify(frame.stream)} (must be true)` : "stream flag (the lane streams unconditionally)");
    if (frame.background !== undefined) offenders.push("background");
    return offenders;
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
    /** #4804: prior checkpoint this one continued — steady-state deltas stay
     *  O(1) memory; expand() walks the chain only on the legacy fallback. */
    base?: Checkpoint;
    /** #4804: identitySig of the last core message of `request`'s conversion —
     *  pins the transcript's last row to this exact turn body. */
    tailSig?: string;
    /** #4804: this turn's NEW input items only. A level with a tail carried an
     *  augmented (partial) body; a level WITHOUT one (legacy full-replay turn)
     *  carries the complete reconstruction in request.input and re-baselines
     *  the chain for every level after it. */
    tail?: unknown[];
}

/** #4804: output item types that are also LEGAL response.input items — the
 *  only shapes the delta lane may echo into the next body. Anything else
 *  (search calls, image_gen, …) takes that turn down the legacy path. */
const ECHOABLE_OUTPUT_ITEM_TYPES = new Set(["message", "function_call", "custom_tool_call", "reasoning"]);

/** #4804: identitySig of the LAST core message of a converted body (null when
 *  it converts to nothing or fails — the next delta then takes the legacy
 *  path). The same converter runs on the stored-row side, so parity is exact. */
function computeTailSig(body: JsonObject): string | null {
    try {
        const { msgs } = responsesToCoreWithToolImages(body as ResponsesRequestBody);
        const last = msgs[msgs.length - 1];
        return last ? identitySig(last) : null;
    } catch {
        return null;
    }
}

class ResponsesWsOutput {
    private items = new Map<number, { item: JsonObject; bytes: number }>();
    private bytes = 0;
    constructor(private readonly limitBytes = limitsReceiveBytes()) {}

    observe(frame: JsonObject): JsonObject | undefined {
        if (frame.type === "response.created") {
            this.items.clear();
            this.bytes = 0;
        }
        if (frame.type === "response.output_item.done" && object(frame.item) && Number.isSafeInteger(frame.output_index) && (frame.output_index as number) >= 0) {
            const index = frame.output_index as number;
            const bytes = Buffer.byteLength(JSON.stringify(frame.item));
            this.bytes += bytes - (this.items.get(index)?.bytes ?? 0);
            if (this.bytes > this.limitBytes) throw new Error("Responses WebSocket checkpoint buffer limit exceeded");
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
    constructor(private readonly limitBytes = limitsReceiveBytes()) {}

    expand(frame: JsonObject): JsonObject {
        const { type: _type, previous_response_id: previous, ...request } = frame;
        if (typeof request.input === "string") request.input = [{ type: "message", role: "user", content: request.input }];
        if (!Array.isArray(request.input)) throw new Error("response.create requires an input array");
        if (previous !== undefined && previous !== null) {
            if (previous !== this.checkpoint?.id) throw new Error("previous_response_not_found");
            // Walk the checkpoint chain oldest→newest. The base level always
            // carries a complete reconstruction in request.input; every later
            // level contributes only its own tail + output (its augmented body
            // would double-count the echoed previous output otherwise).
            const levels: Checkpoint[] = [];
            let cursor: Checkpoint | undefined = this.checkpoint;
            while (cursor) {
                levels.unshift(cursor);
                cursor = cursor.base;
            }
            const base = levels[0];
            if (!base || !Array.isArray(base.request.input)) throw new Error("previous_response_not_found");
            // Per-level contribution in conversation order: the base's complete
            // input, then each later level's own tail followed by its output.
            let input: unknown[] = [];
            for (let i = 0; i < levels.length; i++) {
                const level = levels[i];
                if (i === 0 && Array.isArray(level.request.input)) input = [...input, ...level.request.input];
                else if (Array.isArray(level.tail)) input = [...input, ...level.tail];
                input = [...input, ...level.output];
            }
            // #2966: generate is a per-request action control, not conversation
            // state — a prewarm's generate:false must not leak into a continuation
            // that omits the field (the upstream would then refuse to generate).
            const { generate: _priorGenerate, ...topRequest } = levels[levels.length - 1].request;
            return { ...topRequest, ...request, input: [...input, ...request.input] };
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

    current(): Checkpoint | undefined {
        return this.checkpoint;
    }

    commit(request: JsonObject, response: unknown, opts?: { tailSig?: string; continuedId?: string; tail?: unknown[] }): void {
        if (!object(response) || response.status !== "completed" || typeof response.id !== "string" || !Array.isArray(response.output)) return;
        if (Buffer.byteLength(JSON.stringify(request)) + Buffer.byteLength(JSON.stringify(response.output)) > this.limitBytes) {
            this.clear();
            return;
        }
        // #4804: chain onto the prior checkpoint when this request continued IT.
        // continuedId comes from the CALLER because the committed body has its
        // previous_response_id stripped (the provider sees a full input).
        const contId = opts?.continuedId ?? (typeof request.previous_response_id === "string" ? request.previous_response_id : undefined);
        const prior = this.checkpoint;
        const chained = contId !== undefined && prior !== undefined && contId === prior.id;
        this.checkpoint = {
            id: response.id,
            request,
            output: response.output,
            ...(chained && prior ? { base: prior } : {}),
            ...(opts?.tailSig ? { tailSig: opts.tailSig } : {}),
            ...(opts?.tail ? { tail: [...opts.tail] } : {}),
        };
    }

    clear(): void {
        this.checkpoint = undefined;
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

    constructor(private readonly log: DiagnosticLog = () => {}, private readonly requestBytes = limitsReceiveBytes(), private readonly hopStamp?: string, private readonly forwardTransportFields = false) {}

    private resetHistory(reason: string): void {
        this.history.clear();
        this.log("debug", `upstream checkpoint reset reason=${reason}`);
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
        // #3073: single egress boundary both request paths share. The prewarm
        // probe bypasses the ACP pipeline that stamps bili-internal markers on
        // turn envelopes, so probe and turn handshakes diverged (x-bili-hop /
        // x-bili-tunnel present only on turns) — different connection keys tore
        // every client connection onto two upstream sockets and wiped the
        // checkpoint at the switch. Stamp here, mirroring the pipeline's own
        // decision: own id only when no upstream bili already marked the
        // traffic (a present marker means chain-skip — keep it verbatim, like
        // relay() does), tunnel marker unconditional because this lane IS a
        // /bili/ absolute-URL forward by construction. Idempotent for turns,
        // which arrive pre-stamped with exactly these values.
        const stamped = Object.fromEntries(new Headers(options.headers).entries());
        if (this.hopStamp !== undefined && !Object.keys(stamped).includes(BILI_HOP_HEADER)) stamped[BILI_HOP_HEADER] = this.hopStamp;
        stamped[BILI_TUNNEL_HEADER] = "1";
        const headers = finalizeResponsesWsUpstreamHeaders(url, stamped);
        const wsUrl = url.replace(/^http/, "ws");
        // Connection identity is what the upstream binds to the session. x-bili-*
        // is consumed at ingress by chained bilis (chain/self-loop detection)
        // and stripped or ignored by real upstreams — it cannot change how an
        // upstream treats the connection, so it stays out of the key (#3073):
        // internal bookkeeping must never fragment the socket.
        const key = `${wsUrl}:${canonical(Object.fromEntries(Object.entries(headers).filter(([k]) => !k.startsWith("x-bili-"))))}`;
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

    // #3342: plain-HTTP /responses+SSE egress for a supplier that refused the WS
    // upgrade. Sends the FULL expanded effective input (minus previous_response_id
    // and the WS-only `type` field — a fresh connection shares no checkpoint, so a
    // delta would dangle), transport fields under the same codec gate as the WS
    // egress. Returns the supplier's response UNCHANGED so the relay forwards it
    // exactly like the non-WS codex lane (2xx→drainSse→WS frames, non-2xx verbatim);
    // cancellation rides the same abort signal the WS leg honors.
    private async egressHttp(url: string, options: FetchOptions, body: JsonObject, egressTransportFields: JsonObject): Promise<Response> {
        const stamped = Object.fromEntries(new Headers(options.headers).entries());
        if (this.hopStamp !== undefined && !Object.keys(stamped).includes(BILI_HOP_HEADER)) stamped[BILI_HOP_HEADER] = this.hopStamp;
        stamped[BILI_TUNNEL_HEADER] = "1";
        const headers = finalizeResponsesWsUpstreamHeaders(url, stamped);
        headers["content-type"] = "application/json";
        // The WS lane streams because the connection is inherently streaming;
        // plain HTTP has no such default, so force stream:true or the supplier
        // answers a single JSON body that the SSE-only sink would mislabel as an
        // error frame. (body carries no `stream` — it was stripped above.)
        const httpBody: JsonObject = { ...body, ...egressTransportFields, stream: true };
        const { response, clearTimer } = await fetchWithTimeout(
            url,
            { method: "POST", headers, body: JSON.stringify(httpBody), dispatcher: options.dispatcher },
            undefined,
            options.signal ?? undefined,
            true,
        );
        return releaseUpstreamWatchdog(response, clearTimer);
    }

    async fetch(url: string, options: FetchOptions, rotateRetry = true): Promise<Response> {
        const bodyText = bodyToText(options.body);
        if (options.method !== "POST" || !new URL(url).pathname.endsWith("/responses") || bodyText === undefined) throw new Error("Unsupported request in Responses WebSocket transport");
        const parsed: unknown = JSON.parse(bodyText);
        if (!object(parsed) || !Array.isArray(parsed.input)) throw new Error("Invalid Responses WebSocket request");
        const { stream, stream_options: streamOptions, background: _background, previous_response_id: _previous, type: _type, ...body } = parsed;
        // #3063 wire fidelity (WC-017): the codex lane admits stream/stream_options from
        // the client and must forward them verbatim — real codex create frames always carry
        // stream:true (required field), and dropping it made chatgpt.com answer with a
        // zero-output completed turn. Gated on forwardTransportFields (the codec's
        // allowStreamFlag) rather than field presence: the session layer injects
        // stream:true into EVERY frame before fetch(), so presence cannot distinguish a
        // client-sent field from an internal one. The opencode lane (WC-013) refuses both
        // fields at admission, so its egress stays byte-identical to before.
        const egressTransportFields: JsonObject = {};
        if (this.forwardTransportFields) {
            if (stream !== undefined) egressTransportFields.stream = stream;
            if (streamOptions !== undefined) egressTransportFields.stream_options = streamOptions;
        }
        let socket: InstanceType<typeof UpstreamWebSocket>;
        try {
            socket = await this.connect(url, options);
        } catch (error) {
            // #3342: supplier refused the WS upgrade before any generation request
            // was sent → egress over plain HTTP /responses+SSE instead. Any other
            // failure (abort, non-handshake error) propagates unchanged.
            if (!isHandshakeRefusal(error)) throw error;
            this.close("ws-refused-http-fallback");
            this.log("debug", "upstream egress mode=http reason=ws-handshake-refused");
            return this.egressHttp(url, options, body, egressTransportFields);
        }
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
            // #3701: log the EXACT outbound frame bytes — the upstream gateway judges by
            // bytes, not tokens, so this number is what the ws-byte-shed ladder targets.
            const sendCreate = (payload: JsonObject): void => {
                const frameText = JSON.stringify({ ...payload, ...egressTransportFields, type: "response.create" });
                this.log("info", `upstream send mode=${payload.previous_response_id === undefined ? "full" : "delta"} bytes=${Buffer.byteLength(frameText)}`);
                socket.send(frameText);
            };
            // Backpressure (#2076): the WS socket cannot be paused, so frames arriving
            // while the consumer lags wait in the stream's own queue — delivery is
            // consumer-paced by construction. retained tracks that backlog (exact while
            // the queue is under the highWaterMark, conservative beyond) so the guard
            // below still bounds memory for a consumer that never catches up.
            let retained = 0;
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
                const phase = receivedEvents > 0 ? "stream" : "await-first-event";
                this.log("warn", `upstream failed phase=${phase} event=${event.type} close_code=${closeCode(event)} received_events=${receivedEvents}`);
                fail(new ResponsesWsUpstreamError(
                    `Responses WebSocket upstream disconnected before completion (close_code=${closeCode(event)}, received_events=${receivedEvents})`,
                    closeCode(event),
                    phase,
                    receivedEvents,
                ), "upstream-disconnect");
            };
            const aborted = (): void => {
                this.log("debug", `upstream aborted phase=${receivedEvents > 0 ? "stream" : "await-first-event"}`);
                fail(new DOMException("Aborted", "AbortError"), "request-abort");
                this.close("request-abort");
            };
            const message = (event: { data: unknown }): void => {
                if (ended) return;
                try {
                    if (typeof event.data !== "string" || Buffer.byteLength(event.data) > this.requestBytes) throw new Error("Invalid or oversized Responses WebSocket frame");
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
                            sendCreate(body);
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
                        }, { highWaterMark: this.requestBytes, size: chunk => chunk.byteLength });
                        resolve(new Response(readable, { headers: { "content-type": "text/event-stream" } }));
                    }
                    const block = `event: ${frame.type}\ndata: ${event.data}\n\n`;
                    const desired = controller?.desiredSize ?? 0;
                    retained = desired > 0 ? this.requestBytes - desired : retained + Buffer.byteLength(block);
                    controller?.enqueue(encoder.encode(block));
                    if (retained > 2 * this.requestBytes) throw new Error("Responses WebSocket upstream buffer limit exceeded");
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
                try { sendCreate(request); }
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
    private readonly limitBytes = limitsReceiveBytes();
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
        if (this.buffer.length > this.limitBytes) throw new Error("Responses WebSocket output buffer limit exceeded");
        this.buffer = normalizeSseLineEndings(this.buffer);
        this.drainSse();
        cb?.();
        if (this.peer.bufferedAmount > this.limitBytes) {
            this.peer.close(1013, "Output buffer limit exceeded");
            this.destroy();
        }
        return true;
    }

    private drainSse(): void {
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
    }

    override end(callback?: () => void): this;
    override end(chunk: unknown, callback?: () => void): this;
    override end(chunk: unknown, encoding: BufferEncoding, callback?: () => void): this;
    override end(chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void): this {
        if (this.ended) return this;
        if (typeof chunk === "string" || chunk instanceof Uint8Array) this.write(chunk);
        // #2323: resolve a CRLF/lone-CR whose final byte arrived last (held back by
        // the streaming normalizer) so a complete terminal frame isn't lost.
        this.buffer = finalizeSseLineEndings(this.buffer);
        this.drainSse();
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

export class ResponsesWsSession implements WsBridgeSession {
    private readonly transport: ResponsesWsUpstream;
    private readonly history = new ResponsesWsHistory();
    private readonly budget = limitsReceiveBytes();
    private active?: ResponsesWsResponse;
    private busy = false;

    constructor(private readonly context: WsBridgeContext) {
        this.transport = new ResponsesWsUpstream(context.log, undefined, context.instanceId, context.codec.allowStreamFlag === true);
        context.log("info", "Responses socket connected (ACP request pipeline)");
    }

    onMessage(data: Buffer, binary: boolean): void {
        const peer = this.context.peer;
        if (binary) { peer.close(1003, "Responses requires text frames"); return; }
        if (this.busy) { this.context.log("warn", "client rejected reason=response-in-progress"); peer.send(errorFrame("response_in_progress", "Only one active response is supported", 409)); return; }
        // Each admission failure names its own branch on the wire AND in the log:
        // the old shared "invalid_request" / "Invalid or oversized" bucket (#2126)
        // hid whether the client sent an unsupported event, an unsupported
        // transport option (and which one), or hit the size cap.
        const refuse = (code: string, message: string, status: number): void => {
            this.context.log("warn", `client rejected reason=${code} detail=${message}`);
            peer.send(errorFrame(code, message, status));
        };
        let body: JsonObject;
        let wire = "";
        let anchoredTailSig: string | undefined;
        // #4804: set ONLY on the delta short-circuit — legacy full-replay turns
        // commit flat (their body is already a complete reconstruction; chaining
        // below it would double-count history).
        let deltaContinuation: { id: string; tail: unknown[] } | undefined;
        try {
            const rawFrame: unknown = JSON.parse(data.toString());
            if (!object(rawFrame) || rawFrame.type !== "response.create") {
                refuse("invalid_request", `expected a response.create frame, got ${describeEventType(rawFrame)}`, 400);
                return;
            }
            const frame = rawFrame as JsonObject;
            const unsupported = unsupportedTransportOptions(frame, this.context.codec.allowStreamFlag);
            if (unsupported.length > 0) {
                refuse("invalid_request", `response.create carries unsupported transport option(s): ${unsupported.join(", ")}`, 400);
                return;
            }
            // #4804 delta continuation: when the client continues OUR own last
            // committed turn, skip the O(full-history) reconstruction — the body
            // carries only the server-committed previous output plus the new
            // input tail, and prepare renders the prefix from the unified
            // transcript (anchored snapshot render), verifying the seam against
            // the checkpoint's tailSig. Every miss degrades to the legacy path
            // below or the 400 the client answers with a full replay.
            const cp = this.history.current();
            const continuedId = typeof frame.previous_response_id === "string" ? frame.previous_response_id : undefined;
            const deltaEligible =
                featureEnabled("wsDeltaContinuation") &&
                !this.context.source.headers["x-bili-plugin"] &&
                cp !== undefined &&
                continuedId !== undefined &&
                continuedId === cp.id &&
                Array.isArray(frame.input) &&
                cp.tailSig !== undefined &&
                getStore()?.unifiedReads() === true &&
                cp.output.every((item) => object(item) && ECHOABLE_OUTPUT_ITEM_TYPES.has(String(item.type)));
            if (deltaEligible) {
                const { type: _type, previous_response_id: _prev, ...requestFields } = frame;
                const { generate: _priorGenerate, ...priorRequest } = cp.request;
                body = { ...priorRequest, ...requestFields, input: [...cp.output, ...(frame.input as unknown[])], stream: true };
                anchoredTailSig = cp.tailSig;
                deltaContinuation = { id: continuedId!, tail: frame.input as unknown[] };
            } else {
                // One serialization per turn (#4804 part A): admission measures the same wire
                // string the envelope pushes below, against the receive budget knob
                // instead of the fixed 100 MiB cap that killed long sessions pre-dispatch.
                body = { ...this.history.expand(frame), stream: true };
            }
            wire = JSON.stringify(body);
            if (Buffer.byteLength(wire) > this.budget) {
                refuse("request_too_large", `response.create exceeds the ${Math.round(this.budget / (1024 * 1024))} MiB request limit`, 413);
                return;
            }
        } catch (error) {
            if (error instanceof Error && error.message === "previous_response_not_found") {
                refuse("previous_response_not_found", "Send full input without previous_response_id", 400);
                return;
            }
            refuse("invalid_request", error instanceof SyntaxError ? "response.create frame is not valid JSON" : error instanceof Error ? error.message : "malformed response.create frame", 400);
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
                const sendFrame = (payload: string): void => { if (peer.readyState === WebSocket.OPEN) peer.send(payload); };
                let sawTerminal = false;
                try {
                    const response = await this.transport.fetch(this.context.upstreamUrl, { method: "POST", headers: { ...handshakeHeaders, "content-type": "application/json" }, body: JSON.stringify(body) });
                    if (response.body === null) {
                        const text = await response.text();
                        if (!response.ok) {
                            this.history.clear();
                            sendFrame(text || errorFrame("probe_failed", "Warmup failed", response.status >= 400 ? response.status : 502));
                            return;
                        }
                        sendFrame(text);
                        return;
                    }
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = "";
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        if (buffer.length > this.budget) throw new Error("Warmup output buffer limit exceeded");
                        for (;;) {
                            const index = buffer.indexOf("\n\n");
                            if (index < 0) break;
                            const block = buffer.slice(0, index);
                            buffer = buffer.slice(index + 2);
                            for (const line of block.split("\n")) {
                                if (!line.startsWith("data: ")) continue;
                                const payload = line.slice(6);
                                sendFrame(payload);
                                let frame: unknown;
                                try { frame = JSON.parse(payload); } catch { continue; }
                                if (!object(frame)) continue;
                                if (["response.completed", "response.failed", "response.incomplete", "error"].includes(String(frame.type))) {
                                    sawTerminal = true;
                                    // #3342: even a no-generation warmup must establish a usable
                                    // client checkpoint, so a later previous_response_id
                                    // continuation resolves instead of throwing not_found.
                                    if (frame.type === "response.completed" && object(frame.response)) this.history.commit(body, frame.response);
                                }
                            }
                        }
                    }
                    if (!sawTerminal) {
                        this.history.clear();
                        sendFrame(response.ok
                            ? errorFrame("incomplete_response", "Warmup ended without a terminal event", 502)
                            : errorFrame("probe_failed", "Warmup failed", response.status >= 400 ? response.status : 502));
                    }
                } catch {
                    this.history.clear();
                    this.context.log("warn", "probe relay failed");
                    sendFrame(errorFrame("invalid_request", "Probe relay failed", 502));
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
        if (anchoredTailSig !== undefined) {
            Object.defineProperty(req, WS_ANCHORED_REQ_PROP, { value: { tailSig: anchoredTailSig }, enumerable: false });
        }
        req.push(Buffer.from(wire));
        req.push(null);
        const res = new ResponsesWsResponse(req, peer);
        res.on("error", () => {});
        this.active = res;
        // markWsLaneTransport (#3701 Finding 1): the egress-shed byte budget keys on
        // this tag — managed HTTP transports (dsh-inline) stay out of the shed.
        void withFetchTransport(markWsLaneTransport((url, options) => this.transport.fetch(url, options)), async () => {
            try {
                await this.context.dispatch(req, res);
                if (res.response) {
                    this.history.commit(body, res.response, {
                        tailSig: computeTailSig(body) ?? undefined,
                        continuedId: deltaContinuation?.id,
                        tail: deltaContinuation?.tail,
                    });
                    if (res.restoredOutputItems > 0) this.context.log("debug", `checkpoint restored ${res.restoredOutputItems} streamed output item(s) absent from terminal output`);
                }
            } catch (error) {
                if (error instanceof SnapshotAnchorFallbackError) {
                    // #4804: the anchored render could not verify the transcript
                    // seam — answer with the client's standard recovery (full
                    // replay) and drop the checkpoint chain so the replay
                    // re-anchors fresh. Never guess a view.
                    this.history.clear();
                    this.context.log("warn", `delta continuation rejected reason=${error.reason} — requesting full replay`);
                    this.active?.destroy();
                    if (peer.readyState === WebSocket.OPEN) peer.send(errorFrame("previous_response_not_found", "Send full input without previous_response_id", 400));
                    return;
                }
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
// with `input: []` + `generate: false`, then one request per turn). Captured
// from a real 0.147.0 client, which sent a full-history replay every turn and
// never previous_response_id; other builds send previous_response_id with a
// tiny input tail instead (#4804 real capture) — both shapes are live
// production traffic. Handshake carries `openai-beta: responses_websockets=…`,
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
