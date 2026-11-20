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
    EgressStateCorruptError,
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

test("replay determinism: the five-op example from the proposal", () => {
    const H = open();
    try {
        const S = "sess-1";
        egressStateAppend(H.db, S, [
            { type: "I", msgid: "a", after: null, ref: "m00001", tokens: 3, typeTag: "text", contentHash: h("a1") },
            { type: "I", msgid: "b", after: null, ref: "m00002", tokens: 4, typeTag: "text", contentHash: h("b1") },
            { type: "I", msgid: "c", after: "b", ref: "m00003", tokens: 9, typeTag: "summary", contentHash: h("c1") },
            { type: "D", start: "a", end: "b" },
            { type: "U", msgid: "c", contentHash: h("c2") },
        ], 1_000);
        const view = egressStateView(H.db, S);
        assert.deepEqual(view.map((r) => r.msgid), ["c"]);
        assert.equal(view[0].contentHash, h("c2"));
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
            { type: "I", msgid: "a", after: null, ref: "m00001", tokens: 1, typeTag: "text", contentHash: h("a") },
            { type: "I", msgid: "d", after: null, ref: "m00002", tokens: 1, typeTag: "text", contentHash: h("d") },
            { type: "I", msgid: "e", after: null, ref: "m00003", tokens: 1, typeTag: "text", contentHash: h("e") },
            // mid-history insert anchored at a (positions of d/e shift)
            { type: "I", msgid: "b", after: "a", ref: "m00004", tokens: 1, typeTag: "text", contentHash: h("b") },
            { type: "I", msgid: "c", after: "b", ref: "m00005", tokens: 1, typeTag: "text", contentHash: h("c") },
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
            { type: "I", msgid: "a", after: null, ref: "m00001", tokens: 1, typeTag: "text", contentHash: h("a") },
            { type: "I", msgid: "b", after: null, ref: "m00002", tokens: 1, typeTag: "text", contentHash: h("b") },
        ], 1_000);
    };
        seed("anchor-missing");
        egressStateAppend(H.db, "anchor-missing", [
            { type: "I", msgid: "x", after: "zz", ref: "m00003", tokens: 1, typeTag: "text", contentHash: h("x") },
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
        egressStateAppend(H.db, "update-missing", [{ type: "U", msgid: "ghost", contentHash: h("g") }], 2_000);
        assert.throws(() => egressStateView(H.db, "update-missing"), (e: unknown) => e instanceof EgressStateCorruptError && /update target ghost missing/.test(e.message));
        seed("dup");
        egressStateAppend(H.db, "dup", [
            { type: "I", msgid: "a", after: null, ref: "m00009", tokens: 1, typeTag: "text", contentHash: h("a2") },
        ], 2_000);
        assert.throws(() => egressStateView(H.db, "dup"), (e: unknown) => e instanceof EgressStateCorruptError && /duplicate msgid a/.test(e.message));
        // and the healthy sessions in the same db still replay cleanly (no
        // cross-session leakage from the corrupt rows)
        seed("healthy");
        assert.deepEqual(egressStateView(H.db, "healthy").map((r) => r.msgid), ["a", "b"]);
        // a GOOD op after a BAD op must not be masked: drop the bad row, replay OK
        H.db.prepare("DELETE FROM egress_state WHERE session_id = 'anchor-missing' AND log_seq = 3").run();
        H.db.prepare("DELETE FROM egress_flow WHERE session_id = 'anchor-missing' AND log_seq = 3").run();
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
            ops.push({ type: "I", msgid: `m${i}`, after: null, ref: `m0000${i}`, tokens: i, typeTag: "text", contentHash: h(`m${i}`) });
        }
        ops.push({ type: "I", msgid: "fold", after: "m6", ref: "m00011", tokens: 77, typeTag: "summary", contentHash: h("fold") });
        ops.push({ type: "D", start: "m1", end: "m6" });
        egressStateAppend(H.db, S, ops, 1_000);
        const before = egressStateView(H.db, S);
        assert.deepEqual(before.map((r) => r.msgid), ["fold", "m7", "m8", "m9", "m10"]);

        const stateRowsBefore = (H.db.prepare("SELECT COUNT(*) AS n FROM egress_state WHERE session_id = ?").get(S) as { n: number }).n;
        const flowRowsBefore = (H.db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(S) as { n: number }).n;
        assert.equal(stateRowsBefore, 12);
        assert.equal(flowRowsBefore, 12);

        egressStateCompact(H.db, S, before, 2_000);
        const after = egressStateView(H.db, S);
        assert.deepEqual(after, before);
        // state: base + nothing below (the 12 ops are physically gone)
        const stateRows = (H.db.prepare("SELECT COUNT(*) AS n FROM egress_state WHERE session_id = ?").get(S) as { n: number }).n;
        assert.equal(stateRows, 1);
        // flow: untouched — total history
        const flowRows = (H.db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(S) as { n: number }).n;
        assert.equal(flowRows, 13);
        // ops after compaction still replay on top of the base
        egressStateAppend(H.db, S, [
            { type: "I", msgid: "m11", after: null, ref: "m00012", tokens: 11, typeTag: "text", contentHash: h("m11") },
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
                { type: "I", msgid: `m${i}`, after: null, ref: `m0000${i}`, tokens: i, typeTag: "text", contentHash: h(`m${i}`) },
            ], 1_000 + i);
            snapshots.set(i, egressStateView(H.db, S));
        }
        egressStateAppend(H.db, S, [{ type: "U", msgid: "m2", contentHash: h("m2-edit") }], 6_000);
        snapshots.set(6, egressStateView(H.db, S));
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
