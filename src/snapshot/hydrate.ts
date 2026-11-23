/**
 * #5874 — snapshot-table compression foundation: hydrate (the read-side plane
 * reconstruction).
 *
 * The hydrate has TWO lanes (§6):
 *   - GREEN: the tables are readable and the S4 integrity check passes → the
 *     snapshot plane is the source of truth for egress.
 *   - RED: the flag is off / no world / tables unreadable / S4 or state
 *     checksum bad / a structural-pending marker was lost → fall back to the
 *     legacy kstate path. R1 (S4/checksum bad) and R4 (structural-pending
 *     lost) are PERMANENT for the sid (the base material is unrecoverable).
 *
 * The switch is per-session and one-way progressive (a session goes green and
 * stays green until a red gate fires); any lane desync degrades the whole
 * turn to legacy (§6, same discipline as the D-lane #3756).
 *
 * S4 SEMANTICS (invariant iii): the ckpt stores the S4 aggregate of the
 * active rows at fold time. At hydrate we recompute it over the CURRENT
 * active rows:
 *   - equal to the ckpt S4 → the rows are exactly at the ckpt state (green).
 *   - different, with NO log entry past the ckpt frontier → the rows were
 *     mutated without a recorded event = base-material corruption → R1.
 *   - different, WITH log entries past the frontier → a legitimate advance
 *     (the rows moved after the fold) → green (the in-memory kernel state is
 *     the ckpt's, slightly stale, and is re-derived on the next turn).
 */
import { s4Aggregate, stateChecksum } from "./checksums.ts";
import type { CheckpointMeta, PlaneState, SnapshotRowView, WorldEnvelopeEntry } from "./types.ts";

/** Parse the stored envelopeJson into the canon ({id, pos} entries) + the
 *  derived msgid→pos map. Accepts the current shape (a JSON array of
 *  `{id, pos}` objects) and is defensive about a bare id string (treated as
 *  `{id, pos: index+1}`). A parse failure yields an empty canon — the caller
 *  treats an unreadable world as red (no-tables). */
export function parseEnvelope(
    envelopeJson: string,
): { envelope: WorldEnvelopeEntry[]; posMap: Record<string, number> } {
    const empty = { envelope: [] as WorldEnvelopeEntry[], posMap: {} as Record<string, number> };
    let raw: unknown;
    try {
        raw = JSON.parse(envelopeJson);
    } catch {
        return empty;
    }
    if (!Array.isArray(raw)) return empty;
    const envelope: WorldEnvelopeEntry[] = [];
    const posMap: Record<string, number> = {};
    for (let i = 0; i < raw.length; i++) {
        const e = raw[i] as { id?: unknown; pos?: unknown } | string;
        let id: string;
        let pos: number;
        if (typeof e === "string") {
            id = e;
            pos = i + 1;
        } else if (e !== null && typeof e === "object" && typeof e.id === "string") {
            id = e.id;
            pos = typeof e.pos === "number" ? e.pos : i + 1;
        } else {
            continue; // a malformed entry is skipped (diagnostic, never gates)
        }
        envelope.push({ id, pos });
        posMap[id] = pos;
    }
    return { envelope, posMap };
}

/** Minimal structural shapes for the hydrate inputs (the caller passes the
 *  storage layer's L1WorldRow / SnapRow / SnapCkpt; structural typing means
 *  they satisfy these without a hard dependency, keeping this module
 *  self-contained and trivially fakeable in tests). */
export interface HydrateWorld {
    ledgerId: string;
    envelopeJson: string;
    envelopeChecksum: string;
    issuedAt: number;
    armedAt?: number | null;
}
export interface HydrateRow {
    pos: number;
    coreIds: string;
    preJson?: string | null;
    postJson: string;
    tokensEst: number;
    active: boolean;
    coverRef?: string | null;
    updatedAt: number;
}
export interface HydrateCkpt {
    ckptSeq: number;
    metaJson: string;
    checksum: string;
    updatedAt: number;
}

interface HydrateInput {
    sessionId: string;
    /** The rollout flag for this session (false → red "off"). */
    flagOn: boolean;
    /** The L1 world for the raw session key (null → no world yet). */
    world: HydrateWorld | null;
    /** ALL snap_rows for the sid (active and inactive) — the egress uses the
     *  active ones; the S4 uses the active ones. */
    rows: HydrateRow[];
    /** The latest checkpoint (null when no fold has happened yet). */
    ckpt: HydrateCkpt | null;
    /** The committed event frontier (max over log and ckpt). */
    frontier: number;
    /** A structural-pending marker was persisted but never consumed (it
     *  survived a restart) → R4 (conservatively dead, fail-safe direction). */
    structuralPending?: boolean;
}

/** Reconstruct the read-side plane. Never throws on a corrupt base — a
 *  corrupt plane is RED (R1), not a crash. */
export function hydratePlane(input: HydrateInput): PlaneState {
    if (!input.flagOn) {
        return { health: "red", reason: "off", frontier: input.frontier, turnCount: 0 };
    }
    if (input.world === null) {
        // No identity world → this sid has never been issued. A fresh session
        // issues on its first turn (stage 0); hydrating before that is "no
        // tables yet", not a fault.
        return { health: "red", reason: "no-tables", frontier: input.frontier, turnCount: 0 };
    }
    if (input.structuralPending) {
        // A persisted structural-pending marker that was never consumed means
        // the plane was mid-commit when the process died → fail-safe: dead.
        // (The session runs legacy until an explicit resync re-issues it.)
        return { health: "red", reason: "R4", frontier: input.frontier, turnCount: 0 };
    }

    const activeRows = input.rows.filter((r) => r.active);
    const currentS4 = s4Aggregate(activeRows.map((r) => ({ pos: r.pos, postJson: r.postJson })));

    let meta: CheckpointMeta | undefined;
    if (input.ckpt !== null) {
        let parsedMeta: CheckpointMeta;
        try {
            parsedMeta = JSON.parse(input.ckpt.metaJson) as CheckpointMeta;
        } catch {
            // A corrupt ckpt meta is base-material corruption → R1 (permanent).
            return { health: "red", reason: "R1", frontier: input.frontier, turnCount: 0 };
        }
        // ① the kernel-state self-checksum.
        if (stateChecksum(parsedMeta.kernelState) !== parsedMeta.stateChecksum) {
            return { health: "red", reason: "R1", frontier: input.frontier, turnCount: 0 };
        }
        // ③ the S4 aggregate vs the current rows.
        if (parsedMeta.s4 !== currentS4) {
            // Drift is legitimate only if the log advanced past the frontier
            // the ckpt recorded. The frontier is max(log, ckpt); if the log
            // has entries beyond the ckpt_seq, the rows moved legally.
            const logAdvanced = input.frontier > input.ckpt.ckptSeq;
            if (!logAdvanced) {
                // Rows changed with no recorded event → corruption → R1.
                return { health: "red", reason: "R1", frontier: input.frontier, turnCount: 0 };
            }
        }
        meta = parsedMeta;
    }

    // Green: build the read view.
    const rowMap = new Map<number, SnapshotRowView>();
    for (const r of input.rows) {
        if (!r.active) continue;
        let coreIds: string[] = [];
        try {
            const p = JSON.parse(r.coreIds);
            if (Array.isArray(p)) coreIds = p as string[];
        } catch {
            coreIds = [];
        }
        rowMap.set(r.pos, {
            pos: r.pos,
            coreIds,
            postJson: r.postJson,
            preJson: r.preJson ?? null,
            tokensEst: r.tokensEst,
            active: r.active,
            coverRef: r.coverRef ?? null,
            updatedAt: r.updatedAt,
        });
    }

    return {
        health: "green",
        world: {
            ledgerId: input.world.ledgerId,
            ...parseEnvelope(input.world.envelopeJson),
            envelopeChecksum: input.world.envelopeChecksum,
            issuedAt: input.world.issuedAt,
            armedAt: input.world.armedAt ?? undefined,
        },
        rows: rowMap,
        meta,
        frontier: input.frontier,
        turnCount: input.ckpt ? input.ckpt.ckptSeq : 0,
    };
}
