import test from "node:test";
import assert from "node:assert/strict";

// The module-level guard reads NODE_TEST_CONTEXT while the module EVALUATES,
// and static imports hoist above any assignment — so the value must be set
// first and the module loaded dynamically.
process.env.NODE_TEST_CONTEXT = "1";

import type { NativeInterceptState } from "../src/agent/native-intercept.ts";
import type { V2HttpRequestEvent, V2PluginContext, V2State } from "../src/agent/opencode-v2.ts";
import { ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI } from "../src/compress-tool.ts";

const { shouldBootstrapNativeOpencode, createNativeRoute } = await import("../src/agent/opencode-native.ts");
const { createOpencodeV2Setup } = await import("../src/agent/opencode-v2.ts");
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
