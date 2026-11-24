// Run at either revision: node --import tsx scripts/bench-cache-usage-alignment.ts [requests] [samples-per-request]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDiff } from "../src/acp-cache-diff.ts";

const count = Number(process.argv[2] ?? 10_000);
const perRequest = Number(process.argv[3] ?? 10);
assert.ok(Number.isSafeInteger(count) && count >= 2);
assert.ok(Number.isSafeInteger(perRequest) && perRequest > 0 && perRequest < 900);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-align-bench-"));
const logFile = path.join(dir, "bili.log");
const start = Date.parse("2026-11-14T01:00:00.000Z");
const body = JSON.stringify({ model: "benchmark", messages: [{ role: "user", content: "retained history" }] });

try {
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
        const ts = start + i * 1000;
        fs.writeFileSync(path.join(dir, `${ts}-session-REQ.txt`), `POST /v1/chat/completions\ncontent-type: application/json\n\n${body}`);
        for (let j = 0; j < perRequest; j++) {
            lines.push(`${new Date(ts + 100 + j).toISOString()} [info] [session] [acp-usage] input=${100_000 + i} cached=${99_000 + i}\n`);
        }
    }
    fs.writeFileSync(logFile, lines.join(""));
    await runDiff(dir, { logFile });
    const cpuBefore = process.cpuUsage();
    const before = performance.now();
    const report = await runDiff(dir, { logFile });
    const elapsedMs = performance.now() - before;
    const cpu = process.cpuUsage(cpuBefore);
    assert.equal(report.totalPairs, count - 1);
    assert.equal(report.usageSamples, count * perRequest);
    for (let i = 0; i < count - 1; i++) {
        assert.deepEqual(report.sessions[0]!.pairs[i]!.usage, {
            inputA: 100_000 + i,
            inputB: 100_001 + i,
            cachedB: 99_001 + i,
            missedPrefix: 999,
            hitPctB: Math.round((99_001 + i) / (100_001 + i) * 100),
        });
    }
    const normalized = { ...report, dir: "<fixture>", logSource: "<fixture>/bili.log" };
    const sha256 = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    process.stdout.write(`${JSON.stringify({ requests: count, samples: count * perRequest, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, sha256 })}\n`);
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
