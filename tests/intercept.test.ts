import { test } from "node:test";
import assert from "node:assert/strict";
import { installFetchInterceptor } from "../src/agent/intercept.ts";

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type Call = [RequestInfo | URL, RequestInit?];

const REAL_FETCH: FetchFn = globalThis.fetch;

function withMockedFetch(fn: (calls: Call[]) => void | Promise<void>) {
    const calls: Call[] = [];
    const mock: FetchFn = (input, init) => {
        calls.push([input, init]);
        return Promise.resolve(new Response("ok"));
    };
    globalThis.fetch = mock;
    return Promise.resolve()
        .then(() => fn(calls))
        .finally(() => {
            globalThis.fetch = REAL_FETCH;
        });
}

test("intercept: rewrites matching-origin string URLs with preserved path+query", async () => {
    await withMockedFetch(async (calls) => {
        const un = installFetchInterceptor({
            proxyOrigin: "http://127.0.0.1:43210",
            upstreamOrigins: ["https://api.anthropic.com"],
        });
        try {
            const res = await fetch("https://api.anthropic.com/v1/messages?beta=a", { method: "POST", body: "{}" });
            assert.equal(await res.text(), "ok");
            assert.equal(calls.length, 1);
            assert.equal(calls[0][0], "http://127.0.0.1:43210/bili/https://api.anthropic.com/v1/messages?beta=a");
            assert.deepEqual(calls[0][1], { method: "POST", body: "{}" });
        } finally {
            un();
        }
    });
});

test("intercept: passes through non-matching origins untouched", async () => {
    await withMockedFetch(async (calls) => {
        const un = installFetchInterceptor({
            proxyOrigin: "http://127.0.0.1:43210",
            upstreamOrigins: ["https://api.anthropic.com"],
        });
        try {
            await fetch("http://localhost:9999/telemetry");
            await fetch("https://other.example.com/x");
            assert.equal(calls.length, 2);
            assert.equal(calls[0][0], "http://localhost:9999/telemetry");
            assert.equal(calls[1][0], "https://other.example.com/x");
        } finally {
            un();
        }
    });
});

test("intercept: non-http(s) protocols pass through", async () => {
    await withMockedFetch(async (calls) => {
        const un = installFetchInterceptor({
            proxyOrigin: "http://127.0.0.1:43210",
            upstreamOrigins: ["https://api.anthropic.com"],
        });
        try {
            await fetch("data:text/plain,hi");
            assert.equal(calls.length, 1);
            assert.equal(calls[0][0], "data:text/plain,hi");
        } finally {
            un();
        }
    });
});

test("intercept: never double-wraps /bili/-prefixed URLs even when origin matches", async () => {
    await withMockedFetch(async (calls) => {
        const un = installFetchInterceptor({
            proxyOrigin: "http://127.0.0.1:43210",
            upstreamOrigins: ["https://api.anthropic.com"],
        });
        try {
            await fetch("https://api.anthropic.com/bili/https://api.anthropic.com/v1");
            assert.equal(calls.length, 1);
            assert.equal(calls[0][0], "https://api.anthropic.com/bili/https://api.anthropic.com/v1");
        } finally {
            un();
        }
    });
});

test("intercept: URL object input rewritten, Request input reconstructed with body+duplex", async () => {
    await withMockedFetch(async (calls) => {
        const un = installFetchInterceptor({
            proxyOrigin: "http://127.0.0.1:43210",
            upstreamOrigins: ["https://api.anthropic.com"],
        });
        try {
            await fetch(new URL("https://api.anthropic.com/v1/models"));
            assert.equal(calls.length, 1);
            assert.equal(calls[0][0], "http://127.0.0.1:43210/bili/https://api.anthropic.com/v1/models");

            const req = new Request("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: { authorization: "Bearer t" },
                body: "hello",
            });
            await fetch(req);
            assert.equal(calls.length, 2);
            assert.equal(calls[1][0], "http://127.0.0.1:43210/bili/https://api.anthropic.com/v1/messages");
            const init = calls[1][1] as RequestInit & { duplex?: string };
            assert.equal(init.method, "POST");
            assert.equal(await new Response(init.body).text(), "hello");
            assert.equal(init.duplex, "half");
            assert.equal(init.headers.get("authorization"), "Bearer t");
        } finally {
            un();
        }
    });
});

test("intercept: proxyOrigin trailing slash normalized; origins parsed to bare origin", async () => {
    await withMockedFetch(async (calls) => {
        const un = installFetchInterceptor({
            proxyOrigin: "http://127.0.0.1:43210/",
            upstreamOrigins: ["https://api.anthropic.com/v1"],
        });
        try {
            await fetch("https://api.anthropic.com/v1/messages");
            assert.equal(calls[0][0], "http://127.0.0.1:43210/bili/https://api.anthropic.com/v1/messages");
        } finally {
            un();
        }
    });
});

test("intercept: reinstall replaces prior wrapper (no stacking); stale uninstaller is a no-op", async () => {
    await withMockedFetch(async (calls) => {
        const unA = installFetchInterceptor({
            proxyOrigin: "http://127.0.0.1:1111",
            upstreamOrigins: ["https://a.example"],
        });
        const unB = installFetchInterceptor({
            proxyOrigin: "http://127.0.0.1:2222",
            upstreamOrigins: ["https://b.example"],
        });
        try {
            await fetch("https://b.example/x");
            await fetch("https://a.example/x");
            assert.equal(calls[0][0], "http://127.0.0.1:2222/bili/https://b.example/x");
            assert.equal(calls[1][0], "https://a.example/x");
            unB();
            unA();
            await fetch("https://a.example/x");
            assert.equal(calls[2][0], "https://a.example/x");
        } finally {
            unB();
            unA();
        }
    });
});

test("intercept: invalid options throw", () => {
    assert.throws(() => installFetchInterceptor({ proxyOrigin: "", upstreamOrigins: ["https://a.example"] }));
    assert.throws(() => installFetchInterceptor({ proxyOrigin: "http://127.0.0.1:1", upstreamOrigins: [] }));
    assert.throws(() => installFetchInterceptor({ proxyOrigin: "http://127.0.0.1:1", upstreamOrigins: ["not a url"] }));
});
