// #5825 host wiring (opencode V2): per-turn msgId extraction + stamp budget.
//
// OpenCode 2.x hands the plugin's `http.request` hook a structured turn:
// `event.messages` carries every outgoing history message WITH its host id
// (sst/opencode Message ids are `msg_` + monotonic ascending counter,
// schema/src/session-message.ts:21-25; never reused). This is the ONLY
// trustworthy V2 id seam: the request body itself is already serialized wire
// text with no ids in it. The extracted list is stamped onto the SAME
// request via `x-bili-msg-ids` — no state, no cross-event race, because the
// capture reads the very payload this turn sends.
//
// Whole-turn degrade contract (宁可降级不可错位): ids ride only when EVERY
// message in the list carries a usable host id. Any union variant declares
// `id` OPTIONAL (ai/src/schema/messages.ts:240-270), so one missing or
// foreign-shaped id poisons the whole turn → no header → the session rides
// exactly as before. The server re-proves everything anyway (exact count
// parity vs the wire body + canonical validation + role spot-checks);
// client-side we just keep the obvious poison classes out.

/** Hard ceiling on ids per turn — real sessions are hundreds of messages, not
 *  thousands of KB of header; beyond this the turn degrades. */
const MAX_IDS_PER_TURN = 4096;

/** Comma-joined budget; mirrors what the server-side parser enforces so an
 *  oversized list degrades here without ever riding (server would drop it). */
const STAMPED_HEADER_MAX_BYTES = 16 * 1024;

/** opencode host id shape: msg_ + base62 tail (V1 and V2 mint identically).
 *  Same charset restriction as the V1 twin (opencode-msgids.ts) keeps the
 *  comma separator unambiguous and control chars / the kernel's
 *  acp_summary_ namespace out. */
const HOST_MSG_ID = /^msg_[A-Za-z0-9]+$/;

type OpencodeV2MessageLike = { id?: unknown; role?: unknown } | null | undefined;

/** Extract the full ordered host-id list from a V2 turn's message array, or
 *  undefined when ANY entry cannot be proven usable (whole-turn degrade). */
export function opencodeV2MsgIdList(messages: readonly OpencodeV2MessageLike[] | null | undefined): string[] | undefined {
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    if (messages.length > MAX_IDS_PER_TURN) return undefined;
    const ids: string[] = [];
    for (const m of messages) {
        const id = m !== null && typeof m === "object" ? (m as { id?: unknown }).id : undefined;
        if (typeof id !== "string" || !HOST_MSG_ID.test(id)) return undefined; // poison → no stamp
        ids.push(id);
    }
    return ids;
}

/** The stamped header value for one turn, or undefined when the list is
 *  unusable or over the join budget. */
export function stampedMsgIdsHeaderFromMessages(
    messages: readonly OpencodeV2MessageLike[] | null | undefined,
): string | undefined {
    const ids = opencodeV2MsgIdList(messages);
    if (ids === undefined) return undefined;
    const joined = ids.join(",");
    if (Buffer.byteLength(joined, "utf8") > STAMPED_HEADER_MAX_BYTES) return undefined;
    return joined;
}
