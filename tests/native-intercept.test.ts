import test from "node:test";
import assert from "node:assert/strict";
import { installNativeFetchIntercept, isModelApiUrl, _resetForTest, type NativeInterceptState } from "../src/agent/native-intercept.ts";

test("isModelApiUrl: matches model-API endpoint shapes", () => {
    assert.equal(isModelApiUrl("http://127.0.0.1:8199/v1/messages"), true);
    assert.equal(isModelApiUrl("http://127.0.0.1:8199/v1/chat/completions"), true);
    assert.equal(isModelApiUrl("http://127.0.0.1:8199/v1/completions"), true);
    assert.equal(isModelApiUrl("http://127.0.0.1:8199/v1/responses"), true);
    assert.equal(isModelApiUrl("https://coding.dashscope.aliyuncs.com/apps/anthropic/v1/messages"), true);
    assert.equal(isModelApiUrl("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"), true);
    assert.equal(isModelApiUrl("https://api.anthropic.com/v1/messages?beta=true"), true);
    assert.equal(isModelApiUrl("http://localhost:9123/v1/messages/"), true);
});

test("isModelApiUrl: rejects non-model URLs, proxy paths, non-HTTP", () => {
    assert.equal(isModelApiUrl("http://127.0.0.1:8199/v1/models"), false);
    assert.equal(isModelApiUrl("http://127.0.0.1:36485/__bili/plugin/manifest"), false);
    assert.equal(isModelApiUrl("http://127.0.0.1:36485/bili/http://127.0.0.1:8199/v1/messages"), false);
    assert.equal(isModelApiUrl("https://registry.npmjs.org/billion-context"), false);
    assert.equal(isModelApiUrl("https://example.com/v1/messages/count_tokens"), false);
    assert.equal(isModelApiUrl("file:///tmp/v1/messages"), false);
    assert.equal(isModelApiUrl("not a url"), false);
    assert.equal(isModelApiUrl("https://api.anthropic.com/v1/messages/count_tokens"), false);
});

function fakeFetch(sink: string[]) {
    return (async (input: RequestInfo | URL, _init?: RequestInit) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

async function withPatch<T>(state: NativeInterceptState, fn: (fetch: typeof globalThis.fetch) => Promise<T>): Promise<{ sink: string[]; result: T }> {
    const saved = globalThis.fetch;
    _resetForTest();
    const sink: string[] = [];
    globalThis.fetch = fakeFetch(sink);
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const result = await fn(globalThis.fetch);
        return { sink, result };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

test("install: rewrites model URLs once ready", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { sink } = await withPatch(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

test("install: waits for a not-yet-ready proxy before rewriting", async () => {
    let release: (v: string | undefined) => void = () => {};
    const ready = new Promise<string | undefined>((r) => {
        release = r;
    });
    const state: NativeInterceptState = { origin: undefined, ready, readyTimeoutMs: 5000 };
    const { sink } = await withPatch(state, async (fetch) => {
        const pending = fetch("http://127.0.0.1:8199/v1/messages");
        await new Promise((r) => setTimeout(r, 20));
        release("http://127.0.0.1:40002");
        const res = await pending;
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40002/bili/http://127.0.0.1:8199/v1/messages"]);
});

test("install: falls back to direct when the bootstrap fails/times out", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined), readyTimeoutMs: 50 };
    const { sink } = await withPatch(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:8199/v1/messages"]);
});

test("install: leaves non-model URLs untouched", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { sink } = await withPatch(state, async (fetch) => {
        await fetch("https://registry.npmjs.org/billion-context");
        await fetch("http://127.0.0.1:40001/__bili/plugin/manifest");
    });
    assert.deepEqual(sink, ["https://registry.npmjs.org/billion-context", "http://127.0.0.1:40001/__bili/plugin/manifest"]);
});

test("install: proxy-origin URLs are never re-proxied (self guard)", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { sink } = await withPatch(state, async (fetch) => {
        await fetch("http://127.0.0.1:40001/v1/messages");
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/v1/messages"]);
});

test("install: TypeError triggers one respawn + retry", async () => {
    const calls: string[] = [];
    const saved = globalThis.fetch;
    _resetForTest();
    let failNext = true;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        calls.push(url);
        if (failNext) {
            failNext = false;
            throw new TypeError("fetch failed");
        }
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001"), respawn: undefined };
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        state.respawn = () => {
            state.origin = "http://127.0.0.1:40009";
            state.ready = Promise.resolve("http://127.0.0.1:40009");
            return Promise.resolve("http://127.0.0.1:40009");
        };
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        assert.deepEqual(calls, [
            "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
            "http://127.0.0.1:40009/bili/http://127.0.0.1:8199/v1/messages",
        ]);
        assert.equal(state.origin, "http://127.0.0.1:40009");
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("install: second install is a no-op while active", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const saved = globalThis.fetch;
    _resetForTest();
    globalThis.fetch = fakeFetch([]);
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        assert.equal(installNativeFetchIntercept(state), false);
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("install: Request-object input is re-dispatched with the rewritten URL", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { sink } = await withPatch(state, async (fetch) => {
        const req = new Request("http://127.0.0.1:8199/v1/messages", { method: "POST", body: "{}" });
        const res = await fetch(req);
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});
