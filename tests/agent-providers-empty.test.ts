import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import { agentProviderRecipes, parseAgentProviderReport, recordAgentProviders } from "../src/agent-providers.js";
import { reportAgentProviders, type Ctx } from "../src/agent/pi.js";
import { closeLogger } from "../src/logger.js";

const recipe = { baseUrl: "https://provider.fixture.invalid/v1", api: "openai", apiKey: "fixture-memory-key", models: { sample: {} } };
async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "bili-empty-agent-report-"));
    const oldConfig = process.env.BILI_CONFIG_FILE;
    const oldProxy = process.env.BILLION_CONTEXT_PROXY;
    process.env.BILI_CONFIG_FILE = join(dir, "config.json");
    const logFile = join(dir, "bili.log");
    writeFileSync(process.env.BILI_CONFIG_FILE, "{}");
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const server = await startServer({ upstream: "http://127.0.0.1:1", routes: {}, proxy: "", proxyMode: "direct", proxySource: "direct", modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000), compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: true, logFile, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] }, port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.BILLION_CONTEXT_PROXY = base;
    let reportCount = 0;
    server.on("request", (req) => {
        if (req.method === "POST" && req.url === "/__bili/agent-providers") reportCount++;
    });
    const post = (body: unknown) => fetch(base + "/__bili/agent-providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { base, post, reports: () => reportCount, log: async () => {
        await closeLogger();
        return readFileSync(logFile, "utf8");
    }, close: async () => {
        recordAgentProviders("empty-report-pi", {});
        recordAgentProviders("empty-report-peer", {});
        if (oldConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = oldConfig;
        if (oldProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = oldProxy;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await closeLogger();
        rmSync(dir, { recursive: true, force: true });
    } };
}

test("only an explicitly marked empty provider report parses as a clear", () => {
    assert.deepEqual(parseAgentProviderReport({ agent: "empty-report-pi", providers: {}, clear: true }), { agent: "empty-report-pi", registered: {}, skipped: [], clear: true });
    for (const clear of [undefined, false, "true", 1, null]) {
        assert.throws(() => parseAgentProviderReport({ agent: "empty-report-pi", providers: {}, clear }));
    }
    assert.throws(() => parseAgentProviderReport({ agent: "empty-report-pi", providers: { removed: recipe }, clear: true }));
});

test("empty is distinct from missing or malformed provider envelopes", () => {
    for (const providers of [undefined, null, [], "none"]) {
        assert.throws(() => parseAgentProviderReport({ agent: "empty-report-pi", providers, clear: true }));
    }
    assert.throws(() => parseAgentProviderReport({ agent: "empty-report-pi", providers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, recipe])) }));
});

test("the real endpoint rejects ordinary empty reports, then logs an explicit clear without exposing keys", async () => {
    const f = await fixture();
    try {
        for (const [agent, name] of [["empty-report-pi", "removed"], ["empty-report-peer", "remaining"]]) {
            const response = await f.post({ agent, providers: { [name]: recipe } });
            assert.equal(response.status, 200, await response.text());
        }
        for (const clear of [undefined, false, "true", 1, null]) {
            const refused = await f.post({ agent: "empty-report-pi", providers: {}, clear });
            assert.equal(refused.status, 400, await refused.text());
            assert.equal(agentProviderRecipes().removed.apiKey, recipe.apiKey);
            assert.equal(agentProviderRecipes().remaining.apiKey, recipe.apiKey);
        }
        const cleared = await f.post({ agent: "empty-report-pi", providers: {}, clear: true });
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
        const log = await f.log();
        assert.match(log, /\[agent-providers\] empty-report-pi explicitly cleared.*clear: true/);
        assert.ok(!log.includes(recipe.apiKey));
    } finally { await f.close(); }
});

type Registry = NonNullable<Ctx["modelRegistry"]>;
const model = { id: "sample", provider: "removed", api: "openai-completions" };
const collectionFailures: Array<{ name: string; override: Partial<Registry>; throws?: boolean }> = [
    { name: "empty model catalogue", override: { getAll: () => [] } },
    { name: "all models filtered", override: { getAll: () => [{ ...model, api: "unsupported-api" }] } },
    { name: "catalogue fetch throws", override: { getAll: () => { throw new Error("fixture catalogue unavailable"); } }, throws: true },
    { name: "catalogue reports a load error", override: { getError: () => "fixture catalogue unavailable" } },
    { name: "provider lookup throws", override: { getProvider: () => { throw new Error("fixture provider unavailable"); } }, throws: true },
    { name: "provider lookup is unavailable", override: { getProvider: () => undefined } },
    { name: "auth status throws", override: { getProviderAuthStatus: () => { throw new Error("fixture auth unavailable"); } }, throws: true },
    { name: "auth is not configured", override: { getProviderAuthStatus: () => ({ configured: false }) } },
    { name: "auth status is unavailable", override: { getProviderAuthStatus: () => undefined } },
    { name: "resolved key is empty", override: { getApiKeyForProvider: async () => undefined } },
    { name: "key resolution throws", override: { getApiKeyForProvider: async () => { throw new Error("fixture key unavailable"); } } },
];
for (const failure of collectionFailures) {
    test(`the host sends no report for ${failure.name} and can retry after recovery`, async () => {
        const f = await fixture();
        const registry: Registry = {
            getAll: () => [model],
            getError: () => undefined,
            getProvider: () => ({ baseUrl: recipe.baseUrl }),
            getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
            getApiKeyForProvider: async () => "recovered-memory-key",
        };
        const ctx: Ctx = { model: { baseUrl: f.base, api: "not-virtual" }, modelRegistry: { ...registry, ...failure.override } };
        try {
            const seeded = await f.post({ agent: "empty-report-pi", providers: { removed: recipe } });
            assert.equal(seeded.status, 200, await seeded.text());
            const before = f.reports();
            if (failure.throws) await assert.rejects(reportAgentProviders(ctx, "empty-report-pi"), /fixture .* unavailable/);
            else assert.equal(await reportAgentProviders(ctx, "empty-report-pi"), false, "an incomplete collection must not latch the reporter as done");
            assert.equal(f.reports(), before, "collection failure must not POST even an empty report");
            assert.equal(agentProviderRecipes().removed.apiKey, recipe.apiKey);
            ctx.modelRegistry = registry;
            assert.equal(await reportAgentProviders(ctx, "empty-report-pi"), true);
            assert.equal(f.reports(), before + 1);
            assert.equal(agentProviderRecipes().removed.apiKey, "recovered-memory-key");
        } finally { await f.close(); }
    });
}

for (const keyFailure of ["empty", "throwing"] as const) {
    test(`${keyFailure} key resolution for a configured sibling must not publish a partial snapshot`, async () => {
        const f = await fixture();
        const ctx: Ctx = { model: { baseUrl: f.base, api: "not-virtual" }, modelRegistry: {
            getAll: () => [model, { ...model, provider: "sibling" }],
            getProvider: () => ({ baseUrl: recipe.baseUrl }),
            getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
            getApiKeyForProvider: async (id) => {
                if (id === "removed") return "new-memory-key";
                if (keyFailure === "throwing") throw new Error("fixture key unavailable");
                return undefined;
            },
        } };
        try {
            const seeded = await f.post({ agent: "empty-report-pi", providers: { removed: recipe, sibling: recipe } });
            assert.equal(seeded.status, 200, await seeded.text());
            const before = f.reports();
            assert.equal(await reportAgentProviders(ctx, "empty-report-pi"), false);
            assert.equal(f.reports(), before);
            assert.equal(agentProviderRecipes().removed.apiKey, recipe.apiKey);
            assert.equal(agentProviderRecipes().sibling.apiKey, recipe.apiKey);
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
