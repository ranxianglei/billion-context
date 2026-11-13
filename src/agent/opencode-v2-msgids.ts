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
// parity vs the POST-HOIST core count + canonical validation); client-side we
// core-align — skip the leading system/developer run the kernel hoists out of
// the fold space (see opencodeV2MsgIdList) — and keep the obvious poison
// classes out.

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

/** Extract the CORE-ALIGNED ordered host-id list from a V2 turn's message
 *  array, or undefined when ANY entry cannot be proven usable (whole-turn
 *  degrade).
 *
 *  #6525/#6539 core alignment: the V2 lane stamps turns on the `/responses`
 *  and `/messages` endpoints — the server pins against the POST-hoist core
 *  count of the wire the turn actually rides. Both hoist rules drop exactly
 *  the contiguous LEADING system/developer run:
 *   • responsesToCore: `sysDevHead` stays true until the first non-system/
 *     developer item (kernel/src/wire/responses.ts) — mid-history system/
 *     developer items are position-preserved sidecar cores (#4166), and the
 *     head-neutral opaque items (`additional_tools` / `mcp_list_tools`) do
 *     not clear the head flag. If opencode ever interleaves a head-neutral
 *     item inside the head run, this host-side skip cannot express that
 *     nuance and the counts diverge — SAFELY: the opaque item carries no
 *     msg_ id, so the whole turn degrades (no header) and the server never
 *     sees a miscounted list.
 *   • anthropicToCore: system is a separate top-level field (never inside
 *     messages), so the skip is a no-op there.
 *  If the header carried the leading system ids, its count would exceed the
 *  core count and the pin would be rejected (a safe content-derived degrade,
 *  but the session would never actually pin). A mid-conversation system
 *  message is NOT part of the leading run and keeps its id. */
export function opencodeV2MsgIdList(messages: readonly OpencodeV2MessageLike[] | null | undefined): string[] | undefined {
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    if (messages.length > MAX_IDS_PER_TURN) return undefined;
    // Skip the contiguous leading system/developer run (matches the kernel's
    // responsesToCore sysDevHead / anthropic separate-field rules) so the id
    // list aligns to the post-hoist core count.
    let start = 0;
    while (start < messages.length) {
        const m = messages[start];
        const role = m !== null && typeof m === "object" ? (m as { role?: unknown }).role : undefined;
        if (role === "system" || role === "developer") start += 1;
        else break;
    }
    const ids: string[] = [];
    for (let i = start; i < messages.length; i++) {
        const m = messages[i];
        const id = m !== null && typeof m === "object" ? (m as { id?: unknown }).id : undefined;
        if (typeof id !== "string" || !HOST_MSG_ID.test(id)) return undefined; // poison → no stamp
        ids.push(id);
    }
    if (ids.length === 0) return undefined; // only a leading system run → nothing to pin
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
