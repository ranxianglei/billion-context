import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { findPresentUnverifiedSameLaneTwin, type InstanceShape, type RegistryEntry } from "../src/instance.ts";
import { TWIN_ADOPT_EXIT_CODE } from "../src/listen-policy.ts";
import { assertPortDead } from "./port-race.ts";

// #4977: a substitute child whose port is still held by a same-build twin that
// went SILENT (dying or event-loop-wedged — #3654 three-state liveness) must
// exit with the adopt code BEFORE persistence initialization. Pre-fix it fell
// through into engine creation, opened index.db under the zombie (two-writer
// window #3923/#3959), and only exited code 3 after its own listen failed.
// The unit rows pin the judgment truth table; the real-CLI rows pin the
// ordering against actual child processes (same harness shape as the #4341
// early-adopt suite, which owns the verified-healthy complement case).

const ROOT = path.join(import.meta.dirname, "..");
const ENTRY = path.join(ROOT, "src/index.ts");
const BASE = 18842;
const LANE = "dsh";
const OWN_FP = "fp-our-build";

function ownShape(over: Partial<InstanceShape> = {}): InstanceShape {
    return {
        host: "127.0.0.1",
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        modelMaxOutputs: {},
        ...over,
    };
}

function holder(over: Partial<RegistryEntry> = {}): RegistryEntry {
    return {
        instanceId: "holder-4977",
        pid: process.pid,
        port: BASE,
        origin: `http://127.0.0.1:${BASE}`,
        startedAt: Date.now(),
        host: "127.0.0.1",
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        modelMaxOutputs: {},
        lane: LANE,
        codeFingerprint: OWN_FP,
        ...over,
    };
}

function sameShape(own: InstanceShape): (entry: RegistryEntry) => boolean {
    return (entry) =>
        entry.host === own.host &&
        Boolean(entry.passthrough) === own.passthrough &&
        JSON.stringify(entry.mitmDomains ?? []) === JSON.stringify(own.mitmDomains) &&
        JSON.stringify(entry.modelWindows ?? {}) === JSON.stringify(own.modelWindows) &&
        JSON.stringify(entry.modelMaxOutputs ?? {}) === JSON.stringify(own.modelMaxOutputs);
}

function sandboxDirs(sandbox: string): { stateHome: string; dataHome: string; configHome: string; cacheHome: string; sessions: string } {
    return {
        stateHome: path.join(sandbox, "state"),
        dataHome: path.join(sandbox, "data"),
        configHome: path.join(sandbox, "config"),
        cacheHome: path.join(sandbox, "cache"),
        sessions: path.join(sandbox, "data", "sessions"),
    };
}

function makeEnv(sandbox: string): NodeJS.ProcessEnv {
    const dirs = sandboxDirs(sandbox);
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: "test",
        HOME: sandbox,
        XDG_STATE_HOME: dirs.stateHome,
        XDG_DATA_HOME: dirs.dataHome,
        XDG_CONFIG_HOME: dirs.configHome,
        XDG_CACHE_HOME: dirs.cacheHome,
        BILI_SESSIONS_DIR: dirs.sessions,
        BILI_LAUNCH_TOKEN: "issue-4977-test",
        BILI_LAUNCHER_LANE: LANE,
        BILI_PARENT_PID: String(process.pid),
        BILI_STORAGE_UNIFIED: "full",
        BILI_MITM: "0",
        ACP_PASSTHROUGH: "0",
        BILI_LAUNCHER_MODEL_WINDOWS: "{}",
        BILI_LAUNCHER_MODEL_MAX_OUTPUTS: "{}",
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.BILI_ENCRYPTION_KEY;
    return env;
}

async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

async function waitForStatus(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/__bili/status`);
            if (res.status === 200) return true;
        } catch {
            // connection refused while the child is still starting up — expected
        }
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

async function killChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function deadPid(): Promise<number> {
    const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"]);
    const pid = c.pid;
    if (pid === undefined) throw new Error("spawn failed to produce a pid");
    await new Promise<void>((resolve) => c.once("exit", () => resolve()));
    return pid;
}

const SILENT_HEALTH = async (): Promise<{ pid?: number; instanceId?: string } | undefined> => undefined;
const SOCKET_UP = async (): Promise<boolean> => true;
const SOCKET_DOWN = async (): Promise<boolean> => false;

test("present-unverified twin: silent probe over a live socket is the exit case", async () => {
    const entry = holder();
    const peer = await findPresentUnverifiedSameLaneTwin(
        [entry], BASE, LANE, OWN_FP, sameShape(ownShape()), SILENT_HEALTH, SOCKET_UP,
    );
    assert.equal(peer?.instanceId, entry.instanceId);
});

test("present-unverified twin: stale marker over a free port falls through to the bind", async () => {
    let healthCalls = 0;
    const peer = await findPresentUnverifiedSameLaneTwin(
        [holder()], BASE, LANE, OWN_FP, sameShape(ownShape()),
        async () => { healthCalls += 1; return undefined; },
        SOCKET_DOWN,
    );
    assert.equal(peer, undefined, "no live listener means nothing to adjudicate");
    assert.equal(healthCalls, 0, "the socket check runs first and decides — no probe budget spent on a dead port");
});

test("present-unverified twin: answered probes fall through to their own paths", async () => {
    const entry = holder();
    assert.equal(
        await findPresentUnverifiedSameLaneTwin(
            [entry], BASE, LANE, OWN_FP, sameShape(ownShape()),
            async () => ({ pid: entry.pid, instanceId: entry.instanceId }),
            SOCKET_UP,
        ),
        undefined,
        "a matching answer belongs to the verified-adopt path (#4341)",
    );
    assert.equal(
        await findPresentUnverifiedSameLaneTwin(
            [entry], BASE, LANE, OWN_FP, sameShape(ownShape()),
            async () => ({ pid: entry.pid + 1, instanceId: entry.instanceId }),
            SOCKET_UP,
        ),
        undefined,
        "a mismatched answer must not be refused here (#4341)",
    );
});

test("present-unverified twin: drifted shape, foreign fingerprint, dead pid, wrong port/lane never classify", async () => {
    const dead = await deadPid();
    const rows: Array<[string, RegistryEntry]> = [
        ["drifted shape", holder({ modelWindows: { "model-a": 1000 } })],
        ["foreign fingerprint", holder({ codeFingerprint: "fp-other-build" })],
        ["dead pid", holder({ pid: dead })],
        ["wrong port", holder({ port: BASE + 1, origin: `http://127.0.0.1:${BASE + 1}` })],
        ["wrong lane", holder({ lane: "pi" })],
        ["missing lane", holder({ lane: undefined })],
        ["missing fingerprint", holder({ codeFingerprint: undefined })],
    ];
    for (const [label, entry] of rows) {
        assert.equal(
            await findPresentUnverifiedSameLaneTwin(
                [entry], BASE, LANE, OWN_FP, sameShape(ownShape()), SILENT_HEALTH, SOCKET_UP,
            ),
            undefined,
            label,
        );
    }
    assert.equal(
        await findPresentUnverifiedSameLaneTwin(
            [holder()], BASE, undefined, OWN_FP, sameShape(ownShape()), SILENT_HEALTH, SOCKET_UP,
        ),
        undefined,
        "caller without a lane never classifies",
    );
});

test("real CLI: silent twin exits before unified SQLite initialization", { timeout: 60_000 }, async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4977-"));
    const { stateHome, sessions } = sandboxDirs(sandbox);
    const instanceId = "zombie-twin-4977";
    // The zombie's exact #3654 signature: accepts TCP but never answers HTTP —
    // socket alive, health silent (dying or event-loop-wedged).
    const zombie = net.createServer((sock) => { sock.on("error", () => {}); sock.resume(); });
    await new Promise<void>((resolve, reject) => {
        zombie.once("error", reject);
        zombie.listen(0, "127.0.0.1", resolve);
    });
    const port = (zombie.address() as AddressInfo).port;
    const registryDir = path.join(stateHome, "billion-context", "instances");
    fs.mkdirSync(registryDir, { recursive: true });
    const fingerprint = createHash("sha256").update(fs.readFileSync(ENTRY)).digest("hex");
    fs.writeFileSync(
        path.join(registryDir, `${instanceId}.json`),
        JSON.stringify({
            instanceId,
            pid: process.pid,
            port,
            origin: `http://127.0.0.1:${port}`,
            startedAt: Date.now(),
            host: "127.0.0.1",
            passthrough: false,
            mitmDomains: [],
            modelWindows: {},
            modelMaxOutputs: {},
            lane: LANE,
            codeFingerprint: fingerprint,
        }) + "\n",
    );
    const env = makeEnv(sandbox);

    try {
        const child = spawn(process.execPath, ["--import", "tsx", ENTRY, "start", "--host", "127.0.0.1", "--port", String(port)], {
            cwd: ROOT,
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { output += chunk; });
        child.stderr.on("data", (chunk: string) => { output += chunk; });
        const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
        });
        clearTimeout(timer);

        assert.equal(code, TWIN_ADOPT_EXIT_CODE, output);
        assert.match(output, /exiting before persistence initialization/);
        assert.match(output, /still held by a same-build bili instance/);
        assert.equal(fs.existsSync(path.join(sessions, "index.db")), false, "the duplicate must not create/open the unified database under the zombie");
    } finally {
        await new Promise<void>((resolve) => zombie.close(() => resolve()));
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});

test("real CLI: live marker for an unlistened port falls through to normal boot", { timeout: 90_000 }, async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4977-"));
    const { stateHome, sessions } = sandboxDirs(sandbox);
    const port = await freePort();
    const registryDir = path.join(stateHome, "billion-context", "instances");
    fs.mkdirSync(registryDir, { recursive: true });
    const fingerprint = createHash("sha256").update(fs.readFileSync(ENTRY)).digest("hex");
    fs.writeFileSync(
        path.join(registryDir, "ghost-twin-4977.json"),
        JSON.stringify({
            instanceId: "ghost-twin-4977",
            pid: process.pid,
            port,
            origin: `http://127.0.0.1:${port}`,
            startedAt: Date.now(),
            host: "127.0.0.1",
            passthrough: false,
            mitmDomains: [],
            modelWindows: {},
            modelMaxOutputs: {},
            lane: LANE,
            codeFingerprint: fingerprint,
        }) + "\n",
    );
    const env = makeEnv(sandbox);
    await assertPortDead(port, { label: "ghost-twin port" });
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY, "start", "--host", "127.0.0.1", "--port", String(port)], {
        cwd: ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    try {
        const ready = await waitForStatus(port, 60_000);
        assert.equal(ready, true, `child never became ready:\n${output}`);
        assert.doesNotMatch(output, /exiting before persistence initialization/, "an unproven marker must not trigger the early exit");
        const logText = fs.readFileSync(path.join(stateHome, "billion-context", "bili.log"), "utf8");
        assert.match(logText, /\[storage\] unified FULL mode ENABLED/, "normal boot must open the unified store");
        assert.equal(fs.existsSync(path.join(sessions, "index.db")), true);
    } finally {
        await killChild(child);
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});
