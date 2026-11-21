// #6881: dsh host restart race — a new host (H2) attached to the old proxy (P1)
// while P1 was in its 5s idle-grace tail (listener already closed, established
// keep-alive connections still answering). register.base then pointed at a dead
// address, and the register could never self-heal:
//   1) the recovery timer only re-fetched the manifest (backoff 10→20→40s) and
//      never respawned — maybeRetry's respawn branch only runs when
//      register.base is undefined, so a dead-but-set base re-fetched the dead
//      manifest on every tick;
//   2) the first model request then rode wire mode (plugin headers computed
//      pre-send to the dead addr, tools not yet registered) into a new
//      ANONYMOUS session, and the proxy ran preflight on the raw history before
//      a 413;
//   3) after a respawn finally landed, the old base's backoff (retryAt/failStreak)
//      carried into the new world, gating the new base's first registration.
//
// This suite pins the self-heal:
//   A) a manifest failure against a base that no longer accepts connections
//      (a draining instance's closed listener) clears the dead base so the
//      respawn branch re-bases onto a replacement — and the fresh-spawn landing
//      clears the old base's backoff so the new base's first registration is not
//      gated behind the dead base's wall. A BUSY base (accept queue still drains)
//      is NOT cleared (the #3654/#4811 keep is preserved).
//   B) a registry entry stamped portReleasedAt (draining: listener closed, pid
//      still alive) does not surface as a live attach candidate.
//   C) the session-watcher registration result (ok/failed/refused) is logged on
//      the host-safe attach channel — it was invisible in bili.log before.

import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// The module-level guard reads NODE_TEST_CONTEXT while the module EVALUATES,
// and static imports hoist above any assignment — so the value must be set
// first and the modules loaded dynamically (same discipline as the #3654 suite).
process.env.NODE_TEST_CONTEXT = "1";
delete process.env.BILLION_CONTEXT_ATTACH;
delete process.env.BILLION_CONTEXT_PROXY;

const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6881-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

const dsh = await import("../src/agent/dsh-native.ts");
const { discoverLiveInstances, registerInstanceAndWarn, markPortReleased } = await import("../src/instance.ts");
const { ensureProxyRunning } = await import("../src/launcher.ts");
import type { SpawnChild } from "../src/launcher.ts";
import { rmrf } from "./tmp-rm.ts";

afterEach(() => { void dsh._settleNativeForTest(); });

type MockTool = { name: string; description?: string; inputSchema: Record<string, unknown> };
type RegisteredTool = {
    name: string;
    description?: string;
    parameters: unknown;
    output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    execute: (args: Record<string, unknown>, exec: { agent?: { session?: { id?: unknown } }; signal?: AbortSignal }) => Promise<unknown>;
};

/** A mock bili proxy: /__bili/health always answers ok (so the attach health
 *  gate passes); /__bili/plugin/manifest answers 200 with a valid version but
 *  with `hasTools` controlling whether the anthropic tool list is empty. An
 *  empty tool list makes fetchManifest throw (so registerTools fails) while
 *  fetchProxyVersion still returns the version (so verifyAttachAndRecover
 *  attaches instead of falling back to a spawn). */
function mockBiliHandler(counters: { manifestRequests: number }, hasTools: boolean): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    const manifestTools: MockTool[] = [
        { name: "compress", description: "Compress a range of messages", inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
    ];
    return (req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, instanceId: "inst-6881", pid: process.pid }));
            return;
        }
        if (url === "/__bili/plugin/manifest") {
            counters.manifestRequests += 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                // 999.999.999 is deliberately far newer than the running build:
                // isVersionNewer(VERSION, "999.999.999") is false, so
                // verifyAttachAndRecover ATTACHES (not rotate-and-spawn).
                version: "999.999.999",
                tools: { anthropic: hasTools ? manifestTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) : [] },
            }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    };
}

async function startMockProxy(hasTools: boolean): Promise<{ origin: string; close: () => void; manifestRequests: () => number }> {
    const counters = { manifestRequests: 0 };
    const server = http.createServer(mockBiliHandler(counters, hasTools));
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => server.close(), manifestRequests: () => counters.manifestRequests });
        });
    });
}

type HostCtx = Parameters<typeof dsh.apply>[0];

function mockCtx() {
    const tools: RegisteredTool[] = [];
    const commands: Array<{ name: string; handler: () => Promise<{ kind: string; text: string }> }> = [];
    let initiator: { session?: { id?: unknown } } | undefined = undefined;
    return {
        tools: { register: (t: RegisteredTool) => { tools.push(t); } },
        commands: { register: (c: { name: string; handler: () => Promise<{ kind: string; text: string }> }) => commands.push(c) },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown } } | undefined) => (initiator = i),
        registeredTools: tools,
        registeredCommands: commands,
        inject: (_deps: readonly string[], _cb: (sub: HostCtx) => void) => {},
    };
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
        saved[k] = process.env[k];
        const v = env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 15000;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

// ———— A) dead-base self-heal + backoff clearing on a fresh-spawn landing ————

test("A: a manifest failure against a base that stopped accepting connections clears the dead base and respawns; the landing clears the old backoff (#6881)", async () => {
    // P1: healthy (health ok, version ok) but the manifest serves no tools —
    // so the register backs off (failStreak/retryAt) while the base is still
    // connectable (Fix #2 must NOT clear it yet). P2: fully healthy.
    const proxy1 = await startMockProxy(false);
    const proxy2 = await startMockProxy(true);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-6881-"));
    try {
        await withEnv({
            DSH_HOME: home,
            BILLION_CONTEXT_PROXY: proxy1.origin,
            BILI_DSH_RECOVERY_INTERVAL_MS: "20",
            BILI_DSH_RETRY_INTERVAL_MS: "20",
        }, async () => {
            dsh._resetRegisterForTest(proxy1.origin, false);
            const ctx = mockCtx();
            dsh.apply(ctx);
            // phase 1: the base is connectable but the manifest fails — the
            // register backs off (failStreak=1, retryAt armed) and the base is
            // KEPT (a refused connect, not a 500, is what clears it).
            // failStreak is set before the await tcpConnectable; retryAt is set
            // after it — wait for both so the assertion reads a settled state.
            await waitFor(() => dsh._registerStateForTest().failStreak === 1 && dsh._registerStateForTest().retryAt > 0, "first failed registration backs off");
            const st = dsh._registerStateForTest();
            assert.equal(st.base, proxy1.origin, "a connectable base is not cleared by a manifest failure (the #3654 BUSY keep)");
            assert.ok(st.retryAt > 0, "the backoff is armed against the connectable base");

            // phase 2: the base dies (listener closed — the draining tail). The
            // next manifest failure now probes the base, finds it unconnectable,
            // and clears it so the respawn branch re-bases onto the replacement.
            proxy1.close();
            let attempts = 0;
            dsh._setSpawnForTest(() => {
                attempts += 1;
                return Promise.resolve(proxy2.origin);
            });
            try {
                await waitFor(() => dsh._registerStateForTest().base === proxy2.origin, "timer-driven re-base onto the replacement after the dead base is cleared");
                assert.equal(dsh._nativeStateForTest().origin, proxy2.origin, "interceptor origin follows the healed base");
                assert.ok(attempts >= 1, "the respawn drove the stubbed spawn");
                // the fresh-spawn landing cleared the old base's backoff — the
                // new base's first registration is not gated behind the dead
                // base's wall (the incident's backoff carried into the new world).
                assert.equal(dsh._registerStateForTest().retryAt, 0, "the old base's backoff does not carry into the new world");
                assert.equal(dsh._registerStateForTest().failStreak, 0, "the old base's fail streak does not carry into the new world");
                await waitFor(() => ctx.registeredTools.length === 1, "tool registration against the replacement");
                // churn pin: once healthy again the timer must clear itself.
                const settledManifest = proxy2.manifestRequests();
                const settledAttempts = attempts;
                await new Promise((r) => setTimeout(r, 150));
                assert.equal(attempts, settledAttempts, "no background respawn churn after the heal");
                assert.equal(proxy2.manifestRequests(), settledManifest, "no background re-registration after the heal");
            } finally {
                dsh._setSpawnForTest(undefined);
            }
        });
    } finally {
        proxy1.close();
        proxy2.close();
        rmrf(home);
        dsh._resetRegisterForTest(undefined);
    }
});

test("A-neg: a BUSY base (connectable, manifest still failing) is NOT cleared — the #3654/#4811 keep is preserved", async () => {
    // A base that accepts connections (TCP connect succeeds) but whose manifest
    // fetch keeps failing (no tools) must stay in place — clearing it would
    // respawn a second writer over a live (saturated) incumbent.
    const proxy1 = await startMockProxy(false);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-6881-busy-"));
    try {
        await withEnv({
            DSH_HOME: home,
            BILLION_CONTEXT_PROXY: proxy1.origin,
            BILI_DSH_RECOVERY_INTERVAL_MS: "20",
            BILI_DSH_RETRY_INTERVAL_MS: "20",
        }, async () => {
            dsh._resetRegisterForTest(proxy1.origin, false);
            dsh.apply(mockCtx());
            await waitFor(() => dsh._registerStateForTest().failStreak === 2, "two failed registrations back off");
            // the base is still connectable (the accept queue drains) — it must
            // NOT be cleared into a respawn; it stays and keeps backing off.
            assert.equal(dsh._registerStateForTest().base, proxy1.origin, "a connectable (BUSY) base is kept, not cleared");
            assert.ok(dsh._registerStateForTest().retryAt > 0, "the backoff keeps escalating against the BUSY base");
        });
    } finally {
        proxy1.close();
        rmrf(home);
        dsh._resetRegisterForTest(undefined);
    }
});

// ———— B) a draining registry entry (portReleasedAt) is not a live candidate —

test("B: a registry entry stamped portReleasedAt (draining) is skipped by discovery (#6881/#4982)", () => {
    const st = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6881-reg-"));
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = st;
    try {
        registerInstanceAndWarn(
            { instanceId: "live-6881", pid: process.pid, port: 1, origin: "http://127.0.0.1:1", startedAt: 1, lane: "dsh" },
            () => {},
        );
        registerInstanceAndWarn(
            { instanceId: "draining-6881", pid: process.pid, port: 2, origin: "http://127.0.0.1:2", startedAt: 2, lane: "dsh" },
            () => {},
        );
        // the draining instance's listener closed — its port claim is withdrawn
        // but its pid still lives (the drain outlives the release).
        markPortReleased("draining-6881");
        const live = discoverLiveInstances();
        const ids = live.map((e) => e.instanceId);
        assert.ok(ids.includes("live-6881"), "a live (unreleased) entry still surfaces");
        assert.ok(!ids.includes("draining-6881"), "a draining (portReleasedAt) entry must not surface as a live attach candidate");
    } finally {
        if (prev === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prev;
        fs.rmSync(st, { recursive: true, force: true });
    }
});

// ———— C) the watcher registration result is logged on the host-safe channel —

test("C: the session-watcher registration result (ok/failed) is logged via the host-safe attach channel (#6881)", async () => {
    const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-6881-${process.pid}.js`);
    fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
    const { entryScriptFingerprint } = await import("../src/instance.ts");
    const FP = entryScriptFingerprint(FP_SCRIPT);
    assert.ok(FP !== undefined, "fixture script must fingerprint");
    const TWIN_ORIGIN = "http://127.0.0.1:18916";
    const inst = {
        origin: TWIN_ORIGIN,
        instanceId: "inst-6881",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 18916,
        passthrough: false,
        mitmDomains: [] as string[],
        modelWindows: {} as Record<string, number>,
        lane: "dsh",
        codeFingerprint: FP,
    };

    async function runCase(watcherResult: "ok" | "failed"): Promise<string[]> {
        const diag: string[] = [];
        const pending = ensureProxyRunning(
            { host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "dsh" },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async (origin) => (origin === TWIN_ORIGIN ? { ok: true, instanceId: "inst-6881", watchdog: { armed: true } } : undefined),
                readInstanceFile: () => inst,
                listRegistryInstances: () => [],
                spawnImpl: (_cmd: string, _args: readonly string[]): SpawnChild => { throw new Error("no spawn in this case"); },
                now: () => Date.now(),
                sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
                registerWatcher: async () => watcherResult,
                attachDiag: (msg) => { diag.push(msg); },
                scriptPath: FP_SCRIPT,
                listAdoptCandidates: () => [],
                isConnectable: async () => true,
            },
        );
        const handle = await pending.then((h) => h, () => undefined);
        assert.notEqual(handle, undefined, "the case must attach to a running proxy");
        assert.equal(handle?.attached, true, "the case must attach (not spawn)");
        return diag;
    }

    const okDiag = await runCase("ok");
    assert.ok(okDiag.some((d) => d.includes("session-watcher registered") && d.includes("lifecycle watchdog active")), `the ok result must be logged: ${JSON.stringify(okDiag)}`);

    const failedDiag = await runCase("failed");
    assert.ok(failedDiag.some((d) => d.includes("session-watcher registration FAILED") && d.includes("lifecycle watchdog NOT active")), `the failed result must be logged: ${JSON.stringify(failedDiag)}`);
});
