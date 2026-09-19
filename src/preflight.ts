import {
    defaultCountTokens,
    viableRanges,
    type CompressionCore,
    type Config,
    type CoreMessage,
    type Prompts,
    type PackSurface,
} from "acp-kernel";
import { buildCompressSystemPrompt, parseCompressInput } from "./compress-tool.js";
import { IMAGE_PLACEHOLDER, imagePlaceholders } from "./image-note.js";
import { applyAbsorbView } from "./absorb.js";
import { applyRanges, normalizeRangeOrder, type RewriteCtx } from "./stream.js";
import { fetchWithTimeout, isTransientUpstreamError, replayMaxAttempts, replayBackoffMs, sleep, UpstreamHttpError } from "./fetch-util.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import { lastCompressSuffix, type Session } from "./session.js";
import { peekRegistryOutputLimit } from "./registry.js";

// #247: proactive pre-forward compression. When the session's real context
// (previous turn's upstream input_tokens) exceeds the current model's window
// (e.g. the user switched from a 1M-context model to a 260k one), the payload
// overflows at forward time and the reactive nudge can never fire — the
// request itself is rejected by the upstream, so the model never sees the
// nudge and every subsequent request overflows identically (stuck session).
// This module compresses the oldest compressible ranges first, via dedicated
// summarization calls sized to fit the smaller window, before the payload is
// forwarded.

export const MAX_PREFLIGHT_ROUNDS = 16;
const CHUNK_FRACTION = 0.6;
const MIN_CHUNK_TOKENS = 2000;
const MIN_SUMMARY_CHARS = 50;
// #853: thinking-on-by-default models spend the shared output budget on
// reasoning_content before any answer text (observed ~9.5k reasoning tokens on
// deepseek-flash, whose real output ceiling is 384k) — the old 8192 cap
// guaranteed content:"" + finish_reason:"length". 32k leaves ~3x headroom
// over the observed reasoning while still bounding runaway output.
// summaryPayload() clamps this per model against known models.dev ceilings
// (peekRegistryOutputLimit — warm cache first, bundled snapshot floor) so
// models with a smaller real cap are not over-asked.
const MAX_SUMMARY_OUTPUT_TOKENS = 32768;
// #574: bound on upstream summarization calls per invocation — the multi-range
// walk can otherwise spend a call per viable range in a block-dense history.
export const MAX_SUMMARY_CALLS_PER_PREFLIGHT = 16;

// #869 review: coverage bound of the two depth budgets above. One round folds
// ONE range and each fold removes at most CHUNK_FRACTION x window tokens (the
// per-call chunk budget), so MAX_PREFLIGHT_ROUNDS rounds cover an overshoot of
// at most MAX_PREFLIGHT_ROUNDS x CHUNK_FRACTION x window ~= 9.6x the window —
// a payload of up to ~10.6x the window in the best case. Real coverage is
// lower: a range smaller than the chunk budget saves less, and the #726
// halving worklist can spend several calls on one range without completing a
// fold. Beyond the bound the loop still exits cleanly — the fail-fast reports
// the post-fold size and the remaining compressible-range count, so an
// operator sees exactly how far the budget ran out. 16 is tuned to the
// incident class behind #868 (a 1.39x-window payload); it is a fixed depth,
// not scaled to the overshoot — scaling it is a separate design question.

export type PreflightProtocol = "anthropic" | "openai" | "responses";

export interface PreflightDeps {
    core: CompressionCore;
    session: Session;
    config: Config;
    /** Best-effort target below the hard window; never relax recent protection for headroom alone. */
    compressionTarget?: number;
    prompts: Prompts;
    surface?: PackSurface;
    protocol: PreflightProtocol;
    url: string;
    headers: Record<string, string>;
    model: string;
    proxyUrl?: string;
    signal?: AbortSignal;
    log: (level: string, msg: string) => void;
    /** Constant floor on the forwarded-payload size for this request (image bytes, #488). Folding only ever removes images, so adding this to every text estimate keeps the fit decision sound for multimodal payloads. */
    imageFloor?: number;
    /** Constant wire overhead for this request (system prompt + tool definitions, #470). Folding never removes it, so every fit decision must add it — otherwise the loop stops with "text fits" while the billed input still overflows. */
    wireOverhead?: number;
    /** #553: the caller knows this session's input size is unmeasured AND its
     *  raw history is untrusted (anonymous prefix-affinity session with
     *  lastInputTokens == 0 — a fork minted when an ACP compression broke the
     *  chain hash). Size judgments then use the char-count upper bound
     *  (estimateCoreMessagesUpper / char-based chunking) instead of the
     *  optimistic chars/4 estimator, which undercounts code/JSON replays by up
     *  to ~4x and would let an over-window payload slip through uncompressed. */
    unknownBaseline?: boolean;
}

export type PreflightFailureKind = "upstream" | "exhausted" | "aborted";

export interface PreflightFailure {
    kind: PreflightFailureKind;
    /** A temporary transport failure, not evidence that this context cannot be compressed. */
    retryable?: boolean;
    /** Upstream HTTP status when kind === "upstream" and the failure was an HTTP response. */
    status?: number;
    /** Human-readable cause (safe to surface to the client). */
    detail: string;
}

// #726: a summarization call can return HTTP 200 yet carry no usable summary
// text (in-stream error event, truncated stream, empty completion). The
// unusable branch carries a diagnosis of what the body actually contained so
// it is logged and surfaced in the fail-fast message instead of the generic
// "summary too short".
type SummaryOutcome = { summary: string } | { unusable: string };

export interface PreflightResult {
    compressedRanges: number;
    savedTokens: number;
    /** Token estimate of the final (post-fold) payload, from the payload
     *  itself — NOT floored on the session's lastInputTokens, which can be
     *  stale (e.g. a double-counted usage report, #300). The caller uses it
     *  to decide whether forwarding as-is is actually safe. */
    payloadEstimate: number;
    /** Compressible ranges still visible in the kernel's final view after the
     *  walk stopped — how much foldable headroom a deeper budget would find
     *  (0 when nothing foldable remains). Surfaced in the fail-fast message
     *  so an operator can see why the payload is still over the window
     *  (#869 review). */
    rangesRemaining: number;
    /** Whether the final payload fits the window, judged with the same
     *  measure the loop used: the optimistic token estimate for
     *  measured-baseline sessions (#300 — a stale HIGH baseline must not
     *  fail-fast a fitting payload), the char-count upper bound for
     *  unknown-baseline ones (#553 — the optimistic figure can undershoot by
     *  up to ~4x on dense replays, so only the upper bound proves a fit). */
    fitsWindow: boolean;
    /** Why the loop stopped while the payload still overflows the window.
     *  Undefined when the payload fits. */
    failure?: PreflightFailure;
}

function refMaps(messages: CoreMessage[], state: Session["state"]): { refToIdx: Map<string, number>; idxToRef: Map<number, string> } {
    const refToIdx = new Map<string, number>();
    const idxToRef = new Map<number, string>();
    const byRaw = state.messageRefs?.byRaw ?? {};
    messages.forEach((m, i) => {
        const ref = byRaw[m.id];
        if (!ref) return;
        if (!refToIdx.has(ref)) refToIdx.set(ref, i);
        idxToRef.set(i, ref);
    });
    return { refToIdx, idxToRef };
}

function refNum(ref: string): number {
    return Number(ref.replace(/\D/g, "")) || 0;
}

// CJK-aware: the fast chars/4 estimator undercounts CJK ~4× (CJK is ~1
// token/char), which made the fit check believe an oversized CJK payload
// already fit and skip compression. defaultCountTokens counts CJK per-char.
export function estimateCoreMessages(messages: CoreMessage[]): number {
    let tokens = 0;
    for (const m of messages) tokens += defaultCountTokens(m.text ?? "");
    return tokens;
}

// #554: side requests bypass the pipeline (#388) and are forwarded VERBATIM,
// so their fit decision must be made on the RAW client body — the kernel view
// is empty on that path (processedMessages: []). Walks every string leaf of
// the parsed body through the same CJK-aware defaultCountTokens; binary-
// carrying fields (base64 image data, data-URLs) are excluded because
// imageTokensInParsedBody charges those separately. Slightly overcounts (ids,
// roles, structural strings) — a conservative bias is right for a guard that
// fails closed.
const NON_TEXT_BODY_KEYS = new Set(["data", "url", "b64_json", "file_data"]);

export function estimateRawBodyTokens(parsed: unknown): number {
    let tokens = 0;
    const walk = (value: unknown, key?: string): void => {
        if (typeof value === "string") {
            if (!key || !NON_TEXT_BODY_KEYS.has(key)) tokens += defaultCountTokens(value);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) walk(item, key);
            return;
        }
        if (value && typeof value === "object") {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k);
        }
    };
    walk(parsed);
    return tokens;
}

// #553: upper-bound variant of estimateCoreMessages — every character counts
// as one token. A BPE token covers >=1 char (Latin/code) and CJK is already
// ~1 token/char, so this never undershoots the real count, unlike
// defaultCountTokens' 4-chars-per-token for non-CJK. Used only for anonymous
// prefix-affinity sessions without a measured baseline (a fork mints a new
// session id with lastInputTokens == 0 after an ACP compression breaks the
// chain hash), where an undershoot lets an over-window payload slip past the
// trigger and the fit checks and get forwarded raw.
export function estimateCoreMessagesUpper(messages: CoreMessage[]): number {
    let chars = 0;
    for (const m of messages) chars += (m.text ?? "").length;
    return chars;
}

function spanUnitsOf(messages: CoreMessage[], startIdx: number, endIdx: number, countText: (text: string) => number): number {
    let units = 0;
    for (let i = startIdx; i <= endIdx && i < messages.length; i++) {
        units += countText(messages[i].text ?? "");
    }
    return units;
}

// Message-level splitChunks cannot shrink a span dominated by one huge
// message (e.g. a megabyte tool result); split its rendered content into
// token-budgeted slices so every summarization call stays inside the window.
function splitSummaryContent(content: string, budget: number, countTokens: (text: string) => number): string[] {
    const chunks: string[] = [];
    let offset = 0;
    while (offset < content.length) {
        let low = offset + 1;
        let high = content.length;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (countTokens(content.slice(offset, mid)) <= budget) low = mid;
            else high = mid - 1;
        }
        chunks.push(content.slice(offset, low));
        offset = low;
    }
    return chunks;
}

// minUnits: never close a chunk below this many countText units while more
// messages remain — a chunk under config.compress.minCompressRange chars is
// rejected by applyCompression, so such a chunk would waste a whole round.
// (The char-count regime needs this because its budget can be far smaller
// than minCompressRange on small windows.)
function splitChunks(
    messages: CoreMessage[],
    startIdx: number,
    endIdx: number,
    budget: number,
    minUnits: number,
    countText: (text: string) => number = defaultCountTokens,
): Array<[number, number]> {
    const chunks: Array<[number, number]> = [];
    let cur = startIdx;
    while (cur <= endIdx) {
        let total = 0;
        let last = cur;
        for (let i = cur; i <= endIdx; i++) {
            const t = countText(messages[i].text ?? "");
            if (total + t > budget && i > cur && (minUnits <= 0 || total >= minUnits)) break;
            total += t;
            last = i;
        }
        chunks.push([cur, last]);
        cur = last + 1;
    }
    return chunks;
}

// #853: the summary max_tokens for a model — the 32k default, clamped down to
// the model's known output ceiling when models.dev reports a smaller one.
// Host comes from the upstream URL so a known provider's namespaced entry
// wins over the cross-provider scan; the registry cache is pre-warmed with
// the bundled snapshot at module load, so this never fetches or blocks.
function safeHost(url: string): string | undefined {
    try {
        return new URL(url).host;
    } catch {
        return undefined;
    }
}
function summaryOutputTokens(model: string, host?: string): number {
    const known = peekRegistryOutputLimit(model, host);
    return known === undefined ? MAX_SUMMARY_OUTPUT_TOKENS : Math.min(MAX_SUMMARY_OUTPUT_TOKENS, known);
}

// #987: the summary call's own payload must fit the model window too. Most
// upstreams enforce input + output <= window; asking for 32k of output on a
// small (often learned) window makes them answer with an EMPTY completion
// instead of an error — every summary attempt reads as unusable and preflight
// dead-ends on exactly the sessions this module exists to save. Clamp to the
// headroom when it is smaller than the registry/default cap above.
const SUMMARY_SCRAFFOLDING_TOKENS = 256;
const MIN_CLAMPED_SUMMARY_OUTPUT = 64;
function windowClampedOutput(base: number, window: number | undefined, system: string, content: string): number {
    if (!window || window <= 0) return base;
    const input = defaultCountTokens(system) + defaultCountTokens(content) + SUMMARY_SCRAFFOLDING_TOKENS;
    const headroom = window - input;
    if (headroom <= 0) return base; // input alone does not fit — clamping cannot save the call
    return Math.min(base, Math.max(MIN_CLAMPED_SUMMARY_OUTPUT, headroom));
}

function summaryPayload(protocol: PreflightProtocol, model: string, system: string, content: string, stream: boolean, includeMaxOutputTokens: boolean, host?: string, window?: number): Record<string, unknown> {
    const maxOutputTokens = windowClampedOutput(summaryOutputTokens(model, host), window, system, content);
    if (protocol === "anthropic") {
        return { model, max_tokens: maxOutputTokens, system, messages: [{ role: "user", content }], stream };
    }
    if (protocol === "openai") {
        return { model, max_tokens: maxOutputTokens, messages: [{ role: "system", content: system }, { role: "user", content }], stream };
    }
    // #488: codex relays reject Responses calls without store:false ("Store must be set to false").
    // #663: max_output_tokens is optional — omit it once the upstream has
    // rejected the parameter (learned per URL+model); the model's default
    // output cap then applies.
    const payload: Record<string, unknown> = { model, instructions: system, input: [{ role: "user", content }], stream, store: false };
    if (includeMaxOutputTokens) payload.max_output_tokens = maxOutputTokens;
    return payload;
}

// #626: some upstreams (ChatGPT-login codex backend) reject non-stream calls
// outright with 400 "Stream must be set to true". Match the rejection broadly
// enough to cover phrasing variants, narrowly enough that an unrelated 400
// mentioning neither word never triggers a pointless stream retry.
const STREAM_REQUIRED_RE = /\bstream\b[^\n]{0,60}\btrue\b/i;

// #663: the same ChatGPT-login codex backend rejects the Responses
// max_output_tokens parameter outright with 400 {"detail":"Unsupported
// parameter: max_output_tokens"}. Matching the parameter name in a 400 body
// is narrow enough — a 400 that names the parameter is about the parameter —
// and robust to phrasing variants; omitting an optional parameter is always
// a safe fallback (the model's default output cap applies).
const MAX_OUTPUT_TOKENS_REJECTED_RE = /\bmax_output_tokens\b/i;

// #663: per-endpoint learning of the max_output_tokens rejection. Keyed by
// upstream URL + model (persisted with the session metadata, like #626's
// stream flag) because the rejection is per-endpoint: a session can switch
// models mid-conversation, and a model that accepts the limit must keep its
// (model-clamped) summary cap.
function noMaxOutputTokensKey(deps: PreflightDeps): string {
    return `${deps.url}\u0000${deps.model}`;
}

function hasLearnedNoMaxOutputTokens(deps: PreflightDeps): boolean {
    const learned = deps.session.metadata.preflightNoMaxOutputTokens;
    return typeof learned === "object" && learned !== null && (learned as Record<string, unknown>)[noMaxOutputTokensKey(deps)] === true;
}

function rememberNoMaxOutputTokens(deps: PreflightDeps): void {
    const learned = deps.session.metadata.preflightNoMaxOutputTokens;
    const map = (typeof learned === "object" && learned !== null ? learned : {}) as Record<string, unknown>;
    map[noMaxOutputTokensKey(deps)] = true;
    deps.session.metadata.preflightNoMaxOutputTokens = map;
}

// #663: request-shape-specific headers that must NOT ride the independently
// constructed summary call. The main Codex request carries
// x-openai-internal-codex-responses-lite, which the backend only accepts when
// the body has reasoning.context: all_turns. The summary body is built
// independently (no reasoning field), so carrying the header over makes the
// backend reject it (400 "…requires `reasoning.context` to be `all_turns`").
// The original model request keeps the header and its reasoning fields; only
// the side summary call drops it. Auth/routing headers are preserved.
const SUMMARY_STRIP_HEADERS = new Set(["x-openai-internal-codex-responses-lite"]);

function summaryHeaders(deps: PreflightDeps): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(deps.headers)) {
        if (SUMMARY_STRIP_HEADERS.has(k.toLowerCase())) continue;
        headers[k] = v;
    }
    return headers;
}

// #780: extraction carries a validity contract — it must separate "the stream
// delivered a complete summary" from "the stream died mid-delivery". The naive
// accumulator conflated the two: a gateway truncation (#764: half-line data,
// no [DONE]) left a partial `out` that was persisted as a complete tier-1
// summary — silently worse than an empty one, because #727's diagnosis chain
// only fires on empty results. Rejection rules:
//   - a data line that fails to parse is corruption (badFrame), not noise to skip
//   - failure terminals (response.incomplete/.failed/.error, generic error /
//     bare {error}) invalidate any text accumulated before them
//   - responses requires the spec-mandatory response.completed terminal; its
//     response object reuses the JSON extractor and is authoritative — once
//     seen it is trusted as-is (no framing check on top, so gateways that close
//     right after the final event without a trailing blank line are safe)
//   - anthropic/openai do NOT require finish_reason/[DONE]/message_stop (#764:
//     real gateways omit these occasionally); the body must at least end on a
//     frame boundary (\n\n, CRLF-tolerant), else it may have been cut mid-frame
// A rejected stream returns "" so requestSummary routes it into
// diagnoseEmptySummary + the #726 halving/cooldown chain.
export function extractSummaryFromSse(protocol: PreflightProtocol, text: string): string {
    const framed = /\r?\n\r?\n$/.test(text);
    let out = "";
    let terminalText = "";
    let completed = false;
    let invalid = false;
    let badFrame = false;
    let eventType = "";
    for (const line of text.split("\n")) {
        if (line.trim() === "") {
            eventType = "";
            continue;
        }
        if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
            continue;
        }
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let obj: unknown;
        try {
            obj = JSON.parse(payload);
        } catch {
            badFrame = true;
            continue;
        }
        if (!obj || typeof obj !== "object") {
            badFrame = true;
            continue;
        }
        const o = obj as Record<string, unknown>;
        const type = typeof o.type === "string" ? o.type : eventType;
        if (type === "error" || type === "response.incomplete" || type === "response.failed" || type === "response.error" || (!type && o.error && typeof o.error === "object")) {
            invalid = true;
            continue;
        }
        if (protocol === "anthropic") {
            if (type === "content_block_delta") {
                const d = o.delta as Record<string, unknown> | undefined;
                if (d && d.type === "text_delta" && typeof d.text === "string") out += d.text;
            }
        } else if (protocol === "openai") {
            const choices = o.choices;
            if (Array.isArray(choices) && choices.length > 0) {
                const delta = (choices[0] as Record<string, unknown>).delta as Record<string, unknown> | undefined;
                if (delta && typeof delta.content === "string") out += delta.content;
            }
        } else {
            if (type === "response.output_text.delta" && typeof o.delta === "string") {
                out += o.delta;
            } else if (type === "response.output_text.done" && typeof o.text === "string") {
                terminalText += o.text;
            } else if (type === "response.output_item.done" && o.item && typeof o.item === "object") {
                terminalText += extractSummaryText("responses", { output: [o.item] });
            } else if (type === "response.completed" && o.response && typeof o.response === "object") {
                completed = true;
                const full = extractSummaryText("responses", o.response as Record<string, unknown>);
                if (full) terminalText = full;
            }
        }
    }
    if (invalid) return "";
    if (protocol === "responses") return completed ? terminalText || out : "";
    if (badFrame || !framed) return "";
    return out || terminalText;
}

function extractSummaryText(protocol: PreflightProtocol, json: Record<string, unknown>): string {
    if (protocol === "anthropic") {
        const content = json.content;
        if (!Array.isArray(content)) return "";
        return content
            .map((c) => (c && typeof c === "object" && (c as Record<string, unknown>).type === "text" && typeof (c as Record<string, unknown>).text === "string" ? (c as Record<string, string>).text : ""))
            .join("");
    }
    if (protocol === "openai") {
        const choices = json.choices;
        if (!Array.isArray(choices) || choices.length === 0) return "";
        const msg = (choices[0] as Record<string, unknown>).message;
        if (!msg || typeof msg !== "object") return "";
        const c = (msg as Record<string, unknown>).content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
            return c.map((p) => (p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string" ? (p as Record<string, string>).text : "")).join("");
        }
        return "";
    }
    if (typeof json.output_text === "string") return json.output_text;
    const output = json.output;
    if (!Array.isArray(output)) return "";
    return output
        .map((o) => (o && typeof o === "object" ? (o as Record<string, unknown>).content : undefined))
        .filter((c): c is unknown[] => Array.isArray(c))
        .flatMap((c) => c)
        .map((p) => (p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string" ? (p as Record<string, string>).text : ""))
        .join("");
}

// #726: an HTTP-200 summarization body can still be a rejection — the upstream
// may end its SSE stream with an error event (`error`, `response.failed`) or an
// incomplete response, or answer with a bare JSON error object. Without this
// scan such bodies are silently discarded and the only trace is "summary too
// short (0 chars)" with no way to tell size-driven from systemic failures.
function extractStreamError(o: Record<string, unknown>): string | null {
    const t = typeof o.type === "string" ? o.type : undefined;
    if (t === "error") {
        const e = o.error;
        if (e && typeof e === "object") {
            const eo = e as Record<string, unknown>;
            return `the upstream reported an in-stream error: ${typeof eo.message === "string" ? eo.message : JSON.stringify(eo).slice(0, 200)}`;
        }
        if (typeof o.message === "string") return `the upstream reported an in-stream error: ${o.message}`;
        return "the upstream reported an in-stream error";
    }
    if (t === "response.failed" || t === "response.error") {
        const resp = o.response;
        if (resp && typeof resp === "object") {
            const e = (resp as Record<string, unknown>).error;
            if (e && typeof e === "object") {
                const eo = e as Record<string, unknown>;
                const code = typeof eo.code === "string" ? ` (${eo.code})` : "";
                return `the upstream stream ended with a failed response${code}: ${typeof eo.message === "string" ? eo.message : JSON.stringify(eo).slice(0, 200)}`;
            }
        }
        return "the upstream stream ended with a failed response";
    }
    if (t === "response.incomplete") {
        const resp = (o.response ?? {}) as Record<string, unknown>;
        const status = typeof resp.status === "string" ? resp.status : "unknown";
        const e = resp.error as Record<string, unknown> | undefined;
        const msg = e && typeof e.message === "string" ? ` (${e.message})` : "";
        return `the upstream stream ended incomplete (status=${status}${msg})`;
    }
    if (!t && o.error && typeof o.error === "object") {
        const eo = o.error as Record<string, unknown>;
        return `the upstream reported an error: ${typeof eo.message === "string" ? eo.message : JSON.stringify(eo).slice(0, 200)}`;
    }
    return null;
}

export function diagnoseEmptySummary(text: string, json?: unknown): string {
    if (json && typeof json === "object") {
        const err = extractStreamError(json as Record<string, unknown>);
        if (err) return err;
    }
    let sseEvents = 0;
    let halfLines = 0;
    let firstPayload = "";
    for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        if (!firstPayload) firstPayload = payload.slice(0, 200);
        let obj: unknown;
        try {
            obj = JSON.parse(payload);
        } catch {
            halfLines += 1;
            continue;
        }
        if (!obj || typeof obj !== "object") {
            halfLines += 1;
            continue;
        }
        sseEvents += 1;
        const err = extractStreamError(obj as Record<string, unknown>);
        if (err) return err;
    }
    // #780: the extractor rejects mid-frame-truncated streams (#764 shape) — say so
    // explicitly instead of the generic no-text message, which reads like an
    // upstream that simply never answered with a summary.
    if (halfLines > 0 && sseEvents === 0) return `the upstream stream had ${halfLines} incomplete data line(s) and no parseable events (stream appears truncated)`;
    if (sseEvents > 0) {
        const truncated = halfLines > 0 || !/\r?\n\r?\n$/.test(text) ? ` (stream appears truncated: ${halfLines > 0 ? `${halfLines} incomplete data line(s)` : "no final frame terminator"})` : "";
        return `the upstream stream carried ${sseEvents} SSE event(s) but no summary text${truncated} (first event: ${firstPayload})`;
    }
    const trimmed = text.trim();
    if (!trimmed) return "the upstream returned an empty body";
    // #987: a plain-JSON completion with empty content is NOT "a non-SSE body" —
    // name what it was, with the finish reason and the model id the upstream
    // answered as (relays answer under their real model while the request named
    // an alias — that mismatch is the actionable clue).
    const detail = json && typeof json === "object" ? emptyCompletionDetail(json as Record<string, unknown>) : null;
    if (detail !== null) return `the upstream returned a plain-JSON completion with empty content${detail}`;
    return `the upstream returned a non-SSE body with no summary text (first 200 bytes: ${trimmed.slice(0, 200)})`;
}

// Returns null when the parsed body is not a recognizable completion shape, so
// unrelated JSON keeps the generic non-SSE diagnosis.
function emptyCompletionDetail(json: Record<string, unknown>): string | null {
    const parts: string[] = [];
    const choices = json.choices;
    if (Array.isArray(choices) && choices.length > 0) {
        const first = choices[0];
        if (!first || typeof first !== "object") return null;
        const fr = (first as Record<string, unknown>).finish_reason;
        if (typeof fr === "string") parts.push(`finish_reason=${fr}`);
    } else if (typeof json.stop_reason === "string") {
        parts.push(`stop_reason=${json.stop_reason}`);
    } else if (Array.isArray(json.output)) {
        if (typeof json.status === "string") parts.push(`status=${json.status}`);
    } else {
        return null;
    }
    if (typeof json.model === "string") parts.push(`answered as model=${json.model}`);
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

async function summarizeRange(deps: PreflightDeps, content: string, startRef: string, endRef: string): Promise<SummaryOutcome> {
    const system =
        buildCompressSystemPrompt(deps.prompts, deps.surface?.promptSections) +
        `\n\nTASK: The conversation segment below (messages ${startRef}–${endRef}) must be compressed because the session context exceeds the current model's window. Write a tier-1 compression summary of the segment following every rule above. Output ONLY the summary text — no preamble, no closing remarks, no tool calls.`;
    // #626: the session remembers upstreams that require stream:true, so the
    // extra 400 round-trip is paid at most once per session (persisted with
    // the session metadata). #663: likewise, per URL+model, upstreams that
    // reject the max_output_tokens parameter. Each capability is learned at
    // most once (guarded below), so the compatibility retries are bounded:
    // at most one extra attempt per capability, in either rejection order.
    let stream = deps.session.metadata.preflightStreamSummary === true;
    let includeMaxOutputTokens = !(deps.protocol === "responses" && hasLearnedNoMaxOutputTokens(deps));
    for (;;) {
        try {
            return await requestSummary(deps, system, content, stream, includeMaxOutputTokens);
        } catch (err) {
            if (err instanceof UpstreamHttpError && err.status === 400) {
                let adapted = false;
                if (!stream && STREAM_REQUIRED_RE.test(err.body)) {
                    deps.session.metadata.preflightStreamSummary = true;
                    stream = true;
                    adapted = true;
                    deps.log("info", "[preflight] upstream requires stream for summaries; retrying with SSE (learned for this session)");
                }
                if (deps.protocol === "responses" && includeMaxOutputTokens && MAX_OUTPUT_TOKENS_REJECTED_RE.test(err.body)) {
                    rememberNoMaxOutputTokens(deps);
                    includeMaxOutputTokens = false;
                    adapted = true;
                    deps.log("info", `[preflight] upstream rejects max_output_tokens for summaries (model=${deps.model}); retrying without it (learned for this session+upstream+model)`);
                }
                if (adapted) continue;
            }
            throw err;
        }
    }
}

const TRANSIENT_SUMMARY_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET"]);
const SUMMARY_DIAGNOSTIC_CODES = new Set([
    ...TRANSIENT_SUMMARY_CODES, "ETIMEDOUT", "ENOTFOUND", "UND_ERR_ABORTED", "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "Z_DATA_ERROR", "Z_BUF_ERROR", "Z_MEM_ERROR",
    "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

class SummaryTransportError extends Error {
    readonly retryable: boolean;
    constructor(stage: "request" | "response body", error: unknown, attempts: number) {
        let code: string | undefined;
        let aborted = false;
        let cause: unknown = error;
        for (let depth = 0; depth < 6 && cause && typeof cause === "object"; depth++) {
            const value = cause as { name?: unknown; code?: unknown; cause?: unknown };
            if (value.name === "AbortError" || value.name === "TimeoutError") aborted = true;
            if (!code && typeof value.code === "string" && SUMMARY_DIAGNOSTIC_CODES.has(value.code)) code = value.code;
            cause = value.cause;
        }
        const name = error instanceof Error && ["Error", "TypeError", "AbortError", "TimeoutError"].includes(error.name) ? error.name : "Error";
        super(`summary ${stage} failed (${name}${code ? `, code=${code}` : ""}; ${attempts} attempt${attempts === 1 ? "" : "s"})`);
        this.name = "SummaryTransportError";
        this.retryable = !aborted && code !== undefined && TRANSIENT_SUMMARY_CODES.has(code);
    }
}

async function requestSummaryBody(deps: PreflightDeps, body: string): Promise<string> {
    const maxAttempts = replayMaxAttempts();
    for (let attempt = 1; ; attempt++) {
        deps.signal?.throwIfAborted();
        let clearTimer: (() => void) | undefined;
        let stage: "request" | "response body" = "request";
        let retryDetail: string;
        try {
            const result = await fetchWithTimeout(deps.url, {
                method: "POST",
                headers: { "content-type": "application/json", ...summaryHeaders(deps) },
                body,
                dispatcher: proxyDispatcher(deps.proxyUrl),
            }, undefined, deps.signal);
            clearTimer = result.clearTimer;
            stage = "response body";
            const text = await result.response.text();
            deps.signal?.throwIfAborted();
            if (!result.response.ok) throw new UpstreamHttpError(result.response.status, text, attempt);
            return text;
        } catch (err) {
            deps.signal?.throwIfAborted();
            const failure = err instanceof UpstreamHttpError ? err : new SummaryTransportError(stage, err, attempt);
            const retryable = failure instanceof UpstreamHttpError
                ? isTransientUpstreamError(failure.status, failure.body)
                : failure.retryable;
            if (!retryable || attempt >= maxAttempts) throw failure;
            retryDetail = failure instanceof UpstreamHttpError ? `HTTP ${failure.status}` : failure.message;
        } finally {
            clearTimer?.();
        }
        const delayMs = replayBackoffMs(attempt);
        deps.log("warn", `[preflight] summary attempt ${attempt} got ${retryDetail}; retrying in ${delayMs}ms${lastCompressSuffix(deps.session.lastCompress)}`);
        await sleep(delayMs, deps.signal);
    }
}

async function requestSummary(deps: PreflightDeps, system: string, content: string, stream: boolean, includeMaxOutputTokens: boolean): Promise<SummaryOutcome> {
    const text = await requestSummaryBody(deps, JSON.stringify(summaryPayload(deps.protocol, deps.model, system, content, stream, includeMaxOutputTokens, safeHost(deps.url), deps.config.modelContextLimit)));
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }
    // Streaming bodies are SSE, but a non-conforming upstream may answer a
    // stream:true call with plain JSON — accept either shape.
    const summary = (json && typeof json === "object"
        ? extractSummaryText(deps.protocol, json as Record<string, unknown>)
        : stream
            ? extractSummaryFromSse(deps.protocol, text)
            : "").trim();
    if (!json && !stream) {
        deps.log("warn", `[preflight] summary response was not JSON: ${text.slice(0, 200)}`);
    }
    if (summary.length < MIN_SUMMARY_CHARS) {
        const diagnosis = diagnoseEmptySummary(text, json);
        deps.log("warn", `[preflight] summary too short (${summary.length} chars): ${diagnosis}`);
        return { unusable: diagnosis };
    }
    return { summary };
}

const ABORTED_FAILURE: PreflightFailure = { kind: "aborted", detail: "the client disconnected during preflight compression" };

// #330: the soft-protected recent zone (preserveRecentMessages /
// preserveRecentTokens / most-recent user message) can cover ALL foldable
// content when one large recent message pushes the payload over a small
// window — preflight then 502s forever with no recovery path. Under overflow
// the soft zone is a preference, not a constraint: relax it to zero so its
// oldest content becomes foldable. The hard protectedTools exclusion is
// computed independently of preserveRecent* and still applies.
function relaxedConfig(config: Config): Config {
    return { ...config, preserveRecentMessages: 0, preserveRecentTokens: 0 };
}

// #330: the preflight's fit check must reflect the durable payload, not the
// per-turn emergency-truncate side effect — that node would trim the very tool
// output overflowing the window, making currentTokens undershoot and the loop
// break before the soft zone is relaxed. Inflate the window so usage stays
// below truncate.threshold; compressible ranges derive from the protected zone,
// not usage, so this is safe.
function noEmergencyTruncate(config: Config): Config {
    return { ...config, modelContextLimit: config.modelContextLimit * 100 };
}

export async function preflightCompress(deps: PreflightDeps, messages: CoreMessage[]): Promise<PreflightResult> {
    const limit = deps.config.modelContextLimit;
    let target = Math.min(limit, deps.compressionTarget ?? limit);
    const result: PreflightResult = { compressedRanges: 0, savedTokens: 0, payloadEstimate: estimateCoreMessages(messages) + (deps.imageFloor ?? 0) + (deps.wireOverhead ?? 0), rangesRemaining: 0, fitsWindow: true };
    if (limit <= 0) return result;
    const budget = Math.max(MIN_CHUNK_TOKENS, Math.floor(limit * CHUNK_FRACTION));
    // applyCompression rejects ranges below config.compress.minCompressRange
    // chars, so never spend a summarization call on a chunk that can't apply.
    const minChars = deps.config.compress.minCompressRange;
    // The fit check runs on the real post-fold payload size, not on
    // stats.lastInputTokens: a session without a measured baseline
    // (lastInputTokens == 0 — fresh, or forked/reloaded after an ACP
    // compression broke prefix affinity, #553) starts at 0 while still
    // carrying a full raw history that may overflow the window.
    // #553: for an unknown-baseline session the optimistic chars/4 estimate can
    // be off by up to ~4x on code/JSON replays, so judge those by the char-count
    // upper bound (never undershoots). The regime is caller-decided and fixed
    // for the whole loop — lastInputTokens mutates mid-loop and must not flip it.
    const baselineKnown = deps.unknownBaseline !== true;
    const countText = baselineKnown ? defaultCountTokens : (text: string): number => text.length;
    let currentTokens = baselineKnown ? deps.session.stats.lastInputTokens : estimateCoreMessagesUpper(messages);
    let finalUpper = baselineKnown ? 0 : estimateCoreMessagesUpper(messages);
    let startTokens = -1;
    let failure: PreflightFailure | undefined;
    let lastUnusableDetail: string | undefined;
    let activeConfig = deps.config;
    let relaxed = false;
    const relaxedExhaustedDetail =
        `the payload still exceeds the window after folding everything compressible, including the soft-protected recent zone ` +
        `(last ${deps.config.preserveRecentMessages} messages + most recent user message), which was relaxed under overflow; hard protectedTools remain excluded. ` +
        `Raise the model context window or restart the session to recover.`;
    // #574/#569: walk every viable range oldest-first until one folds; declare
    // exhaustion only after all are tried (legacy stopped at the first bad range).
    // skipSet keys are stable across folds because refs are content-fingerprinted,
    // so a range found unusable is never retried within this invocation.
    const skipSet = new Set<string>();
    let summaryCalls = 0;
    let budgetHit = false;
    let rangesTried = 0;
    let rangesRemaining = 0;
    for (let round = 0; round < MAX_PREFLIGHT_ROUNDS; round++) {
        if (deps.signal?.aborted) {
            failure = ABORTED_FAILURE;
            break;
        }
        // Re-run the pipeline each round: a successful compress hides its
        // range behind a new block, changing the visible view; refs stay
        // stable per-session snapshots (#387), but which ranges are
        // compressible under them does not.
        const turn = deps.core.processTurn({
            messages,
            state: deps.session.state,
            config: noEmergencyTruncate(activeConfig),
            tokenCount: currentTokens,
            renderTags: "text-only",
        });
        deps.session.state = turn.state;
        // Absorbed pairs are hidden on the wire, so the fit check must see the
        // same reduced payload prepare* will actually forward.
        turn.messages = applyAbsorbView(turn.messages, turn.state, activeConfig, currentTokens);
        // Floor on the session's measured input baseline: the upstream's
        // input_tokens also covers the system prompt + tool definitions, which
        // are not in turn.messages, so the direct estimate can undershoot.
        currentTokens = Math.max(deps.session.stats.lastInputTokens, estimateCoreMessages(turn.messages) + (deps.imageFloor ?? 0) + (deps.wireOverhead ?? 0));
        if (!baselineKnown) {
            // #558-merge: the upper-bound regime also carries the image/wire
            // floors — they are real billed costs the fold can never remove
            // (#470/#488 postdate this PR's fork point).
            finalUpper = estimateCoreMessagesUpper(turn.messages) + (deps.imageFloor ?? 0) + (deps.wireOverhead ?? 0);
            currentTokens = Math.max(currentTokens, finalUpper);
        }
        // The caller's forward/fail-fast gate uses the payload's own estimate
        // (the floor can be stale — see PreflightResult.payloadEstimate).
        result.payloadEstimate = estimateCoreMessages(turn.messages) + (deps.imageFloor ?? 0) + (deps.wireOverhead ?? 0);
        if (startTokens < 0) startTokens = currentTokens;
        if (currentTokens < target) break;
        const ranges = viableRanges(turn.nudge?.compressibleRanges ?? []);
        rangesRemaining = ranges.length;
        if (ranges.length === 0) {
            // #330: nothing foldable outside the soft-protected recent zone.
            // Relax the soft zone (oldest-first within it) and retry — the hard
            // protectedTools exclusion still applies. Gate on the payload's own
            // estimate (not currentTokens, which is floored by a possibly-stale
            // lastInputTokens from a prior model): if the real payload already
            // fits, stop instead of folding protected content.
            if (!relaxed && (baselineKnown ? result.payloadEstimate : finalUpper) >= limit) {
                activeConfig = relaxedConfig(deps.config);
                relaxed = true;
                target = limit;
                // #575-merge: the summarization budget counts per protection
                // regime — reset it on relax, else bad summaries burned under
                // normal protection can starve the relaxed walk entirely and
                // reintroduce the #330 unrecoverable stall.
                summaryCalls = 0;
                budgetHit = false;
                deps.log("warn", "[preflight] no compressible ranges outside the protected recent zone; relaxing soft protection (preserveRecentMessages/Tokens -> 0) and retrying");
                continue;
            }
            failure = { kind: "exhausted", detail: relaxed ? relaxedExhaustedDetail : "no compressible ranges remain in the conversation" };
            break;
        }
        const ordered = [...ranges].sort((a, b) => refNum(a.startRef) - refNum(b.startRef));
        let appliedThisRound = 0;
        for (const range of ordered) {
            if (currentTokens < target) break;
            if (deps.signal?.aborted) {
                failure = ABORTED_FAILURE;
                break;
            }
            if (budgetHit) break;
            const skipKey = `${range.startRef}:${range.endRef}`;
            if (skipSet.has(skipKey)) continue;
            const { refToIdx } = refMaps(messages, deps.session.state);
            const startIdx = refToIdx.get(range.startRef);
            const endIdx = refToIdx.get(range.endRef);
            if (startIdx === undefined || endIdx === undefined || startIdx > endIdx) {
                skipSet.add(skipKey);
                continue;
            }
            rangesTried += 1;
            // minUnits only in the char regime: with the optimistic token budget a
            // sub-minimum chunk is already rare, and keeping minUnits = 0 there
            // preserves the historical packing exactly.
            // #726: spans form a worklist instead of a flat pass. A chunk whose
            // summary comes back unusable is halved (oldest half first) and
            // retried down to a floor before the whole range is given up: the
            // prime suspect for an empty summary is a CHUNK_FRACTION-sized chunk
            // exceeding the upstream's real input cap, and halving recovers
            // exactly those cases. Bounded by the per-regime call budget below.
            const spans: Array<[number, number]> = splitChunks(messages, startIdx, endIdx, budget, baselineKnown ? 0 : minChars, countText).slice().reverse();
            while (spans.length > 0) {
                if (currentTokens < target) break;
                if (deps.signal?.aborted) {
                    failure = ABORTED_FAILURE;
                    break;
                }
                if (budgetHit) break;
                const span = spans.pop();
                if (!span) break;
                const [cs, ce] = span;
                const maps = refMaps(messages, deps.session.state);
                let startRef = maps.idxToRef.get(cs);
                let endRef = maps.idxToRef.get(ce);
                if (!startRef || !endRef) continue;
                // #1001: after a client history rewrite, ref numbers are not monotonic
                // with position — emit ascending pairs (the kernel resolves by
                // position anyway; this keeps specs, logs and the summary prompt honest).
                if (refNum(startRef) > refNum(endRef)) {
                    deps.log("warn", `[preflight] normalized reversed range ${startRef}–${endRef} → ${endRef}–${startRef} (non-monotonic refs after client history rewrite, #1001)`);
                    [startRef, endRef] = [endRef, startRef];
                }
                const preview = deps.core.applyCompression({
                    messages,
                    state: deps.session.state,
                    config: activeConfig,
                    ranges: [{ startRef, endRef, summary: "x".repeat(Math.max(MIN_SUMMARY_CHARS, activeConfig.compress.minSummaryLength)) }],
                });
                const previousBlockIds = new Set(deps.session.state.blocks.map((block) => block.blockId));
                const planned = preview.state.blocks.find((block) => !previousBlockIds.has(block.blockId));
                if (!planned) continue;
                // Direct raw messages render host-side: #781 image notes live in BiliMessage
                // sidecars the kernel never sees. Consumed child blocks render through the
                // kernel from the original state so they stay summaries.
                const idxById = new Map(messages.map((m, i) => [m.id, i]));
                const parts: string[] = [];
                for (const id of planned.directMessageIds) {
                    const i = idxById.get(id);
                    if (i === undefined) continue;
                    const m = messages[i];
                    let text = m.text ?? "";
                    const notes = imagePlaceholders(m);
                    if (notes.length > 0) {
                        const note = notes.join(" ");
                        text = text === IMAGE_PLACEHOLDER ? note : text ? `${text}\n${note}` : note;
                    }
                    if (!text) continue;
                    const label =
                        m.contentType === "tool-call"
                            ? `assistant tool-call ${m.toolName ?? "?"}`
                            : m.contentType === "tool-result"
                              ? `tool result ${m.toolName ?? "?"}`
                              : m.contentType === "reasoning"
                                ? "assistant reasoning"
                                : m.role;
                    parts.push(`[${label}]\n${text}`);
                }
                for (const nid of planned.directBlockIds) {
                    const nb = deps.session.state.blocks.find((b) => b.blockId === nid);
                    // The child stays a summary: its raw text is already condensed, and
                    // re-expanding it would defeat the compression this fold performs.
                    if (!nb) continue;
                    const label = nb.topic ? `${nb.blockId}: ${nb.topic}` : nb.blockId;
                    parts.push(`[summarized ${label}]\n${nb.summary}`);
                }
                const content = parts.join("\n\n");
                if (content.length === 0) continue;
                let summary: string | null = null;
                let outcome: SummaryOutcome | undefined;
                try {
                    const parts: string[] = [];
                    const chunks = splitSummaryContent(content, budget, countText);
                    for (const chunk of chunks) {
                        if (summaryCalls >= MAX_SUMMARY_CALLS_PER_PREFLIGHT) {
                            budgetHit = true;
                            break;
                        }
                        summaryCalls += 1;
                        const part = await summarizeRange(deps, chunk, startRef, endRef);
                        if ("unusable" in part) {
                            outcome = part;
                            break;
                        }
                        parts.push(part.summary);
                    }
                    if (!budgetHit && !outcome && parts.length === chunks.length) {
                        const candidate = parts.join("\n\n");
                        // #861: a summary the kernel would reject on length wastes the apply
                        // attempt and its failure log — route it through the same
                        // halving/skip path as any unusable output.
                        if (activeConfig.compress.maxSummaryLength <= 0 || candidate.length <= activeConfig.compress.maxSummaryLength) {
                            summary = candidate;
                        } else {
                            outcome = { unusable: `assembled summary (${candidate.length} chars) exceeds maxSummaryLength (${activeConfig.compress.maxSummaryLength})` };
                        }
                    }
                } catch (err) {
                    if (err instanceof UpstreamHttpError) {
                        failure = {
                            kind: "upstream",
                            status: err.status,
                            retryable: isTransientUpstreamError(err.status, err.body),
                            detail: err.status === 429
                                ? `the summarization call was rate-limited by the upstream (HTTP 429)`
                                : `the summarization call was rejected by the upstream (HTTP ${err.status})`,
                        };
                        deps.log("warn", `[preflight] summarization failed: HTTP ${err.status} after ${err.attempts} attempt(s)`);
                    } else if (deps.signal?.aborted) {
                        failure = ABORTED_FAILURE;
                        deps.log("warn", `[preflight] summarization aborted: client disconnected`);
                    } else if (err instanceof SummaryTransportError) {
                        failure = { kind: "upstream", detail: `the summarization call failed: ${err.message}`, ...(err.retryable ? { retryable: true } : {}) };
                        deps.log("warn", `[preflight] summarization failed: ${err.message}`);
                    } else {
                        failure = { kind: "upstream", detail: "the summarization call failed unexpectedly" };
                        deps.log("warn", "[preflight] summarization failed unexpectedly");
                    }
                    break;
                }
                if (summary === null) {
                    const unusableDetail = outcome && "unusable" in outcome ? outcome.unusable : "unknown";
                    if (outcome) lastUnusableDetail = unusableDetail;
                    const floorUnits = baselineKnown ? 2 * MIN_CHUNK_TOKENS : 2 * minChars;
                    if (ce > cs && spanUnitsOf(messages, cs, ce, countText) >= floorUnits) {
                        deps.log("warn", `[preflight] chunk ${startRef}:${endRef} produced no usable summary (${unusableDetail}); retrying with smaller chunks`);
                        const mid = Math.floor((cs + ce) / 2);
                        spans.push([mid + 1, ce]);
                        spans.push([cs, mid]);
                        continue;
                    }
                    deps.log("warn", `[preflight] range ${skipKey} produced no usable summary even at minimum size (${unusableDetail}); skipping it`);
                    skipSet.add(skipKey);
                    break;
                }
                const ctx: RewriteCtx = {
                    core: deps.core,
                    config: activeConfig,
                    messages,
                    session: deps.session,
                    log: (msg) => deps.log("info", msg),
                };
                const creditBefore = deps.session.stats.compressCreditTokens;
                const applied = applyRanges(parseCompressInput({ content: [{ startId: startRef, endId: endRef, summary, topic: "preflight overflow compress" }] }), ctx);
                if (applied.startsWith("[Compression FAILED")) {
                    deps.log("warn", `[preflight] ${applied}`);
                    skipSet.add(skipKey);
                    break;
                }
                // The summary itself re-enters the payload; net its cost against
                // both the folded size and the session's input baseline. Without a
                // baseline currentTokens is char-based, so net the folded span's
                // char count against it instead of the token-based credit.
                const compressed = deps.session.stats.compressCreditTokens - creditBefore;
                const folded = baselineKnown ? compressed : messages.filter((message) => planned.effectiveMessageIds.includes(message.id)).reduce((total, message) => total + (message.text ?? "").length, 0);
                currentTokens = Math.max(0, currentTokens - folded + countText(summary));
                deps.session.stats.lastInputTokens += defaultCountTokens(summary);
                appliedThisRound += 1;
                result.compressedRanges += 1;
                break;
            }
            if (appliedThisRound > 0) break;
            if (failure || budgetHit) break;
        }
        if (appliedThisRound === 0) {
            if (!failure && !budgetHit && !relaxed && (baselineKnown ? result.payloadEstimate : finalUpper) >= limit) {
                activeConfig = relaxedConfig(deps.config);
                relaxed = true;
                summaryCalls = 0;
                budgetHit = false;
                deps.log("warn", "[preflight] no usable ranges outside the protected recent zone; relaxing soft protection (preserveRecentMessages/Tokens -> 0) and retrying");
                continue;
            }
            break;
        }
    }
    if (currentTokens >= limit && !failure) {
        // #726: carry the most recent unusable-summary diagnosis into the
        // fail-fast message — "no range could be compressed" with no reason is
        // undiagnosable from the client side.
        const unusableNote = lastUnusableDetail ? ` Last unusable summary: ${lastUnusableDetail.slice(0, 300)}.` : "";
        if (budgetHit) {
            failure = { kind: "exhausted", detail: `the preflight summarization budget (${MAX_SUMMARY_CALLS_PER_PREFLIGHT} calls per protection regime) was exhausted before the payload fit the window${unusableNote}` };
        } else if (relaxed && result.compressedRanges > 0) {
            failure = { kind: "exhausted", detail: relaxedExhaustedDetail };
        } else if (result.compressedRanges === 0) {
            failure = { kind: "exhausted", detail: `no range could be compressed across ${rangesTried} viable range${rangesTried === 1 ? "" : "s"} (each was below minCompressRange, had an unusable summary, or failed to apply)${unusableNote}` };
        } else {
            failure = { kind: "exhausted", detail: `the compress budget was exhausted after ${MAX_PREFLIGHT_ROUNDS} rounds${unusableNote}` };
        }
    }
    if (result.compressedRanges > 0) {
        // #857: never persist the IMAGE FLOOR into the usage baseline — images
        // are billed by the upstream and every fit/clamp gate adds their
        // estimate separately, so the baseline must stay usage-semantics
        // (text + overhead only). A bytes-mode floor (b64/4) overestimates
        // pixel-billing upstreams ~100× and would poison the upward window
        // self-heal and close the #496 escape hatch permanently.
        const textBaseline = result.payloadEstimate - (deps.imageFloor ?? 0);
        if (textBaseline > deps.session.stats.lastInputTokens) {
            deps.session.stats.lastInputTokens = textBaseline;
            deps.session.stats.lastInputTokensSource = "estimate";
        }
    }
    result.rangesRemaining = rangesRemaining;
    result.savedTokens = Math.max(0, startTokens - currentTokens);
    if (currentTokens >= limit) result.failure = failure;
    result.fitsWindow = baselineKnown ? result.payloadEstimate < limit : finalUpper < limit;
    return result;
}
