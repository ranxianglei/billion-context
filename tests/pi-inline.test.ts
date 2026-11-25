// #3278: pi inline lane — the no-server mode. Two layers under test:
//  1. the fetch-chain transport link (pi-inline.ts): pseudo-origin traffic is
//     served in-process, foreign traffic passes through, engine failure
//     degrades model traffic to direct upstream while management calls fail loud;
//  2. the in-process engine itself (inline-engine.ts): the real pipeline boots
//     without any proxy process, serves model + admin traffic against a local
//     mock upstream, makes exactly ONE upstream round trip per request (loop
//     safety), and tracks the session in-process.
import { after, test } from "node:test";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Hermetic storage BEFORE anything store-touching loads (same pattern as
// opencode-native.test.ts): the real engine boot writes sessions/logs here.
// All THREE XDG homes: sessions live under XDG_DATA_HOME, the conversation
// routing table under XDG_STATE_HOME — a missing one leaks debounced writes
// into the real store after env restore.
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pi-inline-state-"));
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pi-inline-data-"));
const CONFIG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pi-inline-config-"));
const PREV_STATE = process.env.XDG_STATE_HOME;
const PREV_DATA = process.env.XDG_DATA_HOME;
const PREV_CONFIG = process.env.XDG_CONFIG_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
process.env.XDG_DATA_HOME = DATA_ROOT;
process.env.XDG_CONFIG_HOME = CONFIG_ROOT;
after(async () => {
    // Force the debounced writers out while the hermetic dirs are still bound.
    try {
        const { flushConversations } = await import("../src/plugin.ts");
        const { flushAllSessions } = await import("../src/session.ts");
        flushConversations();
        await flushAllSessions();
    } catch { /* engine never booted in this run */ }
    if (PREV_STATE === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_STATE;
    if (PREV_DATA === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = PREV_DATA;
    if (PREV_CONFIG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = PREV_CONFIG;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
    fs.rmSync(CONFIG_ROOT, { recursive: true, force: true });
});

const hits: string[] = [];
let slowCompleted = false;
const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        hits.push(`${req.method} ${req.url}`);
        if (req.url === "/v1/messages") {
            const reply = () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_1",
                    type: "message",
                    role: "assistant",
                    model: "test-model",
                    content: [{ type: "text", text: "hello-inline" }],
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: { input_tokens: 10, output_tokens: 5 },
                }));
            };
            if (body.includes("slow-please")) {
                // Cancel-parity probe (#3278 review): a deliberately slow
                // completion on the real model lane — if the in-process round
                // trip is truly aborted, this never fires.
                setTimeout(() => {
                    if (res.destroyed) return;
                    slowCompleted = true;
                    reply();
                }, 2500);
            } else {
                reply();
            }
        } else {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "not found" }));
        }
    });
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
after(() => {
    upstream.closeAllConnections();
    upstream.close();
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<never>((_, rej) => {
            const t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms);
            t.unref?.();
        }),
    ]);
}

async function freshChain() {
    const fc = await import("../src/agent/fetch-chain/index.ts");
    const piInline = await import("../src/agent/pi-inline.ts");
    fc.resetFetchChainForTest();
    piInline._resetInlineTransportForTest();
    piInline.installInlineTransport();
    return piInline;
}

// #6841 rework: a minimal stand-in for the pi-web-access 0.46.0 shared proxy
// wrapper — the shape the real bundle installs when its proxy scope is on:
// with a scope active, any http(s) URL that is NOT on its bypass list is
// handled by the wrapper itself (it curls it) and never reaches the fetch
// below; with no scope active it passes through untouched. It marks itself
// with __piWebAccessSharedProxyFetch only (0.46+ behavior). `seenByWrapper`
// records what the wrapper actually observed, and `proxyCalls` records what
// its scope claimed — the assertions that prove inline traffic never reaches
// either.
function installScopeWrapper() {
    const proxyScope = new AsyncLocalStorage<boolean>();
    const proxyCalls: string[] = [];
    const seenByWrapper: string[] = [];
    const base = globalThis.fetch;
    const wrapper = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seenByWrapper.push(url);
        if (proxyScope.getStore() === true && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(url)) {
            proxyCalls.push(url);
            return new Response("proxy-handled");
        }
        return base(input, init);
    }) as typeof fetch;
    Object.defineProperty(wrapper, "__piWebAccessSharedProxyFetch", { value: true, configurable: true });
    globalThis.fetch = wrapper;
    return { proxyScope, proxyCalls, seenByWrapper };
}

test("#3278 transport: pseudo-origin URLs are served in-process, foreign URLs pass through", async () => {
    const ie = await import("../src/inline-engine.ts");
    const calls: string[] = [];
    ie._setEngineFactoryForTest(async () => ({
        origin: ie.INLINE_ORIGIN,
        dispatch: async (input: string | URL | Request): Promise<Response> => {
            calls.push(String(input));
            return new Response("inline-ok");
        },
        dispatchHttp: async () => {},
        wsOrigin: Promise.resolve(undefined),
        webOrigin: Promise.resolve(undefined),
    }));
    try {
        await freshChain();
        const r = await withTimeout(fetch(`${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`), 10_000, "inline dispatch");
        assert.equal(r.status, 200);
        assert.equal(await r.text(), "inline-ok");
        assert.deepEqual(calls, [`${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`]);
        // non-pseudo-origin traffic must reach its real destination untouched
        const before = hits.length;
        const p = await withTimeout(fetch(`${upstreamOrigin}/v1/messages`, { method: "POST", body: "{}" }), 10_000, "passthrough");
        assert.equal(p.status, 200);
        assert.deepEqual(hits.slice(before), ["POST /v1/messages"]);
    } finally {
        const piInline = await import("../src/agent/pi-inline.ts");
        const fc = await import("../src/agent/fetch-chain/index.ts");
        piInline._resetInlineTransportForTest();
        fc.resetFetchChainForTest();
        ie._setEngineFactoryForTest(undefined);
        ie._resetInlineEngineForTest();
    }
});

test("#4527 composition: native intercept + inline link stacked like the real arm — rewrites land on the inline engine, never on real DNS", async () => {
    // The production arm (pi-native.ts) installs the inline transport FIRST,
    // then the native fetch intercept ON TOP. The intercept rewrites model
    // URLs to `${INLINE_ORIGIN}/bili/<upstream>` and hands them DOWN via its
    // send(); pre-#4527 the inline link's `patched` wrapper saw depth===1
    // (#1662 protocol) and skipped its dispatch entirely — the pseudo-origin
    // URL fell through to the raw fetch and died on real DNS
    // (ENOTFOUND billion-context.inline). This is the composition shape every
    // earlier test bypassed by calling the engine directly.
    const ie = await import("../src/inline-engine.ts");
    const ni = await import("../src/agent/native-intercept.ts");
    const fc = await import("../src/agent/fetch-chain/index.ts");
    const piInline = await import("../src/agent/pi-inline.ts");
    const calls: string[] = [];
    ie._setEngineFactoryForTest(async () => ({
        origin: ie.INLINE_ORIGIN,
        dispatch: async (input: string | URL | Request): Promise<Response> => {
            calls.push(String(input));
            return new Response("inline-ok");
        },
        dispatchHttp: async () => {},
        wsOrigin: Promise.resolve(undefined),
        webOrigin: Promise.resolve(undefined),
    }));
    try {
        ni._resetForTest();
        fc.resetFetchChainForTest();
        piInline._resetInlineTransportForTest();
        piInline.installInlineTransport();
        const state: import("../src/agent/native-intercept.ts").NativeInterceptState = { origin: ie.INLINE_ORIGIN, ready: Promise.resolve(ie.INLINE_ORIGIN) };
        assert.equal(ni.installNativeFetchIntercept(state), true);
        const before = hits.length;
        // A PLAIN model URL — what the host SDK actually calls. The intercept
        // rewrites it to the pseudo-origin; the inline link must serve it.
        const r = await withTimeout(fetch(`${upstreamOrigin}/v1/messages`, { method: "POST", body: "{}" }), 10_000, "model via chain");
        assert.equal(r.status, 200);
        assert.equal(await r.text(), "inline-ok");
        assert.deepEqual(calls, [`${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`]);
        // The real upstream must stay untouched — a DNS-bound pseudo-origin
        // leak would never reach it anyway (ENOTFOUND).
        assert.equal(hits.length, before);
        // Management URLs take the intercept's control-passthrough branch and
        // must land on the inline engine too (the manifest/status fetches).
        const m = await withTimeout(fetch(`${ie.INLINE_ORIGIN}/__bili/health`), 10_000, "mgmt via chain");
        assert.equal(m.status, 200);
        assert.deepEqual(calls, [`${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`, `${ie.INLINE_ORIGIN}/__bili/health`]);
    } finally {
        const piInline2 = await import("../src/agent/pi-inline.ts");
        const fc2 = await import("../src/agent/fetch-chain/index.ts");
        const ni2 = await import("../src/agent/native-intercept.ts");
        piInline2._resetInlineTransportForTest();
        fc2.resetFetchChainForTest();
        ni2._resetForTest();
        ie._setEngineFactoryForTest(undefined);
        ie._resetInlineEngineForTest();
    }
});

test("#6829: pi-web-access 0.46+ wrapper (shared marker only) keeps model traffic on the inline engine", async () => {
    // The production arm (pi-native.ts) installs the inline transport FIRST,
    // then the native fetch intercept ON TOP. From pi-web-access 0.46.0 a web
    // tool call wraps the intercept link with a wrapper that carries ONLY the
    // new `__piWebAccessSharedProxyFetch` marker (the old
    // `__piWebAccessProxyFetch` propagates only when the wrapped fetch already
    // has it, which bili's chain never sets from native). Pre-fix the wrapper
    // fell into the generic re-chain, then the #1662 escape handed the
    // rewritten INLINE_ORIGIN request to the oldest live anchor — a real DNS
    // lookup of billion-context.inline that dies ENOTFOUND, and only the first
    // occurrence is logged, so every later model call failed silently.
    const ie = await import("../src/inline-engine.ts");
    const ni = await import("../src/agent/native-intercept.ts");
    const fc = await import("../src/agent/fetch-chain/index.ts");
    const piInline = await import("../src/agent/pi-inline.ts");
    const calls: string[] = [];
    ie._setEngineFactoryForTest(async () => ({
        origin: ie.INLINE_ORIGIN,
        dispatch: async (input: string | URL | Request): Promise<Response> => {
            calls.push(String(input));
            return new Response("inline-ok");
        },
        dispatchHttp: async () => {},
        wsOrigin: Promise.resolve(undefined),
        webOrigin: Promise.resolve(undefined),
    }));
    try {
        ni._resetForTest();
        fc.resetFetchChainForTest();
        piInline._resetInlineTransportForTest();
        piInline.installInlineTransport();
        const state: import("../src/agent/native-intercept.ts").NativeInterceptState = { origin: ie.INLINE_ORIGIN, ready: Promise.resolve(ie.INLINE_ORIGIN) };
        assert.equal(ni.installNativeFetchIntercept(state), true);
        // 0.46+ installGlobalProxyFetch shape: wraps the current top and marks
        // ONLY the shared flag; passes everything else through to its base.
        const seenByWrapper: string[] = [];
        const base = globalThis.fetch;
        const wrapper = (async (input: string | URL | Request, init?: RequestInit) => {
            seenByWrapper.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
            return base(input, init);
        }) as typeof fetch;
        Object.defineProperty(wrapper, "__piWebAccessSharedProxyFetch", { value: true });
        globalThis.fetch = wrapper;
        // The shared marker must be visible through bili's re-chained top, so
        // pi-web-access's own install guard sees a proxy is already in place
        // and does not re-install on every web tool call.
        assert.equal(Reflect.get(globalThis.fetch, "__piWebAccessSharedProxyFetch"), true);
        const before = hits.length;
        // A PLAIN model URL — what the host SDK actually calls. The intercept
        // rewrites it to the pseudo-origin; the inline link must serve it.
        const r = await withTimeout(fetch(`${upstreamOrigin}/v1/messages`, { method: "POST", body: "{}" }), 10_000, "model via chain + 0.46 wrapper");
        assert.equal(r.status, 200);
        assert.equal(await r.text(), "inline-ok");
        assert.deepEqual(calls, [`${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`]);
        // The real upstream must stay untouched — a DNS-bound pseudo-origin
        // leak would never reach it anyway (ENOTFOUND).
        assert.equal(hits.length, before);
        // The wrapper's hook still ran on the rewritten URL (coexistence, not bypass).
        // #6841 rework: the wrapper NEVER sees pseudo-origin traffic now —
        // the intercept serves it in-process before any downstream runs, so
        // coexistence is the marker handshake, not the hook running on it.
        assert.deepEqual(seenByWrapper, []);
        // Management URLs take the intercept's control-passthrough branch and
        // must land on the inline engine too.
        const m = await withTimeout(fetch(`${ie.INLINE_ORIGIN}/__bili/health`), 10_000, "mgmt via chain + 0.46 wrapper");
        assert.equal(m.status, 200);
        assert.deepEqual(calls, [`${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`, `${ie.INLINE_ORIGIN}/__bili/health`]);
    } finally {
        const piInline2 = await import("../src/agent/pi-inline.ts");
        const fc2 = await import("../src/agent/fetch-chain/index.ts");
        const ni2 = await import("../src/agent/native-intercept.ts");
        piInline2._resetInlineTransportForTest();
        fc2.resetFetchChainForTest();
        ni2._resetForTest();
        ie._setEngineFactoryForTest(undefined);
        ie._resetInlineEngineForTest();
    }
});

test("#6841 rework: proxy-scope-ON pi-web-access wrapper cannot steal inline-origin traffic", async () => {
    const ie = await import("../src/inline-engine.ts");
    const ni = await import("../src/agent/native-intercept.ts");
    const fc = await import("../src/agent/fetch-chain/index.ts");
    const piInline = await import("../src/agent/pi-inline.ts");
    ie._setEngineFactoryForTest(async () => ({
        origin: ie.INLINE_ORIGIN,
        dispatch: async (): Promise<Response> => new Response("inline-ok"),
        dispatchHttp: async () => {},
        wsOrigin: Promise.resolve(undefined),
        webOrigin: Promise.resolve(undefined),
    }));
    try {
        const model = `${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`;
        const mgmt = `${ie.INLINE_ORIGIN}/__bili/health`;
        const web = "http://example.test/web-search";
        // Intercept installed first (real arm order), wrapper above it.
        ni._resetForTest();
        fc.resetFetchChainForTest();
        piInline._resetInlineTransportForTest();
        piInline.installInlineTransport();
        const state: import("../src/agent/native-intercept.ts").NativeInterceptState = { origin: ie.INLINE_ORIGIN, ready: Promise.resolve(ie.INLINE_ORIGIN) };
        assert.equal(ni.installNativeFetchIntercept(state), true);
        const { proxyScope, proxyCalls, seenByWrapper } = installScopeWrapper();
        try {
            // Scope ON: model + management traffic must reach the engine;
            // the wrapper must see nothing at all.
            await proxyScope.run(true, async () => {
                assert.equal(await (await withTimeout(fetch(model, { method: "POST", body: "{}" }), 10_000, "model scope-on")).text(), "inline-ok");
                assert.equal(await (await withTimeout(fetch(mgmt), 10_000, "mgmt scope-on")).text(), "inline-ok");
            });
            assert.deepEqual(proxyCalls, []);
            assert.deepEqual(seenByWrapper, []);
            // Scope OFF: same outcome.
            assert.equal(await (await withTimeout(fetch(model, { method: "POST", body: "{}" }), 10_000, "model scope-off")).text(), "inline-ok");
            assert.equal(await (await withTimeout(fetch(mgmt), 10_000, "mgmt scope-off")).text(), "inline-ok");
            assert.deepEqual(proxyCalls, []);
            // Negative control: real web traffic with the scope ON still
            // goes to the proxy stub, so the wrapper is genuinely active.
            await proxyScope.run(true, async () => {
                assert.equal(await (await withTimeout(fetch(web), 10_000, "web scope-on")).text(), "proxy-handled");
            });
            assert.deepEqual(proxyCalls, [web]);
        } finally {
            fc.resetFetchChainForTest();
        }
    } finally {
        const piInline2 = await import("../src/agent/pi-inline.ts");
        const fc2 = await import("../src/agent/fetch-chain/index.ts");
        const ni2 = await import("../src/agent/native-intercept.ts");
        piInline2._resetInlineTransportForTest();
        fc2.resetFetchChainForTest();
        ni2._resetForTest();
        ie._setEngineFactoryForTest(undefined);
        ie._resetInlineEngineForTest();
    }
});

test("#6841 rework: inline-origin requests from a stale dispatchDepth context still reach the engine", async () => {
    const ie = await import("../src/inline-engine.ts");
    const ni = await import("../src/agent/native-intercept.ts");
    const fc = await import("../src/agent/fetch-chain/index.ts");
    const piInline = await import("../src/agent/pi-inline.ts");
    // The dispatch mints an AsyncResource the #5614 way: created inside the
    // fake engine dispatch, it keeps the dispatch's ALS (dispatchDepth 2)
    // alive after the dispatch returns.
    let stale: AsyncResource | undefined;
    ie._setEngineFactoryForTest(async () => ({
        origin: ie.INLINE_ORIGIN,
        dispatch: async (): Promise<Response> => {
            stale = new AsyncResource("stale-scope");
            return new Response("inline-ok");
        },
        dispatchHttp: async () => {},
        wsOrigin: Promise.resolve(undefined),
        webOrigin: Promise.resolve(undefined),
    }));
    try {
        const model = `${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`;
        ni._resetForTest();
        fc.resetFetchChainForTest();
        piInline._resetInlineTransportForTest();
        piInline.installInlineTransport();
        const state: import("../src/agent/native-intercept.ts").NativeInterceptState = { origin: ie.INLINE_ORIGIN, ready: Promise.resolve(ie.INLINE_ORIGIN) };
        assert.equal(ni.installNativeFetchIntercept(state), true);
        const { proxyScope, proxyCalls, seenByWrapper } = installScopeWrapper();
        try {
            await withTimeout(fetch(model, { method: "POST", body: "{}" }), 10_000, "seed");
            assert.notEqual(stale, undefined);
            // Requests issued from that stale scope, with the proxy scope ON,
            // must still reach the engine — not the wrapper, not the anchor.
            await proxyScope.run(true, async () => {
                await stale!.runInAsyncScope(async () => {
                    assert.equal(await (await withTimeout(fetch(model, { method: "POST", body: "{}" }), 10_000, "stale model")).text(), "inline-ok");
                    assert.equal(await (await withTimeout(fetch(`${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`, { method: "POST", body: "{}" }), 10_000, "stale routed")).text(), "inline-ok");
                });
            });
            assert.deepEqual(proxyCalls, []);
            assert.deepEqual(seenByWrapper, []);
        } finally {
            fc.resetFetchChainForTest();
        }
    } finally {
        const piInline2 = await import("../src/agent/pi-inline.ts");
        const fc2 = await import("../src/agent/fetch-chain/index.ts");
        const ni2 = await import("../src/agent/native-intercept.ts");
        piInline2._resetInlineTransportForTest();
        fc2.resetFetchChainForTest();
        ni2._resetForTest();
        ie._setEngineFactoryForTest(undefined);
        ie._resetInlineEngineForTest();
    }
});

test("#6841 rework: inline-origin classification is the exact origin, not a prefix", async () => {
    const ie = await import("../src/inline-engine.ts");
    const fc = await import("../src/agent/fetch-chain/index.ts");
    const piInline = await import("../src/agent/pi-inline.ts");
    const calls: string[] = [];
    ie._setEngineFactoryForTest(async () => ({
        origin: ie.INLINE_ORIGIN,
        dispatch: async (input: string | URL | Request): Promise<Response> => {
            calls.push(String(input));
            return new Response("inline-ok");
        },
        dispatchHttp: async () => {},
        wsOrigin: Promise.resolve(undefined),
        webOrigin: Promise.resolve(undefined),
    }));
    const originalFetch = globalThis.fetch;
    try {
        // Canned anchor: anything the link does NOT serve in-process lands
        // here, so a misclassification is observable without real DNS.
        const anchorCalls: string[] = [];
        const canned = (async (input: string | URL | Request, _init?: RequestInit) => {
            anchorCalls.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
            return new Response("anchor-ok");
        }) as typeof fetch;
        // Define the property DIRECTLY: a plain assignment would fire the
        // stale guard accessor left by the previous test, re-chaining the
        // canned sink as the downstream of the inherited top — every later
        // test would then read "anchor-ok" instead of the real upstream.
        // No { anchor } option: the canned sink is only the link's
        // downstream (captured from globalThis.fetch at install); the
        // module anchor stays the real fetch.
        Object.defineProperty(globalThis, "fetch", { value: canned, writable: true, configurable: true, enumerable: true });
        fc.resetFetchChainForTest();
        piInline._resetInlineTransportForTest();
        piInline.installInlineTransport();
        const model = `${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`;
        // Exact origin, case-insensitive host, :80 — served in-process.
        assert.equal(await (await withTimeout(fetch(model), 10_000, "exact")).text(), "inline-ok");
        assert.equal(await (await withTimeout(fetch("HTTP://BILLION-CONTEXT.INLINE/bili/x"), 10_000, "case")).text(), "inline-ok");
        assert.equal(await (await withTimeout(fetch("http://billion-context.inline:80/bili/x"), 10_000, "port80")).text(), "inline-ok");
        // Lookalike host, https, :81, credentials — NOT the pseudo-origin:
        // they pass through to the anchor instead of reaching the engine.
        assert.equal(await (await withTimeout(fetch("http://billion-context.inline.evil.com/bili/x"), 10_000, "lookalike")).text(), "anchor-ok");
        assert.equal(await (await withTimeout(fetch("https://billion-context.inline/bili/x"), 10_000, "https")).text(), "anchor-ok");
        assert.equal(await (await withTimeout(fetch("http://billion-context.inline:81/bili/x"), 10_000, "port81")).text(), "anchor-ok");
        assert.equal(await (await withTimeout(fetch("http://user:pass@billion-context.inline/bili/x"), 10_000, "creds")).text(), "anchor-ok");
        assert.deepEqual(calls, [model, "HTTP://BILLION-CONTEXT.INLINE/bili/x", "http://billion-context.inline:80/bili/x"]);
        assert.deepEqual(anchorCalls, [
            "http://billion-context.inline.evil.com/bili/x",
            "https://billion-context.inline/bili/x",
            "http://billion-context.inline:81/bili/x",
            "http://user:pass@billion-context.inline/bili/x",
        ]);
    } finally {
        const piInline2 = await import("../src/agent/pi-inline.ts");
        const fc2 = await import("../src/agent/fetch-chain/index.ts");
        piInline2._resetInlineTransportForTest();
        fc2.resetFetchChainForTest();
        // Reset restores the pre-install descriptor (the canned anchor);
        // define the previous top back directly, so the guarded setter
        // cannot swallow it as an own-chain write-back (see above).
        Object.defineProperty(globalThis, "fetch", { value: originalFetch, writable: true, configurable: true, enumerable: true });
        ie._setEngineFactoryForTest(undefined);
        ie._resetInlineEngineForTest();
    }
});

test("#3278 transport: engine failure degrades model traffic direct, management fails loud", async () => {
    const ie = await import("../src/inline-engine.ts");
    ie._setEngineFactoryForTest(async () => {
        throw new Error("boom");
    });
    try {
        await freshChain();
        const before = hits.length;
        // prefix stripped → the request lands on the REAL upstream, uncompressed
        const r = await withTimeout(fetch(`${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`, { method: "POST", body: "{}" }), 10_000, "degrade");
        assert.equal(r.status, 200);
        assert.match(await r.text(), /hello-inline/);
        assert.deepEqual(hits.slice(before), ["POST /v1/messages"]);
        // management traffic has no direct meaning — it must reject, not wander
        await assert.rejects(withTimeout(fetch(`${ie.INLINE_ORIGIN}/__bili/health`), 10_000, "mgmt reject"));
    } finally {
        const piInline = await import("../src/agent/pi-inline.ts");
        const fc = await import("../src/agent/fetch-chain/index.ts");
        piInline._resetInlineTransportForTest();
        fc.resetFetchChainForTest();
        ie._setEngineFactoryForTest(undefined);
        ie._resetInlineEngineForTest();
    }
});

test("#3278 engine: real pipeline runs in-process — one upstream round trip, session tracked, admin reachable", { timeout: 90_000 }, async () => {
    const ie = await import("../src/inline-engine.ts");
    const { listSessions } = await import("../src/session.ts");
    const before = hits.length;
    const engine = await withTimeout(ie.getInlineEngine(), 60_000, "engine boot");
    assert.equal(engine.origin, ie.INLINE_ORIGIN);
    // max_tokens > 200 keeps this on the main model lane (processTurn), not
    // the side-request passthrough lane.
    const body = JSON.stringify({ model: "test-model", max_tokens: 1024, messages: [{ role: "user", content: "hi" }] });
    const r = await withTimeout(
        engine.dispatch(
            `${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`,
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-bili-plugin": "pi",
                    "x-bili-plugin-conversation": "inline-e2e-session-1",
                },
                body,
            },
            globalThis.fetch,
        ),
        30_000,
        "model dispatch",
    );
    assert.equal(r.status, 200);
    const j = (await r.json()) as { content: { text: string }[] };
    assert.equal(j.content[0].text, "hello-inline");
    // loop safety: exactly ONE upstream round trip — a re-entrant rewrite into
    // the patched fetch would double the hit count or hang until timeout
    assert.deepEqual(hits.slice(before), ["POST /v1/messages"]);
    // compression bookkeeping ran in this process
    assert.ok(listSessions().length >= 1, `expected an in-process session, got ${listSessions().length}`);
    // the loopback-gated admin surface answers through the pseudo-origin
    const h = await withTimeout(engine.dispatch(`${ie.INLINE_ORIGIN}/__bili/health`, {}, globalThis.fetch), 10_000, "health");
    assert.equal(h.status, 200);
});

test("#3278 engine: boot is TUI-safe — zero stderr writes while the interactive host owns the terminal", { timeout: 90_000 }, async () => {
    // Field report (2026-10-24): `bili pi-inline` scrolled the pi input box
    // away — the inline engine runs INSIDE the host process, so the tee
    // logger's stderr leg printed every [storage]/[persist]/[inline] line
    // straight onto the interactive terminal. The engine must mute that leg
    // (file-only; BILI_INLINE_DEBUG opts back in) at boot.
    const ie = await import("../src/inline-engine.ts");
    ie._setEngineFactoryForTest(undefined);
    ie._resetInlineEngineForTest();
    const realWrite = process.stderr.write.bind(process.stderr);
    const seen: string[] = [];
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
        seen.push(typeof chunk === "string" ? chunk : String(chunk));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realWrite as any)(chunk, ...rest);
    }) as typeof process.stderr.write;
    try {
        const engine = await withTimeout(ie.getInlineEngine(), 60_000, "engine boot");
        assert.equal(engine.origin, ie.INLINE_ORIGIN);
        assert.equal(seen.length, 0, `inline boot must not write to the host's TUI stderr, got: ${seen.join(" | ").slice(0, 400)}`);
    } finally {
        process.stderr.write = realWrite;
    }
});

test("#4571 inline web: loopback Web UI listener + status panel names its lane", { timeout: 90_000 }, async () => {
    // Field report (2026-10-24): the inline status panel printed
    // `Web UI: http://127.0.0.1:0/...` (dead link — no listener exists in the
    // inline lane) and nothing said the engine was inline. Fix: a loopback,
    // unref'd, admin-only web listener whose real port feeds both the panel
    // link and a " · inline" lane marker.
    const ie = await import("../src/inline-engine.ts");
    ie._setEngineFactoryForTest(undefined);
    ie._resetInlineEngineForTest();
    try {
        const engine = await withTimeout(ie.getInlineEngine(), 60_000, "engine boot");
        // one model round trip first: gives the status endpoint a live session
        // and proves the dispatcher still works with the listener bound
        const body = JSON.stringify({ model: "test-model", max_tokens: 1024, messages: [{ role: "user", content: "hi" }] });
        const r = await withTimeout(engine.dispatch(
            `${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`,
            { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": "inline-web-panel-1" }, body },
            globalThis.fetch,
        ), 30_000, "model dispatch");
        assert.equal(r.status, 200);
        const wo = await withTimeout(engine.webOrigin, 10_000, "webOrigin");
        assert.ok(typeof wo === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(wo), `webOrigin=${String(wo)}`);
        // 1. the BROWSER path: a real TCP round trip against the loopback listener
        const o = await withTimeout(fetch(`${wo}/__bili/overview`), 10_000, "overview via loopback");
        assert.equal(o.status, 200);
        // 2. the listener is admin-only: model lanes are NOT exposed on it
        const nf = await withTimeout(fetch(`${wo}/bili/${upstreamOrigin}/v1/messages`, { method: "POST", body: "{}" }), 10_000, "model lane refused");
        assert.equal(nf.status, 404);
        // 3. the status panel names its lane and prints the REAL link
        const s = await withTimeout(engine.dispatch(`${ie.INLINE_ORIGIN}/__bili/plugin/status?conversationId=inline-web-panel-1`, {}, globalThis.fetch), 10_000, "status");
        assert.equal(s.status, 200);
        const j = await s.json() as { ok: boolean; panel: string | null };
        assert.equal(j.ok, true);
        assert.match(j.panel ?? "", /· inline/);
        assert.match(j.panel ?? "", new RegExp(`${wo}/__bili/#/session/`));
        // 4. #4571 engine-lane stamp: the session this engine served is badged
        //    "inline" in the session list — the web answers "did this run
        //    in-process?" without digging through logs.
        const ses = await withTimeout(engine.dispatch(`${ie.INLINE_ORIGIN}/__bili/sessions`, {}, globalThis.fetch), 10_000, "sessions");
        assert.equal(ses.status, 200);
        const raw = await ses.json() as { sessions?: Array<{ id: string; engineLane?: string; clientHint?: string }>, hiddenEmpty?: number } | Array<{ id: string; engineLane?: string; clientHint?: string }>;
        const list = Array.isArray(raw) ? raw : raw.sessions ?? [];
        const mine = list.find((x) => x.engineLane === "inline" && x.clientHint === "pi");
        assert.ok(mine, `no pi session carries the inline engineLane badge: ${JSON.stringify(list).slice(0, 300)}`);
    } finally {
        ie._setEngineFactoryForTest(undefined);
        ie._resetInlineEngineForTest();
    }
});

test("#3278 engine: caller abort cancels the in-process round trip (spawn-mode parity)", { timeout: 60_000 }, async () => {
    const ie = await import("../src/inline-engine.ts");
    const engine = await withTimeout(ie.getInlineEngine(), 60_000, "engine boot");
    const ac = new AbortController();
    const settled = engine.dispatch(
        // real model lane (max_tokens > 200): the slow-please marker makes the
        // mock hold the response 2.5s so the abort lands mid-round-trip
        `${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-bili-plugin": "pi",
                "x-bili-plugin-conversation": "inline-abort-session",
            },
            body: JSON.stringify({ model: "test-model", max_tokens: 1024, messages: [{ role: "user", content: "hi slow-please" }] }),
            signal: ac.signal,
        },
        globalThis.fetch,
    ).then(
        (r) => { throw new Error(`expected abort rejection, got HTTP ${r.status}`); },
        (e: unknown) => e,
    );
    setTimeout(() => ac.abort(), 150);
    const err = await withTimeout(settled, 10_000, "abort propagation") as Error;
    assert.equal(err.name, "AbortError");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(slowCompleted, false, "upstream round trip must not complete after the caller aborted");
});
