import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { armEventLoopWatchdog, watchdogVerdict } from "../src/event-loop-watchdog.ts";
import { rmrf } from "./tmp-rm.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Synchronous spin — the exact shape of a wedged event loop (#4762): no
 *  heartbeats leave the main thread while the worker's clock keeps running. */
function blockMainLoop(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
}

test("watchdogVerdict: threshold boundaries and warn-once semantics", () => {
    assert.equal(watchdogVerdict(1_000, false, 30_000, 300_000), "ok");
    assert.equal(watchdogVerdict(29_999, false, 30_000, 300_000), "ok");
    assert.equal(watchdogVerdict(30_000, false, 30_000, 300_000), "warn");
    assert.equal(watchdogVerdict(30_000, true, 30_000, 300_000), "ok");
    assert.equal(watchdogVerdict(299_999, true, 30_000, 300_000), "ok");
    assert.equal(watchdogVerdict(300_000, true, 30_000, 300_000), "trip");
});

test("wedged main loop trips the watchdog: warn + fatal forensic lines land in the log file (#4762)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-watchdog-"));
    const logFile = path.join(dir, "bili.log");
    let trippedWith: number | undefined;
    const handle = armEventLoopWatchdog({
        logFile,
        version: "0.0.0-test",
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 60,
        hardTimeoutMs: 150,
        fatalMode: "report",
        onTrip: (gapMs) => { trippedWith = gapMs; },
    });
    try {
        assert.ok(handle, "handle expected");
        await sleep(50); // beats flowing — worker initialized
        blockMainLoop(400); // synchronous spin: zero heartbeats reach the worker
        await sleep(80); // deliver the queued trip message
        if (typeof trippedWith !== "number") throw new Error(`onTrip must fire after a continuous block past hardTimeoutMs (got ${String(trippedWith)})`);
        assert.ok(trippedWith >= 150, `gap ${trippedWith} must reach the hard threshold`);
        const content = fs.readFileSync(logFile, "utf8");
        // sub-second test thresholds render as ms (production values render as s)
        assert.match(content, /\[event-loop-watchdog\] main event loop silent for \d+(?:ms|s) \(soft threshold 60ms\)/);
        assert.match(content, /\[event-loop-watchdog\] FATAL: main event loop silent for \d+(?:ms|s) \(hard threshold 150ms\)/);
        assert.match(content, /\[v=0\.0\.0-test\]/);
        // report mode latches: exactly ONE fatal line per wedge episode
        assert.equal((content.match(/FATAL/g) ?? []).length, 1);
    } finally {
        // stop() in finally: an assertion failure must not leak the live worker
        handle?.stop();
        await sleep(20);
        await rmrf(dir);
    }
});

// A file-based child avoids propagating --input-type=module to the eval worker.
const EXIT_MODE_CHILD_SOURCE = `import net from "node:net";
import { pathToFileURL } from "node:url";
const [modulePath, logFile] = process.argv.slice(2);
// The parent selects its checkout at runtime; this fixture lives outside it.
const { armEventLoopWatchdog } = await import(pathToFileURL(modulePath).href);
const listener = net.createServer((socket) => socket.end());
listener.on("error", (error) => { console.error(error); process.exit(2); });
listener.listen(0, "127.0.0.1", () => {
    process.send({ port: listener.address().port });
    armEventLoopWatchdog({
        logFile, version: "0.0.0-child", heartbeatMs: 20,
        checkIntervalMs: 20, softWarnMs: 100, hardTimeoutMs: 500,
    });
    // Wall-clock silence crosses worker/process boundaries; fake timers cannot model it.
    setTimeout(() => { for (;;) { /* blocked serving loop */ } }, 60);
});
`;

interface ChildOutcome {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    port: number;
    timedOut: boolean;
}

async function runExitModeChild(logFile: string, srcFile: string): Promise<ChildOutcome> {
    const modulePath = path.resolve(import.meta.dirname, "../src/event-loop-watchdog.ts");
    const child = spawn(process.execPath, ["--import", "tsx", srcFile, modulePath, logFile], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    let port = 0;
    let timedOut = false;
    child.stderr!.on("data", (data) => { stderr += String(data); });
    child.on("message", (message) => {
        if (message && typeof message === "object" && "port" in message && typeof message.port === "number") {
            port = message.port;
        }
    });
    // This deadline bounds a real out-of-process wedge; always await child reaping.
    const deadline = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
    }, 20_000);
    deadline.unref();
    try {
        const [code, signal] = await once(child, "close");
        return { code, signal, stderr, port, timedOut };
    } finally {
        clearTimeout(deadline);
    }
}

test("exit mode terminates a blocked serving process and releases its listener", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-watchdog-exit-"));
    const logFile = path.join(dir, "bili.log");
    const srcFile = path.join(dir, "exit-mode-child.mjs");
    let rebound: net.Server | undefined;
    try {
        fs.writeFileSync(srcFile, EXIT_MODE_CHILD_SOURCE);
        const outcome = await runExitModeChild(logFile, srcFile);
        assert.equal(outcome.timedOut, false, `watchdog left child alive: ${outcome.stderr}`);
        assert.ok(outcome.port > 0, "child must own a listener before it blocks");
        const content = fs.readFileSync(logFile, "utf8");
        assert.match(content, /FATAL: main event loop silent for \d+(?:ms|s) \(hard threshold 500ms\)/);
        assert.match(content, /\[v=0\.0\.0-child\]/);
        assert.equal((content.match(/FATAL/g) ?? []).length, 1);
        if (process.platform !== "win32") assert.equal(fs.statSync(logFile).mode & 0o077, 0, "worker-created forensic file must be owner-only");
        rebound = net.createServer();
        rebound.listen(outcome.port, "127.0.0.1");
        await once(rebound, "listening");
    } finally {
        if (rebound?.listening) {
            rebound.close();
            await once(rebound, "close");
        }
        await rmrf(dir);
    }
});

test("healthy heartbeat stream never trips (#4762)", async () => {
    let trips = 0;
    const handle = armEventLoopWatchdog({
        logFile: null,
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 100,
        hardTimeoutMs: 300,
        fatalMode: "report",
        onTrip: () => { trips += 1; },
    });
    assert.ok(handle, "handle expected");
    try {
        await sleep(400);
        assert.equal(trips, 0);
    } finally {
        handle?.stop();
        await sleep(20);
    }
});

test("worker spawn failure degrades to unwatched and never throws (#4762)", () => {
    let failure: unknown;
    const handle = armEventLoopWatchdog({
        spawnWorker: () => { throw new Error("spawn denied"); },
        onSpawnFailure: (err) => { failure = err; },
    });
    assert.equal(handle, undefined);
    assert.ok(failure instanceof Error && /spawn denied/.test(failure.message));
});

/** Pipe-capturing spawn seam: the worker's stdio becomes readable streams
 *  instead of inherited fds, so the test can prove WHICH leg carried a line.
 *  (A blocking pipe cannot be proven — only structurally excluded, which is
 *  exactly what the gate under test is.) */
function armWithCapturedStderr(
    opts: Parameters<typeof armEventLoopWatchdog>[0],
): { handle: ReturnType<typeof armEventLoopWatchdog>, stderrBuf: () => string } {
    let buf = "";
    const handle = armEventLoopWatchdog({
        ...opts,
        spawnWorker: (code, o) => {
            // per-stream pipe flags (the pinned @types model these as
            // booleans; runtime maps them onto the stdio array)
            const w = new Worker(code, { ...o, eval: true, stdout: true, stderr: true });
            w.stderr?.on("data", (d) => { buf += String(d); });
            return w;
        },
    });
    return { handle, stderrBuf: () => buf };
}

async function waitUntil(fn: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await sleep(10);
}

test("forensic lines stay OFF the worker's stderr when a file leg exists and stderr is not a TTY (#4762/#5012)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-watchdog-"));
    const logFile = path.join(dir, "bili.log");
    const { handle, stderrBuf } = armWithCapturedStderr({
        logFile,
        version: "0.0.0-test",
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 60,
        hardTimeoutMs: 150,
        fatalMode: "report",
        stderrTty: false,
    });
    try {
        assert.ok(handle);
        await sleep(50);
        blockMainLoop(400);
        await sleep(80);
        await waitUntil(() => /FATAL/.test(fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : ""), 500);
        const content = fs.readFileSync(logFile, "utf8");
        assert.match(content, /FATAL: main event loop silent/); // file leg carries the record
        await waitUntil(() => stderrBuf().length > 0, 200);
        assert.equal(stderrBuf().trim(), "", "non-TTY stderr is a dead-pipe risk on Windows — never touched (#5012)");
    } finally {
        handle?.stop();
        await sleep(20);
        await rmrf(dir);
    }
});

test("with NO file leg the worker's stderr is the sole forensic record and must carry the FATAL line (#4762)", async () => {
    const { handle, stderrBuf } = armWithCapturedStderr({
        logFile: null,
        version: "0.0.0-test",
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 60,
        hardTimeoutMs: 150,
        fatalMode: "report",
        stderrTty: false,
    });
    try {
        assert.ok(handle);
        await sleep(50);
        blockMainLoop(400);
        await sleep(80);
        await waitUntil(() => /FATAL/.test(stderrBuf()), 500);
        assert.match(stderrBuf(), /FATAL: main event loop silent/);
    } finally {
        handle?.stop();
        await sleep(20);
    }
});
