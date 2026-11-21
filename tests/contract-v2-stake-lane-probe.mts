/**
 * #5241 阶段 0 打桩配套探针:在「干净子进程」里驱动单条宿主车道的
 * verifyAttachAndRecover,把结果以一行 JSON 报告给父测试
 * (tests/contract-v2-stake-verify-attach.test.ts)。
 *
 * 为什么子进程:四条车道共享同一个进程的 global fetch、env 和模块级
 * 状态,同进程顺序驱动会互相污染(实测:一条车道的后台异步会改写另一条
 * 车道的 env/spawn 计数)。生产里每条车道都在自己的宿主进程里启动,
 * 子进程隔离就是被测现实本身。
 *
 * 用法: node --import tsx contract-v2-stake-lane-probe.mts <lane> <scenario>
 *   lane     = pi | omp | opencode | dsh
 *   scenario = s1 (healthy equal-version mock)
 *            | s2 (strictly older mock)
 *            | s3 (dead target, port 9)
 * 输出: 单行 JSON { lane, scenario, landed, spawns, shutdowns, envAfter, registerBase }
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const HERMETIC = fs.mkdtempSync(path.join(os.tmpdir(), "bili-c2-probe-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC, "no-config.json");
process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT ?? "contract-stake";
process.env.BILI_ATTACH_EVIDENCE_GRACE_MS = "30";
process.env.BILI_ATTACH_HEALTH_DEADLINE_MS = "150";
delete process.env.BILLION_CONTEXT_ATTACH;
delete process.env.BILLION_CONTEXT_NATIVE;
delete process.env.BILLION_CONTEXT_PROXY;

const [laneName, scenario] = process.argv.slice(2) as [string, string];
if (laneName === undefined || scenario === undefined) {
    process.stderr.write("usage: lane-probe.mts <lane> <scenario>\n");
    process.exit(2);
}

function startMockBili(version: string): Promise<{ origin: string; shutdowns: () => number }> {
    let shutdowns = 0;
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (req.method === "GET" && url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version, tools: {} }));
            return;
        }
        if (req.method === "POST" && url === "/__bili/shutdown") {
            shutdowns += 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, shutdowns: () => shutdowns });
        });
    });
}

const ni = await import("../src/agent/native-intercept.ts");
const { VERSION } = await import("../src/version.ts");
const counter = { n: 0 };
const countingSpawn = async (): Promise<string | undefined> => {
    counter.n += 1;
    return "http://127.0.0.1:7777";
};

let mock: { origin: string; shutdowns: () => number } | undefined;
let origin: string;
if (scenario === "s1") { mock = await startMockBili(VERSION); origin = mock.origin; }
else if (scenario === "s2") { mock = await startMockBili("0.0.1"); origin = mock.origin; }
else { origin = "http://127.0.0.1:9"; }

let landed: string | undefined;
let registerBase: string | undefined | "unset";

if (laneName === "pi") {
    const pi = await import("../src/agent/pi-native.ts");
    ni._resetForTest();
    pi._resetNativeStateForTest();
    pi._setSpawnForTest(countingSpawn);
    pi.armNativePi({ mode: "attach", attachOrigin: origin });
    const respawn = pi._stateRespawnForTest();
    if (respawn === undefined) throw new Error("pi arm did not expose the respawn seam");
    landed = await respawn();
    pi._setSpawnForTest(undefined);
} else if (laneName === "omp") {
    const omp = await import("../src/agent/omp-native.ts");
    ni._resetForTest();
    omp._resetNativeStateForTest();
    omp._setSpawnForTest(countingSpawn);
    omp.armNativeOmp({ mode: "attach", attachOrigin: origin });
    const respawn = omp._stateRespawnForTest();
    if (respawn === undefined) throw new Error("omp arm did not expose the respawn seam");
    landed = await respawn();
    omp._setSpawnForTest(undefined);
} else if (laneName === "opencode") {
    const oc = await import("../src/agent/opencode-native.ts");
    ni._resetForTest();
    oc._resetNativeStateForTest();
    oc._setSpawnForTest(countingSpawn);
    landed = await oc.verifyAttachAndRecover(origin);
    oc._setSpawnForTest(undefined);
} else if (laneName === "dsh") {
    const dsh = await import("../src/agent/dsh-native.ts");
    ni._resetForTest();
    dsh._resetRoutedForTest();
    dsh._resetRegisterForTest(origin);
    dsh._setSpawnForTest(countingSpawn);
    // dsh rides a preset origin (issue3544 harness): verify must keep it on
    // attach and UNFREE it on spawn fallback.
    process.env.BILLION_CONTEXT_PROXY = origin;
    process.env.DSH_HOME = path.join(HERMETIC, "dsh-home");
    process.env.XDG_STATE_HOME = path.join(HERMETIC, "dsh-state");
    landed = await dsh.verifyAttachAndRecover(origin);
    registerBase = dsh._registerStateForTest().base ?? "unset";
    dsh._setSpawnForTest(undefined);
} else {
    process.stderr.write(`unknown lane: ${laneName}\n`);
    process.exit(2);
}

// Capture right after the lane ran (no reset helpers in between — the
// reset helpers delete BILLION_CONTEXT_PROXY; process.exit handles timers).
const envAfter = process.env.BILLION_CONTEXT_PROXY ?? null;

const report = {
    lane: laneName,
    scenario,
    landed: landed ?? null,
    spawns: counter.n,
    shutdowns: mock?.shutdowns() ?? 0,
    envAfter,
    registerBase: registerBase ?? null,
};
process.stdout.write(`\nPROBE ${JSON.stringify(report)}`);
// Force-exit: lane modules leave background timers (recovery/reprobe loops)
// that would otherwise hold the child open for their full TTL.
process.exit(0);
