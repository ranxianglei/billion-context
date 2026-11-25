// #4491 host wiring (opencode): client msgIds for incremental-lane turns.
//
// Two opencode host seams carry the host's own message ids (msg_ + base62
// tail, zero reuse observed across 378K messages; a streaming-settled
// message re-fires under the SAME id with grown content — edit semantics
// the server-side history reconciles, so each harvester only ever stores
// the LATEST fire per session):
//   • V1 (`opencode` ≤1.x): `experimental.chat.messages.transform` fires
//     per LLM request with `{ info, parts }[]`.
//   • V2 (`opencode` ≥2.0): `ctx.session.hook("context")` fires right
//     before every provider request assembly with the full conversation
//     list `{ id, role, content }[]` (roles user/assistant/tool) plus
//     sessionID — verified live on 2.0.4, anthropic AND openai-compatible
//     providers alike. (The V2 `http.request` seam itself sees only the
//     final wire body; ids reach the planner through this harvest.)
//
// Alignment is proof, not guesswork (宁可降级不可错位): ids ride only when
// every harvested message provably lowers onto the wire 1:1 — same role
// (host `tool` normalizes to wire `user`) and an exactly-equal ordered
// token sequence, where each token fingerprints one semantic part:
//   t␀<text>            text blocks (byte-compared, cache_control ignored)
//   c␀<id>␀<name>       assistant tool call ↔ wire tool_use (anchored by the
//                      provider-unique tool-use id, not input bytes — the
//                      id IS the identity; input lowering fidelity varies)
//   r␀<id>␀<err>        tool result ↔ wire tool_result (same anchor)
//   o:r                 reasoning part ↔ thinking/redacted_thinking block
//   o:m                 media part ↔ image/document block
// Host bookkeeping parts that never reach the wire (step markers,
// snapshots, patches) are skipped on the host side; ANY other unrecognized
// part type, a missing or foreign-shaped id, a count/role/token mismatch,
// or duplicate ids drops the WHOLE field and the turn rides exactly as
// before (content-derived identities). Order-preserving lowering plus
// per-position equality makes the positional pairing safe; a compensating
// merge+split that still byte-matches every position can only swap ids
// between identical-fingerprint content, which the ledger joins as one.

interface HarvestedEntry {
    /** Host message id; "" when unusable (missing/foreign-shaped) — poisons
     *  alignment for any list containing it, never the lane itself. */
    id: string;
    /** Derivable wire shape ({role, ordered part tokens}), or null when
     *  this message cannot be proven to lower 1:1 onto one wire message. */
    shape: { role: "user" | "assistant"; toks: string[] } | null;
}

const MAX_SESSIONS = 256;
const harvests = new Map<string, { at: number; entries: HarvestedEntry[] }>();

/** opencode host ids: msg_ + base62 tail (#4491 audit shape). Restricting to
 *  this charset keeps every server-poison class out client-side (whitespace
 *  and control characters, the kernel's acp_summary_ namespace, empty ids). */
const HOST_MSG_ID = /^msg_[A-Za-z0-9]+$/;

/** Host bookkeeping parts that produce no wire block — present in the host
 *  store (and in these events) but rendered client-side only. */
const NOISE_PART_TYPES = new Set(["step-start", "step-finish", "snapshot", "patch"]);

const T = "\u0000"; // token separator — cannot appear in well-formed JSON text

function str(v: unknown): string | undefined {
    return typeof v === "string" ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** Tokenize ONE host part (V1 `{ parts }` and V2 `{ content }` share the
 *  relevant fields). Returns the token, `false` for known-noise parts, or
 *  `null` when the part type cannot be proven to lower onto the wire. */
function hostPartToken(part: unknown, hostRole: string): string | false | null {
    const p = obj(part);
    if (p === undefined) return null;
    const type = str(p.type);
    switch (type) {
        case "text": {
            if (p.ignored === true || p.synthetic === true) return null; // never reaches the model
            const text = str(p.text);
            return text === undefined ? null : `t${T}${text}`;
        }
        case "reasoning":
            return "o:r";
        case "file":
        case "image":
            return "o:m";
        // V2 ai-sdk style tool parts.
        case "tool-call": {
            const id = str(p.id);
            const name = str(p.name);
            if (id === undefined || name === undefined) return null;
            return `c${T}${id}${T}${name}`;
        }
        case "tool-result": {
            const id = str(p.id);
            if (id === undefined) return null;
            const result = obj(p.result);
            const isErr = result?.type === "error";
            return `r${T}${id}${T}${isErr ? "1" : "0"}`;
        }
        // V1 legacy tool part: lives on the assistant (call) or user/tool
        // (settled result) side — anchored by callID either way.
        case "tool": {
            const id = str(p.callID) ?? str(p.id);
            if (id === undefined) return null;
            if (hostRole === "assistant") {
                const name = str(p.tool) ?? "";
                return `c${T}${id}${T}${name}`;
            }
            const state = obj(p.state);
            const isErr = state?.status === "error";
            return `r${T}${id}${T}${isErr ? "1" : "0"}`;
        }
        default:
            return type !== undefined && NOISE_PART_TYPES.has(type) ? false : null;
    }
}

/** Normalize one harvested host message (either seam's element shape) to
 *  { id, shape }. Never throws — unparseable elements poison their own
 *  session's alignment only. */
export function deriveOpencodeEntry(raw: unknown): HarvestedEntry {
    const holder = obj(raw);
    // V1: { info: { id, role }, parts: [...] }; V2 context: { id, role, content: [...] }.
    const info = holder === undefined ? undefined : obj(holder.info);
    const idSrc = holder === undefined ? undefined : str(holder.id) ?? str(info?.id);
    const id = idSrc !== undefined && HOST_MSG_ID.test(idSrc) ? idSrc : "";
    const roleRaw = info?.role ?? holder?.role;
    const parts = holder?.parts ?? holder?.content;
    if (!Array.isArray(parts)) return { id, shape: null };
    // Host `tool` messages lower onto wire `user` tool_result blocks.
    const normRole = roleRaw === "user" || roleRaw === "assistant" ? roleRaw : roleRaw === "tool" ? "user" : undefined;
    if (normRole === undefined) return { id, shape: null };
    const toks: string[] = [];
    for (const part of parts) {
        const tok = hostPartToken(part, String(roleRaw));
        if (tok === null) return { id, shape: null };
        if (tok !== false) toks.push(tok);
    }
    return { id, shape: { role: normRole, toks } };
}

/** Record the latest id-bearing fire for one session (V1 messages.transform
 *  or V2 "context"). The host's outgoing messages are left untouched —
 *  harvesting never mutates. */
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
    harvests.set(sid, { at: Date.now(), entries: messages.map(deriveOpencodeEntry) });
}

/** Token for one ANTHROPIC-WIRE content block, or null when the block type
 *  cannot be matched against a host part. */
function wireBlockToken(block: unknown): string | null {
    const b = obj(block);
    if (b === undefined) return null;
    switch (b.type) {
        case "text": {
            const text = str(b.text);
            return text === undefined ? null : `t${T}${text}`;
        }
        case "tool_use": {
            const id = str(b.id);
            const name = str(b.name);
            return id === undefined || name === undefined ? null : `c${T}${id}${T}${name}`;
        }
        case "tool_result": {
            const id = str(b.tool_use_id);
            return id === undefined ? null : `r${T}${id}${T}${b.is_error === true ? "1" : "0"}`;
        }
        case "thinking":
        case "redacted_thinking":
            return "o:r";
        case "image":
        case "document":
            return "o:m";
        default:
            // server_tool_use / tool_reference / anything newer: no proven
            // host counterpart — degrade this turn rather than misalign.
            return null;
    }
}

/** Token sequence of one ANTHROPIC-WIRE message, or null on any unmatchable
 *  block. */
function wireContentToks(content: unknown): string[] | null {
    if (typeof content === "string") return [`t${T}${content}`];
    if (!Array.isArray(content)) return null;
    const toks: string[] = [];
    for (const block of content) {
        const tok = wireBlockToken(block);
        if (tok === null) return null;
        toks.push(tok);
    }
    return toks;
}

/** Client ids for the FULL wire message list of one planned turn, or
 *  undefined when alignment cannot be proven (no harvest for the session,
 *  count mismatch, unalignable/divergent entries, duplicate ids). The
 *  planner slices the result in lockstep with the delta messages. */
export function alignedMsgIdsForWire(sid: string, wire: unknown): string[] | undefined {
    const stored = harvests.get(sid);
    if (stored === undefined || !Array.isArray(wire) || stored.entries.length !== wire.length) return undefined;
    const ids: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < wire.length; i++) {
        const entry = stored.entries[i];
        if (entry.id === "" || entry.shape === null) return undefined;
        const msg = obj(wire[i]);
        if (msg === undefined || msg.role !== entry.shape.role) return undefined;
        const toks = wireContentToks(msg.content);
        if (toks === null || toks.length !== entry.shape.toks.length) return undefined;
        for (let j = 0; j < toks.length; j++) {
            if (toks[j] !== entry.shape.toks[j]) return undefined;
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
