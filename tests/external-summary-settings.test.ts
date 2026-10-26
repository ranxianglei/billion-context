import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { once } from "node:events";
import { expandExternalSummaryChain, expandExternalSummaryChainTolerant, parseExternalSummaryChain, parseExternalSummarySettings } from "../src/external-summary-settings.ts";
import { SummaryCredentialStore } from "../src/external-summary-credentials.ts";
import { applyCompressSettings, mergeCompress } from "../src/compress-settings.ts";
import { collectNamedProviders, parseCompressSettings, parseNamedProviderRecipe, parseRouteEntry, type NamedProviderRecipe } from "../src/config.ts";
import { defaultConfig } from "acp-kernel";
import { handleConfigGet, handleConfigPut, handleSummaryCredentialPut } from "../src/web/api.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

const recipes: Record<string, NamedProviderRecipe> = {
    glm: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai", apiKeyEnv: "GLM_KEY", models: { "glm-4.9-flash": {} } },
    claude: { baseUrl: "https://api.anthropic.com/v1", api: "anthropic", credentialRef: "primary", models: { "claude-haiku": { contextWindow: 2048 } } },
    google: { baseUrl: "https://generativelanguage.googleapis.com", api: "google", apiKeyEnv: "G_KEY", models: { "gemini-flash": { stream: true } } },
    remote: { baseUrl: "https://example.com", api: "responses", apiKeyEnv: "R_KEY", models: { "resp-model": {} } },
    local: { baseUrl: "http://127.0.0.1:9999/v1", api: "openai", apiKeyEnv: "LOCAL_KEY", models: { local: {} } },
};

test("external summary chains default off and expand against the named providers table", () => {
    const off = parseExternalSummaryChain({});
    assert.equal(off.enabled, false);
    assert.deepEqual(off.targets, []);
    assert.deepEqual(off.budget, { totalTimeoutMs: 50_000, targetTimeoutMs: 25_000, maxSummaryBytes: 65536 });
    const chain = parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"] });
    const plan = expandExternalSummaryChain(chain, recipes);
    const target = plan.targets[0];
    assert.equal(target.name, "glm--glm-4-9-flash");
    assert.equal(target.protocol, "openai");
    assert.equal(target.url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
    assert.equal(target.model, "glm-4.9-flash");
    assert.equal(target.credentialRef, "env:GLM_KEY");
    assert.equal(target.outputTokens, 8192);
    assert.equal(target.contextWindow, 128_000);
    // The expanded settings are exactly what the rail (and the executor's
    // re-validation via parseExternalSummarySettings) expects.
    assert.doesNotThrow(() => parseExternalSummarySettings(plan));
});

test("endpoint derivation follows the recipe protocol and version segment", () => {
    const expandOne = (ref: string) => expandExternalSummaryChain(parseExternalSummaryChain({ enabled: true, targets: [ref] }), recipes).targets[0];
    assert.equal(expandOne("claude/claude-haiku").url, "https://api.anthropic.com/v1/messages");
    assert.equal(expandOne("claude/claude-haiku").credentialRef, "secret:primary");
    assert.equal(expandOne("google/gemini-flash").url, "https://generativelanguage.googleapis.com/models/gemini-flash:streamGenerateContent");
    assert.equal(expandOne("google/gemini-flash").stream, true);
    assert.equal(expandOne("remote/resp-model").url, "https://example.com/v1/responses");
    assert.equal(expandOne("local/local").url, "http://127.0.0.1:9999/v1/chat/completions");
});

test("small context windows clamp output defaults without changing explicit limits", () => {
    const plan = expandExternalSummaryChain(parseExternalSummaryChain({ enabled: true, targets: ["claude/claude-haiku"], budget: { totalTimeoutMs: 500 } }), recipes);
    assert.equal(plan.targets[0].outputTokens, 512);
    assert.equal(plan.budget.targetTimeoutMs, 500);
});

test("duplicate references get deduplicated names instead of colliding", () => {
    const plan = expandExternalSummaryChain(parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash", "glm/glm-4.9-flash"] }), recipes);
    assert.deepEqual(plan.targets.map((target) => target.name), ["glm--glm-4-9-flash", "glm-1"]);
});

test("chains ride the three-level compress ladder (whole-chain replace) and expand at apply time", () => {
    const chain = (ref: string) => parseExternalSummaryChain({ enabled: true, targets: [ref] });
    const global = chain("glm/glm-4.9-flash");
    const provider = chain("remote/resp-model");
    const model = chain("claude/claude-haiku");
    const off = parseExternalSummaryChain({ enabled: false, targets: ["glm/glm-4.9-flash"] });
    assert.equal(mergeCompress({ externalSummary: global }, { externalSummary: provider }, { externalSummary: model })?.externalSummary?.targets[0], "claude/claude-haiku");
    assert.equal(mergeCompress({ externalSummary: global }, { externalSummary: provider })?.externalSummary?.targets[0], "remote/resp-model");
    assert.equal(mergeCompress({ externalSummary: global })?.externalSummary?.targets[0], "glm/glm-4.9-flash");
    const replaced = mergeCompress({ externalSummary: global }, { externalSummary: provider }, { externalSummary: off })?.externalSummary;
    assert.equal(replaced?.enabled, false);
    assert.deepEqual(replaced?.targets, []);
    // applyCompressSettings expands the winning chain against the recipes.
    const resolved = applyCompressSettings(defaultConfig(100_000), 100_000, { externalSummary: model }, recipes);
    assert.equal(resolved.externalSummary?.enabled, true);
    assert.equal(resolved.externalSummary?.targets[0]?.model, "claude-haiku");
});

for (const invalid of [
    { enabled: "true" }, { enabled: true }, { apiKey: "do-not-echo" },
    { enabled: true, targets: {} }, { enabled: true, targets: [] },
    { enabled: true, targets: [{}] }, { enabled: true, targets: ["glm"] },
    { enabled: true, targets: ["glm/"] }, { enabled: true, targets: ["/flash"] },
    { enabled: true, targets: ["glm/glm-4.9-flash\n"] },
    { enabled: true, budget: { totalTimeoutMs: 700_000 } },
    { enabled: true, budget: { totalTimeoutMs: 100, targetTimeoutMs: 101 } },
    { enabled: true, budget: { concurrency: 1000 } },
    { enabled: true, targets: Array.from({ length: 17 }, () => "glm/glm-4.9-flash") },
]) {
    test(`invalid external summary chain is rejected when enabled: ${JSON.stringify(invalid)}`, () => {
        assert.throws(() => parseExternalSummaryChain(invalid));
        assert.equal(parseCompressSettings({ externalSummary: invalid }), undefined);
    });
}

test("totalTimeoutMs accepts the widened cap and rejects above it (#2484)", () => {
    // A big-session fold runs a dozen or more chunks against one shared
    // deadline, so the cap was raised from 50s to 600s; the default stays 50s.
    assert.doesNotThrow(() => parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"], budget: { totalTimeoutMs: 600_000 } }));
    assert.throws(() => parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"], budget: { totalTimeoutMs: 600_001 } }));
});

for (const invalid of [
    "unknown/glm-4.9-flash", "glm/unknown-model",
]) {
    test(`unresolvable chain references fail expansion loudly: ${invalid}`, () => {
        const chain = parseExternalSummaryChain({ enabled: true, targets: [invalid] });
        assert.throws(() => expandExternalSummaryChain(chain, recipes), /unknown (provider|model)/);
        // The request-path policy: warn + disabled, never a 500.
        assert.equal(expandExternalSummaryChainTolerant(chain, recipes).enabled, false);
    });
}

for (const badRecipe of [
    { baseUrl: "http://remote.example", api: "openai", apiKeyEnv: "K", models: { m: {} } },
    { baseUrl: "https://proxy.example/bili/https://up.example", api: "openai", apiKeyEnv: "K", models: { m: {} } },
    { baseUrl: "https://user:pass@example.com", api: "openai", apiKeyEnv: "K", models: { m: {} } },
]) {
    test(`unusable recipe endpoints fail expansion: ${badRecipe.baseUrl}`, () => {
        const chain = parseExternalSummaryChain({ enabled: true, targets: ["x/m"] });
        assert.throws(() => expandExternalSummaryChain(chain, { x: parseNamedProviderRecipe(badRecipe) }), /not usable/);
    });
}

for (const inert of [
    { targets: {} }, { targets: "glm/glm-4.9-flash" }, { targets: ["dangling-ref"] }, { budget: { totalTimeoutMs: 60_000 } },
]) {
    test(`disabled external summary chains are inert instead of bricking compression: ${JSON.stringify(inert)}`, () => {
        // P2: a `enabled !== true` chain never runs, so garbage references must
        // not refuse every compression — validation happens on enable.
        const plan = parseExternalSummaryChain(inert);
        assert.equal(plan.enabled, false);
        assert.deepEqual(plan.targets, []);
    });
}

test("external summary chains are configured per route like every other compress field", () => {
    const externalSummary = parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"] });
    assert.doesNotThrow(() => parseRouteEntry({ compress: { externalSummary } }));
    assert.doesNotThrow(() => parseRouteEntry({ models: { model: { compress: { externalSummary } } } }));
    assert.doesNotThrow(() => parseRouteEntry({ compress: { tiers: false } }));
    assert.deepEqual(parseCompressSettings({ externalSummary })?.externalSummary, externalSummary);
});

test("named provider recipes parse strictly and reject plaintext credentials", () => {
    const recipe = parseNamedProviderRecipe({ baseUrl: "https://open.bigmodel.cn/api/paas/v4/", api: "openai", apiKeyEnv: "GLM_KEY", models: { "glm-4.9-flash": { outputTokens: 4096 } }, bind: "https://api.deepseek.com" });
    assert.equal(recipe.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
    assert.deepEqual(recipe.models, { "glm-4.9-flash": { outputTokens: 4096 } });
    for (const invalid of [
        { baseUrl: "https://example.com", api: "openai", apiKey: "sk-plaintext", models: { m: {} } },
        { baseUrl: "https://example.com", api: "openai", models: { m: {} } },
        { baseUrl: "https://example.com", api: "openai", apiKeyEnv: "K", credentialRef: "c", models: { m: {} } },
        { baseUrl: "", api: "openai", apiKeyEnv: "K", models: { m: {} } },
        { baseUrl: "https://example.com", api: "openai-completions", apiKeyEnv: "K", models: { m: {} } },
        { baseUrl: "https://example.com", api: "openai", apiKeyEnv: "1BAD", models: { m: {} } },
        { baseUrl: "https://example.com", api: "openai", apiKeyEnv: "K", models: {} },
        { baseUrl: "https://example.com", api: "openai", apiKeyEnv: "K", models: { m: { temperature: 1 } } },
        { baseUrl: "https://example.com", api: "openai", apiKeyEnv: "K", models: { m: { contextWindow: 1 } } },
    ]) {
        assert.throws(() => parseNamedProviderRecipe(invalid), /.*/, JSON.stringify(invalid));
    }
});

test("collectNamedProviders only sees recipe-shaped named entries", () => {
    const collected = collectNamedProviders({
        "https://api.deepseek.com": { compress: { nudgeGrowthTokens: 1000 } },
        glm: recipes.glm as unknown as Record<string, unknown>,
        alias: { bind: "https://api.deepseek.com", models: { "deepseek-chat": { context: 128 } } },
        broken: { baseUrl: "https://example.com", api: "openai", models: { m: {} } },
    });
    // alias carries no recipe fields → not a recipe (its models stay routing);
    // broken (no credential reference) is warned and skipped.
    assert.deepEqual(Object.keys(collected), ["glm"]);
});

const roots: string[] = [];
function root(): string {
    const path = mkdtempSync(join(tmpdir(), "bili-summary-settings-"));
    roots.push(path);
    return path;
}
afterEach(() => { for (const path of roots.splice(0)) rmrf(path); });

test("private store resolves, rotates and deletes keys without exposing arbitrary paths", () => {
    const path = join(root(), "keys.json");
    const store = new SummaryCredentialStore(path);
    assert.equal(store.configured("secret:primary"), false);
    store.set("primary", "test-first-key");
    store.set("backup", "test-backup-key");
    assert.equal(store.resolve("secret:primary"), "test-first-key");
    store.set("primary", "test-rotated-key");
    assert.equal(store.resolve("secret:backup"), "test-backup-key");
    store.set("primary", null);
    assert.equal(store.resolve("secret:primary"), undefined);
    assert.equal(readFileSync(path, "utf8").includes("test-first-key"), false);
    if (process.platform !== "win32") assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.throws(() => store.set("../escape", "test-key"));
    assert.throws(() => store.set("primary", "test-key\nInjected-Header"));
    assert.throws(() => store.resolve("file:/etc/passwd"));
});

test("environment references are read-only and do not inherit another provider key", () => {
    const store = new SummaryCredentialStore(join(root(), "absent.json"));
    assert.equal(store.resolve("env:SUMMARY_KEY", { SUMMARY_KEY: "test-env-key", OPENAI_API_KEY: "wrong" }), "test-env-key");
    assert.equal(store.resolve("env:SUMMARY_KEY", { OPENAI_API_KEY: "wrong" }), undefined);
    assert.throws(() => store.resolve("env:SUMMARY_KEY", { SUMMARY_KEY: "bad\nkey" }));
});

test("corrupt private store fails closed and is not overwritten", () => {
    const path = join(root(), "keys.json");
    writeFileSync(path, "corrupt-private-value", { mode: 0o600 });
    const store = new SummaryCredentialStore(path);
    assert.throws(() => store.set("primary", "replacement"), /credentials unavailable/);
    assert.equal(store.configured("secret:primary"), false);
    assert.equal(readFileSync(path, "utf8"), "corrupt-private-value");
});

test("world-readable private store is refused", { skip: process.platform === "win32" }, () => {
    const path = join(root(), "keys.json");
    const store = new SummaryCredentialStore(path);
    store.set("primary", "test-private-key");
    chmodSync(path, 0o644);
    assert.throws(() => store.resolve("secret:primary"), /permissions/);
});

test("another writer's credential lock refuses the update without deleting its lock", () => {
    const path = join(root(), "keys.json");
    const store = new SummaryCredentialStore(path);
    store.set("primary", "test-original");
    writeFileSync(`${path}.lock`, "other-writer", { mode: 0o600 });
    assert.throws(() => store.set("primary", "test-replacement"), /locked/);
    assert.equal(store.resolve("secret:primary"), "test-original");
    assert.equal(readFileSync(`${path}.lock`, "utf8"), "other-writer");
});

test("config/credential API never echoes keys, and saves validate recipes and chain references", async () => {
    const path = join(root(), "config.json");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = path;
    const recipe = { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai", apiKeyEnv: "GLM_KEY", models: { "glm-4.9-flash": {} } };
    const claudeRecipe = { baseUrl: "https://api.anthropic.com/v1", api: "anthropic", credentialRef: "primary", models: { "claude-haiku": {} } };
    const writeConfig = (config: unknown) => writeFileSync(path, JSON.stringify(config));
    writeConfig({ compress: { externalSummary: { enabled: true, targets: ["claude/claude-haiku"] } }, providers: { glm: recipe, claude: claudeRecipe }, retained: true });
    const server = http.createServer((req, res) => {
        const handler = req.method === "GET" ? handleConfigGet(res)
            : req.url === "/credential" ? handleSummaryCredentialPut(req, res) : handleConfigPut(req, res);
        void handler.catch(() => { res.writeHead(500); res.end("test handler failed"); });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const key = "test-never-public-key";
    const previousEnv = process.env.GLM_KEY;
    process.env.GLM_KEY = "test-glm-env-key";
    const save = async (config: unknown) => fetch(base, { method: "PUT", body: JSON.stringify({ file: JSON.stringify(config) }) });
    try {
        const saved = await fetch(`${base}/credential`, { method: "PUT", body: JSON.stringify({ name: "primary", key }) });
        assert.equal(saved.status, 200);
        assert.equal((await saved.text()).includes(key), false);
        let response = await fetch(base);
        const body = await response.text();
        assert.equal(body.includes(key), false);
        assert.equal(JSON.parse(body).externalSummaryCredentials["secret:primary"], true);
        assert.equal(JSON.parse(body).externalSummaryCredentials["env:GLM_KEY"], true);
        assert.equal(readFileSync(path, "utf8").includes(key), false);
        // An enabled chain that references a provider missing from the file
        // being saved is refused at save time (no dangling chains on disk).
        response = await save({ compress: { externalSummary: { enabled: true, targets: ["claude/claude-haiku"] } }, providers: {} });
        assert.equal(response.status, 400);
        assert.match(await response.text(), /unknown provider/);
        // A malformed recipe is refused with a 400 naming the entry.
        response = await save({ providers: { glm: { ...recipe, apiKey: "sk-plaintext" } } });
        assert.equal(response.status, 400);
        assert.match(await response.text(), /invalid recipe on named provider/);
        // Inline credentials in the compress block are still refused.
        response = await save({ compress: { externalSummary: { enabled: true, targets: ["claude/claude-haiku"], key } } });
        assert.equal(response.status, 400);
        assert.equal((await response.text()).includes(key), false);
        assert.equal(JSON.parse(readFileSync(path, "utf8")).retained, true);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previousEnv === undefined) delete process.env.GLM_KEY;
        else process.env.GLM_KEY = previousEnv;
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previous;
    }
});

test("autoFold rides both the chain form and the expanded rail form", () => {
    const chain = parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"], autoFold: true, autoFoldTargetTokens: 12000 });
    assert.equal(chain.autoFold, true);
    assert.equal(chain.autoFoldTargetTokens, 12000);
    const plan = expandExternalSummaryChain(chain, recipes);
    assert.equal(plan.autoFold, true);
    assert.equal(plan.autoFoldTargetTokens, 12000);
    assert.doesNotThrow(() => parseExternalSummarySettings(plan));
    // Default: no explicit target → the host halves the window at arm time.
    const lazy = expandExternalSummaryChain(parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"], autoFold: true }), recipes);
    assert.equal(lazy.autoFold, true);
    assert.equal(lazy.autoFoldTargetTokens, undefined);
});

test("autoFold validation: boolean only, target within [8192, 10M]", () => {
    assert.throws(() => parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"], autoFold: "yes" }), /autoFold must be boolean/);
    assert.throws(() => parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"], autoFold: true, autoFoldTargetTokens: 0 }), /autoFoldTargetTokens must be an integer/);
    assert.throws(() => parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"], autoFold: true, autoFoldTargetTokens: 8191 }), /autoFoldTargetTokens must be an integer/);
    assert.throws(() => parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"], autoFold: true, autoFoldTargetTokens: "big" }), /autoFoldTargetTokens must be an integer/);
    // A disabled chain never reads the rest of the object (early return).
    const off = parseExternalSummaryChain({ enabled: false, targets: [], autoFold: "junk" as unknown as boolean });
    assert.equal(off.enabled, false);
    assert.equal(off.autoFold, undefined);
});

test("concurrency rides both the chain form and the expanded rail form (#2657)", () => {
    const chain = parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"], concurrency: 12 });
    assert.equal(chain.concurrency, 12);
    const plan = expandExternalSummaryChain(chain, recipes);
    assert.equal(plan.concurrency, 12);
    assert.doesNotThrow(() => parseExternalSummarySettings(plan));
    // Absent → undefined → the executor keeps its base size.
    const lazy = expandExternalSummaryChain(parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"] }), recipes);
    assert.equal(lazy.concurrency, undefined);
    // Whole-chain replace carries it like every other field.
    const merged = mergeCompress({ externalSummary: { ...chain, targets: ["remote/resp-model"] } }, {})?.externalSummary;
    assert.equal(merged?.concurrency, 12);
});

test("concurrency validation: integer within [1, 32] on both forms (#2657)", () => {
    assert.doesNotThrow(() => parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"], concurrency: 1 }));
    assert.doesNotThrow(() => parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"], concurrency: 32 }));
    const plan = expandExternalSummaryChain(parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"] }), recipes);
    for (const bad of [0, 33, -4, 2.5, "12"]) {
        assert.throws(() => parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"], concurrency: bad }), /concurrency must be an integer between 1 and 32/, JSON.stringify(bad));
        assert.throws(() => parseExternalSummarySettings({ ...plan, concurrency: bad }), /concurrency must be an integer between 1 and 32/, JSON.stringify(bad));
    }
    // A disabled chain never reads the rest of the object (early return).
    const off = parseExternalSummaryChain({ enabled: false, targets: [], concurrency: "junk" as unknown as number });
    assert.equal(off.enabled, false);
    assert.equal(off.concurrency, undefined);
});

test("autoFold set on a disabled chain warns instead of silently no-oping", () => {
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    try {
        // `enabled` omitted entirely → chain is off; autoFold must surface, not vanish.
        const off = parseExternalSummaryChain({ autoFold: true });
        assert.equal(off.enabled, false);
        assert.ok(warns.some((w) => w.includes("autoFold") && w.includes('"enabled"')), "expected an autoFold-inert warning");
        // Explicitly disabled with both knobs → still off, still surfaced, no crash.
        const offBoth = parseExternalSummaryChain({ enabled: false, autoFold: true, autoFoldTargetTokens: 16384 });
        assert.equal(offBoth.enabled, false);
        assert.equal(offBoth.autoFold, undefined);
        // A correctly-enabled chain emits nothing on this front.
        const before = warns.length;
        const on = parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-4.9-flash"], autoFold: true });
        assert.equal(on.enabled, true);
        assert.equal(on.autoFold, true);
        assert.equal(warns.length, before);
    } finally {
        setLogCapture(null);
    }
});
