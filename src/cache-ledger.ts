import {
    computeFoldEconomics,
    decomposeSample,
    formatCacheReport,
    summarizeFoldEconomics,
    type CacheReport,
    type CacheTotals,
    type CompressionBlock,
    type FoldEvent,
} from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import type { Session } from "./session.js";

const SAMPLE_CAP = 512;
const FOLD_CAP = 256;

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
    };
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

export function getCacheLedger(session: Session): CacheLedger {
    const meta = session.metadata ?? (session.metadata = {});
    const existing = meta[LEDGER_KEY] as CacheLedger | undefined;
    if (existing && existing.v === 1) return existing;
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
        agg: { requests: 0, input: 0, cached: 0, output: 0, nc: 0, cr: 0, tr: 0 },
    };
    meta[LEDGER_KEY] = led;
    return led;
}

function pushFold(led: CacheLedger, f: Omit<LedgerFold, "seq" | "T" | "hPct" | "requestsAfter" | "k">): void {
    for (const open of led.folds) {
        if (open.k === null) open.k = open.requestsAfter;
    }
    led.foldSeqCounter += 1;
    led.folds.push({ ...f, seq: led.foldSeqCounter, T: 0, hPct: null, requestsAfter: 0, k: null });
    if (led.folds.length > FOLD_CAP) led.folds.splice(0, led.folds.length - FOLD_CAP);
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
 *  NORMALIZED (cached included — promptInputTotal semantics). */
export function recordCacheSample(session: Session, s: { at: number; input: number; cached: number; output?: number }): void {
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
    const dec = decomposeSample(
        prevLine ? { at: prevLine.at, input: prevLine.input, cached: prevLine.cached } : null,
        { at: s.at, input: s.input, cached: s.cached },
        pending,
    );
    let foldSeq: number | null = null;
    if (dec.foldIndex !== null) foldSeq = pendRefs[dec.foldIndex]?.seq ?? null;
    if (pendRefs.length > 0) {
        let hi = 0;
        for (const f of pendRefs) hi = Math.max(hi, f.seq);
        led.consumedFoldSeq = Math.max(led.consumedFoldSeq, hi);
    }
    const hitPct = s.input > 0 ? round1((s.cached / s.input) * 100) : 0;
    for (const f of pendRefs) {
        if (f.at <= s.at) {
            f.requestsAfter += 1;
            if (f.hPct === null) f.hPct = hitPct;
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
        cached: s.cached,
        output: s.output ?? 0,
        hitPct,
        missed: dec.missed,
        nc: dec.newContent,
        cr: dec.compRepay,
        tr: dec.ttlRepay,
        foldSeq,
    });
    if (led.lines.length > SAMPLE_CAP) led.lines.splice(0, led.lines.length - SAMPLE_CAP);
    const agg = led.agg;
    agg.requests += 1;
    agg.input += s.input;
    agg.cached += s.cached;
    agg.output += s.output ?? 0;
    agg.nc += dec.newContent;
    agg.cr += dec.compRepay;
    agg.tr += dec.ttlRepay;
}

export function buildSessionCacheReport(session: Session): CacheReport {
    const led = getCacheLedger(session);
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
        }),
    );
    return {
        generatedAt: Date.now(),
        profile: { w: 1.0, r: 0.1, q: 4.0 },
        totals,
        economics: summarizeFoldEconomics(folds),
        folds,
        lines: led.lines.map((l) => ({
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
    };
}

export function handleAcpCache(session: Session): string {
    try {
        return formatCacheReport(buildSessionCacheReport(session), session.id);
    } catch (err) {
        loggerLog("warn", `[${session.id}] [acp_cache] report failed: ${String(err)}`);
        return `[acp_cache FAILED: ${String(err)}]`;
    }
}
