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
 * TWO TABLES (mirror the egress dual-table ruling, 7773 materialized form):
 *   eg_block_flow   — append-only, NEVER deleted; the record/replay/
 *                         fork authority. PK (session_id, op_seq).
 *   eg_block_state  — MATERIALIZED live view: one row per LIVE block
 *                         (PK (session_id, block_id), pos = its position in
 *                         the current set). I inserts, U edits in place,
 *                         D physically deletes the row. Serving reads are
 *                         `ORDER BY pos` DIRECT reads — no replay.
 *
 * THE ROW ALPHABET (7773): I / U / D — there is no B base row (not written,
 * not read, no DDL CHECK entry) and no compaction: the flow keeps every row
 * forever; growth optimization is a separate, deferred project.
 *
 * DUAL CLOCKS (#7577, owner ruling 2026-11-24 — the original shared-clock
 * design was rejected because it broke eg_flow's density invariant: a
 * fold's block rows were written AFTER the same turn's message rows, so the
 * next message append started two op_seqs past the last flow row and
 * applyOps' `op_seq === prevSeq + 1` check threw on every subsequent read).
 *   - The block tables number THEMSELVES: eg_block_flow.op_seq is dense
 *     within its own table (1,2,3,…), issued from MAX(eg_block_flow)+1.
 *     What the block table does internally (compress, transform, renumber)
 *     is self-contained — it never touches the flow number pool.
 *   - eg_flow keeps its EXCLUSIVE number pool and its #7574 density
 *     invariant, untouched.
 *   - Every block row carries flow_op_seq — a POINTER to the flow clock:
 *     eg_flow's MAX(op_seq) at the moment the row was written (never
 *     decreases, so the rows with flow_op_seq <= X form a prefix). A point
 *     fork at flow watermark X copies flow rows with op_seq <= X and block
 *     rows with flow_op_seq <= X, aligning the message view with the block
 *     set at that moment.
 *
 * Row types (payload = the block snapshot, the contract):
 *   I  block born       block_id required  snapshot (one fold creates it)
 *   U  state change     block_id required  snapshot (superseded active->false
 *                                          / content revision)
 *   D  reaped           block_id required  snapshot — the TERMINAL full
 *                                          snapshot (reaped=true, full
 *                                          one+full bytes): the reap is a
 *                                          log row carrying the full bytes,
 *                                          not a DELETE + orphan_blocks copy
 *                                          (D6, re-lettered at 7773: the old
 *                                          terminal-U is now a D row, and the
 *                                          state replica deletes its row)
 *
 * Every I/U/D row ALSO carries kstate_json — the bounded kstate residual
 * snapshot (D4) at write time. Replay takes the last sidecar with
 * op_seq <= wm (else the caller uses a fresh default).
 *
 * Any duplicate I, U with a missing target, or D with a missing target is a
 * HARD ERROR (EgressBlockCorruptError) — the caller degrades per the degrade
 * ladder (no fuzzy guessing, same discipline as the message log).
 */

import type { SqliteDatabase } from "./driver.js";
import { egressMaterializeState, egressStateAt, LEDGER_GENERATION, type EgressViewRow } from "./egress-state.js";
import { egressUsageForkCopy, egressUsageForkCopyPrefix } from "./egress-usage.js";
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

interface EgressBlockInsertOp {
    type: "I";
    blockId: string;
    snapshot: EgressBlockSnapshot;
}
interface EgressBlockUpdateOp {
    type: "U";
    blockId: string;
    snapshot: EgressBlockSnapshot;
}
interface EgressBlockDeleteOp {
    type: "D";
    blockId: string;
    /** The TERMINAL full snapshot (reaped=true) — the D row is self-
     * contained: replay needs nothing but the flow. */
    snapshot: EgressBlockSnapshot;
}
export type EgressBlockOp = EgressBlockInsertOp | EgressBlockUpdateOp | EgressBlockDeleteOp;

/** 'G' is not an op — it is the GENERATION BOUNDARY row (discussions/7896),
 * the block-side twin of eg_flow's G row: a trust boundary written when the
 * writer's LEDGER_GENERATION differs from the flow's last row. Its payload
 * snapshots the FULL live block set (block_id/pos/snapshot) and its
 * kstate_json sidecar carries the kstate at the boundary; replays start
 * from the latest G at or below their target, so the pre-G prefix (written
 * under an older semantics) is never judged by the new law. */
type EgressBlockRowType = "I" | "U" | "D" | "G";

interface EgressBlockRow {
    op_seq: number;
    flow_op_seq: number;
    row_type: EgressBlockRowType;
    block_id: string | null;
    payload: string;
    kstate_json: string | null;
    gen: number;
}

interface EgressBlockStateRow {
    pos: number;
    op_seq: number;
    flow_op_seq: number;
    block_id: string;
    payload: string;
}

const INSERT_BLOCK_STATE = `INSERT INTO eg_block_state (session_id, block_id, pos, op_seq, flow_op_seq, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const UPDATE_BLOCK_STATE = `UPDATE eg_block_state SET op_seq = ?, flow_op_seq = ?, payload = ?, created_at = ? WHERE session_id = ? AND block_id = ?`;
const DELETE_BLOCK_STATE = `DELETE FROM eg_block_state WHERE session_id = ? AND block_id = ?`;
const INSERT_BLOCK_FLOW = `INSERT INTO eg_block_flow (session_id, op_seq, flow_op_seq, row_type, block_id, payload, kstate_json, gen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Decode + validate a 'G' boundary row's payload (discussions/7896) into
 * the live block set it snapshots. Throws EgressBlockCorruptError on any
 * malformation. Rows are positional: {block_id, pos, payload(snapshot)}. */
function decodeBlockGenSnapshot(sessionId: string, row: EgressBlockRow): Map<string, EgressBlockSnapshot> {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
        throw new EgressBlockCorruptError(sessionId, `G boundary at op_seq=${row.op_seq} is not an object`);
    }
    if (parsed.gen !== LEDGER_GENERATION) {
        throw new EgressBlockCorruptError(sessionId, `G boundary at op_seq=${row.op_seq} names an unknown generation ${String(parsed.gen)}`);
    }
    if (!Array.isArray(parsed.rows)) {
        throw new EgressBlockCorruptError(sessionId, `G boundary at op_seq=${row.op_seq} has no rows array`);
    }
    const blocks = new Map<string, EgressBlockSnapshot>();
    for (let i = 0; i < parsed.rows.length; i++) {
        const o = parsed.rows[i] as Record<string, unknown>;
        if (typeof o?.block_id !== "string" || !Number.isInteger(o.pos) || (o.pos as number) < 0 || typeof o.payload !== "string") {
            throw new EgressBlockCorruptError(sessionId, `G boundary at op_seq=${row.op_seq} has a malformed snapshot row ${i}`);
        }
        if (blocks.has(o.block_id)) {
            throw new EgressBlockCorruptError(sessionId, `G boundary at op_seq=${row.op_seq} has a duplicate block ${o.block_id}`);
        }
        if ((o.pos as number) !== blocks.size) {
            throw new EgressBlockCorruptError(sessionId, `G boundary at op_seq=${row.op_seq} pos jumps from ${blocks.size} to ${o.pos} (block ${o.block_id})`);
        }
        blocks.set(o.block_id, JSON.parse(o.payload) as EgressBlockSnapshot);
    }
    return blocks;
}

/** The block table's OWN next op_seq: dense within eg_block_flow
 *  (dual-clock ruling — the flow number pool is NOT consulted). Must be read
 *  INSIDE the write transaction (#7574 discipline). */
function blockNextSeq(db: SqliteDatabase, sessionId: string): number {
    const block = db
        .prepare("SELECT COALESCE(MAX(op_seq), 0) AS o FROM eg_block_flow WHERE session_id = ?")
        .get(sessionId) as { o: number } | undefined;
    return (Number(block?.o) || 0) + 1;
}

/** The flow watermark: eg_flow's MAX(op_seq) at write time — the pointer
 *  recorded on every block row. Read INSIDE the write transaction (after any
 *  flow rows the current turn just appended), so it reflects "what the flow
 *  clock said at the moment this block state landed". */
function flowWatermark(db: SqliteDatabase, sessionId: string): number {
    const flow = db
        .prepare("SELECT COALESCE(MAX(op_seq), 0) AS o FROM eg_flow WHERE session_id = ?")
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

/** Deterministic diff between the previous LIVE set (the materialized state
 *  view — reaped blocks are physically gone from it) and the current LIVE
 *  set. New blocks emit I; changed blocks emit U; a block that was live but
 *  left the set emits a D carrying the TERMINAL snapshot (reaped=true — D6,
 *  re-lettered at 7773: the reap is a self-contained log row carrying the
 *  full bytes, and the state deletes its row). Order is irrelevant to
 *  correctness (blocks key on block_id, not position) but is deterministic:
 *  next-set order, then prev-only order. */
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
        if (!next.has(blockId)) {
            ops.push({ type: "D", blockId, snapshot: { ...old, reaped: true } });
        }
    }
    return ops;
}

/** Append a batch of I/U/D ops to BOTH tables (flow + state) in ONE
 *  transaction (single source of truth, 7773). Every row gets the next
 *  op_seq from the block table's OWN number pool (dual clocks) plus the flow
 *  watermark pointer and the kstate sidecar; the state takes the same ops in
 *  place: I inserts at the next pos, U edits the row in place, D deletes it.
 *  After the apply, the state's row count is asserted against the live count
 *  implied by the ops (7773 §6 invariant 2, enforced at every write).
 *  Returns the assigned op_seqs in input order. */
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
        // Validate against the current materialized live view: duplicate I
        // and U/D on a missing target are corrupt (the block log is
        // append-only; a block is born exactly once and dies exactly once).
        const current = egressBlockView(db, sessionId);
        let live = current.size;
        for (const op of ops) {
            const existing = current.get(op.blockId);
            if (op.type === "I") {
                if (existing !== undefined) throw new EgressBlockCorruptError(sessionId, `duplicate I for block ${op.blockId}`);
                live++;
            } else {
                if (existing === undefined) throw new EgressBlockCorruptError(sessionId, `${op.type} for missing block ${op.blockId}`);
                if (op.type === "D") live--;
            }
        }
        firstOpSeq = blockNextSeq(db, sessionId);
        const wm = flowWatermark(db, sessionId);
        // 7896: close a cross-generation prefix with a G boundary row before
        // the new ops (same rule as the message log; the snapshot is the
        // current materialized block set, read BEFORE any of the new ops).
        const lastGen = db
            .prepare("SELECT gen FROM eg_block_flow WHERE session_id = ? ORDER BY op_seq DESC LIMIT 1")
            .get(sessionId) as { gen: number } | undefined;
        if (lastGen !== undefined && lastGen.gen !== LEDGER_GENERATION) {
            const liveRows = db
                .prepare("SELECT block_id, pos, payload FROM eg_block_state WHERE session_id = ? ORDER BY pos ASC")
                .all(sessionId) as unknown as { block_id: string; pos: number; payload: string }[];
            const lastKstate = db
                .prepare("SELECT kstate_json FROM eg_block_flow WHERE session_id = ? AND kstate_json IS NOT NULL ORDER BY op_seq DESC LIMIT 1")
                .get(sessionId) as { kstate_json: string | null } | undefined;
            db.prepare(INSERT_BLOCK_FLOW).run(
                sessionId, firstOpSeq, wm, "G", null,
                JSON.stringify({ gen: LEDGER_GENERATION, rows: liveRows }),
                kstateJson ?? lastKstate?.kstate_json ?? null,
                LEDGER_GENERATION, nowMs,
            );
            firstOpSeq += 1;
        }
        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            const opSeq = firstOpSeq + i;
            const payload = JSON.stringify(op.snapshot);
            db.prepare(INSERT_BLOCK_FLOW).run(sessionId, opSeq, wm, op.type, op.blockId, payload, kstateJson, LEDGER_GENERATION, nowMs);
            if (op.type === "I") {
                const pos = (db.prepare("SELECT COALESCE(MAX(pos), -1) AS p FROM eg_block_state WHERE session_id = ?").get(sessionId) as { p: number }).p + 1;
                db.prepare(INSERT_BLOCK_STATE).run(sessionId, op.blockId, pos, opSeq, wm, payload, nowMs);
            } else if (op.type === "U") {
                db.prepare(UPDATE_BLOCK_STATE).run(opSeq, wm, payload, nowMs, sessionId, op.blockId);
            } else {
                const p = db
                    .prepare("SELECT pos FROM eg_block_state WHERE session_id = ? AND block_id = ?")
                    .get(sessionId, op.blockId) as { pos: number } | undefined;
                if (p === undefined) throw new EgressBlockCorruptError(sessionId, `state apply: delete target ${op.blockId} missing`);
                db.prepare(DELETE_BLOCK_STATE).run(sessionId, op.blockId);
                // close the pos gap: the rows behind the deleted one shift up
                // by one (the state view is dense by construction)
                db.prepare("UPDATE eg_block_state SET pos = pos - 1 WHERE session_id = ? AND pos > ?").run(sessionId, p.pos);
            }
        }
        const n = db.prepare("SELECT COUNT(*) AS c FROM eg_block_state WHERE session_id = ?").get(sessionId) as { c: number };
        if (Number(n.c) !== live) {
            throw new EgressBlockCorruptError(sessionId, `state apply diverged: ${Number(n.c)} rows but the batch implies ${live} live blocks`);
        }
    });
    return Array.from({ length: ops.length }, (_, i) => firstOpSeq + i);
}

/** Direct read of the MATERIALIZED live view (the serving fast path — ORDER
 *  BY pos, no replay; 7773). LIVE blocks only: a reaped block's row was
 *  physically deleted by its D op. Throws EgressBlockCorruptError on a shape
 *  violation (a gap or negative in the pos sequence, a malformed snapshot,
 *  or a state row with no I twin in the flow). */
export function egressBlockView(db: SqliteDatabase, sessionId: string): Map<string, EgressBlockSnapshot> {
    const rows = db
        .prepare("SELECT pos, op_seq, flow_op_seq, block_id, payload FROM eg_block_state WHERE session_id = ? ORDER BY pos ASC")
        .all(sessionId) as unknown as EgressBlockStateRow[];
    const blocks = new Map<string, EgressBlockSnapshot>();
    for (const row of rows) {
        if (row.pos !== blocks.size) throw new EgressBlockCorruptError(sessionId, `state pos jumps from ${blocks.size} to ${row.pos} (block ${String(row.block_id)})`);
        if (typeof row.block_id !== "string") throw new EgressBlockCorruptError(sessionId, `state row at op_seq=${row.op_seq} has no block_id`);
        blocks.set(row.block_id, parseSnapshot(sessionId, row.op_seq, row.payload));
    }
    if (blocks.size > 0) {
        const stray = db
            .prepare(
                `SELECT COUNT(*) AS c FROM eg_block_state s
                   LEFT JOIN eg_block_flow f ON f.session_id = s.session_id AND f.block_id = s.block_id AND f.row_type = 'I'
                 WHERE s.session_id = ? AND f.op_seq IS NULL`,
            )
            .get(sessionId) as { c: number };
        if (Number(stray.c) > 0) throw new EgressBlockCorruptError(sessionId, `${Number(stray.c)} state row(s) have no I twin in the block flow`);
    }
    return blocks;
}

/** Replay the FLOW table up to (and including) op_seq x — the fork/rollback
 *  reconstruction (full history from 1 — there is no base row to start
 *  from). I/U rows set the block's snapshot; a D row removes it (its payload
 *  is the terminal snapshot, kept in the flow for the record). Returns the
 *  LIVE block set AND the kstate sidecar from the last row (I/U/D) with
 *  op_seq <= x (null = no sidecar yet — the caller uses a fresh default).
 *  Throws like egressBlockView. */
export function egressBlockReplay(
    db: SqliteDatabase,
    sessionId: string,
    x: number,
): { blocks: Map<string, EgressBlockSnapshot>; kstate: string | null } {
    const rows = db
        .prepare(
            "SELECT op_seq, flow_op_seq, row_type, block_id, payload, kstate_json, gen FROM eg_block_flow WHERE session_id = ? AND op_seq <= ? ORDER BY op_seq ASC",
        )
        .all(sessionId, x) as unknown as EgressBlockRow[];
    // 7896 trust boundary (same rule as the message log): when a G row is in
    // the prefix, it IS the starting view — rows before it were written by
    // an older generation and are never judged by this code; density
    // counting resumes at the G row itself.
    let boundary = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].row_type === "G") { boundary = i; break; }
    }
    let blocks: Map<string, EgressBlockSnapshot>;
    let kstate: string | null;
    if (boundary >= 0) {
        kstate = rows[boundary].kstate_json;
        blocks = decodeBlockGenSnapshot(sessionId, rows[boundary]);
    } else {
        blocks = new Map<string, EgressBlockSnapshot>();
        kstate = null;
    }
    let prevSeq: number | null = boundary >= 0 ? rows[boundary].op_seq : 0;
    for (let i = boundary + 1; i < rows.length; i++) {
        const row = rows[i];
        // Dual clocks: the block table numbers itself — its own op_seq must
        // be dense (1,2,3,…). A gap means a missing row (corruption); unlike
        // the flow table (whose rows can legally be truncated by compaction
        // bases), the block flow is append-only with no row deletion, so the
        // prefix is always complete. A point-forked child inherits a prefix
        // (watermarks are non-decreasing, so flow_op_seq <= X is a prefix),
        // hence dense too.
        if (row.op_seq !== prevSeq + 1) {
            throw new EgressBlockCorruptError(sessionId, `op_seq jumps from ${String(prevSeq)} to ${row.op_seq}`);
        }
        prevSeq = row.op_seq;
        if (row.kstate_json !== null) kstate = row.kstate_json;
        if (row.row_type === "I") {
            if (typeof row.block_id !== "string") throw new EgressBlockCorruptError(sessionId, `insert at op_seq=${row.op_seq} has no block_id`);
            if (blocks.has(row.block_id)) throw new EgressBlockCorruptError(sessionId, `duplicate block ${row.block_id} at op_seq=${row.op_seq}`);
            blocks.set(row.block_id, parseSnapshot(sessionId, row.op_seq, row.payload));
        } else if (row.row_type === "U") {
            if (typeof row.block_id !== "string") throw new EgressBlockCorruptError(sessionId, `update at op_seq=${row.op_seq} has no block_id`);
            if (!blocks.has(row.block_id)) throw new EgressBlockCorruptError(sessionId, `update target ${row.block_id} missing at op_seq=${row.op_seq}`);
            blocks.set(row.block_id, parseSnapshot(sessionId, row.op_seq, row.payload));
        } else if (row.row_type === "D") {
            if (typeof row.block_id !== "string") throw new EgressBlockCorruptError(sessionId, `delete at op_seq=${row.op_seq} has no block_id`);
            if (!blocks.has(row.block_id)) throw new EgressBlockCorruptError(sessionId, `delete target ${row.block_id} missing at op_seq=${row.op_seq}`);
            blocks.delete(row.block_id);
        } else {
            throw new EgressBlockCorruptError(sessionId, `unknown row_type ${String(row.row_type)} at op_seq=${row.op_seq}`);
        }
    }
    return { blocks, kstate };
}

/** Point fork (#7577 D5, dual-clock ruling): wm is a FLOW watermark
 *  (eg_flow's op_seq space). Copy the parent's egress op logs with
 *  op_seq <= wm and the block op logs with flow_op_seq <= wm (the pointer
 *  column — block rows carry their own op_seq clock, so filtering them by
 *  their op_seq would align two unrelated clocks) to the child session_id,
 *  inside ONE transaction. op_seq/log_seq are preserved verbatim, so the
 *  child inherits the parent's number space (nothing re-issued across the
 *  fork). wm >= the parent's flow MAX is the whole-copy special case (the
 *  existing egressFork path). Pre-existing child rows are replaced (an
 *  idempotent re-fork of the same parent pair). Returns the number of
 *  eg_flow rows copied. */
export function egressPointFork(db: SqliteDatabase, fromSessionId: string, toSessionId: string, wm: number): number {
    if (fromSessionId === toSessionId) throw new Error("egressPointFork: conflicting fork lineage (child equals parent)");
    return db.transaction(() => {
        // #7577 (a): fork-to-now fast path. The flow clock is the reference
        // clock: when wm covers the parent's flow high water, every block row
        // (whose flow_op_seq pointer <= flow MAX by construction) is in
        // scope, and BOTH state replicas are already the parent's exact
        // materialized views — copy all four tables straight by SQL. The replay
        // below would instead materialize the child's eg_state as the
        // FULL uncompacted flow (every historical B base row is a whole-view
        // snapshot — ~8MB at 100k messages), making the fork transaction
        // O(total history) and every later turn's prev-read a full-history
        // JS replay until the child's first fold. Only a true point fork
        // (wm < flow high water) needs the replay.
        const parentFlowMax = (db.prepare("SELECT COALESCE(MAX(op_seq), 0) AS m FROM eg_flow WHERE session_id = ?").get(fromSessionId) as { m: number }).m;
        const forkToNow = wm >= parentFlowMax;
        const n = db
            .prepare(forkToNow
                ? "SELECT COUNT(*) AS c FROM eg_flow WHERE session_id = ?"
                : "SELECT COUNT(*) AS c FROM eg_flow WHERE session_id = ? AND op_seq <= ?")
            .get(...(forkToNow ? [fromSessionId] : [fromSessionId, wm])) as { c: number };
        db.prepare("DELETE FROM eg_state WHERE session_id = ?").run(toSessionId);
        db.prepare("DELETE FROM eg_flow WHERE session_id = ?").run(toSessionId);
        db.prepare("DELETE FROM eg_block_state WHERE session_id = ?").run(toSessionId);
        db.prepare("DELETE FROM eg_block_flow WHERE session_id = ?").run(toSessionId);
        // Usage stream (8th egress table): the child inherits the parent's
        // analytics prefix — fork-to-now copies the WHOLE stream (owner
        // ruling: one usage stream per session), a true point fork copies
        // the at <= watermark prefix. The boundary is the parent flow's
        // MAX(created_at) at op_seq <= wm: the S events of exactly the
        // settlements the child inherited.
        if (forkToNow) {
            egressUsageForkCopy(db, fromSessionId, toSessionId);
        } else {
            const usageWm = (
                db.prepare("SELECT COALESCE(MAX(created_at), 0) AS m FROM eg_flow WHERE session_id = ? AND op_seq <= ?").get(fromSessionId, wm) as { m: number }
            ).m;
            egressUsageForkCopyPrefix(db, fromSessionId, toSessionId, usageWm);
        }
        if (forkToNow) {
            db.prepare(
                `INSERT INTO eg_flow (session_id, op_seq, log_seq, row_type, rid, msgid, payload, bytes, gen, created_at)
                 SELECT ?, op_seq, log_seq, row_type, rid, msgid, payload, bytes, gen, created_at FROM eg_flow WHERE session_id = ?`,
            ).run(toSessionId, fromSessionId);
            db.prepare(
                `INSERT INTO eg_block_flow (session_id, op_seq, flow_op_seq, row_type, block_id, payload, kstate_json, gen, created_at)
                 SELECT ?, op_seq, flow_op_seq, row_type, block_id, payload, kstate_json, gen, created_at FROM eg_block_flow WHERE session_id = ?`,
            ).run(toSessionId, fromSessionId);
            db.prepare(
                `INSERT INTO eg_state (session_id, rid, msgid, pos, log_seq, num, ref, tokens, type, role, ts, sys_in, bytes, created_at)
                 SELECT ?, rid, msgid, pos, log_seq, num, ref, tokens, type, role, ts, sys_in, bytes, created_at FROM eg_state WHERE session_id = ?`,
            ).run(toSessionId, fromSessionId);
            db.prepare(
                `INSERT INTO eg_block_state (session_id, block_id, pos, op_seq, flow_op_seq, payload, created_at)
                 SELECT ?, block_id, pos, op_seq, flow_op_seq, payload, created_at FROM eg_block_state WHERE session_id = ?`,
            ).run(toSessionId, fromSessionId);
            return Number(n.c);
        }
        // True point fork: copy the FLOW tables (append-only, op_seq <= wm).
        db.prepare(
            `INSERT INTO eg_flow (session_id, op_seq, log_seq, row_type, rid, msgid, payload, bytes, gen, created_at)
             SELECT ?, op_seq, log_seq, row_type, rid, msgid, payload, bytes, gen, created_at FROM eg_flow WHERE session_id = ? AND op_seq <= ?`,
        ).run(toSessionId, fromSessionId, wm);
        // Block rows align on the FLOW clock via their pointer column
        // (dual clocks: their own op_seq is unrelated to wm).
        db.prepare(
            `INSERT INTO eg_block_flow (session_id, op_seq, flow_op_seq, row_type, block_id, payload, kstate_json, gen, created_at)
             SELECT ?, op_seq, flow_op_seq, row_type, block_id, payload, kstate_json, gen, created_at FROM eg_block_flow WHERE session_id = ? AND flow_op_seq <= ?`,
        ).run(toSessionId, fromSessionId, wm);
        // Materialize the STATE replicas by replaying the flow tables up to
        // wm (a direct copy filtered by op_seq would not be the live view at
        // wm — e.g. a message a later D removed, or a block whose terminal
        // row is past wm).
        const nowMs = Date.now();
        egressMaterializeState(db, toSessionId, egressStateAt(db, toSessionId, wm), nowMs);
        const blockX = (db.prepare("SELECT COALESCE(MAX(op_seq), 0) AS m FROM eg_block_flow WHERE session_id = ? AND flow_op_seq <= ?").get(toSessionId, wm) as { m: number }).m;
        const blockReplay = egressBlockReplay(db, toSessionId, blockX);
        let pos = 0;
        for (const [blockId, snapshot] of blockReplay.blocks) {
            const last = db.prepare("SELECT op_seq, flow_op_seq FROM eg_block_flow WHERE session_id = ? AND block_id = ? AND flow_op_seq <= ? ORDER BY op_seq DESC LIMIT 1").get(toSessionId, blockId, wm) as { op_seq: number; flow_op_seq: number } | undefined;
            db.prepare(INSERT_BLOCK_STATE).run(toSessionId, blockId, pos++, last ? last.op_seq : 0, last ? last.flow_op_seq : 0, JSON.stringify(snapshot), nowMs);
        }
        return Number(n.c);
    });
}
