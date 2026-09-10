import {
    defaultCountTokens,
    viableRanges,
    type CompressionCore,
    type Config,
    type CoreMessage,
    type Prompts,
} from "acp-kernel";
import { buildCompressSystemPrompt, parseCompressInput } from "./compress-tool.js";
import { applyAbsorbView } from "./absorb.js";
import { applyRanges, type RewriteCtx } from "./stream.js";
import { fetchWithRetry, UpstreamHttpError } from "./fetch-util.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import { lastCompressSuffix, type Session } from "./session.js";

// #247: proactive pre-forward compression. When the session's real context
// (previous turn's upstream input_tokens) exceeds the current model's window
// (e.g. the user switched from a 1M-context model to a 260k one), the payload
// overflows at forward time and the reactive nudge can never fire — the
// request itself is rejected by the upstream, so the model never sees the
// nudge and every subsequent request overflows identically (stuck session).
// This module compresses the oldest compressible ranges first, via dedicated
// summarization calls sized to fit the smaller window, before the payload is
// forwarded.

const MAX_PREFLIGHT_ROUNDS = 8;
const CHUNK_FRACTION = 0.6;
const MIN_CHUNK_TOKENS = 2000;
const MIN_SUMMARY_CHARS = 50;
const MAX_SUMMARY_OUTPUT_TOKENS = 8192;
// #574: bound on upstream summarization calls per invocation — the multi-range
// walk can otherwise spend a call per viable range in a block-dense history.
const MAX_SUMMARY_CALLS_PER_PREFLIGHT = 8;

export type PreflightProtocol = "anthropic" | "openai" | "responses";

export interface PreflightDeps {
    core: CompressionCore;
    session: Session;
    config: Config;
    prompts: Prompts;
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
    /** Upstream HTTP status when kind === "upstream" and the failure was an HTTP response. */
    status?: number;
    /** Human-readable cause (safe to surface to the client). */
    detail: string;
}

export interface PreflightResult {
    compressedRanges: number;
    savedTokens: number;
    /** Token estimate of the final (post-fold) payload, from the payload
     *  itself — NOT floored on the session's lastInputTokens, which can be
     *  stale (e.g. a double-counted usage report, #300). The caller uses it
     *  to decide whether forwarding as-is is actually safe. */
    payloadEstimate: number;
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

function rangeChars(messages: CoreMessage[], startIdx: number, endIdx: number): number {
    let chars = 0;
    for (let i = startIdx; i <= endIdx && i < messages.length; i++) {
        chars += (messages[i].text ?? "").length;
    }
    return chars;
}

function renderRange(messages: CoreMessage[], startIdx: number, endIdx: number): string {
    const parts: string[] = [];
    for (let i = startIdx; i <= endIdx && i < messages.length; i++) {
        const m = messages[i];
        const text = (m.text ?? "").trim();
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
    return parts.join("\n\n");
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

function summaryPayload(protocol: PreflightProtocol, model: string, system: string, content: string, stream: boolean, includeMaxOutputTokens: boolean): Record<string, unknown> {
    if (protocol === "anthropic") {
        return { model, max_tokens: MAX_SUMMARY_OUTPUT_TOKENS, system, messages: [{ role: "user", content }], stream };
    }
    if (protocol === "openai") {
        return { model, max_tokens: MAX_SUMMARY_OUTPUT_TOKENS, messages: [{ role: "system", content: system }, { role: "user", content }], stream };
    }
    // #488: codex relays reject Responses calls without store:false ("Store must be set to false").
    // #663: max_output_tokens is optional — omit it once the upstream has
    // rejected the parameter (learned per URL+model); the model's default
    // output cap then applies.
    const payload: Record<string, unknown> = { model, instructions: system, input: [{ role: "user", content }], stream, store: false };
    if (includeMaxOutputTokens) payload.max_output_tokens = MAX_SUMMARY_OUTPUT_TOKENS;
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
// models mid-conversation, and a model that accepts the limit must keep the
// 8192 cap.
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

// Extract the summary text from a buffered SSE body (the streaming twin of
// extractSummaryText). For Responses, prefer the response.completed event's
// full response object (reuses the JSON extractor); otherwise accumulate
// output_text deltas. Non-conforming upstreams that return plain JSON despite
// stream:true are handled by the caller's JSON fallback.
function extractSummaryFromSse(protocol: PreflightProtocol, text: string): string {
    let out = "";
    for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let obj: unknown;
        try {
            obj = JSON.parse(payload);
        } catch {
            continue;
        }
        if (!obj || typeof obj !== "object") continue;
        const o = obj as Record<string, unknown>;
        if (protocol === "anthropic") {
            if (o.type === "content_block_delta") {
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
            if (o.type === "response.output_text.delta" && typeof o.delta === "string") {
                out += o.delta;
            } else if (o.type === "response.completed" && o.response && typeof o.response === "object") {
                const full = extractSummaryText(protocol, o.response as Record<string, unknown>);
                if (full) return full;
            }
        }
    }
    return out;
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

async function summarizeRange(deps: PreflightDeps, content: string, startRef: string, endRef: string): Promise<string | null> {
    const system =
        buildCompressSystemPrompt(deps.prompts) +
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

async function requestSummary(deps: PreflightDeps, system: string, content: string, stream: boolean, includeMaxOutputTokens: boolean): Promise<string | null> {
    const { response, clearTimer } = await fetchWithRetry(
        deps.url,
        {
            method: "POST",
            headers: { "content-type": "application/json", ...summaryHeaders(deps) },
            body: JSON.stringify(summaryPayload(deps.protocol, deps.model, system, content, stream, includeMaxOutputTokens)),
            dispatcher: proxyDispatcher(deps.proxyUrl),
        },
        undefined,
        deps.signal,
        (info) => {
            // #189: correlate the rejection with the rewrite that preceded it.
            deps.log("warn", `[preflight] summary attempt ${info.attempt} got HTTP ${info.status}; retrying in ${info.delayMs}ms${lastCompressSuffix(deps.session.lastCompress)}`);
        },
    );
    try {
        const text = await response.text();
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
            deps.log("warn", `[preflight] summary too short (${summary.length} chars); skipping range`);
            return null;
        }
        return summary;
    } finally {
        clearTimer();
    }
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
    const result: PreflightResult = { compressedRanges: 0, savedTokens: 0, payloadEstimate: estimateCoreMessages(messages) + (deps.imageFloor ?? 0) + (deps.wireOverhead ?? 0), fitsWindow: true };
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
        if (currentTokens < limit) break;
        const ranges = viableRanges(turn.nudge?.compressibleRanges ?? []);
        if (ranges.length === 0) {
            // #330: nothing foldable outside the soft-protected recent zone.
            // Relax the soft zone (oldest-first within it) and retry — the hard
            // protectedTools exclusion still applies. Gate on the payload's own
            // estimate (not currentTokens, which is floored by a possibly-stale
            // lastInputTokens from a prior model): if the real payload already
            // fits, stop instead of folding protected content.
            if (!relaxed && result.payloadEstimate >= limit) {
                activeConfig = relaxedConfig(deps.config);
                relaxed = true;
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
            if (currentTokens < limit) break;
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
            for (const [cs, ce] of splitChunks(messages, startIdx, endIdx, budget, baselineKnown ? 0 : minChars, countText)) {
                if (currentTokens < limit) break;
                if (deps.signal?.aborted) {
                    failure = ABORTED_FAILURE;
                    break;
                }
                if (budgetHit) break;
                const maps = refMaps(messages, deps.session.state);
                const startRef = maps.idxToRef.get(cs);
                const endRef = maps.idxToRef.get(ce);
                if (!startRef || !endRef) continue;
                if (rangeChars(messages, cs, ce) < minChars) continue;
                const content = renderRange(messages, cs, ce);
                if (content.length === 0) continue;
                if (summaryCalls >= MAX_SUMMARY_CALLS_PER_PREFLIGHT) {
                    budgetHit = true;
                    break;
                }
                summaryCalls += 1;
                let summary: string | null;
                try {
                    summary = await summarizeRange(deps, content, startRef, endRef);
                } catch (err) {
                    if (err instanceof UpstreamHttpError) {
                        failure = {
                            kind: "upstream",
                            status: err.status,
                            detail: err.status === 429
                                ? `the summarization call was rate-limited by the upstream (HTTP 429)`
                                : `the summarization call was rejected by the upstream (HTTP ${err.status})`,
                        };
                        deps.log("warn", `[preflight] summarization failed: HTTP ${err.status} ${err.body.slice(0, 200)}`);
                    } else if (deps.signal?.aborted) {
                        failure = ABORTED_FAILURE;
                        deps.log("warn", `[preflight] summarization aborted: client disconnected`);
                    } else {
                        failure = { kind: "upstream", detail: `the summarization call failed: ${String(err)}` };
                        deps.log("warn", `[preflight] summarization failed: ${String(err)}`);
                    }
                    break;
                }
                if (!summary) {
                    deps.log("warn", `[preflight] range ${skipKey} produced no usable summary; skipping it`);
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
                const folded = baselineKnown ? compressed : rangeChars(messages, cs, ce);
                currentTokens = Math.max(0, currentTokens - folded + countText(summary));
                deps.session.stats.lastInputTokens += defaultCountTokens(summary);
                appliedThisRound += 1;
                result.compressedRanges += 1;
                break;
            }
            if (appliedThisRound > 0) break;
            if (failure || budgetHit) break;
        }
        if (appliedThisRound === 0) break;
    }
    if (currentTokens >= limit && !failure) {
        if (budgetHit) {
            failure = { kind: "exhausted", detail: `the preflight summarization budget (${MAX_SUMMARY_CALLS_PER_PREFLIGHT} calls per protection regime) was exhausted before the payload fit the window` };
        } else if (relaxed && result.compressedRanges > 0) {
            failure = { kind: "exhausted", detail: relaxedExhaustedDetail };
        } else if (result.compressedRanges === 0) {
            failure = { kind: "exhausted", detail: `no range could be compressed across ${rangesTried} viable range${rangesTried === 1 ? "" : "s"} (each was below minCompressRange, had an unusable summary, or failed to apply)` };
        } else {
            failure = { kind: "exhausted", detail: `the compress budget was exhausted after ${MAX_PREFLIGHT_ROUNDS} rounds` };
        }
    }
    if (result.compressedRanges > 0) deps.session.stats.lastInputTokens = currentTokens;
    result.savedTokens = Math.max(0, startTokens - currentTokens);
    if (currentTokens >= limit) result.failure = failure;
    result.fitsWindow = baselineKnown ? result.payloadEstimate < limit : finalUpper < limit;
    return result;
}
