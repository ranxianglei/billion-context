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
 * never forwarded, kernel state untouched. MARKER-DECISIVE (#2193): the final
 * user message STARTS with the versioned instruction prefix (machine-appended
 * by the summarizer, never user-chosen in practice) and that is sufficient on
 * its own. The original two-signal AND carried a SHAPE bar (≤4 messages,
 * pinned to rc.1-era observations — 2 msgs at ~152K tokens in the #1727/#1729
 * logs); dsh-compaction-basic 0.2.0-rc.2 changed the summarize call to replay
 * the ENTIRE shadowed region as the message prefix (~1100+ messages), which
 * made SHAPE permanently false and the whole guard silently pass through — a
 * landed checkpoint then durably shadowed the raw history of a live session
 * (#2193). The failure direction of an extra shape signal is exactly what
 * hurt: silent pass of an irreversible call. The cost asymmetry decides: one
 * pass-through = permanent substrate loss, one refusal = dsh falls back to
 * bili-owned compression (auto pressure, overflow recovery, and manual /compact
 * all send the same envelope and all recover). A fully reworded template
 * degrades to a miss (today's pre-#1729 behavior) — inherent to text matching;
 * the tracked sentence is refreshed per dsh release like MAIN_SYSTEM_PREFIXES
 * tracks Claude Code's system prompts (#970).
 *
 * PROTOCOL COVERAGE (#2360): the whitelist used to read openai/anthropic ONLY.
 * dsh's desktop lane speaks Responses (/v1/responses, /responses/compact), so
 * every compaction call on that wire hit the protocol check and returned
 * false BEFORE the marker was ever examined — the second AND-condition
 * failure after #2193's SHAPE fix (marker-decisive but protocol-blind, and
 * the pass-through stayed completely silent: no warn, no refusal, the exact
 * failure direction #2193 eliminated). All three lanes are now marker-
 * decisive with the same final-user-message rule; each wire contributes its
 * last role=user text (messages[] for openai/anthropic, input[] for
 * responses). Google's contents/parts shape stays out of scope — dsh speaks
 * no Google wire.
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

/** rc.1-era envelope size of the compaction call (replayed prefix collapsed +
 * directive; observed as 2 msgs at ~152K tokens in the #1727/#1729 logs).
 * Retained ONLY to flag shape drift in the refusal warn when a newer dsh
 * release replays the full shadowed region (~1100+ msgs, #2193) — NEVER used
 * for gating: that bar made the guard permanently blind on rc.2 while its
 * pass-through stayed silent. */
export const DSH_COMPACTION_SHAPE_MSGS = 4;

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
 * shape stays out of scope — dsh speaks no Google wire. */
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

/** Text of the LAST role=user item on the Responses wire (parsed.input).
 * Items are typed objects ({type:"message", role, content: string | parts[]});
 * function_call / function_call_output / reasoning items never carry user
 * prose, so a role check plus the type guard is enough (#2360). */
function lastResponsesInputUserText(parsed: unknown): string | undefined {
    if (parsed === null || typeof parsed !== "object") return undefined;
    const input = (parsed as Rec).input;
    if (!Array.isArray(input)) return undefined;
    for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i];
        if (item === null || typeof item !== "object") continue;
        const rec = item as Rec;
        if (rec.role !== "user") continue;
        if (rec.type !== undefined && rec.type !== "message") continue;
        return textOfContent(rec.content);
    }
    return undefined;
}

/** Marker-decisive test (#2193): the final user message starts with the
 * versioned instruction prefix. Message count plays NO part — rc.2 replays
 * the full shadowed region (~1100+ msgs) and the old ≤4 bar made the guard
 * permanently blind while its pass-through stayed silent. Protocol coverage
 * (#2360): openai + anthropic read messages[], responses reads input[] — the
 * pre-#2360 whitelist returned false for the responses lane before the marker
 * was ever examined. */
export function isDshCompactionCall(protocol: string | null, parsed: unknown): boolean {
    let finalUser: string | undefined;
    if (protocol === "responses") finalUser = lastResponsesInputUserText(parsed);
    else if (protocol === "openai" || protocol === "anthropic") finalUser = lastUserMessageText(protocol, parsed);
    if (finalUser === undefined) return false;
    return finalUser.trimStart().startsWith(DSH_COMPACTION_INSTRUCTION_PREFIX);
}

// #2432: dsh compaction-basic's CHECKPOINT FRAMING — the single replacement
// user message a LANDED compaction writes into the client's history
// (CHECKPOINT_PREAMBLE + SUMMARY_OPEN_TAG … SUMMARY_CLOSE_TAG,
// @deepseek-ai/dsh-compaction-basic 0.2.x lib/index.js). Version-pinned like
// DSH_COMPACTION_INSTRUCTION_PREFIX (#970): if these bytes drift the detector
// silently stops matching and degrades to the pre-#2432 unannounced-rewrite
// archive path — never a false positive. Angle brackets hex-escaped per KDD #2.
export const DSH_CHECKPOINT_OPEN_TAG = "\x3ccompacted-summary\x3e";
export const DSH_CHECKPOINT_PREAMBLE_PREFIX =
    "This is an automatically generated checkpoint condensing an earlier span of the conversation";

// #2432: floor on decimated fold coverage for local-compaction detection — the
// same bar as codex's CODEX_LOCAL_COMPACTION_MIN_MISSING (#2373): below it,
// missing ids are ordinary drift (edit/truncate), not a region replacement.
export const DSH_LOCAL_COMPACTION_MIN_MISSING = 8;

/** True when a resent core message carries dsh checkpoint framing (preamble
 *  at message start, or the open tag anywhere — the tag sits mid-message after
 *  preamble + blank line). Used by the prepare-openai detector (#2432) to tell
 *  a landed native compaction apart from ordinary history churn. Reads the
 *  core-flattened text first (BiliMessage/CoreMessage carry prose in `.text`),
 *  falling back to a raw wire content field for direct callers.
 *
 *  #2621 producer gate: a LANDED checkpoint is dsh-compaction-basic replacing
 *  exactly one user/message with plain text, so only a role=user TEXT message
 *  can carry real framing. Quotes from every other producer — assistant prose,
 *  reasoning, tool results, tool-call arguments, bili's own compress summaries
 *  echoed back in resent history — must NOT fire the detector: with the old
 *  any-message scan, "history mentions the tag" + "ordinary fold drift" was
 *  enough to rebase ACP state with no host compaction in sight, and the
 *  longest sessions (lowest kept ratio) were the most exposed. The
 *  contentType check is load-bearing on its own: anthropic-lane tool results
 *  flatten to role=user with contentType "tool-result". A role-less or
 *  non-user caller shape now reads false — the safe degradation direction
 *  this file pins everywhere (a miss rides the #2432 unannounced-rewrite
 *  archive path; a false positive resets live fold state). */
export function carriesDshLocalCompactionSummary(msgs: readonly { text?: unknown; content?: unknown; role?: unknown; contentType?: unknown }[]): boolean {
    for (const m of msgs) {
        if (m.role !== "user") continue;
        if (m.contentType !== undefined && m.contentType !== "text") continue;
        const text = typeof m.text === "string" && m.text !== "" ? m.text : textOfContent(m.content);
        if (text === "") continue;
        if (text.includes(DSH_CHECKPOINT_OPEN_TAG) || text.startsWith(DSH_CHECKPOINT_PREAMBLE_PREFIX)) return true;
    }
    return false;
}

export type Refusal = { status: number; body: unknown };

const REFUSAL_MESSAGE =
    `dsh native compaction call refused by billion-context: bili owns compression on this lane (#1729, cf. #1772/#1206). ` +
    `A landed dsh compaction checkpoint durably shadows the raw conversation history, which destroys the proxy's compression substrate. ` +
    `To run dsh native compaction on this lane anyway, opt in explicitly: "allowDshCompaction": true in the bili config (web UI) or env BILI_ALLOW_DSH_COMPACTION=1 (#2028).`;

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
