import { orderedRefPair } from "acp-kernel";
import { listSessions, displayContextBest, type ContextBest, type Session } from "../session.js";
import { conflictClientOf, conflictEventsOf } from "../conflict-watch.js";
import { isDisplayOnlyConflictDetail, isSiblingConflictDetail } from "../thirdparty-scan.js";
import { SessionStore, fileNameMatchesId, isValidRecord, relPathFor } from "../persist.js";
import { flatFileNameFor } from "acp-kernel/persist";
import { renderHandoff } from "../export.js";
import { buildSessionCacheReport, formatPriceSourceLine, parsePriceSourceStamp, summarizePricedFolds } from "../cache-ledger.js";
import type { PriceProfile } from "acp-kernel";
import { METADATA_FOLD_COVERAGE } from "../fold-reconcile.js";
import { markdownToHtml } from "./markdown.js";
import { log } from "../logger.js";
import { dataDir } from "../paths.js";
import { isExternalSummaryBlock } from "../external-summary-marker.js";
import { readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";

/** #1420/#1937: read-only session browsing for the web UI. Merges the LIVE
 *  in-memory pool (bounded — evicted sessions are gone) with the on-disk
 *  corpus. #1937: the disk side is a BOUNDED SUMMARY INDEX — a directory walk
 *  over metadata only, per-file summaries cached by (mtime,size), and
 *  sequential decode of changed/new files whose parsed records are discarded
 *  right after extraction. List/overview paths never construct or retain full
 *  Session objects, so resident memory stays O(#sessions × ~1KB) regardless of
 *  total corpus bytes; a single admin request's peak is one decoded file. */

interface WebSessionSummary {
    id: string;
    title?: string;
    label?: string;
    protocol?: string;
    upstreamOrigin?: string;
    /** true = present in the live in-memory pool (active or recently restored);
     *  false = disk-only (evicted or from before this process started). */
    live: boolean;
    requests: number;
    contextTokens: number;
    /** #1839: provenance of contextTokens — "usage" = last real usage report,
     *  "estimate" = bounded local estimate (display should mark it as such). */
    contextTokensSource?: "usage" | "estimate";
    /** #2117: the honest best reading of "how full is this context right now",
     *  picked by provenance (usage > calibrated estimate > char-count upper
     *  bound). Display surfaces drive their main bar from this so one value
     *  never mixes calibers; raw contextTokens stays for API compat + legacy
     *  clients. Absent when nothing has been observed yet. */
    contextBest?: ContextBest;
    tokensSaved: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    cacheHitPct: number | null;
    blocks: number;
    contextWindow?: number;
    lastSeen: string;
    restored?: boolean;
    /** true when the per-request cache ledger holds samples — the token
     *  fields above then include ledger-measured usage (max with stats). */
    hasLedger?: boolean;
    /** Display-name fallback: collapsed lead of the first compression block's topic/summary. */
    firstBlockHint?: string;
    /** Which client produced this session: plugin agents stamp metadata.pluginAgent,
     *  non-plugin clients get a sniffed/UA-derived metadata.clientHint (server.ts #1426). */
    clientHint?: string;
    /** Number of compression events recorded in the per-request cache ledger (folds). */
    foldCount?: number;
    /** Non-cached token attribution from ledger samples (acp-kernel decomposeSample):
     *  genuinely new content, re-read caused by compression folds, and stable-prefix
     *  misses attributed to upstream TTL expiry/eviction or client wire rewrites
     *  (those two cannot be told apart by the kernel). */
    newContent?: number;
    compRepay?: number;
    ttlRepay?: number;
    /** Hit-rate cost of each missed-token class, in percentage points of input
     *  (e.g. ttlRepay/input × 100 — how much the TTL class alone drags the hit rate). */
    missDropNew?: number;
    missDropComp?: number;
    missDropTtl?: number;
    /** Mid-session model switches seen between consecutive ledger usage samples (#1535). */
    modelSwitches?: number;
    /** Σ stable-prefix tokens re-billed right after a model switch (#1535). */
    switchMissedTokens?: number;
    /** #2131: relay account rotations — outbound credential fingerprint changes
     *  between consecutive samples (key pool behind a stable URL). */
    keySwitches?: number;
    /** #2131: Σ stable-prefix tokens re-billed after a key switch (cold cache
     *  on the rotated account). */
    keySwitchMissedTokens?: number;
    /** Σ (S−σ)×requestsAfter across ledger folds — input tokens not billed thanks to
     *  compression (acp-kernel EconomicsSummary.grossSaved semantics). */
    grossSaved?: number;
    /** Per-session net: Σ ((S−σ)×requestsAfter − T − σ); may be negative. */
    netSaved?: number;
    /** Σ T — measured compression re-pay tokens. */
    repayCost?: number;
    /** Σ σ — summary generation cost (output tokens). */
    summaryCost?: number;
    /** #2202: folds whose covered ids were verified on the wire and have since
     *  vanished (host shadowing / native compaction outside bili's knowledge) —
     *  their avoided-token accrual is frozen; count + frozen share below. */
    coverageLostFolds?: number;
    /** #2202: Σ (S−σ)×requestsAfter over coverage-lost folds — the part of
     *  grossSaved that is frozen rather than accruing. */
    coverageLostFrozenTokens?: number;
    /** #2478: priced P&L in USD — Σ (S−σ)×requestsAfter at the cache-read rate,
     *  converted through the session's price source. Present only when the
     *  session has folds AND a usable price source (a models.dev stamp, or
     *  configured input-ratio profile with an input-price anchor). */
    grossSavedUsd?: number;
    /** #2478: Σ one-time fold costs in USD ((w−r)·T re-pay premium + q·σ summary
     *  output − r·S read-back credit), kernel ΔC₁ math. */
    oneTimeCostUsd?: number;
    /** #2478: grossSavedUsd − oneTimeCostUsd; may be negative. */
    netSavedUsd?: number;
    /** #2478: human-readable price provenance for tooltips/sub-lines. */
    priceSource?: string;
}

interface WebOverview {
    sessions: number;
    live: number;
    requests: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    tokensSaved: number;
    /** Part of tokensSaved coming from sessions WITHOUT usage samples
     *  (pre-tagging era) — always local estimates, flagged for the UI. */
    savedEstimated: number;
    /** Gross "not billed" total: ledger sessions' grossSaved + legacy local estimates. */
    grossSavedTotal: number;
    /** Net savings across ledger sessions (gross − re-pay − summary cost); 0 if no folds. */
    netSavedTotal: number;
    /** true when at least one session had ledger folds (else net/repay are meaningless). */
    hasFoldData: boolean;
    /** Σ measured compression re-pay tokens across ledger sessions. */
    repayTotal: number;
    /** Σ summary generation cost (output tokens) across ledger sessions. */
    summaryCostTotal: number;
    /** #2202: Σ coverage-lost fold count across sessions (0 when none). */
    coverageLostFoldTotal: number;
    /** #2202: Σ frozen avoided tokens over coverage-lost folds — a subset of
     *  grossSavedTotal whose accrual has stopped (host shadowed the covered
     *  bytes outside bili's knowledge, #2193/#2202). 0 when none. */
    coverageLostFrozenTotal: number;
    /** #2478: priced totals in USD across PRICED fold-sessions only — present
     *  (all six) iff at least one session is priced, else absent so faces can
     *  keep the token-denominated display. The unpriced* siblings keep the
     *  mixed-caliber remainder visible next to the dollar figures. */
    netSavedUsdTotal?: number;
    grossSavedUsdTotal?: number;
    oneTimeCostTotal?: number;
    pricedSessions?: number;
    unpricedGrossTokens?: number;
    unpricedNetTokens?: number;
    /** Σ genuinely-new missed tokens across ledger sessions (decomposeSample). */
    missNewTotal: number;
    /** Σ compression re-read missed tokens across ledger sessions. */
    missCompTotal: number;
    /** Σ upstream-TTL-expiry / other-prefix-invalidation missed tokens across ledger sessions. */
    missTtlTotal: number;
    /** Σ input tokens across ledger sessions (denominator for the per-class hit-rate cost). */
    missInputTotal: number;
    /** Startup/test stub sessions (no requests/context/ledger) filtered out of every list. */
    hiddenEmpty: number;
    hitPct: number | null;
    blocks: number;
    byProtocol: Array<{ protocol: string; sessions: number; requests: number; inputTokens: number; cachedTokens: number; savedNet: number; folds: number; hitPct: number | null; missDropNew?: number; missDropComp?: number; missDropTtl?: number }>;
    recent: WebSessionSummary[];
}

interface WebSessionDetail extends WebSessionSummary {
    lastInputTokens: number;
    compressCreditTokens: number;
    retrieveCalls: number;
    retrieveHits: number;
    retrieveMisses: number;
    storedBytes: number;
    storeBytesSaved: number;
    activePack?: string;
    /** Which client produced this session (plugin agent name or header/UA hint). */
    clientHint?: string;
    /** bili build that last persisted this session file (absent on pre-stamp files). */
    biliVersion?: string;
    /** Measured system-prompt size in tokens — the not-compressible baseline drawn
     *  under the trajectory chart. */
    systemPromptTokens?: number;
    /** #2117: char-count upper bound of the LAST outbound send (the fail-closed
     *  caliber) — rendered beside the main bar as an explicit BOUND, never as a
     *  reading; over-window here does not mean actually over-window. */
    contextUpperTokens?: number;
    /** #2117: route that measured the last usage-grade input (#1933 F2 provenance). */
    lastInputTokensOrigin?: string;
    /** #2117: wall-clock when the last usage-grade context value settled. */
    contextMeasuredAt?: number;
    /** #2117: the learned estimator calibration behind the displayed estimate —
     *  k̂ plus its evidence (samples admitted on this route+model, spread). */
    estimateCalibration?: { factor: number; origin?: string; model?: string; samples: number; spread: number };
    ledger: ReturnType<typeof buildSessionCacheReport> | null;
    /** Raw markdown of the handoff doc (handoffHtml rendered) — for the
     *  copy-markdown / download buttons. */
    handoffMd: string;
    handoffHtml: string;
    handoffTruncated: boolean;
    /** #2102: this session's compression-conflict ledger (#1206) — the detail
     *  surface the global banner points users to; absent when empty. */
    conflicts?: Array<{ at: number; kind: string; detail: string }>;
    /** #2219: resolved client name for the per-client remediation hint (same
     *  resolution as the banner's clients[]); absent when unresolvable or when
     *  there are no conflicts. */
    conflictClient?: string;
    blockDetails: Array<{
        blockId: string;
        tier: number;
        topic?: string;
        summary: string;
        compressedTokens: number;
        createdAt: number;
        startRef?: string;
        endRef?: string;
        active: boolean;
        /** Present when the block's summary was written by the external
         *  summary chain — the web block badge mirrors /acp's "⚡ext". */
        external?: true;
    }>;
}

// ---------------------------------------------------------------------------
// #1937 bounded disk summary index
// ---------------------------------------------------------------------------

type DiskEntry = {
    abs: string;
    mtimeMs: number;
    size: number;
    savedAt: number;
    /** null = undecodable/corrupt or renamed file — skipped (logged), never fatal. */
    summary: WebSessionSummary | null;
};

let diskStore: SessionStore | null = null;
function getDiskStore(): SessionStore {
    if (!diskStore) diskStore = new SessionStore({ enabled: true });
    return diskStore;
}

let byFile: Map<string, DiskEntry> | null = null;
let byId: Map<string, string> | null = null;
// #2180 review: latches the first pristine resolution — once sessions existed, a vanished
// root is breakage (#1937 stale snapshot), not "fresh install". Cleared on any successful walk.
let resolvedPristine = false;
let scanInFlight: Promise<void> | null = null;
let decodeCount = 0;
let detailDecodes = 0;

function yieldToGc(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/** Recursive *.json walk under the sessions dir, stat-based (metadata only,
 *  no decoding). Excludes dotfiles (.bili-migration-* markers), temp files
 *  (.tmp-* kernel temps, *.tmp-enc-* codec temps) and CCR content-store
 *  envelopes (*.content-store.json — payload bytes, not session records; they
 *  would fail validation anyway and can be huge). A TOP-LEVEL failure (missing
 *  dir / EACCES) throws so callers can distinguish "no data" from "unreadable";
 *  subdirectory failures skip that subtree. */
async function walkSessionFiles(dir: string): Promise<Array<{ abs: string; mtimeMs: number; size: number }>> {
    await readdir(dir);
    const out: Array<{ abs: string; mtimeMs: number; size: number }> = [];
    async function rec(d: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.name.startsWith(".")) continue;
            const abs = path.join(d, e.name);
            if (e.isDirectory()) {
                await rec(abs);
                continue;
            }
            if (!e.name.endsWith(".json")) continue;
            // startsWith, not includes: parity with kernel walkJsonFiles — canonical names may
            // legitimately contain ".tmp-" mid-string (host labels keep dots); enc temps lack
            // the .json suffix so the gate above drops them anyway (#1939 review).
            if (e.name.startsWith(".tmp-") || e.name.endsWith(".content-store.json")) continue;
            if (!e.isFile()) continue;
            try {
                const st = await stat(abs);
                out.push({ abs, mtimeMs: st.mtimeMs, size: st.size });
            } catch {
                // vanished mid-walk
            }
        }
    }
    await rec(dir);
    return out;
}

/** Absolute paths of files already covered by LIVE pool entries. Their disk
 *  twins are overridden per-id by the live summaries anyway, so decoding them
 *  during a scan is pure waste; skipping leaves NO cache entry, which means a
 *  later evict (which rewrites the file) is picked up on the next refresh. */
function liveCoveredPaths(dir: string): Set<string> {
    const out = new Set<string>();
    for (const s of listSessions()) {
        for (const rel of [
            relPathFor(s.id, s.meta.protocol, s.meta.upstreamOrigin),
            relPathFor(s.id),
            flatFileNameFor(s.id),
        ]) {
            out.add(path.join(dir, rel));
        }
    }
    return out;
}

// #2260(F)/#2180 follow-up: bili's own infra dirs created under the data root
// BEFORE any session exists (ensureRootCA() makes <data>/ca at proxy start) —
// their presence alone must not read as "misconfigured". The set is closed by
// construction: paths.ts writes only `sessions` and `ca` directly under it.
const DATA_DIR_INFRA_ENTRIES = new Set(["ca"]);

/** #2180: a top-level ENOENT means "pristine" — no session file can exist
 *  anywhere — only when the DEFAULT layout is in effect: BILI_SESSIONS_DIR
 *  unset AND the XDG data root either absent or holding ONLY bili's own infra
 *  dirs (a fresh install where ensureRootCA() already ran). An explicit
 *  override pointing nowhere, or a data root containing anything else, stays
 *  loud (#1937): silence there would hide a moved/misconfigured path while
 *  real sessions sit elsewhere. */
function isPristineSessionsRoot(error: unknown): boolean {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return false;
    if (process.env.BILI_SESSIONS_DIR) return false;
    let entries: string[];
    try {
        statSync(dataDir());
        entries = readdirSync(dataDir());
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ENOENT";
    }
    return entries.every((entry) => DATA_DIR_INFRA_ENTRIES.has(entry));
}

/** Single-flight index refresh. Steady-state cost is one stat per file; only
 *  new/changed files (mtime OR size moved) are decoded, one at a time with a
 *  GC checkpoint between files, and the parsed record is dropped immediately
 *  after summary extraction. Top-level walk failure: serve the previous
 *  snapshot when one exists, else propagate (→ HTTP 500, visible in UI) —
 *  except a pristine default layout BEFORE any successful walk (#2180), which
 *  resolves to an EMPTY index instead of failing. */
async function refreshIndex(): Promise<void> {
    if (scanInFlight) return scanInFlight;
    const run = (async () => {
        const store = getDiskStore();
        const dir = store.dir;
        let files: Array<{ abs: string; mtimeMs: number; size: number }>;
        try {
            files = await walkSessionFiles(dir);
        } catch (error) {
            if (!(byFile === null || resolvedPristine) || !isPristineSessionsRoot(error)) throw error;
            byFile = new Map<string, DiskEntry>();
            byId = new Map<string, string>();
            if (!resolvedPristine) {
                resolvedPristine = true;
                log("info", `[acp-web] sessions dir ${dir} not created yet (fresh install) — serving empty index (#2180)`);
            }
            return;
        }
        const prev = byFile ?? new Map<string, DiskEntry>();
        const next = new Map<string, DiskEntry>();
        const covered = liveCoveredPaths(dir);
        for (const f of files) {
            if (covered.has(f.abs)) continue;
            const p = prev.get(f.abs);
            if (p && p.mtimeMs === f.mtimeMs && p.size === f.size) {
                next.set(f.abs, p);
                continue;
            }
            decodeCount++;
            const entry: DiskEntry = { abs: f.abs, mtimeMs: f.mtimeMs, size: f.size, savedAt: 0, summary: null };
            const relName = path.relative(dir, f.abs);
            const raw = await store.readRawFile(f.abs);
            if (raw && typeof raw === "object") {
                const r = raw as Record<string, unknown>;
                const rec = r.payload && typeof r.payload === "object" ? r.payload : raw;
                if (isValidRecord(rec)) {
                    const meta = (rec.meta && typeof rec.meta === "object" ? rec.meta : {}) as Record<string, unknown>;
                    const proto = typeof meta.protocol === "string" ? meta.protocol : typeof rec.protocol === "string" ? rec.protocol : undefined;
                    const origin = typeof meta.upstreamOrigin === "string" ? meta.upstreamOrigin : typeof rec.upstreamOrigin === "string" ? rec.upstreamOrigin : undefined;
                    if (fileNameMatchesId(path.basename(f.abs), rec.id, proto, origin)) {
                        entry.savedAt = typeof rec.savedAt === "number" ? rec.savedAt : Date.now();
                        entry.summary = summaryFromRecord(rec);
                    } else {
                        log("warn", `[acp-web] skipping ${relName}: filename does not match record id`);
                    }
                } else {
                    log("warn", `[acp-web] skipping invalid session file ${relName}`);
                }
            } else {
                log("warn", `[acp-web] skipping undecodable session file ${relName}`);
            }
            next.set(f.abs, entry);
            await yieldToGc();
        }
        const nextById = new Map<string, string>();
        for (const e of next.values()) {
            if (!e.summary) continue;
            const cur = nextById.get(e.summary.id);
            if (cur === undefined) {
                nextById.set(e.summary.id, e.abs);
                continue;
            }
            const curE = next.get(cur)!;
            if (e.savedAt > curE.savedAt || (e.savedAt === curE.savedAt && e.mtimeMs > curE.mtimeMs)) {
                nextById.set(e.summary.id, e.abs);
            }
        }
        byFile = next;
        byId = nextById;
        resolvedPristine = false;
    })();
    scanInFlight = run.finally(() => { scanInFlight = null; });
    try {
        await scanInFlight;
    } catch (error) {
        if (!byFile) throw error;
        log("warn", `[acp-web] sessions index refresh failed, serving last known index: ${String(error)}`);
    }
}

function ensureIndex(): Promise<Map<string, DiskEntry>> {
    return refreshIndex().then(() => byFile!);
}

/** Test hooks: reset the index (memo + store singleton — its dir was resolved
 *  at construction, so a changed BILI_SESSIONS_DIR needs a fresh one) and read
 *  decode accounting (decodedTotal = index-scan decodes, detailDecodes = lazy
 *  single-file detail loads — together the structural proof that steady-state
 *  scans cost zero decodes and a detail never re-scans, #1937). */
export function _resetDiskCacheForTest(): void {
    byFile = null;
    byId = null;
    resolvedPristine = false;
    scanInFlight = null;
    diskStore = null;
    decodeCount = 0;
    detailDecodes = 0;
    detailInFlight.clear();
}

export function _diskScanStatsForTest(): { files: number; decodedTotal: number; detailDecodes: number } {
    let files = 0;
    if (byFile) for (const e of byFile.values()) if (e.summary) files += 1;
    return { files, decodedTotal: decodeCount, detailDecodes };
}

// ---------------------------------------------------------------------------
// Summary extraction
// ---------------------------------------------------------------------------

/** The minimal shape summaryOf actually reads — satisfied by a live Session
 *  AND by a persisted record normalizer, so list rows never need a full
 *  Session construction (#1937). */
interface SummarySource {
    id: string;
    meta: { protocol?: string; upstreamOrigin?: string; label?: string; title?: string; hostTitle?: string };
    stats: { requests: number; tokensSaved: number; inputTokens: number; cachedTokens: number; outputTokens: number; contextTokens: number; contextTokensSource?: "usage" | "estimate"; lastUsageGradeTokens?: number; lastInputTokensSource?: "usage" | "estimate" | "overflow-arm"; contextEstimateTokens?: number; contextEstimateCalibrated?: boolean };
    metadata: Record<string, unknown>;
    state: { blocks: Array<{ topic?: string; summary: string }> };
    lastSeen: number;
    restored?: boolean;
}

function num(v: unknown, fallback = 0): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | undefined {
    return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Normalizer mirroring buildSession's v1-flat → grouped fallback for exactly
 *  the fields summaryOf consumes (no blockContents/messages/state merge —
 *  those are the heavy parts this index deliberately avoids). */
function summaryFromRecord(rec: unknown): WebSessionSummary {
    const r = rec as Record<string, unknown>;
    const meta = (r.meta && typeof r.meta === "object" ? r.meta : {}) as Record<string, unknown>;
    const stats = (r.stats && typeof r.stats === "object" ? r.stats : {}) as Record<string, unknown>;
    const state = (r.state && typeof r.state === "object" ? r.state : {}) as Record<string, unknown>;
    const blocksRaw = Array.isArray(state.blocks) ? state.blocks : [];
    const source: SummarySource = {
        id: String(r.id),
        meta: {
            protocol: str(meta.protocol) ?? str(r.protocol),
            upstreamOrigin: str(meta.upstreamOrigin) ?? str(r.upstreamOrigin),
            label: str(meta.label) ?? str(r.label),
            title: str(meta.title),
            hostTitle: str(meta.hostTitle),
        },
        stats: {
            requests: num(stats.requests, num(r.requests)),
            tokensSaved: num(stats.tokensSaved, num(r.tokensSaved)),
            inputTokens: num(stats.inputTokens, num(r.inputTokens)),
            cachedTokens: num(stats.cachedTokens, num(r.cachedTokens)),
            outputTokens: num(stats.outputTokens, num(r.outputTokens)),
            contextTokens: Math.max(0, num(stats.contextTokens, num(r.contextTokens))),
            // #1839: mirror buildSession's narrowing (persist.ts) — grouped stats
            // only, so list rows always agree with detail rows; legacy files lack it.
            contextTokensSource: stats.contextTokensSource === "usage" || stats.contextTokensSource === "estimate" ? stats.contextTokensSource : undefined,
            // #2117 x #1937: display-caliber fields — without these the bounded
            // index rows fall back to the char-count bound for evicted sessions.
            lastUsageGradeTokens: num(stats.lastUsageGradeTokens) > 0 ? num(stats.lastUsageGradeTokens) : undefined,
            lastInputTokensSource: stats.lastInputTokensSource === "usage" || stats.lastInputTokensSource === "estimate" || stats.lastInputTokensSource === "overflow-arm" ? stats.lastInputTokensSource : undefined,
            contextEstimateTokens: num(stats.contextEstimateTokens) > 0 ? num(stats.contextEstimateTokens) : undefined,
            contextEstimateCalibrated: typeof stats.contextEstimateCalibrated === "boolean" ? stats.contextEstimateCalibrated : undefined,
        },
        metadata: (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>,
        state: { blocks: blocksRaw.filter((b) => !!b && typeof b === "object") as Array<{ topic?: string; summary: string }> },
        lastSeen: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
        restored: true,
    };
    return summaryOf(source, false);
}

function hitPct(input: number, cached: number): number | null {
    return input > 0 ? Math.round((cached / input) * 100) : null;
}

function summaryOf(s: SummarySource, live: boolean): WebSessionSummary {
    // Dual-source token counters: session.stats accumulates upstream-reported
    // usage; metadata.cacheLedger.agg accumulates the ACP/web ledger samples.
    // Per-field MAX (the sources overlap, never sum). Read-only on purpose:
    // getCacheLedger() would bootstrap/mutate session.metadata instead.
    const led = s.metadata["cacheLedger"] as {
        agg?: { requests?: number; input?: number; cached?: number; output?: number; nc?: number; cr?: number; tr?: number; switches?: number; switchMissed?: number; keySwitches?: number; keySwitchMissed?: number };
        folds?: Array<{ S?: number; sigma?: number; T?: number; requestsAfter?: number; bid?: string }>;
    } | undefined;
    // #2202: per-block coverage evidence (reconcileFoldCoverage's record) — a
    // fold is coverage-lost iff it was VERIFIED present at least once and its
    // covered ids are now entirely off the wire. Live state: self-heals when
    // the host resends the originals again.
    const covAll = s.metadata[METADATA_FOLD_COVERAGE] as Record<string, { p?: number; r?: number; t?: number; e?: 1 }> | undefined;
    const agg = led;
    const requests = Math.max(s.stats.requests ?? 0, agg?.agg?.requests ?? 0);
    const inputTokens = Math.max(s.stats.inputTokens ?? 0, agg?.agg?.input ?? 0);
    const cachedTokens = Math.max(s.stats.cachedTokens ?? 0, agg?.agg?.cached ?? 0);
    const outputTokens = Math.max(s.stats.outputTokens ?? 0, agg?.agg?.output ?? 0);
    const hasLedger = Boolean(agg?.agg && (agg.agg.requests ?? 0) > 0);
    // Fold economics straight off the stored ledger (read-only — no report build):
    // mirrors acp-kernel summarizeFoldEconomics() so the dashboard can split
    // "compressed away" (gross) from "net saving after re-pay & summary cost".
    let hasFolds = false, grossSaved = 0, netSaved = 0, repayCost = 0, summaryCost = 0, foldCount = 0;
    let coverageLostFolds = 0, coverageLostFrozenTokens = 0;
    for (const f of led?.folds ?? []) {
        hasFolds = true;
        foldCount += 1;
        const S = f.S ?? 0, sig = f.sigma ?? 0, rep = f.T ?? 0, ra = f.requestsAfter ?? 0;
        const avoided = (S - sig) * ra;
        grossSaved += avoided;
        netSaved += avoided - rep - sig;
        repayCost += rep;
        summaryCost += sig;
        const cov = f.bid !== undefined ? covAll?.[f.bid] : undefined;
        if (cov !== undefined && cov.e === 1 && (cov.p ?? 0) + (cov.r ?? 0) === 0) {
            coverageLostFolds += 1;
            coverageLostFrozenTokens += Math.max(0, avoided);
        }
    }
    // #2478: real-money P&L mirroring /acp-cache's PRICED ECONOMICS — same raw
    // fold fields, same effective-profile merge as buildSessionCacheReport,
    // same source-stamp validation. Unpriced sessions stay token-only.
    let grossSavedUsd: number | undefined, oneTimeCostUsd: number | undefined, netSavedUsd: number | undefined, priceSource: string | undefined;
    if (hasFolds) {
        const ppRaw = s.metadata["cachePriceProfile"];
        let pw: number | undefined, pr: number | undefined, pq: number | undefined;
        if (ppRaw !== null && typeof ppRaw === "object" && !Array.isArray(ppRaw)) {
            const pp = ppRaw as Record<string, unknown>;
            if (typeof pp.w === "number" && Number.isFinite(pp.w) && pp.w >= 0) pw = pp.w;
            if (typeof pp.r === "number" && Number.isFinite(pp.r) && pp.r >= 0) pr = pp.r;
            if (typeof pp.q === "number" && Number.isFinite(pp.q) && pp.q >= 0) pq = pp.q;
        }
        const eff: Required<PriceProfile> = { w: pw ?? 1, r: pr ?? 0.1, q: pq ?? 4 };
        const src = parsePriceSourceStamp(s.metadata["cachePriceSource"]);
        const priced = summarizePricedFolds(
            (led?.folds ?? []).map((f) => ({ S: f.S ?? 0, sigma: f.sigma ?? 0, T: f.T ?? 0, requestsAfter: f.requestsAfter ?? 0 })),
            eff,
            src,
        );
        if (priced !== undefined) {
            grossSavedUsd = priced.grossUsd;
            oneTimeCostUsd = priced.oneTimeUsd;
            netSavedUsd = priced.netUsd;
            priceSource = formatPriceSourceLine(priced.source);
        }
    }
    // Untitled sessions: fall back to the first compression block's topic/summary lead.
    let firstBlockHint = "";
    const fb = s.state.blocks.find((b) => b.topic || b.summary);
    if (fb && (fb.topic || fb.summary)) {
        firstBlockHint = String(fb.topic || fb.summary).replace(/\s+/g, " ").trim();
        if (firstBlockHint.length > 48) firstBlockHint = firstBlockHint.slice(0, 48) + "…";
    }
    // #1426: which client this session came from (plugin stamp wins, then sniff/UA hint).
    const metaRec = s.metadata as Record<string, unknown>;
    // #2155: active self-heal state (zombie plugin degrade / nudge
    // suppression) — surface it so the web list can badge the session.
    const shRaw = metaRec["selfHeal"];
    const selfHeal = shRaw !== null && typeof shRaw === "object"
        && typeof (shRaw as Record<string, unknown>)["detected"] === "string"
        && typeof (shRaw as Record<string, unknown>)["action"] === "string"
        && typeof (shRaw as Record<string, unknown>)["since"] === "number"
        ? { detected: (shRaw as Record<string, unknown>)["detected"] as string, action: (shRaw as Record<string, unknown>)["action"] as string, since: (shRaw as Record<string, unknown>)["since"] as number }
        : undefined;
    const clientHint = typeof metaRec["pluginAgent"] === "string" && metaRec["pluginAgent"]
        ? metaRec["pluginAgent"] as string
        : typeof metaRec["clientHint"] === "string" && metaRec["clientHint"] ? metaRec["clientHint"] as string : "";
    const best = displayContextBest(s);
    return {
        id: s.id,
        ...(best ? { contextBest: best } : {}),
        // #2322: a host-provided name (pi /name) outranks the derived
        // first-message title everywhere the row feeds (list, search, export).
        ...((s.meta.hostTitle || s.meta.title) ? { title: s.meta.hostTitle || s.meta.title } : {}),
        // #1426: meta.label is auto-stamped with the session id on many clients —
        // treat label === id as "no title" so lists/details show 无标题 + block hint.
        ...(s.meta.label && s.meta.label !== s.id ? { label: s.meta.label } : {}),
        ...(s.meta.protocol ? { protocol: s.meta.protocol } : {}),
        ...(s.meta.upstreamOrigin ? { upstreamOrigin: s.meta.upstreamOrigin } : {}),
        live,
        requests,
        contextTokens: s.stats.contextTokens,
        ...(s.stats.contextTokensSource ? { contextTokensSource: s.stats.contextTokensSource } : {}),
        tokensSaved: s.stats.tokensSaved,
        inputTokens,
        cachedTokens,
        outputTokens,
        cacheHitPct: hitPct(inputTokens, cachedTokens),
        blocks: s.state.blocks.length,
        ...(typeof s.metadata.effectiveContextLimit === "number" ? { contextWindow: s.metadata.effectiveContextLimit } : {}),
        ...(selfHeal ? { selfHeal } : {}),
        lastSeen: new Date(s.lastSeen).toISOString(),
        ...(s.restored ? { restored: true } : {}),
        ...(hasLedger ? { hasLedger: true } : {}),
        ...(firstBlockHint ? { firstBlockHint } : {}),
        ...(hasFolds ? { grossSaved, netSaved, repayCost, summaryCost, foldCount } : {}),
        ...(netSavedUsd !== undefined ? { grossSavedUsd, oneTimeCostUsd, netSavedUsd, ...(priceSource !== undefined ? { priceSource } : {}) } : {}),
        ...(hasFolds && coverageLostFolds > 0 ? { coverageLostFolds, coverageLostFrozenTokens } : {}),
        ...(hasLedger ? { newContent: agg?.agg?.nc ?? 0, compRepay: agg?.agg?.cr ?? 0, ttlRepay: agg?.agg?.tr ?? 0 } : {}),
        ...(typeof agg?.agg?.input === "number" && agg.agg.input > 0
            ? {
                  missDropNew: Math.round(((agg.agg.nc ?? 0) / agg.agg.input) * 1000) / 10,
                  missDropComp: Math.round(((agg.agg.cr ?? 0) / agg.agg.input) * 1000) / 10,
                  missDropTtl: Math.round(((agg.agg.tr ?? 0) / agg.agg.input) * 1000) / 10,
              }
            : {}),
        ...(typeof agg?.agg?.switches === "number" && agg.agg.switches > 0
            ? { modelSwitches: agg?.agg.switches, switchMissedTokens: agg?.agg?.switchMissed ?? 0 }
            : {}),
        ...(typeof agg?.agg?.keySwitches === "number" && agg.agg.keySwitches > 0
            ? { keySwitches: agg.agg.keySwitches, keySwitchMissedTokens: agg?.agg?.keySwitchMissed ?? 0 }
            : {}),
        ...(clientHint ? { clientHint } : {}),
    };
}

/** Every known session, newest activity first. Live entries take precedence
 *  over their disk twin (disk files lag by up to the store's write debounce). */
/** Sessions without any trace of activity — reqs<=1, zero context tokens, no
 *  compression blocks, no cache ledger (startup & test stubs). Hidden from every
 *  list (#1426 user ask); still reachable through a direct detail link. */
function isEmptyStub(s: WebSessionSummary): boolean {
    return (s.requests ?? 0) <= 1 && (s.contextTokens ?? 0) === 0 && (s.blocks ?? 0) === 0 && !s.hasLedger;
}

let lastHiddenEmpty = 0;
export function hiddenEmptyCount(): number { return lastHiddenEmpty; }

async function mergedSummaries(): Promise<WebSessionSummary[]> {
    const files = await ensureIndex();
    const out = new Map<string, WebSessionSummary>();
    for (const e of files.values()) if (e.summary) out.set(e.summary.id, e.summary);
    for (const s of listSessions()) out.set(s.id, summaryOf(s, true));
    return [...out.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export async function buildSessionList(): Promise<WebSessionSummary[]> {
    const all = await mergedSummaries();
    const vis = all.filter((s) => !isEmptyStub(s));
    lastHiddenEmpty = all.length - vis.length;
    return vis;
}

interface SessionPageQuery { q?: string; page?: number; pageSize: number }

interface SessionPageResult {
    sessions: WebSessionSummary[];
    total: number;
    page: number;
    pageSize: number;
}

/** #1937: server-side filtered + paged view over the SAME sorted summary set
 *  as buildSessionList (stub filter first so hiddenEmpty keeps its meaning,
 *  then the case-insensitive q match on title/label/id — mirroring what the
 *  old client-side filter did). Read cost is O(index), independent of how
 *  much history lies behind the requested page. */
export async function buildSessionPage(query: SessionPageQuery): Promise<SessionPageResult> {
    const all = await mergedSummaries();
    const vis = all.filter((s) => !isEmptyStub(s));
    lastHiddenEmpty = all.length - vis.length;
    const q = (query.q ?? "").trim().toLowerCase();
    const filtered = q
        ? vis.filter((s) =>
            (s.title ?? "").toLowerCase().includes(q) ||
            (s.label ?? "").toLowerCase().includes(q) ||
            s.id.toLowerCase().includes(q))
        : vis;
    const total = filtered.length;
    const pageSize = Math.min(Math.max(1, Math.floor(query.pageSize)), 200);
    const page = Math.max(1, Math.floor(query.page ?? 1));
    return { sessions: filtered.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize };
}

/** Aggregate stats across ALL known sessions (live + disk) — the "how many
 *  tokens total / saved" numbers for the overview dashboard. */
export async function buildOverview(): Promise<WebOverview> {
    const allAll = await mergedSummaries();
    const all = allAll.filter((s) => !isEmptyStub(s));
    let requests = 0, input = 0, cached = 0, output = 0, saved = 0, savedEstimated = 0, blocks = 0, live = 0;
    let grossSavedTotal = 0, netSavedTotal = 0, repayTotal = 0, summaryCostTotal = 0, hasFoldData = false;
    let coverageLostFoldTotal = 0, coverageLostFrozenTotal = 0;
    // #2478: priced (USD) vs unpriced (token) split of the fold sessions —
    // faces show $ when any session is priced and keep the token remainder.
    let grossSavedUsdTotal = 0, netSavedUsdTotal = 0, oneTimeCostTotal = 0, pricedSessions = 0;
    let unpricedGrossTokens = 0, unpricedNetTokens = 0;
    let missNewTotal = 0, missCompTotal = 0, missTtlTotal = 0, missInputTotal = 0;
    const protoMap = new Map<string, { protocol: string; sessions: number; requests: number; inputTokens: number; cachedTokens: number; savedNet: number; folds: number; missNew: number; missComp: number; missTtl: number; missInput: number }>();
    for (const s of all) {
        requests += s.requests;
        input += s.inputTokens;
        cached += s.cachedTokens;
        output += s.outputTokens;
        saved += s.tokensSaved;
        blocks += s.blocks;
        // Disk-restored sessions count as history: the pool still holds them,
        // but their process died — only never-restored entries are "live".
        if (s.live && !s.restored) live += 1;
        // tokensSaved is a local estimate (upstream never reports it); flag
        // the share coming from sessions without usage samples (ledger).
        const key = s.protocol ?? "unknown";
        const row = protoMap.get(key) ?? { protocol: key, sessions: 0, requests: 0, inputTokens: 0, cachedTokens: 0, savedNet: 0, folds: 0, missNew: 0, missComp: 0, missTtl: 0, missInput: 0 };
        row.sessions += 1;
        row.requests += s.requests;
        row.inputTokens += s.inputTokens;
        row.cachedTokens += s.cachedTokens;
        row.savedNet += s.hasLedger ? (s.netSaved ?? 0) : s.tokensSaved;
        row.folds += s.foldCount ?? 0;
        protoMap.set(key, row);
        if (s.tokensSaved > 0 && !s.hasLedger) savedEstimated += s.tokensSaved;
        if (s.hasLedger) {
            missNewTotal += s.newContent ?? 0;
            missCompTotal += s.compRepay ?? 0;
            missTtlTotal += s.ttlRepay ?? 0;
            missInputTotal += s.inputTokens;
            row.missNew += s.newContent ?? 0;
            row.missComp += s.compRepay ?? 0;
            row.missTtl += s.ttlRepay ?? 0;
            row.missInput += s.inputTokens;
        }
        if (s.hasLedger && s.grossSaved != null) {
            hasFoldData = true;
            grossSavedTotal += s.grossSaved;
            netSavedTotal += s.netSaved ?? 0;
            repayTotal += s.repayCost ?? 0;
            summaryCostTotal += s.summaryCost ?? 0;
            coverageLostFoldTotal += s.coverageLostFolds ?? 0;
            coverageLostFrozenTotal += s.coverageLostFrozenTokens ?? 0;
            if (s.netSavedUsd != null) {
                pricedSessions += 1;
                grossSavedUsdTotal += s.grossSavedUsd ?? 0;
                netSavedUsdTotal += s.netSavedUsd;
                oneTimeCostTotal += s.oneTimeCostUsd ?? 0;
            } else {
                unpricedGrossTokens += s.grossSaved;
                unpricedNetTokens += s.netSaved ?? 0;
            }
        } else if (s.tokensSaved > 0) {
            // Pre-tagging sessions: their local estimate counts toward the compressed side only.
            grossSavedTotal += s.tokensSaved;
        }
    }
    return {
        sessions: all.length,
        live,
        requests,
        inputTokens: input,
        cachedTokens: cached,
        outputTokens: output,
        tokensSaved: saved,
        savedEstimated,
        grossSavedTotal,
        netSavedTotal,
        hasFoldData,
        repayTotal,
        summaryCostTotal,
        coverageLostFoldTotal,
        coverageLostFrozenTotal,
        ...(pricedSessions > 0 ? { grossSavedUsdTotal, netSavedUsdTotal, oneTimeCostTotal, pricedSessions, unpricedGrossTokens, unpricedNetTokens } : {}),
        missNewTotal,
        missCompTotal,
        missTtlTotal,
        missInputTotal,
        hitPct: hitPct(input, cached),
        blocks,
        byProtocol: [...protoMap.values()].map((r) => {
            const base = r.missInput || 0;
            const drop = (v: number) => Math.round((v / base) * 1000) / 10;
            return {
                protocol: r.protocol,
                sessions: r.sessions,
                requests: r.requests,
                inputTokens: r.inputTokens,
                cachedTokens: r.cachedTokens,
                savedNet: r.savedNet,
                folds: r.folds,
                hitPct: hitPct(r.inputTokens, r.cachedTokens),
                ...(base > 0 ? { missDropNew: drop(r.missNew), missDropComp: drop(r.missComp), missDropTtl: drop(r.missTtl) } : {}),
            };
        }),
        recent: all.slice(0, 8),
        hiddenEmpty: allAll.length - all.length,
    };
}

// ---------------------------------------------------------------------------
// Detail (lazy single-file load)
// ---------------------------------------------------------------------------

const detailInFlight = new Map<string, Promise<WebSessionDetail | null>>();

/** Full detail for one session: stats + compression blocks + the per-request
 *  cache ledger (trajectory-chart source) + rendered handoff document.
 *  Returns null when the id is unknown (→ 404). Never creates sessions —
 *  lookups go through listSessions() + ONE decoded disk file (#1937: the old
 *  path scanned the entire directory for a single id). Concurrent requests
 *  for the same id share one decode. */
export function buildSessionDetail(id: string): Promise<WebSessionDetail | null> {
    const existing = detailInFlight.get(id);
    if (existing) return existing;
    const run = (async (): Promise<WebSessionDetail | null> => {
        const live = listSessions().find((s) => s.id === id);
        let session: Session | undefined = live;
        if (!session) {
            const files = await ensureIndex();
            const abs = byId?.get(id);
            if (abs && files.has(abs)) {
                detailDecodes++;
                session = (await getDiskStore().loadSessionFromFile(abs, id)) ?? undefined;
            }
        }
        if (!session) return null;
        return renderDetail(session, !!live);
    })();
    const done = run.finally(() => detailInFlight.delete(id));
    detailInFlight.set(id, done);
    return done;
}

function renderDetail(session: Session, live: boolean): WebSessionDetail {
    // renderHandoff reads lastMessages (a bounded snapshot) — safe for disk
    // sessions; the v2 fallback path renders header + block summaries.
    let handoffMd = "";
    try {
        handoffMd = renderHandoff(session, false);
    } catch (error) {
        log("warn", `[acp-web] handoff render failed for ${session.id}: ${String(error)}`);
    }
    let handoffTruncated = false;
    if (handoffMd.length > 1_500_000) {
        handoffMd = handoffMd.slice(0, 1_500_000) + "\n\n…（内容过长已截断，使用 `bili export` 查看完整会话）\n";
        handoffTruncated = true;
    }

    // #1426 web UI: which client produced this session + its measured system-prompt size.
    // Plugin agents are stamped as metadata.pluginAgent at request time; non-plugin
    // clients carry a header-sniffed or User-Agent hint (metadata.clientHint).
    const pluginAgent = typeof session.metadata["pluginAgent"] === "string" ? session.metadata["pluginAgent"] : undefined;
    const clientHint = pluginAgent ?? (typeof session.metadata["clientHint"] === "string" ? session.metadata["clientHint"] : undefined);
    const sysPrompt = typeof session.metadata["systemPromptTokens"] === "number" ? session.metadata["systemPromptTokens"] : 0;
    // #2430/#2545: bili's own siblings (billion-context-pi / opencode-acp) are compatible
    // family and verified read-only plugins (KNOWN_DISPLAY_ONLY) are not compressors — keep
    // both out of the session evidence card so such sessions render no conflict block at all.
    // Recording (acp_status #2261 calm footer) is unchanged.
    const conflicts = conflictEventsOf(session).filter((e) => !(e.kind === "third-party-plugin" && (isSiblingConflictDetail(e.detail) || isDisplayOnlyConflictDetail(e.detail))));
    const conflictClient = conflicts.length > 0 ? conflictClientOf(session) : undefined;

    return {
        ...summaryOf(session, live),
        lastInputTokens: session.stats.lastInputTokens,
        compressCreditTokens: session.stats.compressCreditTokens,
        retrieveCalls: session.stats.retrieveCalls,
        retrieveHits: session.stats.retrieveHits,
        retrieveMisses: session.stats.retrieveMisses,
        storedBytes: session.stats.storedBytes,
        storeBytesSaved: session.stats.storeBytesSaved,
        ...(session.meta.activePack ? { activePack: session.meta.activePack } : {}),
        ...(clientHint ? { clientHint } : {}),
        ...(typeof session.metadata["biliVersion"] === "string" ? { biliVersion: session.metadata["biliVersion"] as string } : {}),
        ...(sysPrompt > 0 ? { systemPromptTokens: sysPrompt } : {}),
        ...(typeof session.stats.localInputEstimate === "number" && session.stats.localInputEstimate > 0
            ? { contextUpperTokens: session.stats.localInputEstimate } : {}),
        ...(session.stats.lastInputTokensOrigin ? { lastInputTokensOrigin: session.stats.lastInputTokensOrigin } : {}),
        ...(typeof session.metadata["contextTokensAt"] === "number" ? { contextMeasuredAt: session.metadata["contextTokensAt"] as number } : {}),
        ...(typeof session.stats.calibratedEstimate === "number" && session.stats.calibratedEstimate > 0 && (session.stats.calibrationRing?.values.length ?? 0) > 0
            ? (() => {
                  const vals = session.stats.calibrationRing!.values;
                  return { estimateCalibration: {
                      factor: session.stats.calibratedEstimate,
                      ...(session.stats.calibratedEstimateOrigin !== undefined ? { origin: session.stats.calibratedEstimateOrigin } : {}),
                      ...(session.stats.calibratedEstimateModel !== undefined ? { model: session.stats.calibratedEstimateModel } : {}),
                      samples: vals.length,
                      spread: Math.max(...vals) / Math.min(...vals),
                  } };
              })()
            : {}),
        ledger: buildSessionCacheReport(session),
        handoffMd,
        handoffHtml: markdownToHtml(handoffMd),
        handoffTruncated,
        ...(conflicts.length > 0 ? { conflicts } : {}),
        ...(conflictClient ? { conflictClient } : {}),
        blockDetails: session.state.blocks.map((b) => {
            // Display data: canonicalize to ascending labels so non-monotonic-
            // ref spans don't render reversed in the UI (#2168).
            const span =
                b.startRef !== undefined && b.endRef !== undefined
                    ? orderedRefPair(b.startRef, b.endRef)
                    : null;
            return {
                blockId: b.blockId,
                tier: b.tier,
                ...(b.topic !== undefined ? { topic: b.topic } : {}),
                summary: b.summary,
                compressedTokens: b.compressedTokens,
                createdAt: b.createdAt,
                ...(span ? { startRef: span[0], endRef: span[1] } : {}),
                ...(span === null && b.startRef !== undefined ? { startRef: b.startRef } : {}),
                ...(span === null && b.endRef !== undefined ? { endRef: b.endRef } : {}),
                active: b.active,
                ...(isExternalSummaryBlock(b) ? { external: true } : {}),
            };
        }),
    };
}
