/**
 * #7579: egress block flow/state — the block canonical history + read replica.
 * Tests pin the CONTRACT:
 *   - replay determinism: same op sequence → same block set, always;
 *   - the three row types (I born, U state-change, B compaction base) and
 *     their payload shapes;
 *   - point fork: 4-table copy preserves op_seq/log_seq, child inherits
 *     parent number space;
 *   - kstate sidecar: bounded residual snapshot at row-write time;
 *   - B-row compaction: flow-only, state untouched, replay equivalence;
 *   - reap semantics: terminal U row (reaped=1) instead of DELETE;
 *   - diffBlockSet: I for new, U for changed, U reaped=true for live→gone.
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
    egressBlockCompact,
    egressPointFork,
    diffBlockSet,
    EgressBlockCorruptError,
    type EgressBlockOp,
    type EgressBlockSnapshot,
} from "../src/storage/egress-block.ts";

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

test("replay determinism: I/U/B op sequence → same block set", () => {
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

test("B-row compaction: flow-only, state untouched, replay equivalence", () => {
    const H = open();
    try {
        const S = "sess-1";
        egressBlockAppend(H.db, S, [
            { type: "I", blockId: "b1", snapshot: snap() },
            { type: "I", blockId: "b2", snapshot: snap({ tier: 2 }) },
        ], null, 1_000);
        egressBlockAppend(H.db, S, [
            { type: "U", blockId: "b1", snapshot: snap({ active: false }) },
        ], null, 2_000);
        const before = egressBlockView(H.db, S);
        // compact: B row at op_seq 4 (after I@1, I@2, U@3)
        const compactSeq = egressBlockCompact(H.db, S, before, null, 3_000);
        assert.equal(compactSeq, 4);
        const after = egressBlockView(H.db, S);
        assert.equal(after.size, before.size);
        assert.equal(after.get("b1")!.active, false);
        assert.equal(after.get("b2")!.active, true);
        // replay from compacted flow (B row at op_seq 4)
        const r = egressBlockReplay(H.db, S, 4);
        assert.equal(r.blocks.size, 2);
        assert.equal(r.blocks.get("b1")!.active, false);
    } finally { close(H); }
});

test("reap semantics: terminal U row (reaped=1) instead of DELETE", () => {
    const H = open();
    try {
        const S = "sess-1";
        egressBlockAppend(H.db, S, [
            { type: "I", blockId: "b1", snapshot: snap() },
        ], null, 1_000);
        // reap: terminal U with reaped=true
        egressBlockAppend(H.db, S, [
            { type: "U", blockId: "b1", snapshot: snap({ reaped: true, active: false }) },
        ], null, 2_000);
        const view = egressBlockView(H.db, S);
        assert.equal(view.size, 1);
        assert.equal(view.get("b1")!.reaped, true);
        assert.equal(view.get("b1")!.active, false);
    } finally { close(H); }
});

test("point fork: 4-table copy preserves op_seq, child inherits parent number space", () => {
    const H = open();
    try {
        const P = "parent";
        const C = "child";
        egressBlockAppend(H.db, P, [
            { type: "I", blockId: "b1", snapshot: snap() },
        ], null, 1_000);
        egressBlockAppend(H.db, P, [
            { type: "U", blockId: "b1", snapshot: snap({ active: false }) },
        ], null, 2_000);
        // fork at op_seq 1
        egressPointFork(H.db, P, C, 1);
        const childView = egressBlockView(H.db, C);
        assert.equal(childView.size, 1);
        assert.equal(childView.get("b1")!.active, true);
        // child's op_seq should start after parent's op_seq 1
        egressBlockAppend(H.db, C, [
            { type: "I", blockId: "b2", snapshot: snap({ tier: 2 }) },
        ], null, 3_000);
        const childView2 = egressBlockView(H.db, C);
        assert.equal(childView2.size, 2);
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

test("diffBlockSet: I for new, U for changed, U reaped=true for live→gone", () => {
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
    assert.equal(byBlock.get("b2")!.type, "U");
    assert.equal(byBlock.get("b2")!.snapshot.reaped, true);
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
