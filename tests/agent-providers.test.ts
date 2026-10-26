// #2336: agent-registry fallback. Pins the intake contract (POST
// /__bili/agent-providers), the registry primitives (in-memory only, file
// recipes win on the request path), the web surface (names only — a key
// never crosses GET), the inline-key rail (settings reject apiKey from the
// file world, the executor honors it), and the PUT validation merge (a
// chain may reference agent providers without duplicating them in the file).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { applyConfiguredCompression } from "../src/external-summary-compress.ts";
import { parseAgentProviderReport, recordAgentProviders, agentProviderRecipes, agentRegistryStatus, sanitizeAgentProviderField } from "../src/agent-providers.ts";
import { reportAgentProviders, type Ctx } from "../src/agent/pi.ts";
import { parseExternalSummarySettings } from "../src/external-summary-settings.ts";
import { createCore } from "acp-kernel";
import { createSession, type Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { RewriteCtx } from "../src/stream.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.NODE_ENV = "test";

// #2831: agent-provider skip diagnostics now land in the shared bili.log
// instead of the terminal the live TUI renders over — hermetic redirect.
const STATE_ROOT = mkdtempSync(path.join(tmpdir(), "bili-agent-providers-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
const PROVIDERS_LOG_FILE = path.join(STATE_ROOT, "billion-context", "bili.log");
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    rmrf(STATE_ROOT);
});

const VALID_REPORT = {
    agent: "pi",
    providers: {
        zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4/", api: "openai", apiKey: "agent-resolved-key", models: { "glm-5": { contextWindow: 200_000, outputTokens: 8192 }, "glm-5-air": {} } },
        claude: { baseUrl: "https://api.anthropic.com", api: "anthropic", apiKey: "sk-ant-agent", models: { "claude-haiku": { stream: true } } },
    },
};

test("#2336 parseAgentProviderReport accepts and normalizes a valid report", () => {
    const { agent, registered, skipped } = parseAgentProviderReport(VALID_REPORT);
    assert.equal(agent, "pi");
    assert.deepEqual(Object.keys(registered).sort(), ["claude", "zhipu"]);
    assert.deepEqual(skipped, []);
    assert.equal(registered.zhipu.baseUrl, "https://open.bigmodel.cn/api/paas/v4", "trailing slash trimmed");
    assert.equal(registered.zhipu.api, "openai");
    assert.equal(registered.zhipu.models["glm-5-air"].contextWindow, undefined, "absent knobs stay absent");
});

test("#2585 sanitizeAgentProviderField bounds and flattens log/response fields", () => {
    assert.equal(sanitizeAgentProviderField(`a${String.fromCharCode(10)}b${String.fromCharCode(13)}c${String.fromCharCode(0)}d`, 10), "a?b?c?d");
    assert.equal(sanitizeAgentProviderField("x".repeat(300), 200).length, 200);
});

test("#2336 parseAgentProviderReport rejects malformed payloads", () => {
    // top-level envelope violations still throw — nothing could be attributed without them
    const topLevel: Array<[string, unknown]> = [
        ["not an object", "nope"],
        ["missing agent", { providers: { a: VALID_REPORT.providers.zhipu } }],
        ["bad agent name", { agent: "-leading-dash", providers: { a: VALID_REPORT.providers.zhipu } }],
        ["missing providers", { agent: "pi" }],
        ["empty providers", { agent: "pi", providers: {} }],
    ];
    for (const [label, payload] of topLevel) {
        assert.throws(() => parseAgentProviderReport(payload), /.*/, label);
    }
    // #2585: entry-level failures are collected, never fatal — the valid sibling
    // still registers and the refusal names the offending entry
    const entryFails: Array<[string, Record<string, unknown>, RegExp]> = [
        ["bad provider name", { "no/slash": VALID_REPORT.providers.zhipu }, /Invalid provider name "no\/slash"/],
        ["non-object entry", { a: "nope" }, /must be an object/],
        ["missing baseUrl", { a: { api: "openai", apiKey: "k", models: { m: {} } } }, /needs a baseUrl/],
        ["remote http baseUrl", { a: { baseUrl: "http://example.com", api: "openai", apiKey: "k", models: { m: {} } } }, /must be HTTPS \(or loopback HTTP\)/],
        ["tailscale-style http baseUrl", { a: { baseUrl: "http://100.64.0.1:11434/v1", api: "openai", apiKey: "k", models: { m: {} } } }, /must be HTTPS \(or loopback HTTP\)/],
        ["bili recursion baseUrl", { a: { baseUrl: "https://h/__bili/x", api: "openai", apiKey: "k", models: { m: {} } } }, /must be HTTPS \(or loopback HTTP\)/],
        ["bad api enum", { a: { baseUrl: "https://h", api: "grpc", apiKey: "k", models: { m: {} } } }, /api must be one of/],
        ["empty apiKey", { a: { baseUrl: "https://h", api: "openai", apiKey: "", models: { m: {} } } }, /needs an apiKey/],
        ["control chars in apiKey", { a: { baseUrl: "https://h", api: "openai", apiKey: `bad${String.fromCharCode(10)}key`, models: { m: {} } } }, /needs an apiKey/],
        ["empty models", { a: { baseUrl: "https://h", api: "openai", apiKey: "k", models: {} } }, /needs 1 to 64 models/],
        ["bad contextWindow", { a: { baseUrl: "https://h", api: "openai", apiKey: "k", models: { m: { contextWindow: 10 } } } }, /invalid contextWindow/],
        ["bad outputTokens", { a: { baseUrl: "https://h", api: "openai", apiKey: "k", models: { m: { outputTokens: 1 } } } }, /invalid outputTokens/],
        ["bad stream flag", { a: { baseUrl: "https://h", api: "openai", apiKey: "k", models: { m: { stream: "yes" } } } }, /invalid stream flag/],
    ];
    for (const [label, bad, re] of entryFails) {
        const r = parseAgentProviderReport({ agent: "pi", providers: { ...bad, zhipu: VALID_REPORT.providers.zhipu } });
        assert.deepEqual(Object.keys(r.registered), ["zhipu"], `sibling survives: ${label}`);
        assert.equal(r.skipped.length, 1, label);
        assert.equal(r.skipped[0].name, Object.keys(bad)[0], label);
        assert.match(r.skipped[0].reason, re, label);
        assert.ok(!r.skipped[0].reason.includes(String.fromCharCode(10)), `single-line reason: ${label}`);
    }
    // loopback http stays allowed (local summary servers)
    const local = parseAgentProviderReport({ agent: "pi", providers: { a: { baseUrl: "http://127.0.0.1:9000", api: "openai", apiKey: "k", models: { m: {} } } } });
    assert.equal(local.registered.a.baseUrl, "http://127.0.0.1:9000");
});

test("#2336 registry: record/merge/status never leak keys or baseUrl", () => {
    recordAgentProviders("pi", parseAgentProviderReport(VALID_REPORT).registered);
    assert.deepEqual(Object.keys(agentProviderRecipes()).sort(), ["claude", "zhipu"]);
    const status = JSON.stringify(agentRegistryStatus());
    assert.ok(status.includes("zhipu") && status.includes("glm-5"), "names and models exposed for the panel");
    assert.ok(!status.includes("agent-resolved-key") && !status.includes("sk-ant-agent"), "no key bytes in status");
    assert.ok(!status.includes("api.anthropic.com"), "no baseUrl in status");
    // a second agent replacing its own contribution leaves the other intact
    recordAgentProviders("opencode", { sub: { baseUrl: "https://sub.example", api: "openai", apiKey: "k2", models: { m: {} } } });
    assert.deepEqual(Object.keys(agentProviderRecipes()).sort(), ["claude", "sub", "zhipu"]);
    recordAgentProviders("pi", {});
    assert.deepEqual(Object.keys(agentProviderRecipes()), ["sub"], "empty re-report clears that agent's layer");
    recordAgentProviders("opencode", {});
});

test("#2336 inline-key rail: file-world parse rejects apiKey, inlineKeys accepts with XOR", () => {
    const target = { name: "t", protocol: "responses", url: "https://h.example", model: "m", apiKey: "inline-key" };
    assert.throws(() => parseExternalSummarySettings({ enabled: true, targets: [target] }), /credentialRef/, "file world never accepts inline keys");
    const parsed = parseExternalSummarySettings({ enabled: true, targets: [target] }, { inlineKeys: true });
    assert.equal(parsed.targets[0].apiKey, "inline-key");
    assert.equal(parsed.targets[0].credentialRef, undefined);
    assert.throws(() => parseExternalSummarySettings({ enabled: true, targets: [{ ...target, credentialRef: "env:X" }] }, { inlineKeys: true }), /both/);
});

// ---------------------------------------------------------------------------
// Integration: the live admin endpoint + web surfaces through a real server.

function request(port: number, method: string, reqPath: string, payload?: unknown): Promise<{ status: number; body: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = http.request({ host: "127.0.0.1", port, method, path: reqPath, headers: payload !== undefined ? { "content-type": "application/json" } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (payload !== undefined) req.end(JSON.stringify(payload));
    else req.end();
    return promise;
}

test("#2336 endpoint + web GET/PUT contract through a real server", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-agent-providers-"));
    const file = path.join(dir, "billion-context.json");
    writeFileSync(file, JSON.stringify({ providers: { glm: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai", apiKeyEnv: "GLM_KEY", models: { "glm-5-file": {} } } }, compress: { externalSummary: { enabled: false, targets: ["glm/glm-5-file"] } } }), "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = file;
    // Isolate from the machine's real session/prefix-affinity state so the
    // server holds no long-lived handles (same discipline as #2028's suite).
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const server = await startServer({
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
        port: 0,
        host: "127.0.0.1",
    } satisfies Parameters<typeof startServer>[0]);
    await once(server, "listening");
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
        // intake: valid report accepted
        let r = await request(port, "POST", "/__bili/agent-providers", VALID_REPORT);
        assert.equal(r.status, 200);
        let intake = JSON.parse(r.body) as { ok: boolean; registered: string[]; skipped: Array<{ name: string; reason: string }> };
        assert.equal(intake.ok, true);
        assert.deepEqual(intake.registered.sort(), ["claude", "zhipu"]);
        assert.deepEqual(intake.skipped, []);
        assert.ok(!r.body.includes("agent-resolved-key"), "response carries names only");

        // GET exposes the registry layer without any secret material
        r = await request(port, "GET", "/__bili/config");
        const cfg = JSON.parse(r.body) as { agentProviders?: Array<{ agent: string; providers: Array<{ name: string; models: string[] }> }> };
        assert.deepEqual(cfg.agentProviders, [{ agent: "pi", providers: [{ name: "claude", models: ["claude-haiku"] }, { name: "zhipu", models: ["glm-5", "glm-5-air"] }] }], "status shape feeds the panel dropdown");
        assert.ok(!r.body.includes("agent-resolved-key") && !r.body.includes("sk-ant-agent"));

        // PUT: a chain may reference an agent-only provider (zhipu lives only in the agent layer)
        r = await request(port, "PUT", "/__bili/config", { compress: { externalSummary: { enabled: true, targets: ["zhipu/glm-5", "claude/claude-haiku"] } } });
        assert.equal(r.status, 200, `agent refs resolve at save time: ${r.body}`);

        // PUT: file recipes win on name collision — glm is file-owned (glm-5-file
        // only), so the agent layer's glm models are shadowed, and a ref to a
        // file-known provider's unknown model is rejected
        r = await request(port, "PUT", "/__bili/config", { compress: { externalSummary: { enabled: true, targets: ["glm/glm-5-file"] } } });
        assert.equal(r.status, 200, `file-owned ref works: ${r.body}`);
        r = await request(port, "PUT", "/__bili/config", { compress: { externalSummary: { enabled: true, targets: ["glm/glm-5"] } } });
        assert.equal(r.status, 400, "file recipe shadows the same-named agent provider entirely");

        // PUT: unknown provider still rejected
        r = await request(port, "PUT", "/__bili/config", { compress: { externalSummary: { enabled: true, targets: ["nobody/model"] } } });
        assert.equal(r.status, 400);

        // #2585: one bad entry costs only itself — the valid sibling registers
        // and the refusal is named in the response (old behavior: 400 for the
        // whole report, nothing registered, silent on both sides)
        r = await request(port, "POST", "/__bili/agent-providers", {
            agent: "pi",
            providers: {
                zhipu: VALID_REPORT.providers.zhipu,
                "tailscale-ollama": { baseUrl: "http://100.64.0.1:11434/v1", api: "openai", apiKey: "k", models: { "ollama-m": {} } },
            },
        });
        assert.equal(r.status, 200, `mixed report partial-accepted: ${r.body}`);
        intake = JSON.parse(r.body) as typeof intake;
        assert.deepEqual(intake.registered, ["zhipu"]);
        assert.equal(intake.skipped.length, 1);
        assert.equal(intake.skipped[0].name, "tailscale-ollama");
        assert.match(intake.skipped[0].reason, /must be HTTPS \(or loopback HTTP\)/);
        r = await request(port, "GET", "/__bili/config");
        assert.deepEqual((JSON.parse(r.body) as { agentProviders?: Array<{ agent: string; providers: Array<{ name: string; models: string[] }> }> }).agentProviders, [{ agent: "pi", providers: [{ name: "zhipu", models: ["glm-5", "glm-5-air"] }] }], "only the registered entry lands");

        // all-invalid report: 200 with nothing registered (clears the layer), every entry named
        r = await request(port, "POST", "/__bili/agent-providers", { agent: "pi", providers: { a: { baseUrl: "https://h", api: "grpc", apiKey: "k", models: { m: {} } } } });
        assert.equal(r.status, 200, `all-invalid report answers 200-partial: ${r.body}`);
        intake = JSON.parse(r.body) as typeof intake;
        assert.deepEqual(intake.registered, []);
        assert.equal(intake.skipped.length, 1);
        assert.match(intake.skipped[0].reason, /api must be one of/);
        r = await request(port, "GET", "/__bili/config");
        assert.deepEqual((JSON.parse(r.body) as { agentProviders?: unknown }).agentProviders, [], "zero registered clears the agent layer");

        // top-level envelope violations still hard-reject
        r = await request(port, "POST", "/__bili/agent-providers", { providers: { a: VALID_REPORT.providers.zhipu } });
        assert.equal(r.status, 400);
    } finally {
        process.env.BILI_CONFIG_FILE = prevConfig === undefined ? "" : prevConfig;
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// Inline-key rail end-to-end: an apiKey-bearing target dials out with the
// inline key and no credential store involved.

const RAW = "Historical source for the inline-key dial test. ".repeat(120);

function context(externalSummary: unknown): RewriteCtx {
    const core = createCore();
    const config = defaultConfig(400_000) as Config & { externalSummary?: unknown };
    config.externalSummary = externalSummary;
    config.preserveRecentMessages = 0;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 100;
    const session: Session = createSession(`agent-providers-${Math.random()}`);
    const messages: CoreMessage[] = [
        { id: "history", role: "assistant", contentType: "text", text: RAW },
        { id: "current", role: "user", contentType: "text", text: "Current task." },
    ];
    session.state = core.processTurn({ messages, state: session.state, config, tokenCount: 10000, renderTags: "text-only" }).state;
    return { core, config, session, messages, log: () => {} };
}

test("#2336 inline apiKey target dials with the inline key (no store)", async () => {
    const seen: string[] = [];
    const upstream = http.createServer((req, res) => {
        seen.push(String(req.headers.authorization ?? ""));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chatcmpl-1", choices: [{ index: 0, message: { role: "assistant", content: "Inline summary of the range: the history was folded by the agent-reported provider with its in-memory key." }, finish_reason: "stop" }] }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const base = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}`;
    try {
        const ctx = context({ enabled: true, targets: [{ name: "agent-glm", protocol: "openai", url: `${base}/v1/chat/completions`, model: "glm-5", apiKey: "agent-resolved-key" }] });
        const startId = ctx.session.state.messageRefs.byRaw.history;
        const result = await applyConfiguredCompression({ content: [{ startId, endId: startId }] }, ctx);
        assert.equal(result.outcome, "applied", `compression applied: ${result.text}`);
        assert.deepEqual(seen, ["Bearer agent-resolved-key"], "inline key reaches the wire verbatim");
    } finally {
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
});

test("#2336/#2585 pi reportAgentProviders: sanitized table, skip rules, POST shape", async () => {
    const realFetch = globalThis.fetch;
    const prevProxy = process.env.BILLION_CONTEXT_PROXY;
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:8787";
    const calls: Array<{ url: string; body: unknown }> = [];
    const termLines: string[] = [];
    const realWarn = console.warn, realError = console.error, realLog = console.log;
    const sink = (...args: unknown[]) => { termLines.push(args.map(String).join(" ")); };
    console.warn = sink;
    console.error = sink;
    console.log = sink;
    const logBefore = existsSync(PROVIDERS_LOG_FILE) ? readFileSync(PROVIDERS_LOG_FILE, "utf8") : "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    type FakeModel = { id: string; provider: string; api?: string; contextWindow?: number; maxTokens?: number };
    const models: FakeModel[] = [
        { id: "glm-5", provider: "zhipu", api: "openai-completions", contextWindow: 200_000, maxTokens: 8192 },
        { id: "glm-5-air", provider: "zhipu", api: "openai-completions" },
        { id: "claude-haiku", provider: "claude", api: "anthropic-messages" },
        { id: "gpt-x", provider: "openai", api: "openai-responses" }, // responses mapping
        { id: "m1", provider: "bedrock", api: "bedrock-converse-stream" }, // unmapped api -> skip
        { id: "m2", provider: "bad/name", api: "openai-completions" }, // bad provider name -> skip
        { id: "m3", provider: "vertex", api: "google-vertex" }, // unmapped api -> skip
        { id: "m4", provider: "mistral", api: "mistral-conversations" }, // unmapped api -> skip
        { id: "m5", provider: "authjson", api: "openai-completions" }, // source=stored -> skip
        { id: "m6", provider: "oauthp", api: "openai-completions" }, // oauth -> skip
        { id: "m7", provider: "selfloop", api: "openai-completions" }, // baseUrl points at bili -> skip
        { id: "m8", provider: "nokey", api: "openai-completions" }, // key resolution empty -> skip
        { id: "m9", provider: "plainhttp", api: "openai-completions" }, // plain-HTTP non-loopback -> pre-skip (#2585)
        { id: "m10", provider: "codexp", api: "openai-codex-responses" }, // responses-family mapping pin (#2590)
        { id: "m11", provider: "azurep", api: "azure-openai-responses" }, // responses-family mapping pin (#2590)
    ];
    const ctx = {
        model: { baseUrl: "http://127.0.0.1:8787", api: "not-virtual" },
        modelRegistry: {
            getAll: () => models,
            getProvider: (p: string) => ({
                zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
                claude: { baseUrl: "https://api.anthropic.com" },
                openai: { baseUrl: "https://api.openai.com/v1" },
                authjson: { baseUrl: "https://a.example" },
                oauthp: { baseUrl: "https://b.example", auth: { oauth: { kind: "oauth" } } },
                selfloop: { baseUrl: "http://127.0.0.1:8787" },
                nokey: { baseUrl: "https://c.example" },
                plainhttp: { baseUrl: "http://100.64.0.1:11434/v1" },
                codexp: { baseUrl: "https://d.example" },
                azurep: { baseUrl: "https://e.example" },
            })[p],
            getProviderAuthStatus: (p: string) => ({
                zhipu: { configured: true, source: "environment" },
                claude: { configured: true, source: "models_json_key" },
                openai: { configured: true, source: "runtime" },
                authjson: { configured: true, source: "stored" },
                oauthp: { configured: true, source: "environment" },
                selfloop: { configured: true, source: "environment" },
                nokey: { configured: false },
                plainhttp: { configured: true, source: "environment" },
                codexp: { configured: true, source: "environment" },
                azurep: { configured: true, source: "environment" },
            })[p],
            getApiKeyForProvider: async (p: string) => (p === "nokey" ? undefined : `key-${p}`),
        },
    } as unknown as Ctx;
    try {
        const done = await reportAgentProviders(ctx, "pi");
        assert.equal(done, true);
        assert.equal(calls.length, 1, "exactly one POST");
        assert.equal(calls[0].url, "http://127.0.0.1:8787/__bili/agent-providers");
        const body = calls[0].body as { agent: string; providers: Record<string, { baseUrl: string; api: string; apiKey: string; models: Record<string, { contextWindow?: number; outputTokens?: number }> }> };
        assert.equal(body.agent, "pi");
        assert.deepEqual(Object.keys(body.providers).sort(), ["azurep", "claude", "codexp", "openai", "zhipu"], "skip rules applied");
        assert.deepEqual(body.providers.zhipu.models, { "glm-5": { contextWindow: 200_000, outputTokens: 8192 }, "glm-5-air": {} });
        assert.equal(body.providers.zhipu.apiKey, "key-zhipu");
        assert.equal(body.providers.openai.api, "responses", "responses-family api mapping");
        assert.equal(body.providers.codexp.api, "responses", "codex-responses-family api mapping");
        assert.equal(body.providers.azurep.api, "responses", "azure-responses-family api mapping");
        // #2585/#2831: the plain-HTTP non-loopback provider is pre-skipped and named
        // locally — in bili.log now, nothing carrying it reaches the terminal surface
        const logLines = (existsSync(PROVIDERS_LOG_FILE) ? readFileSync(PROVIDERS_LOG_FILE, "utf8") : "").slice(logBefore.length).split("\n").filter((l) => l.length > 0);
        assert.ok(logLines.some((l) => l.includes('provider "plainhttp" not reported') && l.includes("plain-HTTP non-loopback")), "pre-skip named locally");
        assert.equal(termLines.filter((l) => l.includes('provider "plainhttp" not reported')).length, 0, "#2831: must not reach the terminal surface");
        // the report is accepted by the core parser as-is (client/server contract)
        const parsed = parseAgentProviderReport(body);
        assert.deepEqual(Object.keys(parsed.registered).sort(), ["azurep", "claude", "codexp", "openai", "zhipu"]);
    } finally {
        console.warn = realWarn;
        console.error = realError;
        console.log = realLog;
        globalThis.fetch = realFetch;
        if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prevProxy;
    }
});

test("#2585 pi reportAgentProviders surfaces server refusal details and per-entry skips", async () => {
    const realFetch = globalThis.fetch;
    const prevProxy = process.env.BILLION_CONTEXT_PROXY;
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:8787";
    const termLines: string[] = [];
    const realWarn = console.warn, realError = console.error, realLog = console.log;
    const sink = (...args: unknown[]) => { termLines.push(args.map(String).join(" ")); };
    console.warn = sink;
    console.error = sink;
    console.log = sink;
    const logBefore = existsSync(PROVIDERS_LOG_FILE) ? readFileSync(PROVIDERS_LOG_FILE, "utf8") : "";
    const ctx = {
        model: { baseUrl: "http://127.0.0.1:8787", api: "not-virtual" },
        modelRegistry: {
            getAll: () => [{ id: "glm-5", provider: "zhipu", api: "openai-completions" }],
            getProvider: () => ({ baseUrl: "https://open.bigmodel.cn/api/paas/v4" }),
            getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
            getApiKeyForProvider: async () => "key-zhipu",
        },
    } as unknown as Ctx;
    try {
        // 400 with a body naming the entry -> the reason rides into the thrown error
        globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: 'Provider "tailscale-ollama" baseUrl must be HTTPS (or loopback HTTP) without credentials or proxy recursion' }), { status: 400 })) as typeof fetch;
        await assert.rejects(reportAgentProviders(ctx, "pi"), /HTTP 400: Provider "tailscale-ollama" baseUrl must be HTTPS/);
        // 200 with skipped entries -> local warns name them
        globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, registered: ["zhipu"], skipped: [{ name: "tailscale-ollama", reason: 'Provider "tailscale-ollama" baseUrl must be HTTPS (or loopback HTTP) without credentials or proxy recursion' }] }), { status: 200 })) as typeof fetch;
        assert.equal(await reportAgentProviders(ctx, "pi"), true);
        // #2831: the server-side skip is named locally in bili.log, terminal stays clean
        const logLines = (existsSync(PROVIDERS_LOG_FILE) ? readFileSync(PROVIDERS_LOG_FILE, "utf8") : "").slice(logBefore.length).split("\n").filter((l) => l.length > 0);
        assert.ok(logLines.some((l) => l.includes('provider "tailscale-ollama" not registered by bili') && l.includes("stay unresolved")), "server-side skip named locally");
        assert.equal(termLines.filter((l) => l.includes("not registered by bili")).length, 0, "#2831: must not reach the terminal surface");
        // pre-fix server body shape (no skipped field) still fine
        globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
        assert.equal(await reportAgentProviders(ctx, "pi"), true);
    } finally {
        console.warn = realWarn;
        console.error = realError;
        console.log = realLog;
        globalThis.fetch = realFetch;
        if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prevProxy;
    }
});

test("#2336 pi reportAgentProviders: no proxy base yet -> false (retry), missing registry face -> true (done)", async () => {
    const prevProxy = process.env.BILLION_CONTEXT_PROXY;
    delete process.env.BILLION_CONTEXT_PROXY;
    try {
        const retry = await reportAgentProviders({ model: { baseUrl: "https://api.openai.com", api: "not-virtual" } } as unknown as Ctx, "pi");
        assert.equal(retry, false, "no proxy base: report stays armed for the next session");
        process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:8787";
        const done = await reportAgentProviders({ model: { baseUrl: "http://127.0.0.1:8787", api: "not-virtual" }, modelRegistry: { find: () => undefined } } as unknown as Ctx, "pi");
        assert.equal(done, true, "host without the full registry face: stop trying");
    } finally {
        if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prevProxy;
    }
});
