// #7574 (part 1), the op-log invariant, checked against a REAL SQLite
// database through the UnifiedStore wrapper (not a fake):
//   - one writer per session: a second request that starts from the same
//     turn is refused, and nothing of it reaches either table;
//   - a batch whose ops cannot apply to the current view is refused before
//     any row is written;
//   - a turn that deletes (a fold) physically deletes the state rows in the
//     same write — the flow keeps its full history and its letter alphabet
//     is I/D/U (7773 — there is no base row, no compaction step);
//   - the numbers the lane hands out never repeat, even across such a turn;
//   - the materialized state is a read-time replica of the flow: damage to
//     the state alone is healed by a full-history replay in the same read,
//     a state row the flow does not carry is not served, and a hole in the
//     flow itself is reported with nothing deleted.
//
// The operator surfaces (truncate / full reset) are the admin endpoints;
// they must remove whole spans, row for row, from BOTH tables.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BiliMessage } from "acp-kernel/wire";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import {
    EgressConcurrentWriteError,
    EgressStateCorruptError,
    diffEgressView,
    egressRebuildState,
    type EgressViewRow,
} from "../src/storage/egress-state.ts";
import { EGRESS_SYSTEM_MSGID, buildEgressViewRows, recordEgressTurn, recoverEgressBase, type EgressOpLogStore } from "../src/storage/egress-record.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bili-7574-egress-hermetic-")), "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const M = (id: string, text: string, role: "user" | "assistant" = "user") => ({ id, role, contentType: "text" as const, text });

interface Harness {
    store: UnifiedStore;
    ops: EgressOpLogStore;
    db: ReturnType<typeof openSqliteDatabase>["db"];
    dir: string;
}

function open(): Harness {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-7574-"));
    const file = path.join(dir, "index.db");
    const { db } = openSqliteDatabase(file);
    migrateSchema(db);
    const store = UnifiedStore.open(file);
    const ops: EgressOpLogStore = {
        egressAppendTurn: (s, o, baseSeq, nowMs) => store.egressAppendTurn(s, o, baseSeq, nowMs),
        egressStateView: (s) => store.egressStateView(s),
        egressStateViewAt: (s, x) => store.egressStateViewAt(s, x),
        egressStateMaxSeq: (s) => store.egressStateMaxSeq(s),
        egressFlowWalkBack: (s) => store.egressFlowWalkBack(s),
        egressStateTruncateAfter: (s, x) => store.egressStateTruncateAfter(s, x),
    };
    return { store, ops, db, dir };
}

function close(H: Harness): void {
    try { H.store.close(); } catch { /* best effort */ }
    try { H.db.close(); } catch { /* best effort */ }
    fs.rmSync(H.dir, { recursive: true, force: true });
}

/** the two planes, by what each table says: the state's live msgids in pos order and the flow's row types in op_seq order */
function shape(H: Harness, S: string): { state: string[]; flow: string[] } {
    const state = (H.db.prepare("SELECT msgid FROM egress_state WHERE session_id = ? ORDER BY pos").all(S) as { msgid: string }[]).map((r) => r.msgid);
    const flow = (H.db.prepare("SELECT row_type FROM egress_flow WHERE session_id = ? ORDER BY op_seq").all(S) as { row_type: string }[]).map((r) => r.row_type);
    return { state, flow };
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
            () => H.store.egressAppendTurn(S, [{ type: "I", rid: 98, msgid: "x", after: 99, tokens: 1, typeTag: "text", bytes: "h_x" }], baseSeq, 2),
            (e: unknown) => e instanceof EgressStateCorruptError && /insert anchor rid 99 missing/.test(e.message),
        );
        assert.deepEqual(shape(H, S), before, "nothing was written");
        assert.deepEqual(ids(H.store.egressStateView(S)), [SYS, "a", "b"], "the session is still on its healthy point");
    } finally {
        close(H);
    }
});

test("a turn that deletes removes the state rows in the same write; the flow keeps its full history (7773)", () => {
    const H = open();
    try {
        const S = "s-fold";
        const base = recordEgressTurn({ store: H.ops, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2"), M("c", "3"), M("d", "4"), M("e", "5")], systemText: "sys", nowMs: 1 });
        // fold b..d into one summary
        const view = recordEgressTurn({ store: H.ops, sessionId: S, prev: base, conversation: [M("a", "1"), M("sum", "…", "assistant"), M("e", "5")], systemText: "sys", nowMs: 2 });
        assert.deepEqual(ids(view), [SYS, "a", "sum", "e"]);
        const s = shape(H, S);
        assert.deepEqual(s.state, [SYS, "a", "sum", "e"], "state: the live rows only — b..d physically deleted with the D op");
        assert.deepEqual(s.flow, ["I", "I", "I", "I", "I", "I", "D", "I"], "flow: append-only — turn 1's six +I rows (system + a..e), then the fold's D + I; no base row (7773)");
        // the next message gets the next number, none is issued twice
        const high = Math.max(...view.map((r) => r.rid!));
        assert.equal(high, 7, "system row + five messages (rids 1..6) + the summary row (rid 7) = seven rids issued (2026-11-28: the system row takes its own rid like any row)");
        const grown = recordEgressTurn({ store: H.ops, sessionId: S, prev: view, conversation: [M("a", "1"), M("sum", "…", "assistant"), M("e", "5"), M("f", "6")], systemText: "sys", nowMs: 3 });
        assert.equal(grown.find((r) => r.msgid === "f")!.rid, high + 1, "numbering continues after the fold — none is issued twice");
        assert.deepEqual(shape(H, S).flow, ["I", "I", "I", "I", "I", "I", "D", "I", "I"], "the flow never loses rows; only the state plane is materialized");
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

test("the materialized state is healed by a full-history replay; a state row the flow lacks is not served; a hole in the flow is reported", () => {
    const H = open();
    try {
        const S = "s-copy";
        recordEgressTurn({ store: H.ops, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2")], systemText: "sys", nowMs: 1 });
        const good = ids(H.store.egressStateView(S));
        const max = H.store.egressStateMaxSeq(S);
        // 1. the state alone is damaged (an orphan row): the self-healing
        //    read replays the flow and rebuilds the state in place
        H.db.prepare("INSERT INTO egress_state (session_id, rid, msgid, pos, tokens, type, role, ts, sys_in, bytes, created_at) VALUES (?, 99, 'ghost', 99, 0, 'text', 'user', 0, 0, 'x', 9)")
            .run(S);
        assert.deepEqual(ids(H.store.egressStateView(S)), good, "the read answers from the flow, healed");
        assert.equal(H.store.egressStateMaxSeq(S), max, "the flow is untouched");
        assert.deepEqual(shape(H, S).state, good, "the orphan row was removed when the state was rebuilt");
        // 2. the state alone runs AHEAD of the flow (a write that reached
        //    one table): the row the flow does not carry is not served
        H.db.prepare("INSERT INTO egress_state (session_id, rid, msgid, pos, tokens, type, role, ts, sys_in, bytes, created_at) VALUES (?, 99, 'ghost', 99, 1, 'text', 'user', 0, 0, 'x', 9)")
            .run(S);
        assert.deepEqual(ids(H.store.egressStateView(S)), good, "a row the flow does not have is not served");
        assert.deepEqual(shape(H, S).state, good, "the state is the flow, row for row");
        // 3. the FLOW itself has a hole: reported, nothing is deleted
        H.db.prepare("DELETE FROM egress_flow WHERE session_id = ? AND op_seq = 2").run(S);
        assert.throws(() => H.store.egressStateView(S), (e: unknown) => e instanceof EgressStateCorruptError && /op_seq jumps from 1 to 3/.test(e.message));
        assert.equal(H.store.egressStateMaxSeq(S), max, "a corrupt flow is left as it is");
    } finally {
        close(H);
    }
});

test("the rebuild replays the flow row for row and leaves nothing of the old state", () => {
    const H = open();
    try {
        const S = "s-rebuild";
        const view = recordEgressTurn({ store: H.ops, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2")], systemText: "sys", nowMs: 1 });
        H.db.prepare("DELETE FROM egress_state WHERE session_id = ?").run(S);
        H.db.prepare("INSERT INTO egress_state (session_id, rid, msgid, pos, tokens, type, role, ts, sys_in, bytes, created_at) VALUES (?, 99, 'ghost', 99, 0, 'text', 'user', 0, 0, 'x', 9)")
            .run(S);
        const rebuilt = egressRebuildState(H.db, S);
        assert.deepEqual(rebuilt, view, "the view comes back from the flow");
        assert.equal((H.db.prepare("SELECT COUNT(*) AS c FROM egress_state WHERE session_id = ?").get(S) as { c: number }).c, view.length, "the state is the replay, row for row");
        assert.deepEqual(ids(H.store.egressStateView(S)), ids(view), "and the read serves it");
    } finally {
        close(H);
    }
});

test("truncation removes the flow span and re-materializes the state; the operator's reset removes the whole log", () => {
    const H = open();
    try {
        const S = "s-truncate";
        recordEgressTurn({ store: H.ops, sessionId: S, prev: undefined, conversation: [M("a", "1"), M("b", "2"), M("c", "3")], systemText: "sys", nowMs: 1 });
        const max = H.store.egressStateMaxSeq(S);
        assert.equal(max, 4, "system + 3 messages");
        const removed = H.store.egressStateTruncateAfter(S, max - 1);
        assert.equal(removed, 1, "one flow row past the point; the state is re-materialized from the replay, not row-deleted");
        assert.deepEqual(shape(H, S), { state: [SYS, "a", "b"], flow: ["I", "I", "I"] });
        H.store.deleteEgressOps(S);
        assert.deepEqual(shape(H, S), { state: [], flow: [] });
        assert.equal(H.store.egressStateMaxSeq(S), 0);
    } finally {
        close(H);
    }
});

test("recovery walks back only on a real corruption — any other error is passed on and deletes nothing", () => {
    const busy = new Error("SQLITE_BUSY: database is locked");
    let reads = 0;
    let truncations = 0;
    const fake: EgressOpLogStore = {
        egressAppendTurn: () => { throw new Error("not used"); },
        egressStateView: () => { reads++; throw busy; },
        egressStateViewAt: () => { throw new Error("must not be reached"); },
        egressStateMaxSeq: () => 40,
        egressFlowWalkBack: () => { throw new Error("must not be reached"); },
        egressStateTruncateAfter: () => { truncations++; return 0; },
    };
    assert.throws(() => recoverEgressBase(fake, "s-busy"), (e: unknown) => e === busy, "the error is passed on unchanged");
    assert.equal(reads, 1, "no walk-back was attempted");
    assert.equal(truncations, 0, "nothing was deleted");

    // a real corruption at the tail: the newest healthy point is kept, the
    // rows after it are removed from the flow in one step, the state is
    // re-materialized from the surviving span
    let corruptReads = 0;
    let walkCalls = 0;
    const corrupt = new EgressStateCorruptError("s-broken", "payload at op_seq=40 is not an object");
    const healthy = buildEgressViewRows([M("a", "1")], "sys");
    const fake2: EgressOpLogStore = {
        egressAppendTurn: () => { throw new Error("not used"); },
        egressStateView: () => { corruptReads++; throw corrupt; },
        egressStateViewAt: (_sid, seq) => {
            if (seq >= 40) throw corrupt;
            return healthy;
        },
        egressStateMaxSeq: () => 40,
        egressFlowWalkBack: (sid) => {
            walkCalls++;
            assert.equal(sid, "s-broken");
            return { seq: 39, view: healthy };
        },
        egressStateTruncateAfter: (sid, seq) => { truncations++; assert.equal(sid, "s-broken"); assert.equal(seq, 39); return 2; },
    };
    const out = recoverEgressBase(fake2, "s-broken");
    assert.equal(corruptReads, 1);
    assert.equal(walkCalls, 1, "exactly one full-history pass (7773)");
    assert.deepEqual(out, { view: healthy, seq: 39, degraded: true, truncated: 2 });
    assert.equal(truncations, 1);
});
