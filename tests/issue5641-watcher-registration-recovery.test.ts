// #5641: a transient owner-watcher registration failure used to be invisible
// after the fact — the warning dropped the underlying cause, the returned
// handle kept only "refused", and a heartbeat that later repaired the
// registration (the server re-adds the pid on every accepted hb) produced no
// signal at all. The user was left staring at a permanent
// "may exit when its first owner does" warning while the state had already
// recovered.
//
// This suite pins the reporter's scenario table:
//   1. transient failure + later acknowledged beat → diagnosable failure,
//      pending state clears ONLY on an ack, exactly one recovery notice, no
//      extra proxy spawned;
//   2. persistent network failure → bounded attempts, stays unconfirmed, no
//      false success;
//   3. HTTP 409 → refused semantics preserved, never retried, no false
//      recovered;
//   4. heartbeat HTTP 500/409 → a resolved fetch is NOT recovery;
//   5. foreign owner pid → no heartbeat started, failure retained on the
//      handle, retries still happen (they are the only chance);
//   6. worker death → in-thread fallback carries the same ack semantics.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
    ensureProxyRunning,
    formatWatcherError,
    registerWatcherDefault,
    runOwnerHeartbeatWorker,
    startOwnerHeartbeat,
    markWatcherPendingRecovery,
    noteWatcherHeartbeatAck,
    type LauncherDeps,
    type OwnerBeatWorker,
    type WatcherRegistration,
} from "../src/launcher.js";
import { type ProxyInstanceFile as InstanceFile } from "../src/instance.js";

async function wait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/** Poll until `check()` passes or the deadline expires. */
async function until(check: () => boolean, deadlineMs: number, stepMs = 50): Promise<boolean> {
    const end = Date.now() + deadlineMs;
    while (Date.now() < end) {
        if (check()) return true;
        await wait(stepMs);
    }
    return check();
}

/** A controllable /__bili/watcher stand-in recording every beat body. */
interface WatcherStub {
    origin: string;
    bodies: string[];
    close(): Promise<void>;
}

function stubWatcher(status: number): Promise<WatcherStub> {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/__bili/watcher") {
            let b = "";
            req.on("data", (c) => (b += c));
            req.on("end", () => {
                bodies.push(b);
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify(status === 200 ? { ok: true, watchers: 1 } : { ok: false, error: "stub" }));
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({
                origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
                bodies,
                close: () => new Promise<void>((r) => server.close(() => r())),
            });
        });
    });
}

/** Capture console.error lines for the duration of a test. */
function captureConsoleError(): { lines: string[]; restore(): void } {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]): void => { lines.push(args.map(String).join(" ")); };
    return {
        lines,
        restore(): void { console.error = orig; },
    };
}

// #1225-style fingerprint fixture: the attaching side hashes the script it
// WOULD spawn; the fake instance records the same hash so the attach gate
// lines up.
const FP_SCRIPT = path.join(os.tmpdir(), `bili-5641-fp-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// #5641 fingerprint fixture\n");
const FP_HASH = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");

function recordedInstance(origin: string, port: number): InstanceFile {
    return {
        origin,
        instanceId: "inst-5641",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        codeFingerprint: FP_HASH,
    };
}

/** Deps that force ensureProxyRunning down the ATTACH path against a virtual
 *  (or real) instance — nothing here spawns or touches the network beyond
 *  what the caller wires. */
function attachDeps(opts: {
    origin: string;
    port: number;
    registerWatcher: (origin: string, pid: number) => Promise<WatcherRegistration>;
    diag: (msg: string) => void;
}): LauncherDeps {
    return {
        fetchImpl: async () => ({ ok: true }),
        fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-5641", watchdog: { armed: true } }),
        readInstanceFile: () => recordedInstance(opts.origin, opts.port),
        isConnectable: async () => true,
        registerWatcher: opts.registerWatcher,
        attachDiag: opts.diag,
        scriptPath: FP_SCRIPT,
        spawnImpl: () => { throw new Error("attach path must not spawn"); },
    };
}

function launchWith(deps: LauncherDeps, port: number, parentPid?: number) {
    return ensureProxyRunning(
        { host: "127.0.0.1", port, passthrough: false, debug: false, ...(parentPid !== undefined ? { parentPid } : {}) },
        deps,
    );
}

// ── 1. Diagnostics: the failure line must be actionable ─────────────────────

test("#5641 registerWatcherDefault: HTTP failure warns with origin/pid/status and the recovery path", async () => {
    const stub = await stubWatcher(500);
    const cap = captureConsoleError();
    try {
        const reg = await registerWatcherDefault(stub.origin, process.pid);
        assert.equal(reg, "failed");
        assert.equal(cap.lines.length, 1, "one warning line per attempt");
        const line = cap.lines[0];
        assert.ok(line.includes(stub.origin), `origin present: ${line}`);
        assert.ok(line.includes(`owner pid ${process.pid}`), `owner pid present: ${line}`);
        assert.ok(line.includes("HTTP 500"), `status present: ${line}`);
        assert.ok(line.includes("the shared proxy may exit when its first owner does"), line);
        assert.ok(line.includes("a later heartbeat will re-register us"), "own-pid tail names the recovery path");
    } finally {
        cap.restore();
        await stub.close();
    }
});

test("#5641 registerWatcherDefault: transport failure surfaces the nested cause and the foreign-pid tail", async () => {
    // Deterministic refused port: bind, close, then hit it — port 1 would be
    // blocked by undici's bad-port list before any socket is even opened.
    const probe = http.createServer(() => {});
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const cap = captureConsoleError();
    try {
        const reg = await registerWatcherDefault(`http://127.0.0.1:${port}`, 999_999);
        assert.equal(reg, "failed");
        assert.equal(cap.lines.length, 1);
        const line = cap.lines[0];
        assert.ok(line.includes("ECONNREFUSED"), `transport-level reason present: ${line}`);
        assert.ok(line.includes("no heartbeat runs for a foreign owner pid"), "foreign-pid tail says so explicitly");
        assert.ok(!line.includes("a later heartbeat will re-register us"), "foreign pid gets no own-heartbeat promise");
    } finally {
        cap.restore();
    }
});

test("#5641 formatWatcherError: first carrying cause wins, message fallback, bare errors pass through", () => {
    // Structured code (undici ConnectError shape): the code wins over deeper causes.
    const outer = new TypeError("fetch failed");
    const causeErr = Object.assign(new Error("connect ETIMEDOUT 127.0.0.1:8787"), { code: "ETIMEDOUT" });
    const inner = Object.assign(new Error("inner"), { code: "ECONNRESET" });
    causeErr.cause = inner;
    outer.cause = causeErr;
    assert.equal(formatWatcherError(outer), "TypeError: fetch failed [cause: ETIMEDOUT]");

    // No structured code (Node 22 DNS failures carry the errno in the message).
    const msgOnly = new TypeError("fetch failed");
    msgOnly.cause = new Error("getaddrinfo ENOTFOUND upstream.invalid");
    assert.equal(formatWatcherError(msgOnly), "TypeError: fetch failed [cause: getaddrinfo ENOTFOUND upstream.invalid]");

    // No cause at all: name+message only; generic Error name stays unprefixed.
    assert.equal(formatWatcherError(new RangeError("boom")), "RangeError: boom");
    assert.equal(formatWatcherError(new Error("plain")), "plain");
    // Non-Error input survives.
    assert.equal(formatWatcherError("string failure"), "string failure");
});

// ── 2. Handle state: attached never implies registered ──────────────────────

test("#5641 handle.watcherRegistration carries every outcome; refused keeps its flag; no extra spawn", async () => {
    const deadOrigin = "http://127.0.0.1:1";
    const diag: string[] = [];

    let calls = 0;
    const okHandle = await launchWith(attachDeps({
        origin: deadOrigin,
        port: 1,
        registerWatcher: async () => { calls++; return "ok"; },
        diag: (m) => diag.push(m),
    }), 1);
    assert.equal(okHandle.attached, true);
    assert.equal(okHandle.watcherRegistration, "ok");
    assert.equal(okHandle.refusedWatcher, undefined);
    assert.equal(calls, 1, "a clean registration is not retried");

    calls = 0;
    const refusedHandle = await launchWith(attachDeps({
        origin: deadOrigin,
        port: 1,
        registerWatcher: async () => { calls++; return "refused"; },
        diag: (m) => diag.push(m),
    }), 1);
    assert.equal(refusedHandle.watcherRegistration, "refused");
    assert.equal(refusedHandle.refusedWatcher, true, "#1322 flag preserved");
    assert.equal(calls, 1, "a 409 refusal is a policy answer — NEVER retried (#5641 row 3)");
});

test("#5641 transient failure: bounded retries, retained 'failed', no false recovery, no spawn", async () => {
    const deadOrigin = "http://127.0.0.1:1";
    const diag: string[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const deps = attachDeps({
        origin: deadOrigin,
        port: 1,
        registerWatcher: async () => { calls++; return "failed"; },
        diag: (m) => diag.push(m),
    });
    deps.sleep = async (ms: number) => { sleeps.push(ms); };

    const handle = await launchWith(deps, 1);
    assert.equal(handle.attached, true, "traffic still flows — attachment is not rejected");
    assert.equal(handle.watcherRegistration, "failed", "the unconfirmed state is RETAINED on the handle");
    assert.notEqual(handle.refusedWatcher, true, "a transport fault is not a refusal");
    assert.equal(calls, 3, "bounded: initial + 2 retries, then stop (#5641 row 2)");
    assert.deepEqual(sleeps, [500, 500], "explicit backoff budget between attempts");

    // Persistent failure stays unconfirmed: nothing ever reports recovery.
    await wait(300);
    assert.equal(diag.filter((m) => m.includes("recovered")).length, 0, "no false success");
});

test("#5641 retry succeeds on attempt two: final outcome 'ok', no pending state", async () => {
    const deadOrigin = "http://127.0.0.1:1";
    const diag: string[] = [];
    const results: WatcherRegistration[] = ["failed", "ok"];
    let i = 0;
    const handle = await launchWith(attachDeps({
        origin: deadOrigin,
        port: 1,
        registerWatcher: async () => results[i++],
        diag: (m) => diag.push(m),
    }), 1);
    assert.equal(i, 2, "stops retrying once the outcome is conclusive");
    assert.equal(handle.watcherRegistration, "ok");
    await wait(200);
    assert.equal(diag.filter((m) => m.includes("recovered")).length, 0, "direct success needs no recovery notice");
});

test("#5641 foreign owner pid: retries still run (their only chance), failure stays retained", async () => {
    const deadOrigin = "http://127.0.0.1:1";
    const diag: string[] = [];
    let calls = 0;
    const handle = await launchWith(attachDeps({
        origin: deadOrigin,
        port: 1,
        registerWatcher: async () => { calls++; return "failed"; },
        diag: (m) => diag.push(m),
    }), 1, 999_999);
    assert.equal(handle.watcherRegistration, "failed", "row 5: the unconfirmed fact survives on the handle");
    assert.equal(calls, 3, "row 5: bounded retries are the foreign pid's only repair path");
    await wait(300);
    assert.equal(diag.filter((m) => m.includes("recovered")).length, 0);
});

// ── 3. Recovery: an acknowledged beat flips pending → recovered, once ───────

test("#5641 noteWatcherHeartbeatAck: one notice per episode, idempotent afterwards", () => {
    const diag: string[] = [];
    const origin = "http://127.0.0.1:5641-unit";
    markWatcherPendingRecovery(origin, 4242, (m) => diag.push(m));
    noteWatcherHeartbeatAck(origin);
    noteWatcherHeartbeatAck(origin);
    assert.equal(diag.length, 1, "exactly ONE host-visible recovery notice");
    assert.ok(diag[0].includes(`watcher registration recovered at ${origin}`), diag[0]);
    assert.ok(diag[0].includes("owner pid 4242"), diag[0]);
    // An origin that never failed has nothing to recover.
    noteWatcherHeartbeatAck("http://127.0.0.1:5641-quiet");
    assert.equal(diag.length, 1, "acks without a pending failure stay silent");
});

test("#5641 worker path: first 2xx beat acknowledges, later beats add no noise", async () => {
    const stub = await stubWatcher(200);
    const diag: string[] = [];
    markWatcherPendingRecovery(stub.origin, process.pid, (m) => diag.push(m));
    const stop = runOwnerHeartbeatWorker(stub.origin, process.pid, 200);
    assert.equal(typeof stop, "function");
    try {
        assert.ok(await until(() => diag.length >= 1, 8_000), `recovery notice arrives via the host-safe channel (got: ${JSON.stringify(diag)})`);
        const settled = diag.length;
        await wait(700);
        assert.equal(diag.length, settled, "no per-heartbeat log spam after recovery");
        assert.ok(stub.bodies.length >= 1, "beats actually reached the proxy");
        assert.deepEqual(JSON.parse(stub.bodies[0]), { pid: process.pid, hb: true }, "wire shape unchanged");
    } finally {
        stop();
        await stub.close();
    }
});

test("#5641 row 4: a resolved fetch returning 500 is NOT recovery", async () => {
    const stub = await stubWatcher(500);
    const diag: string[] = [];
    markWatcherPendingRecovery(stub.origin, process.pid, (m) => diag.push(m));
    const stop = runOwnerHeartbeatWorker(stub.origin, process.pid, 150);
    try {
        await wait(900);
        assert.ok(stub.bodies.length >= 1, "beats reached the proxy even while it answers 500");
        assert.equal(diag.length, 0, "a resolved non-2xx response must not flip pending→recovered");
    } finally {
        stop();
        await stub.close();
    }
});

test("#5641 rows 3/4: a resolved fetch returning 409 is NOT recovery either", async () => {
    const stub = await stubWatcher(409);
    const diag: string[] = [];
    markWatcherPendingRecovery(stub.origin, process.pid, (m) => diag.push(m));
    const stop = runOwnerHeartbeatWorker(stub.origin, process.pid, 150);
    try {
        await wait(900);
        assert.ok(stub.bodies.length >= 1, "beats keep going (liveness attestation is unchanged)");
        assert.equal(diag.length, 0, "409 means 'watchdog unarmed' — nothing to recover");
    } finally {
        stop();
        await stub.close();
    }
});

test("#5641 row 6: a worker that dies mid-flight falls back to the in-thread loop WITH ack semantics", async () => {
    const stub = await stubWatcher(200);
    const diag: string[] = [];
    markWatcherPendingRecovery(stub.origin, process.pid, (m) => diag.push(m));
    let errorListener: ((err: Error) => void) | undefined;
    const fakeWorker: OwnerBeatWorker = {
        on(event, listener) { if (event === "error") errorListener = listener; },
        unref() {},
        postMessage() {},
        terminate() { return Promise.resolve(undefined); },
    };
    const stop = runOwnerHeartbeatWorker(stub.origin, process.pid, 150, () => fakeWorker);
    try {
        assert.equal(typeof errorListener, "function", "error handler armed before the crash");
        errorListener!(new Error("simulated thread death"));
        assert.ok(await until(() => diag.length >= 1, 8_000), `in-thread fallback must report recovery too (got: ${JSON.stringify(diag)})`);
        assert.equal(diag.length, 1, "still exactly one notice");
        stop();
        const frozen = stub.bodies.length;
        await wait(400);
        assert.equal(stub.bodies.length, frozen, "stop() silences the fallback together with the entry");
    } finally {
        stop();
        await stub.close();
    }
});

test("#5641 injected-post seam: resolving TRUE acks, anything else does not", async () => {
    const origin = "http://127.0.0.1:5641-injected";
    const diag: string[] = [];
    markWatcherPendingRecovery(origin, process.pid, (m) => diag.push(m));
    let posts = 0;
    const stop = startOwnerHeartbeat(origin, process.pid, 120, async () => {
        posts++;
        return posts >= 2; // first beat unresolved-ish, second is an ack
    });
    assert.equal(typeof stop, "function");
    try {
        assert.ok(await until(() => diag.length >= 1, 5_000), `injected post resolving true drives the transition (posts=${posts})`);
        const settled = diag.length;
        await wait(400);
        assert.equal(diag.length, settled, "no repeat notices");
    } finally {
        stop!();
    }

    // Negative direction: a post that never resolves TRUE never recovers.
    const quiet: string[] = [];
    const origin2 = "http://127.0.0.1:5641-injected-neg";
    markWatcherPendingRecovery(origin2, process.pid, (m) => quiet.push(m));
    const stop2 = startOwnerHeartbeat(origin2, process.pid, 120, async () => { /* records nothing */ });
    try {
        await wait(500);
        assert.equal(quiet.length, 0, "falsy/undefined post results are not acknowledgements");
    } finally {
        stop2?.();
    }
});

// ── 4. End-to-end through ensureProxyRunning (the reported scenario) ────────

test("#5641 end-to-end: attach with failed registration, real heartbeat recovers with one notice, zero spawns", { timeout: 30_000 }, async () => {
    const stub = await stubWatcher(200);
    const diag: string[] = [];
    let regCalls = 0;
    const port = Number(new URL(stub.origin).port);
    const handle = await launchWith(attachDeps({
        origin: stub.origin,
        port,
        registerWatcher: async () => { regCalls++; return "failed"; },
        diag: (m) => diag.push(m),
    }), port);
    try {
        assert.equal(handle.attached, true);
        assert.equal(handle.watcherRegistration, "failed", "handle admits the registration is unconfirmed");
        assert.equal(regCalls, 3, "bounded retries ran during attach");
        assert.ok(diag.some((m) => m.includes("attaching to running proxy")), "attach itself proceeded normally");

        // The internal startOwnerHeartbeat uses the 5s production interval —
        // the first acknowledged beat lands ~5s out. Generous deadline like
        // the #5152 suite (worker cold start under CI load).
        assert.ok(
            await until(() => diag.some((m) => m.includes("watcher registration recovered")), 12_000),
            `the recovery notice must reach the host-safe diagnostic channel (diag=${JSON.stringify(diag)})`,
        );
        assert.equal(diag.filter((m) => m.includes("watcher registration recovered")).length, 1, "exactly one recovery notice");
        assert.ok(stub.bodies.length >= 1, "the owning heartbeat did the re-registering — no extra proxy involved");
        assert.deepEqual(JSON.parse(stub.bodies[0]), { pid: process.pid, hb: true });
    } finally {
        await stub.close();
    }
});
