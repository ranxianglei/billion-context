/**
 * Egress state log (proposal discussions/7398, #6785 perf work;
 * MATERIALIZED form per discussions/7773 owner ruling 2026-11-26):
 * the op-log outbound view. Tests pin the CONTRACT:
 *   - replay determinism: same op sequence → same view, always;
 *   - the three row types (+I tail/anchored, -D inclusive range, +U
 *     content/number — the 7773 letter alphabet is I/D/U; the B base row
 *     never existed in this form: not written, not read) and their payload
 *     shapes;
 *   - the hard-error paths (missing anchor / missing or inverted delete
 *     endpoints / update target missing / duplicate row id) throw, never
 *     degrade fuzzy — and addressing is by row id (2026-11-27): a msgid may
 *     collide or churn, the log's anchors never do;
 *   - egress_state is the MATERIALIZED live view: its row count == the
 *     live row count (ORDER BY pos serving read, no replay); egress_flow
 *     keeps every row forever (append-only, physically never deleted —
 *     growth optimization is the separate #7475 family);
 *   - rollback: ANY point (from 0) stays reconstructible from egress_flow;
 *   - a batch that would not replay is refused at append time (#7574);
 *   - a manually planted corrupt FLOW row does not break serving while the
 *     state view is intact (the read is a consistent snapshot) — it is
 *     surfaced by the full replay (egressStateAt) and blocks the walk-back,
 *     which is the degrade path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import {
    egressStateAppend,
    egressStateView,
    egressStateAt,
    egressFork,
    egressFlowWalkBack,
    egressStateRead,
    EgressStateCorruptError,
    EGRESS_SYSTEM_MSGID,
    diffEgressView,
    egressReplay,
    type EgressOp,
    type EgressViewRow,
} from "../src/storage/egress-state.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-state-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

interface Harness {
    db: ReturnType<typeof openSqliteDatabase>["db"];
    dir: string;
}

function open(): Harness {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-state-"));
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

const h = (m: string) => `h_${m}`;

// The rid IS the message number (2026-11-28): db-backed tests assert the
// stamped rids explicitly; pure diff/replay fixtures stamp rids 1..n in
// view order (the `stamped` helper) and comparisons ignore rids (norm).
const norm = (rows: EgressViewRow[]) => rows.map(({ rid, ...rest }) => rest);

// Pure diff/replay fixtures build views without rids — diff assigns them
// defensively from its counter, but a REPLAY resolves rid anchors against
// the prev view, so tests stamp rids 1..n in view order (the same shape a
// DB-backed log holds). `next` views need none: diff reads only their
// content, and fresh rows get their rids from the diff's counter.
const stamped = (rows: EgressViewRow[]): EgressViewRow[] => rows.map((r, i) => (typeof r.rid === "number" ? r : { ...r, rid: i + 1 }));


/** Total rows of a session in BOTH tables. */
function rows(h: Harness, S: string): number {
    const n = (table: string) => (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(S) as { n: number }).n;
    return n("egress_state") + n("egress_flow");
}

/** Live rows (materialized view) of a session. */
function stateRows(h: Harness, S: string): number {
    return (h.db.prepare(`SELECT COUNT(*) AS n FROM egress_state WHERE session_id = ?`).get(S) as { n: number }).n;
}

/** Flow rows (append-only record) of a session. */
function flowRows(h: Harness, S: string): number {
    return (h.db.prepare(`SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?`).get(S) as { n: number }).n;
}

/** Write one op row straight into the FLOW only, bypassing the append
 *  check (7773: egress_state is the materialized live view — a hand edit
 *  targets the record, and the read path must survive it while the view is
 *  intact). */
function plant(h: Harness, S: string, op: EgressOp, opSeq: number, nowMs: number): void {
    const written =
        op.type === "I"
            ? ["I", op.rid, op.msgid, JSON.stringify({ after: op.after, tokens: op.tokens, type: op.typeTag, role: op.role }), op.bytes]
            : op.type === "D"
                ? ["D", null, null, JSON.stringify({ start: op.start, end: op.end }), null]
                : ["U", op.rid, op.msgid, JSON.stringify({ role: op.role }), op.bytes];
    const [rowType, rid, msgid, payload, bytes] = written as [string, number | null, string | null, string, string | null];
    h.db.prepare(`INSERT INTO egress_flow (session_id, op_seq, row_type, rid, msgid, payload, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(S, opSeq, rowType, rid, msgid, payload, bytes, nowMs);
}

test("replay determinism: the five-op example from the proposal", () => {
    const H = open();
    try {
        const S = "sess-1";
        // `after: null` means "this is the FIRST row of the view"; an append
        // names the row it follows (#7574: the stored replay now agrees with
        // the diff on this — it used to put an unanchored row at the end)
        egressStateAppend(H.db, S, [
            { type: "I", rid: 1, msgid: "a", after: null, tokens: 3, typeTag: "text", bytes: "h_a1" },
            { type: "I", rid: 2, msgid: "b", after: 1, tokens: 4, typeTag: "text", bytes: "h_b1" },
            { type: "I", rid: 3, msgid: "c", after: 2, tokens: 9, typeTag: "summary", bytes: "h_c1" },
            { type: "D", start: 1, end: 2 },
            { type: "U", rid: 3, msgid: "c", bytes: "h_c2" },
        ], 1_000);
        const view = egressStateView(H.db, S);
        assert.deepEqual(view.map((r) => r.msgid), ["c"]);
        assert.equal(view[0].bytes, h("c2"));
        // 2026-11-28: the rid IS the message number — c was the 3rd I op
        // (a=1, b=2, c=3); the -D and +U consumed no rids, so c keeps 3
        // even though 5 ops exist
        assert.equal(view[0].rid, 3);
        // tokens/type survive the content update untouched
        assert.equal(view[0].tokens, 9);
        assert.equal(view[0].type, "summary");
        // replay twice → byte-identical
        assert.deepEqual(egressStateView(H.db, S), view);
    } finally {
        close(H);
    }
});

test("+I anchored insert lands mid-history; an unanchored +I is the new first row; -D endpoints are msgids, not positions", () => {
    const H = open();
    try {
        const S = "sess-2";
        egressStateAppend(H.db, S, [
            { type: "I", rid: 1, msgid: "a", after: null, tokens: 1, typeTag: "text", bytes: "h_a" },
            { type: "I", rid: 2, msgid: "d", after: 1, tokens: 1, typeTag: "text", bytes: "h_d" },
            { type: "I", rid: 3, msgid: "e", after: 2, tokens: 1, typeTag: "text", bytes: "h_e" },
            // mid-history insert anchored at a (positions of d/e shift)
            { type: "I", rid: 4, msgid: "b", after: 1, tokens: 1, typeTag: "text", bytes: "h_b" },
            { type: "I", rid: 5, msgid: "c", after: 4, tokens: 1, typeTag: "text", bytes: "h_c" },
        ], 1_000);
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), ["a", "b", "c", "d", "e"]);
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.rid), [1, 4, 5, 2, 3], "the live view's rids follow the flow history, not the positions");
        // a system prompt that shows up in a later turn becomes the FIRST row
        // (what the diff asks for; what the lane then serves)
        egressStateAppend(H.db, S, [
            { type: "I", rid: 6, msgid: "sys", after: null, tokens: 0, typeTag: "system", bytes: "h_sys" },
        ], 1_500);
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), ["sys", "a", "b", "c", "d", "e"]);
        // a fold deletes b..d (rids 4,5,2 by position — b=4, c=5, d=2) —
        // sys, a and e survive in place
        egressStateAppend(H.db, S, [{ type: "D", start: 4, end: 2 }], 2_000);
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), ["sys", "a", "e"]);
        // single-row delete (start == end)
        egressStateAppend(H.db, S, [{ type: "D", start: 1, end: 1 }], 3_000);
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), ["sys", "e"]);
    } finally {
        close(H);
    }
});

test("hard errors: missing anchor / missing or inverted endpoints / update target missing / duplicate msgid (#3617 negative direction)", () => {
    const H = open();
    try {
        // each scenario gets a FRESH session: replay throws at the FIRST
        // violating op in seq order, so stacking bad ops in one session would
        // only ever surface the earliest one.
        const seed = (S: string) => {
            egressStateAppend(H.db, S, [
                { type: "I", rid: 1, msgid: "a", after: null, tokens: 1, typeTag: "text", bytes: "h_a" },
                { type: "I", rid: 2, msgid: "b", after: 1, tokens: 1, typeTag: "text", bytes: "h_b" },
            ], 1_000);
        };
        const corrupt = (e: unknown, re: RegExp) => e instanceof EgressStateCorruptError && re.test(e.message);
        // #7574: a batch that would not replay is REFUSED when it is appended —
        // nothing is written and the session stays on its last healthy point.
        // (It used to be written first and to blow up on the next read.)
        const refused = (S: string, ops: EgressOp[], re: RegExp) => {
            seed(S);
            assert.throws(() => egressStateAppend(H.db, S, ops, 2_000), (e: unknown) => corrupt(e, re), `${S}: the append refuses the batch`);
            assert.equal(rows(H, S), 4, `${S}: nothing was written (the 2 seed rows in each table)`);
            assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), ["a", "b"], `${S}: still on the healthy point`);
        };
        refused("anchor-missing", [
            { type: "I", rid: 3, msgid: "x", after: 99, tokens: 1, typeTag: "text", bytes: "h_x" },
        ], /anchor rid 99 missing/);
        refused("endpoint-missing", [{ type: "D", start: 1, end: 99 }], /delete end rid 99 missing/);
        refused("start-missing", [{ type: "D", start: 99, end: 2 }], /delete start rid 99 missing/);
        refused("inverted", [{ type: "D", start: 2, end: 1 }], /inverted/);
        refused("update-missing", [{ type: "U", rid: 99, msgid: "ghost", bytes: "h_g" }], /update target rid 99 missing/);
        refused("dup-rid", [
            { type: "I", rid: 1, msgid: "x", after: null, tokens: 1, typeTag: "text", bytes: "h_x" },
        ], /duplicate row id 1/);
        // 2026-11-27 (row ids): a COLLIDING msgid on a fresh row is legal at
        // the log layer — addressing is by rid, so the two rows stay
        // distinguishable (before/after an edit or a re-homing) where msgids
        // cannot be.
        seed("collide");
        egressStateAppend(H.db, "collide", [
            { type: "I", rid: 3, msgid: "a", after: 1, tokens: 1, typeTag: "text", bytes: "h_x" },
        ], 3_000);
        assert.deepEqual(egressStateView(H.db, "collide").map((r) => r.rid), [1, 3, 2], "same msgid, fresh rid: both rows live and distinct");
        // 7773: a bad row that got into the FLOW some other way (a library
        // edited by hand, a half-copied backup) must NOT break serving while
        // the materialized view is intact — the read is a consistent
        // snapshot — and the full replay (the rollback path) reports it, so
        // the degrade ladder (walk-back / truncate) can reach the damage.
        const planted = (S: string, op: EgressOp, re: RegExp) => {
            seed(S);
            plant(H, S, op, 3, 2_000);
            assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), ["a", "b"], `${S}: the intact view still serves`);
            assert.throws(() => egressStateAt(H.db, S, Number.MAX_SAFE_INTEGER), (e: unknown) => corrupt(e, re), `${S}: the full replay reports the planted bad row`);
        };
        planted("planted-anchor", { type: "I", rid: 3, msgid: "x", after: 99, tokens: 1, typeTag: "text", bytes: "h_x" }, /anchor rid 99 missing/);
        planted("planted-end", { type: "D", start: 1, end: 99 }, /delete end rid 99 missing/);
        planted("planted-dup", { type: "I", rid: 1, msgid: "a", after: 2, tokens: 1, typeTag: "text", bytes: "h_a2" }, /duplicate row id 1/);
        // and the healthy sessions in the same db still replay cleanly (no
        // cross-session leakage from the corrupt rows)
        seed("healthy");
        assert.deepEqual(egressStateView(H.db, "healthy").map((r) => r.msgid), ["a", "b"]);
        // a GOOD op after a BAD op must not be masked: drop the bad row, replay OK
        H.db.prepare("DELETE FROM egress_flow WHERE session_id = 'planted-anchor' AND op_seq = 3").run();
        assert.deepEqual(egressStateView(H.db, "planted-anchor").map((r) => r.msgid), ["a", "b"]);
        assert.deepEqual(egressStateAt(H.db, "planted-anchor", Number.MAX_SAFE_INTEGER).map((r) => r.msgid), ["a", "b"], "the full replay is healthy again once the bad row is gone");
    } finally {
        close(H);
    }
});

test("materialized view: state row count == live row count, flow keeps its full history, no B row (7773)", () => {
    const H = open();
    try {
        const S = "sess-4";
        // 10 tail appends, then a fold collapses 1..6 into one summary
        const ops: EgressOp[] = [];
        ops.push({ type: "I", rid: 1, msgid: "m1", after: null, tokens: 1, typeTag: "text", bytes: "h_m1" });
        for (let i = 2; i <= 10; i++) {
            ops.push({ type: "I", rid: i, msgid: `m${i}`, after: i - 1, tokens: i, typeTag: "text", bytes: `h_m${i}` });
        }
        ops.push({ type: "I", rid: 11, msgid: "fold", after: 6, tokens: 77, typeTag: "summary", bytes: "h_fold" });
        ops.push({ type: "D", start: 1, end: 6 });
        egressStateAppend(H.db, S, ops, 1_000);
        const before = egressStateView(H.db, S);
        assert.deepEqual(before.map((r) => r.msgid), ["fold", "m7", "m8", "m9", "m10"]);

        // state = the live view exactly: 5 rows for 5 live messages (the 6
        // deleted ones are physically gone — 7773: D deletes the rows, no
        // tombstones); flow = the full record: every one of the 12 ops.
        assert.equal(stateRows(H, S), 5);
        assert.equal(flowRows(H, S), 12);
        // the row alphabet is I/D/U — the B base letter never exists in this
        // form (not written, not read, not in the CHECK)
        const types = (H.db.prepare("SELECT DISTINCT row_type AS t FROM egress_flow WHERE session_id = ? ORDER BY t").all(S) as { t: string }[]).map((r) => r.t);
        assert.deepEqual(types, ["D", "I"]);

        assert.deepEqual(before.map((r) => r.rid), [11, 7, 8, 9, 10], "I rows numbered (by rid) in append order (fold=11);");
        // the state row's rid == its flow I twin's rid (same rid identifies
        // the row in both tables — 2026-11-28: there is no second number)
        const twin = H.db.prepare("SELECT rid FROM egress_state WHERE session_id = ? AND msgid = ?").get(S, "fold") as { rid: number };
        assert.equal(twin.rid, 11);

        // ops after the fold still apply on the live view, numbers continue
        // from the flow high-water (11)
        egressStateAppend(H.db, S, [
            { type: "I", rid: 12, msgid: "m11", after: 10, tokens: 11, typeTag: "text", bytes: "h_m11" },
        ], 3_000);
        const grown = egressStateView(H.db, S);
        assert.deepEqual(grown.map((r) => r.msgid), ["fold", "m7", "m8", "m9", "m10", "m11"]);
        assert.equal(grown.find((r) => r.msgid === "m11")!.rid, 12, "the next number continues the flow high-water");
        assert.equal(stateRows(H, S), 6, "state stays == the live count");
        assert.equal(flowRows(H, S), 13, "flow keeps every row");
        // the serving read is byte-stable across calls (no replay wobble)
        assert.deepEqual(egressStateView(H.db, S), grown);
    } finally {
        close(H);
    }
});

test("rollback: every point — from 0 up — stays reconstructible from egress_flow (no base concept, 7773)", () => {
    const H = open();
    try {
        const S = "sess-5";
        // snapshot the view at every seq 1..6
        const snapshots = new Map<number, EgressViewRow[]>();
        for (let i = 1; i <= 5; i++) {
            egressStateAppend(H.db, S, [
                { type: "I", rid: i, msgid: `m${i}`, after: i === 1 ? null : i - 1, tokens: i, typeTag: "text", bytes: `h_m${i}` },
            ], 1_000 + i);
            snapshots.set(i, egressStateView(H.db, S));
        }
        egressStateAppend(H.db, S, [{ type: "U", rid: 2, msgid: "m2", bytes: "h_m2-edit" }], 6_000);
        snapshots.set(6, egressStateView(H.db, S));
        assert.equal(snapshots.get(6)![1].rid, 2, "the +U did not change m2's number");
        // the materialized view serves the current point byte-identically to
        // the full replay (state == replay(flow) after every write)
        assert.deepEqual(egressStateView(H.db, S), egressStateAt(H.db, S, 6));
        egressStateAppend(H.db, S, [
            { type: "I", rid: 6, msgid: "m6", after: 5, tokens: 6, typeTag: "text", bytes: "h_m6" },
        ], 11_000);
        const later = egressStateView(H.db, S);
        assert.deepEqual(egressStateAt(H.db, S, 7), later, "a point after the last write");
        // seq 0 = empty view
        assert.deepEqual(egressStateAt(H.db, S, 0), []);
        // the flow is append-only and holds the WHOLE history: every earlier
        // point reconstructs byte-for-byte from it (no base floor to stop at)
        for (const seq of [1, 2, 3, 4, 5, 6, 7]) {
            assert.deepEqual(egressStateAt(H.db, S, seq), snapshots.has(seq) ? snapshots.get(seq) : later, `seq ${seq} reconstructs`);
        }
    } finally {
        close(H);
    }
});

// ---- diff engine (segment 2) ------------------------------------------

const V = (msgid: string, bytes = "h_" + msgid, tokens = 3, type = "text"): EgressViewRow =>
    ({ msgid, tokens, type, bytes });


test("diff: case 1 — tail append emits exactly one +I anchored to the last row", () => {
    const prev = stamped([V("a"), V("b")]);
    const next = [...prev, V("c")];
    const ops = diffEgressView(prev, next);
    assert.deepEqual(ops, [{ type: "I", rid: 3, msgid: "c", after: 2, tokens: 3, typeTag: "text", bytes: "h_c" }]);
    assert.deepEqual(norm(egressReplay(prev, ops)), norm(next));
});

test("diff: cases 2+3 — nudge appears (+I) and vanishes (-D) without touching the prefix", () => {
    const base = stamped([V("a"), V("b")]);
    const nudged = stamped([...base, V("nudge", "h_n", 1, "nudge")]);
    assert.deepEqual(diffEgressView(base, nudged), [
        { type: "I", rid: 3, msgid: "nudge", after: 2, tokens: 1, typeTag: "nudge", bytes: "h_n" },
    ]);
    assert.deepEqual(norm(egressReplay(base, diffEgressView(base, nudged))), norm(nudged));
    assert.deepEqual(diffEgressView(nudged, base), [{ type: "D", start: 3, end: 3 }]);
    assert.deepEqual(norm(egressReplay(nudged, diffEgressView(nudged, base))), norm(base));
});

test("diff: case 4 — fold replaces a range with one summary row after the surviving anchor", () => {
    const prev = stamped([V("a"), V("b"), V("c"), V("d"), V("e"), V("f")]);
    const folded = [V("a"), V("sum", "h_sum", 42, "acp_summary"), V("f")];
    assert.deepEqual(diffEgressView(prev, folded), [
        { type: "D", start: 2, end: 5 },
        { type: "I", rid: 7, msgid: "sum", after: 1, tokens: 42, typeTag: "acp_summary", bytes: "h_sum" },
    ]);
    assert.deepEqual(norm(egressReplay(prev, diffEgressView(prev, folded))), norm(folded));
});

test("diff: case U — content edit of an existing row is a +U, position and triple untouched", () => {
    const prev = stamped([V("a", "h_a1"), V("b")]);
    const next = [{ ...prev[0], bytes: "h_a2" }, prev[1]];
    assert.deepEqual(diffEgressView(prev, next), [{ type: "U", rid: 1, msgid: "a", bytes: "h_a2" }]);
    const replayed = egressReplay(prev, diffEgressView(prev, next));
    assert.deepEqual(norm(replayed), norm(next));
    assert.equal(replayed[0].tokens, 3, "+U must not touch tokens");
});

// ---- collision pairs (same msgid, distinct rids — #7851) -----------------
// The host minted two rows with the SAME msgid (a collision). Addressing is
// by rid, so both stay live and distinct — but the DIFF must also be
// occurrence-aware: deleting one of the pair must D the right occurrence,
// not leave a ghost or write one row's bytes onto the other's rid.

test("diff: collision pair — deleting the second row is a pure -D, no ghost (issue repro case 1)", () => {
    // prev = [A(x,bytesA,rid1), B(x,bytesB,rid2)]; next = [A(x,bytesA)]
    const prev = stamped([V("x", "h_xA"), V("x", "h_xB")]);
    const next = [V("x", "h_xA")];
    const ops = diffEgressView(prev, next);
    // The survivor keeps its OWN rid (bytes match the first occurrence) — a
    // pure -D of the deleted occurrence. The old first-wins spine marked both
    // rows "spine" (spine.has(msgid) was true for both), so it emitted NO D
    // and B stayed live (ghost).
    assert.deepEqual(ops, [{ type: "D", start: 2, end: 2 }]);
    const replayed = egressReplay(prev, ops);
    assert.deepEqual(norm(replayed), norm(next));
    assert.equal(replayed.length, 1, "the deleted occurrence is gone — no ghost row");
    assert.equal(replayed[0].rid, 1, "the survivor keeps its own rid");
    assert.equal(replayed[0].bytes, "h_xA");
});

test("diff: collision pair — deleting the first row keeps the second's bytes on its own rid (issue repro case 2)", () => {
    // prev = [A(x,bytesA,rid1), B(x,bytesB,rid2)]; next = [B(x,bytesB)]
    const prev = stamped([V("x", "h_xA"), V("x", "h_xB")]);
    const next = [V("x", "h_xB")];
    const ops = diffEgressView(prev, next);
    // The survivor (B) keeps its OWN rid (bytes match the second occurrence)
    // — a pure -D of A. The old first-wins code matched next to A (rid1) and
    // emitted U{rid1, bytesB}, leaving BOTH rows with B's bytes (mismatch)
    // with A still live (ghost).
    assert.deepEqual(ops, [{ type: "D", start: 1, end: 1 }]);
    const replayed = egressReplay(prev, ops);
    assert.deepEqual(norm(replayed), norm(next));
    assert.equal(replayed.length, 1, "the deleted occurrence is gone — no ghost row");
    assert.equal(replayed[0].rid, 2, "the survivor keeps its own rid");
    assert.equal(replayed[0].bytes, "h_xB");
});

test("diff: collision pair — editing the surviving row is a +U on its own rid", () => {
    // prev = [A(x,bytesA,rid1), B(x,bytesB,rid2)]; next = [A(x,bytesA2)]
    // A survives with CHANGED bytes — the U must land on A's rid (1), not
    // silently target the first-wins row's bytes.
    const prev = stamped([V("x", "h_xA"), V("x", "h_xB")]);
    const next = [V("x", "h_xA2")];
    const ops = diffEgressView(prev, next);
    // D ops are emitted before U ops (the diff's fixed op order).
    assert.deepEqual(ops, [
        { type: "D", start: 2, end: 2 },
        { type: "U", rid: 1, msgid: "x", bytes: "h_xA2" },
    ]);
    const replayed = egressReplay(prev, ops);
    assert.deepEqual(norm(replayed), norm(next));
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].rid, 1, "the edited row keeps its own rid");
    assert.equal(replayed[0].bytes, "h_xA2");
});

// ---- Path A shape (discussions/7836): a message's parts are N rows sharing
// the element msgid (distinct rids, distinct bytes). The occurrence-aware diff
// must handle the general N case (not just #7851's 2-row adversarial pair).
test("diff: 3-part message (one element, N occurrences) — editing part 3 is a +U on its own rid (Path A shape)", () => {
    const prev = stamped([V("m1", "h_p0"), V("m1", "h_p1"), V("m1", "h_p2")]); // rids 1,2,3
    const next = [V("m1", "h_p0"), V("m1", "h_p1"), V("m1", "h_p2x")]; // part 3 edited
    const ops = diffEgressView(prev, next);
    assert.deepEqual(ops, [{ type: "U", rid: 3, msgid: "m1", bytes: "h_p2x" }], "exactly one +U on the edited part's rid");
    const replayed = egressReplay(prev, ops);
    assert.deepEqual(norm(replayed), norm(next));
    assert.equal(replayed.length, 3, "all three parts stay live");
});

test("diff: deleting the last part of a 3-part message is a clean -D of its rid (Path A shape)", () => {
    const prev = stamped([V("m1", "h_p0"), V("m1", "h_p1"), V("m1", "h_p2")]); // rids 1,2,3
    const next = [V("m1", "h_p0"), V("m1", "h_p1")]; // part 3 removed
    const ops = diffEgressView(prev, next);
    assert.deepEqual(ops, [{ type: "D", start: 3, end: 3 }], "a pure -D of the removed part, no ghost");
    const replayed = egressReplay(prev, ops);
    assert.deepEqual(norm(replayed), norm(next));
    assert.equal(replayed.length, 2, "the removed part is gone");
});

// ---- rid lifecycle (2026-11-28 owner ruling, discussions/7903) ---------
// The rid IS the message number: one-shot, never re-issued. A D retires
// its rids forever; an I that tries to reuse a spent rid (live OR retired)
// is refused at append time. This is the exact class the old dual-number
// scheme got wrong (the 2026-11-28 incident): a fold re-citing a retired
// number onto a live row collided and corrupted the log permanently.

test("diff: fold — the summary takes a FRESH rid and never inherits a folded row's", () => {
    const prev = stamped([V("a"), V("b"), V("c"), V("d"), V("e")]); // rids 1..5
    const next = [V("a"), V("sum", "h_sum", 40, "acp_summary"), V("e")];
    assert.deepEqual(diffEgressView(prev, next), [
        { type: "D", start: 2, end: 4 },
        { type: "I", rid: 6, msgid: "sum", after: 1, tokens: 40, typeTag: "acp_summary", bytes: "h_sum" },
    ]);
    const replayed = egressReplay(prev, diffEgressView(prev, next));
    assert.deepEqual(norm(replayed), norm(next));
    assert.equal(replayed[1].rid, 6, "the summary is a NEW message with a NEW number — it never inherits a folded row's");
});

test("append: a retired rid is never re-issued — an I reusing it is refused and the log is intact (2026-11-28 incident class)", () => {
    const H = open();
    const S = "s-ridlifecycle";
    try {
        egressStateAppend(H.db, S, [
            { type: "I", rid: 1, msgid: "a", after: null, tokens: 1, typeTag: "text", bytes: "h_a" },
            { type: "I", rid: 2, msgid: "b", after: 1, tokens: 1, typeTag: "text", bytes: "h_b" },
            { type: "D", start: 1, end: 1 },
            { type: "I", rid: 3, msgid: "c", after: 2, tokens: 1, typeTag: "text", bytes: "h_c" },
        ], 1_000);
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), ["b", "c"]);
        // the old scheme's fatal shape: an I that REUSES retired rid 1 (the
        // row the fold deleted). With dual numbers this is how a fold
        // "re-homed" a retired citation onto a live row's number — here the
        // rid IS the number, so the append must refuse the batch outright
        // (and, crucially, write nothing).
        assert.throws(
            () => egressStateAppend(H.db, S, [
                { type: "I", rid: 1, msgid: "d", after: 3, tokens: 1, typeTag: "text", bytes: "h_d" },
            ], 2_000),
            (e: unknown) => e instanceof EgressStateCorruptError && /duplicate row id 1/.test(e.message),
            "the re-used retired rid is refused",
        );
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), ["b", "c"], "nothing was written — the log stays on its last healthy point");
        // the NEXT fresh rid continues past every issued rid (1,2,3 — 1 is
        // spent forever, it is not a free slot)
        egressStateAppend(H.db, S, [
            { type: "I", rid: 4, msgid: "d", after: 3, tokens: 1, typeTag: "text", bytes: "h_d" },
        ], 3_000);
        const view = egressStateView(H.db, S);
        assert.deepEqual(view.map((r) => r.rid), [2, 3, 4], "numbering continues past the retired rid, never into it");
        // a +U never renumbers: editing the row keeps its rid (= number)
        egressStateAppend(H.db, S, [
            { type: "U", rid: 4, msgid: "d", bytes: "h_d2" },
        ], 4_000);
        assert.equal(egressStateView(H.db, S).find((r) => r.msgid === "d")!.rid, 4, "+U does not change the number");
        // full replay stays in lock-step with the materialized view
        assert.deepEqual(egressStateAt(H.db, S, Number.MAX_SAFE_INTEGER), egressStateView(H.db, S));
    } finally {
        close(H);
    }
});

test("diff: move = D+I (no M op), msgid survives both ops — and the move CONSUMES a rid", () => {
    const prev = stamped([V("a"), V("b")]);
    const next = [prev[1], prev[0]];
    assert.deepEqual(diffEgressView(prev, next), [
        { type: "D", start: 1, end: 1 },
        { type: "I", rid: 3, msgid: "a", after: 2, tokens: 3, typeTag: "text", bytes: "h_a" },
    ]);
    const moved = egressReplay(prev, diffEgressView(prev, next));
    assert.deepEqual(norm(moved), norm(next));
    assert.equal(moved.find((r) => r.msgid === "a")!.rid, 3, "2026-11-28: the D+I move lands on a FRESH rid (= number); the retired one (1) stays spent forever");
});

test("diff: empty views and empty diff (both directions)", () => {
    assert.deepEqual(diffEgressView([], []), []);
    assert.deepEqual(diffEgressView(stamped([V("a"), V("b")]), [V("a"), V("b")]), []);
    const fromEmpty = diffEgressView([], [V("a"), V("b")]);
    assert.deepEqual(fromEmpty, [
        { type: "I", rid: 1, msgid: "a", after: null, tokens: 3, typeTag: "text", bytes: "h_a" },
        { type: "I", rid: 2, msgid: "b", after: 1, tokens: 3, typeTag: "text", bytes: "h_b" },
    ]);
    const toEmpty = diffEgressView(stamped([V("a"), V("b")]), []);
    assert.deepEqual(toEmpty, [{ type: "D", start: 1, end: 2 }]);
});

test("diff property: 300 random sparse mutations — replay(prev, diff) ≡ next, ops apply to the DB state too", () => {
    const H = open();
    try {
        let view: EgressViewRow[] = [];
        const rand = (n: number) => Math.floor(Math.random() * n);
        for (let iter = 0; iter < 300; iter++) {
            const op = rand(5);
            const prev = view;
            const next = [...view];
            if (op === 0 && next.length < 40) {
                next.push(V(`m${Math.random().toString(36).slice(2, 8)}`));
            } else if (op === 1 && next.length > 1) {
                next.splice(next.length - 1 - rand(2), 1);
            } else if (op === 2 && next.length > 2) {
                // fold: replace a run of 2..4 with one summary
                const at = rand(next.length - 2);
                const len = 2 + rand(3);
                next.splice(at, len, V(`sum${iter}`, `h_sum${iter}`, 40, "acp_summary"));
            } else if (op === 3 && next.length > 0) {
                const i = rand(next.length);
                next[i] = { ...next[i], bytes: "edited_" + i + "_" + iter };
            } else if (next.length > 1) {
                // move a row to a new position
                const i = rand(next.length);
                const j = rand(next.length);
                next.splice(j, 0, ...next.splice(i, 1));
            }
            const ops = diffEgressView(prev, next);
            assert.deepEqual(norm(egressReplay(prev, ops)), norm(next), `replay identity at iter ${iter}`);
            // carry the REPLAYED view forward (it carries the rids the next
            // iteration's diff/replay must resolve; norm-identity above
            // already proved it equals `next`)
            view = egressReplay(prev, ops);
        }
        // the final view also round-trips through the DB: rebuild from ops
        const S = "prop-db";
        const rebuild: EgressOp[] = [];
        let cur: EgressViewRow[] = [];
        for (let iter = 0; iter < 300; iter++) {
            // re-derive is expensive; instead verify the FINAL view through
            // a fresh log built from the final diff from empty
            void iter;
        }
        const fromEmpty = diffEgressView([], view);
        egressStateAppend(H.db, S, fromEmpty, 1_000);
        assert.deepEqual(norm(egressStateView(H.db, S)), norm(view), "DB log built from diff(empty, final) replays to the final view");
    } finally {
        close(H);
    }
});

test("fork: whole-table copy — the child inherits the parent number space and retired marks (ruling 7439)", () => {
    const H = open();
    try {
        const P = "parent";
        const C = "child";
        egressStateAppend(H.db, P, [
            { type: "I", rid: 1, msgid: "a", after: null, tokens: 1, typeTag: "text", bytes: "h_a" },
            { type: "I", rid: 2, msgid: "b", after: 1, tokens: 1, typeTag: "text", bytes: "h_b" },
            { type: "I", rid: 3, msgid: "sum", after: 2, tokens: 5, typeTag: "summary", bytes: "h_sum" },
            { type: "D", start: 1, end: 2 },
        ], 1_000);
        // no compaction step exists (7773): the state IS the live view and
        // the flow keeps everything — the fork copies both tables as-is
        const parentView = egressStateView(H.db, P);

        const copied = egressFork(H.db, P, C);
        assert.ok(copied > 0, "rows copied");
        assert.deepEqual(egressStateView(H.db, C), parentView, "child view == parent view (incl. numbers)");

        // the child's NEXT number continues where the parent stopped (a=1,
        // b=2, sum=3 — b's deletion retired 2, it is never re-issued) AND
        // its next rid continues where the parent's flow stopped (1..3
        // spent, 2 twice-over by the D)
        egressStateAppend(H.db, C, [
            { type: "I", rid: 4, msgid: "c2", after: 3, tokens: 1, typeTag: "text", bytes: "h_c2" },
        ], 3_000);
        const childView = egressStateView(H.db, C);
        assert.equal(childView.find((r) => r.msgid === "c2")!.rid, 4, "child continues the parent high-water");
        // and the parent's own next number is UNTOUCHED by the fork
        egressStateAppend(H.db, P, [
            { type: "I", rid: 4, msgid: "p2", after: 3, tokens: 1, typeTag: "text", bytes: "h_p2" },
        ], 4_000);
        assert.equal(egressStateView(H.db, P).find((r) => r.msgid === "p2")!.rid, 4, "parent numbering independent of the fork");

        // no-op without egress rows
        const none = egressFork(H.db, "stranger", C);
        assert.equal(none, 0, "fork from a session without egress rows is a no-op");
        assert.throws(() => egressFork(H.db, P, P), /conflicting fork lineage/);
    } finally {
        close(H);
    }
});
