import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import { agentProviderRecipes, parseAgentProviderReport, recordAgentProviders } from "../src/agent-providers.js";
import { reportAgentProviders, type Ctx } from "../src/agent/pi.js";

const recipe = { baseUrl: "https://provider.fixture.invalid/v1", api: "openai", apiKey: "fixture-memory-key", models: { sample: {} } };
async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "bili-empty-agent-report-"));
    const oldConfig = process.env.BILI_CONFIG_FILE;
    const oldProxy = process.env.BILLION_CONTEXT_PROXY;
    process.env.BILI_CONFIG_FILE = join(dir, "config.json");
    writeFileSync(process.env.BILI_CONFIG_FILE, "{}");
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const server = await startServer({ upstream: "http://127.0.0.1:1", routes: {}, proxy: "", proxyMode: "direct", proxySource: "direct", modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000), compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] }, port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.BILLION_CONTEXT_PROXY = base;
    const post = (body: unknown) => fetch(base + "/__bili/agent-providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { base, post, close: async () => {
        recordAgentProviders("empty-report-pi", {});
        recordAgentProviders("empty-report-peer", {});
        if (oldConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = oldConfig;
        if (oldProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = oldProxy;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
    } };
}

test("an explicit empty provider snapshot parses as a clear for its named agent", () => {
    assert.deepEqual(parseAgentProviderReport({ agent: "empty-report-pi", providers: {} }), { agent: "empty-report-pi", registered: {}, skipped: [] });
});

test("empty is distinct from missing or malformed provider envelopes", () => {
    for (const providers of [undefined, null, [], "none"]) {
        assert.throws(() => parseAgentProviderReport({ agent: "empty-report-pi", providers }));
    }
    assert.throws(() => parseAgentProviderReport({ agent: "empty-report-pi", providers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, recipe])) }));
});

test("the real report endpoint clears only its named agent and exposes no key", async () => {
    const f = await fixture();
    try {
        for (const [agent, name] of [["empty-report-pi", "removed"], ["empty-report-peer", "remaining"]]) {
            const response = await f.post({ agent, providers: { [name]: recipe } });
            assert.equal(response.status, 200, await response.text());
        }
        const cleared = await f.post({ agent: "empty-report-pi", providers: {} });
        assert.equal(cleared.status, 200);
        const text = await cleared.text();
        assert.deepEqual(JSON.parse(text), { ok: true, agent: "empty-report-pi", registered: [], skipped: [] });
        assert.ok(!text.includes(recipe.apiKey));
        assert.equal(agentProviderRecipes().removed, undefined);
        assert.equal(agentProviderRecipes().remaining.apiKey, recipe.apiKey);
        const config = await (await fetch(f.base + "/__bili/config")).text();
        assert.ok(!config.includes("empty-report-pi"));
        assert.ok(config.includes("empty-report-peer"));
        assert.ok(!config.includes(recipe.apiKey));
    } finally { await f.close(); }
});

for (const nextCatalogue of ["empty", "all filtered"] as const) {
    test(`the real host reporter replaces its previous snapshot when the catalogue becomes ${nextCatalogue}`, async () => {
        const f = await fixture();
        let available = true;
        const ctx = { model: { baseUrl: f.base, api: "not-virtual" }, modelRegistry: {
            getAll: () => available ? [{ id: "sample", provider: "removed", api: "openai-completions" }]
                : nextCatalogue === "empty" ? [] : [{ id: "sample", provider: "removed", api: "unsupported-api" }],
            getProvider: () => ({ baseUrl: recipe.baseUrl }),
            getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
            getApiKeyForProvider: async () => recipe.apiKey,
        } } as unknown as Ctx;
        try {
            assert.equal(await reportAgentProviders(ctx, "empty-report-pi"), true);
            assert.equal(agentProviderRecipes().removed.apiKey, recipe.apiKey);
            available = false;
            assert.equal(await reportAgentProviders(ctx, "empty-report-pi"), true);
            assert.equal(agentProviderRecipes().removed, undefined, "the removed provider and key must no longer be dialable by summary chains");
        } finally { await f.close(); }
    });
}

test("a host without the registry face does not turn missing information into a clear", async () => {
    const f = await fixture();
    try {
        const response = await f.post({ agent: "empty-report-pi", providers: { removed: recipe } });
        assert.equal(response.status, 200, await response.text());
        const ctx = { model: { baseUrl: f.base, api: "not-virtual" }, modelRegistry: { find: () => undefined } } as unknown as Ctx;
        assert.equal(await reportAgentProviders(ctx, "empty-report-pi"), true);
        assert.equal(agentProviderRecipes().removed.apiKey, recipe.apiKey);
    } finally { await f.close(); }
});
