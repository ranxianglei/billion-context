import { listSessions, type Session } from "../session.js";
import { SessionStore } from "../persist.js";
import { renderHandoff } from "../export.js";
import { buildSessionCacheReport } from "../cache-ledger.js";
import { markdownToHtml } from "./markdown.js";
import { log } from "../logger.js";

/** #1420: read-only session browsing for the web UI. Merges the LIVE in-memory
 *  pool (bounded — evicted sessions are gone) with the full on-disk store;
 *  live always wins per id. Disk files decode via the same store as bili
 *  export (encryption/zstd); unreadable files skip silently, as in export. */

export interface WebSessionSummary {
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
    /** Σ (S−σ)×requestsAfter across ledger folds — input tokens not billed thanks to
     *  compression (acp-kernel EconomicsSummary.grossSaved semantics). */
    grossSaved?: number;
    /** Per-session net: Σ ((S−σ)×requestsAfter − T − σ); may be negative. */
    netSaved?: number;
    /** Σ T — measured compression re-pay tokens. */
    repayCost?: number;
    /** Σ σ — summary generation cost (output tokens). */
    summaryCost?: number;
}

export interface WebOverview {
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
    hitPct: number | null;
    blocks: number;
    byProtocol: Array<{ protocol: string; sessions: number; requests: number; inputTokens: number; cachedTokens: number }>;
    recent: WebSessionSummary[];
}

export interface WebSessionDetail extends WebSessionSummary {
    lastInputTokens: number;
    compressCreditTokens: number;
    retrieveCalls: number;
    retrieveHits: number;
    retrieveMisses: number;
    storedBytes: number;
    storeBytesSaved: number;
    activePack?: string;
    ledger: ReturnType<typeof buildSessionCacheReport> | null;
    /** Raw markdown of the handoff doc (handoffHtml rendered) — for the
     *  copy-markdown / download buttons. */
    handoffMd: string;
    handoffHtml: string;
    handoffTruncated: boolean;
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
    }>;
}

/** Disk scan memoization: decoding every session file (zstd + optional GCM)
 *  is not free, so results are reused for DISK_TTL_MS. Single-flight so a
 *  burst of overview+sessions requests triggers one scan. The store itself
 *  is a module-level singleton (the kernel StateStore has no timer leaks —
 *  debounce timers only arm on writes, which never happen here). */
const DISK_TTL_MS = 5_000;

let diskStore: SessionStore | null = null;
function getDiskStore(): SessionStore {
    if (!diskStore) diskStore = new SessionStore({ enabled: true });
    return diskStore;
}

let diskMemo: { at: number; map: Map<string, Session> } | null = null;
let diskScan: Promise<Map<string, Session>> | null = null;

function loadDiskSessions(): Promise<Map<string, Session>> {
    if (diskMemo && Date.now() - diskMemo.at < DISK_TTL_MS) return Promise.resolve(diskMemo.map);
    if (!diskScan) {
        const run = (async () => {
            try {
                const map = await getDiskStore().loadAll();
                diskMemo = { at: Date.now(), map };
                return map;
            } catch (error) {
                log("warn", `[acp-web] session disk scan failed: ${String(error)}`);
                return diskMemo?.map ?? new Map<string, Session>();
            }
        })();
        diskScan = run.finally(() => { diskScan = null; });
    }
    return diskScan;
}

/** Test hook: drop the memoized scan AND the store singleton (its dir was
 *  resolved at construction, so a changed BILI_SESSIONS_DIR needs a fresh one). */
export function _resetDiskCacheForTest(): void {
    diskMemo = null;
    diskScan = null;
    diskStore = null;
}

function hitPct(input: number, cached: number): number | null {
    return input > 0 ? Math.round((cached / input) * 100) : null;
}

function summaryOf(s: Session, live: boolean): WebSessionSummary {
    // Dual-source token counters: session.stats accumulates upstream-reported
    // usage; metadata.cacheLedger.agg accumulates the ACP/web ledger samples.
    // Per-field MAX (the sources overlap, never sum). Read-only on purpose:
    // getCacheLedger() would bootstrap/mutate session.metadata instead.
    const led = s.metadata["cacheLedger"] as {
        agg?: { requests?: number; input?: number; cached?: number; output?: number };
        folds?: Array<{ S?: number; sigma?: number; T?: number; requestsAfter?: number }>;
    } | undefined;
    const agg = led;
    const requests = Math.max(s.stats.requests ?? 0, agg?.agg?.requests ?? 0);
    const inputTokens = Math.max(s.stats.inputTokens ?? 0, agg?.agg?.input ?? 0);
    const cachedTokens = Math.max(s.stats.cachedTokens ?? 0, agg?.agg?.cached ?? 0);
    const outputTokens = Math.max(s.stats.outputTokens ?? 0, agg?.agg?.output ?? 0);
    const hasLedger = Boolean(agg?.agg && (agg.agg.requests ?? 0) > 0);
    // Fold economics straight off the stored ledger (read-only — no report build):
    // mirrors acp-kernel summarizeFoldEconomics() so the dashboard can split
    // "compressed away" (gross) from "net saving after re-pay & summary cost".
    let hasFolds = false, grossSaved = 0, netSaved = 0, repayCost = 0, summaryCost = 0;
    for (const f of led?.folds ?? []) {
        hasFolds = true;
        const S = f.S ?? 0, sig = f.sigma ?? 0, rep = f.T ?? 0, ra = f.requestsAfter ?? 0;
        const avoided = (S - sig) * ra;
        grossSaved += avoided;
        netSaved += avoided - rep - sig;
        repayCost += rep;
        summaryCost += sig;
    }
    // Untitled sessions: fall back to the first compression block's topic/summary lead.
    let firstBlockHint = "";
    const fb = s.state.blocks.find((b) => b.topic || b.summary);
    if (fb && (fb.topic || fb.summary)) {
        firstBlockHint = String(fb.topic || fb.summary).replace(/\s+/g, " ").trim();
        if (firstBlockHint.length > 48) firstBlockHint = firstBlockHint.slice(0, 48) + "…";
    }
    return {
        id: s.id,
        ...(s.meta.title ? { title: s.meta.title } : {}),
        ...(s.meta.label ? { label: s.meta.label } : {}),
        ...(s.meta.protocol ? { protocol: s.meta.protocol } : {}),
        ...(s.meta.upstreamOrigin ? { upstreamOrigin: s.meta.upstreamOrigin } : {}),
        live,
        requests,
        contextTokens: s.stats.contextTokens,
        tokensSaved: s.stats.tokensSaved,
        inputTokens,
        cachedTokens,
        outputTokens,
        cacheHitPct: hitPct(inputTokens, cachedTokens),
        blocks: s.state.blocks.length,
        ...(typeof s.metadata.effectiveContextLimit === "number" ? { contextWindow: s.metadata.effectiveContextLimit } : {}),
        lastSeen: new Date(s.lastSeen).toISOString(),
        ...(s.restored ? { restored: true } : {}),
        ...(hasLedger ? { hasLedger: true } : {}),
        ...(firstBlockHint ? { firstBlockHint } : {}),
        ...(hasFolds ? { grossSaved, netSaved, repayCost, summaryCost } : {}),
    };
}

/** Every known session, newest activity first. Live entries take precedence
 *  over their disk twin (disk files lag by up to the store's write debounce). */
export async function buildSessionList(): Promise<WebSessionSummary[]> {
    const disk = await loadDiskSessions();
    const out = new Map<string, WebSessionSummary>();
    for (const [id, s] of disk) out.set(id, summaryOf(s, false));
    for (const s of listSessions()) out.set(s.id, summaryOf(s, true));
    return [...out.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** Aggregate stats across ALL known sessions (live + disk) — the "how many
 *  tokens total / saved" numbers for the overview dashboard. */
export async function buildOverview(): Promise<WebOverview> {
    const all = await buildSessionList();
    let requests = 0, input = 0, cached = 0, output = 0, saved = 0, savedEstimated = 0, blocks = 0, live = 0;
    let grossSavedTotal = 0, netSavedTotal = 0, repayTotal = 0, summaryCostTotal = 0, hasFoldData = false;
    const protoMap = new Map<string, { protocol: string; sessions: number; requests: number; inputTokens: number; cachedTokens: number }>();
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
        const row = protoMap.get(key) ?? { protocol: key, sessions: 0, requests: 0, inputTokens: 0, cachedTokens: 0 };
        row.sessions += 1;
        row.requests += s.requests;
        row.inputTokens += s.inputTokens;
        row.cachedTokens += s.cachedTokens;
        protoMap.set(key, row);
        if (s.tokensSaved > 0 && !s.hasLedger) savedEstimated += s.tokensSaved;
        if (s.hasLedger && s.grossSaved != null) {
            hasFoldData = true;
            grossSavedTotal += s.grossSaved;
            netSavedTotal += s.netSaved ?? 0;
            repayTotal += s.repayCost ?? 0;
            summaryCostTotal += s.summaryCost ?? 0;
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
        hitPct: hitPct(input, cached),
        blocks,
        byProtocol: [...protoMap.values()],
        recent: all.slice(0, 8),
    };
}

/** Full detail for one session: stats + compression blocks + the per-request
 *  cache ledger (trajectory-chart source) + rendered handoff document.
 *  Returns null when the id is unknown (→ 404). Never creates sessions —
 *  lookups go through listSessions() + the disk map only. */
export async function buildSessionDetail(id: string): Promise<WebSessionDetail | null> {
    const live = listSessions().find((s) => s.id === id);
    let session: Session | undefined = live;
    if (!session) {
        const disk = await loadDiskSessions();
        session = disk.get(id);
    }
    if (!session) return null;

    // renderHandoff reads lastMessages (a bounded snapshot) — safe for disk
    // sessions; the v2 fallback path renders header + block summaries.
    let handoffMd = "";
    try {
        handoffMd = renderHandoff(session, false);
    } catch (error) {
        log("warn", `[acp-web] handoff render failed for ${id}: ${String(error)}`);
    }
    let handoffTruncated = false;
    if (handoffMd.length > 1_500_000) {
        handoffMd = handoffMd.slice(0, 1_500_000) + "\n\n…（内容过长已截断，使用 `bili export` 查看完整会话）\n";
        handoffTruncated = true;
    }

    return {
        ...summaryOf(session, !!live),
        lastInputTokens: session.stats.lastInputTokens,
        compressCreditTokens: session.stats.compressCreditTokens,
        retrieveCalls: session.stats.retrieveCalls,
        retrieveHits: session.stats.retrieveHits,
        retrieveMisses: session.stats.retrieveMisses,
        storedBytes: session.stats.storedBytes,
        storeBytesSaved: session.stats.storeBytesSaved,
        ...(session.meta.activePack ? { activePack: session.meta.activePack } : {}),
        ledger: buildSessionCacheReport(session),
        handoffMd,
        handoffHtml: markdownToHtml(handoffMd),
        handoffTruncated,
        blockDetails: session.state.blocks.map((b) => ({
            blockId: b.blockId,
            tier: b.tier,
            ...(b.topic !== undefined ? { topic: b.topic } : {}),
            summary: b.summary,
            compressedTokens: b.compressedTokens,
            createdAt: b.createdAt,
            ...(b.startRef !== undefined ? { startRef: b.startRef } : {}),
            ...(b.endRef !== undefined ? { endRef: b.endRef } : {}),
            active: b.active,
        })),
    };
}
