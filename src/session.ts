import { createInitialState, defaultConfig, highestUsedIndex, indexToRef, type CompressionState, type Config, type CoreMessage, type MessageContentStore, type NudgeDecision } from "acp-kernel";
import { createHash } from "node:crypto";
import { log as loggerLog } from "./logger.js";
import { getStore, effectiveFileStorageMode } from "./persist.js";
import { VERSION } from "./version.js";
import { maxSessions as knobMaxSessions, sessionWarmMax, sessionWarmMaxBytes, sessionResidentMaxBytes } from "./knobs.js";
import { configFileEpoch, loadConfigFile } from "./config.js";
import { applyCompressSettings, hasCompressSettings, resolveContextLimitValue } from "./compress-settings.js";
import { durableMessageToolPaths, withDurableProtection } from "./durable-message-guards.js";
import type { AnonymousProvenance } from "./anon-provenance.js";
import type { WireProtocol } from "./util.js";
import type { InboundSlot, SeamSlot } from "./cache-ledger.js";
import { isResponsesTurnSeparatorId } from "./turn-separator.js";
import type { FoldReconcileResult } from "./fold-reconcile.js";

export type BlockView = { text: string; count: number };

/** Original content of a compressed block, captured at compress time. `full`
 *  (all original messages) is always stored. `one` (one-level: direct messages
 *  + nested child summaries) is `null` when it is byte-identical to `full` —
 *  always the case for leaf blocks, since nested children are deactivated at
 *  creation and the one-level view skips inactive children — and is persisted
 *  as a single copy in that case (#401: the duplicated copy was 50% of
 *  blockContents bytes on disk). */
export type BlockContent = {
    one: BlockView | null;
    full: BlockView;
};

/** #3050 R3 ②b: block-contents map that folds away to (almost) nothing once
 *  a save has captured it, and re-materializes from the store on the first
 *  access. Idle sessions stop carrying every folded block's originals; the
 *  next touch (decompress, fork inheritance, export, or the next save's
 *  record build) pays one disk read and the full set is resident again for
 *  the rest of the burst. The loader closure is bound to the SessionStore
 *  instance that dropped the map, so multi-store processes (tests) never
 *  cross-wire directories. */
export class LazyBlockContents extends Map<string, BlockContent> {
    private readonly sessionId: string;
    private readonly sessionMeta: { protocol?: string; upstreamOrigin?: string };
    private readonly load: (id: string, meta: { protocol?: string; upstreamOrigin?: string }) => Record<string, BlockContent> | null;
    private dropped = false;

    constructor(
        sessionId: string,
        meta: { protocol?: string; upstreamOrigin?: string },
        loader: (id: string, meta: { protocol?: string; upstreamOrigin?: string }) => Record<string, BlockContent> | null,
    ) {
        super();
        this.sessionId = sessionId;
        this.sessionMeta = meta;
        this.load = loader;
    }

    /** Fold the resident contents away. No-op without a wired loader — a map
     *  that cannot be re-materialized must never drop. */
    drop(): void {
        if (this.dropped || !this.load) return;
        super.clear();
        this.dropped = true;
    }

    get isDropped(): boolean {
        return this.dropped;
    }

    private ensure(): void {
        if (!this.dropped) return;
        const record = this.load(this.sessionId, this.sessionMeta);
        if (!record) {
            // Refuse to silently become an empty map: a save iterating this
            // set would otherwise ERASE the block contents from disk.
            throw new Error(`[persist] resident block contents for ${this.sessionId} could not be re-materialized from the store — refusing the thinned view`);
        }
        for (const [id, content] of Object.entries(record)) super.set(id, content);
        this.dropped = false;
    }

    override get(key: string): BlockContent | undefined {
        this.ensure();
        return super.get(key);
    }

    override has(key: string): boolean {
        this.ensure();
        return super.has(key);
    }

    override set(key: string, value: BlockContent): this {
        this.ensure();
        return super.set(key, value);
    }

    override delete(key: string): boolean {
        this.ensure();
        return super.delete(key);
    }

    /** An explicit clear is a real clear (caller semantics), not a drop. */
    override clear(): void {
        this.dropped = false;
        super.clear();
    }

    override get size(): number {
        this.ensure();
        return super.size;
    }

    override *entries(): MapIterator<[string, BlockContent]> {
        this.ensure();
        yield* super.entries();
    }

    override *keys(): MapIterator<string> {
        this.ensure();
        yield* super.keys();
    }

    override *values(): MapIterator<BlockContent> {
        this.ensure();
        yield* super.values();
    }

    override forEach(callbackfn: (value: BlockContent, key: string, map: Map<string, BlockContent>) => void, thisArg?: unknown): void {
        this.ensure();
        super.forEach(callbackfn, thisArg);
    }

    override [Symbol.iterator](): MapIterator<[string, BlockContent]> {
        this.ensure();
        return super[Symbol.iterator]();
    }
}

/** #3050 R3 ②c: dropped lazy-metadata proxies (see lazyMetadata). */
const droppedMetadataProxies = new WeakSet<object>();

/** True when the record is a lazy metadata proxy currently folded away. */
export function isDroppedMetadata(value: unknown): boolean {
    return typeof value === "object" && value !== null && droppedMetadataProxies.has(value);
}

/** #3050 R3 ②c: a metadata record that folds away after a save captures it
 *  and re-materializes from the store on the first access — the exact shape
 *  a restart restores (parsed JSON). Transparent Proxy: no call-site
 *  changes; persistence walks it like any record and materializes the full
 *  set. An unrecoverable drop throws on access instead of ever letting a
 *  save write a thinned metadata record. */
export function lazyMetadata(
    sessionId: string,
    meta: { protocol?: string; upstreamOrigin?: string },
    loader: (id: string, meta: { protocol?: string; upstreamOrigin?: string }) => Record<string, unknown> | null,
): Record<string, unknown> {
    const target: Record<string, unknown> = {};
    let dropped = true;
    const ensure = (): void => {
        if (!dropped) return;
        const record = loader(sessionId, meta);
        if (!record) {
            throw new Error(`[persist] resident metadata for ${sessionId} could not be re-materialized from the store — refusing the thinned view`);
        }
        Object.assign(target, record);
        dropped = false;
        droppedMetadataProxies.delete(proxy);
    };
    const proxy = new Proxy(target, {
        get(t, prop, receiver) {
            ensure();
            return Reflect.get(t, prop, receiver);
        },
        has(t, prop) {
            ensure();
            return Reflect.has(t, prop);
        },
        ownKeys(t) {
            ensure();
            return Reflect.ownKeys(t);
        },
        getOwnPropertyDescriptor(t, prop) {
            ensure();
            return Reflect.getOwnPropertyDescriptor(t, prop);
        },
        set(t, prop, value, receiver) {
            ensure();
            return Reflect.set(t, prop, value, receiver);
        },
        deleteProperty(t, prop) {
            ensure();
            return Reflect.deleteProperty(t, prop);
        },
        defineProperty(t, prop, desc) {
            ensure();
            return Reflect.defineProperty(t, prop, desc);
        },
    });
    droppedMetadataProxies.add(proxy);
    return proxy;
}

/** One successful compress, recorded for #189 observability: correlating a
 *  downstream transient upstream rejection (e.g. GLM 3007 captcha) with the
 *  context rewrite that preceded it. `shrinkRatio` (#1911) is the fraction of
 *  the CURRENT request's live context removed by this compress — counted with
 *  the kernel's own per-message counter over the folded view (capped at 1),
 *  never derived from the billed usage baseline, which can be stale-netted,
 *  clobbered by concurrent streams, or absent after an aborted turn;
 *  `foldPoint` is the start ref of the earliest folded range (where the prefix
 *  structure rewrites). */
export type LastCompressInfo = {
    at: number;
    shrinkRatio: number;
    foldPoint: string;
    blocks: number;
    tokensCompressed: number;
};

/** Compact suffix for retry/error logs: the rewrite that may have triggered a
 *  transient upstream rejection. Empty when no compress has been recorded. */
export function lastCompressSuffix(info: LastCompressInfo | undefined): string {
    if (!info) return "";
    return ` [after compress: shrink ${Math.round(info.shrinkRatio * 100)}% foldPoint=${info.foldPoint} blocks=${info.blocks} ~${info.tokensCompressed}tok]`;
}

/** [#1343] Queued full-text retrieval. `injection` is the ephemeral carrier
 *  (never persisted); ref/tokens/chars/queuedAt back the durable
 *  undelivered-ledger + TTL + drop logging. Lifecycle: queued → attached →
 *  delivered | dropped (see store.ts). */
export type PendingRetrieval = {
    ref: string;
    tokens: number;
    chars: number;
    queuedAt: number;
    injection: CoreMessage;
    /** CCR acp_retrieve riders carry the delivery ledger/TTL/counters; other ephemeral carriers (e.g. range restore #1207) only ride along and are removed at the delivery outcome. */
    ccr?: boolean;
};

export type Session = {
    /** 派生缓存随会话释放，供驻留字节计量遍历；不进入持久化投影或 wire。 */
    transient?: {
        pluginMessages?: { processed: CoreMessage[]; original: CoreMessage[]; nudge?: NudgeDecision };
        sentBody?: SeamSlot;
        settledBody?: SeamSlot;
        /** #3023 (cache-ledger): the CLIENT's resent message list of the
         *  in-flight request (per-message fingerprints + role/len/class meta,
         *  never raw content), paired at settle like sentBody/settledBody so
         *  detectSeam can attribute a mid-history break to the client vs to
         *  bili's rebuild. */
        inBody?: InboundSlot;
        settledInBody?: InboundSlot;
    };
    id: string;
    /** Identity / descriptive metadata. Populated on first request. */
    meta: {
        /** Client wire protocol. Absent until the first request resolves it.
         *  Captured at first request and persisted, so the on-disk filename can
         *  be namespaced by protocol/provider (e.g.
         *  sessions/anthropic/bailian_<hash>.json) and a human can tell
         *  sessions apart at a glance. */
        protocol?: WireProtocol;
        /** Upstream origin URL this session routes to. */
        upstreamOrigin?: string;
        /** Human-readable conversation label (the affinity token), e.g.
         *  "ses_abc123" from opencode's x-session-affinity, or a client-provided
         *  id from codex's body.session_id. Pure conversation dimension — no
         *  key or upstream — so it is safe to display. Empty/undefined if the
         *  client sent none. */
        label?: string;
        /** Short human-readable title derived from the first user message
         *  (truncated). Lets the web UI show "Fix auth bug" instead of a hash.
         *  Set once on the first request that has a user message. */
        title?: string;
        /** #2322: session name set by the host itself (pi /name). Sent by the
         *  plugin over POST /__bili/plugin/session-name; latest-wins and a
         *  clear (empty) removes it. Kept separate from `title` so the four
         *  first-message derivation sites never touch it; display precedence
         *  is hostTitle || title. */
        hostTitle?: string;
        /** Effective compress prompt pack for the most recent request
         *  ("default" when none). Route/model can change it mid-session, so
         *  this is stamped per request (latest wins) — persisted so post-hoc
         *  forensics can tell which surface served the session without config
         *  archaeology. */
        activePack?: string;
        /** Resolved request prompt for external summaries, including pack sections. */
        summaryInstructions?: string;
    };
    /** Cumulative usage stats, summed across all requests. Each sample =
     *  one upstream usage report. Persisted; survives restart. */
    stats: {
        requests: number;
        /** Approximate tokens saved by compression (legacy/rough — kept for
         *  backward compat with old session files, not shown in UI). */
        tokensSaved: number;
        /** Cumulative input (prompt) tokens billed by upstream. */
        inputTokens: number;
        /** Cumulative prompt-cache-hit tokens. */
        cachedTokens: number;
        /** Cumulative output (completion) tokens. */
        outputTokens: number;
        /** Number of upstream usage samples recorded. */
        cacheSamples: number;
        /** Last upstream-reported input_tokens for THIS session (single-turn,
         *  overwritten each turn). Source of truth for tokenCount — never an
         *  estimate. See onCacheUsage in compress-loop-*.ts. */
        lastInputTokens: number;
        /** #857: provenance of lastInputTokens. "usage" = last written by an
         *  upstream usage report; "overflow-arm" = armed by an upstream
         *  context-overflow rejection — live evidence this session cannot
         *  exceed that size, bounded by the declared/stated window (#1839:
         *  overflow arming used to ride in as "usage", promoting a local
         *  estimate into the one tier trusted unconditionally); "estimate" =
         *  last RAISED by a local estimate (preflight fold write-back).
         *  Derivative adjustments (compress credits, fold reclaims) preserve
         *  the existing flag. Absent on legacy session files — evidence-grade
         *  consumers (upward window self-heal, #496 overflow-evidence gate,
         *  stale-limit retraction) treat absent as untrusted. */
        lastInputTokensSource?: "usage" | "estimate" | "overflow-arm";
        /** #3148: emergency shrink armed by a failed round with no usage report
         *  (armFailureShrink) — when + the armed local estimate. Visibility for
         *  the state that used to live only in the warn line; acp_status renders
         *  it. Cleared by the next real usage report (settleUsageReport). */
        emergencyShrinkAt?: number;
        emergencyShrinkEstimate?: number;
        /** #3148: most recent outgoing output-budget clamp event — the #2490
         *  planning-floor clamps were previously visible only in log lines.
         *  Display-only: no decision path reads it. */
        lastOutputClamp?: { raw: number; capped: number; window: number; planningInput: number; ledgerFloor: number; at: number };
        /** #1110: one-shot emergency ceiling armed by an upstream context-
         *  overflow 400 (server.ts overflow handler) — live evidence this
         *  session cannot exceed that size. Kept SEPARATE from lastInputTokens
         *  (the nudge baseline): a healthy compressed host turn keeps that
         *  baseline low, and feeding it into the side-request guard (#554)
         *  clamped an unrelated in-process caller's fixed-size request to a
         *  permanent 413. The guard reads THIS only. Cleared by the next real
         *  usage report (one-shot, per the #554 contract) and on compression
         *  reset. Absent on legacy session files → treated as no arm. */
        overflowArmTokens?: number;
        /** #3450: completion-channel reservation PROVEN by an upstream-stated
         *  overflow ("N in the completion" billed against the same wall) —
         *  preflight folds against window − reserve because the foldable
         *  quantity is MESSAGES. Set alongside the overflow arm; cleared on
         *  native-compaction reset like the arm itself. Absent/zero → no
         *  reservation (legacy behavior). */
        overflowArmCompletionReserve?: number;
        /** #3450: one-time mismatch warning already emitted for this session
         *  (upstream-stated window ≠ window in use). Provenance only. */
        overflowArmMismatchWarned?: boolean;
        /** #3450 follow-up: same completion-share proof as
         *  overflowArmCompletionReserve, on a PROVIDER lifetime — the arm retires
         *  on the next usage report (#1110), "this endpoint bills max_tokens
         *  inside the window" does not stop being true when one turn recovers.
         *  Scoped to the origin+model that stated it; read via
         *  provenCompletionReserve(). Absent/zero → no proof. */
        provenCompletionWall?: number;
        /** normalizeUpstreamOrigin() of the upstream that stated the proof. */
        provenCompletionWallOrigin?: string;
        /** Model on the rejected request that stated the proof. */
        provenCompletionWallModel?: string;
        /** #4124: per-origin learned per-prompt image-count caps, from upstream
         *  rejections ("Too many images in request: N > M"). Key =
         *  normalizeUpstreamOrigin(url) — the same origin stamping as the token
         *  overflow arm (#2313), because the cap belongs to the ROUTE, not the
         *  session. Separate from overflowArmTokens by construction: that channel
         *  rejects sub-1000 numbers and drives TOKEN-space shrink; an image cap
         *  is a count. Persisted with the session; no TTL — a stale (too low) cap
         *  can only over-shed, never under-shed. */
        imageCountCaps?: Record<string, number>;
        /** Tokens compressed THIS turn whose fold has not yet materialized in
         *  an upstream usage report (the post-compress re-request re-sends the
         *  UNFOLDED history for prefix-cache reasons, so its usage report
         *  over-reports). Usage recorders net this credit out of
         *  lastInputTokens; the next prepare() — where the fold actually
         *  happens — clears it. In-memory only. */
        compressCreditTokens: number;
        /** True from compress execution until the next upstream usage report
         *  lands — marks THE request whose prompt first materialized the fold
         *  (the one whose prefix-cache hit is expected to cliff). #695. */
        pendingFoldUsage?: boolean;
        /** Current effective in-context token count at last processTurn — for usage-grade sources this is the post-fold wire footprint (provenance in contextTokensSource), never the unfolded local history size and never cumulative billing (#2837). */
        contextTokens: number;
        /** #1839: provenance of contextTokens — "usage" = billing-grade
         *  (upstream input_tokens or an overflow arm bounded by the declared
         *  window); "estimate" = locally-derived upper bound (PFA forks,
         *  never-reporting upstreams). Display surfaces mark estimate-grade
         *  values instead of presenting them as measurements. */
        contextTokensSource?: "usage" | "estimate";
        /** #728: char-count upper bound of the LAST turn's outbound payload
         *  (post-fold processed messages + system/tools overhead + images),
         *  recorded locally in prepare* each turn. Read ONLY while
         *  lastInputTokens == 0, as the fallback tokenCount for upstreams
         *  that never report usage (ChatGPT-login-style backends — see
         *  effectiveTokenCount in server.ts). Self-correcting: a successful
         *  fold shrinks the next turn's payload and thus the estimate.
         *  Cleared by resetSessionCompression (native-compaction boundary).
         *  Persisted (survives restart like the rest of stats). */
        localInputEstimate?: number;
        /** #2117: billing-caliber estimate of the CURRENT outbound request —
         *  estimateCoreMessages + wire overhead, k̂-scaled only where the
         *  factor's route+model provenance matches (#1933 F1 / #2117 B), plus
         *  the image reserve. Written by forward() alongside the char-count
         *  upper bound above (which stays the fail-closed caliber for
         *  never-reporting upstreams, #553/#728). Display-only: no decision
         *  path reads it — preflight keeps its own per-invocation formula. */
        contextEstimateTokens?: number;
        /** #2117: whether k̂ actually scaled contextEstimateTokens (false when
         *  the factor is absent or its provenance doesn't match). */
        contextEstimateCalibrated?: boolean;
        /** #1569: last netted input value written by a REAL upstream usage
         *  report (the arming paths never touch it — they only pose as
         *  usage-grade for lastInputTokens). While > 0, effectiveTokenCount
         *  sizes nudges on the calibrated CJK-aware estimate of the CURRENT
         *  view instead of the char-count upper bound: the anchor's own
         *  billing proves the optimistic rate holds for this session's
         *  content class, while the upper bound over-counts code/JSON-heavy
         *  payloads ~3.5× and lit spurious nudge bands during estimate-grade
         *  turns. Never-reporting upstreams keep the fail-closed upper-bound
         *  behavior (#553/#728) — their anchor stays absent. Dropped with the
         *  other baseline stats at native-compaction boundaries. Absent on
         *  legacy session files → legacy path. */
        lastUsageGradeTokens?: number;
        /** #1933 F2: upstream origin (scheme://host[:port]) that measured
         *  lastInputTokens — written by settleUsageReport alongside "usage".
         *  The gate demotes a usage-grade baseline to untrusted when the
         *  CURRENT request routes elsewhere: a billing scale learned on one
         *  provider says nothing about whether another accepts the payload.
         *  Absent on legacy session files → baseline keeps legacy behavior. */
        lastInputTokensOrigin?: string;
         /** #1933 F1: calibrated scale factor k̂ = mean of up to 3 recent
          *  consistent same-route samples of (upstream-billed input ÷ local
         *  text estimate), clamped to [0.25, 4] — two-way since #2366: the
         *  correction can inflate OR deflate the estimate toward the route's
         *  real billing scale (the one-way max-1 design failed empirically on
         *  CJK-heavy routes where billing runs 2.4–4.0× above the local
         *  estimate, so under-estimating routes learned nothing). A
          *  sample is only admitted
          *  when it falls in the plausibility band [0.2, 5] — outside it the
          *  report and the payload clearly don't correspond (placeholder
          *  billing, relay echo, mock upstreams) and must not teach anything.
          *  k̂ is published only once ≥2 admitted samples agree within ×2;
          *  disagreement clears it again (fall back to the conservative raw
          *  estimate). The chars/4 estimator is a proxy, not a measurement —
          *  its ratio to real billing varies per upstream (observed 1.3–2.5×
          *  on one relay, ~1.0× on another), and max()ing it against the
          *  usage baseline let the systematically-high proxy fire preflight
          *  while the provider billed 59–63% of the window. Applied ONLY
          *  where the raw estimate currently decides (trigger, zero-range
          *  fast-forward fit, folder exit, post-fold fit); absent or
          *  route-mismatched → raw estimate (today's behavior). */
         calibratedEstimate?: number;
         /** #1933 F1: route the calibratedEstimate was learned on. A sample
          *  from a different origin starts a fresh ring instead of blending
          *  two providers' scales. */
         calibratedEstimateOrigin?: string;
         /** #2117 B: model the calibratedEstimate was learned against — the
          *  second provenance dimension. The ring and every read gate on
          *  route AND model: a mid-session model switch invalidates the old
          *  factor instead of reusing a cross-model billing scale (dangerous
          *  in either direction — a stale k̂<1 deflates → trigger too late).
          *  Absent on factors published before this field existed → reads
          *  treat it as compatible and retire it through normal rollover. */
         calibratedEstimateModel?: string;
         /** #1933 F1 / #2117 B: evidence ring behind calibratedEstimate —
          *  the recent admitted raw samples for ONE origin+model (max 3).
          *  Persisted so a restart doesn't re-arm the warmup delay; reset at
          *  native-compaction boundaries with the rest of the baseline stats. */
         calibrationRing?: { origin: string; model?: string; values: number[] };
        /** #1933 F1: pending pairing input — local estimate of the LAST
         *  prepared outbound in BILLED caliber (estimateCoreMessages +
         *  system/tools overhead + image reserve, defaultCountTokens rate;
         *  includes host-projected thinking mass since #2407),
         *  recorded in prepare*. settleUsageReport pairs it with the NEXT
         *  usage report's billed total (same request) to sample k̂, then
         *  overwrites it with the current turn's value. In-memory only — a
         *  restart simply loses one pending pair. */
        lastLocalTextEstimate?: number;
        /** #1933 F1: route of the pending lastLocalTextEstimate; the pair is
         *  only consumed when the settling report came from the same route. */
        lastLocalTextEstimateOrigin?: string;
        /** #3211: per-route k̂ calibration policy (providers[<key>].calibration)
         *  paired with the NEXT usage settle, applied at publication time; only
         *  consumed when the settling report came from the same route. In-memory
         *  only like lastLocalTextEstimate — re-resolved from config on every
         *  request, so persisting it would be stale by definition. */
        lastCalibrationPolicy?: { disabled?: boolean; max?: number };
        lastCalibrationPolicyOrigin?: string;
        /** #1097 content store: total acp_retrieve calls issued this session. */
        retrieveCalls: number;
        /** #1097: acp_retrieve calls that resolved to stored content. */
        retrieveHits: number;
        /** #1097: acp_retrieve calls that missed (unknown/hallucinated ref). */
        retrieveMisses: number;
        /** #1343: acked retrieves whose full text was DROPPED undelivered
         *  (post-drain upstream failure, disarm, TTL expiry, proxy restart). */
        retrieveDropped?: number;
        /** #1343: acked retrieves whose full text was confirmed delivered upstream. */
        retrieveDelivered?: number;
        /** #1097: cumulative bytes of unique originals held in the store. */
        storedBytes: number;
        /** #1097: cumulative wire bytes saved by placeholder substitution. */
        storeBytesSaved: number;
        /** #1179 CCR v2: range-level decompress restores served (ephemeral channel). */
        rangeRestores: number;
        /** #1336: whole-block decompress restores served. Optional — absent in
         *  pre-#1336 records. */
        wholeBlockRestores?: number;
        /** #1336: of those, how many had a cheaper precise path available at
         *  restore time (the block carried covered refs AND CCR was armed, so
         *  a range-restore / targeted retrieve would have sufficed). The
         *  ratio is the retrieve-quality proxy for plan-aware retrieval. */
        wholeBlockRestoresPreciseAvailable?: number;
    };
    /** Free-form escape hatch for future fields not yet promoted to typed
     *  members. Persisted as-is (must be JSON-serializable). Use sparingly —
     *  prefer promoting a stable field into `meta` or `stats` once it's clear. */
    metadata: Record<string, unknown>;
    state: CompressionState;
    /** #4316 layer 3 PR3/3: refs → raw ids that CHANGED HANDS in this
     *  process's one-time ledger re-stamp (cold-load alignment). Process-
     *  lifetime only — it exists precisely for the window where a resent
     *  in-flight compress call still cites pre-restart numbers; a call citing
     *  a superseded number is honestly rejected (never silently folded onto
     *  the message that now owns the number). A fresh process that never
     *  re-stamped has no map and every ref behaves normally. */
    restampSuperseded?: Map<string, string>;
    createdAt: number;
    lastSeen: number;
    /** Original content of compressed blocks, captured at compress time when
     *  the source messages are still present in the request. decompress reads
     *  from here instead of scanning ctx.messages (which only holds the
     *  post-compression / folded view and loses originals across rounds).
     *  Two views are cached — `one` (one-level: direct messages + nested
     *  child summaries) and `full` (all original messages), matching the
     *  collectBlockContent full flag semantics — but when the views are
     *  byte-identical (leaf blocks) only one copy is kept (`one: null`,
     *  #401).
     *  Unbounded in memory by design — block summaries are small relative to
     *  the history they replace, and disk persistence keeps the source of
     *  truth; the MAX_SESSIONS cap bounds the number of concurrent sessions
     *  in memory. See persist.ts. */
    blockContents: Map<string, BlockContent>;
    /** Latest full conversation snapshot, taken from the client's raw request
     *  each turn (originalMessages). The client is the source of truth and
     *  sends its complete history every request, so overwriting this per
     *  request keeps a bounded, up-to-date copy — that is what makes offline
     *  export complete. Bounded by MAX_SESSIONS, same as blockContents. */
    lastMessages?: CoreMessage[];
    /** True when lastMessages holds an already-pruned folded-view snapshot
     *  (restored from disk — #401: the persisted record stores the bounded
     *  folded view, not the raw history). Export must render it as-is instead
     *  of re-running prune() (the snapshot's message ids no longer align with
     *  the state ranges). Cleared by snapshotMessages on the next live
     *  request — the client re-sends full raw history, restoring the invariant. */
    lastMessagesFolded?: boolean;
    pluginSnapshot?: CoreMessage[];
    /** #3301: original message decompositions supplied by an external state
     *  converter (e.g. opencode-acp migration) at import time. Transient
     *  import payload: consumed once by the unified ingest (rows land in the
     *  index for fold re-anchor backfill) and never written back to records. */
    decompositionLog?: CoreMessage[];
    /** In-memory only (NOT persisted — buildRecord omits it): monotone counter
     *  bumped by markDirty after every mutation. Keys the fork-revision cache
     *  below so status polling skips re-hashing the whole history (#2017). */
    revisionEpoch?: number;
    /** In-memory only (NOT persisted): cached fork parentRevision valid for
     *  the current revisionEpoch — forkSnapshot() is a pure function of the
     *  session content, so same epoch ⇒ same hash. */
    pluginRevisionCache?: { epoch: number; revision: string };
    /** Kernel CCR envelope (#1097): originals of ID-referenced tool results,
    *  owned and mutated only by kernel processTurn (ccr-store node) via
    *  adoptContentStore. Lazily loaded from the session's content-store.json;
    *  NOT part of session.state (separate file, separate lifecycle — reset on
    *  full-state rebase). In-memory only here; buildRecord omits it. */
    contentStore?: MessageContentStore;
    /** In-memory only (NOT persisted): content-store.json is rewritten only
     *  while this is set (adopt grew entries / reset cleared the store). */
    contentStoreDirty?: boolean;
    /** #1336 in-memory only (NOT persisted — buildRecord omits it): acp_retrieve
     *  hit count per ref, used by plan-aware search steering to flag refs the
     *  model keeps re-fetching. Bounded by trimRetrieveCounts; lost on restart
     *  (advisory signal only). */
    retrieveCountsByRef?: Map<string, number>;
    /** In-memory only (NOT persisted): request-only injections riding the
     *  nudge channel. Since the GHSA jc6g v2 rework, acp_retrieve delivers its
     *  full text in the tool result itself — this carrier now only serves
     *  non-CCR riders (#1207 range restore, ccr:false). Legacy sessions from
     *  before the rework may still carry ccr:true entries; the reconcile/
     *  commit/drop machinery below handles them (they are never re-created). */
    pendingRetrievals: PendingRetrieval[];
    /** #1995 in-memory only (NOT persisted — buildRecord omits it): ref → images
     *  index built per request from the INBOUND body (default media folding
     *  archives pixels off the wire, #2640), so decompress({ imageRef }) can
     *  pull a folded image's original pixels back. Latest-wins (the client
     *  re-sends full history every turn, so each request's index is complete;
     *  count_tokens requests carry no usable protocol view and clear it).
     *  Values
     *  hold only metadata + the on-disk path (bytes are spilled at index-time and
     *  never retained), so residency stays O(refs) regardless of image volume. */
    incomingImageIndex?: Map<string, Array<{ mediaType: string; bytes: number; width?: number; height?: number; path: string }>>;
    /** #1995 in-memory only: timestamp of the last best-effort
     *  pruneRetrieveImgExports sweep for this session (throttled to once a
     *  minute in the request path). */
    lastImgPrune?: number;
     /** Number of in-flight requests using this session. A session with
     *  inFlight > 0 must NOT be LRU-evicted: evicting it mid-stream flushes a
     *  half-mutated snapshot and then a miss reloads a SECOND Session object,
     *  causing split-brain writes to the same file. See persist.ts M5. */
    inFlight: number;
    /** False until the first successful write to disk. evictOldest will not
     *  drop a never-persisted session on flush failure (that would be a
     *  permanent loss). */
    persisted: boolean;
    /** In-memory only (NOT persisted — buildRecord omits it): true while the
     *  session was restored from disk and has seen no request in THIS process
     *  (#404). Restored sessions carry their on-disk savedAt as lastSeen (not
     *  Date.now()), so consumers can tell boot-restore staleness from real
     * activity; fallback=latest skips restored sessions rather than guessing
     * among a readdir-order tie. Cleared on the first real request touch. */
    restored?: boolean;
    /** In-memory only (NOT persisted — buildRecord omits it): timestamp of
     *  the last MODEL REQUEST that touched this session in THIS process
     *  (#4661). Stamped by the request pipeline only — tool calls and
     *  disk-reload paths must never refresh it, so it stays honest evidence
     *  of live traffic for stale-binding diagnosis (a statically-bound MCP
     *  shim querying a quiet session while another session receives model
     *  requests). Undefined until the first request of this process. */
    lastModelRequestAt?: number;
    /** In-memory only (NOT persisted): one-shot set by persist's load (#1343).
     *  getSession() clears `restored` on the first request touch, but
     *  reconcileReloadedRetrievals runs LATER in that same request — so it
     *  keys off this flag, which survives until the reconcile (or a full
     *  reset) has actually run. */
    ccrReconcilePending?: boolean;
    /** In-memory only (NOT persisted — buildRecord omits it): the most recent
     *  successful compress, set by applyRanges and read by the replay/preflight
     *  retry callbacks to correlate a transient upstream rejection with the
     *  rewrite that preceded it (#189). A fresh process has none. */
    lastCompress?: LastCompressInfo;
    /** Promise chain for per-session serialization. Two concurrent requests
     *  sharing a session id would interleave processTurn / stream-rewriter
     *  mutations on session.state, corrupting it. withSessionLock chains each
     *  critical section onto the previous one so they run strictly in order. */
    lockChain?: Promise<unknown>;
};

/** Server-stamped anonymous-prefix-affinity record (#1115/#1486 lane, written
 *  in src/server.ts when an anonymous request resolves onto a pfa-* chain or
 *  mints a fresh one). Typed here so readers don't cast the Record bag. */
type AnonymousPrefixAffinityStamp = {
    depth: number;
    tailHash: string;
    via: "prefix" | "new";
    lineage?: { parents: string[]; reason: "truncated" | "forked"; sharedPrefix?: number };
    /** #2879: first-writer provenance of the mint request (see anon-provenance.ts). */
    producer?: AnonymousProvenance;
};

// #833: wire paths resolve the kernel Config per request (global → provider →
// model compress settings + self-heal + output headroom), while the plugin
// status/tool API reads sessions with no request context and was falling back
// to the base kernelConfig — which carries NO file/provider/model compress
// settings — so the panel Nudge line showed kernel defaults regardless of user
// config. Same pattern as absorb.ts's effectiveAbsorb: stamp the last resolved
// Config per session (latest wins), read it with fallback to the base.
// #2584: the stamp must stay CLONE-SAFE — fork-adoption structuredClones
// metadata.effectiveConfig (plugin.ts) and disk persistence JSON-serializes
// it; a function value throws at the clone site (DataCloneError → 503
// FORK_FAILED). Function fields are re-resolved at read time: effectiveConfig()
// merges over the base kernelConfig, which carries them again (isToolProtected
// #2578; isMessageProtected re-resolves from the lane id below).
export function storeEffectiveConfig(session: Session, config: Config): void {
    const cloneSafe: Record<string, unknown> = { ...config };
    for (const key of Object.keys(cloneSafe)) {
        if (typeof cloneSafe[key] === "function") delete cloneSafe[key];
    }
    session.metadata["effectiveConfig"] = cloneSafe;
    // #2960⑥: identity of the config source this snapshot was resolved from.
    // effectiveConfig() refuses the snapshot when the source has moved on
    // (file edited, different BILI_CONFIG_FILE lane) — see the reader below.
    session.metadata["effectiveConfigEpoch"] = configFileEpoch();
}

/** True when the session's effectiveConfig stamp was resolved from a config
 *  source that no longer matches the live file (file edited since the last
 *  wire request, or a different lane's file whose content diverged — the
 *  epoch is a content hash, so byte-identical files validate across
 *  instances). Stamps without an epoch predate the guard and keep the legacy
 *  behavior (stamp wins). */
function staleEffectiveStamp(session: Session | undefined): boolean {
    const stamped = session?.metadata?.["effectiveConfigEpoch"];
    return typeof stamped === "string" && stamped !== configFileEpoch();
}

/** Re-resolve the FILE tier of the config (compress.* incl. externalSummary at
 *  the global level) onto `base` from the live file. Used when a stale stamp is
 *  refused: the fallback (`deps.config` / opts.kernelConfig) is a bare default
 *  Config without file settings, so returning it naked would drop every file
 *  knob between the edit and the session's next wire request. Provider/model
 *  cascade levels need the request URL and are deliberately NOT re-resolved
 *  here — the next wire request re-stamps the full cascade. */
function liveFileOverlayConfig(base: Config): Config {
    const compress = loadConfigFile().compress;
    if (!compress || !hasCompressSettings(compress)) return base;
    const limit = resolveContextLimitValue(compress.modelContextLimit, base.modelContextLimit);
    return applyCompressSettings(base, limit, compress, {});
}

export function effectiveConfig(session: Session | undefined, fallback: Config): Config {
    const stored = session?.metadata["effectiveConfig"];
    // #2960⑥ stale-stamp guard: the snapshot was resolved from a config source
    // that has since changed (edited file / foreign lane). Serving it would
    // execute retired settings — the October externalSummary incident ran a
    // user-disabled summary chain for days off one such stamp. Refuse the
    // snapshot and resolve the live file tier onto the fallback instead.
    if (staleEffectiveStamp(session)) {
        const live = liveFileOverlayConfig(fallback);
        const lane = typeof session?.metadata["pluginAgent"] === "string" ? session.metadata["pluginAgent"] : undefined;
        const classifier = lane ? durableMessageToolPaths[lane] : undefined;
        return classifier && !live.messagePathOf ? withDurableProtection(live, classifier) : live;
    }
    const base = stored && typeof stored === "object" ? { ...fallback, ...(stored as Partial<Config>) } : fallback;
    // #2446 follow-up (CI regression): the per-lane durable classifier is a
    // FUNCTION and must never be persisted into session.metadata — fork-adoption
    // structuredClones metadata.effectiveConfig (plugin.ts) and disk persistence
    // cannot serialize a function. The lane id is already clone-safe here, so
    // re-resolve the classifier AND the default `durable/*` policy from it at
    // read time; every consumer (plugin tool, nudge panel) then sees the same
    // protection the wire path used this turn.
    const lane = typeof session?.metadata["pluginAgent"] === "string" ? session.metadata["pluginAgent"] : undefined;
    const classifier = lane ? durableMessageToolPaths[lane] : undefined;
    return classifier && !base.messagePathOf ? withDurableProtection(base, classifier) : base;
}

// #4383: a positive usage-grade anchor below this share of the billing-caliber
// estimate of the last main send (contextEstimateTokens) cannot describe the
// payload this conversation actually carries — it measured a different,
// smaller request under the same session id (title-gen/probe sidecar) or
// predates a growth burst. 0.25 sits just inside the estimator's own error
// band (uncalibrated chars/4 over-counts ASCII up to ~3.5× ⇒ a legitimate
// same-payload sample lands ≈0.29× the estimate and survives; sidecar samples
// are typically <10% and get caught), matching the k̂ clamp floor (0.25–4).
const STALE_ANCHOR_RATIO = 0.25;

/** #4383: stale-small usage-anchor guard shared by every input-baseline reader
 *  (statusInputBaseline, effectiveTokenCount). Returns the replacement reading
 *  — the calibrated local estimate itself (#1595's promised "ride local
 *  estimates until a usage-grade sample lands" fallback) — when BOTH hold:
 *   - `anchor` is below STALE_ANCHOR_RATIO × `stats.contextEstimateTokens`
 *     (magnitude-inconsistent with what this conversation actually sends);
 *   - `contextTokensSource === "estimate"`, i.e. a MAIN SEND has occurred
 *     since the last settled usage report (the relay chokepoint stamps it per
 *     send, settleUsageReport flips it back to "usage"). That freshness gate
 *     is what separates a STALE sidecar sample (superseded by later larger
 *     main sends) from a FRESH small one (the current send's own report,
 *     which keeps its #1820 authority over the post-rebuild anchor).
 *  One-directional by design: anchors ABOVE the estimate keep their #1839
 *  precedence (fail-closed direction); only too-small poison is demoted.
 *  Absent/non-positive estimate (legacy sessions, no main send yet) → null,
 *  byte-identical legacy behavior. */
export function staleSmallAnchorFallback(
    stats: Pick<Session["stats"], "contextEstimateTokens" | "contextTokensSource">,
    anchor: number,
): number | null {
    const est = stats.contextEstimateTokens;
    return stats.contextTokensSource === "estimate"
        && anchor > 0 && typeof est === "number" && Number.isFinite(est) && est > 0 && anchor < STALE_ANCHOR_RATIO * est
        ? est
        : null;
}

/** #2029: provenance-aware baseline for STATUS readers — acp_status nudge
 *  recompute, plugin live nudge + panel, post-compress tail. Shared by every
 *  status surface so none of them can present an estimate-grade reading as a
 *  measurement.
 *
 * The main request path already refuses estimate-grade failure baselines
 * (#1839/#1846, effectiveTokenCount), but the status readers kept passing raw
 * stats.lastInputTokens into processTurn: a no-usage failure or preflight
 * write-back could raise it to an estimate-grade phantom and the status
 * surfaces reported false emergency pressure while the request path stayed
 * anchored on real usage (#2029 repro: 60k real / 174k estimate → 116% in the
 * panel for a 150k window).
 *
 * Contract (mirrors effectiveTokenCount's provenance priority): source
 * "usage" or bounded "overflow-arm" → lastInputTokens verbatim, including 0
 * after credit adjustments drained it; otherwise (estimate-grade, or legacy
 * sessions restored without a source flag) → the retained real usage anchor
 * (lastUsageGradeTokens, #1569); no positive anchor → 0, the kernel's unknown
 * sentinel. Never clamps: a REAL over-window usage report must still read
 * >100%. The JSON observation contract (contextTokens/contextTokensSource,
 * #2017) is deliberately separate — it expresses unknown explicitly rather
 * than as 0. On top of that, BOTH #4383 guards apply: cycle-stale
 * (usageAnchorCycleStale — see its header below) and stale-small
 * (staleSmallAnchorFallback — an anchor below 25% of the billing-caliber
 * local estimate AND superseded by a later main send measured a different
 * request under the same session id). */
/** #4383: a usage-grade anchor is CYCLE-STALE when the freshest per-send
 *  evidence postdates the last settle: the relay send chokepoint re-stamps
 *  contextTokens/contextTokensSource="estimate" on every main-lane send
 *  (noteOutboundContextEstimates, cache-ledger.ts) and only a real usage
 *  settle flips them back to "usage" (settleUsageReport). At decision time
 *  (prepare runs before this cycle's send) contextTokensSource ===
 *  "estimate" therefore proves the last completed cycle ended WITHOUT a
 *  usage report — the anchor may be arbitrarily old (#4383: anchor frozen at
 *  4733 while the outbound grew past 300K; nudge idle 154 consecutive turns,
 *  zero folds over four hours). Requires a live per-send estimate, else there
 *  is nothing fresher to ride and the anchor remains the last real
 *  measurement. overflow-arm never qualifies: the arm is itself a per-send
 *  measurement, window-bounded (#1839). */
export function usageAnchorCycleStale(stats: Session["stats"]): boolean {
    if (stats.lastInputTokensSource !== "usage" || stats.contextTokensSource !== "estimate") return false;
    return (stats.localInputEstimate ?? 0) > 0;
}

export function statusInputBaseline(session: Session): number {
    const stats = session.stats;
    if (usageAnchorCycleStale(stats)) return stats.localInputEstimate ?? 0;
    const baseline = stats.lastInputTokensSource === "usage" || stats.lastInputTokensSource === "overflow-arm"
        ? stats.lastInputTokens
        : stats.lastUsageGradeTokens ?? 0;
    return staleSmallAnchorFallback(stats, baseline) ?? baseline;
}

/** #2117: the honest best reading of "how full is this context right now" for
 *  DISPLAY surfaces, picked by provenance — never mixes calibers on one bar:
 *   usage     — last upstream-measured input (billing grade); wins whenever present.
 *   estimate  — the billing-caliber estimate of the CURRENT outbound request
 *               (contextEstimateTokens, k̂-scaled where its route+model
 *               provenance matches), shown only while a usage-grade anchor
 *               exists: a never-reporting upstream has no evidence that the
 *               optimistic rate holds, so it keeps the fail-closed upper bound
 *               (#553/#728 discipline).
 *   upper     — char-count upper bound of the last send: never undershoots,
 *               but over-counts ASCII-heavy payloads up to ~3.5× — a BOUND,
 *               not a reading; over-window here does NOT mean actually
 *               over-window.
 * Legacy sessions without contextEstimateTokens fall through to upper —
 * exactly today's display. Read-only; decision paths are untouched. */
export interface ContextBest {
    tokens: number;
    kind: "usage" | "estimate" | "upper";
    /** true when kind=="estimate" and k̂ actually scaled the value. */
    calibrated?: boolean;
    /** wall-clock of the underlying measurement (usage reports stamp it). */
    at?: number;
}

// #2117 x #1937: minimal structural param — web list rows build from bounded
// summary sources (sessions-data.ts) that carry no full Session object.
export function displayContextBest(session: {
    stats: Pick<Session["stats"], "contextTokens" | "contextTokensSource" | "lastUsageGradeTokens" | "lastInputTokensSource" | "contextEstimateTokens" | "contextEstimateCalibrated">;
    metadata?: Record<string, unknown>;
}): ContextBest | null {
    const st = session.stats;
    if (st.contextTokensSource === "usage" && st.contextTokens > 0) {
        const at = typeof session.metadata?.contextTokensAt === "number" ? session.metadata.contextTokensAt : undefined;
        return { tokens: st.contextTokens, kind: "usage", ...(at !== undefined ? { at } : {}) };
    }
    const anchored = (st.lastUsageGradeTokens ?? 0) > 0 || st.lastInputTokensSource === "usage";
    if (anchored && typeof st.contextEstimateTokens === "number" && st.contextEstimateTokens > 0) {
        return { tokens: st.contextEstimateTokens, kind: "estimate", ...(st.contextEstimateCalibrated ? { calibrated: true } : {}) };
    }
    if (st.contextTokens > 0) return { tokens: st.contextTokens, kind: "upper" };
    return null;
}

/** #1595 (retired by #3674): the host-side nudge re-anchor used to retire a
 *  stale-high kernel reference when a usage-grade sample landed a full growth
 *  interval below it. The kernel's references are now LOW-WATER marks — both
 *  lastPerMessageNudgeTokens and lastNudgeShownTokens ride down with every
 *  observed sample — so the kernel self-corrects on the next reading at any
 *  grade, and this host mirror is strictly subsumed. The #1595 regression
 *  scenario (estimate-grade overshoot pinning the shown reference) lives on
 *  as a kernel test. */

/** #1595: name the third no-usage shape — an upstream SUCCESS that completes
 *  without reporting input usage. Transport failures and upstream 5xx already
 *  log their own armFailureShrink arms; this one used to be silent, so a
 *  session could sit on stale values with nothing in the log explaining why.
 *  Callers gate the preconditions (clean terminal / parsed body + no input
 *  sample accumulated); this handles the once-per-session throttle. */
export function diagnoseSuccessWithoutUsage(session: Session, wire: string): void {
    // Partial-session literals (test fixtures) may lack the metadata bag —
    // nothing to throttle against, so skip rather than crash.
    if (!session.metadata) return;
    if (session.metadata["warnedNoUsage"]) return;
    session.metadata["warnedNoUsage"] = true;
    markDirty(session);
    loggerLog("warn", `[${session.id}] [${wire}] upstream success without usage report — keeping lastInputTokens=${session.stats.lastInputTokens} (source=${session.stats.lastInputTokensSource ?? "none"}); nudge decisions ride local estimates until a usage-grade sample lands (#1595)`);
}

// #1820: post-rebuild meter anchor. Right after a big preflight rebuild the
// usage-grade baseline is momentarily absent (the rebuild request's own report
// hasn't landed yet, or the upstream never reports one), so effectiveTokenCount
// falls through to branches that size on the INCOMING RAW history — the very
// mass the rebuild just folded away — inflating the meter ~3.4× (char-count
// upper bound) and firing a phantom EMERGENCY nudge into an already-at-window
// context. The rebuilt payload's measured size (the same quantity the preflight
// fit gate checked) is stamped here and consumed by the meter for a bounded
// number of prepares: a real usage-grade sample supersedes it immediately
// (settleUsageReport clears it), and when no sample ever comes the counter
// runs out and legacy sizing resumes instead of freezing the meter.
const POST_REBUILD_ANCHOR_PREPARES = 3;

export function setPostRebuildAnchor(session: Session, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    session.metadata["postRebuildAnchor"] = { tokens, remainingPrepares: POST_REBUILD_ANCHOR_PREPARES };
    markDirty(session);
}

/** Metadata is persisted user-editable JSON — re-validate on read; a corrupt
 *  stamp degrades to "no anchor" (legacy sizing) instead of poisoning the meter. */
export function postRebuildAnchorTokens(session: Session | undefined): number {
    const a = session?.metadata?.["postRebuildAnchor"];
    if (!a || typeof a !== "object") return 0;
    const t = (a as Record<string, unknown>).tokens;
    return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : 0;
}

/** One prepare consumed. The last one deletes the anchor so never-reporting
 *  upstreams fall back to legacy per-turn sizing. */
export function tickPostRebuildAnchor(session: Session): void {
    const a = session.metadata?.["postRebuildAnchor"];
    if (!a || typeof a !== "object") return;
    const o = a as Record<string, unknown>;
    const rem = typeof o.remainingPrepares === "number" ? o.remainingPrepares - 1 : 0;
    if (rem <= 0) delete session.metadata["postRebuildAnchor"];
    else o.remainingPrepares = rem;
    markDirty(session);
}

export function clearPostRebuildAnchor(session: Session): void {
    if (session.metadata?.["postRebuildAnchor"] === undefined) return;
    delete session.metadata["postRebuildAnchor"];
    markDirty(session);
}

const sessions = new Map<string, Session>();

let MAX_SESSIONS = knobMaxSessions();
let MAX_RESIDENT_BYTES = sessionResidentMaxBytes();
const residentWeights = new WeakMap<Session, { revision: number; bytes: number }>();

// #3918: last-known LIVE weight of evicted sessions, stamped at eviction time.
// The live weight (transient message caches included) is only measurable while
// the object is resident — a disk reload carries persisted state alone and
// under-measures by exactly the mass that made the eviction necessary. The map
// is advisory (it only shapes refusal wording), never load-bearing; bounded so
// a long-lived process cannot accumulate unbounded entries.
const evictedWeights = new Map<string, number>();
const EVICTED_WEIGHT_CAP = 256;

function stampEvictedWeight(id: string, bytes: number): void {
    if (evictedWeights.has(id)) evictedWeights.delete(id);
    evictedWeights.set(id, bytes);
    while (evictedWeights.size > EVICTED_WEIGHT_CAP) {
        const oldest = evictedWeights.keys().next().value;
        if (oldest === undefined) break;
        evictedWeights.delete(oldest);
    }
}

/** Estimate retained objects without serializing a second giant copy. Include
 * originals and last-message caches; counting files alone misses both. */
function deepSizeOf(value: unknown): number {
    const seen = new WeakSet<object>();
    const size = (v: unknown): number => {
        if (typeof v === "string") return 32 + v.length * 2;
        if (!v || typeof v !== "object") return 8;
        if (seen.has(v)) return 0;
        seen.add(v);
        if (Buffer.isBuffer(v)) return 64 + v.byteLength;
        if (v instanceof LazyBlockContents && v.isDropped) return 64; // #3050 R3 ②b: folded away — measuring must not re-materialize it
        if (droppedMetadataProxies.has(v)) return 64; // #3050 R3 ②c: same for folded metadata records
        let bytes = 64;
        if (v instanceof Map) {
            for (const [key, item] of v) bytes += size(key) + size(item) + 32;
        } else if (v instanceof Set) {
            for (const item of v) bytes += size(item) + 16;
        } else if (Array.isArray(v)) {
            for (const item of v) bytes += size(item) + 8;
        } else {
            for (const key of Object.keys(v)) bytes += size(key) + size((v as Record<string, unknown>)[key]) + 16;
        }
        return bytes;
    };
    return size(value);
}

function sessionWeight(session: Session): number {
    const revision = session.revisionEpoch ?? 0;
    const cached = residentWeights.get(session);
    if (cached?.revision === revision) return cached.bytes;
    const bytes = deepSizeOf(session);
    residentWeights.set(session, { revision, bytes });
    return bytes;
}

/** Per-field resident bytes for one session (#R3 diagnostics). The `total` leg
 * reuses the revision-cached sessionWeight; the per-field legs walk fresh on
 * every call (diagnostics only — never hot). Shared substructure between
 * fields may double-count across the fresh walkers; `other` absorbs the
 * remainder clamped at 0, so columns sum to `total` while fields stay disjoint. */
export interface ResidentFieldBreakdown {
    lastMessages: number;
    pluginSnapshot: number;
    blockContents: number;
    contentStore: number;
    state: number;
    metadata: number;
    other: number;
    total: number;
}

export function residentBreakdown(session: Session): ResidentFieldBreakdown {
    const total = sessionWeight(session);
    const lastMessages = session.lastMessages ? deepSizeOf(session.lastMessages) : 0;
    const pluginSnapshot = session.pluginSnapshot ? deepSizeOf(session.pluginSnapshot) : 0;
    const blockContents = deepSizeOf(session.blockContents);
    const contentStore = session.contentStore ? deepSizeOf(session.contentStore) : 0;
    const state = deepSizeOf(session.state);
    const metadata = deepSizeOf(session.metadata);
    const other = Math.max(0, total - lastMessages - pluginSnapshot - blockContents - contentStore - state - metadata);
    return { lastMessages, pluginSnapshot, blockContents, contentStore, state, metadata, other, total };
}

/** Whole-pool memory report for the /__bili/memory diagnostics endpoint:
 * budget vs resident totals, per-field sums, and the heaviest sessions.
 * Read-only snapshot — safe to call at any time. */
export interface MemoryReport {
    pool: { sessions: number; maxSessions: number; residentBytes: number; budgetBytes: number };
    breakdown: ResidentFieldBreakdown;
    sessions: Array<{ id: string; inFlight: number; lastSeen: number; revision: number; fields: ResidentFieldBreakdown }>;
}

export function memoryReport(): MemoryReport {
    const rows: MemoryReport["sessions"] = [];
    const sums: ResidentFieldBreakdown = { lastMessages: 0, pluginSnapshot: 0, blockContents: 0, contentStore: 0, state: 0, metadata: 0, other: 0, total: 0 };
    for (const session of sessions.values()) {
        const fields = residentBreakdown(session);
        sums.lastMessages += fields.lastMessages;
        sums.pluginSnapshot += fields.pluginSnapshot;
        sums.blockContents += fields.blockContents;
        sums.metadata += fields.metadata;
        sums.contentStore += fields.contentStore;
        sums.state += fields.state;
        sums.other += fields.other;
        sums.total += fields.total;
        rows.push({ id: session.id, inFlight: session.inFlight, lastSeen: session.lastSeen, revision: session.revisionEpoch ?? 0, fields });
    }
    rows.sort((a, b) => b.fields.total - a.fields.total);
    return {
        pool: { sessions: sessions.size, maxSessions: MAX_SESSIONS, residentBytes: residentBytes(), budgetBytes: MAX_RESIDENT_BYTES },
        breakdown: sums,
        sessions: rows,
    };
}

function residentBytes(): number {
    let bytes = 0;
    for (const session of sessions.values()) bytes += sessionWeight(session);
    return bytes;
}

/** #3918: can this session's message view survive BETWEEN model requests? The
 * empty-view compress refusal (#3126) self-heals on the next model request ONLY
 * when the reloaded session stays resident afterwards. When the session's
 * last-known live weight plus the other residents exceeds the byte budget,
 * every request cycle ends with it evicted again (releaseInFlight discharge)
 * and the refusal repeats identically forever — the incident's 444 MiB image
 * session ping-ponged against an 87.5 MiB peer under the 512 MiB default.
 * Returns the measured pressure so the refusal receipt says so plainly instead
 * of promising a heal that will not come. */
interface ResidentPressure {
    /** True when retrying cannot restore a usable view under the CURRENT pool state. */
    permanent: boolean;
    /** Last-known LIVE weight of this session (eviction-time measurement; falls
     * back to its resident weight when it is resident now). Undefined = unknown. */
    weightBytes?: number;
    /** Resident bytes held by all OTHER sessions (this one excluded). */
    otherBytes: number;
    residentBytes: number;
    budgetBytes: number;
}

export function residentPressure(id: string): ResidentPressure {
    const resident = sessions.get(id);
    const self = resident ? sessionWeight(resident) : 0;
    const total = residentBytes();
    const known = evictedWeights.get(id);
    const weightBytes = known !== undefined ? Math.max(known, self) : resident ? self : undefined;
    return {
        permanent: weightBytes !== undefined && weightBytes + (total - self) > MAX_RESIDENT_BYTES,
        weightBytes,
        otherBytes: total - self,
        residentBytes: total,
        budgetBytes: MAX_RESIDENT_BYTES,
    };
}

function makeResidentRoom(incoming = 0): void {
    while (sessions.size >= MAX_SESSIONS || (sessions.size > 0 && residentBytes() + incoming > MAX_RESIDENT_BYTES)) {
        if (!evictOldest()) {
            // The byte budget limits the idle cache, not active workload.
            // Refusing every new conversation while a large request is pinned
            // turns ordinary concurrent use into a proxy outage. The count
            // limit remains a hard admission bound.
            if (sessions.size < MAX_SESSIONS) break;
            const reason = [...sessions.values()].every(session => session.inFlight > 0)
                ? "all in-flight" : "active requests or failed saves prevent safe eviction";
            throw new Error(`session pool exhausted (MAX_SESSIONS=${MAX_SESSIONS}; ${reason})`);
        }
    }
}

let initialized = false;

/** Index persisted history before listening and warm a small bounded cache.
 * Older live and archived sessions reload on demand. Idempotent. */
export async function initSessions(): Promise<void> {
    if (initialized) return;
    initialized = true;
    const store = getStore();
    if (!store.enabled) return;
    const loaded = await store.boot({ maxSessions: Math.min(MAX_SESSIONS, sessionWarmMax()), maxBytes: sessionWarmMaxBytes() });
    for (const [id, s] of loaded) sessions.set(id, s);
}

/** Zero-valued stats for a fresh session (#1991) — exported so test fixtures
 *  can build sessions without retyping every field. */
export function zeroStats(): Session["stats"] {
    return { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, retrieveDropped: 0, retrieveDelivered: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 };
}

export function getSession(id: string, meta?: { protocol?: Session["meta"]["protocol"]; upstreamOrigin?: string; label?: string }): Session {
    const existing = sessions.get(id);
    if (existing) {
        existing.lastSeen = Date.now();
        existing.restored = false;
        // Fill in protocol/upstream/label meta on an existing session if the caller
        // now knows it (e.g. a session was created by loadAll without meta).
        if (meta?.protocol && !existing.meta.protocol) existing.meta.protocol = meta.protocol;
        if (meta?.upstreamOrigin && !existing.meta.upstreamOrigin) existing.meta.upstreamOrigin = meta.upstreamOrigin;
        if (meta?.label && !existing.meta.label) existing.meta.label = meta.label;
        return existing;
    }
    // Memory miss: try reload from disk (e.g. after LRU eviction).
    const store = getStore();
    makeResidentRoom();
    const reloaded = store.loadSync(id, meta);
    if (reloaded) {
        // A memory-miss reload is triggered by a real request: stamp fresh
        // activity, not the restored-from-disk state (#404).
        reloaded.lastSeen = Date.now();
        reloaded.restored = false;
        reloaded.persisted = true;
        // A memory-miss reload puts a NEW resident entry back into the pool; the
        // new-session cap guard below is unreachable on this path, so enforce it
        // here or evict-then-revisit grows the pool past MAX_SESSIONS (#1064).
        makeResidentRoom(sessionWeight(reloaded));
        sessions.set(id, reloaded);
        return reloaded;
    }
    if (sessions.size >= MAX_SESSIONS) {
        const evicted = evictOldest();
        if (!evicted) {
            throw new Error(`session pool exhausted (MAX_SESSIONS=${MAX_SESSIONS}; all in-flight)`);
        }
    }
    const session = createSession(id, meta);
    makeResidentRoom(sessionWeight(session));
    sessions.set(id, session);
    return session;
}

export function createSession(id: string, meta?: Session["meta"]): Session {
    return {
        id,
        meta: { protocol: meta?.protocol, upstreamOrigin: meta?.upstreamOrigin, label: meta?.label },
        stats: zeroStats(),
        // #3093: stamp provenance on the LIVE object too — the web detail panel
        // reads live sessions directly; buildRecord re-stamps the same values on save.
        metadata: { biliVersion: VERSION, storageMode: effectiveFileStorageMode() },
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

export function publishForkSession(session: Session): void {
    if (sessions.has(session.id) || getStore().loadSync(session.id)) throw new Error("child session already exists");
    makeResidentRoom(sessionWeight(session));
    if (!getStore().flushSync(session)) throw new Error("fork persistence failed");
    session.persisted = getStore().enabled;
    sessions.set(session.id, session);
}

/** Mark a session as in-use by a request. Must be paired with releaseInFlight.
 *  Prevents LRU eviction of a session mid-stream. */
export function acquireInFlight(session: Session): void {
    session.inFlight++;
}

/** Release an in-use marker. Decrements; the session becomes evictable again. */
export function releaseInFlight(session: Session): void {
    if (session.inFlight > 0) session.inFlight--;
    residentWeights.delete(session);
    // Active sessions are pinned. Once a request finishes, discharge its
    // growth before admitting more historical sessions into the cache.
    while (residentBytes() > MAX_RESIDENT_BYTES && evictOldest()) { /* bounded cache */ }
}

/** Total in-flight requests across all sessions (sum of per-session
 *  counters). The self-restart gate (#811) requires this to be zero. */
export function totalInFlight(): number {
    let n = 0;
    for (const s of sessions.values()) n += s.inFlight;
    return n;
}

/** Serialize a critical section per session. Each call chains onto the
 *  previous lockChain, so concurrent requests for the same session execute
 *  strictly one-at-a-time. This prevents two processTurn / stream-rewriter
 *  invocations from interleaving mutations on session.state.
 *
 *  For single-agent workflows (the common case) there is no contention and
 *  the chain resolves immediately. The cost is one Promise allocation. */
export async function withSessionLock<T>(session: Session, fn: () => T | Promise<T>): Promise<T> {
    const prev = session.lockChain ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    session.lockChain = prev.then(() => done);
    await prev;
    try {
        return await fn();
    } finally {
        release();
    }
}

export function listSessions(): Session[] {
    return [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

// #2170 measure 4 (runtime canary): the #2165 failure shape — one dsh
// conversation's traffic split across BOTH the raw id and a `|sub:` fork,
// both live at once (the raw session steals the compressions / anchor while
// the fork carries the real turns). Surface any such split on /__bili/status
// so an operator sees it without digging through logs.
//
// Design splits are excluded: sessions namespaced onto `|sub:` ON PURPOSE —
// #970 claude subagent conversations and #1916/#1307/#1314 dsh persona-fork
// reviews — carry session.metadata.personaNamespace = true (stamped at
// request time in server.ts) and never count toward a warning; without this
// every active Auto-tier dsh conversation (review fork beside main turns)
// would cry wolf. What remains actionable: ≥2 fresh sessions on one base
// where ≥1 carried traffic (requests>0) and ≥1 is an UNMARKED `|sub:` child.
// The #2165 report itself was "empty raw twin + live fork", so a traffic-less
// raw twin does NOT disqualify a warning — only the stale (>freshness window)
// and the fully idle (nothing ever carried traffic) groups stay silent.
interface SplitSessionWarning {
    base: string;
    sessions: { id: string; requests: number; lastSeen: number }[];
}
export const SPLIT_CANARY_FRESH_MS = 10 * 60 * 1000;
export function splitSessionWarnings(sessions: Session[], now: number = Date.now()): SplitSessionWarning[] {
    const byBase = new Map<string, Session[]>();
    for (const s of sessions) {
        if (s.metadata?.personaNamespace === true) continue; // designed split (#970/#1916)
        const base = s.id.split("|sub:")[0];
        const arr = byBase.get(base);
        if (arr) arr.push(s); else byBase.set(base, [s]);
    }
    const out: SplitSessionWarning[] = [];
    for (const [base, group] of byBase) {
        if (group.length < 2) continue;
        const fresh = group.filter((s) => now - (s.lastSeen ?? 0) < SPLIT_CANARY_FRESH_MS);
        const anyTraffic = fresh.some((s) => (s.stats?.requests ?? 0) > 0);
        const anyChild = fresh.some((s) => s.id.includes("|sub:"));
        if (fresh.length >= 2 && anyTraffic && anyChild) {
            out.push({ base, sessions: fresh.map((s) => ({ id: s.id, requests: s.stats?.requests ?? 0, lastSeen: s.lastSeen ?? 0 })) });
        }
    }
    return out;
}

/** Read-only in-memory lookup. Unlike getSession, never creates or reloads a
 *  session — used by the plugin tool API, which must not conjure state for a
 *  conversation it has never seen. */
export function peekSession(id: string): Session | undefined {
    return sessions.get(id);
}

// #1086: does THIS instance hold processed compression state for the given
// conversation? Memory first, then the persisted record (covers the
// auto-update restart: memory is gone, disk state survives). A bili instance
// only ever creates a session record when it PROCESSED the request, so
// "record exists" ⇒ "the ACP artifacts this client re-sends are ours" — the
// exemption the chain-detection content fallback needs before passing a
// request through verbatim. Read-only: never mutates the session map.
export function hasProcessedState(id: string, meta?: { protocol?: string }): boolean {
    const mem = sessions.get(id);
    if (mem) return processedEvidence(mem);
    const store = getStore();
    if (!store.enabled) return false;
    const reloaded = store.loadSync(id, meta);
    return reloaded !== null && processedEvidence(reloaded);
}

function processedEvidence(s: Session): boolean {
    return s.stats.requests > 0 || s.state.nextBlockId > 1 || s.blockContents.size > 0;
}

/** #1082 GC: remove a session from the in-memory map so its debounced writer
 *  cannot resurrect the file GC just deleted. Caller must have verified the
 *  session is idle (no in-flight requests, no pending save, lastSeen not newer
 *  than the on-disk record). Returns false when absent or busy. */
export function dropSessionForGc(id: string): boolean {
    const s = sessions.get(id);
    if (!s || s.inFlight > 0) return false;
    sessions.delete(id);
    return true;
}

// #760b: unified canonical session id. Every session exposes a stable pfa-* id
// that MCP tools route by, independent of what the client calls itself.
// Anonymous sessions already ARE pfa-* (PFA-minted session.id), so their
// canonical id is session.id itself. Legacy (client-id) sessions derive a
// stable pfa-* from their session id — deterministic, so the value survives even
// if the persisted copy is lost. It is materialized onto metadata.canonicalId
// (persisted) on first use so lookups are cheap and the value is inspectable.
function derivedLegacyCanonicalId(sessionId: string): string {
    return `pfa-${createHash("sha256").update(`legacy:${sessionId}`).digest("hex").slice(0, 16)}`;
}

/** Pure: the session's canonical id (always pfa-*). Never mutates. */
function canonicalIdOf(session: Session): string {
    if (session.id.startsWith("pfa-")) return session.id;
    const c = session.metadata.canonicalId;
    if (typeof c === "string" && c.length > 0) return c;
    return derivedLegacyCanonicalId(session.id);
}

/** Materialize + persist the session's canonical id (idempotent) and return it.
 *  Called where the id is surfaced to the model (wire notes) so the exact value
 *  shown is the one persisted and routable. Anonymous sessions are a no-op
 *  (canonical id already equals session.id). */
export function ensureCanonicalId(session: Session): string {
    const id = canonicalIdOf(session);
    if (!session.id.startsWith("pfa-") && session.metadata.canonicalId !== id) {
        session.metadata.canonicalId = id;
        markDirty(session);
    }
    return id;
}

/** Read-only reverse lookup: the resident session whose canonical id matches.
 *  Scans the in-memory pool (≤ MAX_SESSIONS); always consistent with the live
 *  session set — no separate index to desync on evict/load. */
export function findSessionByCanonicalId(canonicalId: string): Session | undefined {
    for (const s of sessions.values()) {
        if (canonicalIdOf(s) === canonicalId) return s;
    }
    return undefined;
}

/** Overwrite the session's full-conversation snapshot with the latest client
 *  raw request messages (originalMessages from prepare*). One array per
 *  session, replaced every request — bounded, always the newest state. Empty
 *  arrays (parse failures) never clobber a good snapshot. */
export function snapshotMessages(session: Session, messages: CoreMessage[]): void {
    if (messages.length > 0) {
        session.lastMessages = messages;
        session.lastMessagesFolded = false;
        delete session.metadata.handoffResponse;
    }
}

/** Mark a session's state as changed so it is persisted on the next debounce.
 *  Call this after any mutation (processTurn, compress, decompress, orphan GC). */
export function markDirty(session: Session): void {
    session.revisionEpoch = (session.revisionEpoch ?? 0) + 1;
    getStore().scheduleSave(session);
}

/** Record original block content at compress time. */
export function cacheBlockContent(session: Session, blockId: string, content: BlockContent): void {
    session.blockContents.set(blockId, content);
}

export function resetSessionCompression(session: Session): void {
    session.state = createInitialState();
    session.blockContents.clear();
    // The kernel contract ties the store to the state ('host resets the store
    // with the state'): a full rebase restarts refs at m00001, so old entries
    // would misattribute under reused numbers. contentStoreDirty + markDirty
    // deletes the on-disk envelope on the next save.
    session.contentStore = undefined;
    session.contentStoreDirty = true;
    // #1343: rebase wipes both the queued injections and their acks (context
    // rebuilt), so clear the durable ledger too — otherwise a later
    // reconcileReloadedRetrievals would misattribute this expected loss as a
    // proxy-restart drop.
    session.pendingRetrievals.length = 0;
    delete session.metadata.ccrUndelivered;
    delete session.metadata.ccrDropNotes;
    session.ccrReconcilePending = false;
    session.stats.lastInputTokens = 0;
    // #857: a zeroed baseline carries no provenance — drop any stale flag.
    delete session.stats.lastInputTokensSource;
    // #1110: the conversation was rebuilt — a pre-compaction overflow arm no
    // longer bounds this session; drop it so the guard falls back to the
    // declared window instead of clamping to a stale ceiling.
    delete session.stats.overflowArmTokens;
    // #3450: same boundary — the proven completion reservation described the
    // pre-compaction payload lineage, and the rebuilt conversation re-arms the
    // one-time mismatch warning.
    delete session.stats.overflowArmCompletionReserve;
    delete session.stats.overflowArmMismatchWarned;
    // #728: the pre-compaction outbound payload is gone — the old estimate
    // (measured against the pre-compaction wire) would read high and blind
    // the nudge fallback early; let the next prepare* re-measure.
    session.stats.localInputEstimate = 0;
    // #1569: pre-compaction billing evidence describes a payload lineage that
    // no longer exists — fall back to legacy sizing until a fresh report lands.
    delete session.stats.lastUsageGradeTokens;
    // #1933: same rationale for the calibration pair and its provenance — k̂ was
    // learned against the pre-compaction content class, and the baseline's
    // measuring route no longer bounds this rebuilt session.
    delete session.stats.lastInputTokensOrigin;
    delete session.stats.calibratedEstimate;
    delete session.stats.calibratedEstimateOrigin;
    // #2117 B: same boundary — the factor's model provenance dies with it.
    delete session.stats.calibratedEstimateModel;
    delete session.stats.calibrationRing;
    delete session.stats.lastLocalTextEstimate;
    delete session.stats.lastLocalTextEstimateOrigin;
    delete session.stats.lastCalibrationPolicy;
    delete session.stats.lastCalibrationPolicyOrigin;
    // #2117: the per-send estimate describes the pre-compaction payload too —
    // let the next forward re-measure instead of displaying a stale reading.
    delete session.stats.contextEstimateTokens;
    delete session.stats.contextEstimateCalibrated;
    // #1820: same lineage argument — the anchored rebuilt payload is gone too.
    delete session.metadata.postRebuildAnchor;
    session.stats.contextTokens = 0;
    delete session.stats.contextTokensSource;
    session.metadata.nativeCompactionAt = Date.now();
    markDirty(session);
}

export function markNativeCompactionBoundary(session: Session): void {
    session.metadata.nativeCompactionBoundary = {
        at: Date.now(),
        pendingRebase: true,
    };
    markDirty(session);
}

export function reconcileNativeCompactionBoundary(session: Session): boolean {
    const boundary = session.metadata.nativeCompactionBoundary;
    if (!boundary || typeof boundary !== "object" || !(boundary as Record<string, unknown>).pendingRebase) {
        return false;
    }
    // #2592/F5: capture the pre-rebase ref high-water mark before the reset
    // wipes the map, and pin it back after — the compacted resend starts a
    // fresh counter at m00001, and a ref the model still remembers from the
    // pre-compaction generation must never be re-allocated onto different
    // raw content (silent misattribution; refs are never reused within a
    // session, same pin as applyCompactionArchive / fork adoption).
    const highestBefore = highestUsedIndex(session.state.messageRefs);
    resetSessionCompression(session);
    if (highestBefore > 0 && reserveRefsThrough(session, highestBefore)) {
        markDirty(session);
    }
    session.metadata.nativeCompactionBoundary = {
        ...(boundary as Record<string, unknown>),
        pendingRebase: false,
        rebasedAt: Date.now(),
    };
    markDirty(session);
    return true;
}

/** Mark a client-side native compaction (omp /compact on the anthropic wire).
 *  The sid does NOT rotate on in-session compaction, so the per-sid registry
 *  reuses the same key with stale state. Consumed by the NEXT processTurn via
 *  applyCompactionArchive (#395). Distinct from nativeCompactionBoundary
 *  (Responses/codex, which rebases by resetting state). */
export function markCompactionBoundary(session: Session): void {
    session.metadata.compactionBoundary = {
        at: Date.now(),
        pending: true,
    };
    markDirty(session);
}

type PreCompactionArchive = Record<string, { at: number; reason: string }>;

function readPreCompactionArchive(session: Session): PreCompactionArchive {
    const raw = session.metadata.preCompactionArchive;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return raw as PreCompactionArchive;
    }
    return {};
}

export function preCompactionArchiveOf(session: Session): PreCompactionArchive {
    return readPreCompactionArchive(session);
}

// Must run AFTER the processTurn that followed markCompactionBoundary (so
// syncBlocks has deactivated the blocks whose raw ids left the shortened
// history). Blocks active in `activeBefore` but inactive now are archived;
// byRaw/byRef are pruned to liveRawIds (stops the #390 additive leak).
// nextIndex is left alone so a freed ref slot is never re-allocated onto a
// retained tail's live tag.
/** Synthetic byRaw key pinning a session's ref high-water mark. Its value is
 *  the highest ref this session must never re-allocate (refs the parent used
 *  before a fork/resume, or numbers freed by an archive prune); the kernel
 *  cursor (highestUsedIndex+1) then starts above it. Never a real message id
 *  (those are SHA-256 hex), so it matches no incoming message and has no
 *  byRef entry. */
export const REF_FLOOR_RAW_ID = "bili:ref-floor";

/** Raise `session`'s ref floor to at least `index` (no-op when its map
 *  already reaches that high). */
export function reserveRefsThrough(session: Session, index: number): boolean {
    if (index <= highestUsedIndex(session.state.messageRefs)) return false;
    session.state.messageRefs.byRaw[REF_FLOOR_RAW_ID] = indexToRef(index);
    return true;
}

export function applyCompactionArchive(
    session: Session,
    activeBefore: Set<string>,
    liveRawIds: Set<string>,
    log: (level: string, msg: string) => void,
): void {
    const boundary = session.metadata.compactionBoundary;
    if (!boundary || typeof boundary !== "object" || !(boundary as Record<string, unknown>).pending) {
        return;
    }
    const activeAfter = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
    const deactivated = [...activeBefore].filter((id) => !activeAfter.has(id));
    if (deactivated.length > 0) {
        const archive = readPreCompactionArchive(session);
        const at = Date.now();
        for (const id of deactivated) {
            archive[id] = { at, reason: "content replaced by client native compaction summary" };
        }
        session.metadata.preCompactionArchive = archive;
    }

    const { byRaw, byRef } = session.state.messageRefs;
    // #4131: name what the prune costs — ref(s) about to be dropped that still
    // sit under some block's coverage, so silent coverage loss is auditable.
    const droppedIds = new Set(Object.keys(byRaw).filter((id) => id !== REF_FLOOR_RAW_ID && !liveRawIds.has(id)));
    let coverageNote = "";
    if (droppedIds.size > 0) {
        const affectedBlocks = session.state.blocks.filter((b) => (b.effectiveMessageIds ?? []).some((id) => droppedIds.has(id))).map((b) => b.blockId);
        coverageNote = `; ${droppedIds.size} ref(s) dropped${affectedBlocks.length > 0 ? `, covering block(s) ${affectedBlocks.join(", ")}` : ""}`;
    }
    pruneRefsToLiveIds(session, liveRawIds, byRaw, byRef);

    session.metadata.compactionBoundary = {
        ...(boundary as Record<string, unknown>),
        pending: false,
        archivedAt: Date.now(),
        archivedBlocks: deactivated,
    };
    markDirty(session);
    log("info", `[${session.id}] native compaction boundary: archived ${deactivated.length} pre-compaction block(s)${deactivated.length > 0 ? ` (${deactivated.join(", ")})` : ""}; pruned ref maps to ${liveRawIds.size} live raw id(s)${coverageNote}`);
}

/** Prune the ref maps to `liveRawIds` in place (same maps, not new objects:
 *  session.state stays the object the kernel pipeline mutates). The kernel's
 *  ref cursor is highestUsedIndex+1, so pruning the top of the map would hand
 *  the freed numbers out again — the old high-water mark is re-pinned via
 *  REF_FLOOR_RAW_ID (refs are never reused within a session, Kernel
 *  Contract). Shared by the announced archive path (#395) and the zombie
 *  reap (#2695). */
function pruneRefsToLiveIds(
    session: Session,
    liveRawIds: Set<string>,
    byRaw: Record<string, string>,
    byRef: Record<string, string>,
): void {
    const highestBefore = highestUsedIndex(session.state.messageRefs);
    const prunedByRaw: Record<string, string> = {};
    for (const [rawId, ref] of Object.entries(byRaw)) {
        if (liveRawIds.has(rawId)) prunedByRaw[rawId] = ref;
    }
    if (highestBefore > highestUsedIndex({ byRaw: prunedByRaw, byRef: {} })) prunedByRaw[REF_FLOOR_RAW_ID] = indexToRef(highestBefore);
    const prunedByRef: Record<string, string> = {};
    const droppedRefs: string[] = [];
    for (const [ref, rawId] of Object.entries(byRef)) {
        if (liveRawIds.has(rawId)) prunedByRef[ref] = rawId;
        else droppedRefs.push(ref);
    }
    session.state.messageRefs.byRaw = prunedByRaw;
    session.state.messageRefs.byRef = prunedByRef;
    if (droppedRefs.length > 0) {
        // #3302: tombstone the freed numbers so the kernel classifies a later
        // citation as dead (snap-to-neighbor / honest "content gone") instead
        // of unknown ("typo or wrong session") — the mislabel that sent models
        // probing upward for a valid number after every native-compaction
        // prune. I6 invariant: deadRefs stays unique and numerically sorted
        // ascending; empty ⇒ undefined.
        const merged = new Set(session.state.deadRefs ?? []);
        for (const ref of droppedRefs) merged.add(ref);
        const sorted = [...merged].sort((a, b) => Number(a.replace(/^m/, "")) - Number(b.replace(/^m/, "")));
        session.state.deadRefs = sorted.length > 0 ? sorted : undefined;
    }
}

/** #2695: remove fold blocks whose covered substrate the client demonstrably
 *  destroyed — a strict majority of each block's covered ids absent from the
 *  resent history for several consecutive passes (streak tracked in
 *  src/fold-reconcile.ts, METADATA_FOLD_COVERAGE.z). REMOVAL, not
 *  deactivation: syncBlocks re-activates every non-consumed, non-expanded
 *  block whose id set still intersects the wire (kernel/src/sync.ts sets
 *  active=true before the stillPresent check), and duplicate-content
 *  re-derivation keeps exactly that intersection alive forever — the zombie
 *  carrier that renders (and flaps) every turn (#2695). Removing the block
 *  from state.blocks is sticky: sync/prune/anchors all iterate state.blocks.
 *  blockContents are kept, so the derived-decompress fallback can still
 *  restore the summary text; the block is recorded in the #395 pre-compaction
 *  archive (direct decompress fails loudly with the archive reason); refs are
 *  pruned to live ids with the same high-water pin as applyCompactionArchive. */
export function reapDestroyedSubstrate(
    session: Session,
    blockIds: ReadonlySet<string>,
    liveRawIds: Set<string>,
    log: (level: string, msg: string) => void,
): string[] {
    if (blockIds.size === 0 || session.state.blocks.length === 0) return [];
    const present = new Set(session.state.blocks.map((b) => b.blockId));
    const reaped = [...blockIds].filter((id) => present.has(id));
    if (reaped.length === 0) return [];
    session.state.blocks = session.state.blocks.filter((b) => !blockIds.has(b.blockId));
    const archive = readPreCompactionArchive(session);
    const at = Date.now();
    for (const id of reaped) {
        archive[id] = { at, reason: "covered substrate destroyed by unannounced client history rewrite (#2695)" };
    }
    session.metadata.preCompactionArchive = archive;
    pruneRefsToLiveIds(session, liveRawIds, session.state.messageRefs.byRaw, session.state.messageRefs.byRef);
    markDirty(session);
    log("info", `[${session.id}] zombie fold reap: removed ${reaped.length} block(s) (${reaped.join(", ")}) from ACP state; blockContents retained, refs pruned to live ids (#2695)`);
    return reaped;
}

// #1001: clients rewrite session history SILENTLY mid-session (opencode native
// compaction on model switch) with no /compact request for the announced-
// boundary machinery to key off — mixed-generation ref maps then persist.
// TIMING INVARIANT: callers must capture knownRefsBefore BEFORE processTurn —
// post-turn every incoming id has a fresh ref and the ratio is always 1.0.
// Append-only turns keep the ratio near 1.0; a rewrite collapses it. The gate
// on prior compression history keeps fresh sessions / first replays out.
const REWRITE_MIN_KNOWN_REFS = 20;
const REWRITE_MAX_KNOWN_RATIO = 0.5;
// #1075: clients stamp auxiliary side-requests (Claude Code WebSearch query
// refinement, title generation, …) with the SAME session id but carry only a
// handful of brand-new messages — 0/N < 0.5 trips the ratio gate, and the
// archive+prune that follows wipes the whole ref map, so the next
// full-history replay burns N fresh refs per side-request until m99999
// exhausts. A genuine rewrite of a mature conversation never arrives as a
// near-empty payload, and always shares at least one message id with the
// prior history (clients keep a tail through compaction), so require both
// before treating the shrink as real. Missing a genuine rewrite is cheap
// (stale map entries linger until session end); a false positive is fatal.
// The ratio is also required on the PRIOR side (known ids that survived /
// known ids before): a turn that keeps all of the prior history but appends
// a lot of new material (a resume that inherited only an old ancestor's refs,
// a large batch of tool results) dilutes the incoming-side ratio without
// rewriting anything — a rewrite is when most of the old history is gone.
export const REWRITE_MIN_INCOMING_TOTAL = 10;

interface RewriteDetection {
    detected: boolean;
    knownBefore: number;
    incomingTotal: number;
    knownIncoming: number;
    /** #4131: the ratio collapse was explained by this pass's fold-reconcile
     *  finding EVERY covered id on the wire (present or re-anchored, zero
     *  unmatched) — bili's own sanctioned id churn across builds (#3642 D1),
     *  not a client rewrite. The destructive boundary is suppressed and
     *  callers record an adoption event instead of marking one. */
    churnExplained: boolean;
}

export function detectUnannouncedHistoryRewrite(
    session: Session,
    knownRefsBefore: ReadonlySet<string>,
    liveRawIds: Iterable<string>,
    reconcile?: Pick<FoldReconcileResult, "kind" | "unmatched"> | null,
): RewriteDetection {
    const knownBefore = knownRefsBefore.size - (knownRefsBefore.has(REF_FLOOR_RAW_ID) ? 1 : 0);
    let incomingTotal = 0;
    let knownIncoming = 0;
    for (const id of liveRawIds) {
        incomingTotal++;
        if (knownRefsBefore.has(id)) knownIncoming++;
    }
    const rawDetected =
        knownBefore >= REWRITE_MIN_KNOWN_REFS &&
        session.state.blocks.length > 0 &&
        incomingTotal >= REWRITE_MIN_INCOMING_TOTAL &&
        knownIncoming > 0 &&
        knownIncoming / incomingTotal < REWRITE_MAX_KNOWN_RATIO &&
        knownIncoming / knownBefore < REWRITE_MAX_KNOWN_RATIO;
    // #4131: order-centric doctrine — no single dimension may veto the
    // multi-evidence verdict. When this pass's fold-reconcile found EVERY
    // covered id on the wire (kind reanchored/resend, unmatched === 0), the
    // hash-identity collapse is explained churn: bili's own cross-build id
    // re-mint (#3642 D1 accepted exactly this once-per-upgrade mass churn,
    // promising the reconcile ladder would absorb it). Marking the destructive
    // compaction boundary here instead tombstones hundreds of still-cited
    // refs (#4131 incident). Off/noop verdicts (reconcile disabled, side-request
    // skip) carry no evidence either way → legacy behavior unchanged; partial
    // claims (unmatched > 0) keep the legacy escalation path.
    const churnExplained = rawDetected
        && reconcile !== undefined && reconcile !== null
        && (reconcile.kind === "reanchored" || reconcile.kind === "resend")
        && reconcile.unmatched === 0;
    return { detected: rawDetected && !churnExplained, knownBefore, incomingTotal, knownIncoming, churnExplained };
}

/** #1195: message ids are content hashes — if a client resends history whose
 *  bytes changed (resume/re-serialization, edit, duplicate-cluster shift), the
 *  ids of compressed-range messages no longer match the block's covered set,
 *  and those messages silently re-enter the wire unfolded even though the
 *  compress result already reported them as saved. Returns how many of the
 *  covered ids are present in the resent history, or null when coverage is
 *  complete (or nothing was covered). */
interface FoldCoverage {
    expected: number;
    matched: number;
}

export function foldCoverage(
    coveredBefore: ReadonlySet<string>,
    liveRawIds: Iterable<string>,
): FoldCoverage | null {
    if (coveredBefore.size === 0) return null;
    const incoming = new Set(liveRawIds);
    let matched = 0;
    for (const id of coveredBefore) if (incoming.has(id)) matched++;
    return matched < coveredBefore.size ? { expected: coveredBefore.size, matched } : null;
}

// #2627 turn-separator helpers moved to ./turn-separator.ts (zero-dependency leaf
// — the storage seam needs them without session.ts's built-acp-kernel import;
// the doc comments live there now). Re-exported so existing consumers keep the
// session.js import path.
export { RESPONSES_TURN_SEPARATOR_ID_PREFIX, isResponsesTurnSeparatorId, scrubTurnSeparatorIds } from "./turn-separator.js";

/** #2627: the REAL-history coverage set — active blocks' effective ids minus
 *  outbound-only turn separators. Single source for every drift consumer (the
 *  four [acp-drift] pre-turn snapshots, local-compaction gap detection,
 *  fold-reconcile's covered set, per-block ledger evidence): the unfiltered
 *  union would report separator-only gaps forever against an unchanged history. */
export function coveredRealHistoryIds(blocks: ReadonlyArray<{ readonly active?: boolean; readonly effectiveMessageIds?: readonly string[] }>): Set<string> {
    const covered = new Set<string>();
    for (const block of blocks) {
        if (!block.active) continue;
        for (const id of block.effectiveMessageIds ?? []) {
            if (!isResponsesTurnSeparatorId(id)) covered.add(id);
        }
    }
    return covered;
}

/** Flush a session to disk and drop it from memory (LRU eviction). Refuses to
 *  evict sessions that are in-flight or whose flush failed (would lose a
 *  never-persisted session permanently). Returns true if a slot was freed. */
function evictOldest(): boolean {
    let oldestId: string | undefined;
    let oldestSeen = Infinity;
    for (const [id, s] of sessions) {
        // Never evict a session being actively mutated by a request — flushing
        // its half-mutated state then reloading a second object causes
        // split-brain writes to the same file.
        if (s.inFlight > 0) continue;
        if (s.lastSeen < oldestSeen) {
            oldestSeen = s.lastSeen;
            oldestId = id;
        }
    }
    if (!oldestId) return false;
    const s = sessions.get(oldestId)!;
    const ok = getStore().flushSync(s);
    if (!ok) {
        // A prior save does not contain the latest mutations. Keep newer
        // state resident whenever its flush fails, including CCR failures.
        return false;
    }
    sessions.delete(oldestId);
    stampEvictedWeight(oldestId, sessionWeight(s));
    // #3126: eviction is the trigger for the empty-view compress window (the
    // session's message bytes live only here; state reloads from disk but the
    // view self-heals only on the next model request). Log it so operators can
    // correlate ctx=0 receipts with the exact moment a session left memory.
    loggerLog("info", `[session] evicted ${oldestId} from resident pool (weight ${sessionWeight(s)} bytes, ${sessions.size} session(s) remain, budget ${MAX_RESIDENT_BYTES} bytes)`);
    return true;
}

/** Graceful shutdown: flush all sessions with pending writes. */
export async function flushAllSessions(): Promise<void> {
    await getStore().flushAll(sessions.values());
}

export function _resetSessionsForTest(max?: number, maxBytes?: number): void {
    if (max !== undefined) MAX_SESSIONS = Math.max(1, Math.floor(max));
    if (maxBytes !== undefined) MAX_RESIDENT_BYTES = Math.max(1, Math.floor(maxBytes));
    // A fresh process boots with initialized=false; tests that reset the pool
    // to re-run initSessions() need the flag reset too.
    initialized = false;
    for (const s of sessions.values()) {
        if (s.inFlight > 0) s.inFlight = 0;
    }
    sessions.clear();
    evictedWeights.clear();
}

export function _sessionsSizeForTest(): number {
    return sessions.size;
}
