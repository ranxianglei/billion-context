import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { Agent } from "undici";

import { makeContinuationRefetch } from "../src/degenerate-retry.ts";
import { withFetchTransport } from "../src/fetch-transport.ts";
import { _liveUpstreamTimersForTest, fetchWithTimeout } from "../src/fetch-util.ts";
import { _resetUpstreamThrottleForTest, activeThrottleHolds } from "../src/upstream-throttle.ts";

const encoder = new TextEncoder();
const body = JSON.stringify({ model: "cleanup-model", messages: [{ role: "user", content: "continue" }] });

function options(url: string, signal: AbortSignal = new AbortController().signal) {
    return {
        protocol: "openai" as const,
        body,
        model: "cleanup-model",
        upstreamUrl: url,
        reqHeaders: {},
        signal,
        log: () => {},
        label: "continuation-error-body-cleanup",
    };
}

for (const status of [302, 403, 503]) {
    test(`a discarded HTTP ${status} continuation cancels its unfinished body`, async () => {
        let canceled = 0;
        const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(encoder.encode("upstream error")); },
            cancel() { canceled++; },
        }), { status });
        const result = await withFetchTransport(async () => response,
            () => makeContinuationRefetch(options(`http://cleanup-${status}.invalid/v1/chat/completions`))());
        assert.equal(result, null);
        assert.equal(canceled, 1, "the discarded body has no reader that could release it later");
        assert.equal(_liveUpstreamTimersForTest(), 0);
    });
}

for (const cancelKind of ["reject", "never settle"] as const) {
    test(`a discarded continuation returns even when cancellation will ${cancelKind}`, { timeout: 2_000 }, async () => {
        let canceled = 0;
        const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(encoder.encode("error")); },
            cancel() {
                canceled++;
                if (cancelKind === "reject") throw new Error("transport cancellation failed");
                return new Promise<void>(() => {});
            },
        }), { status: 500 });
        const result = await withFetchTransport(async () => response,
            () => makeContinuationRefetch(options(`http://cleanup-cancel-${canceled}.invalid/v1/chat/completions`))());
        assert.equal(result, null);
        assert.equal(canceled, 1);
        assert.equal(_liveUpstreamTimersForTest(), 0);
    });
}

test("a successful continuation retains its byte-exact stream for the caller", async () => {
    const bytes = Uint8Array.from([0, 1, 13, 10, 127, 128, 255]);
    let canceled = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
        cancel() { canceled++; },
    }));
    const result = await withFetchTransport(async () => response,
        () => makeContinuationRefetch(options("http://cleanup-ok.invalid/v1/chat/completions"))());
    assert.ok(result);
    assert.deepEqual(new Uint8Array(await new Response(result).arrayBuffer()), bytes);
    assert.equal(canceled, 0);
    assert.equal(_liveUpstreamTimersForTest(), 0);
});

test("a bodyless continuation response still returns null", async () => {
    const result = await withFetchTransport(async () => new Response(null, { status: 204 }),
        () => makeContinuationRefetch(options("http://cleanup-empty.invalid/v1/chat/completions"))());
    assert.equal(result, null);
    assert.equal(_liveUpstreamTimersForTest(), 0);
});

test("a 429 continuation keeps its body for model-scope classification", async () => {
    // #6639: governor is OFF by default now — this pin verifies the ENABLED
    // path, so opt in explicitly (restored in finally).
    const previousToggle = process.env.BILI_THROTTLE_429;
    process.env.BILI_THROTTLE_429 = "1";
    _resetUpstreamThrottleForTest();
    let canceled = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(JSON.stringify({ error: {
                code: "keyring_model_temporarily_unavailable", model: "cleanup-model", message: "model unavailable",
            } })));
            controller.close();
        },
        cancel() { canceled++; },
    }), { status: 429, headers: { "retry-after": "10" } });
    try {
        const result = await withFetchTransport(async () => response,
            () => makeContinuationRefetch(options("http://cleanup-throttled.invalid/v1/chat/completions"))());
        assert.equal(result, null);
        assert.equal(canceled, 0, "429 bodies are consumed by the existing scope classifier");
        assert.equal(activeThrottleHolds()[0]?.model, "cleanup-model");
        assert.equal(_liveUpstreamTimersForTest(), 0);
    } finally {
        _resetUpstreamThrottleForTest();
        if (previousToggle === undefined) delete process.env.BILI_THROTTLE_429;
        else process.env.BILI_THROTTLE_429 = previousToggle;
    }
});

test("an unfinished HTTP error releases a real single-connection pool for the next request", { timeout: 5_000 }, async (t) => {
    let requests = 0;
    let rejectedResponseClosed = false;
    const server = http.createServer((request, response) => {
        request.resume();
        requests++;
        if (requests === 1) {
            response.on("close", () => { rejectedResponseClosed = true; });
            response.writeHead(503, { "content-type": "text/plain" });
            response.write("retry unavailable");
        } else {
            response.end("the next request completed");
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    const dispatcher = new Agent({ connections: 1, pipelining: 1 });
    const clientAbort = new AbortController();
    try {
        const result = await makeContinuationRefetch({ ...options(url, clientAbort.signal), dispatcher })();
        assert.equal(result, null);
        const next = await fetchWithTimeout(url, { dispatcher }, 1_500);
        try {
            assert.equal(await next.response.text(), "the next request completed");
            assert.equal(requests, 2);
            assert.equal(rejectedResponseClosed, true, "the server observes cancellation of the unfinished error response");
        } finally {
            next.clearTimer();
        }
        assert.equal(_liveUpstreamTimersForTest(), 0);
    } finally {
        t.diagnostic(JSON.stringify({ requests, rejectedResponseClosed }));
        clientAbort.abort();
        await dispatcher.destroy();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
