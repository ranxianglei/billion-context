import { createHash, randomBytes } from "node:crypto";
import { collectBlockContent, countMessageTokens, defaultCountTokens, formatRanges, hideConsumedCompressCalls, indexToRef, parseBoundary, storeCoveredOriginals, viableRanges, type CompressionCore, type Config, type CoreMessage, type CompressionState, type NudgeDecision, type CompressParseDiagnostics, refToIndex } from "acp-kernel";
import { excludeDeadRefRanges, handleAcpStatus, liveCompressionRanges } from "./acp-status.js";
import { handleAcpCache, prefixTokensBeforeRef, recordCacheFoldsFromBlocks } from "./cache-ledger.js";
import { type Session, cacheBlockContent, markDirty, residentPressure, scrubTurnSeparatorIds, statusInputBaseline } from "./session.js";
import { COMPRESS_TOOL_NAME, parseCompressInput, ABSORB_TOOL_NAME, type ParsedRange } from "./compress-tool.js";
import { effectiveAbsorbConfig, executeAbsorb, isProxyToolFor } from "./absorb.js";
import { executeSearchContextTarget, resolveDecompress } from "./decompress-shared.js";
import { ONE_CALL_HINT } from "acp-kernel";
import { adoptContentStore, contentStoreOf, ccrEnabled, drainPendingRetrievals, executeRetrieve, retrieveToolName } from "./store.js";
import { recordThreadTail } from "./server/thread-tracking.js";
import { peekStoredTailView } from "./persist.js";
import { imagePlaceholdersForSummary } from "./image-note.js";
import { containsBiliInternalText, containsMarkerLineText, containsRenderTagText, containsToolCallEmissionText, stripAcpTags } from "./loop/tag-echo-filter.js";
import { maxShrinkPerCompress } from "./fetch-util.js";
import { compressResult, toolFail, type ProxyToolResult } from "./proxy-tool-result.js";
import { attachSubagentSessions, subagentSessionNote, subagentSessionsOf, syncSubagentSessions } from "./subagent-sessions.js";
import { METADATA_DRIFT_ESCALATED } from "./fold-reconcile.js";
import { safePrefix, safeSuffix, scrubLoneSurrogates } from "./text-safe.js";
import { applyConfiguredCompression } from "./external-summary-compress.js";
import { describeUncoveredRuns, shortTokenCount, uncoveredHistoryRuns } from "./uncovered.js";

export type RewriteCtx = {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    /** View handed to applyCompression. Defaults to `messages`; hosts whose
     *  `messages` view has pruned/hidden content (so block anchors can't
     *  resolve) pass the unpruned log here (billion-context-pi#195). */
    compressMessages?: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
    debug?: boolean;
    /** #2404: this request's prepare-time nudge — the pre-fold offer the model
     *  acted on. postCompressTail bases "remaining ranges" on it (minus the
     *  just-folded spans) instead of a post-fold recompute, which would advance
     *  the protection window and leak newly-de-protected ranges into the receipt
     *  (zero-growth chained folds + prefix-cache thrash). Preflight internal
     *  lanes pin their round's own processTurn offer (#4227); a lane without
     *  one falls back to the live recompute below. */
    lastNudge?: NudgeDecision;
};

// Dispatch all four ACP proxy tools to the same logic the OpenAI/Responses
// path uses (loop/core.ts executeProxyTool). compress mutates context
// (handled by applyRanges); the other three are read-only queries whose result
// becomes a text block replacing the intercepted tool_use.
function executeAnthropicProxyTool(toolName: string, args: Record<string, unknown>, ctx: RewriteCtx): ProxyToolResult {
    if (toolName === COMPRESS_TOOL_NAME) {
        return applyRanges(parseCompressInput(args), ctx);
    }
    if (toolName === "decompress") {
        const ack = resolveDecompress(args, ctx);
        // #1179 CCR v2: range-restore rides the same ephemeral channel as
        // acp_retrieve; this non-stream rewrite has no separate re-request, so
        // drained injections ride inline right after the ack. Whole-block
        // decompress queues nothing — behavior unchanged.
        const injections = drainPendingRetrievals(ctx.session);
        if (injections.length === 0) return ack;
        return { ...ack, text: injections.reduce((acc, inj) => `${acc}\n\n${inj.text}`, ack.text) };
    }
    if (toolName === "search_context") {
        return executeSearchContextTarget(args, ctx.core, ctx.session.id, ctx.session.state, ctx);
    }
    if (toolName === "acp_status") {
        return handleAcpStatus(args, ctx);
    }
    if (toolName === "acp_cache") {
        return handleAcpCache(ctx.session);
    }
    const absorb = effectiveAbsorbConfig(ctx.session, ctx.config);
    if (absorb?.enabled === true && toolName === (absorb.toolName ?? ABSORB_TOOL_NAME)) {
        return executeAbsorb(args, undefined, absorb, ctx);
    }
    if (ccrEnabled(ctx.session) && toolName === retrieveToolName(ctx.session)) {
        // Non-stream rewrite has no re-request to ride, so the full text rides
        // inline right after the ack inside the converted text block.
        const ack = executeRetrieve(args, ctx.session);
        const injections = drainPendingRetrievals(ctx.session);
        if (injections.length === 0) return ack;
        return { ...ack, text: injections.reduce((acc, inj) => `${acc}\n\n${inj.text}`, ack.text) };
    }
    return toolFail(`[Unknown proxy tool: ${toolName}]`);
}

/** Numeric part of a ref ("m00042" → 42, "b3" → 3); 0 for non-numeric. Used to
 *  order ranges by position when picking the fold point (#189 observability). */
function refNum(ref: string): number {
    return Number(ref.replace(/\D/g, "")) || 0;
}

/** #1026: recovery hint appended to failed-compress receipts — the raw-ref
 *  span NOT covered by active blocks right now. Kernel errors tell the model
 *  to run acp_status; a model that retries blind keeps anchoring on refs an
 *  earlier fold already consumed (01a0b0c4, 2026-09-18: three consecutive
 *  failed compresses, two full T1 checkpoints wasted, then it gave up and
 *  let the nudge re-fire every turn). Handing the live span over kills the
 *  retry loop without another round-trip. Boundary counts ACTIVE blocks
 *  only — after a decompress (blocks inactive) the restored span shows as
 *  compressible again, which is exactly the recoverable truth. */
function compressionRecovery(ctx: RewriteCtx): { hint: string; canRetry: boolean } {
    try {
        const live = liveCompressionRanges(ctx);
        if (live) {
            if (live.ranges.length > 0) {
                const ranges = formatRanges(live.ranges, []).replace(/\s*\n\s*/g, " ");
                return { hint: ` Current compressible ranges (use these refs exactly as listed): ${ranges} Do not repeat the rejected call unchanged; use only the eligible ranges listed here.`, canRetry: true };
            }
            if (live.nudge.tier !== null && live.nudge.tier >= 2) {
                return { hint: " No eligible raw-message ranges remain. A block-distillation nudge is active; call acp_status to inspect its target blocks before requesting a block merge. Do not repeat the rejected message range.", canRetry: false };
            }
            return { hint: " No eligible message ranges are available now; continue the task without compressing. Recheck acp_status after the context changes.", canRetry: false };
        }
        // #3302: the live check only yields a verdict when this pass produced a
        // nudge decision. When it didn't, the previous prepare's offer
        // (ctx.lastNudge) still lists kernel-validated ranges — stale by at
        // most one turn, and self-correcting if one was folded meanwhile (the
        // kernel rejects it as already compressed). Sending the model to
        // acp_status for another full round-trip after EVERY failed compress
        // is exactly the cost this issue reports.
        const last = ctx.lastNudge;
        if (last?.shouldInject && last.compressibleRanges && last.compressibleRanges.length > 0) {
            const minChars = ctx.config.compress.minCompressRange;
            const submitGate = (r: CompressibleRangeItem): boolean =>
                minChars <= 0 || (r.chars ?? r.tokens * 4) >= minChars;
            const ranges = excludeDeadRefRanges(viableRanges(last.compressibleRanges).filter(submitGate), ctx.session.state.deadRefs);
            if (ranges.length > 0) {
                const formatted = formatRanges(ranges, []).replace(/\s*\n\s*/g, " ");
                return { hint: ` Current compressible ranges from the last compression check (use these refs exactly as listed; recheck acp_status if one is rejected): ${formatted} Do not repeat the rejected call unchanged.`, canRetry: true };
            }
        }
    } catch {
        // Never replace a failed live check with a guessed ref span.
    }
    return { hint: " Current compression eligibility could not be determined. Call acp_status before retrying; do not repeat the rejected range blindly.", canRetry: false };
}

export function compressibleSpanHint(ctx: RewriteCtx): string {
    return compressionRecovery(ctx).hint;
}

const M_REF_NUM_RE = /^m0*(\d{1,7})$/i;

// #1001: after a client history rewrite, ref numbers are no longer monotonic
// with message position (surviving old messages keep low refs interleaved with
// fresh high refs), so position-derived spans can come back numerically
// reversed (startId > endId). The kernel resolves boundaries BY POSITION and
// swaps silently — normalize up front so specs and logs stay honest and range
// validity is validated explicitly instead of implicitly. bN/mixed endpoints
// have no cross-namespace ordering and are left untouched.
export function normalizeRangeOrder(ranges: Array<{ startRef: string; endRef: string }>): number {
    let swapped = 0;
    for (const r of ranges) {
        const a = M_REF_NUM_RE.exec(r.startRef.trim());
        const b = M_REF_NUM_RE.exec(r.endRef.trim());
        if (!a || !b) continue;
        if (Number(a[1]) > Number(b[1])) {
            const s = r.startRef;
            r.startRef = r.endRef;
            r.endRef = s;
            swapped++;
        }
    }
    return swapped;
}

// #847: the kernel normalizes reversed startId/endId silently (bounds are
// swapped), so a parameter slip surfaces as an unrelated content error — the
// model then imitates its own failed call in a loop. Surface the reversal.
function reversedRanges(ranges: ParsedRange[]): ParsedRange[] {
    return ranges.filter((r) => refNum(r.startRef) > refNum(r.endRef));
}
// #847: a rejected spec fails deterministically until the visible context
// changes, so repeating it is pure context burn (the incident looped the same
// call 7x over ~13 min while usage climbed 76%→89%). Track recent failed
// specs per session and escalate on repeat instead of echoing the plain gate
// error again. Stored on metadata (persisted) so the streak survives LRU
// eviction/reload; stale keys after a ref reset are harmless (no match).
const FAIL_STREAK_KEY = "compressFailKeys";
const FAIL_STREAK_CAP = 5;
function normalizedSpecKey(ranges: ParsedRange[]): string {
    return ranges
        .map((r) => (refNum(r.startRef) <= refNum(r.endRef) ? `${r.startRef}..${r.endRef}` : `${r.endRef}..${r.startRef}`))
        .sort()
        .join(",");
}
function recordCompressFailure(session: Session, key: string, repeatAdvice?: string): string {
    if (!key) return "";
    const prev = session.metadata[FAIL_STREAK_KEY];
    const keys = Array.isArray(prev) ? prev.filter((k): k is string => typeof k === "string") : [];
    const occurrences = keys.filter((k) => k === key).length + 1;
    keys.push(key);
    while (keys.length > FAIL_STREAK_CAP) keys.shift();
    session.metadata[FAIL_STREAK_KEY] = keys;
    markDirty(session);
    if (occurrences < 2) return "";
    const advice = repeatAdvice ?? "Call acp_status and follow its current eligibility advice; continue the task if no eligible ranges remain.";
    return ` [Repeat-failure guard: you have now requested this exact spec ${occurrences} time(s) in this session and it keeps failing with the same error. Repeating it deterministically fails the same way until the visible context changes — do NOT re-issue it. ${advice}]`;
}
function clearCompressFailures(session: Session): void {
    if (session.metadata[FAIL_STREAK_KEY] !== undefined) {
        delete session.metadata[FAIL_STREAK_KEY];
        markDirty(session);
    }
}

// #2146: the exact-spec repeat guard above is defeated by a model that walks
// spec space — one fresh (also failing) range per call. In the incident,
// glm-5.3-flash burned 2h42m on 161 DISTINCT failing specs after a client
// restart left stale-generation refs in its persisted history, never calling
// acp_status despite every receipt asking it to; the #1026/#1029 hints were
// in the receipts and were ignored. A session-level streak of consecutive
// TOTAL failures (any spec) catches that shape: at N failures the receipt
// switches from diagnostic hints to a hard-stop instruction. Hardcoded by
// design (config-surface discipline, cf. DEGENERATE_FOLD_COVERAGE). Disarm is
// success or 10 min of quiet — refs keep advancing DURING the loop (each
// failed round appends messages), so a frontier-based decay would disarm
// mid-loop and be defeated the same way.
const COMPRESS_LOOP_KEY = "compressFailStreak";
const COMPRESS_LOOP_THRESHOLD = 3;
const COMPRESS_LOOP_DECAY_MS = 10 * 60 * 1000;

type CompressLoopStreak = { n: number; lastAt: number; cause?: string };

function readCompressLoopStreak(session: Session): CompressLoopStreak | undefined {
    const v = session.metadata[COMPRESS_LOOP_KEY];
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    if (typeof o["n"] !== "number" || !Number.isFinite(o["n"]) || typeof o["lastAt"] !== "number") return undefined;
    return {
        n: Math.max(0, Math.floor(o["n"] as number)),
        lastAt: o["lastAt"] as number,
        ...(typeof o["cause"] === "string" && (o["cause"] as string).length > 0 ? { cause: o["cause"] as string } : {}),
    };
}

function writeCompressLoopStreak(session: Session, s: CompressLoopStreak | undefined): void {
    if (s === undefined) delete session.metadata[COMPRESS_LOOP_KEY];
    else session.metadata[COMPRESS_LOOP_KEY] = s;
    markDirty(session);
}

// #2146: the loop-noise pause paragraph. Wording kept VERBATIM on purpose
// (owner decision, 2026-10-07) — the direct voice is part of the fix's
// measured behavior. This comment is written in neutral terms because
// provider-side content scanners read source files that agents open.
function loopNoisePauseParagraph(n: number): string {
    return ` [COMPRESS CIRCUIT BREAKER: ${n} consecutive compress failures in this session — every attempt has failed and further attempts will keep failing. STOP calling compress now: do not try other ranges, do not re-issue any previous range, and do not poll acp_status. Continue your actual task without compressing — compression happens again only when there is genuinely new content to fold.]`;
}

// #2432: substrate-destruction is NOT loop noise. When the fold substrate was
// destroyed by an out-of-band history rewrite, blind stopping leaves the model
// in a room with no exit — the ONLY recovery is one acp_status plus a
// live-range re-anchor, and one success clears the breaker. The blanket "do
// not poll acp_status" order above is right for noise and wrong for this
// cause, so the armed receipt branches on compressFailureCause (#2360 §2.4
// already computes it at the same sites).
function substrateDestructionPauseParagraph(n: number): string {
    return ` [COMPRESS CIRCUIT BREAKER: ${n} consecutive compress failures in this session — every attempt has failed because the fold substrate was destroyed by an out-of-band history rewrite. STOP calling compress now: do not try other ranges and do not re-issue any previous ones. There is exactly ONE recovery step: run acp_status once, then compress ONLY a range it currently reports as compressible — one success clears this breaker. If acp_status reports no compressible ranges, continue your task without compressing.]`;
}

/** #2146: record one total compress failure (any spec) and return "" while
 *  healthy, or the pause paragraph to embed in the receipt once the
 *  consecutive-failure threshold is reached. Only failed-call receipts carry
 *  it: successful calls always go through, and one success clears the streak
 *  (clearCompressLoopStreak). The pause paragraph branches on the failure
 *  cause (#2432): substrate-destruction gets the single-recovery-step
 *  wording, everything else keeps the verbatim loop-noise paragraph. */
function noteCompressLoopFailure(ctx: RewriteCtx, specLabel: string, errs?: string, forcedCause?: string): string {
    const now = Date.now();
    let streak = readCompressLoopStreak(ctx.session);
    if (streak && now - streak.lastAt > COMPRESS_LOOP_DECAY_MS) streak = undefined;
    const n = (streak?.n ?? 0) + 1;
    // #2432: persist the failure cause on the streak so surfaces OUTSIDE the
    // receipt (acp_status) can react to a substrate/stale-ref verdict at n=1
    // instead of waiting for the third failure to arm the breaker. A cause
    // only ever moves forward: an unknown-cause failure keeps the last known
    // verdict rather than erasing it. #3126: host-side gates that know their
    // own verdict before the kernel runs pass it as forcedCause — deriving it
    // from kernel error text would misattribute a gate refusal to content.
    const freshCause = forcedCause ?? (errs !== undefined ? compressFailureCause(errs, ctx.session) : "");
    const cause = freshCause !== "" ? freshCause : streak?.cause;
    writeCompressLoopStreak(ctx.session, { n, lastAt: now, ...(cause !== undefined ? { cause } : {}) });
    if (n < COMPRESS_LOOP_THRESHOLD) return "";
    const label = specLabel || "unparseable call";
    if (n === COMPRESS_LOOP_THRESHOLD) {
        ctx.log(`[warn: compress-loop] circuit breaker armed after ${n} consecutive compress failures (last spec: ${label}) — receipts now demand a full stop; disarms on success or ${COMPRESS_LOOP_DECAY_MS / 60000} min quiet`);
    } else {
        ctx.log(`[warn: compress-loop] failure ${n} in armed streak (last spec: ${label})`);
    }
    if (freshCause.startsWith("substrate-destruction")) {
        return substrateDestructionPauseParagraph(n);
    }
    return loopNoisePauseParagraph(n);
}

function clearCompressLoopStreak(session: Session): void {
    if (readCompressLoopStreak(session)) writeCompressLoopStreak(session, undefined);
}

/** #2432: armed-breaker state for surfaces outside the receipt (acp_status,
 *  nudge injection gates). A streak counts as armed while n ≥ threshold AND
 *  within the decay window — the same two conditions noteCompressLoopFailure
 *  applies, so a decayed-but-not-yet-overwritten streak reads as disarmed
 *  here even before the next failure rewrites the metadata. */
export function compressBreakerDetail(session: Session): { n: number; threshold: number; decayMinutes: number; cause?: string } | undefined {
    const s = readCompressLoopStreak(session);
    if (!s || s.n < COMPRESS_LOOP_THRESHOLD) return undefined;
    if (Date.now() - s.lastAt > COMPRESS_LOOP_DECAY_MS) return undefined;
    return { n: s.n, threshold: COMPRESS_LOOP_THRESHOLD, decayMinutes: Math.round(COMPRESS_LOOP_DECAY_MS / 60000), ...(s.cause !== undefined ? { cause: s.cause } : {}) };
}

export function compressBreakerArmed(session: Session): boolean {
    return compressBreakerDetail(session) !== undefined;
}

/** #2432: the last recorded compress-failure cause, readable while the breaker
 *  is NOT yet armed (n < threshold) and within the decay window. acp_status
 *  uses it to stop advertising ranges the moment a failure is attributed to a
 *  dead substrate or a foreign ref generation — before the third failure arms
 *  the breaker and the model has already been pointed at failing ranges twice. */
export function compressLastFailureCause(session: Session): string | undefined {
    const s = readCompressLoopStreak(session);
    if (!s || Date.now() - s.lastAt > COMPRESS_LOOP_DECAY_MS) return undefined;
    return s.cause;
}

// #2360 §2: while the breaker is armed, the kernel's per-error retry guidance
// ("Run acp_status, then call the compress tool again …") sits in the SAME
// receipt as the breaker paragraph's "do not poll acp_status" — the looping
// model got two contradictory orders in one tool result and obeyed neither
// (observed: 3 blind re-issues, zero acp_status calls). Scrub the known
// kernel sentences from the model-visible receipt while armed; the operator
// log keeps the full text. The wording lives in kernel/src/compress.ts
// (gateMessage variants) — if it drifts the scrub misses and the pre-#2360
// behavior returns, which is no worse than today.
const KERNEL_RETRY_GUIDANCE = [
    "Run acp_status, then call the compress tool again using only the refs it reports.",
    "Continue the task, or run acp_status and target one of the CURRENT compressible ranges it reports.",
    "Do not retry this range in any form \u2014 run acp_status and target only the live refs it reports.",
] as const;

function scrubKernelRetryGuidance(errs: string): string {
    let out = errs;
    for (const g of KERNEL_RETRY_GUIDANCE) out = out.split(g).join("");
    return out;
}

/** #2360 §2.4: name the failure class so model and user can tell at a glance
 *  who owns the fix — stale refs (transient), an already-covered range
 *  (nothing to do), or a destroyed substrate (host-native compaction landed
 *  outside bili's knowledge — structural, report it instead of retrying).
 *  Derived from the kernel's gate-message variants (kernel/src/compress.ts);
 *  the escalated fold-drift flag (#2193) sharpens the unanchored case into
 *  the substrate verdict. */
function compressFailureCause(errs: string, session: Session): string {
    if (errs.includes("cannot be anchored")) {
        return session.metadata[METADATA_DRIFT_ESCALATED] === true
            ? "substrate-destruction — host-native compaction or bulk client-side history rewrite landed outside bili's knowledge (#1729/#2193); structural, report it"
            : "content-changed — the messages behind those refs changed and carry new refs now";
    }
    // #3302: "unknown" now covers three sub-cases (earlier generation, typo,
    // sparse-space gap) — name the class honestly; the prefix stays stable for
    // downstream startsWith matching (acp_status verdict sections).
    if (errs.includes("every ref is unknown to this session")) return "stale-ref — the refs do not exist in this session's ref space (another generation, a typo, or pruned gaps)";
    if (errs.includes("covered by active block")) return "covered-by-block — nothing new to fold in that window";
    return "";
}

/** Highest allocated mNNNNN number in the session's ref map (0 when empty). */
function highestMappedRef(state: Pick<CompressionState, "messageRefs">): number {
    let highest = 0;
    for (const ref of Object.keys(state.messageRefs?.byRef ?? {})) {
        const m = M_REF_NUM_RE.exec(ref);
        if (m) highest = Math.max(highest, Number(m[1]));
    }
    return highest;
}

/** #2146: every requested endpoint sits strictly ABOVE the session's highest
 *  mapped m-ref. Such refs cannot exist in this session (refs are never
 *  pre-allocated); the kernel now classifies that case as above-frontier
 *  (#3302) and this note reinforces it with the model-visible consequence —
 *  NO superset of such refs can ever compress — so the model stops re-anchoring
 *  on other stale artifacts instead. */
export function beyondFrontierNote(state: Pick<CompressionState, "messageRefs">, ranges: Array<{ startRef: string; endRef: string }>): string {
    const highest = highestMappedRef(state);
    if (highest <= 0 || ranges.length === 0) return "";
    const allAbove = ranges.every((r) => {
        const s = M_REF_NUM_RE.exec(r.startRef.trim());
        const e = M_REF_NUM_RE.exec(r.endRef.trim());
        return !!s && !!e && Number(s[1]) > highest && Number(e[1]) > highest;
    });
    if (!allAbove) return "";
    const hi = `m${String(highest).padStart(5, "0")}`;
    return ` All requested refs are above this session's highest ref (${hi}) — they cannot exist here (this session allocates no future refs). They are stale artifacts from an earlier session generation left in your visible history; NO superset of them can ever compress. Request only refs ≤ ${hi}, or call acp_status for the live ranges.`;
}

/** #4252 follow-up: PARTIALLY past the frontier — some endpoint above the
 *  highest stored ref while another sits inside it. beyondFrontierNote
 *  (#2146) only fires when EVERY endpoint is above, so a start-in/end-out
 *  range fell through to generic guidance while allocation lagged rendering
 *  (the model sees refs in its transcript that the store has not minted yet)
 *  and it blind-retried against a moving ceiling (incident session 01a15993:
 *  5× gate:none-resolved inside 8 minutes, breaker armed). Name the ceiling
 *  and the clamp explicitly so one retry converges. Fires only when the
 *  all-above note is absent (the two are mutually exclusive by design). */
export function frontierClampNote(
    state: Pick<CompressionState, "messageRefs">,
    ranges: Array<{ startRef: string; endRef: string }>,
    beyond: string,
): string {
    if (beyond !== "" || ranges.length === 0) return "";
    const highest = highestMappedRef(state);
    if (highest <= 0) return "";
    const over = ranges.filter((rg) => {
        const s = M_REF_NUM_RE.exec(rg.startRef.trim());
        const e = M_REF_NUM_RE.exec(rg.endRef.trim());
        return !!s && !!e && (Number(s[1]) > highest || Number(e[1]) > highest);
    });
    if (over.length === 0) return "";
    const hi = `m${String(highest).padStart(5, "0")}`;
    const list = over.map((rg) => `${rg.startRef}–${rg.endRef}`).join(", ");
    return ` Range(s) ${list} extend past this session's highest stored ref (${hi}) — refs are minted as messages are stored, so numbers you can already see rendered may not be ingestible yet. Retry with endId ≤ ${hi}, or call acp_status for the live compressible span.`;
}

/** #2592/F3: after a host-native compaction rebase (resetSessionCompression)
 *  the ref numbering restarted, so pre-rebase refs the model still cites can
 *  never resolve again. Name the rebase as the deterministic cause so the
 *  model stops treating the unknown refs as typos and re-anchors on the live
 *  snapshot instead. Fires only for the below-frontier stale-ref case — when
 *  every requested ref sits above the frontier, #2146's note already names
 *  the earlier-generation cause. */
export function rebaseNote(session: Session, errs: string, beyond: string): string {
    if (beyond !== "" || !errs.includes("every ref is unknown to this session")) return "";
    if (typeof session.metadata.nativeCompactionAt !== "number") return "";
    return ` This session was rebased (host-native compaction) — refs minted before the rebase no longer resolve and no retry can revive them.`;
}

// #1029: after a session-generation change (client restart/fork starts a fresh
// session instance whose refs restart at m00001), stale refs from the previous
// generation fail resolution. The kernel gate points at acp_status; inline the
// current span here so the model can re-issue immediately without the round-trip.
function currentRefsSnapshot(ctx: RewriteCtx): string {
    // Refs live in state.messageRefs (mNNNNN namespace); message ids are raw
    // client ids and carry no ref numbers.
    let loId = "";
    let hiId = "";
    let loN = Infinity;
    let hiN = -1;
    for (const ref of Object.keys(ctx.session.state.messageRefs?.byRef ?? {})) {
        const m = M_REF_NUM_RE.exec(ref);
        if (!m) continue;
        const n = Number(m[1]);
        if (n < loN) { loN = n; loId = ref; }
        if (n > hiN) { hiN = n; hiId = ref; }
    }
    if (!loId || !hiId) return "";
    const activeBlocks = ctx.session.state.blocks.filter((b) => b.active).length;
    return ` [Current context: ${ctx.messages.length} visible message(s), refs ${loId}–${hiId}, ${activeBlocks} active block(s). Refs restart at m00001 after a session-generation change — request only refs inside this span, or call acp_status for exact compressible ranges.]`;
}

// #1294 P1: one-line integrity fingerprint per created/updated block — exact
// char length plus head/tail excerpts (newlines flattened to spaces) so the
// model can verify its summary was stored intact without decompressing.
export function summaryFingerprintLine(blockId: string, summary: string): string {
    // #1615: code-unit cuts can split a surrogate pair and the lone half
    // breaks upstream JSON parsing of the whole body — clamp + scrub (#816
    // family, third site; never slice model-visible text by hand again).
    const head = scrubLoneSurrogates(safePrefix(summary, 30).replace(/\r?\n/g, " "));
    const tail = scrubLoneSurrogates(safeSuffix(summary, 100).replace(/\r?\n/g, " "));
    return ` · ${blockId} full summary ${summary.length}ch · head "${head}" … tail "${tail}"`;
}

// #1718: log-safe variant of the fingerprint line. Summaries are
// conversation-derived text (local paths, task state, decisions, commands), so
// bili.log must carry only the length — never the head/tail excerpts. The
// model-facing receipt keeps the full fingerprint (#1294 integrity check);
// the two consumers diverge by design.
export function summaryFingerprintLogLine(blockId: string, summary: string): string {
    return ` · ${blockId} summary ${summary.length}ch`;
}

// #1718: m.id is a DETERMINISTIC content hash (deriveMessageId: sha256 over
// role|contentType|toolCallId|toolName|text, see MESSAGE-IDENTITY.md) — logging
// it raw lets identical messages be correlated across sessions/runs/machines
// and enables offline guessing against low-entropy content. Salt with a
// per-process random value: joins within one run still work, cross-run
// correlation dies, and guessing is impossible without the salt (which never
// leaves the process).
const MSG_ID_LOG_SALT = randomBytes(8).toString("hex");
export function saltedMsgIdForLog(id: string, salt: string = MSG_ID_LOG_SALT): string {
    return "x_" + createHash("sha256").update(`${salt}:${id}`).digest("hex").slice(0, 10);
}

// #1494: entries dropped at PARSE time vanish from `ranges`, so the success
// line ("Compressed <detail>") and the 0-blocks failure both list only the
// survivors — a 3-entry call that silently loses one reads as a clean 2-block
// success (the exact report in the issue; the kernel diagnostics carry the
// per-entry reasons but nothing surfaced them when ≥1 range survived).
function droppedEntriesNote(diagnostics: CompressParseDiagnostics): string {
    // #1495: a gateway-stringified content array can arrive CUT — the lenient
    // parser salvages only the complete leading entries (kind="truncated") and
    // the unterminated tail is lost without counting as invalidItems.
    if (diagnostics.kind === "truncated" && diagnostics.invalidItems <= 0) {
        return `[The compress arguments arrived TRUNCATED — only the complete leading entries could be salvaged; any requested range not listed above was LOST, not compressed. Check acp_status for what is still compressible and re-issue the missing range(s).]`;
    }
    if (diagnostics.invalidItems <= 0) return "";
    const reasons = (diagnostics.invalidReasons ?? []).slice(0, 3).map((r) => (r.length > 160 ? safePrefix(r, 160) + "..." : r));
    const why = reasons.length > 0 ? reasons.join(" | ") : `${diagnostics.invalidItems} entr(ies) failed validation (parse kind=${diagnostics.kind})`;
    const n = diagnostics.invalidItems;
    return `[${n} of the submitted entr${n === 1 ? "y" : "ies"} ${n === 1 ? "was" : "were"} REJECTED and NOT compressed: ${why}. Re-issue the rejected range${n === 1 ? "" : "s"} in a new compress call.]`;
}

// #1387 (pi-side #420/#521 alignment): post-compress continuation contract.
// Silence after success is not a stop signal — models extrapolate ghost endIds
// past the session tail and burn a round on kernel rejection. Wording is
// verbatim pi-side so both hosts speak the same contract.
const NO_RANGES_REMAIN_TEXT = "No compressible ranges remain — the context is already at its minimum; continue the task without compressing.";
// #4331 / pi #521 anti-nag rule: below this TOTAL uncovered mass the receipt
// keeps the legacy wording — small leftovers outside the offer must not re-nag
// on every fold. Material leaks (the #4331 class: tens of K tokens raw) override it.
const UNCOVERED_RECEIPT_FLOOR_TOKENS = 10_000;

// #2404: the tail's "remaining ranges" is the LAST NUDGE's offer (the pre-fold
// set the model acted on) minus the just-folded spans — NOT a fresh post-fold
// recompute. Recomputing from live state advances the protection window, so a
// range still protected at nudge time becomes eligible only AFTER the fold and
// leaks into the receipt; the model then folds it at ZERO conversation growth,
// each fold rewriting the history prefix and invalidating the upstream prefix
// cache (fold #1's uncached re-read is paid again by fold #2). Pinning the list
// to the pre-fold offer keeps a not-yet-offered (still-protected) range out of
// the receipt, so the protection holds. Wording unchanged (KDD #8: prompt text
// is kernel-owned) — this is pure bili-side gating.
type CompressibleRangeItem = NonNullable<NudgeDecision["compressibleRanges"]>[number];

// Refs are zero-padded mNNNNN, stable across folds (kernel id-never-reused
// contract); compare numeric parts. Two [start,end] spans overlap iff neither
// ends before the other starts.
function spanNum(ref: string): number {
    const n = Number(ref.replace(/\D/g, ""));
    return Number.isFinite(n) ? n : 0;
}
function spansOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
    const aLo = Math.min(spanNum(aStart), spanNum(aEnd));
    const aHi = Math.max(spanNum(aStart), spanNum(aEnd));
    const bLo = Math.min(spanNum(bStart), spanNum(bEnd));
    const bHi = Math.max(spanNum(bStart), spanNum(bEnd));
    return aLo <= bHi && bLo <= aHi;
}

function postCompressTail(ctx: RewriteCtx, cleanSuccess: boolean, submitted: Array<{ startRef: string; endRef: string }>): string {
    // Same gates as handleAcpStatus: viability floor + the submit gate's raw char
    // count — never advertise a range the kernel would reject (#847).
    const minChars = ctx.config.compress.minCompressRange;
    const submitGate = (r: CompressibleRangeItem): boolean =>
        minChars <= 0 || (r.chars ?? r.tokens * 4) >= minChars;
    let base: CompressibleRangeItem[];
    let tier: number | null;
    if (ctx.lastNudge) {
        // Baseline = this request's prepare-time offer (already viable-filtered
        // by the prepare step), NOT a post-fold recompute (#2404).
        base = excludeDeadRefRanges(viableRanges(ctx.lastNudge.compressibleRanges).filter(submitGate), ctx.session.state.deadRefs);
        tier = ctx.lastNudge.tier ?? null;
    } else {
        // Lane without a pinned offer → fall back to the live recompute (same
        // source as #389); preflight now pins its round's own nudge (#4227).
        // processTurn is pure; the returned state is deliberately NOT adopted.
        let nudge: NudgeDecision | undefined;
        try {
            const turn = ctx.core.processTurn({
                messages: ctx.messages,
                state: ctx.session.state,
                config: ccrEnabled(ctx.session) ? ctx.config : { ...ctx.config, ccr: undefined },
                tokenCount: statusInputBaseline(ctx.session),
                renderTags: "none",
                contentStore: contentStoreOf(ctx.session),
                // #3236: screen advertised tail ranges on the apply class.
                applyView: ctx.compressMessages,
            });
            nudge = turn.nudge;
        } catch {
            return "";
        }
        if (!nudge) return "";
        // The kernel's own eligibility verdict governs the tail: a decision
        // struct with shouldInject === false is the kernel saying the leftover
        // ranges sit below its threshold/floor/cadence (e.g. a 1-message
        // residue exposed by a smaller preserveRecentMessages window, #3058).
        // Advertising them anyway re-nags at zero pressure — the exact disease
        // #1387 (pi #521) fixed. shouldInject=false ⇒ nothing actionable ⇒ fall
        // through to the stop-signal logic below (never list the ranges).
        if (nudge.shouldInject) {
            base = excludeDeadRefRanges(viableRanges(nudge.compressibleRanges).filter(submitGate), ctx.session.state.deadRefs);
        } else {
            base = [];
        }
        tier = nudge.tier ?? null;
    }
    // Drop the offers this call just folded; everything else stays advertised
    // ("compressed 2 of 3 -> show the 1"). Only when ALL offered folded does the
    // stop signal fire below. Ranges not in the pre-fold offer never appear here.
    const remaining = ctx.lastNudge
        ? base.filter((r) => !submitted.some((s) => spansOverlap(r.startRef, r.endRef, s.startRef, s.endRef)))
        : base;
    if (remaining.length > 0) {
        return `\n\nCurrent compressible ranges (use these refs exactly as listed):\n${formatRanges(remaining, [])}\n${ONE_CALL_HINT}`;
    }
    // A tier-distillation nudge means block-boundary compress calls (bN..bM) are
    // still actionable — a stop signal there would contradict the tier trigger.
    // Partial failures stay silent too: the model still owes the errors an answer
    // before any "you are done" verdict (pi #521 gate).
    if (!cleanSuccess || tier !== null) return "";
    // #4331: offer exhaustion is NOT proof the context is at its minimum — the
    // verdict only sees this call's pre-fold offer, and mid-history runs can sit
    // outside every active block AND outside the offer (disjoint folds, dead-ref
    // holes, integrity withdrawals). Audit before making the global claim; the
    // verbatim contract string (#1387) stays intact for genuinely-drained
    // sessions. Advisory only: audit failure degrades to the old wording path.
    try {
        const runs = uncoveredHistoryRuns({
            core: ctx.core,
            messages: ctx.messages,
            state: ctx.session.state,
            config: ccrEnabled(ctx.session) ? ctx.config : { ...ctx.config, ccr: undefined },
            tokenCount: statusInputBaseline(ctx.session),
            contentStore: contentStoreOf(ctx.session),
            applyView: ctx.compressMessages,
            actionableSpans: remaining,
        });
        if (runs.length > 0) {
            const totalMsgs = runs.reduce((s, r) => s + r.count, 0);
            const totalTok = runs.reduce((s, r) => s + r.tokens, 0);
            if (totalTok >= UNCOVERED_RECEIPT_FLOOR_TOKENS) {
                return `\n\nUncovered history remains — all offered ranges are folded, but ${totalMsgs} msg(s) across ${runs.length} run(s), ${shortTokenCount(totalTok)} tok, sit outside every active block and are not in this call's offer: ${describeUncoveredRuns(runs)}. The context is not at its minimum (runs may sit below the fold-size gate — named for visibility, not as fold suggestions); inspect with acp_status(scope:"uncompressed").`;
            }
        }
    } catch {
        // Fall through to the contract wording below.
    }
    return `\n\n${NO_RANGES_REMAIN_TEXT}`;
}

// #1495: the kernel's lenient parser salvages complete entries from damaged
// arguments (truncated gateway-stringified arrays, corrupted elements) and
// reports what it dropped via diagnostics — which this path only read on TOTAL
// failure. On partial success the receipt was a clean "[Compressed … → N
// block(s)]" for ranges that were requested but never folded. Every non-total
// receipt now names what was dropped so partial application stays visible and
// re-issuable. Apply-layer per-range errors (unknown refs, …) get the same
// treatment: previously also invisible when some other range in the batch
// succeeded.
function applyErrorNote(r: { errors: string[] }): string {
    if (r.errors.length === 0) return "";
    const errs = r.errors.slice(0, 3).map((e) => e.length > 200 ? `${safePrefix(e, 200)}…` : e).join(" | ");
    return ` Errors: ${errs}`;
}

// #1911: coverage at or above which one fold counts as a degenerate reset —
// the entire live context rewritten into the new block(s), prefix cache
// restarting from scratch. Hardcoded by design (config-surface discipline);
// hosts that want to penalize this shape grep the warn marker below.
const DEGENERATE_FOLD_COVERAGE = 0.8;

/** #3126: refuse up front when the proxy holds NO message view of this
 *  conversation while its ref table says refs exist. The plugin tool endpoint
 *  serves compress from a volatile in-memory view (session.transient.pluginMessages,
 *  with the fork-only pluginSnapshot as fallback) that is legitimately empty
 *  between model requests once the session object left the resident pool
 *  (512 MiB byte budget, evictOldest) or the process restarted — state (every
 *  ref mapping) survives on disk, the message bytes do not (transient is never
 *  persisted; pluginSnapshot persists only for fork sessions, #2077). Feeding
 *  an empty view to the kernel dangles EVERY requested ref, records them all
 *  DEAD (the host commits applyCompression's cloned state even when zero blocks
 *  were created), and the receipt blames "content-changed" — none of which is
 *  true: the refs are intact and the view self-heals on the next model request
 *  (rememberPluginMessages after forward).
 *
 *  #3859: WHICH empty-view calls may still be handed to the kernel is decided
 *  by the kernel's own dead-ref test, not by span overlap. danglingMessageRefs
 *  records a requested ref dead exactly when that BOUNDARY ref is known to this
 *  session but not visible and not inside any active block's effectiveMessageIds
 *  — so a range that overlaps one block while its boundary refs sit in gaps
 *  between blocks passed the old overlap gate and got its live refs tombstoned.
 *  The gate now yields only when every requested range's message-ref boundaries
 *  are point-covered by some active block (block-ref boundaries carry no raw id
 *  and can never be tombstoned). That is also exactly the set of shapes the
 *  kernel could ever serve from state alone (#403/#2748 restoredInline refold,
 *  already-compressed warnings): with a truly empty view nothing else anchors,
 *  so every uncovered-boundary shape can only fail or corrupt.
 *  Null = no refusal, proceed. */
export function noVisibleContextRefusal(
    ctx: RewriteCtx,
    ranges: ParsedRange[],
    opts?: { loopTracking?: boolean },
): ProxyToolResult | null {
    const view = ctx.compressMessages ?? ctx.messages;
    const mappedRefs = Object.keys(ctx.session.state.messageRefs?.byRef ?? {}).length;
    if (view.length > 0 || mappedRefs === 0) return null;
    // #3859: yield to the kernel only when its own dead-ref test cannot fire on
    // anything here — i.e. every requested message-ref boundary is point-covered
    // by an active block (mirrors danglingMessageRefs: same byRef lookup, same
    // effectiveMessageIds coverage; block-ref boundaries carry no raw id and are
    // skipped there too). Any uncovered boundary would be recorded DEAD on this
    // empty view while still live on disk. A boundary with no known rawId is
    // yielded deliberately: the kernel then only re-records ids already dead
    // (#3302, idempotent) or skips unknown ones — it can never corrupt a live ref.
    const byRef = ctx.session.state.messageRefs?.byRef ?? {};
    const coveredRawIds = new Set(
        ctx.session.state.blocks.filter((b) => b.active).flatMap((b) => b.effectiveMessageIds),
    );
    const unvouchable = ranges.some((r) => [r.startRef, r.endRef].some((ref) => {
        const parsed = parseBoundary(ref);
        if (!parsed || parsed.kind !== "message") return false;
        const rawId = byRef[parsed.raw] ?? byRef[indexToRef(parsed.numericId)];
        return Boolean(rawId) && !coveredRawIds.has(rawId);
    }));
    if (!unvouchable) return null;
    const detail = ranges.map((r) => `${r.startRef}–${r.endRef}`).join(", ");
    // #3918: the "self-heals on the next model request" promise holds ONLY when
    // the reloaded session survives between requests. When this session's
    // last-known live weight cannot fit alongside the current residents within
    // the byte budget, every request cycle ends with it evicted again and this
    // exact refusal repeats forever — say so plainly instead of advising an
    // impossible retry (the incident: a ~444 MiB image session ping-ponging
    // against an ~87.5 MiB peer under the 512 MiB default budget).
    const pressure = residentPressure(ctx.session.id);
    ctx.log(pressure.permanent
        ? `[acp-proxy: compress REFUSED ${detail} — no visible context (view=0 message(s), ${mappedRefs} ref(s) mapped); refs left untouched and nothing recorded as dead — PERMANENT: last-known weight ${formatMiB(pressure.weightBytes)} + other residents ${formatMiB(pressure.otherBytes)} > budget ${formatMiB(pressure.budgetBytes)}; the session cannot stay resident between model requests (#3918)]`
        : `[acp-proxy: compress REFUSED ${detail} — no visible context (view=0 message(s), ${mappedRefs} ref(s) mapped); refs left untouched and nothing recorded as dead — the view self-heals on the next model request (#3126)]`);
    const specKey = normalizedSpecKey(ranges);
    const repeatGuard = recordCompressFailure(ctx.session, specKey, pressure.permanent
        ? "This failure repeats until the resident pool can hold this session alongside the others — closing another open session or raising sessions.residentMaxBytes clears it; waiting for the next turn does NOT."
        : "This failure is the proxy's missing in-memory message view, not your refs — it clears on the next model request. Wait for that turn instead of re-issuing.");
    const loopGuard = opts?.loopTracking === false ? "" : noteCompressLoopFailure(ctx, specKey, undefined, "no-visible-context");
    const healClause = pressure.permanent
        ? ` THIS REFUSAL IS NOT TRANSIENT: your session's last measured memory footprint (~${formatMiB(pressure.weightBytes)}) plus the other resident sessions (~${formatMiB(pressure.otherBytes)}) exceed the resident pool budget (${formatMiB(pressure.budgetBytes)}), so every reload of this session is evicted again and no usable view survives between model requests — retrying now or after the next turn fails identically. To recover: finish or close the other open session(s), or raise sessions.residentMaxBytes in ~/.config/billion-context/billion-context.json (env twin BILI_SESSION_RESIDENT_MAX_BYTES) above ~${formatMiB((pressure.weightBytes ?? 0) + pressure.otherBytes)} and restart bili.`
        : "Do NOT retry now — every retry fails identically until the next model request re-sends the conversation and restores the view. Continue your task; after the next turn you can compress the same ranges again.";
    const receipt = `[Compression FAILED: no visible context — the proxy holds no live message view of this conversation right now (its in-memory copy was dropped between model requests, e.g. by memory eviction or a restart). Your refs are intact and NOTHING was marked dead: ${mappedRefs} ref(s) remain mapped, and this is NOT a ref problem.${healClause} [cause: no-visible-context]${repeatGuard}${loopGuard}]`;
    return compressResult(receipt, "refused", 0, "gate:no-visible-context");
}

/** #3982: evicted-session view recovery — when the effective live view is
 *  empty, restore the raw client view from the unified transcript (persisted
 *  on every save, #3911) BEFORE the no-visible-context gate above. Peek-only
 *  (a store must already exist); any unparsable row keeps the honest refusal.
 *  A non-empty live view stays authoritative — the store is never consulted
 *  for it. Shared by the plain-compress lane (applyRanges) and the external-
 *  summary lane (applyConfiguredCompression). */
export function recoverEvictedView(ctx: RewriteCtx): void {
    if ((ctx.compressMessages ?? ctx.messages).length > 0) return;
    const recovered = peekStoredTailView(ctx.session.id);
    if (recovered && recovered.length > 0) {
        ctx.compressMessages = recovered;
        ctx.log(`[acp-proxy: view recovered from the unified store — ${recovered.length} message(s); folding against the persisted raw view (#3982)]`);
    }
}

function formatMiB(bytes: number | undefined): string {
    if (bytes === undefined) return "?";
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// #2749: display-stub re-submission guard. In plugin mode the model's only
// persistent record of a folded block's summary is the ~200-char display stub
// that hideConsumedCompressCalls writes into the re-sent call args
// (kernel/src/hide-consumed.ts SUMMARY_STUB_CHARS=200 — applied on both the
// live-range rewrite path and the orphan-compact path); the full-text
// acp_summary anchor is stripped there in plugin mode (#1316). Asked to
// summarize again — tier distillation, refold — a model can "recall" only that
// fragment and submit it as if it were the full summary. minSummaryLength (50)
// accepts it and a large range then folds under the truncated record (worst
// variant: re-folding the same block silently SHRINKS its canonical summary).
// The stub set is harvested from the kernel's OWN outbound rewrite of the
// current messages rather than mirrored from constants: whatever fragments the
// model can actually see right now are exactly what gets rejected. Exact match
// only — legitimate prose (summaries containing an ellipsis, short summaries,
// ±1-char transcription drift) can never trip it.
export function visibleSummaryStubs(messages: CoreMessage[], state: CompressionState): Set<string> {
    let hidden: { messages: CoreMessage[] };
    try {
        hidden = hideConsumedCompressCalls(state, messages);
    } catch {
        return new Set();
    }
    const stubs = new Set<string>();
    for (const m of hidden.messages) {
        if (m.contentType !== "tool-call" || m.toolName !== COMPRESS_TOOL_NAME || typeof m.text !== "string") continue;
        let parsed: ReturnType<typeof parseCompressInput>;
        try {
            parsed = parseCompressInput(m.text);
        } catch {
            continue;
        }
        for (const r of parsed.ranges) {
            const s = r.summary;
            // Structural band of a kernel-emitted stub: safePrefix(·, 199) +
            // U+2026 ⇒ length 199 or 200 ending in the ellipsis. A legitimate
            // summary never targets an exact 200-char cut mid-word, so this
            // band cannot false-positive on real prose.
            if ((s.length === 199 || s.length === 200) && s.endsWith("\u2026")) stubs.add(s);
        }
    }
    return stubs;
}

export function findVisibleStubResubmissions(ctx: RewriteCtx, ranges: ParsedRange[]): Array<{ startRef: string; endRef: string }> {
    const stubs = visibleSummaryStubs(ctx.compressMessages ?? ctx.messages, ctx.session.state);
    if (stubs.size === 0) return [];
    const hits: Array<{ startRef: string; endRef: string }> = [];
    for (const r of ranges) {
        if (typeof r.summary === "string" && stubs.has(r.summary)) hits.push({ startRef: r.startRef, endRef: r.endRef });
    }
    return hits;
}

/** #4316 layer 3 PR3/3: does this compress call cite a ref that changed
 *  hands in this process's one-time ledger re-stamp? Returns a one-line
 *  explanation when at least one cited ref is superseded, null when the call
 *  is clean (or the session never re-stamped — the common case). */
export function supersededRefRejection(
    ranges: { startRef: string; endRef: string }[],
    session: Session,
): string | null {
    const superseded = session.restampSuperseded;
    if (!superseded || superseded.size === 0) return null;
    const hits: string[] = [];
    for (const range of ranges) {
        const start = refToIndex(range.startRef);
        const end = refToIndex(range.endRef);
        if (start === null || end === null) continue;
        for (let index = start; index <= end; index++) {
            const ref = indexToRef(index);
            if (superseded.has(ref)) hits.push(ref);
        }
    }
    if (hits.length === 0) return null;
    const listed = hits.slice(0, 5).join(", ");
    const more = hits.length > 5 ? ` (+${hits.length - 5} more)` : "";
    return `ref(s) ${listed}${more} were re-numbered by the ledger alignment. Call acp_status to see the current refs.`;
}

export function applyRanges(parsed: ReturnType<typeof parseCompressInput>, ctx: RewriteCtx, opts?: { loopTracking?: boolean }): ProxyToolResult {
    // #2146: preflight overflow-compress is bili's OWN internal lane — its
    // failures have separate reporting (noteSkip) and must not arm the
    // model-facing circuit breaker on attempts the model never made.
    const trackLoop = opts?.loopTracking !== false;
    const { ranges, diagnostics } = parsed;
    if (ranges.length === 0) {
        ctx.log("[acp-proxy: compress call had no valid ranges; nothing compressed.]");
        const rawReasons = diagnostics.invalidReasons ?? [];
        for (const reason of rawReasons) ctx.log(`[acp-proxy: rejected entry: ${reason}]`);
        // #1029: keep the ENTIRE failure on ONE line. buildVisibilityMarker
        // (the ❌ status line streamed to the client) keeps only line 1, so the
        // old multi-line "Rejected entries:" list reached clients as a dangling
        // header with no entries — stored in client history and re-sent forever,
        // and useless for self-correction. Inline the reasons instead (full
        // list stays logged above).
        const reasons = rawReasons.slice(0, 3).map((r) => (r.length > 160 ? safePrefix(r, 160) + "..." : r));
        const why = reasons.length > 0 ? ` Rejected entries: ${reasons.join(" | ")}.` : "";
        // #1366: a call with NO content at all ({} / "" args — an "empty companion"
        // compress() emitted alongside the real one) must never be told to
        // "re-issue": a structurally empty call fails identically every time, so
        // that advice loops until the #847 guard trips. The #362 shape-drift case
        // ({ranges: …} instead of {content: …}) stays on the format lecture below:
        // there, fixing the key CAN succeed, so re-issue IS the right advice.
        const isEmptyCall =
            rawReasons.length === 0 &&
            (diagnostics.kind === "empty-input" ||
                (diagnostics.kind === "missing-content" && !(diagnostics.keys ?? []).includes("ranges")));
        // #1502: a raw-string argument the lenient parser could not salvage
        // (malformed-json/truncated; diag.length is set only for string inputs)
        // used to arrive here pre-degraded to {} and inherit the empty-call
        // verdict above. Name the real cause — syntax corruption, not emptiness —
        // safe label: length only, no payload echo (#1454 pattern).
        const argLen = diagnostics.length;
        const argCorruption =
            !isEmptyCall &&
            argLen !== undefined &&
            (diagnostics.kind === "malformed-json" || diagnostics.kind === "truncated");
        const parseKey = `parse:${diagnostics.kind}:${diagnostics.invalidItems}:${rawReasons.slice(0, 3).join("|")}`;
        const guard = recordCompressFailure(
            ctx.session,
            parseKey,
            isEmptyCall
                ? "An empty call fails identically on every retry — drop it instead of re-issuing."
                : argCorruption
                    ? "Do not retry the same corrupt byte string — re-issue the call as one well-formed JSON object."
                    : "Fix the argument shape against the format below instead of re-issuing the same malformed call.",
        );
        const loopGuard = trackLoop ? noteCompressLoopFailure(ctx, parseKey) : "";
        if (isEmptyCall) {
            return compressResult(`[Compression FAILED: the call carried no content at all (kind=${diagnostics.kind}) — an empty compress() compresses nothing and can never succeed. Do NOT re-issue an empty call; if you meant to compress, put the non-empty 'content' array (elements {startId, endId, summary}) in that SAME single call.${guard}${loopGuard}]`, "refused", 0, `parse:${diagnostics.kind}`);
        }
        if (argCorruption) {
            const truncNote = diagnostics.kind === "truncated" ? " (looks truncated)" : "";
            return compressResult(`[Compression FAILED: the call's arguments (${argLen} chars) were not parseable JSON${truncNote} — the intended content was lost and nothing was compressed. Re-issue the compress call as well-formed JSON: a single object with a non-empty 'content' array of {startId, endId, summary} elements.${guard}${loopGuard}]`, "refused", 0, `parse:${diagnostics.kind}`);
        }
        const recovery = loopGuard === "" ? compressionRecovery(ctx) : { hint: "", canRetry: false };
        const retry = recovery.canRetry ? " Re-issue the compress call with a valid content array using those eligible refs." : "";
        return compressResult(`[Compression FAILED: no valid ranges parsed (kind=${diagnostics.kind}, dropped=${diagnostics.invalidItems}).${why} compress requires a non-empty 'content' array where each element is EITHER an object {startId, endId, summary} OR one line-form string whose first line is 'mNNNNN–mNNNNN optional topic' with the summary markdown on the following lines (a separate summary-only element right after a bare header line is also accepted). startId/endId are mNNNNN message refs from the conversation (call acp_status to see current refs).${recovery.hint}${retry}${guard}${loopGuard}]`, "refused", 0, `parse:${diagnostics.kind}`);
    }
    // #847: detect reversed refs as SUBMITTED, before #1001 normalization
    // rewrites them (order matters — normalizeRangeOrder mutates in place).
    const revs = reversedRanges(ranges);
    const swappedRanges = normalizeRangeOrder(ranges);
    if (swappedRanges > 0) {
        ctx.log(`[acp-proxy: normalized ${swappedRanges} reversed range(s) to ascending ref order (#1001)]`);
    }
    ctx.log(`[acp-proxy: compress requested ${ranges.length} range(s): ${ranges.map((r) => `${r.startRef}–${r.endRef}`).join(", ")}]`);
    ctx.log(`[acp-proxy: ctx has ${ctx.messages.length} message(s), state has ${Object.keys(ctx.session.state.messageRefs?.byRef ?? {}).length} ref(s) mapped]`);
    // #4316 PR3/3: this process re-stamped the citation space onto the ledger
    // at cold load; a resent in-flight call may still cite pre-restart numbers
    // that now belong to DIFFERENT messages. Folding those would silently
    // compress the wrong span — refuse, point at the fresh labels, let the
    // caller re-read them. Cheap and safe: refusal never mis-folds, and the
    // one-time cost disappears once the caller re-syncs.
    const supersededHit = supersededRefRejection(ranges, ctx.session);
    if (supersededHit !== null) {
        ctx.log(`[acp-proxy: refused compress citing superseded ref(s): ${supersededHit} (#4316 PR3/3)]`);
        return compressResult(`[Compression REFUSED: ${supersededHit} The refs in this call no longer identify the same messages and folding them would compress the wrong span. Re-issue the compress call with the updated labels.]`, "refused", 0, "superseded-ref");
    }
    if (ctx.messages.length > 0) {
        const ids = ctx.messages.slice(0, 10).map((m) => `${saltedMsgIdForLog(m.id)}(${(m.text ?? "").length}c)`).join(", ");
        ctx.log(`[acp-proxy: first msg ids: ${ids}]`);
    }
    recoverEvictedView(ctx);
    const noView = noVisibleContextRefusal(ctx, ranges, { loopTracking: trackLoop });
    if (noView) return noView;
    // #2749: reject summaries that are byte-identical to a display stub the
    // model can currently see (the fragments it can "recall" after the
    // full-text anchor was stripped in plugin mode). Log carries refs only —
    // never the fragment itself (business content, #1454 pattern).
    const stubHits = findVisibleStubResubmissions(ctx, ranges);
    if (stubHits.length > 0) {
        const detail = stubHits.map((h) => `${h.startRef}–${h.endRef}`).join(", ");
        ctx.log(`[acp-proxy: compress rejected — ${stubHits.length} submitted summary fragment(s) byte-identical to a currently-visible display stub (#2749): ${detail}]`);
        const specKey = `stub:${detail}`;
        const guard = recordCompressFailure(ctx.session, specKey, "Restore the content first — decompress the block(s) whose stub you copied, or search_context — then re-issue with a fresh, complete summary.");
        const loopGuard = trackLoop ? noteCompressLoopFailure(ctx, specKey) : "";
        return compressResult(`[Compression FAILED: the summary for ${detail} is byte-identical to a display stub currently visible in your history — a ~200-char truncated preview of an already-stored summary, NOT a complete summary. Accepting it would fold those ranges under a fragment and lose everything after the cut (when re-folding the same block, silently shrink its stored summary). Nothing was compressed. Do NOT re-issue the fragment: first restore what you need to summarize (decompress the source block(s), or search_context), then re-issue the compress call with a fresh, complete summary covering the range's key information.${guard}${loopGuard}]`, "refused", 0, "stub-resubmission");
    }
    try {
        const res = ctx.core.applyCompression({
            ranges,
            messages: ctx.compressMessages ?? ctx.messages,
            state: ctx.session.state,
            config: ctx.config,
        });
        const beforeIds = new Set(ctx.session.state.blocks.map((b) => b.blockId));
        const beforeSummaries = new Map(ctx.session.state.blocks.map((b) => [b.blockId, b.summary] as const));
        const r = res.result;
        // #3322: coverage-monotonicity backstop. A committed fold must never
        // leave a previously-covered message without ANY covering block: on
        // full-resend hosts the kernel's turn-integrity gate once judged splits
        // against the fold's own set instead of post-fold coverage, so ids
        // carried by consumed blocks were withdrawn wholesale — the processed
        // view doubled (253→519), the local estimate blew past the window and
        // preflight fail-fasted forever while upstream had headroom. Measure
        // active-block coverage before vs after on the clone; any loss means
        // this fold GROWS the live view, refuse it before commit (state and
        // prefix cache untouched). Healthy folds never lose coverage: fresh
        // folds add it, refolds preserve it, integrity withdrawals only touch
        // direct ids of the range being folded.
        {
            const coveredAfter = new Set<string>();
            for (const b of res.state.blocks) {
                if (!b.active) continue;
                for (const id of b.effectiveMessageIds) coveredAfter.add(id);
            }
            const lostCoverage = new Set<string>();
            for (const b of ctx.session.state.blocks) {
                if (!b.active) continue;
                for (const id of b.effectiveMessageIds) {
                    if (!coveredAfter.has(id)) lostCoverage.add(id);
                }
            }
            if (lostCoverage.size > 0) {
                const detail = ranges.map((rg) => `${rg.startRef}–${rg.endRef}`).join(", ");
                const sample = [...lostCoverage].slice(0, 5).map((id) => saltedMsgIdForLog(id)).join(", ");
                const specKey = normalizedSpecKey(ranges);
                const repeatGuard = recordCompressFailure(ctx.session, specKey);
                ctx.log(`[acp-proxy: compress REFUSED ${detail} — coverage regression: ${lostCoverage.size} previously-folded message(s) would lose ALL covering block(s) (${sample}); committing it grows the live view and can push the local estimate past the model window (#3322). State left uncommitted, prefix cache untouched.]`);
                const receipt = `[Compression refused: coverage regression — folding these ranges would leave ${lostCoverage.size} already-folded message(s) without any covering block, so the live context view would GROW instead of shrink (and the size estimate can blow past the model window, bricking the session behind permanent preflight rejections). Nothing was folded: no block was created and the context prefix/cache were left untouched. Retry with ranges aligned to whole turns (do not cut through a reasoning/tool-call/result group), target fewer blocks, or continue your task without compressing.${repeatGuard !== "" ? " " + repeatGuard : ""}]`;
                return compressResult(receipt, "refused", 0, "gate:coverage-regression");
            }
        }
        // #2748: host-side image notes append a ref-carrying footer to a new
        // block's summary AFTER the kernel's length validation — count that
        // wrapped mass in the net-benefit decision too. Moved above the commit
        // so the gate sees the real post-wrap size (identical arithmetic to the
        // old post-commit honesty note, just evaluated before the state lands).
        {
            const view = ctx.compressMessages ?? ctx.messages;
            const byRaw = res.state.messageRefs?.byRaw;
            for (const b of res.state.blocks) {
                if (beforeIds.has(b.blockId)) continue;
                const notes: string[] = [];
                for (const id of b.directMessageIds) {
                    const m = view.find((msg) => msg.id === id);
                    if (!m) continue;
                    notes.push(...imagePlaceholdersForSummary(m, byRaw?.[id]));
                }
                if (notes.length > 0) {
                    b.summary = `${b.summary}\n\n[folded images: ${notes.join(" ")} — decompress({ imageRef }) restores pixels]`;
                }
            }
        }
        // #2748: net-benefit gate runs BEFORE the commit. applyCompression
        // returns a FRESH cloned state — the assignment below is the act that
        // rewrites the context prefix and re-pays the prefix cache, so the
        // accept/reject decision must fall on the clone first. Old behavior
        // committed first and only appended a "[Net context change]" honesty
        // note afterwards, silently accepting zero/negative net folds plus the
        // unavoidable cache re-pay they force (issue #2748). Net delta per
        // touched block: new blocks remove their compressedTokens and add their
        // (wrapped) summary mass; refolds swap old summary mass for new.
        let netDelta = 0;
        let touchedBlocks = 0;
        for (const b of res.state.blocks) {
            const prev = beforeSummaries.get(b.blockId);
            if (prev === undefined) {
                touchedBlocks += 1;
                netDelta += b.compressedTokens - defaultCountTokens(b.summary);
            } else if (prev !== b.summary) {
                touchedBlocks += 1;
                netDelta += defaultCountTokens(prev) - defaultCountTokens(b.summary);
            }
        }
        if (r.blocksCreated > 0 && touchedBlocks > 0 && netDelta <= 0) {
            const detail = ranges.map((rg) => `${rg.startRef}–${rg.endRef}`).join(", ");
            const revNote = revs.length > 0
                ? ` Note: startId > endId in range(s) ${revs.map((rg) => `${rg.startRef}→${rg.endRef}`).join(", ")} — your refs were reversed and normalized to ascending order before evaluation.`
                : "";
            const netDesc = netDelta < 0
                ? `committing it would grow the context by ${-netDelta} token(s)`
                : `committing it leaves the context size unchanged`;
            // #847 repeat-guard: re-issuing the SAME bloated range escalates
            // advice; deliberately NOT fed into the #2146 circuit breaker — a
            // too-long summary is recoverable (write a shorter one), so arming
            // "stop calling compress entirely" would wrongly kill legit folds.
            const specKey = normalizedSpecKey(ranges);
            const repeatGuard = recordCompressFailure(ctx.session, specKey);
            ctx.log(`[acp-proxy: compress REFUSED ${detail} — no net shrink (net delta=${netDelta} tok across ${touchedBlocks} touched block(s)); state left uncommitted, prefix cache untouched]`);
            const receipt = `[Compression refused: no net shrink — the summary you supplied is not smaller than the range it replaces (${netDesc}). Nothing was folded: no block was created and the context prefix/cache were left untouched.${revNote} Do not re-issue this same range and summary; supply a much shorter summary for the range, target a larger span so the summary shrinks it, or continue your task without compressing.${repeatGuard !== "" ? " " + repeatGuard : ""}]`;
            return compressResult(receipt, "refused", 0, "gate:no-net-shrink");
        }
        ctx.session.state = res.state;
        // #2627 backstop: no committed state may carry outbound-only turn-
        // separator ids in coverage (a polluted child would otherwise re-
        // poison higher folds via effectiveMessageIds inheritance). Runs
        // before CCR/storeCoveredOriginals and subagent mirroring below so
        // they see clean coverage.
        {
            const scrubbed = scrubTurnSeparatorIds(ctx.session.state.blocks);
            if (scrubbed > 0) ctx.log(`[acp-proxy: scrubbed ${scrubbed} turn-separator id(s) from fold coverage (#2627)]`);
        }
        // Cache original content for newly-created blocks. At compress time the
        // source messages are still in ctx.messages (this round's view, before
        // the next processTurn folds them) — or in ctx.compressMessages when an
        // EMPTY-view fold recovered its source from the unified store (#3982);
        // collecting against [] would leave those blocks uncached for later
        // decompress/range-restore. Storing the text here lets decompress work
        // in later rounds where neither carries the originals.
        // Two views are cached so decompress can honor the `full` flag: `one`
        // (direct messages + nested child summaries) and `full` (all originals).
        // Leaf blocks have no active nested children, so both kernel paths
        // emit byte-identical text — persist a single copy in that case
        // (#401: the duplicate was 50% of blockContents bytes on disk).
        const contentSource = ctx.messages.length > 0 ? ctx.messages : (ctx.compressMessages ?? ctx.messages);
        for (const b of res.state.blocks) {
            if (beforeIds.has(b.blockId)) continue;
            const full = collectBlockContent(res.state, b, contentSource, { full: true });
            const one = collectBlockContent(res.state, b, contentSource, { full: false });
            if (full.count > 0 || one.count > 0) {
                const sameView = one.text === full.text && one.count === full.count;
                cacheBlockContent(ctx.session, b.blockId, {
                    one: sameView ? null : { text: one.text, count: one.count },
                    full: { text: full.text, count: full.count },
                });
            }
        }
        // #1179 CCR v2 (fold-time storing): the moment a fold lands, its covered
        // originals are still in hand — persist them into the content store so
        // retrieve-by-ref / range-restore work for FOLDED content, not just
        // oversized tool results stored at arrival. First-write-wins keeps
        // arrival-time entries authoritative; reasoning is skipped. Proxy mode
        // only: plugin-mode agents own their folds, so bili never sees those
        // originals.
        if (ccrEnabled(ctx.session)) {
            const newBlocks = res.state.blocks.filter((b) => !beforeIds.has(b.blockId));
            if (newBlocks.length > 0) {
                adoptContentStore(ctx.session, storeCoveredOriginals(contentStoreOf(ctx.session), ctx.compressMessages ?? ctx.messages, res.state, newBlocks.map((b) => b.blockId), defaultCountTokens));
            }
        }
        // #1995 review ④ host-side image-note footer + the #2748 net-benefit
        // gate now run ABOVE the commit (before `ctx.session.state = res.state`)
        // so a zero/negative net fold is refused before it rewrites the prefix
        // cache; `const r` is defined there too.
        const detail = ranges.map((rg) => `${rg.startRef}–${rg.endRef}`).join(", ");
        if (revs.length > 0) {
            ctx.log(`[acp-proxy: reversed range(s) in compress call: ${revs.map((rg) => `${rg.startRef}->${rg.endRef}`).join(", ")}`);
        }

        if (r.blocksCreated === 0) {
            const errs = r.errors.join("; ") || "no blocks created";
            // #2362: machine-readable failure class for the [plugin] execution
            // line — outcome=refused alone never says why in the logs.
            const gateReason = /cannot be anchored/.test(errs) ? "gate:cannot-anchor"
                : /already compressed/.test(errs) ? "gate:already-compressed"
                : /requested range\(s\) resolved/.test(errs) ? "gate:none-resolved"
                : /too small/.test(errs) ? "gate:too-small"
                : /Batch rejected before folding any range/.test(errs) ? "gate:summary-length"
                : "gate:other";
            const revNote = revs.length > 0
                ? ` Note: startId > endId in range(s) ${revs.map((rg) => `${rg.startRef}→${rg.endRef}`).join(", ")} — your refs were reversed; they were normalized to ascending order before evaluation, so check your ref order.`
                : "";
            ctx.log(`[acp-proxy: compress FAILED ${detail} → 0 blocks. ${errs}${revs.length > 0 ? " [reversed refs]" : ""}]`);
            // #1036 span hint names boundary+1..highest ("still raw") — it
            // duplicates the snapshot's lo–hi exactly when no fold covers
            // anything, so only append it when active blocks exist.
            const spanHint = compressibleSpanHint(ctx);
            // #1112: when the ENTIRE visible context is under the minimum, no
            // COMBINATION of ranges can succeed either (the kernel sums chars
            // across ranges against one threshold) — the generic "combine more
            // messages" advice sent models into acp_status/search_context
            // retry loops on fresh sessions. Append a conclusive verdict to the
            // standard failure (keeping the kernel reason + #847 reversal note
            // intact, all on one line for the client marker) so the model stops
            // inspecting state and lets the original turn continue.
            const minChars = ctx.config.compress.minCompressRange;
            const totalChars = (ctx.messages.length > 0 ? ctx.messages : (ctx.compressMessages ?? ctx.messages))
                .reduce((n, m) => n + (m.text ?? "").length, 0);
            const noViableAnywhere = minChars > 0 && totalChars < minChars
                ? ` This conversation holds only ${totalChars} char(s) — below the ${minChars}-char minimum, so NO range can succeed yet; do not retry compress or call acp_status/search_context about it — continue answering the user's task.`
                : "";
            const dropped = droppedEntriesNote(diagnostics);
            const specKey = normalizedSpecKey(ranges);
            const repeatGuard = recordCompressFailure(ctx.session, specKey);
            const loopGuard = trackLoop ? noteCompressLoopFailure(ctx, specKey, errs) : "";
            const beyond = beyondFrontierNote(ctx.session.state, ranges);
            const clamp = frontierClampNote(ctx.session.state, ranges, beyond);
            // #2146: once the breaker arms, the diagnostic hint cluster it used
            // to lead with has proven unread by the looping model — swap it for
            // the hard-stop paragraph instead of stacking more ignored advice.
            const hints = loopGuard === ""
                ? `${beyond}${clamp}${rebaseNote(ctx.session, errs, beyond)}${currentRefsSnapshot(ctx)}${repeatGuard}${spanHint}${noViableAnywhere}`
                : `${beyond}${loopGuard}`;
            // #2360 §2: one instruction per receipt — while armed, the kernel's
            // "run acp_status and retry" guidance is scrubbed from the model-
            // visible text (the breaker paragraph below forbids exactly that),
            // and the cause label names who owns the failure. The ctx.log line
            // above keeps the full kernel text for operators.
            const receiptErrs = loopGuard === "" ? errs : scrubKernelRetryGuidance(errs);
            const cause = compressFailureCause(errs, ctx.session);
            let receipt = `[Compression FAILED: ${receiptErrs}${cause ? ` [cause: ${cause}]` : ""}${revNote}${hints}${dropped ? " " + dropped : ""}${applyErrorNote(r)}]`;
            // #2146: when every requested ref is provably stale-generation, the
            // kernel's per-range error text hands those exact phantom numbers
            // straight back into the client-persisted history — where the
            // looping model reads them as unfinished work and slides further up
            // the same ladder (incident log: m29971–m30020 → m30021–m30070 → …
            // across hours). Scrub the requested endpoints from the model-
            // visible receipt so that echo channel dies; the ctx.log line above
            // keeps the real refs for the operator. Live refs are untouched:
            // when the note fires, every requested ref exceeds the session's
            // highest mapped ref, so no live snapshot number can collide.
            if (beyond !== "") {
                for (const rg of ranges) {
                    for (const id of [rg.startRef, rg.endRef]) {
                        receipt = receipt.split(id).join("[stale-ref]");
                    }
                }
            }
            return compressResult(receipt, "refused", 0, gateReason);
        }
        clearCompressFailures(ctx.session);
        clearCompressLoopStreak(ctx.session);

        // #189 observability: record the rewrite magnitude + fold point so a
        // downstream transient rejection (GLM 3007) can be correlated with it.
        // #1911: the denominator must live in the SAME space as the numerator.
        // r.tokensCompressed is a fresh kernel count over THIS request's view;
        // stats.lastInputTokens is a session scalar from the previous request's
        // usage report — stale-netted by unconsumed compress credits, clobbered
        // by concurrent streams sharing the session id, or absent after an
        // aborted turn. Mixing the two produced impossible "shrink 287%" lines
        // and postCtx≈0 artifacts that also froze the nudge baseline (#728
        // shape) and poisoned the cache ledger (#1839). Count the current view
        // with the kernel's own per-message counter instead — a same-space
        // denominator makes the ratio structurally ≤1, so #1839's
        // "trustworthy baseline" gate is subsumed and no longer needed.
        // #3307: "the current view" is the LIVE context being managed — the
        // compressed outbound (ctx.messages / processedMessages), i.e. what gets
        // billed next — NOT the client's un-shrunken resend. applyCompression
        // still runs on ctx.compressMessages (raw message boundaries, #2627) so
        // the fold geometry maps correctly; only the OBSERVABILITY denominator
        // moves. A stateless client (codex_webui) re-sends its FULL history every
        // turn, so preferring compressMessages made V ~50x the billed input and
        // read every real fold as a ~1% shrink — postCtx/ceiling and the
        // degenerate-fold gate below all distorted off the wrong basis.
        // #4227: id→tokens map over the same live view — one scan serves both meters.
        const viewMessages = ctx.messages;
        const viewTokById = new Map<string, number>();
        let viewTokens = 0;
        for (const m of viewMessages) {
            const t = countMessageTokens(m);
            viewTokById.set(m.id, t);
            viewTokens += t;
        }
        // This-fold ratio only: lastCompress, the degenerate-fold gate and the
        // staged-compress note all judge ONE rewrite, never the session (#4227).
        // #3307: keep the raw-inbound total alongside (log-only) so one capture
        // shows the view-factor collapse — V=live vs Vraw=inbound — separating it
        // from the residual chars/4-vs-BPE estimator factor without a second trip.
        let rawViewTokens = 0;
        for (const m of ctx.compressMessages ?? ctx.messages) rawViewTokens += countMessageTokens(m);
        const shrinkRatio = viewTokens > 0 ? Math.min(1, r.tokensCompressed / viewTokens) : 0;
        const foldPoint = [...ranges].sort((a, b) => refNum(a.startRef) - refNum(b.startRef))[0]?.startRef ?? "unknown";
        ctx.session.lastCompress = { at: Date.now(), shrinkRatio, foldPoint, blocks: r.blocksCreated, tokensCompressed: r.tokensCompressed };
        ctx.session.stats.pendingFoldUsage = true;
        // #695: the next request materializes this fold — its prefix-cache hit
        // ceiling ≈ anchor / postFoldContext. sys length is unknown here, so
        // anchor (active block summaries) is a LOWER bound; the fold=new
        // [acp-usage] line reports the real cached, separating physics from
        // upstream eviction.
        const anchorTok = res.state.blocks.reduce((n, b) => n + (b.active ? Math.ceil(b.summary.length / 4) : 0), 0);
        const activeBlockCount = res.state.blocks.filter((b) => b.active).length;
        // #4227: postCtx is the RENDERED post-fold context — raw view minus what
        // EVERY active block covers (union, so overlapping merged blocks count
        // once), not "raw view minus this fold". The old value ignored all
        // earlier blocks' net savings: with 86+ active blocks it read as the
        // full resend mass (#4224: postCtx≈14.5M while most of it was already
        // covered) and printed "shrink 0%" + "ceiling ≥0%" for a heavily
        // compressed session. Single-block sessions are byte-identical to the
        // old value (union == this fold); re-entering anchors stay reported
        // separately as anchor≈ below, so nothing double-counts.
        const coveredIds = new Set<string>();
        for (const b of res.state.blocks) if (b.active) for (const id of b.effectiveMessageIds) coveredIds.add(id);
        let coveredTok = 0;
        for (const id of coveredIds) {
            const t = viewTokById.get(id);
            if (t !== undefined) coveredTok += t;
        }
        const postCtx = Math.max(0, viewTokens - coveredTok);
        const cumSaved = Math.max(0, viewTokens - postCtx);
        const cumShrinkRatio = viewTokens > 0 ? Math.min(1, cumSaved / viewTokens) : 0;
        const ceiling = postCtx > 0 ? Math.floor((100 * anchorTok) / postCtx) : 0;
        ctx.log(`[acp-compress-obs] shrink ${Math.round(shrinkRatio * 100)}% this-fold (~${r.tokensCompressed}/${viewTokens} tok) · cumulative ${Math.round(cumShrinkRatio * 100)}% (~${cumSaved}/${viewTokens} tok) foldPoint=${foldPoint} blocks=${r.blocksCreated} anchor≈${anchorTok} tok (${activeBlockCount} active blocks, sys excluded) postCtx≈${postCtx} → next-request cache ceiling ≥${ceiling}%`);
        // #1911: a fold covering most of the live context is a degenerate reset —
        // legitimate as a marathon-session strategy, but it rewrites the whole
        // prefix and leaves only the anchor summaries. Hosts need a
        // machine-greppable marker to audit/penalize it (the obs line alone is
        // indistinguishable from a normal fold's).
        if (shrinkRatio >= DEGENERATE_FOLD_COVERAGE) {
            ctx.log(`[warn: degenerate-fold] [acp-compress-obs] covers ${Math.round(shrinkRatio * 100)}% of the live context (~${r.tokensCompressed}/${viewTokens} tok) leaving ${activeBlockCount} active block(s), anchor≈${anchorTok} tok — the whole prefix rewrites and the prefix cache restarts from scratch on the next request`);
        }
        // #800: feed the cache ledger — the next request's usage report will
        // attribute its re-pay cliff to these folds via decomposeSample.
        const newFoldBlocks = res.state.blocks.filter((b) => !beforeIds.has(b.blockId));
        // #3307: the ledger credits a fold only when firstFoldStartTokens=X < billed
        // input, but X is a kernel chars/4 estimate vs provider-billed input — in long
        // sessions X can land >= input and the re-pay drops unattributed. Log X plus the
        // same-space view tokens (V/Vp) so one capture separates unit-scale from view
        // identity as the inflation source.
        if (newFoldBlocks.length > 0) {
            const xs = newFoldBlocks.map((b) => (b.startRef ? `${b.startRef}=${prefixTokensBeforeRef(ctx.session, b.startRef)}` : `${b.blockId}=none`)).join(" ");
            ctx.log(`[acp-compress-obs] fold-attribution X(firstFoldStartTokens)=${xs} · V=${viewTokens} Vraw=${rawViewTokens} Vp=${postCtx} (#3307)`);
        }
        recordCacheFoldsFromBlocks(ctx.session, newFoldBlocks, { V: viewTokens, Vp: postCtx });

        const warn = r.warnings.length > 0 ? ` ${r.warnings.join("; ")}` : "";
        // #1495: apply-layer per-range errors (unknown refs, …) were invisible
        // whenever some other range in the batch succeeded — surface them on
        // the success line too, not only on total failure.
        let msg = `[Compressed ${detail} → ${r.blocksCreated} block(s), ~${r.tokensCompressed} tokens saved.${warn}${applyErrorNote(r)}]`;
        // #1718: log copy mirrors the receipt but swaps each fingerprint line
        // for its length-only form — summary excerpts must not reach bili.log.
        let logMsg = msg;
        // #2748: the net-benefit gate (and its netDelta/touchedBlocks tally)
        // moved ABOVE the commit — a zero/negative net fold is refused before
        // it rewrites the prefix cache, so any fold reaching this success path
        // genuinely shrank; no post-commit growth note is needed anymore.
        // #1494: a partial fold must not read as a clean success — surface the
        // parse-dropped entries (and log them server-side) so the model
        // re-issues the rejected range instead of believing it folded.
        // #1495: droppedEntriesNote also covers kind="truncated" salvage loss.
        const dropped = droppedEntriesNote(diagnostics);
        if (dropped !== "") {
            ctx.log(`[acp-proxy: compress PARTIAL — kind=${diagnostics.kind} ${diagnostics.invalidItems} entr(ies) rejected at parse: ${(diagnostics.invalidReasons ?? []).join(" | ")}]`);
            msg += `\n${dropped}`;
            logMsg += `\n${dropped}`;
        }
        // #1294 P1: append a fingerprint line per created/updated block —
        // kernel refolds update an existing block's summary in place (same id),
        // so "updated" means any pre-existing block whose summary changed.
        // #1702: opencode sub-agent session ids are captured mechanically at
        // this same fold commit into a metadata sidecar (structured field
        // extraction from the dispatch pairs — summary text never carries the
        // duty), and the receipt names them so the id stays model-visible.
        const changedBlocks = res.state.blocks.filter((b) => {
            const prev = beforeSummaries.get(b.blockId);
            return prev === undefined || prev !== b.summary;
        });
        syncSubagentSessions(ctx.session, changedBlocks, ctx.compressMessages ?? ctx.messages);
        const subagentMap = subagentSessionsOf(ctx.session);
        for (const b of changedBlocks) {
            msg += `\n${summaryFingerprintLine(b.blockId, b.summary)}`;
            logMsg += `\n${summaryFingerprintLogLine(b.blockId, b.summary)}`;
            const ids = subagentMap[b.blockId];
            if (ids !== undefined && ids.length > 0) {
                // block id + opaque ses_ identifier only — no summary text, so the
                // note is safe in the log copy as well (#1718 scope is excerpts).
                const note = `\n${subagentSessionNote(b.blockId, ids)}`;
                msg += note;
                logMsg += note;
            }
        }
        // #2544: the fingerprint's head/tail excerpts read as "only the ends
        // were stored", and models have answered that reading by defensively
        // decompressing freshly created blocks to recover the "missing"
        // middle. State the opposite at the moment the suspicion arises and
        // route detail retrieval through search_context first, matching the
        // kernel's "use search_context BEFORE decompressing" guidance.
        // Model-facing receipt only — the log copy carries no excerpts by
        // design (#1718), so it keeps neither the fingerprints nor this note.
        if (changedBlocks.length > 0) {
            msg += "\nFingerprints show head/tail only — every summary is stored in full. To retrieve a specific detail from a new block, call search_context({ query }) first; decompress only if the excerpt doesn't answer it.";
        }
        // #189 staged compression (gated): a rewrite above the configured max
        // shrink is the shape that trips provider risk-control; steer the model
        // toward smaller, tail-biased ranges so the prefix (m00001..foldPoint)
        // survives for prefix caching and each round's transition stays gentle.
        const maxShrink = maxShrinkPerCompress();
        if (maxShrink !== undefined && shrinkRatio > maxShrink) {
            const staged = ` [Staged-compress: this rewrite shrank context ${Math.round(shrinkRatio * 100)}%, above your ${Math.round(maxShrink * 100)}% per-compress target — the shape that trips provider risk-control (3007). Next time compress a SMALLER, TAIL-biased range (the most recent large content) and keep the stable prefix intact.]`;
            msg += staged;
            logMsg += staged;
        }
        // The fold materializes only at the NEXT request's processTurn; the
        // post-compress re-request re-sends the unfolded history (prefix-cache
        // friendly), so usage reports until then over-report. Net the savings
        // out immediately and keep them as a credit the usage recorders apply,
        // so the next nudge decision sees post-compress reality instead of
        // re-firing on the stale pre-compress number (#252 double-inject).
        ctx.session.stats.compressCreditTokens = (ctx.session.stats.compressCreditTokens ?? 0) + r.tokensCompressed;
        // #1911: deliberately NO estimate fallback here. Writing viewTokens − S
        // into lastInputTokens would leave an estimate-grade value in a
        // usage-grade field (source stays "usage") and arm kernel context-space
        // truncation differently from master — mid-history rewrites that break
        // the #1592 render contract (proven by A/B on fold-round2-shape).
        // Zero-baseline sessions are handled by the existing #728 machinery.
        ctx.session.stats.lastInputTokens = Math.max(0, ctx.session.stats.lastInputTokens - r.tokensCompressed);
        // #1387: post-compress snapshot / stop signal ride on the netted
        // (post-compress) token count, matching what the next turn sees.
        // #2404: base the "remaining ranges" on this request's pre-fold offer
        // (ctx.lastNudge) minus the submitted spans — a partial fold still shows
        // what was offered but not folded; recovery for rejected refs rides the
        // error note above (#1495/#847), not the range list.
        const tail = postCompressTail(ctx, r.errors.length === 0, ranges);
        msg += tail;
        logMsg += tail;
        ctx.log(`[acp-proxy: ${logMsg}]`);
        // #1875: blocksCreated > 0 with parse-dropped entries or per-range apply
        // errors is a PARTIAL fold — neither clean applied nor refused.
        return compressResult(msg, dropped !== "" || r.errors.length > 0 ? "partial" : "applied", r.blocksCreated);
    } catch (err) {
        ctx.log(`[acp-proxy: compress failed: ${String(err)}]`);
        const specKey = normalizedSpecKey(ranges);
        const repeatGuard = recordCompressFailure(ctx.session, specKey);
        const loopGuard = trackLoop ? noteCompressLoopFailure(ctx, specKey, String(err)) : "";
        const advice = loopGuard === "" ? `${repeatGuard}${compressibleSpanHint(ctx)}` : loopGuard;
        return compressResult(`[Compression FAILED: ${String(err)}${advice}]`, "refused", 0, "exception");
    }
}

export type JsonToolCall = { name: string; args: unknown; id?: string };

export function runJsonRewrite(steps: Generator<JsonToolCall, unknown, string>, execute: (call: JsonToolCall) => string): unknown {
    let step = steps.next();
    while (!step.done) step = steps.next(execute(step.value));
    return step.value;
}

export async function runJsonRewriteAsync(steps: Generator<JsonToolCall, unknown, string>, execute: (call: JsonToolCall) => Promise<string>): Promise<unknown> {
    let step = steps.next();
    while (!step.done) step = steps.next(await execute(step.value));
    return step.value;
}

export function rewriteJsonResponse(body: unknown, ctx: RewriteCtx): unknown {
    return runJsonRewrite(rewriteJsonSteps(body, ctx), (call) => executeAnthropicProxyTool(call.name, call.args as Record<string, unknown>, ctx).text);
}

export async function rewriteJsonResponseAsync(body: unknown, ctx: RewriteCtx, signal?: AbortSignal): Promise<unknown> {
    return runJsonRewriteAsync(rewriteJsonSteps(body, ctx), async (call) => call.name === COMPRESS_TOOL_NAME
        ? (await applyConfiguredCompression(call.args, ctx, call.id, signal)).text
        : executeAnthropicProxyTool(call.name, call.args as Record<string, unknown>, ctx).text);
}

function* rewriteJsonSteps(body: unknown, ctx: RewriteCtx): Generator<JsonToolCall, unknown, string> {
    if (!body || typeof body !== "object") return body;
    const b = body as { content?: unknown[]; stop_reason?: string };
    if (!Array.isArray(b.content)) return body;
    let converted = false;
    let sawRealToolUse = false;
    const newContent: unknown[] = [];
    for (const block of b.content) {
        const blk = block as { type?: string; name?: string; input?: unknown; id?: string };
        if (blk.type === "tool_use" && typeof blk.name === "string" && isProxyToolFor(blk.name, ctx.session, ctx.config)) {
            converted = true;
            const args = (blk.input && typeof blk.input === "object" ? blk.input : {}) as Record<string, unknown>;
            const text = yield { name: blk.name, args, id: blk.id };
            newContent.push({ type: "text", text });
        } else {
            if (blk.type === "tool_use") sawRealToolUse = true;
            newContent.push(block);
        }
    }
    b.content = newContent;
    if (converted && !sawRealToolUse) b.stop_reason = "end_turn";
    // Absorb signature in whole text (m00885): drop only when the request
    // actually instructed the model about absorb — the shape check alone
    // cannot tell an emission from a user-quoted fragment.
    const absorbArmed = effectiveAbsorbConfig(ctx.session, ctx.config)?.enabled === true;
    const requestText = JSON.stringify(ctx.messages);
    for (const blk of newContent) {
        const t = (blk as { type?: string; text?: string }).text;
        if (typeof t === "string" && (containsRenderTagText(t) || containsMarkerLineText(t) || containsBiliInternalText(t) || (absorbArmed && containsToolCallEmissionText(t)))) {
            ctx.log(`[tag-echo] stripped: non-stream model output ACP echo (render tags/markers/internal artifacts): ${t.slice(0, 120).replace(/\n/g, " ")}`);
            (blk as { text?: string }).text = stripAcpTags(t, absorbArmed, requestText);
        }
    }
    return body;
}

export type { CompressionState };
