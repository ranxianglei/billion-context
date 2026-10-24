import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logTimestamp } from "../src/logger.ts";
import { queryLogLines } from "../src/web/logs-query.ts";
import { parseUsageLog } from "../src/acp-cache-diff.ts";

test("logTimestamp: system local wall clock, no zone suffix", () => {
    const d = new Date(2026, 9, 24, 19, 19, 2, 681);
    const ts = logTimestamp(d);
    assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
    // Local fields, exactly what `date` prints — not the UTC fields.
    assert.equal(ts.slice(0, 19), "2026-10-24T19:19:02");
    assert.equal(ts.slice(11, 19), [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":"));
    // A bare stamp reads back as local time, so it round-trips on this machine.
    assert.equal(Date.parse(ts), d.getTime());
});

test("logs-query: window selection parses bare local stamps (and old Z stamps)", () => {
    const zone = new Date(2026, 9, 24, 12, 0, 0, 0);
    const local = Array.from({ length: 5 }, (_, i) => `${logTimestamp(new Date(zone.getTime() + i * 60_000))} [info] ${i === 1 ? "needle" : `noise-${i}`}`);
    // ±90s around the minute-1 hit → rows 0,1,2 (rows are one minute apart).
    assert.deepEqual(queryLogLines(local, "needle", { ctx: 0, winSec: 90, n: 100 }).lines, local.slice(0, 3));
    // Rotated-file stamps stay Z; they must still parse into the same window.
    const legacy = ["2026-09-24T14:32:05.123Z [info] needle-a", "2026-09-24T14:32:40.000Z [info] noise-legacy", "2026-09-24T14:33:01.000Z [info] needle-b"];
    assert.deepEqual(queryLogLines(legacy, "needle", { ctx: 0, winSec: 30, n: 100 }).lines, legacy);
});

test("acp-cache-diff: usage lines with a bare local stamp still parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-log-ts-"));
    try {
        const file = join(dir, "bili.log");
        const ts = logTimestamp(new Date(2026, 9, 24, 12, 0, 0, 0));
        writeFileSync(file, `${ts} [info] [ses_a] [acp-usage] input=1000 cached=900 (cache hit 90%)\n`);
        const bySession = parseUsageLog(file);
        assert.deepEqual(bySession.get("ses_a"), [{ ts: Date.parse(ts), input: 1000, cached: 900 }]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
