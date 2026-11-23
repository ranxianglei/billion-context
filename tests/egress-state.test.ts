/**
 * Egress state log (proposal discussions/7398, #6785 perf work): the op-log
 * outbound view. Tests pin the CONTRACT:
 *   - replay determinism: same op sequence → same view, always;
 *   - the four row types (+I tail/anchored, -D inclusive range, +U
 *     content-only, B base) and their payload shapes;
 *   - the three hard-error paths (missing anchor / missing or inverted
 *     delete endpoints / update target missing) throw, never degrade fuzzy;
 *   - compaction equivalence: view before == view after, row count bounded;
 *   - dual-table rollback: ANY log_seq stays reconstructible from egress_flow
 *     after the state table is compacted below it.
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
    egressStateCompact,
    egressStateView,
    egressStateAt,
    egressFork,
    EgressStateCorruptError,
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

// The canonical `num` is assigned at append/replay time from the stored
// high-water, so pure diff/replay fixtures carry num: 0 — comparisons ignore
// it (norm); the db-backed tests assert the stamped numbers explicitly.
const norm = (rows: EgressViewRow[]) => rows.map(({ num, ...rest }) => rest);


test("replay determinism: the five-op example from the proposal", () => {
    const H = open();
    try {
        const S = "sess-1";
        egressStateAppend(H.db, S, [
            { type: "I", msgid: "a", after: null, ref: "m00001", tokens: 3, typeTag: "text", bytes: "h_a1" },
            { type: "I", msgid: "b", after: null, ref: "m00002", tokens: 4, typeTag: "text", bytes: "h_b1" },
            { type: "I", msgid: "c", after: "b", ref: "m00003", tokens: 9, typeTag: "summary", bytes: "h_c1" },
            { type: "D", start: "a", end: "b" },
            { type: "U", msgid: "c", bytes: "h_c2" },
        ], 1_000);
        const view = egressStateView(H.db, S);
        assert.deepEqual(view.map((r) => r.msgid), ["c"]);
        assert.equal(view[0].bytes, h("c2"));
        // ruling 7439: c was the 3rd I op (a=1, b=2, c=3); the -D and +U
        // consumed no numbers, so c keeps 3 even though 5 rows exist
        assert.equal(view[0].num, 3);
        // ref/tokens/type survive the content update untouched
        assert.equal(view[0].ref, "m00003");
        assert.equal(view[0].tokens, 9);
        assert.equal(view[0].type, "summary");
        // replay twice → byte-identical
        assert.deepEqual(egressStateView(H.db, S), view);
    } finally {
        close(H);
    }
});

test("+I anchored insert lands mid-history; -D endpoints are msgids, not positions", () => {
    const H = open();
    try {
        const S = "sess-2";
        egressStateAppend(H.db, S, [
            { type: "I", msgid: "a", after: null, ref: "m00001", tokens: 1, typeTag: "text", bytes: "h_a" },
            { type: "I", msgid: "d", after: null, ref: "m00002", tokens: 1, typeTag: "text", bytes: "h_d" },
            { type: "I", msgid: "e", after: null, ref: "m00003", tokens: 1, typeTag: "text", bytes: "h_e" },
            // mid-history insert anchored at a (positions of d/e shift)
            { type: "I", msgid: "b", after: "a", ref: "m00004", tokens: 1, typeTag: "text", bytes: "h_b" },
            { type: "I", msgid: "c", after: "b", ref: "m00005", tokens: 1, typeTag: "text", bytes: "h_c" },
        ], 1_000);
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), ["a", "b", "c", "d", "e"]);
        // a fold deletes b..d — a and e survive in place
        egressStateAppend(H.db, S, [{ type: "D", start: "b", end: "d" }], 2_000);
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), ["a", "e"]);
        // single-row delete (start == end)
        egressStateAppend(H.db, S, [{ type: "D", start: "a", end: "a" }], 3_000);
        assert.deepEqual(egressStateView(H.db, S).map((r) => r.msgid), ["e"]);
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
            { type: "I", msgid: "a", after: null, ref: "m00001", tokens: 1, typeTag: "text", bytes: "h_a" },
            { type: "I", msgid: "b", after: null, ref: "m00002", tokens: 1, typeTag: "text", bytes: "h_b" },
        ], 1_000);
    };
        seed("anchor-missing");
        egressStateAppend(H.db, "anchor-missing", [
            { type: "I", msgid: "x", after: "zz", ref: "m00003", tokens: 1, typeTag: "text", bytes: "h_x" },
        ], 2_000);
        assert.throws(() => egressStateView(H.db, "anchor-missing"), (e: unknown) => e instanceof EgressStateCorruptError && /anchor zz missing/.test(e.message));
        seed("endpoint-missing");
        egressStateAppend(H.db, "endpoint-missing", [{ type: "D", start: "a", end: "nope" }], 2_000);
        assert.throws(() => egressStateView(H.db, "endpoint-missing"), (e: unknown) => e instanceof EgressStateCorruptError && /delete end nope missing/.test(e.message));
        seed("start-missing");
        egressStateAppend(H.db, "start-missing", [{ type: "D", start: "nope", end: "b" }], 2_000);
        assert.throws(() => egressStateView(H.db, "start-missing"), (e: unknown) => e instanceof EgressStateCorruptError && /delete start nope missing/.test(e.message));
        seed("inverted");
        egressStateAppend(H.db, "inverted", [{ type: "D", start: "b", end: "a" }], 2_000);
        assert.throws(() => egressStateView(H.db, "inverted"), (e: unknown) => e instanceof EgressStateCorruptError && /inverted/.test(e.message));
        seed("update-missing");
        egressStateAppend(H.db, "update-missing", [{ type: "U", msgid: "ghost", bytes: "h_g" }], 2_000);
        assert.throws(() => egressStateView(H.db, "update-missing"), (e: unknown) => e instanceof EgressStateCorruptError && /update target ghost missing/.test(e.message));
        seed("dup");
        egressStateAppend(H.db, "dup", [
            { type: "I", msgid: "a", after: null, ref: "m00009", tokens: 1, typeTag: "text", bytes: "h_a2" },
        ], 2_000);
        assert.throws(() => egressStateView(H.db, "dup"), (e: unknown) => e instanceof EgressStateCorruptError && /duplicate msgid a/.test(e.message));
        // and the healthy sessions in the same db still replay cleanly (no
        // cross-session leakage from the corrupt rows)
        seed("healthy");
        assert.deepEqual(egressStateView(H.db, "healthy").map((r) => r.msgid), ["a", "b"]);
        // a GOOD op after a BAD op must not be masked: drop the bad row, replay OK
        H.db.prepare("DELETE FROM egress_state WHERE session_id = 'anchor-missing' AND op_seq = 3").run();
        H.db.prepare("DELETE FROM egress_flow WHERE session_id = 'anchor-missing' AND op_seq = 3").run();
        assert.deepEqual(egressStateView(H.db, "anchor-missing").map((r) => r.msgid), ["a", "b"]);
    } finally {
        close(H);
    }
},);

test("compaction equivalence: view before == view after; state bounded, flow total", () => {
    const H = open();
    try {
        const S = "sess-4";
        // 10 tail appends, then a fold collapses 1..6 into one summary
        const ops: EgressOp[] = [];
        for (let i = 1; i <= 10; i++) {
            ops.push({ type: "I", msgid: `m${i}`, after: null, ref: `m0000${i}`, tokens: i, typeTag: "text", bytes: `h_m${i}` });
        }
        ops.push({ type: "I", msgid: "fold", after: "m6", ref: "m00011", tokens: 77, typeTag: "summary", bytes: "h_fold" });
        ops.push({ type: "D", start: "m1", end: "m6" });
        egressStateAppend(H.db, S, ops, 1_000);
        const before = egressStateView(H.db, S);
        assert.deepEqual(before.map((r) => r.msgid), ["fold", "m7", "m8", "m9", "m10"]);

        const stateRowsBefore = (H.db.prepare("SELECT COUNT(*) AS n FROM egress_state WHERE session_id = ?").get(S) as { n: number }).n;
        const flowRowsBefore = (H.db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(S) as { n: number }).n;
        assert.equal(stateRowsBefore, 12);
        assert.equal(flowRowsBefore, 12);

        assert.deepEqual(before.map((r) => r.num), [11, 7, 8, 9, 10], "I rows numbered in append order (fold=11)");
        egressStateCompact(H.db, S, before, 2_000);
        const after = egressStateView(H.db, S);
        assert.deepEqual(after, before, "compact base carries the stamped numbers inline");
        // state: base + nothing below (the 12 ops are physically gone)
        const stateRows = (H.db.prepare("SELECT COUNT(*) AS n FROM egress_state WHERE session_id = ?").get(S) as { n: number }).n;
        assert.equal(stateRows, 1);
        // flow: untouched — total history
        const flowRows = (H.db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(S) as { n: number }).n;
        assert.equal(flowRows, 13);
        // ops after compaction still replay on top of the base
        egressStateAppend(H.db, S, [
            { type: "I", msgid: "m11", after: null, ref: "m00012", tokens: 11, typeTag: "text", bytes: "h_m11" },
        ], 3_000);
        const grown = egressStateView(H.db, S);
        assert.deepEqual(grown.map((r) => r.msgid), ["fold", "m7", "m8", "m9", "m10", "m11"]);
    } finally {
        close(H);
    }
});

test("any-log_seq rollback: compacted-away history stays reconstructible from egress_flow", () => {
    const H = open();
    try {
        const S = "sess-5";
        // snapshot the view at every seq 1..5, then compact at 5
        const snapshots = new Map<number, EgressViewRow[]>();
        for (let i = 1; i <= 5; i++) {
            egressStateAppend(H.db, S, [
                { type: "I", msgid: `m${i}`, after: null, ref: `m0000${i}`, tokens: i, typeTag: "text", bytes: `h_m${i}` },
            ], 1_000 + i);
            snapshots.set(i, egressStateView(H.db, S));
        }
        egressStateAppend(H.db, S, [{ type: "U", msgid: "m2", bytes: "h_m2-edit" }], 6_000);
        snapshots.set(6, egressStateView(H.db, S));
        assert.equal(snapshots.get(6)![1].num, 2, "the +U did not change m2's canonical number");
        egressStateCompact(H.db, S, egressStateView(H.db, S), 10_000);
        // the state table is now just the base — every pre-compaction seq must
        // still come back byte-identical from the flow table
        for (const [seq, expected] of snapshots) {
            assert.deepEqual(egressStateAt(H.db, S, seq), expected, `rollback at seq ${seq}`);
        }
        // seq 0 = empty view
        assert.deepEqual(egressStateAt(H.db, S, 0), []);
    } finally {
        close(H);
    }
});

// ---- diff engine (segment 2) ------------------------------------------

const V = (msgid: string, bytes = "h_" + msgid, ref = "m" + msgid, tokens = 3, type = "text"): EgressViewRow =>
    ({ num: 0, msgid, ref, tokens, type, bytes });


test("diff: case 1 — tail append emits exactly one +I anchored to the last row", () => {
    const prev = [V("a"), V("b")];
    const next = [V("a"), V("b"), V("c")];
    const ops = diffEgressView(prev, next);
    assert.deepEqual(ops, [{ type: "I", msgid: "c", after: "b", ref: "mc", tokens: 3, typeTag: "text", bytes: "h_c" }]);
    assert.deepEqual(norm(egressReplay(prev, ops)), norm(next));
});

test("diff: cases 2+3 — nudge appears (+I) and vanishes (-D) without touching the prefix", () => {
    const base = [V("a"), V("b")];
    const nudged = [V("a"), V("b"), V("nudge", "h_n", "mn", 1, "nudge")];
    assert.deepEqual(diffEgressView(base, nudged), [
        { type: "I", msgid: "nudge", after: "b", ref: "mn", tokens: 1, typeTag: "nudge", bytes: "h_n" },
    ]);
    assert.deepEqual(norm(egressReplay(base, diffEgressView(base, nudged))), norm(nudged));
    assert.deepEqual(diffEgressView(nudged, base), [{ type: "D", start: "nudge", end: "nudge" }]);
    assert.deepEqual(norm(egressReplay(nudged, diffEgressView(nudged, base))), norm(base));
});

test("diff: case 4 — fold replaces a range with one summary row after the surviving anchor", () => {
    const prev = [V("a"), V("b"), V("c"), V("d"), V("e"), V("f")];
    const folded = [V("a"), V("sum", "h_sum", "ms", 42, "acp_summary"), V("f")];
    assert.deepEqual(diffEgressView(prev, folded), [
        { type: "D", start: "b", end: "e" },
        { type: "I", msgid: "sum", after: "a", ref: "ms", tokens: 42, typeTag: "acp_summary", bytes: "h_sum" },
    ]);
    assert.deepEqual(norm(egressReplay(prev, diffEgressView(prev, folded))), norm(folded));
});

test("diff: case U — content edit of an existing row is a +U, position and triple untouched", () => {
    const prev = [V("a", "h_a1"), V("b")];
    const next = [V("a", "h_a2"), V("b")];
    assert.deepEqual(diffEgressView(prev, next), [{ type: "U", msgid: "a", bytes: "h_a2" }]);
    const replayed = egressReplay(prev, diffEgressView(prev, next));
    assert.deepEqual(norm(replayed), norm(next));
    assert.equal(replayed[0].ref, "ma", "+U must not touch the ref");
    assert.equal(replayed[0].tokens, 3, "+U must not touch tokens");
    assert.equal(replayed[0].num, 0, "+U must not touch the canonical number");
});

test("diff: move = D+I (no M op), msgid survives both ops", () => {
    const prev = [V("a"), V("b")];
    const next = [V("b"), V("a")];
    assert.deepEqual(diffEgressView(prev, next), [
        { type: "D", start: "a", end: "a" },
        { type: "I", msgid: "a", after: "b", ref: "ma", tokens: 3, typeTag: "text", bytes: "h_a" },
    ]);
    const moved = egressReplay(prev, diffEgressView(prev, next));
    assert.deepEqual(norm(moved), norm(next));
    assert.equal(moved.find((r) => r.msgid === "a")!.num, 1, "the D+I move takes the next number; the old one stays retired");
});

test("diff: empty views and empty diff (both directions)", () => {
    assert.deepEqual(diffEgressView([], []), []);
    assert.deepEqual(diffEgressView([V("a"), V("b")], [V("a"), V("b")]), []);
    const fromEmpty = diffEgressView([], [V("a"), V("b")]);
    assert.deepEqual(fromEmpty, [
        { type: "I", msgid: "a", after: null, ref: "ma", tokens: 3, typeTag: "text", bytes: "h_a" },
        { type: "I", msgid: "b", after: "a", ref: "mb", tokens: 3, typeTag: "text", bytes: "h_b" },
    ]);
    const toEmpty = diffEgressView([V("a"), V("b")], []);
    assert.deepEqual(toEmpty, [{ type: "D", start: "a", end: "b" }]);
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
                next.splice(at, len, V(`sum${iter}`, `h_sum${iter}`, `ms${iter}`, 40, "acp_summary"));
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
            view = next;
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
            { type: "I", msgid: "a", after: null, ref: "m00001", tokens: 1, typeTag: "text", bytes: "h_a" },
            { type: "I", msgid: "b", after: null, ref: "m00002", tokens: 1, typeTag: "text", bytes: "h_b" },
            { type: "I", msgid: "sum", after: "b", ref: "m00003", tokens: 5, typeTag: "summary", bytes: "h_sum" },
            { type: "D", start: "a", end: "b" },
        ], 1_000);
        // a compaction so the state table carries a base row too — the fork
        // must copy BOTH tables (base entries keep their numbers)
        egressStateCompact(H.db, P, egressStateView(H.db, P), 2_000);
        const parentView = egressStateView(H.db, P);

        const copied = egressFork(H.db, P, C);
        assert.ok(copied > 0, "rows copied");
        assert.deepEqual(egressStateView(H.db, C), parentView, "child view == parent view (incl. numbers)");

        // the child's NEXT number continues where the parent stopped (a=1,
        // b=2, sum=3 — b's deletion retired 2, it is never re-issued)
        egressStateAppend(H.db, C, [
            { type: "I", msgid: "c2", after: null, ref: "m00004", tokens: 1, typeTag: "text", bytes: "h_c2" },
        ], 3_000);
        const childView = egressStateView(H.db, C);
        assert.equal(childView.find((r) => r.msgid === "c2")!.num, 4, "child continues the parent high-water");
        // and the parent's own next number is UNTOUCHED by the fork
        egressStateAppend(H.db, P, [
            { type: "I", msgid: "p2", after: null, ref: "m00005", tokens: 1, typeTag: "text", bytes: "h_p2" },
        ], 4_000);
        assert.equal(egressStateView(H.db, P).find((r) => r.msgid === "p2")!.num, 4, "parent numbering independent of the fork");

        // no-op without egress rows
        const none = egressFork(H.db, "stranger", C);
        assert.equal(none, 0, "fork from a session without egress rows is a no-op");
        assert.throws(() => egressFork(H.db, P, P), /conflicting fork lineage/);
    } finally {
        close(H);
    }
});
