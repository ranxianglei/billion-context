// #4491 host wiring (opencode): client msgIds for incremental-lane turns.
//
// opencode 1.x fires `experimental.chat.messages.transform` per LLM request
// with `{ info, parts }[]` — info.id is the host message id (msg_ + 12 hex +
// 14 base62; zero reuse observed across 378K messages, and a
// streaming-settled message re-fires under the SAME id with grown content —
// edit semantics the server-side history reconciles, so the host side only
// ever stores the LATEST fire per session). That hook is the ONLY opencode
// seam carrying host ids: the V2 `http.request` interception sees the final
// wire body and nothing else, so V2-shaped turns never carry msgIds — they
// degrade to the lane's content-derived identities by design (#4491 host
// wiring audit; opencode is the weakest of the four host seams).
//
// Alignment is proof, not guesswork (宁可降级不可错位): ids ride only when
// every harvested message provably lowers 1:1 onto the wire — text-only
// parts, role user|assistant, and the derived text sequence exactly equal to
// the observed wire messages (cache_control and other block props ignored).
// Any deviation — tool/reasoning/file parts, ignored or synthetic text, a
// missing or foreign-shaped id, a content drift, duplicate ids — drops the
// whole field and the turn rides exactly as before. Order-preserving lowering
// plus per-position equality is what makes the positional pairing safe; a
// compensating merge+split that still byte-matches every position can only
// swap ids between byte-identical content, which the ledger joins as one.

interface HarvestedEntry {
    /** Host message id; "" when unusable (missing/foreign-shaped) — poisons
     *  alignment for any list containing it, never the lane itself. */
    id: string;
    /** Derivable wire shape ({role, ordered text-part texts}), or null when
     *  this message cannot be proven to lower 1:1 onto one wire message. */
    shape: { role: "user" | "assistant"; texts: string[] } | null;
}

const MAX_SESSIONS = 256;
const harvests = new Map<string, { at: number; entries: HarvestedEntry[] }>();

/** opencode host ids: msg_ + base62 tail (#4491 audit shape). Restricting to
 *  this charset keeps every server-poison class out client-side (whitespace
 *  and control characters, the kernel's acp_summary_ namespace, empty ids). */
const HOST_MSG_ID = /^msg_[A-Za-z0-9]+$/;

function deriveEntry(raw: unknown): HarvestedEntry {
    const holder = raw as { info?: unknown; parts?: unknown } | null | undefined;
    const info = holder !== null && typeof holder === "object" ? holder.info : undefined;
    const parts = holder !== null && typeof holder === "object" ? holder.parts : undefined;
    const infoObj = info !== null && typeof info === "object" ? (info as { id?: unknown; role?: unknown }) : undefined;
    const id = typeof infoObj?.id === "string" && HOST_MSG_ID.test(infoObj.id) ? infoObj.id : "";
    if (infoObj?.role !== "user" && infoObj?.role !== "assistant") return { id, shape: null };
    if (!Array.isArray(parts)) return { id, shape: null };
    const texts: string[] = [];
    for (const part of parts) {
        const p = part !== null && typeof part === "object" ? (part as { type?: unknown; text?: unknown; ignored?: unknown; synthetic?: unknown }) : undefined;
        // ignored text never reaches the model (host-render notices) and
        // synthetic text has no proven lowering — both stay underivable.
        if (p === undefined || p.type !== "text" || p.ignored === true || p.synthetic === true || typeof p.text !== "string") return { id, shape: null };
        texts.push(p.text);
    }
    return { id, shape: { role: infoObj.role, texts } };
}

/** Record the latest messages.transform fire for one session (V1 hook). The
 *  host's outgoing messages are left untouched — harvesting never mutates. */
export function harvestOpencodeMsgIds(sid: string | undefined, messages: unknown): void {
    if (typeof sid !== "string" || sid.length === 0 || !Array.isArray(messages)) return;
    if (!harvests.has(sid) && harvests.size >= MAX_SESSIONS) {
        let oldestKey: string | undefined;
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [key, entry] of harvests) {
            if (entry.at < oldestAt) { oldestAt = entry.at; oldestKey = key; }
        }
        if (oldestKey !== undefined) harvests.delete(oldestKey);
    }
    harvests.set(sid, { at: Date.now(), entries: messages.map(deriveEntry) });
}

/** Wire text sequence of one wire message: string content → [text]; block
 *  array → text blocks' text in order (cache_control et al. ignored). Any
 *  non-text block (tool_use, tool_result, image, thinking…) → null. */
function wireTexts(content: unknown): string[] | null {
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return null;
    const texts: string[] = [];
    for (const block of content) {
        const b = block !== null && typeof block === "object" ? (block as { type?: unknown; text?: unknown }) : undefined;
        if (b === undefined || b.type !== "text" || typeof b.text !== "string") return null;
        texts.push(b.text);
    }
    return texts;
}

/** Client ids for the FULL wire message list of one planned turn, or
 *  undefined when alignment cannot be proven (no harvest for the session,
 *  count mismatch, underivable/divergent entries, duplicate ids). The
 *  planner slices the result in lockstep with the delta messages. */
export function alignedMsgIdsForWire(sid: string, wire: unknown): string[] | undefined {
    const stored = harvests.get(sid);
    if (stored === undefined || !Array.isArray(wire) || stored.entries.length !== wire.length) return undefined;
    const ids: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < wire.length; i++) {
        const entry = stored.entries[i];
        if (entry.id === "" || entry.shape === null) return undefined;
        const msg = wire[i] as { role?: unknown; content?: unknown } | null | undefined;
        if (msg === null || typeof msg !== "object" || msg.role !== entry.shape.role) return undefined;
        const texts = wireTexts(msg.content);
        if (texts === null || texts.length !== entry.shape.texts.length) return undefined;
        for (let j = 0; j < texts.length; j++) {
            if (texts[j] !== entry.shape.texts[j]) return undefined;
        }
        if (seen.has(entry.id)) return undefined;
        seen.add(entry.id);
        ids.push(entry.id);
    }
    return ids;
}

/** Test hook: drop all harvested sessions (module state across suites). */
export function __resetOpencodeMsgIdsForTests(): void {
    harvests.clear();
}
