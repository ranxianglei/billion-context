import { randomUUID } from "node:crypto";
import {
    computeFoldEconomics,
    decomposeSample,
    formatCacheReport,
    summarizeFoldEconomics,
    type CacheReport,
    type CacheTotals,
    type CompressionBlock,
    type FoldEvent,
    type PriceProfile,
} from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import { markDirty, reanchorNudgeOnUsageDrop, type Session } from "./session.js";
import { normalizeUpstreamOrigin } from "./util.js";

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
    cause?: "restart" | "model" | "wire" | "upstream";
}

export interface CacheLedger {
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
         *  appended. Either way the upstream simply did not serve its cache
         *  (TTL expiry / eviction / relay node rotation). Not a rebuild seam. */
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
    invModel?: { seq: number; at: number; from: string | null; to: string };
    invWire?: { seq: number; at: number; from: string | null; to: string };
    invUp?: { seq: number; at: number; from: string | null; to: string };
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
    /** Index of the first message element whose serialized form differs. */
    msgIndex: number;
    prevMsgs: number;
    curMsgs: number;
}

const SEAM_BODY_CAP = 512 * 1024;
const SEAM_EVENTS_CAP = 8;
const seamLastSent = new WeakMap<Session, string>();
const seamLastSettled = new WeakMap<Session, string>();
const lastClientAbort = new WeakMap<Session, number>();

export interface ContextObservation {
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

/** Record the body of the upstream round that is about to be sent. Called at
 *  the single send chokepoints (loop fetchUpstream, non-streaming forward);
 *  the next settleUsageReport pairs it with the usage report it produced. */
export function noteForwardedBody(session: Session, body: string): void {
    seamLastSent.set(session, body.length > SEAM_BODY_CAP ? body.slice(0, SEAM_BODY_CAP) : body);
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
export interface ForwardedImageFacts {
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

function seamLcp(a: string, b: string): { lcpBytes: number; msgIndex: number; prevMsgs: number; curMsgs: number } {
    let lcp = 0;
    const n = Math.min(a.length, b.length);
    while (lcp < n && a.charCodeAt(lcp) === b.charCodeAt(lcp)) lcp++;
    const msgsOf = (s: string): unknown[] => {
        try {
            const arr = (JSON.parse(s) as { messages?: unknown }).messages;
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
    return { lcpBytes: lcp, msgIndex: i, prevMsgs: ma.length, curMsgs: mb.length };
}

/** Append-only turn shape: the previous message list survives byte-identical as a
 *  prefix of the current one, so every difference is in the appended tail and no
 *  prefix break exists. */
function seamTailAppendOnly(f: { msgIndex: number; prevMsgs: number }): boolean {
    return f.prevMsgs > 0 && f.msgIndex === f.prevMsgs;
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
    if (cur !== undefined && prev !== undefined) {
        const f = seamLcp(prev, cur);
        if (f.curMsgs < f.prevMsgs) {
            // Client reverted/trimmed history: the miss is the sanctioned
            // one-time re-bill of the retained prefix (or the gap's TTL).
            agg.rewinds += 1;
            agg.rewindMissed += line.tr;
            return;
        }
        // A body clipped at SEAM_BODY_CAP cannot prove anything about the bytes past
        // its recorded end — two clipped bodies share their whole recorded prefix by
        // construction, which would read as "byte-stable" (or as an append-only tail)
        // even when a real divergence sits past the cap. Both arms need full evidence.
        const bothUnderCap = prev.length < SEAM_BODY_CAP && cur.length < SEAM_BODY_CAP;
        if (bothUnderCap && (f.lcpBytes >= cur.length || seamTailAppendOnly(f))) {
            // The previous request's payload came back byte-identical (whole body,
            // or its entire message list as a prefix with only tail messages
            // appended) — nothing the client sent broke the prefix, so the
            // upstream simply did not serve its cache. Provider-side.
            agg.providerSideMisses += 1;
            agg.providerSideMissed += line.tr;
            return;
        }
    }
    agg.seamSuspects += 1;
    agg.seamMissed += line.tr;
    line.seam = 1;
    if (cur !== undefined && prev !== undefined && led.seamEvents !== undefined && led.seamEvents.length >= SEAM_EVENTS_CAP) {
        led.seamEvents.shift();
    }
    if (cur !== undefined && prev !== undefined) {
        const f = seamLcp(prev, cur);
        const ev: SeamEvent = { seq: line.seq, at: line.at, input: line.input, hitPct: line.hitPct ?? 0, ...f };
        (led.seamEvents ?? (led.seamEvents = [])).push(ev);
        if (agg.seamSuspects === 1) {
            loggerLog("warn", `[${session.id}] [cache-seam] suspected mid-history prefix break: hit ${line.hitPct}% (input=${line.input}, unexplained=${Math.round(line.tr)} tok, no fold/switch/restart attribution); first divergence at byte ${ev.lcpBytes}, message[${ev.msgIndex}] of ${ev.prevMsgs}→${ev.curMsgs} — see /acp-cache for the seam section`);
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
            "switches", "switchMissed", "wireSwitches", "wireSwitchMissed",
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
        agg: { requests: 0, input: 0, cached: 0, output: 0, nc: 0, cr: 0, tr: 0, switches: 0, switchMissed: 0, wireSwitches: 0, wireSwitchMissed: 0, upstreamSwitches: 0, upstreamSwitchMissed: 0, restartDrops: 0, restartDropMissed: 0, attributedMissed: 0, unknownSamples: 0, unknownInput: 0, nbSamples: 0, nbInput: 0, seamSuspects: 0, seamMissed: 0, providerSideMisses: 0, providerSideMissed: 0, rewinds: 0, rewindMissed: 0, abortCorrelated: 0 },
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
    s: { at: number; input: number; cached: number | null; output?: number; protocol?: string; upstream?: string },
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
    // #1847: detect a dimension change against the last KNOWN value, not the immediately-previous
    // line — an unmeasured (null-cache) request at the switch boundary must not swallow the flag,
    // or the following measured cold re-bill lands unattributed. Unknown samples never advance it.
    const modelSwitched = known && model !== undefined && led.lastKnownModel !== undefined && model !== led.lastKnownModel;
    const wireSwitched = known && proto !== undefined && led.lastKnownProto !== undefined && proto !== led.lastKnownProto;
    const upstreamSwitched = known && up !== undefined && led.lastKnownUp !== undefined && up !== led.lastKnownUp;
    // #499: first KNOWN sample under a fresh daemon boot with prior history →
    // proxy-restart / re-fork boundary (upstream KV dropped during downtime).
    const restarted = known && led.lines.length > 0 && led.lastBoot !== undefined && led.lastBoot !== BOOT_ID;
    // #1286: turn counting is decoupled from compRepay attribution — the
    // consumedFoldSeq gate above applies to the pending list only. Every
    // elapsed fold counts EVERY later sample, matching buildCacheReport's
    // full post-fold requestsAfter window. hPct seeds from the first KNOWN
    // post-fold sample only (unknown samples carry no measurable hit rate).
    for (const f of led.folds) {
        if (f.at <= s.at) {
            f.requestsAfter += 1;
            if (known && f.hPct === null) f.hPct = hitPct;
        }
    }
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
    const cause: "restart" | "model" | "wire" | "upstream" | null =
        restarted ? "restart"
            : modelSwitched ? "model"
            : wireSwitched ? "wire"
            : upstreamSwitched ? "upstream"
            : contWithin(led.invModel) ? "model"
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
        sw: modelSwitched ? 1 : undefined,
        pw: wireSwitched ? 1 : undefined,
        uw: upstreamSwitched ? 1 : undefined,
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
    if (wireSwitched) agg.wireSwitches += 1;
    if (upstreamSwitched) agg.upstreamSwitches += 1;
    if (restarted) agg.restartDrops += 1;
    if (cause === "model") agg.switchMissed += dec.ttlRepay;
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
    } else {
        if (led.invModel && seq - led.invModel.seq > SWITCH_COLD_ROUNDS) led.invModel = undefined;
        if (led.invWire && seq - led.invWire.seq > SWITCH_COLD_ROUNDS) led.invWire = undefined;
        if (led.invUp && seq - led.invUp.seq > SWITCH_COLD_ROUNDS) led.invUp = undefined;
    }
    if (modelSwitched) led.invModel = { seq, at: s.at, from: led.lastKnownModel ?? null, to: model! };
    if (wireSwitched) led.invWire = { seq, at: s.at, from: led.lastKnownProto ?? null, to: proto! };
    if (upstreamSwitched) led.invUp = { seq, at: s.at, from: led.lastKnownUp ?? null, to: up! };
    if (model !== undefined) led.lastKnownModel = model;
    if (proto !== undefined) led.lastKnownProto = proto;
    if (up !== undefined) led.lastKnownUp = up;
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
// one relay vs ~1.0× on another in the same session), so k̂ is learned per
// route and only applied on that route. Samples below MIN are noise (tiny
// requests), clamps bound a single pathological sample from wrecking the EMA
// and pin the correction to the deflate direction only (max 1, see below).
const CALIBRATION_MIN_ESTIMATE = 2000;
// Plausibility band for admitting a sample: outside it, the report and the
// payload it bills demonstrably don't correspond (placeholder billing, relay
// echo, mock upstreams) — a ratio there must never teach a factor.
const CALIBRATION_SAMPLE_MIN = 0.2;
const CALIBRATION_SAMPLE_MAX = 5;
// Final clamp on the published factor: bounds how far calibration can move
// any decision away from the raw estimate. One-way by design: the clamp max
// is 1, so a learned factor can only DEFLATE the estimate (fire later than
// the raw proxy would), never inflate it. Routes whose billing runs ABOVE
// the local estimate (samples >1) publish k̂=1 — legacy raw behavior — and
// stay covered by the overflow arm / learn-on-failure ladder instead. This
// eliminates the class "calibration itself causes an earlier trigger": the
// observed #1933 damage was over-triggering (37% window tax, fold churn),
// while the opposite error already has a backstop. Discussion: PR #1940.
const CALIBRATION_CLAMP_MIN = 0.25;
const CALIBRATION_CLAMP_MAX = 1;
// Evidence requirements: ≥2 recent same-route samples agreeing within ×2.
// One lucky/degenerate pair must not flip every estimate on the route.
const CALIBRATION_SAMPLE_WINDOW = 3;
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
            let ring = session.stats.calibrationRing;
            if (!ring || ring.origin !== settleOrigin) ring = { origin: settleOrigin, values: [] };
            if (rawSample >= CALIBRATION_SAMPLE_MIN && rawSample <= CALIBRATION_SAMPLE_MAX) {
                ring.values.push(rawSample);
                if (ring.values.length > CALIBRATION_SAMPLE_WINDOW) ring.values.shift();
                const spread = Math.max(...ring.values) / Math.min(...ring.values);
                if (ring.values.length >= 2 && spread <= CALIBRATION_CONSISTENCY_RATIO) {
                    const mean = ring.values.reduce((a, b) => a + b, 0) / ring.values.length;
                    session.stats.calibratedEstimate = Math.min(CALIBRATION_CLAMP_MAX, Math.max(CALIBRATION_CLAMP_MIN, mean));
                    session.stats.calibratedEstimateOrigin = settleOrigin;
                } else {
                    delete session.stats.calibratedEstimate;
                    delete session.stats.calibratedEstimateOrigin;
                }
            }
            session.stats.calibrationRing = ring;
        }
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
    recordCacheSample(session, { at: Date.now(), input: s.total, cached: s.reportedCached, output: s.output, protocol: s.protocol, upstream: s.upstream });
    // #1843 L1: the usage total is ground truth for what the route's vision
    // encoder actually billed — fold any captured image facts into the learned
    // per-route cost (no-op when the request carried no images or no capture).
    settleImageLearning(session, s.total);
    // #1592-family seam forensics: pair this settle with the body that was
    // actually sent (noteForwardedBody), then keep it as the next pair's
    // baseline. Lanes without body capture still get the aggregate flag.
    detectSeam(session, getCacheLedger(session));
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

export interface ModelSwitchStats {
    count: number;
    missedTokens: number;
    events: ModelSwitchEvent[];
}

export interface InvalidationTokenBreakdown {
    model: number;
    wire: number;
    upstream: number;
    restart: number;
    /** Residual stable-prefix miss NOT charged to any named cause — the true
     *  upstream TTL/eviction/wire-rewrite remainder (kernel cannot name it). */
    remaining: number;
}

export interface BiliCacheReport extends CacheReport {
    modelSwitches: ModelSwitchStats;
    wireSwitches: ModelSwitchStats;
    upstreamSwitches: ModelSwitchStats;
    restartDrops: ModelSwitchStats;
    unmeasured: { samples: number; inputTokens: number };
    /** #1891: first-bill samples with no prior baseline — their uncached input
     *  is booked as new content, never as a prefix re-pay. */
    initialBills: { samples: number; inputTokens: number };
    invalidation: InvalidationTokenBreakdown;
    seam: { suspects: number; missed: number; events: SeamEvent[]; providerSide: { count: number; missed: number }; rewinds: { count: number; missed: number }; abortCorrelated: number };
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
    const switchEvents = (flag: (l: LedgerLine) => boolean, value: (l: LedgerLine | undefined) => string | undefined, dim: "model" | "wire" | "upstream"): ModelSwitchEvent[] => {
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
        wire: a.wireSwitchMissed,
        upstream: a.upstreamSwitchMissed,
        restart: a.restartDropMissed,
        remaining: Math.max(0, a.tr - a.attributedMissed),
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
        })),
        linesOmitted: led.sampleSeq - led.lines.length,
        modelSwitches: { count: a.switches, missedTokens: a.switchMissed, events: switchEvents((l) => l.sw === 1 && l.model !== undefined, (l) => l?.model, "model") },
        wireSwitches: { count: a.wireSwitches, missedTokens: a.wireSwitchMissed, events: switchEvents((l) => l.pw === 1 && l.proto !== undefined, (l) => l?.proto, "wire") },
        upstreamSwitches: { count: a.upstreamSwitches, missedTokens: a.upstreamSwitchMissed, events: switchEvents((l) => l.uw === 1 && l.up !== undefined, (l) => l?.up, "upstream") },
        restartDrops: { count: a.restartDrops, missedTokens: a.restartDropMissed, events: restartEvents },
        unmeasured: { samples: a.unknownSamples, inputTokens: a.unknownInput },
        initialBills: { samples: a.nbSamples, inputTokens: a.nbInput },
        invalidation,
        seam: { suspects: a.seamSuspects, missed: a.seamMissed, events: led.seamEvents ?? [], providerSide: { count: a.providerSideMisses, missed: a.providerSideMissed }, rewinds: { count: a.rewinds, missed: a.rewindMissed }, abortCorrelated: a.abortCorrelated },
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

export function handleAcpCache(session: Session, args?: Record<string, unknown>): string {
    try {
        const detail = args?.detail === "full" ? "full" : "summary";
        const report = buildSessionCacheReport(session);
        if (detail === "full" && report.lines.length > FULL_DETAIL_LINES) {
            const dropped = report.lines.length - FULL_DETAIL_LINES;
            const capped = formatCacheReport(
                { ...report, lines: report.lines.slice(-FULL_DETAIL_LINES), linesOmitted: report.linesOmitted + dropped },
                session.id,
                { detail },
            );
            return capped + "\n\n" + formatModelSwitches(report.modelSwitches, detail) + "\n\n" + formatInvalidation(report) + (formatSeam(report) ? "\n\n" + formatSeam(report) : "");
        }
        return formatCacheReport(report, session.id, { detail }) + "\n\n" + formatModelSwitches(report.modelSwitches, detail) + "\n\n" + formatInvalidation(report) + (formatSeam(report) ? "\n\n" + formatSeam(report) : "");
    } catch (err) {
        loggerLog("warn", `[${session.id}] [acp_cache] report failed: ${String(err)}`);
        return `[acp_cache FAILED: ${String(err)}]`;
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

function formatModelSwitches(sw: ModelSwitchStats, detail: "summary" | "full"): string {
    const out: string[] = ["MODEL SWITCHES"];
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
            out.push(`    #${e.seq} ${fmtTime(e.at)} hit ${e.hitPct.toFixed(1)}% · input ${fmtTok(e.input)} · divergence ≥${fmtTok(e.lcpBytes)}B at message[${e.msgIndex}] of ${e.prevMsgs}→${e.curMsgs}`);
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
        out.push("▲ PROVIDER-SIDE MISS (no prefix break in the outbound body)");
        out.push(`  ${r.seam.providerSide.count} sample(s) · ${fmtTok(r.seam.providerSide.missed)} tok — the previous request's entire message list came back byte-identical (whole body, or its prefix with only tail messages appended), so nothing the client sent broke the prefix; the upstream did not serve its cache (TTL expiry / eviction / relay node rotation). Not a bili rebuild seam.`);
    }
    if (r.seam.abortCorrelated > 0) {
        out.push("⏻ ABORT-CORRELATED");
        out.push(`  ${r.seam.abortCorrelated} missed sample(s) within 30s of a client mid-stream abort — abort/retry churn rewrites the resent tail; correlation, not causation (see bili.log 'client aborted mid-stream')`);
    }
    return out.length > 0 ? out.join("\n") : "";
}

function formatInvalidation(r: BiliCacheReport): string {
    const b = r.invalidation;
    const named = b.model + b.wire + b.upstream + b.restart;
    const total = named + b.remaining;
    const out: string[] = ["CACHE INVALIDATION"];
    out.push(`  stable-prefix re-bill by cause (mutually exclusive, sums to total): ${fmtTok(named)} tok charged · ${fmtTok(b.remaining)} tok unattributed (upstream TTL/eviction/wire rewrite)`);
    out.push(`    model switch:    ${fmtTok(b.model)} (${r.modelSwitches.count})`);
    out.push(`    wire switch:     ${fmtTok(b.wire)} (${r.wireSwitches.count})`);
    out.push(`    upstream switch: ${fmtTok(b.upstream)} (${r.upstreamSwitches.count})`);
    out.push(`    restart/refork:  ${fmtTok(b.restart)} (${r.restartDrops.count})`);
    // #1847: a dominant unattributed residual with NO observed cause is the misleading case — the README
    // triage order would steer users to "③ bili bug". Name it explicitly as expected provider-side behavior.
    if (b.remaining > 0 && total > 0 && b.remaining / total >= 0.5) {
        const pct = Math.round((b.remaining / total) * 100);
        const noCauseEver = r.modelSwitches.count === 0 && r.wireSwitches.count === 0 && r.upstreamSwitches.count === 0 && r.restartDrops.count === 0;
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
