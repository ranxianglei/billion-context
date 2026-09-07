// In-process fetch interceptor (#521): async target resolution (early calls
// wait on bootstrap instead of leaking direct), origin-scoped rewrite to
// /bili/, passthrough for everything else, one-shot degrade when the proxy
// is down, and clean uninstall.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFetchInterceptor, type FetchInterceptor, type FetchInterceptTargets } from "../src/agent/intercept.ts";

const UP = "http://up.example.com:9999";
const PROXY = "http://127.0.0.1:8787";
const TARGETS: FetchInterceptTargets = { upstreamOrigin: UP, proxyOrigin: PROXY };

type Call = { url: string; input: string | URL | Request; init?: RequestInit };

function fakeReal(handlers: (url: string) => Response | Promise<Response>, calls: Call[]) {
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
        calls.push({ url, input, init });
        return handlers(url);
    }) as typeof fetch;
}

test("interceptor rewrites only the upstream origin; everything else passes through", async () => {
    const calls: Call[] = [];
    const real = fakeReal(() => new Response("ok", { status: 200 }), calls);
    const prev = globalThis.fetch;
    const ic = installFetchInterceptor({ resolveTargets: () => Promise.resolve(TARGETS), fetchImpl: real })!;
    try {
        await globalThis.fetch(`${UP}/v1/chat/completions`);
        await globalThis.fetch("http://other.example/x");
        // The plugin's own management traffic targets the proxy origin — never rewritten.
        await globalThis.fetch(`${PROXY}/__bili/plugin/status`);
        assert.deepEqual(calls.map((c) => c.url), [
            `${PROXY}/bili/${UP}/v1/chat/completions`,
            "http://other.example/x",
            `${PROXY}/__bili/plugin/status`,
        ]);
        assert.deepEqual(ic.stats(), { rewritten: 1, passthrough: 2, degraded: 0 });
    } finally {
        ic.uninstall();
        globalThis.fetch = prev;
    }
});

test("interceptor handles URL and Request inputs, preserving method and headers on Request", async () => {
    const calls: Call[] = [];
    const real = fakeReal(() => new Response("ok"), calls);
    const prev = globalThis.fetch;
    const ic = installFetchInterceptor({ resolveTargets: () => Promise.resolve(TARGETS), fetchImpl: real })!;
    try {
        await globalThis.fetch(new URL(`${UP}/a`));
        const req = new Request(`${UP}/b`, { method: "POST", headers: { "x-k": "v" }, body: "{}" });
        await globalThis.fetch(req);
        assert.equal(calls[0]!.url, `${PROXY}/bili/${UP}/a`);
        const second = calls[1]!;
        assert.equal(second.url, `${PROXY}/bili/${UP}/b`);
        const seen = second.input;
        assert.ok(seen instanceof Request);
        assert.equal(seen.method, "POST");
        assert.equal(seen.headers.get("x-k"), "v");
        assert.equal(await (seen as Request).text(), "{}");
    } finally {
        ic.uninstall();
        globalThis.fetch = prev;
    }
});

test("proxy down at network layer → that request degrades to direct, once", async () => {
    const calls: Call[] = [];
    let directCalls = 0;
    const real = fakeReal((url) => {
        if (url.startsWith(PROXY)) throw new TypeError("fetch failed");
        directCalls++;
        return new Response("direct", { status: 200 });
    }, calls);
    const prev = globalThis.fetch;
    const ic = installFetchInterceptor({ resolveTargets: () => Promise.resolve(TARGETS), fetchImpl: real })!;
    try {
        const res = await globalThis.fetch(`${UP}/v1/chat/completions`);
        assert.equal(res.status, 200);
        assert.equal(directCalls, 1);
        assert.deepEqual(ic.stats(), { rewritten: 1, passthrough: 0, degraded: 1 });
    } finally {
        ic.uninstall();
        globalThis.fetch = prev;
    }
});

test("abort is never retried; non-network errors propagate", async () => {
    const calls: Call[] = [];
    let proxyCalls = 0;
    const real = fakeReal((url) => {
        if (url.startsWith(PROXY)) {
            if (++proxyCalls === 1) {
                const err = new Error("aborted");
                err.name = "AbortError";
                throw err;
            }
            throw new SyntaxError("boom");
        }
        return new Response("ok");
    }, calls);
    const prev = globalThis.fetch;
    const ic = installFetchInterceptor({ resolveTargets: () => Promise.resolve(TARGETS), fetchImpl: real })!;
    try {
        await assert.rejects(() => globalThis.fetch(`${UP}/x`), /aborted/);
        await assert.rejects(() => globalThis.fetch(`${UP}/y`), /boom/);
        assert.equal(calls.length, 2, "no second attempt after a failure");
    } finally {
        ic.uninstall();
        globalThis.fetch = prev;
    }
});

test("uninstall restores the previous fetch and stops rewriting", async () => {
    const calls: Call[] = [];
    const real = fakeReal(() => new Response("ok"), calls);
    const prev = globalThis.fetch;
    const ic = installFetchInterceptor({ resolveTargets: () => Promise.resolve(TARGETS), fetchImpl: real })!;
    ic.uninstall();
    assert.equal(globalThis.fetch, prev);
    await real(`${UP}/z`);
    assert.deepEqual(calls.map((c) => c.url), [`${UP}/z`]);
    assert.deepEqual(ic.stats(), { rewritten: 0, passthrough: 0, degraded: 0 });
});

test("call issued before bootstrap finishes waits on the gate, then rewrites", async () => {
    const calls: Call[] = [];
    const real = fakeReal(() => new Response("ok"), calls);
    const prev = globalThis.fetch;
    let release!: (t: FetchInterceptTargets) => void;
    const pending = new Promise<FetchInterceptTargets>((r) => {
        release = r;
    });
    const ic = installFetchInterceptor({ resolveTargets: () => pending, fetchImpl: real })!;
    try {
        const inflight = globalThis.fetch(`${UP}/v1/chat/completions`);
        // Gate still closed: nothing reached the network yet.
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(calls.length, 0);
        release(TARGETS);
        await inflight;
        assert.deepEqual(calls.map((c) => c.url), [`${PROXY}/bili/${UP}/v1/chat/completions`]);
        assert.deepEqual(ic.stats(), { rewritten: 1, passthrough: 0, degraded: 0 });
    } finally {
        ic.uninstall();
        globalThis.fetch = prev;
    }
});

test("gate resolving undefined or rejecting → passthrough, never a hang", async () => {
    const calls: Call[] = [];
    const real = fakeReal(() => new Response("ok"), calls);
    const prev = globalThis.fetch;
    const ic1 = installFetchInterceptor({ resolveTargets: () => Promise.resolve(undefined), fetchImpl: real })!;
    try {
        await globalThis.fetch(`${UP}/a`);
        assert.deepEqual(calls.map((c) => c.url), [`${UP}/a`]);
        assert.deepEqual(ic1.stats(), { rewritten: 0, passthrough: 1, degraded: 0 });
    } finally {
        ic1.uninstall();
        globalThis.fetch = prev;
    }
    const ic2 = installFetchInterceptor({
        resolveTargets: () => Promise.reject(new Error("bootstrap failed")),
        fetchImpl: real,
    })!;
    try {
        await globalThis.fetch(`${UP}/b`);
        assert.deepEqual(calls.map((c) => c.url), [`${UP}/a`, `${UP}/b`]);
        assert.deepEqual(ic2.stats(), { rewritten: 0, passthrough: 1, degraded: 0 });
    } finally {
        ic2.uninstall();
        globalThis.fetch = prev;
    }
});

test("equal or unparseable origins → every call passes through untouched", async () => {
    const calls: Call[] = [];
    const real = fakeReal(() => new Response("ok"), calls);
    const prev = globalThis.fetch;
    const ic1 = installFetchInterceptor({
        resolveTargets: () => Promise.resolve({ upstreamOrigin: UP, proxyOrigin: UP }),
        fetchImpl: real,
    })!;
    try {
        await globalThis.fetch(`${UP}/a`);
        assert.deepEqual(calls.map((c) => c.url), [`${UP}/a`]);
        assert.deepEqual(ic1.stats(), { rewritten: 0, passthrough: 1, degraded: 0 });
    } finally {
        ic1.uninstall();
        globalThis.fetch = prev;
    }
    const ic2 = installFetchInterceptor({
        resolveTargets: () => Promise.resolve({ upstreamOrigin: "not a url", proxyOrigin: PROXY }),
        fetchImpl: real,
    })!;
    try {
        await globalThis.fetch(`${UP}/b`);
        assert.deepEqual(calls.map((c) => c.url), [`${UP}/a`, `${UP}/b`]);
        assert.deepEqual(ic2.stats(), { rewritten: 0, passthrough: 1, degraded: 0 });
    } finally {
        ic2.uninstall();
        globalThis.fetch = prev;
    }
});
