import test from "node:test";
import assert from "node:assert/strict";
import nodeHttp from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { parseRouteEntry, type ProviderRoutes } from "../src/config.ts";
import { SummaryCredentialStore } from "../src/external-summary-credentials.ts";
import { _setLaneCredentialStoreForTest, applyLaneCredential, laneCredential, type LaneCredential } from "../src/lane-credentials.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const cred = (key: string, reference = "env:TEST"): LaneCredential => ({ key, reference });

test("applyLaneCredential: replaces a Bearer authorization (case-insensitive scheme)", () => {
    const headers = { authorization: "bearer client-token" };
    applyLaneCredential(headers, cred("lane-key"), () => assert.fail("no warn expected"));
    assert.equal(headers.authorization, "Bearer lane-key");
});

test("applyLaneCredential: non-Bearer authorization is signature-owned and kept (warn)", () => {
    const headers = { authorization: "SDK-HMAC-SHA256 signed=abc" };
    let warned = false;
    applyLaneCredential(headers, cred("lane-key"), () => { warned = true; });
    assert.equal(headers.authorization, "SDK-HMAC-SHA256 signed=abc");
    assert.equal(warned, true);
});

test("applyLaneCredential: non-Bearer authorization + x-api-key — api key replaced, signature kept, no warn", () => {
    const headers = { authorization: "SDK-HMAC-SHA256 signed=abc", "x-api-key": "client-token" };
    applyLaneCredential(headers, cred("lane-key"), () => assert.fail("no warn expected"));
    assert.equal(headers.authorization, "SDK-HMAC-SHA256 signed=abc");
    assert.equal(headers["x-api-key"], "lane-key");
});

test("applyLaneCredential: x-goog-api-key replaced outright", () => {
    const headers = { "x-goog-api-key": "client-token" };
    applyLaneCredential(headers, cred("lane-key"), () => assert.fail("no warn expected"));
    assert.equal(headers["x-goog-api-key"], "lane-key");
});

test("applyLaneCredential: no auth headers at all — injects Bearer", () => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    applyLaneCredential(headers, cred("lane-key"), () => assert.fail("no warn expected"));
    assert.equal(headers.authorization, "Bearer lane-key");
});

test("applyLaneCredential: bearer + x-api-key — both replaced", () => {
    const headers = { authorization: "Bearer client-token", "x-api-key": "client-token" };
    applyLaneCredential(headers, cred("lane-key"), () => assert.fail("no warn expected"));
    assert.equal(headers.authorization, "Bearer lane-key");
    assert.equal(headers["x-api-key"], "lane-key");
});

test("laneCredential: env reference resolves from the passed env", () => {
    const routes: ProviderRoutes = { "https://api.deepseek.com": { apiKeyEnv: "DEEPSEEK_LANE_KEY" } };
    const resolved = laneCredential(routes, "https://api.deepseek.com/v1/chat/completions", () => assert.fail("no warn expected"), { DEEPSEEK_LANE_KEY: "sk-lane" });
    assert.deepEqual(resolved, { key: "sk-lane", reference: "env:DEEPSEEK_LANE_KEY" });
});

test("laneCredential: longest-prefix routing picks the most specific lane", () => {
    const routes: ProviderRoutes = {
        "https://api.deepseek.com": { apiKeyEnv: "A_LANE_KEY" },
        "https://api.deepseek.com/v2": { apiKeyEnv: "B_LANE_KEY" },
    };
    const first = laneCredential(routes, "https://api.deepseek.com/v1/chat", () => assert.fail("no warn expected"), { A_LANE_KEY: "a" });
    assert.deepEqual(first, { key: "a", reference: "env:A_LANE_KEY" });
    const second = laneCredential(routes, "https://api.deepseek.com/v2/chat", () => assert.fail("no warn expected"), { A_LANE_KEY: "a", B_LANE_KEY: "b" });
    assert.deepEqual(second, { key: "b", reference: "env:B_LANE_KEY" });
    const none = laneCredential(routes, "https://other.example.com/x", () => assert.fail("no warn expected"), { A_LANE_KEY: "a" });
    assert.equal(none, undefined);
});

test("laneCredential: unset env keeps client headers, warns ONCE per route+reference, re-arms after success", () => {
    const routes: ProviderRoutes = { "https://api.example.com": { apiKeyEnv: "UNSET_LANE_KEY_X1" } };
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    const env = {};
    assert.equal(laneCredential(routes, "https://api.example.com/x", warn, env), undefined);
    assert.equal(laneCredential(routes, "https://api.example.com/x", warn, env), undefined);
    assert.equal(warnings.length, 1);
    // env now set → resolves, warning slot re-armed
    const resolved = laneCredential(routes, "https://api.example.com/x", warn, { UNSET_LANE_KEY_X1: "k" });
    assert.deepEqual(resolved, { key: "k", reference: "env:UNSET_LANE_KEY_X1" });
    assert.equal(laneCredential(routes, "https://api.example.com/x", warn, env), undefined);
    assert.equal(warnings.length, 2);
});

test("laneCredential: secret: reference resolves through the (stubbed) store", () => {
    const stub = {
        resolve: (reference: string) => (reference === "secret:lane-primary" ? "sk-secret" : undefined),
    } as unknown as SummaryCredentialStore;
    _setLaneCredentialStoreForTest(stub);
    try {
        const routes: ProviderRoutes = { "https://api.example.com": { credentialRef: "lane-primary" } };
        const resolved = laneCredential(routes, "https://api.example.com/x", () => assert.fail("no warn expected"), {});
        assert.deepEqual(resolved, { key: "sk-secret", reference: "secret:lane-primary" });
    } finally {
        _setLaneCredentialStoreForTest(undefined);
    }
});

test("parseRouteEntry: lane credential fields parsed, validated, exactly-one (#2336)", () => {
    assert.deepEqual(parseRouteEntry({ apiKeyEnv: "MY_KEY" }), { models: undefined, apiKeyEnv: "MY_KEY" });
    assert.deepEqual(parseRouteEntry({ credentialRef: "primary" }), { models: undefined, credentialRef: "primary" });
    assert.deepEqual(parseRouteEntry({ models: { m: { context: 8 } }, apiKeyEnv: "MY_KEY" }), { models: { m: { context: 8 } }, apiKeyEnv: "MY_KEY" });
    assert.throws(() => parseRouteEntry({ apiKeyEnv: "MY_KEY", credentialRef: "x" }), /exactly one lane credential/);
    assert.throws(() => parseRouteEntry({ apiKeyEnv: "not a name" }), /apiKeyEnv must be an environment variable name/);
    assert.throws(() => parseRouteEntry({ apiKeyEnv: 42 }), /apiKeyEnv must be an environment variable name/);
    assert.throws(() => parseRouteEntry({ credentialRef: "has spaces" }), /credentialRef must be a name/);
    // recipe-shaped entries keep their credential fields OUT of the route —
    // parseNamedProviderRecipe owns them there (dialing recipes, not lanes)
    const recipeRoute = parseRouteEntry({ baseUrl: "https://x", api: "openai", apiKeyEnv: "MY_KEY", models: { m: {} } });
    assert.equal((recipeRoute as { apiKeyEnv?: string }).apiKeyEnv, undefined);
});

function listen(server: nodeHttp.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

test("forward: lane apiKeyEnv replaces the client's Bearer on the wire (#2336)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    let seenAuth = "";
    let seenXKey = "";
    const upstream = nodeHttp.createServer((req, res) => {
        seenAuth = String(req.headers["authorization"] ?? "");
        seenXKey = String(req.headers["x-api-key"] ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const upstreamHost = `127.0.0.1:${upstreamPort}`;

    const opts = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://${upstreamHost}`,
        routes: { [`http://${upstreamHost}`]: { apiKeyEnv: "LANE_FORWARD_TEST_KEY" } },
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
        compat: { roles: {} }, streamErrorShape: "protocol" as const, passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    const proxy = await startServer(opts as Parameters<typeof startServer>[0]);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    const prev = process.env.LANE_FORWARD_TEST_KEY;
    process.env.LANE_FORWARD_TEST_KEY = "sk-lane-forward";
    const body = JSON.stringify({ model: "gpt-test", stream: false, messages: [{ role: "user", content: "hi" }] });
    try {
        await new Promise<void>((resolve, reject) => {
            const req = nodeHttp.request(
                {
                    host: "127.0.0.1",
                    port: proxyPort,
                    method: "POST",
                    path: `http://${upstreamHost}/v1/chat/completions`,
                    headers: {
                        "content-type": "application/json",
                        host: upstreamHost,
                        "x-acp-session": "lane-forward-test",
                        "content-length": String(Buffer.byteLength(body)),
                        authorization: "Bearer sk-client-original",
                        "x-api-key": "sk-client-original",
                    },
                },
                (res) => {
                    res.resume();
                    res.on("end", () => resolve());
                },
            );
            req.on("error", reject);
            req.end(body);
        });
        assert.equal(seenAuth, "Bearer sk-lane-forward");
        assert.equal(seenXKey, "sk-lane-forward");
    } finally {
        if (prev === undefined) delete process.env.LANE_FORWARD_TEST_KEY;
        else process.env.LANE_FORWARD_TEST_KEY = prev;
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
});
