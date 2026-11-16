// #3129: CloudCode / Antigravity `v1internal` wire dialect adapter (host-side).
//
// Antigravity's language_server + agy CLI do NOT talk plain Gemini. They POST to
// `/v1internal:{streamGenerateContent|generateContent|countTokens}` with a
// CloudCode OUTER ENVELOPE around the standard GenerateContentRequest, and they
// receive the response wrapped back in an envelope. Pure string/object shuffling
// here — no kernel involvement, no state. The kernel only ever sees the
// UNWRAPPED standard shape; this module is the dialect boundary.
//
//   request  { project, requestId, model, userAgent, requestType,
//              request: { contents, systemInstruction, tools, generationConfig,
//                        sessionId } }
//   response { response: <GenerateContentResponse>, traceId, metadata }
//
// The inner request.sessionId is constant across ALL windows/sessions (signed
// int64 of the FNV-1a empty-string hash, "-3750763034362895579") — it must NOT
// be used as conversation identity; extractConversationId does that instead.

import { normalizeSseLineEndings, finalizeSseLineEndings } from "./sse-util.js";

const V1_MODEL_ENDPOINTS = ["streamGenerateContent", "generateContent", "countTokens"] as const;

// The proxy sees these as `/bili/<origin>/v1internal:<ep>` (or bare
// `/v1internal:<ep>` in tests), so match the endpoint by suffix rather than by
// exact whole-path equality.
function isV1InternalPath(urlPath: string): boolean {
    const p = urlPath.split("?", 2)[0];
    return V1_MODEL_ENDPOINTS.some((e) => p.endsWith("/v1internal:" + e));
}

// The `/v1internal:*` path is Antigravity-exclusive (a standard Gemini call
// never lands there), so within it any object `request` field unambiguously
// marks a CloudCode envelope — no need to inspect the inner shape (which keeps
// countTokens variants whose inner may lack `contents` covered).
export function isV1InternalRequest(urlPath: string, parsed: unknown): boolean {
    if (!isV1InternalPath(urlPath)) return false;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const req = (parsed as Record<string, unknown>).request;
    return !!req && typeof req === "object" && !Array.isArray(req);
}

export function unwrapV1Internal(
    parsed: Record<string, unknown>,
): { inner: Record<string, unknown>; meta: Record<string, unknown>; model?: string } {
    const meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
        if (k === "request") continue;
        meta[k] = v;
    }
    const innerReq = parsed.request;
    const inner: Record<string, unknown> = innerReq && typeof innerReq === "object" && !Array.isArray(innerReq)
        ? { ...(innerReq as Record<string, unknown>) }
        : { contents: [] };
    const model = typeof meta.model === "string" ? meta.model : undefined;
    return { inner, meta, model };
}

export function wrapV1Internal(inner: Record<string, unknown>, meta: Record<string, unknown>): Record<string, unknown> {
    return { ...meta, request: inner };
}

const CONVERSATION_ID_RE = /Conversation ID:\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

function systemInstructionText(inner: Record<string, unknown>): string {
    const si = inner.systemInstruction;
    if (typeof si === "string") return si;
    if (si && typeof si === "object" && !Array.isArray(si)) {
        const parts = (si as { parts?: unknown }).parts;
        if (Array.isArray(parts)) {
            return parts.map((p) => {
                if (typeof p === "string") return p;
                if (p && typeof p === "object") {
                    const t = (p as { text?: unknown }).text;
                    return typeof t === "string" ? t : "";
                }
                return "";
            }).join("\n");
        }
    }
    return "";
}

// Stable per-conversation UUID from the `<user_information>` block; null when
// absent (pure-CLI sessions) so the caller falls back to content-prefix affinity.
export function extractConversationId(inner: Record<string, unknown>): string | null {
    const m = CONVERSATION_ID_RE.exec(systemInstructionText(inner));
    return m ? m[1] : null;
}

// Background utility call → verbatim passthrough, never enters the ACP state
// machine (#3129): requestType !== "agent", OR (no Conversation ID AND no tools
// AND a flash-lite micro-model).
export function isV1BackgroundSideRequest(meta: Record<string, unknown>, inner: Record<string, unknown>): boolean {
    const requestType = typeof meta.requestType === "string" ? meta.requestType : undefined;
    if (requestType !== undefined && requestType !== "agent") return true;
    if (extractConversationId(inner) !== null) return false;
    const tools = inner.tools;
    if (Array.isArray(tools) && tools.length > 0) return false;
    const model = typeof meta.model === "string" ? meta.model : "";
    return model.includes("flash-lite");
}

// #6963: a MAX_TOKENS-cut turn is continued by resending the SAME input plus a
// `continuationToken` — upstream binds the token to the exact bytes it saw on
// the minting leg and 400s any deviation ("pass the exact same input and
// conversation history as the initial request"). The token may ride the
// envelope meta, the inner request root, or inner.generationConfig, in
// camelCase or snake_case.
type V1Continuation = { location: "meta" | "inner" | "generationConfig"; key: string; value: string };

const CONTINUATION_TOKEN_KEYS = ["continuationToken", "continuation_token"] as const;

function readContinuationToken(obj: Record<string, unknown>): { key: string; value: string } | undefined {
    for (const key of CONTINUATION_TOKEN_KEYS) {
        const v = obj[key];
        if (typeof v === "string" && v.length > 0) return { key, value: v };
    }
    return undefined;
}

export function findV1Continuation(meta: Record<string, unknown>, inner: Record<string, unknown>): V1Continuation | undefined {
    const atMeta = readContinuationToken(meta);
    if (atMeta !== undefined) return { location: "meta", ...atMeta };
    const atInner = readContinuationToken(inner);
    if (atInner !== undefined) return { location: "inner", ...atInner };
    const gc = inner.generationConfig;
    if (gc && typeof gc === "object" && !Array.isArray(gc)) {
        const atGc = readContinuationToken(gc as Record<string, unknown>);
        if (atGc !== undefined) return { location: "generationConfig", ...atGc };
    }
    return undefined;
}

// Rebuild the continuation leg's inner from the cached minting-leg egress inner:
// contents / systemInstruction / tools / sessionId / the rest of
// generationConfig stay byte-identical to what upstream minted the token for;
// only the client's fresh maxOutputTokens (accumulated across legs — upstream
// tells the client to pass a HIGHER value) and the token itself are spliced
// back. A token located in the envelope meta is not spliced here: the relay
// re-wraps with the incoming leg's own meta, which already carries it.
export function spliceV1ContinuationInner(
    cachedInner: Record<string, unknown>,
    incomingInner: Record<string, unknown>,
    cont: V1Continuation,
): Record<string, unknown> {
    const out: Record<string, unknown> = { ...cachedInner };
    const incomingGc = incomingInner.generationConfig;
    const incomingGen = incomingGc && typeof incomingGc === "object" && !Array.isArray(incomingGc)
        ? (incomingGc as Record<string, unknown>)
        : {};
    const cachedGc = out.generationConfig;
    const hasCachedGen = cachedGc !== undefined && typeof cachedGc === "object" && !Array.isArray(cachedGc);
    const mergedGen: Record<string, unknown> = hasCachedGen ? { ...(cachedGc as Record<string, unknown>) } : {};
    // A stale token from a previous leg may sit at ANY location in the cached
    // inner — strip every spelling at both spots before splicing the fresh one
    // back, so the replayed inner carries exactly one token (or none, when it
    // rides the envelope meta). A leftover token at another location is itself
    // a deviation upstream would 400.
    for (const key of CONTINUATION_TOKEN_KEYS) {
        delete out[key];
        delete mergedGen[key];
    }
    for (const key of ["maxOutputTokens", "max_output_tokens"] as const) {
        const v = incomingGen[key];
        if (typeof v === "number" && Number.isFinite(v) && v > 0) mergedGen[key] = v;
    }
    if (cont.location === "generationConfig") mergedGen[cont.key] = cont.value;
    if (hasCachedGen || Object.keys(mergedGen).length > 0) out.generationConfig = mergedGen;
    if (cont.location === "inner") out[cont.key] = cont.value;
    return out;
}

// Inbound unwrap: pull the GenerateContentResponse out of `response`. No-op when
// not enveloped, so repeated application and non-v1 traffic pass through intact.
export function unwrapV1ResponseJson(json: string): string {
    try {
        const obj = JSON.parse(json) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            const resp = (obj as Record<string, unknown>).response;
            if (resp && typeof resp === "object" && !Array.isArray(resp)) {
                return JSON.stringify(resp);
            }
        }
    } catch { /* not JSON */ }
    return json;
}

function isV1ResponseEnvelope(json: string): boolean {
    try {
        const obj = JSON.parse(json) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            const resp = (obj as Record<string, unknown>).response;
            return resp !== undefined && typeof resp === "object" && !Array.isArray(resp);
        }
    } catch { /* not JSON */ }
    return false;
}

// Outbound wrap: bare GenerateContentResponse → envelope. Idempotent and
// pass-through for already-enveloped / non-JSON frames.
export function wrapV1ResponseJson(json: string): string {
    if (isV1ResponseEnvelope(json)) return json;
    try {
        const obj = JSON.parse(json) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            return JSON.stringify({ response: obj, traceId: "", metadata: {} });
        }
    } catch { /* not JSON */ }
    return json;
}

// Rewrite a single SSE frame's complete data payload: SSE joins multiple
// `data:` fields with newlines before dispatch. Only JSON objects needing an
// envelope change are touched; other payloads and non-data fields stay intact.
function mapDataPayload(frame: string, fn: (payload: string) => string): string {
    const lines = frame.split("\n");
    const data: string[] = [];
    let firstData = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("data:")) {
            if (firstData < 0) firstData = i;
            data.push(lines[i].charAt(5) === " " ? lines[i].slice(6) : lines[i].slice(5));
        }
    }
    if (firstData < 0) return frame;
    const payload = data.join("\n").trim();
    if (payload === "" || payload === "[DONE]") return frame;
    const mapped = fn(payload);
    if (mapped === payload) return frame;
    lines[firstData] = "data: " + mapped;
    return lines.filter((line, index) => index === firstData || !line.startsWith("data:")).join("\n");
}

export function unwrapV1SseFrame(frame: string): string {
    return mapDataPayload(frame, unwrapV1ResponseJson);
}

export function wrapV1SseFrame(frame: string): string {
    return mapDataPayload(frame, wrapV1ResponseJson);
}

// Inbound stream transform: unwrap each upstream v1internal frame (SSE) or the
// whole JSON body. Mode is decided by the first non-whitespace byte (`{` → one
// JSON document, otherwise SSE framed by blank lines), mirroring the google
// adapter's own heuristic. Pass-through when nothing is enveloped.
export function v1UnwrapStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buf = "";
    let mode: "unknown" | "sse" | "json" = "unknown";
    const flushSse = (controller: TransformStreamDefaultController<Uint8Array>) => {
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            controller.enqueue(encoder.encode(unwrapV1SseFrame(frame) + "\n\n"));
        }
    };
    return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            buf += decoder.decode(chunk, { stream: true });
            // #3331: CRLF-emitting upstreams would otherwise never produce a
            // `\n\n` boundary and every frame would hang in the buffer.
            buf = normalizeSseLineEndings(buf);
            if (mode === "unknown") {
                const lead = buf.replace(/^[\uFEFF\s]+/, "");
                if (lead.length > 0) mode = lead.startsWith("{") ? "json" : "sse";
            }
            if (mode === "sse") flushSse(controller);
        },
        flush(controller) {
            buf += decoder.decode();
            buf = finalizeSseLineEndings(buf);
            if (buf.trim().length === 0) return;
            if (mode === "json") controller.enqueue(encoder.encode(unwrapV1ResponseJson(buf.trim())));
            else controller.enqueue(encoder.encode(unwrapV1SseFrame(buf)));
        },
    }));
}
