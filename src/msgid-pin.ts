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

export function validateMsgIds(raw: unknown, expectedLen: number): MsgIdValidation {
    if (!Array.isArray(raw)) return { ok: false, reason: "not-an-array" };
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

export function applyMsgIdPin(msgs: BiliMessage[], ids: string[]): BiliMessage[] {
    return msgs.map((m, i) => ({ ...m, id: ids[i] }));
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
