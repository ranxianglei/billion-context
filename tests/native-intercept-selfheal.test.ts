import assert from "node:assert/strict";
import test from "node:test";
import { installNativeFetchIntercept, type NativeInterceptState } from "../src/agent/native-intercept.js";

function fakeFetch(sink: string[]) {
    return (async (input: RequestInfo | URL, _init?: RequestInit) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

async function withHeal<T>(fn: (ctx: { sink: string[]; rearm: (v: typeof fetch) => void; fetch: () => typeof fetch }) => Promise<T>): Promise<{ sink: string[]; result: T }> {
    const saved = globalThis.fetch;
    const sink: string[] = [];
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest();
    globalThis.fetch = fakeFetch(sink);
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const result = await fn({
            sink,
            rearm: (v) => {
                globalThis.fetch = v;
            },
            fetch: () => globalThis.fetch,
        });
        return { sink, result };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

test("#1158 self-heal: third-party reset to a frozen bare fetch re-chains and keeps routing through bili", async () => {
    const bareSink: string[] = [];
    const { sink } = await withHeal(async ({ rearm, fetch }) => {
        rearm(fakeFetch(bareSink));
        const res = await fetch()("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
    });
    assert.deepEqual(bareSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
    assert.deepEqual(sink, []);
});

test("#1158 self-heal: third-party wrapper becomes the downstream (dsh-http-proxy apply shape)", async () => {
    const downstreamSeen: string[] = [];
    const { sink } = await withHeal(async ({ rearm, fetch }) => {
        const wrapper = (async (input: RequestInfo | URL, init?: RequestInit) => {
            downstreamSeen.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
            return fakeFetch([])(input, init);
        }) as typeof fetch;
        rearm(wrapper);
        const res = await fetch()("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        // Non-model URL still passes through to the third-party wrapper untouched.
        await fetch()("https://registry.npmjs.org/billion-context");
    });
    assert.deepEqual(downstreamSeen, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages", "https://registry.npmjs.org/billion-context"]);
    assert.deepEqual(sink, []);
    assert.equal(downstreamSeen.length, 2);
});

test("#1158 self-heal: guarded property is transparent when nobody fights it", async () => {
    const { sink } = await withHeal(async ({ fetch }) => {
        const res = await fetch()("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        // A re-read of the global yields a stable callable (accessor works).
        assert.equal(typeof fetch(), "function");
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

test("#1158 self-heal: non-function and self writes are ignored by the guard", async () => {
    const { sink } = await withHeal(async ({ rearm, fetch }) => {
        rearm(undefined as unknown as typeof fetch);
        const mine = fetch();
        rearm(mine);
        const res = await mine("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

// #1410: a coexisting network-scope plugin (dsh-codex-subscription shape)
// wraps globalThis.fetch while its scope is open and, on scope end, restores
// ONLY if its wrapper still sits on top — then unconditionally nulls its own
// closure locals. If bili had adopted that transient wrapper as downstream,
// every later request died with "baseFetch is not a function". These suites
// pin the interleave outcomes: the chain must survive either teardown order.

function foreignScope() {
    let baseFetch: typeof fetch | undefined;
    let scopedFetch: typeof fetch | undefined;
    return {
        open: (): void => {
            baseFetch = globalThis.fetch;
            scopedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => baseFetch!(input, init)) as typeof fetch;
            globalThis.fetch = scopedFetch;
        },
        close: (): void => {
            if (globalThis.fetch === scopedFetch) globalThis.fetch = baseFetch as typeof fetch;
            baseFetch = undefined;
            scopedFetch = undefined;
        },
    };
}

async function withScope<T>(anchor: typeof fetch, fn: (ctx: { scope: ReturnType<typeof foreignScope>; sink: string[] }) => Promise<T>): Promise<{ sink: string[]; result: T }> {
    const saved = globalThis.fetch;
    const sink: string[] = [];
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest({ anchor });
    globalThis.fetch = anchor;
    const scope = foreignScope();
    try {
        const result = await fn({ scope, sink });
        return { sink, result };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

test("#1410: install inside a foreign network scope survives scope teardown (re-anchor)", async () => {
    const nativeSink: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    await withScope(nativeFetch, async ({ scope }) => {
        scope.open();
        assert.equal(installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") }), true);
        // While the scope is still open, routing rides the live wrapper.
        await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
        assert.deepEqual(nativeSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
        scope.close(); // its guard sees bili's chain on top → skips restore, nulls its locals
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        await globalThis.fetch("https://registry.npmjs.org/billion-context");
    });
    assert.deepEqual(nativeSink, [
        "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
        "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
        "https://registry.npmjs.org/billion-context",
    ]);
});

test("#1410: foreign scope opening AFTER install — re-arm adopts its wrapper; teardown re-anchors", async () => {
    const nativeSink: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    await withScope(nativeFetch, async ({ scope }) => {
        const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
        assert.equal(installNativeFetchIntercept(state), true);
        scope.open(); // captures bili's top as its base; the write re-arms (#1158) onto its wrapper
        scope.close(); // guard fails (bili's chain on top) → wrapper torn down behind our back
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        await globalThis.fetch("https://registry.npmjs.org/billion-context");
    });
    assert.deepEqual(nativeSink, [
        "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
        "https://registry.npmjs.org/billion-context",
    ]);
});

test("#1410: writing back our OWN stale chain link is recognized as ours — no re-arm, top unchanged", async () => {
    const foreignSink: string[] = [];
    const { sink } = await withHeal(async ({ rearm, fetch }) => {
        const link1 = fetch();
        const foreign = fakeFetch(foreignSink);
        rearm(foreign); // genuine third-party evict → new top
        const topAfter = fetch();
        assert.notEqual(topAfter, link1);
        rearm(link1); // our own stale link written back — must be ignored
        assert.equal(fetch(), topAfter);
        const res = await fetch()("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
    });
    // Routing still flows through the third-party downstream adopted at re-arm.
    assert.deepEqual(foreignSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
    assert.deepEqual(sink, []);
});

test("#1410: _resetForTest leaves a third-party redefined descriptor alone", async () => {
    const saved = globalThis.fetch;
    const nativeFetch = fakeFetch([]);
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest({ anchor: nativeFetch });
    globalThis.fetch = nativeFetch;
    try {
        const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
        assert.equal(installNativeFetchIntercept(state), true);
        const hostile = fakeFetch([]);
        Object.defineProperty(globalThis, "fetch", { value: hostile, writable: true, configurable: true, enumerable: true });
        _resetForTest();
        // The third party's legal redefine stands — a blind restore clobbers it.
        assert.equal(Object.getOwnPropertyDescriptor(globalThis, "fetch")?.value, hostile);
    } finally {
        Object.defineProperty(globalThis, "fetch", { value: saved, writable: true, configurable: true, enumerable: true });
        _resetForTest();
    }
});

test("#1410: every observed fetch torn down → loud failure, no silent corruption", async () => {
    const saved = globalThis.fetch;
    let inner: typeof fetch | undefined = fakeFetch([]);
    const doomed = (async (input: RequestInfo | URL, init?: RequestInit) => inner!(input, init)) as typeof fetch;
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest({ anchor: doomed });
    globalThis.fetch = doomed;
    try {
        const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
        assert.equal(installNativeFetchIntercept(state), true);
        inner = undefined; // the owner tears down the only path this process ever saw
        await assert.rejects(
            () => globalThis.fetch("http://127.0.0.1:8199/v1/messages"),
            (err: unknown) => err instanceof TypeError && /is not a function$/.test(err.message),
        );
    } finally {
        inner = fakeFetch([]);
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("#1158 escape hatch: BILI_RECLAIM_FETCH_PATCH=0 keeps the classic direct install", async () => {
    process.env.BILI_RECLAIM_FETCH_PATCH = "0";
    try {
        const saved = globalThis.fetch;
        const { _resetForTest } = await import("../src/agent/native-intercept.js");
        _resetForTest();
        const sink: string[] = [];
        globalThis.fetch = fakeFetch(sink);
        const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
        try {
            assert.equal(installNativeFetchIntercept(state), true);
            // A plain writable data property again (no accessor guard).
            assert.equal(Object.getOwnPropertyDescriptor(globalThis, "fetch")?.writable, true);
            const thirdParty = fakeFetch([]);
            globalThis.fetch = thirdParty;
            // The third party wins: direct send, no bili rewrite.
            assert.equal(globalThis.fetch, thirdParty);
            const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
            assert.equal(res.status, 200);
        } finally {
            globalThis.fetch = saved;
            _resetForTest();
        }
    } finally {
        delete process.env.BILI_RECLAIM_FETCH_PATCH;
    }
});
