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
interface TurnOutcome {
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

// #2904: wire-native words for "cut off at the output limit" — openai "length",
// anthropic "max_tokens", google "MAX_TOKENS", responses "incomplete" /
// "max_output_tokens". Anchored + case-insensitive so no other reason
// ("stop_sequence", "content_filter", "tool_use") can match.
const MAX_OUTPUT_REASON_RE = /^(?:length|max_tokens|incomplete|max_output_tokens)$/i;
export function isMaxOutputReason(reason: string | undefined): boolean {
    return typeof reason === "string" && MAX_OUTPUT_REASON_RE.test(reason);
}

export function degenerateTurnWarning(o: TurnOutcome): string | null {
    const reason = o.reason ?? o.terminalReason;
    // A max-output truncation (reason differs from terminal but is a known
    // limit word) is ALSO degenerate when it left nothing visible: the budget
    // ran out inside reasoning before any prose/tool call reached the client.
    const maxOut = reason !== o.terminalReason && isMaxOutputReason(reason);
    if (reason !== o.terminalReason && !maxOut) return null;
    if (o.toolCalls > 0) return null;
    if (o.text.outputChars > 0) return null;
    const bits: string[] = [];
    if (o.sawThinking) bits.push("thinking present");
    if (o.text.dropped && o.text.inputChars > 0) bits.push(`${o.text.inputChars} chars of emitted text stripped as render-tag echo`);
    else bits.push("no visible text emitted");
    if (maxOut) {
        return (
            `[degenerate-turn] ${o.wire}: turn ended ${reason} (max-output) with zero visible text and zero tool calls (${bits.join("; ")}) ` +
            `— the output budget ran out before any prose/tool call reached the client; if this repeats, the outgoing max_tokens is pathologically small (see the output-budget restore log / #2904)`
        );
    }
    return (
        `[degenerate-turn] ${o.wire}: turn ended ${o.terminalReason} with zero visible text and zero tool calls (${bits.join("; ")}) ` +
        `— the agent receives an empty turn and may stall until nudged (#673)`
    );
}

// #2303: a terminal turn whose visible prose ENDS with a compression-draft
// closing tag (the summary / analysis close forms) and no tool call is non-
// converged even though it delivered text: the model wrote a handoff or
// compression draft as prose — describing the tool call it was about to make —
// instead of issuing it, most often after the upstream cut the final tool call
// out of the step (observed: 149 silent stops across 70 sessions, DSH native).
// The tag vocabulary is model-side learned convention (the kernel prompts
// contain no such tags), so the matcher is deliberately narrow: exactly the two
// closing tags seen in production, fully closed (truncated forms are a
// different defect class — #1755/#2190 — and stay out of scope), case-
// insensitive (#1731 case drift), trailing whitespace allowed.
const DRAFT_CLOSE_TAIL = /\x3c\/(?:summary|analysis)\x3e\s*$/i;
// #5175: the envelope form. When the model writes the WHOLE draft as prose the
// close above is not at the end of the text — `</analysis>` is followed by the
// `<summary>` BODY, tens of thousands of characters of it, so the `$` anchor can
// never match and the turn slipped through as an ordinary answer. The envelope
// signature is exactly the ordering the client's compaction contract describes
// ("an <analysis> block followed by a <summary> block"): an analysis close
// IMMEDIATELY followed by a summary open, whitespace between them. Corpus census
// (8225 fields, 462 sessions): 25 fields carry it, 5 carry the full open…close
// envelope, and only ONE — the already-handled tail form — ends with it. Nothing
// else in the corpus produces that adjacency, so it cannot false-positive on
// prose that merely mentions the words.
const DRAFT_ENVELOPE = /\x3c\/analysis\x3e\s*\x3csummary\x3e/i;
const SUMMARY_CLOSE = /\x3c\/summary\x3e/i;
export function endsWithDraftClose(text: string): boolean {
    return text.length > 0 && DRAFT_CLOSE_TAIL.test(text);
}
/** #5175: the draft-envelope shape — a handoff/compression draft written as
 *  prose in either of its two observable forms: the closing tag at the very end
 *  (#2303), or the analysis→summary envelope (#5175). Both mean the model
 *  narrated the action instead of issuing it, so both are non-converged.
 *
 *  The envelope counts only while the draft is UNFINISHED. A complete
 *  `</analysis><summary>…</summary>` followed by substantive prose delivered
 *  BOTH the draft and an answer — the turn converged, and re-issuing it appends
 *  a duplicate answer on the real chat pipe (measured: pristine master keeps a
 *  single answer, the unconditional envelope rule produced answer + retry
 *  answer). The reported dumps are always open-ended — the model stops inside
 *  the summary body (#5175) or right at the analysis close (#2303) — so recall
 *  is unchanged: the only hits this gives up are complete drafts that kept
 *  writing, which are exactly the false positives. */
export function isDraftDump(text: string): boolean {
    if (text.length === 0) return false;
    if (DRAFT_CLOSE_TAIL.test(text)) return true;
    const env = DRAFT_ENVELOPE.exec(text);
    if (env === null) return false;
    // Still inside the draft: the summary body is truncated mid-flight.
    return !SUMMARY_CLOSE.test(text.slice(env.index + env[0].length));
}

// #2612: the #2303 draft-tail shape has a legitimate producer — the CLIENT's
// own summarization request. Claude Code's compaction (/compact, auto-compact,
// precomputed compression) instructs the model, in the final user message, to
// answer with plain text only: "Wrap your summary in <summary></summary>
// tags" / "Do NOT call any tools. Respond with plain text only — an
// <analysis> block followed by a <summary> block." A compliant reply
// NECESSARILY ends with </summary> and carries no tool call, so the #2303
// verdict reads a correct answer as a stalled handoff draft: the retry
// re-asks, the retry also complies, and the #870 in-band error breaks the
// client's compaction entirely ("automatic compaction failed"). Detection
// matches the two distinctive instruction phrases verbatim (case-insensitive
// for #1731-style drift) rather than bare "<summary>" — the tag alone also
// appears in bili's own compress receipts riding the history, which must NOT
// suppress the retry for ordinary turns.
const CLIENT_SUMMARY_INSTRUCTION =
    /(?:Wrap your summary in \x3csummary\x3e\x3c\/summary\x3e tags|\x3canalysis\x3e block followed by a \x3csummary\x3e block)/i;
export function requestExpectsProseSummary(requestText: string | undefined): boolean {
    return typeof requestText === "string" && requestText.length > 0 && CLIENT_SUMMARY_INSTRUCTION.test(requestText);
}

/** #2612 proxy-lane twin: the last user message's text, where a client
 *  compaction instruction lives (Claude Code puts it in the final user turn).
 *  Undefined when there is no user message or it carries no text. */
export function lastUserSummaryInstruction(messages: ReadonlyArray<{ role: string; text?: string }>): string | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i]!;
        if (m.role === "user") return typeof m.text === "string" ? m.text : undefined;
    }
    return undefined;
}
