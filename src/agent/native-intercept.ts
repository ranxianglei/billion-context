// Native-mode fetch interception (#519): a globalThis.fetch patch that
// silently routes model-API requests through a bili proxy that the extension
// itself spawned (see pi-native.ts). Verified end-to-end on pi 0.83.6: pi's
// provider stack (pi-stable-ai → Anthropic/OpenAI SDKs) resolves its fetch
// from the global at FIRST-request client construction, so a patch installed
// at extension load always wins. The patch is surgical — it rewrites ONLY
// model-API shaped URLs and leaves every other request untouched.

import { installFetchChain, isDeadClosureError, resetFetchChainForTest } from "./fetch-chain/index.js";
import { logHostEvent } from "./host-log.js";

import { envMillis } from "./native-bootstrap.js";
import { probeLiveness, type LivenessVerdict } from "../liveness.js";
import { BILI_PASSTHROUGH_HEADER } from "../util.js";
import { DSH_COMPACTION_MARKER_SNIFF } from "../server/dsh-compaction-guard.js";
import { APIG_RESIGN_HEADER, APIG_RESIGN_CREDENTIAL_HEADER, APIG_RESIGN_SCHEME, clearSignedRefusal, encodeApigCredential, inboundSignedScheme, recordSignedRefusal, resignEnabled, resignPassthroughEnabled, signedRefusal } from "../apig-resign.js";

/** #2924: takeover-gate verdict. `true` claims the request; `false` keeps the
 *  host's #1117 semantics (raw URL → direct, routed URL → passthrough);
 *  `"refuse-oversized"` asks the transport to fail this ONE request locally
 *  (protocol-shaped 422, the #2709 precedent) because forwarding it
 *  uncompressed cannot succeed — the body provably exceeds the model's
 *  context window. */
export type GateVerdict = boolean | "refuse-oversized" | "refuse-oversized-unattributed";

/** #3304: prepareDirectSend's verdict for one fall-back send to the real
 *  upstream (see the state field). */
export type DirectSendPrep =
    | { outcome: "as-is" }
    | { outcome: "restored"; body: string }
    | { outcome: "unrestorable" };

/** #3654: why createLiveOriginResolver found nothing to route to — the
 *  refusal wording must tell a live-but-saturated proxy (the busy wait window
 *  exhausted) apart from a dead one or a failed bootstrap. #4125:
 *  "send-failed" marks the send-failure recovery paths (the held origin
 *  answered its probe but the send threw, and recover() produced no
 *  replacement) so a give-up line can name that branch too. */
export type UnavailableReason = "busy-exhausted" | "dead" | "bootstrap-failed" | "send-failed";

export interface NativeInterceptState {
    /** Proxy origin ("http://127.0.0.1:PORT") once the bootstrap resolved.
     *  Written by the owner (pi-native.ts); read synchronously on each call. */
    origin: string | undefined;
    /** Origin the WS wrapper should rewrite codex Responses URLs to, when it
     *  differs from `origin`. Inline mode (#3278 follow-up): `origin` is the
     *  never-dialable pseudo-origin, so the WS lane needs the loopback bridge
     *  (inline-ws.ts) instead. Holds the bridge origin, a Promise settling to
     *  it (bridge still booting; construction defers, bounded, then degrades
     *  DIRECT if it settles undefined), or undefined (use `origin`). */
    wsOrigin?: string | Promise<string | undefined>;
    /** Resolves to the proxy origin once healthy, or undefined on failure. */
    ready: Promise<string | undefined>;
    /** Owner hook: re-run the bootstrap (proxy died → respawn). */
    respawn?: () => Promise<string | undefined>;
    /** Owner hook: fired once when a respawn attempt fails and the session
     *  degrades to direct sends for good — clear proxy-owned state (e.g. the
     *  BILLION_CONTEXT_PROXY env) so event-time ownership checks disarm with
     *  the traffic. */
    onGiveUp?: () => void;
    /** #3654: set before createLiveOriginResolver returns undefined — why
     *  nothing was routable (see UnavailableReason: "busy-exhausted" | "dead"
     *  | "bootstrap-failed", plus #4125's "send-failed" set by the send-failure
     *  recovery paths just before they fire onGiveUp); cleared on the next
     *  successful resolution. The refusal builder reads it to keep a
     *  live-but-saturated proxy out of "proxy unavailable" wording; the dsh
     *  give-up seam appends it to the client event line (#4125). */
    lastUnavailableReason?: UnavailableReason;
    /** Attach mode (#809): route through a user-supplied external proxy at
     *  state.origin instead of a spawned one. Set by the host entry when a
     *  BILLION_CONTEXT_ATTACH / launcher-preset BILLION_CONTEXT_PROXY is
     *  present. Rewrites model URLs to the attach origin exactly like spawn
     *  mode (opencode V1's fetch patch and #809's probe+rewrite semantics
     *  depend on it); already-routed `/bili/` URLs still pass through except
     *  for headersFor stamping. The attached proxy is often owned by ANOTHER
     *  launcher that can exit mid-session (#1130) — hosts arm state.respawn
     *  so an observed death triggers the same runtime recovery as spawn
     *  mode; without respawn, an observed death degrades to direct sends
     *  instead of failing every request forever. */
    attach?: boolean;
    /** Optional header hook (#941): called synchronously per model-API
     *  request with the (pre-rewrite) target URL. A non-undefined return is
     *  merged into the outgoing request headers — dsh-native uses it to
     *  stamp x-bili-plugin* once its tools are registered, gating plugin
     *  mode exactly like pi.ts's before_provider_headers stamp. Returning
     *  undefined sends the request untouched (wire mode). */
    headersFor?: (url: string) => Record<string, string> | undefined;
    /** #2399: async pre-send hook — awaited (defensively; a hook error never
     *  breaks the request) per attributed model-API request after the tools
     *  gate clears and BEFORE headersFor is consulted. dsh-native uses it to
     *  adopt a fork child's parent state via the plugin fork protocol before
     *  the child's first replayed request lands. Unlike headersFor it sees
     *  the request init (body) and may spend async time; wire-mode requests
     *  (headersFor returns nothing) still pass through it — the hook itself
     *  gates on its own conditions. */
     beforeSend?: (url: string, init: RequestInit | undefined) => Promise<void>;
    /** #3304: consulted immediately before ANY fall-back send to the REAL
     *  upstream (proxy-death give-up, bootstrap-fail, unattributed direct,
     *  signed passthrough). Lanes that mutate the outgoing payload (the
     *  incremental-turn adapters) arm it; every other lane leaves it
     *  undefined and each fall-back behaves byte-identically to pre-#3304.
     *  The hook sees the SAME (input, init) pair the fall-back would send
     *  (headers/body already mutated by the lane's own swap) and answers:
     *  - "as-is"        — the payload is a standalone request → send it;
     *  - "restored"     — send `body` INSTEAD (the pre-mutation original);
     *  - "unrestorable" — the payload was mutated and cannot be undone →
     *                     the direct send is refused locally (TypeError) so
     *                     a lane-only body never reaches a provider that
     *                     cannot parse it; the host's retry re-runs the full
     *                     decision (re-probe, re-plan) from scratch. */
    prepareDirectSend?: (url: string, input: string | URL | Request, init: RequestInit | undefined) => DirectSendPrep | Promise<DirectSendPrep>;
    /** #3248 incremental turns: response hook — fired with the routed
     *  Response BEFORE it is returned to the host, so response headers are
     *  readable without consuming the stream. Native hosts use it to read
     *  x-bili-applied-seq (the ack channel). Always fires with the
     *  HOST-REQUESTED url (the fetch argument) — never a rerouted or retried
     *  target. #3329: the optional third argument carries THIS DISPATCH'S
     *  outgoing headers (lowercase-name record; init.headers wins over a
     *  Request-object input's own headers, exactly as fetch itself resolves
     *  them) — consumers correlate a response back to THE REQUEST that
     *  produced it via their per-request correlation id stamped on send,
     *  because several conversations share one provider URL and keying by
     *  url alone mis-attributes a late response to whichever conversation
     *  happened to plan last on that URL. Undefined for a dispatch with no
     *  readable headers. Best-effort: never throws into the request path. */
    onResponse?: (url: string, response: Response, headers?: Record<string, string>) => void;
    /** #1117: attribution gate — called per model-API request with the
     *  (pre-rewrite) target URL. Returning false means the caller is NOT the
     *  host itself (e.g. a third-party in-process plugin riding the host's
     *  LLM bridge, whose model calls hit the same URLs): the request is NOT
     *  claimed — raw URLs send direct, already-routed `/bili/` URLs are
     *  stamped with the passthrough marker instead. Undefined (hosts without
     *  an attribution signal) keeps URL-shape claiming for every caller.
     *  #2924: the verdict may be a Promise (dsh-native's `threw` path retries
     *  attribution before deciding) and may be `"refuse-oversized"` — a local,
     *  recoverable refusal for a body that provably cannot fit the model's
     *  window; the fetch lane answers it with a protocol-shaped 422 instead
     *  of an upstream 400. The optional body size lets the gate make that
     *  call without re-reading the request. */
    takeoverGate?: (url: string, body?: { bytes: number }, init?: RequestInit) => GateVerdict | Promise<GateVerdict>;
    /** How long a pre-ready model request waits for the bootstrap before
     *  falling back to a direct (uncompressed) send. */
    readyTimeoutMs?: number;
    /** Owner hook (#1268): resolves when the host-side ACP tool registration
     *  has finished its FIRST attempt (success OR failure). Model-API requests
     *  await it (bounded by readyTimeoutMs) before headersFor is consulted, so
     *  the first request of a fresh session is stamped into plugin mode instead
     *  of silently riding wire mode because registration lost the boot race
     *  (observed live: dsh fires R1 ~90ms before the manifest lands). Undefined
     *  (every lane that does not arm one) = no wait, behavior unchanged. */
    toolsReady?: Promise<unknown>;
    /** #1365: origin baked into already-routed `/bili/` model URLs observed
     *  by this process (sticky; last observation wins). Routed URLs are
     *  STATICALLY pinned to that origin — a spawned replacement can never
     *  carry them — so attach lanes treat this as evidence their model
     *  channel cannot follow a new instance: wait for the pinned target /
     *  fail loudly instead of spawning a second proxy (split brain). */
    routedOrigin?: string;
    /** #1365 owner hook: fired when routed model traffic is observed at an
     *  origin different from the one previously noted (late evidence — e.g.
     *  the first routed request landing after the attach decision already
     *  settled elsewhere). The owner binds its tool surface to the observed
     *  origin when healthy, or the session splits across two instances. */
    onRoutedOriginObserved?: (origin: string) => void;
    /** Test/observability hook: every dispatched decision. */
    onDispatch?: (url: string, action: "rewrite" | "direct" | "self" | "retry" | "refused") => void;
    /** #1290: observability hook — fired for every POST request the fetch patch
     *  lets through WITHOUT routing because its URL is not a recognized model
     *  endpoint (isModelApiUrl miss). Such requests never reach a bili proxy,
     *  so without this their "went direct (uncompressed)" outcome was completely
     *  silent — #1158's logging promise only covered the attribution gate below.
     *  #1657: non-POST methods are excluded — a GET/HEAD cannot carry a prompt,
     *  so it cannot be model inference, and host tooling traffic (npm registries,
     *  catalog JSONs, git refs — ~18 lines per dsh web boot) used to drown the
     *  real failure lines. Called per request; hosts dedup once-per-process-
     *  per-endpoint like takeoverGate. Undefined hosts stay silent. */
    onUnroutedModelUrl?: (url: string) => void;
    /** #1884: observability hook — fired for every model-API request that
     *  carries a body-covering signature (SDK-HMAC-SHA256 family). Hosts
     *  dedup; undefined hosts stay silent. */
    onSignedModelUrl?: (url: string, scheme: string) => void;
    /** #1884 re-sign arm: called when a signed model request is about to be
     *  routed. A returned credential arms the server-side re-signer (the
     *  request tunnels with the x-bili-resign markers and every egress body
     *  bili produces is re-signed); undefined falls back to the #1886 direct
     *  send — bytes untouched, inbound signature intact, no compression. */
    resignCredentialFor?: (url: string, scheme: string, inboundAk?: string) => Promise<{ ak: string; sk: string; token?: string } | undefined>;
}

// #1410: same-process installs share one identity — Symbol.for keeps the
// double-load check working across duplicate copies of this module (a plain
// Symbol would let a second copy re-install on top of the first).
const INTERCEPT_FLAG = Symbol.for("billion-context.native-fetch-intercept");

// #3394: which intercept state routes RIGHT NOW, read by the fetch chain AND
// the Codex Responses WS chain (#3558) at call time. INTERCEPT_FLAG /
// WS_INTERCEPT_FLAG only mark "a chain exists"; this ONE slot carries the live
// instance. A host hot-reimport (DSH 0.2.1-alpha.3 profile recomposition)
// re-applies with a FRESH state — the once-per-process chains must follow that
// new instance instead of staying closed over the first one's dead state. Both
// transports share this single slot so the whole plugin instance moves
// atomically when a new module instance is applied.
export const ACTIVE_STATE = Symbol.for("billion-context.native-intercept-state");

// #3394 hardening: install generation paired with ACTIVE_STATE, bumped by every
// installNativeFetchIntercept / installNativeWebSocketIntercept call (#3558).
// Object identity alone cannot tell apart "a newer module instance" from "a
// newer activation of the SAME instance" (dsh deactivate/reactivate re-applies
// the module-level state, #2082/#2101) — the generation stops an older
// activation's late dispose from clearing a slot a later apply() already
// rebound.
export const ACTIVE_STATE_SEQ = Symbol.for("billion-context.native-intercept-state-seq");

// #2090: the built-in-scheme passthrough opt-in (#1884 escape hatch) is the
// only path where a signed request goes DIRECT — make it LOUD in host logs so
// the user knows this link runs uncompressed. Once per URL, never per request.
const signedDirectSeen = new Set<string>();
function noteSignedDirect(url: string, scheme: string, why: string): void {
    let key = url.split("?")[0];
    try {
        const u = new URL(url);
        key = `${u.origin}${u.pathname}`;
    } catch { /* keep the raw query-stripped form */ }
    if (signedDirectSeen.has(key) || signedDirectSeen.size >= 128) return;
    signedDirectSeen.add(key);
    logHostEvent("warn", "[native-client]", `bili-native: ${scheme}-signed model request forwarded DIRECT (${why}): ${key}`);
}

// Model-API endpoint suffixes across the wires bili proxies: Anthropic
// `/v1/messages`, OpenAI chat `/v1/chat/completions` (and legacy
// `/v1/completions`), Responses `/v1/responses`, Mistral
// `/v1/chat/completions`|`/v1/conversations`, Google native
// `/v1beta/models/<model>:(streamGenerateContent|generateContent|countTokens)`,
// and Google Cloud Code / Antigravity's v1internal dialect
// `/v1internal:(streamGenerateContent|generateContent|countTokens)` (#4256).
// The model methods are exactly the three the proxy core prepares
// (#2493; other Google methods such as `:predict` have no pipeline); the
// v1internal arm matches ONLY those same three so Antigravity's non-model
// control-plane POSTs (loadCodeAssist, fetchUserInfo, … — see
// isV1InternalControlPlanePath) keep passing through direct. Version segment
// is optional and unpinned (zhipuai uses `/v4/chat/completions`, bailian
// mounts `/apps/anthropic/v1/messages`), so match on the trailing shape only.
const MODEL_API_SUFFIX = /(?:^|\/)(?:v\d+\/)?(?:messages|chat\/completions|completions|responses|conversations)\/?$|(?:^|\/)models\/[^/:?]+:(?:streamGenerateContent|generateContent|countTokens)$|(?:^|\/)v1internal:(?:streamGenerateContent|generateContent|countTokens)$/;

/** True when the URL points at a model-API endpoint worth proxying. Never
 *  true for bili's own proxy paths (`/bili/…`, `/__bili/…`) or non-HTTP(S). */
/** True when this process carries the native fetch intercept (#519) — every
 *  isModelApiUrl request WILL be rewritten to the proxy regardless of what
 *  the model config's baseUrl says. Lets identity stamping mirror the
 *  interceptor's own routing decision (#1579) instead of guessing from
 *  launcher-shaped URL forms. */
export function nativeInterceptInstalled(): boolean {
    return (globalThis as Record<PropertyKey, unknown>)[INTERCEPT_FLAG] === true;
}

export function isModelApiUrl(url: string): boolean {
    if (!/^https?:\/\//i.test(url)) return false;
    if (url.includes("/__bili/") || url.includes("/__acp/")) return false;
    try {
        const u = new URL(url);
        const segments = u.pathname.split("/").filter((s) => s.length > 0);
        if (segments[0] === "bili") return false;
        const pathname = u.pathname.replace(/\/+$/, "");
        return MODEL_API_SUFFIX.test(pathname);
    } catch {
        return false;
    }
}

/** Normalize either init.headers or a Request-object input — the two forms a
 *  dispatch can arrive in — into a lowercased-name header record. */
function headerRecordOf(input: string | URL | Request, init?: RequestInit): Record<string, string> | undefined {
    let headers: Headers | undefined;
    if (init?.headers !== undefined) headers = new Headers(init.headers);
    else if (input !== null && typeof input === "object" && !(input instanceof URL)) {
        try {
            headers = new Headers((input as Request).headers);
        } catch {
            headers = undefined;
        }
    }
    if (headers === undefined) return undefined;
    const record: Record<string, string> = {};
    for (const [name, value] of headers) record[name] = value;
    return record;
}

/** Detect a body-covering signature from either init.headers or a
 *  Request-object input — the two forms a dispatch can arrive in — by
 *  normalizing to lowercased header names and delegating to the single
 *  shape-based detector shared with the proxy guard (#1884/#2090). Returns
 *  the scheme token (e.g. "sdk-hmac-sha256") or undefined for unsigned
 *  traffic. */
export function bodySignedSchemeOf(input: string | URL | Request, init?: RequestInit): string | undefined {
    const record = headerRecordOf(input, init);
    return record === undefined ? undefined : inboundSignedScheme(record);
}

/** The SDK-HMAC-SHA256 signing account is named in the inbound Authorization
 *  (`SDK-HMAC-SHA256 Access=<ak>,…`). bili re-signs every egress body (#1884),
 *  so it must sign with THE SAME account the request was issued under — not an
 *  arbitrary pool account — or a multi-account pool collapses to one credential
 *  and off-account models break upstream (#3106). Returns `<ak>` or undefined
 *  when the header is absent or carries no `Access=` field. */
export function inboundApigAccessKey(input: string | URL | Request, init?: RequestInit): string | undefined {
    const record = headerRecordOf(input, init);
    if (record === undefined) return undefined;
    const auth = String(record["authorization"] ?? "").trim();
    const match = /\bAccess=([^,\s]+)/.exec(auth);
    const ak = match?.[1];
    return ak !== undefined && ak.trim() !== "" ? ak.trim() : undefined;
}

/** True when the URL addresses bili's own control plane (`/__bili/*`,
 *  `/__acp/*`, or a `/bili/<protocol>/<url>` tunnel) — expected direct
 *  traffic, not an unrecognized endpoint (#1290): reporting it as "not a
 *  recognized model endpoint" would flag bili's own requests. */
function isBiliControlUrl(url: string): boolean {
    if (url.includes("/__bili/") || url.includes("/__acp/")) return true;
    try {
        const segments = new URL(url).pathname.split("/").filter((s) => s.length > 0);
        return segments[0] === "bili";
    } catch {
        return false;
    }
}

/** A URL already routed by a bili proxy in `/bili/` rewrite form
 *  (`${proxy}/bili/${upstream}`): returns the embedded upstream URL when it
 *  is model-API shaped, else undefined. The launcher's settings overlay
 *  produces these; the patch does not rewrite them (routing is already
 *  done) but DOES stamp plugin headers on them. */
export function routedBiliModelUrl(url: string): string | undefined {
    if (!/^https?:\/\//i.test(url) || url.includes("/__bili/") || url.includes("/__acp/")) return undefined;
    const m = /^https?:\/\/[^/]+\/bili\/(?:responses\/)?(https?:\/.+)$/i.exec(url);
    if (m === null) return undefined;
    return isModelApiUrl(m[1]) ? m[1] : undefined;
}

function fetchUrlOf(input: string | URL | Request): string | undefined {
    try {
        if (typeof input === "string") return input;
        if (input instanceof URL) return input.href;
        if (input !== null && typeof input === "object" && typeof (input as Request).url === "string") {
            return (input as Request).url;
        }
    } catch {
        // fallthrough
    }
    return undefined;
}

/** HTTP method of a fetch call, uppercased: init.method wins (spec: init
 *  overrides a Request-object input), then the Request object's own method,
 *  then the fetch default GET. */
function fetchMethodOf(input: string | URL | Request, init?: RequestInit): string {
    const m = init?.method;
    if (typeof m === "string") return m.toUpperCase();
    try {
        if (input !== null && typeof input === "object" && !(input instanceof URL)) {
            const rm = (input as Request).method;
            if (typeof rm === "string") return rm.toUpperCase();
        }
    } catch {
        // fallthrough
    }
    return "GET";
}

/** Merge extra headers into a (input, init) pair, preserving all three
 *  init.headers forms (Headers instance, entries array, plain object) and
 *  rebuilding a Request-object input with the merged headers (its body
 *  stream passes through explicitly — undici refuses to copy a body-bearing
 *  Request without duplex). Returns the original pair unchanged when there
 *  is nothing to merge. */
function withHeaders(input: string | URL | Request, init: RequestInit | undefined, extra: Record<string, string> | undefined): { input: string | URL | Request; init: RequestInit | undefined } {
    if (extra === undefined || Object.keys(extra).length === 0) return { input, init };
    if (input instanceof Request) {
        try {
            const headers = new Headers(input.headers);
            for (const [k, v] of Object.entries(extra)) headers.set(k, v);
            const rebuilt = new Request(input.url, { method: input.method, headers, body: input.body, duplex: "half" });
            return { input: rebuilt, init };
        } catch {
            return { input, init };
        }
    }
    if (init?.headers === undefined) return { input, init: { ...init, headers: { ...extra } } };
    if (init.headers instanceof Headers) {
        const headers = new Headers(init.headers);
        for (const [k, v] of Object.entries(extra)) headers.set(k, v);
        return { input, init: { ...init, headers } };
    }
    if (Array.isArray(init.headers)) {
        return { input, init: { ...init, headers: [...init.headers, ...Object.entries(extra)] } };
    }
    if (typeof init.headers === "object" && init.headers !== null) {
        return { input, init: { ...init, headers: { ...(init.headers as Record<string, string>), ...extra } } };
    }
    return { input, init };
}

/** #3329: the outgoing headers of a dispatch exactly as fetch resolves them —
 *  init.headers wins over a Request-object input's own headers (spec: init
 *  overrides), normalized to a lowercase-name record so response-time
 *  consumers can look up their per-request correlation id without re-deriving
 *  the merge rules. undefined when no headers exist or none can be read. */
function outgoingHeadersOf(input: string | URL | Request, init?: RequestInit): Record<string, string> | undefined {
    try {
        const src = init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined;
        if (src === undefined) return undefined;
        const out: Record<string, string> = {};
        for (const [k, v] of new Headers(src)) out[k.toLowerCase()] = v;
        return out;
    } catch {
        return undefined;
    }
}

/** #2592/#2709: client-side mirror of the passthrough lane's cheap ASCII
 *  prefilter — true when the dispatch body contains DSH_COMPACTION_MARKER_SNIFF
 *  (the exact bytes the server sniffs; imported, not re-derived). A hit is NOT
 *  decisive (a conversation that merely quotes the directive matches too); the
 *  diverted request lands on the proxy's unattributed passthrough lane, where
 *  detectPassthroughDshCompactionCall runs the marker-decisive
 *  last-user-message check and either refuses (#2709) or relays verbatim —
 *  an over-match costs one loopback hop. Body forms that cannot be read
 *  without disturbing the dispatch (ReadableStream/FormData) fail OPEN:
 *  direct send, today's behavior, with the post-hoc rebase floor (#2742) as
 *  the backstop. A Request-object input is probed through a CLONE — the
 *  original must stay sendable (#2496). init.body wins over a Request
 *  input's own body (spec: init overrides), mirroring fetchMethodOf. */
async function dshCompactionMarkerInBody(input: string | URL | Request, init?: RequestInit): Promise<boolean> {
    const marker = DSH_COMPACTION_MARKER_SNIFF;
    const body: unknown = init?.body;
    if (body === undefined) {
        if (input === null || typeof input !== "object" || input instanceof URL) return false;
        try {
            const probe = (input as Request).clone();
            return (await probe.text()).includes(marker);
        } catch {
            return false;
        }
    }
    if (typeof body === "string") return body.includes(marker);
    if (body instanceof URLSearchParams) return body.toString().includes(marker);
    if (body instanceof Blob) {
        try {
            return (await body.text()).includes(marker);
        } catch {
            return false;
        }
    }
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
        const bytes = body instanceof ArrayBuffer ? body : new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength);
        return new TextDecoder().decode(bytes).includes(marker);
    }
    return false;
}

/** #2924: best-effort body size for the gate's oversize arm — strings and
 *  byte buffers only. Stream/FormData bodies and absent bodies yield
 *  undefined, which disables the size arm for that request (the gate then
 *  keeps #1117 semantics — never a false refusal from missing data). */
function bodyByteSizeOf(init: RequestInit | undefined): { bytes: number } | undefined {
    const body: unknown = init?.body;
    if (typeof body === "string") return { bytes: Buffer.byteLength(body) };
    if (body instanceof Uint8Array) return { bytes: body.byteLength };
    if (body instanceof ArrayBuffer) return { bytes: body.byteLength };
    return undefined;
}

/** #2924 direction 1: protocol-shaped local refusal — 422 per the #2709
 *  precedent (not 401/403 credential-class, not 408/429/5xx transient-class),
 *  so hosts and SDKs treat it as a policy refusal of this ONE request and
 *  surface it instead of retrying or disabling a credential. Reachable only via
 *  the threw+oversized arm (the host's agent scope died mid-request): while it
 *  stays dead, retrying the same call keeps failing, so the remedy is a host
 *  restart (session state is persisted on disk), not another attempt (#3589). */
function oversizeRefusal(url: string): Response {
    const message =
        "billion-context refused this request locally: the host's attribution lookup threw mid-request (its agent scope is disposed/closing), so this body cannot be folded into the model's context window — forwarding it uncompressed would be rejected upstream (#2924). " +
        "While that scope stays dead, retrying this same call will keep failing; restart the client host once (its session state is persisted on disk, so nothing is lost) so the oversized history can be folded back under the window. If you cannot restart, start a fresh session instead.";
    const headers = { "content-type": "application/json", "x-bili-gate": "oversize-refusal" };
    if (url.endsWith("/messages")) {
        return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), { status: 422, headers });
    }
    return new Response(JSON.stringify({ error: { type: "server_error", code: "bili_gate_oversize_refusal", message, retryable: false } }), { status: 422, headers });
}

/** #4068/#4079: local refusal for an UNATTRIBUTED body the gate proved cannot
 *  fit any window. `none` verdicts keep #1117 direct semantics by design — an
 *  agentless lane is not ours to manage — but a body whose optimistic
 *  byte-floor token count already exceeds the window has no direct future:
 *  the raw send 400s/413s upstream and the host retries the SAME oversized
 *  history every turn (the #4068 loop: a 6,165,048-token send against a
 *  1,048,580 window). Refusing locally is damage control, not management —
 *  same 422 policy-refusal class as oversizeRefusal, distinct remedy wording
 *  (there is no broken scope to restart). */
function unattributedOversizeRefusal(url: string): Response {
    const message =
        "billion-context refused this request locally: it is not attributed to any bili-managed session, and its body provably exceeds even a 1,000,000-token window — sending it directly to the provider can only be rejected (every retry re-sends the same oversized history, #4068). " +
        "Route the conversation through a bili-managed session so it can be compressed (check the client's bili plugin attribution), or trim/remove the oversized content (e.g. a giant paste or tool result), or start a fresh session.";
    const headers = { "content-type": "application/json", "x-bili-gate": "oversize-refusal-unattributed" };
    if (url.endsWith("/messages")) {
        return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), { status: 422, headers });
    }
    return new Response(JSON.stringify({ error: { type: "server_error", code: "bili_gate_oversize_refusal_unattributed", message, retryable: false } }), { status: 422, headers });
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
    });
    try {
        return await Promise.race([p, timeout]);
    } catch (err) {
        // #983: a rejected bootstrap used to vanish silently here — surface
        // the real error so a dead-spawn looks different from a slow one.
        logHostEvent("error", "[native-client]", `bili-native: proxy bootstrap failed (${err instanceof Error ? err.message : String(err)}) — falling back after timeout`);
        return undefined;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export async function readyOrigin(state: NativeInterceptState): Promise<string | undefined> {
    if (state.origin !== undefined) return state.origin;
    return withTimeout(state.ready, state.readyTimeoutMs ?? 15000);
}

// ———— Routed-channel evidence (#1365) ————————————————————————————
// Already-routed `/bili/` model URLs carry their proxy origin baked into the
// string; nothing bili does at runtime can move them to a different instance.
// Observing one is therefore DIRECT EVIDENCE that this process's model channel
// is pinned — the attach lanes consume it to decide wait/fail over spawn.

// #3923: lanes without an owner hook (spawn mode — pi/opencode/dsh/omp/zcode/
// kimi all arm the hook only in ATTACH mode) used to absorb routed-channel
// evidence SILENTLY: baked `/bili/` URLs kept passing through to their foreign
// origin while raw URLs followed state.origin, splitting one conversation
// across two live instances with zero signal. Warn once per foreign origin
// instead. (Attach lanes keep their owner-hook behavior untouched.)
const routedMismatchWarned = new Set<string>();

/** Record the origin of an already-routed model URL on the shared state and
 *  fire the owner hook on a transition (first observation or a NEW origin).
 *  MUST be called before any gate/await in the dispatch path: the recording
 *  must never be blocked by machinery it itself informs (the #1268 toolsReady
 *  gate waits on tool registration, which waits on the attach decision, which
 *  consumes this evidence — ordering it after the gate would self-deadlock
 *  the first request). */
export function noteRoutedOrigin(state: NativeInterceptState, url: string): void {
    let origin: string;
    try {
        origin = new URL(url).origin;
    } catch {
        return;
    }
    if (state.routedOrigin === origin) return;
    state.routedOrigin = origin;
    if (state.onRoutedOriginObserved === undefined) {
        const held = state.origin;
        const normalizedHeld = held === undefined ? undefined : held.replace(/\/+$/, "").toLowerCase();
        if (held !== undefined && normalizedHeld !== origin.toLowerCase() && !routedMismatchWarned.has(origin)) {
            if (routedMismatchWarned.size >= 128) routedMismatchWarned.clear();
            routedMismatchWarned.add(origin);
            logHostEvent("error", "[native-client]", `bili-native: model traffic observed at ${origin} but this process's proxy is ${held} — requests will split across two bili instances and same-conversation state will desync (#394); align your client's /bili/ base URL with ${held} or stop one of the instances (#3923)`);
        }
    }
    state.onRoutedOriginObserved?.(origin);
}

const EVIDENCE_GRACE_DEFAULT_MS = 5000;
const EVIDENCE_GRACE_POLL_MS = 100;

/** Wait up to the evidence-grace window for the first routed model request to
 *  reveal where this process's model channel is pinned. The startup attach
 *  decision runs BEFORE the first request (the liveness probe fails in
 *  milliseconds; the request lands seconds later), so an immediate spawn
 *  fallback would race ahead of the evidence — the grace window lets the
 *  channel shape declare itself. Returns the observed origin (pinned channel:
 *  never spawn) or undefined (no routed traffic within the window — the
 *  channel is presumed raw and may follow a replacement, legacy behavior).
 *  BILI_ATTACH_EVIDENCE_GRACE_MS overrides the default; unset = unchanged. */
export async function observeRoutedOrigin(state: NativeInterceptState): Promise<string | undefined> {
    const limit = envMillis(process.env, "BILI_ATTACH_EVIDENCE_GRACE_MS", EVIDENCE_GRACE_DEFAULT_MS);
    const startedAt = Date.now();
    for (;;) {
        const observed = state.routedOrigin;
        if (observed !== undefined) return observed;
        const elapsed = Date.now() - startedAt;
        if (elapsed >= limit) return undefined;
        await new Promise((r) => setTimeout(r, Math.min(EVIDENCE_GRACE_POLL_MS, limit - elapsed)));
    }
}

// ———— Live-origin resolution (#1135) ——————————————————————————————
// Shared by BOTH OpenCode lanes (the native entry's V2 route and the
// launcher plugin's V2 route): each outgoing request resolves the LIVE proxy
// origin — fast-path the held origin through a TTL-cached liveness probe, and
// when it is dead drive state.respawn (cooldown-gated unless we just lost an
// origin we were actively routing to) and adopt whatever replacement lands.
// #3654: the probe is THREE-state (src/liveness.ts). Connect-refused = dead
// (instant, unchanged fast path). Connected-but-no-health-answer = busy —
// the event loop is saturated (a large compression in flight), NOT dead:
// dropping a busy HELD origin would respawn into the SAME process
// (twin-collision, #3044), so instead the origin is held and re-probed at a
// jittered cadence inside a bounded wait window. A busy REPLACEMENT (just
// respawned or adopted) is routed to anyway — its loop drains and the request
// queues instead of failing for nothing. A transient blip that recovers to
// the SAME origin costs nothing (the session never migrates); a genuinely
// dead origin falls back to whatever the owner's respawn produces (a
// self-spawned proxy, or another healthy shared instance via discovery).
// Returns undefined when nothing is alive — callers MUST degrade to direct
// sends, not fail-closed.

const HEALTH_TIMEOUT_MS = 1500;
/** #3654: total budget for re-probing a BUSY held origin before declaring it
 *  lost. Deliberately far above HEALTH_TIMEOUT_MS: the point is to ride out
 *  multi-second event-loop saturation (large compressions), not to widen the
 *  single-shot probe. */
const BUSY_WAIT_CAP_MS = 10_000;
/** #3654: base interval between busy re-probes (jittered 0.5x–1.5x). */
const BUSY_REPROBE_BASE_MS = 1_000;
/** Probe-verdict trust window (#928). Far below RESPAWN_COOLDOWN_MS: that
 *  cooldown already assumes multi-second proxy stability, so a few-second
 *  detection horizon is consistent with it while removing the per-request RTT. */
const HEALTH_PROBE_TTL_MS = 2_000;
const RESPAWN_COOLDOWN_MS = 15_000;

/** Default liveness probe: GET /__bili/health under the single-shot budget —
 *  now three-state (#3654): TCP connect refused classifies dead in
 *  milliseconds instead of eating the whole budget. */
async function probeOriginHealth(origin: string): Promise<LivenessVerdict> {
    return probeLiveness(origin, HEALTH_TIMEOUT_MS);
}

/** Wrap a probe in a per-origin TTL cache (#928). Only DEFINITE verdicts are
 *  cached: alive skips the steady-state loopback RTT; dead avoids re-paying
 *  the full HEALTH_TIMEOUT_MS on every request across the death+cooldown
 *  window. BUSY is never cached — a saturation episode ends within seconds and
 *  caching it would solidify "slow" into "dead" (#3654). Stale entries for
 *  other origins are evicted on insert, keeping the map bounded. */
function withProbeTtl(probe: (origin: string) => Promise<LivenessVerdict>, ttlMs: number): (origin: string) => Promise<LivenessVerdict> {
    const cache = new Map<string, { verdict: LivenessVerdict; at: number }>();
    return (origin) => {
        const now = Date.now();
        const hit = cache.get(origin);
        if (hit !== undefined && now - hit.at < ttlMs) return Promise.resolve(hit.verdict);
        return probe(origin).then((verdict) => {
            const t = Date.now();
            for (const [key, entry] of cache) if (t - entry.at >= ttlMs) cache.delete(key);
            if (verdict.state !== "busy") cache.set(origin, { verdict, at: t });
            return verdict;
        });
    };
}

export interface LiveOriginResolverDeps {
    /** Injectable liveness probe (tests); defaults to probeLiveness over
     *  /__bili/health under HEALTH_TIMEOUT_MS. Legacy boolean probes stay
     *  accepted (true → alive, false → dead). */
    probe?: (origin: string) => Promise<LivenessVerdict | boolean>;
    /** Bootstrap retry interval when no live origin is held (tests shrink it). */
    respawnCooldownMs?: number;
    /** Probe-verdict cache TTL; defaults to HEALTH_PROBE_TTL_MS (tests shrink it). */
    probeTtlMs?: number;
    /** #3654: busy-wait budget for a saturated HELD origin; defaults to
     *  BUSY_WAIT_CAP_MS (tests shrink it). */
    busyWaitCapMs?: number;
    /** #3654: base interval between busy re-probes; defaults to
     *  BUSY_REPROBE_BASE_MS (tests shrink it). */
    busyReprobeBaseMs?: number;
}

/** Build the per-request live-origin resolver over a shared intercept state.
 *  The owner arms `state.respawn` (self-spawn for spawn mode, probe-then-
 *  fallback for attach mode — #1130/#1135); this resolver only decides WHEN
 *  to fire it and whether the result is actually alive. */
export function createLiveOriginResolver(state: NativeInterceptState, deps: LiveOriginResolverDeps = {}): () => Promise<string | undefined> {
    // #1957: a health verdict describes a PROCESS GENERATION, not a URL. A
    // respawn puts a new process behind the same origin (lane port memory,
    // #1723), so every verdict obtained before that boundary is void — a
    // stale negative hit would send the first post-recovery request(s)
    // direct (uncompressed) until the TTL lapses. At each respawn the TTL
    // cache is rebuilt (kills cached verdicts) and `generation` advances
    // (kills in-flight verdicts, which must not clear a healthy
    // replacement that already landed).
    const rawProbe = deps.probe ?? probeOriginHealth;
    const probeFn = (origin: string): Promise<LivenessVerdict> => rawProbe(origin).then((v) => typeof v === "boolean" ? { state: v ? "alive" : "dead" } : v);
    const probeTtlMs = deps.probeTtlMs ?? HEALTH_PROBE_TTL_MS;
    let probe = withProbeTtl(probeFn, probeTtlMs);
    let generation = 0;
    const respawnCooldownMs = deps.respawnCooldownMs ?? RESPAWN_COOLDOWN_MS;
    const busyWaitCapMs = deps.busyWaitCapMs ?? BUSY_WAIT_CAP_MS;
    const busyReprobeBaseMs = deps.busyReprobeBaseMs ?? BUSY_REPROBE_BASE_MS;
    let lastRespawn = 0;
    // #3654: one entry per busy episode per origin (attempt count) so the log
    // announces an episode ONCE (the first caller that sees it) and concurrent
    // callers in the same episode only count attempts.
    const busyEpisodes = new Map<string, { attempts: number }>();
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    return async (): Promise<string | undefined> => {
        let ownedThenLost = false;
        let lossReason: UnavailableReason | undefined;
        const held = state.origin;
        const gen = generation;
        if (held !== undefined) {
            const v = await probe(held);
            // Act on the verdict only if the world didn't move while it was
            // in flight: a concurrent caller's respawn (generation bump) or
            // any origin change underneath us voids it — re-resolve instead.
            if (gen === generation && state.origin === held) {
                if (v.state === "alive") {
                    state.lastUnavailableReason = undefined;
                    return held;
                }
                if (v.state === "dead") {
                    logHostEvent("info", "[native-client]", `bili-native: liveness: ${held} dead (${v.detail ?? "no answer"}) — clearing origin`);
                    // Proxy died mid-session. Clearing origin first makes concurrent
                    // callers share the same state.ready (dedup).
                    ownedThenLost = true;
                    lossReason = "dead";
                    state.origin = undefined;
                } else {
                    // #3654: BUSY — TCP connect succeeded but /__bili/health never
                    // answered within the budget: the event loop is saturated
                    // (typically a large compression), not dead. Dropping this
                    // origin would respawn into the SAME process (twin-collision,
                    // #3044); ride out the episode instead.
                    const freshEpisode = !busyEpisodes.has(held);
                    const ep = busyEpisodes.get(held) ?? { attempts: 0 };
                    busyEpisodes.set(held, ep);
                    if (freshEpisode) {
                        logHostEvent("info", "[native-client]", `bili-native: liveness: ${held} BUSY (${v.detail ?? "no health answer"}) — holding origin, re-probing (budget ${busyWaitCapMs}ms) (#3654)`);
                    }
                    const deadline = Date.now() + busyWaitCapMs;
                    for (;;) {
                        if (Date.now() >= deadline) break;
                        const jitter = 0.5 + Math.random(); // 0.5x–1.5x
                        await sleep(Math.min(busyReprobeBaseMs * jitter, Math.max(0, deadline - Date.now())));
                        if (gen !== generation || state.origin !== held) break;
                        ep.attempts += 1;
                        const again = await probe(held);
                        if (gen !== generation || state.origin !== held) break;
                        if (again.state === "alive") {
                            busyEpisodes.delete(held);
                            logHostEvent("info", "[native-client]", `bili-native: liveness: ${held} alive again after ${ep.attempts} busy re-probe(s)`);
                            state.lastUnavailableReason = undefined;
                            return held;
                        }
                        if (again.state === "dead") {
                            busyEpisodes.delete(held);
                            logHostEvent("info", "[native-client]", `bili-native: liveness: ${held} dead during busy episode (${again.detail ?? "no answer"}, attempt ${ep.attempts}) — respawning`);
                            ownedThenLost = true;
                            lossReason = "dead";
                            state.origin = undefined;
                            break;
                        }
                        logHostEvent("info", "[native-client]", `bili-native: liveness: ${held} still busy — re-probe attempt ${ep.attempts}`);
                    }
                    if (state.origin === held && gen === generation) {
                        // Window exhausted while still busy: lost-for-this-request,
                        // but record WHY so the refusal says "saturated", not "dead".
                        busyEpisodes.delete(held);
                        logHostEvent("warn", "[native-client]", `bili-native: liveness: ${held} still busy after ${ep.attempts} re-probe(s) over ${busyWaitCapMs}ms — letting go, respawning (#3654)`);
                        ownedThenLost = true;
                        lossReason = "busy-exhausted";
                        state.origin = undefined;
                    }
                }
            }
        }
        // Retry bootstrap whenever no live origin is held — either just lost
        // it or the load-time bootstrap failed (the hook cannot observe send
        // failures, so nothing else would retry). Cooldown bounds attempts to
        // one per interval instead of one per request.
        if (state.respawn !== undefined && (ownedThenLost || Date.now() - lastRespawn >= respawnCooldownMs)) {
            lastRespawn = Date.now();
            generation += 1;
            probe = withProbeTtl(probeFn, probeTtlMs);
            // Same generation boundary as the verdict-cache rebuild above: a
            // post-respawn busy episode behind the same origin must announce
            // itself instead of inheriting a stale pre-respawn episode entry.
            busyEpisodes.clear();
            state.ready = state.respawn();
        }
        const o = await readyOrigin(state);
        if (o !== undefined) {
            const v = await probe(o);
            if (v.state === "alive") {
                state.lastUnavailableReason = undefined;
                return o;
            }
            if (v.state === "busy") {
                // #3654: a just-landed replacement that is already busy is still
                // ALIVE — routing to it queues the request behind the saturating
                // fold; refusing here would fail the very request the adoption
                // existed to save.
                logHostEvent("info", "[native-client]", `bili-native: liveness: replacement ${o} BUSY (${v.detail ?? "no health answer"}) — routing anyway, the request will queue (#3654)`);
                state.lastUnavailableReason = undefined;
                return o;
            }
        }
        state.lastUnavailableReason = lossReason ?? "bootstrap-failed";
        if (ownedThenLost) state.onGiveUp?.();
        return undefined;
    };
}

/** Replace the outgoing request reference with a new Request against
 *  `target`, preserving method/headers/body (a Request.url is read-only,
 *  #810 — the reference itself moves). When the body cannot be copied the
 *  original request is left untouched (it goes direct rather than dying). */
export function replaceRequestTarget(e: { request?: unknown }, target: string): void {
    const old = e.request;
    if (old == null) return;
    try {
        e.request = new Request(target, old as unknown as Request);
    } catch {
        // undici refuses to copy a body-bearing Request without explicit
        // duplex — reconstruct with the body stream passed explicitly.
        const src = old as unknown as { method?: unknown; headers?: Iterable<readonly [string, string]> | null; body?: ReadableStream<Uint8Array> | null };
        try {
            const init: RequestInit & { duplex?: "half" } = { method: typeof src.method === "string" ? src.method : "GET" };
            const pairs: [string, string][] = [];
            try {
                for (const pair of src.headers ?? []) pairs.push([pair[0], pair[1]]);
            } catch {}
            if (pairs.length > 0) init.headers = pairs;
            if (src.body != null) {
                init.body = src.body as RequestInit["body"];
                init.duplex = "half";
            }
            e.request = new Request(target, init);
        } catch {
            // replacement impossible (exotic body) — request goes direct
        }
    }
}

/** Replace the hook's request with a new Request carrying a NEW BODY (and
 *  optionally extra headers) while preserving url/method/headers. The
 *  incremental-turn adapters use it: the host hands a real fetch Request
 *  whose target and headers must survive while the body is swapped for the
 *  incremental payload. A string body needs no duplex. */
export function replaceRequestPayload(e: { request?: unknown }, body: string, extraHeaders?: Record<string, string>): void {
    const old = e.request as { url?: unknown; method?: unknown; headers?: unknown } | null | undefined;
    if (old == null || typeof old.url !== "string") return;
    try {
        const headers = new Headers((old.headers ?? undefined) as ConstructorParameters<typeof Headers>[0]);
        for (const [k, v] of Object.entries(extraHeaders ?? {})) headers.set(k, v);
        e.request = new Request(old.url, {
            method: typeof old.method === "string" ? old.method : "POST",
            headers,
            body,
        });
    } catch {
        // replacement impossible (exotic request) — the caller's plan is
        // abandoned; the request goes out full exactly as the host built it
    }
}

/** #3304: rebuild a fall-back dispatch carrying `body` INSTEAD of whatever
 *  `init`/the Request carried. The restored body rides INIT so fetch-spec
 *  precedence (init over Request fields) stays exactly what the original
 *  dispatch had; a string body needs no duplex. */
export function withRestoredBody(input: string | URL | Request, init: RequestInit | undefined, body: string): { input: string | URL | Request; init: RequestInit | undefined } {
    if (input instanceof Request) {
        try {
            const plain = new Request(input.url, { method: input.method, headers: input.headers });
            return { input: plain, init: { ...(init ?? {}), body } };
        } catch {
            const headers: Record<string, string> = {};
            try {
                for (const [k, v] of input.headers) headers[k] = v;
            } catch {}
            return { input: input.url, init: { ...(init ?? {}), method: input.method, headers, body } };
        }
    }
    return { input, init: { ...(init ?? {}), body } };
}

/** Re-point the process-level live-state slot at the activating instance and
 *  advance its generation, so every transport (fetch + Codex Responses WS)
 *  follows the newest applied module instance (#3394/#3558). Called at the TOP
 *  of every install — including the ones that find a chain already present and
 *  bail — because "which instance is active" is independent of whether THIS
 *  transport's wrapper got (re)installed. Returns true when the slot was empty
 *  before: the caller then warns once, since a pre-live-state chain cannot be
 *  rewritten to read the slot until the host restarts. */
export function bindLiveStateSlot(state: NativeInterceptState): boolean {
    const g = globalThis as Record<PropertyKey, unknown>;
    const firstBind = g[ACTIVE_STATE] === undefined;
    g[ACTIVE_STATE_SEQ] = Number(g[ACTIVE_STATE_SEQ] ?? 0) + 1;
    g[ACTIVE_STATE] = state;
    return firstBind;
}

/** Install the global fetch patch. The first call wraps globalThis.fetch and
 *  returns true; later calls return false (a process installs one chain) BUT
 *  always rebind the live-state slot, so a host hot-reimport that re-applies
 *  with a fresh state takes over routing without a restart (#3394). */
export function installNativeFetchIntercept(initialState: NativeInterceptState): boolean {
    const g = globalThis as Record<PropertyKey, unknown>;
    // Point the slot at whichever state is being activated. The dispatch below
    // reads g[ACTIVE_STATE] per request, so the newest applied instance wins
    // even though the chain itself was wrapped only once.
    const hadChain = g[INTERCEPT_FLAG] === true;
    const firstBind = bindLiveStateSlot(initialState);
    if (hadChain) {
        // A chain from an EARLIER build already wraps fetch and cannot be
        // rewritten to read this slot — until the host restarts, requests route
        // through that old closure. Say so once instead of failing silent.
        if (firstBind) logHostEvent("warn", "[native-client]", "native fetch chain predates live-state routing; restart the host once for model requests to follow this plugin instance (#3394)");
        return false;
    }
    // Shared across every re-armed chain link (a re-arm replaces the chain
    // top but must not forget what this process already learned).
    let warned = false;
    // Origins verified dead-and-replaced during a runtime recovery (#1130).
    // Launcher settings overlays bake the origin into request URLs, so after
    // a replace we must reroute those pre-baked URLs before they touch the
    // network again. Only ever contains origins we ourselves observed dying.
    const replacedOrigins = new Set<string>();

    installFetchChain((send) => async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = fetchUrlOf(input);
        // #3394: resolve the ACTIVE state per request instead of capturing the
        // first installer's — a hot-reimport swapped in a fresh instance whose
        // headersFor/takeoverGate/origin live on ITS state. No fallback to the
        // captured one: an empty slot means no plugin is active, so pass through
        // direct rather than hit a disposed context.
        const state = g[ACTIVE_STATE] as NativeInterceptState | undefined;
        if (url === undefined || state === undefined) return send(input, init);
        // #1268: hold the request until the host's ACP tool registration has
        // finished its first attempt, so headersFor can stamp it into plugin
        // mode. Steady state costs nothing (gate already resolved). A timeout
        // or a failed registration falls through exactly like today — the
        // request proceeds un-stamped (wire mode).
        let gateLogged = false;
        const waitToolsGate = async (): Promise<void> => {
            const gate = state.toolsReady;
            if (gate === undefined) return;
            const t0 = Date.now();
            await withTimeout(gate, state.readyTimeoutMs ?? 15000);
            const held = Date.now() - t0;
            if (!gateLogged && held >= 50) {
                gateLogged = true;
                logHostEvent("warn", "[native-client]", `[bili-native] held model request ${held}ms for ACP tool registration (#1268)`);
            }
        };
        // Rebuild a Request-object input against a different target. A
        // caller-side defect here (already-consumed or locked body) must not
        // reach the proxy-death branch below — respawning would orphan a
        // fresh proxy for a request that can never be sent.
        const makeTarget = (target: string): string | URL | Request =>
            typeof input === "string" || input instanceof URL ? target : new Request(target, input);

        // Runtime recovery (#1130): the origin just failed against is dead.
        // Clear it first (readyOrigin must not short-circuit onto the stale
        // value), ask the owner to bring up a replacement, await it. Returns
        // the replacement origin, or undefined when nothing came up. An
        // origin that comes back as ITSELF (transient blip) is not recorded
        // as replaced — URLs baked against it stay valid.
        const recover = async (deadOrigin: string): Promise<string | undefined> => {
            if (state.respawn === undefined) return undefined;
            state.origin = undefined;
            state.ready = state.respawn();
            const again = await readyOrigin(state);
            if (again !== undefined && again !== deadOrigin) replacedOrigins.add(deadOrigin);
            return again;
        };

        // #3304: ask the lane whether this fall-back payload may go to the
        // real upstream AS-IS. Fail-safe direction: an armed hook that
        // throws is treated as "unrestorable" — never risk sending bytes the
        // lane may have mutated.
        const prepareForDirectSend = async (url: string, input: string | URL | Request, init: RequestInit | undefined): Promise<DirectSendPrep> => {
            const hook = state.prepareDirectSend;
            if (hook === undefined) return { outcome: "as-is" };
            try {
                return await hook(url, input, init);
            } catch (err) {
                logHostEvent("error", "[native-client]", `bili-native: prepareDirectSend hook failed (${err instanceof Error ? err.message : String(err)}) — refusing the direct send (#3304)`);
                return { outcome: "unrestorable" };
            }
        };

        // #3304: the guarded fall-back send. `defaultInput` is what the site
        // would send without the guard (usually `input`; makeTarget(routedTarget)
        // on the routed give-up). Restored bodies ride INIT so fetch-spec
        // precedence (init over Request) stays exactly what the original
        // dispatch had.
        const directSendOrRefuse = async (dispatchUrl: string, defaultInput: string | URL | Request, init: RequestInit | undefined): Promise<Response> => {
            const prep = await prepareForDirectSend(dispatchUrl, defaultInput, init);
            if (prep.outcome === "as-is") {
                state.onDispatch?.(dispatchUrl, "direct");
                return send(defaultInput, init);
            }
            if (prep.outcome === "unrestorable") {
                // A lane-only payload (e.g. an incremental delta) cannot be
                // forwarded to a provider that cannot parse it — refusing
                // locally keeps the host's retry loop driving the decision
                // again (re-probe / re-plan) instead of burning the turn on
                // an upstream 400.
                state.onDispatch?.(dispatchUrl, "refused");
                logHostEvent("error", "[native-client]", `bili-native: no usable proxy and the request carries a lane-only payload — failing locally instead of sending it to the provider; retry the turn (#3304): ${dispatchUrl}`);
                throw new TypeError("billion-context: proxy unavailable — the request payload is lane-specific (incremental turn) and cannot be forwarded to the provider directly; retry the turn (#3304)");
            }
            const restored = withRestoredBody(defaultInput, init, prep.body);
            state.onDispatch?.(dispatchUrl, "direct");
            return send(restored.input, restored.init);
        };

        // Already-routed `/bili/` model requests (launcher settings overlay):
        // routing is done, but plugin headers still decide wire vs plugin
        // mode — stamp and pass through untouched otherwise.
        const routedTarget = routedBiliModelUrl(url);
        if (routedTarget !== undefined) {
            // #1117: routing already happened (settings overlay), so an
            // unattributed caller cannot be refused here — mark it for
            // byte-untouched passthrough instead of letting it ride the
            // pipeline as an anonymous client. Its failures are not ours to
            // recover: the host's own attributed traffic drives the respawn
            // below, and once a replacement lands the pre-emptive reroute
            // carries unattributed riders along (still passthrough-marked).
            if (state.takeoverGate !== undefined) {
                const verdict = await state.takeoverGate(routedTarget, bodyByteSizeOf(init), init);
                if (verdict === "refuse-oversized" || verdict === "refuse-oversized-unattributed") {
                    // #2924 direction 1 (routed lane): an already-routed body
                    // the gate could not claim and that provably cannot fit
                    // fails LOCALLY here too — the #1117 passthrough marker
                    // would forward it verbatim into the very upstream 400 the
                    // raw lane already refuses. The unattributed variant
                    // (#4068) covers the same shape without a broken scope.
                    state.onDispatch?.(url, "refused");
                    return verdict === "refuse-oversized" ? oversizeRefusal(url) : unattributedOversizeRefusal(url);
                }
                if (verdict !== true) {
                    const stamped = withHeaders(input, init, { [BILI_PASSTHROUGH_HEADER]: "1" });
                    return directSendOrRefuse(url, stamped.input, stamped.init);
                }
            }
            // #1365: attributed routed traffic pins this process's model channel
            // to the baked origin — record it BEFORE the gate (noteRoutedOrigin).
            noteRoutedOrigin(state, url);
            // The gate must clear BEFORE headersFor is consulted — the hook
            // reads the host's live tool-registration state, and evaluating
            // it pre-gate would freeze an un-stamped decision forever.
            await waitToolsGate();
            if (state.beforeSend !== undefined) {
                try {
                    await state.beforeSend(url, init);
                } catch (err) {
                    logHostEvent("error", "[native-client]", `bili-native: beforeSend hook failed (${err instanceof Error ? err.message : String(err)}) — request continues (#2399)`);
                }
            }
            const routedExtra = state.headersFor?.(routedTarget);
            let target = url;
            const baked = new URL(url);
            if (replacedOrigins.has(baked.origin)) {
                // This URL was baked against an origin we already verified
                // dead-and-replaced (#1130) — reroute it before paying
                // another connection failure.
                const fresh = await readyOrigin(state);
                if (fresh !== undefined && fresh !== baked.origin) target = `${fresh}${baked.pathname}${baked.search}`;
            }
            const stamped = withHeaders(target === url ? input : makeTarget(target), init, routedExtra);
            try {
                state.onDispatch?.(target, target === url ? "self" : "retry");
                const resp = await send(stamped.input, stamped.init);
                try {
                    state.onResponse?.(url, resp, outgoingHeadersOf(stamped.input, stamped.init));
                } catch {
                    // observability hook only — never break the response
                }
                return resp;
            } catch (err) {
                // The overlay bakes a specific proxy origin into these URLs;
                // that proxy can die mid-session when its owning launcher
                // exits while later sessions still ride it (#1130). A
                // network-level failure (undici TypeError) triggers one
                // recovery + one retry; if no replacement comes up, degrade
                // to a direct send of the embedded upstream instead of
                // failing the request forever. Recovery re-attempts on every
                // subsequent failure — only this path can reroute the
                // overlay-baked URLs. A dead-closure error (#1410) is NOT a
                // proxy death — send() already exhausted every live anchor;
                // respawning would churn a healthy proxy for the wrong fault.
                if (!(err instanceof TypeError) || isDeadClosureError(err)) throw err;
                // #2496 guard: a Request-object body disturbed by the failed
                // send cannot be re-sent — `new Request(target, input)` would
                // throw a confusing "Body is unusable" (or, for some stream
                // bodies, silently send an empty/EOF body). The request is
                // unrecoverable either way: surface the original failure
                // instead of retrying or degrading to a direct send (PR #2581
                // review).
                if (input instanceof Request && input.bodyUsed) throw err;
                const deadOrigin = new URL(target).origin;
                const again = await recover(deadOrigin);
                if (again !== undefined) {
                    // #2496: a recovery that lands back on the SAME origin is a
                    // transient blip, not a loss — the proxy is alive and the
                    // baked URL still points at it, so retry there instead of
                    // giving up (the old give-up fired onGiveUp, which deletes
                    // BILLION_CONTEXT_PROXY process-wide in the omp/pi lanes).
                    const u = new URL(target);
                    const retried = `${again}${u.pathname}${u.search}`;
                    const restamped = withHeaders(makeTarget(retried), init, routedExtra);
                    state.onDispatch?.(retried, "retry");
                    const resp = await send(restamped.input, restamped.init);
                    try {
                        state.onResponse?.(url, resp, outgoingHeadersOf(restamped.input, restamped.init));
                    } catch {
                        // observability hook only — never break the response
                    }
                    return resp;
                }
                state.lastUnavailableReason = "send-failed";
                state.onGiveUp?.();
                if (!warned) {
                    warned = true;
                    logHostEvent("error", "[native-client]", `bili-native: no live proxy — model requests go direct (uncompressed): ${routedTarget}`);
                }
                return directSendOrRefuse(routedTarget, makeTarget(routedTarget), init);
            }
        }
        if (!isModelApiUrl(url)) {
            // #1657: only POST can carry model traffic — npm registries,
            // catalog JSONs, git refs and the rest of the host's tooling are
            // GET and would otherwise fire the hook once per boot per endpoint.
            if (!isBiliControlUrl(url) && fetchMethodOf(input, init) === "POST") state.onUnroutedModelUrl?.(url);
            return send(input, init);
        }
        // #1884/#2090 plan A + owner binary-contract ruling ("要么一定压缩，
        // 或者一定拒绝"): a body-covering signature cannot survive a rewrite —
        // routing these through the proxy un-armed makes the upstream reject
        // every request with 401 (APIG.0301 body hash mismatch / SigV4
        // SignatureDoesNotMatch). A signed request therefore has exactly TWO
        // legal outcomes here: re-signed+compressed (host supplies the
        // credential — dsh credential service, built-in scheme only — and the
        // request tunnels WITH a re-sign arm) or REFUSED locally (403 naming
        // the scheme). There is NO unsigned pass-through outcome: letting a
        // signed body through un-compressed would hide the bypass from the
        // user, which is exactly what the ruling forbids. The sole exception
        // is the pre-existing #1884 escape hatch on the BUILT-IN scheme itself
        // (resign["sdk-hmac-sha256"].passthrough / BILI_RESIGN_PASSTHROUGH) —
        // its refusal has a user-side fix (provide the credential), so an
        // explicit opt-in there is a real decision, not a cop-out; for every
        // OTHER scheme passthrough settings are INERT and the request is
        // always refused. Refusals are remembered (recordSignedRefusal) so
        // bili startups keep listing unresolved schemes until bili ships
        // their re-signer. BILI_RESIGN=0 or `resign["<scheme>"].enabled=false`
        // un-deploy the branch entirely (pre-#1884 behavior: signed bodies
        // ride the normal takeover path) and clear the scheme's refusal
        // memory.
        let resignExtra: Record<string, string> | undefined;
        const signedScheme = bodySignedSchemeOf(input, init);
        if (signedScheme !== undefined) {
            if (!resignEnabled(undefined, signedScheme)) {
                clearSignedRefusal(signedScheme);
            } else {
                state.onSignedModelUrl?.(url, signedScheme);
                let cred: { ak: string; sk: string; token?: string } | undefined;
                if (signedScheme === APIG_RESIGN_SCHEME && state.resignCredentialFor !== undefined) {
                    try {
                        cred = await state.resignCredentialFor(url, signedScheme, inboundApigAccessKey(input, init));
                    } catch {
                        cred = undefined;
                    }
                }
                if (cred === undefined) {
                    const builtinPassthrough = signedScheme === APIG_RESIGN_SCHEME && resignPassthroughEnabled(undefined, signedScheme);
                    if (!builtinPassthrough) {
                        state.onDispatch?.(url, "refused");
                        recordSignedRefusal(signedScheme, url);
                        const refusal = signedRefusal(signedScheme, url.endsWith("/messages") ? "anthropic" : "openai");
                        return new Response(refusal.body, { status: refusal.status, headers: { "content-type": refusal.contentType, "x-bili-resign": "unavailable" } });
                    }
                    clearSignedRefusal(signedScheme);
                    noteSignedDirect(url, signedScheme, "built-in passthrough opt-in (#1884) — byte-untouched, no compression");
                    return directSendOrRefuse(url, input, init);
                }
                resignExtra = {
                    [APIG_RESIGN_HEADER]: APIG_RESIGN_SCHEME,
                    [APIG_RESIGN_CREDENTIAL_HEADER]: encodeApigCredential(cred),
                };
            }
        }
        // #1117: URL shape alone cannot claim a request — every model call in
        // the process hits the same endpoints. When the host supplies an
        // attribution gate, an unattributed caller keeps its original URL and
        // sends direct (never touches a bili proxy).
        if (state.takeoverGate !== undefined) {
            // #2924: the gate may need async settle-retries on a `threw`
            // attribution, and may answer `"refuse-oversized"` — both await
            // fine; a plain sync boolean (every other host) is unchanged.
            const verdict = await state.takeoverGate(url, bodyByteSizeOf(init), init);
            if (verdict !== true) {
                // #2592/#2709 residual leak: an agentless dsh compaction call on a
                // RAW provider URL (no settings overlay → nothing routed it) rode
                // this branch direct and landed — the 4/49 field-report shape, with
                // only the post-hoc rebase floor (#2742) to catch it. Divert JUST
                // marker-sniffed POSTs into the proxy's unattributed passthrough
                // lane (same stamp the overlay-routed case above uses), where the
                // #2709 guard runs the decisive check: refused (422; dsh logs
                // "step compaction failed" and continues the turn) — the former
                // allowDshCompaction opt-out was removed (#3666), so the refusal
                // is unconditional. Everything else — plain traffic, stream bodies that
                // cannot be peeked, a dead proxy — keeps #1117's direct semantics.
                if (fetchMethodOf(input, init) === "POST" && await dshCompactionMarkerInBody(input, init)) {
                    const compactionOrigin = await readyOrigin(state);
                    if (compactionOrigin !== undefined) {
                        const stamped = withHeaders(makeTarget(`${compactionOrigin}/bili/${url}`), init, { [BILI_PASSTHROUGH_HEADER]: "1" });
                        state.onDispatch?.(`${compactionOrigin}/bili/${url}`, "rewrite");
                        return send(stamped.input, stamped.init);
                    }
                }
                // #2924 direction 1: a provably-oversized body that the gate
                // could not claim fails LOCALLY (422, host-visible) instead of
                // riding #1117's direct send into a guaranteed upstream 400 —
                // on a >window local history that 400 kills the whole session,
                // because every later request carries the same history.
                if (verdict === "refuse-oversized" || verdict === "refuse-oversized-unattributed") {
                    state.onDispatch?.(url, "refused");
                    return verdict === "refuse-oversized" ? oversizeRefusal(url) : unattributedOversizeRefusal(url);
                }
                return directSendOrRefuse(url, input, init);
            }
        }

        const origin = await readyOrigin(state);
        if (origin === undefined) {
            // Bootstrap failed or timed out — NEVER break the agent: send
            // direct (uncompressed) and say so once.
            if (!warned) {
                warned = true;
                logHostEvent("error", "[native-client]", `bili-native: proxy not ready — model request goes direct (uncompressed): ${url}`);
            }
            return directSendOrRefuse(url, input, init);
        }
        // Attach mode rewrites exactly like spawn mode (#809 semantics —
        // opencode's attach probe+rewrite; the V1 fetch patch relies on it to
        // catch providers without an explicit baseURL). For dsh under the
        // `bili dsh` launcher this is doubly safe: settings-overlay URLs are
        // already `/bili/`-shaped and take the routed branch above, and
        // rewriting a raw upstream URL to the loopback proxy bypasses the
        // MITM envs entirely (an http loopback target is never proxied).
        if (url.startsWith(`${origin}/`)) {
            state.onDispatch?.(url, "self");
            return send(input, init);
        }
        await waitToolsGate();
        if (state.beforeSend !== undefined) {
            try {
                await state.beforeSend(url, init);
            } catch (err) {
                logHostEvent("error", "[native-client]", `bili-native: beforeSend hook failed (${err instanceof Error ? err.message : String(err)}) — request continues (#2399)`);
            }
        }
        const first = makeTarget(`${origin}/bili/${url}`);
        state.onDispatch?.(`${origin}/bili/${url}`, "rewrite");
        try {
            const stamped = withHeaders(first, init, resignExtra !== undefined ? { ...(state.headersFor?.(url) ?? {}), ...resignExtra } : state.headersFor?.(url));
            const resp = await send(stamped.input, stamped.init);
            try {
                state.onResponse?.(url, resp, outgoingHeadersOf(stamped.input, stamped.init));
            } catch {
                // observability hook only — never break the response
            }
            return resp;
        } catch (err) {
            // The proxy can die mid-session (its parent watchdog fires when
            // the FIRST owner exits while later sessions still ride it —
            // spawned, or shared-attached via another launcher, #1130). A
            // network-level failure (undici throws TypeError) triggers one
            // recovery + one retry. A dead-closure error (#1410) is NOT a
            // proxy death — send() already exhausted every live anchor; let
            // it propagate instead of churning a healthy proxy.
            if (err instanceof TypeError && !isDeadClosureError(err)) {
                const again = await recover(origin);
                if (again !== undefined) {
                    const retried = makeTarget(`${again}/bili/${url}`);
                    state.onDispatch?.(`${again}/bili/${url}`, "retry");
                    const stamped = withHeaders(retried, init, resignExtra !== undefined ? { ...(state.headersFor?.(url) ?? {}), ...resignExtra } : state.headersFor?.(url));
                    const resp = await send(stamped.input, stamped.init);
                    try {
                        state.onResponse?.(url, resp, outgoingHeadersOf(stamped.input, stamped.init));
                    } catch {
                        // observability hook only — never break the response
                    }
                    return resp;
                }
                // No replacement available — this session runs direct for its
                // lifetime. Degrade exactly like a bootstrap failure: actually
                // send the request direct, then let the owner clear proxy-owned
                // state.
                state.lastUnavailableReason = "send-failed";
                state.onGiveUp?.();
                if (!warned) {
                    warned = true;
                    logHostEvent("error", "[native-client]", `bili-native: proxy respawn failed — model requests go direct (uncompressed): ${url}`);
                }
                return directSendOrRefuse(url, input, init);
            }
            throw err;
        }
    });
    g[INTERCEPT_FLAG] = true;
    return true;
}

/** #3394: effect thunk for hosts whose plugin context can die while the module
 *  lives on (dsh deactivate/reactivate, #2082/#2101). The host runs it once per
 *  activation; the returned disposer clears the live-state slot only if THIS
 *  activation still owns it — generation match (no newer apply, including a
 *  re-activation of the same instance) AND bound-state match (no hot-reimported
 *  instance). While the slot is empty the shared chain passes through direct.
 *  The generation is captured when the host RUNS the thunk: if a host ever ran
 *  it before this activation's install, the disposer degrades to a no-op (the
 *  slot survives — routing unaffected), never to a wrong clear. */
export function liveStateSlotEffect(state: NativeInterceptState): () => (() => void) {
    return () => {
        const g = globalThis as Record<PropertyKey, unknown>;
        const seq = g[ACTIVE_STATE_SEQ];
        return () => {
            if (g[ACTIVE_STATE_SEQ] === seq && g[ACTIVE_STATE] === state) delete g[ACTIVE_STATE];
        };
    };
}

/** Test-only: drop the patch guard so a suite can install again. The
 *  caller owns restoring globalThis.fetch. `opts.anchor` overrides the
 *  module-load anchor (#1410) for suites that simulate a foreign scope. */
export function _resetForTest(opts: { anchor?: typeof globalThis.fetch } = {}): void {
    const g = globalThis as Record<PropertyKey, unknown>;
    delete g[INTERCEPT_FLAG];
    delete g[ACTIVE_STATE];
    delete g[ACTIVE_STATE_SEQ];
    signedDirectSeen.clear();
    resetFetchChainForTest(opts);
}
