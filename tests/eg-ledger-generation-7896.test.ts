/**
 * Egress ledger GENERATION discipline (discussions/7896) — the pre-GA
 * cross-generation fixtures required by the AGENTS.md rule:
 *
 *   "Any change to the ROW SEMANTICS of eg_flow / eg_block_flow … MUST bump
 *    LEDGER_GENERATION, add the 'G' boundary-row write in the append paths,
 *    AND ship a cross-generation fixture test."
 *
 * The fixtures simulate what a version upgrade does: rows written under an
 * OLDER generation (gen=0, rows the NEW law would reject) followed by the
 * writer continuing under the current generation. The rules under test:
 *   (1) the writer closes a cross-generation prefix with a G boundary row
 *       whose payload is the full materialized view at the boundary;
 *   (2) every replay starts from the latest G at or below its target — the
 *       pre-G prefix is NEVER judged by the new law;
 *   (3) a G-less gen=0 prefix that violates the new law fails loudly
 *       (one-time legacy damage — no silent skip, no per-turn loop);
 *   (4) forks preserve G rows and the generation stamp;
 *   (5) the schema migration: empty old tables are dropped, current-shape
 *       non-empty old tables are copied with gen=0, old-shape non-empty old
 *       tables are frozen, gate-off drops empty new tables and freezes
 *       non-empty ones.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrateSchema } from "../src/storage/schema.js";
import { openSqliteDatabase, type SqliteDatabase } from "../src/storage/driver.js";
import {
    LEDGER_GENERATION,
    egressStateAppend,
    egressStateAt,
    egressFlowWalkBack,
    egressFork,
    type EgressOp,
    type EgressViewRow,
    EgressStateCorruptError,
} from "../src/storage/egress-state.js";
import {
    egressBlockAppend,
    egressBlockReplay,
    type EgressBlockSnapshot,
} from "../src/storage/egress-block.js";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eg-ledger-gen-7896-"));
fs.mkdirSync(testRoot, { recursive: true });

function openDb(): { db: SqliteDatabase; dir: string } {
    const dir = fs.mkdtempSync(path.join(testRoot, "case-"));
    const db = openSqliteDatabase(path.join(dir, "index.db")).db;
    migrateSchema(db, { legacyTables: false });
    return { db, dir };
}
function close(H: { db: SqliteDatabase; dir: string }): void {
    H.db.close();
    fs.rmSync(H.dir, { recursive: true, force: true });
}

/** A minimal I op — the egress op shape the writer/replay require. */
function iOp(rid: number, msgid: string, ref: string): EgressOp {
    return { type: "I", msgid, rid, after: null, ref, tokens: 1, typeTag: "text", bytes: JSON.stringify({ text: msgid }) };
}

const SNAP: EgressBlockSnapshot = {
    tier: 1, startMsgid: null, startSeq: 0, endMsgid: null, endSeq: 0,
    supersedesBlockId: null, active: true, reaped: false, one: null, full: "one",
    createdAt: 1_000,
};

/** Insert a raw eg_flow row (the fixtures hand-assemble cross-generation
 *  history that no single writer version would produce). */
function rawFlow(db: SqliteDatabase, S: string, opSeq: number, logSeq: number | null, rowType: string, rid: number | null, msgid: string | null, payload: string, bytes: string | null, gen: number, at: number): void {
    db.prepare(
        "INSERT INTO eg_flow (session_id, op_seq, log_seq, row_type, rid, msgid, payload, bytes, gen, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(S, opSeq, logSeq, rowType, rid, msgid, payload, bytes, gen, at);
}
function iPayload(ref: string, bytes: string, after?: number): string {
    const p: Record<string, unknown> = { ref, tokens: 1, type: "text", bytes };
    if (after !== undefined) p.after = after;
    return JSON.stringify(p);
}
function gPayload(rows: EgressViewRow[]): string {
    return JSON.stringify({ gen: LEDGER_GENERATION, rows });
}
function viewRow(rid: number, num: number, msgid: string, ref: string, bytes = "{}"): EgressViewRow {
    return { rid, num, msgid, ref, tokens: 1, type: "text", bytes };
}

// ---------------------------------------------------------------------------
// 1. The writer closes a cross-generation prefix with a G boundary row.
// ---------------------------------------------------------------------------
describe("7896 writer: the G boundary row", () => {
    it("appends a G row (full-view snapshot) before the first new-gen ops when the last flow row is older", () => {
        const H = openDb();
        try {
            const S = "sess-1";
            // Turn under the CURRENT generation (a fresh log).
            egressStateAppend(H.db, S, [iOp(1, "m1", "m00001")], 1_000);
            // Simulate an upgrade: the writer's law changed — every existing
            // row now reads as an older generation (gen 0).
            H.db.prepare("UPDATE eg_flow SET gen = 0 WHERE session_id = ?").run(S);
            // The next turn's append must close the prefix first.
            const seqs = egressStateAppend(H.db, S, [iOp(2, "m2", "m00002")], 2_000);
            assert.deepEqual(seqs, [3]);
            const rows = H.db
                .prepare("SELECT op_seq, row_type, gen, payload FROM eg_flow WHERE session_id = ? ORDER BY op_seq")
                .all(S) as { op_seq: number; row_type: string; gen: number; payload: string }[];
            assert.equal(rows.length, 3);
            assert.equal(rows[1].row_type, "G", "op_seq 2 is the G boundary row");
            assert.equal(rows[1].gen, LEDGER_GENERATION);
            const snap = JSON.parse(rows[1].payload) as { gen: number; rows: EgressViewRow[] };
            assert.equal(snap.gen, LEDGER_GENERATION);
            assert.deepEqual(snap.rows.map((r) => r.msgid), ["m1"]);
            assert.equal(rows[2].row_type, "I", "the new-gen I op took the slot after the G");
            assert.equal(rows[2].gen, LEDGER_GENERATION);
        } finally { close(H); }
    });

    it("appends nothing extra when the flow is empty or same-generation", () => {
        const H = openDb();
        try {
            const S = "sess-1";
            // Fresh log: no rows → no G needed.
            egressStateAppend(H.db, S, [iOp(1, "m1", "m00001")], 1_000);
            egressStateAppend(H.db, S, [iOp(2, "m2", "m00002")], 2_000);
            const n = H.db.prepare("SELECT COUNT(*) c FROM eg_flow WHERE session_id = ? AND row_type = 'G'").get(S) as { c: number };
            assert.equal(Number(n.c), 0, "two same-generation turns write no G rows");
        } finally { close(H); }
    });
});

// ---------------------------------------------------------------------------
// 2. Replays start from the latest G — the pre-G prefix is never judged.
// ---------------------------------------------------------------------------
describe("7896 replay: the G row is a trust boundary", () => {
    it("replays a dirty gen-0 prefix (rows the new law would reject) cleanly from its G boundary", () => {
        const H = openDb();
        try {
            const S = "sess-1";
            // A gen-0 prefix whose rows the CURRENT law would reject on
            // their own: a row id re-used by a second insert (the old build
            // renumbered in place — the 11-24
            // EgressStateCorruptError era). Without the G boundary this is a
            // dead session.
            rawFlow(H.db, S, 1, 1, "I", 1, "m1", iPayload("m00001", "{}"), "{}", 0, 1_000);
            rawFlow(H.db, S, 2, 2, "I", 1, "m2", iPayload("m00002", "{}"), "{}", 0, 1_000);
            // The boundary: the writer's law changed; the snapshot is the
            // view the old generation left (one live row — the old law
            // allowed the double number).
            rawFlow(H.db, S, 3, null, "G", null, null, gPayload([viewRow(1, 1, "m1", "m00001")]), null, LEDGER_GENERATION, 2_000);
            // A new-gen I after the boundary (numbering resumed under the
            // new law — it may reuse whatever the new law permits).
            rawFlow(H.db, S, 4, 2, "I", 3, "m3", iPayload("m00003", "{}", 1), "{}", LEDGER_GENERATION, 3_000);

            // egressStateAt from the top: the dirty prefix is skipped, the
            // G snapshot is the starting view, and the post-G ops apply.
            const view = egressStateAt(H.db, S, 999_999);
            assert.deepEqual(view.map((r) => r.msgid), ["m1", "m3"]);
            // A target BELOW the G has no boundary at or below it: the
            // dirty prefix is replayed under the new law and fails.
            assert.throws(() => egressStateAt(H.db, S, 2), EgressStateCorruptError);
        } finally { close(H); }
    });

    it("walk-back returns the post-G healthy point and never judges the pre-G rows", () => {
        const H = openDb();
        try {
            const S = "sess-1";
            // gen-0 prefix (dirty under the new law), G, one good new-gen I,
            // then a corrupt tail row (unparseable payload).
            rawFlow(H.db, S, 1, 1, "I", 1, "m1", iPayload("m00001", "{}"), "{}", 0, 1_000);
            rawFlow(H.db, S, 2, null, "G", null, null, gPayload([viewRow(1, 1, "m1", "m00001")]), null, LEDGER_GENERATION, 2_000);
            rawFlow(H.db, S, 3, 2, "I", 2, "m2", iPayload("m00002", "{}", 1), "{}", LEDGER_GENERATION, 3_000);
            rawFlow(H.db, S, 4, 3, "I", 3, "m3", "{\"x\":1", "{}", LEDGER_GENERATION, 4_000);
            const healthy = egressFlowWalkBack(H.db, S);
            assert.ok(healthy !== null);
            assert.equal(healthy.seq, 3);
            assert.deepEqual(healthy.view.map((r) => r.msgid), ["m1", "m2"]);
        } finally { close(H); }
    });

    it("a malformed G payload is a corrupt floor (null), not a silent skip", () => {
        const H = openDb();
        try {
            const S = "sess-1";
            rawFlow(H.db, S, 1, 1, "I", 1, "m1", iPayload("m00001", "{}"), "{}", 0, 1_000);
            rawFlow(H.db, S, 2, null, "G", null, null, "{not json", null, LEDGER_GENERATION, 2_000);
            assert.equal(egressFlowWalkBack(H.db, S), null);
            assert.throws(() => egressStateAt(H.db, S, 999_999), EgressStateCorruptError);
        } finally { close(H); }
    });
});

// ---------------------------------------------------------------------------
// 3. A G-less gen=0 prefix fails loudly (one-time legacy damage).
// ---------------------------------------------------------------------------
describe("7896 replay: no G = the old law is gone", () => {
    it("a gen-0 prefix that violates the new law throws (no boundary to trust it)", () => {
        const H = openDb();
        try {
            const S = "sess-1";
            // Same duplicate-rid pair as fixture 2, but NO G boundary: the
            // upgrade happened in flight (a crash between the two writes).
            // There is no boundary to start from — the prefix is judged row
            // by row by the only law this code knows, and fails.
            rawFlow(H.db, S, 1, 1, "I", 1, "m1", iPayload("m00001", "{}"), "{}", 0, 1_000);
            rawFlow(H.db, S, 2, 2, "I", 1, "m2", iPayload("m00002", "{}"), "{}", 0, 1_000);
            assert.throws(() => egressStateAt(H.db, S, 999_999), EgressStateCorruptError);
            // The walk-back finds the last HEALTHY prefix (row 1) and stops
            // at the corrupt row — recovery is possible, the session is not
            // dead; only a fully-unhealthy log returns null.
            const healthy = egressFlowWalkBack(H.db, S);
            assert.ok(healthy !== null);
            assert.equal(healthy.seq, 1);
            assert.deepEqual(healthy.view.map((r) => r.msgid), ["m1"]);
        } finally { close(H); }
    });
});

// ---------------------------------------------------------------------------
// 4. Forks preserve G rows and the generation stamp.
// ---------------------------------------------------------------------------
describe("7896 fork: G rows and gen travel with the copy", () => {
    it("whole-table fork keeps the G boundary row and its gen; the child replays from it", () => {
        const H = openDb();
        try {
            const P = "parent";
            const C = "child";
            rawFlow(H.db, P, 1, 1, "I", 1, "m1", iPayload("m00001", "{}"), "{}", 0, 1_000);
            rawFlow(H.db, P, 2, null, "G", null, null, gPayload([viewRow(1, 1, "m1", "m00001")]), null, LEDGER_GENERATION, 2_000);
            egressFork(H.db, P, C);
            const childRows = H.db
                .prepare("SELECT op_seq, row_type, gen FROM eg_flow WHERE session_id = ? ORDER BY op_seq")
                .all(C)
                .map((r) => ({ op_seq: Number((r as { op_seq: number }).op_seq), row_type: (r as { row_type: string }).row_type, gen: Number((r as { gen: number }).gen) }));
            assert.deepEqual(childRows, [
                { op_seq: 1, row_type: "I", gen: 0 },
                { op_seq: 2, row_type: "G", gen: LEDGER_GENERATION },
            ]);
            assert.deepEqual(egressStateAt(H.db, C, 999_999).map((r) => r.msgid), ["m1"]);
        } finally { close(H); }
    });

    it("the block log: append writes a G boundary (full block snapshot) before new-gen ops, and replay starts from it", () => {
        const H = openDb();
        try {
            const S = "sess-1";
            egressBlockAppend(H.db, S, [{ type: "I", blockId: "b1", snapshot: SNAP }], null, 1_000);
            // Upgrade: the existing block rows read as the older generation.
            H.db.prepare("UPDATE eg_block_flow SET gen = 0 WHERE session_id = ?").run(S);
            egressBlockAppend(H.db, S, [{ type: "U", blockId: "b1", snapshot: { ...SNAP, active: false } }], null, 2_000);
            const rows = H.db
                .prepare("SELECT op_seq, row_type, gen, payload FROM eg_block_flow WHERE session_id = ? ORDER BY op_seq")
                .all(S) as { op_seq: number; row_type: string; gen: number; payload: string }[];
            assert.equal(rows.length, 3);
            assert.equal(rows[1].row_type, "G");
            const snap = JSON.parse(rows[1].payload) as { gen: number; rows: { block_id: string; pos: number }[] };
            assert.equal(snap.gen, LEDGER_GENERATION);
            assert.deepEqual(snap.rows.map((r) => [r.block_id, r.pos]), [["b1", 0]]);
            // Replay through the boundary: the U applies to the snapshot's b1.
            const r = egressBlockReplay(H.db, S, 999_999);
            assert.equal(r.blocks.size, 1);
            assert.equal(r.blocks.get("b1")?.active, false);
        } finally { close(H); }
    });
});

// ---------------------------------------------------------------------------
// 5. Schema migration: rename + gate.
// ---------------------------------------------------------------------------
describe("7896 schema: rename migration and the gate", () => {
    it("empty old egress_* tables are dropped; nothing freezes", () => {
        const H = openDb();
        try {
            // Old-name tables, empty (the pre-rename probe shape).
            H.db.exec(`
                CREATE TABLE egress_flow (
                    session_id TEXT NOT NULL, op_seq INTEGER NOT NULL,
                    log_seq INTEGER, row_type TEXT NOT NULL CHECK (row_type IN ('I','D','U')),
                    rid INTEGER, msgid TEXT, payload TEXT NOT NULL, bytes TEXT,
                    created_at INTEGER NOT NULL, PRIMARY KEY (session_id, op_seq)
                );
                CREATE TABLE egress_state (
                    session_id TEXT NOT NULL, rid INTEGER NOT NULL, msgid TEXT NOT NULL,
                    pos INTEGER NOT NULL, log_seq INTEGER NOT NULL, num INTEGER,
                    ref TEXT, tokens INTEGER, type TEXT, role TEXT, ts INTEGER,
                    sys_in TEXT, bytes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
                    PRIMARY KEY (session_id, rid)
                );
            `);
            const res = migrateSchema(H.db, { legacyTables: false });
            assert.deepEqual(res.frozenEgressTables, []);
            const names = (H.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'eg\_%' ESCAPE '\\')").all() as { name: string }[]).map((r) => r.name).sort();
            assert.ok(names.includes("eg_flow") && !names.includes("egress_flow"), `new tables exist, old dropped: ${names.join(",")}`);
        } finally { close(H); }
    });

    it("a current-shape non-empty old table is copied (gen=0 on flow rows) and the old table dropped", () => {
        const H = openDb();
        try {
            H.db.exec(`
                CREATE TABLE egress_flow (
                    session_id TEXT NOT NULL, op_seq INTEGER NOT NULL,
                    log_seq INTEGER, row_type TEXT NOT NULL CHECK (row_type IN ('I','D','U')),
                    rid INTEGER, msgid TEXT, payload TEXT NOT NULL, bytes TEXT,
                    created_at INTEGER NOT NULL, PRIMARY KEY (session_id, op_seq)
                );
            `);
            H.db.prepare(
                "INSERT INTO egress_flow (session_id, op_seq, log_seq, row_type, rid, msgid, payload, bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ).run("s", 1, 1, "I", 1, "m1", iPayload("m00001", "{}"), "{}", 1_000);
            const res = migrateSchema(H.db, { legacyTables: false });
            assert.deepEqual(res.frozenEgressTables, []);
            const rowRaw = H.db.prepare("SELECT op_seq, row_type, gen FROM eg_flow WHERE session_id = ?").get("s") as { op_seq: number; row_type: string; gen: number };
            assert.deepEqual({ op_seq: Number(rowRaw.op_seq), row_type: rowRaw.row_type, gen: Number(rowRaw.gen) }, { op_seq: 1, row_type: "I", gen: 0 }, "the row is copied with gen=0");
            const old = H.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='egress_flow'").get() as { name: string } | undefined;
            assert.equal(old, undefined, "the old table is dropped after the copy");
            // A G-less gen-0 prefix that is VALID under the new law still
            // replays (gen=0 alone is not corruption — only a law violation
            // is, and there is no boundary to trust it).
            assert.deepEqual(egressStateAt(H.db, "s", 999_999).map((r) => r.msgid), ["m1"]);
        } finally { close(H); }
    });

    it("an old-shape (pre-gen) non-empty old table is FROZEN (read-only), not dropped or copied", () => {
        const H = openDb();
        try {
            // Old shape = the retired 'B' row type still in the CHECK
            // (a pre-#7773 build): its writer's law is unknown, so the data
            // is preserved read-only rather than copied into the new law.
            H.db.exec(`
                CREATE TABLE egress_flow (
                    session_id TEXT NOT NULL, op_seq INTEGER NOT NULL,
                    log_seq INTEGER, row_type TEXT NOT NULL CHECK (row_type IN ('B','I','D','U')),
                    rid INTEGER, msgid TEXT, payload TEXT NOT NULL, bytes TEXT,
                    created_at INTEGER NOT NULL, PRIMARY KEY (session_id, op_seq)
                );
            `);
            H.db.prepare(
                "INSERT INTO egress_flow (session_id, op_seq, log_seq, row_type, rid, msgid, payload, bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ).run("s", 1, 1, "I", 1, "m1", iPayload("m00001", "{}"), "{}", 1_000);
            const res = migrateSchema(H.db, { legacyTables: false });
            assert.ok(res.frozenEgressTables.includes("egress_flow"), `the old-shape table is frozen: ${JSON.stringify(res.frozenEgressTables)}`);
            const kept = H.db.prepare("SELECT COUNT(*) c FROM egress_flow").get() as { c: number };
            assert.equal(Number(kept.c), 1, "the frozen table keeps its rows");
        } finally { close(H); }
    });

    it("gate off: new-name tables are not created; an empty new table is dropped, a non-empty one frozen", () => {
        const H = openDb();
        try {
            // Fresh migrate with the gate off: the eg tables must not exist.
            const res = migrateSchema(H.db, { legacyTables: false, egressTables: false });
            assert.deepEqual(res.frozenEgressTables, []);
            const names = (H.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'eg\\_%' ESCAPE '\\'").all() as { name: string }[]).map((r) => r.name);
            assert.deepEqual(names, [], "gate off creates no eg tables on a fresh db");

            // Now create one (a mid-run gate flip leaves the table behind):
            // empty → dropped; non-empty → frozen.
            const mkEgFlow = `CREATE TABLE eg_flow (session_id TEXT NOT NULL, op_seq INTEGER NOT NULL, log_seq INTEGER, row_type TEXT NOT NULL CHECK (row_type IN ('G','I','D','U')), rid INTEGER, msgid TEXT, payload TEXT NOT NULL, bytes TEXT, gen INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, op_seq))`;
            H.db.exec(mkEgFlow);
            const res2 = migrateSchema(H.db, { legacyTables: false, egressTables: false });
            assert.deepEqual(res2.frozenEgressTables, []);
            const empty = H.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='eg_flow'").get() as { name: string } | undefined;
            assert.equal(empty, undefined, "the empty eg table is dropped when the gate is off");

            H.db.exec(mkEgFlow);
            H.db.prepare(
                "INSERT INTO eg_flow (session_id, op_seq, log_seq, row_type, rid, msgid, payload, bytes, gen, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            ).run("s", 1, 1, "I", 1, "m1", iPayload("m00001", "{}"), "{}", LEDGER_GENERATION, 1_000);
            const res3 = migrateSchema(H.db, { legacyTables: false, egressTables: false });
            assert.deepEqual(res3.frozenEgressTables, ["eg_flow"], "the non-empty eg table is frozen, not dropped");
            const kept = H.db.prepare("SELECT COUNT(*) c FROM eg_flow").get() as { c: number };
            assert.equal(Number(kept.c), 1, "the frozen table keeps its rows");
        } finally { close(H); }
    });
});
