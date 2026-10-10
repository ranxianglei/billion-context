import { createInitialState, defaultConfig, highestUsedIndex, indexToRef, resetImageFullState, type CompressionState, type Config, type CoreMessage, type MessageContentStore } from "acp-kernel";
import { createHash } from "node:crypto";
import { log as loggerLog } from "./logger.js";
import { getStore } from "./persist.js";
import { maxSessions as knobMaxSessions } from "./knobs.js";
import { durableMessageGuards } from "./durable-message-guards.js";
import type { WireProtocol } from "./util.js";

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
        /** Current in-context (uncompressed) token count at last processTurn. */
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
        /** #1095: image blocks downscaled this session (lifetime; optional —
         *  absent in pre-#1095 records). */
        imageShrunkCount?: number;
        /** #1095: cumulative wire bytes saved by downscaling. */
        imageBytesSaved?: number;
        /** #1095: cumulative estimated visual tokens saved by downscaling. */
        imageTokensSaved?: number;
        /** #1095: total image_full tool calls issued. */
        imageFullCalls?: number;
        /** #1095: image_full calls that restored a downscaled ref. */
        imageFullRestores?: number;
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
     /** #1095 in-memory only (NOT persisted): deterministic encode cache keyed
     *  by sha256 of the ORIGINAL base64 → encoded payload. Identical inputs
     *  must yield identical wire bytes across turns/restarts (prefix-cache
     *  invariant), so this is a pure CPU cache, never a correctness source. */
    imageEncodeCache?: Map<string, { b64: string; mediaType: string }>;
    /** #1095 in-memory only (NOT persisted): sha256 fingerprints of the
     *  original payloads shrunk per ref — lets image_full invalidate the exact
     *  encode-cache entries a restored ref contributed. */
    imageFingerprintsByRef?: Map<string, string[]>;
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
     *  activity; fallback=latest skips restored sessions rather than guessing
     *  among a readdir-order tie. Cleared on the first real request touch. */
    restored?: boolean;
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
};

// #833: wire paths resolve the kernel Config per request (global → provider →
// model compress settings + self-heal + output headroom), while the plugin
// status/tool API reads sessions with no request context and was falling back
// to the base kernelConfig — which carries NO file/provider/model compress
// settings — so the panel Nudge line showed kernel defaults regardless of user
// config. Same pattern as absorb.ts's effectiveAbsorb: stamp the last resolved
// Config per session (latest wins), read it with fallback to the base.
export function storeEffectiveConfig(session: Session, config: Config): void {
    session.metadata["effectiveConfig"] = config;
}

export function effectiveConfig(session: Session | undefined, fallback: Config): Config {
    const stored = session?.metadata["effectiveConfig"];
    const base = stored && typeof stored === "object" ? { ...fallback, ...(stored as Partial<Config>) } : fallback;
    // #2419 follow-up (CI regression): the per-lane durable-message guard is a
    // FUNCTION and must never be persisted into session.metadata — fork-adoption
    // structuredClones metadata.effectiveConfig (plugin.ts) and disk persistence
    // cannot serialize a function. The lane id is already clone-safe here, so
    // re-resolve the guard from it at read time; every consumer (plugin tool,
    // nudge panel) then sees the same protection the wire path used this turn.
    const lane = typeof session?.metadata["pluginAgent"] === "string" ? session.metadata["pluginAgent"] : undefined;
    const guard = lane ? durableMessageGuards[lane] : undefined;
    return guard && !base.isMessageProtected ? { ...base, isMessageProtected: guard } : base;
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
 * than as 0. */
export function statusInputBaseline(session: Session): number {
    const stats = session.stats;
    return stats.lastInputTokensSource === "usage" || stats.lastInputTokensSource === "overflow-arm"
        ? stats.lastInputTokens
        : stats.lastUsageGradeTokens ?? 0;
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

/** Mirror of acp-kernel's resolveAdaptiveGrowth (not exported by the kernel):
 *  min(growthCap, max(growthFloor, round(modelContextLimit × growthRatio))).
 *  The per-request config stamped by storeEffectiveConfig is the same object
 *  the kernel decided with this turn, so the margin matches the kernel's own
 *  cadence exactly — including owner-flattened compress.nudgeGrowthTokens. */
function nudgeGrowthInterval(config?: Config): number {
    const c = config ?? defaultConfig(1);
    return Math.min(c.nudge.growthCap, Math.max(c.nudge.growthFloor, Math.round(c.modelContextLimit * c.nudge.growthRatio)));
}

/** #1595: retire a stale-high kernel nudge reference when a REAL usage-grade
 *  sample lands far below it.
 *
 * The kernel's own downward re-anchor (nudgeNode) compares the incoming token
 * count against the BASELINE only, but its growth decision prefers
 * lastNudgeShownTokens whenever that is non-zero. When an estimate-grade
 * reading (armFailureShrink window feeding effectiveTokenCount's #1492
 * fall-through) pins lastNudgeShownTokens at a phantom-high level and real
 * usage then settles within one interval of the low baseline, the kernel never
 * self-resets and every later growth calculation runs against the phantom —
 * permanently negative, blocking the tier cadence until context regrows past
 * the phantom level or a compression resets the references.
 *
 * Called from every usage-grade settle site (plugin SSE pipes via
 * applyUsageSample, proxy streaming loops via recordUsage, non-streaming JSON)
 * AFTER lastInputTokens has been written from the real report. Fires only for
 * drops of more than one full growth interval below the current reference
 * (lastNudgeShownTokens, else baseline) — estimates never trigger it. On fire
 * it mirrors the kernel's drift-reset trio: baseline := real value,
 * lastNudgeShownTokens := 0, lastShownByTier := {} — so the next prepare
 * measures growth from reality with a full interval of cadence headroom. */
export function reanchorNudgeOnUsageDrop(session: Session): void {
    // Partial-session literals (test fixtures, pre-kernel shapes) may lack
    // state/stats fields entirely — no-op rather than crash.
    const nudge = session.state?.nudge;
    const value = session.stats.lastInputTokens;
    if (!nudge || typeof value !== "number" || value <= 0) return;
    const ref = nudge.lastNudgeShownTokens > 0 ? nudge.lastNudgeShownTokens : nudge.lastPerMessageNudgeTokens;
    if (ref <= 0) return;
    const stored = session.metadata?.["effectiveConfig"];
    const margin = nudgeGrowthInterval(stored && typeof stored === "object" ? (stored as Config) : undefined);
    if (!(value < ref - margin)) return;
    nudge.lastPerMessageNudgeTokens = value;
    nudge.lastNudgeShownTokens = 0;
    nudge.lastShownByTier = {};
    markDirty(session);
    loggerLog("info", `[${session.id}] nudge reference re-anchored ${ref} -> ${value} after usage-grade drop (margin ${margin}) — stale high reference retired (#1595)`);
}

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

let initialized = false;

/** Bulk-load persisted sessions from disk into the in-memory map. Called once
 *  at server startup before listening. boot() does ONE loadAll pass plus the
 *  #286 migration over the same parsed map (#401: the
 *  old migrateLegacyIds()+loadAll() pair walked and parsed the tree twice).
 *  Caps at MAX_SESSIONS by the most recently active of createdAt/lastSeen-
 *  from-disk (keeps the freshest; a session that is old but was active until
 *  recently must not lose its slot to a newer-created-but-idle one, #404) so
 *  a huge backlog cannot OOM on boot. Idempotent. */
export async function initSessions(): Promise<void> {
    if (initialized) return;
    initialized = true;
    const store = getStore();
    if (!store.enabled) return;
    const loaded = await store.boot();
    if (loaded.size > MAX_SESSIONS) {
        const freshness = (s: Session) => Math.max(s.createdAt ?? 0, s.lastSeen ?? 0);
        const entries = [...loaded.entries()].sort((a, b) => freshness(b[1]) - freshness(a[1]));
        for (const [id, s] of entries) {
            if (sessions.size >= MAX_SESSIONS) break;
            sessions.set(id, s);
        }
    } else {
        for (const [id, s] of loaded) sessions.set(id, s);
    }
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
        if (sessions.size >= MAX_SESSIONS) {
            const evicted = evictOldest();
            if (!evicted) {
                throw new Error(`session pool exhausted (MAX_SESSIONS=${MAX_SESSIONS}; all in-flight)`);
            }
        }
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
    sessions.set(id, session);
    return session;
}

export function createSession(id: string, meta?: Session["meta"]): Session {
    return {
        id,
        meta: { protocol: meta?.protocol, upstreamOrigin: meta?.upstreamOrigin, label: meta?.label },
        stats: zeroStats(),
        metadata: {},
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
    if (sessions.size >= MAX_SESSIONS && !evictOldest()) throw new Error("session pool exhausted");
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
    // Kernel contract (acp-kernel image-compress.d.ts): resetImageFullState on
    // EVERY state reset — refs are re-issued here, so any surviving
    // imageFullRestored/imageShrinks entries would misattribute.
    session.state = resetImageFullState(createInitialState());
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
    // #1095: same ref-reissue rationale as the content store — encode-cache /
    // fingerprint entries keyed by old refs would misattribute after rebase.
    session.imageEncodeCache?.clear();
    session.imageFingerprintsByRef?.clear();
    session.stats.lastInputTokens = 0;
    // #857: a zeroed baseline carries no provenance — drop any stale flag.
    delete session.stats.lastInputTokensSource;
    // #1110: the conversation was rebuilt — a pre-compaction overflow arm no
    // longer bounds this session; drop it so the guard falls back to the
    // declared window instead of clamping to a stale ceiling.
    delete session.stats.overflowArmTokens;
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
    resetSessionCompression(session);
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
    pruneRefsToLiveIds(session, liveRawIds, byRaw, byRef);

    session.metadata.compactionBoundary = {
        ...(boundary as Record<string, unknown>),
        pending: false,
        archivedAt: Date.now(),
        archivedBlocks: deactivated,
    };
    markDirty(session);
    log("info", `[${session.id}] native compaction boundary: archived ${deactivated.length} pre-compaction block(s)${deactivated.length > 0 ? ` (${deactivated.join(", ")})` : ""}; pruned ref maps to ${liveRawIds.size} live raw id(s)`);
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
    for (const [ref, rawId] of Object.entries(byRef)) {
        if (liveRawIds.has(rawId)) prunedByRef[ref] = rawId;
    }
    session.state.messageRefs.byRaw = prunedByRaw;
    session.state.messageRefs.byRef = prunedByRef;
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
}

export function detectUnannouncedHistoryRewrite(
    session: Session,
    knownRefsBefore: ReadonlySet<string>,
    liveRawIds: Iterable<string>,
): RewriteDetection {
    const knownBefore = knownRefsBefore.size - (knownRefsBefore.has(REF_FLOOR_RAW_ID) ? 1 : 0);
    let incomingTotal = 0;
    let knownIncoming = 0;
    for (const id of liveRawIds) {
        incomingTotal++;
        if (knownRefsBefore.has(id)) knownIncoming++;
    }
    const detected =
        knownBefore >= REWRITE_MIN_KNOWN_REFS &&
        session.state.blocks.length > 0 &&
        incomingTotal >= REWRITE_MIN_INCOMING_TOTAL &&
        knownIncoming > 0 &&
        knownIncoming / incomingTotal < REWRITE_MAX_KNOWN_RATIO &&
        knownIncoming / knownBefore < REWRITE_MAX_KNOWN_RATIO;
    return { detected, knownBefore, incomingTotal, knownIncoming };
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
    if (!ok && !s.persisted) {
        // Flush failed AND this session was never written to disk — evicting
        // would permanently lose it. Keep it in memory instead.
        return false;
    }
    sessions.delete(oldestId);
    return true;
}

/** Graceful shutdown: flush all sessions with pending writes. */
export async function flushAllSessions(): Promise<void> {
    await getStore().flushAll(sessions.values());
}

export function _resetSessionsForTest(max?: number): void {
    if (max !== undefined) MAX_SESSIONS = Math.max(1, Math.floor(max));
    for (const s of sessions.values()) {
        if (s.inFlight > 0) s.inFlight = 0;
    }
    sessions.clear();
}

export function _sessionsSizeForTest(): number {
    return sessions.size;
}
