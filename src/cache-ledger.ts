import { createHash, randomUUID } from "node:crypto";
import {
    computeFoldEconomics,
    decomposeSample,
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
import { METADATA_FOLD_COVERAGE, METADATA_SYSTEM_FP } from "./fold-reconcile.js";
import { clearPostRebuildAnchor, markDirty, reanchorNudgeOnUsageDrop, type Session } from "./session.js";
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
     *  fingerprint — the host rewrote the system prompt between requests,
     *  invalidating every downstream prefix cache entry. */
    sf?: 1;
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
    cause?: "restart" | "model" | "key" | "prompt" | "wire" | "upstream";
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
     *  mid-history rewrite; "unknown": bodies above BODY_FULL_CAP (inequality
     *  proven by digest, offset unavailable). Sparse. */
    bs?: "head" | "append" | "mid" | "unknown";
}

interface CacheLedger {
    v: 1;
    lastBlockId: number;
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
         *  wins the attribution partition. */
        promptSwitches: number;
        promptSwitchMissed: number;
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
    invModel?: { seq: number; at: number; from: string | null; to: string };
    invWire?: { seq: number; at: number; from: string | null; to: string };
    invUp?: { seq: number; at: number; from: string | null; to: string };
    invKey?: { seq: number; at: number; from: string | null; to: string };
    invSp?: { seq: number; at: number; from: string | null; to: string };
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
function prefixTokensBeforeRef(session: Session, ref: string): number {
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
}

const SEAM_BODY_CAP = 512 * 1024;
const SEAM_EVENTS_CAP = 8;

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
 *  pairs can report their first-diverging byte offset. */
interface SeamSlot {
    str: string;
    msgs: number | null;
    digest: string;
    full: string | null;
    /** #2131: credential fingerprint of the headers that carried THIS body out.
     *  Preserved across byte-identical re-notes (the non-streaming settle
     *  re-notes the same wireBody without headers in hand). */
    keyFp?: string;
}
const seamLastSent = new WeakMap<Session, SeamSlot>();
const seamLastSettled = new WeakMap<Session, SeamSlot>();
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
            if (v !== "") { cred = v; break; }
        }
    }
    if (cred === undefined) return undefined;
    return "sha256:" + createHash("sha256").update(cred, "utf8").digest("hex").slice(0, 12);
}

/** Record the body of the upstream round that is about to be sent. Called at
 *  the single send chokepoints (loop fetchUpstream, non-streaming forward);
 *  the next settleUsageReport pairs it with the usage report it produced.
 *  `msgs` is the exact outbound message count (#2131); when omitted and the
 *  stored payload is byte-identical to a previously noted one (the non-streaming
 *  settle re-noting the same wireBody), the earlier count is kept. `keyFp` is
 *  the outbound credential fingerprint (#2131) — likewise inherited from the
 *  prior slot on a byte-identical re-note without a fresh capture. */
export function noteForwardedBody(session: Session, body: string, msgs?: number | null, keyFp?: string): void {
    const str = body.length > SEAM_BODY_CAP ? body.slice(0, SEAM_BODY_CAP) : body;
    // #2131: hash the FULL body — the capped head alone cannot tell two payloads
    // sharing a 512 KiB prefix apart. Re-noting a byte-identical payload (the
    // non-streaming settle path) reuses the prior slot's count/full instead of
    // re-deriving them.
    const digest = createHash("sha256").update(body, "utf8").digest("hex");
    const prior = seamLastSent.get(session);
    const samePayload = prior !== undefined && prior.digest === digest;
    seamLastSent.set(session, {
        str,
        msgs: msgs ?? (samePayload ? prior.msgs : null),
        digest,
        full: body.length <= BODY_FULL_CAP ? body : samePayload ? prior.full : null,
        keyFp: keyFp ?? (samePayload ? prior.keyFp : undefined),
    });
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
const LEARNED_PER_IMAGE_MAX = 1_000_000;
const imageFactsLastSent = new WeakMap<Session, ForwardedImageFacts>();

/** Capture side of L1: called at the same send chokepoints as noteForwardedBody
 *  with the image facts of the round about to be sent. The next settleUsageReport
 *  consumes exactly this entry (same pairing guarantee as the seam forensics). */
export function noteForwardedImageFacts(session: Session, facts: ForwardedImageFacts): void {
    imageFactsLastSent.set(session, facts);
}

function settleImageLearning(session: Session, billedTotal: number): void {
    const facts = imageFactsLastSent.get(session);
    if (!facts) return;
    imageFactsLastSent.delete(session);
    if (facts.nImages <= 0 || billedTotal <= 0) return;
    const observed = billedTotal - facts.textSide;
    if (observed <= 0) return; // text estimate overshot the bill — no signal
    const per = observed / facts.nImages;
    if (!(per >= 1 && per <= LEARNED_PER_IMAGE_MAX)) return; // out-of-band sample
    const store = (session.metadata.learnedImageCosts ?? {}) as Record<string, LearnedImageCostEntry>;
    const prev = store[facts.host];
    const cost = prev && typeof prev.cost === "number" ? prev.cost * (1 - LEARNED_IMAGE_COST_ALPHA) + per * LEARNED_IMAGE_COST_ALPHA : per;
    store[facts.host] = { cost, seen: (prev?.seen ?? 0) + 1, ts: Date.now(), fp: facts.fp };
    session.metadata.learnedImageCosts = store;
    markDirty(session);
}

/** Consume side of L1: the learned reserve for THIS payload — learned per-image
 *  cost x current image count, or undefined when no fresh matching evidence
 *  exists (caller then falls back to the prior-based estimate). */
export function learnedImageReserve(session: Session, host: string, nImages: number, fp: string, cap: number): number | undefined {
    if (nImages <= 0) return undefined;
    const entry = (session.metadata.learnedImageCosts as Record<string, LearnedImageCostEntry> | undefined)?.[host];
    if (!entry || typeof entry.cost !== "number" || entry.seen < 1) return undefined;
    if (Date.now() - entry.ts > LEARNED_IMAGE_COST_TTL_MS) return undefined;
    if (entry.fp !== fp) return undefined; // billing/cap reconfigured since learning
    const per = cap > 0 ? Math.min(entry.cost, cap) : entry.cost;
    return per * nImages;
}

function seamLcp(a: string, b: string): { lcpBytes: number; msgIndex: number | null; prevMsgs: number; curMsgs: number } {
    let lcp = 0;
    const n = Math.min(a.length, b.length);
    while (lcp < n && a.charCodeAt(lcp) === b.charCodeAt(lcp)) lcp++;
    // #2339: the message array lives under `messages` (Anthropic/chat), `input`
    // (Responses) or `contents` (Google native) — same caliber as the send-time
    // count captures (server.ts / loop/core.ts). Reading only `.messages` made
    // every Responses/Google pair parse to zero messages: msgIndex degenerated
    // to a fallback 0 that rendered as a real "message[0]", and the count-based
    // classification arms went dead on those wires.
    const msgsOf = (s: string): unknown[] => {
        try {
            const p = JSON.parse(s) as { messages?: unknown; input?: unknown; contents?: unknown };
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
function byteLcp(a: string, b: string): number {
    let lcp = 0;
    const n = Math.min(a.length, b.length);
    while (lcp < n && a.charCodeAt(lcp) === b.charCodeAt(lcp)) lcp++;
    return lcp;
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
    const cur = seamLastSent.get(session);
    const prev = seamLastSettled.get(session);
    let f: ReturnType<typeof seamLcp> | undefined;
    if (cur !== undefined && prev !== undefined) {
        f = seamLcp(prev.str, cur.str);
        // #2131: a body stored at full length is readable; one clipped at
        // SEAM_BODY_CAP parses to zero messages, so parse-derived arms below
        // only decide pairs where that side is under the cap.
        const prevCapped = prev.str.length >= SEAM_BODY_CAP;
        const curCapped = cur.str.length >= SEAM_BODY_CAP;
        // Client reverted/trimmed history: the miss is the sanctioned
        // one-time re-bill of the retained prefix (or the gap's TTL). Only
        // trust the parsed counts when BOTH sides are fully stored — a side
        // clipped at SEAM_BODY_CAP parses to zero messages and would fake a
        // shrink (or hide one); those pairs go to the #2131 byte/count arms.
        if (!prevCapped && !curCapped && f.prevMsgs > 0 && f.curMsgs < f.prevMsgs) {
            agg.rewinds += 1;
            agg.rewindMissed += line.tr;
            return;
        }
        if (cur.str.length < prev.str.length && f.lcpBytes >= cur.str.length - 4) {
            // #2131: the WHOLE current payload survives inside the previous
            // one — a JSON array only diverges from its own longer superstring
            // in the closing-bracket region (the 4-byte tolerance), so this is
            // a sanctioned client-side trim/fold re-bill of the retained prefix,
            // NOT a provider miss. Must run before the byte-stable arm, which
            // would otherwise read "all of cur survives" and book it provider-side.
            agg.rewinds += 1;
            agg.rewindMissed += line.tr;
            return;
        }
        if (f.lcpBytes >= cur.str.length) {
            // Wire was byte-stable against the previous request — the
            // upstream simply did not serve its cache. Provider-side. Above
            // the cap this covers the identical-recorded-head case: anything
            // past SEAM_BODY_CAP is beyond recorded evidence either way.
            agg.providerSideMisses += 1;
            agg.providerSideMissed += line.tr;
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
            agg.providerSideMisses += 1;
            agg.providerSideMissed += line.tr;
            return;
        }
        if (prev.str.length < cur.str.length && f.lcpBytes >= prev.str.length - 4) {
            // #2131: the WHOLE previous payload survives inside the longer
            // current one (JSON appends diverge only in the previous body's
            // closing-bracket region — the 4-byte tolerance). Under the cap the
            // #2059 arm above already decided clean appends, so reaching here
            // means a clipped side was involved and the parsed counts are blind;
            // the exact counts captured at send time must prove pure tail
            // growth. Without them the pair is indistinguishable from a real
            // break and falls through to suspect.
            if (prev.msgs !== null && cur.msgs !== null && cur.msgs > prev.msgs) {
                agg.providerSideMisses += 1;
                agg.providerSideMissed += line.tr;
                return;
            }
        }
        // No decisive byte/count shape (visible break in the recorded region,
        // or capped evidence without exact counts): suspect.
    }
    agg.seamSuspects += 1;
    agg.seamMissed += line.tr;
    line.seam = 1;
    if (cur !== undefined && prev !== undefined && led.seamEvents !== undefined && led.seamEvents.length >= SEAM_EVENTS_CAP) {
        led.seamEvents.shift();
    }
    if (cur !== undefined && prev !== undefined) {
        const forensics = f ?? seamLcp(prev.str, cur.str);
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
            "switches", "switchMissed", "keySwitches", "keySwitchMissed", "promptSwitches", "promptSwitchMissed", "wireSwitches", "wireSwitchMissed",
            "upstreamSwitches", "upstreamSwitchMissed", "restartDrops",
            "restartDropMissed", "attributedMissed", "unknownSamples", "unknownInput",
            "nbSamples", "nbInput",
            "seamSuspects", "seamMissed",
            "providerSideMisses", "providerSideMissed", "rewinds", "rewindMissed", "abortCorrelated",
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
        agg: { requests: 0, input: 0, cached: 0, output: 0, nc: 0, cr: 0, tr: 0, switches: 0, switchMissed: 0, keySwitches: 0, keySwitchMissed: 0, promptSwitches: 0, promptSwitchMissed: 0, wireSwitches: 0, wireSwitchMissed: 0, upstreamSwitches: 0, upstreamSwitchMissed: 0, restartDrops: 0, restartDropMissed: 0, attributedMissed: 0, unknownSamples: 0, unknownInput: 0, nbSamples: 0, nbInput: 0, seamSuspects: 0, seamMissed: 0, providerSideMisses: 0, providerSideMissed: 0, rewinds: 0, rewindMissed: 0, abortCorrelated: 0 },
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

/** Record one provider usage report into the session ledger. `input` must be
 *  NORMALIZED (cached included — promptInputTotal semantics). `cached === null`
 *  means the provider reported NO cache-hit tokens (unmeasurable): such samples
 *  are quarantined out of the closure totals instead of booking their whole
 *  billed prefix as an unexplained ttlRepay residual (#1536). */
export function recordCacheSample(
    session: Session,
    s: { at: number; input: number; cached: number | null; output?: number; protocol?: string; upstream?: string; keyFp?: string; sysFp?: string },
): void {
    const led = getCacheLedger(session);
    detectNewFolds(session, led);
    const prevLine = led.lines[led.lines.length - 1];
    // Same window as buildCacheReport: a fold counts once its timestamp has
    // elapsed (f.at <= s.at), never earlier — keeps incremental and batch math
    // identical under clock skew between block.createdAt and settle time.
    const pendRefs = led.folds.filter((f) => f.seq > led.consumedFoldSeq && f.at <= s.at);
    const pending: FoldEvent[] = pendRefs.map((f) => ({
        at: f.at,
        tokensCompressed: f.S,
        summaryTokens: f.sigma,
        firstFoldStartTokens: f.X,
        viewBefore: f.V,
        viewAfter: f.Vp,
    }));
    // #1536: unknown-cache samples still need a prev/cur pair so the fold chain
    // stays consistent, but decompose with cached=0 then QUARANTINE every derived
    // bucket (line missed/nc/cr/tr forced to 0 + excluded from agg below).
    const known = s.cached !== null;
    const effCached: number = s.cached ?? 0;
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
    // Advance the fold-consume cursor only for measurable samples: an unknown
    // sample must not eat a fold, or its compRepay would never reach a fold owner.
    if (known && pendRefs.length > 0) {
        let hi = 0;
        for (const f of pendRefs) hi = Math.max(hi, f.seq);
        led.consumedFoldSeq = Math.max(led.consumedFoldSeq, hi);
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
    // #1847: detect a dimension change against the last KNOWN value, not the immediately-previous
    // line — an unmeasured (null-cache) request at the switch boundary must not swallow the flag,
    // or the following measured cold re-bill lands unattributed. Unknown samples never advance it.
    const modelSwitched = known && model !== undefined && led.lastKnownModel !== undefined && model !== led.lastKnownModel;
    const wireSwitched = known && proto !== undefined && led.lastKnownProto !== undefined && proto !== led.lastKnownProto;
    const upstreamSwitched = known && up !== undefined && led.lastKnownUp !== undefined && up !== led.lastKnownUp;
    const keySwitched = known && key !== undefined && led.lastKnownKey !== undefined && key !== led.lastKnownKey;
    const promptSwitched = known && sys !== undefined && led.lastKnownSp !== undefined && sys !== led.lastKnownSp;
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
    const cause: "restart" | "model" | "key" | "prompt" | "wire" | "upstream" | null =
        restarted ? "restart"
            : modelSwitched ? "model"
            : keySwitched ? "key"
            : promptSwitched ? "prompt"
            : wireSwitched ? "wire"
            : upstreamSwitched ? "upstream"
            : contWithin(led.invModel) ? "model"
            : contWithin(led.invKey) ? "key"
            : contWithin(led.invSp) ? "prompt"
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
        sw: modelSwitched ? 1 : undefined,
        pw: wireSwitched ? 1 : undefined,
        uw: upstreamSwitched ? 1 : undefined,
        kw: keySwitched ? 1 : undefined,
        sf: promptSwitched ? 1 : undefined,
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
    // Event counters fire whenever a dimension actually changed (or a restart boundary did) — independent
    // of attribution, preserving the full from→to log. Token buckets charge EXACTLY the primary cause so
    // the per-cause breakdown partitions the residual instead of overlapping it across dimensions.
    if (modelSwitched) agg.switches += 1;
    if (keySwitched) agg.keySwitches += 1;
    if (promptSwitched) agg.promptSwitches += 1;
    if (wireSwitched) agg.wireSwitches += 1;
    if (upstreamSwitched) agg.upstreamSwitches += 1;
    if (restarted) agg.restartDrops += 1;
    if (cause === "model") agg.switchMissed += dec.ttlRepay;
    else if (cause === "key") agg.keySwitchMissed += dec.ttlRepay;
    else if (cause === "prompt") agg.promptSwitchMissed += dec.ttlRepay;
    else if (cause === "wire") agg.wireSwitchMissed += dec.ttlRepay;
    else if (cause === "upstream") agg.upstreamSwitchMissed += dec.ttlRepay;
    else if (cause === "restart") agg.restartDropMissed += dec.ttlRepay;
    if (cause !== null) agg.attributedMissed += dec.ttlRepay;
    // Advance the trackers (measured samples only): a warm line retires every open cold-window, an expired
    // window drops out, and a fresh change opens/replaces it.
    if (isWarm) {
        led.invModel = undefined;
        led.invWire = undefined;
        led.invUp = undefined;
        led.invKey = undefined;
        led.invSp = undefined;
    } else {
        if (led.invModel && seq - led.invModel.seq > SWITCH_COLD_ROUNDS) led.invModel = undefined;
        if (led.invWire && seq - led.invWire.seq > SWITCH_COLD_ROUNDS) led.invWire = undefined;
        if (led.invUp && seq - led.invUp.seq > SWITCH_COLD_ROUNDS) led.invUp = undefined;
        if (led.invKey && seq - led.invKey.seq > SWITCH_COLD_ROUNDS) led.invKey = undefined;
        if (led.invSp && seq - led.invSp.seq > SWITCH_COLD_ROUNDS) led.invSp = undefined;
    }
    if (modelSwitched) led.invModel = { seq, at: s.at, from: led.lastKnownModel ?? null, to: model! };
    if (wireSwitched) led.invWire = { seq, at: s.at, from: led.lastKnownProto ?? null, to: proto! };
    if (upstreamSwitched) led.invUp = { seq, at: s.at, from: led.lastKnownUp ?? null, to: up! };
    if (keySwitched) led.invKey = { seq, at: s.at, from: led.lastKnownKey ?? null, to: key! };
    if (promptSwitched) led.invSp = { seq, at: s.at, from: led.lastKnownSp ?? null, to: sys! };
    if (model !== undefined) led.lastKnownModel = model;
    if (proto !== undefined) led.lastKnownProto = proto;
    if (up !== undefined) led.lastKnownUp = up;
    if (key !== undefined) led.lastKnownKey = key;
    if (sys !== undefined) led.lastKnownSp = sys;
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

export function settleUsageReport(
    session: Session,
    s: { total: number; reportedCached: number | null; output?: number; protocol?: string; upstream?: string },
    localTextEstimate?: number,
): void {
    // #793: a zero-total sample carries no information (gateway placeholder or
    // relay echo) — it must not clobber the last trusted lastInputTokens.
    if (s.total > 0) {
        session.stats.inputTokens += s.total;
        // Net out this turn's compress credit: the post-compress re-request
        // re-sends the unfolded history, so its usage report over-reports the
        // context the NEXT request will actually carry (see stream.ts applyRanges).
        session.stats.lastInputTokens = Math.max(0, s.total - (session.stats.compressCreditTokens ?? 0));
        // #1569: calibration anchor for estimate-grade turns — written ONLY by
        // real upstream usage reports (all three response shapes funnel here),
        // never by estimate-grade samples or arming paths; dropped at native-
        // compaction boundaries via resetSessionCompression (session.ts).
        session.stats.lastUsageGradeTokens = session.stats.lastInputTokens;
        session.stats.lastInputTokensSource = "usage";
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
        const pendingEst = session.stats.lastLocalTextEstimate;
        const pendingOrigin = normalizeUpstreamOrigin(session.stats.lastLocalTextEstimateOrigin);
        if (pendingEst !== undefined && pendingEst >= CALIBRATION_MIN_ESTIMATE && settleOrigin !== undefined && pendingOrigin === settleOrigin) {
            const rawSample = s.total / pendingEst;
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
                    session.stats.calibratedEstimate = Math.min(CALIBRATION_CLAMP_MAX, Math.max(CALIBRATION_CLAMP_MIN, mean));
                    session.stats.calibratedEstimateOrigin = settleOrigin;
                    // Provenance is the ring's model key, not this sample's stamp —
                    // an unknown-model settle continues a model-keyed ring without
                    // blanking the established provenance.
                    session.stats.calibratedEstimateModel = ring.model;
                } else {
                    delete session.stats.calibratedEstimate;
                    delete session.stats.calibratedEstimateOrigin;
                    delete session.stats.calibratedEstimateModel;
                }
            }
            session.stats.calibrationRing = ring;
        }
        // #1820: a real usage-grade sample supersedes the post-rebuild meter
        // anchor immediately — no need to wait out its prepare budget.
        clearPostRebuildAnchor(session);
        // #1110: a real usage report retires the one-shot overflow arm.
        delete session.stats.overflowArmTokens;
        // #1595: a real report landing far below a stale-high nudge reference
        // retires that reference too (one call covers all three lanes).
        reanchorNudgeOnUsageDrop(session);
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
    const curKeyFp = seamLastSent.get(session)?.keyFp;
    // #2350: the host's system-prompt fingerprint as noted for THIS request by
    // fold-reconcile's wire sites (they precede this settle under the session
    // lock). Sparse: lanes that never noted one (title-gen / compaction-trigger
    // sidecars) carry no value and can neither flag nor advance the baseline.
    const notedSys = session.metadata?.[METADATA_SYSTEM_FP] as { fp?: unknown } | undefined;
    const curSysFp = typeof notedSys?.fp === "string" && notedSys.fp !== "" ? notedSys.fp : undefined;
    const led = getCacheLedger(session);
    recordCacheSample(session, { at: Date.now(), input: s.total, cached: s.reportedCached, output: s.output, protocol: s.protocol, upstream: s.upstream, keyFp: curKeyFp, sysFp: curSysFp });
    // #2131: per-call body-stability proof on the just-recorded line — the same
    // pairing detectSeam uses (this request's forwarded body vs the previous
    // settled one), so "prefix unchanged between calls" is stored data, not an
    // interpretation. Digest equality decides; the LCP offset localizes where
    // a divergence started when both full bodies were retained.
    const curSlot = seamLastSent.get(session);
    if (curSlot !== undefined) {
        const curLine = led.lines[led.lines.length - 1];
        if (curLine !== undefined) {
            curLine.bd = curSlot.digest;
            const prevSlot = seamLastSettled.get(session);
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
                        curLine.bs = lcp >= Math.min(prevSlot.full.length, curSlot.full.length) - 64 ? "append" : lcp < 1024 ? "head" : "mid";
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
    const seamBody = seamLastSent.get(session);
    if (seamBody !== undefined) seamLastSettled.set(session, seamBody);
    seamLastSent.delete(session);
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

/** #2478: WHERE a stamped price profile came from — report faces must tell
 *  ABSOLUTE $/Mtok profiles (a models.dev row was stamped; its units are
 *  already money) apart from INPUT-RATIO profiles (user config / kernel
 *  defaults; units are input-token-equivalents that need an input-price
 *  anchor to convert to dollars). Absent on ledgers persisted before #2478 —
 *  those sessions stay token-denominated rather than guessing. Metadata is
 *  persisted user-editable JSON, so every field is re-validated on read,
 *  same discipline as stampedPriceProfile. */
export interface PriceSourceStamp {
    kind: "config" | "registry";
    /** #2478 round 2: user-configured ABSOLUTE $/Mtok unit prices (costPerMtok
     *  config) — the stamped profile is already real money, so scale is 1 and
     *  no models.dev anchor exists (modelKey absent by construction). */
    absolute?: boolean;
    /** models.dev catalog key that resolved ("provider/model-id") — display identity. */
    modelKey?: string;
    /** Input list price in $/Mtok — the anchor converting ratio-profile units to $. */
    inputPerMtok?: number;
    /** Output list price in $/Mtok (display only). */
    outputPerMtok?: number;
    /** Cache-read list price in $/Mtok (display only). */
    cacheReadPerMtok?: number;
    /** Cache-write list price in $/Mtok (display only; absent when no write premium). */
    cacheWritePerMtok?: number;
}

export function parsePriceSourceStamp(raw: unknown): PriceSourceStamp | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const o = raw as Record<string, unknown>;
    if (o.kind !== "config" && o.kind !== "registry") return undefined;
    const out: PriceSourceStamp = { kind: o.kind };
    if (o.absolute === true) out.absolute = true;
    if (typeof o.modelKey === "string" && o.modelKey !== "") out.modelKey = o.modelKey;
    for (const key of ["inputPerMtok", "outputPerMtok", "cacheReadPerMtok", "cacheWritePerMtok"] as const) {
        const n = o[key];
        if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
    }
    return out;
}

function stampedPriceSource(session: Session): PriceSourceStamp | undefined {
    return parsePriceSourceStamp(session.metadata?.cachePriceSource);
}

/** #2478: price-weighted fold P&L in real money, mirroring the kernel's
 *  computeFoldEconomics unit math EXACTLY — one-time cost (w−r)·T + q·σ − r·S
 *  and per-later-request saving (S−σ)·r — so dollar figures reconcile with
 *  the ΔC₁/Δs printed per fold. Recomputed here from the RAW fold fields
 *  because the kernel rounds its own outputs (round1), which would drift when
 *  summing many folds. Verdict classification mirrors the kernel too:
 *  breakevenTurns = max(0, oneTime)/perTurn when perTurn > 0, paid back iff
 *  requestsAfter reached it, else unobserved. scale maps unit→μ$: 1 for
 *  absolute $/Mtok profiles (models.dev rows OR user costPerMtok config —
 *  source.absolute), the input anchor ($/Mtok) over ratio profiles.
 *  Returns undefined when the session cannot be priced (no source stamp, or a
 *  ratio profile without an input anchor) — callers keep the token display. */
export interface PricedFoldSummary {
    source: PriceSourceStamp;
    /** μ$ per unit of the effective profile (1 = absolute, else input anchor $/Mtok). */
    scale: number;
    grossUsd: number;
    /** Σ one-time fold costs ((w−r)·T re-pay premium + q·σ summary output − r·S read-back credit). */
    oneTimeUsd: number;
    netUsd: number;
    paidBackCount: number;
    notPaidBackCount: number;
    unobservedCount: number;
}

export function summarizePricedFolds(
    folds: readonly { S: number; sigma: number; T: number; requestsAfter: number }[],
    profile: Required<PriceProfile>,
    source: PriceSourceStamp | undefined,
): PricedFoldSummary | undefined {
    if (source === undefined) return undefined;
    const scale = source.kind === "registry" || source.absolute === true ? 1 : source.inputPerMtok;
    if (typeof scale !== "number" || !Number.isFinite(scale) || !(scale > 0)) return undefined;
    const { w, r, q } = profile;
    let grossUnits = 0;
    let oneTimeUnits = 0;
    let paidBack = 0;
    let notPaidBack = 0;
    let unobserved = 0;
    for (const f of folds) {
        const oneTime = (w - r) * f.T + q * f.sigma - r * f.S;
        oneTimeUnits += oneTime;
        const perTurn = (f.S - f.sigma) * r;
        if (perTurn > 0) {
            grossUnits += perTurn * f.requestsAfter;
            const breakevenTurns = Math.max(0, oneTime) / perTurn;
            if (f.requestsAfter >= breakevenTurns) paidBack += 1;
            else notPaidBack += 1;
        } else {
            unobserved += 1;
        }
    }
    const usd = (units: number): number => (units * scale) / 1_000_000;
    return {
        source,
        scale,
        grossUsd: usd(grossUnits),
        oneTimeUsd: usd(oneTimeUnits),
        netUsd: usd(grossUnits - oneTimeUnits),
        paidBackCount: paidBack,
        notPaidBackCount: notPaidBack,
        unobservedCount: unobserved,
    };
}

/** #2478: human-readable provenance line shared by /acp-cache and web faces. */
export function formatPriceSourceLine(src: PriceSourceStamp): string {
    const money = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(n >= 100 ? 0 : 1)}`;
    if (src.kind === "registry") {
        const parts = [`in ${money(src.inputPerMtok ?? 0)}`];
        if (src.cacheReadPerMtok !== undefined) parts.push(`read ${money(src.cacheReadPerMtok)}`);
        if (src.cacheWritePerMtok !== undefined) parts.push(`write ${money(src.cacheWritePerMtok)}`);
        if (src.outputPerMtok !== undefined) parts.push(`out ${money(src.outputPerMtok)}`);
        return `models.dev ${src.modelKey ?? "?"} @ ${parts.join(" · ")} per Mtok`;
    }
    if (src.absolute === true) {
        // #2478 round 2: user-supplied $/Mtok unit prices — same part order as
        // the registry line, but no models.dev identity (the user IS the source).
        const parts = [`in ${money(src.inputPerMtok ?? 0)}`];
        if (src.cacheReadPerMtok !== undefined) parts.push(`read ${money(src.cacheReadPerMtok)}`);
        if (src.cacheWritePerMtok !== undefined) parts.push(`write ${money(src.cacheWritePerMtok)}`);
        if (src.outputPerMtok !== undefined) parts.push(`out ${money(src.outputPerMtok)}`);
        return `configured costPerMtok @ ${parts.join(" · ")}`;
    }
    const anchor = src.inputPerMtok !== undefined ? ` anchored at ${money(src.inputPerMtok)}/Mtok input${src.modelKey ? ` (models.dev ${src.modelKey})` : ""}` : "";
    return `configured priceProfile (input-ratio)${anchor}`;
}

interface ModelSwitchEvent {
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
    key: number;
    /** #2350: stable-prefix re-bill charged to host system-prompt rewrites. */
    prompt: number;
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
    /** be=0: diverged; the four classes partition this count. */
    diverged: number;
    /** Divergence inside the first 1 KiB — host-side parameter region (model/tools/sampling/system), NOT a history rewrite. */
    head: number;
    /** Whole shorter payload survives ±64 closing-bracket bytes — pure tail growth/trim. */
    append: number;
    /** Mid-history byte change — the shape a real rewrite has. */
    mid: number;
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
    lines: Array<CacheReportLine & { bodyDigest?: string; bodyEqual?: 0 | 1; bodyLcp?: number; bodyClass?: "head" | "append" | "mid" | "unknown"; keyFp?: string; sysFp?: string }>;
    modelSwitches: ModelSwitchStats;
    /** #2131: relay account rotations (credential fingerprint changes) —
     *  the identity a URL-granular upstream switch cannot see. */
    keySwitches: ModelSwitchStats;
    /** #2350: host system-prompt rewrites (system fingerprint changes between
     *  consecutive requests — the host edits its own instructions). */
    promptSwitches: ModelSwitchStats;
    wireSwitches: ModelSwitchStats;
    upstreamSwitches: ModelSwitchStats;
    restartDrops: ModelSwitchStats;
    unmeasured: { samples: number; inputTokens: number };
    /** #1891: first-bill samples with no prior baseline — their uncached input
     *  is booked as new content, never as a prefix re-pay. */
    initialBills: { samples: number; inputTokens: number };
    invalidation: InvalidationTokenBreakdown;
    seam: { suspects: number; missed: number; events: SeamEvent[]; providerSide: { count: number; missed: number }; rewinds: { count: number; missed: number }; abortCorrelated: number };
    /** #2478: real-money P&L when the session carries a usable price source;
     *  absent on unpriced sessions (token-denominated display stays). */
    priced?: PricedFoldSummary;
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
    // #2478: real-money P&L from the RAW fold fields (kernel outputs are
    // rounded; summing them would drift) — undefined when unpriced.
    const priced = summarizePricedFolds(led.folds, effective, stampedPriceSource(session));
    // Unknown-cache samples are quarantined out of the rendered line set — they
    // carry no measurable hit rate and would show as misleading 0% rows.
    const knownLines = led.lines.filter((l) => l.unk !== 1);
    const switchEvents = (flag: (l: LedgerLine) => boolean, value: (l: LedgerLine | undefined) => string | undefined, dim: "model" | "key" | "prompt" | "wire" | "upstream"): ModelSwitchEvent[] => {
        const evs: ModelSwitchEvent[] = [];
        for (let i = 0; i < led.lines.length; i++) {
            const l = led.lines[i];
            if (!l || l.unk === 1 || !flag(l)) continue;
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
        key: a.keySwitchMissed,
        prompt: a.promptSwitchMissed,
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
    let unknownOffset = 0;
    for (const l of knownLines) {
        if (l.be === undefined) continue;
        paired += 1;
        if (l.be === 1) { equal += 1; continue; }
        if (l.bs === "head") head += 1;
        else if (l.bs === "append") append += 1;
        else if (l.bs === "mid") mid += 1;
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
            bodyDigest: l.bd,
            keyFp: l.kp,
            sysFp: l.sp,
            bodyEqual: l.be,
            bodyLcp: l.bl,
            bodyClass: l.bs,
        })),
        linesOmitted: led.sampleSeq - led.lines.length,
        modelSwitches: { count: a.switches, missedTokens: a.switchMissed, events: switchEvents((l) => l.sw === 1 && l.model !== undefined, (l) => l?.model, "model") },
        keySwitches: { count: a.keySwitches, missedTokens: a.keySwitchMissed, events: switchEvents((l) => l.kw === 1 && l.kp !== undefined, (l) => l?.kp, "key") },
        promptSwitches: { count: a.promptSwitches, missedTokens: a.promptSwitchMissed, events: switchEvents((l) => l.sf === 1 && l.sp !== undefined, (l) => l?.sp, "prompt") },
        wireSwitches: { count: a.wireSwitches, missedTokens: a.wireSwitchMissed, events: switchEvents((l) => l.pw === 1 && l.proto !== undefined, (l) => l?.proto, "wire") },
        upstreamSwitches: { count: a.upstreamSwitches, missedTokens: a.upstreamSwitchMissed, events: switchEvents((l) => l.uw === 1 && l.up !== undefined, (l) => l?.up, "upstream") },
        restartDrops: { count: a.restartDrops, missedTokens: a.restartDropMissed, events: restartEvents },
        unmeasured: { samples: a.unknownSamples, inputTokens: a.unknownInput },
        initialBills: { samples: a.nbSamples, inputTokens: a.nbInput },
        invalidation,
        stability,
        seam: { suspects: a.seamSuspects, missed: a.seamMissed, events: led.seamEvents ?? [], providerSide: { count: a.providerSideMisses, missed: a.providerSideMissed }, rewinds: { count: a.rewinds, missed: a.rewindMissed }, abortCorrelated: a.abortCorrelated },
        ...(priced !== undefined ? { priced } : {}),
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

function formatStability(st: BodyStability): string {
    if (st.paired === 0) return "";
    const out: string[] = ["BODY STABILITY (per-call outbound byte proof, vs previous settled request)"];
    out.push(`  ${st.paired} pair(s): ${st.equal} byte-identical · ${st.diverged} diverged`);
    out.push(`  divergence class: head <1KiB ${st.head} · tail-append ${st.append} · mid-history ${st.mid} · offset-unknown(capped) ${st.unknownOffset}`);
    if (st.head > 0) out.push(`  ⚠ ${st.head} head-region divergence(s) — model/tools/sampling/system changed between calls (host-side parameter change, NOT a bili history rewrite)`);
    if (st.mid > 0) out.push(`  ⚠ ${st.mid} mid-history divergence(s) — real prefix rewrites; inspect the seam events above`);
    const sb = st.sizeBuckets.filter((b) => b.n >= 3);
    if (sb.length >= 2) out.push("  hit% by input size (median): " + sb.map((b) => `${Math.round(b.lo / 1000)}K=${b.hitMedian}%`).join("  "));
    const g = st.gapSplit;
    if (g.lowHitMedGapMs !== null && g.highHitMedGapMs !== null) {
        out.push(`  inter-request gap median: low-hit(<80%) ${(g.lowHitMedGapMs / 1000).toFixed(1)}s vs high-hit ${(g.highHitMedGapMs / 1000).toFixed(1)}s`);
    }
    return out.join("\n");
}

function fmtUsd(n: number): string {
    const sign = n < 0 ? "-" : "";
    const a = Math.abs(n);
    if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
    if (a >= 10_000) return `${sign}$${(a / 1_000).toFixed(1)}K`;
    if (a >= 100) return `${sign}$${a.toFixed(1)}`;
    return `${sign}$${a.toFixed(2)}`;
}

/** #2478: the PRICED ECONOMICS block — real-money P&L alongside the kernel's
 *  token-denominated FOLD ECONOMICS. Rendered only when the session is
 *  priced; unpriced sessions keep the pre-#2478 byte-identical report. */
function formatPricedEconomics(r: BiliCacheReport): string {
    const p = r.priced;
    if (!p) return "";
    const out: string[] = [`PRICED ECONOMICS (${formatPriceSourceLine(p.source)})`];
    // #2478 round 2: pair every $ figure with the kernel's token figures so the
    // two calibers stay side by side (owner: keep both, money may be off).
    // One-time cost deliberately has no token twin: its $ value nets the −r·S
    // cache-read-back credit, which the kernel's repay+summary token sums do not.
    const e = r.economics;
    out.push(`  gross saved ≈ ${fmtUsd(p.grossUsd)} (${e.grossSaved} tok) · one-time cost ≈ ${fmtUsd(p.oneTimeUsd)} (re-pay premium + summary output) → net ≈ ${fmtUsd(p.netUsd)} (${e.netTokens} tok)`);
    out.push(`  verdict: ${p.paidBackCount} paid back · ${p.notPaidBackCount} not paid back · ${p.unobservedCount} unobserved`);
    if (r.modelSwitches.count > 0) out.push("  ⚠ prices are the LAST observed model's listing — this session switched models mid-flight, so earlier folds are priced with the later model (mixed caliber)");
    out.push("  list-price estimate (models.dev / configured ratios) — not an actual billing statement");
    return out.join("\n");
}

export function handleAcpCache(session: Session, args?: Record<string, unknown>): ProxyToolResult {
    try {
        const detail = args?.detail === "full" ? "full" : "summary";
        const report = buildSessionCacheReport(session);
        const stabilityText = formatStability(report.stability);
        // #2478: PRICED ECONOMICS sits right after the kernel report (whose
        // FOLD ECONOMICS it prices), before the switch sections.
        const pricedJoin = (() => { const t = formatPricedEconomics(report); return t ? "\n\n" + t : ""; })();
        const tail = (base: string): string => base + (stabilityText ? "\n\n" + stabilityText : "") + (formatSeam(report) ? "\n\n" + formatSeam(report) : "");
        // #2131: key switches get their own section only when observed — the
        // common case (one account, no rotation) stays byte-identical.
        const keyText = report.keySwitches.count > 0 ? "\n\n" + formatModelSwitches(report.keySwitches, detail, "KEY SWITCHES (relay account rotation)") : "";
        // #2350: host system-prompt rewrites get their own section only when
        // observed — sessions whose host never rewrites stay byte-identical.
        const promptText = report.promptSwitches.count > 0 ? "\n\n" + formatModelSwitches(report.promptSwitches, detail, "PROMPT SWITCHES (host rewrote system prompt)") : "";
        if (detail === "full" && report.lines.length > FULL_DETAIL_LINES) {
            const dropped = report.lines.length - FULL_DETAIL_LINES;
            const capped = formatCacheReport(
                { ...report, lines: report.lines.slice(-FULL_DETAIL_LINES), linesOmitted: report.linesOmitted + dropped },
                session.id,
                { detail },
            );
            return toolOk(tail(capped + pricedJoin + "\n\n" + formatModelSwitches(report.modelSwitches, detail) + keyText + promptText + "\n\n" + formatInvalidation(report)));
        }
        return toolOk(tail(formatCacheReport(report, session.id, { detail }) + pricedJoin + "\n\n" + formatModelSwitches(report.modelSwitches, detail) + keyText + promptText + "\n\n" + formatInvalidation(report)));
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
        for (const e of r.seam.events) {
            out.push(`    #${e.seq} ${fmtTime(e.at)} hit ${e.hitPct.toFixed(1)}% · input ${fmtTok(e.input)} · divergence ≥${fmtTok(e.lcpBytes)}B at message[${e.msgIndex ?? "?"}] of ${e.prevMsgs}→${e.curMsgs}`);
        }
        if (r.seam.events.length === 0) {
            out.push("    (no body-pair forensics on this lane — aggregate flag only; report the session + log if this persists)");
        }
        out.push("  if reproducible: /acp-cache detail:\"full\" + bili.log around the timestamps above (likely a #1548-family round-2/steady render seam)");
    }
    if (r.seam.rewinds.count > 0) {
        out.push("↩ HISTORY REWOUND (client revert/trim)");
        out.push(`  ${r.seam.rewinds.count} sample(s) · ${fmtTok(r.seam.rewinds.missed)} tok re-billed once for the retained prefix — sanctioned client intent, not a rebuild seam`);
    }
    if (r.seam.providerSide.count > 0) {
        out.push("▲ PROVIDER-SIDE MISS (previous request's message list fully preserved)");
        out.push(`  ${r.seam.providerSide.count} sample(s) · ${fmtTok(r.seam.providerSide.missed)} tok — the previous request's message list is preserved in this one (byte-for-byte under the 512 KiB forensics cap; above it, proven by the stable recorded head plus exact message-count growth — any difference is only the appended tail); the upstream did not serve its cache (TTL expiry / eviction / relay node rotation). Not a bili rebuild seam.`);
        out.push(`  stateful-upstream check (#2483): if your upstream keeps a live session per conversation and validates the echoed history against its own transcript (claude-code-based relays such as magpie), bili's render tags on assistant text trip that check even though bili's own list is unchanged — set diagnostics.renderNone=true until per-route render-tags control ships; expect exactly ONE replay when flipping the flag mid-session`);
    }
    if (r.seam.abortCorrelated > 0) {
        out.push("⏻ ABORT-CORRELATED");
        out.push(`  ${r.seam.abortCorrelated} missed sample(s) within 30s of a client mid-stream abort — abort/retry churn rewrites the resent tail; correlation, not causation (see bili.log 'client aborted mid-stream')`);
    }
    return out.length > 0 ? out.join("\n") : "";
}

function formatInvalidation(r: BiliCacheReport): string {
    const b = r.invalidation;
    const named = b.model + b.key + b.prompt + b.wire + b.upstream + b.restart;
    const total = named + b.remaining;
    const out: string[] = ["CACHE INVALIDATION"];
    out.push(`  stable-prefix re-bill by cause (mutually exclusive, sums to total): ${fmtTok(named)} tok charged · ${fmtTok(b.remaining)} tok unattributed (upstream TTL/eviction/wire rewrite)`);
    out.push(`    model switch:    ${fmtTok(b.model)} (${r.modelSwitches.count})`);
    out.push(`    key switch:      ${fmtTok(b.key)} (${r.keySwitches.count}) — relay account rotation, fingerprinted headers never logged raw`);
    out.push(`    prompt rewrite:  ${fmtTok(b.prompt)} (${r.promptSwitches.count}) — host rewrote its system prompt between requests (#2350)`);
    out.push(`    wire switch:     ${fmtTok(b.wire)} (${r.wireSwitches.count})`);
    out.push(`    upstream switch: ${fmtTok(b.upstream)} (${r.upstreamSwitches.count})`);
    out.push(`    restart/refork:  ${fmtTok(b.restart)} (${r.restartDrops.count})`);
    // #1847: a dominant unattributed residual with NO observed cause is the misleading case — the README
    // triage order would steer users to "③ bili bug". Name it explicitly as expected provider-side behavior.
    if (b.remaining > 0 && total > 0 && b.remaining / total >= 0.5) {
        const pct = Math.round((b.remaining / total) * 100);
        const noCauseEver = r.modelSwitches.count === 0 && r.keySwitches.count === 0 && r.promptSwitches.count === 0 && r.wireSwitches.count === 0 && r.upstreamSwitches.count === 0 && r.restartDrops.count === 0;
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
