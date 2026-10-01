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
import { reanchorNudgeOnUsageDrop, type Session } from "./session.js";

// Render window for handleAcpCache's detail:"full" text view (#1489). The
// ledger itself is unbounded — this only bounds how many lines the text
// listing shows so a marathon session cannot flood the caller's context.
const FULL_DETAIL_LINES = 512;

// #1536: identity of this daemon process boot. A session's first KNOWN sample under a
// NEW boot id (with prior history) marks a proxy-restart / re-fork boundary (#499): its
// upstream KV was dropped during downtime even though bili's message refs were preserved.
const BOOT_ID = randomUUID();

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
    hitPct: number;
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
        seamSuspects: number;
        seamMissed: number;
        /** #1592 follow-up: misses whose current body was byte-stable vs the
         *  previous request — the upstream simply did not serve its cache
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

function detectSeam(session: Session, led: CacheLedger): void {
    const line = led.lines[led.lines.length - 1];
    if (!line || line.unk === 1 || line.missed <= 0) return;
    // Abort correlation is counted for EVERY missed sample, independent of
    // structural attribution — abort/retry churn is orthogonal evidence.
    const abortAt = lastClientAbort.get(session);
    if (abortAt !== undefined && Math.abs(line.at - abortAt) < 30_000) {
        line.abortedNear = 1;
        led.agg.abortCorrelated += 1;
    }
    // Structural attributions already explain the miss — not a seam candidate.
    if (line.sw === 1 || line.pw === 1 || line.uw === 1 || line.rs === 1 || line.foldSeq !== null) return;
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
        if (f.lcpBytes >= cur.length) {
            // Wire was byte-stable against the previous request — the
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
        const ev: SeamEvent = { seq: line.seq, at: line.at, input: line.input, hitPct: line.hitPct, ...f };
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
        agg: { requests: 0, input: 0, cached: 0, output: 0, nc: 0, cr: 0, tr: 0, switches: 0, switchMissed: 0, wireSwitches: 0, wireSwitchMissed: 0, upstreamSwitches: 0, upstreamSwitchMissed: 0, restartDrops: 0, restartDropMissed: 0, attributedMissed: 0, unknownSamples: 0, unknownInput: 0, seamSuspects: 0, seamMissed: 0, providerSideMisses: 0, providerSideMissed: 0, rewinds: 0, rewindMissed: 0, abortCorrelated: 0 },
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
    const dec = decomposeSample(
        prevLine ? { at: prevLine.at, input: prevLine.input, cached: prevLine.cached } : null,
        { at: s.at, input: s.input, cached: effCached },
        pending,
    );
    let foldSeq: number | null = null;
    if (known && dec.foldIndex !== null) foldSeq = pendRefs[dec.foldIndex]?.seq ?? null;
    // Advance the fold-consume cursor only for measurable samples: an unknown
    // sample must not eat a fold, or its compRepay would never reach a fold owner.
    if (known && pendRefs.length > 0) {
        let hi = 0;
        for (const f of pendRefs) hi = Math.max(hi, f.seq);
        led.consumedFoldSeq = Math.max(led.consumedFoldSeq, hi);
    }
    const hitPct = known && s.input > 0 ? round1((effCached / s.input) * 100) : 0;
    // Target identity (#1535 model, generalized to model|wire|upstream in #1536):
    // each component flags only when BOTH sides are known (unknown never flags).
    const model = typeof session.metadata?.lastModel === "string" && session.metadata.lastModel !== ""
        ? session.metadata.lastModel
        : undefined;
    const proto = typeof s.protocol === "string" && s.protocol !== "" ? s.protocol : undefined;
    const up = typeof s.upstream === "string" && s.upstream !== "" ? s.upstream : undefined;
    const prevModel = prevLine?.model;
    const prevProto = prevLine?.proto;
    const prevUp = prevLine?.up;
    const modelSwitched = model !== undefined && prevModel !== undefined && model !== prevModel;
    const wireSwitched = proto !== undefined && prevProto !== undefined && proto !== prevProto;
    const upstreamSwitched = up !== undefined && prevUp !== undefined && up !== prevUp;
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
    if (modelSwitched) {
        // #1535: charge only this sample's unexplained residual (tr) — compRepay stays booked to its fold.
        agg.switches += 1;
        agg.switchMissed += dec.ttlRepay;
    }
    if (wireSwitched) {
        agg.wireSwitches += 1;
        agg.wireSwitchMissed += dec.ttlRepay;
    }
    if (upstreamSwitched) {
        agg.upstreamSwitches += 1;
        agg.upstreamSwitchMissed += dec.ttlRepay;
    }
    if (restarted) {
        agg.restartDrops += 1;
        agg.restartDropMissed += dec.ttlRepay;
    }
    if (modelSwitched || wireSwitched || upstreamSwitched || restarted) {
        // Union residual charged to ≥1 named cause (buckets may overlap each
        // other; this one does not, keeping `remaining` non-negative).
        agg.attributedMissed += dec.ttlRepay;
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
export function settleUsageReport(
    session: Session,
    s: { total: number; reportedCached: number | null; output?: number; protocol?: string; upstream?: string },
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
        // #1110: a real usage report retires the one-shot overflow arm.
        delete session.stats.overflowArmTokens;
        // #1595: a real report landing far below a stale-high nudge reference
        // retires that reference too (one call covers all three lanes).
        reanchorNudgeOnUsageDrop(session);
    }
    if (s.reportedCached !== null && s.total > 0) {
        session.stats.cachedTokens += s.reportedCached;
        session.stats.cacheSamples += 1;
    }
    recordCacheSample(session, { at: Date.now(), input: s.total, cached: s.reportedCached, output: s.output, protocol: s.protocol, upstream: s.upstream });
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
    const switchEvents = (flag: (l: LedgerLine) => boolean, value: (l: LedgerLine | undefined) => string | undefined): ModelSwitchEvent[] => {
        const evs: ModelSwitchEvent[] = [];
        for (let i = 0; i < led.lines.length; i++) {
            const l = led.lines[i];
            if (!l || l.unk === 1 || !flag(l)) continue;
            const prev = i > 0 ? led.lines[i - 1] : undefined;
            evs.push({
                seq: l.seq,
                at: l.at,
                from: value(prev) ?? null,
                to: value(l) ?? "?",
                input: l.input,
                cached: l.cached,
                hitPct: l.hitPct,
                attributed: l.tr,
            });
        }
        return evs;
    };
    const restartEvents: ModelSwitchEvent[] = [];
    for (const l of led.lines) {
        if (l.rs !== 1 || l.unk === 1) continue;
        restartEvents.push({ seq: l.seq, at: l.at, from: null, to: "(restart)", input: l.input, cached: l.cached, hitPct: l.hitPct, attributed: l.tr });
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
            hitPct: l.hitPct,
            missed: l.missed,
            newContent: l.nc,
            compRepay: l.cr,
            ttlRepay: l.tr,
            foldSeq: l.foldSeq,
        })),
        linesOmitted: led.sampleSeq - led.lines.length,
        modelSwitches: { count: a.switches, missedTokens: a.switchMissed, events: switchEvents((l) => l.sw === 1 && l.model !== undefined, (l) => l?.model) },
        wireSwitches: { count: a.wireSwitches, missedTokens: a.wireSwitchMissed, events: switchEvents((l) => l.pw === 1 && l.proto !== undefined, (l) => l?.proto) },
        upstreamSwitches: { count: a.upstreamSwitches, missedTokens: a.upstreamSwitchMissed, events: switchEvents((l) => l.uw === 1 && l.up !== undefined, (l) => l?.up) },
        restartDrops: { count: a.restartDrops, missedTokens: a.restartDropMissed, events: restartEvents },
        unmeasured: { samples: a.unknownSamples, inputTokens: a.unknownInput },
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
    out.push(`  ${sw.count} switch(es) · ${fmtTok(sw.missedTokens)} tok re-billed (stable-prefix miss charged to the model change)`);
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
        out.push("▲ PROVIDER-SIDE MISS (wire was byte-stable)");
        out.push(`  ${r.seam.providerSide.count} sample(s) · ${fmtTok(r.seam.providerSide.missed)} tok — the outbound body matched the previous request's prefix; the upstream did not serve its cache (TTL expiry / eviction / relay node rotation). Not a bili rebuild seam.`);
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
    const out: string[] = ["CACHE INVALIDATION"];
    out.push(`  stable-prefix re-bill by cause: ${fmtTok(named)} tok charged · ${fmtTok(b.remaining)} tok unattributed (upstream TTL/eviction/wire rewrite)`);
    out.push(`    model switch:    ${fmtTok(b.model)} (${r.modelSwitches.count})`);
    out.push(`    wire switch:     ${fmtTok(b.wire)} (${r.wireSwitches.count})`);
    out.push(`    upstream switch: ${fmtTok(b.upstream)} (${r.upstreamSwitches.count})`);
    out.push(`    restart/refork:  ${fmtTok(b.restart)} (${r.restartDrops.count})`);
    if (r.unmeasured.samples > 0) {
        out.push(`  unmeasured (provider reported no cache tokens): ${r.unmeasured.samples} sample(s) · ${fmtTok(r.unmeasured.inputTokens)} tok — excluded from hit rate`);
    }
    return out.join("\n");
}
