import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ProxyInstanceFile } from "../src/instance.ts";
import {
    allocateDynamicPort,
    ensureProxyRunning,
    runDaemon,
    spawnDaemonProxy,
    type LauncherDeps,
    type SpawnChild,
    type SpawnFn,
} from "../src/launcher.ts";

function rec(over: Partial<ProxyInstanceFile> = {}): ProxyInstanceFile {
    return {
        origin: "http://127.0.0.1:8787",
        instanceId: "inst-1",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 8787,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        ...over,
    };
}

function fakeChild(pid = 4242): SpawnChild {
    return { pid, unref() {}, kill() {} };
}

const BASE_OPTS = { host: "127.0.0.1", port: 9911, passthrough: false, debug: false };

interface Sink {
    env?: NodeJS.ProcessEnv;
    args?: readonly string[];
}

// Fake child that performs the launch-token handshake against the per-session
// result file exactly like a real proxy does (env BILI_RESULT_FILE, record
// carrying the token and the REAL bound port).
function handshakeSpawn(sink: Sink): SpawnFn {
    return (_cmd, args, options) => {
        sink.env = options.env;
        sink.args = args;
        const target = options.env?.BILI_RESULT_FILE;
        const port = Number(args[args.indexOf("--port") + 1]);
        setImmediate(() => {
            if (!target) return;
            fs.writeFileSync(target, JSON.stringify(rec({ origin: `http://127.0.0.1:${port}`, port, launchToken: options.env?.BILI_LAUNCH_TOKEN ?? "" })));
        });
        return fakeChild();
    };
}

function handshakeDeps(sink: Sink, over: Partial<LauncherDeps> = {}): LauncherDeps {
    return {
        fetchImpl: async (url) => ({ ok: url.includes("/__bili/health") && !url.startsWith("http://127.0.0.1:8787") }),
        fetchHealthInfo: async () => ({ ok: true }),
        // Live, compatible GLOBAL instance: if the fresh path ever polled this
        // instead of the result file, the token would mismatch and the wait
        // would time out instead of completing.
        readInstanceFile: () => rec(),
        spawnImpl: handshakeSpawn(sink),
        ...over,
    };
}

function tmpResultFile(): string {
    return path.join(os.tmpdir(), `bili-daemon-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

function daemonTmpFiles(): string[] {
    return fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("bili-daemon-"));
}

interface EnvSave {
    ACP_PORT?: string;
    ACP_HOST?: string;
    BILI_PARENT_PID?: string;
}

function saveDaemonEnv(): EnvSave {
    return { ACP_PORT: process.env.ACP_PORT, ACP_HOST: process.env.ACP_HOST, BILI_PARENT_PID: process.env.BILI_PARENT_PID };
}

function clearDaemonEnv(): void {
    delete process.env.ACP_PORT;
    delete process.env.ACP_HOST;
    delete process.env.BILI_PARENT_PID;
}

function restoreDaemonEnv(saved: EnvSave): void {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
}

// Tee, not blind patch: node:test emits its TAP protocol through
// process.stdout.write, so captured writes must still reach the original.
function captureStdout(): { stop: () => void; text: () => string } {
    let out = "";
    const orig = process.stdout.write;
    const tee = ((...args: Parameters<typeof process.stdout.write>) => {
        const chunk = args[0];
        // Record STRING chunks only: the runner's own IPC travels here as
        // binary frames and must stay out of the capture.
        if (typeof chunk === "string") out += chunk;
        return Reflect.apply(orig, process.stdout, args);
    }) as typeof process.stdout.write;
    process.stdout.write = tee;
    return {
        stop() {
            process.stdout.write = orig;
        },
        text: () => out,
    };
}

test("ensureProxyRunning: fresh skips attach even when a compatible healthy instance exists", async () => {
    const sink: Sink = {};
    const deps = handshakeDeps(sink);

    const attached = await ensureProxyRunning({ ...BASE_OPTS }, deps);
    assert.equal(attached.attached, true);
    assert.equal(attached.origin, "http://127.0.0.1:8787");
    assert.equal(sink.args, undefined);

    const resultFile = tmpResultFile();
    try {
        const fresh = await ensureProxyRunning({ ...BASE_OPTS, fresh: true, resultFile }, deps);
        assert.equal(fresh.attached, undefined);
        assert.equal(fresh.origin, `http://127.0.0.1:${BASE_OPTS.port}`);
        assert.equal(fresh.child?.pid, 4242);
        assert.deepEqual(sink.args?.slice(1, 6), ["start", "--host", "127.0.0.1", "--port", "9911"]);
        assert.equal(sink.env?.BILI_RESULT_FILE, resultFile);
        assert.ok(typeof sink.env?.BILI_LAUNCH_TOKEN === "string" && sink.env.BILI_LAUNCH_TOKEN.length > 0);
        assert.equal(sink.env?.BILI_PARENT_PID, String(process.pid));
    } finally {
        fs.unlinkSync(resultFile);
    }
});

test("ensureProxyRunning: parentPid 31337 is forwarded, null omits the watcher env", async () => {
    const sinkA: Sink = {};
    const resultA = tmpResultFile();
    try {
        await ensureProxyRunning({ ...BASE_OPTS, fresh: true, resultFile: resultA, parentPid: 31337 }, handshakeDeps(sinkA));
        assert.equal(sinkA.env?.BILI_PARENT_PID, "31337");
    } finally {
        fs.unlinkSync(resultA);
    }

    const sinkB: Sink = {};
    const resultB = tmpResultFile();
    try {
        await ensureProxyRunning({ ...BASE_OPTS, fresh: true, resultFile: resultB, parentPid: null }, handshakeDeps(sinkB));
        assert.equal(sinkB.env?.BILI_PARENT_PID, undefined);
    } finally {
        fs.unlinkSync(resultB);
    }
});

test("ensureProxyRunning: fresh + resultFile times out when the child never hands back", async () => {
    const sink: Sink = {};
    let t = 0;
    const deps = handshakeDeps(sink, {
        spawnImpl: (() => fakeChild()) as SpawnFn,
        fetchImpl: async () => ({ ok: false }),
        now: () => t,
        sleep: async () => {
            t += 20001;
        },
    });
    await assert.rejects(
        ensureProxyRunning({ ...BASE_OPTS, fresh: true, resultFile: tmpResultFile() }, deps),
        /did not become healthy within 20000ms/,
    );
});

test("allocateDynamicPort returns a currently-bindable ephemeral port", async () => {
    const p = await allocateDynamicPort("127.0.0.1");
    assert.ok(p > 1024 && p <= 65535, `unexpected port ${p}`);
    await new Promise<void>((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(p, "127.0.0.1", () => srv.close(() => resolve()));
    });
});

test("spawnDaemonProxy allocates a dynamic port and reports the child pid", async () => {
    const sink: Sink = {};
    const resultFile = tmpResultFile();
    try {
        const res = await spawnDaemonProxy({ host: "127.0.0.1", passthrough: false, debug: false, resultFile }, handshakeDeps(sink));
        assert.equal(res.pid, 4242);
        assert.ok(res.port > 1024 && res.port <= 65535, `unexpected port ${res.port}`);
        assert.equal(res.origin, `http://127.0.0.1:${res.port}`);
        assert.ok(res.logPath?.endsWith(".log"));
        assert.equal(sink.env?.BILI_RESULT_FILE, resultFile);
    } finally {
        fs.unlinkSync(resultFile);
    }
});

test("runDaemon prints single-line JSON, exits 0, cleans up its result file", async () => {
    const saved = saveDaemonEnv();
    clearDaemonEnv();
    const prevExitCode = process.exitCode;
    const cap = captureStdout();
    const countBefore = daemonTmpFiles().length;
    const sink: Sink = {};
    try {
        await runDaemon({ overrides: {}, parentPid: 777 }, handshakeDeps(sink));
        assert.equal(process.exitCode, 0);
        const lines = cap.text().split("\n").filter((l) => l.startsWith("{"));
        assert.equal(lines.length, 1, `expected one JSON line, got: ${cap.text()}`);
        const parsed = JSON.parse(lines[0]) as { origin: string; port: number; pid: number; logPath?: string };
        assert.equal(parsed.pid, 4242);
        assert.ok(parsed.port > 0);
        assert.equal(parsed.origin, `http://127.0.0.1:${parsed.port}`);
        assert.ok(parsed.logPath?.endsWith(".log"));
        assert.equal(sink.env?.BILI_PARENT_PID, "777");
        assert.equal(daemonTmpFiles().length, countBefore, "result file must be unlinked after success");
    } finally {
        cap.stop();
        process.exitCode = prevExitCode;
        restoreDaemonEnv(saved);
    }
});

test("runDaemon exits 1 with stderr diagnostics and no stdout on failure", async () => {
    const saved = saveDaemonEnv();
    clearDaemonEnv();
    const prevExitCode = process.exitCode;
    const cap = captureStdout();
    const prevErr = console.error;
    let errOut = "";
    console.error = ((...args: unknown[]) => {
        errOut += args.map(String).join(" ") + "\n";
    }) as typeof console.error;
    const countBefore = daemonTmpFiles().length;
    let t = 0;
    const deps: LauncherDeps = {
        fetchImpl: async () => ({ ok: false }),
        spawnImpl: (() => fakeChild()) as SpawnFn,
        now: () => t,
        sleep: async () => {
            t += 20001;
        },
    };
    try {
        await runDaemon({ overrides: {}, parentPid: 777 }, deps);
        assert.equal(process.exitCode, 1);
        assert.ok(!cap.text().split("\n").some((l) => l.startsWith("{")), `no JSON result line on failure: ${cap.text()}`);
        assert.match(errOut, /bili daemon:/);
        assert.match(errOut, /did not become healthy/);
        assert.equal(daemonTmpFiles().length, countBefore, "result file must be unlinked after failure");
    } finally {
        cap.stop();
        console.error = prevErr;
        process.exitCode = prevExitCode;
        restoreDaemonEnv(saved);
    }
});

test("runDaemon honors inherited BILI_PARENT_PID and warns when no host pid exists", async () => {
    const saved = saveDaemonEnv();
    clearDaemonEnv();
    process.env.BILI_PARENT_PID = "555";
    const prevExitCode = process.exitCode;
    const cap = captureStdout();
    const prevErr = console.error;
    let errOut = "";
    console.error = ((...args: unknown[]) => {
        errOut += args.map(String).join(" ") + "\n";
    }) as typeof console.error;
    try {
        const sinkA: Sink = {};
        await runDaemon({ overrides: {} }, handshakeDeps(sinkA));
        assert.equal(sinkA.env?.BILI_PARENT_PID, "555");
        assert.equal(errOut, "");

        delete process.env.BILI_PARENT_PID;
        const sinkB: Sink = {};
        await runDaemon({ overrides: {} }, handshakeDeps(sinkB));
        assert.equal(sinkB.env?.BILI_PARENT_PID, undefined);
        assert.match(errOut, /no --parent-pid given/);
        assert.equal(process.exitCode, 0);
    } finally {
        cap.stop();
        console.error = prevErr;
        process.exitCode = prevExitCode;
        restoreDaemonEnv(saved);
    }
});
