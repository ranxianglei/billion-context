// Context analysis — per-session observability for the question that used to
// take hours of manual log forensics: "why is this session's context where
// it is?" (born from the 2026-11-08 session-aedc188c investigation: the
// session sat at 40-52% usage and nobody could say whether it was the init
// size, the nudge cadence, or the model under-harvesting the offered mass).
//
// Four dimensions, three surfaces:
//   1. init profile — first observed request: how many messages, how big each
//   2. nudge cadence — INJECT count + which gate idled (mass / growth / cadence)
//   3. harvest rate — per INJECT, the offered pendingT1 vs the tokens the
//      model actually folded within a short window (acceptance rate)
//   4. verdict — plain-language diagnosis assembled from 1-3 (inflow vs drain,
//      distillation readiness, under-harvest alert)
// Surfaces: a `[context-analysis]` log line on every INJECT (and every 60th
// idle gate), a CONTEXT ANALYSIS section in the acp_status default report,
// and a card on the web session detail page.
//
// In-memory only (this process's lifetime), bounded, and strictly advisory —
// NO decision path reads it.

import { countMessageTokens, defaultCountTokens, type CoreMessage } from "acp-kernel";

interface InitMessageEntry {
    role: string;
    contentType: string;
    toolName?: string;
    estTokens: number;
}

interface InitProfile {
    ts: number;
    messageCount: number;
    totalChars: number;
    estTokens: number;
    /** Capped sample (largest first); the aggregate counts cover ALL messages. */
    perMessage: InitMessageEntry[];
}

interface NudgeEvent {
    ts: number;
    label: string;
    tier: number | null;
    usagePct: number;
    tokenCount: number;
    limit: number;
    growth: number;
    floor: number;
    interval: number;
    pendingT1: number;
    pendingT2: number;
    pendingT3: number;
    /** Set when a compress commit within the harvest window consumed this offer. */
    matched?: boolean;
}

interface HarvestRecord {
    ts: number;
    offered: number;
    got: number;
    ratio: number;
}

interface CommitSample {
    ts: number;
    tokens: number;
}

export interface UsageSample {
    ts: number;
    tokenCount: number;
    limit: number;
}

interface TierReadiness {
    ts: number;
    t1: number;
    t2: number;
    t3: number;
    /** The T1 mass threshold (nudgeGrowthTokens) observed with this sample. */
    interval: number;
}

interface ContextAnalysis {
    sessionId: string;
    firstSeen: number;
    lastSeen: number;
    requests: number;
    init?: InitProfile;
    /** Inject-family events, oldest first (capped). */
    injects: NudgeEvent[];
    /** Total INJECT count (survives the cap). */
    injectTotal: number;
    /** Idle-observation gate counts (which gate held, and how often).
     *  No distill bucket: the kernel never emits a distill-specific idle
     *  reason, so T2/T3 readiness is reported from lastReadiness instead. */
    idleGates: { mass: number; growth: number; cadence: number; other: number };
    /** Harvest pairings, oldest first (capped). */
    harvests: HarvestRecord[];
    /** Per-commit token samples (capped) — powers the drain rate. */
    commits: CommitSample[];
    compressCommits: number;
    compressedTotal: number;
    /** Usage ring (capped) — powers the inflow rate. */
    usage: UsageSample[];
    lastReadiness?: TierReadiness;
}

const SESSIONS_CAP = 256;
const INJECTS_CAP = 500;
const HARVESTS_CAP = 200;
const COMMITS_CAP = 500;
const USAGE_CAP = 1200;
const INIT_PER_MSG_CAP = 100;
/** A commit this close after an INJECT counts as the answer to that offer. */
export const HARVEST_WINDOW_MS = 120_000;

const analyses = new Map<string, ContextAnalysis>();

function touch(id: string): ContextAnalysis {
    let a = analyses.get(id);
    if (!a) {
        a = {
            sessionId: id,
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            requests: 0,
            injects: [],
            injectTotal: 0,
            idleGates: { mass: 0, growth: 0, cadence: 0, other: 0 },
            harvests: [],
            commits: [],
            compressCommits: 0,
            compressedTotal: 0,
            usage: [],
        };
        analyses.set(id, a);
        if (analyses.size > SESSIONS_CAP) {
            const oldest = analyses.keys().next().value;
            if (oldest !== undefined) analyses.delete(oldest);
        }
    } else {
        // LRU: re-insert so the capped eviction drops the coldest session.
        analyses.delete(id);
        analyses.set(id, a);
    }
    return a;
}

function snapshotInit(messages: CoreMessage[]): InitProfile {
    const entries: InitMessageEntry[] = [];
    let totalChars = 0;
    let estTokens = 0;
    for (const m of messages) {
        const chars = (m.text ?? "").length + (m.toolName ? m.toolName.length : 0);
        totalChars += chars;
        const tok = countMessageTokens(m, defaultCountTokens);
        estTokens += tok;
        entries.push({ role: m.role, contentType: m.contentType, toolName: m.toolName, estTokens: tok });
    }
    entries.sort((x, y) => y.estTokens - x.estTokens);
    return {
        ts: Date.now(),
        messageCount: messages.length,
        totalChars,
        estTokens,
        perMessage: entries.slice(0, INIT_PER_MSG_CAP),
    };
}

interface NudgeObservationTurn {
    nudge?: {
        shouldInject: boolean;
        reason: string;
        contextUsage: number;
        tier: number | null;
        breakdown?: Record<string, number>;
    } | null;
    messages?: CoreMessage[] | null;
}

function fmtKiB(chars: number): string {
    const k = chars / 1024;
    return k >= 1024 ? `${(k / 1024).toFixed(1)}MiB` : `${k.toFixed(1)}KiB`;
}

function fmtKtok(n: number): string {
    return n >= 10_000 ? `${(n / 1000).toFixed(0)}K` : `${n}`;
}

function fmtHM(ms: number): string {
    const h = ms / 3_600_000;
    return h >= 10 ? `${h.toFixed(0)}h` : h >= 1 ? `${h.toFixed(1)}h` : `${(ms / 60_000).toFixed(0)}m`;
}

function clock(ts: number): string {
    const d = new Date(ts);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ringSlopePerHour(ring: { ts: number; v: number }[], now: number): number | null {
    // Slope over the last hour of the ring (needs ≥5 min of span to be meaningful).
    const cutoff = now - 3_600_000;
    let first: { ts: number; v: number } | null = null;
    let last: { ts: number; v: number } | null = null;
    for (const s of ring) {
        if (s.ts < cutoff) continue;
        if (first === null) first = s;
        last = s;
    }
    if (first === null || last === null || first === last) return null;
    const spanH = (last.ts - first.ts) / 3_600_000;
    if (spanH < 5 / 60) return null;
    return (last.v - first.v) / spanH;
}

/** The plain-language verdict (rule 8: a non-member must understand it). */
function buildVerdict(a: ContextAnalysis, now = Date.now()): string[] {
    const out: string[] = [];
    const spanMs = a.lastSeen - a.firstSeen;
    if (spanMs < 60_000) return out; // too young to diagnose
    const inflow = ringSlopePerHour(a.usage.map((u) => ({ ts: u.ts, v: u.tokenCount })), now);
    // Drain is the slope of CUMULATIVE compressed tokens (each commit sample
    // is a per-commit amount, not a running total).
    const cumCommits: { ts: number; v: number }[] = [];
    let cumTokens = 0;
    for (const c of a.commits) {
        cumTokens += c.tokens;
        cumCommits.push({ ts: c.ts, v: cumTokens });
    }
    const drain = ringSlopePerHour(cumCommits, now);
    const limit = a.usage.length > 0 ? a.usage[a.usage.length - 1]!.limit : 0;

    if (a.init && limit > 0 && a.init.estTokens >= 0.15 * limit) {
        out.push(
            `session started heavy: the first observed request already carried ~${fmtKtok(a.init.estTokens)} tok (${a.init.messageCount} msgs, ${fmtKiB(a.init.totalChars)}) — the context floor was high before any compression ran`,
        );
    }
    if (inflow !== null && drain !== null) {
        if (inflow > drain * 1.15) {
            out.push(`usage climbing: new content ≈${fmtKtok(inflow)} tok/h outpaces T1 compression ≈${fmtKtok(drain)} tok/h — the band drifts up until a distillation reset lands`);
        } else if (inflow < drain * 0.85) {
            out.push(`usage falling: T1 compression ≈${fmtKtok(drain)} tok/h exceeds new content ≈${fmtKtok(inflow)} tok/h`);
        } else {
            out.push(`usage plateau: inflow ≈${fmtKtok(inflow)} tok/h balances T1 drain ≈${fmtKtok(drain)} tok/h — the band is pinned where they meet, not stuck`);
        }
    }
    const under = a.harvests.filter((h) => h.ratio < 0.5);
    if (a.injectTotal >= 3 && a.harvests.length >= 3 && under.length >= 1) {
        const worst = a.harvests.reduce((w, h) => (h.ratio < w.ratio ? h : w), a.harvests[0]!);
        out.push(`${under.length}/${a.harvests.length} recent nudges under-harvested (worst ${Math.round(worst.ratio * 100)}% at ${clock(worst.ts)}) — the model folded less than the offered pending; nudges are advisory, the kernel never forces a range`);
    }
    const r = a.lastReadiness;
    if (r && r.interval > 0) {
        const t2Thr = Math.round(1.5 * r.interval);
        if (r.t2 >= t2Thr) {
            out.push(`T2 distillation is mass-ready (summary pool ${fmtKtok(r.t2)} tok ≥ ${fmtKtok(t2Thr)}) — a block-merge reset can fire and drop the band sharply`);
        } else if (r.t2 > 0.5 * t2Thr) {
            out.push(`T2 distillation not ready: summary pool ${fmtKtok(r.t2)} tok < ${fmtKtok(t2Thr)} threshold — it refills slowly (each T1 fold contributes only its ~1-3K summary)`);
        }
    }
    return out.slice(0, 4);
}

/** Compact multi-line report (acp_status / web). null while too young. */
export function formatContextAnalysis(sessionId: string, now = Date.now()): string[] | null {
    const a = analyses.get(sessionId);
    if (!a || a.requests < 2) return null;
    const spanMs = a.lastSeen - a.firstSeen;
    const lines: string[] = [];
    if (a.init) {
        const top = a.init.perMessage[0];
        lines.push(
            `init: ${clock(a.init.ts)} — ${a.init.messageCount} msgs / ${fmtKiB(a.init.totalChars)} inbound ≈ ${fmtKtok(a.init.estTokens)} tok` +
                (top ? ` · largest: ${top.role}/${top.contentType}${top.toolName ? ` ${top.toolName}` : ""} ≈${fmtKtok(top.estTokens)} tok` : ""),
        );
    }
    const g = a.idleGates;
    const gateTotal = g.mass + g.growth + g.cadence + g.other;
    const gateStr = gateTotal > 0 ? ` · idle gates: mass ${g.mass}× / growth ${g.growth}× / cadence ${g.cadence}× / other ${g.other}×` : "";
    lines.push(`injects: ${a.injectTotal} in ${fmtHM(spanMs)}${gateStr}`);
    if (a.harvests.length > 0) {
        const under = a.harvests.filter((h) => h.ratio < 0.5).length;
        const sorted = [...a.harvests].sort((x, y) => x.ratio - y.ratio);
        const worst = sorted[0]!;
        const best = sorted[sorted.length - 1]!;
        lines.push(`harvest: ${a.harvests.length - under}/${a.harvests.length} nudges ≥50% of offered (range ${Math.round(worst.ratio * 100)}%–${Math.round(best.ratio * 100)}%)${under > 0 ? `, ${under} under-harvested` : ""}`);
    }
    if (a.compressCommits > 0) {
        lines.push(`compression: ${a.compressCommits} commit(s), ~${fmtKtok(a.compressedTotal)} tok total`);
    }
    for (const v of buildVerdict(a, now)) lines.push(`verdict: ${v}`);
    return lines;
}

/**
 * One nudge observation (called once per proxied request, every wire).
 * Returns a `[context-analysis]` digest line to log when this observation is
 * an INJECT (or every 60th idle gate) — null otherwise.
 */
export function recordNudgeObservation(
    sessionId: string,
    turn: NudgeObservationTurn,
    tokenCount: number,
    limit: number,
    willInject: boolean,
    decidePending = false,
    surfaceOff?: string,
): string | null {
    const now = Date.now();
    const a = touch(sessionId);
    a.requests++;
    a.lastSeen = now;
    if (!a.init && Array.isArray(turn.messages) && turn.messages.length > 0) {
        a.init = snapshotInit(turn.messages);
    }
    a.usage.push({ ts: now, tokenCount, limit });
    if (a.usage.length > USAGE_CAP) a.usage.splice(0, a.usage.length - USAGE_CAP);

    const n = turn.nudge;
    if (!n) return null;
    const b = n.breakdown ?? {};
    const interval = b["nudgeGrowthTokens"] ?? 0;
    const pendingT1 = b["pendingT1"] ?? 0;
    const pendingT2 = b["pendingT2"] ?? 0;
    const pendingT3 = b["pendingT3"] ?? 0;
    a.lastReadiness = { ts: now, t1: pendingT1, t2: pendingT2, t3: pendingT3, interval };

    // Same label rules as diagNudge (the log line) — kept local so the
    // formatter stays pure.
    const label = willInject
        ? decidePending
            ? `INJECT-PENDING T${n.tier ?? "?"}`
            : n.shouldInject
                ? `INJECT T${n.tier ?? "?"}`
                : `INJECT-ESC T${n.tier ?? "?"}`
        : n.shouldInject
            ? `ARMED-SUPPRESSED T${n.tier ?? "?"}`
            : "idle";
    const pct = limit > 0 ? Math.round((tokenCount / limit) * 100) : 0;

    if (willInject) {
        a.injectTotal++;
        a.injects.push({
            ts: now,
            label,
            tier: n.tier,
            usagePct: pct,
            tokenCount,
            limit,
            growth: b["growth"] ?? 0,
            floor: b["growthFloor"] ?? 0,
            interval,
            pendingT1,
            pendingT2,
            pendingT3,
        });
        if (a.injects.length > INJECTS_CAP) a.injects.splice(0, a.injects.length - INJECTS_CAP);
        const fmt = formatContextAnalysis(sessionId, now);
        return fmt ? `[context-analysis] ${sessionId} ${label} @${pct}% — ` + fmt.join(" · ") : null;
    }

    // Idle: which gate held? (reason-string classification against the kernel's
    // emitted forms: "< threshold", "< floor", ", blocked: Tn (cadence)")
    const reason = n.reason ?? "";
    if (/cadence/i.test(reason)) a.idleGates.cadence++;
    else if (/< threshold/i.test(reason)) a.idleGates.mass++;
    else if (/< floor/i.test(reason)) a.idleGates.growth++;
    else a.idleGates.other++;
    const gateTotal = a.idleGates.mass + a.idleGates.growth + a.idleGates.cadence + a.idleGates.other;
    if (gateTotal > 0 && gateTotal % 60 === 0) {
        const fmt = formatContextAnalysis(sessionId, now);
        return fmt ? `[context-analysis] ${sessionId} ${label} @${pct}% (${reason.slice(0, 80)}) — ` + fmt.join(" · ") : null;
    }
    return null;
}

/** A compress commit landed (success path only). Pairs with the recent INJECT. */
export function recordCompressCommit(sessionId: string, tokensCompressed: number, blocksCreated: number): void {
    const now = Date.now();
    const a = touch(sessionId);
    a.lastSeen = now;
    a.compressCommits++;
    a.compressedTotal += tokensCompressed;
    a.commits.push({ ts: now, tokens: tokensCompressed });
    if (a.commits.length > COMMITS_CAP) a.commits.splice(0, a.commits.length - COMMITS_CAP);
    if (blocksCreated <= 0 || tokensCompressed <= 0) return;
    // Pair with the newest still-unmatched INJECT inside the harvest window.
    for (let i = a.injects.length - 1; i >= 0; i--) {
        const ev = a.injects[i]!;
        if (ev.matched) continue;
        const age = now - ev.ts;
        if (age > HARVEST_WINDOW_MS) break; // injects are chronological — older ones are further out
        // Offered mass = what the injected tier asked the model to fold. A T2/T3
        // offer measured against the whole-session count read as under-harvested
        // even on full execution (#5963 review); fall back to it only when the
        // injected tier's own mass is absent.
        const tierMass = ev.tier === 2 ? ev.pendingT2 : ev.tier === 3 ? ev.pendingT3 : ev.pendingT1;
        const offered = tierMass > 0 ? tierMass : ev.tokenCount;
        ev.matched = true;
        a.harvests.push({ ts: now, offered, got: tokensCompressed, ratio: offered > 0 ? Math.min(2, tokensCompressed / offered) : 1 });
        if (a.harvests.length > HARVESTS_CAP) a.harvests.splice(0, a.harvests.length - HARVESTS_CAP);
        return;
    }
}

/** The web/session-detail view (plain JSON). */
export interface ContextAnalysisView {
    firstSeen: number;
    lastSeen: number;
    requests: number;
    init?: InitProfile;
    injectTotal: number;
    injects: NudgeEvent[];
    idleGates: ContextAnalysis["idleGates"];
    harvests: HarvestRecord[];
    compressCommits: number;
    compressedTotal: number;
    lastReadiness?: TierReadiness;
    verdict: string[];
    /** Pre-rendered report text (the acp_status section, one line per entry). */
    text: string;
}

export function contextAnalysisView(sessionId: string, now = Date.now()): ContextAnalysisView | null {
    const a = analyses.get(sessionId);
    if (!a || a.requests < 2) return null;
    const lines = formatContextAnalysis(sessionId, now);
    return {
        firstSeen: a.firstSeen,
        lastSeen: a.lastSeen,
        requests: a.requests,
        init: a.init,
        injectTotal: a.injectTotal,
        injects: a.injects.slice(-50),
        idleGates: a.idleGates,
        harvests: a.harvests.slice(-50),
        compressCommits: a.compressCommits,
        compressedTotal: a.compressedTotal,
        lastReadiness: a.lastReadiness,
        verdict: buildVerdict(a, now),
        text: (lines ?? []).join("\n"),
    };
}

/** Test-only: clear all tracked sessions. */
export function resetContextAnalysisForTest(): void {
    analyses.clear();
}
