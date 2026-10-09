import { createHash, randomBytes } from "node:crypto";
import { collectBlockContent, countMessageTokens, defaultCountTokens, formatRanges, storeCoveredOriginals, viableRanges, type CompressionCore, type Config, type CoreMessage, type CompressionState, type NudgeDecision, type CompressParseDiagnostics } from "acp-kernel";
import { handleAcpStatus } from "./acp-status.js";
import { handleAcpCache, recordCacheFoldsFromBlocks } from "./cache-ledger.js";
import { type Session, cacheBlockContent, markDirty, statusInputBaseline } from "./session.js";
import { COMPRESS_TOOL_NAME, parseCompressInput, ABSORB_TOOL_NAME, type ParsedRange } from "./compress-tool.js";
import { effectiveAbsorbConfig, executeAbsorb, isProxyToolFor } from "./absorb.js";
import { executeSearchContextTarget, resolveDecompress } from "./decompress-shared.js";
import { ONE_CALL_HINT } from "acp-kernel";
import { adoptContentStore, contentStoreOf, ccrEnabled, drainPendingRetrievals, executeRetrieve, retrieveToolName } from "./store.js";
import { IMAGE_FULL_TOOL_NAME, executeImageFull, imageCompressionEnabled } from "./image-compress.js";
import { imagePlaceholdersForSummary } from "./image-note.js";
import { containsBiliInternalText, containsMarkerLineText, containsRenderTagText, containsToolCallEmissionText, stripAcpTags } from "./loop/tag-echo-filter.js";
import { maxShrinkPerCompress } from "./fetch-util.js";
import { compressResult, toolFail, type ProxyToolResult } from "./proxy-tool-result.js";
import { attachSubagentSessions, subagentSessionNote, subagentSessionsOf, syncSubagentSessions } from "./subagent-sessions.js";
import { METADATA_DRIFT_ESCALATED } from "./fold-reconcile.js";
import { safePrefix, safeSuffix, scrubLoneSurrogates } from "./text-safe.js";
import { applyConfiguredCompression } from "./external-summary-compress.js";

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
     *  (zero-growth chained folds + prefix-cache thrash). Absent on internal
     *  lanes (preflight) → they fall back to the live recompute. */
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
    if (imageCompressionEnabled(ctx.session) && toolName === IMAGE_FULL_TOOL_NAME) {
        // Restore is passive egress behavior (the next forward re-emits the
        // cached original), so there is nothing to drain inline.
        return executeImageFull(args, ctx.session, ctx.config);
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
export function compressibleSpanHint(state: Pick<CompressionState, "messageRefs" | "blocks" | "deadRefs">): string {
    const refs = Object.keys(state.messageRefs?.byRef ?? {});
    const highest = refs.reduce((m, r) => Math.max(m, r.startsWith("m") ? Number(r.slice(1)) || 0 : 0), 0);
    const boundary = state.blocks.reduce((m, b) => (b.active && b.endRef?.startsWith("m") ? Math.max(m, Number(b.endRef.slice(1)) || 0) : m), 0);
    const fmt = (n: number) => `m${String(n).padStart(5, "0")}`;
    if (highest <= boundary) {
        const actives = state.blocks.filter((b) => b.active).map((b) => b.blockId);
        const span = actives.length >= 2 ? ` (e.g. startId ${actives[0]}, endId ${actives[actives.length - 1]})` : "";
        return ` No raw refs are directly compressible right now — compress a run of ACTIVE blocks instead${span}: fold their summaries into one higher-tier block. acp_status lists the current active blocks.`;
    }
    // #1366: blocks need not be contiguous — a gap below the highest block end
    // (e.g. m05027–m05052 between two blocks) is still compressible raw space, so
    // claiming "everything up to N is inside blocks" misleads models into skipping it.
    const covered = boundary > 0 ? ` (refs up to ${fmt(boundary)} are largely inside active blocks; isolated free gaps may still exist below it)` : "";
    // #2362: dead refs (the client history no longer carries their messages)
    // can never compress — subtract them from the advertised span so a retry
    // does not steer the model back into a doomed range (self-amplifying loop).
    const dead = new Set<number>();
    for (const r of state.deadRefs ?? []) {
        const n = Number(r.replace(/\D/g, ""));
        if (Number.isFinite(n) && n > boundary && n <= highest) dead.add(n);
    }
    const spans: string[] = [];
    let cursor = boundary + 1;
    for (const d of [...dead].sort((a, b) => a - b)) {
        if (d > cursor) spans.push(cursor === d - 1 ? fmt(cursor) : `${fmt(cursor)}–${fmt(d - 1)}`);
        cursor = d + 1;
        if (cursor > highest) break;
    }
    if (cursor <= highest) spans.push(cursor === highest ? fmt(cursor) : `${fmt(cursor)}–${fmt(highest)}`);
    if (spans.length === 0) {
        return ` No live raw refs right now: every ref between ${fmt(boundary + 1)} and ${fmt(highest)} is DEAD — the client history no longer carries those messages (host-native compaction or a bulk rewrite), so no range citing them can ever compress. Compress a run of ACTIVE blocks instead or work within your current visible context.`;
    }
    const deadNote = dead.size > 0
        ? ` Excluded as DEAD (${dead.size} ref(s) whose messages the client no longer sends — they can never compress): ${[...dead].sort((a, b) => a - b).slice(0, 4).map(fmt).join(", ")}${dead.size > 4 ? ", …" : ""}.`
        : "";
    return ` Live compressible refs: ${spans.join(", ")}${covered}. Retry NOW in this same turn with startId/endId inside that span.${deadNote}`;
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
    const advice = repeatAdvice ?? "Call acp_status first and pick from its CURRENT compressible ranges, or extend your range(s) to cover more adjacent messages.";
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
function noteCompressLoopFailure(ctx: RewriteCtx, specLabel: string, errs?: string): string {
    const now = Date.now();
    let streak = readCompressLoopStreak(ctx.session);
    if (streak && now - streak.lastAt > COMPRESS_LOOP_DECAY_MS) streak = undefined;
    const n = (streak?.n ?? 0) + 1;
    // #2432: persist the failure cause on the streak so surfaces OUTSIDE the
    // receipt (acp_status) can react to a substrate/stale-ref verdict at n=1
    // instead of waiting for the third failure to arm the breaker. A cause
    // only ever moves forward: an unknown-cause failure keeps the last known
    // verdict rather than erasing it.
    const freshCause = errs !== undefined ? compressFailureCause(errs, ctx.session) : "";
    const cause = freshCause !== "" ? freshCause : streak?.cause;
    writeCompressLoopStreak(ctx.session, { n, lastAt: now, ...(cause !== undefined ? { cause } : {}) });
    if (n < COMPRESS_LOOP_THRESHOLD) return "";
    const label = specLabel || "unparseable call";
    if (n === COMPRESS_LOOP_THRESHOLD) {
        ctx.log(`[warn: compress-loop] circuit breaker armed after ${n} consecutive compress failures (last spec: ${label}) — receipts now demand a full stop; disarms on success or ${COMPRESS_LOOP_DECAY_MS / 60000} min quiet`);
    } else {
        ctx.log(`[warn: compress-loop] failure ${n} in armed streak (last spec: ${label})`);
    }
    if (errs !== undefined && compressFailureCause(errs, ctx.session).startsWith("substrate-destruction")) {
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
    if (errs.includes("every ref is unknown to this session")) return "stale-ref — the refs belong to another session generation (or are typos)";
    if (errs.includes("covered by active block")) return "covered-by-block — nothing new to fold in that window";
    return "";
}

/** #2146: every requested endpoint sits strictly ABOVE the session's highest
 *  mapped m-ref. Such refs cannot exist in this session (refs are never
 *  pre-allocated), so the kernel's generic "typo or wrong session" wording
 *  misleads models into hunting for the typo and re-anchoring on other stale
 *  artifacts. The deterministic cause is stale-generation refs baked into the
 *  client's persisted history — name it instead. */
export function beyondFrontierNote(state: Pick<CompressionState, "messageRefs">, ranges: Array<{ startRef: string; endRef: string }>): string {
    let highest = 0;
    for (const ref of Object.keys(state.messageRefs?.byRef ?? {})) {
        const m = M_REF_NUM_RE.exec(ref);
        if (m) highest = Math.max(highest, Number(m[1]));
    }
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
    return ` · ${blockId} summary ${summary.length}ch · head "${head}" … tail "${tail}"`;
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
    // Same gates as handleAcpStatus: viability floor + the submit gate's token
    // count — never advertise a range the kernel would reject (#847).
    const minTokens = ctx.config.compress.minCompressRange;
    const submitGate = (r: CompressibleRangeItem): boolean =>
        minTokens <= 0 || r.tokens >= minTokens;
    let base: CompressibleRangeItem[];
    let tier: number | null;
    if (ctx.lastNudge) {
        // Baseline = this request's prepare-time offer (already viable-filtered
        // by the prepare step), NOT a post-fold recompute (#2404).
        base = viableRanges(ctx.lastNudge.compressibleRanges).filter(submitGate);
        tier = ctx.lastNudge.tier ?? null;
    } else {
        // Internal lanes (preflight overflow-compress) capture no prepare-time
        // nudge → fall back to the live recompute (same source as #389).
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
            });
            nudge = turn.nudge;
        } catch {
            return "";
        }
        if (!nudge) return "";
        base = viableRanges(nudge.compressibleRanges).filter(submitGate);
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
        return compressResult(`[Compression FAILED: no valid ranges parsed (kind=${diagnostics.kind}, dropped=${diagnostics.invalidItems}).${why} compress requires a non-empty 'content' array where each element is EITHER an object {startId, endId, summary} OR one line-form string whose first line is 'mNNNNN–mNNNNN optional topic' with the summary markdown on the following lines (a separate summary-only element right after a bare header line is also accepted). startId/endId are mNNNNN message refs from the conversation (call acp_status to see current refs).${compressibleSpanHint(ctx.session.state)} Re-issue the compress call with a valid content array.${guard}${loopGuard}]`, "refused", 0, `parse:${diagnostics.kind}`);
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
    if (ctx.messages.length > 0) {
        const ids = ctx.messages.slice(0, 10).map((m) => `${saltedMsgIdForLog(m.id)}(${(m.text ?? "").length}c)`).join(", ");
        ctx.log(`[acp-proxy: first msg ids: ${ids}]`);
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
        ctx.session.state = res.state;
        // Cache original content for newly-created blocks. At compress time the
        // source messages are still in ctx.messages (this round's view, before
        // the next processTurn folds them). Storing the text here lets decompress
        // work in later rounds where ctx.messages no longer carries the originals.
        // Two views are cached so decompress can honor the `full` flag: `one`
        // (direct messages + nested child summaries) and `full` (all originals).
        // Leaf blocks have no active nested children, so both kernel paths
        // emit byte-identical text — persist a single copy in that case
        // (#401: the duplicate was 50% of blockContents bytes on disk).
        for (const b of res.state.blocks) {
            if (beforeIds.has(b.blockId)) continue;
            const full = collectBlockContent(res.state, b, ctx.messages, { full: true });
            const one = collectBlockContent(res.state, b, ctx.messages, { full: false });
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
        // #1995 review ④: preflight summaries render host-side image notes with
        // refs, but a MODEL-driven fold's summary is whatever the model wrote —
        // sidecar images covered by the fold (e.g. responses tool-output
        // screenshots, which are foldable) lose their discoverability pointer.
        // Append the same ref-carrying notes as a compact footer so a later
        // turn can still find decompress({ imageRef }). Appended AFTER the
        // kernel's length validation — the footer is host bookkeeping, not
        // model output, and stays bounded (one short note per covered image).
        {
            const view = ctx.compressMessages ?? ctx.messages;
            const byRaw = ctx.session.state.messageRefs?.byRaw;
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
        const r = res.result;
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
                : "gate:other";
            const revNote = revs.length > 0
                ? ` Note: startId > endId in range(s) ${revs.map((rg) => `${rg.startRef}→${rg.endRef}`).join(", ")} — your refs were reversed; they were normalized to ascending order before evaluation, so check your ref order.`
                : "";
            ctx.log(`[acp-proxy: compress FAILED ${detail} → 0 blocks. ${errs}${revs.length > 0 ? " [reversed refs]" : ""}]`);
            // #1036 span hint names boundary+1..highest ("still raw") — it
            // duplicates the snapshot's lo–hi exactly when no fold covers
            // anything, so only append it when active blocks exist.
            const spanHint = ctx.session.state.blocks.some((b) => b.active) ? compressibleSpanHint(ctx.session.state) : "";
            // #1112: when the ENTIRE visible context is under the minimum, no
            // COMBINATION of ranges can succeed either (the kernel sums tokens
            // across ranges against one threshold) — the generic "combine more
            // messages" advice sent models into acp_status/search_context
            // retry loops on fresh sessions. Append a conclusive verdict to the
            // standard failure (keeping the kernel reason + #847 reversal note
            // intact, all on one line for the client marker) so the model stops
            // inspecting state and lets the original turn continue.
            const minTokens = ctx.config.compress.minCompressRange;
            const totalTokens = ctx.messages.reduce((n, m) => n + countMessageTokens(m), 0);
            const noViableAnywhere = minTokens > 0 && totalTokens < minTokens
                ? ` This conversation holds only ~${totalTokens} token(s) — below the ${minTokens}-token minimum, so NO range can succeed yet; do not retry compress or call acp_status/search_context about it — continue answering the user's task.`
                : "";
            const dropped = droppedEntriesNote(diagnostics);
            const specKey = normalizedSpecKey(ranges);
            const repeatGuard = recordCompressFailure(ctx.session, specKey);
            const loopGuard = trackLoop ? noteCompressLoopFailure(ctx, specKey, errs) : "";
            const beyond = beyondFrontierNote(ctx.session.state, ranges);
            // #2146: once the breaker arms, the diagnostic hint cluster it used
            // to lead with has proven unread by the looping model — swap it for
            // the hard-stop paragraph instead of stacking more ignored advice.
            const hints = loopGuard === ""
                ? `${beyond}${currentRefsSnapshot(ctx)}${repeatGuard}${spanHint}${noViableAnywhere}`
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
        const viewMessages = ctx.compressMessages ?? ctx.messages;
        let viewTokens = 0;
        for (const m of viewMessages) viewTokens += countMessageTokens(m);
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
        const postCtx = Math.max(0, viewTokens - r.tokensCompressed);
        const ceiling = postCtx > 0 ? Math.floor((100 * anchorTok) / postCtx) : 0;
        ctx.log(`[acp-compress-obs] shrink ${Math.round(shrinkRatio * 100)}% (~${r.tokensCompressed}/${viewTokens} tok) foldPoint=${foldPoint} blocks=${r.blocksCreated} anchor≈${anchorTok} tok (${activeBlockCount} active blocks, sys excluded) postCtx≈${postCtx} → next-request cache ceiling ≥${ceiling}%`);
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
        recordCacheFoldsFromBlocks(
            ctx.session,
            res.state.blocks.filter((b) => !beforeIds.has(b.blockId)),
            { V: viewTokens, Vp: postCtx },
        );

        const warn = r.warnings.length > 0 ? ` ${r.warnings.join("; ")}` : "";
        // #1495: apply-layer per-range errors (unknown refs, …) were invisible
        // whenever some other range in the batch succeeded — surface them on
        // the success line too, not only on total failure.
        let msg = `[Compressed ${detail} → ${r.blocksCreated} block(s), ~${r.tokensCompressed} tokens saved.${warn}${applyErrorNote(r)}]`;
        // #1718: log copy mirrors the receipt but swaps each fingerprint line
        // for its length-only form — summary excerpts must not reach bili.log.
        let logMsg = msg;
        // #1819: honest output — r.tokensCompressed is the REMOVED mass; the new
        // summaries re-enter the payload, so the line above can claim "saved"
        // while the fold actually grew context (weak-model regurgitation on the
        // model-driven path). Net per touched block: new blocks remove their
        // compressedTokens and add their summary mass; refolds swap old summary
        // mass for new. The base line stays intact — core.ts parses
        // `~N tokens saved` out of it — so the correction appends after it.
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
        if (touchedBlocks > 0 && netDelta <= 0) {
            const netNote = netDelta < 0
                ? `[Net context change: +${-netDelta} tokens — the new summary is larger than what it replaced; this fold grew the context instead of shrinking it.]`
                : `[No net shrink: the new summary costs about as much as what it replaced; this fold left the context size unchanged.]`;
            msg += netNote;
            logMsg += netNote;
        }
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
        return compressResult(`[Compression FAILED: ${String(err)}${recordCompressFailure(ctx.session, specKey)}${trackLoop ? noteCompressLoopFailure(ctx, specKey, String(err)) : ""}]`, "refused", 0, "exception");
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
