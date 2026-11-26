/**
 * Egress op-log RECORDING (seg 3, proposal discussions/7398, #6785 perf
 * work): shadow recording of the outbound conversation view as sparse ops.
 * Pinned contract:
 *   - buildEgressViewRows determinism (same inputs → same rows; content
 *     edit → bytes change only; system block row present);
 *   - turn 1 = one +I per row; turn 2 tail append = exactly ONE +I op;
 *   - the four upper-layer shapes produce the expected op batches
 *     (append / nudge-excluded / fold = -D + +I summary / edit = +U);
 *   - a -D batch physically deletes the state rows (7773 materialized
 *     view — there is no compaction step, no base row; the flow keeps its
 *     full history and its letter alphabet is I/D/U);
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
    egressAppendTurn,
    egressFlowWalkBack,
    egressMaterializeState,
    egressStateAt,
    egressStateRead,
    egressStateView,
    type EgressOp,
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
        egressAppendTurn: (sid, ops, baseSeq, nowMs) => egressAppendTurn(db, sid, ops, nowMs, { baseSeq }),
        egressStateView: (sid) => egressStateRead(db, sid),
        egressStateViewAt: (sid, seq) => egressStateAt(db, sid, seq),
        egressStateMaxSeq: (sid) => (db.prepare(`SELECT COALESCE(MAX(op_seq), 0) AS mx FROM egress_flow WHERE session_id = ?`).get(sid) as { mx: number }).mx,
        egressStateTruncateAfter: (sid, seq) => {
            const b = db.prepare(`DELETE FROM egress_flow WHERE session_id = ? AND op_seq > ?`).run(sid, seq);
            egressMaterializeState(db, sid, egressStateAt(db, sid, seq), Date.now());
            return Number(b.changes);
        },
        egressFlowWalkBack: (sid) => egressFlowWalkBack(db, sid),
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
        // Renumber (2026-11-25): turn1's rows are system=0, a=1, b=2 (the
        // system row no longer consumes number 1) — the new tail row is 3.
        const added = H.db.prepare("SELECT COUNT(*) AS c FROM egress_flow WHERE session_id = ? AND log_seq > 2").get(S) as { c: number };
        assert.equal(added.c, 1, "tail append records exactly ONE new op row");
        const last = H.db.prepare("SELECT row_type, msgid FROM egress_flow WHERE session_id = ? ORDER BY log_seq DESC LIMIT 1").get(S) as { row_type: string; msgid: string };
        assert.deepEqual({ row_type: last.row_type, msgid: last.msgid }, { row_type: "I", msgid: "c" });
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), [EGRESS_SYSTEM_MSGID, "a", "b", "c"]);
    } finally {
        close(H);
    }
});

test("recording: fold shape = -D range + +I summary, state rows physically deleted (7773)", () => {
    const H = open();
    try {
        const S = "sess-r2";
        const store = H.store;
        let view = recordEgressTurn({ store, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2"), M("c", "3"), M("d", "4"), M("e", "5")], systemText: "SYS", nowMs: 1000 });
        // fold: b..d replaced by one summary row
        const folded = [M("a", "1"), M("acp_summary_9", "…", "assistant"), M("e", "5")];
        // read the op list through the store: the -D physically deletes the
        // b..d rows from the MATERIALIZED state view (7773 — there is no
        // compaction step); the FLOW keeps its full history (append-only)
        const batches: EgressOp[][] = [];
        const spy: EgressOpLogStore = {
            ...store,
            egressAppendTurn: (sid, ops, baseSeq, nowMs) => {
                batches.push(ops);
                return store.egressAppendTurn(sid, ops, baseSeq, nowMs);
            },
        };
        view = recordEgressTurn({ store: spy, sessionId: S, prev: view, conversation: folded, systemText: "SYS", nowMs: 2000 });
        const ops = batches[0];
        assert.ok(ops !== undefined && ops.length > 0, "the fold was recorded");
        const types = ops.map((o) => o.type);
        assert.ok(types.includes("D"), "fold emits a -D");
        assert.ok(types.includes("I"), "fold emits a +I for the summary");
        assert.equal(view.length, 4);
        // state = the live view exactly: 4 rows (system + a + summary + e),
        // b..d physically gone in the same write as the ops
        const stateCount = H.db.prepare("SELECT COUNT(*) AS c FROM egress_state WHERE session_id = ?").get(S) as { c: number };
        assert.equal(stateCount.c, 4, "the state table holds only the live rows");
        const flowRows = H.db.prepare("SELECT row_type FROM egress_flow WHERE session_id = ? ORDER BY op_seq").all(S) as { row_type: string }[];
        assert.deepEqual(flowRows.map((r) => r.row_type), ["I", "I", "I", "I", "I", "I", "D", "I"], "the flow is append-only: turn 1's six +I rows (system + a..e), then the fold's D + I — no B row in this form (7773)");
        assert.equal(egressStateView(H.db, S).length, 4, "view has the system row + a + summary + e");
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), view.map((r) => r.msgid), "view survives the fold byte-identical");
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

test("recording with refs ledger: protection rows lose their dense numbers and the kernel's re-citation lands (cited-vs-dense divergence)", () => {
    const H = open();
    try {
        const S = "sess-rcite";
        // turn 1: the compress call + result are protected (BLOCKED — no
        // kernel citation), so their rows are dense-allocated; "a" is cited
        const t1 = [M("a", "one"), M("p1", "two", "assistant"), M("p2", "three")];
        let view = recordEgressTurn({
            store: H.store, sessionId: S, prev: undefined, conversation: t1, systemText: "SYS", nowMs: 1000,
            refMap: { byRaw: { a: "m00002", p1: "BLOCKED", p2: "BLOCKED" } },
        });
        assert.deepEqual(view.map((r) => r.num), [0, 2, 3, 4], "a is cited 2; the two protection rows are dense 3/4");
        // turn 2: the protection cleared in a different order — the fresh
        // reply "r" was cited by the kernel counter at 3 (it never saw the
        // dense numbers), while p1/p2 stay protected for this turn
        const t2 = [M("a", "one"), M("p1", "two", "assistant"), M("p2", "three"), M("r", "four", "assistant")];
        view = recordEgressTurn({
            store: H.store, sessionId: S, prev: view, conversation: t2, systemText: "SYS", nowMs: 2000,
            refMap: { byRaw: { a: "m00002", p1: "BLOCKED", p2: "BLOCKED", r: "m00003" } },
        });
        const byMsg = new Map(view.map((r) => [r.msgid, r.num]));
        assert.equal(byMsg.get("r"), 3, "the kernel's citation lands on the slot the demotion retired");
        assert.equal(byMsg.get("p1"), 0, "p1 demoted to 0 — its dense number is retired");
        assert.equal(byMsg.get("p2"), 0);
        // no rows were lost: the log advanced, not froze
        assert.equal((H.db.prepare("SELECT COUNT(*) AS c FROM egress_flow WHERE session_id = ?").get(S) as { c: number }).c, 7, "turn 1's 4 +I rows + turn 2's two demote-U + one +I");
        // turn 3: p1/p2 finally leave protection and the kernel cited them
        // at 5/6 — the rows re-home onto their citations
        const t3 = t2.map((m) => m);
        view = recordEgressTurn({
            store: H.store, sessionId: S, prev: view, conversation: t3, systemText: "SYS", nowMs: 3000,
            refMap: { byRaw: { a: "m00002", p1: "m00005", p2: "m00006", r: "m00003" } },
        });
        const byMsg3 = new Map(view.map((r) => [r.msgid, r.num]));
        assert.equal(byMsg3.get("p1"), 5, "re-homing onto the kernel citation");
        assert.equal(byMsg3.get("p2"), 6);
    } finally {
        close(H);
    }
});

test("#3617 negative direction: the plane can be forced OFF → gate never opens", () => {
    const saved = process.env.BILI_ROLLOUT_EGRESS_PLANE;
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "0";
    try {
        // this ci:full branch bakes egressPlane to 100 — the rollback path is
        // the forced "0" (the env always wins over the baked-in percent):
        // with the env at 0 the prepare-openai gate (featureEnabled) sees it OFF and
        // records no rows. The documented force-on is env "1" or config true.
        assert.equal(featureEnabled("egressPlane"), false, "forced 0 resolves OFF even against the branch default 100");
        process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
        assert.equal(featureEnabled("egressPlane"), true, "explicit 1 (the documented force-on) opens the gate");
    } finally {
        if (saved === undefined) delete process.env.BILI_ROLLOUT_EGRESS_PLANE;
        else process.env.BILI_ROLLOUT_EGRESS_PLANE = saved;
    }
});
