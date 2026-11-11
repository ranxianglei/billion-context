// Native-mode Codex Responses WebSocket interception (#2111, follow-up to #2073;
// proxy-side bridge & codec from #1968).
//
// The fetch intercept (native-intercept.ts) rewrites model-API HTTP(S) requests
// to `<proxy>/bili/<upstream>`. The pi Codex provider's `transport: "auto"` /
// `"websocket"` mode instead opens a WebSocket straight at
// `wss://<host>/backend-api/codex/responses` (pi 1.0.2 constructor form:
// `new WebSocketCtor(url, { headers })`) — invisible to the fetch patch, so
// every model request bypassed the proxy and no ACP session ever formed
// (#2073). This module closes that gap on the CLIENT side:
//
//   * wraps globalThis.WebSocket at native-extension load, BEFORE any model
//     connection. Timing is a hard constraint, not a preference: pi's Node
//     branch reads globalThis.WebSocket live per call, but its Bun branch
//     caches a subclass of the then-global constructor on first use — only a
//     load-time install is correct on both runtimes (#2073 Q3);
//   * claims ONLY the supported Codex Responses shape (ws(s)://… whose path
//     ends in /responses) and rewrites it to `ws(s)://<proxy>/bili/<https-
//     upstream>`. The scheme split is mandatory: codexResponsesCodec only
//     claims `/bili/(https?://…/responses)` (src/responses-ws.ts) and the
//     upstream transport turns the embedded URL back with
//     `url.replace(/^http/, "ws")` — a naive `${origin}/bili/${wssUrl}` is
//     unclaimed and 426s;
//   * forwards constructor arguments VERBATIM (subprotocols, the `{headers}`
//     init object carrying session-id + x-bili-plugin* stamped by pi's
//     before_provider_headers — verified to ride the upgrade request on Node
//     ≥22 undici and Bun, #2073 Q1). Exception (#5838): lanes that arm the
//     per-dispatch preparation hooks on their NativeInterceptState (dsh —
//     its identity stamping lives in state.headersFor, not in a host header
//     event) run that preparation inside the deferred window and merge the
//     stamped headers onto the upgrade init. Each response.create then awaits
//     body-aware preparation in its sender's scope; cached sockets refuse sends
//     after identity/model, plugin activation, or proxy-origin changes instead
//     of reusing stale upgrade metadata (#5840). A lane without those hooks sees
//     byte-identical verbatim forwarding;
//   * leaves everything else alone: non-model WS (devtools, socket.io, …),
//     already-/bili/-routed URLs, control-plane paths, other protocols.
//
// Scope is openai-codex-responses only. The Bedrock provider's
// bedrock-converse-stream socket carries no custom headers at all and matches
// no codec — it stays direct and is tracked separately (#2111 scope note).
//
// Startup race: the proxy origin lands asynchronously (bootstrap/attach), but
// the WebSocket constructor is synchronous and starts connecting immediately.
// When the origin is not yet known, the wrapper returns a deferred shell that
// mirrors the WebSocket API and defers the real connection until readyOrigin
// settles — the same bounded wait the fetch lane applies per request. A
// permanently absent proxy degrades the connection DIRECT (warned once),
// matching the fetch lane's give-up semantics. Explicit `sse` remains the
// documented escape hatch either way.

import { ACTIVE_STATE, ACTIVE_STATE_SEQ, bindLiveStateSlot, noteRoutedOrigin, readyOrigin, withTimeout, type GateVerdict, type NativeInterceptState } from "./native-intercept.js";
import { logHostEvent } from "./host-log.js";

// @types/node exposes Event/EventTarget globally but keeps the web-platform
// listener callback types module-scoped (web-globals/events.d.ts) — mirror the
// DOM shapes locally instead of reaching into the module namespace.
type EventListener = (event: Event) => void;
interface EventListenerObject {
    handleEvent(event: Event): void;
}
type WsEventTargetOptions = { capture?: boolean; once?: boolean; passive?: boolean; signal?: AbortSignal } | boolean;

const WS_INTERCEPT_FLAG = Symbol.for("billion-context.native-ws-intercept");
const OWN_MARKER = Symbol.for("billion-context.native-ws-intercept.own");

// Adoption logging cap — bounds LOGGING only, not authority (mirrors the
// fetch lane's REARM_LIMIT discipline, #1158/#1410).
const ADOPT_LOG_LIMIT = 16;

/** Structural client-side WebSocket surface (no DOM lib in this project; the
 *  runtime global is undici/Bun's WHATWG WebSocket). */
interface WsInstanceLike {
    readonly url: string;
    readonly readyState: number;
    readonly bufferedAmount: number;
    readonly protocol: string;
    readonly extensions: string;
    binaryType: string;
    onopen: EventListener | null;
    onerror: EventListener | null;
    onclose: EventListener | null;
    onmessage: EventListener | null;
    addEventListener(type: string, listener: EventListener | EventListenerObject | null, options?: WsEventTargetOptions): void;
    removeEventListener(type: string, listener: EventListener | EventListenerObject | null, options?: WsEventTargetOptions): void;
    dispatchEvent(event: Event): boolean;
    send(data: unknown): void;
    close(code?: number, reason?: string): void;
}

type WsCtor = new (url: string | URL, ...rest: unknown[]) => WsInstanceLike;

// #5838: the deferred window's full verdict — where to connect AND with which
// constructor arguments. The per-dispatch prep merges stamped headers onto
// the init, so the rest array is part of the decision, not just the URL; an
// absent field falls back to the originally requested shape (direct send).
type WsConnectionPrep = { url?: string; rest?: unknown[] };

type GlobalRecord = Record<PropertyKey, unknown>;

const CONNECTING = 0;
const CLOSING = 2;
const CLOSED = 3;

/** Claim predicate for the Codex Responses WS shape. Returns the scheme-
 *  normalized http(s) upstream URL when this connection should be routed,
 *  else undefined (passthrough). Mirrors isModelApiUrl's exclusions
 *  (/__bili/, /__acp/, first-path-segment bili) but deliberately NARROWER than
 *  MODEL_API_SUFFIX: only the /responses endpoint has a WS codec — claiming
 *  messages/chat/completions/conversations would rewrite URLs that 426. */
export function codexResponsesWsTarget(url: string | URL): string | undefined {
    const raw = typeof url === "string" ? url : url instanceof URL ? url.href : String(url);
    if (!/^wss?:\/\//i.test(raw)) return undefined;
    const httpUrl = raw.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
    if (/__bili\//.test(httpUrl) || /__acp\//.test(httpUrl)) return undefined;
    let parsed: URL;
    try {
        parsed = new URL(httpUrl);
    } catch {
        return undefined;
    }
    const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
    if (segments[0] === "bili") return undefined;
    if (!/(^|\/)responses\/?$/.test(parsed.pathname)) return undefined;
    return httpUrl;
}

/** Bound a pending inline wsOrigin like readyOrigin bounds a bootstrap: a
 *  wedged bridge boot settles undefined (→ DIRECT degrade) instead of
 *  pinning a DeferredWebSocket in CONNECTING forever. */
function raceWsOriginBound(pending: Promise<string | undefined>): Promise<string | undefined> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(undefined), 20_000);
        pending.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(undefined);
            },
        );
    });
}

/** `<origin>` + `/bili/` + the normalized http(s) upstream — the proxy-connect
 *  side uses ws(s):, the embedded upstream keeps http(s): (codec contract). */
export function rewriteCodexResponsesWsUrl(target: string, origin: string): string {
    const proxyWs = origin.replace(/^http/i, "ws").replace(/\/+$/, "");
    return `${proxyWs}/bili/${target}`;
}

function prepareWsFrames(socket: WsInstanceLike, target: string, state: NativeInterceptState, identity: Record<string, string> | undefined, origin: NativeInterceptState["wsOrigin"], generation: unknown): WsInstanceLike {
    const assertCurrent = (): void => {
        if ((globalThis as GlobalRecord)[ACTIVE_STATE] !== state || (globalThis as GlobalRecord)[ACTIVE_STATE_SEQ] !== generation || (state.wsOrigin ?? state.origin) !== origin) {
            throw new Error("bili-native(ws): plugin state/origin changed; reconnect before sending");
        }
    };
    const send = socket.send.bind(socket);
    let pending = Promise.resolve();
    let failed = false;
    socket.send = (data: unknown): void => {
        if (socket.readyState !== 1) return send(data);
        let frame: unknown;
        if (typeof data === "string") {
            try { frame = JSON.parse(data); } catch { /* Preserve malformed/control frames. */ }
        }
        const isCreate = frame !== null && typeof frame === "object" && (frame as { type?: unknown }).type === "response.create";
        // Register each continuation in the SENDER's ALS scope, not the upgrade's.
        pending = pending.then(async () => {
            if (failed || socket.readyState !== 1) return;
            assertCurrent();
            if (!isCreate || typeof data !== "string") return send(data);
            if (state.toolsReady !== undefined) await withTimeout(state.toolsReady, state.readyTimeoutMs ?? 15_000);
            assertCurrent();
            const init: RequestInit = { body: data, headers: identity === undefined ? undefined : { ...identity } };
            const verdict = await state.takeoverGate?.(target, { bytes: Buffer.byteLength(data) }, init);
            if (verdict !== undefined && verdict !== true) throw new Error("bili-native(ws): request attribution refused on a reused connection");
            assertCurrent();
            await state.beforeSend?.(target, init);
            assertCurrent();
            const currentHeaders = state.headersFor?.(target);
            const current = Object.fromEntries(new Headers(currentHeaders));
            const prepared = Object.fromEntries(new Headers(init.headers));
            const keys = new Set([...Object.keys(identity ?? {}), ...Object.keys(current), ...Object.keys(prepared)]);
            if ([...keys].some(key => identity?.[key] !== current[key] || identity?.[key] !== prepared[key])) {
                throw new Error("bili-native(ws): request identity/model changed; reconnect before sending");
            }
            send(init.body ?? data);
        }).catch((error: unknown) => {
            if (failed) return;
            failed = true;
            const event = new Event("error");
            Object.assign(event, { error });
            socket.dispatchEvent(event);
            // WHATWG clients allow only 1000 or application codes 3000–4999.
            try {
                socket.close(4008, "bili request preparation refused");
            } catch (closeError) {
                logHostEvent("error", "[native-client]", `bili-native(ws): refusal close failed (${closeError instanceof Error ? closeError.message : String(closeError)})`);
                try { socket.close(); } catch { /* Best effort after withholding the frame. */ }
            }
        });
    };
    return socket;
}

/** Deferred-connection shell: stands in for the real WebSocket while the
 *  proxy origin is still settling. Listeners/on*-handlers/binaryType recorded
 *  during the window are replayed onto the real instance at attach; accessors
 *  delegate afterwards. send() before attach throws exactly like a real
 *  not-yet-open socket; close() during the window cancels the connection
 *  (native undici aborts without guaranteeing a 'close' event — probed on
 *  v22.23.2 — so a deterministic abnormal-close frame is emitted instead to
 *  unblock client cleanup). */
class DeferredWebSocket {
    private real: WsInstanceLike | undefined;
    private cancelled = false;
    private closed = false;
    private settled = false;
    private listeners = new Map<string, Array<{ el: EventListener | EventListenerObject; once: boolean }>>();
    private handlers: Partial<Record<"onopen" | "onerror" | "onclose" | "onmessage", EventListener | null>> = {};
    private binaryTypeOverride: string | undefined;

    constructor(
        private readonly requestedUrl: string,
        rest: unknown[],
        private readonly resolvePrep: () => Promise<WsConnectionPrep | undefined>,
        private readonly construct: (finalUrl: string, rest: unknown[]) => WsInstanceLike,
    ) {
        void this.settle(rest);
    }

    private async settle(rest: unknown[]): Promise<void> {
        if (this.settled) return;
        this.settled = true;
        try {
            const prep = await this.resolvePrep();
            // Re-check AFTER the await: a close() may have landed mid-window.
            if (this.cancelled || this.real !== undefined) return;
            this.attach(this.construct(prep?.url ?? this.requestedUrl, prep?.rest ?? rest));
        } catch (error) {
            if (this.cancelled) return;
            this.closed = true;
            // Stale preparation must not silently construct a direct socket.
            // Surface a socket error +
            // abnormal close so client cleanup proceeds, instead of letting the
            // rejected promise become an unhandledRejection in the host process.
            const errEvent = new Event("error");
            Object.assign(errEvent, { error });
            this.dispatchEvent(errEvent);
            const closeEvent = new Event("close");
            Object.assign(closeEvent, { code: 1006, reason: "", wasClean: false });
            this.dispatchEvent(closeEvent);
        }
    }

    private attach(real: WsInstanceLike): void {
        if (this.real !== undefined) return;
        this.real = real;
        for (const [type, entries] of this.listeners) {
            for (const entry of entries) real.addEventListener(type, entry.el, { once: entry.once });
        }
        for (const key of ["onopen", "onerror", "onclose", "onmessage"] as const) {
            const handler = this.handlers[key];
            if (handler !== undefined) real[key] = handler;
        }
        if (this.binaryTypeOverride !== undefined) real.binaryType = this.binaryTypeOverride;
    }

    addEventListener(type: string, listener: EventListener | EventListenerObject | null, options?: WsEventTargetOptions): void {
        if (this.real !== undefined) {
            this.real.addEventListener(type, listener, options);
            return;
        }
        if (listener === null) return;
        const once = typeof options === "object" && options !== null ? options.once === true : options === true;
        const list = this.listeners.get(type) ?? [];
        list.push({ el: listener, once });
        this.listeners.set(type, list);
    }

    removeEventListener(type: string, listener: EventListener | EventListenerObject | null, _options?: WsEventTargetOptions): void {
        if (this.real !== undefined) {
            this.real.removeEventListener(type, listener, _options);
            return;
        }
        if (listener === null) return;
        const list = this.listeners.get(type);
        if (list !== undefined) {
            const at = list.findIndex((entry) => entry.el === listener);
            if (at >= 0) list.splice(at, 1);
            if (list.length === 0) this.listeners.delete(type);
        }
    }

    dispatchEvent(event: Event): boolean {
        if (this.real !== undefined) return this.real.dispatchEvent(event);
        for (const entry of [...(this.listeners.get(event.type) ?? [])]) {
            if (typeof entry.el === "function") entry.el.call(this, event);
            else entry.el.handleEvent(event);
            if (entry.once) this.removeEventListener(event.type, entry.el);
        }
        // A real EventTarget fires the on* handler property alongside listeners —
        // a client registered via ws.onclose = fn must not miss a window-phase
        // close frame.
        const handler = this.handlers[(`on${event.type}`) as "onopen" | "onerror" | "onclose" | "onmessage"];
        if (typeof handler === "function") handler.call(this, event);
        return !event.defaultPrevented;
    }

    send(data: unknown): void {
        if (this.real !== undefined) {
            this.real.send(data);
            return;
        }
        throw new DOMException("Sent message before the connection was opened.", "InvalidStateError");
    }

    close(code?: number, reason?: string): void {
        if (this.real !== undefined) {
            this.real.close(code, reason);
            return;
        }
        if (this.cancelled || this.closed) return;
        this.cancelled = true;
        queueMicrotask(() => {
            const event = new Event("close");
            Object.assign(event, { code: 1006, reason: "", wasClean: false });
            this.dispatchEvent(event);
        });
    }

    get readyState(): number {
        return this.real?.readyState ?? (this.closed ? CLOSED : this.cancelled ? CLOSING : CONNECTING);
    }

    get url(): string {
        return this.real?.url ?? this.requestedUrl;
    }

    get bufferedAmount(): number {
        return this.real?.bufferedAmount ?? 0;
    }

    get protocol(): string {
        return this.real?.protocol ?? "";
    }

    get extensions(): string {
        return this.real?.extensions ?? "";
    }

    get binaryType(): string {
        return this.real?.binaryType ?? this.binaryTypeOverride ?? "blob";
    }

    set binaryType(value: string) {
        if (this.real !== undefined) this.real.binaryType = value;
        else this.binaryTypeOverride = value;
    }

    get onopen(): EventListener | null {
        return this.real?.onopen ?? this.handlers["onopen"] ?? null;
    }

    set onopen(handler: EventListener | null) {
        if (this.real !== undefined) this.real.onopen = handler;
        else this.handlers["onopen"] = handler;
    }

    get onerror(): EventListener | null {
        return this.real?.onerror ?? this.handlers["onerror"] ?? null;
    }

    set onerror(handler: EventListener | null) {
        if (this.real !== undefined) this.real.onerror = handler;
        else this.handlers["onerror"] = handler;
    }

    get onclose(): EventListener | null {
        return this.real?.onclose ?? this.handlers["onclose"] ?? null;
    }

    set onclose(handler: EventListener | null) {
        if (this.real !== undefined) this.real.onclose = handler;
        else this.handlers["onclose"] = handler;
    }

    get onmessage(): EventListener | null {
        return this.real?.onmessage ?? this.handlers["onmessage"] ?? null;
    }

    set onmessage(handler: EventListener | null) {
        if (this.real !== undefined) this.real.onmessage = handler;
        else this.handlers["onmessage"] = handler;
    }
}

function isOwn(value: unknown): boolean {
    return typeof value === "function" && (value as unknown as Record<symbol, unknown>)[OWN_MARKER] === true;
}

/** True when this process installed the native WebSocket intercept. */
export function nativeWebSocketInterceptInstalled(): boolean {
    return (globalThis as GlobalRecord)[WS_INTERCEPT_FLAG] === true;
}

let preInstallDesc: PropertyDescriptor | undefined;
let ourGet: (() => unknown) | undefined;

// #5838: the constructor's second argument when it IS an init object (undici's
// {headers, protocols, ...} form) — the SAME reference flows through gate →
// beforeSend → header merge so a hook that rebuilds init.headers (#4082's
// negotiated-stamp path) lands on the very upgrade request it claimed.
function wsInitLike(arg: unknown): RequestInit | undefined {
    return arg !== null && typeof arg === "object" && !Array.isArray(arg) ? (arg as RequestInit) : undefined;
}

// #5838: rebuild the constructor's rest array with a replaced second argument
// only when the merge actually produced a new value (host object identity is
// preserved otherwise — the same byte-identity the fast path has always held).
function restWithInit(rest: unknown[], replacedFirst: unknown): unknown[] {
    if (Object.is(replacedFirst, rest[0])) return rest;
    const next = [...rest];
    next[0] = replacedFirst;
    return next;
}

// #5838: merge bili-stamped headers onto the constructor argument without ever
// mutating the host's object (rebuild, #3370 discipline). Stamps WIN on name
// conflict — the same precedence withHeaders gives the fetch lane's stamps.
// Subprotocol string/array forms are wrapped into the object form undici
// accepts for BOTH fields (verified on Node ≥22: sec-websocket-protocol and
// custom headers ride the same upgrade). Unrecognized shapes pass through
// untouched — a stamp that cannot be expressed safely is dropped, never a
// connection broken.
function mergeWsInitHeaders(arg: unknown, extra: Record<string, string> | undefined): unknown {
    if (extra === undefined || Object.keys(extra).length === 0) return arg;
    if (arg === undefined || arg === null) return { headers: { ...extra } };
    if (typeof arg === "string" || Array.isArray(arg)) return { protocols: arg, headers: { ...extra } };
    if (typeof arg === "object") {
        const init = { ...(arg as Record<string, unknown>) };
        const h = init.headers;
        if (h === undefined || h === null) {
            init.headers = { ...extra };
        } else if (h instanceof Headers) {
            const merged = new Headers(h);
            for (const [k, v] of Object.entries(extra)) merged.set(k, v);
            init.headers = merged;
        } else if (Array.isArray(h)) {
            init.headers = [...h, ...Object.entries(extra)];
        } else if (typeof h === "object") {
            init.headers = { ...(h as Record<string, string>), ...extra };
        } else {
            return arg;
        }
        return init;
    }
    return arg;
}

/** Install the globalThis.WebSocket wrapper for one native host process.
 *  Idempotent (Symbol.for flag — repeated extension loads are no-ops) and
 *  lifecycle-bound to the same guard as installNativeFetchIntercept: off mode
 *  patches nothing. Third-party replacements are ADOPTED as the downstream
 *  constructor (authority is kept, like the fetch lane) instead of silently
 *  evicting routing; non-constructor values are refused with a warning. Every
 *  activation rebinds the SHARED live-state slot (#3558), so the wrapper's
 *  per-connection read follows the newest applied module instance across a hot
 *  reimport — mirroring the fetch lane exactly. */
export function installNativeWebSocketIntercept(initialState: NativeInterceptState): boolean {
    // #3558: rebind the shared live-state slot on EVERY activation (the same
    // slot the fetch chain reads), then resolve it per connection below — so a
    // hot-reimport that swaps in a fresh state takes over WS routing without a
    // restart, instead of the once-per-process wrapper staying closed over the
    // first instance's dead state.
    const hadChain = nativeWebSocketInterceptInstalled();
    const firstBind = bindLiveStateSlot(initialState);
    if (hadChain) {
        // A wrapper from an EARLIER build already wraps globalThis.WebSocket and
        // cannot be rewritten to read this slot — until the host restarts, Codex
        // Responses traffic routes through that old closure. Say so once.
        if (firstBind) logHostEvent("warn", "[native-client]", "native WebSocket chain predates live-state routing; restart the host once for Codex Responses traffic to follow this plugin instance (#3558)");
        return false;
    }
    const initial = (globalThis as GlobalRecord).WebSocket;
    if (typeof initial !== "function") return false;

    let currentBase: unknown = initial;
    const observed: unknown[] = [];
    let adoptCount = 0;
    let warnedDirect = false;
    let warnedFallback = false;
    const ref: { current: unknown } = { current: undefined };

    /** Construct through the best live constructor: current base first, the
     *  module-load anchor as fallback (a broken adopted stub must not brick
     *  every subsequent connection). */
    const constructLive = (finalUrl: string, rest: unknown[]): WsInstanceLike => {
        const candidates: unknown[] = [currentBase];
        if (!Object.is(currentBase, initial)) candidates.push(initial);
        let lastErr: unknown;
        for (const candidate of candidates) {
            if (typeof candidate !== "function") continue;
            try {
                return new (candidate as WsCtor)(finalUrl, ...rest);
            } catch (err) {
                lastErr = err;
                if (err instanceof TypeError && !warnedFallback) {
                    warnedFallback = true;
                    logHostEvent("warn", "[native-client]", `bili-native(ws): active WebSocket constructor threw (${err.message}) — falling back to the load-time anchor`);
                }
            }
        }
        throw lastErr instanceof Error ? lastErr : new Error("No usable WebSocket constructor available");
    };

    const buildTop = (base: unknown): unknown => {
        const Base = base as WsCtor;
        class RoutedWebSocket extends Base {}
        function routed(this: unknown, url: string | URL, ...rest: unknown[]): unknown {
            const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : String(url);
            const target = codexResponsesWsTarget(urlStr);
            // #3558: resolve the ACTIVE state per connection (mirrors the fetch
            // lane's per-request read, #3394) instead of the install-time closure —
            // a hot-reimport swapped in a fresh instance. Empty slot = no active
            // plugin → pass through direct, never hit a disposed context.
            const state = (globalThis as GlobalRecord)[ACTIVE_STATE] as NativeInterceptState | undefined;
            if (target === undefined || state === undefined) return new RoutedWebSocket(url, ...rest);
            // #5838: lanes arming the per-dispatch prep hooks (dsh: async
            // takeover verdict, tools-ready gate, fork-adoption beforeSend,
            // headersFor stamps) run them INSIDE the deferred window before the
            // upgrade goes out — an un-awaited gate verdict or a socket opened
            // ahead of registration would ride wire mode for its whole life
            // (#1268 shape). Hook-less lanes (pi stamps via its own extension
            // event) keep today's exact sync paths below.
            const hooksArmed = state.takeoverGate !== undefined || state.toolsReady !== undefined || state.headersFor !== undefined || state.beforeSend !== undefined;
            const initLike = wsInitLike(rest[0]);
            let origin = state.wsOrigin ?? state.origin;
            let originSettled = false;
            const generation = (globalThis as GlobalRecord)[ACTIVE_STATE_SEQ];
            const assertCurrent = (): void => {
                if (!hooksArmed) return;
                if ((globalThis as GlobalRecord)[ACTIVE_STATE] !== state || (globalThis as GlobalRecord)[ACTIVE_STATE_SEQ] !== generation || ((origin !== undefined || originSettled) && (state.wsOrigin ?? state.origin) !== origin)) {
                    throw new Error("bili-native(ws): plugin activation changed during connection preparation");
                }
            };
            if (!hooksArmed && typeof origin === "string") {
                const rewritten = rewriteCodexResponsesWsUrl(target, origin);
                // Record the HTTP-shaped origin — the fetch lane records http origins and the
                // attach-lane comparisons (observeRoutedOrigin / verifyAttachAndRecover) match
                // against them; a "ws://" origin would never equal one of them (#2111).
                noteRoutedOrigin(state, rewritten.replace(/^ws/i, "http"));
                state.onDispatch?.(rewritten, "rewrite");
                return new RoutedWebSocket(rewritten, ...rest);
            }
            // Origin settling OR hooks armed → defer the real connection (bounded
            // by readyOrigin's timeout, same hold the fetch lane applies). A
            // pending wsOrigin (inline bridge booting) rides the same shell:
            // settle undefined → DIRECT degrade below.
            let identity: Record<string, string> | undefined;
            let routed = false;
            return new DeferredWebSocket(
                urlStr,
                rest,
                async () => {
                    assertCurrent();
                    if (hooksArmed) {
                        if (state.takeoverGate !== undefined) {
                            let verdict: GateVerdict;
                            try {
                                verdict = await state.takeoverGate(target, undefined, initLike);
                            } catch (err) {
                                assertCurrent();
                                logHostEvent("error", "[native-client]", `bili-native(ws): takeover gate threw (${err instanceof Error ? err.message : String(err)}) — Codex Responses WebSocket goes DIRECT: ${urlStr}`);
                                state.onDispatch?.(target, "refused");
                                return undefined;
                            }
                            assertCurrent();
                            if (verdict !== true) {
                                state.onDispatch?.(target, "refused");
                                return undefined;
                            }
                        }
                        if (state.toolsReady !== undefined) await withTimeout(state.toolsReady, state.readyTimeoutMs ?? 15_000);
                    }
                    // A pending wsOrigin is the inline bridge booting; bound it
                    // like readyOrigin bounds a bootstrap (20s) so a wedged
                    // cold start cannot hold the construction in CONNECTING
                    // forever — it degrades DIRECT below instead.
                    const settled = state.wsOrigin instanceof Promise ? await raceWsOriginBound(state.wsOrigin) : await readyOrigin(state);
                    if (hooksArmed && origin === undefined) {
                        const current = state.wsOrigin ?? state.origin;
                        if (current !== undefined && current !== settled) throw new Error("bili-native(ws): proxy origin changed during bootstrap");
                        origin = current;
                    }
                    originSettled = true;
                    assertCurrent();
                    if (settled === undefined) {
                        if (!warnedDirect) {
                            warnedDirect = true;
                            logHostEvent("error", "[native-client]", `bili-native(ws): proxy bootstrap did not settle — Codex Responses WebSocket goes DIRECT (uncompressed): ${urlStr}`);
                        }
                        state.onDispatch?.(target, "direct");
                        return undefined;
                    }
                    if (hooksArmed && state.beforeSend !== undefined) {
                        try {
                            await state.beforeSend(target, initLike);
                        } catch (err) {
                            logHostEvent("error", "[native-client]", `bili-native(ws): beforeSend hook failed (${err instanceof Error ? err.message : String(err)}) — connection continues (#2399)`);
                        }
                    }
                    assertCurrent();
                    const rewritten = rewriteCodexResponsesWsUrl(target, settled);
                    noteRoutedOrigin(state, rewritten.replace(/^ws/i, "http"));
                    state.onDispatch?.(rewritten, "rewrite");
                    const stamps = hooksArmed ? state.headersFor?.(target) : undefined;
                    identity = stamps === undefined ? undefined : Object.fromEntries(new Headers(stamps));
                    routed = true;
                    // Keep #5839's constructor/subprotocol handling unchanged.
                    const mergedRest = hooksArmed ? restWithInit(rest, mergeWsInitHeaders(rest[0], stamps)) : rest;
                    return mergedRest === rest ? { url: rewritten } : { url: rewritten, rest: mergedRest };
                },
                (finalUrl, args) => {
                    assertCurrent();
                    const socket = constructLive(finalUrl, args);
                    return hooksArmed && routed ? prepareWsFrames(socket, target, state, identity, origin, generation) : socket;
                },
            );
        }
        for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
            const value = (Base as unknown as Record<string, unknown>)[key];
            if (value !== undefined) Object.defineProperty(routed, key, { value, writable: true, enumerable: false, configurable: true });
        }
        Object.setPrototypeOf(routed, Base);
        routed.prototype = Base.prototype;
        Object.defineProperty(routed, "name", { value: "WebSocket", writable: false, configurable: true });
        (routed as unknown as Record<symbol, unknown>)[OWN_MARKER] = true;
        return routed;
    };

    ref.current = buildTop(initial);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    if (descriptor === undefined) return false;
    preInstallDesc = descriptor;
    if (descriptor.configurable) {
        const getFn = (): unknown => ref.current;
        ourGet = getFn;
        Object.defineProperty(globalThis, "WebSocket", {
            configurable: true,
            enumerable: descriptor.enumerable ?? true,
            get: getFn,
            set: (value: unknown) => {
                if (value === ref.current || isOwn(value)) return;
                if (typeof value !== "function") {
                    if (adoptCount < ADOPT_LOG_LIMIT) {
                        logHostEvent("error", "[native-client]", `bili-native(ws): globalThis.WebSocket replaced with a non-constructor (${String(value)}) — keeping the previous constructor until a valid one is restored`);
                    }
                    return;
                }
                adoptCount++;
                if (adoptCount <= ADOPT_LOG_LIMIT) {
                    logHostEvent("warn", "[native-client]", `bili-native(ws): adopting third-party globalThis.WebSocket as the downstream constructor`);
                }
                observed.push(value);
                currentBase = value;
                ref.current = buildTop(value);
            },
        });
    } else if (descriptor.writable === true) {
        (globalThis as GlobalRecord).WebSocket = ref.current;
    } else {
        preInstallDesc = undefined;
        return false;
    }
    (globalThis as GlobalRecord)[WS_INTERCEPT_FLAG] = true;
    return true;
}

/** Test hook: restore the pre-install globalThis.WebSocket (identity-compared
 *  accessor, mirroring the fetch lane's #1410 discipline), clear the flag, and
 *  drop the shared live-state slot (#3558) so a suite that installed only the WS
 *  wrapper leaves no stale active state for a later suite. */
export function _resetForTest(): void {
    if (preInstallDesc !== undefined && ourGet !== undefined) {
        const d = preInstallDesc;
        const g = ourGet;
        preInstallDesc = undefined;
        ourGet = undefined;
        const cur = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
        if (cur !== undefined && typeof cur.get === "function" && cur.get === g) {
            Object.defineProperty(globalThis, "WebSocket", { ...d, configurable: true });
        }
    }
    delete (globalThis as GlobalRecord)[WS_INTERCEPT_FLAG];
    delete (globalThis as GlobalRecord)[ACTIVE_STATE];
    delete (globalThis as GlobalRecord)[ACTIVE_STATE_SEQ];
}
