import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import { setLogCapture } from "../src/logger.ts";
import { getUnrecognizedPathStats, getUnroutedModelEndpointStats, logDumpFailure, logUnrecognizedPath, logUnroutedModelEndpoint } from "../src/server.ts";
import { maskUrlsInText } from "../src/log-mask.ts";

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

test("logUnrecognizedPath: a varying query string does not split the per-path key", () => {
    const lines: Line[] = [];
    const log = (level: string, msg: string) => { lines.push({ level, msg }); };
    for (let i = 0; i < 4; i++) logUnrecognizedPath(log, `/api/v1/event/report?ts=${i}`);
    assert.equal(lines.length, 4);
    assert.equal(lines[3].level, "info");
    assert.ok(lines[3].msg.includes("suppressed"));
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

// #1290: unrecognized paths were only visible as 3 transient stderr warns —
// expose the per-path counts so /__bili/stats and the /acp report can surface them.
test("getUnrecognizedPathStats: exposes per-path counts for /__bili/stats (#1290)", () => {
    const url = "https://cc-stats-1290.example/alpha/generate?x=1";
    const key = maskUrlsInText(url.split("?")[0]);
    const before = getUnrecognizedPathStats();
    const base = before.paths[key] ?? 0;
    for (let i = 0; i < 5; i++) logUnrecognizedPath(() => {}, url);
    const after = getUnrecognizedPathStats();
    assert.equal(after.paths[key], base + 5, "counted under the masked path key");
    assert.ok(after.total >= 5);
});

// #6641: client-side bypass — a host plugin (dsh lane) detected a model request
// whose URL is not a recognized model endpoint and sent it DIRECT (uncompressed),
// so the proxy never saw it. The host reports each distinct endpoint once per
// process; the proxy records it so acp_status can surface "lane bypassed" instead
// of the misleading "0 messages / nothing compressible".
test("logUnroutedModelEndpoint + getUnroutedModelEndpointStats: exposes per-endpoint counts for /__bili/stats (#6641)", () => {
    const url = "https://cc-stats-6641.example/api/agent/v3/llm_utils_chat?x=1";
    const key = maskUrlsInText(url.split("?")[0]);
    const before = getUnroutedModelEndpointStats();
    const base = before.endpoints[key] ?? 0;
    logUnroutedModelEndpoint(url);
    logUnroutedModelEndpoint(url);
    const after = getUnroutedModelEndpointStats();
    assert.equal(after.endpoints[key], base + 2, "counted under the masked endpoint key");
    assert.ok(after.total >= 2);
});

test("logUnroutedModelEndpoint: distinct endpoints are counted independently", () => {
    logUnroutedModelEndpoint("https://a.example/api/agent/v3/llm_utils_chat");
    logUnroutedModelEndpoint("https://b.example/api/agent/v3/llm_utils_chat");
    const stats = getUnroutedModelEndpointStats();
    const keyA = maskUrlsInText("https://a.example/api/agent/v3/llm_utils_chat");
    const keyB = maskUrlsInText("https://b.example/api/agent/v3/llm_utils_chat");
    assert.ok(stats.endpoints[keyA] !== undefined, "endpoint A counted");
    assert.ok(stats.endpoints[keyB] !== undefined, "endpoint B counted");
});
