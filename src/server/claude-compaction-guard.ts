// #5767: Claude Code native-compaction landing detector (anthropic lane).
//
// Claude Code's auto-compact (CLAUDE_CODE_AUTO_COMPACT_WINDOW) rewrites the
// client's history in place: the shadowed region is replaced by ONE
// continuation user message that opens with the verbatim sentence below, and
// the next request replays [continuation summary, retained tail…] against the
// SAME session id. The #5767 ledger shows the landing shape — 19–24 incoming
// messages, 5–9 carrying pre-turn refs, of 415–2312 known — a region
// replacement the generic rewrite detector can see (the gap) but cannot
// attribute (no framing it knows), so it recorded "unannounced-rewrite" and
// lit the alarm banner for the client's own auto-compact. The dsh marker path
// (#2432/#2658) and the codex local-compaction path (#2373) already settle the
// same landing shape as handled "native-compaction"; this detector gives the
// claude lane the same treatment.
//
// Version-pinned like DSH_CHECKPOINT_PREAMBLE_PREFIX (#970): if Claude Code
// rewords the continuation sentence, detection degrades to a MISS — the
// pre-#5767 unannounced-rewrite archive path — never a false positive.
export const CLAUDE_COMPACTION_CONTINUATION_PREFIX =
    "This session is being continued from a previous conversation that ran out of context";

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

/** True when a freshly-LANDED Claude Code native-compaction continuation
 *  message is present in the resent history. Same three-gate discipline as
 *  carriesDshLocalCompactionSummary (#2621/#4438):
 *
 *   ① CARRIER — role="user" AND plain text (contentType "text" when typed).
 *      A tool_result riding a wire role:"user" message flattens to
 *      role="tool"/contentType="tool-result" (kernel anthropicToCore), so the
 *      role gate alone already drops it; the contentType gate is kept as
 *      belt-and-suspenders for any lane that maps a structured user block to
 *      a non-text contentType.
 *   ② NOVELTY — the message's raw id must NOT already be in the pre-turn ref
 *      map (`knownIds` = Object.keys(session.state.messageRefs.byRaw) taken
 *      BEFORE processTurn). A freshly-landed continuation is by definition a
 *      NEW message; a historical quote/replay hits an OLD id.
 *   ③ STANDALONE — the message must START with the continuation sentence; a
 *      quote embeds it inside other content. Consequence accepted per the
 *      version-pin doctrine (header): if Claude Code rewords the sentence,
 *      detection degrades to a miss — never a false positive wiping live fold
 *      state.
 *
 *  Reads the core-flattened text first (BiliMessage/CoreMessage carry prose in
 *  `.text`), falling back to a raw wire content field for direct callers. When
 *  `knownIds` is omitted the novelty gate is skipped (carrier gate only) —
 *  in-lane callers pass it. */
export function carriesClaudeNativeCompactionSummary(
    msgs: readonly { id?: unknown; role?: unknown; contentType?: unknown; text?: unknown; content?: unknown }[],
    knownIds?: ReadonlySet<string>,
): boolean {
    for (const m of msgs) {
        // ① CARRIER (#2621): only a user-role plain-text message can be a
        // continuation summary. Exclude every other producer of the sentence.
        if (m.role !== "user" || (m.contentType !== undefined && m.contentType !== "text")) continue;
        // ② NOVELTY (#2621): a freshly-landed continuation is a NEW id; a
        // quoted or replayed mention is an old id already in the pre-turn ref
        // map.
        if (knownIds !== undefined && typeof m.id === "string" && knownIds.has(m.id)) continue;
        const text = typeof m.text === "string" && m.text !== "" ? m.text : textOfContent(m.content);
        if (text === "") continue;
        // ③ STANDALONE (#4438): the sentence must open the message — see the
        // gate list above for why mid-text matching is a false-positive
        // machine on synthesized aux blobs that quote old summaries.
        const head = text.trimStart();
        if (head.startsWith(CLAUDE_COMPACTION_CONTINUATION_PREFIX)) return true;
    }
    return false;
}
