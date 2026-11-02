import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
    computeFoldEconomics,
    decomposeSample,
    type CoreMessage,
    FOLD_CLAIM_COLD_ROUNDS,
    FOLD_CLAIM_WARM_HIT_PCT,
    formatCacheReport,
    summarizeFoldEconomics,
    type CacheReport,
    type CacheReportLine,
    type CacheTotals,
    type CompressionBlock,
    type FoldEvent,
    type PriceProfile,
} from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import { METADATA_CANONICAL_SYS_FP, METADATA_FOLD_COVERAGE, METADATA_LAST_RESPONSES_MODE, METADATA_SYSTEM_FP } from "./fold-reconcile.js";
import { clearPostRebuildAnchor, markDirty, type Session } from "./session.js";
import { isForeignMembership } from "./request-membership.js";
import { billInputUsage } from "./billing.js";
import { normalizeUpstreamOrigin } from "./util.js";
import { toolFail, toolOk, type ProxyToolResult } from "./proxy-tool-result.js";

// Render window for handleAcpCache's detail:"full" text view (#1489). The
// ledger itself is unbounded — this only bounds how many lines the text
// listing shows so a marathon session cannot flood the caller's context.
const FULL_DETAIL_LINES = 512;

// #1536: identity of this daemon process boot. A session's first KNOWN sample under a
// NEW boot id (with prior history) marks a proxy-restart / re-fork boundary (#499): its
// upstream KV was dropped during downtime even though bili's message refs were preserved.
const BOOT_ID = randomUUID();

// #1847: a dimension that changed keeps claiming this sample's stable-prefix residual for up to
// SWITCH_COLD_ROUNDS later samples (by sample index — unmeasured ones also advance it, tightening the
// window), until a line >= WARM_HIT_PCT proves re-cache (retires all open windows). Beyond the bound
// the residual reverts to unattributed TTL — an old switch must never swallow later, unrelated churn.
const SWITCH_COLD_ROUNDS = 4;
const WARM_HIT_PCT = 85;

// #2131: input-size bucket width for the hit-rate stratification diagnostic.
const SIZE_BUCKET_TOK = 20000;

// #2202: blockIds whose coverage-lost transition was already logged — one warn
// per loss episode per fold instead of one per usage sample; the entry is
// dropped again when coverage returns (a flapping client logs once per flip).
const LOST_LOGGED_KEY = "foldCoverageLostLogged";

function median(xs: number[]): number | null {
    if (xs.length === 0) return null;
    const s = [...xs].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 === 1 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

interface LedgerFold {
    seq: number;
    at: number;
    S: number;
    sigma: number;
    /** #2929: samples this fold has claimed under the cold-tail window
     *  (first claim unconditional, then cold continuations until warm or
     *  FOLD_CLAIM_COLD_ROUNDS). Sparse: absent on ledgers persisted before
     *  #2929 — treated as 0 claims, which reproduces the first-claim path. */
    claims?: number;
    /** #2929: claim window closed (warm line proved re-cache, or the cold-round
     *  bound elapsed). Sparse: absent = open. */
    retired?: boolean;
    X?: number;
    V?: number;
    Vp?: number;
    T: number;
    hPct: number | null;
    requestsAfter: number;
    k: number | null;
    /** #2202: kernel blockId the fold was cut from — links the entry to
     *  reconcileFoldCoverage's per-block coverage evidence (foldCoverageByBlock)
     *  so avoided-token accrual can be conditioned on measured wire presence.
     *  Sparse: absent on ledgers persisted before #2202 (unverifiable → status
     *  quo booking, byte-identical to pre-#2202 behavior). */
    bid?: string;
}

interface LedgerLine {
    captureId?: string;
    captureRound?: number;
    evidence?: "out-of-order";
    seq: number;
    at: number;
    input: number;
    cached: number;
    output: number;
    hitPct: number | null;
    missed: number;
    nc: number;
    cr: number;
    tr: number;
    foldSeq: number | null;
    model?: string;
    /** #1536: wire protocol of this request — part of the target identity. */
    proto?: string;
    /** #1536: LLM endpoint origin of this request — part of the target identity. */
    up?: string;
    /** #2131: outbound credential fingerprint of this request
     *  ("sha256:<12 hex>" of authorization/x-api-key/… — the raw key is
     *  NEVER stored). A URL-granular upstream identity cannot see relay
     *  key-pool rotation; the fingerprint can. Sparse: omitted when no
     *  header capture happened on this lane. */
    kp?: string;
    /** #1592-family seam detector: 1 iff this sample's unexplained residual
     *  tripped the mid-history-break suspicion (no fold/switch/restart
     *  attribution AND a large ttlRepay). Sparse: omitted unless set. */
    seam?: 1;
    /** #1592 follow-up: 1 iff this sample settled within 30s of a client
     *  mid-stream abort in the same session (abort/retry churn correlation). */
    abortedNear?: 1;
    /** #2929: which attribution arm detectSeam booked this sample's residual
     *  into — "ttl" (long-idle byte-stable miss, normal ageing), "side"
     *  (short-idle byte-stable miss, abnormal provider failure), "rewind"
     *  (client revert/trim re-bill) or "client" (#3023: the client's own
     *  resent history broke mid-list — host-side insert/rewrite, e.g. another
     *  plugin or paste hoisting; the outbound seam is bili's faithful rebuild
     *  of host churn). Sparse: omitted unless booked. The seam arm sets `seam`
     *  above instead. Lets the web trajectory chart paint the same bucket
     *  membership the economics card aggregates. */
    prov?: "ttl" | "side" | "rewind" | "client" | "orphan-sweep";
    /** #1535: 1 iff `model` differs from the previous sample's KNOWN model
     *  (unknown sides never flag); marks the re-billed stable prefix on the
     *  first request after a model switch. Sparse: omitted unless set. */
    sw?: 1;
    /** #1536: 1 iff `proto` differs from the previous sample's KNOWN protocol. */
    pw?: 1;
    /** #1536: 1 iff `up` differs from the previous sample's KNOWN origin. */
    uw?: 1;
    /** #2131: 1 iff `kp` differs from the previous sample's KNOWN credential
     *  fingerprint — relay account rotation behind a stable URL. */
    kw?: 1;
    /** #2350: system-prompt fingerprint of this request ("sha256:<16 hex>" via
     *  fold-reconcile's noteSystemPromptFingerprint — raw prompt text is NEVER
     *  stored). Sparse: omitted when no system was noted on this lane. */
    sp?: string;
    /** #2350: 1 iff `sp` differs from the previous sample's KNOWN system-prompt
     *  fingerprint — the forwarded system bytes changed between requests,
     *  invalidating every downstream prefix cache entry. Whether that is a host
     *  rewrite or bili's own mode/projection switch is decided by `pf` below
     *  (#2867). */
    sf?: 1;
    /** #2867: 1 iff `sp` flipped while the CANONICAL incoming fingerprint stayed
     *  stable — bili's own compression-mode/projection switch (self-heal
     *  degrade-to-proxy re-hoists mid-history developer items) changed what was
     *  forwarded, NOT the host. Charged to the `projection` cause, never to
     *  `prompt`. */
    pf?: 1;
    /** #2867: 1 iff the canonical incoming system/developer fingerprint flipped
     *  WITHOUT the forwarded projection flipping (e.g. a mid-history developer
     *  edit under plugin mode, which never touches the head developer block) —
     *  observational only: a host-side change outside the projected system
     *  surface; no billing bucket of its own. */
    cf?: 1;
    /** #2867: compression mode serving this sample on the responses lane —
     *  context for `pf` events (the before/after pair lives on consecutive
     *  lines). Sparse: other lanes and pre-#2867 lines omit it. */
    pm?: "plugin" | "proxy";
    /** #1536: 1 on the first KNOWN sample under a NEW daemon boot (#499 restart/refork). */
    rs?: 1;
    /** #1536: 1 when the provider reported NO cache tokens — unmeasurable, quarantined out of closure totals. */
    unk?: 1;
    /** #1891: 1 iff this sample had NO previous ledger baseline (the session's
     *  first measurable bill). Nothing was billed before, so nothing could have
     *  expired: its uncached input is initial content, booked as newContent and
     *  never a seam candidate. Sparse: omitted unless set. */
    nb?: 1;
    /** #1847: the single primary cause this line's stable-prefix residual was charged to (a partition —
     *  never more than one); omitted when unattributed or unmeasured. */
    cause?: "restart" | "model" | "effort" | "key" | "prompt" | "projection" | "wire" | "upstream";
    /** #3803: 1 iff the outbound generation-parameter fingerprint (reasoning
     *  effort / thinking config) changed between consecutive samples — a host-side
     *  knob flip that re-partitions the provider's prompt-cache namespace (e.g.
     *  DeepSeek buckets cache by `output_config.effort`). Sparse: omitted unless set. */
    ef?: 1;
    /** #3803: this request's generation-parameter fingerprint ("sha256:<16hex>").
     *  Sparse: omitted when no effort-bearing field was present on the wire. */
    efp?: string;
    /** #2131: SHA-256 hex of this request's exact outbound body — the per-call
     *  byte-identity proof; sparse: omitted when no body was captured. */
    bd?: string;
    /** #2131: 1 iff the outbound body was byte-identical to the PREVIOUS settled
     *  request's body (e.g. a transport retry), 0 iff it diverged. Sparse:
     *  omitted without a comparable predecessor. */
    be?: 0 | 1;
    /** #2131: first diverging byte offset when be=0 and both full bodies were
     *  retained under BODY_FULL_CAP. Sparse. */
    bl?: number;
    /** #2131: divergence class of a be=0 pair — "head": change within the first
     *  1 KiB (model/tools/sampling-params/system region → host-side parameter
     *  change, not a history rewrite); "append": the whole shorter payload
     *  survives ±64 closing-bracket bytes (pure tail growth/trim); "mid": a
     *  mid-history rewrite; "tail" (#2982): the first divergence sits at/past
     *  the shorter body's message-array closing bracket — only trailing
     *  top-level params (host-computed max_tokens/…) or an ephemeral tail note
     *  that appeared/vanished between requests changed; shared history bytes are
     *  untouched, but a provider MAY partition its prompt cache on a trailing field
     *  (e.g. DeepSeek's output_config.effort — see the effort dimension, #3803), so
     *  the cache is NOT universally unaffected; above SEAM_BODY_CAP the append
     *  evidence itself is also blind (#3800); "unknown": bodies above BODY_FULL_CAP
     *  (inequality proven by digest, offset unavailable). Sparse. */
    bs?: "head" | "append" | "mid" | "tail" | "unknown";
}

interface CacheLedger {
    v: 1;
    lastBlockId: number;
    /** #3769: high-water of session.state.sweptOrphanCallIds length — detects a
     *  proactive failed-compress cleanup between samples so detectSeam can
     *  attribute a mid-history break to the cleanup instead of "unexplained". */
    lastSweptCount?: number;
    /** #3769: orphans swept on the CURRENT sample (0 = none); read by detectSeam's
     *  orphan-sweep arm, refreshed each recordCacheSample. Transient. */
    sweepThisSample?: number;
    consumedFoldSeq: number;
    sampleSeq: number;
    foldSeqCounter: number;
    folds: LedgerFold[];
    lines: LedgerLine[];
    agg: {
        requests: number;
        input: number;
        cached: number;
        output: number;
        nc: number;
        cr: number;
        tr: number;
        switches: number;
        switchMissed: number;
        /** #3803: host generation-parameter (reasoning-effort / thinking-config)
         *  flips between consecutive samples — re-partitions the provider's
         *  prompt-cache namespace (DeepSeek buckets cache by effort), so the first
         *  use of a new value pays one full-prefix re-prefill. Counted independently;
         *  charged only when `effort` wins the attribution partition. */
        effSwitches: number;
        effSwitchMissed: number;
        /** #2131: relay account rotations — the outbound credential
         *  fingerprint changed between consecutive samples (same URL can
         *  hide a key pool behind it). Counted independently of the model/
         *  wire/upstream dimensions; charged only when `key` wins the
         *  attribution partition. */
        keySwitches: number;
        keySwitchMissed: number;
        /** #2350: host system-prompt rewrites — the system-prompt fingerprint
         *  changed between consecutive samples (the host rewrites its own
         *  instructions mid-session, e.g. a periodic dynamic section). Counted
         *  independently of the other dimensions; charged only when `prompt`
         *  wins the attribution partition. Post-#2867 this counts HOST-side
         *  flips only (canonical incoming view also changed); proxy-side mode
         *  switches book into projSwitches instead. */
        promptSwitches: number;
        promptSwitchMissed: number;
        /** #2867: proxy projection/mode switches — the forwarded system bytes
         *  flipped while the canonical incoming system/developer view stayed
         *  stable (self-heal degrade-to-proxy re-hoists mid-history developer
         *  items; the prefix invalidation is real but bili's own doing). */
        projSwitches: number;
        projSwitchMissed: number;
        wireSwitches: number;
        wireSwitchMissed: number;
        upstreamSwitches: number;
        upstreamSwitchMissed: number;
        restartDrops: number;
        restartDropMissed: number;
        attributedMissed: number;
        unknownSamples: number;
        unknownInput: number;
        /** #1891: no-baseline first bills — samples booked as initial content
         *  (their uncached input could not be a prefix re-pay) + billed input. */
        nbSamples: number;
        nbInput: number;
        seamSuspects: number;
        seamMissed: number;
        /** #1592 follow-up: misses with no client-side prefix break — the current
         *  body is byte-stable vs the previous request, or the previous message
         *  list comes back byte-identical as a prefix with only tail messages
         *  appended (#2059). Either way the upstream simply did not serve its
         *  cache (TTL expiry / eviction / relay node rotation). Not a rebuild seam. */
        providerSideMisses: number;
        providerSideMissed: number;
        /** #3023: client-side mid-history rewrites — the inbound pair broke
         *  mid-list (host-side insert/rewrite: another plugin, paste hoisting,
         *  host re-rendering), so the residual belongs to the host, not to a
         *  bili rebuild seam. Charged only when the client arm wins. */
        clientInserts: number;
        clientInsertMissed: number;
        /** #3769: mid-history breaks attributed to a proactive failed-compress
         *  cleanup (orphan rotation) landing in-window without a fold claiming
         *  the break — kept out of the unexplained seam tally. */
        orphanSweepSeams: number;
        orphanSweepMissed: number;
        /** #2929: the provider-side arm split by idle gap — samples settled more
         *  than PROVIDER_TTL_GAP_MS after the previous sample are normal TTL
         *  expiry, not an abnormal provider failure. */
        providerTtlMisses: number;
        providerTtlMissed: number;
        /** #1592 follow-up: misses right after the client rewound history
         *  (revert/trim — fewer message elements than the previous request).
         *  Sanctioned client intent; recorded so the one-time re-bill is
         *  attributed instead of landing in the unexplained residual. */
        rewinds: number;
        rewindMissed: number;
        /** #1592 follow-up: samples settled within 30s of a client abort —
         *  abort/retry churn correlates with prefix misses (the retried
         *  request carries a rewritten tail). Correlation, not causation. */
        abortCorrelated: number;
    };
    /** #1592-family: bounded forensic log of suspected mid-history cache-seam
     *  breaks (consecutive outbound bodies diverged with no structural
     *  attribution). Purely diagnostic — never part of the closure math. */
    seamEvents?: SeamEvent[];
    /** #1536: BOOT_ID of the process that recorded the last line — a mismatch on
     *  the next sample marks a proxy-restart boundary (#499). Absent pre-#1536. */
    lastBoot?: string;
    /** #1847: incremental switch-attribution trackers, advanced by measured samples only. Absent
     *  pre-#1847 — robust detection + cold-window continuation simply don't apply to older ledgers. */
    lastKnownModel?: string;
    lastKnownProto?: string;
    lastKnownUp?: string;
    /** #2131: last measured outbound credential fingerprint ("sha256:<12hex>").
     *  Absent until the first sample that captured one — unknown never flags. */
    lastKnownKey?: string;
    /** #2350: last noted system-prompt fingerprint ("sha256:<16hex>"). Absent
     *  until the first request that carried one — unknown never flags. */
    lastKnownSp?: string;
    /** #2867: last noted CANONICAL incoming system/developer fingerprint —
     *  mode-independent, so a stable canon with a flipped forwarded projection
     *  is bili's own mode/projection switch, not a host rewrite. */
    lastKnownCanon?: string;
    /** #3803: last measured outbound generation-parameter fingerprint ("sha256:<16hex>").
     *  Absent until the first request that carried one — unknown never flags. */
    lastKnownEff?: string;
    invModel?: { seq: number; at: number; from: string | null; to: string };
    invEff?: { seq: number; at: number; from: string | null; to: string };
    invWire?: { seq: number; at: number; from: string | null; to: string };
    invUp?: { seq: number; at: number; from: string | null; to: string };
    invKey?: { seq: number; at: number; from: string | null; to: string };
    invSp?: { seq: number; at: number; from: string | null; to: string };
    invProj?: { seq: number; at: number; from: string | null; to: string };
}

const LEDGER_KEY = "cacheLedger";

function refNum(ref: string): number {
    return Number(ref.replace(/\D/g, "")) || 0;
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

/** Token offset of the view prefix that survives a fold starting at `ref`:
 *  sum of first-render token counts of all refs chronologically before it.
 *  Refs are assigned in message order and never reused (kernel contract),
 *  so numeric order IS view order. */
export function prefixTokensBeforeRef(session: Session, ref: string): number {
    const byRef = session.state?.messageRefs?.byRef;
    const snap = session.state?.tokenSnapshot;
    if (!byRef || !snap || refNum(ref) === 0) return 0;
    let n = 0;
    for (const key of Object.keys(byRef)) {
        if (refNum(key) < refNum(ref)) n += snap[key] ?? 0;
    }
    return n;
}

/** #1592-family seam forensics: where two consecutive outbound bodies first
 *  diverged, for samples whose miss has no structural attribution. */
export interface SeamEvent {
    seq: number;
    at: number;
    input: number;
    hitPct: number;
    /** Byte offset of the first differing byte (a LOWER bound — bodies are
     *  capped at SEAM_BODY_CAP for storage, so huge prefixes report the cap). */
    lcpBytes: number;
    /** Index of the first message element whose serialized form differs.
     *  `null` = position unknowable (a side clipped at SEAM_BODY_CAP or an
     *  unparseable body yields no message list to walk) — never a real index;
     *  renderers must show an unknown token, not 0 (#2339). */
    msgIndex: number | null;
    prevMsgs: number;
    curMsgs: number;
    /** #3023: present iff this event was booked as a CLIENT-side mid-history
     *  rewrite/insert — the inbound pair itself broke mid-list, so the
                     *  outbound seam is the faithful rebuild of host churn, not a bili
     *  rebuild artifact. Carries the divergent message's role/length/class
     *  (never raw content). */
    client?: { idx: number; role: string; len: number; cls: string };
}

const SEAM_BODY_CAP = 512 * 1024;
const SEAM_EVENTS_CAP = 8;
/** Idle gap past which a byte-stable/append-shaped miss reads as NORMAL upstream
 *  TTL expiry rather than an abnormal provider-side failure (#2929 taxonomy:
 *  cold start | normal TTL expiry | abnormal provider miss). Mirrors the web
 *  chart's GAP_MS. */
const PROVIDER_TTL_GAP_MS = 600_000;

// #2131 reachability: full-body retention cap for per-call body-stability
// forensics. Bodies above it are digest-only — SHA-256 still proves byte
// equality/inequality, the LCP offset just becomes unavailable. 8 MiB covers
// multi-MiB plugin-mode sessions (the #2131 log ran ~3.3 MiB outbound).
const BODY_FULL_CAP = 8 * 1024 * 1024;

/** #2131: stored body PLUS exact outbound message count. A body clipped at
 *  SEAM_BODY_CAP parses to zero messages, so count-based classification needs
 *  the count captured at the send chokepoint where the full body is in hand.
 *  `null` = unknown (wire shape without a message array). `digest` hashes the
 *  FULL body (the capped head cannot distinguish two payloads sharing 512 KiB);
 *  `full` keeps the whole payload while it fits BODY_FULL_CAP so divergent
 *  pairs can report their first-diverging byte offset. #2868: bodies are kept
 *  as UTF-8 Buffers — every cap, LCP and tolerance in this file is BYTES, and
 *  the capture-time encoding is reused instead of re-encoded per comparison
 *  (a code-unit LCP misreported CJK offsets by up to 3×, and slicing a string
 *  then re-encoding cannot repair it: distinct codepoints share leading
 *  UTF-8 bytes). #2923: slots live under session.transient so the retained
 *  copies release with the session. */
export interface SeamSlot {
    order?: number;
    requestId?: string;
    round?: number;
    /** Capped head (≤ SEAM_BODY_CAP bytes) — seam forensics + JSON parse side. */
    head: Buffer;
    /** Exact outbound body size in bytes — precise cap/full detection. */
    bytes: number;
    msgs: number | null;
    digest: string;
    full: Buffer | null;
    /** #2131: credential fingerprint of the headers that carried THIS body out.
     *  Preserved across byte-identical re-notes (the non-streaming settle
     *  re-notes the same wireBody without headers in hand). */
    keyFp?: string;
    /** #3803: generation-parameter (reasoning-effort / thinking-config)
     *  fingerprint of the parsed outbound body that carried this request out.
     *  Preserved across byte-identical re-notes like keyFp. */
    effFp?: string;
}

// #3023: message-count ceiling for the inbound pair. The per-message
// fingerprint array is stored whole; above this bound the walk cannot prove
// where (or whether) the client's list broke mid-way, so the client arm
// declines to classify and the sample keeps the legacy seam behavior.
const INBOUND_MSG_CAP = 8192;

/** #3023: the CLIENT's resent view of a request — `Prepared.originalMessages`
 * (the protocol conversion of the client's bytes, BEFORE processTurn folds or
 * replaces anything), captured at the same send chokepoint as noteForwardedBody
 * and settled with the same prev/cur pairing. Holds per-message fingerprints
 * plus role/length/class metadata — NEVER raw content (same rule as every
 * other ledger slot). Lets detectSeam tell a client-side mid-history
 * insert/rewrite (host-owned, #2997's dsh inserts) from a genuine bili
 * rebuild seam: only the latter leaves the inbound list prefix-stable while
 * the outbound body diverges mid-list. */
export interface InboundSlot {
    msgs: number;
    /** sha256-16 of each message's canonical JSON, in list order. */
    fps: string[];
    /** Parallel to `fps`: role + JSON length + coarse content class of each
     *  message, recorded so a divergent index can report WHAT the client
     *  inserted without retaining its text. */
    meta: { role: string; len: number; cls: string }[];
}

// #4043: host-generated metering fields — present on Prepared.originalMessages
// but NOT in the client's bytes. projectThinkingMass (#1320) stamps
// CoreMessage.thinkingTokens onto the anthropic-lane list between conversion
// and this capture, and re-derives the value every turn from the previous
// usage report — so a byte-stable client list would otherwise show positional
// fingerprint divergence at every signature-only reasoning message, and
// detectSeam's #3023 client arm would attribute a bili-owned miss to "host
// churn". Strip these fields from the ORIGIN EVIDENCE only: signatures, raw
// payloads, tool ids and unknown semantic fields stay full evidence, and miss
// accounting is untouched. Future host-projected metering fields MUST extend
// this list before shipping (evidence-permitlist, same discipline as #1104/#1107).
const GENERATED_METERING_FIELDS: readonly string[] = ["thinkingTokens"];

/** Canonical JSON of ONE message as ORIGIN EVIDENCE — the message minus the
 *  host-generated metering fields above. Fast path: messages without any
 *  generated field stringify byte-identically to before this exclusion
 *  existed, so every unaffected session keeps its legacy fingerprints. */
function originEvidenceJson(m: CoreMessage): string {
    const r = m as unknown as Record<string, unknown>;
    if (!GENERATED_METERING_FIELDS.some((k) => k in r)) return JSON.stringify(m);
    const stripped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
        if (!GENERATED_METERING_FIELDS.includes(k)) stripped[k] = v;
    }
    return JSON.stringify(stripped);
}

// #4430: per-request pending-evidence isolation. Overlapping forwards on one
// session (same-request re-tries, concurrent side lanes) used to share ONE
// session.transient slot — the second forward's evidence clobbered the first's
// before settle. Pending evidence now lives in an AsyncLocalStorage capture;
// session.transient remains the fallback for callers outside the wrapper.
type Capture = {
    session: Session;
    requestId: string;
    round: number;
    sentBody?: SeamSlot;
    inBody?: InboundSlot;
    imageFacts?: ForwardedImageFacts;
};
const captures = new AsyncLocalStorage<Capture>();
let captureOrder = 0;

/** Covers the entire forward, including awaited streaming/loop callbacks.
 *  Concurrent requests keep independent pending evidence; only settled pairs
 *  live on the session. It does not serialize upstream work or change the wire. */
export async function withCacheCapture<T>(session: Session | undefined, fn: () => Promise<T>): Promise<T> {
    if (!session) return fn();
    return captures.run({ session, requestId: randomUUID(), round: 0 }, async () => {
        try { return await fn(); }
        finally {
            const capture = captures.getStore();
            if (capture) {
                delete capture.sentBody;
                delete capture.inBody;
                delete capture.imageFacts;
            }
        }
    });
}

function pendingCapture(session: Session): Capture | NonNullable<Session["transient"]> {
    const capture = captures.getStore();
    return capture?.session === session ? capture : (session.transient ??= {});
}

export function lastForwardedBody(session: Session): SeamSlot | undefined {
    return pendingCapture(session).sentBody;
}

/** #4731: the pending evidence PAIR of the in-flight request — outbound body
 *  AND inbound view from ONE source: the ALS capture when this code runs
 *  inside withCacheCapture (relay lane), else session.transient (loop lane).
 *  Callers that pair the two sides MUST take both from here; mixing one side
 *  from the capture with the other from the fallback can mate an old body
 *  with fresh usage and mis-attribute the seam. Settled baselines
 *  (settledBody/settledInBody) always live on session.transient and stay
 *  read from there on every lane. */
export function pendingEvidencePair(session: Session): { sentBody?: SeamSlot; inBody?: InboundSlot } {
    const pending = pendingCapture(session);
    return { sentBody: pending.sentBody, inBody: pending.inBody };
}

/** #3023: capture side of the inbound pair — call at the send chokepoint
 *  (src/server/relay.ts), next to noteForwardedBody, with the request's
 *  original (pre-rebuild) message list. Cost is one canonical stringify per
 *  message (≈ one extra body serialization, the outbound path already does
 *  the same order of work hashing the wire body). Fingerprints are computed
 *  over origin evidence (#4043): host-generated metering never counts as
 *  client-origin divergence, everything else does. */
export function noteInboundMessages(session: Session, msgs: CoreMessage[]): void {
    const transient = pendingCapture(session);
    if (msgs.length > INBOUND_MSG_CAP) {
        // Too many messages to fingerprint whole: keep the count (so the
        // settle-side guard can decline) but drop any stale slot from a
        // previous request — a mismatched pair must never be compared.
        delete transient.inBody;
        transient.inBody = { msgs: msgs.length, fps: [], meta: [] };
        return;
    }
    const fps: string[] = [];
    const meta: { role: string; len: number; cls: string }[] = [];
    for (const m of msgs) {
        const j = originEvidenceJson(m);
        fps.push(createHash("sha256").update(j).digest("hex").slice(0, 16));
        meta.push({ role: String((m as { role?: unknown }).role ?? "?"), len: j.length, cls: inboundMessageClass(m) });
    }
    transient.inBody = { msgs: msgs.length, fps, meta };
}

function inboundMessageClass(m: CoreMessage): string {
    const r = m as unknown as Record<string, unknown>;
    if (r.tool_calls !== undefined || r.tool_use !== undefined) return "tool-call";
    const content = r.content;
    if (typeof content === "string") return "text";
    if (Array.isArray(content)) {
        for (const part of content) {
            const t = (part as { type?: unknown } | null)?.type;
            if (t === "image" || t === "image_url" || t === "input_image" || t === "inline_data") return "image";
        }
        return "text";
    }
    return "other";
}

/** #3023: index of the first message whose fingerprint differs between the
 *  settled pair — `null` when the recorded prefixes are identical (pure
 *  tail-append or byte-stable list). Only meaningful when both sides were
 *  captured whole (msgs <= INBOUND_MSG_CAP, checked by the caller). */
function firstDivergentInboundMsg(prev: InboundSlot, cur: InboundSlot): number | null {
    const n = Math.min(prev.fps.length, cur.fps.length);
    for (let i = 0; i < n; i++) {
        if (prev.fps[i] !== cur.fps[i]) return i;
    }
    return null;
}
const lastClientAbort = new WeakMap<Session, number>();

interface ContextObservation {
    sessionId: string;
    tokens: number;
    source: "usage" | "estimate";
    at: number;
    generation: string;
}

/** Public context provenance is separate from billing and nudge baselines. */
export function recordContextObservation(session: Session, tokens: number, source: ContextObservation["source"]): void {
    if (!Number.isFinite(tokens) || tokens < 0) {
        delete session.metadata?.publicContextObservation;
        return;
    }
    session.metadata ??= {};
    session.metadata.publicContextObservation = { sessionId: session.id, tokens, source, at: Date.now(), generation: randomUUID() } satisfies ContextObservation;
}

export function currentContextObservation(session: Session): ContextObservation | undefined {
    const raw = session.metadata?.publicContextObservation;
    if (!raw || typeof raw !== "object") return undefined;
    const o = raw as Record<string, unknown>;
    if (o.sessionId !== session.id || typeof o.tokens !== "number" || !Number.isFinite(o.tokens) || o.tokens < 0 ||
        (o.source !== "usage" && o.source !== "estimate") || typeof o.at !== "number" || !Number.isFinite(o.at) || o.at < 0 ||
        typeof o.generation !== "string" || o.generation.length === 0) return undefined;
    return { sessionId: session.id, tokens: o.tokens, source: o.source, at: o.at, generation: o.generation };
}

/** #1592 follow-up: stamp the wall-clock time of a client mid-stream abort
 *  (wired at both forward abort chokepoints). The next settle in the same
 *  session reads it to mark abort-correlated samples. */
export function noteClientAbort(session: Session): void {
    lastClientAbort.set(session, Date.now());
}

/** #2131: stable fingerprint of the outbound credential — the ONLY form the
 *  key is ever persisted in (raw secrets never reach the ledger, logs or the
 *  web UI). Checks the standard bearer/api-key headers, case-insensitively;
 *  returns undefined when the lane sent no recognized credential header. */
export function credentialFingerprint(headers: Record<string, string> | undefined | null): string | undefined {
    if (!headers) return undefined;
    let cred: string | undefined;
    for (const [name, value] of Object.entries(headers)) {
        const n = name.toLowerCase();
        if (n === "authorization" || n === "x-api-key" || n === "api-key" || n === "x-goog-api-key") {
            // Strip the auth-scheme envelope so "Bearer X" (authorization) and
            // a bare "X" (x-api-key) hash to the SAME credential identity.
            const v = value.trim().replace(/^Bearer\s+/i, "").trim();
            if (v !== "") {
                // #1884 resign lane: SDK-HMAC-SHA256 authorization lines are
                // re-signed EVERY request (Signature is an HMAC over the
                // per-request date + body hash), so hashing the raw line
                // yields a per-request-unique identity — downstream that
                // meant the 429 governor's holds never matched (#4204 never
                // throttled on the APIG lane it was built for), the #3376
                // keepalive snapshot deleted itself after every forward, and
                // #2131 cache-sample attribution fragmented into one bucket
                // per request. The STABLE credential on that line is the
                // Access key id — fingerprint only that.
                const m = /^SDK-HMAC-SHA256\s+Access=([^\s,]+)/i.exec(v);
                cred = m !== null ? `sdk-hmac:${m[1]!}` : v;
                break;
            }
        }
    }
    if (cred === undefined) return undefined;
    return "sha256:" + createHash("sha256").update(cred, "utf8").digest("hex").slice(0, 12);
}

// #3803: deterministic key-sorted JSON — the fingerprint must be stable under
// field reordering (a host that emits the same knobs in a different order must
// NOT flip the cache-partition identity between requests).
function canonicalJson(v: unknown): string {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/** #3803: fingerprint the outbound body's generation-parameter surface — the
 *  reasoning-effort / thinking-config knobs some providers fold into their prompt
 *  cache key (DeepSeek buckets cache by `output_config.effort`; a new value pays
 *  one full-prefix re-prefill). Built from the PARSED object at the send
 *  chokepoint, never from the capped head (trailing fields sit past SEAM_BODY_CAP
 *  exactly when the body is large → cap-independent). Only effort-bearing fields
 *  are collected; cache-neutral params (max_tokens / temperature) stay OUT so
 *  folding them cannot mask real provider-side losses. Returns undefined when no
 *  effort-bearing field is present (unknown never flags). */
export function generationParamFp(body: Record<string, unknown> | null | undefined): string | undefined {
    if (!body || typeof body !== "object") return undefined;
    const parts: Record<string, unknown> = {};
    if (body.thinking !== undefined && body.thinking !== null) parts.thinking = body.thinking;
    if (body.output_config !== undefined && body.output_config !== null) parts.output_config = body.output_config;
    if (typeof body.reasoning_effort === "string" && body.reasoning_effort !== "") parts.reasoning_effort = body.reasoning_effort;
    const r = body.reasoning;
    if (r !== null && typeof r === "object") {
        const re = (r as Record<string, unknown>).effort;
        if (typeof re === "string" && re !== "") parts["reasoning.effort"] = re;
    }
    const gc = body.generationConfig;
    if (gc !== null && typeof gc === "object") {
        const tc = (gc as Record<string, unknown>).thinkingConfig;
        if (tc !== undefined && tc !== null) parts.thinkingConfig = tc;
    }
    if (Object.keys(parts).length === 0) return undefined;
    return "sha256:" + createHash("sha256").update(canonicalJson(parts), "utf8").digest("hex").slice(0, 16);
}

/** Record the body of the upstream round that is about to be sent. Called at
 *  the single send chokepoints (loop fetchUpstream, non-streaming forward);
 *  the next settleUsageReport pairs it with the usage report it produced.
 *  `msgs` is the exact outbound message count (#2131); when omitted and the
 *  stored payload is byte-identical to a previously noted one (the non-streaming
 *  settle re-noting the same wireBody), the earlier count is kept. `keyFp` is
 *  the outbound credential fingerprint (#2131) — likewise inherited from the
 *  prior slot on a byte-identical re-note without a fresh capture. `effFp` is
 *  the generation-parameter fingerprint (#3803) — same inheritance rule. */
export function noteForwardedBody(session: Session, body: string, msgs?: number | null, keyFp?: string, effFp?: string): void {
    // #2868: encode to UTF-8 ONCE here — digest, capped head and retained full
    // body all consume this same buffer, so no later comparison re-encodes.
    // Caps are BYTES (the old code-unit caps overshot them up to 3× on CJK).
    // The buffer is a fresh allocation and nothing below retains `body` itself
    // (#2923: the request string releases once this returns).
    // #2131: hash the FULL body — the capped head alone cannot tell two payloads
    // sharing a 512 KiB prefix apart. Re-noting a byte-identical payload (the
    // non-streaming settle path) reuses the prior slot's count/full instead of
    // re-deriving them.
    const buf = Buffer.from(body, "utf8");
    const digest = createHash("sha256").update(buf).digest("hex");
    const transient = pendingCapture(session);
    const prior = transient.sentBody;
    const samePayload = prior !== undefined && prior.digest === digest;
    transient.sentBody = {
        order: ++captureOrder,
        requestId: "requestId" in transient ? transient.requestId : undefined,
        round: "round" in transient ? ++transient.round : undefined,
        head: buf.byteLength > SEAM_BODY_CAP ? Buffer.from(buf.subarray(0, SEAM_BODY_CAP)) : buf,
        bytes: buf.byteLength,
        msgs: msgs ?? (samePayload ? prior.msgs : null),
        digest,
        full: buf.byteLength <= BODY_FULL_CAP ? buf : samePayload ? prior.full : null,
        keyFp: keyFp ?? (samePayload ? prior.keyFp : undefined),
        effFp: effFp ?? (samePayload ? prior.effFp : undefined),
    };
    if ("round" in transient && transient.round > 1) {
        delete transient.imageFacts;
        delete transient.inBody;
    }
    // prepare may reuse a measured baseline; this new payload is not measured yet.
    if (session.stats.contextTokensSource !== undefined) recordContextObservation(session, session.stats.contextTokens, "estimate");
    else delete session.metadata?.publicContextObservation;
}

// #1843 L1: learned per-route image cost. The prior (pixel tile model or bytes)
// can be off by up to 15x per image on non-OpenAI vision encoders; the upstream
// usage report is the ground truth, so derive the observed image mass as
// (billed input - text-side estimate of the SAME forwarded payload) and learn
// an EMA per image count, keyed by upstream host (the encoder is a property of
// the route). Persisted in session.metadata like #626's learnedCompatRoles so a
// restart keeps the converged value; invalidated by TTL or by a billing/cap
// fingerprint change (a reconfigured route may bill differently).
export interface LearnedImageCostEntry {
    /** EMA of observed billed tokens per image for this host. */
    cost: number;
    /** Samples absorbed into the EMA. */
    seen: number;
    /** Last sample wall-clock ms — entries older than the TTL are ignored. */
    ts: number;
    /** `${billing}:${cap}` fingerprint captured with the sample. */
    fp: string;
}
interface ForwardedImageFacts {
    nImages: number;
    /** Text-side estimate of the forwarded payload (messages + wire overhead) —
     *  whatever the usage total bills besides the images. */
    textSide: number;
    host: string;
    fp: string;
}
const LEARNED_IMAGE_COST_TTL_MS = 24 * 60 * 60 * 1000;
const LEARNED_IMAGE_COST_ALPHA = 0.5;
// Absolute backstop on a single learned per-image sample. Reduced from 1e6 (#4153): that
// ceiling sat three orders of magnitude above any plausible vision bill, so a
// residual-attribution blow-up (a route whose usage input outruns bili's text estimate by
// reasoning/system/tool mass or relay accounting) sailed through and converged via EMA to a
// nonsense fixed point (448k/image observed on a 2k-prior screenshot). 100k still admits
// every realistic single-image bill — including genuinely large byte-billing payloads —
// while rejecting only the degenerate samples that poison the store.
const LEARNED_PER_IMAGE_MAX = 100_000;
// #4153: how far a learned per-image cost may exceed the payload's OWN prior per-image cost
// before it is treated as residual-attribution error rather than encoder variance. Anchored
// to the #1843 documented encoder-variance band ("the prior can be off by up to 15x per
// image"): within the band the learned value is trusted (it corrects the prior in either
// direction); beyond it the residual has picked up non-image mass and the value is clamped
// back to the band edge. Downward corrections (learned < prior — the #1843 rescue for
// over-counting bytes priors) are untouched because the clamp only bounds the high side.
const LEARNED_VARIANCE_BAND = 15;
const imageFactsLastSent = new WeakMap<Session, ForwardedImageFacts>();

/** Capture side of L1: called at the same send chokepoints as noteForwardedBody
 *  with the image facts of the round about to be sent. The next settleUsageReport
 *  consumes exactly this entry (same pairing guarantee as the seam forensics). */
export function noteForwardedImageFacts(session: Session, facts: ForwardedImageFacts): void {
    const capture = captures.getStore();
    if (capture?.session === session) { capture.imageFacts = facts; return; }
    imageFactsLastSent.set(session, facts);
}

function settleImageLearning(session: Session, billedTotal: number): void {
    const capture = captures.getStore();
    const facts = capture?.session === session ? capture.imageFacts : imageFactsLastSent.get(session);
    if (!facts) return;
    if (capture?.session === session) delete capture.imageFacts;
    else imageFactsLastSent.delete(session);
    if (facts.nImages <= 0 || billedTotal <= 0) return;
    const observed = billedTotal - facts.textSide;
    if (observed <= 0) return; // text estimate overshot the bill — no signal
    const per = observed / facts.nImages;
    if (!(per >= 1 && per <= LEARNED_PER_IMAGE_MAX)) return; // out-of-band sample
    const store = (session.metadata.learnedImageCosts ?? {}) as Record<string, LearnedImageCostEntry>;
    const prev = store[facts.host];
    // #4153 Detail-1: the read side already ignores an entry whose fingerprint no longer
    // matches (falls back to the prior), but the write side used to EMA straight off the
    // stale base anyway — so a poisoned value captured under the old fingerprint kept being
    // blended in forever, and setting a cap to mitigate only changed the read behavior and
    // never diluted the stored value. A reconfigured route (billing/cap fp changed) starts
    // fresh instead of inheriting the old base.
    const fresh = !prev || typeof prev.cost !== "number" || prev.fp !== facts.fp;
    const cost = fresh ? per : prev.cost * (1 - LEARNED_IMAGE_COST_ALPHA) + per * LEARNED_IMAGE_COST_ALPHA;
    store[facts.host] = { cost, seen: fresh ? 1 : (prev.seen ?? 0) + 1, ts: Date.now(), fp: facts.fp };
    session.metadata.learnedImageCosts = store;
    markDirty(session);
}

/** Consume side of L1: the learned reserve for THIS payload — learned per-image
 *  cost x current image count, or undefined when no fresh matching evidence
 *  exists (caller then falls back to the prior-based estimate).
 *
 *  `prior` is the caller's PRIOR-based estimate for this same payload (pixels/bytes).
 *  When present it becomes the trust anchor (#4153): the learned per-image cost is
 *  additionally clamped to LEARNED_VARIANCE_BAND × (prior/nImages) so a poisoned sample
 *  can never push the reserve past a sane multiple of bili's own independent estimate. */
export function learnedImageReserve(
    session: Session,
    host: string,
    nImages: number,
    fp: string,
    cap: number,
    prior?: number,
): number | undefined {
    if (nImages <= 0) return undefined;
    const entry = (session.metadata.learnedImageCosts as Record<string, LearnedImageCostEntry> | undefined)?.[host];
    if (!entry || typeof entry.cost !== "number" || entry.seen < 1) return undefined;
    if (Date.now() - entry.ts > LEARNED_IMAGE_COST_TTL_MS) return undefined;
    if (entry.fp !== fp) return undefined; // billing/cap reconfigured since learning
    let per = cap > 0 ? Math.min(entry.cost, cap) : entry.cost;
    if (typeof prior === "number" && prior > 0) {
        // Trust the learned value only within the encoder-variance band around the payload's
        // own prior; beyond it the residual has absorbed non-image mass (#4153) → clamp.
        per = Math.min(per, (LEARNED_VARIANCE_BAND * prior) / nImages);
    } else {
        per = Math.min(per, LEARNED_PER_IMAGE_MAX);
    }
    return per * nImages;
}

// #2868: compares UTF-8 BYTES — lcpBytes feeds byte thresholds and displays,
// so comparing UTF-16 code units misreported every non-ASCII offset.
function seamLcp(a: Buffer, b: Buffer): { lcpBytes: number; msgIndex: number | null; prevMsgs: number; curMsgs: number } {
    let lcp = 0;
    const n = Math.min(a.length, b.length);
    while (lcp < n && a[lcp] === b[lcp]) lcp++;
    // #2339: the message array lives under `messages` (Anthropic/chat), `input`
    // (Responses) or `contents` (Google native) — same caliber as the send-time
    // count captures (server.ts / loop/core.ts). Reading only `.messages` made
    // every Responses/Google pair parse to zero messages: msgIndex degenerated
    // to a fallback 0 that rendered as a real "message[0]", and the count-based
    // classification arms went dead on those wires. A capped head may end mid
    // character; toString("utf8") replaces it and the truncated JSON fails to
    // parse — the same outcome as before #2868.
    const msgsOf = (s: Buffer): unknown[] => {
        try {
            const p = JSON.parse(s.toString("utf8")) as { messages?: unknown; input?: unknown; contents?: unknown };
            const arr = p.messages ?? p.input ?? p.contents;
            return Array.isArray(arr) ? arr : [];
        } catch {
            return [];
        }
    };
    const ma = msgsOf(a);
    const mb = msgsOf(b);
    let i = 0;
    const eq = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
    while (i < Math.min(ma.length, mb.length) && eq(ma[i], mb[i])) i++;
    // null = position unknowable (neither side yielded a message list — capped or
    // unparseable body). A bare 0 would be a real head-break index, not a fallback.
    return { lcpBytes: lcp, msgIndex: ma.length > 0 && mb.length > 0 ? i : null, prevMsgs: ma.length, curMsgs: mb.length };
}

// #2131: byte-LCP WITHOUT the JSON parse seamLcp does — the per-call stability
// check runs on every settled pair and must stay cheap on multi-MiB bodies
// (message-level detail belongs to detectSeam's forensics path only).
// #2868: real bytes over the capture-time buffers — the old charCodeAt loop
// returned UTF-16 code units, so CJK offsets were short by up to 3× and the
// 1024-byte head threshold / ±64-byte append tolerance misfired on them.
function byteLcp(a: Buffer, b: Buffer): number {
    const n = Math.min(a.length, b.length);
    if (n === 0 || a[0] !== b[0]) return 0;
    // Same integer as the naive per-byte walk ("first k bytes equal" is
    // monotone in k), but binary search over k with native Buffer.compare
    // views (memcmp, no copies) — consecutive turns share the whole history
    // as prefix, so the walk was O(body) of interpreter steps every turn.
    let lo = 1;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (Buffer.compare(a.subarray(0, mid), b.subarray(0, mid)) === 0) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

// #3476: true iff `prev` is fully covered by the common prefix (length `lcp`)
// plus some common suffix (its middle residual is EMPTY) while `cur` carries
// extra bytes in that middle — a SEMANTIC append where one logical unit's
// interior grows in place (auto-review FILTERED_HISTORY + fixed PENDING_ACTION
// trailer). A genuine rewrite leaves a non-empty residual on the shorter side,
// so it is never matched here and stays "mid". Mirrors src/acp-cache-diff.ts.
function isMidInsertionAppend(prev: Buffer, cur: Buffer, lcp: number): boolean {
    if (cur.length <= prev.length || lcp >= prev.length) return false;
    const room = prev.length - lcp;
    // "the last k bytes of prev equal the last k of cur" is monotone in k —
    // the same native-compare binary search as byteLcp, over the suffix.
    let lo = 0;
    let hi = room;
    while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (Buffer.compare(prev.subarray(prev.length - mid), cur.subarray(cur.length - mid)) === 0) lo = mid;
        else hi = mid - 1;
    }
    return lcp + lo === prev.length;
}

// #2982: byte offset of the CLOSING bracket terminating the top-level
// messages/input/contents array (same key set as seamLcp's msgsOf), or null
// when the body carries no such array (or is not valid JSON). String-aware
// depth scan over the raw text instead of JSON.parse + re-serialization:
// re-serialized element offsets do not match the original text (whitespace),
// and one linear pass keeps multi-MiB bodies cheap. Runs only on pairs that
// would otherwise class "mid" — the hot path never pays for it.
// #2868: scans the UTF-8 Buffer directly, returning a BYTE offset comparable
// to byteLcp's result. Safe on multi-byte content: every delimiter checked
// here (quotes/backslash/braces/brackets/whitespace ≤0x20) is ASCII, and
// UTF-8 continuation bytes (0x80–0xBF) and lead bytes (0xC0+) can never
// equal an ASCII code point — a multi-byte character cannot hide or fake a
// delimiter. Escapes consume exactly one following byte, matching valid JSON
// where the escaped char after '\' is always ASCII.
function messagesArrayCloseOffset(body: Buffer): number | null {
    const n = body.length;
    let depth = 0; // object/array nesting depth
    let inStr = false;
    let want = -1; // depth at which the tracked array closes (-1 = not tracking)
    let keyAt = -1; // opening-quote offset of a candidate top-level key
    let i = 0;
    while (i < n) {
        const c = body[i];
        if (inStr) {
            if (c === 92) {
                // Backslash run: JSON parity — an odd-length run escapes the
                // single byte after it, an even run is pure content.
                let j = i;
                while (j < n && body[j] === 92) j++;
                i = (j - i) % 2 === 1 ? j + 1 : j;
                continue;
            }
            if (c === 34) {
                inStr = false;
                if (keyAt >= 0) {
                    // +1/-1 strip the surrounding quotes from the captured range.
                    const key = body.subarray(keyAt + 1, i).toString("utf8");
                    keyAt = -1;
                    // A top-level string VALUE is also seen at depth 1 — the
                    // following-colon check below is what separates keys from it.
                    if (depth === 1 && (key === "messages" || key === "input" || key === "contents")) {
                        let j = i + 1;
                        while (j < n && body[j] <= 32) j++;
                        if (body[j] === 58) { // ':'
                            j++;
                            while (j < n && body[j] <= 32) j++;
                            if (body[j] === 91) want = depth + 1; // '['
                        }
                    }
                }
                i++;
                continue;
            }
            // String content: hop to the next quote or backslash (native
            // scans) instead of branching per byte — the bulk of any body.
            let m = n;
            const q = body.indexOf(34, i + 1);
            if (q !== -1 && q < m) m = q;
            const b = body.indexOf(92, i + 1);
            if (b !== -1 && b < m) m = b;
            i = m;
            continue;
        }
        if (c === 34) { inStr = true; keyAt = depth === 1 ? i : -1; i++; continue; }
        if (c === 123 || c === 91) { depth++; i++; continue; }
        if (c === 125 || c === 93) {
            if (want !== -1 && c === 93 && depth === want) return i;
            depth--;
            i++;
            continue;
        }
        // Inter-token filler (whitespace/commas/colons/literals): hop to the
        // next structural byte, again natively.
        let m = n;
        for (const code of [34, 123, 125, 91, 93]) {
            const p = body.indexOf(code, i + 1);
            if (p !== -1 && p < m) m = p;
        }
        i = m;
    }
    return null;
}

function detectSeam(session: Session, led: CacheLedger): void {
    const line = led.lines[led.lines.length - 1];
    if (!line || line.unk === 1 || line.missed <= 0) return;
    // #1891: a no-baseline first bill has no prior prefix to break — its miss is
    // initial content. The rebooking above already zeroes its tr; this guard also
    // keeps it out of the rewind/provider-side body-pair classifications.
    if (line.nb === 1) return;
    // Abort correlation is counted for EVERY missed sample, independent of
    // structural attribution — abort/retry churn is orthogonal evidence.
    const abortAt = lastClientAbort.get(session);
    if (abortAt !== undefined && Math.abs(line.at - abortAt) < 30_000) {
        line.abortedNear = 1;
        led.agg.abortCorrelated += 1;
    }
    // Structural attributions already explain the miss — not a seam candidate. `cause` additionally covers
    // post-switch cold-tail continuations (they carry no sw/pw/uw flag); legacy lines lack it and keep old behavior.
    if (line.sw === 1 || line.pw === 1 || line.uw === 1 || line.rs === 1 || line.cause !== undefined || line.foldSeq !== null) return;
    // Substantive unexplained residual only: a big ttlRepay slice of a big bill.
    if (!(line.tr > 8192 && line.tr > 0.3 * line.input)) return;
    const agg = led.agg;
    const cur = pendingCapture(session).sentBody;
    const prev = session.transient?.settledBody;
    if (cur?.order !== undefined && prev?.order !== undefined && cur.order <= prev.order) {
        line.evidence = "out-of-order";
        return;
    }
    // #2929: split the provider-side arms by idle gap — a byte-stable miss
    // after a long idle is normal TTL expiry; the same miss seconds after the
    // previous request is the abnormal provider-side failure.
    const prevSampleAt = led.lines.length >= 2 ? led.lines[led.lines.length - 2].at : line.at;
    const ttlExpired = line.at - prevSampleAt > PROVIDER_TTL_GAP_MS;
    const bookProvider = (): void => {
        line.prov = ttlExpired ? "ttl" : "side";
        if (ttlExpired) {
            agg.providerTtlMisses += 1;
            agg.providerTtlMissed += line.tr;
        } else {
            agg.providerSideMisses += 1;
            agg.providerSideMissed += line.tr;
        }
    };
    let f: ReturnType<typeof seamLcp> | undefined;
    if (cur !== undefined && prev !== undefined) {
        f = seamLcp(prev.head, cur.head);
        // #2131: a body stored at full length is readable; one clipped at
        // SEAM_BODY_CAP parses to zero messages, so parse-derived arms below
        // only decide pairs where that side is under the cap. #2868: capped
        // means CLIPPED (bytes > cap) — an exactly-at-cap body is fully stored.
        const prevCapped = prev.bytes > SEAM_BODY_CAP;
        const curCapped = cur.bytes > SEAM_BODY_CAP;
        // Client reverted/trimmed history: the miss is the sanctioned
        // one-time re-bill of the retained prefix (or the gap's TTL). Only
        // trust the parsed counts when BOTH sides are fully stored — a side
        // clipped at SEAM_BODY_CAP parses to zero messages and would fake a
        // shrink (or hide one); those pairs go to the #2131 byte/count arms.
        if (!prevCapped && !curCapped && f.prevMsgs > 0 && f.curMsgs < f.prevMsgs) {
            line.prov = "rewind";
            agg.rewinds += 1;
            agg.rewindMissed += line.tr;
            return;
        }
        if (cur.head.byteLength < prev.head.byteLength && f.lcpBytes >= cur.head.byteLength - 4) {
            // #2131: the WHOLE current payload survives inside the previous
            // one — a JSON array only diverges from its own longer superstring
            // in the closing-bracket region (the 4-byte tolerance), so this is
            // a sanctioned client-side trim/fold re-bill of the retained prefix,
            // NOT a provider miss. Must run before the byte-stable arm, which
            // would otherwise read "all of cur survives" and book it provider-side.
            line.prov = "rewind";
            agg.rewinds += 1;
            agg.rewindMissed += line.tr;
            return;
        }
        if (f.lcpBytes >= cur.head.byteLength) {
            // Wire was byte-stable against the previous request — the
            // upstream simply did not serve its cache. Provider-side. Above
            // the cap this covers the identical-recorded-head case: anything
            // past SEAM_BODY_CAP is beyond recorded evidence either way.
            bookProvider();
            return;
        }
        // #2059: tail-append turns — the previous request's ENTIRE message list
        // survives byte-identically as this one's prefix (msgIndex == prevMsgs)
        // and only the tail grew, so there is NO mid-history break: provider-side
        // again. The byte-LCP test above can't see it (it demands the whole body
        // match, which a growing conversation never satisfies), so before this the
        // common append+no-cache case falsely cried seam. Both bodies must be
        // uncapped: one truncated at SEAM_BODY_CAP parses to zero messages and
        // would fake the msgIndex == prevMsgs == 0 signature; prevMsgs > 0 keeps
        // an empty prior list out.
        if (!prevCapped && !curCapped && f.prevMsgs > 0 && f.msgIndex === f.prevMsgs && f.curMsgs > f.prevMsgs) {
            bookProvider();
            return;
        }
        if (prev.head.byteLength < cur.head.byteLength && f.lcpBytes >= prev.head.byteLength - 4) {
            // #2131: the WHOLE previous payload survives inside the longer
            // current one (JSON appends diverge only in the previous body's
            // closing-bracket region — the 4-byte tolerance). Under the cap the
            // #2059 arm above already decided clean appends, so reaching here
            // means a clipped side was involved and the parsed counts are blind;
            // the exact counts captured at send time must prove pure tail
            // growth. Without them the pair is indistinguishable from a real
            // break and falls through to suspect.
            if (prev.msgs !== null && cur.msgs !== null && cur.msgs > prev.msgs) {
                bookProvider();
                return;
            }
        }
        // No decisive byte/count shape (visible break in the recorded region,
        // or capped evidence without exact counts): suspect — unless the CLIENT
        // pair proves the break is host-owned (#3023).
    }
    // #3023: client-side mid-history rewrite — the client's own resent list
    // broke mid-list (insert/rewrite at index k, k < min(prevMsgs, curMsgs)),
    // so bili's faithful rebuild carried the break to the wire and the miss
    // belongs to the host (another plugin, paste hoisting, re-render), NOT to
    // a bili rebuild seam. Requires BOTH inbound slots captured whole
    // (msgs <= INBOUND_MSG_CAP — an above-cap list cannot prove where it
    // broke, and a missing lane capture must keep the legacy bucket).
    const curIn = pendingCapture(session).inBody;
    const prevIn = session.transient?.settledInBody;
    if (curIn !== undefined && prevIn !== undefined && curIn.msgs <= INBOUND_MSG_CAP && prevIn.msgs <= INBOUND_MSG_CAP) {
        const k = firstDivergentInboundMsg(prevIn, curIn);
        if (k !== null && k < Math.min(prevIn.msgs, curIn.msgs)) {
            line.prov = "client";
            agg.clientInserts += 1;
            agg.clientInsertMissed += line.tr;
            const m = curIn.meta[k] ?? { role: "?", len: 0, cls: "?" };
            if (cur !== undefined && prev !== undefined) {
                if (led.seamEvents !== undefined && led.seamEvents.length >= SEAM_EVENTS_CAP) led.seamEvents.shift();
                const forensics = f ?? seamLcp(prev.head, cur.head);
                (led.seamEvents ?? (led.seamEvents = [])).push({ seq: line.seq, at: line.at, input: line.input, hitPct: line.hitPct ?? 0, ...forensics, prevMsgs: prev.msgs ?? forensics.prevMsgs, curMsgs: cur.msgs ?? forensics.curMsgs, client: { idx: k, role: m.role, len: m.len, cls: m.cls } });
            }
            if (agg.clientInserts === 1) {
                loggerLog("warn", `[${session.id}] [cache-seam] client-side mid-history rewrite: hit ${line.hitPct}% (input=${line.input}, unexplained=${Math.round(line.tr)} tok) — the client's resent history diverged at inbound message[${k}] of ${prevIn.msgs}→${curIn.msgs} (${m.role}/${m.cls}, ${m.len}B JSON), so the wire break is the host's own churn, not a bili rebuild (#3023)`);
            }
            return;
        }
        // Inbound prefix-stable or a clean tail boundary: the outbound
        // mid-list break is bili-side — fall through to the seam bucket.
    }
    // #3769: a proactive failed-compress cleanup (orphan rotation) landed in this
    // window. After the fold-gated fix such a cleanup only rides along a committed
    // fold, which claims its own break above via foldSeq — so reaching here means a
    // mid-history break coincided with a cleanup WITHOUT any fold/switch/restart/
    // client arm claiming it. Attribute it to the cleanup rather than leave it
    // "unexplained". Additive: none of the earlier arms is touched.
    if ((led.sweepThisSample ?? 0) > 0) {
        line.prov = "orphan-sweep";
        agg.orphanSweepSeams += 1;
        agg.orphanSweepMissed += line.tr;
        if (agg.orphanSweepSeams === 1) {
            loggerLog("warn", `[${session.id}] [cache-seam] mid-history break attributed to proactive failed-compress cleanup (${led.sweepThisSample} record(s) rotated out, #3769): hit ${line.hitPct}% (unexplained=${Math.round(line.tr)} tok) — no fold claimed this break`);
        }
        return;
    }
    agg.seamSuspects += 1;
    agg.seamMissed += line.tr;
    line.seam = 1;
    if (cur !== undefined && prev !== undefined && led.seamEvents !== undefined && led.seamEvents.length >= SEAM_EVENTS_CAP) {
        led.seamEvents.shift();
    }
    if (cur !== undefined && prev !== undefined) {
        const forensics = f ?? seamLcp(prev.head, cur.head);
        const ev: SeamEvent = { seq: line.seq, at: line.at, input: line.input, hitPct: line.hitPct ?? 0, ...forensics, prevMsgs: prev.msgs ?? forensics.prevMsgs, curMsgs: cur.msgs ?? forensics.curMsgs };
        (led.seamEvents ?? (led.seamEvents = [])).push(ev);
        if (agg.seamSuspects === 1) {
            loggerLog("warn", `[${session.id}] [cache-seam] suspected mid-history prefix break: hit ${line.hitPct}% (input=${line.input}, unexplained=${Math.round(line.tr)} tok, no fold/switch/restart attribution); first divergence at byte ${ev.lcpBytes}, message[${ev.msgIndex ?? "?"}] of ${ev.prevMsgs}→${ev.curMsgs} — see /acp-cache for the seam section`);
        }
    } else if (agg.seamSuspects === 1) {
        loggerLog("warn", `[${session.id}] [cache-seam] suspected mid-history prefix break: hit ${line.hitPct}% (input=${line.input}, unexplained=${Math.round(line.tr)} tok, no fold/switch/restart attribution); outbound body pair unavailable (lane without body capture) — aggregate flag only`);
    }
}

export function getCacheLedger(session: Session): CacheLedger {
    const meta = session.metadata ?? (session.metadata = {});
    const existing = meta[LEDGER_KEY] as CacheLedger | undefined;
    if (existing && existing.v === 1) {
        // Ledgers persisted before #1535/#1536 lack the newer counters — normalize
        // in place so later arithmetic never sees undefined.
        const g = existing.agg;
        for (const key of [
            "switches", "switchMissed", "effSwitches", "effSwitchMissed", "keySwitches", "keySwitchMissed", "promptSwitches", "promptSwitchMissed", "projSwitches", "projSwitchMissed", "wireSwitches", "wireSwitchMissed",
            "upstreamSwitches", "upstreamSwitchMissed", "restartDrops",
            "restartDropMissed", "attributedMissed", "unknownSamples", "unknownInput",
            "nbSamples", "nbInput",
            "seamSuspects", "seamMissed",
            "providerSideMisses", "providerSideMissed", "providerTtlMisses", "providerTtlMissed", "rewinds", "rewindMissed", "abortCorrelated", "clientInserts", "clientInsertMissed", "orphanSweepSeams", "orphanSweepMissed",
        ] as const) {
            if (typeof g[key] !== "number") g[key] = 0;
        }
        return existing;
    }
    // Bootstrap: blocks already present predate ledger tracking — record
    // their high-water mark WITHOUT fold events (no usage baseline existed).
    const maxBlockId = (session.state?.blocks ?? []).reduce((n, b) => Math.max(n, refNum(b.blockId)), 0);
    const led: CacheLedger = {
        v: 1,
        lastBlockId: maxBlockId,
        consumedFoldSeq: 0,
        sampleSeq: 0,
        foldSeqCounter: 0,
        folds: [],
        lines: [],
        agg: { requests: 0, input: 0, cached: 0, output: 0, nc: 0, cr: 0, tr: 0, switches: 0, switchMissed: 0, effSwitches: 0, effSwitchMissed: 0, keySwitches: 0, keySwitchMissed: 0, promptSwitches: 0, promptSwitchMissed: 0, projSwitches: 0, projSwitchMissed: 0, wireSwitches: 0, wireSwitchMissed: 0, upstreamSwitches: 0, upstreamSwitchMissed: 0, restartDrops: 0, restartDropMissed: 0, attributedMissed: 0, unknownSamples: 0, unknownInput: 0, nbSamples: 0, nbInput: 0, seamSuspects: 0, seamMissed: 0, providerSideMisses: 0, providerSideMissed: 0, providerTtlMisses: 0, providerTtlMissed: 0, rewinds: 0, rewindMissed: 0, abortCorrelated: 0, clientInserts: 0, clientInsertMissed: 0, orphanSweepSeams: 0, orphanSweepMissed: 0 },
    };
    meta[LEDGER_KEY] = led;
    return led;
}

function pushFold(led: CacheLedger, f: Omit<LedgerFold, "seq" | "T" | "hPct" | "requestsAfter" | "k">): void {
    // Freeze k = samples since each open fold (#1286): samples arrive in
    // order, so at this instant the count equals the batch-path
    // turnsToNextFold window (f.at < s.at <= nextFold.at); requestsAfter
    // keeps growing afterward to the full post-fold total.
    for (const open of led.folds) {
        if (open.k === null) open.k = open.requestsAfter;
    }
    led.foldSeqCounter += 1;
    led.folds.push({ ...f, seq: led.foldSeqCounter, T: 0, hPct: null, requestsAfter: 0, k: null });
}

/** Record compression folds materialized as new kernel blocks. Proxy mode
 *  calls this eagerly at the applyCompression site; plugin mode folds are
 *  caught lazily by detectNewFolds() via the blockId high-water mark. */
export function recordCacheFoldsFromBlocks(session: Session, blocks: CompressionBlock[], geo?: { V?: number; Vp?: number }): void {
    if (blocks.length === 0) return;
    const led = getCacheLedger(session);
    for (const b of blocks) {
        const id = refNum(b.blockId);
        if (id <= led.lastBlockId) continue;
        pushFold(led, {
            at: b.createdAt || Date.now(),
            S: b.compressedTokens,
            sigma: Math.ceil(b.summary.length / 4),
            X: b.startRef ? prefixTokensBeforeRef(session, b.startRef) : undefined,
            V: geo?.V,
            Vp: geo?.Vp,
            bid: b.blockId,
        });
        led.lastBlockId = Math.max(led.lastBlockId, id);
    }
}

function detectNewFolds(session: Session, led: CacheLedger): void {
    const blocks = session.state?.blocks ?? [];
    let maxId = led.lastBlockId;
    for (const b of blocks) maxId = Math.max(maxId, refNum(b.blockId));
    if (maxId > led.lastBlockId) {
        recordCacheFoldsFromBlocks(session, blocks.filter((b) => refNum(b.blockId) > led.lastBlockId));
    }
}

// #3769: sweptOrphanCallIds is monotonic, so its length high-water makes growth
// exact. detectSeam's orphan-sweep arm reads sweepThisSample set here.
function detectOrphanSweeps(session: Session, led: CacheLedger): void {
    const n = session.state?.sweptOrphanCallIds?.length ?? 0;
    // First observation only baselines: a resumed session's pre-existing sweeps
    // must not be charged to the current sample.
    if (led.lastSweptCount === undefined) {
        led.lastSweptCount = n;
        led.sweepThisSample = 0;
        return;
    }
    const delta = n - led.lastSweptCount;
    led.lastSweptCount = n;
    led.sweepThisSample = delta > 0 ? delta : 0;
}

/** Record one provider usage report into the session ledger. `input` must be
 *  NORMALIZED (cached included — promptInputTotal semantics). `cached === null`
 *  means the provider reported NO cache-hit tokens (unmeasurable): such samples
 *  are quarantined out of the closure totals instead of booking their whole
 *  billed prefix as an unexplained ttlRepay residual (#1536). */
export function recordCacheSample(
    session: Session,
    s: { at: number; input: number; cached: number | null; output?: number; protocol?: string; upstream?: string; keyFp?: string; sysFp?: string; canonFp?: string; mode?: "plugin" | "proxy"; effFp?: string },
): void {
    const led = getCacheLedger(session);
    detectNewFolds(session, led);
    detectOrphanSweeps(session, led);
    const prevLine = led.lines[led.lines.length - 1];
    // #1536: unknown-cache samples still need a prev/cur pair so the fold chain
    // stays consistent, but decompose with cached=0 then QUARANTINE every derived
    // bucket (line missed/nc/cr/tr forced to 0 + excluded from agg below).
    const known = s.cached !== null;
    const effCached: number = s.cached ?? 0;
    const eff = typeof s.effFp === "string" && s.effFp !== "" ? s.effFp : undefined;
    // Same window as buildCacheReport: a fold counts once its timestamp has
    // elapsed (f.at <= s.at), never earlier — keeps incremental and batch math
    // identical under clock skew between block.createdAt and settle time.
    // #2929: the window is now the fold's COLD TAIL (mirror of the kernel's
    // buildCacheReport): the first following sample is claimed
    // unconditionally, then cold continuations are claimed until a warm line
    // (>= FOLD_CLAIM_WARM_HIT_PCT) proves re-cache or FOLD_CLAIM_COLD_ROUNDS
    // samples have elapsed. Before this, the first measurable sample consumed
    // the fold, so the client-echo re-bill ~25–66s later carried no fold stamp,
    // fell into the unattributed ttlRepay residual, and tripped the seam
    // detector with "no fold attribution" (#2929's seven seams were exactly
    // this shape, 25–66s after a degenerate head fold).
    const warmLine =
        known && s.input > 0 && (effCached / s.input) * 100 >= FOLD_CLAIM_WARM_HIT_PCT;
    const pendRefs = led.folds.filter(
        (f) => f.at <= s.at && !f.retired && ((f.claims ?? 0) === 0 || !warmLine),
    );
    const pending: FoldEvent[] = pendRefs.map((f) => ({
        at: f.at,
        tokensCompressed: f.S,
        summaryTokens: f.sigma,
        firstFoldStartTokens: f.X,
        viewBefore: f.V,
        viewAfter: f.Vp,
    }));
    // #3307 P2-A: f.X (firstFoldStartTokens) is prefixTokensBeforeRef over the
    // client's UN-SHRUNKEN resent history — for a stateless proxy client that far
    // exceeds the billed input, so decomposeSample zeroes structuralExcess and the
    // fold's re-pay falls into the unattributed seam bucket. When a genuine
    // bili-side mid-history break is present, measure the stable prefix straight
    // off the wire instead: the byte-LCP between this outbound and the previous
    // marks where a summary replaced folded content, so (lcpBytes / cur.bytes) *
    // billed input is a same-space lower bound on the pre-fold prefix. min() with
    // the snapshot X leaves already-correct folds untouched. Gated to mid-list
    // breaks only (a tail append lands lcpBytes near the end -> xMeasured ~= input
    // -> no effect) and never on a client-side inbound rewrite (#3023), whose
    // earlier divergence would understate the fold and mis-credit it.
    if (pending.length > 0 && known && s.input > 0) {
        const rawMissed = s.input - effCached;
        if (rawMissed > 8192 && rawMissed > 0.3 * s.input) {
            // #4731: both pending sides come from ONE source via
            // pendingEvidencePair — on the relay lane the evidence lives in
            // the #4430 ALS capture (session.transient.sentBody is never
            // written there), on the loop lane it falls back to the transient
            // slot byte-identically.
            const { sentBody: curB, inBody: curIn } = pendingEvidencePair(session);
            const prevB = session.transient?.settledBody;
            if (curB !== undefined && prevB !== undefined && curB.bytes <= SEAM_BODY_CAP && prevB.bytes <= SEAM_BODY_CAP) {
                const prevIn = session.transient?.settledInBody;
                const clientBreak = curIn !== undefined && prevIn !== undefined && curIn.msgs <= INBOUND_MSG_CAP && prevIn.msgs <= INBOUND_MSG_CAP && (() => {
                    const k = firstDivergentInboundMsg(prevIn, curIn);
                    return k !== null && k < Math.min(prevIn.msgs, curIn.msgs);
                })();
                if (!clientBreak) {
                    const lcp = seamLcp(prevB.head, curB.head);
                    if (lcp.msgIndex !== null && lcp.prevMsgs > 0 && lcp.msgIndex < lcp.prevMsgs && lcp.lcpBytes > 0 && lcp.lcpBytes < curB.head.byteLength) {
                        const xMeasured = Math.round(s.input * (lcp.lcpBytes / curB.bytes));
                        for (const p of pending) p.firstFoldStartTokens = Math.min(p.firstFoldStartTokens ?? Number.POSITIVE_INFINITY, xMeasured);
                    }
                }
            }
        }
    }
    const rawDec = decomposeSample(
        prevLine ? { at: prevLine.at, input: prevLine.input, cached: prevLine.cached } : null,
        { at: s.at, input: s.input, cached: effCached },
        pending,
    );
    // #1891: a sample with NO previous baseline (the session's first measurable
    // bill) has no prior prefix that could have expired — decomposeSample's
    // prev=null path forces growth=0 and books the ENTIRE uncached input as
    // ttlRepay, which detectSeam then misreads as an unexplained mid-history
    // break (every field-flagged event in #1891 was exactly this shape). Rebook
    // the residual as new content: missed === nc+cr+tr holds either way, so the
    // closure stays balanced and only the bucket moves.
    const noBaseline = !prevLine && known;
    const dec = noBaseline
        ? { ...rawDec, newContent: rawDec.newContent + rawDec.ttlRepay, ttlRepay: 0 }
        : rawDec;
    let foldSeq: number | null = null;
    if (known && dec.foldIndex !== null) foldSeq = pendRefs[dec.foldIndex]?.seq ?? null;
    // Advance the claim window only for measurable samples: an unknown
    // sample must not eat a fold, or its compRepay would never reach a fold owner.
    // #2929: each claimed sample bumps the fold's claim count; warm line or
    // the FOLD_CLAIM_COLD_ROUNDS bound retires it (consumedFoldSeq stays the
    // high-water mark of RETIRED folds for schema compat).
    if (known && pendRefs.length > 0) {
        for (const f of pendRefs) {
            f.claims = (f.claims ?? 0) + 1;
            if (f.claims >= FOLD_CLAIM_COLD_ROUNDS) {
                f.retired = true;
                led.consumedFoldSeq = Math.max(led.consumedFoldSeq, f.seq);
            }
        }
    }
    // A warm line retires EVERY open window — claimed or not this sample
    // (#1847 discipline): it proves the provider re-cached, so a later cold
    // blip is a new, unrelated event and must not be swallowed by the fold.
    if (known && warmLine) {
        for (const f of led.folds) {
            if (f.at <= s.at && !f.retired) {
                f.retired = true;
                led.consumedFoldSeq = Math.max(led.consumedFoldSeq, f.seq);
            }
        }
    }
    const hitPct: number | null = known && s.input > 0 ? round1((effCached / s.input) * 100) : null;
    // Target identity (#1535 model, generalized to model|wire|upstream in #1536):
    // each component flags only when BOTH sides are known (unknown never flags).
    const model = typeof session.metadata?.lastModel === "string" && session.metadata.lastModel !== ""
        ? session.metadata.lastModel
        : undefined;
    const proto = typeof s.protocol === "string" && s.protocol !== "" ? s.protocol : undefined;
    const up = typeof s.upstream === "string" && s.upstream !== "" ? s.upstream : undefined;
    // #2131: credential fingerprint — the fourth identity component. Same
    // never-flags-on-unknown rule: a lane without header capture must not
    // fabricate switch events.
    const key = typeof s.keyFp === "string" && s.keyFp !== "" ? s.keyFp : undefined;
    // #2350: system-prompt fingerprint — the fifth identity component, same
    // never-flags-on-unknown rule as the others.
    const sys = typeof s.sysFp === "string" && s.sysFp !== "" ? s.sysFp : undefined;
    // #2867: canonical INCOMING system/developer fingerprint (mode-independent).
    // Pairs with `sys`: a flipped `sys` with a STABLE canon means bili's own
    // compression-mode/projection switch moved what was forwarded, not the host.
    const canon = typeof s.canonFp === "string" && s.canonFp !== "" ? s.canonFp : undefined;
    // #1847: detect a dimension change against the last KNOWN value, not the immediately-previous
    // line — an unmeasured (null-cache) request at the switch boundary must not swallow the flag,
    // or the following measured cold re-bill lands unattributed. Unknown samples never advance it.
    const modelSwitched = known && model !== undefined && led.lastKnownModel !== undefined && model !== led.lastKnownModel;
    const effortSwitched = known && eff !== undefined && led.lastKnownEff !== undefined && eff !== led.lastKnownEff;
    const wireSwitched = known && proto !== undefined && led.lastKnownProto !== undefined && proto !== led.lastKnownProto;
    const upstreamSwitched = known && up !== undefined && led.lastKnownUp !== undefined && up !== led.lastKnownUp;
    const keySwitched = known && key !== undefined && led.lastKnownKey !== undefined && key !== led.lastKnownKey;
    const promptSwitched = known && sys !== undefined && led.lastKnownSp !== undefined && sys !== led.lastKnownSp;
    // #2867: projection-flip = forwarded system bytes changed but the canonical
    // incoming view did NOT (both sides known — an unknown side keeps the legacy
    // host-side reading, never a fabricated projection claim).
    const canonSwitched = known && canon !== undefined && led.lastKnownCanon !== undefined && canon !== led.lastKnownCanon;
    const projFlip = promptSwitched && !canonSwitched && canon !== undefined && led.lastKnownCanon !== undefined;
    // #499: first KNOWN sample under a fresh daemon boot with prior history →
    // proxy-restart / re-fork boundary (upstream KV dropped during downtime).
    const restarted = known && led.lines.length > 0 && led.lastBoot !== undefined && led.lastBoot !== BOOT_ID;
    // #1286: turn counting is decoupled from compRepay attribution — the
    // consumedFoldSeq gate above applies to the pending list only. Every
    // elapsed fold counts EVERY later sample, matching buildCacheReport's
    // full post-fold requestsAfter window. hPct seeds from the first KNOWN
    // post-fold sample only (unknown samples carry no measurable hit rate).
    // #2202: condition the benefit claim on measured coverage. requestsAfter
    // multiplies (S−σ) into the avoided-token projection — booking a request
    // against a fold whose covered bytes are no longer on the wire bills a
    // saving that stopped happening (#2193: netSaved climbed through a
    // destroyed substrate). The fraction comes from reconcileFoldCoverage's
    // per-block record, measured on THIS request's inbound (the wire sites'
    // reconcile pass precedes the usage report that settles here):
    //   1 — full coverage, legacy entries without a block link, or the
    //       never-present class (structural absence, unverifiable) → identical
    //       to the pre-#2202 counter;
    //   f — partial coverage → proportional accrual;
    //   0 — verified coverage-lost → accrual frozen until coverage returns.
    const covAll = session.metadata[METADATA_FOLD_COVERAGE] as Record<string, { p?: number; r?: number; t?: number; e?: 1 }> | undefined;
    const lostLogged = (session.metadata[LOST_LOGGED_KEY] as Record<string, true> | undefined) ?? {};
    let lostDirty = false;
    for (const f of led.folds) {
        if (f.at <= s.at) {
            const cov = f.bid !== undefined ? covAll?.[f.bid] : undefined;
            let frac = 1;
            let lost: boolean | null = null;
            if (cov !== undefined && cov.e === 1 && typeof cov.t === "number" && cov.t > 0) {
                const present = (cov.p ?? 0) + (cov.r ?? 0);
                frac = Math.min(1, present / cov.t);
                lost = present === 0;
            }
            f.requestsAfter += frac;
            if (known && f.hPct === null) f.hPct = hitPct;
            if (lost !== null && f.bid !== undefined) {
                if (lost && lostLogged[f.bid] !== true) {
                    lostLogged[f.bid] = true;
                    lostDirty = true;
                    loggerLog("warn", `[${session.id}] [cache-ledger] fold seq ${f.seq} (block ${f.bid}) coverage-lost: covered id(s) no longer on the resent wire — avoided-token accrual frozen at requestsAfter=${f.requestsAfter.toFixed(1)} (#2202)`);
                } else if (!lost && lostLogged[f.bid] === true) {
                    delete lostLogged[f.bid];
                    lostDirty = true;
                    loggerLog("info", `[${session.id}] [cache-ledger] fold seq ${f.seq} (block ${f.bid}) coverage restored — avoided-token accrual resumes (#2202)`);
                }
            }
        }
    }
    if (lostDirty) session.metadata[LOST_LOGGED_KEY] = lostLogged;
    if (foldSeq !== null) {
        const owner = led.folds.find((f) => f.seq === foldSeq);
        if (owner) owner.T += dec.compRepay;
    }
    led.sampleSeq += 1;
    // #1847: attribute this sample's stable-prefix residual to AT MOST ONE named cause — a partition,
    // not overlapping charges. Priority: restart drops every KV entry regardless of identity; then
    // identity changes (model recomputes everything, wire/upstream re-route); plain TTL expiry is the
    // unattributed remainder. A changed dimension also claims the bounded post-switch cold tail until a
    // warm line proves re-cache — so a switch that cools several rounds is fully charged to it.
    const isWarm = known && s.input > 0 && (hitPct ?? 0) >= WARM_HIT_PCT;
    const seq = led.sampleSeq;
    const contWithin = (inv: { seq: number } | undefined): boolean =>
        inv !== undefined && !isWarm && seq - inv.seq <= SWITCH_COLD_ROUNDS;
    // A fresh change on THIS line outranks any prior-line continuation; among fresh changes use the fixed
    // priority; with none, fall to the highest-priority dimension whose cold window is still open.
    // #2131: `key` sits between model and wire — a rotated account on the same
    // URL/model is more specific than a wire change and produces the same
    // full-cold re-bill a model change does.
    // #2350: `prompt` sits between key and wire — a host system-prompt rewrite
    // is more specific than a wire/upstream re-route and drops every downstream
    // prefix cache entry just like a key rotation does.
    // #2867: `projection` sits behind prompt — a forwarded-system flip whose
    // canonical incoming view stayed stable is bili's own mode/projection
    // switch (self-heal degrade-to-proxy), same full-cold shape, different actor.
    const freshCause: "restart" | "model" | "effort" | "key" | "prompt" | "projection" | "wire" | "upstream" | null =
        restarted ? "restart"
            : modelSwitched ? "model"
            : effortSwitched ? "effort"
            : keySwitched ? "key"
            : (promptSwitched && !projFlip) ? "prompt"
            : projFlip ? "projection"
            : wireSwitched ? "wire"
            : upstreamSwitched ? "upstream"
            : null;
    const cause: "restart" | "model" | "effort" | "key" | "prompt" | "projection" | "wire" | "upstream" | null =
        freshCause !== null ? freshCause
            : contWithin(led.invModel) ? "model"
            : contWithin(led.invEff) ? "effort"
            : contWithin(led.invKey) ? "key"
            : contWithin(led.invSp) ? "prompt"
            : contWithin(led.invProj) ? "projection"
            : contWithin(led.invWire) ? "wire"
            : contWithin(led.invUp) ? "upstream"
            : null;
    led.lines.push({
        seq: led.sampleSeq,
        at: s.at,
        input: s.input,
        cached: effCached,
        output: s.output ?? 0,
        hitPct,
        missed: known ? dec.missed : 0,
        nc: known ? dec.newContent : 0,
        cr: known ? dec.compRepay : 0,
        tr: known ? dec.ttlRepay : 0,
        foldSeq,
        model,
        proto,
        up,
        kp: key,
        sp: sys,
        efp: eff,
        sw: modelSwitched ? 1 : undefined,
        ef: effortSwitched ? 1 : undefined,
        pw: wireSwitched ? 1 : undefined,
        uw: upstreamSwitched ? 1 : undefined,
        kw: keySwitched ? 1 : undefined,
        sf: promptSwitched ? 1 : undefined,
        pf: projFlip ? 1 : undefined,
        cf: !promptSwitched && canonSwitched ? 1 : undefined,
        pm: s.mode,
        rs: restarted ? 1 : undefined,
        unk: known ? undefined : 1,
        nb: noBaseline ? 1 : undefined,
        cause: known && cause !== null ? cause : undefined,
    });
    led.lastBoot = BOOT_ID;
    const agg = led.agg;
    agg.requests += 1;
    agg.output += s.output ?? 0;
    if (!known) {
        // Unmeasurable: quarantine the whole billed prefix out of the closure.
        agg.unknownInput += s.input;
        agg.unknownSamples += 1;
        return;
    }
    agg.input += s.input;
    agg.cached += effCached;
    agg.nc += dec.newContent;
    agg.cr += dec.compRepay;
    agg.tr += dec.ttlRepay;
    // #2784: event counters follow the SAME rule as the token partition — one line, exactly ONE narrative
    // cause. One user action often flips several identity dimensions at once (dsh's model switch re-renders
    // the model name into its system prompt, so the prompt fingerprint flips on the SAME line as the model
    // change); counting the shadowed dimensions narrates one action twice and the web panel renders them as
    // independent zero-token causes ("prompt rewrite 0 x1"). The raw observation stays on the line itself
    // (per-dimension flags + values + the winning cause), so forensics lose nothing. Token buckets charge
    // EXACTLY the primary cause so the per-cause breakdown partitions the residual instead of overlapping it.
    if (freshCause === "restart") agg.restartDrops += 1;
    else if (freshCause === "model") agg.switches += 1;
    else if (freshCause === "effort") agg.effSwitches += 1;
    else if (freshCause === "key") agg.keySwitches += 1;
    else if (freshCause === "prompt") agg.promptSwitches += 1;
    else if (freshCause === "projection") agg.projSwitches += 1;
    else if (freshCause === "wire") agg.wireSwitches += 1;
    else if (freshCause === "upstream") agg.upstreamSwitches += 1;
    if (cause === "model") agg.switchMissed += dec.ttlRepay;
    else if (cause === "effort") agg.effSwitchMissed += dec.ttlRepay;
    else if (cause === "key") agg.keySwitchMissed += dec.ttlRepay;
    else if (cause === "prompt") agg.promptSwitchMissed += dec.ttlRepay;
    else if (cause === "projection") agg.projSwitchMissed += dec.ttlRepay;
    else if (cause === "wire") agg.wireSwitchMissed += dec.ttlRepay;
    else if (cause === "upstream") agg.upstreamSwitchMissed += dec.ttlRepay;
    else if (cause === "restart") agg.restartDropMissed += dec.ttlRepay;
    if (cause !== null) agg.attributedMissed += dec.ttlRepay;
    // Advance the trackers (measured samples only): a warm line retires every open cold-window, an expired
    // window drops out, and a fresh change opens/replaces it.
    if (isWarm) {
        led.invModel = undefined;
        led.invEff = undefined;
        led.invWire = undefined;
        led.invUp = undefined;
        led.invKey = undefined;
        led.invSp = undefined;
        led.invProj = undefined;
    } else {
        if (led.invModel && seq - led.invModel.seq > SWITCH_COLD_ROUNDS) led.invModel = undefined;
        if (led.invEff && seq - led.invEff.seq > SWITCH_COLD_ROUNDS) led.invEff = undefined;
        if (led.invWire && seq - led.invWire.seq > SWITCH_COLD_ROUNDS) led.invWire = undefined;
        if (led.invUp && seq - led.invUp.seq > SWITCH_COLD_ROUNDS) led.invUp = undefined;
        if (led.invKey && seq - led.invKey.seq > SWITCH_COLD_ROUNDS) led.invKey = undefined;
        if (led.invSp && seq - led.invSp.seq > SWITCH_COLD_ROUNDS) led.invSp = undefined;
        if (led.invProj && seq - led.invProj.seq > SWITCH_COLD_ROUNDS) led.invProj = undefined;
    }
    if (modelSwitched) led.invModel = { seq, at: s.at, from: led.lastKnownModel ?? null, to: model! };
    if (effortSwitched) led.invEff = { seq, at: s.at, from: led.lastKnownEff ?? null, to: eff! };
    if (wireSwitched) led.invWire = { seq, at: s.at, from: led.lastKnownProto ?? null, to: proto! };
    if (upstreamSwitched) led.invUp = { seq, at: s.at, from: led.lastKnownUp ?? null, to: up! };
    if (keySwitched) led.invKey = { seq, at: s.at, from: led.lastKnownKey ?? null, to: key! };
            // #2867: a pure projection flip also sets promptSwitched (the
            // forwarded bytes did change) — opening invSp as well would let
            // the cold tail re-charge "prompt" for the proxy's own mode
            // switch. Only the host-side reading owns invSp.
            if (promptSwitched && !projFlip) led.invSp = { seq, at: s.at, from: led.lastKnownSp ?? null, to: sys! };
    if (projFlip) led.invProj = { seq, at: s.at, from: led.lastKnownSp ?? null, to: sys! };
    if (model !== undefined) led.lastKnownModel = model;
    if (eff !== undefined) led.lastKnownEff = eff;
    if (proto !== undefined) led.lastKnownProto = proto;
    if (up !== undefined) led.lastKnownUp = up;
    if (key !== undefined) led.lastKnownKey = key;
    if (sys !== undefined) led.lastKnownSp = sys;
    if (canon !== undefined) led.lastKnownCanon = canon;
    if (noBaseline) {
        agg.nbSamples += 1;
        agg.nbInput += s.input;
    }
}

/** #1547: single settle path for one successful upstream turn's usage report.
 *  All three response shapes — loop SSE (recordUsage), plugin pipes
 *  (applyUsageSample) and the non-streaming rewriter (server.ts forward) —
 *  route their input-side stats + ledger sample through here, so session.stats
 *  and the cache ledger can never drift apart per response shape again. The
 *  caller keeps its own settle-decision gate, log line, collapse watch and
 *  outputTokens update; `reportedCached === null` means the provider reported
 *  no cache tokens (recordCacheSample quarantines that sample). */
// #1933 F1: estimator calibration constants. The local chars/4 estimate is a
// proxy whose ratio to real billing varies per upstream (observed 1.3–2.5× on
// one relay vs ~1.0× on another in the same session; CJK-heavy content on
// llama-family tokenizers runs 2.4–4.0× ABOVE it, #2366), so k̂ is learned per
// route and only applied on that route. Samples below MIN are noise (tiny
// requests), clamps bound a single pathological sample from wrecking the mean.
const CALIBRATION_MIN_ESTIMATE = 2000;
// Plausibility band for admitting a sample: outside it, the report and the
// payload it bills demonstrably don't correspond (placeholder billing, relay
// echo, mock upstreams) — a ratio there must never teach a factor.
export const CALIBRATION_SAMPLE_MIN = 0.2;
export const CALIBRATION_SAMPLE_MAX = 5;
// Final clamp on the published factor: bounds how far calibration can move
// any decision away from the raw estimate, in BOTH directions since #2366.
// It was one-way (max 1, "deflate only") by PR #1940's design: inflated
// estimates were deemed safe because they just fire early, with the overflow
// arm as backstop. That premise failed empirically on CJK routes — the
// estimator runs 2.4–4.0× BELOW real billing there (#2366 evidence: 53K
// estimated vs 152,903 billed), so under-estimating routes published k̂=1
// forever: the >1 samples were collected into the ring and discarded at
// publish, and every decision (preflight trigger, output budget, the
// agent-visible status) stayed in the wrong caliber until the window filled
// past recoverable compression. The max now bounds symmetric inflation at 4×:
// it covers the measured CJK band and stays BELOW CALIBRATION_SAMPLE_MAX (5),
// so non-corresponding reports are still rejected before the clamp sees them.
// Wild values remain bounded by the evidence gates: ≥2 recent samples agreeing
// within ×2, keyed by route AND model, MIN_ESTIMATE floor.
export const CALIBRATION_CLAMP_MIN = 0.25;
export const CALIBRATION_CLAMP_MAX = 4;
// Evidence requirements: ≥2 recent same-route samples agreeing within ×2.
// One lucky/degenerate pair must not flip every estimate on the route.
export const CALIBRATION_SAMPLE_WINDOW = 3;
const CALIBRATION_CONSISTENCY_RATIO = 2;

/** #2867/#2973: the canonical incoming system fp is a responses-LANE-ONLY
 *  classification input — its sole writer is prepare-responses'
 *  noteCanonicalSystemFingerprint. Session metadata persists across turns AND
 *  lanes, so a session that switched responses→anthropic/openai/google still
 *  carries the last responses request's fp in the slot. Gating on the CURRENT
 *  request's wire keeps every non-responses sample free of that stale value
 *  (feeding it would mis-bucket the #2867 host-rewrite-vs-proxy-projection
 *  attribution). Split out as a pure helper so the lane gate is unit-testable
 *  off-Windows. */
export function canonicalSysFpForSettle(session: Session, protocol?: string): string | undefined {
    if (protocol !== "responses") return undefined;
    const noted = session.metadata?.[METADATA_CANONICAL_SYS_FP] as { fp?: unknown } | undefined;
    return typeof noted?.fp === "string" && noted.fp !== "" ? noted.fp : undefined;
}

/** #1933 F1 + #3900/#4079: ingest one billed-total-vs-pending-local-estimate
 *  pair into the per-origin+model calibration ring and publish/clear k̂ per
 *  the ring discipline. Extracted VERBATIM from settleUsageReport so usage
 *  settles and overflow settles (settleOverflowCalibration) cannot drift
 *  apart — every guard, band, clamp and provenance rule below is shared. */
function ingestCalibrationPair(session: Session, billed: number, upstream: string | undefined): void {
    // #3211: per-route calibration policy (providers[<key>].calibration),
    // paired by handle.ts with the SAME latest-wins/origin-gated discipline
    // as the pending estimate — applied below at PUBLICATION time only, so
    // the learned ring stays raw and auditable. Origin mismatch (slot set
    // by a request on another route) voids it for this settle.
    const settleOrigin = normalizeUpstreamOrigin(upstream);
    const pendingCalibOrigin = session.stats.lastCalibrationPolicyOrigin !== undefined ? normalizeUpstreamOrigin(session.stats.lastCalibrationPolicyOrigin) : undefined;
    const calibPolicy = pendingCalibOrigin === settleOrigin ? session.stats.lastCalibrationPolicy : undefined;
    const pendingEst = session.stats.lastLocalTextEstimate;
    const pendingOrigin = normalizeUpstreamOrigin(session.stats.lastLocalTextEstimateOrigin);
    if (pendingEst !== undefined && pendingEst >= CALIBRATION_MIN_ESTIMATE && settleOrigin !== undefined && pendingOrigin === settleOrigin) {
        const rawSample = billed / pendingEst;
        // #2117 B: the ring is keyed by route AND model — tokenizers bill
        // differently across models, so a mid-session model switch starts a
        // FRESH ring instead of blending two models' billing scales into one
        // factor. Missing model info NEVER invalidates (same discipline as
        // currentCalibrationFactor): a ring without a model key — legacy
        // pre-upgrade files included, and records restored after a restart
        // whose load whitelist drops the model fields (#2141) — continues
        // and ADOPTS the first known model. Discarding it would clear a
        // provenance-matched published k̂ on the first post-restart settle
        // (the #2129 regression class).
        const settleModel = typeof session.metadata?.lastModel === "string" && session.metadata.lastModel !== "" ? session.metadata.lastModel : undefined;
        let ring = session.stats.calibrationRing;
        if (!ring || ring.origin !== settleOrigin || (ring.model !== undefined && settleModel !== undefined && ring.model !== settleModel)) {
            ring = { origin: settleOrigin, model: settleModel, values: [] };
        } else if (ring.model === undefined && settleModel !== undefined) {
            ring.model = settleModel;
        }
        if (rawSample >= CALIBRATION_SAMPLE_MIN && rawSample <= CALIBRATION_SAMPLE_MAX) {
            ring.values.push(rawSample);
            if (ring.values.length > CALIBRATION_SAMPLE_WINDOW) ring.values.shift();
            const spread = Math.max(...ring.values) / Math.min(...ring.values);
            if (ring.values.length >= 2 && spread <= CALIBRATION_CONSISTENCY_RATIO) {
                const mean = ring.values.reduce((a, b) => a + b, 0) / ring.values.length;
                if (calibPolicy?.disabled === true) {
                    // #3211: route-level opt-out — the learned value stays in
                    // the ring (auditable) but is never applied on this route.
                    delete session.stats.calibratedEstimate;
                    delete session.stats.calibratedEstimateOrigin;
                    delete session.stats.calibratedEstimateModel;
                } else {
                    const clamped = Math.min(CALIBRATION_CLAMP_MAX, Math.max(CALIBRATION_CLAMP_MIN, mean));
                    session.stats.calibratedEstimate = calibPolicy?.max !== undefined ? Math.min(clamped, calibPolicy.max) : clamped;
                    session.stats.calibratedEstimateOrigin = settleOrigin;
                    // Provenance is the ring's model key, not this sample's stamp —
                    // an unknown-model settle continues a model-keyed ring without
                    // blanking the established provenance. Stays inside the publish
                    // branch: the disabled path above clears all three fields and
                    // must not re-stamp one of them (#3211 review).
                    session.stats.calibratedEstimateModel = ring.model;
                }
            } else {
                delete session.stats.calibratedEstimate;
                delete session.stats.calibratedEstimateOrigin;
                delete session.stats.calibratedEstimateModel;
            }
        }
        session.stats.calibrationRing = ring;
    }
}

/** #3900/#4079: teach the estimator from an upstream overflow rejection.
 *  parseOverflowCounts (#3450) extracts the REJECTED PAYLOAD'S OWN billed
 *  message-token count from the 400 body — a usage-grade measurement of the
 *  exact body whose local text estimate prepare recorded as the pending k̂
 *  pair. A route that only ever overflows never settles a usage report, so
 *  the local calibre never self-corrects: preflight keeps judging "fits"
 *  on the low estimate, re-forwards the same doomed body, and the 400 loops
 *  forever (#3900). Ingest the measurement through the shared ring
 *  discipline (same plausibility band, same ≥2-agreeing-samples rule, same
 *  publish clamps — never a shortcut) so k̂ converges and the next preflight
 *  judges the payload at its true size. */
export function settleOverflowCalibration(
    session: Session,
    measured: number,
    upstream?: string,
): void {
    if (!(measured > 0)) return;
    ingestCalibrationPair(session, measured, upstream);
    // The rejected request will never produce a usage report — retire its
    // pending pair NOW so no later report can mispair against a consumed
    // estimate (#1933 F1). A same-request refold (#1195) re-runs prepare and
    // re-notes a fresh pair for the folded body before its send.
    session.stats.lastLocalTextEstimate = undefined;
    session.stats.lastLocalTextEstimateOrigin = undefined;
}

/** #4383: the relay main-lane send stamp for per-send context evidence,
 *  extracted from the forward chokepoint so the write contract is nameable
 *  and testable: localInputEstimate/contextTokens carry the char-count upper
 *  bound (fail-closed caliber, #553/#728/#1493), contextEstimateTokens the
 *  k̂-scaled billing-caliber reading (#2117), and contextTokensSource=
 *  "estimate" is the cycle-freshness mark that only a real usage settle
 *  flips back to "usage" (settleUsageReport) — usageAnchorCycleStale
 *  (session.ts) reads exactly that flip. */
export function noteOutboundContextEstimates(
    session: Session,
    est: { upperBound: number; scaledText: number; imageTokens: number; calibrated: boolean },
): void {
    session.stats.localInputEstimate = est.upperBound;
    session.stats.contextEstimateTokens = Math.round(est.scaledText + est.imageTokens);
    session.stats.contextEstimateCalibrated = est.calibrated;
    session.stats.contextTokens = est.upperBound;
    session.stats.contextTokensSource = "estimate";
}

export function settleUsageReport(
    session: Session,
    s: { total: number; reportedCached: number | null; output?: number; protocol?: string; upstream?: string; creation?: number },
    localTextEstimate?: number,
): void {
    // #793: a zero-total sample carries no information (gateway placeholder or
    // relay echo) — it must not clobber the last trusted lastInputTokens.
    if (s.total > 0) {
        session.stats.inputTokens += s.total;
        // #4899: USD spend ledger — input/cache-read/cache-write billed at the
        // per-request stamped price, in lockstep with the token counters above
        // (foreign #4805 payloads bill too: the tokens were really spent, the
        // gate only protects this conversation's anchor family).
        billInputUsage(session, { total: s.total, cached: s.reportedCached, creation: s.creation });
        // #4805: id-membership gate — a report produced by a request whose
        // message ids do not join this session's known id family is foreign
        // billing data under a colliding session key (auxiliary host personas
        // stamp the host conversation id on their own tiny payloads). It
        // still counts toward cumulative usage, but it is not this
        // conversation's truth and must not touch the anchor family. Abstain
        // paths (no evidence / first turns / #2821 re-mints) settle exactly
        // as before: the gate only ever refuses the clearly-foreign.
        if (isForeignMembership(session.transient?.requestMembership)) {
            const m = session.transient!.requestMembership!;
            loggerLog("info", `[${session.id}] [membership] usage sample (total=${s.total}) refused anchor write: its request did not carry the conversation's latest message id (needle=${m.needle ?? "-"}) — foreign payload under a shared session id (#4805)`);
        } else {
        // Net out this turn's compress credit: the post-compress re-request
        // re-sends the unfolded history, so its usage report over-reports the
        // context the NEXT request will actually carry (see stream.ts applyRanges).
        session.stats.lastInputTokens = Math.max(0, s.total - (session.stats.compressCreditTokens ?? 0));
        // #1569: calibration anchor for estimate-grade turns — written ONLY by
        // real upstream usage reports (all three response shapes funnel here),
        // never by estimate-grade samples or arming paths; dropped at native-
        // compaction boundaries via resetSessionCompression (session.ts).
        session.stats.lastUsageGradeTokens = session.stats.lastInputTokens;
        session.stats.lastUsagePayloadUpper = session.stats.localInputEstimate ?? 0;
        session.stats.lastInputTokensSource = "usage";
        // #3148: a real usage report supersedes the failed-round arm — drop the
        // visibility marker so acp_status stops advertising a stale emergency state.
        delete session.stats.emergencyShrinkAt;
        delete session.stats.emergencyShrinkEstimate;
        session.stats.contextTokens = session.stats.lastInputTokens;
        session.stats.contextTokensSource = "usage";
        if (session.metadata) session.metadata.contextTokensAt = Date.now();
        recordContextObservation(session, session.stats.lastInputTokens, (session.stats.compressCreditTokens ?? 0) > 0 ? "estimate" : "usage");
        // #1933 F2: record which route measured this baseline — the gate uses
        // it to demote the baseline when the current request routes elsewhere.
        const settleOrigin = normalizeUpstreamOrigin(s.upstream);
        if (settleOrigin !== undefined) session.stats.lastInputTokensOrigin = settleOrigin;
        // #1933 F1: consume the pending pair — the local text estimate of the
        // payload THIS report bills, recorded at prepare time. Same route
        // required. Admitted samples (plausibility band) accumulate in a
        // per-origin ring; the factor is published only once ≥2 recent samples
        // agree within ×2, and cleared again when they stop agreeing — until
        // then the raw estimate decides (legacy behavior).
        // #3900/#4079: extracted verbatim so an upstream overflow 400 — which is
        // a usage-grade measurement of the rejected body (#3450 parseOverflowCounts)
        // — can feed the SAME ring via settleOverflowCalibration. A route that
        // only ever overflows never settles a usage report, so without this the
        // local estimator's calibre never self-corrects and the same "fits"
        // verdict re-forwards the same doomed body forever.
        ingestCalibrationPair(session, s.total, s.upstream);
        // #1820: a real usage-grade sample supersedes the post-rebuild meter
        // anchor immediately — no need to wait out its prepare budget.
        clearPostRebuildAnchor(session);
        // #1110: a real usage report retires the one-shot overflow arm.
        // #3450: the proven completion reservation retires with it — it was
        // evidence about the rejected payload's turn; a recovered session
        // returns to judging on the declared window (a repeat overflow
        // re-arms both in one event).
        delete session.stats.overflowArmTokens;
        delete session.stats.overflowArmCompletionReserve;
        }
    }
    // #1933 F1: roll the pending pair forward to the current turn's value —
    // it will be consumed by the NEXT report (or cleared when the lane
    // provides none, so a stale pair can never be mispaired).
    session.stats.lastLocalTextEstimate = localTextEstimate;
    session.stats.lastLocalTextEstimateOrigin = localTextEstimate !== undefined ? normalizeUpstreamOrigin(s.upstream) : undefined;
    if (s.reportedCached !== null && s.total > 0) {
        session.stats.cachedTokens += s.reportedCached;
        session.stats.cacheSamples += 1;
    }
    // #2131: the credential fingerprint captured at the send chokepoint rides
    // the seam slot — read it BEFORE recordCacheSample so the line it pushes
    // already carries the identity (kp/kw) without a second slot lookup.
    const curKeyFp = pendingCapture(session).sentBody?.keyFp;
    // #3803: the generation-parameter fingerprint noted for THIS request at the
    // send chokepoint — same transient-slot pairing as the credential one above.
    const curEffFp = pendingCapture(session).sentBody?.effFp;
    // #2350: the host's system-prompt fingerprint as noted for THIS request by
    // fold-reconcile's wire sites (they precede this settle under the session
    // lock). Sparse: lanes that never noted one (title-gen / compaction-trigger
    // sidecars) carry no value and can neither flag nor advance the baseline.
    const notedSys = session.metadata?.[METADATA_SYSTEM_FP] as { fp?: unknown } | undefined;
    const curSysFp = typeof notedSys?.fp === "string" && notedSys.fp !== "" ? notedSys.fp : undefined;
    // #2867: the canonical incoming fingerprint + compression mode ride along so
    // recordCacheSample can tell a host-side prompt rewrite from bili's own
    // projection/mode switch (responses lane only; other lanes omit both).
    const curCanonFp = canonicalSysFpForSettle(session, s.protocol);
    // Same lane-gate as the canon slot above: the mode stamp is written only by
    // prepare-responses, so on a non-responses settle it would leak the last
    // responses request's label into an inert-but-misleading line field.
    const lastMode = s.protocol === "responses" ? (session.metadata?.[METADATA_LAST_RESPONSES_MODE] as unknown) : undefined;
    const led = getCacheLedger(session);
    recordCacheSample(session, { at: Date.now(), input: s.total, cached: s.reportedCached, output: s.output, protocol: s.protocol, upstream: s.upstream, keyFp: curKeyFp, sysFp: curSysFp, canonFp: curCanonFp, effFp: curEffFp, mode: lastMode === "plugin" || lastMode === "proxy" ? lastMode : undefined });
    const capture = captures.getStore();
    const sample = led.lines[led.lines.length - 1];
    if (capture?.session === session && sample) {
        sample.captureId = capture.requestId;
        sample.captureRound = capture.round;
    }
    // #2131: per-call body-stability proof on the just-recorded line — the same
    // pairing detectSeam uses (this request's forwarded body vs the previous
    // settled one), so "prefix unchanged between calls" is stored data, not an
    // interpretation. Digest equality decides; the LCP offset localizes where
    // a divergence started when both full bodies were retained.
    const curSlot = pendingCapture(session).sentBody;
    if (curSlot !== undefined) {
        const curLine = led.lines[led.lines.length - 1];
        if (curLine !== undefined) {
            curLine.bd = curSlot.digest;
            const settled = session.transient?.settledBody;
            const backwards = curSlot.order !== undefined && settled?.order !== undefined && curSlot.order <= settled.order;
            const prevSlot = backwards ? undefined : settled;
            if (backwards) curLine.evidence = "out-of-order";
            if (prevSlot !== undefined) {
                if (curSlot.digest === prevSlot.digest) {
                    curLine.be = 1;
                } else {
                    curLine.be = 0;
                    if (curSlot.full !== null && prevSlot.full !== null) {
                        const lcp = byteLcp(prevSlot.full, curSlot.full);
                        curLine.bl = lcp;
                        // Append/trim first: "the whole shorter payload survives"
                        // is anchored to the END of the payload and stays true on
                        // small bodies where the head threshold alone would lie.
                        // #2982: the would-be-mid branch pays one extra scan over
                        // the SHORTER body: when the first divergence sits at/past
                        // that body's message-array closing bracket, no shared
                        // history byte moved — only trailing top-level params
                        // (host-computed max_tokens/…) or an ephemeral tail note
                        // that appeared/vanished between requests differ (#2980).
                        // The shorter side is decisive: when one side grew the
                        // array, the LCP stops at ITS closing bracket (`]` vs `,`),
                        // which lies inside the LONGER side's array — parsing that
                        // side would misread the pair as mid. No array locatable
                        // (unparseable body) keeps the conservative pre-fix class.
                        const shorterFull = prevSlot.full.length <= curSlot.full.length ? prevSlot.full : curSlot.full;
                        const arrClose = messagesArrayCloseOffset(shorterFull);
                        // #3476: a growing logical unit (single giant message whose interior
                        // container extends in place) is byte-wise a mid-body insertion but
                        // semantically an append — recognize it in the would-be-mid slot.
                        const midInsert = isMidInsertionAppend(prevSlot.full, curSlot.full, lcp);
                        curLine.bs = lcp >= Math.min(prevSlot.full.length, curSlot.full.length) - 64 ? "append" : lcp < 1024 ? "head" : arrClose !== null && lcp >= arrClose ? "tail" : midInsert ? "append" : "mid";
                    } else {
                        curLine.bs = "unknown";
                    }
                }
            }
        }
    }
    // #1843 L1: the usage total is ground truth for what the route's vision
    // encoder actually billed — fold any captured image facts into the learned
    // per-route cost (no-op when the request carried no images or no capture).
    settleImageLearning(session, s.total);
    // #1592-family seam forensics: pair this settle with the body that was
    // actually sent (noteForwardedBody), then keep it as the next pair's
    // baseline. Lanes without body capture still get the aggregate flag.
    detectSeam(session, led);
    const pending = pendingCapture(session);
    const settled = session.transient ??= {};
    const seamBody = pending.sentBody;
    const backwards = seamBody?.order !== undefined && settled.settledBody?.order !== undefined && seamBody.order <= settled.settledBody.order;
    if (seamBody !== undefined && !backwards) settled.settledBody = seamBody;
    else delete settled.settledBody;
    delete pending.sentBody;
    const seamIn = pending.inBody;
    // #4731: noteForwardedBody deletes pending.inBody on round>1 of a capture,
    // so a same-request retry settles without inbound evidence and drops the
    // settledInBody baseline (the round-2 delete-then-miss). That conservative
    // behavior stays BY DESIGN: #3023 attribution is diagnostic-only (nothing
    // bills on settledInBody), and the pair accessor cannot cheaply recover
    // the evidence here because the delete removes it from the capture itself.
    if (seamBody !== undefined && seamIn !== undefined && !backwards) settled.settledInBody = seamIn;
    else delete settled.settledInBody;
    delete pending.inBody;
}

/** [#1279] Price profile stamped by the last request (server.ts runPrepare).
 *  Metadata is persisted user-editable JSON, so re-validate on read: only
 *  finite non-negative numbers survive — a corrupt stamp degrades to the
 *  kernel defaults instead of poisoning the report. */
function stampedPriceProfile(session: Session): PriceProfile | undefined {
    const v = session.metadata?.cachePriceProfile;
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const o = v as Record<string, unknown>;
    const out: PriceProfile = {};
    for (const key of ["w", "r", "q"] as const) {
        const n = o[key];
        if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

export interface ModelSwitchEvent {
    seq: number;
    at: number;
    from: string | null;
    to: string;
    input: number;
    cached: number;
    hitPct: number;
    /** This sample's unexplained residual (tr) — the re-bill charged to the switch. */
    attributed: number;
}

interface ModelSwitchStats {
    count: number;
    missedTokens: number;
    events: ModelSwitchEvent[];
}

interface InvalidationTokenBreakdown {
    model: number;
    /** #3803: stable-prefix re-bill charged to a host generation-parameter switch
     *  (reasoning effort / thinking config) — a provider cache-namespace flip, not a history rewrite. */
    effort: number;
    key: number;
    /** #2350: stable-prefix re-bill charged to host system-prompt rewrites. */
    prompt: number;
    /** #2867: stable-prefix re-bill charged to bili's own compression-mode /
     *  projection switch (forwarded system flipped, incoming view unchanged). */
    projection: number;
    wire: number;
    upstream: number;
    restart: number;
    /** Residual stable-prefix miss NOT charged to any named cause — the true
     *  upstream TTL/eviction/wire-rewrite remainder (kernel cannot name it). */
    remaining: number;
}

/** #2131: per-call outbound body stability (SHA-256 compared against the
 *  previous settled request) plus the hit-rate context checks that separate
 *  provider-side cache behavior from bili-side rewrites. Computed at report
 *  time from the unbounded line set; no new hot-path state. */
interface BodyStability {
    /** Adjacent pairs where both bodies were captured (be defined). */
    paired: number;
    /** be=1: byte-identical resends (transport retries, re-requests). */
    equal: number;
    /** be=0: diverged; the five classes partition this count. */
    diverged: number;
    /** Divergence inside the first 1 KiB — host-side parameter region (model/tools/sampling/system), NOT a history rewrite. */
    head: number;
    /** Whole shorter payload survives ±64 closing-bracket bytes — pure tail growth/trim. */
    append: number;
    /** Mid-history byte change — the shape a real rewrite has. */
    mid: number;
    /** #2982: divergence at/past the shorter body's message-array closing bracket — trailing top-level params or ephemeral tail notes; shared history bytes untouched, though a provider may partition its prompt cache on a trailing field (#3803). */
    tail: number;
    /** Diverged but offset unknown (bodies above BODY_FULL_CAP, digest-only mode). */
    unknownOffset: number;
    /** Median/min hit rate per 20K-token input-size bucket — flat across sizes argues against KV-pool capacity thrashing. */
    sizeBuckets: Array<{ lo: number; hi: number; n: number; hitMedian: number; hitMin: number }>;
    /** Median inter-request gap for low-hit (<80%) vs high-hit lines — comparable medians argue against TTL/gap expiry. */
    gapSplit: { lowHitMedGapMs: number | null; highHitMedGapMs: number | null };
}

interface BiliCacheReport extends CacheReport {
    stability: BodyStability;
    /** #2131: line set widened with the per-call body-stability fields. */
    lines: Array<CacheReportLine & { captureId?: string; captureRound?: number; evidence?: "out-of-order"; bodyDigest?: string; bodyEqual?: 0 | 1; bodyLcp?: number; bodyClass?: "head" | "append" | "mid" | "tail" | "unknown"; keyFp?: string; sysFp?: string; efp?: string; seam?: 1; prov?: "ttl" | "side" | "rewind" | "client" | "orphan-sweep" }>;
    modelSwitches: ModelSwitchStats;
    /** #3803: host generation-parameter switches (reasoning effort / thinking config) — a provider cache-namespace flip that re-bills the whole stable prefix once, distinct from any byte change. */
    effSwitches: ModelSwitchStats;
    /** #2131: relay account rotations (credential fingerprint changes) —
     *  the identity a URL-granular upstream switch cannot see. */
    keySwitches: ModelSwitchStats;
    /** #2350: host system-prompt rewrites (system fingerprint changes between
     *  consecutive requests — the host edits its own instructions). Post-#2867
     *  this section narrates HOST-side flips only; proxy-side mode switches
     *  appear under projSwitches. */
    promptSwitches: ModelSwitchStats;
    /** #2867: proxy projection/mode switches (forwarded system flipped while
     *  the canonical incoming view stayed stable — bili's self-heal
     *  degrade-to-proxy re-hoisting mid-history developer items). */
    projSwitches: ModelSwitchStats;
    wireSwitches: ModelSwitchStats;
    upstreamSwitches: ModelSwitchStats;
    restartDrops: ModelSwitchStats;
    unmeasured: { samples: number; inputTokens: number };
    /** #1891: first-bill samples with no prior baseline — their uncached input
     *  is booked as new content, never as a prefix re-pay. */
    initialBills: { samples: number; inputTokens: number };
    invalidation: InvalidationTokenBreakdown;
    seam: { suspects: number; missed: number; events: SeamEvent[]; providerSide: { count: number; missed: number }; providerTtl: { count: number; missed: number }; rewinds: { count: number; missed: number }; abortCorrelated: number; client: { count: number; missed: number }; orphanSweep: { count: number; missed: number } };
}

export function buildSessionCacheReport(session: Session): BiliCacheReport {
    const led = getCacheLedger(session);
    // Effective profile = stamped value over kernel defaults (w=1, r=0.1, q=4),
    // mirroring the per-field fallback inside computeFoldEconomics. Unstamped
    // sessions keep the pre-#1279 Anthropic-ratio output byte-for-byte.
    const price = stampedPriceProfile(session);
    const effective: Required<PriceProfile> = { w: price?.w ?? 1, r: price?.r ?? 0.1, q: price?.q ?? 4 };
    const a = led.agg;
    const totals: CacheTotals = {
        requests: a.requests,
        input: a.input,
        cached: a.cached,
        output: a.output,
        hitPct: a.input > 0 ? round1((a.cached / a.input) * 100) : 0,
        newContent: a.nc,
        compRepay: a.cr,
        ttlRepay: a.tr,
        residual: a.input - a.cached - (a.nc + a.cr + a.tr),
        balanced: true,
    };
    totals.balanced = totals.residual === 0;
    const folds = led.folds.map((f) =>
        computeFoldEconomics({
            seq: f.seq,
            at: f.at,
            S: f.S,
            sigma: f.sigma,
            Vprime: f.Vp ?? null,
            hPct: f.hPct,
            T: f.T,
            requestsAfter: f.requestsAfter,
            turnsToNextFold: f.k,
        }, effective),
    );
    // Unknown-cache samples are quarantined out of the rendered line set — they
    // carry no measurable hit rate and would show as misleading 0% rows.
    const knownLines = led.lines.filter((l) => l.unk !== 1);
    const switchEvents = (flag: (l: LedgerLine) => boolean, value: (l: LedgerLine | undefined) => string | undefined, dim: "model" | "effort" | "key" | "prompt" | "projection" | "wire" | "upstream"): ModelSwitchEvent[] => {
        const evs: ModelSwitchEvent[] = [];
        for (let i = 0; i < led.lines.length; i++) {
            const l = led.lines[i];
            if (!l || l.unk === 1 || !flag(l)) continue;
            // #2784: only lines where THIS dimension won the partition are narrated as events — a flip
            // shadowed by a higher-priority cause on the same line stays on the line itself (flag + value),
            // not in the narrative list. Lines persisted pre-#1847 have no `cause` field: keep their
            // historical display so old ledgers render as before.
            if (l.cause !== undefined && l.cause !== dim) continue;
            // #1847: from = the last KNOWN line strictly before this one (its value is the pre-switch
            // identity) — scanning past intervening unmeasured lines keeps the pair intact when a
            // switch straddles an unknown-cache boundary.
            let from: string | undefined;
            for (let j = i - 1; j >= 0; j--) {
                const p = led.lines[j];
                if (p && p.unk !== 1) { from = value(p); break; }
            }
            evs.push({
                seq: l.seq,
                at: l.at,
                from: from ?? null,
                to: value(l) ?? "?",
                input: l.input,
                cached: l.cached,
                hitPct: l.hitPct ?? 0,
                // #1847: this event's share is the residual only when this dimension won the partition —
                // a co-occurring higher-priority cause absorbs the charge into its own bucket instead.
                // Lines persisted pre-#1847 have no `cause` field: keep their historical display (full tr),
                // so old ledgers render as before and the header's cold-tail delta stays honest.
                attributed: l.cause === dim || l.cause === undefined ? l.tr : 0,
            });
        }
        return evs;
    };
    const restartEvents: ModelSwitchEvent[] = [];
    for (const l of led.lines) {
        if (l.rs !== 1 || l.unk === 1) continue;
        restartEvents.push({ seq: l.seq, at: l.at, from: null, to: "(restart)", input: l.input, cached: l.cached, hitPct: l.hitPct ?? 0, attributed: l.cause === "restart" || l.cause === undefined ? l.tr : 0 });
    }
    const invalidation: InvalidationTokenBreakdown = {
        model: a.switchMissed,
        effort: a.effSwitchMissed,
        key: a.keySwitchMissed,
        prompt: a.promptSwitchMissed,
        projection: a.projSwitchMissed,
        wire: a.wireSwitchMissed,
        upstream: a.upstreamSwitchMissed,
        restart: a.restartDropMissed,
        remaining: Math.max(0, a.tr - a.attributedMissed),
    };
    // #2131: per-call body-stability proof + hit-rate context checks (size
    // stratification, gap split) — computed from the stored line flags.
    let paired = 0;
    let equal = 0;
    let head = 0;
    let append = 0;
    let mid = 0;
    let tail = 0;
    let unknownOffset = 0;
    for (const l of knownLines) {
        if (l.be === undefined) continue;
        paired += 1;
        if (l.be === 1) { equal += 1; continue; }
        if (l.bs === "head") head += 1;
        else if (l.bs === "append") append += 1;
        else if (l.bs === "mid") mid += 1;
        else if (l.bs === "tail") tail += 1;
        else unknownOffset += 1;
    }
    const sizeBuckets: BodyStability["sizeBuckets"] = [];
    {
        const byLo = new Map<number, number[]>();
        for (const l of knownLines) {
            if (l.hitPct === null || l.input <= 0) continue;
            const lo = Math.floor(l.input / SIZE_BUCKET_TOK) * SIZE_BUCKET_TOK;
            const hits = byLo.get(lo);
            if (hits) hits.push(l.hitPct);
            else byLo.set(lo, [l.hitPct]);
        }
        for (const [lo, hits] of [...byLo.entries()].sort((x, y) => x[0] - y[0]).slice(0, 24)) {
            sizeBuckets.push({ lo, hi: lo + SIZE_BUCKET_TOK, n: hits.length, hitMedian: median(hits) ?? 0, hitMin: Math.min(...hits) });
        }
    }
    const lowGaps: number[] = [];
    const highGaps: number[] = [];
    for (let i = 1; i < led.lines.length; i++) {
        const p = led.lines[i - 1];
        const c = led.lines[i];
        if (!p || !c || c.hitPct === null) continue;
        const gap = c.at - p.at;
        if (!(gap > 0)) continue;
        (c.hitPct < 80 ? lowGaps : highGaps).push(gap);
    }
    const stability: BodyStability = {
        paired,
        equal,
        diverged: paired - equal,
        head,
        append,
        mid,
        tail,
        unknownOffset,
        sizeBuckets,
        gapSplit: { lowHitMedGapMs: median(lowGaps), highHitMedGapMs: median(highGaps) },
    };
    return {
        generatedAt: Date.now(),
        profile: effective,
        totals,
        economics: summarizeFoldEconomics(folds),
        folds,
        lines: knownLines.map((l) => ({
            seq: l.seq,
            at: l.at,
            input: l.input,
            cached: l.cached,
            output: l.output,
            hitPct: l.hitPct ?? 0,
            missed: l.missed,
            newContent: l.nc,
            compRepay: l.cr,
            ttlRepay: l.tr,
            foldSeq: l.foldSeq,
            seam: l.seam,
            prov: l.prov,
            captureId: l.captureId,
            captureRound: l.captureRound,
            evidence: l.evidence,
            bodyDigest: l.bd,
            keyFp: l.kp,
            sysFp: l.sp,
            efp: l.efp,
            bodyEqual: l.be,
            bodyLcp: l.bl,
            bodyClass: l.bs,
        })),
        linesOmitted: led.sampleSeq - led.lines.length,
        modelSwitches: { count: a.switches, missedTokens: a.switchMissed, events: switchEvents((l) => l.sw === 1 && l.model !== undefined, (l) => l?.model, "model") },
        effSwitches: { count: a.effSwitches, missedTokens: a.effSwitchMissed, events: switchEvents((l) => l.ef === 1 && l.efp !== undefined, (l) => l?.efp, "effort") },
        keySwitches: { count: a.keySwitches, missedTokens: a.keySwitchMissed, events: switchEvents((l) => l.kw === 1 && l.kp !== undefined, (l) => l?.kp, "key") },
        promptSwitches: { count: a.promptSwitches, missedTokens: a.promptSwitchMissed, events: switchEvents((l) => l.sf === 1 && l.sp !== undefined, (l) => l?.sp, "prompt") },
        projSwitches: { count: a.projSwitches, missedTokens: a.projSwitchMissed, events: switchEvents((l) => l.pf === 1 && l.sp !== undefined, (l) => l?.sp, "projection") },
        wireSwitches: { count: a.wireSwitches, missedTokens: a.wireSwitchMissed, events: switchEvents((l) => l.pw === 1 && l.proto !== undefined, (l) => l?.proto, "wire") },
        upstreamSwitches: { count: a.upstreamSwitches, missedTokens: a.upstreamSwitchMissed, events: switchEvents((l) => l.uw === 1 && l.up !== undefined, (l) => l?.up, "upstream") },
        restartDrops: { count: a.restartDrops, missedTokens: a.restartDropMissed, events: restartEvents },
        unmeasured: { samples: a.unknownSamples, inputTokens: a.unknownInput },
        initialBills: { samples: a.nbSamples, inputTokens: a.nbInput },
        invalidation,
        stability,
        seam: { suspects: a.seamSuspects, missed: a.seamMissed, events: led.seamEvents ?? [], providerSide: { count: a.providerSideMisses, missed: a.providerSideMissed }, providerTtl: { count: a.providerTtlMisses, missed: a.providerTtlMissed }, rewinds: { count: a.rewinds, missed: a.rewindMissed }, abortCorrelated: a.abortCorrelated, client: { count: a.clientInserts, missed: a.clientInsertMissed }, orphanSweep: { count: a.orphanSweepSeams, missed: a.orphanSweepMissed } },
    };
}

/** Read-only switch stats for the web sessions table — returns null instead of
 *  bootstrapping an empty ledger just to render zeros. */
export function readModelSwitchStats(session: Session): { count: number; missedTokens: number } | null {
    const raw = session.metadata?.[LEDGER_KEY];
    if (!raw || typeof raw !== "object") return null;
    const led = raw as CacheLedger;
    if (led.v !== 1) return null;
    return {
        count: typeof led.agg?.switches === "number" ? led.agg.switches : 0,
        missedTokens: typeof led.agg?.switchMissed === "number" ? led.agg.switchMissed : 0,
    };
}

/** #2131: read-only KEY switch stats for the web sessions table — same
 *  no-bootstrap contract as readModelSwitchStats. */
export function readKeySwitchStats(session: Session): { count: number; missedTokens: number } | null {
    const raw = session.metadata?.[LEDGER_KEY];
    if (!raw || typeof raw !== "object") return null;
    const led = raw as CacheLedger;
    if (led.v !== 1) return null;
    return {
        count: typeof led.agg?.keySwitches === "number" ? led.agg.keySwitches : 0,
        missedTokens: typeof led.agg?.keySwitchMissed === "number" ? led.agg.keySwitchMissed : 0,
    };
}

/** #2350: read-only PROMPT switch stats for the web sessions table — same
 *  no-bootstrap contract as readKeySwitchStats. */
export function readPromptSwitchStats(session: Session): { count: number; missedTokens: number } | null {
    const raw = session.metadata?.[LEDGER_KEY];
    if (!raw || typeof raw !== "object") return null;
    const led = raw as CacheLedger;
    if (led.v !== 1) return null;
    return {
        count: typeof led.agg?.promptSwitches === "number" ? led.agg.promptSwitches : 0,
        missedTokens: typeof led.agg?.promptSwitchMissed === "number" ? led.agg.promptSwitchMissed : 0,
    };
}

/** #2867: read-only PROJECTION switch stats for the web sessions table — same
 *  no-bootstrap contract as readPromptSwitchStats. */
export function readProjSwitchStats(session: Session): { count: number; missedTokens: number } | null {
    const raw = session.metadata?.[LEDGER_KEY];
    if (!raw || typeof raw !== "object") return null;
    const led = raw as CacheLedger;
    if (led.v !== 1) return null;
    return {
        count: typeof led.agg?.projSwitches === "number" ? led.agg.projSwitches : 0,
        missedTokens: typeof led.agg?.projSwitchMissed === "number" ? led.agg.projSwitchMissed : 0,
    };
}

function formatStability(st: BodyStability): string {
    if (st.paired === 0) return "";
    const out: string[] = ["BODY STABILITY (per-call outbound byte proof, vs previous settled request)"];
    out.push(`  ${st.paired} pair(s): ${st.equal} byte-identical · ${st.diverged} diverged`);
    out.push(`  divergence class: head <1KiB ${st.head} · tail-append ${st.append} · mid-history ${st.mid} · tail(params/notes) ${st.tail} · offset-unknown(capped) ${st.unknownOffset}`);
    if (st.head > 0) out.push(`  ⚠ ${st.head} head-region divergence(s) — model/tools/sampling/system changed between calls (host-side parameter change, NOT a bili history rewrite)`);
    if (st.mid > 0) out.push(`  ⚠ ${st.mid} mid-history divergence(s) — real prefix rewrites; inspect the seam events above`);
    if (st.tail > 0) out.push(`  ${st.tail} tail-region divergence(s) — trailing top-level params or ephemeral tail notes at/past the message-array end; shared history bytes untouched, but a provider may re-partition its prompt cache on a trailing field such as reasoning effort — see EFFORT SWITCHES / invalidation above (#3803)`);
    const sb = st.sizeBuckets.filter((b) => b.n >= 3);
    if (sb.length >= 2) out.push("  hit% by input size (median): " + sb.map((b) => `${Math.round(b.lo / 1000)}K=${b.hitMedian}%`).join("  "));
    const g = st.gapSplit;
    if (g.lowHitMedGapMs !== null && g.highHitMedGapMs !== null) {
        out.push(`  inter-request gap median: low-hit(<80%) ${(g.lowHitMedGapMs / 1000).toFixed(1)}s vs high-hit ${(g.highHitMedGapMs / 1000).toFixed(1)}s`);
    }
    return out.join("\n");
}

export function handleAcpCache(session: Session, args?: Record<string, unknown>): ProxyToolResult {
    try {
        const detail = args?.detail === "full" ? "full" : "summary";
        const report = buildSessionCacheReport(session);
        const stabilityText = formatStability(report.stability);
        const tail = (base: string): string => base + (stabilityText ? "\n\n" + stabilityText : "") + (formatSeam(report) ? "\n\n" + formatSeam(report) : "");
        // #2131: key switches get their own section only when observed — the
        // common case (one account, no rotation) stays byte-identical.
        // #3803: host generation-parameter switches get their own section only when observed — a
        // session whose host never changes reasoning effort stays byte-identical.
        const effText = report.effSwitches.count > 0 ? "\n\n" + formatModelSwitches(report.effSwitches, detail, "EFFORT SWITCHES (host changed reasoning effort / thinking config)") : "";
        const keyText = report.keySwitches.count > 0 ? "\n\n" + formatModelSwitches(report.keySwitches, detail, "KEY SWITCHES (relay account rotation)") : "";
        // #2350: host system-prompt rewrites get their own section only when
        // observed — sessions whose host never rewrites stay byte-identical.
        const promptText = report.promptSwitches.count > 0 ? "\n\n" + formatModelSwitches(report.promptSwitches, detail, "PROMPT SWITCHES (host rewrote system prompt)") : "";
        // #2867: proxy-side mode/projection switches get their own section only
        // when observed — a session that never switches modes stays byte-identical.
        const projText = report.projSwitches.count > 0 ? "\n\n" + formatModelSwitches(report.projSwitches, detail, "PROJECTION SWITCHES (proxy mode/projection change — bili's own doing, e.g. self-heal degrade-to-proxy)") : "";
        // #3307: wire/upstream/restart carry per-event data in the report (switchEvents /
        // restartEvents) but only their aggregate counts reached CACHE INVALIDATION — no
        // per-line timestamps, so cross-checks (e.g. seam-vs-restart) were impossible.
        const wireText = report.wireSwitches.count > 0 ? "\n\n" + formatModelSwitches(report.wireSwitches, detail, "WIRE SWITCHES (client switched protocol wire between requests)") : "";
        const upstreamText = report.upstreamSwitches.count > 0 ? "\n\n" + formatModelSwitches(report.upstreamSwitches, detail, "UPSTREAM SWITCHES (relay/upstream origin changed between requests)") : "";
        const restartText = report.restartDrops.count > 0 ? "\n\n" + formatModelSwitches(report.restartDrops, detail, "RESTART/REFORK (first bill under a fresh daemon boot — prefix re-billed once)") : "";
        if (detail === "full" && report.lines.length > FULL_DETAIL_LINES) {
            const dropped = report.lines.length - FULL_DETAIL_LINES;
            const capped = formatCacheReport(
                { ...report, lines: report.lines.slice(-FULL_DETAIL_LINES), linesOmitted: report.linesOmitted + dropped },
                session.id,
                { detail },
            );
            return toolOk(tail(capped + "\n\n" + formatModelSwitches(report.modelSwitches, detail) + effText + keyText + promptText + projText + wireText + upstreamText + restartText + "\n\n" + formatInvalidation(report)));
        }
        return toolOk(tail(formatCacheReport(report, session.id, { detail }) + "\n\n" + formatModelSwitches(report.modelSwitches, detail) + effText + keyText + promptText + projText + wireText + upstreamText + restartText + "\n\n" + formatInvalidation(report)));
    } catch (err) {
        loggerLog("warn", `[${session.id}] [acp_cache] report failed: ${String(err)}`);
        return toolFail(`[acp_cache FAILED: ${String(err)}]`);
    }
}

function fmtTok(n: number): string {
    const v = Math.round(n);
    return v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : String(v);
}

function fmtTime(at: number): string {
    const d = new Date(at);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const SWITCH_LIST_CAP = 8;

function formatModelSwitches(sw: ModelSwitchStats, detail: "summary" | "full", title = "MODEL SWITCHES"): string {
    const out: string[] = [title];
    if (sw.count === 0) {
        out.push("  none observed");
        return out.join("\n");
    }
    // #1847: missedTokens includes the bounded post-switch cold rounds (attributed to the switch but not
    // discrete from→to events); surface that delta so the per-event list reconciles with the total.
    const eventSum = sw.events.reduce((n, e) => n + e.attributed, 0);
    const tail = sw.missedTokens - eventSum;
    out.push(`  ${sw.count} switch(es) · ${fmtTok(sw.missedTokens)} tok re-billed${tail > 0 ? ` (${fmtTok(tail)} on post-switch cold rounds)` : ""}`);
    const shown = detail === "full" ? sw.events : sw.events.slice(-SWITCH_LIST_CAP);
    for (const e of shown) {
        out.push(`  #${e.seq} ${fmtTime(e.at)} ${e.from ?? "?"} → ${e.to} · hit ${e.hitPct.toFixed(1)}% · attributed ${fmtTok(e.attributed)}`);
    }
    if (shown.length < sw.events.length) {
        out.push(`  … ${sw.events.length - shown.length} earlier switch(es) omitted (detail:"full" lists all)`);
    }
    return out.join("\n");
}

function formatSeam(r: BiliCacheReport): string {
    const out: string[] = [];
    if (r.seam.suspects > 0) {
        out.push("⚠ CACHE SEAM (suspected mid-history prefix breaks)");
        out.push(`  ${r.seam.suspects} sample(s) · ${fmtTok(r.seam.missed)} tok re-billed with no fold/switch/restart attribution`);
        // #3307: seamEvents holds BOTH suspect and #3023 client-side events
        // (one shared capped ring), so listing every event here echoed host-owned
        // rewrites under the "suspected bili rebuild" header — the ✎ CLIENT
        // section below already owns those. List only suspects here so the two
        // sections stay disjoint and a client insert is never misread as a seam.
        const suspectEvents = r.seam.events.filter((e) => !e.client);
        for (const e of suspectEvents) {
            out.push(`    #${e.seq} ${fmtTime(e.at)} hit ${e.hitPct.toFixed(1)}% · input ${fmtTok(e.input)} · divergence ≥${fmtTok(e.lcpBytes)}B at message[${e.msgIndex ?? "?"}] of ${e.prevMsgs}→${e.curMsgs}`);
        }
        if (suspectEvents.length === 0) {
            out.push("    (no body-pair forensics retained for the suspect samples on this lane — aggregate flag only; client-side rewrites are listed separately below)");
        }
        out.push("  if reproducible: /acp-cache detail:\"full\" + bili.log around the timestamps above (likely a #1548-family round-2/steady render seam)");
    }
    if (r.seam.rewinds.count > 0) {
        out.push("↩ HISTORY REWOUND (client revert/trim)");
        out.push(`  ${r.seam.rewinds.count} sample(s) · ${fmtTok(r.seam.rewinds.missed)} tok re-billed once for the retained prefix — sanctioned client intent, not a rebuild seam`);
    }
    if (r.seam.providerTtl.count > 0) {
        out.push("⏱ UPSTREAM TTL EXPIRY — NORMAL (long idle gap)");
        out.push(`  ${r.seam.providerTtl.count} sample(s) · ${fmtTok(r.seam.providerTtl.missed)} tok — byte-stable/append-shaped misses settled more than ${Math.round(PROVIDER_TTL_GAP_MS / 60_000)} min after the previous sample: the upstream prefix cache simply aged out. Expected cost, not a failure.`);
    }
    if (r.seam.providerSide.count > 0) {
        out.push("▲ PROVIDER-SIDE MISS (previous request's message list fully preserved)");
        out.push(`  ${r.seam.providerSide.count} sample(s) · ${fmtTok(r.seam.providerSide.missed)} tok — the previous request's message list is preserved in this one (byte-for-byte under the 512 KiB forensics cap; above it, proven by the stable recorded head plus exact message-count growth — any difference is only the appended tail), and the sample arrived within ${Math.round(PROVIDER_TTL_GAP_MS / 60_000)} min of the previous one, so this is an ABNORMAL provider miss (eviction / relay node rotation), not TTL ageing. Not a bili rebuild seam.`);
        out.push(`  stateful-upstream check (#2483): if your upstream keeps a live session per conversation and validates the echoed history against its own transcript (claude-code-based relays such as magpie), bili's render tags on assistant text trip that check even though bili's own list is unchanged — set diagnostics.renderNone=true until per-route render-tags control ships; expect exactly ONE replay when flipping the flag mid-session`);
    }
    if (r.seam.client.count > 0) {
        out.push("✎ CLIENT MID-HISTORY REWRITE (host-side insert — NOT a bili seam)");
        out.push(`  ${r.seam.client.count} sample(s) · ${fmtTok(r.seam.client.missed)} tok — the client's own resent history broke mid-list, so bili's faithful rebuild carried the break to the wire (host plugin insert / paste hoisting / re-render). Client-owned re-bill, not a rebuild seam.`);
        for (const e of r.seam.events) {
            if (e.client) out.push(`    #${e.seq} ${fmtTime(e.at)} hit ${e.hitPct.toFixed(1)}% · input ${fmtTok(e.input)} · inbound message[${e.client.idx}] ${e.client.role}/${e.client.cls} ${e.client.len}B JSON · outbound ${fmtTok(e.lcpBytes)}B @ message[${e.msgIndex ?? "?"}] of ${e.prevMsgs}→${e.curMsgs}`);
        }
    }
    if (r.seam.orphanSweep.count > 0) {
        out.push("🧹 ORPHAN CLEANUP SEAM (proactive failed-compress rotation — #3769)");
        out.push(`  ${r.seam.orphanSweep.count} sample(s) · ${fmtTok(r.seam.orphanSweep.missed)} tok re-billed when failed-compress records were rotated out of history without a fold claiming the break — bili's own cleanup, not an upstream or host rewrite`);
    }
    if (r.seam.abortCorrelated > 0) {
        out.push("⏻ ABORT-CORRELATED");
        out.push(`  ${r.seam.abortCorrelated} missed sample(s) within 30s of a client mid-stream abort — abort/retry churn rewrites the resent tail; correlation, not causation (see bili.log 'client aborted mid-stream')`);
    }
    return out.length > 0 ? out.join("\n") : "";
}

function formatInvalidation(r: BiliCacheReport): string {
    const b = r.invalidation;
    const named = b.model + b.effort + b.key + b.prompt + b.projection + b.wire + b.upstream + b.restart;
    const total = named + b.remaining;
    const out: string[] = ["CACHE INVALIDATION"];
    out.push(`  stable-prefix re-bill by cause (mutually exclusive, sums to total): ${fmtTok(named)} tok charged · ${fmtTok(b.remaining)} tok unattributed (upstream TTL/eviction/wire rewrite)`);
    out.push(`    model switch:    ${fmtTok(b.model)} (${r.modelSwitches.count})`);
    out.push(`    effort switch:   ${fmtTok(b.effort)} (${r.effSwitches.count}) — host changed reasoning effort / thinking config; provider re-partitions its prompt cache on it (#3803)`);
    out.push(`    key switch:      ${fmtTok(b.key)} (${r.keySwitches.count}) — relay account rotation, fingerprinted headers never logged raw`);
    out.push(`    prompt rewrite:  ${fmtTok(b.prompt)} (${r.promptSwitches.count}) — host rewrote its system prompt between requests (#2350)`);
    out.push(`    projection switch: ${fmtTok(b.projection)} (${r.projSwitches.count}) — proxy switched compression mode/projection (self-heal degrade-to-proxy re-hoists mid-history developer items, #2867)`);
    out.push(`    wire switch:     ${fmtTok(b.wire)} (${r.wireSwitches.count})`);
    out.push(`    upstream switch: ${fmtTok(b.upstream)} (${r.upstreamSwitches.count})`);
    out.push(`    restart/refork:  ${fmtTok(b.restart)} (${r.restartDrops.count})`);
    // #1847: a dominant unattributed residual with NO observed cause is the misleading case — the README
    // triage order would steer users to "③ bili bug". Name it explicitly as expected provider-side behavior.
    if (b.remaining > 0 && total > 0 && b.remaining / total >= 0.5) {
        const pct = Math.round((b.remaining / total) * 100);
        const noCauseEver = r.modelSwitches.count === 0 && r.effSwitches.count === 0 && r.keySwitches.count === 0 && r.promptSwitches.count === 0 && r.projSwitches.count === 0 && r.wireSwitches.count === 0 && r.upstreamSwitches.count === 0 && r.restartDrops.count === 0;
        out.push(noCauseEver
            ? `  ⚠ ${pct}% of your stable-prefix re-bill has no observable cause (no model/wire/upstream switch or restart seen) — expected provider-side behavior (cache TTL expiry / eviction / relay rotation), NOT a bili bug; if reproducible see #1195 coverage-mismatch`
            : `  ⚠ ${pct}% of your stable-prefix re-bill is unnameable provider-side behavior (cache TTL expiry / eviction / relay rotation) beyond the causes listed above`);
    }
    if (r.unmeasured.samples > 0) {
        out.push(`  unmeasured (provider reported no cache tokens): ${r.unmeasured.samples} sample(s) · ${fmtTok(r.unmeasured.inputTokens)} tok — excluded from hit rate`);
    }
    if (r.initialBills.samples > 0) {
        out.push(`  initial bills (no prior baseline): ${r.initialBills.samples} sample(s) · ${fmtTok(r.initialBills.inputTokens)} tok — first request(s) of a session; booked as new content, not a prefix re-pay`);
    }
    return out.join("\n");
}
