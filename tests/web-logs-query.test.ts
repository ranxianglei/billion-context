import test from "node:test";
import assert from "node:assert/strict";
import { queryLogLines } from "../src/web/logs-query.ts";

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

test("empty query: raw tail, total = file line count, no isMatch", () => {
    const r = queryLogLines(ALL, "", { ctx: 0, winSec: 0, n: 4 });
    assert.equal(r.total, 10);
    assert.equal(r.shown, 4);
    assert.equal(r.omitted, 6); // tail cap drops the six oldest rows
    assert.deepEqual(r.lines, ALL.slice(-4));
    assert.equal(r.isMatch, undefined);
});

test("discrete mode (no ctx/win): exact hits only, isMatch aligned", () => {
    const r = queryLogLines(ALL, "line-2", { ctx: 0, winSec: 0, n: 100 });
    assert.equal(r.total, 1);
    assert.deepEqual(r.lines, [ALL[2]]);
    assert.deepEqual(r.isMatch, [true]);
});

test("matching is case-insensitive", () => {
    const r = queryLogLines(ALL, "LINE-4", { ctx: 0, winSec: 0, n: 100 });
    assert.equal(r.total, 1);
    assert.equal(r.lines[0], ALL[4]);
});

test("ctx: overlapping ranges merge into one contiguous block", () => {
    // Hits at 2 and 5, ctx=3 → [0,5] ∪ [2,8] → contiguous 0..8 (no dups).
    const r = queryLogLines(MERGE, "needle", { ctx: 3, winSec: 0, n: 100 });
    assert.equal(r.shown, 9);
    assert.equal(r.lines[0], MERGE[0]);
    assert.equal(r.lines[8], MERGE[8]);
    assert.deepEqual(r.isMatch, [false, false, true, false, false, true, false, false, false]);
});

test("ctx: clamped at file edges", () => {
    const r = queryLogLines(ALL, "line-0", { ctx: 3, winSec: 0, n: 100 });
    assert.deepEqual(r.lines, ALL.slice(0, 4));
    assert.deepEqual(r.isMatch, [true, false, false, false]);
});

test("win: time window around [first,last] hit keeps interleaved lines", () => {
    // Hits at minutes 2 and 5, ±60s → [1min, 6min] → rows 1..6 (inclusive).
    const r = queryLogLines(WIN, "needle", { ctx: 0, winSec: 60, n: 100 });
    assert.equal(r.shown, 6);
    assert.equal(r.lines[0], WIN[1]);
    assert.equal(r.lines[5], WIN[6]);
    assert.deepEqual(r.isMatch, [false, true, false, false, true, false]);
});

test("win takes precedence over ctx", () => {
    // ctx=20 alone would swallow the whole file; the 60s window must win.
    const r = queryLogLines(WIN, "needle", { ctx: 20, winSec: 60, n: 100 });
    assert.equal(r.shown, 6);
    assert.equal(r.lines[0], WIN[1]);
});

test("cap: n keeps the newest rows and reports omitted", () => {
    const r = queryLogLines(WIN, "needle", { ctx: 0, winSec: 60, n: 4 });
    assert.equal(r.shown, 4);
    assert.equal(r.omitted, 2);
    assert.deepEqual(r.lines, WIN.slice(3, 7));
});

test("unparseable leading line: NaN timestamp is skipped safely", () => {
    // Orphan row without a ts prepended → everything shifts by one; the
    // window's lower bound must NOT reach into the NaN-timestamp row.
    const mixed = ["orphan row without a timestamp", ...WIN.slice(1)];
    const r = queryLogLines(mixed, "needle", { ctx: 0, winSec: 60, n: 100 });
    assert.equal(r.lines[0], mixed[1]);
    assert.equal(r.shown, 6);
});

test("no matches: empty result, aligned isMatch []", () => {
    const r = queryLogLines(ALL, "zzz-not-there", { ctx: 3, winSec: 0, n: 100 });
    assert.equal(r.total, 0);
    assert.equal(r.shown, 0);
    assert.equal(r.omitted, 0);
    assert.deepEqual(r.lines, []);
    assert.deepEqual(r.isMatch, []);
});
