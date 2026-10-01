/**
 * #1729: dsh native compaction-call guard.
 *
 * dsh's `dsh-compaction-basic` answers context pressure by replaying the whole
 * conversation prefix and appending a fixed summarization directive
 * (COMPACTION_INSTRUCTION, dsh-compaction-basic/lib/index.js) as the FINAL
 * user message, reusing the same session id so the provider's KV prefix cache
 * stays warm. In the desktop lane those calls ride bili under the main
 * conversation id — the second producer of #1729's deadlock — and when one
 * LANDS, dsh durably shadows the replayed surface range: the original
 * messages never ride a future request again, which destroys the proxy's
 * compression substrate (irreversible, unlike every cost of refusing).
 *
 * This guard identifies the call at the traffic level and refuses it locally:
 * never forwarded, kernel state untouched. Two-signal AND, per the
 * claudeSubagentSplit (#970) discipline — both signals must agree, and the
 * failure direction is "stop intercepting" (a reworded template degrades to
 * today's behavior; a normal turn can never match: multi-turn requests carry
 * far more messages than DSH_COMPACTION_MAX_MESSAGES):
 *   1. MARKER — the final user message STARTS with the versioned instruction
 *      prefix (machine-appended by the summarizer, never user-chosen);
 *   2. SHAPE — the whole request is ≤ DSH_COMPACTION_MAX_MESSAGES messages
 *      (replayed prefix collapsed + directive; observed live: 2 msgs at
 *      ~152K tokens in the #1729/#1727 logs).
 *
 * Deliberately unconditional (auto pressure, context-overflow recovery, and
 * manual /compact all send the same envelope — the traffic layer cannot tell
 * which trigger fired, and a landed checkpoint is equally destructive from
 * any of them). Not gated on the dsh plugin marker: a dsh host routed through
 * a global bili proxy without the plugin bundle must be covered too. Refusal
 * message text intentionally rides into dsh's own warn line
 * ("step compaction failed: <message>; continuing the turn").
 */

/** Stable opening sentence of dsh's COMPACTION_INSTRUCTION template
 * (verbatim from @deepseek-ai/dsh-compaction-basic, tracked per dsh release
 * like MAIN_SYSTEM_PREFIXES tracks Claude Code's system prompts, #970). */
export const DSH_COMPACTION_INSTRUCTION_PREFIX =
    "You are now acting as a compaction engine for this AI coding assistant";

/** The compaction call is a replayed prefix + directive: observed as 2
 * messages (~152K tokens) in the #1727 production logs. A normal turn —
 * including a user pasting the template into an existing conversation —
 * carries the full multi-message history and cannot fit under this bar. */
export const DSH_COMPACTION_MAX_MESSAGES = 4;

type Rec = Record<string, unknown>;

/** Concatenate a wire content field (string | parts array) into plain text. */
function textOfContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    let out = "";
    for (const part of content) {
        if (typeof part === "string") out += part;
        else if (part !== null && typeof part === "object" && typeof (part as Rec).text === "string") {
            out += (part as Rec).text;
        }
    }
    return out;
}

/** Text of the LAST role=user message for the messages-shaped protocols
 * (openai chat/completions, anthropic messages). Google's contents/parts
 * shape and the Responses input items are out of scope for v1 — dsh's
 * desktop lane speaks OpenAI-compatible chat. */
function lastUserMessageText(protocol: string, parsed: unknown): string | undefined {
    if (parsed === null || typeof parsed !== "object") return undefined;
    const messages = (parsed as Rec).messages;
    if (!Array.isArray(messages)) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m === null || typeof m !== "object") continue;
        if ((m as Rec).role !== "user") continue;
        return textOfContent((m as Rec).content);
    }
    return undefined;
}

/** Two-signal test: marker in the final user message AND a compact
 * message count. `messageCount` is the wire messages-array length the
 * caller already computed (server.ts inboundMsgs). */
export function isDshCompactionCall(protocol: string | null, parsed: unknown, messageCount: number | null): boolean {
    if (protocol !== "openai" && protocol !== "anthropic") return false;
    if (messageCount === null || messageCount > DSH_COMPACTION_MAX_MESSAGES) return false;
    const finalUser = lastUserMessageText(protocol, parsed);
    if (finalUser === undefined) return false;
    return finalUser.trimStart().startsWith(DSH_COMPACTION_INSTRUCTION_PREFIX);
}

export type Refusal = { status: number; body: unknown };

const REFUSAL_MESSAGE =
    `dsh native compaction call refused by billion-context: bili owns compression on this lane (#1729, cf. #1772/#1206). ` +
    `A landed dsh compaction checkpoint durably shadows the raw conversation history, which destroys the proxy's compression substrate. ` +
    `Disable dsh auto-compaction (bili preset 'standard-bili-auto-off') or remove the co-resident dsh compaction plugin.`;

/** Protocol-shaped refusal body (mirrors the #554 side-request guard shape so
 * clients render it natively). 403: a policy refusal, not a malformed
 * request — the caller's own retry logic must not treat it as transient. */
export function dshCompactionRefusal(protocol: string): Refusal {
    if (protocol === "anthropic") {
        return {
            status: 403,
            body: { type: "error", error: { type: "invalid_request_error", message: REFUSAL_MESSAGE } },
        };
    }
    return {
        status: 403,
        body: {
            error: {
                type: "server_error",
                code: "dsh_compaction_refused",
                message: REFUSAL_MESSAGE,
                retryable: false,
            },
        },
    };
}
