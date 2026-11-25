import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseUsageLog, runDiff } from "../src/acp-cache-diff.ts";
import { closeLogger, configureLogger, enterSessionContext, log } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

const START = Date.parse("2026-11-14T12:00:00.000Z");

for (const scoped of [false, true]) {
    for (const plugin of [false, true]) {
        test(`reads actual logger output: scoped=${scoped}, plugin=${plugin}`, async (t) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-usage-tags-"));
            const file = path.join(dir, "bili.log");
            t.mock.timers.enable({ apis: ["Date"], now: START });
            try {
                configureLogger(file);
                if (scoped) enterSessionContext("request-scope");
                log("info", `[actual-session] ${plugin ? "[plugin] " : ""}[acp-usage]${plugin ? "" : " round 2"} input=10000 cached=0 (cache hit 0%)`);
                await closeLogger();
                const line = fs.readFileSync(file, "utf8").split("\n").find((s) => s.includes("[acp-usage]"));
                assert.ok(line);
                assert.match(line, /\[v=[^\]]+\] \[actual-session\]/);
                if (scoped) assert.match(line, /\[sess=request-scope\]/);
                else assert.doesNotMatch(line, /\[sess=/);
                const samples = await parseUsageLog(file);
                assert.deepEqual([...samples], [["actual-session", [{ ts: START, input: 10000, cached: 0 }]]]);
            } finally {
                await closeLogger();
                configureLogger("off");
                rmrf(dir);
            }
        });
    }
}

for (const stamp of ["2026-11-14T12:00:00.000", "2026-11-14T12:00:00.000Z", "2026-11-14T17:45:00.000+05:45"]) {
    test(`keeps legacy and tagged timestamps: ${stamp}`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-usage-mixed-"));
        const file = path.join(dir, "bili.log");
        try {
            fs.writeFileSync(file, [
                `${stamp} [info] [legacy/id] [acp-usage] round 1 input=10 cached=5`,
                `${stamp} [info] [v=0.1.214] [tagged/id] [plugin] [acp-usage] input=20 cached=15`,
            ].join("\n"));
            assert.deepEqual([...await parseUsageLog(file)], [
                ["legacy_id", [{ ts: Date.parse(stamp), input: 10, cached: 5 }]],
                ["tagged_id", [{ ts: Date.parse(stamp), input: 20, cached: 15 }]],
            ]);
        } finally { rmrf(dir); }
    });
}

test("sorts mixed historical and current samples by timestamp within the explicit session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-usage-order-"));
    const file = path.join(dir, "bili.log");
    try {
        fs.writeFileSync(file, [
            "2026-11-14T12:00:02.000Z [info] [sess=scope] [v=0.1.214] [same] [acp-usage] round 3 input=30 cached=25",
            "2026-11-14T12:00:00.000Z [info] [same] [plugin] [acp-usage] input=0 cached=0",
            "2026-11-14T12:00:01.000Z [info] [v=0.1.213] [same] [acp-usage] input=20 cached=10",
        ].join("\n"));
        assert.deepEqual([...await parseUsageLog(file)], [["same", [
            { ts: START, input: 0, cached: 0 },
            { ts: START + 1000, input: 20, cached: 10 },
            { ts: START + 2000, input: 30, cached: 25 },
        ]]]);
    } finally { rmrf(dir); }
});

for (const tags of ["[v=0.1.214]", "[sess=scope] [v=0.1.214]"]) {
    test(`does not invent a session from logger metadata: ${tags}`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-usage-no-session-"));
        const file = path.join(dir, "bili.log");
        try {
            fs.writeFileSync(file, `2026-11-14T12:00:00.000Z [info] ${tags} [acp-usage] input=10 cached=5\n`);
            assert.equal((await parseUsageLog(file)).size, 0);
        } finally { rmrf(dir); }
    });
}

test("keeps a literal plugin session id distinct from the optional plugin producer tag", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-usage-plugin-id-"));
    const file = path.join(dir, "bili.log");
    try {
        fs.writeFileSync(file, [
            "2026-11-14T12:00:00.000Z [info] [v=0.1.214] [plugin] [acp-usage] input=10 cached=5",
            "2026-11-14T12:00:00.000Z [info] [v=0.1.214] [plugin] [plugin] [acp-usage] input=20 cached=15",
        ].join("\n"));
        assert.deepEqual([...await parseUsageLog(file)], [["plugin", [
            { ts: START, input: 10, cached: 5 },
            { ts: START, input: 20, cached: 15 },
        ]]]);
    } finally { rmrf(dir); }
});

test("keeps malformed and unrelated lines out of the usage ledger", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-usage-noise-"));
    const file = path.join(dir, "bili.log");
    try {
        const prefix = "2026-11-14T12:00:00.000Z [info]";
        fs.writeFileSync(file, [
            `${prefix} [v=0.1.214] [sid] [plugin] [acp-usage] input=10 cached=n/a`,
            `${prefix} [v=0.1.214] [sid] response body: [acp-usage] input=10 cached=5`,
            `${prefix} [v=0.1.214] [sid] [unknown] [acp-usage] input=10 cached=5`,
            `${prefix} [v=0.1.214] [v=other] [sid] [acp-usage] input=10 cached=5`,
            `${prefix} [sid] [acp-usage] input=10`,
            "2026-99-99T12:00:00.000Z [info] [v=0.1.214] [sid] [acp-usage] input=10 cached=5",
        ].join("\n"));
        assert.equal((await parseUsageLog(file)).size, 0);
    } finally { rmrf(dir); }
});

for (const explicitLog of [false, true]) {
    test(`runDiff correlates real scoped logger output and reports a cache miss: explicitLog=${explicitLog}`, async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-usage-report-"));
        const file = path.join(dir, "bili.log");
        t.mock.timers.enable({ apis: ["Date"], now: START + 500 });
        try {
            const messages = [{ role: "user", content: "hello" }, { role: "assistant", content: "reply" }];
            for (const [stamp, count] of [[START, 1], [START + 5000, 2]] as const) {
                const body = JSON.stringify({ model: "fixture-model", messages: messages.slice(0, count) });
                for (const kind of ["REQ", "INCOMING"]) {
                    fs.writeFileSync(path.join(dir, `${stamp}-actual-session-${kind}.txt`), `POST /v1/chat/completions\ncontent-type: application/json\n\n${body}`);
                }
            }
            configureLogger(file);
            enterSessionContext("different-request-scope");
            log("info", "[actual-session] [plugin] [acp-usage] input=10000 cached=9500");
            t.mock.timers.setTime(START + 5500);
            log("info", "[actual-session] [acp-usage] round 1 input=11000 cached=1000");
            await closeLogger();
            const report = await runDiff(dir, explicitLog ? { logFile: file } : {});
            assert.equal(report.logSource, file);
            assert.equal(report.usageSamples, 2);
            assert.equal(report.totalPairs, 1);
            const pair = report.sessions[0]!.pairs[0]!;
            assert.equal(report.sessions[0]!.sid, "actual-session");
            assert.equal(pair.usageAvailable, true);
            assert.equal(pair.category, "prefix-stable-miss");
            assert.deepEqual(pair.usage, { inputA: 10000, cachedB: 1000, inputB: 11000, missedPrefix: 9000, hitPctB: 9 });
        } finally {
            await closeLogger();
            configureLogger("off");
            rmrf(dir);
        }
    });
}
