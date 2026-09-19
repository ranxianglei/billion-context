import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Logger } from "../src/logger.ts";

const root = mkdtempSync(path.join(tmpdir(), "bc-auto-restart-"));
process.env.XDG_CACHE_HOME = path.join(root, "cache");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_DATA_HOME = path.join(root, "data");
process.env.XDG_STATE_HOME = path.join(root, "state");

// Imported AFTER the XDG env above: MARKER_FILE is frozen at module load.
const { decideAutoRestart, probeHostFor, performSelfRestart, readLastRestart, RESTART_COOLDOWN_MS } = await import("../src/restart.ts");

after(() => {
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_STATE_HOME;
    rmSync(root, { recursive: true, force: true });
});

function makeLog(): { log: Logger; entries: string[] } {
    const entries: string[] = [];
    return { log: (level, msg) => { entries.push(`${level}: ${msg}`); }, entries };
}

/** A fake on-disk install: package.json + one parseable ESM entry. */
function makeInstall(version: string, entrySource = "export const loaded = 'x';\n"): string {
    const dir = mkdtempSync(path.join(root, "install-"));
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }),
    );
    writeFileSync(path.join(dir, "dist", "index.js"), entrySource);
    return dir;
}

function startServer(host = "127.0.0.1"): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
    });
    return new Promise((resolve) => {
        server.listen(0, host, () => {
            const addr = server.address();
            assert.ok(addr && typeof addr === "object");
            resolve({ server, port: addr.port });
        });
    });
}

async function requestOk(port: number): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        return res.status === 200;
    } catch {
        return false;
    }
}

/** Stub replacement: serves real HTTP on argv[2] and stays up until killed.
 *  A bare TCP accept is not enough: the readiness probe passes but every
 *  request gets its socket closed before a response. */
function makeReadyStub(name: string): string {
    const p = path.join(root, name);
    writeFileSync(p, [
        "import http from 'node:http';",
        "const port = Number(process.argv[2]);",
        "if (!Number.isFinite(port)) process.exit(64);",
        "http.createServer((_req, res) => res.end('ok')).listen(port, '127.0.0.1');",
    ].join("\n"));
    return p;
}

function makeCrashStub(name: string): string {
    const p = path.join(root, name);
    writeFileSync(p, "setTimeout(() => process.exit(1), 50);\n");
    return p;
}

type SpawnRecord = { child?: ChildProcess; args?: string[] };

function makeSpawn(stubPath: string, port: number, record: SpawnRecord): (execPath: string, args: string[], options: SpawnOptions) => ChildProcess {
    return (_execPath, args, _options) => {
        record.args = args;
        const child = spawn(process.execPath, [stubPath, String(port)], { stdio: "ignore" });
        record.child = child;
        return child;
    };
}

const baseInput = {
    enabled: true,
    runningVersion: "1.0.0",
    diskVersion: "1.0.1",
    inFlight: 0,
    restarting: false,
    nowMs: 1_000_000,
    lastRestartMs: undefined as number | undefined,
    cooldownMs: RESTART_COOLDOWN_MS,
};

test("decideAutoRestart: pure decision matrix", () => {
    assert.deepEqual(decideAutoRestart(baseInput), { go: true, reason: "ok" });
    assert.deepEqual(decideAutoRestart({ ...baseInput, enabled: false }), { go: false, reason: "disabled" });
    assert.deepEqual(decideAutoRestart({ ...baseInput, restarting: true }), { go: false, reason: "restart-in-progress" });
    assert.deepEqual(decideAutoRestart({ ...baseInput, diskVersion: undefined }), { go: false, reason: "not-stale" });
    assert.deepEqual(decideAutoRestart({ ...baseInput, diskVersion: "1.0.0" }), { go: false, reason: "not-stale" });
    assert.deepEqual(decideAutoRestart({ ...baseInput, diskVersion: "0.9.9" }), { go: false, reason: "not-stale" });
    assert.deepEqual(decideAutoRestart({ ...baseInput, inFlight: 3 }), { go: false, reason: "in-flight:3" });
    assert.deepEqual(
        decideAutoRestart({ ...baseInput, lastRestartMs: baseInput.nowMs - RESTART_COOLDOWN_MS + 1 }),
        { go: false, reason: "cooldown" },
    );
    // Exactly-cooldown-old is allowed (strict <).
    assert.deepEqual(
        decideAutoRestart({ ...baseInput, lastRestartMs: baseInput.nowMs - RESTART_COOLDOWN_MS }),
        { go: true, reason: "ok" },
    );
    // Gate order: disabled wins over everything; stale wins over in-flight.
    assert.deepEqual(decideAutoRestart({ ...baseInput, enabled: false, restarting: true, inFlight: 9 }), { go: false, reason: "disabled" });
    assert.deepEqual(decideAutoRestart({ ...baseInput, diskVersion: "1.0.0", inFlight: 9 }), { go: false, reason: "not-stale" });
});

test("probeHostFor: wildcards map to their loopback counterpart", () => {
    assert.equal(probeHostFor("0.0.0.0"), "127.0.0.1");
    assert.equal(probeHostFor("::"), "::1");
    assert.equal(probeHostFor("127.0.0.1"), "127.0.0.1");
    assert.equal(probeHostFor("192.168.1.5"), "192.168.1.5");
});

test("performSelfRestart: broken install fails sanity check, service untouched", { timeout: 30_000 }, async () => {
    const { server, port } = await startServer();
    const { log, entries } = makeLog();
    const record: SpawnRecord = {};
    try {
        const result = await performSelfRestart({
            server, host: "127.0.0.1", port,
            installDir: makeInstall("1.0.1", "this is not parseable js !!!"),
            runningVersion: "1.0.0", diskVersion: "1.0.1",
            log, spawnImpl: makeSpawn(makeReadyStub("stub-ok.mjs"), port, record),
            settleMs: 500, readyTimeoutMs: 2000,
            finish: () => assert.fail("must not finish before sanity check passes"),
        });
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /install verification failed/);
        assert.equal(record.child, undefined, "no replacement may be spawned");
        assert.equal(await readLastRestart(), undefined, "no cooldown marker before the point of no return");
        assert.equal(await requestOk(port), true, "original listener must still serve");
        assert.match(entries.join("\n"), /aborted.*install verification failed/s);
    } finally {
        record.child?.kill();
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
    }
});

test("performSelfRestart: in-flight requests block, then service resumes", { timeout: 30_000 }, async () => {
    const { server, port } = await startServer();
    const { log } = makeLog();
    const record: SpawnRecord = {};
    try {
        const result = await performSelfRestart({
            server, host: "127.0.0.1", port,
            installDir: makeInstall("1.0.1"),
            runningVersion: "1.0.0", diskVersion: "1.0.1",
            log, inFlightProvider: () => 1,
            spawnImpl: makeSpawn(makeReadyStub("stub-inflight.mjs"), port, record),
            settleMs: 400, readyTimeoutMs: 2000,
            finish: () => assert.fail("must not finish while requests are in flight"),
        });
        assert.equal(result.ok, false);
        assert.equal(result.error, "in-flight-remained");
        assert.equal(record.child, undefined, "no replacement may be spawned");
        assert.equal(await readLastRestart(), undefined, "aborted attempts must not burn the cooldown");
        assert.equal(server.listening, true, "listener must be resumed after abort");
        assert.equal(await requestOk(port), true, "resumed listener must serve");
    } finally {
        record.child?.kill();
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
    }
});

test("performSelfRestart: crashing replacement aborts, service resumes", { timeout: 30_000 }, async () => {
    const { server, port } = await startServer();
    const { log, entries } = makeLog();
    const record: SpawnRecord = {};
    try {
        const result = await performSelfRestart({
            server, host: "127.0.0.1", port,
            installDir: makeInstall("1.0.1"),
            runningVersion: "1.0.0", diskVersion: "1.0.1",
            log, inFlightProvider: () => 0,
            spawnImpl: makeSpawn(makeCrashStub("stub-crash.mjs"), port, record),
            settleMs: 500, readyTimeoutMs: 3000,
            finish: () => assert.fail("must not finish when the replacement crashed"),
        });
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /exited code 1/);
        assert.ok(record.child, "replacement must have been spawned");
        assert.ok(await readLastRestart(), "point-of-no-return marker written even though spawn failed");
        assert.equal(server.listening, true, "listener must be resumed after abort");
        assert.equal(await requestOk(port), true, "resumed listener must serve");
        assert.match(entries.join("\n"), /did not become ready.*exited code 1/s);
    } finally {
        record.child?.kill();
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
    }
});

test("performSelfRestart: handover succeeds at zero in-flight", { timeout: 30_000 }, async () => {
    const { server, port } = await startServer();
    const { log, entries } = makeLog();
    const record: SpawnRecord = {};
    let finished = 0;
    try {
        const result = await performSelfRestart({
            server, host: "127.0.0.1", port,
            installDir: makeInstall("1.0.1"),
            runningVersion: "1.0.0", diskVersion: "1.0.1",
            log, inFlightProvider: () => 0,
            spawnImpl: makeSpawn(makeReadyStub("stub-happy.mjs"), port, record),
            settleMs: 500, readyTimeoutMs: 5000,
            finish: () => { finished++; },
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.ok(record.child?.pid, "replacement pid reported");
        assert.ok(record.args && record.args.length >= 1, "spawn called with an entry script");
        assert.equal(finished, 1, "finish seam called exactly once");
        assert.equal(server.listening, false, "original listener stopped");
        assert.equal(await requestOk(port), true, "replacement now owns the port");
        assert.ok(await readLastRestart());
        assert.match(entries.join("\n"), /handing over v1\.0\.0 -> v1\.0\.1/s);
    } finally {
        record.child?.kill();
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
    }
});

test("readLastRestart: tolerant of missing/corrupt markers", async () => {
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    const markerDir = path.join(process.env.XDG_CACHE_HOME ?? "", "billion-context");
    await mkdir(markerDir, { recursive: true });
    // Earlier orchestration tests may have written a marker; start clean.
    await rm(path.join(markerDir, ".auto-restart"), { force: true });
    assert.equal(await readLastRestart(), undefined);
    await writeFile(path.join(markerDir, ".auto-restart"), "{not json");
    assert.equal(await readLastRestart(), undefined);
    await writeFile(path.join(markerDir, ".auto-restart"), JSON.stringify({ ts: 12345, from: "1.0.0", to: "1.0.1" }));
    assert.equal(await readLastRestart(), 12345);
});
