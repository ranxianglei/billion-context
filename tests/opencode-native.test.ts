import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// The module-level guard reads NODE_TEST_CONTEXT while the module EVALUATES,
// and static imports hoist above any assignment — so the value must be set
// first and the module loaded dynamically.
process.env.NODE_TEST_CONTEXT = "1";
// #1365: legacy dead-attach suites must not pay the 5s routed-evidence grace
// default (same waitFor-cap race as dsh-native.test.ts). Pinned-path tests
// override per-test.
process.env.BILI_ATTACH_EVIDENCE_GRACE_MS = "30";

import type { NativeInterceptState } from "../src/agent/native-intercept.ts";
import type { V2HttpRequestEvent, V2PluginContext, V2State } from "../src/agent/opencode-v2.ts";
import { ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI } from "../src/compress-tool.ts";

const { shouldBootstrapNativeOpencode, createNativeRoute, planNativeOpencode, armNativeOpencode, verifyAttachAndRecover, _resetNativeStateForTest, _setSpawnForTest, _stateRespawnForTest, _noteRoutedForTest } = await import("../src/agent/opencode-native.ts");
const { createOpencodeV2Setup } = await import("../src/agent/opencode-v2.ts");
const { markNativeHost, nativeAttachOrigin } = await import("../src/agent/native-bootstrap.ts");
const nativeDefault = (await import("../src/agent/opencode-native.ts")).default;

const EXPECTED_TOOLS = [...ACP_TOOLS_OPENAI.map((t) => t.function.name), ABSORB_TOOL_OPENAI.function.name];
const MODEL_URL = "https://api.anthropic.com/v1/messages";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("shouldBootstrapNativeOpencode: true in a bare host with no bili env", () => {
    assert.equal(shouldBootstrapNativeOpencode({}), true);
});

test("shouldBootstrapNativeOpencode: false when the plugin or native mode is opted out", () => {
    assert.equal(shouldBootstrapNativeOpencode({ BILLION_CONTEXT_PLUGIN: "0" }), false);
    assert.equal(shouldBootstrapNativeOpencode({ BILI_NATIVE_OPENCODE: "0" }), false);
});

test("shouldBootstrapNativeOpencode: false when a bili launch already owns a proxy", () => {
    assert.equal(shouldBootstrapNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485" }), false);
    assert.equal(shouldBootstrapNativeOpencode({ BILLION_CONTEXT_PROXY: "  " }), true);
    assert.equal(shouldBootstrapNativeOpencode({ BILI_PROVIDER_REWRITES: '{"vllm":"http://127.0.0.1:1/bili/http://x"}' }), false);
});

test("native entry exports an OpenCode 2.x plugin object", () => {
    assert.equal(nativeDefault.id, "billion-context-opencode-native");
    assert.equal(typeof nativeDefault.setup, "function");
});

// #820 coexistence: the standalone opencode-acp extension must see this marker
// at its action-time check even though our bootstrap writes BILLION_CONTEXT_PROXY
// only later (async) and its /bili/ baseUrl check never sees our rewrite.
test("module evaluation marks the process as a native opencode host", () => {
    assert.equal(process.env.BILLION_CONTEXT_NATIVE, "opencode");
});

test("markNativeHost: sets when unset, first writer wins", () => {
    const env: NodeJS.ProcessEnv = {};
    markNativeHost(env, "pi");
    assert.equal(env.BILLION_CONTEXT_NATIVE, "pi");
    markNativeHost(env, "opencode");
    assert.equal(env.BILLION_CONTEXT_NATIVE, "pi");
    const blank: NodeJS.ProcessEnv = { BILLION_CONTEXT_NATIVE: "" };
    markNativeHost(blank, "omp");
    assert.equal(blank.BILLION_CONTEXT_NATIVE, "omp");
});

test("route: healthy origin rewrites the request reference and records proxyBase", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const body = JSON.stringify({ messages: [] });
    const e: V2HttpRequestEvent = {
        sessionID: "ses_1",
        request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer x" }, body }),
    };
    await route(e, s);
    const out = e.request as Request;
    assert.equal(out.url, `${origin}/bili/${MODEL_URL}`);
    assert.equal(out.method, "POST");
    assert.equal(out.headers.get("authorization"), "Bearer x");
    assert.equal(await out.text(), body);
    assert.equal(s.proxyBase, origin);
});

test("route: non-model-API and already-routed URLs are left untouched", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const plain = new Request("https://github.com/repos");
    const e1: V2HttpRequestEvent = { request: plain };
    await route(e1, s);
    assert.equal(e1.request, plain);
    const routed = new Request(`${origin}/bili/${MODEL_URL}`);
    const e2: V2HttpRequestEvent = { request: routed };
    await route(e2, s);
    assert.equal(e2.request, routed);
    assert.equal(s.proxyBase, undefined);
});

test("route: waits for a pending bootstrap before routing", async () => {
    let release!: (o: string) => void;
    const state: NativeInterceptState = { origin: undefined, ready: new Promise<string | undefined>((r) => (release = r)) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const e: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    const pending = route(e, s);
    release("http://127.0.0.1:4321");
    await pending;
    assert.equal((e.request as Request).url, `http://127.0.0.1:4321/bili/${MODEL_URL}`);
});

test("route: failed bootstrap sends direct with a single warning (no respawn wired)", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const origError = console.error;
    const warnings: string[] = [];
    console.error = (...args: unknown[]) => {
        warnings.push(args.join(" "));
    };
    try {
        const e1: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
        await route(e1, s);
        assert.equal((e1.request as Request).url, MODEL_URL);
        const e2: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
        await route(e2, s);
        assert.equal((e2.request as Request).url, MODEL_URL);
        assert.equal(s.proxyBase, undefined);
        assert.equal(warnings.filter((w) => w.includes("bili-native-opencode")).length, 1);
    } finally {
        console.error = origError;
    }
});

test("route: dead origin respawns once and routes to the replacement", async () => {
    const dead = "http://127.0.0.1:1111";
    const live = "http://127.0.0.1:2222";
    const state: NativeInterceptState = {
        origin: dead,
        ready: Promise.resolve(dead),
        respawn: async () => {
            state.origin = live;
            return live;
        },
    };
    const route = createNativeRoute(state, { probe: async (o) => o === live });
    const s: V2State = {};
    const e: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e, s);
    assert.equal((e.request as Request).url, `${live}/bili/${MODEL_URL}`);
    assert.equal(s.proxyBase, live);
});

test("route: failed respawn fires onGiveUp once and holds direct (cooldown suppresses re-spawn)", async () => {
    const dead = "http://127.0.0.1:1111";
    let gaveUp = 0;
    let respawns = 0;
    const state: NativeInterceptState = {
        origin: dead,
        ready: Promise.resolve(dead),
        respawn: async () => {
            respawns++;
            return undefined;
        },
        onGiveUp: () => {
            gaveUp++;
        },
    };
    const route = createNativeRoute(state, { probe: async () => false });
    const s: V2State = {};
    const e1: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e1, s);
    assert.equal((e1.request as Request).url, MODEL_URL);
    assert.equal(gaveUp, 1);
    assert.equal(respawns, 1);
    const e2: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e2, s);
    assert.equal(gaveUp, 1);
    assert.equal(respawns, 1);
});

test("route: load-time bootstrap failure retries after the cooldown only", async () => {
    let respawns = 0;
    const state: NativeInterceptState = {
        origin: undefined,
        ready: Promise.resolve(undefined),
        respawn: async () => {
            respawns++;
            return undefined;
        },
    };
    const route = createNativeRoute(state, { probe: async () => true, respawnCooldownMs: 10 });
    const s: V2State = {};
    const e1: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e1, s);
    assert.equal(respawns, 1);
    const e2: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e2, s);
    assert.equal(respawns, 1);
    await sleep(15);
    const e3: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e3, s);
    assert.equal(respawns, 2);
});

test("setup(route): header stamping applies to the REPLACED request, tools register natively", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const hooks: Array<{ name: string; cb: (e: V2HttpRequestEvent) => void | Promise<void> }> = [];
    const tools: string[] = [];
    const ctx: V2PluginContext = {
        session: {
            hook: (name, cb) => {
                hooks.push({ name, cb });
                return { dispose() {} };
            },
        },
        tool: {
            transform: (add) => {
                add({ add: (t) => tools.push(t.name) });
                return { dispose() {} };
            },
        },
    };
    const setup = createOpencodeV2Setup({ route: createNativeRoute(state, { probe: async () => true }) });
    const cleanup = await setup(ctx);
    assert.deepEqual(hooks.map((h) => h.name), ["http.request"]);
    assert.deepEqual(tools.sort(), [...EXPECTED_TOOLS].sort());
    const e: V2HttpRequestEvent = {
        sessionID: "ses_abc",
        model: { providerID: "anthropic", id: "claude-x" },
        request: new Request(MODEL_URL, { method: "POST" }),
    };
    await hooks[0].cb(e);
    const out = e.request as Request;
    assert.equal(out.url, `${origin}/bili/${MODEL_URL}`);
    assert.equal(out.headers.get("x-bili-plugin-conversation"), "ses_abc");
    assert.equal(out.headers.get("x-bili-plugin"), "opencode");
    cleanup();
});

test("setup(route): kill switch keeps the hook fully inert", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const hooks: Array<(e: V2HttpRequestEvent) => void | Promise<void>> = [];
    const ctx: V2PluginContext = {
        session: {
            hook: (_name, cb) => {
                hooks.push(cb);
                return { dispose() {} };
            },
        },
    };
    const setup = createOpencodeV2Setup({ route: createNativeRoute(state, { probe: async () => true }) });
    const cleanup = await setup(ctx);
    process.env.BILLION_CONTEXT_PLUGIN = "0";
    try {
        const req = new Request(MODEL_URL);
        const e: V2HttpRequestEvent = { sessionID: "ses_x", request: req };
        await hooks[0](e);
        assert.equal(e.request, req);
    } finally {
        delete process.env.BILLION_CONTEXT_PLUGIN;
        cleanup();
    }
});

test("nativeAttachOrigin: unset/blank/malformed/non-http(s) all resolve to undefined", () => {
    assert.equal(nativeAttachOrigin({}), undefined);
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "" }), undefined);
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "   " }), undefined);
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "not a url" }), undefined);
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "ftp://127.0.0.1:21" }), undefined);
});

test("nativeAttachOrigin: normalizes a valid http(s) origin (trailing slash stripped)", () => {
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "http://127.0.0.1:8787" }), "http://127.0.0.1:8787");
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "http://127.0.0.1:8787///" }), "http://127.0.0.1:8787");
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "  https://proxy.example.com/ " }), "https://proxy.example.com");
});

test("planNativeOpencode: default is spawn; opt-out and /bili/ launches are off", () => {
    assert.deepEqual(planNativeOpencode({}), { mode: "spawn" });
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeOpencode({ BILI_NATIVE_OPENCODE: "0" }), { mode: "off" });
    assert.deepEqual(planNativeOpencode({ BILI_PROVIDER_REWRITES: '{"vllm":"http://127.0.0.1:1/bili/http://x"}' }), { mode: "off" });
});

test("planNativeOpencode: a preset BILLION_CONTEXT_PROXY is an attach target, not a stand-down", () => {
    assert.deepEqual(
        planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485" }),
        { mode: "attach", attachOrigin: "http://127.0.0.1:36485" },
    );
    assert.deepEqual(
        planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485/" }),
        { mode: "attach", attachOrigin: "http://127.0.0.1:36485" },
    );
    // kill switches and a /bili/ launch still win over the preset
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILI_PROVIDER_REWRITES: "{}" }), { mode: "off" });
    // a garbage preset falls back to spawn (self-managed) rather than dead-off
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "garbage" }), { mode: "spawn" });
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "  " }), { mode: "spawn" });
});

test("planNativeOpencode: attach wins over spawn when no launcher owns the proxy", () => {
    assert.deepEqual(
        planNativeOpencode({ BILLION_CONTEXT_ATTACH: "http://10.0.0.5:9000/" }),
        { mode: "attach", attachOrigin: "http://10.0.0.5:9000" },
    );
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_ATTACH: "garbage" }), { mode: "spawn" });
});

test("planNativeOpencode: explicit BILLION_CONTEXT_ATTACH wins over the env preset", () => {
    assert.deepEqual(
        planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILLION_CONTEXT_ATTACH: "http://10.0.0.5:9000" }),
        { mode: "attach", attachOrigin: "http://10.0.0.5:9000" },
    );
});

test("native route: attach mode routes model traffic through the external proxy", async () => {
    const origin = "http://10.0.0.5:9000";
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        attach: true,
        origin,
        ready: Promise.resolve(origin),
        respawn: async () => {
            respawnCalls++;
            return undefined;
        },
    };
    const s: V2State = {};
    const route = createNativeRoute(state, { probe: async () => true });
    const e: V2HttpRequestEvent = { sessionID: "ses_a", request: new Request(MODEL_URL, { method: "POST" }) };
    await route(e, s);
    assert.equal((e.request as Request).url, `${origin}/bili/${MODEL_URL}`);
    assert.equal(s.proxyBase, origin);
    assert.equal(respawnCalls, 0);
});

// #1135: the old fail-closed semantics are gone — with no respawn wired the
// dead target degrades to DIRECT sends (session survives, compression lost)
// instead of failing every request forever.
test("native route: attach mode degrades to direct when the external proxy is down and no respawn is wired", async () => {
    const origin = "http://10.0.0.5:9000";
    const state: NativeInterceptState = { attach: true, origin, ready: Promise.resolve(origin) };
    const s: V2State = {};
    const warns: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => {
        warns.push(a.join(" "));
    };
    try {
        const route = createNativeRoute(state, { probe: async () => false });
        await route({ sessionID: "ses_b", request: new Request(MODEL_URL, { method: "POST" }) }, s);
        const second: V2HttpRequestEvent = { sessionID: "ses_b", request: new Request(MODEL_URL, { method: "POST" }) };
        await route(second, s);
        assert.equal((second.request as Request).url, MODEL_URL, "dead target without respawn sends direct, not into the dead port");
        assert.equal(s.proxyBase, undefined);
        assert.ok(warns.some((w) => w.includes("proxy unavailable")), "expected an unavailability diagnostic");
        assert.ok(warns.filter((w) => w.includes("proxy unavailable")).length === 1, "expected exactly one warning");
    } finally {
        console.error = origErr;
    }
});

test("native route: attach mode respawns on runtime death and routes to the replacement (#1135)", async () => {
    const ext = "http://10.0.0.5:9000";
    const spawned = "http://127.0.0.1:4321";
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        attach: true,
        origin: ext,
        ready: Promise.resolve(ext),
        respawn: async () => {
            respawnCalls++;
            state.origin = spawned;
            return spawned;
        },
    };
    const probe = async (o: string) => o !== ext;
    const s: V2State = {};
    const route = createNativeRoute(state, { probe });
    const e: V2HttpRequestEvent = { sessionID: "ses_d", request: new Request(MODEL_URL, { method: "POST" }) };
    await route(e, s);
    assert.equal(respawnCalls, 1, "one respawn per death");
    assert.equal((e.request as Request).url, `${spawned}/bili/${MODEL_URL}`, "request re-routed to the replacement");
    assert.equal(s.proxyBase, spawned);
    // next request fast-paths through the landed origin
    const e2: V2HttpRequestEvent = { sessionID: "ses_d", request: new Request(MODEL_URL, { method: "POST" }) };
    await route(e2, s);
    assert.equal(respawnCalls, 1, "no re-spawn while the replacement is healthy");
    assert.equal((e2.request as Request).url, `${spawned}/bili/${MODEL_URL}`);
});

test("native route: attach mode transient blip re-attaches to the SAME origin (no migration, #1135)", async () => {
    const ext = "http://10.0.0.5:9000";
    let up = false;
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        attach: true,
        origin: ext,
        ready: Promise.resolve(ext),
        respawn: async () => {
            respawnCalls++;
            up = true;
            state.origin = ext;
            return ext;
        },
    };
    const s: V2State = {};
    const route = createNativeRoute(state, { probe: async () => up, probeTtlMs: 0 });
    const e: V2HttpRequestEvent = { sessionID: "ses_e", request: new Request(MODEL_URL, { method: "POST" }) };
    await route(e, s);
    assert.equal(respawnCalls, 1);
    assert.equal((e.request as Request).url, `${ext}/bili/${MODEL_URL}`, "re-attached to the same origin");
    assert.equal(state.origin, ext);
    assert.equal(s.proxyBase, ext);
});

test("native route: attach mode leaves non-model requests untouched", async () => {
    const origin = "http://10.0.0.5:9000";
    const state: NativeInterceptState = { attach: true, origin, ready: Promise.resolve(origin) };
    const s: V2State = {};
    const route = createNativeRoute(state, { probe: async () => true });
    const req = new Request("https://api.anthropic.com/v1/models", { method: "GET" });
    const e: V2HttpRequestEvent = { sessionID: "ses_c", request: req };
    await route(e, s);
    assert.equal(e.request, req);
    assert.equal(s.proxyBase, undefined);
});

test("#1135 wiring: attach arms runtime recovery; a dead target falls back to a spawned proxy", async () => {
    const savedProxy = process.env.BILLION_CONTEXT_PROXY;
    try {
        _resetNativeStateForTest();
        let spawned = 0;
        _setSpawnForTest(async () => {
            spawned++;
            return "http://127.0.0.1:7777";
        });
        armNativeOpencode({ mode: "attach", attachOrigin: "http://127.0.0.1:9" });
        assert.equal(typeof _stateRespawnForTest(), "function", "respawn seam armed at load");
        // port 9 refuses connections instantly — the manifest probe fails fast,
        // the fallback spawn lands and replaces the env origin
        const landed = await _stateRespawnForTest()!();
        assert.equal(landed, "http://127.0.0.1:7777");
        assert.ok(spawned >= 1);
        assert.equal(process.env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:7777");
    } finally {
        if (savedProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = savedProxy;
        _resetNativeStateForTest();
    }
});

test("#1135 wiring: a healthy attach target stays attached (no migration, no spawn)", async () => {
    const savedProxy = process.env.BILLION_CONTEXT_PROXY;
    const server = createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ version: "0.1.134" }));
            return;
        }
        res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
        _resetNativeStateForTest();
        let spawned = 0;
        _setSpawnForTest(async () => {
            spawned++;
            return "http://127.0.0.1:7778";
        });
        armNativeOpencode({ mode: "attach", attachOrigin: `http://127.0.0.1:${port}` });
        const landed = await _stateRespawnForTest()!();
        assert.equal(landed, `http://127.0.0.1:${port}`, "healthy target resolves to itself");
        assert.equal(spawned, 0, "no fallback spawn for a healthy target");
        assert.equal(process.env.BILLION_CONTEXT_PROXY, `http://127.0.0.1:${port}`);
    } finally {
        server.close();
        if (savedProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = savedProxy;
        _resetNativeStateForTest();
    }
});

// #928: the health verdict is TTL-cached per origin. Steady-state requests must
// reuse the last result instead of paying a loopback RTT on every request.
test("route: healthy origin triggers a single health probe across N steady-state requests (#928)", async () => {
    const origin = "http://127.0.0.1:9999";
    let calls = 0;
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => { calls++; return true; }, probeTtlMs: 10_000 });
    const s: V2State = {};
    for (let i = 0; i < 5; i++) {
        const e: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
        await route(e, s);
        assert.equal((e.request as Request).url, `${origin}/bili/${MODEL_URL}`);
    }
    assert.equal(calls, 1, "expected exactly one probe for N requests within the TTL");
});

test("route: re-probes once the probe TTL elapses rather than latching forever (#928)", async () => {
    const origin = "http://127.0.0.1:9999";
    let calls = 0;
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => { calls++; return true; }, probeTtlMs: 20 });
    const s: V2State = {};
    await route({ request: new Request(MODEL_URL) }, s);
    assert.equal(calls, 1);
    await sleep(45);
    await route({ request: new Request(MODEL_URL) }, s);
    assert.equal(calls, 2, "expected a fresh probe after the TTL elapsed");
});

test("route: a proxy that dies is detected within one TTL and degrades to direct (#928)", async () => {
    const origin = "http://127.0.0.1:9999";
    let alive = true;
    let calls = 0;
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => { calls++; return alive; }, probeTtlMs: 30 });
    const s: V2State = {};
    const up: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(up, s);
    assert.equal((up.request as Request).url, `${origin}/bili/${MODEL_URL}`);
    assert.equal(calls, 1);
    alive = false;
    await sleep(45);
    const down: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(down, s);
    assert.equal((down.request as Request).url, MODEL_URL, "expected an unrewritten (direct) request after the proxy died");
    assert.ok(calls >= 2, "expected a re-probe within one TTL that observed the dead proxy");
});

// — #1365: pinned model channel — never spawn over a statically-routed target —

async function reserveLoopbackPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address() as AddressInfo;
            srv.close(() => resolve(addr.port));
        });
        srv.on("error", reject);
    });
}

test("#1365 verifyAttachAndRecover: routed evidence pins the channel — waits the target back, never spawns", async () => {
    const port = await reserveLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: "0.1.119", tools: {} }));
    });
    let spawnCalls = 0;
    let upTimer: NodeJS.Timeout | undefined;
    try {
        _resetNativeStateForTest();
        _setSpawnForTest(async () => {
            spawnCalls += 1;
            return "http://127.0.0.1:2";
        });
        process.env.BILLION_CONTEXT_PROXY = origin;
        _noteRoutedForTest(`${origin}/bili/${MODEL_URL}`);
        const pending = verifyAttachAndRecover(origin);
        upTimer = setTimeout(() => server.listen(port, "127.0.0.1"), 120);
        const recovered = await pending;
        clearTimeout(upTimer);
        assert.equal(recovered, origin, "recovery lands back on the pinned origin");
        assert.equal(spawnCalls, 0, "no second instance may be spawned over a pinned channel");
        assert.equal(process.env.BILLION_CONTEXT_PROXY, origin, "the user's target stays frozen");
    } finally {
        clearTimeout(upTimer);
        server.close();
        delete process.env.BILLION_CONTEXT_PROXY;
        _setSpawnForTest(undefined);
        _resetNativeStateForTest();
    }
});

test("#1365 route: already-routed /bili/ URLs record pinned-channel evidence before the model-URL gate", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const routed = new Request(`${origin}/bili/${MODEL_URL}`);
    const e: V2HttpRequestEvent = { request: routed };
    await route(e, s);
    assert.equal(e.request, routed, "already-routed requests stay untouched");
    assert.equal(state.routedOrigin, origin, "routed traffic records the pinned channel even though isModelApiUrl skips it");
});

test("#1365 verifyAttachAndRecover: persistently dead pinned target — refuses to spawn, keeps the env", async () => {
    const port = await reserveLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    let spawnCalls = 0;
    try {
        _resetNativeStateForTest();
        _setSpawnForTest(async () => {
            spawnCalls += 1;
            return "http://127.0.0.1:2";
        });
        process.env.BILLION_CONTEXT_PROXY = origin;
        process.env.BILI_ATTACH_HEALTH_DEADLINE_MS = "150";
        _noteRoutedForTest(`${origin}/bili/${MODEL_URL}`);
        const recovered = await verifyAttachAndRecover(origin);
        assert.equal(recovered, undefined);
        assert.equal(spawnCalls, 0);
        assert.equal(process.env.BILLION_CONTEXT_PROXY, origin, "the pinned target env must survive");
    } finally {
        delete process.env.BILLION_CONTEXT_PROXY;
        delete process.env.BILI_ATTACH_HEALTH_DEADLINE_MS;
        _setSpawnForTest(undefined);
        _resetNativeStateForTest();
    }
});
