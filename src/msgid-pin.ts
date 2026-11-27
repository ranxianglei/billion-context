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

// STRUCTURAL wire-id identity. The real identity of a pinned core is the
// (wire-element, ordinal) pair; the on-wire/ledger id string is an INJECTIVE
// rendering of it. Legacy rendered the k-th sibling as `<base>#p<k>`, which is
// lossy: (elem X, ord 1) and (elem X#p1, ord 0) BOTH rendered to "X#p1". That
// only bites a host that mints an id CONTAINING '#' (pi/dsh/opencode mint
// hex/uuid ids, so it never fired in the field) — but it made the id space
// depend on a host promise instead of holding on its own.
//
// Now: a '#' -free element id renders VERBATIM (byte-identical to legacy for
// every real host); a '#' -containing one is injected into the reserved SIBMARK
// namespace (SIBMARK + base64url, '#' -free + injective), so its cores can never
// equal a derived `#p<k>` sibling of another element. SIBMARK is reserved:
// host ids in it are rejected, keeping the two namespaces disjoint.
export const SIBMARK = "x";

function b64u(s: string): string {
    return Buffer.from(s, "utf8").toString("base64url");
}
function b64uDecode(s: string): string {
    try {
        return Buffer.from(s, "base64url").toString("utf8");
    } catch {
        return s; // malformed — keep opaque (well-formed ledger ids never hit this)
    }
}
/** The '#' -free base a wire element's cores render under. */
function elementBase(id: string): string {
    return id.includes("#") ? SIBMARK + b64u(id) : id;
}
/** Render the on-wire/ledger id for (element, ordinal). ordinal 0 = head core
 *  (no suffix); ordinal k>0 = k-th sibling (`#p` + k). Injective over the pair:
 *  distinct (element, ordinal) always yield distinct ids. */
export function renderCoreId(id: string, ordinal: number): string {
    const base = elementBase(id);
    return ordinal === 0 ? base : `${base}#p${ordinal}`;
}
/** Invert renderCoreId → (element, ordinal). A '#' -free head is ordinal 0 with
 *  element === id; a `#p<k>` suffix is ordinal k; a SIBMARK-prefixed base decodes
 *  back to the original '#' -containing element id (so wire-element consumers —
 *  element lists, the incremental tail pin — compare '#' -host elements against
 *  exactly what the host resends). */
export function elementOfCore(id: string): { element: string; ordinal: number } {
    const m = /^(.*)#p(\d+)$/.exec(id);
    const base = m !== null ? m[1]! : id;
    const ordinal = m !== null ? parseInt(m[2]!, 10) : 0;
    const element = base.startsWith(SIBMARK) ? b64uDecode(base.slice(SIBMARK.length)) : base;
    return { element, ordinal };
}

type MsgIdValidation = { ok: true; ids: string[] } | { ok: false; reason: string };

function validateIdEntries(raw: unknown[], expectedLen: number): MsgIdValidation {
    if (raw.length !== expectedLen) return { ok: false, reason: "length-mismatch" };
    const seen = new Set<string>();
    for (const v of raw) {
        if (typeof v !== "string" || v.length === 0 || v.length > MAX_ID_LEN) return { ok: false, reason: "bad-entry" };
        if (v.startsWith(RESERVED_PREFIX)) return { ok: false, reason: "reserved-prefix" };
        // SIBMARK is the server-side encoded-element namespace — a host id in it
        // would collide with a derived core id (see renderCoreId).
        if (v.startsWith(SIBMARK)) return { ok: false, reason: "reserved-prefix" };
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
    return msgs.map((m, i) => ({ ...m, id: renderCoreId(ids[i]!, 0) }));
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

/**
 * #7439 follow-up (Part 2): the ledger view is CORE-granular — a multi-core
 * wire element carries its host id on its FIRST core and derived `#pN` ids
 * on its siblings. Wire-element-granular consumers (the incremental tail pin
 * compares against the host's element list) need the ELEMENT list: keep every
 * head (ordinal 0), drop every sibling. Each head is returned DECODED to its
 * element id (elementOfCore), so a '#' -host element compares equal to what
 * the host resends; a '#' -free head decodes to itself — the legacy behavior.
 */
export function wireElementIds(ledgerIds: readonly string[]): string[] {
    return ledgerIds
        .filter((id) => elementOfCore(id).ordinal === 0)
        .map((id) => elementOfCore(id).element);
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
        return { ...m, id: renderCoreId(ids[w - groups.min]!, pos) };
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
