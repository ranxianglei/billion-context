import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { queryLogFiles } from "../src/web/logs-query.ts";

// Ten lines, one minute apart, starting 12:00:00Z.
const T0 = Date.parse("2026-09-27T12:00:00.000Z");
function mkLine(minute: number, label: string): string {
    return `${new Date(T0 + minute * 60_000).toISOString()} [info] ${label}`;
}
const ALL: string[] = Array.from({ length: 10 }, (_, i) => mkLine(i, `line-${i}`));
// Hits at minutes 2 and 5, everything else noise.
const WIN: string[] = Array.from({ length: 10 }, (_, i) => mkLine(i, i === 2 || i === 5 ? "needle" : `noise-${i}`));
// Two hits close together (2 and 5) for ctx-merge checks.
const MERGE: string[] = Array.from({ length: 9 }, (_, i) => mkLine(i, i === 2 || i === 5 ? "needle" : `filler-${i}`));

/** Write `lines` as one generation file and query it through the real reader —
 *  the engine no longer accepts a materialized array, so every case exercises
 *  the streaming path end to end. */
async function query(lines: string[], q: string, opts: { ctx: number; winSec: number; n: number }) {
    const dir = mkdtempSync(path.join(tmpdir(), "logs-query-"));
    try {
        const file = path.join(dir, "bili.log");
        writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
        return await queryLogFiles([file], q, opts);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("empty query: raw tail, total = file line count, no isMatch", async () => {
    const r = await query(ALL, "", { ctx: 0, winSec: 0, n: 4 });
    assert.equal(r.total, 10);
    assert.equal(r.shown, 4);
    assert.equal(r.omitted, 6); // tail cap drops the six oldest rows
    assert.deepEqual(r.lines, ALL.slice(-4));
    assert.equal(r.isMatch, undefined);
});

test("discrete mode (no ctx/win): exact hits only, isMatch aligned", async () => {
    const r = await query(ALL, "line-2", { ctx: 0, winSec: 0, n: 100 });
    assert.equal(r.total, 1);
    assert.deepEqual(r.lines, [ALL[2]]);
    assert.deepEqual(r.isMatch, [true]);
});

test("matching is case-insensitive", async () => {
    const r = await query(ALL, "LINE-4", { ctx: 0, winSec: 0, n: 100 });
    assert.equal(r.total, 1);
    assert.equal(r.lines[0], ALL[4]);
});

test("ctx: overlapping ranges merge into one contiguous block", async () => {
    // Hits at 2 and 5, ctx=3 → [0,5] ∪ [2,8] → contiguous 0..8 (no dups).
    const r = await query(MERGE, "needle", { ctx: 3, winSec: 0, n: 100 });
    assert.equal(r.shown, 9);
    assert.equal(r.lines[0], MERGE[0]);
    assert.equal(r.lines[8], MERGE[8]);
    assert.deepEqual(r.isMatch, [false, false, true, false, false, true, false, false, false]);
});

test("ctx: clamped at file edges", async () => {
    const r = await query(ALL, "line-0", { ctx: 3, winSec: 0, n: 100 });
    assert.deepEqual(r.lines, ALL.slice(0, 4));
    assert.deepEqual(r.isMatch, [true, false, false, false]);
});

test("win: time window around [first,last] hit keeps interleaved lines", async () => {
    // Hits at minutes 2 and 5, ±60s → [1min, 6min] → rows 1..6 (inclusive).
    const r = await query(WIN, "needle", { ctx: 0, winSec: 60, n: 100 });
    assert.equal(r.shown, 6);
    assert.equal(r.lines[0], WIN[1]);
    assert.equal(r.lines[5], WIN[6]);
    assert.deepEqual(r.isMatch, [false, true, false, false, true, false]);
});

test("win takes precedence over ctx", async () => {
    // ctx=20 alone would swallow the whole file; the 60s window must win.
    const r = await query(WIN, "needle", { ctx: 20, winSec: 60, n: 100 });
    assert.equal(r.shown, 6);
    assert.equal(r.lines[0], WIN[1]);
});

test("cap: n keeps the newest rows and reports omitted", async () => {
    const r = await query(WIN, "needle", { ctx: 0, winSec: 60, n: 4 });
    assert.equal(r.shown, 4);
    assert.equal(r.omitted, 2);
    assert.deepEqual(r.lines, WIN.slice(3, 7));
});

test("unparseable leading line: NaN timestamp is skipped safely", async () => {
    // Orphan row without a ts prepended → everything shifts by one; the
    // window's lower bound must NOT reach into the NaN-timestamp row.
    const mixed = ["orphan row without a timestamp", ...WIN.slice(1)];
    const r = await query(mixed, "needle", { ctx: 0, winSec: 60, n: 100 });
    assert.equal(r.lines[0], mixed[1]);
    assert.equal(r.shown, 6);
});

test("no matches: empty result, aligned isMatch []", async () => {
    const r = await query(ALL, "zzz-not-there", { ctx: 3, winSec: 0, n: 100 });
    assert.equal(r.total, 0);
    assert.equal(r.shown, 0);
    assert.equal(r.omitted, 0);
    assert.deepEqual(r.lines, []);
    assert.deepEqual(r.isMatch, []);
});

test("streaming spans generations in order without concatenating them", async () => {
    // Two generations: the split must not lose or reorder rows, and a hit in
    // the older file must still be found.
    const dir = mkdtempSync(path.join(tmpdir(), "logs-query-gen-"));
    try {
        const older = path.join(dir, "bili-1.log");
        const active = path.join(dir, "bili.log");
        writeFileSync(older, `${mkLine(0, "needle-old")}\n${mkLine(1, "noise")}\n`);
        writeFileSync(active, `${mkLine(2, "needle-new")}\n${mkLine(3, "noise")}\n`);
        const r = await queryLogFiles([older, active], "needle", { ctx: 0, winSec: 0, n: 100 });
        assert.equal(r.total, 2);
        assert.deepEqual(r.lines, [mkLine(0, "needle-old"), mkLine(2, "needle-new")]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an unreadable generation is reported, not silently dropped", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "logs-query-miss-"));
    try {
        const good = path.join(dir, "bili.log");
        const gone = path.join(dir, "bili-1.log");
        writeFileSync(good, `${mkLine(0, "needle")}\n`);
        const errors: string[] = [];
        const r = await queryLogFiles([gone, good], "needle", { ctx: 0, winSec: 0, n: 10 }, {
            onError: (f) => errors.push(f),
        });
        assert.deepEqual(errors, [gone], "the missing generation must surface through onError");
        assert.equal(r.total, 1, "the readable generation still answers");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("time-window view reports each unreadable generation once across passes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "logs-window-unreadable-"));
    try {
        const missing = path.join(dir, "missing.log");
        const active = path.join(dir, "active.log");
        const lines = [mkLine(2, "needle"), mkLine(3, "context")];
        writeFileSync(active, `${lines.join("\n")}\n`);
        const errors: string[] = [];
        const result = await queryLogFiles([missing, active], "needle", { ctx: 0, winSec: 60, n: 10 }, {
            onError: (file) => errors.push(file),
        });
        assert.deepEqual(result.lines, lines);
        assert.deepEqual(errors, [missing]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
