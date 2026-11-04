/**
 * #5241 阶段 0 特征化打桩(不改产品代码):/__bili/health 的应答词汇表
 * —— C1 契约(生命周期单源、健康度可表达)改造前的现状基准。
 *
 * 现状只有两个状态:bootReady 之前 503 {ok:false, reason:"starting"},
 * 之后 200 全量快照。没有 degraded / degraded-reason / recovery-etf 字段
 * —— sidecar 被闩死、stderr 被闩死、lane 降级直发,这些都发生在进程
 * 内部,health 一个字都不说。这正是 C1 要改的:桩先把这个「不可表达」
 * 钉死,阶段 1 加字段时本桩的键集断言必须同步更新(有意为之的账本)。
 *
 * 客户端三态探测(alive/busy/dead,src/liveness.ts)已有专项桩
 * tests/issue3654-health-probe-three-state.test.ts,不在此重钉。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { handleAdminRoute } from "../src/server/admin.ts";
import { VERSION } from "../src/version.ts";

const HERMETIC = fs.mkdtempSync(path.join(os.tmpdir(), "bili-c2-health-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC, "no-config.json");

after(() => {
    fs.rmSync(HERMETIC, { recursive: true, force: true });
});

type AdminCtxLike = Parameters<typeof handleAdminRoute>[2];

/** The health branch only reads these fields (auxProxyShot resolves inside a
 *  try/catch, so a minimal opts is safe). Everything else gets a stub. */
function makeCtx(bootReady: boolean): AdminCtxLike {
    return {
        opts: { upstream: "https://api.example.invalid" },
        core: {},
        config: {},
        log: () => {},
        instanceId: "stake-instance",
        instanceStartedAt: 1_710_000_000_000,
        proxyWatchers: new Set([4242]),
        initialWatcherPid: 4242,
        watcherLastSeen: new Map(),
        bootReady: () => bootReady,
    } as unknown as AdminCtxLike;
}

async function getHealth(bootReady: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
    const ctx = makeCtx(bootReady);
    const server = http.createServer((req, res) => {
        void handleAdminRoute(req, res, ctx).catch(() => {
            if (!res.headersSent) { res.statusCode = 500; res.end("{}"); }
        });
    });
    const origin = await new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve(`http://127.0.0.1:${addr.port}`);
        });
    });
    try {
        const res = await fetch(`${origin}/__bili/health`);
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
    }
}

test("pre-boot /__bili/health: exactly 503 {ok:false, reason:\"starting\"} — nothing else is expressible yet", async () => {
    const { status, body } = await getHealth(false);
    assert.equal(status, 503);
    assert.deepEqual(Object.keys(body).sort(), ["ok", "reason"], "the starting answer carries exactly two keys");
    assert.deepEqual(body, { ok: false, reason: "starting" });
});

test("post-boot /__bili/health: exactly the 11-field snapshot — no lifecycle/degradation vocabulary exists today", async () => {
    const { status, body } = await getHealth(true);
    assert.equal(status, 200);
    assert.deepEqual(
        Object.keys(body).sort(),
        ["auxProxy", "auxProxySource", "blindTunnels", "commit", "instanceId", "ok", "pid", "startedAt", "upstream", "version", "watchdog"],
        "the ready answer carries exactly the current field set (C1: adding lifecycle fields is a deliberate, visible change)",
    );
    assert.equal(body.ok, true);
    assert.equal(body.version, VERSION);
    assert.equal(body.instanceId, "stake-instance");
    assert.equal(body.startedAt, 1_710_000_000_000);
    assert.equal(body.pid, process.pid, "in-process stub server: the pid is this test process");
    assert.equal(body.upstream, "https://api.example.invalid");
    // The C1 gap, pinned explicitly: today's payload CANNOT say degraded.
    for (const absent of ["lifecycle", "state", "mode", "degraded", "degradations", "recoveryEtaMs", "reason"]) {
        assert.equal(absent in body, false, `no "${absent}" field exists in today's health vocabulary`);
    }
    assert.deepEqual(body.watchdog, { armed: true, parentPid: 4242, watchers: [4242] }, "#1322 watchdog shape pinned as-is");
});
