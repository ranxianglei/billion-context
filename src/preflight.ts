import {
    countMessageTokens,
    defaultCountTokens,
    viableRanges,
    type CompressionCore,
    type Config,
    type CoreMessage,
    type Prompts,
    type PackSurface,
} from "acp-kernel";
import { buildCompressSystemPrompt, parseCompressInput } from "./compress-tool.js";
import { IMAGE_PLACEHOLDER, imagePlaceholdersForSummary } from "./image-note.js";
import { applyAbsorbView } from "./absorb.js";
import { adoptContentStore, ccrLoopConfig, contentStoreOf } from "./store.js";
import { applyRanges, normalizeRangeOrder, type RewriteCtx } from "./stream.js";
import { fetchWithTimeout, isTransientUpstreamError, replayMaxAttempts, replayBackoffMs, sleep, UpstreamHttpError } from "./fetch-util.js";
import { dumpSummaryRejection } from "./error-dump.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import { lastCompressSuffix, type Session } from "./session.js";
import { peekRegistryOutputLimit } from "./registry.js";
import { safePrefix } from "./text-safe.js";
import { applyEstimateCalibration, currentCalibrationFactor } from "./util.js";
import { configuredSummaryPlan, type ConfiguredSummaryPlan } from "./external-summary-runtime.js";
import type { ResolvedKernelConfig } from "./compress-settings.js";

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
// #1775: gap between joined chunk summaries ("\n\n") — subtracted when
// spreading maxSummaryLength across chunks so the assembled candidate fits the
// cap when every chunk lands exactly on its per-chunk budget.
const SUMMARY_JOIN_GAP = 2;
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
// #1819: net-shrink monotonicity tolerance for fold acceptance. A weak
// summarizer can regurgitate a verbose re-narration that EXCEEDS its own
// range: the flat maxSummaryLength cap bounds absolute size only, so such a
// summary was accepted as a successful fold and the rebuild landed LARGER
// than the preflight input (越压越大 — minutes of latency, re-firing rounds,
// misleading "tokens saved" telemetry). The acceptance gate compares the
// candidate's mass against the span's mass in the SAME units this loop's
// post-fold accounting uses (token regime: the kernel's credit for the span;
// char regime: raw-char mass), so a passing fold always nets a shrink under
// that accounting. The slack covers O(1) tag/wrapper overhead and estimator
// noise between the two sides; regurgitation (typically ≥2x) is rejected
// decisively either way. Folds whose summary merely fails to shrink by more
// than the slack are rejected too — they buy nothing but block-management
// cost, and the halving path routes the budget to smaller material.
export const NET_SHRINK_TOLERANCE = 1.05;
// #1767: bounded same-span retries for TRANSIENT empty summaries — HTTP 200
// with no text (finish_reason=content_filter, truncated streams, empty bodies).
// Distinct from the #726 halving cascade, which assumes the empty answer is
// size-driven: a single-message span cannot be halved, so without these
// retries the span's only draw against a flaky summarizer kills the whole
// preflight (one content_filter blip bricked an entire turn; the identical
// payload summarized fine ~90s later on the user's manual retry). Retries
// count against the per-invocation summary budget like any other call.
const TRANSIENT_EMPTY_SUMMARY_RETRIES = 2;
// Per-protection-regime cap on wasted transient retries so a SYSTEMIC
// (persistent) empty-summary failure degrades to today's behavior after a
// few extra calls instead of burning the full budget on doomed draws.
// Reset alongside summaryCalls when soft protection is relaxed (#575-merge).
const TRANSIENT_EMPTY_RETRY_BUDGET = 4;
// #1841: slack on the futility verdicts below. Range token estimates carry
// ±~20% error on mixed CJK/Latin/code, and a fold's summary re-enters the
// payload, so realizable saving is strictly below span mass. Fail CLOSED:
// skip a doomed round only when the shortfall survives this slack — when
// unsure, walk exactly as before.
const FUTILITY_SLACK = 1.2;
// #2383: entry overshoot (entryTokens / window) above which the LLM fold path
// is PROVABLY unable to converge in this invocation — it exceeds the raised
// budget's maximum coverage (MAX_PREFLIGHT_ROUNDS * 2 rounds x CHUNK_FRACTION
// x window per ideal fold). Observed shape: a dsh fork resends its whole raw
// history as a fresh session (5.09M tokens vs a 240K window = 21.2x): ~45
// folds are needed against a 32-round cap, each fold costs one upstream call
// (~15-30s), and the host client disconnects every ~300s — the user retries
// forever and the session never starts. In that regime the fold only needs to
// be a VALID block summary (the folded originals stay restorable via
// decompress — applyRanges caches them like any other preflight fold), so the
// summarization call is replaced by a CPU-only structural digest
// (deterministicDigest below). Hard constant by design: no new config surface,
// and the trigger derives from this loop's own coverage math instead of an
// arbitrary multiplier — normal sessions (one turn of growth per request)
// never approach it.
const EMERGENCY_FOLD_COVERAGE = MAX_PREFLIGHT_ROUNDS * 2 * CHUNK_FRACTION;
// Round cap for the emergency regime: every round is CPU-only (kernel walk +
// digest, no upstream wait), so even the worst case stays at seconds; 512
// covers ~250x the window at observed per-fold savings (~0.5-0.6x window) —
// far beyond any realistic resend size.
const EMERGENCY_ROUND_CAP = 512;
// Per-entry head-fragment length in digest form A (form B strips heads when
// even that does not fit the bounds).
const DIGEST_HEAD_CHARS = 120;

// #869 review: coverage bound of the two depth budgets above. One round folds
// ONE range and each fold removes at most CHUNK_FRACTION x window tokens (the
// per-call chunk budget), so MAX_PREFLIGHT_ROUNDS rounds cover an overshoot of
// at most MAX_PREFLIGHT_ROUNDS x CHUNK_FRACTION x window ~= 9.6x the window —
// a payload of up to ~10.6x the window in the best case. Real coverage is
// lower: a range smaller than the chunk budget saves less, and the #726
// halving worklist can spend several calls on one range without completing a
// fold. Beyond the bound the loop still exits cleanly — the fail-fast reports
// the post-fold size and the remaining compressible-range count, so an
// operator sees exactly how far the budget ran out. #1933 made the depth
// dynamic: base 16 covers payloads up to ~1.4x the window (one ideal fold
// removes CHUNK_FRACTION x window); larger entry overshoots scale both
// budgets proportionally, capped at 2x the base (see preflightCompress).
// #2383 extends coverage past the bound: an entry overshoot above
// EMERGENCY_FOLD_COVERAGE switches every fold to a deterministic digest
// (zero upstream calls), so structurally unconvergent payloads converge too.

export type PreflightProtocol = "anthropic" | "openai" | "responses" | "google";

// #2189: subscription-OAuth credentials (Claude Code login) accept only
// requests whose system carries the client's billing-attribution block; every
// other call on the same credential gets 429 rate_limit_error "Error" (a
// shape rejection wearing a rate-limit costume). The main forward lane has
// preserved the client's block shape since #1876 — this extractor lets the
// summary side-path carry it too. cache_control is dropped (it pinned the
// client's own placement, not one in bili's summary system); scanning instead
// of index-0-only survives a host relocating the block.
export const BILLING_ATTRIBUTION_PREFIX = "x-anthropic-billing-header:";

export function extractBillingAttributionBlock(
    system: string | Array<Record<string, unknown>> | undefined,
): { type: "text"; text: string } | undefined {
    if (!Array.isArray(system)) return undefined;
    for (const block of system) {
        if (!block || typeof block !== "object" || block.type !== "text") continue;
        const text = block.text;
        if (typeof text === "string" && text.trimStart().startsWith(BILLING_ATTRIBUTION_PREFIX)) {
            return { type: "text", text };
        }
    }
    return undefined;
}

// #2189: 429 + error.type "rate_limit_error" + the BARE message "Error" is
// upstream's credential-shape rejection (see above), not a rate limit — real
// limits carry descriptive messages. Retrying the identical shape cannot
// succeed, so callers fail fast on this signature instead of burning the
// replay budget. Both halves are required so real-limit wording can't trip it.
export function isCredentialShapeRejection(status: number, body: string): boolean {
    if (status !== 429) return false;
    try {
        const parsed = JSON.parse(body) as { error?: { type?: unknown; message?: unknown } };
        return parsed.error?.type === "rate_limit_error" && parsed.error.message === "Error";
    } catch {
        return false;
    }
}

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
    /** #1843: the image reserve for this request — the billed cost of the images riding the payload verbatim (#488). Folding never removes them, so every TEXT-channel decision compares the text estimate against `limit − reserve` instead of adding the reserve to each total; an image-estimate error can no longer move a fold decision. Kernel-facing quantities keep the total view (reserve added back), which is the conservative direction. */
    imageReserve?: number;
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
    /** #1933 F1: origin of the upstream this request routes to. When it matches the route that learned the session's estimate-calibration factor k̂, every per-round text estimate is scaled by k̂ so gate, per-round exit and final fit judge one payload on the same scale as the trigger that started this invocation; absent or mismatched → raw estimates (legacy behavior). */
    upstreamOrigin?: string;
    /** #2133: compress.streamSummary resolved true for this request (three-level cascade). The self-learn flag only sees 400 "stream required" rejections, so gateways that time out long non-streaming completions (Cloudflare 524) can never self-heal — this forces SSE from the first attempt instead. */
    forceStreamSummary?: boolean;
    /** One external-summary deadline shared by every range/chunk in this invocation. */
    externalSummary?: ConfiguredSummaryPlan;
    /** #2155: compress.streamSummary resolved FALSE for this request (explicit operator opt-out anywhere in the cascade). Neither learn path (400 "stream required" nor the 524/504 gateway-timeout first-hit learn) may arm, and an already-armed session flag is ignored — the operator said this upstream must never stream summaries. */
    streamSummaryOff?: boolean;
    /** #2189: the client's billing-attribution block from the INBOUND anthropic system (extractBillingAttributionBlock). Carried into every summary call as system[0]; absent → legacy string system unchanged. */
    billingBlock?: { type: "text"; text: string };
}

type PreflightFailureKind = "upstream" | "exhausted" | "aborted";

interface PreflightFailure {
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
type SummaryOutcome = { summary: string } | { unusable: string; transient?: boolean };

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
// #2407: host-projected thinking mass (CoreMessage.thinkingTokens, #1320) is
// billed by upstream but invisible in m.text — count it via the kernel's
// countMessageTokens so every consumer of this estimator (the k̂ calibration
// denominator at the prepare sites, preflight fit/round budgets, the output
// clamp, the image-cost textSide) carries billed-caliber mass. Without it the
// k̂ sample divides a bill that includes thinking by an estimate that
// excludes it, and thinking-heavy routes learn an inflated factor.
export function estimateCoreMessages(messages: CoreMessage[]): number {
    let tokens = 0;
    for (const m of messages) tokens += countMessageTokens(m, defaultCountTokens);
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
export function splitSummaryContent(content: string, budget: number, countTokens: (text: string) => number): string[] {
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
        // #1615 family: a budget boundary landing between the two halves of an
        // astral char would strand a lone surrogate at this chunk's end (and the
        // next chunk's start) — strict upstreams reject such summarization bodies.
        if (low - offset > 1 && low < content.length) {
            const c = content.charCodeAt(low - 1);
            if (c >= 0xd800 && c <= 0xdbff) low -= 1;
        }
        chunks.push(content.slice(offset, low));
        offset = low;
    }
    return chunks;
}

// #1775: rescue for an assembled summary that exceeds maxSummaryLength but is
// still shorter than the folded content — truncating to the cap nets savings,
// so keep the summary instead of discarding the whole range (the halving retry
// cannot help: on tool-dense spans summary length does not scale with input
// size, so every half fails identically). Cuts at a line boundary with a
// marker, only if the result still passes the kernel's minSummaryLength gate;
// null when the cap cannot carry a usable result (caller keeps the discard).
function truncateSummaryToLimit(text: string, maxChars: number, minChars: number): string | null {
    if (text.length <= maxChars) return text;
    const marker = "\n[truncated]";
    const room = maxChars - marker.length;
    if (room < minChars) return null;
    let cut = text.lastIndexOf("\n", room);
    if (cut < minChars) cut = room;
    const out = `${text.slice(0, cut)}${marker}`;
    return out.length <= maxChars && out.trim().length >= minChars ? out : null;
}

// minUnits: never close a chunk below this many countText units while more
// messages remain — a chunk under config.compress.minCompressRange tokens is
// rejected by applyCompression, so such a chunk would waste a whole round. In
// the char-count regime (#553) the caller passes the 4× worst-case conversion
// of that token gate. (That regime needs this because its budget can be far
// smaller than the gate on small windows.)
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

export function summaryPayload(protocol: PreflightProtocol, model: string, system: string, content: string, stream: boolean, includeMaxOutputTokens: boolean, host?: string, window?: number, billingBlock?: { type: "text"; text: string }): Record<string, unknown> {
    const maxOutputTokens = windowClampedOutput(summaryOutputTokens(model, host), window, system, content);
    if (protocol === "anthropic") {
        // #2189: carry the client's billing-attribution block as system[0] with
        // the bili prompt as system[1]; subscription-OAuth upstreams reject
        // calls lacking it. Absent → legacy string system byte-identical.
        const systemOut = billingBlock ? [billingBlock, { type: "text", text: system }] : system;
        return { model, max_tokens: maxOutputTokens, system: systemOut, messages: [{ role: "user", content }], stream };
    }
    if (protocol === "openai") {
        return { model, max_tokens: maxOutputTokens, messages: [{ role: "system", content: system }, { role: "user", content }], stream };
    }
    if (protocol === "google") {
        // Gemini carries the model in the request PATH (never in the body) and
        // has no `stream` field either — the `:streamGenerateContent` path
        // decides. The summary call therefore carries only the conversation
        // shape: contents + the system channel, with the output cap living in
        // generationConfig (there is no top-level max_tokens).
        const payload: Record<string, unknown> = { contents: [{ role: "user", parts: [{ text: content }] }] };
        if (system) payload.systemInstruction = { parts: [{ text: system }] };
        if (includeMaxOutputTokens) payload.generationConfig = { maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS };
        return payload;
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

// Gemini carries the summary text in candidates[0].content.parts[].text. A
// `thought:true` part is the model's reasoning (thinkingConfig), not summary
// output, so it is skipped; several candidates only occur when n>1 is
// requested, which the summary call never is — first candidate wins, mirroring
// the OpenAI/Anthropic extractors.
function googleChunkText(chunk: Record<string, unknown>): string {
    const candidates = chunk.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return "";
    const first = candidates[0];
    if (!first || typeof first !== "object") return "";
    const content = (first as Record<string, unknown>).content;
    if (!content || typeof content !== "object") return "";
    const parts = (content as Record<string, unknown>).parts;
    if (!Array.isArray(parts)) return "";
    let out = "";
    for (const p of parts) {
        if (!p || typeof p !== "object") continue;
        const part = p as Record<string, unknown>;
        if (part.thought === true) continue;
        if (typeof part.text === "string") out += part.text;
    }
    return out;
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
//     real gateways omit these occasionally), and the Gemini wire requires no
//     finishReason either; the body must at least end on a frame boundary
//     (\n\n, CRLF-tolerant), else it may have been cut mid-frame
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
        } else if (protocol === "google") {
            out += googleChunkText(o);
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

export function extractSummaryText(protocol: PreflightProtocol, json: Record<string, unknown>): string {
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
    if (protocol === "google") {
        // Without `alt=sse` the same chunk objects arrive as a JSON ARRAY (the
        // non-SSE streaming form), which the caller's JSON.parse hands us whole.
        const chunks = Array.isArray(json) ? (json as unknown[]) : [json];
        return chunks.map((c) => (c && typeof c === "object" ? googleChunkText(c as Record<string, unknown>) : "")).join("");
    }
    // #2309: an HTTP-200 Responses body declares its terminal state in
    // `status`. incomplete/failed means whatever text rides below is NOT a
    // finished summary, whatever its length — the SSE path already rejects
    // those terminals (#780/#784); mirror them on the JSON path too, across
    // both the flat output_text shortcut and the output[] walk, or a 95-char
    // fragment sails past MIN_SUMMARY_CHARS into a compression block.
    // Omitted status stays accepted (compat gateways that never send it).
    const status = typeof json.status === "string" ? json.status : undefined;
    if (status === "incomplete" || status === "failed") return "";
    if (typeof json.output_text === "string") return json.output_text;
    const output = json.output;
    if (!Array.isArray(output)) return "";
    // #2308: an explicit type declares what the bytes are — only assistant
    // message items and their output_text parts are summary body; reasoning
    // items/parts (reasoning_text, summary_text, ...) must not leak into the
    // saved summary. Typeless shapes stay accepted for gateways that omit
    // `type`; top-level output_text compat above is untouched.
    return output
        .map((o) => {
            if (!o || typeof o !== "object") return undefined;
            const item = o as Record<string, unknown>;
            const itemType = typeof item.type === "string" ? item.type : "";
            if (itemType !== "" && itemType !== "message") return undefined;
            return item.content;
        })
        .filter((c): c is unknown[] => Array.isArray(c))
        .flatMap((c) => c)
        .map((p) => {
            if (!p || typeof p !== "object") return "";
            const part = p as Record<string, unknown>;
            const partType = typeof part.type === "string" ? part.type : "";
            if (partType !== "" && partType !== "output_text") return "";
            return typeof part.text === "string" ? part.text : "";
        })
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

// #2309: an HTTP-200 Responses body can declare a bad terminal state while
// still carrying partial text past MIN_SUMMARY_CHARS — the generic
// "plain-JSON completion with empty content" string is false for such a body
// (the content IS present, just unfinished). Name the terminal precisely and
// embed the raw reason/error verbatim: the operator sees WHY without a log
// cross-reference, and emptySummaryIsSizeDriven sees the size signal
// (reason=max_output_tokens halves like finish_reason=length).
function responsesTerminalDiagnosis(json: Record<string, unknown>): string | null {
    const status = typeof json.status === "string" ? json.status : undefined;
    if (status !== "incomplete" && status !== "failed") return null;
    if (!Array.isArray(json.output) && typeof json.output_text !== "string") return null;
    const parts: string[] = [`status=${status}`];
    if (status === "incomplete") {
        const details = json.incomplete_details;
        const reason = details && typeof details === "object" && typeof (details as Record<string, unknown>).reason === "string"
            ? (details as Record<string, unknown>).reason as string
            : undefined;
        if (reason) parts.push(`reason=${reason}`);
    } else {
        const e = json.error;
        if (e && typeof e === "object") {
            const eo = e as Record<string, unknown>;
            if (typeof eo.code === "string") parts.push(eo.code);
            if (typeof eo.message === "string") parts.push(eo.message.slice(0, 200));
        }
    }
    const article = status === "incomplete" ? "an" : "a";
    return `the upstream returned ${article} ${status} Responses summary (${parts.join(", ")})`;
}

// #1767: classify a diagnosis from diagnoseEmptySummary. Only explicit SIZE
// signals mean "the span is too big" (halving is the recovery — #726); every
// other empty shape (content_filter, empty body, truncated stream, in-stream
// error) is a blip of the summarizer or its gateway and is worth one bounded
// re-draw of the SAME span. A single-message span cannot be halved, so
// without this split a flaky summarizer kills the whole preflight. The
// diagnosis strings are test-pinned, so matching them keeps the classifier in
// lockstep with what the operator sees.
export function emptySummaryIsSizeDriven(diagnosis: string): boolean {
    // #2309: reason=max_output_tokens is the Responses-side spelling of the
    // same size signal — the span outgrew the summarizer's output budget.
    return /context_length_exceeded|too long|finish_reason=length\b|stop_reason=max_tokens\b|reason=max_output_tokens\b/i.test(diagnosis);
}

export function diagnoseEmptySummary(text: string, json?: unknown): string {
    if (json && typeof json === "object") {
        // #2309: the Responses terminal check runs FIRST — a failed response
        // also carries a top-level error object that extractStreamError would
        // otherwise claim with the weaker bare-error framing.
        const o = json as Record<string, unknown>;
        const terminal = responsesTerminalDiagnosis(o);
        if (terminal) return terminal;
        const err = extractStreamError(o);
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

async function summarizeRange(deps: PreflightDeps, content: string, startRef: string, endRef: string, lengthBudget?: number): Promise<SummaryOutcome> {
    // #1775: the cap used to be enforced only after the fact — an over-cap
    // assembly was discarded wholesale (the #1775 incident). Tell the model the
    // character budget up front so the first attempt already fits. Below
    // MIN_SUMMARY_CHARS the instruction would be counterproductive (the kernel
    // minimum-summary gate rejects such output anyway), so omit it.
    const system =
        buildCompressSystemPrompt(deps.prompts, deps.surface?.promptSections) +
        `\n\nTASK: The conversation segment below (messages ${startRef}–${endRef}) must be compressed because the session context exceeds the current model's window. Write a tier-1 compression summary of the segment following every rule above. Output ONLY the summary text — no preamble, no closing remarks, no tool calls.` +
        (lengthBudget !== undefined && lengthBudget >= MIN_SUMMARY_CHARS
            ? `\n\nLENGTH BUDGET: Your ENTIRE response must be AT MOST ${lengthBudget} characters total — longer output is rejected by the pipeline. Be dense: compact bullets, no filler or repetition.`
            : "");
    if (deps.externalSummary) {
        const batch = await deps.externalSummary.summarize([{ instructions: system, content, minSummaryChars: MIN_SUMMARY_CHARS,
            maxSummaryChars: deps.config.compress.maxSummaryLength }], deps.signal);
        const result = batch.results[0];
        return result?.status === "success" ? { summary: result.summary }
            : { unusable: "configured external summary candidates failed or exceeded their budget", transient: false };
    }
    // #626: the session remembers upstreams that require stream:true, so the
    // extra 400 round-trip is paid at most once per session (persisted with
    // the session metadata). #663: likewise, per URL+model, upstreams that
    // reject the max_output_tokens parameter. Each capability is learned at
    // most once (guarded below), so the compatibility retries are bounded:
    // at most one extra attempt per capability, in either rejection order.
    // #2133: compress.streamSummary forces SSE from the first attempt — the
    // learn path above only sees 400 "stream required" rejections, which a
    // gateway timeout (524) never produces. #2155: an explicit cascade FALSE
    // (streamSummaryOff) opts the request out of SSE summaries entirely — both
    // learn paths stay disarmed and a stale learned flag is ignored.
    let stream = !deps.streamSummaryOff && (deps.session.metadata.preflightStreamSummary === true || deps.forceStreamSummary === true);
    let includeMaxOutputTokens = !(deps.protocol === "responses" && hasLearnedNoMaxOutputTokens(deps));
    for (;;) {
        try {
            return await requestSummary(deps, system, content, stream, includeMaxOutputTokens);
        } catch (err) {
            if (err instanceof UpstreamHttpError && !stream && !deps.streamSummaryOff && (err.status === 524 || err.status === 504)) {
                // #2155 D3: first-hit learn — the non-streaming summary call
                // timed out at the gateway. Flip this session to SSE summaries
                // (persisted, same slot as the #626/#2133 learn) and retry once;
                // the streaming attempt itself keeps normal transient retry
                // semantics inside requestSummaryBody.
                deps.session.metadata.preflightStreamSummary = true;
                stream = true;
                deps.log("info", `[preflight] non-streaming summary timed out at the gateway (HTTP ${err.status}); retrying with SSE (learned for this session, #2155)`);
                continue;
            }
            if (err instanceof UpstreamHttpError && err.status === 400) {
                let adapted = false;
                if (!stream && !deps.streamSummaryOff && STREAM_REQUIRED_RE.test(err.body)) {
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

// In-loop retry set — parity with the main model-request path's fail-fast
// kinds (#1263/#1453 isFailFastUpstreamKind): a summary call must not die
// faster than the request it protects. TLS trust failures stay OUT on purpose:
// a bad CA does not self-heal within the backoff window (the main path agrees).
const TRANSIENT_SUMMARY_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "ECONNABORTED"]);
const SUMMARY_DIAGNOSTIC_CODES = new Set([
    ...TRANSIENT_SUMMARY_CODES, "ETIMEDOUT", "UND_ERR_ABORTED",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "Z_DATA_ERROR", "Z_BUF_ERROR", "Z_MEM_ERROR",
    "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "DEPTH_ZERO_UNTRUSTED_ROOT",
    "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);
// Certificate-TRUST codes: the failure is "this CA chain is not trusted here"
// (corporate interception / MITM), not "the upstream is broken" — the
// client-facing error must say so and name the remedy (#1987).
const TLS_TRUST_HINT_CODES = new Set([
    "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "DEPTH_ZERO_UNTRUSTED_ROOT",
    "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

class SummaryTransportError extends Error {
    readonly retryable: boolean;
    readonly aborted: boolean;
    readonly code?: string;
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
        this.aborted = aborted;
        this.code = code;
    }
}

async function requestSummaryBody(deps: PreflightDeps, body: string, stream: boolean): Promise<string> {
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
            // #2155 D3: a gateway timeout (Cloudflare 524 / 504) on a
            // NON-STREAMING summary must not burn the replay budget — each
            // identical retry just waits out another ~100s edge timeout. Surface
            // it immediately; summarizeRange learns SSE for the session and
            // retries once with stream:true (the #2133 self-learn semantics,
            // extended beyond the 400 "stream required" shape). Streaming
            // attempts keep the normal transient replay below.
            if (failure instanceof UpstreamHttpError && !stream && !deps.streamSummaryOff && (failure.status === 524 || failure.status === 504)) {
                throw failure;
            }
            // #2189: retrying the identical shape cannot succeed — name it and fail fast.
            const shapeRejection = failure instanceof UpstreamHttpError
                && isCredentialShapeRejection(failure.status, failure.body);
            if (shapeRejection) {
                deps.log("warn", `[preflight] summary rejected with HTTP 429 rate_limit_error "Error" — suspected credential-shape rejection rather than a rate limit (upstream requires a request attribute missing from this summary call, e.g. the client's billing-attribution system block; #2189); not retrying`);
            }
            const retryable = shapeRejection
                ? false
                : failure instanceof UpstreamHttpError
                    ? isTransientUpstreamError(failure.status, failure.body)
                    : failure.retryable;
            if (!retryable || attempt >= maxAttempts) {
                if (failure instanceof UpstreamHttpError && failure.status >= 400 && failure.status < 500) {
                    dumpSummaryRejection(failure.status, deps.session.id, body, failure.body);
                }
                throw failure;
            }
            retryDetail = failure instanceof UpstreamHttpError ? `HTTP ${failure.status}` : failure.message;
        } finally {
            clearTimer?.();
        }
        const delayMs = replayBackoffMs(attempt);
        deps.log("warn", `[preflight] summary attempt ${attempt} got ${retryDetail}; retrying in ${delayMs}ms${lastCompressSuffix(deps.session.lastCompress)}`);
        await sleep(delayMs, deps.signal);
    }
}

// #829: the body's shape decides how a summary reply is read, not the requested
// `stream` flag. The flag covers upstreams that answer a stream:true call with
// plain JSON; the mirror case is just as real — the Gemini wire posts its
// summary call to the client's own `:streamGenerateContent` URL, which answers
// SSE whatever the request says (the Gemini payload has no `stream` field to
// turn it off). An SSE body that is never parsed reads as an empty summary, so
// every call in the per-request budget is spent for nothing and the turn
// fail-fasts with "context exceeds the model window" instead of compressing.
const SSE_DATA_LINE_RE = /(?:^|\n)data:/;

async function requestSummary(deps: PreflightDeps, system: string, content: string, stream: boolean, includeMaxOutputTokens: boolean): Promise<SummaryOutcome> {
    const text = await requestSummaryBody(deps, JSON.stringify(summaryPayload(deps.protocol, deps.model, system, content, stream, includeMaxOutputTokens, safeHost(deps.url), deps.config.modelContextLimit, deps.billingBlock)), stream);
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }
    // Streaming bodies are SSE, but a non-conforming upstream may answer a
    // stream:true call with plain JSON — accept either shape, and likewise for
    // a non-stream call answered with SSE (#829).
    const sseBody = SSE_DATA_LINE_RE.test(text);
    const summary = (json && typeof json === "object"
        ? extractSummaryText(deps.protocol, json as Record<string, unknown>)
        : stream || sseBody
            ? extractSummaryFromSse(deps.protocol, text)
            : "").trim();
    if (!json && !stream && !sseBody) {
        deps.log("warn", `[preflight] summary response was not JSON: ${text.slice(0, 200)}`);
    }
    if (summary.length < MIN_SUMMARY_CHARS) {
        const diagnosis = diagnoseEmptySummary(text, json);
        deps.log("warn", `[preflight] summary too short (${summary.length} chars): ${diagnosis}`);
        return { unusable: diagnosis, transient: !emptySummaryIsSizeDriven(diagnosis) };
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

// #2383: CPU-only stand-in for the LLM summary in the emergency-fold regime.
// A fold only needs a summary the kernel accepts that nets a shrink; the
// folded originals stay restorable because applyRanges caches them (CCR store)
// exactly like any other preflight fold. The digest is structural — per-entry
// ref/label/size plus a head fragment — so a reader can see what was folded
// and where it lives. Three fallback forms guarantee the result fits BOTH
// maxSummaryLength and the net-shrink bound by construction; the output is
// deterministic (no timestamps), so repeated folds of identical content are
// byte-stable for prefix caching.
interface DigestEntry {
    ref: string;
    label: string;
    text: string;
}

interface DeterministicDigestOptions {
    /** compress.maxSummaryLength chars; <= 0 means unbounded. */
    maxSummary?: number;
    /** compress.minSummaryLength chars — the floor the kernel requires. */
    minSummaryLength: number;
    /** countText-unit ceiling (spanUnits / NET_SHRINK_TOLERANCE). */
    shrinkBound: number;
    countText: (text: string) => number;
}

export function deterministicDigest(entries: DigestEntry[], startRef: string, endRef: string, opts: DeterministicDigestOptions): string {
    const { maxSummary, minSummaryLength, shrinkBound, countText } = opts;
    const totalChars = entries.reduce((sum, entry) => sum + entry.text.length, 0);
    const header = `[deterministic digest ${startRef}:${endRef}] ${entries.length} message(s), ~${totalChars} char(s) total. Emergency fast-path under extreme overflow (#2383): structural digest, no LLM summary; originals preserved - decompress this block to restore them verbatim.`;
    const fits = (form: string): boolean =>
        countText(form) <= shrinkBound && (maxSummary === undefined || maxSummary <= 0 || form.length <= maxSummary);
    const line = (entry: DigestEntry, headChars: number): string => {
        const head = headChars > 0 ? ` :: ${entry.text.replace(/\s+/g, " ").trim().slice(0, headChars)}` : "";
        return `[${entry.ref} ${entry.label}] ${entry.text.length}ch${head}`;
    };
    for (const headChars of [DIGEST_HEAD_CHARS, 0]) {
        const body = entries.map((entry) => line(entry, headChars)).join("\n");
        const form = entries.length > 0 ? `${header}\n${body}` : header;
        if (fits(form)) return form;
    }
    if (fits(header)) return header;
    // Pathological: even the header cannot fit the bounds — emit a minimal
    // marker padded to the kernel's minimum so the block still applies.
    const marker = `[deterministic digest ${startRef}:${endRef}]`;
    if (marker.length >= minSummaryLength) return marker;
    const pad = Math.max(0, minSummaryLength - marker.length - 1);
    return `${marker} ${"x".repeat(pad)}`;
}

export async function preflightCompress(deps: PreflightDeps, messages: CoreMessage[]): Promise<PreflightResult> {
    const limit = deps.config.modelContextLimit;
    // #1843 dual-channel accounting: fold decisions run on the TEXT channel —
    // text estimate vs `target − imageReserve`. Algebraically the same firing
    // set as the old total-view check (max(B, T+R) >= C  <=>  max(max(0,B−R), T)
    // >= max(0,C−R)), but an image-estimate error can no longer start or stop
    // folding. Images ride the payload verbatim through every round, so the
    // reserve is constant for this invocation. Kernel-facing quantities below
    // keep the total view (reserve added back): conservative direction, and the
    // kernel's own truncation/absorb behavior stays byte-identical.
    const imageReserve = deps.imageReserve ?? 0;
    const wireOverhead = deps.wireOverhead ?? 0;
    // #1933 F1: capture k̂ once — it only mutates on usage settlement (outside
    // this invocation), while every fit judgment in this loop must stay on
    // one consistent scale with the gate that started it.
    // #2117 B: model-provenance gate — a factor learned on another model acts
    // as absent (raw estimate) rather than deciding with a cross-model scale.
    const kFactor = currentCalibrationFactor(deps.session.stats, deps.session.metadata?.lastModel);
    const kOrigin = deps.session.stats.calibratedEstimateOrigin;
    let textTarget = Math.max(0, Math.min(limit, deps.compressionTarget ?? limit) - imageReserve);
    const result: PreflightResult = { compressedRanges: 0, savedTokens: 0, payloadEstimate: applyEstimateCalibration(estimateCoreMessages(messages) + wireOverhead, kFactor, kOrigin, deps.upstreamOrigin) + imageReserve, rangesRemaining: 0, fitsWindow: true };
    if (limit <= 0) return result;
    if (deps.externalSummary === undefined) {
        try {
            // The plan rides the request Config rail: deps.config is this
            // request's resolved Config (three-level cascade), so the plan
            // always matches the settings the wire path itself resolved.
            deps = { ...deps, externalSummary: configuredSummaryPlan((deps.config as ResolvedKernelConfig).externalSummary) };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            deps.log("warn", `[external-summary] configuration unavailable; using legacy preflight: ${detail}`);
        }
    }
    const budget = Math.max(MIN_CHUNK_TOKENS, Math.floor(limit * CHUNK_FRACTION));
    // applyCompression rejects ranges below config.compress.minCompressRange
    // tokens, so never spend a summarization call on a chunk that can't apply.
    const minTokens = deps.config.compress.minCompressRange;
    // Char-regime (#553 upper-bound) equivalent of the token gate: worst case is
    // 4 chars per token (all-Latin), so a span this large always clears the
    // kernel's token gate regardless of script mix.
    const minGateChars = minTokens * 4;
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
    let decisionTokens = 0;
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
    // #1372: every silent skip leaves a trace — preflight and the plugin compress
    // path judge the same range at different pipeline positions, so their verdicts
    // can legitimately diverge; recording where+why makes the divergence diffable.
    const skipReasons: string[] = [];
    const noteSkip = (reason: string): void => {
        if (skipReasons.length < 8 && !skipReasons.includes(reason)) skipReasons.push(safePrefix(reason, 200));
    };
    let subMinNoted = false;
    let summaryCalls = 0;
    let budgetHit = false;
    let transientRetryBudget = TRANSIENT_EMPTY_RETRY_BUDGET;
    let rangesTried = 0;
    let rangesRemaining = 0;
    // #1933 F3: scale the depth budgets with the entry overshoot (coverage-bound
    // note atop the file). A raised budget is only a ceiling — well-behaved
    // payloads exit early exactly as before; only genuinely huge payloads burn
    // toward it before the fail-fast reports how far it ran out.
    const entryLocal = (baselineKnown ? estimateCoreMessages(messages) : estimateCoreMessagesUpper(messages)) + imageReserve + wireOverhead;
    const entryTokens = Math.max(baselineKnown ? deps.session.stats.lastInputTokens : 0, entryLocal);
    const overshootRatio = limit > 0 && entryTokens > 0 ? entryTokens / limit : 1;
    const summaryBudget = Math.min(MAX_SUMMARY_CALLS_PER_PREFLIGHT * 2, Math.max(MAX_SUMMARY_CALLS_PER_PREFLIGHT, Math.ceil(MAX_SUMMARY_CALLS_PER_PREFLIGHT * overshootRatio)));
    const roundBudget = Math.min(MAX_PREFLIGHT_ROUNDS * 2, Math.max(MAX_PREFLIGHT_ROUNDS, Math.ceil(MAX_PREFLIGHT_ROUNDS * overshootRatio)));
    if (summaryBudget > MAX_SUMMARY_CALLS_PER_PREFLIGHT) {
        deps.log("warn", `[preflight] payload ~${entryTokens} tok vs window ${limit} (~${overshootRatio.toFixed(1)}x) — raising summarization budget ${MAX_SUMMARY_CALLS_PER_PREFLIGHT} -> ${summaryBudget}, rounds ${MAX_PREFLIGHT_ROUNDS} -> ${roundBudget}`);
    }
    // #2383: the fold MECHANISM is decided once per invocation from the entry
    // overshoot (same discipline as baselineKnown — no mid-loop regime flips).
    // Beyond EMERGENCY_FOLD_COVERAGE the LLM path cannot converge here, so
    // every fold becomes a deterministic digest: zero upstream calls, no
    // failure modes, originals restorable via decompress.
    // The regime judges the FOLDABLE mass (entryLocal), never the
    // baseline-floored entryTokens: a usage baseline measured on another model
    // (model switch) or a stale high-water mark covers system prompt + tool
    // definitions that NO fold can remove — letting it pick the regime would
    // digest-fold ordinary payloads (caught by the model-switch e2e: its
    // summarization calls vanished under a 300k foreign-model baseline).
    const entryOvershoot = limit > 0 && entryLocal > 0 ? entryLocal / limit : 1;
    const emergencyFold = entryOvershoot > EMERGENCY_FOLD_COVERAGE;
    const effectiveRoundCap = emergencyFold ? EMERGENCY_ROUND_CAP : roundBudget;
    if (emergencyFold) {
        deps.log("warn", `[preflight] payload ~${entryLocal} tok vs window ${limit} (~${entryOvershoot.toFixed(1)}x) exceeds the LLM fold path's coverage bound (${EMERGENCY_FOLD_COVERAGE}x) — folding with deterministic digests instead of summarization calls; originals stay restorable via decompress (#2383)`);
    }
    for (let round = 0; round < effectiveRoundCap; round++) {
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
            config: noEmergencyTruncate(ccrLoopConfig(deps.session, activeConfig)),
            tokenCount: currentTokens,
            renderTags: "text-only",
            contentStore: contentStoreOf(deps.session),
        });
        deps.session.state = turn.state;
        adoptContentStore(deps.session, turn.contentStore);
        // Absorbed pairs are hidden on the wire, so the fit check must see the
        // same reduced payload prepare* will actually forward.
        turn.messages = applyAbsorbView(turn.messages, turn.state, activeConfig, currentTokens);
        // Floor on the session's measured input baseline: the upstream's
        // input_tokens also covers the system prompt + tool definitions, which
        // are not in turn.messages, so the direct estimate can undershoot.
        // #1839: an overflow-armed baseline floors too — it is upstream
        // REJECTION evidence at that size, and without it the kernel sees only
        // the undershooting local estimate and refuses to fold what the
        // rejection proved necessary (#1195 refold / #987 next-turn fold).
        // #1492: an ESTIMATE-sourced failure arm may floor only while the
        // payload is unmeasured (empty input → transform failed, outbound IS
        // raw); a stale one from an earlier unfolded turn would pin
        // currentTokens at millions and burn rounds folding ranges the window
        // never needed.
        const baselineFloor = messages.length > 0
            ? ((deps.session.stats.lastInputTokensSource === "usage" || deps.session.stats.lastInputTokensSource === "overflow-arm") ? deps.session.stats.lastInputTokens : 0)
            : deps.session.stats.lastInputTokens;
        const rawRoundText = estimateCoreMessages(turn.messages) + wireOverhead;
        // #1933 F1: same calibrated caliber as the gate's trigger/fit checks —
        // per-round exit and final fit must judge this payload identically to
        // the trigger that started the invocation (no mid-loop scale drift).
        const roundText = applyEstimateCalibration(rawRoundText, kFactor, kOrigin, deps.upstreamOrigin);
        currentTokens = Math.max(baselineFloor, roundText + imageReserve);
        // #1843: the TEXT-channel judgment quantity — the usage-grade baseline
        // bills images too, so project it onto the text channel by subtracting
        // the reserve (floored at zero).
        decisionTokens = Math.max(Math.max(0, baselineFloor - imageReserve), roundText);
        if (!baselineKnown) {
            // #558-merge: the upper-bound regime also carries the image/wire
            // floors — they are real billed costs the fold can never remove
            // (#470/#488 postdate this PR's fork point).
            finalUpper = estimateCoreMessagesUpper(turn.messages) + imageReserve + wireOverhead;
            currentTokens = Math.max(currentTokens, finalUpper);
            decisionTokens = Math.max(decisionTokens, estimateCoreMessagesUpper(turn.messages) + wireOverhead);
        }
        // The caller's forward/fail-fast gate uses the payload's own estimate
        // (the floor can be stale — see PreflightResult.payloadEstimate).
        result.payloadEstimate = roundText + imageReserve;
        if (startTokens < 0) startTokens = currentTokens;
        if (decisionTokens < textTarget) break;
        // #847: drop sub-minimum ranges at list level too — every chunk of a
        // sub-min range fails the apply-side gate, so walking them only burns
        // rounds and misreports "N viable ranges tried"; with them gone the
        // empty-list path below can reach the #330 soft-zone relaxation.
        const viable = viableRanges(turn.nudge?.compressibleRanges ?? []);
        const ranges = viable.filter((r) => minTokens <= 0 || r.tokens >= minTokens);
        // #1372: the list-level minCompressRange filter used to drop sub-minimum
        // ranges silently — "no compressible ranges remain" gave no hint that
        // ranges existed but were all under the gate.
        if (ranges.length === 0 && viable.length > 0 && !subMinNoted) {
            subMinNoted = true;
            deps.log("warn", `[preflight] ${viable.length} viable range(s) are below minCompressRange (${minTokens} tokens); none foldable`);
            noteSkip(`all ${viable.length} viable range(s) below minCompressRange (${minTokens} tokens)`);
        }
        rangesRemaining = ranges.length;
        if (baselineKnown && ranges.length > 0) {
            // #1841: round-level futility gate. A fold removes its span's mass
            // at best (its summary re-enters the payload), so the sum of all
            // foldable range masses bounds this round's possible saving. When
            // even that cannot close the gap to the window, no combination of
            // folds can fit the payload — walking would only burn summarization
            // calls minutes at a time (incident 08cc0df7: ~9 calls over 5 min,
            // net −5.5%). Skip with zero calls and an honest detail instead.
            // The deficit is measured on payloadEstimate (the floorless wire
            // estimate the caller's forward decision itself uses, #470/#1492),
            // NOT on currentTokens: the usage-based floor also covers system
            // prompt + tool definitions that folding cannot remove, so a
            // floor-pinned deficit would declare futility while folding would
            // still bring the forwarded payload under the window.
            // Only RESOLVABLE ranges can ever fold: a range whose refs are
            // absent from the current state dies in the walk before any summary
            // call, contributing zero saving. And a pool that is entirely dead
            // (potential === 0) must still be walked — it spends no calls and
            // its per-range skip notes are the only record of WHY each
            // candidate died (#1372 brain-split shape); gating it would mask
            // that diagnosis behind a window-mis-size verdict.
            const { refToIdx: gateRefs } = refMaps(messages, deps.session.state);
            const resolvableMass = (rs: Array<{ startRef: string; endRef: string; tokens: number }>): number => rs.reduce((sum, r) => {
                const si = gateRefs.get(r.startRef);
                const ei = gateRefs.get(r.endRef);
                return si !== undefined && ei !== undefined && si <= ei ? sum + r.tokens : sum;
            }, 0);
            let potential = resolvableMass(ranges);
            const deficit = result.payloadEstimate - limit;
            if (potential > 0 && deficit > 0 && potential * FUTILITY_SLACK < deficit) {
                if (!relaxed) {
                    // The soft-protected recent zone is not in `ranges` yet; #330
                    // makes it foldable on relax. Probe the relaxed view (CPU-only,
                    // mirrors the preview convention — kernel entry points return
                    // new state without mutating the input) before declaring
                    // futility, or a false positive here regresses the #330 path.
                    const probe = deps.core.processTurn({
                        messages,
                        state: deps.session.state,
                        config: noEmergencyTruncate(ccrLoopConfig(deps.session, relaxedConfig(deps.config))),
                        tokenCount: currentTokens,
                        renderTags: "text-only",
                        contentStore: contentStoreOf(deps.session),
                    });
                    const relaxedRanges = viableRanges(probe.nudge?.compressibleRanges ?? []).filter((r) => minTokens <= 0 || r.tokens >= minTokens);
                    const relaxedPotential = resolvableMass(relaxedRanges);
                    if (relaxedPotential * FUTILITY_SLACK >= deficit) {
                        activeConfig = relaxedConfig(deps.config);
                        relaxed = true;
                        textTarget = Math.max(0, limit - imageReserve);
                        summaryCalls = 0;
                        budgetHit = false;
                        transientRetryBudget = TRANSIENT_EMPTY_RETRY_BUDGET;
                        deps.log("warn", `[preflight] foldable mass outside the protected recent zone (~${potential} tok) cannot close the ${deficit}-tok gap; relaxing soft protection up front and retrying (#1841)`);
                        continue;
                    }
                    // The relaxed pool is the superset: quote it as the true bound.
                    potential = relaxedPotential;
                }
                const zoneNote = relaxed ? ", including the relaxed recent zone" : "";
                failure = { kind: "exhausted", detail: `futile round: the maximum possible saving from all foldable content (~${potential} tokens${zoneNote}) is below the required reduction (~${deficit} tokens) — no combination of folds can bring the payload under the target. Raise the model context window or restart the session.` };
                deps.log("warn", `[preflight] skipping futile round: max possible saving ~${potential} tok < required ~${deficit} tok${zoneNote}; zero summarization calls spent (#1841)`);
                break;
            }
        }
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
                textTarget = Math.max(0, limit - imageReserve);
                // #575-merge: the summarization budget counts per protection
                // regime — reset it on relax, else bad summaries burned under
                // normal protection can starve the relaxed walk entirely and
                // reintroduce the #330 unrecoverable stall.
                summaryCalls = 0;
                budgetHit = false;
                transientRetryBudget = TRANSIENT_EMPTY_RETRY_BUDGET;
                deps.log("warn", "[preflight] no compressible ranges outside the protected recent zone; relaxing soft protection (preserveRecentMessages/Tokens -> 0) and retrying");
                continue;
            }
            failure = { kind: "exhausted", detail: relaxed ? relaxedExhaustedDetail : subMinNoted
                ? `no foldable compressible ranges remain: all ${viable.length} viable range(s) are below minCompressRange (${minTokens} tokens)`
                : "no compressible ranges remain in the conversation" };
            break;
        }
        const ordered = [...ranges].sort((a, b) => refNum(a.startRef) - refNum(b.startRef));
        let appliedThisRound = 0;
        // #1841: set when the mid-walk futility check stops the walk before
        // every range was tried; the round-end site turns it into a failure
        // unless the #330 relax path is still available.
        let futileBail = false;
        let bailRemaining = 0;
        let bailDeficit = 0;
        for (let oi = 0; oi < ordered.length; oi++) {
            const range = ordered[oi];
            if (decisionTokens < textTarget) break;
            if (deps.signal?.aborted) {
                failure = ABORTED_FAILURE;
                break;
            }
            if (budgetHit) break;
            const skipKey = `${range.startRef}:${range.endRef}`;
            if (skipSet.has(skipKey)) continue;
            const { refToIdx } = refMaps(messages, deps.session.state);
            if (baselineKnown) {
                // #1841: mid-walk futility bail. Ranges already consumed,
                // skipped, or unresolvable cannot yield saving; when the live
                // untried rest of the walk cannot close the gap either, stop
                // before spending more summarization calls on ranges that
                // cannot change the outcome. Same payloadEstimate-based deficit
                // as the pre-walk gate (floor-pinned currentTokens would
                // overstate what folding can still influence). remaining === 0
                // means every rest-of-walk candidate is structurally dead —
                // walking it is call-free and its notes are the diagnosis
                // (#1372), so bail only when some live mass remains.
                let remaining = 0;
                for (let j = oi; j < ordered.length; j++) {
                    const rj = ordered[j];
                    if (skipSet.has(`${rj.startRef}:${rj.endRef}`)) continue;
                    const si = refToIdx.get(rj.startRef);
                    const ei = refToIdx.get(rj.endRef);
                    if (si !== undefined && ei !== undefined && si <= ei) remaining += rj.tokens;
                }
                const deficit = result.payloadEstimate - limit;
                if (remaining > 0 && deficit > 0 && remaining * FUTILITY_SLACK < deficit) {
                    futileBail = true;
                    bailRemaining = remaining;
                    bailDeficit = deficit;
                    deps.log("warn", `[preflight] remaining foldable mass (~${remaining} tok) cannot close the ~${deficit}-tok gap; stopping further summarization calls (#1841)`);
                    break;
                }
            }
            const startIdx = refToIdx.get(range.startRef);
            const endIdx = refToIdx.get(range.endRef);
            if (startIdx === undefined || endIdx === undefined || startIdx > endIdx) {
                skipSet.add(skipKey);
                const why = startIdx === undefined
                    ? `start ref ${range.startRef} is absent from the current messages`
                    : endIdx === undefined
                        ? `end ref ${range.endRef} is absent from the current messages`
                        : `position resolution inverted the range (${startIdx} > ${endIdx})`;
                deps.log("warn", `[preflight] skipping range ${skipKey}: ${why}`);
                noteSkip(`${skipKey}: ${why}`);
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
            const spans: Array<[number, number]> = splitChunks(messages, startIdx, endIdx, budget, baselineKnown ? 0 : minGateChars, countText).slice().reverse();
            while (spans.length > 0) {
                if (decisionTokens < textTarget) break;
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
                if (!startRef || !endRef) {
                    deps.log("warn", `[preflight] dropping span ${cs}..${ce} of range ${skipKey}: boundary message has no ref in the current state`);
                    noteSkip(`${skipKey}: span ${cs}..${ce} boundary message has no ref`);
                    continue;
                }
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
                if (!planned) {
                    // #1372: the kernel verdict used to be discarded here — this is where
                    // "no range could be compressed" died silently (minCompressRange gate,
                    // unknown/consumed refs, fully protected span, dummy summary length).
                    const verdict = safePrefix([...preview.result.errors, ...preview.result.warnings].join("; "), 300)
                        || "the kernel created no block and reported no error";
                    deps.log("warn", `[preflight] preview rejected range ${skipKey}: ${verdict}`);
                    noteSkip(`${skipKey}: preview rejected — ${verdict}`);
                    continue;
                }
                // Direct raw messages render host-side: #781 image notes live in BiliMessage
                // sidecars the kernel never sees. Consumed child blocks render through the
                // kernel from the original state so they stay summaries.
                const idxById = new Map(messages.map((m, i) => [m.id, i]));
                // #1995: summary notes carry the ref so the fold's own text
                // points at the restore channel (decompress imageRef).
                const byRaw = deps.session.state?.messageRefs?.byRaw;
                const parts: string[] = [];
                const droppedParts: string[] = [];
                // #2383: parallel to `parts` — the digest's input, collected only
                // in the emergency regime so the LLM path stays byte-identical.
                const entries: DigestEntry[] = [];
                for (const id of planned.directMessageIds) {
                    const i = idxById.get(id);
                    if (i === undefined) { droppedParts.push(`message ${id} not found in current messages`); continue; }
                    const m = messages[i];
                    let text = m.text ?? "";
                    const notes = imagePlaceholdersForSummary(m, byRaw?.[m.id]);
                    if (notes.length > 0) {
                        const note = notes.join(" ");
                        text = text === IMAGE_PLACEHOLDER ? note : text ? `${text}\n${note}` : note;
                    }
                    if (!text) { droppedParts.push(`message ${id} rendered no text`); continue; }
                    const label =
                        m.contentType === "tool-call"
                            ? `assistant tool-call ${m.toolName ?? "?"}`
                            : m.contentType === "tool-result"
                              ? `tool result ${m.toolName ?? "?"}`
                              : m.contentType === "reasoning"
                                ? "assistant reasoning"
                                : m.role;
                    parts.push(`[${label}]\n${text}`);
                    if (emergencyFold) entries.push({ ref: maps.idxToRef.get(i) ?? "?", label, text });
                }
                for (const nid of planned.directBlockIds) {
                    const nb = deps.session.state.blocks.find((b) => b.blockId === nid);
                    // The child stays a summary: its raw text is already condensed, and
                    // re-expanding it would defeat the compression this fold performs.
                    if (!nb) { droppedParts.push(`child block ${nid} missing from state`); continue; }
                    const label = nb.topic ? `${nb.blockId}: ${nb.topic}` : nb.blockId;
                    parts.push(`[summarized ${label}]\n${nb.summary}`);
                    if (emergencyFold) entries.push({ ref: nb.blockId, label: `summarized ${label}`, text: nb.summary });
                }
                if (droppedParts.length > 0) {
                    deps.log("debug", `[preflight] range ${skipKey}: ${droppedParts.length} part(s) rendered nothing (${droppedParts.slice(0, 3).join("; ")})`);
                }
                const content = parts.join("\n\n");
                if (content.length === 0) {
                    deps.log("warn", `[preflight] planned block for range ${skipKey} rendered no text: ${droppedParts.slice(0, 5).join("; ") || "all parts empty"}`);
                    noteSkip(`${skipKey}: planned block rendered no text (${droppedParts.slice(0, 3).join("; ") || "all parts empty"})`);
                    continue;
                }
                let summary: string | null = null;
                let outcome: SummaryOutcome | undefined;
                // #2383: hoisted out of the LLM path below — the emergency digest
                // branch needs the span's mass for its net-shrink bound before any
                // summary exists; units match the post-fold accounting.
                const spanUnits = baselineKnown
                    ? planned.compressedTokens
                    : messages.filter((message) => planned.effectiveMessageIds.includes(message.id)).reduce((total, message) => total + (message.text ?? "").length, 0);
                if (emergencyFold) {
                    // Zero-upstream-call fold. The digest fits maxSummaryLength AND
                    // the net-shrink bound by construction (fallback forms), so it
                    // never reaches the halving/skip recovery below — those stay the
                    // LLM regime's.
                    const shrinkBound = Math.max(activeConfig.compress.minSummaryLength, Math.floor(spanUnits / NET_SHRINK_TOLERANCE));
                    summary = deterministicDigest(entries, startRef, endRef, {
                        maxSummary: activeConfig.compress.maxSummaryLength,
                        minSummaryLength: activeConfig.compress.minSummaryLength,
                        shrinkBound,
                        countText,
                    });
                    deps.log("info", `[preflight] range ${skipKey}: deterministic digest fold of ${entries.length} part(s) -> ${summary.length} chars, no summarization call (#2383)`);
                } else {
                    try {
                        const parts: string[] = [];
                        const chunks = splitSummaryContent(content, budget, countText);
                        // #1775: spread maxSummaryLength across the chunks (minus the exact
                        // "\n\n" join gaps) so each summarization call carries a per-chunk
                        // character ceiling — previously nothing bounded the model's output,
                        // and one verbose chunk made the whole assembly unusable.
                        const maxSummary = activeConfig.compress.maxSummaryLength;
                        const perChunkBudget = maxSummary > 0 ? Math.floor((maxSummary - (chunks.length - 1) * SUMMARY_JOIN_GAP) / chunks.length) : undefined;
                        for (const chunk of chunks) {
                            if (summaryCalls >= summaryBudget) {
                                budgetHit = true;
                                break;
                            }
                            summaryCalls += 1;
                            let part = await summarizeRange(deps, chunk, startRef, endRef, perChunkBudget);
                            let transientTries = 0;
                            while (
                                "unusable" in part && part.transient &&
                                transientTries < TRANSIENT_EMPTY_SUMMARY_RETRIES &&
                                transientRetryBudget > 0 &&
                                summaryCalls < summaryBudget &&
                                !deps.signal?.aborted
                            ) {
                                transientTries += 1;
                                transientRetryBudget -= 1;
                                const delayMs = replayBackoffMs(transientTries);
                                deps.log("warn", `[preflight] transient empty summary on ${startRef}:${endRef} (${part.unusable.slice(0, 160)}); retrying same span in ${delayMs}ms (${transientTries}/${TRANSIENT_EMPTY_SUMMARY_RETRIES})`);
                                await sleep(delayMs, deps.signal);
                                summaryCalls += 1;
                                part = await summarizeRange(deps, chunk, startRef, endRef, perChunkBudget);
                            }
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
                            // halving/skip path as any unusable output. #1775: except when
                            // truncating to the cap still nets savings (the candidate is
                            // shorter than the folded content) — then rescue the summary
                            // instead of discarding the whole range. #1819: every accepted
                            // candidate — rescued or not — must additionally satisfy net-shrink
                            // monotonicity (NET_SHRINK_TOLERANCE) — same units as the post-fold
                            // accounting below: token regime takes the kernel's credit for this
                            // span, char regime the raw-char mass of the folded messages. A
                            // regurgitated summary that exceeds its range routes through the
                            // halving/skip path like any other unusable output instead of
                            // inflating the payload.
                            const shrinkOk = (text: string): boolean => countText(text) <= spanUnits * NET_SHRINK_TOLERANCE;
                            if (maxSummary <= 0 || candidate.length <= maxSummary) {
                                if (shrinkOk(candidate)) {
                                    summary = candidate;
                                } else {
                                    outcome = { unusable: `assembled summary (~${countText(candidate)} units) does not shrink its range (~${spanUnits} units) — suspected regurgitation` };
                                }
                            } else if (candidate.length < content.length) {
                                const rescued = truncateSummaryToLimit(candidate, maxSummary, activeConfig.compress.minSummaryLength);
                                if (rescued !== null && shrinkOk(rescued)) {
                                    deps.log("warn", `[preflight] range ${skipKey}: assembled summary ${candidate.length} chars exceeded maxSummaryLength (${maxSummary}); truncated to ${rescued.length} chars`);
                                    summary = rescued;
                                } else if (rescued !== null) {
                                    outcome = { unusable: `assembled summary (~${countText(rescued)} units after truncation) does not shrink its range (~${spanUnits} units) — suspected regurgitation` };
                                } else {
                                    outcome = { unusable: `assembled summary (${candidate.length} chars) exceeds maxSummaryLength (${maxSummary}) and cannot be truncated to a usable length` };
                                }
                            } else {
                                outcome = { unusable: `assembled summary (${candidate.length} chars) exceeds maxSummaryLength (${maxSummary}) and is not shorter than the folded content (${content.length} chars)` };
                            }
                        }
                    } catch (err) {
                        if (err instanceof UpstreamHttpError) {
                            // #1993: the rejection body is the only evidence for WHY the
                            // upstream said no — log it the way the main paths already do
                            // and carry a bounded snippet into the client-visible detail.
                            const transient = isTransientUpstreamError(err.status, err.body);
                            const shapeRejection = isCredentialShapeRejection(err.status, err.body);
                            const bodySnippet = safePrefix(err.body.trim(), 200);
                            failure = {
                                kind: "upstream",
                                status: err.status,
                                // #2189: a shape-based rejection is deterministic for this
                                // payload — a client retry hits the same wall, so do not
                                // advertise retryability (and let the dead-end cooldown arm).
                                retryable: shapeRejection ? false : transient,
                                detail: err.status === 429
                                    ? shapeRejection
                                        ? `the summarization call was rejected with HTTP 429 (rate_limit_error "Error") — suspected credential-shape rejection rather than a rate limit (the upstream requires a request attribute missing from the summary call, e.g. the client's billing-attribution system block; #2189)`
                                        : `the summarization call was rate-limited by the upstream (HTTP 429)`
                                    : `the summarization call was rejected by the upstream (HTTP ${err.status})${bodySnippet ? `: ${bodySnippet}` : ""}`,
                            };
                            deps.log("warn", `[preflight] summarization failed: HTTP ${err.status} after ${err.attempts} attempt(s)${bodySnippet ? `: ${bodySnippet}` : ""}`);
                            // #1993: a hard (non-transient) size-plausible rejection gets the
                            // same halving recovery as an unusable HTTP-200 summary — the
                            // whole request was refused, so it is at least as likely to be
                            // size-driven as an empty 200. Transient 4xx (risk-control
                            // markers) keep the replay-retry semantics; other 4xx (auth /
                            // routing) fail fast instead of burning the call budget;
                            // unsplittable spans fall through to the give-up below. The
                            // cascade is bounded by the per-invocation summary budget
                            // (summaryBudget, #1933) via the while-top budgetHit check.
                            const floorUnits = baselineKnown ? 2 * MIN_CHUNK_TOKENS : 2 * minGateChars;
                            if ((err.status === 400 || err.status === 413) && !transient
                                && ce > cs && spanUnitsOf(messages, cs, ce, countText) >= floorUnits) {
                                lastUnusableDetail = `HTTP ${err.status}: ${bodySnippet}`;
                                deps.log("warn", `[preflight] chunk ${startRef}:${endRef} rejected with HTTP ${err.status}; retrying with smaller chunks`);
                                const mid = Math.floor((cs + ce) / 2);
                                spans.push([mid + 1, ce]);
                                spans.push([cs, mid]);
                                continue;
                            }
                        } else if (deps.signal?.aborted) {
                            failure = ABORTED_FAILURE;
                            deps.log("warn", `[preflight] summarization aborted: client disconnected`);
                        } else if (err instanceof SummaryTransportError) {
                            // #1987: a transport-class death carries NO upstream verdict about the
                            // content — the call simply did not complete — so it stays retryable for
                            // the client regardless of which code surfaced (a cert problem is not more
                            // terminal than a gzip corruption). Only an abort (client gone / idle budget)
                            // is not worth retrying; keep that case's field omitted as before.
                            const caNote = err.code !== undefined && TLS_TRUST_HINT_CODES.has(err.code)
                                ? " This looks like TLS certificate interception (corporate proxy/MITM): install the corporate root CA for Node.js via NODE_EXTRA_CA_CERTS=/path/to/ca.pem, or run node with --use-system-ca."
                                : "";
                            failure = { kind: "upstream", detail: `the summarization call failed: ${err.message}${caNote}`, ...(err.aborted ? {} : { retryable: true }) };
                            deps.log("warn", `[preflight] summarization failed: ${err.message}`);
                        } else {
                            failure = { kind: "upstream", detail: "the summarization call failed unexpectedly" };
                            deps.log("warn", "[preflight] summarization failed unexpectedly");
                        }
                        break;
                    }
                }
                if (summary === null) {
                    const unusableDetail = outcome && "unusable" in outcome ? outcome.unusable : "unknown";
                    if (outcome) lastUnusableDetail = unusableDetail;
                    const floorUnits = baselineKnown ? 2 * MIN_CHUNK_TOKENS : 2 * minGateChars;
                    if (ce > cs && spanUnitsOf(messages, cs, ce, countText) >= floorUnits) {
                        deps.log("warn", `[preflight] chunk ${startRef}:${endRef} produced no usable summary (${unusableDetail}); retrying with smaller chunks`);
                        const mid = Math.floor((cs + ce) / 2);
                        spans.push([mid + 1, ce]);
                        spans.push([cs, mid]);
                        continue;
                    }
                    deps.log("warn", `[preflight] range ${skipKey} produced no usable summary even at minimum size (${unusableDetail}); skipping it`);
                    noteSkip(`${skipKey}: no usable summary even at minimum size (${unusableDetail})`);
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
                // #2146: internal lane — must not arm the model-facing loop breaker.
                const applied = applyRanges(parseCompressInput({ content: [{ startId: startRef, endId: endRef, summary, topic: "preflight overflow compress" }] }), ctx, { loopTracking: false });
                if (applied.outcome === "refused") {
                    deps.log("warn", `[preflight] ${applied.text}`);
                    noteSkip(`${skipKey}: apply failed — ${safePrefix(applied.text.replace(/^\[Compression FAILED[:\s]*/, ""), 200)}`);
                    skipSet.add(skipKey);
                    break;
                }
                // #1993: a fold succeeded after an earlier rejection in this walk — the
                // payload shrank, so the stale failure no longer describes the end
                // state; clear it so a later exhaustion reports its own reason (and a
                // fitting result reports none at all).
                failure = undefined;
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
            // #1841: the mid-walk futility bail becomes a failure here unless the
            // #330 relax path below is still available (!relaxed AND the payload
            // overflows the window) — in that case fall through to it; the next
            // round re-judges on the relaxed view.
            if (futileBail && !budgetHit && (relaxed || result.payloadEstimate < limit)) {
                const zoneNote = relaxed ? ", including the relaxed recent zone" : "";
                // #1372 contract: per-range skip notes are the diagnosis of WHY
                // candidates died — carry them into the bail verdict too.
                const skipNote = skipReasons.length > 0 ? ` Skipped: ${skipReasons.slice(0, 3).join(" | ")}.` : "";
                failure = { kind: "exhausted", detail: `futile round: after the folds so far, the remaining foldable content (~${bailRemaining} tokens${zoneNote}) cannot close the ~${bailDeficit}-token gap to the target even if every remaining range folded successfully.${skipNote} Raise the model context window or restart the session.` };
                break;
            }
            if (!failure && !budgetHit && !relaxed && (baselineKnown ? result.payloadEstimate : finalUpper) >= limit) {
                activeConfig = relaxedConfig(deps.config);
                relaxed = true;
                summaryCalls = 0;
                budgetHit = false;
                transientRetryBudget = TRANSIENT_EMPTY_RETRY_BUDGET;
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
        // #1372: carry the actual per-range skip reasons too — the old hardcoded
        // parenthetical claimed causes that often had not happened (e.g. "below
        // minCompressRange" for a range that died before any summary call).
        const unusableNote = lastUnusableDetail ? ` Last unusable summary: ${safePrefix(lastUnusableDetail, 300)}.` : "";
        const skipNote = skipReasons.length > 0 ? ` Skipped: ${skipReasons.slice(0, 3).join(" | ")}.` : "";
        if (budgetHit) {
            failure = { kind: "exhausted", detail: `the preflight summarization budget (${summaryBudget} calls per protection regime) was exhausted before the payload fit the window${unusableNote}${skipNote}` };
        } else if (relaxed && result.compressedRanges > 0) {
            failure = { kind: "exhausted", detail: `${relaxedExhaustedDetail}${skipNote}` };
        } else if (result.compressedRanges === 0) {
            const cause = skipReasons.length > 0
                ? skipReasons.slice(0, 3).join(" | ")
                : "each was below minCompressRange, had an unusable summary, or failed to apply";
            failure = { kind: "exhausted", detail: rangesTried === 0
                ? `no viable range could be compressed: ${cause}${unusableNote}`
                : `no range could be compressed across ${rangesTried} viable range${rangesTried === 1 ? "" : "s"}: ${cause}${unusableNote}` };
        } else {
            failure = { kind: "exhausted", detail: `the compress budget was exhausted after ${effectiveRoundCap} rounds${unusableNote}${skipNote}` };
        }
    }
    result.rangesRemaining = rangesRemaining;
    result.savedTokens = Math.max(0, startTokens - currentTokens);
    if (currentTokens >= limit) result.failure = failure;
    result.fitsWindow = baselineKnown ? result.payloadEstimate < limit : finalUpper < limit;
    return result;
}
