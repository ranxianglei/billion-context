import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { loadOptions, parseNudgeGrowthTokens, type ProxyOptions } from "../src/config.ts";
import { diagNudge, startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

/** Load options with a temp config file whose contents are `json`. */
function loadWithConfig(json: string, env: Record<string, string> = {}): ProxyOptions {
    const root = path.join(tmpdir(), `bili-nudge-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(root, { recursive: true });
    const file = path.join(root, "billion-context.json");
    writeFileSync(file, json, "utf8");
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = file;
    try {
        return loadOptions(env);
    } finally {
        if (prev === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prev;
        rmSync(root, { recursive: true, force: true });
    }
}

test("unset nudgeGrowthTokens keeps acp-kernel adaptive default unchanged", () => {
    const opts = loadWithConfig("{}");
    const base = defaultConfig(opts.modelContextLimit);
    assert.equal(opts.nudgeGrowthTokens, undefined);
    assert.deepEqual(opts.kernelConfig.nudge, base.nudge, "nudge block must be byte-identical to acp-kernel default");
    assert.deepEqual(opts.kernelConfig, base, "whole kernel config must match default when unset");
});

test("config compress.nudgeGrowthTokens=200000 sets growthFloor=growthCap=200000", () => {
    const opts = loadWithConfig('{"compress":{"nudgeGrowthTokens":200000}}');
    assert.equal(opts.nudgeGrowthTokens, 200000);
    assert.equal(opts.nudgeGrowthTokensSource, "config");
    assert.equal(opts.kernelConfig.nudge.growthFloor, 200000);
    assert.equal(opts.kernelConfig.nudge.growthCap, 200000);
});

test("env ACP_NUDGE_GROWTH_TOKENS overrides config file", () => {
    const opts = loadWithConfig('{"compress":{"nudgeGrowthTokens":50000}}', { ACP_NUDGE_GROWTH_TOKENS: "200000" });
    assert.equal(opts.nudgeGrowthTokens, 200000);
    assert.equal(opts.nudgeGrowthTokensSource, "env");
    assert.equal(opts.kernelConfig.nudge.growthFloor, 200000);
    assert.equal(opts.kernelConfig.nudge.growthCap, 200000);
});

test("invalid nudgeGrowthTokens values are hard config errors", () => {
    for (const [label, value] of [
        ["0", "0"],
        ["negative", "-1"],
        ["NaN", "NaN"],
        ["Infinity", "Infinity"],
        ["string", "abc"],
        ["fractional", "1.5"],
    ] as const) {
        assert.throws(
            () => parseNudgeGrowthTokens(value, "env"),
            /invalid env ACP_NUDGE_GROWTH_TOKENS/,
            `${label} must be rejected`,
        );
    }
    assert.throws(() => loadWithConfig('{"compress":{"nudgeGrowthTokens":0}}'), /invalid compress\.nudgeGrowthTokens/);
    assert.throws(() => loadWithConfig("{}", { ACP_NUDGE_GROWTH_TOKENS: "-1" }), /invalid env ACP_NUDGE_GROWTH_TOKENS/);
});

test("empty-string nudgeGrowthTokens is treated as unset (returns undefined)", () => {
    assert.equal(parseNudgeGrowthTokens("", "env"), undefined);
    assert.equal(parseNudgeGrowthTokens("   ", "config"), undefined);
    assert.equal(parseNudgeGrowthTokens(undefined, undefined), undefined);
});

test("emergencyThresholdPct and every other nudge default survive the override", () => {
    const base = defaultConfig(200000);
    const opts = loadWithConfig('{"compress":{"nudgeGrowthTokens":200000}}', { ACP_MODEL_CONTEXT_LIMIT: "200000" });
    const baseNudge = base.nudge;
    const cfgNudge = opts.kernelConfig.nudge;
    assert.equal(cfgNudge.emergencyThresholdPct, baseNudge.emergencyThresholdPct, "emergency must never change");
    assert.equal(cfgNudge.maxContextLimitPct, baseNudge.maxContextLimitPct);
    assert.equal(cfgNudge.minContextLimitPct, baseNudge.minContextLimitPct);
    assert.equal(cfgNudge.frequency, baseNudge.frequency);
    assert.equal(cfgNudge.iterationThreshold, baseNudge.iterationThreshold);
    assert.equal(cfgNudge.force, baseNudge.force);
    assert.equal(cfgNudge.growthRatio, baseNudge.growthRatio);
    assert.equal(cfgNudge.minGrowthFloor, baseNudge.minGrowthFloor);
    assert.equal(cfgNudge.minGrowthRatio, baseNudge.minGrowthRatio);
    // Only growthFloor/growthCap may differ.
    assert.equal(cfgNudge.growthFloor, 200000);
    assert.equal(cfgNudge.growthCap, 200000);
});

test("model-specific context override keeps the fixed nudge interval", () => {
    const opts = loadWithConfig('{"compress":{"nudgeGrowthTokens":200000}}');
    // server.ts builds reqConfig = { ...config, modelContextLimit: limit } for
    // per-request model windows. The spread keeps the nudge sub-object, so the
    // user's fixed interval must survive any modelContextLimit.
    for (const limit of [258000, 400000, 1000000]) {
        const reqConfig = { ...opts.kernelConfig, modelContextLimit: limit };
        assert.equal(reqConfig.nudge.growthFloor, 200000, `floor must survive modelContextLimit=${limit}`);
        assert.equal(reqConfig.nudge.growthCap, 200000, `cap must survive modelContextLimit=${limit}`);
        assert.equal(reqConfig.nudge.emergencyThresholdPct, 0.8, "emergency must survive");
    }
});

test("diagNudge uses breakdown nudgeGrowthTokens as the denominator", () => {
    const turn = {
        nudge: {
            shouldInject: false,
            reason: "idle",
            contextUsage: 0.5,
            tier: null,
            breakdown: {
                growth: 31667,
                pendingT1: 7766,
                nudgeGrowthTokens: 200000,
                growthReference: 100,
                growthFloor: 20000,
            },
        },
    };
    const line = diagNudge(turn, "sess-1", 100000, 200000);
    assert.match(line, /growth=31667\/200000/, "growth denominator must be nudgeGrowthTokens");
    assert.match(line, /pendingT1=7766\/200000/, "pendingT1 denominator must be nudgeGrowthTokens");
    assert.match(line, /interval=200000/);
});

test("PUT /__bili/config hot-reloads kernelConfig (20000 → 200000)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-nudge-put-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"compress":{"nudgeGrowthTokens":20000}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        nudgeGrowthTokens: 20000,
        nudgeGrowthTokensSource: "config",
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        updateMode: "auto",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        const put = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ nudgeGrowthTokens: 200000 }),
        });
        assert.equal(put.status, 200);
        // The PUT callback mutates the shared opts object in place, so the very
        // next request sees the new interval — no restart required.
        assert.equal(opts.nudgeGrowthTokens, 200000, "opts.nudgeGrowthTokens hot-reloaded");
        assert.equal(opts.kernelConfig.nudge.growthFloor, 200000, "kernelConfig hot-reloaded");
        assert.equal(opts.kernelConfig.nudge.growthCap, 200000);
        assert.equal(opts.kernelConfig.nudge.emergencyThresholdPct, 0.8, "emergency survives hot reload");
        const readback = await (await fetch(`${base}/__bili/config`)).json() as { nudgeGrowthTokens: number };
        assert.equal(readback.nudgeGrowthTokens, 200000);
    } finally {
        await close(proxy);
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
        rmSync(root, { recursive: true, force: true });
    }
});

test("POST /__bili/config/reload hot-reloads kernelConfig from the config file", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-nudge-reload-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"compress":{"nudgeGrowthTokens":200000}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000), // stale: interval not yet applied
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        updateMode: "auto",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        const reload = await fetch(`${base}/__bili/config/reload`, { method: "POST" });
        assert.equal(reload.status, 200);
        assert.equal(opts.kernelConfig.nudge.growthFloor, 200000, "reload applied nudgeGrowthTokens");
        assert.equal(opts.kernelConfig.nudge.growthCap, 200000);
        assert.equal(opts.kernelConfig.nudge.emergencyThresholdPct, 0.8);
    } finally {
        await close(proxy);
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
        rmSync(root, { recursive: true, force: true });
    }
});
