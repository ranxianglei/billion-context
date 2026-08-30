import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import { setLogCapture } from "../src/logger.ts";
import { logDumpFailure, logUnrecognizedPath } from "../src/server.ts";

interface Line { level: string; msg: string; }

// #362 noise: client telemetry paths (/api/v1/event/report, ...) are forwarded
// unchanged — expected, not an error. Logging every hit produced ~20k warn lines
// in one user's capture. Per-path: first 3 at warn, one "suppressed" notice,
// then silent.
test("logUnrecognizedPath: per-path warn x3, then one suppression notice, then silent", () => {
    const lines: Line[] = [];
    const log = (level: string, msg: string) => { lines.push({ level, msg }); };
    const url = "https://client.example/api/v1/event/report";
    for (let i = 0; i < 5; i++) logUnrecognizedPath(log, url);
    assert.equal(lines.length, 4);
    assert.equal(lines[0].level, "warn");
    assert.ok(lines[0].msg.includes("unrecognized path"));
    assert.equal(lines[1].level, "warn");
    assert.equal(lines[2].level, "warn");
    assert.equal(lines[3].level, "info");
    assert.ok(lines[3].msg.includes("suppressed"));
});

test("logUnrecognizedPath: distinct paths are counted independently", () => {
    const lines: Line[] = [];
    const log = (level: string, msg: string) => { lines.push({ level, msg }); };
    logUnrecognizedPath(log, "https://a.example/p1");
    logUnrecognizedPath(log, "https://b.example/p2");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].msg.includes("/p1"));
    assert.ok(lines[1].msg.includes("/p2"));
});

// #362: a raw dump that fails (disk full, locked dir, EPERM) must not break the
// request, but a silently-stopped dump hides real problems. First failure logs
// immediately, repeats within the window are suppressed, and it re-logs after
// the window with a cumulative count.
test("logDumpFailure: first failure logs, repeat suppressed, re-logs after window", (t) => {
    const lines: Line[] = [];
    setLogCapture((level, msg) => { lines.push({ level, msg }); });
    t.after(() => { setLogCapture(null); });
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    logDumpFailure("SSE stream dump", new Error("ENOSPC: no space left on device"));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, "warn");
    assert.ok(lines[0].msg.includes("SSE stream dump"));
    assert.ok(lines[0].msg.includes("total 1x"));
    assert.ok(lines[0].msg.includes("ENOSPC"));
    logDumpFailure("SSE stream dump", new Error("ENOSPC: no space left on device"));
    assert.equal(lines.length, 1);
    now += 61_000;
    logDumpFailure("SSE stream dump", new Error("ENOSPC: no space left on device"));
    assert.equal(lines.length, 2);
    assert.ok(lines[1].msg.includes("total 3x"));
});
