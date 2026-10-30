/**
 * #5241 阶段 0 特征化打桩(不改产品代码):四条宿主车道
 * verifyAttachAndRecover 的行为矩阵 —— 抽取共享 adapter/lifecycle 之前的
 * 现状基准。
 *
 * 桩钉的是"现在怎样"(包括不一致),不是"应该怎样":
 *  - S1 健康等版本 target:四车道一致 → attach 原地,不 spawn、不发 shutdown;
 *  - S2 target 跑严格旧版本:pi/omp/opencode 照样 attach(无版本轮换);
 *    dsh 车道会轮换 + 重生 —— 那条分歧已有专项桩
 *    (tests/issue3544-stale-proxy-rotation.test.ts:392),此处不重跑,
 *    只记录四车道对同一输入给出不同答案这一事实;
 *  - S3 target 死亡:四车道一致 → spawnFallback,spawn 恰一次;env 侧
 *    pi/omp/opencode 把 BILLION_CONTEXT_PROXY 重发布到新 origin,dsh 则
 *    解除 preset 并改写 register(车道间又一个形态差异)。
 *
 * 每条车道在自己的子进程里跑(contract-v2-stake-lane-probe.mts):四车道
 * 共享同进程的 global fetch / env / 模块状态,同进程顺序驱动会互相污染
 * (实测:一条车道的后台异步会改写另一条的 env 与 spawn 计数)——
 * 生产现实也是每车道一个宿主进程。
 *
 * 阶段 1 合并四份拷贝时,本矩阵是行为等价性的验收网;S2 的跨车道分歧
 * 必须在实现方案讨论里显式裁决(统一成轮换,还是保留 dsh 特权)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(new URL("./contract-v2-stake-lane-probe.mts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface ProbeReport {
    lane: string;
    scenario: string;
    landed: string | null;
    spawns: number;
    shutdowns: number;
    envAfter: string | null;
    registerBase: string | null;
}

async function probe(lane: string, scenario: string): Promise<ProbeReport> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", PROBE, lane, scenario], {
            cwd: REPO_ROOT,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (c) => { out += c; });
        child.on("error", reject);
        child.on("close", (code) => {
            const line = out.split("\n").find((l) => l.startsWith("PROBE "));
            if (line === undefined) { reject(new Error(`${lane}/${scenario} probe produced no report (exit ${code}); stdout=${out.slice(0, 400)}`)); return; }
            resolve(JSON.parse(line.slice("PROBE ".length)) as ProbeReport);
        });
    });
}

const SPAWNED = "http://127.0.0.1:7777";
const LANES = ["pi", "omp", "opencode", "dsh"] as const;

test("S1: a healthy equal-version target attaches in place on all four lanes (no spawn, no shutdown)", async () => {
    for (const lane of LANES) {
        const r = await probe(lane, "s1");
        assert.notEqual(r.landed, null, `${lane}: healthy target must land somewhere`);
        assert.equal(r.spawns, 0, `${lane}: no spawn for a healthy target`);
        assert.equal(r.shutdowns, 0, `${lane}: no shutdown request for a healthy equal-version resident`);
        if (lane === "dsh") {
            assert.equal(r.envAfter, r.landed, "dsh: the preset origin survives the attach (frozen)");
            assert.equal(r.registerBase, r.landed, "dsh: register stays based on the resident");
        } else {
            assert.equal(r.landed, r.envAfter, `${lane}: landed origin is published to BILLION_CONTEXT_PROXY`);
        }
    }
});

test("S2: a strictly OLDER target attaches untouched on pi/omp/opencode — no rotation exists outside dsh", async () => {
    for (const lane of ["pi", "omp", "opencode"] as const) {
        const r = await probe(lane, "s2");
        assert.notEqual(r.landed, null, `${lane}: an older-but-healthy resident is attached as-is (today's behavior)`);
        assert.equal(r.spawns, 0, `${lane}: no spawn for an older-but-healthy resident`);
        assert.equal(r.shutdowns, 0, `${lane}: no shutdown request — rotation machinery does not exist on this lane`);
        assert.equal(r.landed, r.envAfter, `${lane}: landed origin published`);
    }
    // DIVERGENCE STAKE: dsh answers the SAME input differently (rotate +
    // respawn). That arm is pinned by tests/issue3544-stale-proxy-rotation.test.ts
    // ("a strictly older resident is rotated out and replaced"). Phase 1
    // extraction must decide ONE policy for the shared adapter; until then
    // the four copies are not behaviorally interchangeable.
});

test("S3: a dead target falls back to exactly one spawn on all four lanes", async () => {
    for (const lane of LANES) {
        const r = await probe(lane, "s3");
        assert.equal(r.landed, SPAWNED, `${lane}: dead target lands on the spawned origin`);
        assert.equal(r.spawns, 1, `${lane}: spawn fallback ran exactly once`);
        if (lane === "dsh") {
            assert.equal(r.envAfter, null, "dsh: spawn fallback UNFREEZES the preset (register becomes the source of truth)");
            assert.equal(r.registerBase, SPAWNED, "dsh: register re-based onto the fresh spawn");
        } else {
            assert.equal(r.envAfter, SPAWNED, `${lane}: env republished onto the spawn`);
        }
    }
});
