/**
 * #5874 — snapshot-table compression foundation: stage 0 (world cursor).
 *
 * #7064 msgid-storage slimming (owner ruling 2026-11-17) reshaped this file:
 * the standing state is a BOOKKEEPING CURSOR — the head + tail id windows of
 * the last seen host array plus its count and the append-only pos frontier —
 * not a full canon. The middle is deliberately invisible:
 *
 *   - D1 (永不判分叉): an id verdict NEVER diverges. Client compression
 *     removes ids freely; a head drop is a `shrink`, a middle rewrite or a
 *     head swap is a `reanchor` (re-issue the cursor). The worst outcome is
 *     one cheap re-issue — never a reject. Middle-TAMPER detection is the
 *     ledger's job ((msg_id, identity) probes), not the cursor's.
 *   - D2: sessions with a host conversation identity skip the id verdict
 *     entirely (`anchor` mode — the cursor follows the incoming
 *     unconditionally).
 *   - D3: the cursor refreshes on watermark-hit turns too (the hit view is
 *     the same canonical id space — the envelope is space-stable).
 *
 * pos stays APPEND-ONLY (never reused): a re-anchored id is the SAME id at
 * the same pos (it survives the re-anchor by identity), only genuinely new
 * ids draw fresh pos from maxPos+1.
 */

import type { WorldDecision, WorldMode, WorldWindow } from "./types.ts";

/** Tail window width (the anchor chain). ~32 KiB JSON at ~60-char ids — the
 *  long-session cost this slimming exists to bound. */
export const WORLD_TAIL_K = 512;
/** Head window width (the origin anchor — fork/resume-parent confusion is
 *  only detectable at the head; a small number suffices). */
export const WORLD_HEAD_K = 32;

interface WorldMatchInput {
    /** The stored world anchor for this sess_raw, or null when none exists. */
    stored: WorldWindow | null;
    /** The stored world origin (issued_at); 0 when no stored world. */
    issuedAt: number;
    /** The incoming host ids (host order) — full-resend lanes send the whole
     *  array; M2 incremental sends only the new tail (matchAppendWindow). */
    incoming: string[];
    /** The raw session key (host value, never truncated, P9). */
    sessRaw: string;
    /** The bili canonical ledger identity to issue when no world exists
     *  (ruling D: the existing sid keyspace). */
    ledgerId: string;
    now: number;
    /** True when this turn is an explicit re-baseline (mode switch). */
    resync?: boolean;
}

function sameArr(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Cut the (tail, head) windows of an array. head = the first min(HEAD_K, n)
 *  ids; tail = the last min(TAIL_K, n) ids. */
export function windowOf(ids: readonly string[], maxPos: number): WorldWindow {
    return {
        tailIds: ids.slice(-WORLD_TAIL_K),
        headIds: ids.slice(0, WORLD_HEAD_K),
        count: ids.length,
        maxPos,
    };
}

/** Count the longest run of stored-tail elements that sit at the START of
 *  the incoming array — the chain-containment measure. Pure extension
 *  (incoming continues the stored array) → the whole stored tail counts;
 *  equality (echo) → also the whole tail; a head swap or a middle rewrite
 *  caps the run at the first mismatch. (A tail-vs-tail overlap would count
 *  the same arrays and miss every pure extension — the verdict the W3
 *  round trip needs.) */
function prefixContainLen(storedTail: readonly string[], incoming: readonly string[]): number {
    const cap = Math.min(storedTail.length, incoming.length);
    let k = 0;
    for (let i = 0; i < cap; i++) {
        if (storedTail[i] !== incoming[i]) break;
        k++;
    }
    return k;
}

/** Match the incoming host-id array against the stored cursor. Pure — returns
 *  the verdict; persistence is the caller's. D1: NO verdict rejects; the
 *  strongest move is `reanchor` (re-issue from the incoming). */
export function matchWindow(input: WorldMatchInput): WorldDecision {
    const incoming = Array.from(input.incoming);
    const fresh = (mode: WorldMode, witness?: string): WorldDecision => {
        const n = incoming.length;
        return {
            mode,
            window: windowOf(incoming, n),
            newIdPos: incoming.map((id, i) => ({ id, pos: i + 1 })),
            goneIds: [],
            issuedLedgerId: input.ledgerId,
            issuedAt: input.now,
            witness,
        };
    };

    // Explicit re-baseline always re-issues (the mode changed).
    if (input.resync) return fresh("resync");
    // No world yet: issue (one arming turn is charged at the session level).
    if (input.stored === null) return fresh("issue");

    const s = input.stored;
    const incomingSet = new Set(incoming);
    // Windowed gone-set: stored TAIL ids absent from the incoming (only what
    // the window can see — the middle is invisible by design).
    const goneIds = s.tailIds.filter((id) => !incomingSet.has(id));

    // No overlap at all → total re-mint → re-issue (D1: bookkeeping).
    if (s.tailIds.length === 0 || incoming.length === 0) {
        return {
            mode: "reanchor",
            window: windowOf(incoming, s.maxPos + incoming.length),
            newIdPos: incoming.map((id, i) => ({ id, pos: s.maxPos + i + 1 })),
            goneIds,
            issuedAt: input.issuedAt,
            witness: `no overlap (stored ${s.count}, incoming ${incoming.length})`,
        };
    }

    const k = prefixContainLen(s.tailIds, incoming);
    // The stored anchor fully contained in the incoming tail: the chain
    // extends (or holds).
    if (k >= s.tailIds.length) {
        // head + count + tail all agree → nothing moved (the middle is
        // invisible by design — head digest + count is the strongest claim
        // the windows can make).
        if (incoming.length === s.count && sameArr(s.headIds, incoming.slice(0, WORLD_HEAD_K))) {
            return {
                mode: "echo",
                window: s,
                newIdPos: [],
                goneIds: [],
                issuedAt: input.issuedAt,
            };
        }
        // Extension: ids beyond the stored array length are new. The count
        // cannot shrink across a full chain containment, so pos accounting
        // is exact.
        const newIdPos = incoming.slice(s.count).map((id, i) => ({ id, pos: s.count + i + 1 }));
        return {
            mode: "extend",
            // The head must track the INCOMING array — the next M1 full
            // resend re-compares against it (the W11 round trip): preserving
            // the stored head here would never echo again.
            window: { ...windowOf(incoming, s.maxPos), maxPos: s.maxPos + newIdPos.length },
            newIdPos,
            goneIds,
            issuedAt: input.issuedAt,
        };
    }
    // The whole incoming is a SUFFIX of the stored tail → the client dropped
    // head elements (a fold). D1: legal shrink, never divergent.
    if (incoming.length < s.count && incoming.every((id, i) => s.tailIds[s.tailIds.length - incoming.length + i] === id)) {
        return {
            mode: "shrink",
            window: windowOf(incoming, s.maxPos),
            newIdPos: [],
            goneIds,
            issuedAt: input.issuedAt,
            witness: `head drop: ${s.count} -> ${incoming.length}`,
        };
    }
    // No anchor relation (partial overlap / head swap / middle rewrite /
    // re-mint): re-issue the cursor. Ids that SURVIVE keep their pos via the
    // stored tail; everything else is counted as new (pos is bookkeeping —
    // M2 contiguity anchors on ledger seqs, not on this counter).
    // pos reconstruction: the tail ids hold maxPos-tailLen+1 .. maxPos in
    // order — the only positions the window knows exactly.
    const storedPos = new Map<string, number>();
    const base = s.maxPos - s.tailIds.length + 1;
    for (let i = 0; i < s.tailIds.length; i++) storedPos.set(s.tailIds[i], base + i);
    let pos = s.maxPos;
    const newIdPos: Array<{ id: string; pos: number }> = [];
    for (const id of incoming) {
        const p = storedPos.get(id);
        if (p === undefined) {
            pos += 1;
            newIdPos.push({ id, pos });
        }
    }
    return {
        mode: "reanchor",
        window: { ...windowOf(incoming, pos), maxPos: pos },
        newIdPos,
        goneIds,
        issuedAt: input.issuedAt,
        witness: `chain broke (overlap ${k}/${s.tailIds.length}; stored ${s.count}, incoming ${incoming.length})`,
    };
}

/**
 * #5874 2×2 M2 INCREMENTAL window: the client sends ONLY the new elements
 * (with msgids) — the caller has ALREADY located them at the ledger frontier
 * (contiguous seqs starting exactly after maxSeq, all ids unknown). The new
 * cursor = stored cursor ++ the new tail; the head is unchanged.
 */
export function matchAppendWindow(stored: WorldWindow, incoming: string[]): WorldDecision {
    const ids = Array.from(incoming);
    const all = [...stored.tailIds, ...ids];
    const prior = new Set(stored.tailIds);
    const newIdPos = ids
        .map((id, i) => ({ id, pos: stored.maxPos + i + 1, fresh: !prior.has(id) }))
        .filter((e) => e.fresh)
        .map(({ id, pos }) => ({ id, pos }));
    return {
        mode: "extend",
        window: {
            // tail tracks the COMBINED array — the next M1 full resend
            // re-compares against it (the W11 round trip). The head: while
            // the array is <= WORLD_HEAD_K the head IS the whole array, so it
            // extends with the appends; past K the true head is not in
            // stored.tailIds and re-slicing `all` would store a
            // middle-of-array slice as head (PR#6785 review fix — that broke
            // the echo gate at identity.ts:134 for every >WORLD_TAIL_K
            // session after any M2 turn: perpetual re-anchor + window
            // upsert instead of the steady-state no-write).
            tailIds: all.slice(-WORLD_TAIL_K),
            headIds: stored.count <= WORLD_HEAD_K ? all.slice(0, WORLD_HEAD_K) : stored.headIds,
            count: stored.count + ids.length,
            maxPos: stored.maxPos + ids.length, // M2 appends sequentially — every appended id takes the next pos, known or not
        },
        newIdPos,
        goneIds: [],
        issuedAt: 0, // the caller preserves the stored origin
    };
}

/** Parse a LEGACY persisted envelope (`JSON.stringify({id,pos}[])` — the
 *  pre-slimming l1_world.envelope_json) into the new window shape. Used by
 *  the schema migration ONLY (fresh rows store the window columns directly).
 *  Throws on malformed data (the migration degrades that row to a blank
 *  cursor instead of crashing the open). */
export function parseLegacyEnvelopeToWindow(envelopeJson: string): WorldWindow {
    const parsed: unknown = JSON.parse(envelopeJson);
    if (!Array.isArray(parsed)) throw new Error("legacy envelope is not an array");
    const ids: string[] = [];
    let maxPos = 0;
    for (const e of parsed) {
        const entry = e as { id?: unknown, pos?: unknown };
        if (typeof entry.id !== "string") throw new Error("legacy envelope entry is not {id, pos}");
        ids.push(entry.id);
        if (typeof entry.pos === "number" && entry.pos > maxPos) maxPos = entry.pos;
    }
    return windowOf(ids, maxPos || ids.length);
}
