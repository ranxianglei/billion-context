/**
 * #5241 阶段 0 特征化打桩(不改产品代码):两把「一次性闩锁」的永久性
 * —— C3 契约(降级必须有告警、可恢复、有 TTL)改造前的现状基准。
 *
 *  - shadow.ts stats.disabled:3 次结构性 ingest 失败闩死统一 sidecar。
 *    issue5140 已钉「3 strike 才闩、闩后 warn 只一条」;这里补钉的是
 *    C3 关心的另一半事实:**进程内不存在任何恢复路径** —— 故障消失后
 *    record() 永久 no-op、读路径全部回退、fork 直接 throw,直到进程重启。
 *  - logger.ts stderrDead:stderr 写失败(同步抛或流 error 事件)把
 *    整个进程的日志降级为 file-only,一次性、幂等、同样无复位。
 *    markStderrDead 未导出且无 reset —— 进程内翻闩会污染同进程后续
 *    测试,所以这半边用子进程桩:子进程自己翻闩,把 capture 记录和
 *    「翻闩后 stderr 还写过几次」回报给父进程断言。
 *
 * 阶段 2(闩锁治理)要改行为时,这两个桩就是「改了什么」的显式账本。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { isStreamWriteError } from "../src/logger.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";

const HERMETIC = fs.mkdtempSync(path.join(os.tmpdir(), "bili-c2-latch-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC, "no-config.json");

before(() => {
    delete process.env.BILI_STORAGE_UNIFIED;
    delete process.env.BILI_ENCRYPTION_KEY;
});

after(() => {
    fs.rmSync(HERMETIC, { recursive: true, force: true });
});

function mkShadow(): UnifiedShadow {
    const dir = fs.mkdtempSync(path.join(HERMETIC, "sh-"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
    assert.ok(shadow !== null, "hermetic shadow must open (real sqlite engine present)");
    return shadow;
}

let seq = 0;
function fix(): LegacySessionLike {
    seq++;
    return {
        id: `latch-s${seq}`,
        createdAt: 1_000,
        lastSeen: 2_000 + seq,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, nextBlockId: 1, nextRunId: 1 },
        blockContents: new Map<string, string>(),
        lastMessages: [],
        lastMessagesFolded: false,
    } as unknown as LegacySessionLike;
}

/** Same fault seam as issue5140: the verify leg's first read-back. */
type SyncLike = { getBlocks: (id: string, opts?: { limit: number; offset?: number }) => unknown[] };
function installFault(shadow: UnifiedShadow, message: string): () => void {
    const sync = (shadow as unknown as { sync: SyncLike }).sync;
    const orig = sync.getBlocks;
    sync.getBlocks = () => { throw new Error(message); };
    return () => { sync.getBlocks = orig; };
}

test("shadow disable latch: once disabled, healthy records are permanent no-ops (no re-enable path exists)", () => {
    const shadow = mkShadow();
    try {
        const off = installFault(shadow, "file is not a database (stake: structural)");
        for (let i = 0; i < 3; i++) shadow.record(fix());
        off();
        assert.equal(shadow.stats.disabled, true, "three structural strikes latch the sidecar");
        const ingestsFrozen = shadow.stats.ingests;
        const lastErr = String(shadow.stats.lastError);
        assert.match(lastErr, /file is not a database/);

        // The fault is GONE now. Today there is no recovery: every later
        // record() early-returns at the disabled gate before it can succeed,
        // so the streak can never reset and the latch can never clear.
        for (let i = 0; i < 5; i++) shadow.record(fix());
        assert.equal(shadow.stats.disabled, true, "still disabled after healthy records — the latch never re-arms");
        assert.equal(shadow.stats.ingests, ingestsFrozen, "disabled record() is a no-op: the ingest counter never moves again");
        assert.equal(String(shadow.stats.lastError), lastErr, "lastError is frozen at the strike that latched");

        // Every read/degrade path funnels back to legacy:
        assert.equal(shadow.readsUnified, false, "reads go legacy-only");
        assert.equal(shadow.viewFor("anything"), null, "viewFor degrades to null (callers fall back to legacy)");

        // And the strict fork publication path fails closed instead:
        assert.throws(() => shadow.createForkAsync("parent", fix()), /fork storage unavailable/, "fork publication throws once disabled");
    } finally {
        shadow.close();
    }
});

// ---------------------------------------------------------------------------
// stderr-dead latch: driven in a CHILD process (markStderrDead is module-
// private, has no reset, and flipping it here would poison every later test
// in this process — itself part of the characterization: the latch owns the
// whole process for its lifetime).
// ---------------------------------------------------------------------------

const CHILD_SRC = `
import { log, setLogCapture } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/logger.ts", import.meta.url))).href)};
const captured: string[] = [];
setLogCapture((level, msg) => { captured.push(level + " " + msg); });
const origWrite = process.stderr.write.bind(process.stderr);
let writes = 0;
const counting = (chunk: unknown, enc?: unknown, cb?: unknown) => { writes += 1; return origWrite(chunk as never, enc as never, cb as never); };
process.stderr.write = counting as typeof process.stderr.write;
log("info", "stake warmup"); // healthy: counted, latch not yet flipped
// 1) a synchronous stderr write failure flips the latch…
process.stderr.write = (() => { throw new Error("EPIPE (stake)"); }) as typeof process.stderr.write;
log("info", "stake before flip");
// 2) …after which the stderr leg is skipped even though stderr works again…
process.stderr.write = counting as typeof process.stderr.write;
log("info", "stake after flip");
// 3) …and a second trigger (the async stream 'error' event path) stays idempotent.
process.stderr.emit("error", new Error("EPIPE async (stake)"));
log("info", "stake after second trigger");
process.stdout.write(JSON.stringify({ captured, writes }));
`;

test("stderr-dead latch: one failure permanently skips the stderr leg, exactly one warn, logging itself keeps working", async () => {
    const childPath = path.join(HERMETIC, "stderr-flip-child.mts");
    fs.writeFileSync(childPath, CHILD_SRC, "utf8");
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const done = new Promise<{ captured: string[]; writes: number }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", childPath], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (c) => { out += c; });
        child.stderr.on("data", () => { /* counted in-child */ });
        child.on("error", reject);
        child.on("close", (code) => {
            const line = out.split("\n").find((l) => l.startsWith("{"));
            if (code !== 0 || line === undefined) { reject(new Error(`child exited ${code}; stdout=${out.slice(0, 500)}`)); return; }
            resolve(JSON.parse(line) as { captured: string[]; writes: number });
        });
    });
    const { captured, writes } = await done;
    const flips = captured.filter((l) => l.startsWith("warn stderr unavailable ("));
    assert.equal(flips.length, 1, "the file-only degradation warns exactly once, idempotent across both trigger paths");
    assert.match(flips[0]!, /continuing with file-only logging/);
    assert.equal(writes, 1, "only the PRE-flip warmup line reached stderr — nothing after the flip, even though stderr works again");
    // The logger itself never degrades to silence: later lines still flow
    // through capture (and the file leg).
    assert.ok(captured.some((l) => l === "info stake after flip"), "post-flip lines still reach the capture sink");
    assert.ok(captured.some((l) => l === "info stake after second trigger"), "lines after the second trigger still reach the capture sink");
});

test("isStreamWriteError truth table (pure predicate, kept beside the latch it serves)", () => {
    assert.equal(isStreamWriteError(Object.assign(new Error("broken pipe"), { code: "EPIPE" })), true);
    assert.equal(isStreamWriteError(Object.assign(new Error("io"), { code: "EIO" })), true);
    assert.equal(isStreamWriteError(Object.assign(new Error("bad fd"), { code: "EBADF" })), true);
    assert.equal(isStreamWriteError(Object.assign(new Error("destroyed"), { code: "ERR_STREAM_DESTROYED" })), true);
    assert.equal(isStreamWriteError(new Error("plain error without code")), false);
    assert.equal(isStreamWriteError(Object.assign(new Error("other code"), { code: "ENOENT" })), false);
    assert.equal(isStreamWriteError("not an error object"), false);
    assert.equal(isStreamWriteError(undefined), false);
});
