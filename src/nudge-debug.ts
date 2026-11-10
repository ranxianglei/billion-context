// Nudge-injection debug surface: a tiny in-process pub/sub carrying the EXACT
// wire text a prepare stage just injected as the ephemeral trailing user
// message (post renderNudgeText + withFirstSightDrain/withSummaryBudgetNote/
// withMarkerIntegrityNote — the final string that goes on the wire, not the
// pre-wrapper template).
//
// Why a bus and not a log line: the nudge text IS the thing under debugging —
// "what did the model actually read this round" — and grepping a log file
// after the fact hides the placement (which turn, which arm). The pi lane
// subscribes (src/agent/pi.ts wireNudgeDebug) and mirrors each event into the
// host transcript as a CustomEntry via pi.appendEntry("bili-nudge", ...) —
// CustomEntry does NOT participate in LLM context (pi's buildSessionContext
// ignores type:"custom"), so the debug view is HUMAN-ONLY: the operator sees
// the verbatim nudge inline in pi, the model never does, and nothing is added
// to any re-sent history. Gated by the existing debug switch
// (debugEnabled(), src/knobs.ts — ACP_DEBUG > config `debug` > false) on the
// consumer side; emitters always fire — a listener-less emit is a no-op, so
// the prepare sites stay config-plumbing-free.
//
// Process scope: the bus is a module-level singleton. It reaches the pi
// extension because BOTH live inside the same dist bundle + process in the pi
// lane's default INLINE mode (dist/agent/pi-native.js bundles pi.ts AND
// inline-engine.ts AND these prepare modules — tsup splitting:false). In
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
    /** The FINAL wrapped wire text, verbatim. */
    text: string;
    ts: number;
};

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
