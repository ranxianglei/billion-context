// #1958: OpenCode V2 native route — model requests that ALREADY carry a
// `/bili/` prefix used to skip proxyBase initialization entirely (the routed
// gate returned before any origin was recorded on the hook state), so every
// request of such a session arrived at the proxy WITHOUT x-bili-plugin /
// x-bili-plugin-conversation / window / output markers: plugin identity was
// never bound even though the traffic already rode bili. The fix binds the
// hook's stamping base to the origin baked into the request URL — no rewrite,
// no resolveLive, no respawn (pinned channels must not follow a replacement,
// #1365/#1370).
import test from "node:test";
import assert from "node:assert/strict";

// Module-level guards read env while opencode-native EVALUATES; static imports
// hoist above any assignment, so set the marker first and import dynamically
// (same pattern as opencode-native.test.ts).
process.env.NODE_TEST_CONTEXT = "1";

import type { NativeInterceptState } from "../src/agent/native-intercept.ts";
import type { V2HttpRequestEvent, V2PluginContext, V2State } from "../src/agent/opencode-v2.ts";

const { createNativeRoute } = await import("../src/agent/opencode-native.ts");
const { createOpencodeV2Setup } = await import("../src/agent/opencode-v2.ts");

const ORIGIN = "http://127.0.0.1:9999";
const UPSTREAM = "http://example.invalid/v1/chat/completions";
const ROUTED_URL = `${ORIGIN}/bili/${UPSTREAM}`;

function v2Ctx(captureHook: (cb: (e: V2HttpRequestEvent) => void | Promise<void>) => void): V2PluginContext {
    return {
        session: { hook: (_name: string, cb: (e: V2HttpRequestEvent) => void | Promise<void>) => captureHook(cb) },
        model: { list: async () => ({ data: [{ providerID: "test", id: "model", limit: { context: 1_000_000, output: 384_000 } }] }) },
    };
}

test("#1958: already-routed model request keeps its URL and carries the plugin session headers", async () => {
    let hook: ((e: V2HttpRequestEvent) => void | Promise<void>) | undefined;
    const ctx = v2Ctx((cb) => { hook = cb; });
    const dispose = await createOpencodeV2Setup({
        route: createNativeRoute({ origin: ORIGIN, ready: Promise.resolve(ORIGIN) }, { probe: async () => true }),
    })(ctx);
    try {
        const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
        const event: V2HttpRequestEvent = {
            sessionID: "ses_repro",
            model: { providerID: "test", id: "model" },
            request: new Request(ROUTED_URL, { method: "POST", headers: { authorization: "Bearer keep-me" }, body }),
        };
        assert.ok(hook);
        await hook(event);
        // refreshWindows commits through microtask hops — flush before the
        // second pass that stamps from the committed map.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await hook(event);
        const request = event.request as Request;
        assert.equal(request.url, ROUTED_URL, "an already-routed URL must not be rewritten");
        assert.equal(request.method, "POST");
        assert.equal(request.headers.get("authorization"), "Bearer keep-me", "existing headers are preserved");
        assert.equal(await request.text(), body, "the body stream is untouched");
        assert.equal(request.headers.get("x-bili-plugin"), "opencode");
        assert.equal(request.headers.get("x-bili-plugin-conversation"), "ses_repro");
        assert.equal(request.headers.get("x-bili-plugin-context-window"), "1000000");
        assert.equal(request.headers.get("x-bili-plugin-max-output"), "384000");
        assert.equal(request.headers.get("x-bili-plugin-model"), "model");
    } finally {
        dispose();
    }
});

test("#1958: the baked URL origin wins over the lifecycle origin; no respawn is triggered", async () => {
    const other = "http://127.0.0.1:7777";
    let respawns = 0;
    const state: NativeInterceptState = {
        origin: other,
        ready: Promise.resolve(other),
        respawn: async () => { respawns += 1; return undefined; },
    };
    const s: V2State = {};
    const route = createNativeRoute(state, { probe: async () => true });
    const e: V2HttpRequestEvent = { sessionID: "ses_pin", request: new Request(ROUTED_URL, { method: "POST" }) };
    await route(e, s);
    assert.equal(s.proxyBase, ORIGIN, "stamping base comes from the request URL, not state.origin");
    assert.equal((e.request as Request).url, ROUTED_URL, "a pinned channel is never migrated (#1365/#1370)");
    assert.equal(respawns, 0, "a pinned channel must not drive a second instance");
    assert.equal(state.routedOrigin, ORIGIN);
});

test("#1958: a raw model URL is rewritten exactly once; the routed form then passes through", async () => {
    const state: NativeInterceptState = { origin: ORIGIN, ready: Promise.resolve(ORIGIN) };
    const s: V2State = {};
    const route = createNativeRoute(state, { probe: async () => true });
    let e: V2HttpRequestEvent = { sessionID: "ses_once", request: new Request(UPSTREAM, { method: "POST" }) };
    await route(e, s);
    assert.equal((e.request as Request).url, ROUTED_URL);
    assert.equal(s.proxyBase, ORIGIN);
    e = { sessionID: "ses_once", request: e.request as Request };
    await route(e, s);
    assert.equal((e.request as Request).url, ROUTED_URL, "the routed form must not be re-wrapped");
});

test("#1958: non-model /bili/ requests and control paths do not bind proxyBase", async () => {
    const state: NativeInterceptState = { origin: ORIGIN, ready: Promise.resolve(ORIGIN) };
    const s: V2State = {};
    const route = createNativeRoute(state, { probe: async () => true });
    const catalog = new Request(`${ORIGIN}/bili/http://example.invalid/v1/models`);
    const e1: V2HttpRequestEvent = { request: catalog };
    await route(e1, s);
    assert.equal(e1.request, catalog);
    assert.equal(s.proxyBase, undefined, "catalog fetches are not model inference — no plugin identity");
    const health = new Request(`${ORIGIN}/__bili/health`);
    const e2: V2HttpRequestEvent = { request: health };
    await route(e2, s);
    assert.equal(e2.request, health);
    assert.equal(s.proxyBase, undefined, "control paths stay untouched");
});
