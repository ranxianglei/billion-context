import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { parseCompressSettings } from "../src/config.ts";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("embedded Web client is valid JavaScript", () => {
    assert.doesNotThrow(() => new Function(WEB_CLIENT));
});

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

test("Web UI exposes upstream controls without inline handlers", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-web-routing-${process.pid}-${Date.now()}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");

    const previous = {
        config: process.env.BILI_CONFIG_FILE,
    };
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
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        const ui = await (await fetch(`${base}/__bili/`)).text();
        assert.match(ui, /Codex（ChatGPT 登录）/);
        assert.match(ui, /上游网络/);
        assert.match(ui, /Fork me on GitHub/);
        assert.match(ui, /addEventListener/);
        assert.doesNotMatch(ui, /\sonclick=/i);
        assert.match(ui, /escapeHtml/);

        const saveProxy = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ upstreamProxyMode: "manual", upstreamProxy: "http://127.0.0.1:9999" }),
        });
        assert.equal(saveProxy.status, 200);
        const config = await (await fetch(`${base}/__bili/config`)).json() as { upstreamProxy: string; upstreamProxyMode: string };
        assert.equal(config.upstreamProxy, "http://127.0.0.1:9999");
        assert.equal(config.upstreamProxyMode, "manual");
        const upstream = await (await fetch(`${base}/__bili/upstream`)).json() as { proxy: string; source: string };
        assert.equal(upstream.proxy, "http://127.0.0.1:9999/");
        assert.equal(upstream.source, "web-manual");

    } finally {
        await close(proxy);
        if (previous.config === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous.config;
        rmSync(root, { recursive: true, force: true });
    }
});

test("PUT /__bili/config with providers takes effect without a separate reload call", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-put-providers-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
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
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        const providers = { "https://api.example.com/v1": { models: { "gpt-test": { context: 123456 } } } };
        const put = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ providers }),
        });
        assert.equal(put.status, 200);
        const after = await (await fetch(`${base}/__bili/config`)).json() as { providers: Record<string, unknown> };
        assert.deepEqual(after.providers, providers, "providers saved and visible after PUT without /reload");
    } finally {
        await close(proxy);
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
        rmSync(root, { recursive: true, force: true });
    }
});

test("parseCompressSettings round-trips prompts overrides (#155 + #157 interplay)", () => {
    const withPrompts = {
        nudgeGrowthTokens: 4000,
        acknowledgePromptsRisk: true,
        prompts: {
            compressPhilosophy: "custom philosophy",
            howToCompressRules: "custom rules",
        },
    };
    assert.deepEqual(parseCompressSettings(withPrompts), withPrompts);
    // Full four-field prompts object passes through.
    const full = {
        prompts: {
            compressPhilosophy: "p",
            howToCompressRules: "r",
            tier2DistillRules: "t2",
            tier3CondenseRules: "t3",
        },
    };
    assert.deepEqual(parseCompressSettings(full), full);
    // Prompts without the risk acknowledgement are still stored (the gate is
    // enforced at resolve time, not by the parser).
    assert.deepEqual(parseCompressSettings({ prompts: { compressPhilosophy: "x" } }), { prompts: { compressPhilosophy: "x" } });
    // Malformed prompts are rejected, not silently dropped.
    assert.equal(parseCompressSettings({ prompts: { compressPhilosophy: 42 } }), undefined);
    assert.equal(parseCompressSettings({ prompts: { unknownKey: "x" } }), undefined);
    assert.equal(parseCompressSettings({ prompts: { compressPhilosophy: "   " } }), undefined);
    assert.equal(parseCompressSettings({ prompts: "not an object" }), undefined);
    assert.equal(parseCompressSettings({ acknowledgePromptsRisk: "yes" }), undefined);
    // Regression: saving unrelated compress fields from the web UI must not
    // strip prompts that live in the config file (PUT validates the whole
    // block, so prompts must be accepted here, not dropped).
    const mixed = { tiers: true, prompts: { tier2DistillRules: "t2" }, acknowledgePromptsRisk: true };
    assert.deepEqual(parseCompressSettings(mixed), mixed);
});

test("parseCompressSettings accepts tuned fields and rejects malformed ones", () => {
    assert.deepEqual(parseCompressSettings({
        modelContextLimit: "70%",
        maxContextLimit: 0.8,
        emergencyThresholdPercent: "95%",
        nudgeGrowthTokens: 4000,
        preserveRecentMessages: 6,
        preserveRecentTokens: 2000,
        minCompressRange: 1000,
        tiers: true,
    }), {
        modelContextLimit: "70%",
        maxContextLimit: 0.8,
        emergencyThresholdPercent: "95%",
        nudgeGrowthTokens: 4000,
        preserveRecentMessages: 6,
        preserveRecentTokens: 2000,
        minCompressRange: 1000,
        tiers: true,
    });
    assert.equal(parseCompressSettings(null), undefined);
    assert.equal(parseCompressSettings("x"), undefined);
    assert.equal(parseCompressSettings({ nudgeGrowthTokens: "lots" }), undefined);
    assert.equal(parseCompressSettings({ tiers: "yes" }), undefined);
    assert.equal(parseCompressSettings({ modelContextLimit: "seventy percent" }), undefined);
    assert.deepEqual(parseCompressSettings({}), {});
    // Injection toggles are file-level fields shown in the web UI — they must
    // round-trip, and malformed ones are rejected like every other field.
    assert.deepEqual(parseCompressSettings({ injectTool: false, injectNudge: true }), { injectTool: false, injectNudge: true });
    assert.deepEqual(parseCompressSettings({ injectTool: false, nudgeGrowthTokens: 4000 }), { injectTool: false, nudgeGrowthTokens: 4000 });
    assert.equal(parseCompressSettings({ injectTool: "no" }), undefined);
    assert.equal(parseCompressSettings({ injectNudge: 1 }), undefined);
});

test("#154: PUT /__bili/config with compress hot-applies the global compress block", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-put-compress-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
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
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        const ui = await (await fetch(`${base}/__bili/`)).text();
        assert.match(ui, /compress-json/);
        assert.match(ui, /save-compress/);

        const before = await (await fetch(`${base}/__bili/config`)).json() as { compress: unknown };
        assert.equal(before.compress, null);

        const bad = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ compress: { nudgeGrowthTokens: "fast" } }),
        });
        assert.equal(bad.status, 400);

        const tuned = { modelContextLimit: 200_000, maxContextLimit: "75%", preserveRecentMessages: 4 };
        const put = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ compress: tuned }),
        });
        assert.equal(put.status, 200);

        const after = await (await fetch(`${base}/__bili/config`)).json() as { compress: typeof tuned };
        assert.deepEqual(after.compress, tuned);

        const cleared = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ compress: null }),
        });
        assert.equal(cleared.status, 200);
        const final = await (await fetch(`${base}/__bili/config`)).json() as { compress: unknown };
        assert.equal(final.compress, null);
    } finally {
        await close(proxy);
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
        rmSync(root, { recursive: true, force: true });
    }
});

// Regression: the file's compress block may carry the global injection
// toggles (injectTool / injectNudge — FileConfig.compress, honored by
// loadOptions via `=== false`). GET returns the raw file block, so the web
// UI's compress textarea shows them, and an unchanged save must round-trip
// them: dropping them silently flips injectTool:false back to the enabled
// default on the next loadOptions().
test("compress round-trip preserves injectTool/injectNudge injection toggles", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-put-toggles-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    const toggles = { injectTool: false, nudgeGrowthTokens: 4000 };
    writeFileSync(biliConfig, JSON.stringify({ providers: {}, compress: toggles }) + "\n", "utf8");
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
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        // UI flow: GET shows the file block (incl. the toggles); "save" sends
        // the textarea content back unchanged.
        const before = await (await fetch(`${base}/__bili/config`)).json() as { compress: Record<string, unknown> };
        assert.deepEqual(before.compress, toggles);
        const put = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ compress: before.compress }),
        });
        assert.equal(put.status, 200);
        const fileAfter = JSON.parse(readFileSync(biliConfig, "utf8")) as { compress: unknown };
        assert.deepEqual(fileAfter.compress, toggles, "unchanged web save must not strip injectTool from the file");
        const after = await (await fetch(`${base}/__bili/config`)).json() as { compress: unknown };
        assert.deepEqual(after.compress, toggles);
    } finally {
        await close(proxy);
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
        rmSync(root, { recursive: true, force: true });
    }
});

test("PUT /__bili/config refuses to overwrite a config file that does not parse", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-put-broken-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    // Hand-edited file with a trailing comma — JSON.parse fails, the loader
    // sees {}. A PUT must NOT rebuild from {} (that would silently drop the
    // user's modelContextLimit etc.); it must 409 until the syntax is fixed.
    writeFileSync(biliConfig, '{"providers":{},"modelContextLimit":333000,}\n', "utf8");
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
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        const get1 = await (await fetch(`${base}/__bili/config`)).json() as { parseError?: string };
        assert.ok(get1.parseError, "GET surfaces parseError for a broken file");
        assert.match(get1.parseError, /not valid JSON/);

        const put = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ providers: {} }),
        });
        assert.equal(put.status, 409);
        const err = await put.json() as { error: string };
        assert.match(err.error, /not valid JSON/);
        // File untouched on disk.
        assert.match(readFileSync(biliConfig, "utf8"), /modelContextLimit/);

        // User fixes the syntax by hand → PUT works again and preserves fields.
        writeFileSync(biliConfig, '{"providers":{},"modelContextLimit":333000}\n', "utf8");
        const put2 = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ providers: { "https://api.example.com": {} } }),
        });
        assert.equal(put2.status, 200);
        const after = readFileSync(biliConfig, "utf8");
        assert.match(after, /modelContextLimit/, "pre-existing fields survive the PUT");
        const get2 = await (await fetch(`${base}/__bili/config`)).json() as { parseError?: string; providers: Record<string, unknown> };
        assert.equal(get2.parseError, undefined);
        assert.ok(get2.providers["https://api.example.com"]);
    } finally {
        await close(proxy);
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
        rmSync(root, { recursive: true, force: true });
    }
});
