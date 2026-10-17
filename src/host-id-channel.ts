/**
 * #3464 (R1 of the #2960 identity pipeline): host message-id side channel.
 *
 * Native plugin hosts (dsh, opencode) assign every message a stable internal
 * id, but the wire never carries it. The wire body is all bili sees, and all
 * three identity layers were historically derived from content bytes
 * (MESSAGE-IDENTITY.md) — any byte drift (marker stripping, re-encoding,
 * provider rewrite, dsh edit) collapsed message identity and forced fold-
 * reconcile into after-the-fact guessing ("are these two really the same
 * message?").
 *
 * This channel fixes it at the source: the plugin stamps the ordered list of
 * host ids for the wire messages as a top-level body field; the proxy
 * extracts it at the single parse chokepoint and NEVER forwards it upstream
 * (the field is deleted from the parsed object before any path can serialize
 * it again). Where the channel is active, reconciliation degrades from
 * byte-hash inference to exact set algebra (host-id equality claims) and the
 * canonical store keys ONE row per (host_id, slot) instead of per content
 * hash — a drifted resend refreshes the row instead of minting a twin.
 *
 * Adoption is gradual by lane capability: only hosts that expose message ids
 * stamp (dsh MessageBase.id, opencode msg_…). Lanes without ids keep byte-id
 * behavior bit-identical. A malformed stamp is stripped and ignored for that
 * request — honest degradation, never worse than status quo.
 *
 * Wire shape (anthropic v1; the field is protocol-neutral JSON):
 *   { ..., "messages": [...], "_bili_message_ids": ["<id>", null, ...] }
 * aligned index-for-index with `messages`. One wire message may expand into
 * several kernel cores (one per content block); the intra-group ordinal
 * ("slot") disambiguates them — see coreHostRefs.
 */

/** Reserved top-level request-body field. Never forwarded upstream. */
export const HOST_ID_BODY_FIELD = "_bili_message_ids";
/** Host ids are opaque strings; printable ASCII keeps the storage columns
 *  cheap and the composite-key separator (\u0000) injection-proof. */
const HOST_ID_PATTERN = /^[\x21-\x7e]+$/;
export const HOST_ID_MAX_ENTRY_LEN = 1024;
export const HOST_ID_MAX_ENTRIES = 10_000;

interface HostIdExtract {
    /** Validated wire-aligned host ids (null = that wire message carries no
     *  id), or null when the field was absent or malformed. */
    ids: (string | null)[] | null;
    /** True when the reserved field was present and removed from `parsed`. */
    stripped: boolean;
}

/** Extracts AND strips the side channel from a parsed request body. The
 *  delete happens for EVERY presence — including malformed ones — so the
 *  reserved namespace can never reach an upstream through a later
 *  re-serialization. `wireMessages` is the body's own message array
 *  (protocol-specific: anthropic/openai `messages`, responses `input`,
 *  google `contents`); length mismatch or non-array ⇒ malformed. */
export function extractHostIds(
    parsed: Record<string, unknown>,
    wireMessages: readonly unknown[] | undefined,
): HostIdExtract {
    if (!(HOST_ID_BODY_FIELD in parsed)) return { ids: null, stripped: false };
    const raw = parsed[HOST_ID_BODY_FIELD];
    delete parsed[HOST_ID_BODY_FIELD];
    if (!Array.isArray(wireMessages)) return { ids: null, stripped: true };
    if (!Array.isArray(raw) || raw.length !== wireMessages.length || raw.length > HOST_ID_MAX_ENTRIES) {
        return { ids: null, stripped: true };
    }
    const ids: (string | null)[] = [];
    for (const v of raw) {
        if (v === null) {
            ids.push(null);
            continue;
        }
        if (typeof v !== "string" || v.length === 0 || v.length > HOST_ID_MAX_ENTRY_LEN || !HOST_ID_PATTERN.test(v)) {
            return { ids: null, stripped: true };
        }
        ids.push(v);
    }
    return { ids, stripped: true };
}

/** Plugin-side collector: reads each wire message's own `id` field (hosts
 *  that serialize it into the request body — dsh MessageBase.id, opencode
 *  msg_…) into a stamp-ready list. Returns null when nothing should be
 *  stamped: no id present at all, more messages than the channel allows, or
 *  ANY entry malformed (non-string / empty / oversized / non-printable-ASCII)
 *  — mirroring extractHostIds' server-side validation so a half-valid stamp
 *  can never ship. Null PAD entries are fine (that message carries no id). */
export function collectWireHostIds(
    wireMessages: readonly unknown[],
    maxEntries: number,
): (string | null)[] | null {
    if (wireMessages.length > maxEntries) return null;
    let present = 0;
    const out: (string | null)[] = new Array(wireMessages.length);
    for (let i = 0; i < wireMessages.length; i++) {
        const m = wireMessages[i];
        const id = m !== null && typeof m === "object" ? (m as { id?: unknown }).id : undefined;
        if (id === undefined || id === null) {
            out[i] = null;
            continue;
        }
        if (typeof id !== "string" || id.length === 0 || id.length > HOST_ID_MAX_ENTRY_LEN || !HOST_ID_PATTERN.test(id)) {
            return null;
        }
        out[i] = id;
        present++;
    }
    return present > 0 ? out : null;
}

/** One core's position inside its host message: the host id plus the ordinal
 *  among the cores that the SAME wire message expanded into (kernel adapters
 *  emit one core per content block and tag each with `wireIndex`). */
export interface CoreHostRef {
    hostId: string;
    slot: number;
}

/** Composite identity used by dedup maps, anchors and the partial unique
 *  index — the separator cannot occur inside a validated host id. */
export function hostKeyOf(ref: CoreHostRef): string {
    return `${ref.hostId}\u0000${ref.slot}`;
}

/** Zips a wire-aligned host-id list onto the converted cores. Returns null
 *  per core wherever the pairing is unavailable (lane not stamped, entry
 *  null, or the core lacks a usable wireIndex tag — the kernel tags it only
 *  on the anthropic wire today; other adapters degrade honestly). A core
 *  without a wireIndex gets a per-core-unique slot so it can never collide
 *  with another core's slot by accident (it also cannot dedup across legs —
 *  conservative, by design). */
export function coreHostRefs(
    msgs: ReadonlyArray<{ id: string; wireIndex?: number }>,
    ids: readonly (string | null)[] | null | undefined,
): (CoreHostRef | null)[] {
    if (ids === null || ids === undefined || ids.length !== msgs.length) return msgs.map(() => null);
    const slotByWire = new Map<number, number>();
    return msgs.map((m, i) => {
        const h = ids[i];
        if (h === null || h === undefined) return null;
        const wi = m.wireIndex;
        let slot: number;
        if (typeof wi === "number" && Number.isSafeInteger(wi) && wi >= 0) {
            slot = slotByWire.get(wi) ?? 0;
            slotByWire.set(wi, slot + 1);
        } else {
            slot = i;
        }
        return { hostId: h, slot };
    });
}
