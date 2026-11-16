// Nudge-injection debug surface: a tiny in-process pub/sub carrying the nudge
// a prepare stage just injected as the ephemeral trailing user message (final
// wrapped wire text, post renderNudgeText + withFirstSightDrain/
// withSummaryBudgetNote/withMarkerIntegrityNote — the exact string on the
// wire, not the pre-wrapper template).
//
// Display contract: the nudge ITSELF goes to the model — that is the
// pre-existing nudge mechanism's job (the model must read it to call
// compress); this module adds nothing to model context. The pi lane mirrors
// the injection to the TERMINAL ONLY, gated on the debug switch
// (debugEnabled() — ACP_DEBUG > config `debug` > false): once the model has
// answered a request that carried a nudge, the verbatim wire text is shown
// as a transient terminal notification (pi.ui.notify), at most once per user
// turn (per-turn dedup, turnKey: emergency nudges re-inject on every LLM
// call of a turn). Nothing is written to the session file.
//
// Why a bus and not a log line: the nudge text IS the thing under debugging —
// "what did the model actually read this round" — and grepping a log file
// after the fact hides the placement (which turn, which arm).
//
// Process scope: the bus is a module-level singleton. It reaches the pi
// extension because BOTH live inside the same dist bundle + process in the pi
// lane's default INLINE mode (dist/agent/pi-native.js bundles pi.ts AND
// inline-engine.ts AND the prepare modules — tsup splitting:false). In
// spawn/attach mode the proxy is a separate process holding its own bundle
// copy: no listener ever fires there and the feature is inert (documented in
// docs/clients.md en+zh, Pi section).

type NudgeDebugKind = "advisory" | "directive" | "fallback";

export type NudgeDebugEvent = {
    /** bili session id the nudge armed under (not the host session id). */
    sessionId: string;
    /** Wire family that carried the nudge ("anthropic" | "openai"). */
    protocol: string;
    /** Which injection arm fired: legacy/over-limit advisory, model-decided
     *  directive (#2228), or decide-ladder fallback advisory. */
    kind: NudgeDebugKind;
    /** Nudge tier (1 = gentle, 2+ = distillation pressure); null when the
     *  nudge is not tier-based (legacy over-limit/emergency). */
    tier: number | null;
    /** Why the nudge armed (turn.nudge.reason). */
    reason: string;
    /** Context usage at decision time, whole percent. */
    pct: number;
    /** Emergency arm (breakdown.emergencyOverride) — record line marks it. */
    emergency: boolean;
    /** Largest compressible range by tokens (the record line's suggestion),
     *  or null when the nudge carried no ranges. */
    topRange: { startRef: string; endRef: string } | null;
    /** Identity of the user message this nudge belongs to (the LAST user
     *  message of the pre-nudge conversation). One record line per
     *  (session, turnKey) — emergency re-injections within a turn collapse. */
    turnKey: string;
    /** The FINAL wrapped wire text, verbatim (debug display only — shown
     *  transiently in the terminal, never persisted). */
    text: string;
    ts: number;
};

/** Minimal structural view of the kernel NudgeDecision the emit sites have
 *  in scope — keeps this module free of a kernel import. */
type NudgeDecisionView = {
    tier: number | null;
    reason: string;
    contextUsage: number;
    breakdown?: { emergencyOverride?: number } | null;
    compressibleRanges?: Array<{ startRef: string; endRef: string; tokens: number }> | null;
};

/** Fields shared by every emit site of a turn — computed once at the top of
 *  the injection block (see prepare-anthropic.ts / prepare-openai.ts). */
type NudgeDebugMeta = Pick<NudgeDebugEvent, "tier" | "reason" | "pct" | "emergency" | "topRange" | "turnKey">;

export function nudgeDebugMeta(nudge: NudgeDecisionView, preNudgeMessages: Array<{ role?: string; content?: unknown }>): NudgeDebugMeta {
    const top = [...(nudge.compressibleRanges ?? [])].sort((a, b) => b.tokens - a.tokens)[0] ?? null;
    return {
        tier: nudge.tier,
        reason: nudge.reason,
        pct: Math.round(nudge.contextUsage * 100),
        emergency: nudge.breakdown?.emergencyOverride === 1,
        topRange: top !== null ? { startRef: top.startRef, endRef: top.endRef } : null,
        turnKey: nudgeTurnKey(preNudgeMessages),
    };
}

/** Cheap identity key for the LAST user message with TEXT content (before
 *  the nudge append): length + djb2 of the first 512 chars. On the anthropic
 *  wire, tool results come back as role:"user" with tool_result blocks (no
 *  text) — they are skipped, so the key stays stable across a turn's tool
 *  loop and the per-turn record dedup collapses re-injections. A collision
 *  only ever costs one record line. */
export function nudgeTurnKey(messages: Array<{ role?: string; content?: unknown }>): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m === undefined || m.role !== "user") continue;
        const c = m.content;
        const text =
            typeof c === "string"
                ? c
                : Array.isArray(c)
                    ? c.map((p) => (typeof p === "string" ? p : (p as { text?: string } | null)?.text ?? "")).join("")
                    : "";
        if (text.length === 0) continue;
        return `${text.length}:${djb2(text.slice(0, 512))}`;
    }
    return "0:0";
}

function djb2(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return h;
}

type NudgeDebugListener = (event: NudgeDebugEvent) => void;

const listeners = new Set<NudgeDebugListener>();

/** Subscribe; returns an unsubscribe function. */
export function onNudgeInjected(listener: NudgeDebugListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Fire-and-forget emit. A throwing listener must never break the request
 *  pipeline — injection already happened on the wire when this fires. */
export function emitNudgeInjected(event: NudgeDebugEvent): void {
    for (const listener of [...listeners]) {
        try {
            listener(event);
        } catch {
            // debug surface only — swallow
        }
    }
}

/** Test seam: drop all listeners between cases. */
export function _resetNudgeDebugForTest(): void {
    listeners.clear();
}
