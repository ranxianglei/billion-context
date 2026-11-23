import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDiff } from "../src/acp-cache-diff.ts";
import { rmrf } from "./tmp-rm.ts";

const START = Date.parse("2026-11-14T01:00:00.000Z");
const BODY = JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "retained history" }] });

async function reportFor(requests: Array<{ at: number; sid?: string; subdir?: string }>, samples: Array<{ at: number; input: number; cached: number; sid?: string }>, session?: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-usage-align-"));
    try {
        for (const request of requests) {
            const folder = path.join(dir, request.subdir ?? "");
            fs.mkdirSync(folder, { recursive: true });
            fs.writeFileSync(path.join(folder, `${START + request.at}-${request.sid ?? "session"}-REQ.txt`), `POST /v1/chat/completions\ncontent-type: application/json\n\n${BODY}`);
        }
        const logFile = path.join(dir, "bili.log");
        fs.writeFileSync(logFile, samples.map((sample) => `${new Date(START + sample.at).toISOString()} [info] [${sample.sid ?? "session"}] [acp-usage] input=${sample.input} cached=${sample.cached}\n`).join(""));
        return await runDiff(dir, { logFile, session });
    } finally {
        rmrf(dir);
    }
}

test("cache usage alignment keeps the earliest sample per request after sorting the log", async () => {
    const report = await reportFor([{ at: 3000 }, { at: 1000 }, { at: 2000 }], [
        { at: 3200, input: 30_000, cached: 19_000 },
        { at: 2300, input: 21_000, cached: 9000 },
        { at: 900, input: 999_999, cached: 0 },
        { at: 2100, input: 20_000, cached: 10_000 },
        { at: 1200, input: 10_000, cached: 8000 },
        { at: 3100, input: 30_000, cached: 20_000 },
        { at: 99_000, input: 999_999, cached: 0 },
    ]);
    assert.equal(report.usageSamples, 7);
    assert.deepEqual(report.sessions[0]!.pairs.map((pair) => pair.usage), [
        { inputA: 10_000, inputB: 20_000, cachedB: 10_000, missedPrefix: 0, hitPctB: 50 },
        { inputA: 20_000, inputB: 30_000, cachedB: 20_000, missedPrefix: 0, hitPctB: 67 },
    ]);
    assert.deepEqual(report.byCategory, { "pure-append": 2, "mid-stream-rewrite": 0, "prefix-stable-miss": 0 });
});

for (const offset of [-51, -50, 0, 50]) {
    test(`cache usage alignment retains the 50 ms admission boundary (${offset} ms)`, async () => {
        const report = await reportFor([{ at: 1000 }, { at: 2000 }], [
            { at: 1000 + offset, input: 10_000, cached: 8000 },
            { at: 2000 + offset, input: 20_000, cached: 10_000 },
        ]);
        const pair = report.sessions[0]!.pairs[0]!;
        assert.equal(pair.usageAvailable, offset >= -50);
        assert.deepEqual(pair.usage, offset >= -50
            ? { inputA: 10_000, inputB: 20_000, cachedB: 10_000, missedPrefix: 0, hitPctB: 50 }
            : null);
    });
}

test("cache usage alignment assigns equal-time dumps to the last retained request", async () => {
    const report = await reportFor([{ at: 1000 }, { at: 1000, subdir: "raw" }, { at: 2000 }], [
        { at: 1100, input: 10_000, cached: 8000 },
        { at: 2100, input: 20_000, cached: 10_000 },
    ]);
    const pairs = report.sessions[0]!.pairs;
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0]!.usageAvailable, false);
    assert.deepEqual(pairs[1]!.usage, { inputA: 10_000, inputB: 20_000, cachedB: 10_000, missedPrefix: 0, hitPctB: 50 });
});

test("cache usage alignment keeps same-time samples stable and sessions separate", async () => {
    const report = await reportFor([
        { at: 1000, sid: "first" }, { at: 2000, sid: "first" },
        { at: 1000, sid: "second" }, { at: 2000, sid: "second" },
    ], [
        { at: 2100, input: 20_000, cached: 1000, sid: "first" },
        { at: 1100, input: 900_000, cached: 0, sid: "second" },
        { at: 1100, input: 10_000, cached: 8000, sid: "first" },
        { at: 2100, input: 99_999, cached: 10_000, sid: "first" },
    ], "first");
    assert.equal(report.sessions.length, 1);
    assert.equal(report.usageSamples, 4);
    const pair = report.sessions[0]!.pairs[0]!;
    assert.equal(pair.category, "prefix-stable-miss");
    assert.deepEqual(pair.usage, { inputA: 10_000, inputB: 20_000, cachedB: 1000, missedPrefix: 9000, hitPctB: 5 });
});

test("cache usage alignment leaves requests without samples unavailable", async () => {
    const report = await reportFor([{ at: 1000 }, { at: 2000 }, { at: 3000 }], [
        { at: 1100, input: 10_000, cached: 8000 },
        { at: 3100, input: 30_000, cached: 10_000 },
    ]);
    assert.deepEqual(report.sessions[0]!.pairs.map((pair) => pair.usage), [null, null]);
    const empty = await reportFor([{ at: 1000 }, { at: 2000 }], []);
    assert.equal(empty.usageSamples, 0);
    assert.equal(empty.sessions[0]!.pairs[0]!.usageAvailable, false);
});
