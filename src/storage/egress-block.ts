/**
 * Egress block lifecycle log — the op-log canonical history of the session's
 * compression blocks (#7577; #7439 follow-up, owner rulings
 * 2026-11-23).
 *
 * The blocks table (shipped) is a point-in-time replica: a fork copies it, a
 * reap DELETEs from it, and its content lives in the global content table via
 * hash refs. This log is the BLOCK-side twin of the egress message log
 * (egress-state.ts): an append-only op history where every row carries the
 * block's FULL snapshot (self-contained bytes — D2: zero content-CAS refs),
 * so a fork/restore reconstructs the block set from THIS log alone, at any
 * op_seq, with no blocks/orphan_blocks/checkpoints involvement.
 *
 * TWO TABLES (mirror the egress dual-table ruling):
 *   egress_block_flow   — append-only, NEVER deleted; the replay/fork
 *                         authority. PK (session_id, op_seq).
 *   egress_block_state  — read replica, ONE row per block (its latest
 *                         snapshot); the fast read of the current set.
 *                         PK (session_id, block_id).
 *
 * DUAL CLOCKS (#7577, owner ruling 2026-11-24 — the original shared-clock
 * design was rejected because it broke egress_flow's density invariant: a
 * fold's block rows were written AFTER the same turn's message rows, so the
 * next message append started two op_seqs past the last flow row and
 * applyOps' `op_seq === prevSeq + 1` check threw on every subsequent read).
 *   - The block tables number THEMSELVES: egress_block_flow.op_seq is dense
 *     within its own table (1,2,3,…), issued from MAX(egress_block_flow)+1.
 *     What the block table does internally (compress, transform, renumber)
 *     is self-contained — it never touches the flow number pool.
 *   - egress_flow keeps its EXCLUSIVE number pool and its #7574 density
 *     invariant, untouched.
 *   - Every block row carries flow_op_seq — a POINTER to the flow clock:
 *     egress_flow's MAX(op_seq) at the moment the row was written (never
 *     decreases, so the rows with flow_op_seq <= X form a prefix). A point
 *     fork at flow watermark X copies flow rows with op_seq <= X and block
 *     rows with flow_op_seq <= X, aligning the message view with the block
 *     set at that moment.
 *
 * Row types (payload = the block snapshot, the contract):
 *   I  block born       block_id required  snapshot (one fold creates it)
 *   U  state change     block_id required  snapshot (superseded active->false
 *                                          / reaped reaped->true with the full
 *                                          one+full bytes / content revision)
 *   B  compaction base  block_id NULL      {"entries": [{blockId, snapshot}],
 *                                          watermark} — ALL current blocks
 *                                          (live AND reaped) inline
 *
 * Every I/U/B row ALSO carries kstate_json — the bounded kstate residual
 * snapshot (D4) at write time. Replay takes the last sidecar with
 * op_seq <= wm (else the caller uses a fresh default).
 *
 * Any duplicate I, U with a missing target, or B without entries is a HARD
 * ERROR (EgressBlockCorruptError) — the caller degrades per the degrade
 * ladder (no fuzzy guessing, same discipline as the message log).
 */

import type { SqliteDatabase } from "./driver.js";
import type { EgressViewRow } from "./egress-state.js";
import type { CompressionState } from "acp-kernel";

/**
 * The bounded kstate residual (D4): the CompressionState fields that are NOT
 * derivable from the egress message flow + block flow. These ride on every
 * I/U/B row as `kstate_json` so a fork/rollback reconstructs the full kstate
 * from (message flow → messageRefs/tokenSnapshot/tsStamps) + (block flow →
 * blocks) + (this sidecar → the residual). `lastPassIds` is deliberately
 * EXCLUDED — it is a self-heal field (one pass of 0.0.95 semantics on a
 * restart, then rewritten) and was 652.5KB of the measured 674KB kstate_json.
 * The residual is <2KB in practice (latches/records are small and bounded).
 */
export const KSTATE_RESIDUAL_FIELDS = [
    "viewLatches", "emergencyTruncateLatch", "absorbed", "rules", "nudge",
    "stats", "terminalStreak", "nextRuleId", "deadRefs", "sweptOrphanCallIds",
    "renderDeferredRefs", "refLedgerAligned", "timestampsHighWaterRefSeq",
] as const;

export function serializeKstateResidual(state: CompressionState): string {
    const residual: Record<string, unknown> = {};
    for (const field of KSTATE_RESIDUAL_FIELDS) {
        const value = (state as unknown as Record<string, unknown>)[field];
        if (value !== undefined) residual[field] = value;
    }
    return JSON.stringify(residual);
}

/** Serialize the kstate residual from the persisted `kstateJson` (the
 *  SessionRow's serialized kernel-state fields, EXCLUDING
 *  blocks/messageRefs/deadRefs/nextBlockId/nextRunId which come from
 *  dedicated tables). `deadRefs` is not in kstateJson (it has its own table),
 *  so it is skipped here — the sidecar carries the 12 in-kstateJson residual
 *  fields. Used by the block recorder (store.ts ingest) which only has the
 *  SessionRow, not the in-memory CompressionState. */
export function serializeKstateResidualFromKstateJson(kstateJson: string): string {
    let kstate: Record<string, unknown>;
    try {
        kstate = JSON.parse(kstateJson) as Record<string, unknown>;
    } catch {
        return "{}";
    }
    const residual: Record<string, unknown> = {};
    for (const field of KSTATE_RESIDUAL_FIELDS) {
        if (field === "deadRefs") continue; // not in kstateJson (dedicated table)
        const value = kstate[field];
        if (value !== undefined) residual[field] = value;
    }
    return JSON.stringify(residual);
}

/** The in-memory kernel block set + its contents — the inputs the
 *  egress-on block recorder needs (PR #7664 A). Structurally typed so the
 *  server layer can pass Session fields directly. */
export type EgressBlockLedgerInput = {
    state: CompressionState;
    blockContents: Map<string, { one: unknown | null; full: unknown }>;
};

/** #7664 (PR-A): build the block set for the ledger from the IN-MEMORY
 *  kernel state — the unified-leg recorder's twin (store.ts ingest builds
 *  the same snapshots from its incoming rows). Coordinates resolve against
 *  the EGRESS flow view instead of unified rows (an egress-on session has
 *  none): a covered msgid still live in the view carries its canonical
 *  log_seq num; covered ids already D-retired by THIS turn (the fold shape)
 *  keep their msgid bounds with 0/0 seqs — the "unknown bounds" shape
 *  ingest uses for unresolvable coverage. The msgid bounds are the
 *  self-contained keys (ruling 7439-2); seqs are best-effort evidence on
 *  the egress clock. */
export function buildEgressBlockSnapshots(ledger: EgressBlockLedgerInput, view: readonly EgressViewRow[]): Map<string, EgressBlockSnapshot> {
    const numByMsgid = new Map<string, number>();
    for (const r of view) if (r.num > 0) numByMsgid.set(r.msgid, r.num);
    const out = new Map<string, EgressBlockSnapshot>();
    for (const b of ledger.state.blocks) {
        const c = ledger.blockContents.get(b.blockId);
        const full = c?.full ?? (b.summary === undefined ? { count: 0 } : { text: b.summary, count: 0 });
        const one = c?.one ?? null;
        let startMsgid: string | null = null;
        let endMsgid: string | null = null;
        let startSeq = 0;
        let endSeq = 0;
        for (const id of b.effectiveMessageIds) {
            const n = numByMsgid.get(id);
            if (startMsgid === null) startMsgid = id;
            endMsgid = id;
            if (n === undefined || n <= 0) continue;
            if (startSeq === 0 || n < startSeq) startSeq = n;
            if (n > endSeq) endSeq = n;
        }
        out.set(b.blockId, {
            tier: b.tier,
            startMsgid,
            startSeq,
            endMsgid,
            endSeq,
            supersedesBlockId: null,
            active: b.active,
            reaped: false,
            one: one === null ? null : JSON.stringify(one),
            full: JSON.stringify(full),
            // #7658 PR-B: the load-rebuild fields (see EgressBlockSnapshot).
            summaryText: typeof b.summary === "string" ? b.summary : null,
            runId: typeof b.runId === "string" ? b.runId : null,
            effectiveMessageIds: Array.isArray(b.effectiveMessageIds) ? [...b.effectiveMessageIds] : null,
            directMessageIds: Array.isArray(b.directMessageIds) ? [...b.directMessageIds] : null,
            directBlockIds: Array.isArray(b.directBlockIds) ? [...b.directBlockIds] : null,
            compressedTokens: typeof b.compressedTokens === "number" ? b.compressedTokens : null,
            createdAt: typeof b.createdAt === "number" ? b.createdAt : null,
            survivedCount: typeof b.survivedCount === "number" ? b.survivedCount : null,
            generation: typeof b.generation === "number" ? b.generation : null,
            expanded: b.expanded === true ? true : null,
        });
    }
    return out;
}

/** #7658 PR-B: the egress-on LOAD REBUILD overlay. Returns only the fields
 *  the op log can reconstruct — the caller Object.assigns the result onto the
 *  stored state, so every field NOT covered here keeps its stored value (the
 *  stored column remains the fallback of last resort; a failed REPLAY never
 *  reaches here — the caller catches and keeps the stored state verbatim):
 *  - the kstate residual sidecar from the LAST block-ledger row at/before the
 *    watermark (only the fields the sidecar actually carries — a corrupt or
 *    absent sidecar keeps the stored fields);
 *  - state.blocks from the ledger replay (the self-contained snapshots incl.
 *    the PR-B rebuild fields; pre-PR-B rows rebuild with empty coverage —
 *    inert but present, same as the #3573 no-persisted-blocks shape);
 *  - messageRefs derived from the LIVE message-flow rows (row.msgid IS the
 *    kernel raw id, row.ref the padded ref; num 0 = not numbered yet);
 *  - tsStamps from the flow rows' first-observed ts (#7577 D3, the same
 *    derivation as store.egressTsStamps).
 *  lastPassIds is deliberately NOT rebuilt — it is a self-heal field
 *  (excluded from the sidecar by design; one 0.95-semantics pass on restart
 *  rewrites it). */
export function rebuildEgressKstateOverlay(
    blockReplay: { blocks: Map<string, EgressBlockSnapshot>; kstate: string | null },
    view: readonly EgressViewRow[],
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (blockReplay.kstate !== null) {
        try {
            const sidecar = JSON.parse(blockReplay.kstate) as Record<string, unknown>;
            for (const field of KSTATE_RESIDUAL_FIELDS) {
                if (sidecar[field] !== undefined) out[field] = sidecar[field];
            }
        } catch {
            // corrupt sidecar: keep the stored fields for this turn.
        }
    }
    if (blockReplay.blocks.size > 0) {
        out["blocks"] = [...blockReplay.blocks.entries()].map(([blockId, s]) => ({
            blockId,
            runId: s.runId ?? "",
            tier: s.tier,
            topic: undefined,
            summary: s.summaryText ?? "",
            directMessageIds: s.directMessageIds ?? [],
            effectiveMessageIds: s.effectiveMessageIds ?? [],
            directBlockIds: s.directBlockIds ?? [],
            compressedTokens: s.compressedTokens ?? 0,
            createdAt: s.createdAt ?? 0,
            survivedCount: s.survivedCount ?? 0,
            generation: (s.generation ?? 1) as 1,
            active: s.active,
            ...(s.expanded === true ? { expanded: true } : {}),
        }));
    }
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    const tsStamps: Record<string, number> = {};
    for (const row of view) {
        if (row.num <= 0 || row.msgid === undefined || row.msgid === "") continue;
        const ref = typeof row.ref === "string" && row.ref.length > 0 ? row.ref : "m" + String(row.num).padStart(5, "0");
        byRaw[row.msgid] = ref;
        byRef[ref] = row.msgid;
        if (row.ts !== undefined) tsStamps[row.msgid] = row.ts;
    }
    if (Object.keys(byRaw).length > 0) out["messageRefs"] = { byRaw, byRef };
    if (Object.keys(tsStamps).length > 0) out["tsStamps"] = tsStamps;
    return out;
}

export class EgressBlockCorruptError extends Error {
    constructor(readonly sessionId: string, readonly reason: string) {
        super(`egress-block corrupt (session=${sessionId}): ${reason}`);
        this.name = "EgressBlockCorruptError";
    }
}

/** One block's full snapshot — the self-contained payload of an I/U row, a
 *  state-replica row, and a B-row entry. `one` is the one-line summary (JSON
 *  or null), `full` is the full block content (JSON). The coordinates
 *  (seq/msgid) describe the block's coverage; the content is self-contained
 *  (D2: zero content-CAS refs — replay/fork need nothing but this log). */
export interface EgressBlockSnapshot {
    tier: number;
    startMsgid: string | null;
    startSeq: number;
    endMsgid: string | null;
    endSeq: number;
    supersedesBlockId: string | null;
    active: boolean;
    reaped: boolean;
    one: string | null;
    full: string;
    /** #7658 PR-B: the kernel fields a LOAD REBUILD of state.blocks needs —
     *  carried in the JSON payload (probe-first: old rows and legacy-leg
     *  writers simply omit them, and parseSnapshot keeps null/empty
     *  defaults). The msgid coverage is the self-contained identity;
     *  everything else is display/behavior state. */
    summaryText?: string | null | undefined;
    runId?: string | null | undefined;
    effectiveMessageIds?: string[] | null | undefined;
    directMessageIds?: string[] | null | undefined;
    directBlockIds?: string[] | null | undefined;
    compressedTokens?: number | null | undefined;
    createdAt?: number | null | undefined;
    survivedCount?: number | null | undefined;
    generation?: number | null | undefined;
    /** Host-set decompress flag (CompressionBlock.expanded) — the ledger is
     *  its only durable home (it is not in the kstate residual sidecar). */
    expanded?: boolean | null | undefined;
}

export interface EgressBlockInsertOp {
    type: "I";
    blockId: string;
    snapshot: EgressBlockSnapshot;
}
export interface EgressBlockUpdateOp {
    type: "U";
    blockId: string;
    snapshot: EgressBlockSnapshot;
}
export type EgressBlockOp = EgressBlockInsertOp | EgressBlockUpdateOp;

type EgressBlockRowType = "B" | "I" | "U";

interface EgressBlockRow {
    op_seq: number;
    flow_op_seq: number;
    row_type: EgressBlockRowType;
    block_id: string | null;
    payload: string;
    kstate_json: string | null;
}

interface EgressBlockStateRow {
    op_seq: number;
    flow_op_seq: number;
    block_id: string;
    payload: string;
}

const INSERT_BLOCK_STATE = `INSERT INTO egress_block_state (session_id, block_id, op_seq, flow_op_seq, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, block_id) DO UPDATE SET op_seq = excluded.op_seq, flow_op_seq = excluded.flow_op_seq, payload = excluded.payload, created_at = excluded.created_at`;
const INSERT_BLOCK_FLOW = `INSERT INTO egress_block_flow (session_id, op_seq, flow_op_seq, row_type, block_id, payload, kstate_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/** The block table's OWN next op_seq: dense within egress_block_flow
 *  (dual-clock ruling — the flow number pool is NOT consulted). Must be read
 *  INSIDE the write transaction (#7574 discipline). */
function blockNextSeq(db: SqliteDatabase, sessionId: string): number {
    const block = db
        .prepare("SELECT COALESCE(MAX(op_seq), 0) AS o FROM egress_block_flow WHERE session_id = ?")
        .get(sessionId) as { o: number } | undefined;
    return (Number(block?.o) || 0) + 1;
}

/** The flow watermark: egress_flow's MAX(op_seq) at write time — the pointer
 *  recorded on every block row. Read INSIDE the write transaction (after any
 *  flow rows the current turn just appended), so it reflects "what the flow
 *  clock said at the moment this block state landed". */
function flowWatermark(db: SqliteDatabase, sessionId: string): number {
    const flow = db
        .prepare("SELECT COALESCE(MAX(op_seq), 0) AS o FROM egress_flow WHERE session_id = ?")
        .get(sessionId) as { o: number } | undefined;
    return Number(flow?.o) || 0;
}

function snapshotEqual(a: EgressBlockSnapshot, b: EgressBlockSnapshot): boolean {
    return a.tier === b.tier
        && a.startMsgid === b.startMsgid
        && a.startSeq === b.startSeq
        && a.endMsgid === b.endMsgid
        && a.endSeq === b.endSeq
        && a.supersedesBlockId === b.supersedesBlockId
        && a.active === b.active
        && a.reaped === b.reaped
        && a.one === b.one
        && a.full === b.full;
}

function parseSnapshot(sessionId: string, opSeq: number, payload: string): EgressBlockSnapshot {
    let p: Record<string, unknown>;
    try {
        p = JSON.parse(payload) as Record<string, unknown>;
    } catch {
        throw new EgressBlockCorruptError(sessionId, `payload at op_seq=${opSeq} is not an object`);
    }
    if (typeof p.tier !== "number" || typeof p.active !== "boolean" || typeof p.reaped !== "boolean" || typeof p.full !== "string") {
        throw new EgressBlockCorruptError(sessionId, `malformed snapshot at op_seq=${opSeq}`);
    }
    return {
        tier: p.tier,
        startMsgid: typeof p.startMsgid === "string" ? p.startMsgid : null,
        startSeq: typeof p.startSeq === "number" ? p.startSeq : 0,
        endMsgid: typeof p.endMsgid === "string" ? p.endMsgid : null,
        endSeq: typeof p.endSeq === "number" ? p.endSeq : 0,
        supersedesBlockId: typeof p.supersedesBlockId === "string" ? p.supersedesBlockId : null,
        active: p.active,
        reaped: p.reaped,
        one: typeof p.one === "string" ? p.one : null,
        full: p.full,
        // #7658 PR-B rebuild fields — probe-first: pre-PR-B rows lack them.
        summaryText: typeof p.summaryText === "string" ? p.summaryText : null,
        runId: typeof p.runId === "string" ? p.runId : null,
        effectiveMessageIds: Array.isArray(p.effectiveMessageIds) ? (p.effectiveMessageIds as string[]) : null,
        directMessageIds: Array.isArray(p.directMessageIds) ? (p.directMessageIds as string[]) : null,
        directBlockIds: Array.isArray(p.directBlockIds) ? (p.directBlockIds as string[]) : null,
        compressedTokens: typeof p.compressedTokens === "number" ? p.compressedTokens : null,
        createdAt: typeof p.createdAt === "number" ? p.createdAt : null,
        survivedCount: typeof p.survivedCount === "number" ? p.survivedCount : null,
        generation: typeof p.generation === "number" ? p.generation : null,
        expanded: typeof p.expanded === "boolean" ? p.expanded : null,
    };
}

/** Deterministic diff between the previous block set (live + reaped, from the
 *  state replica) and the current LIVE set. New blocks emit I; changed blocks
 *  emit U; a block that was live but left the set emits a terminal U with
 *  reaped=true (D6: the reap is a log row carrying the full bytes, not a
 *  DELETE + orphan_blocks copy). A reaped block that stays reaped emits
 *  nothing. Order is irrelevant to correctness (blocks key on block_id, not
 *  position) but is deterministic: next-set order, then prev-only order. */
export function diffBlockSet(
    prev: Map<string, EgressBlockSnapshot>,
    next: Map<string, EgressBlockSnapshot>,
): EgressBlockOp[] {
    const ops: EgressBlockOp[] = [];
    for (const [blockId, snap] of next) {
        const old = prev.get(blockId);
        if (old === undefined) {
            ops.push({ type: "I", blockId, snapshot: snap });
        } else if (!snapshotEqual(old, snap)) {
            ops.push({ type: "U", blockId, snapshot: snap });
        }
    }
    for (const [blockId, old] of prev) {
        if (!next.has(blockId) && !old.reaped) {
            ops.push({ type: "U", blockId, snapshot: { ...old, reaped: true } });
        }
    }
    return ops;
}

/** Append a batch of I/U ops to BOTH tables (flow + state) in ONE
 *  transaction. Every row gets the next op_seq from the block table's OWN
 *  number pool (dual clocks) plus the flow watermark pointer and the kstate
 *  sidecar; the state replica is upserted per block. Returns the assigned
 *  op_seqs in input order. */
export function egressBlockAppend(
    db: SqliteDatabase,
    sessionId: string,
    ops: EgressBlockOp[],
    kstateJson: string | null,
    nowMs: number,
): number[] {
    if (ops.length === 0) return [];
    // #7577 (b-fix): the state replica read (validation) and the next op_seq
    // are read INSIDE the write transaction — the same discipline the message
    // log established in #7574: never read before the transaction.
    let firstOpSeq = 0;
    db.transaction(() => {
        // Validate against the current state replica: duplicate I and U on a
        // missing target are corrupt (the block log is append-only; a block is
        // born exactly once).
        const current = egressBlockView(db, sessionId);
        for (const op of ops) {
            const existing = current.get(op.blockId);
            if (op.type === "I" && existing !== undefined) {
                throw new EgressBlockCorruptError(sessionId, `duplicate I for block ${op.blockId}`);
            }
            if (op.type === "U" && existing === undefined) {
                throw new EgressBlockCorruptError(sessionId, `U for missing block ${op.blockId}`);
            }
        }
        firstOpSeq = blockNextSeq(db, sessionId);
        const wm = flowWatermark(db, sessionId);
        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            const opSeq = firstOpSeq + i;
            const payload = JSON.stringify(op.snapshot);
            db.prepare(INSERT_BLOCK_FLOW).run(sessionId, opSeq, wm, op.type, op.blockId, payload, kstateJson, nowMs);
            db.prepare(INSERT_BLOCK_STATE).run(sessionId, op.blockId, opSeq, wm, payload, nowMs);
        }
    });
    return Array.from({ length: ops.length }, (_, i) => firstOpSeq + i);
}

/** Read the STATE replica into the current block set (live + reaped, latest
 *  snapshot per block). The fast read for the per-turn diff. Throws
 *  EgressBlockCorruptError on a malformed row. */
export function egressBlockView(db: SqliteDatabase, sessionId: string): Map<string, EgressBlockSnapshot> {
    const rows = db
        .prepare("SELECT op_seq, flow_op_seq, block_id, payload FROM egress_block_state WHERE session_id = ? ORDER BY op_seq ASC")
        .all(sessionId) as unknown as EgressBlockStateRow[];
    const blocks = new Map<string, EgressBlockSnapshot>();
    for (const row of rows) {
        if (typeof row.block_id !== "string") throw new EgressBlockCorruptError(sessionId, `state row at op_seq=${row.op_seq} has no block_id`);
        blocks.set(row.block_id, parseSnapshot(sessionId, row.op_seq, row.payload));
    }
    return blocks;
}

/** Replay the FLOW table up to (and including) op_seq x — the fork/rollback
 *  reconstruction. A B row resets the set to its entries; I/U rows after it
 *  are applied in op_seq order. Returns the block set AND the kstate sidecar
 *  from the last row (B/I/U) with op_seq <= x (null = no sidecar yet — the
 *  caller uses a fresh default). Throws like egressBlockView. */
export function egressBlockReplay(
    db: SqliteDatabase,
    sessionId: string,
    x: number,
): { blocks: Map<string, EgressBlockSnapshot>; kstate: string | null } {
    const rows = db
        .prepare(
            "SELECT op_seq, flow_op_seq, row_type, block_id, payload, kstate_json FROM egress_block_flow WHERE session_id = ? AND op_seq <= ? ORDER BY op_seq ASC",
        )
        .all(sessionId, x) as unknown as EgressBlockRow[];
    const blocks = new Map<string, EgressBlockSnapshot>();
    let kstate: string | null = null;
    let prevSeq = 0;
    for (const row of rows) {
        // Dual clocks: the block table numbers itself — its own op_seq must
        // be dense (1,2,3,…). A gap means a missing row (corruption); unlike
        // the flow table (whose rows can legally be truncated by compaction
        // bases), the block flow is append-only with no row deletion, so the
        // prefix is always complete. A point-forked child inherits a prefix
        // (watermarks are non-decreasing, so flow_op_seq <= X is a prefix),
        // hence dense too.
        if (row.op_seq !== prevSeq + 1) {
            throw new EgressBlockCorruptError(sessionId, `op_seq jumps from ${prevSeq} to ${row.op_seq}`);
        }
        prevSeq = row.op_seq;
        if (row.kstate_json !== null) kstate = row.kstate_json;
        if (row.row_type === "B") {
            let parsed: { entries?: Array<{ blockId: string; snapshot: EgressBlockSnapshot }> };
            try {
                parsed = JSON.parse(row.payload) as typeof parsed;
            } catch {
                throw new EgressBlockCorruptError(sessionId, `base at op_seq=${row.op_seq} is not an object`);
            }
            if (!Array.isArray(parsed.entries)) throw new EgressBlockCorruptError(sessionId, `base at op_seq=${row.op_seq} has no entries`);
            blocks.clear();
            for (const e of parsed.entries) {
                if (typeof e.blockId !== "string") throw new EgressBlockCorruptError(sessionId, `base at op_seq=${row.op_seq} has a malformed entry`);
                blocks.set(e.blockId, { ...e.snapshot });
            }
        } else if (row.row_type === "I") {
            if (typeof row.block_id !== "string") throw new EgressBlockCorruptError(sessionId, `insert at op_seq=${row.op_seq} has no block_id`);
            if (blocks.has(row.block_id)) throw new EgressBlockCorruptError(sessionId, `duplicate block ${row.block_id} at op_seq=${row.op_seq}`);
            blocks.set(row.block_id, parseSnapshot(sessionId, row.op_seq, row.payload));
        } else if (row.row_type === "U") {
            if (typeof row.block_id !== "string") throw new EgressBlockCorruptError(sessionId, `update at op_seq=${row.op_seq} has no block_id`);
            if (!blocks.has(row.block_id)) throw new EgressBlockCorruptError(sessionId, `update target ${row.block_id} missing at op_seq=${row.op_seq}`);
            blocks.set(row.block_id, parseSnapshot(sessionId, row.op_seq, row.payload));
        } else {
            throw new EgressBlockCorruptError(sessionId, `unknown row_type ${String(row.row_type)} at op_seq=${row.op_seq}`);
        }
    }
    return { blocks, kstate };
}

/** Compaction: persist the current block set as a new base row (B) in the
 *  FLOW (all blocks — live AND reaped — inline), as a fast-forward point for
 *  replay. The flow is append-only (no row deletion); the state replica is
 *  untouched (it is already one row per block). One transaction. */
export function egressBlockCompact(
    db: SqliteDatabase,
    sessionId: string,
    blocks: Map<string, EgressBlockSnapshot>,
    kstateJson: string | null,
    nowMs: number,
): number {
    let seq = 0;
    db.transaction(() => {
        // #7577 (b-fix): read the next op_seq inside the transaction
        // (#7574 discipline — never before it).
        seq = blockNextSeq(db, sessionId);
        const entries = Array.from(blocks.entries()).map(([blockId, snapshot]) => ({ blockId, snapshot }));
        const payload = JSON.stringify({ entries, watermark: seq });
        db.prepare(INSERT_BLOCK_FLOW).run(sessionId, seq, flowWatermark(db, sessionId), "B", null, payload, kstateJson, nowMs);
    });
    return seq;
}

/** Point fork (#7577 D5, dual-clock ruling): wm is a FLOW watermark
 *  (egress_flow's op_seq space). Copy the parent's egress op logs with
 *  op_seq <= wm and the block op logs with flow_op_seq <= wm (the pointer
 *  column — block rows carry their own op_seq clock, so filtering them by
 *  their op_seq would align two unrelated clocks) to the child session_id,
 *  inside ONE transaction. op_seq/log_seq are preserved verbatim, so the
 *  child inherits the parent's number space (nothing re-issued across the
 *  fork). wm >= the parent's flow MAX is the whole-copy special case (the
 *  existing egressFork path). Pre-existing child rows are replaced (an
 *  idempotent re-fork of the same parent pair). Returns the number of
 *  egress_flow rows copied. */
export function egressPointFork(db: SqliteDatabase, fromSessionId: string, toSessionId: string, wm: number): number {
    if (fromSessionId === toSessionId) throw new Error("egressPointFork: conflicting fork lineage (child equals parent)");
    return db.transaction(() => {
        // #7577 (a): fork-to-now fast path. The flow clock is the reference
        // clock: when wm covers the parent's flow high water, every block row
        // (whose flow_op_seq pointer <= flow MAX by construction) is in
        // scope, and BOTH state replicas are already the correct child state
        // (egress_state compacted as base + window, block state one row per
        // live block) — copy all four tables straight by SQL. The replay
        // below would instead materialize the child's egress_state as the
        // FULL uncompacted flow (every historical B base row is a whole-view
        // snapshot — ~8MB at 100k messages), making the fork transaction
        // O(total history) and every later turn's prev-read a full-history
        // JS replay until the child's first fold. Only a true point fork
        // (wm < flow high water) needs the replay.
        const parentFlowMax = (db.prepare("SELECT COALESCE(MAX(op_seq), 0) AS m FROM egress_flow WHERE session_id = ?").get(fromSessionId) as { m: number }).m;
        const forkToNow = wm >= parentFlowMax;
        const n = db
            .prepare(forkToNow
                ? "SELECT COUNT(*) AS c FROM egress_flow WHERE session_id = ?"
                : "SELECT COUNT(*) AS c FROM egress_flow WHERE session_id = ? AND op_seq <= ?")
            .get(...(forkToNow ? [fromSessionId] : [fromSessionId, wm])) as { c: number };
        db.prepare("DELETE FROM egress_state WHERE session_id = ?").run(toSessionId);
        db.prepare("DELETE FROM egress_flow WHERE session_id = ?").run(toSessionId);
        db.prepare("DELETE FROM egress_block_state WHERE session_id = ?").run(toSessionId);
        db.prepare("DELETE FROM egress_block_flow WHERE session_id = ?").run(toSessionId);
        if (forkToNow) {
            db.prepare(
                `INSERT INTO egress_flow (session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at)
                 SELECT ?, op_seq, log_seq, row_type, msgid, payload, bytes, created_at FROM egress_flow WHERE session_id = ?`,
            ).run(toSessionId, fromSessionId);
            db.prepare(
                `INSERT INTO egress_block_flow (session_id, op_seq, flow_op_seq, row_type, block_id, payload, kstate_json, created_at)
                 SELECT ?, op_seq, flow_op_seq, row_type, block_id, payload, kstate_json, created_at FROM egress_block_flow WHERE session_id = ?`,
            ).run(toSessionId, fromSessionId);
            db.prepare(
                `INSERT INTO egress_state (session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at)
                 SELECT ?, op_seq, log_seq, row_type, msgid, payload, bytes, created_at FROM egress_state WHERE session_id = ?`,
            ).run(toSessionId, fromSessionId);
            db.prepare(
                `INSERT INTO egress_block_state (session_id, block_id, op_seq, flow_op_seq, payload, created_at)
                 SELECT ?, block_id, op_seq, flow_op_seq, payload, created_at FROM egress_block_state WHERE session_id = ?`,
            ).run(toSessionId, fromSessionId);
            return Number(n.c);
        }
        // True point fork: copy the FLOW tables (append-only, op_seq <= wm).
        db.prepare(
            `INSERT INTO egress_flow (session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at)
             SELECT ?, op_seq, log_seq, row_type, msgid, payload, bytes, created_at FROM egress_flow WHERE session_id = ? AND op_seq <= ?`,
        ).run(toSessionId, fromSessionId, wm);
        // Block rows align on the FLOW clock via their pointer column
        // (dual clocks: their own op_seq is unrelated to wm).
        db.prepare(
            `INSERT INTO egress_block_flow (session_id, op_seq, flow_op_seq, row_type, block_id, payload, kstate_json, created_at)
             SELECT ?, op_seq, flow_op_seq, row_type, block_id, payload, kstate_json, created_at FROM egress_block_flow WHERE session_id = ? AND flow_op_seq <= ?`,
        ).run(toSessionId, fromSessionId, wm);
        // Rebuild the STATE replicas by replaying the flow tables up to wm
        // (the state tables are read-replicas of the latest snapshot per
        // key; a direct copy filtered by op_seq would miss blocks whose
        // latest row is past wm).
        const egressRows = db
            .prepare("SELECT op_seq, log_seq, row_type, msgid, payload, bytes, created_at FROM egress_flow WHERE session_id = ? AND op_seq <= ? ORDER BY op_seq ASC")
            .all(toSessionId, wm) as unknown as { op_seq: number; log_seq: number | null; row_type: string; msgid: string | null; payload: string; bytes: string | null; created_at: number }[];
        for (const row of egressRows) {
            db.prepare(
                "INSERT OR REPLACE INTO egress_state (session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(toSessionId, row.op_seq, row.log_seq, row.row_type, row.msgid, row.payload, row.bytes, row.created_at);
        }
        const blockRows = db
            .prepare("SELECT op_seq, flow_op_seq, row_type, block_id, payload, created_at FROM egress_block_flow WHERE session_id = ? AND flow_op_seq <= ? ORDER BY op_seq ASC")
            .all(toSessionId, wm) as unknown as { op_seq: number; flow_op_seq: number; row_type: string; block_id: string | null; payload: string; created_at: number }[];
        for (const row of blockRows) {
            if (row.row_type === "B" || row.block_id === null) continue;
            db.prepare(
                "INSERT OR REPLACE INTO egress_block_state (session_id, block_id, op_seq, flow_op_seq, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(toSessionId, row.block_id, row.op_seq, row.flow_op_seq, row.payload, row.created_at);
        }
        return Number(n.c);
    });
}
