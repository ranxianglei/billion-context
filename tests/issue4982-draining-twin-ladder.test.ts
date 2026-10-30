// #4982: a same-lane proxy entering graceful shutdown releases its listening
// socket IMMEDIATELY (server.close) but keeps its registry marker until the
// drain/flush finishes (seconds-to-minutes later, pinned by keep-alive
// connections). During that window the marker still claims "I hold port N"
// while a DIFFERENT instance can bind the freed port. A same-lane newcomer
// hitting EADDRINUSE there misclassified the draining predecessor as its
// twin and died with the adopt signal (exit 3) — stranding its launcher
// behind a cross-lane stranger it is forbidden to attach to (#1225). CI hit
// this in the #3203 concurrent-sessions e2e (release v0.1.209, PR #4982).
//
// Two complementary fixes, each pinned here:
//   B' (root-cause hygiene): shutdown() stamps portReleasedAt on its own
//      marker the moment the listener closes; classifySameLanePeer skips
//      stamped entries, so a draining instance can never be mistaken for the
//      port holder again (integration test A exercises this end to end).
//   A  (defense in depth): the late EADDRINUSE path verifies the claimed
//      twin's socket ownership via /__bili/health (pid + instance identity,
//      the #4341 criterion) before declaring twin-collision; an unverified
//      claim falls through to the plain foreign-holder policy and ladders
//      (integration test B exercises this with an UNSTAMPED marker, i.e. a
//      pre-fix build or a failed stamp).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { classifySameLanePeer, markPortReleased, type InstanceShape, type RegistryEntry } from "../src/instance.ts";
import { verifyEntryOwnsPort } from "../src/port-owner.ts";
import { assertPortDead } from "./port-race.ts";

const ROOT = path.join(import.meta.dirname, "..");
const ENTRY = path.join(ROOT, "src/index.ts");
const BASE = 18861;
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
        instanceId: "holder-4982",
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

test("classifySameLanePeer: a draining marker (portReleasedAt) is never a twin or drifted peer", () => {
    const live = holder();
    const drained = holder({ instanceId: "drained-4982", portReleasedAt: Date.now() });
    const shape = sameShape(ownShape());
    assert.equal(classifySameLanePeer([live], BASE, "pi", OWN_FP, shape)?.kind, "twin", "control: an unstamped live marker still classifies");
    assert.equal(classifySameLanePeer([drained], BASE, "pi", OWN_FP, shape), undefined, "a stamped marker must be skipped even with a live pid and full identity match");
    assert.equal(classifySameLanePeer([drained, live], BASE, "pi", OWN_FP, shape)?.entry.instanceId, live.instanceId, "an unstamped twin behind a drained one still classifies");
});

test("markPortReleased: stamps only its own marker, idempotent, missing-file no-op", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4982-mark-"));
    const prevState = process.env.XDG_STATE_HOME;
    try {
        process.env.XDG_STATE_HOME = path.join(sandbox, "state");
        const regDir = path.join(process.env.XDG_STATE_HOME as string, "billion-context", "instances");
        fs.mkdirSync(regDir, { recursive: true });
        const base = {
            startedAt: Date.now(),
            host: "127.0.0.1",
            passthrough: false,
            mitmDomains: [],
            modelWindows: {},
            modelMaxOutputs: {},
            lane: "pi",
            codeFingerprint: OWN_FP,
        };
        fs.writeFileSync(path.join(regDir, "aaa.json"), JSON.stringify({ instanceId: "aaa", pid: 1, port: 1, origin: "http://127.0.0.1:1", ...base }) + "\n");
        fs.writeFileSync(path.join(regDir, "bbb.json"), JSON.stringify({ instanceId: "bbb", pid: 2, port: 2, origin: "http://127.0.0.1:2", ...base }) + "\n");

        markPortReleased("aaa");
        const a = JSON.parse(fs.readFileSync(path.join(regDir, "aaa.json"), "utf8"));
        const b = JSON.parse(fs.readFileSync(path.join(regDir, "bbb.json"), "utf8"));
        assert.equal(typeof a.portReleasedAt, "number", "own marker gets the stamp");
        assert.equal(b.portReleasedAt, undefined, "other instances' markers must stay untouched");

        markPortReleased("aaa");
        const a2 = JSON.parse(fs.readFileSync(path.join(regDir, "aaa.json"), "utf8"));
        assert.equal(a2.portReleasedAt, a.portReleasedAt, "idempotent — re-stamping must not move the timestamp");

        markPortReleased("missing"); // no-op, must not throw
    } finally {
        if (prevState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevState;
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});

test("verifyEntryOwnsPort: an answered probe decides immediately (match or mismatch)", async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        return { ok: true, json: async () => ({ ok: true, pid: 4242, instanceId: "inst-a" }) };
    };
    const sleepImpl = async () => { throw new Error("an answered probe must not sleep/retry"); };
    assert.equal(await verifyEntryOwnsPort("http://127.0.0.1:1", { pid: 4242, instanceId: "inst-a" }, { fetchImpl, sleepImpl }), true);
    assert.equal(calls, 1);
    assert.equal(await verifyEntryOwnsPort("http://127.0.0.1:1", { pid: 9999, instanceId: "inst-a" }, { fetchImpl, sleepImpl }), false, "a pid mismatch decides immediately");
    assert.equal(calls, 2);
    assert.equal(await verifyEntryOwnsPort("http://127.0.0.1:1", { pid: 4242, instanceId: "other" }, { fetchImpl, sleepImpl }), false, "an instance mismatch decides immediately");
    assert.equal(calls, 3);
});

test("verifyEntryOwnsPort: only a silent responder is retried within the probe budget", async () => {
    let calls = 0;
    let sleeps = 0;
    const sleepImpl = async () => { sleeps += 1; };
    const silent = async () => {
        calls += 1;
        throw new Error("probe timeout");
    };
    assert.equal(await verifyEntryOwnsPort("http://127.0.0.1:1", { pid: 1, instanceId: "i" }, { fetchImpl: silent, sleepImpl, attempts: 3 }), false);
    assert.equal(calls, 3, "silent responder exhausts the attempt budget");
    assert.equal(sleeps, 2, "sleeps between attempts only");

    calls = 0;
    sleeps = 0;
    const thenMatch = async () => {
        calls += 1;
        if (calls === 1) throw new Error("probe timeout");
        return { ok: true, json: async () => ({ ok: true, pid: 1, instanceId: "i" }) };
    };
    assert.equal(await verifyEntryOwnsPort("http://127.0.0.1:1", { pid: 1, instanceId: "i" }, { fetchImpl: thenMatch, sleepImpl }), true, "a late answer within budget verifies");
    assert.equal(calls, 2);
    assert.equal(sleeps, 1);
});

// ---------------------------------------------------------------------------
// Integration helpers (conventions from issue4341-early-twin-adoption.test.ts)
// ---------------------------------------------------------------------------

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
        BILI_LAUNCH_TOKEN: "issue-4982-test",
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
            const res = await fetch(`http://127.0.0.1:${port}/__bili/status`, { signal: AbortSignal.timeout(2_000) });
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
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        child.once("close", () => {
            clearTimeout(timer);
            resolve();
        });
        child.kill("SIGTERM");
    });
}

/** A TCP listener that accepts connections and then says nothing — invisible
 *  to /__bili/health probes (they time out as "no evidence") but still owns
 *  the socket, so binders get EADDRINUSE. Deterministically forces the LATE
 *  EADDRINUSE decision path instead of the pre-bind foreign-owner ladder. */
function silentTcpListener(port: number): Promise<{ close(): Promise<void> }> {
    return new Promise((resolve, reject) => {
        const sockets = new Set<net.Socket>();
        const server = net.createServer((sock) => {
            sockets.add(sock);
            sock.once("close", () => sockets.delete(sock));
            // accept and hang — never answer HTTP; drain the probe's bytes so peer
            // EOF is actually delivered (a paused socket buffers them and never sees
            // EOF) and release the connection, or a dead prober pins server.close()
            // with CLOSE-WAIT sockets
            sock.resume();
            sock.on("end", () => sock.destroy());
            // An aborted health probe may reset instead of ending the connection,
            // or a killed prober (Windows kill() is a hard terminate) RSTs mid-probe;
            // without an error listener that surfaces as an uncaughtException AFTER
            // the test ends and fails the whole file (#5050). Destroying keeps the
            // fixture clean and owns the socket.
            sock.on("error", () => sock.destroy());
        });
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve({
            close: () => new Promise<void>((done) => {
                server.close(() => done());
                for (const socket of sockets) socket.destroy();
            }),
        }));
    });
}

test("silent TCP fixture survives an aborted health probe", { timeout: 5_000 }, async () => {
    const port = await freePort();
    const fixture = await silentTcpListener(port);
    const client = net.connect({ host: "127.0.0.1", port });
    try {
        await new Promise<void>((resolve, reject) => {
            client.once("connect", resolve);
            client.once("error", reject);
        });
        client.write("GET /__bili/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        await new Promise((resolve) => setTimeout(resolve, 25));
        client.resetAndDestroy();
        await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
        client.destroy();
        await fixture.close();
    }
});

function tcpRefused(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const s = net.connect({ port, host: "127.0.0.1" });
        let done = false;
        const finish = (v: boolean): void => {
            if (done) return;
            done = true;
            s.destroy();
            resolve(v);
        };
        s.once("connect", () => finish(false));
        s.once("error", () => finish(true));
        setTimeout(() => finish(false), 2_000).unref();
    });
}

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await cond()) return;
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

function readMarkers(stateHome: string): Array<Record<string, unknown>> {
    const dir = path.join(stateHome, "billion-context", "instances");
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const out: Array<Record<string, unknown>> = [];
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
            out.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
        } catch {
            // torn write in flight — skip
        }
    }
    return out;
}

function spawnBili(sandbox: string, port: number): { child: ChildProcess; out: { value: string } } {
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY, "start", "--host", "127.0.0.1", "--port", String(port)], {
        cwd: ROOT,
        env: makeEnv(sandbox),
        stdio: ["ignore", "pipe", "pipe"],
    });
    const out = { value: "" };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { out.value += chunk; });
    child.stderr.on("data", (chunk: string) => { out.value += chunk; });
    return { child, out };
}

/** Wait for the child's own registry marker, then for it to serve health on
 *  the port IT registered (laddering may have moved it off the requested one). */
async function waitUntilLadderedHealthy(stateHome: string, child: ChildProcess, label: string): Promise<number> {
    let port = 0;
    await waitUntil(async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`${label} exited before becoming healthy`);
        }
        const m = readMarkers(stateHome).find((e) => e.pid === child.pid);
        if (!m || typeof m.port !== "number") return false;
        port = m.port as number;
        return waitForStatus(port, 5_000);
    }, 90_000, `${label} to register and become healthy`);
    return port;
}

test("#4982 e2e: draining same-lane predecessor + squatter → newcomer ladders instead of dying", { timeout: 180_000 }, async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4982a-"));
    const { stateHome } = sandboxDirs(sandbox);
    const port = await freePort();
    await assertPortDead(port, { label: "4982 drain-test port" });
    let p1Ref: ReturnType<typeof spawnBili> | null = null;
    let p2Ref: ReturnType<typeof spawnBili> | null = null;
    let heldRef: net.Socket | null = null;
    let squatterRef: Awaited<ReturnType<typeof silentTcpListener>> | null = null;
    try {
        // P1: the serving proxy that will enter graceful shutdown.
        const p1 = spawnBili(sandbox, port);
        p1Ref = p1;
        if (!(await waitForStatus(port, 90_000))) throw new Error(`P1 never became ready:\n${p1.out.value}`);
        const p1Marker = readMarkers(stateHome).find((m) => m.pid === p1.child.pid);
        assert.ok(p1Marker, "P1 must have registered itself");

        // Pin P1's drain with a held connection so it stays alive (listener
        // closed, process + marker present) long enough to run the race.
        const held = await new Promise<net.Socket>((resolve, reject) => {
            const s = net.connect(port, "127.0.0.1");
            s.once("connect", () => resolve(s));
            s.once("error", reject);
        });
        heldRef = held;
        // #5050: a destroyed pin must not leak a late ECONNRESET into a later
        // test on platforms where teardown races differ (observed windows node 22).
        held.on("error", () => {});

        // #5050: kill("SIGTERM") is POSIX-only — Windows Node kills via
        // TerminateProcess without delivering any signal, so the graceful path
        // (and the portReleasedAt stamp) never ran there. The cross-platform
        // seam is POST /__bili/shutdown (#3544): SIGTERM/SIGBREAK/HTTP all
        // converge on the same shutdown(). A refused/hung response is fine —
        // the stamp+refusal wait below is the real verification.
        try {
            await fetch(`http://127.0.0.1:${port}/__bili/shutdown`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
                signal: AbortSignal.timeout(10_000),
            });
        } catch {}
        const p1MarkerFile = path.join(stateHome, "billion-context", "instances", `${p1Marker.instanceId}.json`);
        await waitUntil(async () => {
            let stamped = false;
            try {
                stamped = (JSON.parse(fs.readFileSync(p1MarkerFile, "utf8")).portReleasedAt as unknown) !== undefined;
            } catch {
                return false;
            }
            return stamped && (await tcpRefused(port));
        }, 30_000, "P1 to stamp portReleasedAt and release the socket");

        // The squatter takes the freed port BEFORE the newcomer starts — but
        // silently, so the newcomer's pre-bind claim probe sees no evidence.
        const squatter = await silentTcpListener(port);
        squatterRef = squatter;

        // P2: same lane, same requested port — the CI victim.
        const p2 = spawnBili(sandbox, port);
        p2Ref = p2;
        const result = await Promise.race([
            new Promise<"exited">((resolve) => p2.child.once("exit", () => resolve("exited"))),
            (async () => {
                const servedPort = await waitUntilLadderedHealthy(stateHome, p2.child, "P2");
                return { kind: "healthy" as const, servedPort };
            })(),
        ]);
        if (typeof result === "string") {
            throw new Error(`P2 exited before becoming healthy (the #4982 failure mode):\n${p2.out.value}`);
        }
        assert.notEqual(result.servedPort, port, "P2 must ladder off the contended port");
        const p2Marker = readMarkers(stateHome).find((m) => m.pid === p2.child.pid);
        assert.equal(p2Marker?.lane, "pi");
        assert.equal(p2Marker?.port, result.servedPort);
        assert.doesNotMatch(p2.out.value, /already served by a same-build bili instance/, "the stale claim must not produce a twin-collision verdict");
    } finally {
        // Cleanup lives in finally so an assertion failure reports its reason
        // instead of leaking the children + squatter and hanging the runner.
        if (p2Ref) await killChild(p2Ref.child);
        heldRef?.destroy();
        if (p1Ref) await killChild(p1Ref.child);
        const squatter = squatterRef;
        if (squatter) await squatter.close();
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});

test("#4982 e2e: unverified registry twin claim (unstamped marker) → ladder, not adopt-death", { timeout: 180_000 }, async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4982b-"));
    const { stateHome } = sandboxDirs(sandbox);
    const port = await freePort();
    await assertPortDead(port, { label: "4982 unverified-twin port" });
    let p2Ref: ReturnType<typeof spawnBili> | null = null;
    let squatterRef: Awaited<ReturnType<typeof silentTcpListener>> | null = null;
    try {
        // A registry marker claiming `port` with a LIVE pid and full identity
        // match — but NO portReleasedAt stamp (pre-fix build, or a failed
        // stamp), and the socket is actually owned by a silent squatter.
        const registryDir = path.join(stateHome, "billion-context", "instances");
        fs.mkdirSync(registryDir, { recursive: true });
        const fingerprint = createHash("sha256").update(fs.readFileSync(ENTRY)).digest("hex");
        fs.writeFileSync(
            path.join(registryDir, "stale-4982.json"),
            JSON.stringify({
                instanceId: "stale-4982",
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
        const squatter = await silentTcpListener(port);
        squatterRef = squatter;

        const p2 = spawnBili(sandbox, port);
        p2Ref = p2;
        const result = await Promise.race([
            new Promise<"exited">((resolve) => p2.child.once("exit", () => resolve("exited"))),
            (async () => {
                const servedPort = await waitUntilLadderedHealthy(stateHome, p2.child, "P2");
                return { kind: "healthy" as const, servedPort };
            })(),
        ]);
        if (typeof result === "string") {
            throw new Error(`P2 exited before becoming healthy (the #4982 failure mode):\n${p2.out.value}`);
        }
        assert.notEqual(result.servedPort, port, "P2 must ladder off the contended port");
        const logText = fs.readFileSync(path.join(stateHome, "billion-context", "bili.log"), "utf8");
        assert.match(logText, /no longer answers as itself/, "the demotion from twin to foreign-held must be logged");
        // The demotion warn above deliberately names "twin-collision" in prose, so pin
        // the verdict by its unique log marker (shared by the early #4341 and the late
        // path) instead of that substring.
        assert.doesNotMatch(logText, /already served by a same-build bili instance/, "an unverified claim must never reach the twin-collision verdict");
    } finally {
        if (p2Ref) await killChild(p2Ref.child);
        const squatter = squatterRef;
        if (squatter) await squatter.close();
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});
