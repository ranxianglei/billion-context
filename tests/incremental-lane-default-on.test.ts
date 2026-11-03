// #3248/#5156 GA follow-up (nails the PRODUCTION default end-to-end): a fresh
// install must answer "the incremental lane is enabled" from the version's
// baked-in rollout plan alone — no BILI_ROLLOUT_* env var, no
// `rollout.features` entry in the config file, no operator action. Both escape
// hatches (file `enabled: false`, env "0") must still turn the lane off.
//
// This drives the honest production expressions instead of copies of their
// predicates: a fresh XDG root with NO config file, the real `featureEnabled` /
// `incrementalTurnsEnabled` entry points, and a real `startServer` asked through
// its real GET probe on the turn path.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest as _setRegistryForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests, incrementalTurnsEnabled } from "../src/incremental-lane.ts";
import { ROLLOUT_FEATURES, featureEnabled, resolveRollout, rolloutEnvName, rolloutInstallId } from "../src/rollout.ts";

process.env.NODE_ENV = "test";

const FEATURE = "pluginIncrementalTurns";
const ENV_VAR = rolloutEnvName(FEATURE);
const testRoot = mkdtempSync(join(tmpdir(), "bili-incr-ga-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

const KEYS = [ENV_VAR, "BILI_CONFIG_FILE", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "BILI_STORAGE_UNIFIED"];
const savedEnv = new Map<string, string | undefined>();
for (const key of KEYS) savedEnv.set(key, process.env[key]);
test.after(() => {
    for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

/** A believable fresh install: an empty config dir, so loadConfigFile() carries
 *  no `rollout` section at all — the state a new user's machine is in. */
function freshInstall(): string {
    const dir = mkdtempSync(join(testRoot, "root-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    mkdirSync(join(dir, "billion-context"), { recursive: true });
    delete process.env[ENV_VAR];
    delete process.env.BILI_CONFIG_FILE;
    return dir;
}

test("GA default: the baked-in plan ships the lane at 100%, not behind a canary", () => {
    const plan = ROLLOUT_FEATURES[FEATURE];
    assert.ok(plan !== undefined, "the feature must be registered in the version plan");
    assert.equal(plan.percent, 100, "the version plan must ship the lane at 100% (GA)");
});

test("GA default: a fresh install with no config file resolves the lane ON", () => {
    freshInstall();
    assert.equal(featureEnabled(FEATURE), true, "no operator action may be required for a fresh install");
    const decision = resolveRollout(FEATURE, { id: rolloutInstallId() });
    assert.equal(decision.enabled, true);
    assert.equal(decision.source, "bucket", "GA still resolves through the bucketing tier (100% = every bucket)");
});

test("GA default: escape hatch 1 — file `enabled: false` still turns the lane off", () => {
    const dir = freshInstall();
    writeFileSync(join(dir, "billion-context", "billion-context.json"),
        JSON.stringify({ rollout: { features: { [FEATURE]: { enabled: false } } } }), "utf8");
    assert.equal(featureEnabled(FEATURE), false, "a user who opted out must stay off");
});

test("GA default: escape hatch 2 — env \"0\" resolves off through the top tier", () => {
    freshInstall();
    process.env[ENV_VAR] = "0";
    try {
        assert.equal(featureEnabled(FEATURE), false);
        const decision = resolveRollout(FEATURE, { id: rolloutInstallId() });
        assert.equal(decision.source, "env", "the env tier is the top of the ladder");
        assert.equal(decision.enabled, false);
    } finally {
        delete process.env[ENV_VAR];
    }
});

test("GA default: the real GET probe on the turn path reports the lane enabled", async () => {
    const dir = freshInstall();
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setRegistryForTest({});
    const upstream = http.createServer((req, res) => {
        req.on("data", () => undefined);
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10, output_tokens: 1 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert.ok(addr !== null && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    try {
        assert.equal(incrementalTurnsEnabled(), true, "the effective gate must resolve the lane on for a fresh install");
        const response = await fetch(`${base}/__bili/plugin/turn`, { method: "GET", headers: { "x-bili-plugin": "dsh" } });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { enabled?: boolean; feature?: string; storage?: string };
        assert.equal(body.feature, FEATURE);
        assert.equal(body.storage, "unified", "full mode keeps the sidecar gate live");
        assert.equal(body.enabled, true, "a fresh install must see the lane enabled with no operator action");
    } finally {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        store.closeQuietly();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
});
