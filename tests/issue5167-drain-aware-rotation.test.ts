// #5167: during an auto-update turnover the OLD resident accepts
// /__bili/shutdown and runs server.close() — its LISTENER frees the port
// within milliseconds, but it keeps ANSWERING pooled keep-alive sockets while
// it drains (by design, worst case (1+10)×10s post-#3890). Both rotation
// waits polled "is it still alive?" with Node's global fetch, whose undici
// pool reuses exactly those keep-alive sockets (poll cadence 200/500ms is far
// below the server's 5s keepAliveTimeout), so a draining resident read as
// alive for the whole 12s budget:
//   - dsh pinned attach (dsh-native.ts) ⇒ "attaching anyway" — hosts rode the
//     doomed old instance while other hosts used the new spawn: two live
//     processes writing one session store;
//   - launcher rotation ⇒ spurious timeout ⇒ "falling back to the normal
//     spawn ladder" while the port was actually free.
// The fix: rotation-wait polls send Connection: close (fresh connection each
// round), so "answers" means "the listener still accepts" — the port-release
// signal. This suite pins both paths against REAL draining http servers
// (no fetch mocks): a draining resident must read as released, a wedged
// holder that truly keeps its listener must still time out into the fallback.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ProxyInstanceFile } from "../src/instance.ts";
import { ensureProxyRunning, type SpawnChild, type SpawnFn } from "../src/launcher.ts";
import { rotatePinnedStaleProxy, _setPinnedRotationWaitForTest } from "../src/agent/dsh-native.ts";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

const CHILD_PID = 42_471;

const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-5167-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP_HASH = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");

function staleInstance(port: number): ProxyInstanceFile {
    return {
        origin: `http://127.0.0.1:${port}`,
        instanceId: "old-instance",
        // process.pid: ALIVE, so the candidate survives the probe-time
        // isPidAlive drop and reaches the rotation decision.
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        codeFingerprint: "old-build",
        lane: "dsh",
        launchToken: "old-token",
    };
}

function mineMarker(port: number): ProxyInstanceFile {
    return {
        origin: `http://127.0.0.1:${port}`,
        instanceId: "mine-1",
        pid: CHILD_PID,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        lane: "dsh",
        codeFingerprint: FP_HASH,
    };
}

function makeFakeChild(pid: number): SpawnChild {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
        pid,
        unref(): void {},
        kill(): boolean { return true; },
        on(event: string, listener: (...args: unknown[]) => void): SpawnChild {
            const list = listeners.get(event) ?? [];
            list.push(listener);
            listeners.set(event, list);
            return this;
        },
    } as SpawnChild;
}

/** Real http resident modeling the production drain: on POST /__bili/shutdown
 *  it 202s and calls server.close() — the LISTENER stops accepting (port
 *  released) while already-accepted keep-alive connections keep being served
 *  (that is the drain). `neverRelease` models a wedged holder whose listener
 *  never closes even after accepting the shutdown. */
async function startDrainingResident(t: TestContext, opts: { neverRelease?: boolean; manifest?: boolean } = {}): Promise<{ srv: http.Server; port: number; origin: string; shutdownCalls: () => number }> {
    let shutdownCalls = 0;
    const srv = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (req.method === "POST" && url === "/__bili/shutdown") {
            shutdownCalls += 1;
            if (!opts.neverRelease) srv.close(); // listener off, conns drain on
            res.writeHead(202, { "content-type": "application/json" });
            res.end("{}");
            return;
        }
        if (opts.manifest) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "0.0.1", commit: "deadbeef" }));
            return;
        }
        if (url === "/__bili/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, instanceId: "old-instance", pid: process.pid, version: "0.0.1", watchdog: { armed: true } }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const { port } = srv.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    t.after(() => {
        srv.close();
        srv.closeAllConnections?.();
    });
    return { srv, port, origin, shutdownCalls: () => shutdownCalls };
}

test("#5167 launcher rotation sees a draining resident as released (fresh-connection polls)", async (t) => {
    const resident = await startDrainingResident(t);
    // Warm the undici pool exactly like production discovery does: the health
    // probe inside ensureProxyRunning rides pooled keep-alive connections.
    const errs: string[] = [];
    const origErr = console.error;
    console.error = ((...args: unknown[]) => { errs.push(args.map(String).join(" ")); }) as typeof console.error;
    let spawnCalls = 0;
    let ticks = 0;
    try {
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: resident.port, passthrough: false, debug: false, lane: "dsh", parentPid: 999_999 },
            {
                fetchImpl: async (url) => ({ ok: url.startsWith(resident.origin) }),
                // fetchHealthInfo deliberately NOT injected: the default real
                // probe must warm the pool against the live resident, exactly
                // like a production bring-up.
                // requestInstanceShutdown deliberately NOT injected: the real
                // POST must drive the real drain path (202 + listener close).
                spawnImpl: (): SpawnChild => { spawnCalls += 1; return makeFakeChild(CHILD_PID); },
                now: (): number => ticks * 5_000,
                sleep: (): Promise<void> => { ticks += 1; return Promise.resolve(); },
                readInstanceFile: (): ProxyInstanceFile => staleInstance(resident.port),
                listRegistryInstances: (): ProxyInstanceFile[] => [staleInstance(resident.port), mineMarker(resident.port)],
            },
        );
        assert.equal(resident.shutdownCalls(), 1, "asked the draining resident to shut down");
        assert.equal(spawnCalls, 1, "spawned after rotation instead of attaching anyway");
        assert.equal(handle.port, resident.port, "took over the freed canonical port");
        // Pre-fix the pooled poll kept answering the draining resident until
        // the 12s deadline (4 ticks at 5s steps). A fresh-connection poll sees
        // the closed listener on the first or second round.
        assert.ok(ticks <= 2, `drain-aware wait was bounded (ticks=${ticks})`);
        assert.ok(!errs.some((e) => e.includes("stale rotation timed out")), `no spurious timeout: ${errs.join(" | ")}`);
    } finally {
        console.error = origErr;
    }
});

test("#5167 launcher rotation still times out a holder that truly keeps its listener (fallback intact)", async (t) => {
    const resident = await startDrainingResident(t, { neverRelease: true });
    const errs: string[] = [];
    const origErr = console.error;
    console.error = ((...args: unknown[]) => { errs.push(args.map(String).join(" ")); }) as typeof console.error;
    let spawnCalls = 0;
    let ticks = 0;
    try {
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: resident.port, passthrough: false, debug: false, lane: "dsh", parentPid: 999_999 },
            {
                fetchImpl: async (url) => ({ ok: url.startsWith(resident.origin) }),
                spawnImpl: (): SpawnChild => { spawnCalls += 1; return makeFakeChild(CHILD_PID); },
                now: (): number => ticks * 5_000,
                sleep: (): Promise<void> => { ticks += 1; return Promise.resolve(); },
                readInstanceFile: (): ProxyInstanceFile => staleInstance(resident.port),
                listRegistryInstances: (): ProxyInstanceFile[] => [staleInstance(resident.port), mineMarker(resident.port)],
            },
        );
        assert.equal(resident.shutdownCalls(), 1);
        assert.ok(ticks >= 3, `deadline was actually consumed (ticks=${ticks})`);
        assert.ok(errs.some((e) => e.includes("stale rotation timed out") && e.includes("still accepts fresh connections")), `timeout branch logged: ${errs.join(" | ")}`);
        assert.equal(spawnCalls, 1, "fell back to the spawn ladder");
        assert.equal(handle.port, resident.port);
    } finally {
        console.error = origErr;
    }
});

test("#5167 pinned rotation returns true for a draining resident — no more attach-anyway", async (t) => {
    const resident = await startDrainingResident(t, { manifest: true });
    const manifestUrl = `${resident.origin}/__bili/plugin/manifest`;
    // Pin dispatching to ONE connection per origin (undici Agent) so every
    // request — the shutdown POST included — demonstrably rides the pooled
    // socket. That socket is in-flight when the resident accepts the shutdown
    // and calls server.close(), so it SURVIVES Node's idle-socket teardown and
    // keeps answering later keep-alive requests: the exact false "alive" the
    // PRE-FIX poll loop rode to its 12s deadline (probe log in the issue).
    // Pre-fix this test fails: every pooled poll is answered, so the deadline
    // is the only exit and rotate returns false.
    const prevDispatcher = getGlobalDispatcher();
    setGlobalDispatcher(new Agent({ connections: 1, pipelining: 1 }));
    t.after(() => setGlobalDispatcher(prevDispatcher));
    // Warm the pool like the pre-rotation version probes do: cadenced GETs —
    // exactly the pattern that keeps one keep-alive socket alive in production.
    for (let i = 0; i < 3; i++) {
        const r = await fetch(manifestUrl);
        assert.ok(r.ok);
        await r.text();
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const started = Date.now();
    const rotated = await rotatePinnedStaleProxy(resident.origin);
    const elapsed = Date.now() - started;
    assert.equal(rotated, true, "draining resident must read as rotated-out");
    assert.equal(resident.shutdownCalls(), 1, "exactly one shutdown request");
    assert.ok(elapsed < 3_000, "rotation completed promptly, not via the 12s deadline (took " + elapsed + "ms)");
    // Node ≥19 destroys IDLE keep-alive sockets on server.close(); only the
    // socket carrying the in-flight shutdown POST survives and stays answered
    // until its keep-alive lingers out — which is exactly the false "alive"
    // the PRE-FIX poll loop rode (probe log in the issue). With Connection:
    // close on every rotation request, no pooled socket is ever consulted
    // again, so nothing here depends on that survivor's timing.
});

test("#5167 pinned rotation returns false for a holder that never releases the port", async (t) => {
    const resident = await startDrainingResident(t, { manifest: true, neverRelease: true });
    _setPinnedRotationWaitForTest(400);
    try {
        const rotated = await rotatePinnedStaleProxy(resident.origin);
        assert.equal(rotated, false, "listener genuinely still open ⇒ deadline, caller falls back");
        assert.equal(resident.shutdownCalls(), 1);
    } finally {
        _setPinnedRotationWaitForTest(12_000);
    }
});
