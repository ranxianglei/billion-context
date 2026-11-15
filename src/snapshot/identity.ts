/**
 * #5874 — snapshot-table compression foundation: stage 0 (identity / world
 * match).
 *
 * The host's `(sess_raw, msgid[])` pair is the identity channel (§4.0). The
 * `l1_world` table is the server's standing canon: for a raw session id it
 * records the canonical host-msgid ENVELOPE — an ordered list of
 * `{id, pos}` where `pos` is the APPEND-ONLY ledger position the msgid was
 * first issued at (never reused, the DDL invariant) — plus the ledger
 * identity it was issued under.
 *
 * Every turn the incoming envelope (host msgids in host order) is matched
 * against the stored canon:
 *
 *   - echo    — the id sequence matches positionally → all known.
 *   - probe   — the stored id sequence is a strict PREFIX of the incoming →
 *               tail append (the common, v5-proven shape).
 *   - scatter — known ids keep their relative order but NEW ids are inserted
 *               at any position → the span-parse case (T5 byte pin).
 *   - issue   — no stored world → issue a fresh ledger identity + arm.
 *   - diverge — the LIVE head changed, or a KNOWN id changed its relative
 *               order (history rewrite) → this turn legacy + re-stamp; the
 *               canon is NOT updated (the client converges in one turn).
 *   - resync  — an explicit re-baseline (mode switch).
 *
 * Deletions (a stored id absent from the incoming) are NOT a divergence while
 * the live head and the survivors' relative order are unchanged: they are
 * reported via `goneIds` and the reconcile turns them into `delete` events.
 *
 * THE LIVE HEAD: after a fold the client's envelope starts at the first
 * SURVIVING element while the canon still lists the covered head entries
 * (their pos is never reused). A head change is a divergence only when the
 * first stored id that is NOT fold-explained (`explainedGone`) differs from
 * the incoming head — a legal post-fold shrink therefore keeps the plane
 * green, while a host that drops its head WITHOUT fold evidence diverges.
 * (Middle deletions without fold evidence stay legal — reconcile emits the
 * `delete` events and the egress skips the row.)
 *
 * NEW ids are issued fresh append-only pos (maxPos+1.., in incoming order), so
 * a middle insertion never shifts a stored row — the rows (and the prefix
 * cache) stay put.
 */
import { envelopeChecksum } from "./checksums.ts";
import type { WorldDecision, WorldEnvelopeEntry } from "./types.ts";

interface WorldMatchInput {
    /** The stored L1 world for this sess_raw, or null when none exists. */
    stored: {
        ledgerId: string;
        /** The stored canon (ordered {id, pos}). */
        envelope: WorldEnvelopeEntry[];
        envelopeChecksum: string;
        issuedAt: number;
        armedAt?: number;
    } | null;
    /** The incoming host envelope (per-element msgids, in host order). For a
     *  non-cohort host this is the sequence-derived pseudo-envelope. */
    incoming: string[];
    /** Stored ids whose absence a fold already explains (their row is
     *  inactive with a coverRef). Only such ids may legally vanish from the
     *  HEAD of the envelope; any other gone id is a client-side drop
     *  (legal in the middle, divergent at the head). */
    explainedGone?: ReadonlySet<string>;
    /** The raw session key (host value, never truncated, P9). */
    sessRaw: string;
    /** The bili canonical ledger identity to issue when no world exists
     *  (ruling D: the existing sid keyspace). */
    ledgerId: string;
    now: number;
    /** True when this turn is an explicit re-baseline (mode switch). */
    resync?: boolean;
}

/** Match the incoming envelope against the stored canon. Pure — returns the
 *  verdict; the persistence (upsertL1World) is done by the caller so a
 *  `diverge` turn has ZERO side effects (the canon is not touched). */
export function matchWorld(input: WorldMatchInput): WorldDecision {
    const incoming = Array.from(input.incoming);
    const incomingCk = envelopeChecksum(incoming);

    // Explicit re-baseline always re-issues the canon (the mode changed).
    if (input.resync) {
        const env: WorldEnvelopeEntry[] = incoming.map((id, i) => ({ id, pos: i + 1 }));
        return {
            mode: "resync",
            envelope: env,
            envelopeChecksum: incomingCk,
            newIdPos: env.map((e) => ({ id: e.id, pos: e.pos })),
            goneIds: [],
            issuedLedgerId: input.ledgerId,
            issuedAt: input.now,
            armedAt: input.now,
        };
    }

    if (input.stored === null) {
        // No world yet: issue a fresh ledger identity, pay one arming turn.
        const env: WorldEnvelopeEntry[] = incoming.map((id, i) => ({ id, pos: i + 1 }));
        return {
            mode: "issue",
            envelope: env,
            envelopeChecksum: incomingCk,
            newIdPos: env.map((e) => ({ id: e.id, pos: e.pos })),
            goneIds: [],
            issuedLedgerId: input.ledgerId,
            issuedAt: input.now,
            armedAt: input.now,
        };
    }

    const stored = input.stored;
    const storedIds = stored.envelope.map((e) => e.id);

    // 1. echo: the id sequence matches positionally → all known.
    if (stored.envelopeChecksum === incomingCk && stored.envelope.length === incoming.length) {
        return {
            mode: "echo",
            envelope: stored.envelope.map((e) => ({ id: e.id, pos: e.pos })),
            envelopeChecksum: incomingCk,
            newIdPos: [],
            goneIds: [],
            issuedAt: stored.issuedAt, // B1 trap: origin never moves on echo
        };
    }

    // Known-id bookkeeping.
    const storedPos = new Map<string, number>();
    for (const e of stored.envelope) storedPos.set(e.id, e.pos);
    const incomingSet = new Set(incoming);
    const goneIds: string[] = [];
    for (const id of storedIds) if (!incomingSet.has(id)) goneIds.push(id);

    // A KNOWN id that changed its relative order (or the LIVE head changed)
    // is a history rewrite → diverge (the canon is not updated; the turn
    // runs legacy and re-stamps so the client converges in one turn).
    // The live head = the first stored id that a fold did NOT absorb:
    // after a post-fold shrink the incoming envelope legitimately starts at
    // the first surviving element, not at the (covered) canon head.
    const aliveStored = storedIds.filter((id) => !input.explainedGone?.has(id));
    const headMoved = aliveStored.length > 0 && incoming.length > 0 && incoming[0] !== aliveStored[0];
    let orderBroken = false;
    if (!headMoved) {
        // The survivor ids must appear in the same relative order as stored.
        const survivorsStored = storedIds.filter((id) => incomingSet.has(id));
        const survivorsIncoming = incoming.filter((id) => storedPos.has(id));
        if (survivorsStored.length !== survivorsIncoming.length) {
            orderBroken = true;
        } else {
            for (let i = 0; i < survivorsStored.length; i++) {
                if (survivorsStored[i] !== survivorsIncoming[i]) {
                    orderBroken = true;
                    break;
                }
            }
        }
    }
    if (headMoved || orderBroken) {
        return {
            mode: "diverge",
            envelope: stored.envelope.map((e) => ({ id: e.id, pos: e.pos })),
            envelopeChecksum: stored.envelopeChecksum,
            newIdPos: [],
            goneIds: [],
            issuedAt: stored.issuedAt,
            witness: `head ${storedIds[0] ?? "-"} -> ${incoming[0] ?? "-"}; orderBroken=${orderBroken}`,
        };
    }

    // Head stable + survivor order preserved → a legal extension (probe or
    // scatter). Issue fresh pos to every NEW id (maxPos+1.., incoming order).
    let maxPos = 0;
    for (const e of stored.envelope) maxPos = Math.max(maxPos, e.pos);
    const newIdPos: Array<{ id: string; pos: number }> = [];
    const posMap = new Map<string, number>();
    for (const e of stored.envelope) posMap.set(e.id, e.pos);
    for (const id of incoming) {
        if (!posMap.has(id)) {
            maxPos += 1;
            posMap.set(id, maxPos);
            newIdPos.push({ id, pos: maxPos });
        }
    }
    const envelope: WorldEnvelopeEntry[] = incoming.map((id) => ({ id, pos: posMap.get(id)! }));

    // probe = stored is a strict prefix of incoming (tail append only);
    // scatter = new ids are interleaved.
    let isPrefix = storedIds.length < incoming.length;
    if (isPrefix) {
        for (let i = 0; i < storedIds.length; i++) {
            if (incoming[i] !== storedIds[i]) {
                isPrefix = false;
                break;
            }
        }
    }
    const mode = newIdPos.length > 0
        ? (isPrefix ? "probe" : "scatter")
        : goneIds.length > 0
            ? "probe" // canon shrink (deletions only)
            : "echo";

    return {
        mode,
        envelope,
        envelopeChecksum: incomingCk,
        newIdPos,
        goneIds,
        issuedAt: stored.issuedAt, // B1 trap: origin never moves on extend
    };
}

/**
 * #5874 2×2 (brief 19544722, Part A) — the M2 INCREMENTAL envelope:
 * the client sends ONLY the new elements (with msgids), so the incoming
 * list shares NO ids with the stored canon (a pure addition). The caller
 * has ALREADY located the sequence position (世界匹配定位序列位置) via the
 * seqs carrier — the incoming ledger seqs are contiguous and start exactly
 * after the plane's max stamped seq — so every incoming id gets a fresh
 * append-only pos (maxPos+1.., in incoming order) and the envelope is the
 * stored canon ++ the new tail.
 *
 * This is the "probe" shape of a client that never re-sends: the covered
 * (fold-explained) canon entries stay in the canon (the caller prunes them
 * from the kernel-input walk via explainedGone — the plane keeps serving
 * them as covered rows until GC).
 */
export function matchAppend(
    stored: {
        ledgerId: string;
        envelope: WorldEnvelopeEntry[];
        envelopeChecksum: string;
        issuedAt: number;
        armedAt?: number;
    },
    incoming: string[],
): WorldDecision {
    const incomingCk = envelopeChecksum(incoming);
    let maxPos = 0;
    const posMap = new Map<string, number>();
    for (const e of stored.envelope) {
        maxPos = Math.max(maxPos, e.pos);
        posMap.set(e.id, e.pos);
    }
    const newIdPos: Array<{ id: string, pos: number }> = [];
    for (const id of incoming) {
        if (posMap.has(id)) continue; // defensive: the caller guarantees a pure addition
        maxPos += 1;
        posMap.set(id, maxPos);
        newIdPos.push({ id, pos: maxPos });
    }
    const envelope: WorldEnvelopeEntry[] = [
        ...stored.envelope.map((e) => ({ id: e.id, pos: e.pos })),
        ...incoming.map((id) => ({ id, pos: posMap.get(id)! })),
    ];
    return {
        mode: "probe",
        envelope,
        // The stored canon's checksum covers the WHOLE envelope sequence
        // (the next M1 full resend must echo against it), not just the new
        // tail.
        envelopeChecksum: envelopeChecksum(envelope.map((e) => e.id)),
        newIdPos,
        goneIds: [],
        issuedAt: stored.issuedAt, // B1 trap: origin never moves on extend
    };
}

/** Parse the persisted element envelope (the l1_world envelope_json column —
 *  `JSON.stringify(WorldEnvelopeEntry[])`, host order). Validated: a
 *  malformed canon is a storage-corruption signal and throws (the lane
 *  maps it to a resync — the client converges in one round) rather than
 *  being silently re-issued over a half-read canon. */
export function parseEnvelope(envelopeJson: string | null): { envelope: WorldEnvelopeEntry[] } {
    if (envelopeJson === null) return { envelope: [] };
    const parsed: unknown = JSON.parse(envelopeJson);
    if (!Array.isArray(parsed)) throw new Error("parseEnvelope: the canon is not an array (corrupted l1_world row)");
    const envelope: WorldEnvelopeEntry[] = parsed.map((e, i) => {
        const entry = e as { id?: unknown, pos?: unknown };
        if (typeof entry.id !== "string" || !Number.isInteger(entry.pos) || (entry.pos as number) < 0) {
            throw new Error(`parseEnvelope: canon entry ${i} is not a {id, pos} pair (corrupted l1_world row)`);
        }
        return { id: entry.id, pos: entry.pos as number };
    });
    return { envelope };
}
