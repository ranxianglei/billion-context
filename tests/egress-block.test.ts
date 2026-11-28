/**
 * #7577: egress block flow/state — the block canonical history + materialized
 * live view (7773: the B base row is retired; reap = a D row carrying the
 * terminal snapshot; the state row is physically deleted).
 * Tests pin the CONTRACT:
 *   - replay determinism: same op sequence → same block set, always;
 *   - the three row types (I born, U state-change, D terminal with a full
 *     final snapshot) and their payload shapes;
 *   - point fork: 4-table copy preserves op_seq/log_seq, child inherits
 *     parent number space;
 *   - kstate sidecar: bounded residual snapshot at row-write time;
 *   - reap semantics: terminal D row (snapshot reaped=true) + physical state
 *     delete, instead of an UPDATE or an UPDATE-with-reaped-flag;
 *   - diffBlockSet: I for new, U for changed, D for live→gone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import {
    egressBlockAppend,
    egressBlockView,
    egressBlockReplay,
    egressPointFork,
    diffBlockSet,
    EgressBlockCorruptError,
    type EgressBlockOp,
    type EgressBlockSnapshot,
} from "../src/storage/egress-block.ts";
import { egressAppendTurn, egressStateView, egressStateAt } from "../src/storage/egress-state.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-block-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

interface Harness {
    db: ReturnType<typeof openSqliteDatabase>["db"];
    dir: string;
}

function open(): Harness {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-block-"));
    const { db } = openSqliteDatabase(path.join(dir, "index.db"));
    migrateSchema(db);
    return { db, dir };
}

function close(h: Harness): void {
    h.db.close();
    try {
        fs.rmSync(h.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* leaked temp dir on a Windows runner is harmless */ }
}

const snap = (over: Partial<EgressBlockSnapshot> = {}): EgressBlockSnapshot => ({
    tier: 1,
    startMsgid: "m00001",
    startSeq: 1,
    endMsgid: "m00005",
    endSeq: 5,
    supersedesBlockId: null,
    active: true,
    reaped: false,
    one: JSON.stringify({ text: "one-line summary", count: 3 }),
    full: JSON.stringify({ text: "full block content", count: 5 }),
    ...over,
});

test("replay determinism: I/U op sequence → same block set", () => {
    const H = open();
    try {
        const S = "sess-1";
        egressBlockAppend(H.db, S, [
            { type: "I", blockId: "b1", snapshot: snap() },
            { type: "I", blockId: "b2", snapshot: snap({ tier: 2, startMsgid: "m00006", startSeq: 6, endMsgid: "m00010", endSeq: 10 }) },
        ], null, 1_000);
        egressBlockAppend(H.db, S, [
            { type: "U", blockId: "b1", snapshot: snap({ active: false, supersedesBlockId: "b2" }) },
        ], null, 2_000);
        const view = egressBlockView(H.db, S);
        assert.equal(view.size, 2);
        assert.equal(view.get("b1")!.active, false);
        assert.equal(view.get("b1")!.supersedesBlockId, "b2");
        assert.equal(view.get("b2")!.active, true);
        // replay at op_seq 2 (after first append: b1@1, b2@2)
        const r1 = egressBlockReplay(H.db, S, 2);
        assert.equal(r1.blocks.size, 2);
        assert.equal(r1.blocks.get("b1")!.active, true);
        // replay at op_seq 3 (after second append: b1 U@3)
        const r2 = egressBlockReplay(H.db, S, 3);
        assert.equal(r2.blocks.size, 2);
        assert.equal(r2.blocks.get("b1")!.active, false);
    } finally { close(H); }
});

test("reap = terminal D row with the full final snapshot; the state row is physically deleted (7773)", () => {
    const H = open();
    try {
        const S = "sess-1";
        egressBlockAppend(H.db, S, [
            { type: "I", blockId: "b1", snapshot: snap() },
            { type: "I", blockId: "b2", snapshot: snap({ tier: 2 }) },
        ], null, 1_000);
        // reap b1: the D row carries the terminal snapshot (reaped=true)
        egressBlockAppend(H.db, S, [
            { type: "D", blockId: "b1", snapshot: snap({ reaped: true, active: false }) },
        ], null, 2_000);
        // the live view loses the block — it is deleted, not flagged
        const after = egressBlockView(H.db, S);
        assert.equal(after.size, 1);
        assert.equal(after.has("b1"), false);
        assert.equal(after.get("b2")!.active, true);
        // the flow keeps both rows (append-only): I@1, I@2, D@3
        const rows = H.db.prepare("SELECT row_type FROM egress_block_flow WHERE session_id = ? ORDER BY op_seq").all(S) as { row_type: string }[];
        assert.deepEqual(rows.map((r) => r.row_type), ["I", "I", "D"]);
        // replay sees the block only before the D
        const before = egressBlockReplay(H.db, S, 2);
        assert.equal(before.blocks.has("b1"), true);
        const atD = egressBlockReplay(H.db, S, 3);
        assert.equal(atD.blocks.has("b1"), false);
        assert.equal(atD.blocks.get("b2")!.active, true);
        // the D row's payload carries the terminal snapshot
        const dRow = H.db.prepare("SELECT block_id, payload FROM egress_block_flow WHERE session_id = ? AND row_type = 'D'").get(S) as { block_id: string; payload: string };
        const parsed = JSON.parse(dRow.payload);
        assert.equal(dRow.block_id, "b1");
        assert.equal(parsed.reaped, true);
        assert.equal(parsed.tier, 1, "the D row's payload carries the full final snapshot, not a marker");
    } finally { close(H); }
});

test("point fork: the block set aligns to the FLOW watermark via flow_op_seq (dual clocks)", () => {
    const H = open();
    try {
        const P = "parent";
        // flow point 1
        egressAppendTurn(H.db, P, [
            { type: "I", rid: 1, msgid: "m00001", after: null, tokens: 3, typeTag: "text", bytes: "a" },
        ], 1_000, { baseSeq: 0 });
        // block born — its flow_op_seq pointer is 1 (flow's MAX at write time)
        egressBlockAppend(H.db, P, [
            { type: "I", blockId: "b1", snapshot: snap() },
        ], null, 1_500);
        // flow point 2
        egressAppendTurn(H.db, P, [
            { type: "I", rid: 2, msgid: "m00002", after: 1, tokens: 4, typeTag: "text", bytes: "b" },
        ], 2_000, { baseSeq: 1 });
        // block updated at flow point 2
        egressBlockAppend(H.db, P, [
            { type: "U", blockId: "b1", snapshot: snap({ active: false }) },
        ], null, 2_500);
        // pointer sanity: I row → 1, U row → 2
        const ptrs = H.db.prepare("SELECT row_type, flow_op_seq FROM egress_block_flow WHERE session_id = ? ORDER BY op_seq").all(P) as { row_type: string; flow_op_seq: number }[];
        assert.deepEqual(ptrs.map((r) => [r.row_type, r.flow_op_seq]), [["I", 1], ["U", 2]]);
        // fork at FLOW watermark 1 → only the I row is in scope (flow_op_seq <= 1)
        egressPointFork(H.db, P, "child", 1);
        const childView = egressBlockView(H.db, "child");
        assert.equal(childView.size, 1);
        assert.equal(childView.get("b1")!.active, true);
        // fork-to-now at FLOW watermark 2 (parent's flow MAX) → includes the U
        egressPointFork(H.db, P, "child2", 2);
        assert.equal(egressBlockView(H.db, "child2").get("b1")!.active, false);
        // the child's block clock is ITS OWN: it inherited block op 1, so the
        // next append numbers op 2 in the child's space (independent of the
        // parent's block clock position)
        egressBlockAppend(H.db, "child", [
            { type: "I", blockId: "b2", snapshot: snap({ tier: 2 }) },
        ], null, 3_000);
        assert.equal(egressBlockView(H.db, "child").size, 2);
    } finally { close(H); }
});

test("fork-to-now: the child inherits the parent's four tables verbatim (a)", () => {
    const H = open();
    try {
        const P = "parent-a";
        // two message turns (flow ops 1, 2)
        egressAppendTurn(H.db, P, [
            { type: "I", rid: 1, msgid: "m00001", after: null, tokens: 3, typeTag: "text", bytes: "hello" },
        ], 1_000, { baseSeq: 0 });
        egressAppendTurn(H.db, P, [
            { type: "I", rid: 2, msgid: "m00002", after: 1, tokens: 4, typeTag: "text", bytes: "there" },
        ], 2_000, { baseSeq: 1 });
        // a block birth (block op 1 on the block's OWN clock; flow_op_seq 2)
        egressBlockAppend(H.db, P, [{ type: "I", blockId: "blk_1", snapshot: snap() }], null, 3_000);
        // a fold: delete both messages → compaction in the same write
        egressAppendTurn(H.db, P, [
            { type: "D", start: 1, end: 2 },
        ], 4_000, { baseSeq: 2 });

        // The FLOW clock is the reference clock for fork watermarks (dual
        // clocks) — the block table's own op_seq space is self-contained.
        const parentMax = (H.db.prepare("SELECT COALESCE(MAX(op_seq), 0) AS m FROM egress_flow WHERE session_id = ?").get(P) as { m: number }).m;
        const C = "child-a";
        egressPointFork(H.db, P, C, parentMax);

        // every one of the four tables is byte-identical to the parent's
        for (const [table, cols] of [
            ["egress_flow", "op_seq, row_type, rid, msgid, payload, bytes, created_at"],
            ["egress_block_flow", "op_seq, flow_op_seq, row_type, block_id, payload, kstate_json, created_at"],
            ["egress_state", "rid, msgid, pos, tokens, type, role, ts, sys_in, bytes, created_at"],
            ["egress_block_state", "block_id, pos, op_seq, flow_op_seq, payload, created_at"],
        ] as const) {
            const q = (id: string) => H.db.prepare(`SELECT ${cols} FROM ${table} WHERE session_id = ? ORDER BY 1, 2`).all(id);
            assert.deepEqual(q(C), q(P));
        }
        // the child continues the FLOW clock past the parent's high water
        egressAppendTurn(H.db, C, [
            { type: "I", rid: 3, msgid: "m00009", after: null, tokens: 2, typeTag: "text", bytes: "after fork" },
        ], 9_000, { baseSeq: parentMax });
        const childMax = (H.db.prepare("SELECT COALESCE(MAX(op_seq), 0) AS m FROM egress_flow WHERE session_id = ?").get(C) as { m: number }).m;
        assert.equal(childMax, parentMax + 1);
        assert.equal(egressBlockView(H.db, C).get("blk_1")!.active, true);

        // a TRUE point fork (wm < flow high water) replays: tables truncated
        // at the FLOW watermark; block rows align via flow_op_seq. Use a
        // separate non-folded parent so the watermark lands before the fold
        // and the flow rows 1,2 are still the fork's source.
        const P2 = "parent-a2";
        egressAppendTurn(H.db, P2, [
            { type: "I", rid: 1, msgid: "m00001", after: null, tokens: 3, typeTag: "text", bytes: "hello" },
        ], 1_000, { baseSeq: 0 });
        egressAppendTurn(H.db, P2, [
            { type: "I", rid: 2, msgid: "m00002", after: 1, tokens: 4, typeTag: "text", bytes: "there" },
        ], 2_000, { baseSeq: 1 });
        // blk_1's flow_op_seq pointer is 2 — it "exists at flow point 2"
        egressBlockAppend(H.db, P2, [{ type: "I", blockId: "blk_1", snapshot: snap() }], null, 3_000);
        const C2 = "child-a-point";
        egressPointFork(H.db, P2, C2, 1); // at flow point 1, before the block's flow point
        assert.equal((H.db.prepare("SELECT COUNT(*) AS c FROM egress_flow WHERE session_id = ?").get(C2) as { c: number }).c, 1);
        assert.equal((H.db.prepare("SELECT COUNT(*) AS c FROM egress_block_flow WHERE session_id = ?").get(C2) as { c: number }).c, 0, "the block's flow point is 2, past wm=1");
        // at flow point 2 the block IS in scope
        const C3 = "child-a-point2";
        egressPointFork(H.db, P2, C3, 2);
        assert.equal((H.db.prepare("SELECT COUNT(*) AS c FROM egress_block_flow WHERE session_id = ?").get(C3) as { c: number }).c, 1);
    } finally { close(H); }
});

test("interleave regression (the review-critical bug): flow stays DENSE when message and block ops alternate", () => {
    const H = open();
    try {
        const S = "sess-interleave";
        // turn 1: two messages
        egressAppendTurn(H.db, S, [
            { type: "I", rid: 1, msgid: "m00001", after: null, tokens: 3, typeTag: "text", bytes: "a" },
            { type: "I", rid: 2, msgid: "m00002", after: 1, tokens: 4, typeTag: "text", bytes: "b" },
        ], 1_000, { baseSeq: 0 });
        // a fold turn lands a block at SAVE time (production write order:
        // message rows at prepare, block rows at save)
        egressBlockAppend(H.db, S, [{ type: "I", blockId: "blk_1", snapshot: snap() }], null, 1_500);
        // turn 2: a NEW message after the block rows — under the OLD shared
        // clock this row would have landed at op 4 (block took op 3), and
        // applyOps' density check (`op_seq === prevSeq + 1`) threw "jumps
        // from 2 to 4" on every subsequent egress read.
        egressAppendTurn(H.db, S, [
            { type: "I", rid: 3, msgid: "m00003", after: 2, tokens: 5, typeTag: "text", bytes: "c" },
        ], 2_000, { baseSeq: 2 });
        // ALL egress reads must work on the interleaved session — this is
        // exactly what broke in production (read threw, recoverEgressBase
        // truncated the just-written row every turn, the log froze).
        const view = egressStateView(H.db, S);
        assert.deepEqual(view.map((r) => r.msgid), ["m00001", "m00002", "m00003"]);
        const at2 = egressStateAt(H.db, S, 2);
        assert.deepEqual(at2.map((r) => r.msgid), ["m00001", "m00002"]);
        // the flow table itself is dense: 1,2,3 — the block rows never
        // consumed a flow number
        const seqs = (H.db.prepare("SELECT op_seq FROM egress_flow WHERE session_id = ? ORDER BY op_seq").all(S) as { op_seq: number }[]).map((r) => r.op_seq);
        assert.deepEqual(seqs, [1, 2, 3]);
        // the block table numbered ITSELF: its own op 1, flow pointer 2
        const blk = H.db.prepare("SELECT op_seq, flow_op_seq FROM egress_block_flow WHERE session_id = ?").get(S) as { op_seq: number; flow_op_seq: number };
        assert.equal(blk.op_seq, 1);
        assert.equal(blk.flow_op_seq, 2);
    } finally { close(H); }
});

test("corrupt: a gap in the block table's OWN op_seq is reported (density)", () => {
    const H = open();
    try {
        const S = "sess-block-density";
        egressBlockAppend(H.db, S, [
            { type: "I", blockId: "b1", snapshot: snap() },
        ], null, 1_000);
        egressBlockAppend(H.db, S, [
            { type: "I", blockId: "b2", snapshot: snap({ tier: 2 }) },
        ], null, 2_000);
        egressBlockAppend(H.db, S, [
            { type: "I", blockId: "b3", snapshot: snap({ tier: 3 }) },
        ], null, 3_000);
        // delete the MIDDLE block row (op 2) → a gap inside the replay
        // window (rows 1,3) that must be reported (the block flow is
        // append-only, so its own sequence is always dense; a gap means a
        // missing row)
        H.db.prepare("DELETE FROM egress_block_flow WHERE session_id = ? AND op_seq = 2").run(S);
        assert.throws(() => egressBlockReplay(H.db, S, 3), EgressBlockCorruptError);
    } finally { close(H); }
});

test("kstate sidecar: bounded residual snapshot at row-write time", () => {
    const H = open();
    try {
        const S = "sess-1";
        const kstate = JSON.stringify({ viewLatches: {}, stats: { requests: 1 } });
        egressBlockAppend(H.db, S, [
            { type: "I", blockId: "b1", snapshot: snap() },
        ], kstate, 1_000);
        const r = egressBlockReplay(H.db, S, 1);
        assert.equal(r.kstate, kstate);
    } finally { close(H); }
});

test("diffBlockSet: I for new, U for changed, D for live→gone (snapshot reaped=true)", () => {
    const prev = new Map<string, EgressBlockSnapshot>();
    const next = new Map<string, EgressBlockSnapshot>();
    prev.set("b1", snap());
    prev.set("b2", snap({ tier: 2 }));
    next.set("b1", snap({ active: false })); // changed
    next.set("b3", snap({ tier: 3 })); // new
    // b2 is gone (live→gone)
    const ops = diffBlockSet(prev, next);
    const byBlock = new Map(ops.map((o) => [o.blockId, o]));
    assert.equal(byBlock.get("b1")!.type, "U");
    assert.equal(byBlock.get("b1")!.snapshot.active, false);
    assert.equal(byBlock.get("b3")!.type, "I");
    assert.equal(byBlock.get("b2")!.type, "D");
    assert.equal(byBlock.get("b2")!.snapshot.reaped, true);
    assert.equal(byBlock.get("b2")!.snapshot.tier, 2, "the D snapshot is the full final state of the block");
});

test("corrupt: duplicate I throws", () => {
    const H = open();
    try {
        const S = "sess-1";
        egressBlockAppend(H.db, S, [
            { type: "I", blockId: "b1", snapshot: snap() },
        ], null, 1_000);
        assert.throws(() => {
            egressBlockAppend(H.db, S, [
                { type: "I", blockId: "b1", snapshot: snap() },
            ], null, 2_000);
        }, EgressBlockCorruptError);
    } finally { close(H); }
});

test("corrupt: U on missing target throws", () => {
    const H = open();
    try {
        const S = "sess-1";
        assert.throws(() => {
            egressBlockAppend(H.db, S, [
                { type: "U", blockId: "b1", snapshot: snap() },
            ], null, 1_000);
        }, EgressBlockCorruptError);
    } finally { close(H); }
});

test("corrupt: D on missing target throws", () => {
    const H = open();
    try {
        const S = "sess-1";
        assert.throws(() => {
            egressBlockAppend(H.db, S, [
                { type: "D", blockId: "b1", snapshot: snap({ reaped: true }) },
            ], null, 1_000);
        }, EgressBlockCorruptError);
    } finally { close(H); }
});
