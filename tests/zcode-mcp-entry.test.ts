import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultZcodeRoutePolicy } from "../src/zcode/json-edit.ts";
import type { ZcodeRouteApplied } from "../src/zcode/native.ts";
import { main, zcodeWatchdogTick } from "../src/zcode/mcp-entry.ts";
import type { MutableZcodeWatchdogState, ZcodeWatchdogDeps } from "../src/zcode/mcp-entry.ts";

const ORIGIN = "http://127.0.0.1:18787";
const DRIFTED = "http://127.0.0.1:18789";
const POLICY = defaultZcodeRoutePolicy();

function appliedFor(origin: string): ZcodeRouteApplied {
    return { origin, port: Number(new URL(origin).port), kind: "new", file: "/store.json", upstream: "https://api.example.com", wrapped: [] };
}

interface TickFixture {
    state: MutableZcodeWatchdogState;
    deps: ZcodeWatchdogDeps;
    logs: string[];
    ensureCalls: Array<Parameters<NonNullable<ZcodeWatchdogDeps["ensure"]>>[0]>;
    routeOrigins: string[];
    repairCalls: string[];
    setHealthy: (h: boolean) => void;
    setEnsureOrigin: (o: string) => void;
    failRoute: (f: boolean) => void;
    setEnsureThrows: (f: boolean) => void;
}

function tickFixture(origin: string): TickFixture {
    const state: MutableZcodeWatchdogState = { origin, policy: POLICY, failures: 0 };
    const logs: string[] = [];
    const ensureCalls: TickFixture["ensureCalls"] = [];
    const routeOrigins: string[] = [];
    const repairCalls: string[] = [];
    let healthy = false;
    let ensureOrigin = origin;
    let routeFails = false;
    let ensureThrows = false;
    const deps: ZcodeWatchdogDeps = {
        probe: async () => healthy,
        ensure: async (opts) => { ensureCalls.push(opts); if (ensureThrows) throw new Error("spawn failed"); return { origin: ensureOrigin }; },
        route: async ({ origin: o }) => { if (routeFails) return undefined; routeOrigins.push(o); return appliedFor(o); },
        activate: async () => {},
        repair: async (selfOrigin) => { repairCalls.push(selfOrigin); },
        failureLimit: 3,
    };
    return {
        state, deps, logs, ensureCalls, routeOrigins, repairCalls,
        setHealthy: (h: boolean) => { healthy = h; },
        setEnsureOrigin: (o: string) => { ensureOrigin = o; },
        failRoute: (f: boolean) => { routeFails = f; },
        setEnsureThrows: (f: boolean) => { ensureThrows = f; },
    };
}

async function runTicks(fx: TickFixture, externallyOwned: boolean, n: number): Promise<void> {
    for (let i = 0; i < n; i++) await zcodeWatchdogTick(fx.state, externallyOwned, fx.deps, (m) => fx.logs.push(m));
}

test("healthy tick resets the failure counter without any recovery", async () => {
    const fx = tickFixture(ORIGIN);
    await runTicks(fx, false, 2);
    assert.equal(fx.state.failures, 2);
    fx.setHealthy(true);
    await runTicks(fx, false, 1);
    assert.equal(fx.state.failures, 0);
    assert.equal(fx.ensureCalls.length, 0);
});

test("below-limit failures never trigger recovery but still repair the store", async () => {
    const fx = tickFixture(ORIGIN);
    await runTicks(fx, false, 2);
    assert.equal(fx.ensureCalls.length, 0);
    assert.deepEqual(fx.repairCalls, [ORIGIN, ORIGIN]);
});

test("third consecutive failure respawns a dead lane proxy (#1821)", async () => {
    const savedPort = process.env.BILI_ZCODE_PORT;
    delete process.env.BILI_ZCODE_PORT;
    try {
        const fx = tickFixture(ORIGIN);
        await runTicks(fx, false, 3);
        assert.equal(fx.ensureCalls.length, 1);
        const opts = fx.ensureCalls[0];
        assert.equal(opts.host, "127.0.0.1");
        assert.equal(opts.port, 0);
        assert.equal(opts.strictPort, false);
        assert.equal(opts.lane, "zcode");
        assert.equal(opts.passthrough, false);
        // same-origin recovery: no re-route, counter reset
        assert.equal(fx.routeOrigins.length, 0);
        assert.equal(process.env.BILI_MCP_PROXY, undefined);
        assert.equal(fx.state.failures, 0);
        assert.ok(fx.logs.some((l) => l.includes("recovered without a re-route")));
    } finally {
        if (savedPort === undefined) delete process.env.BILI_ZCODE_PORT; else process.env.BILI_ZCODE_PORT = savedPort;
    }
});

test("an explicit BILI_ZCODE_PORT pin stays strict on respawn", async () => {
    const saved = process.env.BILI_ZCODE_PORT;
    process.env.BILI_ZCODE_PORT = "18801";
    try {
        const fx = tickFixture(ORIGIN);
        await runTicks(fx, false, 3);
        assert.equal(fx.ensureCalls.length, 1);
        assert.equal(fx.ensureCalls[0].port, 18801);
        assert.equal(fx.ensureCalls[0].strictPort, true);
    } finally {
        if (saved === undefined) delete process.env.BILI_ZCODE_PORT; else process.env.BILI_ZCODE_PORT = saved;
    }
});

test("origin drift re-routes the config and follows the new origin (#1821)", async () => {
    const savedProxy = process.env.BILI_MCP_PROXY;
    delete process.env.BILI_MCP_PROXY;
    try {
        const fx = tickFixture(ORIGIN);
        fx.setEnsureOrigin(DRIFTED);
        await runTicks(fx, false, 3);
        assert.equal(fx.state.origin, DRIFTED);
        assert.equal(process.env.BILI_MCP_PROXY, DRIFTED);
        assert.deepEqual(fx.routeOrigins, [DRIFTED]);
        assert.ok(fx.logs.some((l) => l.includes("config re-routed")));
    } finally {
        if (savedProxy === undefined) delete process.env.BILI_MCP_PROXY; else process.env.BILI_MCP_PROXY = savedProxy;
    }
});

test("a failed config rewrite throws so the watchdog error surfaces", async () => {
    const fx = tickFixture(ORIGIN);
    fx.setEnsureOrigin(DRIFTED);
    fx.failRoute(true);
    await assert.rejects(runTicks(fx, false, 3), /config rewrite failed/);
});

test("#3813: a throwing ensure leaves the counter hot — the next tick retries immediately", async () => {
    const fx = tickFixture(ORIGIN);
    fx.setEnsureThrows(true);
    // Ticks 1-2 accumulate below the limit; tick 3 reaches it and the failing
    // bring-up must NOT cool the counter (pre-fix code reset before ensure,
    // costing ~90s of re-accumulation before retrying).
    await assert.rejects(runTicks(fx, false, 3), /spawn failed/);
    assert.equal(fx.state.failures, 2, "counter stays hot (limit-1) when the bring-up throws, not reset to 0");
    await assert.rejects(zcodeWatchdogTick(fx.state, false, fx.deps, (m) => fx.logs.push(m)), /spawn failed/);
    assert.equal(fx.ensureCalls.length, 2, "immediate retry on the next tick");
});

test("externally-owned attach posture never respawns — it waits (#1821)", async () => {
    const fx = tickFixture(ORIGIN);
    await runTicks(fx, true, 6);
    assert.equal(fx.ensureCalls.length, 0);
    assert.ok(fx.logs.some((l) => l.includes("user-owned attach posture")));
    assert.equal(fx.repairCalls.length, 6);
    assert.equal(fx.state.failures, 0);
});

test("#4006: without an injected failureLimit the tick resolves the knob live (env tier)", async () => {
    const savedLimit = process.env.BILI_WATCHDOG_FAILURE_LIMIT;
    const savedCfg = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = "/nonexistent/bili-zcode-watchdog-test.json";
    process.env.BILI_WATCHDOG_FAILURE_LIMIT = "2";
    try {
        const fx = tickFixture(ORIGIN);
        fx.deps = { ...fx.deps, failureLimit: undefined };
        await runTicks(fx, false, 1);
        assert.equal(fx.ensureCalls.length, 0, "first failure accumulates under limit 2");
        await runTicks(fx, false, 1);
        assert.equal(fx.ensureCalls.length, 1, "second consecutive failure respawns");
        assert.equal(fx.state.failures, 0);
        delete process.env.BILI_WATCHDOG_FAILURE_LIMIT;
        const fx2 = tickFixture(ORIGIN);
        fx2.deps = { ...fx2.deps, failureLimit: undefined };
        await runTicks(fx2, false, 2);
        assert.equal(fx2.ensureCalls.length, 0, "env unset → built-in default limit 3 still accumulates");
    } finally {
        if (savedLimit === undefined) delete process.env.BILI_WATCHDOG_FAILURE_LIMIT; else process.env.BILI_WATCHDOG_FAILURE_LIMIT = savedLimit;
        if (savedCfg === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = savedCfg;
    }
});

test("main() short-circuits under NODE_TEST_CONTEXT", async () => {
    assert.notEqual(process.env.NODE_TEST_CONTEXT, undefined);
    await main();
});
