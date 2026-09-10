import type { TagEchoFilterStats } from "./loop/tag-echo-filter.js";

// #673: detection of degenerate terminal turns — upstream finishes normally
// (end_turn / stop / completed) but the client receives zero visible text and
// zero tool calls. Observed cause: the turn's only text was a render-tag echo
// the stripper missed (typo'd tag name), so the agent receives an empty turn
// mid-orchestration and stalls until manually nudged. The condition is
// deliberately recall-first: a legitimately empty text-only terminal turn is
// rare and equally confusing to an agentic client, so it warns too. Callers
// gate on their wire's own state (reason seen, tool calls emitted, thinking
// presence) and feed the filter's lifetime text accounting.
export interface TurnOutcome {
    /** Wire-native reason observed (stop_reason / finish_reason / status), if any. */
    reason: string | undefined;
    /** The wire's normal-completion reason ("end_turn" / "stop" / "completed"). */
    terminalReason: string;
    toolCalls: number;
    /** Lifetime visible-text accounting (summed across text fields/blocks). */
    text: TagEchoFilterStats;
    sawThinking: boolean;
    /** Wire label for logs, e.g. "anthropic" or "plugin-passthrough-openai". */
    wire: string;
}

export function degenerateTurnWarning(o: TurnOutcome): string | null {
    if ((o.reason ?? o.terminalReason) !== o.terminalReason) return null;
    if (o.toolCalls > 0) return null;
    if (o.text.outputChars > 0) return null;
    const bits: string[] = [];
    if (o.sawThinking) bits.push("thinking present");
    if (o.text.dropped && o.text.inputChars > 0) bits.push(`${o.text.inputChars} chars of emitted text stripped as render-tag echo`);
    else bits.push("no visible text emitted");
    return (
        `[degenerate-turn] ${o.wire}: turn ended ${o.terminalReason} with zero visible text and zero tool calls (${bits.join("; ")}) ` +
        `— the agent receives an empty turn and may stall until nudged (#673)`
    );
}
