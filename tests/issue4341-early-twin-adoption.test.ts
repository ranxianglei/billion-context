import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { findVerifiedSameLaneTwin, type InstanceShape, type RegistryEntry } from "../src/instance.ts";
import { assertPortDead } from "./port-race.ts";

const ROOT = path.join(import.meta.dirname, "..");
const ENTRY = path.join(ROOT, "src/index.ts");
const BASE = 18841;
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
        instanceId: "holder-4341",
        pid: process.pid,
        port: BASE,
        origin: `http://127.0.0.1:${BASE}`,
        startedAt: Date.now(),
        host: "127.0.0.1",
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        modelMaxOutputs: {},
        lane: "pi",
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
        BILI_LAUNCH_TOKEN: "issue-4341-test",
        BILI_LAUNCHER_LANE: "pi",
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

test("verified twin: matching health identity permits the early adopt", async () => {
    const entry = holder();
    const peer = await findVerifiedSameLaneTwin([entry], BASE, "pi", OWN_FP, sameShape(ownShape()), async (origin) => {
        assert.equal(origin, entry.origin);
        return { pid: entry.pid, instanceId: entry.instanceId };
    });
    assert.equal(peer?.instanceId, entry.instanceId);
});

test("verified twin: stale matching marker cannot hide a later verified twin", async () => {
    const stale = holder({ instanceId: "stale-4341" });
    const live = holder({ instanceId: "live-4341" });
    const peer = await findVerifiedSameLaneTwin([stale, live], BASE, "pi", OWN_FP, sameShape(ownShape()), async () => ({
        pid: live.pid,
        instanceId: live.instanceId,
    }));
    assert.equal(peer?.instanceId, live.instanceId);
});

test("verified twin: stale marker or foreign listener cannot trigger the early adopt", async () => {
    const entry = holder();
    assert.equal(
        await findVerifiedSameLaneTwin([entry], BASE, "pi", OWN_FP, sameShape(ownShape()), async () => ({ pid: entry.pid + 1, instanceId: entry.instanceId })),
        undefined,
        "pid mismatch",
    );
    assert.equal(
        await findVerifiedSameLaneTwin([entry], BASE, "pi", OWN_FP, sameShape(ownShape()), async () => ({ pid: entry.pid, instanceId: "replacement" })),
        undefined,
        "instance mismatch",
    );
    assert.equal(
        await findVerifiedSameLaneTwin([entry], BASE, "pi", OWN_FP, sameShape(ownShape()), async () => undefined),
        undefined,
        "no health proof",
    );
});

test("verified twin: config drift preserves the existing bind/EADDRINUSE path", async () => {
    let healthCalls = 0;
    const peer = await findVerifiedSameLaneTwin(
        [holder({ modelWindows: { "model-a": 1000 } })],
        BASE,
        "pi",
        OWN_FP,
        sameShape(ownShape()),
        async () => {
            healthCalls += 1;
            return { pid: process.pid, instanceId: "holder-4341" };
        },
    );
    assert.equal(peer, undefined);
    assert.equal(healthCalls, 0, "a drifted peer is not an adopt candidate and must not be health-probed");
});

test("real CLI: verified twin exits before unified SQLite initialization", { timeout: 30_000 }, async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4341-"));
    const { stateHome, sessions } = sandboxDirs(sandbox);
    const instanceId = "live-twin-4341";
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, pid: process.pid, instanceId }));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
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
            lane: "pi",
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
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
        });
        clearTimeout(timer);

        assert.equal(code, 3, output);
        assert.match(output, /exiting before persistence initialization/);
        assert.equal(fs.existsSync(path.join(sessions, "index.db")), false, "the duplicate must not create/open the unified database");
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});

test("real CLI: live marker for an unlistened port falls through to normal boot", { timeout: 90_000 }, async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4341-"));
    const { stateHome, sessions } = sandboxDirs(sandbox);
    const port = await freePort();
    const registryDir = path.join(stateHome, "billion-context", "instances");
    fs.mkdirSync(registryDir, { recursive: true });
    const fingerprint = createHash("sha256").update(fs.readFileSync(ENTRY)).digest("hex");
    fs.writeFileSync(
        path.join(registryDir, "ghost-twin-4341.json"),
        JSON.stringify({
            instanceId: "ghost-twin-4341",
            pid: process.pid,
            port,
            origin: `http://127.0.0.1:${port}`,
            startedAt: Date.now(),
            host: "127.0.0.1",
            passthrough: false,
            mitmDomains: [],
            modelWindows: {},
            modelMaxOutputs: {},
            lane: "pi",
            codeFingerprint: fingerprint,
        }) + "\n",
    );
    const env = makeEnv(sandbox);
    await assertPortDead(port, { label: "dead-twin port" });
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
        assert.doesNotMatch(output, /exiting before persistence initialization/, "an unproven marker must not trigger the early adopt");
        const logText = fs.readFileSync(path.join(stateHome, "billion-context", "bili.log"), "utf8");
        assert.match(logText, /\[storage\] unified FULL mode ENABLED/, "normal boot must open the unified store");
        assert.equal(fs.existsSync(path.join(sessions, "index.db")), true);
    } finally {
        await killChild(child);
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});

test("real CLI: duplicate-start burst keeps the serving process in unified mode", { timeout: 180_000 }, async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4341-"));
    const { stateHome } = sandboxDirs(sandbox);
    const port = await freePort();
    const env = makeEnv(sandbox);
    await assertPortDead(port, { label: "burst serving port" });
    const args = ["--import", "tsx", ENTRY, "start", "--host", "127.0.0.1", "--port", String(port)];
    const serving = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let servingOut = "";
    serving.stdout.setEncoding("utf8");
    serving.stderr.setEncoding("utf8");
    serving.stdout.on("data", (chunk: string) => { servingOut += chunk; });
    serving.stderr.on("data", (chunk: string) => { servingOut += chunk; });
    if (!(await waitForStatus(port, 90_000))) throw new Error(`serving child never became ready:\n${servingOut}`);
    try {
        const dups = Array.from({ length: 4 }, () => {
            const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
            const sink = { out: "" };
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => { sink.out += chunk; });
            child.stderr.on("data", (chunk: string) => { sink.out += chunk; });
            const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
            return { child, timer, sink };
        });
        const codes = await Promise.all(dups.map((dup) => new Promise<number | null>((resolve) => dup.child.once("exit", resolve))));
        dups.forEach((dup, i) => {
            clearTimeout(dup.timer);
            assert.equal(codes[i], 3, `duplicate ${i} must exit with the adopt code:\n${dup.sink.out}`);
            assert.match(dup.sink.out, /exiting before persistence initialization/);
        });
        const res = await fetch(`http://127.0.0.1:${port}/__bili/status`);
        assert.equal(res.status, 200, "the serving process must still be serving after the burst");
        const logText = fs.readFileSync(path.join(stateHome, "billion-context", "bili.log"), "utf8");
        const adopts = logText.split("\n").filter((line) => line.includes("exiting before persistence initialization")).length;
        assert.ok(adopts >= 4, `expected 4 durably flushed adopt lines, saw ${adopts}\n${logText}`);
        const enabled = logText.match(/\[storage\] unified FULL mode ENABLED/g) ?? [];
        assert.equal(enabled.length, 1, `only the serving process may open the unified store:\n${logText}`);
        assert.doesNotMatch(logText, /disabled after \d+ consecutive failures/, "the latch from the issue must not fire under a burst");
        assert.doesNotMatch(logText, /database is locked/i);
    } finally {
        await killChild(serving);
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});
