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

// #7085 follow-up: source-kind attestation channel. The dsh plugin attests
// `(kind, fingerprint)` pairs for its host-injected messages — the kind is
// the structured `source.kind` it stamps internally (never visible on the
// wire otherwise), the fingerprint is 16 hex of sha256(exact text). The
// classifier (src/durable-message-guards.ts dshDurableToolPathWithKinds)
// consults the decoded index before its text markers, so a host rewording an
// injection can no longer silently disarm a classifier. Strict decode, whole
// header all-or-nothing (one malformed pair or an ambiguous fingerprint —
// the same fp attested under two kinds — drops EVERYTHING, exactly the
// parseTailIds / stamped-header discipline): absent or rejected headers
// classify byte-identically to pre-channel traffic. The header is egress-
// stripped (UPSTREAM_HOP_HEADERS); it rides alongside x-bili-msg-ids and is
// consumed at the same seam (src/server/handle.ts).
export const MSG_KINDS_HEADER = "x-bili-msg-kinds";
const MSG_KINDS_MAX_PAIRS = 512; // ~30KiB worst case under the byte cap below
const MSG_KIND_TOKEN_RE = /^[a-z][a-z0-9-]{0,39}$/; // dsh kinds are lower-kebab, producer-declared
const MSG_KIND_FP_RE = /^[0-9a-f]{16}$/;

/** Decode `x-bili-msg-kinds` into a fingerprint→kind index, or undefined
 *  (absent / oversized / any malformed pair / ambiguous fp) — the caller
 *  then classifies exactly as pre-channel. Unknown kinds PASS validation and
 *  are ignored at classify time: the kind→path map is the evidence
 *  permitlist, not a closed vocabulary (a future dsh kind degrades to the
 *  text markers, never to a 400 or a dropped turn). */
export function incomingMsgKindsHeader(headerValue: string | string[] | undefined): Map<string, string> | undefined {
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    if (raw.length > STAMPED_HEADER_MAX_TOTAL_BYTES) return undefined;
    const index = new Map<string, string>();
    let pairs = 0; // RAW pair count (duplicates included) — the documented
    // "≤512 pairs" guarantee is about the header's work, not the deduped index
    for (const pair of raw.split(",")) {
        if (pair.length === 0) continue; // trailing/interior comma tolerance, like the ids header
        pairs += 1;
        if (pairs > MSG_KINDS_MAX_PAIRS) return undefined;
        const eq = pair.indexOf("=");
        const kind = eq <= 0 ? "" : pair.slice(0, eq);
        const fp = eq <= 0 ? "" : pair.slice(eq + 1);
        if (!MSG_KIND_TOKEN_RE.test(kind) || !MSG_KIND_FP_RE.test(fp)) return undefined;
        const prior = index.get(fp);
        if (prior !== undefined && prior !== kind) return undefined; // ambiguous attestation → void
        index.set(fp, kind);
    }
    return index.size > 0 ? index : undefined;
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
