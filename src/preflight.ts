import {
    BLOCKED_REF,
    countMessageTokens,
    defaultCountTokens,
    viableRanges,
    type CompressionCore,
    type Config,
    type CoreMessage,
    type Prompts,
    type PackSurface,
    type NudgeDecision,
} from "acp-kernel";
import { createHash } from "node:crypto";
import { yieldToEventLoop } from "./yield-loop.js";
import { buildCompressSystemPrompt, parseCompressInput } from "./compress-tool.js";
import { IMAGE_PLACEHOLDER, imagePlaceholdersForSummary } from "./image-note.js";
import { applyAbsorbView } from "./absorb.js";
import { adoptContentStore, ccrLoopConfig, contentStoreOf } from "./store.js";
import { applyRanges, normalizeRangeOrder, type RewriteCtx } from "./stream.js";
import { fetchWithTimeout, isTransientUpstreamError, replayMaxAttempts, replayBackoffMs, sleep, UpstreamHttpError } from "./fetch-util.js";
import { dumpSummaryRejection } from "./error-dump.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import { isTlsTrustCode, tlsTrustRemediation, TLS_TRUST_CODES } from "./upstream-fail.js";
import { lastCompressSuffix, type Session } from "./session.js";
import { epochConfirmPending } from "./fold-reconcile.js";
import { deadSkipKeys, filterDeadRanges, parseStructuralEmptyVerdict, recordDeadRange } from "./dead-ranges.js";
import { peekRegistryOutputLimit } from "./registry.js";
import { safePrefix } from "./text-safe.js";
import { applyEstimateCalibration, currentCalibrationFactor } from "./util.js";
import { configuredSummaryPlan, type ConfiguredSummaryPlan } from "./external-summary-runtime.js";
import { isCodexClient } from "./codex-compact.js";
import { describeExternalSummaryFailure, summaryLengthBudgetClause } from "./external-summary.js";
// #3635: the failure description moved to the leaf module next to its data
// type; re-exported here for importers that historically reached it via preflight.
export { describeExternalSummaryFailure };
import type { ResolvedKernelConfig } from "./compress-settings.js";
import { newExternalCallId } from "./external-summary-marker.js";

// #247: proactive pre-forward compression. When the session's real context
// (previous turn's upstream input_tokens) exceeds the current model's window
// (e.g. the user switched from a 1M-context model to a 260k one), the payload
// overflows at forward time and the reactive nudge can never fire — the
// request itself is rejected by the upstream, so the model never sees the
// nudge and every subsequent request overflows identically (stuck session).
// This module compresses the highest-payoff compressible ranges first —
// outside the soft-protected recent zone, largest span per summarization call
// (#2682: a call costs the same wall clock for 6K or 64K tokens, and the head
// range re-grows after each fold, so age-order starved the big ranges behind
// endless head re-folds); ranges that enter the zone exist only after a
// #330/#1841 relax and stay oldest-first within it, never outranking old
// content — via dedicated summarization calls sized to fit the smaller
// window, before the payload is forwarded.

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
// #2678/#2667: how many disjoint ranges one preflight round nominates into a
// SINGLE external-summary batch call. Sized at the executor pool's default
// concurrency (src/external-summary-runtime.ts): beyond that, extra work items
// only queue inside the same pass. Ranges past the cap fold through the
// serial walk in later rounds exactly as before.
const MAX_PREFLIGHT_SUMMARY_BATCH = 4;
// #2952 Design A: bounded tier-distillation recovery. When raw-range folding
// alone cannot close the window gap but distilling existing lower-tier BLOCKS
// (T1->T2, T2->T3) can, preflight performs the distillation ITSELF — the model
// is blocked from doing it because its next turn is refused by this very
// fail-fast (the deadlock reported in #2952). Hard caps keep it bounded: at most
// MAX_TIER_DISTILL_CALLS summary calls per invocation, and each call's source
// content is capped (TIER_DISTILL_SOURCE_CHAR_BUDGET) so one recovery cannot
// bill an unbounded prompt. Never entered for tiers=false or emergency digest
// mode (no LLM lane), so those paths stay byte-identical.
const MAX_TIER_DISTILL_CALLS = 6;
const TIER_DISTILL_SOURCE_CHAR_BUDGET = 60_000;
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
// #2832: a completion that ends NORMALLY (end_turn / stop / completed) with
// ZERO answer text is not a blip — the model spent its whole turn in the
// thinking channel and stopped cleanly, or the relay stripped the text
// blocks. Re-sending the identical payload returns the identical empty
// answer, so unlike #1767's transient empties (content_filter, truncated
// streams) it earns no same-span retry, and unlike #726's size-driven empties
// halving the span cannot help either: a normal stop is not a size signal.
// K consecutive such answers on the same (host, model) arm a session-level
// dead-probe verdict that stops further probing for this session until a
// probe succeeds again (canary probe per invocation — see preflightCompress).
const DETERMINISTIC_EMPTY_STICKY_LIMIT = 3;
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
    /** Display-only: why this walk runs — "growth" (auto-fold floor) vs "overflow" (window). Labels the applied blocks' topic so panels/logs can tell auto-folds from emergency folds. */
    compressReason?: "growth" | "overflow";
    prompts: Prompts;
    surface?: PackSurface;
    protocol: PreflightProtocol;
    url: string;
    headers: Record<string, string>;
    /** #3226: re-sign hook for body-covering signature lanes (CodeArts APIG
     *  SDK-HMAC-SHA256 and peers). The summarization call sends a body bili built
     *  itself, so any inbound signature that covered the ORIGINAL request body is
     *  invalid here; the caller supplies the same signer the main forward uses
     *  (#1884 re-sign arm) so the summary egress carries a signature over its OWN
     *  bytes instead of someone else's (which the gateway rejects with 401
     *  body-hash-mismatch, killing compression on signed lanes). Absent for
     *  unsigned traffic — summaryHeaders then clones the inbound auth as-is. */
    resign?: (headers: Record<string, string>, body: string) => void;
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
    /** Pure fold-math proved NO combination of folds can close the gap regardless of
     * upstream health (#3461) — the host answers non-retryable 4xx instead of a
     * transient 502. Relay-dependent exhaustion (empty/truncated/incomplete
     * summaries, budget draws, pool saturation) deliberately leaves this unset:
     * those walks can succeed on retry once the relay recovers. */
    deterministic?: boolean;
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
type SummaryOutcome = { summary: string; external?: boolean } | { unusable: string; transient?: boolean; deterministic?: boolean; external?: never };

// Persistence can replace the session state while a summary request is in flight.
function foldTargetKey(block: Session["state"]["blocks"][number], state: Session["state"]): string {
    return JSON.stringify([
        block.directMessageIds,
        block.effectiveMessageIds,
        block.directBlockIds.map((id) => {
            const source = state.blocks.find((candidate) => candidate.blockId === id);
            return source && [source.blockId, source.tier, source.topic, source.summary, source.directMessageIds, source.effectiveMessageIds, source.directBlockIds];
        }),
    ]);
}

function previewFoldTargetKey(core: CompressionCore, messages: CoreMessage[], state: Session["state"], config: Config, startRef: string, endRef: string): string | undefined {
    const summary = "x".repeat(Math.max(MIN_SUMMARY_CHARS, config.compress.minSummaryLength));
    const preview = core.applyCompression({ messages, state, config, ranges: [{ startRef, endRef, summary }] });
    const known = new Set(state.blocks.map((block) => block.blockId));
    const target = preview.state.blocks.find((block) => !known.has(block.blockId));
    return target && foldTargetKey(target, state);
}

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
    /** 循环因窗口仍溢出或客户端取消而停止的原因。
     *  即使压缩后的内容已能放入窗口，也必须保留取消状态。 */
    failure?: PreflightFailure;
    /** #2662: external-chain dispatch telemetry, present only when a chain
     *  ran; calls > 0 && attempts === 0 = pool dropped every batch before
     *  dispatch (congestion, not provider failure). */
    externalDispatch?: { calls: number; attempts: number };
    /** #2638: some round saw at least one range that passed every list-level gate
     *  (viability, minCompressRange, dead-range memory). The caller uses it to tell a
     *  failed fold chain (candidates existed, none delivered — backoff is right) from
     *  lean steady state (nothing foldable remained at all — arming the auto-fold
     *  backoff would only cycle classic nudges at dead spans). */
    hadFoldableCandidates: boolean;
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

// #2490: UTF-8 byte twin of the char upper bound. Chars and bytes diverge on
// CJK (1 char = 3 bytes, real density as low as ~1.5 chars/token) — a pure-CJK
// monster can be char-harmless yet byte-doomed, so the doomed-probe guard
// prices the floor in bytes: even the densest tokenizer observed on a live
// route compresses agent traffic to ~6.8 bytes/token (#2122), so a core-text
// mass beyond window×7.5 bytes cannot fit under ANY plausible tokenizer and
// forwarding it "to acquire evidence" is a guaranteed 400, not an experiment.
export function estimateCoreMessagesUpperBytes(messages: CoreMessage[]): number {
    let bytes = 0;
    for (const m of messages) bytes += Buffer.byteLength(m.text ?? "", "utf8");
    return bytes;
}

// #4079: the byte floor above prices every message independently — that is what
// a tokenizer charges (a repeat is billed again, never free) — but it cannot
// tell a payload that GREW from one that was REPEATED. Those need different
// fixes: repeated content points at whatever built the message list (fold/view),
// grown content at the conversation itself. Today only the byte total is logged,
// so an operator looking at "12 MB" against a baseline the same session just
// measured at 387K tokens has nothing to act on. Grouping the core text by
// sha256 costs one pass and is paid only on the refusal path.
// Review of #4290: the kernel's render-refs node (default strategy
// "text-only") prepends a UNIQUE ref tag to every
// rendered text message, so hashing raw m.text groups nothing — two
// byte-identical payloads differ only in their ref and read as distinct,
// pinning duplicateRatio at 0.000 for every multi-message proxy-mode payload
// (defeating the diagnostic's whole point). Strip the leading well-formed tag
// so the profile measures CONTENT redundancy. totalBytes then trails the
// doomed-probe byte floor (estimateCoreMessagesUpperBytes, tagged) by the tag
// overhead only (~44B/message) — reconcilable at MB scale.
// Shape follows invariant-judge's RENDER_TAG_RE (`/\n?\x3cacp\s[^>]*\x3e.../`),
// not a fixed attr list: the renderer injects the tag on its own line, and the
// attr set is the renderer's to change. An over-strict prefix fails SILENTLY —
// the ratio just goes back to 0.000 and nothing says so — so widening here is
// cheaper than re-learning that in six months.
const ACP_REF_TAG_PREFIX = /^\n?\x3cacp\s[^>]*\x3em\d+\x3c\/acp\x3e\n?/;

export function measureCoreTextDuplication(messages: CoreMessage[]): { messageCount: number; totalBytes: number; uniqueBytes: number; distinctTexts: number } {
    const distinct = new Map<string, number>();
    let totalBytes = 0;
    let messageCount = 0;
    for (const m of messages) {
        const text = (m.text ?? "").replace(ACP_REF_TAG_PREFIX, "");
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes === 0) continue;
        messageCount++;
        totalBytes += bytes;
        const key = createHash("sha256").update(text, "utf8").digest("base64");
        if (!distinct.has(key)) distinct.set(key, bytes);
    }
    let uniqueBytes = 0;
    for (const bytes of distinct.values()) uniqueBytes += bytes;
    return { messageCount, totalBytes, uniqueBytes, distinctTexts: distinct.size };
}

export function describeCoreTextDuplication(messages: CoreMessage[]): string {
    const d = measureCoreTextDuplication(messages);
    if (d.totalBytes === 0) return "core text is empty";
    const ratio = 1 - d.uniqueBytes / d.totalBytes;
    return `${d.messageCount} message(s), ${d.totalBytes}B core over ${d.distinctTexts} distinct text(s), ${d.uniqueBytes}B unique, duplicateRatio=${ratio.toFixed(3)} — repeats are billed as tokens; a high ratio means the payload grew by repetition (fold/view build), not by content (#4079)`;
}

function spanUnitsOf(messages: CoreMessage[], startIdx: number, endIdx: number, countText: (text: string) => number): number {
    let units = 0;
    for (let i = startIdx; i <= endIdx && i < messages.length; i++) {
        units += countText(messages[i].text ?? "");
    }
    return units;
}

// #2672: a range boundary must name a message the kernel can resolve. Protected
// messages hold the BLOCKED sentinel in byRaw and ephemeral injections hold no
// ref at all; a boundary landing on either makes applyCompression reject the
// whole range ("Invalid boundary ref(s)"). Snap [lo,hi] inward to the nearest
// usable indices; null when nothing usable remains (nothing to fold there).
function snapToUsableBounds(
    idxToRef: Map<number, string>,
    lo: number,
    hi: number,
): [number, number] | null {
    let l = lo;
    let h = hi;
    const usable = (i: number): boolean => {
        const ref = idxToRef.get(i);
        return ref !== undefined && ref !== BLOCKED_REF;
    };
    while (l <= h && !usable(l)) l += 1;
    while (h >= l && !usable(h)) h -= 1;
    return l <= h ? [l, h] : null;
}

// #726/#2672: push the two halves of a failed span onto the worklist (oldest
// half first), adjusting each inner boundary past protected/unreferenced
// messages so the split itself can never mint an unresolvable boundary. A half
// left with no usable message is dropped instead of pushed.
function pushSpanHalves(
    idxToRef: Map<number, string>,
    spans: Array<[number, number]>,
    cs: number,
    ce: number,
): void {
    const mid = Math.floor((cs + ce) / 2);
    const upper = snapToUsableBounds(idxToRef, mid + 1, ce);
    if (upper) spans.push(upper);
    const lower = snapToUsableBounds(idxToRef, cs, mid);
    if (lower) spans.push(lower);
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

// #4740: merge away poison fragments — chunks whose char mass is below
// the kernel's minCompressRange gate. applyCompression counts msg.text
// chars and rejects such a range ATOMICALLY, so folding it wastes a whole
// round (and in the batch lane, one span per range, the range never folds
// at all). Extend the FOLLOWING chunk to swallow the fragment; a trailing
// fragment folds into the previous chunk instead. Budget discipline is
// preserved downstream: the summarizer request content is split by budget
// (splitSummaryContent), and the alternative to merging is a guaranteed
// kernel rejection, not a smaller request.
function mergeSubMinimumFragments(
    messages: CoreMessage[],
    spans: Array<[number, number]>,
    minChars: number,
    isCoveredIdx?: (idx: number) => boolean,
): Array<[number, number]> {
    if (minChars <= 0 || spans.length === 0) return spans;
    const chars = (s: [number, number]) => {
        let total = 0;
        for (let i = s[0]; i <= s[1]; i++) total += (messages[i]?.text ?? "").length;
        return total;
    };
    const out: Array<[number, number]> = [];
    let fragStart = -1;
    for (let i = 0; i < spans.length; i++) {
        const s = spans[i]!;
        const run: [number, number] = fragStart >= 0 ? [fragStart, s[1]] : [s[0], s[1]];
        const blockedByCoverage = i + 1 < spans.length && (isCoveredIdx?.(spans[i + 1]![0]) ?? false);
        if (chars(run) < minChars && i < spans.length - 1 && !blockedByCoverage) {
            fragStart = run[0];
            continue;
        }
        // Known corner (round-2 review F3, master parity): a sub-min fragment
        // blocked by coverage with nothing ahead and nothing behind to absorb
        // it is still emitted — the kernel's apply gate rejects it at the cheap
        // preview (no LLM call), the walk skips the span and retries next
        // round; bounded churn, never poison beyond this span. Merging across
        // the covered boundary would fold covered content into a new range —
        // worse than the churn.
        // A trailing fragment (nothing ahead to swallow it) folds backward.
        if (chars(run) < minChars && out.length > 0) out[out.length - 1]![1] = run[1];
        else out.push(run);
        fragStart = -1;
    }
    return out;
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

export function summaryPayload(protocol: PreflightProtocol, model: string, system: string, content: string, stream: boolean, includeMaxOutputTokens: boolean, host?: string, window?: number, billingBlock?: { type: "text"; text: string }, codexClient?: boolean): Record<string, unknown> {
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
    // #2733: new-api / anyrouter-family codex relays validate inbound calls as
    // "legitimate Codex requests" — input must be typed message items AND carry
    // include:["reasoning.encrypted_content"] (the real codex CLI's signature,
    // sent unconditionally by codex-rs core client.rs); anything else is 400
    // invalid_responses_request. The main path forwards real codex bytes
    // verbatim, so only bili's own side-channel summary call was rejected
    // (preflight lane dead → codex local auto-compaction won the race).
    // Non-codex clients keep the minimal shape byte-identical.
    const input = codexClient
        ? [{ type: "message", role: "user", content: [{ type: "input_text", text: content }] }]
        : [{ role: "user", content }];
    const payload: Record<string, unknown> = { model, instructions: system, input, stream, store: false };
    if (codexClient) payload.include = ["reasoning.encrypted_content"];
    if (includeMaxOutputTokens) payload.max_output_tokens = maxOutputTokens;
    return payload;
}

// #626: some upstreams (ChatGPT-login codex backend) reject non-stream calls
// outright with 400 "Stream must be set to true". #2494: no phrase list can
// enumerate every vendor's wording for the same policy ("Non-stream chat
// request is currently not supported", code 11101, defeats the original
// regex), so the regex no longer GATES the adaptation — a 400 on a
// NON-STREAMING summary call is itself the signal (the shape was rejected)
// and gets exactly one SSE probe. The regex survives only to pick the more
// specific log line.
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

// #2832: a plain-JSON completion that ended NORMALLY (end_turn / stop /
// completed) yet carries ZERO answer text is deterministic for this
// (model, host) pair — the model spent its whole turn in the thinking
// channel and stopped cleanly, or the relay dropped the text blocks.
// Re-sending the identical payload yields the identical empty answer, so it
// earns neither #1767's same-span retries nor #726's halving recovery (a
// normal stop is not a size signal). SSE bodies (json === null) are never
// classified here — truncation mid-stream stays the transient case #1767/#780
// defend. A non-zero answer under MIN_SUMMARY_CHARS also stays off this path:
// only a genuinely EMPTY normal stop proves the probe path itself is dead.
export function isDeterministicEmptyCompletion(protocol: PreflightProtocol, json: unknown): boolean {
    if (!json || typeof json !== "object") return false;
    if (extractSummaryText(protocol, json as Record<string, unknown>).trim().length > 0) return false;
    const o = json as Record<string, unknown>;
    switch (protocol) {
        case "anthropic": {
            return o.stop_reason === "end_turn" && Array.isArray(o.content);
        }
        case "openai": {
            const choices = o.choices;
            if (!Array.isArray(choices) || choices.length === 0) return false;
            const first = choices[0];
            if (!first || typeof first !== "object") return false;
            return (first as Record<string, unknown>).finish_reason === "stop";
        }
        case "responses": {
            if (!Array.isArray(o.output)) return false;
            if (typeof o.status === "string" && o.status !== "completed") return false;
            return true;
        }
        default:
            return false;
    }
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
        const choice = first as Record<string, unknown>;
        const fr = choice.finish_reason;
        if (typeof fr === "string") parts.push(`finish_reason=${fr}`);
        // #2832: block-level fingerprint — an EMPTY answer with a NORMAL stop
        // reason is only diagnosable when the log shows where the model's
        // output went (thinking-only vs relay-stripped text vs truly nothing).
        const message = choice.message;
        if (message && typeof message === "object") {
            const msg = message as Record<string, unknown>;
            if (typeof msg.content === "string") {
                parts.push(`text_chars=${msg.content.length}`);
            } else if (Array.isArray(msg.content)) {
                let textBlocks = 0;
                for (const part of msg.content) {
                    if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") textBlocks += 1;
                }
                parts.push(`text_blocks=${textBlocks}`);
            }
            if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
                parts.push(`reasoning_chars=${msg.reasoning_content.length}`);
            }
        }
    } else if (typeof json.stop_reason === "string") {
        parts.push(`stop_reason=${json.stop_reason}`);
        if (Array.isArray(json.content)) {
            let textBlocks = 0;
            let thinkingBlocks = 0;
            let reasoningChars = 0;
            for (const block of json.content) {
                if (!block || typeof block !== "object") continue;
                const b = block as Record<string, unknown>;
                if (b.type === "text") textBlocks += 1;
                else if (b.type === "thinking" || b.type === "redacted_thinking") {
                    thinkingBlocks += 1;
                    if (typeof b.thinking === "string") reasoningChars += b.thinking.length;
                }
            }
            parts.push(`text_blocks=${textBlocks}`);
            if (thinkingBlocks > 0) parts.push(`thinking_blocks=${thinkingBlocks}`);
            if (reasoningChars > 0) parts.push(`reasoning_chars=${reasoningChars}`);
        }
    } else if (Array.isArray(json.output)) {
        if (typeof json.status === "string") parts.push(`status=${json.status}`);
        // #2832 responses shape: mirror extractSummaryText's counting — text
        // parts only from message items, reasoning chars from reasoning items.
        let textParts = 0;
        let reasoningChars = 0;
        for (const item of json.output) {
            if (!item || typeof item !== "object") continue;
            const it = item as Record<string, unknown>;
            const itemType = typeof it.type === "string" ? it.type : "";
            if (itemType === "reasoning") {
                for (const arr of [it.content, it.summary]) {
                    if (!Array.isArray(arr)) continue;
                    for (const p of arr) {
                        if (p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string") {
                            reasoningChars += ((p as Record<string, unknown>).text as string).length;
                        }
                    }
                }
            } else if (itemType === "" || itemType === "message") {
                const content = it.content;
                if (!Array.isArray(content)) continue;
                for (const p of content) {
                    if (!p || typeof p !== "object") continue;
                    const part = p as Record<string, unknown>;
                    const partType = typeof part.type === "string" ? part.type : "";
                    if ((partType === "" || partType === "output_text") && typeof part.text === "string") textParts += 1;
                }
            }
        }
        parts.push(`text_parts=${textParts}`);
        if (reasoningChars > 0) parts.push(`reasoning_chars=${reasoningChars}`);
    } else {
        return null;
    }
    if (typeof json.model === "string") parts.push(`answered as model=${json.model}`);
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

async function summarizeRange(deps: PreflightDeps, content: string, startRef: string, endRef: string, lengthBudget?: number, systemOverride?: string): Promise<SummaryOutcome> {
    // #1775: the cap used to be enforced only after the fact — an over-cap
    // assembly was discarded wholesale (the #1775 incident). Tell the model the
    // character budget up front so the first attempt already fits. Below
    // MIN_SUMMARY_CHARS the instruction would be counterproductive (the kernel
    // minimum-summary gate rejects such output anyway), so omit it.
    // #2952: systemOverride carries a tier-distillation TASK (T2/T3 rules) in
    // place of the default tier-1 TASK; absent → byte-identical default below.
    const system = systemOverride ?? buildCompressSystemPrompt(deps.prompts, deps.surface?.promptSections) +
        `\n\nTASK: The conversation segment below (messages ${startRef}–${endRef}) must be compressed because the session context exceeds the current model's window. Write a tier-1 compression summary of the segment following every rule above. Output ONLY the summary text — no preamble, no closing remarks, no tool calls.` +
        summaryLengthBudgetClause(lengthBudget, MIN_SUMMARY_CHARS);
    if (deps.externalSummary) {
        const batch = await deps.externalSummary.summarize([{ instructions: system, content, minSummaryChars: MIN_SUMMARY_CHARS,
            maxSummaryChars: deps.config.compress.maxSummaryLength }], deps.signal);
        const result = batch.results[0];
        // Observability parity with the model-tool path (external-summary-compress
        // logs "[external-summary] completed" there): this path used to be fully
        // silent on success, which made executor attribution impossible from logs.
        deps.log("info", `[external-summary] completed (preflight) 1/1 range(s); ${describeExternalSummaryFailure(batch)}`);
        return result?.status === "success" ? { summary: result.summary, external: true }
            : { unusable: describeExternalSummaryFailure(batch), transient: false };
    }
    // #626: the session remembers upstreams that require stream:true, so the
    // extra 400 round-trip is paid at most once per session (persisted with
    // the session metadata). #663: likewise, per URL+model, upstreams that
    // reject the max_output_tokens parameter. Each capability is learned at
    // most once (guarded below), so the compatibility retries are bounded:
    // at most one extra attempt per capability, in either rejection order.
    // #2133: compress.streamSummary forces SSE from the first attempt — the
    // learn path below only sees 400 rejections of a NON-STREAMING attempt
    // (#2494: any wording; originally just "stream … true") plus the 524/504
    // first-hit timeout, which a gateway that cuts long non-streaming
    // completions with a timeout status never produces as a 400. #2155: an
    // explicit cascade FALSE (streamSummaryOff) opts the request out of SSE
    // summaries entirely — all learn paths stay disarmed and a stale learned
    // flag is ignored.
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
                const paramRejected = deps.protocol === "responses" && includeMaxOutputTokens && MAX_OUTPUT_TOKENS_REJECTED_RE.test(err.body);
                // #2494: probe on ANY wording (see STREAM_REQUIRED_RE note) —
                // except when the 400 has an identified specific cause (the
                // max_output_tokens parameter below): then the correct
                // single-variable adaptation is dropping the param and keeping
                // the transport, and if the upstream ALSO mandates streaming
                // its next 400 triggers the probe. Also excluded: the Google
                // wire, whose summary payload carries no stream field
                // (:streamGenerateContent always streams), so the probe would
                // only repeat the identical request.
                if (!stream && !deps.streamSummaryOff && deps.protocol !== "google" && !paramRejected) {
                    deps.session.metadata.preflightStreamSummary = true;
                    stream = true;
                    adapted = true;
                    deps.log("info", STREAM_REQUIRED_RE.test(err.body)
                        ? "[preflight] upstream requires stream for summaries; retrying with SSE (learned for this session)"
                        : "[preflight] non-streaming summary rejected with HTTP 400; probing once with SSE — upstream likely requires streaming (learned for this session, #2494)");
                }
                if (paramRejected) {
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
    ...TLS_TRUST_CODES, // #3776: single source of truth lives in upstream-fail.js
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
            // #3226: build the header set first so a signed lane can re-sign over
            // the summary's OWN bytes — forwarding the inbound signature verbatim
            // (it covers the original request body) makes the gateway reject the
            // summary call with 401 body-hash-mismatch and kill compression.
            const outHeaders = { "content-type": "application/json", ...summaryHeaders(deps) };
            deps.resign?.(outHeaders, body);
            const result = await fetchWithTimeout(deps.url, {
                method: "POST",
                headers: outHeaders,
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
    const text = await requestSummaryBody(deps, JSON.stringify(summaryPayload(deps.protocol, deps.model, system, content, stream, includeMaxOutputTokens, safeHost(deps.url), deps.config.modelContextLimit, deps.billingBlock, isCodexClient(deps.headers))), stream);
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
        // #2832: a normal-stop empty completion is deterministic — retrying the
        // identical payload cannot succeed, so it is neither transient nor
        // size-driven; the walk's dead-probe verdict counts it instead.
        const deterministic = isDeterministicEmptyCompletion(deps.protocol, json);
        deps.log("warn", `[preflight] summary too short (${summary.length} chars): ${diagnosis}${deterministic ? " [deterministic empty completion: normal stop with zero text — retrying the identical payload cannot succeed]" : ""}`);
        return deterministic
            ? { unusable: diagnosis, transient: false, deterministic: true }
            : { unusable: diagnosis, transient: !emptySummaryIsSizeDriven(diagnosis) };
    }
    return { summary };
}

const ABORTED_FAILURE: PreflightFailure = { kind: "aborted", detail: "the client disconnected during preflight compression" };

// #2832: persisted half of the dead-probe verdict (see the constant above).
// Lives in session metadata like #626's learned stream flag so a verdict
// armed on one turn survives into later turns of the same session; the
// (host, model) key makes a stale entry inert after a model or relay switch.
type DeterministicProbeState = { key: string; strikes: number; dead: boolean };

function readDeterministicProbeState(metadata: Record<string, unknown>): DeterministicProbeState | undefined {
    const stored = metadata["deterministicEmptyProbe"];
    if (!stored || typeof stored !== "object") return undefined;
    const o = stored as Record<string, unknown>;
    if (typeof o["key"] !== "string" || typeof o["strikes"] !== "number" || typeof o["dead"] !== "boolean") return undefined;
    return { key: o["key"], strikes: o["strikes"], dead: o["dead"] };
}

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

// #2682: farthest ref of unprotected content under the ORIGINAL protection
// config — the tier boundary between content outside the soft-protected recent
// zone and content inside it when walking a relaxed view. CPU-only probe
// mirroring the #1841 convention (kernel entry points return new state without
// mutating the input); re-derived every round because a zone fold slides the
// last-N window forward, so a cached boundary would re-promote zone content.
function recentZoneBoundaryRef(deps: PreflightDeps, messages: CoreMessage[], tokenCount: number): number {
    const probe = deps.core.processTurn({
        messages,
        state: deps.session.state,
        config: noEmergencyTruncate(ccrLoopConfig(deps.session, deps.config)),
        tokenCount,
        renderTags: "text-only",
        contentStore: contentStoreOf(deps.session),
    });
    let boundary = -1;
    for (const r of probe.nudge?.compressibleRanges ?? []) {
        boundary = Math.max(boundary, refNum(r.endRef));
    }
    return boundary;
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

// Labels are built by the digest entry collectors as `assistant tool-call <verb>`
// and `tool result <verb>` (space-separated, see the entry builders below) — a
// tool call and its result count as one logical action, so both collapse to the
// verb ("Structure: 178×bash" for 89 calls + 89 results).
function digestLabelCategory(label: string): string {
    const m = /^(?:assistant tool-call|tool result) (\S+)/.exec(label);
    if (m) return m[1];
    return label;
}

export function deterministicDigest(entries: DigestEntry[], startRef: string, endRef: string, opts: DeterministicDigestOptions): string {
    const { maxSummary, minSummaryLength, shrinkBound, countText } = opts;
    const totalChars = entries.reduce((sum, entry) => sum + entry.text.length, 0);
    const header = `[deterministic digest ${startRef}:${endRef}] ${entries.length} message(s), ~${totalChars} char(s) total. Emergency fast-path under extreme overflow (#2383): structural digest, no LLM summary; originals preserved - decompress this block to restore them verbatim.`;

    // #4224: one-line structural conclusion — counts by message category so
    // the digest conveys WHAT happened even when per-entry excerpts are trimmed.
    let structureLine = "";
    if (entries.length > 0) {
        const counts = new Map<string, number>();
        for (const e of entries) {
            const cat = digestLabelCategory(e.label);
            counts.set(cat, (counts.get(cat) ?? 0) + 1);
        }
        const parts = [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([cat, n]) => `${n}\u00d7${cat}`);
        structureLine = `Structure: ${parts.join(", ")}.`;
    }

    const fits = (form: string): boolean =>
        countText(form) <= shrinkBound && (maxSummary === undefined || maxSummary <= 0 || form.length <= maxSummary);
    const line = (entry: DigestEntry, headChars: number): string => {
        const head = headChars > 0 ? ` :: ${entry.text.replace(/\s+/g, " ").trim().slice(0, headChars)}` : "";
        return `[${entry.ref} ${entry.label}] ${entry.text.length}ch${head}`;
    };
    const preamble = entries.length > 0 ? `${header}\n${structureLine}\n` : header;

    // #4224: dynamic head-length trimming. Instead of all-or-nothing (120→0→
    // header-only), compute the per-line head budget from the remaining space
    // so large spans keep short excerpts rather than losing them entirely.
    const tryForm = (headChars: number): string | null => {
        if (entries.length === 0) {
            const form = preamble;
            return fits(form) ? form : null;
        }
        const body = entries.map((entry) => line(entry, headChars)).join("\n");
        const form = `${preamble}${body}`;
        return fits(form) ? form : null;
    };

    const candidates: number[] = [DIGEST_HEAD_CHARS];
    if (maxSummary !== undefined && maxSummary > 0 && entries.length > 0) {
        const n = entries.length;
        const baseLen = preamble.length + entries.reduce((s, e) => s + line(e, 0).length + 1, 0);
        const computed = Math.floor((maxSummary - baseLen - 4 * n + 1) / n);
        if (computed >= 24 && computed < DIGEST_HEAD_CHARS) candidates.push(computed);
        if (computed < 24) candidates.push(24);
    }
    candidates.push(0);
    for (const hc of candidates) {
        const form = tryForm(hc);
        if (form !== null) return form;
    }
    if (fits(preamble)) return preamble;
    if (fits(header)) return header;
    // Pathological: even the header cannot fit the bounds — emit a minimal
    // marker padded to the kernel's minimum so the block still applies.
    const marker = `[deterministic digest ${startRef}:${endRef}]`;
    if (marker.length >= minSummaryLength) return marker;
    const pad = Math.max(0, minSummaryLength - marker.length - 1);
    return `${marker} ${"x".repeat(pad)}`;
}

export async function preflightCompress(deps: PreflightDeps, messages: CoreMessage[]): Promise<PreflightResult> {
    // #3641: epoch confirmation pending — the fold state and the resent
    // history share nothing (wholesale replacement, no word evidence), so any
    // fold computed here would summarize a substrate whose anchor set can
    // never re-anchor. Pause folding for this session (verbatim passthrough)
    // and say so once per pass at debug level: the error line lives at the
    // escalation site (fold-reconcile). The FIRST realigned pass clears the
    // latch (resetFoldDriftState), resuming folding automatically — no
    // restart, no manual reset. Import direction: preflight → fold-reconcile
    // is acyclic (fold-reconcile never imports preflight).
    if (epochConfirmPending(deps.session)) {
        deps.log("debug", `[preflight] fold epoch confirmation pending for ${deps.session.id} — compression paused (verbatim passthrough) until the resent history realigns (#3641)`);
        const paused = estimateCoreMessages(messages) + (deps.wireOverhead ?? 0);
        return { compressedRanges: 0, savedTokens: 0, payloadEstimate: paused, rangesRemaining: 0, fitsWindow: paused <= deps.config.modelContextLimit, hadFoldableCandidates: false };
    }
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
    // #3645: kernel range.tokens are the UNCALIBRATED count, but
    // result.payloadEstimate (hence every deficit derived from it) sits on the
    // CALIBRATED scale once a matching-origin k̂ is set (#1933 F1). Folding a
    // raw-mass range removes its mass from the text, so its calibrated saving
    // is bounded by mass*k̂ — compare the foldable pool to the deficit on that
    // same scale, or a k̂>1 session inflates the deficit ×k̂ against an
    // un-scaled mass and the gate calls a recoverable round futile. Identity
    // for k̂=1 / absent / mismatched-origin (applyEstimateCalibration → raw), so
    // the uncalibrated #1841 path stays byte-identical.
    const calibrateFoldMass = (rawMass: number): number => applyEstimateCalibration(rawMass, kFactor, kOrigin, deps.upstreamOrigin);
    let textTarget = Math.max(0, Math.min(limit, deps.compressionTarget ?? limit) - imageReserve);
    const result: PreflightResult = { compressedRanges: 0, savedTokens: 0, payloadEstimate: applyEstimateCalibration(estimateCoreMessages(messages) + wireOverhead, kFactor, kOrigin, deps.upstreamOrigin) + imageReserve, rangesRemaining: 0, fitsWindow: true, hadFoldableCandidates: false };
    // #4288: set when the round-top fit exit fired — the walk ended in a
    // forward decision, and no later verdict may override it (see the final
    // failure stamp below).
    let fitExitForward = false;
    if (limit <= 0) return result;
    if (deps.externalSummary === undefined) {
        try {
            // The plan rides the request Config rail: deps.config is this
            // request's resolved Config (three-level cascade), so the plan
            // always matches the settings the wire path itself resolved.
            deps = { ...deps, externalSummary: configuredSummaryPlan((deps.config as ResolvedKernelConfig).externalSummary, deps.session.id) };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            deps.log("warn", `[external-summary] configuration unavailable; using legacy preflight: ${detail}`);
        }
    }
    const budget = Math.max(MIN_CHUNK_TOKENS, Math.floor(limit * CHUNK_FRACTION));
    // applyCompression rejects ranges below config.compress.minCompressRange
    // chars, so never spend a summarization call on a chunk that can't apply.
    const minChars = deps.config.compress.minCompressRange;
    // #4740/#1372: fragment merging must not glue a poison fragment onto a
    // span that begins with an already-covered message — that span's pure
    // "already covered" preview verdict IS the #1372 diagnosable trace.
    const coveredRawIds = new Set<string>();
    for (const b of deps.session.state.blocks) if (b.active) for (const id of b.effectiveMessageIds) coveredRawIds.add(id);
    const coveredIdx = (idx: number): boolean => coveredRawIds.has(messages[idx]?.id ?? "");
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
    // #2638: seed with the session-level memory of spans whose previews returned a
    // structural "no new compressible messages" verdict — without this, every request
    // re-nominates and re-rejects them (the permanent rejection loop). The kernel keeps
    // advertising them, so the list-level filter below and this seed share one source.
    for (const key of deadSkipKeys(deps.session)) skipSet.add(key);
    // #1372: every silent skip leaves a trace — preflight and the plugin compress
    // path judge the same range at different pipeline positions, so their verdicts
    // can legitimately diverge; recording where+why makes the divergence diffable.
    const skipReasons: string[] = [];
    const noteSkip = (reason: string): void => {
        if (skipReasons.length < 8 && !skipReasons.includes(reason)) skipReasons.push(safePrefix(reason, 200));
    };
    let subMinNoted = false;
    let deadNoted = false;
    let deadDroppedTotal = 0;
    let summaryCalls = 0;
    let budgetHit = false;
    let transientRetryBudget = TRANSIENT_EMPTY_RETRY_BUDGET;
    // #2832: dead-probe verdict for the MODEL summary path. Keyed by
    // (host, model) — evidence against one relay/model pair says nothing
    // about another. Gated off when an external summary lane is configured:
    // the walk's probes then run through that executor, not the model path
    // this verdict describes.
    const probeGated = !deps.externalSummary;
    const probeKey = `${safeHost(deps.url) ?? "?"}|${deps.model}`;
    let probeState = probeGated ? readDeterministicProbeState(deps.session.metadata) : undefined;
    let probeDead = probeGated && probeState?.dead === true && probeState.key === probeKey;
    if (probeDead) {
        deps.log("info", `[preflight] carrying the dead-probe verdict from a previous turn for ${probeKey}: at most one canary probe this turn; configure compress.externalSummary or switch the model to restore folding (#2832)`);
    }
    // One canary probe per invocation is always allowed while dead: it is how
    // a self-healed relay clears the verdict, and it bounds the waste to one
    // billed call per turn instead of today's retry budget per span.
    let canarySpent = false;
    const stickyFailureDetail =
        `the summary probe path is dead for ${probeKey}: ${DETERMINISTIC_EMPTY_STICKY_LIMIT} consecutive completions ended normally (end_turn/stop/completed) with zero answer text — ` +
        `the model answered inside its thinking channel or the relay strips text blocks, so every probe bills the span and returns the same empty answer. ` +
        `Restore folding by configuring compress.externalSummary (a working summary model), switching the session's model, or fixing the relay's thinking/text handling (#2832)`;
    const recordDeterministicEmpty = (): void => {
        if (!probeGated) return;
        let st = probeState;
        if (!st || st.key !== probeKey) st = { key: probeKey, strikes: 0, dead: false };
        st.strikes += 1;
        if (!probeDead && st.strikes >= DETERMINISTIC_EMPTY_STICKY_LIMIT) {
            probeDead = true;
            st.dead = true;
            canarySpent = true;
            deps.log("warn", `[preflight] dead-probe verdict armed: ${st.strikes} consecutive deterministic empty completions (normal stop, zero text) for ${probeKey}. Every further probe bills the span and returns the same empty answer — stopping further probes this turn (one canary probe per turn until a probe succeeds). Restore folding by configuring compress.externalSummary (a working summary model), switching the session's model, or fixing the relay's thinking/text handling (block fingerprints in the lines above; #2832)`);
        }
        probeState = st;
        deps.session.metadata["deterministicEmptyProbe"] = st;
    };
    const clearDeterministicProbe = (): void => {
        const st = probeState;
        if (!probeGated || !st || st.key !== probeKey) return;
        deps.log("info", `[preflight] summary probe for ${probeKey} answered with usable text again — clearing the dead-probe verdict (${st.strikes} strike(s) recorded)`);
        delete deps.session.metadata["deterministicEmptyProbe"];
        probeState = undefined;
        probeDead = false;
    };
    let rangesTried = 0;
    // #2657×#2678 fusion: set when a round's whole external-summary batch died
    // in the shared pool's queue (deadline, zero dispatched attempts). Later
    // rounds would queue behind the same holders with fresh budgets each,
    // serializing the whole turn behind the congestion — stop instead and let
    // the next turn retry into a (hopefully) drained pool. Zero dispatched
    // attempts keeps the #2662 no-backoff path intact.
    let poolQueueDrop = false;
    const triedKeys = new Set<string>();
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
    let foldOrderLogged = false;
    // #2952 Design A: bounded tier-distillation recovery (caps + rationale in
    // the constant comments above). The gates below DEFER their terminal verdict
    // here when raw-range folding cannot close the gap but merging existing
    // lower-tier blocks might; the post-walk funnel is the single execution point
    // so every exhaustion path (deferred gate, mid-walk bail, natural exhaustion)
    // gets exactly one bounded chance before any fail-fast verdict is final.
    const tiersEnabled = (deps.config as ResolvedKernelConfig).tiers?.enabled !== false;
    let tierRecoveryAttempted = false;
    const eligibleForTierRecovery = (): boolean => {
        if (!tiersEnabled || tierRecoveryAttempted || deps.signal?.aborted || emergencyFold) return false;
        if (summaryCalls >= summaryBudget) return false;
        const active = deps.session.state.blocks.filter((b) => b.active);
        return active.filter((b) => b.tier === 1).length >= 2 || active.filter((b) => b.tier === 2).length >= 2;
    };
    type TierRecoveryResult = { recovered: boolean; callsUsed: number; netSaved: number; honestDetail: string };
    const attemptTierRecovery = async (): Promise<TierRecoveryResult> => {
        let callsUsed = 0;
        let netSaved = 0;
        // #4227: the most recent measurement's nudge offer — pinned into the
        // distill fold's ctx so its receipt tail judges from the same
        // source/scope/moment as the recovery's own processTurn call.
        let measuredNudge: NudgeDecision | undefined;
        const measureEst = (): number => {
            const turn = deps.core.processTurn({
                messages, state: deps.session.state, config: noEmergencyTruncate(ccrLoopConfig(deps.session, activeConfig)),
                tokenCount: currentTokens, renderTags: "text-only", contentStore: contentStoreOf(deps.session),
            });
            measuredNudge = turn.nudge;
            deps.session.state = turn.state;
            adoptContentStore(deps.session, turn.contentStore);
            const view = applyAbsorbView(turn.messages, turn.state, activeConfig, currentTokens);
            const est = applyEstimateCalibration(estimateCoreMessages(view) + wireOverhead, kFactor, kOrigin, deps.upstreamOrigin) + imageReserve;
            result.payloadEstimate = est;
            // #2952 review: keep the char-count UPPER bound fresh through recovery.
            // Since #3146 the fit gate reads result.payloadEstimate (set above) for
            // every regime, so finalUpper no longer drives fitsWindow — but it still
            // feeds processTurn's tokenCount and the over-window continue/failure
            // signals below, so a recovery that only lowers the point estimate would
            // leave those meters stale. Recompute here, same caliber as the main loop.
            if (!baselineKnown) {
                finalUpper = estimateCoreMessagesUpper(view) + imageReserve + wireOverhead;
                currentTokens = Math.max(currentTokens, finalUpper);
            }
            return est;
        };
        // Wire-position helpers. The distillation span is [first..last] by MESSAGE
        // index, and the kernel folds EVERYTHING in that span — including any unfolded
        // raw messages and any other active blocks between the selected ones (#2952
        // review: a b-ref range is a span, not a set of blocks). The summary input must
        // therefore cover the whole span or those messages are silently dropped. Enumerate
        // the span as ordered atoms: each active block contributes its summary once, each
        // uncovered message its own text.
        const msgIndex = new Map<string, number>();
        for (let i = 0; i < messages.length; i++) msgIndex.set(messages[i]!.id, i);
        const spanExtent = (ids: readonly string[]): [number, number] => {
            let lo = Number.POSITIVE_INFINITY, hi = -1;
            for (const id of ids) { const ix = msgIndex.get(id); if (ix === undefined) continue; if (ix < lo) lo = ix; if (ix > hi) hi = ix; }
            return lo <= hi ? [lo, hi] : [-1, -1];
        };
        const spanContent = (lo: number, hi: number): string => {
            const cover = new Map<string, string>();
            for (const b of deps.session.state.blocks) if (b.active) for (const id of b.effectiveMessageIds) cover.set(id, b.blockId);
            const parts: string[] = [];
            let i = lo;
            while (i <= hi) {
                const m = messages[i];
                const cid = m ? cover.get(m.id) : undefined;
                if (cid) {
                    const blk = deps.session.state.blocks.find((x) => x.blockId === cid);
                    if (blk) parts.push(`[summarized ${blk.topic ? `${blk.blockId}: ${blk.topic}` : blk.blockId}]\n${blk.summary}`);
                    while (i <= hi) { const mm = messages[i]; if (mm && cover.get(mm.id) === cid) i++; else break; }
                } else {
                    if (m) parts.push(`[${m.role}] ${m.text ?? ""}`);
                    i++;
                }
            }
            return parts.join("\n\n");
        };
        let stopReason: "fit" | "exhausted" | "cap" | "unavailable" | "no-shrink" = "fit";
        // #3646: name WHY the candidate search ended — "no eligible blocks",
        // "unpositionable", and "source-budget-blocked" are three different truths
        // the old blanket "every compression tier is exhausted" conflated.
        let exhaustedWhy: string | undefined;
        let est = measureEst();
        while (callsUsed < MAX_TIER_DISTILL_CALLS && summaryCalls < summaryBudget && est >= limit && !deps.signal?.aborted) {
            const active = deps.session.state.blocks.filter((b) => b.active);
            const t1 = active.filter((b) => b.tier === 1);
            const t2 = active.filter((b) => b.tier === 2);
            // Tier preference keeps the finer T1->T2 merge first — but a BLOCKED
            // preferred tier (fewer than two positionable blocks, or every span over
            // the source budget) must not end recovery: the other supported tier gets
            // its turn before the search is declared exhausted (#3646).
            const pools: Array<{ tier: number; blocks: typeof active }> = [];
            if (t1.length >= 2) pools.push({ tier: 1, blocks: t1 });
            if (t2.length >= 2) pools.push({ tier: 2, blocks: t2 });
            const poolProblems: string[] = [];
            let chosen: { sourceTier: number; first: (typeof active)[number]; last: (typeof active)[number]; lo: number; hi: number } | undefined;
            for (const pool of pools) {
                const positioned = pool.blocks
                    .map((b) => ({ b, ext: spanExtent(b.effectiveMessageIds) }))
                    .filter((p) => p.ext[0] >= 0)
                    .sort((x, y) => x.ext[0] - y.ext[0]);
                if (positioned.length < 2) {
                    poolProblems.push(`tier-${pool.tier}: only ${positioned.length} of ${pool.blocks.length} active block(s) positionable on the wire (need two)`);
                    continue;
                }
                // Earliest wire-ordered start whose forward run reaches a second block
                // without the full span crossing the source budget, measured on REAL
                // content (blocks + any inter-block messages) and checked BEFORE
                // committing each addition so the last one cannot overshoot (#2952
                // review). Advancing past a start whose first pair already overshoots
                // is what the front-only picker missed (#3646).
                let cFirst = -1, cLast = -1, cLo = -1, cHi = -1;
                for (let s = 0; s < positioned.length && cLast < 0; s++) {
                    let lo = positioned[s]!.ext[0], hi = positioned[s]!.ext[1];
                    let lastIdx = s;
                    for (let e = s + 1; e < positioned.length; e++) {
                        const ext = positioned[e]!.ext;
                        const nLo = Math.min(lo, ext[0]), nHi = Math.max(hi, ext[1]);
                        if (spanContent(nLo, nHi).length > TIER_DISTILL_SOURCE_CHAR_BUDGET) break;
                        lo = nLo; hi = nHi; lastIdx = e;
                    }
                    if (lastIdx > s) { cFirst = s; cLast = lastIdx; cLo = lo; cHi = hi; }
                }
                if (cLast < 0) {
                    poolProblems.push(`tier-${pool.tier}: no two-block span stayed under the ${TIER_DISTILL_SOURCE_CHAR_BUDGET.toLocaleString("en-US")}-character source budget`);
                    continue;
                }
                chosen = { sourceTier: pool.tier, first: positioned[cFirst]!.b, last: positioned[cLast]!.b, lo: cLo, hi: cHi };
                // T1 preference: the FIRST pool with a candidate wins. Without this
                // break the later T2 pool would overwrite a feasible T1 choice and
                // condense coarser T2->T3 before the finer T1->T2 merge (#3646 review).
                break;
            }
            if (!chosen) {
                stopReason = "exhausted";
                exhaustedWhy = pools.length === 0
                    ? "no tier held two or more active blocks to distill"
                    : poolProblems.join("; ");
                break;
            }
            const { sourceTier, first, last, lo, hi } = chosen;
            const rules = sourceTier === 1 ? deps.prompts.tier2DistillRules : deps.prompts.tier3CondenseRules;
            const system = buildCompressSystemPrompt(deps.prompts, deps.surface?.promptSections)
                + `\n\n${rules}\n\nTASK: The tier-${sourceTier} block summaries below must be distilled into ONE tier-${sourceTier + 1} summary because the session context exceeds the model window and raw-message folding alone cannot close the gap. Follow every rule above. Output ONLY the distilled summary text — no preamble, no closing remarks, no tool calls.`;
            const content = spanContent(lo, hi);
            const targetKey = previewFoldTargetKey(deps.core, messages, deps.session.state, activeConfig, first.blockId, last.blockId);
            if (targetKey === undefined) {
                stopReason = "unavailable";
                break;
            }
            let outcome;
            try {
                outcome = await summarizeRange(deps, content, first.blockId, last.blockId, undefined, system);
            } catch (error) {
                // #2952 review: a thrown summary error (network/relay) must stop
                // recovery like the normal path does, not escape to the caller.
                // #3226: an UpstreamHttpError carries the upstream body — surface a
                // snippet like the normal-round path so a signed-lane 401 ("body hash
                // mismatch x-sdk-content-sha256") self-diagnoses instead of masquerading
                // as "futile round / net ~0 tokens saved".
                const distillBodySnippet = error instanceof UpstreamHttpError ? safePrefix(error.body.trim(), 200) : "";
                const distillDetail = error instanceof UpstreamHttpError
                    ? `HTTP ${error.status} after ${error.attempts} attempt(s)${distillBodySnippet ? `: ${distillBodySnippet}` : ""}`
                    : safePrefix(error instanceof Error ? error.message : String(error), 200);
                deps.log("warn", `[preflight] tier-${sourceTier}->${sourceTier + 1} distillation summary call failed (${distillDetail}); stopping recovery (#2952)`);
                stopReason = "unavailable";
                break;
            }
            if ("unusable" in outcome) {
                deps.log("warn", `[preflight] tier-${sourceTier}->${sourceTier + 1} distillation produced no usable summary (${outcome.unusable}); stopping recovery (#2952)`);
                stopReason = "unavailable";
                break;
            }
            if (previewFoldTargetKey(deps.core, messages, deps.session.state, activeConfig, first.blockId, last.blockId) !== targetKey) {
                deps.log("warn", `[preflight] discarded tier-distillation summary: fold targets changed while awaiting the summary`);
                stopReason = "unavailable";
                break;
            }
            const ctx: RewriteCtx = { core: deps.core, config: activeConfig, messages, session: deps.session, lastNudge: measuredNudge, log: (m) => deps.log("info", m) };
            const fold = parseCompressInput({ content: [{ startId: first.blockId, endId: last.blockId, summary: outcome.summary, topic: `preflight tier-${sourceTier + 1} distill (#2952)` }] });
            const applied = applyRanges(fold, ctx, { loopTracking: false });
            if (applied.outcome === "refused") {
                deps.log("warn", `[preflight] tier distillation apply refused: ${safePrefix(applied.text, 200)}; stopping recovery (#2952)`);
                stopReason = "unavailable";
                break;
            }
            deps.session.stats.lastInputTokens += defaultCountTokens(outcome.summary);
            const after = measureEst();
            const gained = est - after;
            callsUsed += 1;
            summaryCalls += 1;
            // #2952 review: count the distillation as a real fold so the caller
            // rebuilds THIS round's outbound request from the recovered state
            // (server.ts only rebuilds when compressedRanges > 0).
            result.compressedRanges += 1;
            result.savedTokens += Math.max(0, gained);
            if (gained <= 0) {
                deps.log("warn", `[preflight] tier-${sourceTier}->${sourceTier + 1} distillation netted ${gained} tokens (no shrink); stopping recovery (#2952)`);
                stopReason = "no-shrink";
                break;
            }
            netSaved += gained;
            est = after;
            if (est < limit) { stopReason = "fit"; break; }
            deps.log("info", `[preflight] tier-${sourceTier}->${sourceTier + 1} distillation merged b-range ${first.blockId}..${last.blockId} into one block; net -${gained} tok, payload ~${after} vs window ${limit} (${callsUsed}/${MAX_TIER_DISTILL_CALLS} calls, #2952)`);
        }
        if (stopReason === "fit" && est >= limit) stopReason = "cap";
        const recovered = est < limit;
        if (recovered) currentTokens = Math.min(currentTokens, est);
        const overBy = Math.max(0, est - limit);
        // #2952 review: name WHY recovery ended — claim "every tier is exhausted"
        // only when there was genuinely nothing left to distill; a call-cap hit or an
        // unavailable summary is not tier exhaustion. #3646: when the search really
        // found no candidate, say WHICH gate blocked it instead of the blanket claim.
        const why = stopReason === "exhausted" ? (exhaustedWhy ?? "every compression tier is exhausted")
            : stopReason === "cap" ? `the bounded distillation call budget was reached after ${callsUsed} call(s)`
            : stopReason === "unavailable" ? "the distillation summary was unavailable"
            : "a distillation pass produced no further shrink";
        const honestDetail =
            `futile round: folding compressible raw messages plus tier distillation (${callsUsed} summary call(s), net ~${netSaved} tokens saved) still leaves the payload ~${overBy} tokens over the window — ${why}. ` +
            `These figures are measured on the post-fold wire view; the separately displayed context total additionally floors on the upstream usage baseline, which also bills the system prompt and tool definitions. ` +
            `Raise the model context window or restart the session.`;
        return { recovered, callsUsed, netSaved, honestDetail };
    };
    for (let round = 0; round < effectiveRoundCap; round++) {
        if (deps.signal?.aborted) {
            failure = ABORTED_FAILURE;
            break;
        }
        if (poolQueueDrop) break;
        // #4528: each round re-runs the full O(messages) kernel pass over the
        // resent history; yield between rounds so UI/API requests on the same
        // listener are served instead of queueing behind the whole compression
        // run.
        await yieldToEventLoop();
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
            // #3146: the char-count bound pins currentTokens so the kernel keeps
            // marking ranges compressible WHILE folding, but it NO LONGER boosts
            // decisionTokens — the per-round exit and the final fit judge on the
            // calibrated CJK-aware estimate (payloadEstimate), not raw char count.
            // Chars-as-tokens made a fitting payload unsatisfiable (#3146): the
            // bound stayed over-window no matter how much folded, so a successful
            // fold still failed fast after burning every round. Char count remains
            // the TRIGGER arm only (server.ts decisionTrigger), where erring early
            // is harmless.
            finalUpper = estimateCoreMessagesUpper(turn.messages) + imageReserve + wireOverhead;
            currentTokens = Math.max(currentTokens, finalUpper);
        }
        // The caller's forward/fail-fast gate uses the payload's own estimate
        // (the floor can be stale — see PreflightResult.payloadEstimate).
        result.payloadEstimate = roundText + imageReserve;
        if (startTokens < 0) startTokens = currentTokens;
        // #4288: the round-boundary exit must judge on the payload's OWN estimate —
        // the same floorless quantity the caller's forward gate trusts (#1839/#1492) —
        // NOT on decisionTokens, which is floored by the session's usage baseline.
        // After a mid-session switch to a smaller-window model that baseline was
        // measured under the prior (wider) model and sits above the new target, so a
        // floored comparison never trips and the loop burns the whole slow
        // summarization ladder on a payload that already fits (the client then times
        // out mid-ladder and the session appears stuck).
        // Judge against the round's fold TARGET, not the hard window limit: callers
        // may still demand folding on a window-fitting payload — a compressionTarget
        // below the window (external summary plans, #a66353ac target stability) or a
        // headroom reservation (codex native compaction, #68f6bfe3).
        // Compare TEXT to TEXT: roundText is the text-space estimate and textTarget
        // already subtracts imageReserve, while payloadEstimate is total-space
        // (roundText + imageReserve) — a total-to-text comparison subtracts the
        // reserve twice and misses the exit on image lanes.
        // EXCEPTION (#1195/#987, the reason the original #4294 was reverted): an
        // OVERFLOW-ARM baseline is upstream rejection evidence for THIS request —
        // the provider's own counting rejected this exact payload, so the local
        // text estimate (which cannot see provider-side counting, cache stamps,
        // tokenizers that differ from ours) may NOT outrank it. Under an arm the
        // floored decisionTokens comparator stays: the #1195 in-request rescue
        // must keep folding until the payload fits the STATED window on the
        // upstream's scale. The arm is one-shot (#1110) and retires on the next
        // real usage report, so this exception cannot resurrect the #4288
        // marathon — that burn was driven by a stale USAGE-sourced baseline
        // measured under a prior wider-window model, which keeps the floorless
        // roundText path.
        const armedBaseline = deps.session.stats.lastInputTokensSource === "overflow-arm";
        if (armedBaseline ? decisionTokens < textTarget : roundText < textTarget) {
            // #4288: the walk ends in a fit-forward — the caller's gate judges
            // on the same floorless payloadEstimate and forwards. The final
            // verdict below must not stamp an exhausted/failure verdict over
            // this exit just because the STALE-floored currentTokens still
            // reads over-limit.
            fitExitForward = true;
            if (baselineFloor >= textTarget && !armedBaseline) {
                deps.log("info", `[preflight] payload fits by its own estimate (~${Math.round(result.payloadEstimate)}/${textTarget} target, window ${limit}); stopping instead of folding further despite a higher usage baseline (~${Math.round(baselineFloor)} tok measured under a prior model/route) — forwarding (#4288)`);
            }
            break;
        }
        // #847: drop sub-minimum ranges at list level too — every chunk of a
        // sub-min range fails the apply-side gate, so walking them only burns
        // rounds and misreports "N viable ranges tried"; with them gone the
        // empty-list path below can reach the #330 soft-zone relaxation.
        const viable = viableRanges(turn.nudge?.compressibleRanges ?? []);
        const aboveMin = viable.filter((r) => minChars <= 0 || (r.chars ?? r.tokens * 4) >= minChars);
        // #2638: spans whose previews returned a structural "no new compressible
        // messages" verdict can never fold through plain refs — the kernel keeps
        // advertising them, so without this filter every round re-walks and
        // re-previews them. Exact key match only: a wider range that merely
        // contains a dead chunk keeps its live members.
        let ranges = filterDeadRanges(deps.session, aboveMin);
        const deadDropped = aboveMin.length - ranges.length;
        if (deadDropped > 0) {
            deadDroppedTotal += deadDropped;
            if (!deadNoted) {
                deadNoted = true;
                deps.log("debug", `[preflight] ${deadDropped} candidate range(s) suppressed: previously-dead structural verdicts (#2638)`);
            }
        }
        // #1372: the list-level minCompressRange filter used to drop sub-minimum
        // ranges silently — "no compressible ranges remain" gave no hint that
        // ranges existed but were all under the gate.
        if (ranges.length === 0 && aboveMin.length === 0 && viable.length > 0 && !subMinNoted) {
            subMinNoted = true;
            deps.log("warn", `[preflight] ${viable.length} viable range(s) are below minCompressRange (${minChars} chars); none foldable`);
            noteSkip(`all ${viable.length} viable range(s) below minCompressRange (${minChars} chars)`);
        }
        rangesRemaining = ranges.length;
        if (ranges.length > 0) result.hadFoldableCandidates = true;
        // Field reports of the preflight marathon cut at the #568 hold line
        // with zero round visibility (both 0.1.195 fork incidents): 19 LLM
        // rounds × tens of seconds upstream each, nothing in between. One
        // info line per LLM round — and every 32nd digest round in the
        // CPU-only emergency regime, where hundreds of rounds are cheap —
        // makes the marathon observable WHILE it runs instead of only via
        // the exhaustion verdict afterwards.
        if (!emergencyFold || (round & 31) === 0) {
            deps.log("info", `[preflight] round ${round + 1}/${effectiveRoundCap}: payload ~${Math.round(result.payloadEstimate)} tok vs window ${limit} (deficit ${Math.max(0, Math.round(result.payloadEstimate - limit))}), ${ranges.length} viable range(s)`);
        }
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
            if (potential > 0 && deficit > 0 && calibrateFoldMass(potential) * FUTILITY_SLACK < deficit) {
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
                    // #2638: structural verdicts hold under relax too (coverage-based, zone-independent) — dead mass cannot close the gap either.
                    const relaxedRanges = filterDeadRanges(deps.session, viableRanges(probe.nudge?.compressibleRanges ?? []).filter((r) => minChars <= 0 || (r.chars ?? r.tokens * 4) >= minChars));
                    const relaxedPotential = resolvableMass(relaxedRanges);
                    if (calibrateFoldMass(relaxedPotential) * FUTILITY_SLACK >= deficit) {
                        activeConfig = relaxedConfig(deps.config);
                        relaxed = true;
                        textTarget = Math.max(0, limit - imageReserve);
                        summaryCalls = 0;
                        budgetHit = false;
                        transientRetryBudget = TRANSIENT_EMPTY_RETRY_BUDGET;
                        deps.log("warn", `[preflight] foldable mass outside the protected recent zone (~${calibrateFoldMass(potential)} tok) cannot close the ${deficit}-tok gap; relaxing soft protection up front and retrying (#1841)`);
                        continue;
                    }
                    // The relaxed pool is the superset: quote it as the true bound.
                    potential = relaxedPotential;
                }
                const zoneNote = relaxed ? ", including the relaxed recent zone" : "";
                // #2952 Design A: raw-range folding (even with the recent zone
                // relaxed) cannot close the gap, but distilling existing
                // lower-tier BLOCKS might — and the model cannot do it because its
                // next turn is refused by this very fail-fast (the deadlock in
                // #2952). Defer the verdict to the post-walk recovery funnel
                // instead of declaring futility here. Never entered for tiers=false
                // or emergency digest mode, so both paths stay byte-identical.
                if (eligibleForTierRecovery()) {
                    deps.log("info", `[preflight] raw-fold pool (~${calibrateFoldMass(potential)} tok${zoneNote}) below deficit (~${deficit} tok); deferring to bounded tier-distillation recovery (#2952)`);
                    break;
                }
                // #3461: structurally doomed only when NO draw ever came back
                // unusable and the pool never dropped — an unusable draw means
                // the shortfall may be the relay, not the content, and the
                // retry/canary machinery (#726/#2832) owns that case.
                failure = { kind: "exhausted", deterministic: lastUnusableDetail === undefined && !poolQueueDrop, detail: `futile round: the maximum possible saving from all foldable content (~${calibrateFoldMass(potential)} tokens${zoneNote}) is below the required reduction (~${deficit} tokens) — no combination of folds can bring the payload under the target. Raise the model context window or restart the session.` };
                deps.log("warn", `[preflight] skipping futile round: max possible saving ~${calibrateFoldMass(potential)} tok < required ~${deficit} tok${zoneNote}; zero summarization calls spent (#1841)`);
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
            if (!relaxed && result.payloadEstimate >= limit) {
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
            // #3461: every subcase here is structural — nothing compressible
            // remains (or nothing above minCompressRange, or the whole relaxed
            // zone already folded) — so no retry against a healthier relay can
            // change the verdict.
            // #2952 Design A: "nothing compressible" can still leave a rescue —
            // every raw message already inside a block (view = carriers only)
            // is exactly the distillable state. Defer to the post-walk
            // recovery funnel instead of failing here, same as the futility
            // gate above; tiers=false / emergency digest never enter this way.
            if (eligibleForTierRecovery()) {
                deps.log("info", `[preflight] no compressible ranges remain${relaxed ? " even with the soft zone relaxed" : ""}; deferring to bounded tier-distillation recovery (#2952)`);
                break;
            }
            failure = { kind: "exhausted", deterministic: true, detail: relaxed ? relaxedExhaustedDetail : subMinNoted
                ? `no foldable compressible ranges remain: all ${viable.length} viable range(s) are below minCompressRange (${minChars} chars)`
                : deadNoted
                    ? `no foldable compressible ranges remain: ${deadDroppedTotal} range(s) carry previously-dead structural verdicts (#2638)`
                    : "no compressible ranges remain in the conversation" };
            break;
        }
        // #2682: two-tier dispatch order. Tier 1 = ranges entirely outside the
        // soft-protected recent zone: payoff order, largest first — a
        // summarization call costs the same wall clock whether it folds 6K or
        // 64K tokens (measured 25-44s/call regardless of size), and the head
        // range re-grows after each fold (its block + newer messages form one
        // bigger range again), so oldest-first re-folded an almost-exhausted
        // head every round while the largest ranges never got dispatched
        // within the pass budget. Age order breaks ties of equal mass.
        // Tier 2 = ranges entering the soft-protected recent zone (present
        // only after a #330/#1841 relax): they stay oldest-first — #330's
        // stated policy ("relax the soft zone (oldest-first within it)") —
        // and never outrank old unfolded content: pure mass order would let
        // one giant relaxed range eat the active working set before moderate
        // old ranges do.
        const zoneBoundary = relaxed ? recentZoneBoundaryRef(deps, messages, currentTokens) : null;
        const tierOf = (r: (typeof ranges)[number]): number => (zoneBoundary !== null && refNum(r.endRef) > zoneBoundary ? 2 : 1);
        const ordered = [...ranges].sort((a, b) =>
            tierOf(a) - tierOf(b) ||
            (tierOf(a) === 1 ? b.tokens - a.tokens : 0) ||
            refNum(a.startRef) - refNum(b.startRef));
        if (!foldOrderLogged && ordered.length > 0) {
            foldOrderLogged = true;
            const shown = ordered.slice(0, 8).map((r) => `${r.startRef}:${r.endRef} (${r.tokens} tok${tierOf(r) === 2 ? ", zone" : ""})`).join(", ");
            deps.log("info", `[preflight] fold order (largest first outside the recent zone, #2682): ${shown}${ordered.length > 8 ? `, ... (+${ordered.length - 8} more)` : ""}`);
        }
        let appliedThisRound = 0;
        // #1841: set when the mid-walk futility check stops the walk before
        // every range was tried; the round-end site turns it into a failure
        // unless the #330 relax path is still available.
        let futileBail = false;
        let bailRemaining = 0;
        let bailDeficit = 0;
        // Shared fold commit for this round: applies one parsed range to the
        // session state and nets its accounting, exactly as the serial walk did
        // inline before #2678 hoisted it so the batch path below commits through
        // the same code (one apply path, no drifted copies). Returns false when
        // the kernel refused the fold (the caller records the skip and moves on).
        const commitFold = (skipKey: string, startRef: string, endRef: string, summary: string, effectiveMessageIds: readonly string[], externalFold: boolean, targetKey: string): boolean => {
            const state = deps.session.state;
            const preview = deps.core.applyCompression({ messages, state, config: activeConfig, ranges: [{ startRef, endRef, summary }] });
            const known = new Set(state.blocks.map((block) => block.blockId));
            const target = preview.state.blocks.find((block) => !known.has(block.blockId));
            if (!target || foldTargetKey(target, state) !== targetKey) {
                deps.log("warn", `[preflight] discarded summary for ${skipKey}: fold targets changed while awaiting the summary`);
                noteSkip(`${skipKey}: fold targets changed while awaiting the summary`);
                skipSet.add(skipKey);
                return false;
            }
            const ctx: RewriteCtx = {
                core: deps.core,
                config: activeConfig,
                messages,
                session: deps.session,
                // #4227: pin the receipt tail to THIS round's own nudge offer —
                // the same source/scope/moment the walk above just acted on.
                // Without it, postCompressTail falls back to a live recompute
                // judged on statusInputBaseline (the previous request's usage-
                // grade input tokens): in an overflow marathon that baseline is
                // far below the window while the ACTUAL payload is 19x over, so
                // the tail printed "No compressible ranges remain" in the very
                // fold whose walk logged "102 viable range(s)" (#4224/#4227).
                lastNudge: turn.nudge,
                log: (msg) => deps.log("info", msg),
            };
            const creditBefore = deps.session.stats.compressCreditTokens;
            // #2146: internal lane — must not arm the model-facing loop breaker.
            const fold = parseCompressInput({ content: [{ startId: startRef, endId: endRef, summary, topic: deps.compressReason === "growth" ? "preflight auto-fold (growth)" : "preflight overflow compress" }] });
            if (externalFold) for (const range of fold.ranges) range.compressCallId = newExternalCallId();
            const applied = applyRanges(fold, ctx, { loopTracking: false });
            if (applied.outcome === "refused") {
                deps.log("warn", `[preflight] ${applied.text}`);
                noteSkip(`${skipKey}: apply failed — ${safePrefix(applied.text.replace(/^\[Compression (?:FAILED|refused)[:\s]*/, ""), 200)}`);
                skipSet.add(skipKey);
                return false;
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
            const folded = baselineKnown ? compressed : messages.filter((message) => effectiveMessageIds.includes(message.id)).reduce((total, message) => total + (message.text ?? "").length, 0);
            currentTokens = Math.max(0, currentTokens - folded + countText(summary));
            // The apply path (stream.ts applyRanges) already netted the gross
            // fold out of lastInputTokens and credited compressCreditTokens;
            // add the re-entering summary's cost back so the baseline tracks
            // the post-fold payload size exactly once (#3450 trace: arm 1048576
            // → −gross +summary = 1047168 after one fold).
            deps.session.stats.lastInputTokens += defaultCountTokens(summary);
            appliedThisRound += 1;
            result.compressedRanges += 1;
            return true;
        };
        // #2678/#2667: fold several disjoint ranges in ONE external-summary call
        // so the executor's pool runs them concurrently — the pass's wall clock
        // becomes the slowest chunk instead of k sequential ~20-40s calls (the
        // shared per-pass deadline used to cut multi-range passes off with whole
        // ranges never dispatched). Nomination mirrors the walk below: same span
        // choice (oldest full-budget chunk first), same preview/content/chunking
        // gates, and a rejected preview or empty render does NOT poison the
        // range's skipSet. A range the batch cannot summarize is left out of the
        // skipSet on purpose: later rounds re-nominate it while siblings keep
        // folding in batches, and once the batch applies nothing in a round the
        // serial walk below takes it over with halving/transient retries. Gated
        // on the external lane (the legacy streaming lane has no batch executor)
        // and on ≥2 viable ranges (a single range keeps the legacy path
        // byte-identically).
        if (!emergencyFold && ordered.length >= 2 && !budgetHit) {
            const batchPlan = deps.externalSummary;
            if (batchPlan) {
                type BatchNomination = {
                    skipKey: string;
                    startRef: string;
                    endRef: string;
                    content: string;
                    chunks: string[];
                    instructions: string;
                    effectiveMessageIds: string[];
                    targetKey: string;
                    spanUnits: number;
                    offset: number;
                };
                const nominations: BatchNomination[] = [];
                let workTotal = 0;
                let reservedCalls = 0;
                for (let oi = 0; oi < ordered.length && nominations.length < MAX_PREFLIGHT_SUMMARY_BATCH; oi++) {
                    const range = ordered[oi];
                    const skipKey = `${range.startRef}:${range.endRef}`;
                    if (skipSet.has(skipKey)) continue;
                    const { refToIdx } = refMaps(messages, deps.session.state);
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
                    if (!triedKeys.has(skipKey)) {
                        triedKeys.add(skipKey);
                        rangesTried += 1;
                    }
                    // #4740: the min-chars floor applies in BOTH regimes. With
                    // minUnits = 0 a pair range whose tool-result alone exceeds the
                    // budget split into [call-only fragment][oversized result], and
                    // the fragment's preview is atomically rejected by the kernel's
                    // minCompressRange gate (a 64-char call vs min 5000) — in this
                    // batch lane the range then never folds at all (one span per
                    // range), and in the walk it burns a preview per round.
                    const spans = mergeSubMinimumFragments(messages, splitChunks(messages, startIdx, endIdx, budget, baselineKnown ? 0 : minChars, countText), minChars, coveredIdx).slice().reverse();
                    const span = spans.pop();
                    if (!span) continue;
                    const [cs, ce] = span;
                    const maps = refMaps(messages, deps.session.state);
                    let startRef = maps.idxToRef.get(cs);
                    let endRef = maps.idxToRef.get(ce);
                    if (!startRef || !endRef) {
                        deps.log("warn", `[preflight] dropping span ${cs}..${ce} of range ${skipKey}: boundary message has no ref in the current state`);
                        noteSkip(`${skipKey}: span ${cs}..${ce} boundary message has no ref`);
                        continue;
                    }
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
                        const verdict = safePrefix([...preview.result.errors, ...preview.result.warnings].join("; "), 300)
                            || "the kernel created no block and reported no error";
                        deps.log("warn", `[preflight] preview rejected range ${skipKey}: ${verdict}`);
                        noteSkip(`${skipKey}: preview rejected — ${verdict}`);
                        // No skipSet here, mirroring the walk: a rejected span (e.g. a
                        // sub-minimum tail) must not poison the whole range — its older
                        // chunks may still be foldable in later rounds.
                        continue;
                    }
                    // Direct raw messages render host-side (#781 image notes live in
                    // BiliMessage sidecars the kernel never sees); consumed child
                    // blocks render through the kernel from the original state.
                    // Byte-identical to the walk's renderer below.
                    const idxById = new Map(messages.map((m, i) => [m.id, i]));
                    const byRaw = deps.session.state?.messageRefs?.byRaw;
                    const parts: string[] = [];
                    const droppedParts: string[] = [];
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
                    }
                    for (const nid of planned.directBlockIds) {
                        const nb = deps.session.state.blocks.find((b) => b.blockId === nid);
                        if (!nb) { droppedParts.push(`child block ${nid} missing from state`); continue; }
                        const label = nb.topic ? `${nb.blockId}: ${nb.topic}` : nb.blockId;
                        parts.push(`[summarized ${label}]\n${nb.summary}`);
                    }
                    if (droppedParts.length > 0) {
                        deps.log("debug", `[preflight] range ${skipKey}: ${droppedParts.length} part(s) rendered nothing (${droppedParts.slice(0, 3).join("; ")})`);
                    }
                    const content = parts.join("\n\n");
                    if (content.length === 0) {
                        deps.log("warn", `[preflight] planned block for range ${skipKey} rendered no text: ${droppedParts.slice(0, 5).join("; ") || "all parts empty"}`);
                        noteSkip(`${skipKey}: planned block rendered no text (${droppedParts.slice(0, 3).join("; ") || "all parts empty"})`);
                        // No skipSet here either (walk parity): an empty render for one
                        // span does not make the rest of the range unrenderable.
                        continue;
                    }
                    const spanUnits = baselineKnown
                        ? planned.compressedTokens
                        : messages.filter((message) => planned.effectiveMessageIds.includes(message.id)).reduce((total, message) => total + (message.text ?? "").length, 0);
                    const chunks = splitSummaryContent(content, budget, countText);
                    // Track reservations locally: they count against the pass
                    // budget only once the batch actually fires (≥2 nominations).
                    // A sub-batch set falls through to the walk, which reserves
                    // its own calls — committing here too would double-book them.
                    if (summaryCalls + reservedCalls + chunks.length > summaryBudget) break;
                    reservedCalls += chunks.length;
                    // Same system prompt summarizeRange builds for the serial path
                    // (per-chunk length budget spread over maxSummaryLength, #1775).
                    const maxSummary = activeConfig.compress.maxSummaryLength;
                    const perChunkBudget = maxSummary > 0 ? Math.floor((maxSummary - (chunks.length - 1) * SUMMARY_JOIN_GAP) / chunks.length) : undefined;
                    const instructions =
                        buildCompressSystemPrompt(deps.prompts, deps.surface?.promptSections) +
                        `\n\nTASK: The conversation segment below (messages ${startRef}–${endRef}) must be compressed because the session context exceeds the current model's window. Write a tier-1 compression summary of the segment following every rule above. Output ONLY the summary text — no preamble, no closing remarks, no tool calls.` +
                        summaryLengthBudgetClause(perChunkBudget, MIN_SUMMARY_CHARS);
                    nominations.push({ skipKey, startRef, endRef, content, chunks, instructions, effectiveMessageIds: [...planned.effectiveMessageIds], targetKey: foldTargetKey(planned, deps.session.state), spanUnits, offset: workTotal });
                    workTotal += chunks.length;
                }
                if (nominations.length >= 2) {
                    summaryCalls += reservedCalls;
                    const workItems = nominations.flatMap((nom) => nom.chunks.map((chunk) => ({ content: chunk, instructions: nom.instructions, minSummaryChars: MIN_SUMMARY_CHARS, maxSummaryChars: deps.config.compress.maxSummaryLength })));
                    const batch = await batchPlan.summarize(workItems, deps.signal);
                    const assembled = nominations.map((nom): string | undefined => {
                        const entries = batch.results.slice(nom.offset, nom.offset + nom.chunks.length);
                        if (entries.length < nom.chunks.length || entries.some((entry) => entry.status !== "success")) return undefined;
                        const candidate = entries.map((entry) => (entry.status === "success" ? entry.summary : "")).join("\n\n");
                        // Acceptance identical to the walk: absolute cap, then net-
                        // shrink monotonicity (#861/#1775/#1819), rescue-truncate
                        // when truncating still nets savings.
                        const shrinkOk = (text: string): boolean => countText(text) <= nom.spanUnits * NET_SHRINK_TOLERANCE;
                        const maxSummary = activeConfig.compress.maxSummaryLength;
                        if (maxSummary <= 0 || candidate.length <= maxSummary) {
                            return shrinkOk(candidate) ? candidate : undefined;
                        }
                        if (candidate.length < nom.content.length) {
                            const rescued = truncateSummaryToLimit(candidate, maxSummary, activeConfig.compress.minSummaryLength);
                            if (rescued !== null && shrinkOk(rescued)) {
                                deps.log("warn", `[preflight] range ${nom.skipKey}: assembled summary ${candidate.length} chars exceeded maxSummaryLength (${maxSummary}); truncated to ${rescued.length} chars`);
                                return rescued;
                            }
                        }
                        return undefined;
                    });
                    const successful = assembled.filter((candidate) => candidate !== undefined).length;
                    deps.log("info", `[external-summary] completed (preflight) ${successful}/${nominations.length} range(s); calls=${workItems.length}; ${describeExternalSummaryFailure(batch)}`);
                    if (batch.status === "deadline" && batch.results.every((entry) => entry.attempts.length === 0)) {
                        poolQueueDrop = true;
                        deps.log("warn", `[external-summary] the whole batch died in the shared pool queue before a single candidate dispatched (deadline, 0 attempts) — pool congestion; stopping this fold instead of queueing further rounds, the next turn retries (#2657 × #2678 fusion)`);
                    }
                    for (let ni = 0; ni < nominations.length; ni++) {
                        const candidate = assembled[ni];
                        if (candidate === undefined) continue;
                        const nom = nominations[ni];
                        commitFold(nom.skipKey, nom.startRef, nom.endRef, candidate, nom.effectiveMessageIds, true, nom.targetKey);
                    }
                }
            }
        }
        // #4224: emergency digests are CPU-only (zero upstream calls), so the
        // LLM-path "one fold per round" cap wastes hundreds of rounds.
        const maxFoldsPerRound = emergencyFold ? Infinity : 1;
        for (let oi = 0; oi < ordered.length && appliedThisRound < maxFoldsPerRound && !poolQueueDrop; oi++) {
            const range = ordered[oi];
            if (decisionTokens < textTarget) break;
            if (deps.signal?.aborted) {
                failure = ABORTED_FAILURE;
                break;
            }
            if (budgetHit) break;
            const skipKey = `${range.startRef}:${range.endRef}`;
            if (skipSet.has(skipKey)) continue;
            // #2832: dead-probe verdict with the canary spent — no range in this
            // walk can fold (they all share the same dead model path), so stop
            // the walk with the actionable detail instead of probing again.
            if (probeGated && probeDead && canarySpent) {
                noteSkip(`${skipKey}: summary probe path dead for ${probeKey} — no further probes this turn (#2832)`);
                failure = { kind: "exhausted", detail: stickyFailureDetail };
                break;
            }
            const { refToIdx } = refMaps(messages, deps.session.state);
            // #4224: skip the mid-walk futility bail in the emergency path —
            // each fold is free (CPU-only), so "cannot fully close the gap"
            // is not a reason to stop folding.
            if (baselineKnown && !emergencyFold) {
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
                if (remaining > 0 && deficit > 0 && calibrateFoldMass(remaining) * FUTILITY_SLACK < deficit) {
                    futileBail = true;
                    bailRemaining = calibrateFoldMass(remaining);
                    bailDeficit = deficit;
                    deps.log("warn", `[preflight] remaining foldable mass (~${calibrateFoldMass(remaining)} tok) cannot close the ~${deficit}-tok gap; stopping further summarization calls (#1841)`);
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
            if (!triedKeys.has(skipKey)) {
                triedKeys.add(skipKey);
                rangesTried += 1;
            }
            // minUnits only in the char regime: with the optimistic token budget a
            // sub-minimum chunk is already rare, and keeping minUnits = 0 there
            // preserves the historical packing exactly.
            // #726: spans form a worklist instead of a flat pass. A chunk whose
            // summary comes back unusable is halved (oldest half first) and
            // retried down to a floor before the whole range is given up: the
            // prime suspect for an empty summary is a CHUNK_FRACTION-sized chunk
            // exceeding the upstream's real input cap, and halving recovers
            // exactly those cases. Bounded by the per-regime call budget below.
            // #4740: floor in both regimes — see the batch nomination comment.
            // Sub-floor fragments were guaranteed-rejected previews, not packing.
            const spans: Array<[number, number]> = mergeSubMinimumFragments(messages, splitChunks(messages, startIdx, endIdx, budget, baselineKnown ? 0 : minChars, countText), minChars, coveredIdx).slice().reverse();
            while (spans.length > 0) {
                if (decisionTokens < textTarget) break;
                if (deps.signal?.aborted) {
                    failure = ABORTED_FAILURE;
                    break;
                }
                if (budgetHit) break;
                // #2832: verdict armed mid-walk (this range's own draw was the
                // last strike) — abandon the remaining sub-spans CPU-only; they
                // would all hit the same wall and the next range's gate stops
                // the whole walk.
                if (probeGated && probeDead && canarySpent) {
                    noteSkip(`${skipKey}: summary probe path dead for ${probeKey} — remaining sub-span(s) not probed (#2832)`);
                    skipSet.add(skipKey);
                    break;
                }
                const span = spans.pop();
                if (!span) break;
                const maps = refMaps(messages, deps.session.state);
                // #2672: the old guard dropped the WHOLE span when a boundary
                // lacked a plain ref, but protected messages hold the truthy
                // BLOCKED sentinel — so a blind halving midpoint on one passed
                // the guard, reached the kernel as "Invalid boundary ref(s)",
                // and killed both halves at once. Snap instead: a span loses at
                // most its unreferencable rim (the kernel excludes such messages
                // from the block anyway).
                const bounds = snapToUsableBounds(maps.idxToRef, span[0], span[1]);
                const bStart = bounds?.[0];
                const bEnd = bounds?.[1];
                const startRef0 = bStart !== undefined ? maps.idxToRef.get(bStart) : undefined;
                const endRef0 = bEnd !== undefined ? maps.idxToRef.get(bEnd) : undefined;
                if (bStart === undefined || bEnd === undefined || !startRef0 || !endRef0) {
                    deps.log("warn", `[preflight] dropping span ${span[0]}..${span[1]} of range ${skipKey}: no message carries a usable ref (protected or unreferenced)`);
                    noteSkip(`${skipKey}: span ${span[0]}..${span[1]} has no usable ref boundary`);
                    continue;
                }
                let cs = bStart;
                let ce = bEnd;
                let startRef = startRef0;
                let endRef = endRef0;
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
                    // #2638: ONLY the structural "no new compressible messages" verdicts are
                    // regime-independent — coverage-based, they hold under the #330 relax flip
                    // too, so the span is skipped for the rest of this invocation and
                    // remembered across invocations. Zone/min-gate/length verdicts can clear
                    // mid-invocation (relax, newer messages) and stay retryable. Raw errors,
                    // not the truncated verdict: the named-block list must survive intact.
                    const named = parseStructuralEmptyVerdict(preview.result.errors.join("\n"));
                    if (named !== null) {
                        skipSet.add(skipKey);
                        recordDeadRange(deps.session, startRef, endRef, named);
                    }
                    continue;
                }
                const targetKey = foldTargetKey(planned, deps.session.state);
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
                // Any-part external flag: chunked folds assemble one block from
                // several summarizeRange parts, so the marker must survive the
                // assembly (it tags the applied block, not the individual calls).
                let externalFold = false;
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
                            // #2832: while the verdict is dead this call is the
                            // invocation's one canary probe.
                            if (probeGated && probeDead) canarySpent = true;
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
                            if ("unusable" in part && part.deterministic) recordDeterministicEmpty();
                            if ("unusable" in part) {
                                outcome = part;
                                break;
                            }
                            if (part.external) externalFold = true;
                            else clearDeterministicProbe();
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
                            const floorUnits = baselineKnown ? 2 * MIN_CHUNK_TOKENS : 2 * minChars;
                            if ((err.status === 400 || err.status === 413) && !transient
                                && ce > cs && spanUnitsOf(messages, cs, ce, countText) >= floorUnits) {
                                lastUnusableDetail = `HTTP ${err.status}: ${bodySnippet}`;
                                deps.log("warn", `[preflight] chunk ${startRef}:${endRef} rejected with HTTP ${err.status}; retrying with smaller chunks`);
                                pushSpanHalves(maps.idxToRef, spans, cs, ce);
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
                            const caNote = isTlsTrustCode(err.code) ? ` — ${tlsTrustRemediation()}` : "";
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
                    // #2832: a deterministic empty (normal stop, zero text) is not
                    // size-driven — halving would only re-bill doomed draws
                    // against the same wall, so skip straight to the give-up.
                    // The strike may have armed the dead-probe verdict, which
                    // stops the whole walk at the next range's gate.
                    const deterministicUnusable = outcome !== undefined && "unusable" in outcome && outcome.deterministic === true;
                    if (deterministicUnusable) {
                        deps.log("warn", `[preflight] range ${skipKey} got a deterministic empty summary (${unusableDetail}); skipping without halving — a normal stop with zero text is not size-driven (#2832)`);
                        noteSkip(`${skipKey}: deterministic empty summary (${unusableDetail})`);
                        skipSet.add(skipKey);
                        break;
                    }
                    const floorUnits = baselineKnown ? 2 * MIN_CHUNK_TOKENS : 2 * minChars;
                    if (ce > cs && spanUnitsOf(messages, cs, ce, countText) >= floorUnits) {
                        deps.log("warn", `[preflight] chunk ${startRef}:${endRef} produced no usable summary (${unusableDetail}); retrying with smaller chunks`);
                        pushSpanHalves(maps.idxToRef, spans, cs, ce);
                        continue;
                    }
                    deps.log("warn", `[preflight] range ${skipKey} produced no usable summary even at minimum size (${unusableDetail}); skipping it`);
                    noteSkip(`${skipKey}: no usable summary even at minimum size (${unusableDetail})`);
                    skipSet.add(skipKey);
                    break;
                }
                commitFold(skipKey, startRef, endRef, summary, planned.effectiveMessageIds, outcome?.external || externalFold, targetKey);
                break;
            }
            if (appliedThisRound >= maxFoldsPerRound) break;
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
                // #2952 Design A: some raw folds landed but the remaining RAW pool
                // can't close the gap — distilling existing lower-tier blocks might.
                // Defer to the post-walk recovery funnel instead of failing here
                // (tiers=false / emergency digest never enter this branch).
                if (eligibleForTierRecovery()) {
                    deps.log("info", `[preflight] remaining raw-fold pool (~${bailRemaining} tok${zoneNote}) below deficit (~${bailDeficit} tok); deferring to bounded tier-distillation recovery (#2952)`);
                    break;
                }
                // #3461: doomed regardless of relay health only when no draw came
                // back unusable and the pool never dropped — landed folds prove
                // the relay worked, so the residual shortfall is real content.
                failure = { kind: "exhausted", deterministic: lastUnusableDetail === undefined && !poolQueueDrop, detail: `futile round: after the folds so far, the remaining foldable content (~${bailRemaining} tokens${zoneNote}) cannot close the ~${bailDeficit}-token gap to the target even if every remaining range folded successfully.${skipNote} Raise the model context window or restart the session.` };
                break;
            }
            if (!failure && !budgetHit && !relaxed && result.payloadEstimate >= limit) {
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
        // #2952 Design A: last-resort bounded tier-distillation recovery before any
        // exhaustion verdict is final. Reached from a deferred futility gate, a
        // deferred mid-walk bail, or natural walk exhaustion alike — exactly one
        // bounded chance per invocation. On success currentTokens drops under the
        // window and the verdict branches below are skipped entirely; on failure it
        // installs the honest all-tier-exhaustion detail. Never entered for
        // tiers=false / emergency digest mode, so those paths keep their exact
        // prior verdicts.
        if (!tierRecoveryAttempted && eligibleForTierRecovery()) {
            tierRecoveryAttempted = true;
            const rec = await attemptTierRecovery();
            deps.log("info", `[preflight] tier-distillation recovery finished: ${rec.recovered ? "recovered" : "not recovered"}; ${rec.callsUsed} summary call(s), net ~${rec.netSaved} tok saved (#2952)`);
            if (!rec.recovered) {
                failure = { kind: "exhausted", detail: rec.honestDetail };
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
                // #3461: "folded everything compressible" is only a structural
                // verdict when nothing was lost to unusable draws or pool drops.
                failure = { kind: "exhausted", deterministic: lastUnusableDetail === undefined && !poolQueueDrop, detail: `${relaxedExhaustedDetail}${skipNote}` };
            } else if (result.compressedRanges === 0) {
                const cause = poolQueueDrop
                    ? "the shared summary pool was saturated and no summary call was ever dispatched (scheduler congestion, not a chain failure; auto-fold retries next turn)"
                    : skipReasons.length > 0
                        ? skipReasons.slice(0, 3).join(" | ")
                        : "each was below minCompressRange, had an unusable summary, or failed to apply";
                // #3461: zero dispatches means the walk never touched the relay —
                // the shortfall is structural unless the pool itself dropped work.
                failure = { kind: "exhausted", deterministic: rangesTried === 0 && !poolQueueDrop && lastUnusableDetail === undefined, detail: rangesTried === 0
                    ? `no viable range could be compressed: ${cause}${unusableNote}`
                    : `no range could be compressed across ${rangesTried} viable range${rangesTried === 1 ? "" : "s"}: ${cause}${unusableNote}` };
            } else {
                failure = { kind: "exhausted", detail: `the compress budget was exhausted after ${effectiveRoundCap} rounds${unusableNote}${skipNote}` };
            }
        }
    }
    result.rangesRemaining = rangesRemaining;
    result.savedTokens = Math.max(0, startTokens - currentTokens);
    if (deps.signal?.aborted) failure = ABORTED_FAILURE;
    // #4288: a fit-forward exit outranks the stale-floored currentTokens —
    // the payload fits by its own estimate and the caller forwards it; an
    // exhausted verdict here would report a marathon that did not happen.
    if ((currentTokens >= limit && !fitExitForward) || failure?.kind === "aborted") result.failure = failure;
    // #3146: both regimes judge fit on the calibrated CJK-aware estimate — the
    // char-count upper bound was the trigger arm, never the reject-forward gate.
    result.fitsWindow = result.payloadEstimate < limit;
    if (deps.externalSummary !== undefined) {
        result.externalDispatch = { calls: deps.externalSummary.stats.calls, attempts: deps.externalSummary.stats.attempts };
    }
    return result;
}
