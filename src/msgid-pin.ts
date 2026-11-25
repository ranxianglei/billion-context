// #4491 plugin-lane server history: consume + validate the client-supplied
// message-id array (`biliMsgIds`, parallel to `messages`).
//
// The ids become the messages' identity in the kernel ref space and in the
// unified table (msg_id column) — so validation is strict: an invalid array
// degrades the turn to content-derived ids rather than poisoning the ledger
// with colliding or unstable keys. Reserved prefixes stay out: `acp_summary_`
// is the kernel's synthetic-anchor namespace (rendered fold anchors carry
// those ids; a client id claiming one would misattribute decompress lookups).

import type { BiliMessage } from "acp-kernel/wire";

export const MSG_IDS_BODY_FIELD = "biliMsgIds";

// #4316 layer 3 (PR 2/3): the plugin lane rides the server-owned ledger
// seqs next to the ids (same parallel-array transport, same lifecycle:
// stripped before the upstream, validated strictly, degraded to unstamped
// on any mismatch). With stamps riding the synthetic body, the pipeline
// kernel survives the wire boundary — fold coverage can key on seq
// intervals (churn-immune) and refs can connect to the ledger directly.
export const MSG_SEQS_BODY_FIELD = "biliLedgerSeqs";

const MAX_ID_LEN = 512;
const RESERVED_PREFIX = "acp_summary_";

type MsgIdValidation = { ok: true; ids: string[] } | { ok: false; reason: string };

function validateIdEntries(raw: unknown[], expectedLen: number): MsgIdValidation {
    if (raw.length !== expectedLen) return { ok: false, reason: "length-mismatch" };
    const seen = new Set<string>();
    for (const v of raw) {
        if (typeof v !== "string" || v.length === 0 || v.length > MAX_ID_LEN) return { ok: false, reason: "bad-entry" };
        if (v.startsWith(RESERVED_PREFIX)) return { ok: false, reason: "reserved-prefix" };
        // whitespace/control chars make ids un-greppable and ambiguous in logs
        if (/[\s\p{C}]/u.test(v)) return { ok: false, reason: "control-or-space" };
        if (seen.has(v)) return { ok: false, reason: "duplicate" };
        seen.add(v);
    }
    return { ok: true, ids: raw as string[] };
}

export function validateMsgIds(raw: unknown, expectedLen: number): MsgIdValidation {
    if (!Array.isArray(raw)) return { ok: false, reason: "not-an-array" };
    return validateIdEntries(raw, expectedLen);
}

export function applyMsgIdPin(msgs: BiliMessage[], ids: string[]): BiliMessage[] {
    return msgs.map((m, i) => ({ ...m, id: ids[i] }));
}

// #7439 follow-up (cross-lane model/protocol switching): WIRE-granularity
// pinning. The host stamps one id per WIRE message element (the pi-ai
// walkers prove element⇄host-message pairing); the kernel splits one
// element into N cores (an agentic assistant with text+tool_calls becomes
// text core + tool-call cores, sharing one wireIndex). The per-core form
// (validateMsgIds against msgs.length) can never express that — the old
// host-side proof bailed to content-derived ids instead. The wire form:
// group the post-hoist cores by their kernel-stamped wireIndex and pin
// per group — the head core takes the host id, siblings get deterministic
// derived ids (`<head>#p<k>`, lane-neutral, no schema change).
//
// Dual-mode unambiguity: a host that CAN'T split-proof still emits one id
// per element, but ONLY when every element is 1:1 with its cores — which
// is exactly the per-core length. So: ids.length === msgs.length → per-core
// path (byte-identical to before); ids.length === group count AND at least
// one group has >1 core → wire form. No overlap, no guess.

/** #7439 follow-up: group post-hoist cores by wireIndex. Null when the
 *  grouping can't express the envelope: any core lacks a non-negative
 *  integer wireIndex, or the index range has a gap (a vanished wire element
 *  has no group head to carry its host id → safe degrade to content-derived). */
type WirePinGroups = {
    /** Lowest wireIndex present (openai/responses hoist the leading
     *  system/developer run, so the first surviving core may start past 0). */
    min: number;
    /** Number of wire elements (groups) — the expected envelope length. */
    size: number;
    /** True when at least one element owns more than one core. */
    split: boolean;
    /** wireIndex → core indices into the msgs array (array order = core order). */
    groups: Map<number, number[]>;
};

export function wirePinGroups(msgs: BiliMessage[]): WirePinGroups | null {
    const groups = new Map<number, number[]>();
    let split = false;
    for (let i = 0; i < msgs.length; i++) {
        const w = msgs[i]!.wireIndex;
        if (typeof w !== "number" || !Number.isInteger(w) || w < 0) return null;
        const g = groups.get(w);
        if (g === undefined) groups.set(w, [i]);
        else {
            g.push(i);
            split = true;
        }
    }
    if (groups.size === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const w of groups.keys()) {
        if (w < min) min = w;
        if (w > max) max = w;
    }
    if (max - min + 1 !== groups.size) return null; // gap — orphan index
    return { min, size: groups.size, split, groups };
}

const WIRE_SIBLING_RE = /^(\S+)#p\d+$/;

/**
 * #7439 follow-up (Part 2): the ledger view is CORE-granular — a multi-core
 * wire element carries its host id on its FIRST core and derived `#pN` ids
 * on its siblings. Wire-element-granular consumers (the incremental tail pin
 * compares against the host's element list) need the ELEMENT list: drop
 * every derived sibling, keep every leader.
 *
 * Documented limit: a host-minted id that genuinely ends in `#pN` while its
 * base is ALSO in the ledger is indistinguishable from a derived sibling and
 * is treated as one (host ids are a host-owned namespace; the collision
 * would have to match both the exact suffix and a co-resident base id).
 */
export function wireElementIds(ledgerIds: readonly string[]): string[] {
    const set = new Set(ledgerIds);
    return ledgerIds.filter((id) => {
        const m = WIRE_SIBLING_RE.exec(id);
        return !(m !== null && set.has(m[1]));
    });
}

/** Wire-form validation: same entry rules as the per-core path, length
 *  against the GROUP count (wire elements), not the core count. */
export function validateWireMsgIds(raw: unknown, groups: WirePinGroups): MsgIdValidation {
    if (!Array.isArray(raw)) return { ok: false, reason: "not-an-array" };
    return validateIdEntries(raw, groups.size);
}

/** Wire-form pinning: each group's head core takes the host id for its
 *  wireIndex; siblings derive `<head>#p<k>` in core order. Deterministic
 *  and lane-neutral — the same logical split pins the same ids on every
 *  lane, so a lane switch keeps the flow's ids (the op-log swap matches by
 *  id). Pinning copies — the source messages keep their derived ids. */
export function applyWireMsgIdPin(msgs: BiliMessage[], groups: WirePinGroups, ids: string[]): BiliMessage[] {
    return msgs.map((m, i) => {
        const w = m.wireIndex as number;
        const g = groups.groups.get(w)!;
        const pos = g.indexOf(i);
        return { ...m, id: pos === 0 ? ids[w - groups.min] : `${ids[w - groups.min]}#p${pos}` };
    });
}

// #5719: the lane resolver's identity input — same degrade-over-mispair
// discipline as validateMsgIds but WITHOUT the length-equals-messages
// contract: the fork-exit rung only needs ANY overlap between the incoming
// ids and a key's recorded ledger, so a short/partial array is still
// evidence. Absent or malformed → undefined → callers take exactly the
// pre-#5719 path (strict pinning stays with validateMsgIds' full check).
export function incomingMsgIdsOf(body: unknown): string[] | undefined {
    if (typeof body !== "object" || body === null) return undefined;
    const raw = (body as Record<string, unknown>)[MSG_IDS_BODY_FIELD];
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    for (const v of raw) {
        if (typeof v !== "string" || v.length === 0 || v.length > MAX_ID_LEN) return undefined;
        if (v.startsWith(RESERVED_PREFIX)) return undefined;
        if (/\s|[\u0000-\u001f\u007f]/.test(v)) return undefined;
    }
    return raw as string[];
}

// #5825 stamped-header channel: hosts that cannot rewrite the body they send
// (opencode V2 — ids live on the structured event, not in the wire JSON) ride
// them comma-joined on `x-bili-msg-ids`. Parsed into the SAME light contract
// as incomingMsgIdsOf so downstream consumers see one shape; full strictness
// stays at pin time (validateMsgIds). Absent / oversized / malformed →
// undefined → exactly the pre-channel path.
const STAMPED_HEADER_MAX_TOTAL_BYTES = 64 * 1024; // host-side budget is 16KiB; parse headroom above it
const STAMPED_HEADER_MAX_IDS = 4096;

export function incomingMsgIdsHeader(headerValue: string | string[] | undefined): string[] | undefined {
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    if (raw.length > STAMPED_HEADER_MAX_TOTAL_BYTES) return undefined;
    const list = raw.split(",").filter((s) => s.length > 0);
    if (list.length === 0 || list.length > STAMPED_HEADER_MAX_IDS) return undefined;
    return incomingMsgIdsOf({ [MSG_IDS_BODY_FIELD]: list });
}

type SeqValidation = { ok: true; seqs: number[] } | { ok: false; reason: string };

// #5874 2×2 (brief 19544722, Part A): the SEQS half of the dual-channel
// identity (biliLedgerSeqs, #4316 layer 3 transport). Lenient read like
// incomingMsgIdsOf — absent/malformed → undefined → callers take exactly
// the pre-2×2 path (the strict pin stays with validateMsgSeqs).
export function incomingSeqsOf(body: unknown): number[] | undefined {
    if (typeof body !== "object" || body === null) return undefined;
    const raw = (body as Record<string, unknown>)[MSG_SEQS_BODY_FIELD];
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    for (const v of raw) {
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) return undefined;
    }
    return raw as number[];
}

/** #7064 §8: the pin-mode signal the server stamps on the response — tells
 *  the client what it may send NEXT turn: "incremental" (the ledger pins the
 *  prefix; ride only x-bili-pf-tail-ids, suppress the full list) or "full"
 *  (send the full id list — bootstrap / reanchor / this turn degraded).
 *  Rides with the existing watermark response headers (same chokepoint). */
export const MSGID_MODE_HEADER = "x-bili-msgid-mode";

/** Strict validation for the seq stamp array: 1-based positive integers,
 *  exactly one per message. Non-monotonic or non-contiguous values are
 *  ACCEPTED on purpose — the branch pointers pick arbitrary row subsets
 *  (rewind/fork views), and the kernel's interval math only ever reasons
 *  about the values themselves, never their density. */
export function validateMsgSeqs(raw: unknown, expectedLen: number): SeqValidation {
    if (!Array.isArray(raw)) return { ok: false, reason: "not-an-array" };
    if (raw.length !== expectedLen) return { ok: false, reason: "length-mismatch" };
    for (const v of raw) {
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) return { ok: false, reason: "bad-entry" };
    }
    return { ok: true, seqs: raw as number[] };
}

export function applyMsgSeqStamps(msgs: BiliMessage[], seqs: number[]): BiliMessage[] {
    return msgs.map((m, i) => ({ ...m, ledgerSeq: seqs[i] }));
}
