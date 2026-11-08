// #5931 — opencode v2.2.6 inline mode: effect 4.1.0 caches the native fetch in
// FetchHttpClient.Fetch on first resolution, so model requests can leave
// through an unpatched fetch while createNativeRoute has already rewritten the
// URL to http://billion-context.inline/bili/<url> → unintercepted pseudo-origin
// traffic → 302 HTML instead of SSE → "stream ended without finish_reason" and
// endless retries. Fix under test (B′): the inline route stops rewriting to the
// pseudo-origin — the wire keeps the REAL upstream URL plus the stamped
// x-bili-* headers, and the installed fetch chain performs the rewrite when
// (and only when) egress actually passes through it. A bypassing host then
// degrades to a direct uncompressed send instead of voiding. The incremental
// lane may only swap its lane-only envelope after at least one chain-carried
// model send has been observed (chainEgressSeen); until then a bypassing host
// keeps sending full-resend bodies the upstream understands.
import { after, test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_TEST_CONTEXT = "1";

const { createNativeRoute, maybeIncrementalOpencode, _resetNativeStateForTest, _nativeStateForTest, __resetOpencodeIncrementalForTests } = await import("../src/agent/opencode-native.ts");
const { __resetIncrementalClientForTests, INCREMENTAL_TURN_MARKER_HEADER } = await import("../src/agent/incremental-client.ts");
const { installNativeFetchIntercept } = await import("../src/agent/native-intercept.ts");
const { INLINE_ORIGIN } = await import("../src/inline-engine.ts");
import type { V2HttpRequestEvent, V2State } from "../src/agent/opencode-v2.ts";
import type { NativeInterceptState } from "../src/agent/native-intercept.ts";
import type { LivenessVerdict } from "../src/liveness.ts";

const MODEL_URL = "https://api.anthropic.com/v1/messages";
const FAKE_PROXY_BASE = "http://127.0.0.1:1";
const BODY = { model: "claude-test", max_tokens: 512, system: "be terse", messages: [{ role: "user", content: "hello opencode" }] };

function fakeEvent(body: unknown, sid: string): V2HttpRequestEvent {
    const req = new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { request: req, sessionID: sid } as unknown as V2HttpRequestEvent;
}

function emptyV2State(): V2State {
    return { proxyBase: undefined } as unknown as V2State;
}

const urlOf = (input: string | URL | Request): string =>
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const aliveProbe = async (): Promise<LivenessVerdict> => ({ state: "alive" });

after(() => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
});

test("inline route keeps the real upstream URL and pins proxyBase (no pseudo-origin rewrite)", async () => {
    const s = { origin: INLINE_ORIGIN, ready: Promise.resolve(undefined) } as NativeInterceptState;
    const route = createNativeRoute(s, { probe: aliveProbe });
    const e = fakeEvent(BODY, "oc-5931-t1");
    const st = emptyV2State();
    await route(e, st);
    assert.equal((e.request as Request).url, MODEL_URL, "inline mode must NOT rewrite to the pseudo-origin");
    assert.equal(st.proxyBase, INLINE_ORIGIN, "stamping/tools/fork still bind to the inline engine origin");
});

test("non-inline origin still rewrites to /bili/ (gate scoped to INLINE_ORIGIN only)", async () => {
    const s = { origin: FAKE_PROXY_BASE, ready: Promise.resolve(undefined) } as NativeInterceptState;
    const route = createNativeRoute(s, { probe: aliveProbe });
    const e = fakeEvent(BODY, "oc-5931-t2");
    const st = emptyV2State();
    await route(e, st);
    assert.equal((e.request as Request).url, `${FAKE_PROXY_BASE}/bili/${MODEL_URL}`, "spawn/attach routing is untouched");
    assert.equal(st.proxyBase, FAKE_PROXY_BASE);
});

test("incremental: inline base without observed chain egress does NOT swap (direct send stays full-resend)", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        fetchCalls++;
        throw new Error("no network in this test");
    };
    try {
        const e = fakeEvent(BODY, "oc-5931-t3");
        await maybeIncrementalOpencode(e, { proxyBase: INLINE_ORIGIN } as unknown as V2State);
        assert.equal(fetchCalls, 0, "the evidence gate must short-circuit BEFORE the lane probe");
        assert.equal((e.request as Request).url, MODEL_URL);
        assert.equal(await (e.request as Request).clone().text(), JSON.stringify(BODY), "lane-only envelope must never be sent by a bypassing host");
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("a chain-carried model send sets chainEgressSeen, and the inline incremental swap then proceeds", async () => {
    _resetNativeStateForTest();
    const modState = _nativeStateForTest();

    // Phase 1: drive a real dispatch through the installed intercept bound to
    // the module state — the success site is the single chokepoint that records
    // chain-carried egress (#3394 live-slot discipline).
    const innerCalls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const u = urlOf(input);
        innerCalls.push(u);
        if (u === `${FAKE_PROXY_BASE}/bili/${MODEL_URL}`) {
            return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
        }
        throw new Error(`unexpected fetch ${u}`);
    };
    try {
        modState.origin = FAKE_PROXY_BASE;
        modState.ready = Promise.resolve(undefined);
        assert.equal(installNativeFetchIntercept(modState), true, "fresh test process installs the intercept exactly once");
        await fetch(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        assert.deepEqual(innerCalls, [`${FAKE_PROXY_BASE}/bili/${MODEL_URL}`], "model branch rewrote to /bili/ inside the chain");
        assert.equal(modState.chainEgressSeen, true, "success site records the chain-carried send");
    } finally {
        globalThis.fetch = origFetch;
    }

    // Phase 2: with evidence present, the same inline-base request swaps.
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const probeCalls: string[] = [];
    globalThis.fetch = async (input: string | URL | Request) => {
        const u = urlOf(input);
        probeCalls.push(u);
        if (u === `${INLINE_ORIGIN}/__bili/plugin/turn`) {
            return new Response(
                JSON.stringify({ ok: true, protocol: 1, feature: "pluginIncrementalTurns", enabled: true, storage: "unified" }),
                { status: 200, headers: { "content-type": "application/json" } },
            );
        }
        throw new Error(`unexpected fetch ${u}`);
    };
    try {
        const e = fakeEvent(BODY, "oc-5931-t4");
        await maybeIncrementalOpencode(e, { proxyBase: INLINE_ORIGIN } as unknown as V2State);
        assert.deepEqual(probeCalls, [`${INLINE_ORIGIN}/__bili/plugin/turn`]);
        const req = e.request as Request;
        assert.equal(req.url, MODEL_URL, "swap preserves the real upstream URL");
        assert.equal(req.headers.get(INCREMENTAL_TURN_MARKER_HEADER), "1");
        const text = await req.clone().text();
        assert.notEqual(text, JSON.stringify(BODY), "seed swap replaced the body with the lane payload");
    } finally {
        globalThis.fetch = origFetch;
    }
});
