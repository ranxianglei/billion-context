/**
 * Egress op-log RECORDING (seg 3, proposal discussions/7398, #6785 perf
 * work): shadow recording of the outbound conversation view as sparse ops.
 * Pinned contract:
 *   - buildEgressViewRows determinism (same inputs → same rows; content
 *     edit → bytes change only; system block row present);
 *   - turn 1 = one +I per row; turn 2 tail append = exactly ONE +I op;
 *   - the four upper-layer shapes produce the expected op batches
 *     (append / nudge-excluded / fold = -D + +I summary / edit = +U);
 *   - a -D batch triggers compaction (state table collapses to base + tail);
 *   - #3617 both directions: with the rollout key off the recorder is not
 *     called (zero rows) — asserted at the gate level (featureEnabled
 *     default) since the wiring sits behind it in prepare-openai.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import {
    egressStateAt,
    egressStateAppend,
    egressStateCompact,
    egressStateView,
} from "../src/storage/egress-state.ts";
import { EGRESS_SYSTEM_MSGID, buildEgressViewRows, recordEgressTurn, type EgressOpLogStore } from "../src/storage/egress-record.ts";
import { featureEnabled } from "../src/rollout.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-record-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

interface Harness {
    db: ReturnType<typeof openSqliteDatabase>["db"];
    store: EgressOpLogStore;
    dir: string;
}

function open(): Harness {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-record-"));
    const { db } = openSqliteDatabase(path.join(dir, "index.db"));
    migrateSchema(db);
    const store: EgressOpLogStore = {
        egressStateAppendOps: (sid, ops, nowMs) => egressStateAppend(db, sid, ops, nowMs),
        egressStateView: (sid) => egressStateView(db, sid),
        egressStateCompactView: (sid, view, nowMs) => egressStateCompact(db, sid, view, nowMs),
        egressStateViewAt: (sid, seq) => egressStateAt(db, sid, seq),
        egressStateMaxSeq: (sid) => (db.prepare(`SELECT COALESCE(MAX(log_seq), 0) AS mx FROM egress_flow WHERE session_id = ?`).get(sid) as { mx: number }).mx,
        egressStateTruncateAfter: (sid, seq) => {
            const a = db.prepare(`DELETE FROM egress_state WHERE session_id = ? AND log_seq > ?`).run(sid, seq);
            const b = db.prepare(`DELETE FROM egress_flow WHERE session_id = ? AND log_seq > ?`).run(sid, seq);
            return Number(a.changes) + Number(b.changes);
        },
    };
    return { db, store, dir };
}

function close(H: Harness): void {
    H.db.close();
    fs.rmSync(H.dir, { recursive: true, force: true });
}

const M = (id: string, text: string, role = "user") => ({ id, role, contentType: "text", text });

test("buildEgressViewRows: deterministic, system row first, content-edit visible", () => {
    const conv = [M("a", "hello"), M("b", "world", "assistant")];
    const r1 = buildEgressViewRows(conv, "SYS");
    const r2 = buildEgressViewRows([M("a", "hello"), M("b", "world", "assistant")], "SYS");
    assert.deepEqual(r1, r2, "same inputs → identical rows");
    assert.equal(r1[0].msgid, EGRESS_SYSTEM_MSGID, "system row carries the constant msgid (no hash)");
    assert.equal(r1.length, 3);
    assert.equal(r1[1].msgid, "a");
    assert.equal(r1[1].type, "text");
    const edited = buildEgressViewRows([M("a", "hello"), M("b", "EDITED", "assistant")], "SYS");
    assert.equal(edited[2].bytes !== r1[2].bytes, true, "content edit changes bytes");
    assert.equal(edited[2].msgid, "b", "msgid stable across the edit");
    assert.deepEqual(buildEgressViewRows([], undefined), []);
    // summary rows are typed acp_summary
    const s = buildEgressViewRows([M("acp_summary_1", "…", "assistant")], undefined);
    assert.equal(s[0].type, "acp_summary");
});

test("recording: turn1 = full +I batch; turn2 tail append = exactly one +I", () => {
    const H = open();
    try {
        const S = "sess-r1";
        const t1 = [M("a", "one"), M("b", "two", "assistant")];
        let view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: t1, systemText: "SYS", nowMs: 1000 });
        assert.equal(view.length, 3);
        let rows = H.db.prepare("SELECT COUNT(*) AS c FROM egress_flow WHERE session_id = ?").get(S) as { c: number };
        assert.equal(rows.c, 3, "flow has one +I row per view row");
        assert.equal(view.every((r) => r.ref === "" || /^m\d{4,}$/.test(r.ref)), true);

        const t2 = [t1[0], t1[1], M("c", "three")];
        view = recordEgressTurn({ store: H.store, sessionId: S, prev: view, conversation: t2, systemText: "SYS", nowMs: 2000 });
        const added = H.db.prepare("SELECT COUNT(*) AS c FROM egress_flow WHERE session_id = ? AND log_seq > 3").get(S) as { c: number };
        assert.equal(added.c, 1, "tail append records exactly ONE new op row");
        const last = H.db.prepare("SELECT row_type, msgid FROM egress_flow WHERE session_id = ? ORDER BY log_seq DESC LIMIT 1").get(S) as { row_type: string; msgid: string };
        assert.deepEqual({ row_type: last.row_type, msgid: last.msgid }, { row_type: "I", msgid: "c" });
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), [EGRESS_SYSTEM_MSGID, "a", "b", "c"]);
    } finally {
        close(H);
    }
});

test("recording: fold shape = -D range + +I summary, and the -D triggers compaction", () => {
    const H = open();
    try {
        const S = "sess-r2";
        const store = H.store;
        let view = recordEgressTurn({ store, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2"), M("c", "3"), M("d", "4"), M("e", "5")], systemText: "SYS", nowMs: 1000 });
        // fold: b..d replaced by one summary row
        const folded = [M("a", "1"), M("acp_summary_9", "…", "assistant"), M("e", "5")];
        view = recordEgressTurn({ store, sessionId: S, prev: view, conversation: folded, systemText: "SYS", nowMs: 2000 });
        const ops = H.db.prepare("SELECT row_type, msgid FROM egress_flow WHERE session_id = ? AND op_seq > 5 ORDER BY op_seq").all(S) as { row_type: string; msgid: string | null }[];
        const types = ops.map((o) => o.row_type);
        assert.ok(types.includes("D"), "fold emits a -D");
        assert.ok(types.includes("I"), "fold emits a +I for the summary");
        assert.equal(view.length, 4);
        // compaction fired: state table = base row + nothing else (the I was
        // replayed INTO the base by the same compact call)
        const stateRows = H.db.prepare("SELECT row_type FROM egress_state WHERE session_id = ? ORDER BY op_seq").all(S) as { row_type: string }[];
        assert.ok(stateRows.some((r) => r.row_type === "B"), "compaction wrote a base row");
        assert.equal(egressStateView(H.db, S).length, 4, "view has the system row + a + summary + e");
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), view.map((r) => r.msgid), "view survives compaction byte-identical");
    } finally {
        close(H);
    }
});

test("recording: content edit of one row = exactly one +U, no D/I churn", () => {
    const H = open();
    try {
        const S = "sess-r3";
        const store = H.store;
        let view = recordEgressTurn({ store, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2", "assistant"), M("c", "3")], systemText: "SYS", nowMs: 1000 });
        view = recordEgressTurn({ store, sessionId: S, prev: view, conversation: [M("a", "1"), M("b", "2-edited", "assistant"), M("c", "3")], systemText: "SYS", nowMs: 2000 });
        const rows = H.db.prepare("SELECT row_type, msgid FROM egress_flow WHERE session_id = ? AND op_seq > 4").all(S) as { row_type: string; msgid: string | null }[];
        assert.equal(rows.length, 1, "exactly one op");
        assert.equal(rows[0].row_type, "U", "it is a +U");
        assert.equal(rows[0].msgid, "b", "targeting the edited row");
        const expected = buildEgressViewRows([M("a", "1"), M("b", "2-edited", "assistant"), M("c", "3")], "SYS");
        const got = egressStateView(H.db, S);
        assert.deepEqual(got.map((r) => [r.msgid, r.bytes]), expected.map((r) => [r.msgid, r.bytes]), "replayed view carries the edited bytes");
    } finally {
        close(H);
    }
});

test("recording: nudge-shaped churn is EXCLUDED (ephemeral rows never recorded)", () => {
    const H = open();
    try {
        const S = "sess-r4";
        const store = H.store;
        let view = recordEgressTurn({ store, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2", "assistant")], systemText: "SYS", nowMs: 1000 });
        // the prepare layer passes processedMessages (kernel view) — the
        // nudge is appended AFTER this seam by design, so it is structurally
        // absent; pin that the recorder's contract is the kernel view shape:
        view = recordEgressTurn({ store, sessionId: S, prev: view, conversation: [M("a", "1"), M("b", "2", "assistant")], systemText: "SYS", nowMs: 2000 });
        const added = H.db.prepare("SELECT COUNT(*) AS c FROM egress_flow WHERE session_id = ? AND log_seq > 3").get(S) as { c: number };
        assert.equal(added.c, 0, "identical view → zero ops");
    } finally {
        close(H);
    }
});

test("#3617 negative direction: rollout key OFF by default → gate never opens", () => {
    delete process.env.BILI_ROLLOUT_EGRESS_PLANE;
    assert.equal(featureEnabled("egressPlane"), false, "egressPlane defaults to 0 — the prepare-openai gate (featureEnabled) sees nothing and records zero rows");
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
    assert.equal(featureEnabled("egressPlane"), true);
    delete process.env.BILI_ROLLOUT_EGRESS_PLANE;
});
