// #7574 (review of PR #6785), the outbound op log:
//   - two requests on one session: the second writer is REFUSED (it started
//     from a view that is no longer the log) — before, its ops were written on
//     top of the first writer's and the conversation silently changed order;
//   - a turn that deletes compacts in the same write, and the compaction
//     shrinks BOTH tables (the flow used to keep every row and gain one full
//     snapshot per fold);
//   - a system prompt that shows up in a later turn lands where the lane
//     serves it (first row), not at the end;
//   - a damaged serving copy is copied again from the log, a copy that ran
//     ahead of the log is cut back, a hole in the log is reported;
//   - recovery walks back ONLY on a real corruption — any other error (a busy
//     database, a failed read) is passed on and deletes nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BiliMessage } from "acp-kernel/wire";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import {
    EgressConcurrentWriteError,
    EgressStateCorruptError,
    diffEgressView,
    egressRebuildState,
    type EgressOp,
    type EgressViewRow,
} from "../src/storage/egress-state.ts";
import { EGRESS_SYSTEM_MSGID, buildEgressViewRows, recoverEgressBase, recordEgressTurn, type EgressOpLogStore } from "../src/storage/egress-record.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bili-7574-egress-hermetic-")), "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const M = (id: string, text: string, role: BiliMessage["role"] = "user"): BiliMessage => ({ id, role, contentType: "text", text });

interface Harness {
    store: UnifiedStore;
    ops: EgressOpLogStore;
    db: ReturnType<typeof openSqliteDatabase>["db"];
    dir: string;
}

function open(): Harness {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-7574-egress-"));
    const file = path.join(dir, "index.db");
    const { db } = openSqliteDatabase(file);
    migrateSchema(db);
    const store = UnifiedStore.open(file);
    const ops: EgressOpLogStore = {
        egressAppendTurn: (s, o, baseSeq, nowMs) => store.egressAppendTurn(s, o, baseSeq, nowMs),
        egressStateView: (s) => store.egressStateView(s),
        egressStateViewAt: (s, x) => store.egressStateViewAt(s, x),
        egressStateMaxSeq: (s) => store.egressStateMaxSeq(s),
        egressStateBaseSeq: (s) => store.egressStateBaseSeq(s),
        egressStateTruncateAfter: (s, x) => store.egressStateTruncateAfter(s, x),
    };
    return { store, ops, db, dir };
}

function close(H: Harness): void {
    try { H.store.close(); } catch { /* best effort */ }
    try { H.db.close(); } catch { /* best effort */ }
    fs.rmSync(H.dir, { recursive: true, force: true });
}

/** rows of a session per table, by row type in op_seq order */
function shape(H: Harness, S: string): { state: string[]; flow: string[] } {
    const q = (table: string) => (H.db.prepare(`SELECT row_type FROM ${table} WHERE session_id = ? ORDER BY op_seq`).all(S) as { row_type: string }[]).map((r) => r.row_type);
    return { state: q("egress_state"), flow: q("egress_flow") };
}

const ids = (rows: EgressViewRow[]) => rows.map((r) => r.msgid);
const SYS = EGRESS_SYSTEM_MSGID;

test("two requests on one session: the second writer is refused and the first turn stays intact", () => {
    const H = open();
    try {
        const S = "s-race";
        // both requests start from the same turn of the conversation
        const base = recordEgressTurn({ store: H.ops, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2"), M("c", "3")], systemText: "sys", nowMs: 1 });
        const baseSeq = H.store.egressStateMaxSeq(S);
        assert.deepEqual(ids(base), [SYS, "a", "b", "c"]);
        // request 1 deletes b …
        const afterDelete = buildEgressViewRows([M("a", "1"), M("c", "3")], "sys");
        H.store.egressAppendTurn(S, diffEgressView(base, afterDelete), baseSeq, 2);
        const written = shape(H, S);
        // … request 2 (the older view) inserts d "after b" — b is gone by now
        const afterInsert = buildEgressViewRows([M("a", "1"), M("b", "2"), M("d", "4"), M("c", "3")], "sys");
        assert.throws(() => H.store.egressAppendTurn(S, diffEgressView(base, afterInsert), baseSeq, 3), (e: unknown) => e instanceof EgressConcurrentWriteError && /moved during the turn/.test(e.message));
        assert.deepEqual(shape(H, S), written, "nothing of the refused request was written");
        assert.deepEqual(ids(H.store.egressStateView(S)), [SYS, "a", "c"], "the log holds the first request's turn");
    } finally {
        close(H);
    }
});

test("a batch that would break the log is refused before anything is written", () => {
    const H = open();
    try {
        const S = "s-bad";
        recordEgressTurn({ store: H.ops, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2")], systemText: "sys", nowMs: 1 });
        const baseSeq = H.store.egressStateMaxSeq(S);
        const before = shape(H, S);
        assert.throws(
            () => H.store.egressAppendTurn(S, [{ type: "I", msgid: "x", after: "not-there", ref: "m00009", tokens: 1, typeTag: "text", bytes: "h_x" }], baseSeq, 2),
            (e: unknown) => e instanceof EgressStateCorruptError && /insert anchor not-there missing/.test(e.message),
        );
        assert.deepEqual(shape(H, S), before, "nothing was written");
        assert.deepEqual(ids(H.store.egressStateView(S)), [SYS, "a", "b"], "the session is still on its healthy point");
    } finally {
        close(H);
    }
});

test("a turn that deletes compacts in the same write: both tables hold the base row, numbers continue", () => {
    const H = open();
    try {
        const S = "s-fold";
        const base = recordEgressTurn({ store: H.ops, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2"), M("c", "3"), M("d", "4"), M("e", "5")], systemText: "sys", nowMs: 1 });
        // fold b..d into one summary
        const folded = buildEgressViewRows([M("a", "1"), M("sum", "…", "assistant"), M("e", "5")], "sys");
        const view = recordEgressTurn({ store: H.ops, sessionId: S, prev: base, conversation: [M("a", "1"), M("sum", "…", "assistant"), M("e", "5")], systemText: "sys", nowMs: 2 });
        void folded;
        assert.deepEqual(ids(view), [SYS, "a", "sum", "e"]);
        const s = shape(H, S);
        assert.deepEqual(s.state, ["B"], "state: the base row, nothing else");
        assert.deepEqual(s.flow, ["B"], "flow: the base row replaced the rows below it (it used to keep all of them and add one snapshot per fold)");
        // the next message gets the next number, none is issued twice
        const high = Math.max(...view.map((r) => r.num));
        assert.equal(high, 7, "system + five messages + the summary row = seven numbers issued so far");
        const grown = recordEgressTurn({ store: H.ops, sessionId: S, prev: view, conversation: [M("a", "1"), M("sum", "…", "assistant"), M("e", "5"), M("f", "6")], systemText: "sys", nowMs: 3 });
        assert.equal(grown.find((r) => r.msgid === "f")!.num, high + 1, "numbering continues after the base — none is issued twice");
        assert.deepEqual(shape(H, S).flow, ["B", "I"]);
    } finally {
        close(H);
    }
});

test("a system prompt that shows up in a later turn becomes the first row, not the last", () => {
    const H = open();
    try {
        const S = "s-late-sys";
        const t1 = recordEgressTurn({ store: H.ops, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2")], systemText: "", nowMs: 1 });
        assert.deepEqual(ids(t1), ["a", "b"]);
        const t2 = recordEgressTurn({ store: H.ops, sessionId: S, prev: t1, conversation: [M("a", "1"), M("b", "2"), M("c", "3")], systemText: "sys", nowMs: 2 });
        assert.deepEqual(ids(t2), [SYS, "a", "b", "c"], "the stored order is the order the lane serves");
        // and the turn after it is a plain append — no delete+insert rewrite
        const before = shape(H, S).flow.length;
        const t3 = recordEgressTurn({ store: H.ops, sessionId: S, prev: t2, conversation: [M("a", "1"), M("b", "2"), M("c", "3"), M("d", "4")], systemText: "sys", nowMs: 3 });
        assert.deepEqual(ids(t3), [SYS, "a", "b", "c", "d"]);
        assert.equal(shape(H, S).flow.length, before + 1, "one insert for one new message");
    } finally {
        close(H);
    }
});

test("a damaged serving copy is copied again from the log; a copy that ran ahead of the log is cut back", () => {
    const H = open();
    try {
        const S = "s-copy";
        recordEgressTurn({ store: H.ops, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2")], systemText: "sys", nowMs: 1 });
        const good = ids(H.store.egressStateView(S));
        const max = H.store.egressStateMaxSeq(S);
        // 1. the serving copy alone is damaged
        H.db.prepare("INSERT INTO egress_state (session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at) VALUES (?, ?, NULL, 'U', 'ghost', ?, ?, 9)")
            .run(S, max + 1, JSON.stringify({ role: "user" }), "x");
        assert.deepEqual(ids(H.store.egressStateView(S)), good, "the read answers from the log");
        assert.equal(H.store.egressStateMaxSeq(S), max, "the extra row was removed when the copy was rebuilt");
        assert.deepEqual(shape(H, S).state, shape(H, S).flow, "copy and log agree again");
        // 2. the copy alone ran AHEAD of the log (a write that reached one table)
        H.db.prepare("INSERT INTO egress_state (session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at) VALUES (?, ?, 9, 'I', 'ghost', ?, ?, 9)")
            .run(S, max + 1, JSON.stringify({ after: "b", ref: "m00009", tokens: 1, type: "text" }), "x");
        assert.deepEqual(ids(H.store.egressStateView(S)), good, "a row the log does not have is not served");
        assert.deepEqual(shape(H, S).state, shape(H, S).flow, "copy and log agree again");
        // 3. the LOG itself has a hole: reported, nothing is deleted
        H.db.prepare("DELETE FROM egress_flow WHERE session_id = ? AND op_seq = 2").run(S);
        H.db.prepare("DELETE FROM egress_state WHERE session_id = ? AND op_seq = 2").run(S);
        assert.throws(() => H.store.egressStateView(S), (e: unknown) => e instanceof EgressStateCorruptError && /op_seq jumps from 1 to 3/.test(e.message));
        assert.equal(H.store.egressStateMaxSeq(S), max, "a corrupt log is left as it is");
    } finally {
        close(H);
    }
});

test("the rebuild copies the log row for row and leaves nothing of the old copy", () => {
    const H = open();
    try {
        const S = "s-rebuild";
        const view = recordEgressTurn({ store: H.ops, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2")], systemText: "sys", nowMs: 1 });
        H.db.prepare("DELETE FROM egress_state WHERE session_id = ?").run(S);
        H.db.prepare("INSERT INTO egress_state (session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at) VALUES (?, 99, NULL, 'U', 'ghost', ?, ?, 9)")
            .run(S, JSON.stringify({ role: "user" }), "x");
        const rebuilt = egressRebuildState(H.db, S);
        assert.deepEqual(rebuilt, view, "the view comes back from the log");
        assert.deepEqual(shape(H, S).state, shape(H, S).flow, "the copy is the log, row for row");
    } finally {
        close(H);
    }
});

test("truncation removes the rows of both tables; the operator's reset removes the whole log", () => {
    const H = open();
    try {
        const S = "s-truncate";
        recordEgressTurn({ store: H.ops, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2"), M("c", "3")], systemText: "sys", nowMs: 1 });
        const max = H.store.egressStateMaxSeq(S);
        assert.equal(max, 4, "system + 3 messages");
        const removed = H.store.egressStateTruncateAfter(S, max - 1);
        assert.equal(removed, 2, "one row in each table");
        assert.deepEqual(shape(H, S), { state: ["I", "I", "I"], flow: ["I", "I", "I"] });
        H.store.deleteEgressOps(S);
        assert.deepEqual(shape(H, S), { state: [], flow: [] });
        assert.equal(H.store.egressStateMaxSeq(S), 0);
    } finally {
        close(H);
    }
});

test("recovery walks back only on a real corruption — any other error is passed on and deletes nothing", () => {
    const busy = new Error("SQLITE_BUSY: database is locked");
    let scans = 0;
    let truncations = 0;
    const fake: EgressOpLogStore = {
        egressAppendTurn: () => { throw new Error("not used"); },
        egressStateView: () => { scans++; throw busy; },
        egressStateViewAt: () => { scans++; throw new Error("must not be reached"); },
        egressStateMaxSeq: () => 40,
        egressStateTruncateAfter: () => { truncations++; return 0; },
    };
    assert.throws(() => recoverEgressBase(fake, "s-busy"), (e: unknown) => e === busy, "the error is passed on unchanged");
    assert.equal(scans, 1, "no walk-back was attempted");
    assert.equal(truncations, 0, "nothing was deleted");

    // a real corruption at the tail: the newest healthy point is kept, the
    // rows after it are removed from BOTH tables, in one step
    let reads = 0;
    const corrupt = new EgressStateCorruptError("s-broken", "payload at op_seq=40 is not an object");
    const walked: number[] = [];
    const fake2: EgressOpLogStore = {
        egressAppendTurn: () => { throw new Error("not used"); },
        egressStateView: () => { reads++; throw corrupt; },
        egressStateViewAt: (_sid, seq) => {
            walked.push(seq);
            if (seq >= 40) throw corrupt;
            return buildEgressViewRows([M("a", "1")], "sys");
        },
        egressStateMaxSeq: () => 40,
        egressStateTruncateAfter: (sid, seq) => { truncations++; assert.equal(sid, "s-broken"); assert.equal(seq, 39); return 2; },
    };
    const out = recoverEgressBase(fake2, "s-broken");
    assert.equal(reads, 1);
    assert.deepEqual(walked, [39], "the walk stops at the newest healthy point");
    assert.deepEqual(out, { view: buildEgressViewRows([M("a", "1")], "sys"), seq: 39, degraded: true, truncated: 2 });
    assert.equal(truncations, 1);
});
