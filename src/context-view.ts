// #3862: structured context view for programmatic consumers (the dsh client
// Context tab). bili folds happen OUTSIDE the dsh event stream, so host-side
// stat plugins anchored on it show the PRE-compression caliber forever
// (dsh-context#173); bili knows the exact post-fold bytes and publishes them
// here as a machine-readable twin of the /acp panel. Two load-bearing
// invariants: (1) every figure is the kernel countTokens estimate of the
// CURRENT sent view except `anchor`, which is the usage-grade reading (#2117
// displayContextBest ladder) on its OWN scale — never mix the two in
// arithmetic; (2) the category math mirrors kernel buildStatusPanel
// one-to-one (sentTotal = classified + host system+tools), so segments sum
// to sentTotal and the view can never drift from the panel text. Events ride
// buildSessionCacheReport — the same ledger semantics the Web UI renders.

import type { NudgeDecision } from "acp-kernel";
import { buildSessionCacheReport, type ModelSwitchEvent } from "./cache-ledger.js";
import { displayContextBest, type Session } from "./session.js";

/** Max events per trail published in the view (newest first). */
const EVENT_CAP = 20;

interface ContextViewCategory {
    /** sysprompt | tool | text | code | summaries | system */
    key: string;
    tokens: number;
    /** percent of sentTotal (rounded; segments may not sum to exactly 100). */
    pct: number;
}

interface ContextViewFold {
    seq: number;
    at: number;
    /** S: original tokens folded out of the sent view. */
    s: number;
    /** sigma: summary tokens that stayed in the window. */
    sigma: number;
    /** S − sigma clamped at 0 — the pure token removal this fold achieved. */
    reclaimed: number;
    /** (S−σ) × requestsAfter — tokens not billed because of this fold so far. */
    savedSoFar: number;
    paidBack: boolean | null;
}

interface ContextViewSwitch {
    dim: "model" | "key" | "prompt" | "restart";
    at: number;
    from: string | null;
    to: string;
    /** ttlRepay tokens attributed to this event by the ledger partition. */
    attributed: number;
}

interface ContextViewAnchor {
    tokens: number;
    kind: "usage" | "estimate" | "upper";
    at: number | null;
}

interface ContextView {
    /** Every token figure in this object is on ONE scale: the kernel
     *  countTokens estimate of the current sent view. The anchor is the
     *  exception — its own usage-grade scale, labeled via kind. */
    scale: "estimate";
    /** wall-clock of this computation (epoch ms). */
    at: number;
    limit: number | null;
    sentTotal: number;
    /** growth since the last nudge reference (0 when none recorded). */
    growth: number;
    categories: ContextViewCategory[];
    anchor: ContextViewAnchor | null;
    folds: ContextViewFold[];
    switches: ContextViewSwitch[];
}

interface BuildInput {
    nudge: NudgeDecision | undefined;
    /** Host-measured system+tools overhead (prepare-time, same source as the
     *  panel's SysPrompt row). */
    systemPromptTokens: number;
    limit: number;
    session: Session;
}

/** null when no breakdown exists yet (no messages processed this process) —
 *  consumers then show their waiting state instead of a zero card. */
export function buildContextView(input: BuildInput): ContextView | null {
    const bd = input.nudge?.contextBreakdown;
    if (bd === undefined) return null;
    // Same classification as kernel/src/panel/panel.ts buildStatusPanel.
    const classified = bd.system + bd.tool + bd.summaries + bd.code + bd.text;
    const sentTotal = classified + input.systemPromptTokens;
    const pctOf = (v: number): number => (sentTotal > 0 ? Math.round((v / sentTotal) * 100) : 0);
    const rows: Array<[string, number]> = [
        ["sysprompt", input.systemPromptTokens],
        ["tool", bd.tool],
        ["text", bd.text],
        ["code", bd.code],
        ["summaries", bd.summaries],
        ["system", bd.system],
    ];
    const categories: ContextViewCategory[] = [];
    for (const [key, tokens] of rows) {
        if (tokens <= 0) continue;
        categories.push({ key, tokens, pct: pctOf(tokens) });
    }
    const folds: ContextViewFold[] = [];
    const switches: ContextViewSwitch[] = [];
    try {
        const report = buildSessionCacheReport(input.session);
        for (const f of [...report.folds].reverse().slice(0, EVENT_CAP)) {
            folds.push({
                seq: f.seq,
                at: f.at,
                s: f.S,
                sigma: f.sigma,
                reclaimed: Math.max(0, f.S - f.sigma),
                savedSoFar: f.savedSoFar,
                paidBack: f.paidBack,
            });
        }
        const evs: ContextViewSwitch[] = [];
        const take = (dim: ContextViewSwitch["dim"], events: readonly ModelSwitchEvent[]): void => {
            for (const e of events) evs.push({ dim, at: e.at, from: e.from, to: e.to, attributed: e.attributed });
        };
        take("model", report.modelSwitches.events);
        take("key", report.keySwitches.events);
        take("prompt", report.promptSwitches.events);
        take("restart", report.restartDrops.events);
        evs.sort((a, b) => b.at - a.at);
        for (const e of evs.slice(0, EVENT_CAP)) switches.push(e);
    } catch {
        // Ledger/report unavailable (corrupt metadata, partial restore) — the
        // view still serves its primary job (current composition); trails stay
        // empty rather than failing the whole status read.
    }
    const best = displayContextBest(input.session);
    return {
        scale: "estimate",
        at: Date.now(),
        limit: Number.isFinite(input.limit) && input.limit > 0 ? input.limit : null,
        sentTotal,
        growth: bd.growth,
        categories,
        anchor: best !== null ? { tokens: best.tokens, kind: best.kind, at: best.at ?? null } : null,
        folds,
        switches,
    };
}
