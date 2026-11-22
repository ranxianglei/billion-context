import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { egressStateAppend, egressStateAt, egressStateCompact, egressStateView } from "../src/storage/egress-state.ts";
import { recordEgressTurn, recoverEgressBase, type EgressOpLogStore } from "../src/storage/egress-record.ts";
import type { BiliMessage } from "acp-kernel/wire";

/**
 * #7475 — egress_flow unbounded growth. The flow table was append-only-forever,
 * so every fold's inline base view accumulated (100k session → 101k rows /
 * 417MB). Compaction now reclaims the flow's dead prefix (rows older than the
 * PREVIOUS base — never read by the bounded walk-back), keeping it to one fold
 * period. These tests pin BOTH the storage bound AND the correctness guarantee
 * that the walk-back recovery still works after the reclamation.
 */

const S = "sess-flow-reclaim";
const M = (id: string, text: string, role: BiliMessage["role"] = "user"): BiliMessage => ({ id, role, contentType: "text", text });

function open() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-reclaim-"));
    const { db } = openSqliteDatabase(path.join(dir, "index.db"));
    migrateSchema(db);
    const store: EgressOpLogStore = {
        egressStateAppendOps: (sid, ops, nowMs) => egressStateAppend(db, sid, ops, nowMs),
        egressStateView: (sid) => egressStateView(db, sid),
        egressStateCompactView: (sid, view, nowMs) => egressStateCompact(db, sid, view, nowMs),
        egressStateViewAt: (sid, seq) => egressStateAt(db, sid, seq),
        egressStateMaxSeq: (sid) => (db.prepare(`SELECT COALESCE(MAX(op_seq), 0) AS mx FROM egress_flow WHERE session_id = ?`).get(sid) as { mx: number }).mx,
        egressStateTruncateAfter: (sid, seq) => {
            const a = db.prepare(`DELETE FROM egress_state WHERE session_id = ? AND op_seq > ?`).run(sid, seq);
            const b = db.prepare(`DELETE FROM egress_flow WHERE session_id = ? AND op_seq > ?`).run(sid, seq);
            return Number(a.changes) + Number(b.changes);
        },
    };
    return { db, store, dir };
}

const flowRows = (db: ReturnType<typeof openSqliteDatabase>["db"], sid: string): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(sid) as { n: number }).n;

const baseSeqs = (db: ReturnType<typeof openSqliteDatabase>["db"], sid: string): number[] =>
    (db.prepare("SELECT op_seq FROM egress_flow WHERE session_id = ? AND row_type = 'B' ORDER BY op_seq ASC").all(sid) as { op_seq: number }[]).map((r) => r.op_seq);

/** A growing conversation driver: tracks the full message id list and records
 * each turn against it. `append` adds a tail run (I ops); `fold` replaces the
 * middle with a summary row (a -D op → compaction). */
function driver(store: EgressOpLogStore, sid: string) {
    let ids: string[] = [];
    let prev: ReturnType<typeof recordEgressTurn> | undefined;
    let now = 0;
    const conv = (): BiliMessage[] => ids.map((id) => M(id, `text-${id}`));
    return {
        append(n: number): void {
            for (let i = 0; i < n; i++) ids.push(`m${ids.length + 1}`);
            prev = recordEgressTurn({ store, sessionId: sid, prev, conversation: conv(), systemText: "sys", nowMs: ++now });
        },
        fold(summaryId: string): void {
            // keep head + tail, replace the middle with the summary row
            const head = ids[0];
            const tailId = ids[ids.length - 1];
            ids = [head, summaryId, tailId];
            prev = recordEgressTurn({ store, sessionId: sid, prev, conversation: conv(), systemText: "sys", nowMs: ++now });
        },
        currentIds(): string[] { return [...ids]; },
    };
}

test("egress_flow stays bounded to one fold period after many compactions (#7475)", () => {
    const H = open();
    try {
        const d = driver(H.store, S);
        d.append(3);
        for (let cycle = 0; cycle < 30; cycle++) {
            d.append(20);
            d.fold(`acp_summary_${cycle}`);
        }
        const rows = flowRows(H.db, S);
        // One more fold cycle must NOT grow the flow (the reclamation deletes
        // the dead prefix that the new base makes unreadable).
        d.append(20);
        d.fold("acp_summary_last");
        const rowsAfter = flowRows(H.db, S);
        // Pre-fix the flow kept EVERY row (30 cycles × ~23 rows ≈ 700+ and
        // growing without bound). Post-fix it is one fold period (~23 rows) and
        // stable: one more cycle neither grows nor shrinks it.
        assert.ok(rowsAfter <= rows, `the flow is stable across folds (before last cycle: ${rows}, after: ${rowsAfter})`);
        assert.ok(rowsAfter <= 30, `the flow is bounded to one fold period (got ${rowsAfter} rows, expected ≤ 30, not the ~700+ cumulative)`);
    } finally {
        H.db.close();
        fs.rmSync(H.dir, { recursive: true, force: true });
    }
});

test("walk-back recovery still works after the flow reclamation (fold period > 16)", () => {
    const H = open();
    try {
        const d = driver(H.store, S);
        d.append(3);
        for (let cycle = 0; cycle < 2; cycle++) {
            d.append(20);
            d.fold(`acp_summary_${cycle}`);
        }
        const bases = baseSeqs(H.db, S);
        assert.ok(bases.length >= 2, `two bases exist (got ${bases.length})`);
        const b1 = bases[bases.length - 2];
        const b2 = bases[bases.length - 1];
        assert.ok(b2 - b1 > 16, `the fold period exceeds the walk-back window (b1=${b1}, b2=${b2}, gap=${b2 - b1}) — the reclamation deleted the first cycle`);
        // The reclamation kept b1 (the previous base) — the row the walk-back
        // restarts from when the newest base is corrupt.
        const minSeq = (H.db.prepare("SELECT MIN(op_seq) AS m FROM egress_flow WHERE session_id = ?").get(S) as { m: number }).m;
        assert.equal(minSeq, b1, `the flow's oldest retained row is the previous base (min=${minSeq}, b1=${b1})`);
        // Corrupt the NEWEST base (b2) in BOTH tables. The state table holds
        // only b2 (the compaction trimmed it), so egressStateView throws and the
        // ladder walks back — it must restart at b1 (retained by the fix) and
        // recover a non-empty healthy point.
        H.db.prepare(`UPDATE egress_flow SET payload = ? WHERE session_id = ? AND op_seq = ?`).run('{"x":1}', S, b2);
        H.db.prepare(`UPDATE egress_state SET payload = ? WHERE session_id = ? AND op_seq = ?`).run('{"x":1}', S, b2);
        const got = recoverEgressBase(H.store, S);
        assert.ok(got !== null, "the walk-back recovers after the reclamation (the previous base was retained)");
        assert.equal(got.degraded, true, "recovery is a degraded walk-back");
        assert.ok(got.view.length > 0, "the recovered view is non-empty");
        assert.ok(got.seq < b2, `the healthy point is before the corrupt base (seq=${got.seq} < b2=${b2})`);
        void d.currentIds;
    } finally {
        H.db.close();
        fs.rmSync(H.dir, { recursive: true, force: true });
    }
});

test("current view is intact after the flow reclamation", () => {
    const H = open();
    try {
        const d = driver(H.store, S);
        d.append(3);
        for (let cycle = 0; cycle < 5; cycle++) {
            d.append(20);
            d.fold(`acp_summary_${cycle}`);
        }
        // The serving read (state table) must still reconstruct the CURRENT
        // view exactly — the reclamation only touched the flow's dead prefix.
        // The view carries a leading system row (msgid "egress-system") that
        // the conversation id list does not, so strip it before comparing.
        const served = H.store.egressStateView(S).filter((r) => r.msgid !== "egress-system");
        assert.deepEqual(
            served.map((r) => r.msgid),
            d.currentIds(),
            "the state table's current view matches the recorded view",
        );
    } finally {
        H.db.close();
        fs.rmSync(H.dir, { recursive: true, force: true });
    }
});
