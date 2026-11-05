import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Logger } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";
import { defaultConfig } from "acp-kernel";
import { startServer as startBiliServer, restartForceCloseOf } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { isPidAlive } from "../src/instance.ts";
import { UPGRADE_REPLACEMENT_ENV } from "../src/listen-policy.ts";

const root = mkdtempSync(path.join(tmpdir(), "bc-auto-restart-"));
process.env.XDG_CACHE_HOME = path.join(root, "cache");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_DATA_HOME = path.join(root, "data");
process.env.XDG_STATE_HOME = path.join(root, "state");

// Imported AFTER the XDG env above: MARKER_FILE is frozen at module load.
const { decideAutoRestart, probeHostFor, performSelfRestart, readLastRestart, selfRestartSpawnOptions, RESTART_COOLDOWN_MS } = await import("../src/restart.ts");

after(() => {
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_STATE_HOME;
    rmrf(root);
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

async function healthOk(port: number): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/__bili/health`);
        return res.status === 200;
    } catch {
        return false;
    }
}

/** Real bili proxy with MITM enabled and an EMPTY whitelist: every CONNECT
 *  target becomes a blind TCP tunnel — the production shape behind #2895. */
async function startBiliProxy(): Promise<{ server: http.Server; port: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: true, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    const server = await startBiliServer(opts);
    await once(server, "listening");
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    return { server, port: addr.port };
}

/** Loopback TCP server that accepts and HOLDS connections — a tunnel peer. */
async function startHoldingServer(): Promise<{ port: number; close: () => Promise<void> }> {
    const held: net.Socket[] = [];
    const server = net.createServer((sock) => {
        sock.on("error", () => {});
        held.push(sock);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const port = addr.port;
    const close = async () => {
        for (const s of held) s.destroy();
        await new Promise<void>((r) => server.close(() => r()));
    };
    return { port, close };
}

/** Raw client: opens a CONNECT tunnel through the proxy toward the holding
 *  server and resolves once "200 Connection Established" arrives. */
function openConnectTunnel(proxyPort: number, targetPort: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const sock = net.connect(proxyPort, "127.0.0.1", () => {
            sock.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
        });
        const timer = setTimeout(() => {
            sock.destroy();
            reject(new Error("CONNECT timed out"));
        }, 5000);
        sock.once("data", (buf) => {
            clearTimeout(timer);
            const statusLine = buf.toString("latin1").split("\r\n")[0] ?? "";
            if (/^HTTP\/1\.1 200/.test(statusLine)) resolve(sock);
            else reject(new Error(`unexpected CONNECT response: ${statusLine}`));
        });
        sock.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

async function clearRestartMarker(): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(path.join(process.env.XDG_CACHE_HOME ?? "", "billion-context", ".auto-restart"), { force: true });
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
        // #3182: a stolen port must be distinguishable from a product
        // failure — exit 91 lets the retry wrapper below re-run the scenario.
        // EACCES/EPERM = the OS refused the bind outright (Windows dynamic
        // exclusion ranges on shared runners) — same "port unusable" class,
        // not a product failure.
        "const srv = http.createServer((_req, res) => res.end('ok'));",
        "srv.on('error', (e) => process.exit(e && ['EADDRINUSE', 'EACCES', 'EPERM'].includes(e.code) ? 91 : 1));",
        "srv.listen(port, '127.0.0.1');",
    ].join("\n"));
    return p;
}

function makeCrashStub(name: string): string {
    const p = path.join(root, name);
    writeFileSync(p, "setTimeout(() => process.exit(1), 50);\n");
    return p;
}

type SpawnRecord = { child?: ChildProcess; args?: string[]; options?: SpawnOptions };

function makeSpawn(stubPath: string, port: number, record: SpawnRecord): (execPath: string, args: string[], options: SpawnOptions) => ChildProcess {
    return (_execPath, args, options) => {
        record.args = args;
        record.options = options;
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

// #2095: the replacement died on Windows because it was spawned non-detached —
// a console-attached parent's exit tears down libuv's kill-on-job-close job
// object and takes the child with it mid-boot. Pin the platform split so a
// future "simplification" back to a single non-detached spawn is caught.
test("selfRestartSpawnOptions: win32 detaches+hide+ignore-stdio; posix inherits (#2095)", () => {
    const win = selfRestartSpawnOptions("win32");
    assert.equal(win.detached, true, "win32 must detach so the replacement outlives the parent's exit");
    assert.equal(win.windowsHide, true, "win32 must hide the console (#1887 pattern)");
    assert.equal(win.stdio, "ignore", "win32 stdio ignored — the durable log file is independent of stderr");
    assert.ok(win.env, "env must be inherited on win32 (BILI_PARENT_PID / BILI_LAUNCH_TOKEN)");

    for (const p of ["linux", "darwin"] as NodeJS.Platform[]) {
        const posix = selfRestartSpawnOptions(p);
        assert.equal(posix.detached, undefined, `${p} must stay NON-detached so stopProxy() group kill reaches it (#414)`);
        assert.equal(posix.windowsHide, undefined, `${p} keeps no console-hide flag in this path`);
        assert.equal(posix.stdio, "inherit", `${p} keeps inherited stdio so it logs wherever the parent does`);
        assert.ok(posix.env, `${p} env must be inherited`);
    }
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

// #2895: CONNECT tunnels leave HTTP-parser tracking (claimed by the 'connect'
// handler) yet still count against the net.Server connection count, so
// closeAllConnections() alone can never fire the close callback while a tunnel
// is held open — under HTTPS_PROXY/MITM setups (long-lived telemetry pools,
// keep-alive clients) the forced-close grace always expired and every
// auto-restart aborted with "connections stuck". The first test below pins the
// failure WITHOUT the hook; the second proves the wired hook fixes it.
test("performSelfRestart: held CONNECT tunnel blocks closeAllConnections (#2895 repro)", { timeout: 30_000 }, async () => {
    const holding = await startHoldingServer();
    const { server, port } = await startBiliProxy();
    const { log, entries } = makeLog();
    const record: SpawnRecord = {};
    await clearRestartMarker();
    const tunnel = await openConnectTunnel(port, holding.port);
    try {
        const result = await performSelfRestart({
            server, host: "127.0.0.1", port,
            installDir: makeInstall("1.0.1"),
            runningVersion: "1.0.0", diskVersion: "1.0.1",
            log, inFlightProvider: () => 0,
            spawnImpl: makeSpawn(makeReadyStub("stub-stuck.mjs"), port, record),
            settleMs: 500, readyTimeoutMs: 5000,
            finish: () => assert.fail("must not finish while a tunnel holds the listener"),
        });
        assert.equal(result.ok, false, JSON.stringify(result));
        assert.equal(result.error, "connections-stuck");
        assert.equal(record.child, undefined, "no replacement may be spawned");
        assert.equal(await readLastRestart(), undefined, "aborted attempts must not burn the cooldown");
        assert.equal(server.listening, true, "listener must be resumed after abort");
        assert.equal(await healthOk(port), true, "resumed listener must serve");
        assert.match(entries.join("\n"), /connections stuck after forced close/s);
    } finally {
        record.child?.kill();
        tunnel.destroy();
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
        await holding.close();
    }
});

test("performSelfRestart: lingering-socket hook force-closes tunnels and hands over (#2895 fix)", { timeout: 30_000 }, async () => {
    const holding = await startHoldingServer();
    const { server, port } = await startBiliProxy();
    const { log, entries } = makeLog();
    const record: SpawnRecord = {};
    let finished = 0;
    await clearRestartMarker();
    assert.equal(typeof restartForceCloseOf(server), "function", "bili server must expose the force-close hook");
    const tunnel = await openConnectTunnel(port, holding.port);
    let tunnelClosed = false;
    tunnel.once("close", () => { tunnelClosed = true; });
    try {
        const result = await performSelfRestart({
            server, host: "127.0.0.1", port,
            installDir: makeInstall("1.0.1"),
            runningVersion: "1.0.0", diskVersion: "1.0.1",
            log, inFlightProvider: () => 0,
            destroyLingeringSockets: restartForceCloseOf(server),
            spawnImpl: makeSpawn(makeReadyStub("stub-tunnel.mjs"), port, record),
            settleMs: 500, readyTimeoutMs: 5000,
            finish: () => { finished++; },
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.ok(record.child?.pid, "replacement pid reported");
        assert.equal(finished, 1, "finish seam called exactly once");
        assert.equal(server.listening, false, "original listener stopped");
        assert.equal(tunnelClosed, true, "held-open CONNECT tunnel must have been destroyed");
        assert.match(entries.join("\n"), /force-closed \d+ lingering socket\(s\)/);
        assert.ok(await readLastRestart(), "point-of-no-return marker written");
        assert.equal(await healthOk(port), true, "replacement now owns the port");
    } finally {
        record.child?.kill();
        tunnel.destroy();
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
        await holding.close();
    }
});

// #2095 wiring guard: the options-matrix test above pins selfRestartSpawnOptions
// in isolation; this proves performSelfRestart actually hands THAT output (for
// the requested platform) to spawn — so a regression that hardcodes one set of
// options or ignores deps.platform is caught, not just a broken helper.
test("performSelfRestart: hands the platform-specific spawn options through to spawn (#2095)", { timeout: 30_000 }, async () => {
    for (const platform of ["win32", "linux"] as NodeJS.Platform[]) {
        const { server, port } = await startServer();
        const { log } = makeLog();
        const record: SpawnRecord = {};
        try {
            const result = await performSelfRestart({
                server, host: "127.0.0.1", port,
                installDir: makeInstall("1.0.1"),
                runningVersion: "1.0.0", diskVersion: "1.0.1",
                log, inFlightProvider: () => 0,
                platform,
                spawnImpl: makeSpawn(makeReadyStub(`stub-opts-${platform}.mjs`), port, record),
                settleMs: 500, readyTimeoutMs: 5000,
                finish: () => {},
            });
            assert.equal(result.ok, true, JSON.stringify(result));
            const baseOpts = selfRestartSpawnOptions(platform);
            assert.deepEqual(
                record.options,
                {
                    ...baseOpts,
                    // #3044: the replacement is marked so it cannot inherit the
                    // launcher's +1 ladder rights (bind-or-die on the freed port).
                    env: { ...(baseOpts.env as NodeJS.ProcessEnv), [UPGRADE_REPLACEMENT_ENV]: "1" },
                },
                `${platform}: spawn must be called with the platform-specific options plus the #3044 replacement marker`,
            );
        } finally {
            record.child?.kill();
            server.closeAllConnections?.();
            await new Promise<void>((r) => server.close(() => r()));
        }
    }
});

test("performSelfRestart: durable state flush runs before the replacement spawns (#1724)", { timeout: 30_000 }, async () => {
    const { server, port } = await startServer();
    const { log } = makeLog();
    const record: SpawnRecord = {};
    const events: string[] = [];
    let finished = 0;
    const innerSpawn = makeSpawn(makeReadyStub("stub-order.mjs"), port, record);
    try {
        const result = await performSelfRestart({
            server, host: "127.0.0.1", port,
            installDir: makeInstall("1.0.1"),
            runningVersion: "1.0.0", diskVersion: "1.0.1",
            log, inFlightProvider: () => 0,
            preSpawnFlush: () => { events.push("pre-flush"); },
            spawnImpl: (execPath, args, options) => { events.push("spawn"); return innerSpawn(execPath, args, options); },
            settleMs: 500, readyTimeoutMs: 5000,
            finish: () => { finished++; },
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        // Before #1724 the only flush happened in `finish`, AFTER the child had
        // already booted and hydrated a stale snapshot. The durable-state flush
        // must now strictly precede the spawn.
        assert.deepEqual(events, ["pre-flush", "spawn"], "durable state must be flushed before the replacement is spawned (#1724)");
        assert.equal(finished, 1, "finish seam called exactly once");
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

// ---------------------------------------------------------------------------
// #3044: occupied target port must never strand an orphan replacement. The
// old shape: a replacement that hit EADDRINUSE on the freed port silently
// hopped +1 and idled serving no client while the prior instance kept the
// real port — accumulating one zombie per upgrade cycle. Pinned here at the
// parent side (readiness verification + terminal decision); the child side
// (bind-or-die) is pinned in listen-policy.test.ts and port-zone-live.test.ts.
// ---------------------------------------------------------------------------

function instancesDir(): string {
    return path.join(process.env.XDG_STATE_HOME ?? "", "billion-context", "instances");
}

function writeRegistryEntry(entry: Record<string, unknown>): void {
    mkdirSync(instancesDir(), { recursive: true });
    const id = typeof entry.instanceId === "string" ? entry.instanceId : "anon";
    writeFileSync(path.join(instancesDir(), `${id}.json`), JSON.stringify(entry));
}

// resumeListening is fire-and-forget (as in production): give the rebind a
// bounded chance to complete before asserting on the listener state.
async function waitForListening(server: { listening: boolean }, ms = 3000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!server.listening && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
    }
    return server.listening;
}

test("performSelfRestart: replacement spawn env carries the bind-or-die marker without mutating the parent env (#3044)", { timeout: 30_000 }, async () => {
    const { server, port } = await startServer();
    const { log } = makeLog();
    const record: SpawnRecord = {};
    process.env.BILI_TEST_SENTINEL = "sentinel-value";
    try {
        const result = await performSelfRestart({
            server, host: "127.0.0.1", port,
            installDir: makeInstall("1.0.1"),
            runningVersion: "1.0.0", diskVersion: "1.0.1",
            log, inFlightProvider: () => 0,
            platform: "linux",
            spawnImpl: makeSpawn(makeReadyStub("stub-marker.mjs"), port, record),
            settleMs: 500, readyTimeoutMs: 5000,
            finish: () => {},
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        const env = record.options?.env as NodeJS.ProcessEnv | undefined;
        assert.ok(env, "spawn options carry an env");
        assert.equal(env[UPGRADE_REPLACEMENT_ENV], "1", "replacement marked so it binds-or-dies on the freed port (#3044)");
        assert.equal(env.BILI_TEST_SENTINEL, "sentinel-value", "inherited env survives the merge");
        assert.equal(process.env[UPGRADE_REPLACEMENT_ENV], undefined, "the parent's own env must not be mutated");
    } finally {
        delete process.env.BILI_TEST_SENTINEL;
        record.child?.kill();
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
    }
});

test("performSelfRestart: replacement that binds the WRONG port is terminated and service resumes (#3044)", { timeout: 30_000 }, async () => {
    // #3182: the stub's port can be stolen by concurrent load on a shared
    // shard runner (bind-0 TOCTOU). A stub that died with exit 91 never
    // reached the product scenario — re-pick ports and re-run, bounded.
    for (let attempt = 0; ; attempt++) {
    const { server, port } = await startServer();
    const { log, entries } = makeLog();
    const record: SpawnRecord = {};
    try {
        const pending = performSelfRestart({
            server, host: "127.0.0.1", port,
            installDir: makeInstall("1.0.1"),
            runningVersion: "1.0.0", diskVersion: "1.0.1",
            log, inFlightProvider: () => 0,
            // The stub listens on port+9 instead of the freed port: it models a
            // replacement that drifted via the old ladder after EADDRINUSE.
            spawnImpl: makeSpawn(makeReadyStub("stub-misplaced.mjs"), port + 9, record),
            settleMs: 500, readyTimeoutMs: 5000,
            finish: () => assert.fail("must not finish when the replacement drifted"),
        });
        for (let i = 0; i < 500 && record.child?.pid === undefined; i++) {
            await new Promise((r) => setTimeout(r, 10));
        }
        assert.ok(record.child?.pid, "replacement spawned");
        // The drifted replacement announces itself on the wrong port — exactly
        // what the parent's readiness loop must catch instead of trusting TCP.
        writeRegistryEntry({ instanceId: "stub-misplaced", pid: record.child.pid, port: port + 9, origin: `http://127.0.0.1:${port + 9}`, startedAt: Date.now(), lane: "dsh" });
        const result = await pending;
        assert.equal(result.ok, false, JSON.stringify(result));
        assert.equal(result.error, `replacement-misplaced:${port + 9}`);
        assert.match(entries.join("\n"), /bound port \d+ instead of \d+ — terminating/s);
        assert.equal(await waitForListening(server), true, "original listener must be resumed");
        assert.equal(await requestOk(port), true, "resumed listener must serve");
        if (record.child?.pid !== undefined) {
            for (let i = 0; i < 100 && isPidAlive(record.child.pid); i++) await new Promise((r) => setTimeout(r, 20));
            assert.equal(isPidAlive(record.child.pid), false, "misplaced replacement must be gone — no orphan left behind");
        }
        break;
    } catch (e) {
        if (record.child?.exitCode !== 91 || attempt >= 2) throw e;
    } finally {
        record.child?.kill("SIGKILL");
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
    }
    }
});

test("performSelfRestart: port taken over by another bili instance → parent exits instead of resuming (#3044)", { timeout: 30_000 }, async () => {
    const { server, port } = await startServer();
    const { log, entries } = makeLog();
    const record: SpawnRecord = {};
    let finished = 0;
    // A live non-listening process standing in for a peer bili instance.
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    try {
        assert.ok(sleeper.pid, "sleeper pid for the fake peer");
        // A live bili peer now owns our port (e.g. a host respawn that beat the
        // replacement): resuming THIS old-code copy would ladder-drift it onto
        // a fresh port nobody routes to — the zombie half of the leak.
        writeRegistryEntry({ instanceId: "superseding-peer", pid: sleeper.pid, port, origin: `http://127.0.0.1:${port}`, startedAt: Date.now(), lane: "dsh" });
        const result = await performSelfRestart({
            server, host: "127.0.0.1", port,
            installDir: makeInstall("1.0.1"),
            runningVersion: "1.0.0", diskVersion: "1.0.1",
            log, inFlightProvider: () => 0,
            spawnImpl: makeSpawn(makeCrashStub("stub-superseded.mjs"), port, record),
            settleMs: 500, readyTimeoutMs: 3000,
            finish: () => { finished++; },
        });
        assert.equal(result.ok, true, "the upgrade landed elsewhere — handover achieved, parent exits cleanly");
        assert.equal(finished, 1, "finish seam called exactly once");
        assert.equal(server.listening, false, "no resume: the old-code copy must not drift onto a new port");
        assert.match(entries.join("\n"), /served by bili instance pid \d+ — exiting instead of resuming/s);
    } finally {
        record.child?.kill();
        try { sleeper.kill("SIGKILL"); } catch {}
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
    }
});

test("performSelfRestart: a replacement that ignores SIGTERM is reaped by the SIGKILL escalation (#3044/#3344)", { timeout: 30_000, skip: process.platform === "win32" ? "POSIX-only: Windows terminates on SIGTERM uncatchably, so a SIGTERM-surviving stub cannot be modeled (was a w24 CI red, #3182 family)" : false }, async () => {
    // #3182: same stolen-port retry as above (stub exit 91 = infra TOCTOU).
    const stubborn = path.join(root, "stub-stubborn.mjs");
    for (let attempt = 0; ; attempt++) {
    const { server, port } = await startServer();
    const { log, entries } = makeLog();
    const record: SpawnRecord = {};
    writeFileSync(stubborn, [
        // No listener by design: the stub models a replacement that never
        // reaches readiness. It ignores SIGTERM to force the escalation path;
        // #3344 escalates to SIGKILL, which it cannot ignore — so the orphan
        // is reaped instead of left for manual cleanup (#3044).
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
    ].join("\n"));
    try {
        const result = await performSelfRestart({
            server, host: "127.0.0.1", port,
            installDir: makeInstall("1.0.1"),
            runningVersion: "1.0.0", diskVersion: "1.0.1",
            log, inFlightProvider: () => 0,
            spawnImpl: makeSpawn(stubborn, port, record),
            settleMs: 500, readyTimeoutMs: 800, killVerifyMs: 400,
            finish: () => assert.fail("must not finish while the replacement is stuck"),
        });
        assert.equal(result.ok, false, JSON.stringify(result));
        assert.equal(result.error, "replacement-not-ready");
        // #3344: the SIGTERM-ignoring replacement is reaped by the SIGKILL
        // escalation — no orphan survives its parent's timeout, so no
        // manual-cleanup error is logged. (Pre-#3344 this stub stayed alive
        // and the assertion matched the loud manual-cleanup message.)
        assert.ok(record.child?.pid, "stub pid for the liveness check");
        assert.equal(isPidAlive(record.child!.pid), false, "the SIGTERM-stubborn replacement was reaped by SIGKILL");
        assert.doesNotMatch(entries.join("\n"), /manual cleanup required/s);
        assert.equal(await waitForListening(server), true, "service resumes regardless");
        break;
    } catch (e) {
        if (record.child?.exitCode !== 91 || attempt >= 2) throw e;
    } finally {
        record.child?.kill("SIGKILL");
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
    }
    }
});
