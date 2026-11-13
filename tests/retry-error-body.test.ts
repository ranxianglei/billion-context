import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { withFetchTransport } from "../src/fetch-transport.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest, fetchWithRetry, type ReplayRetryInfo } from "../src/fetch-util.ts";

const priorMax = process.env.BILI_REPLAY_RETRY_MAX;
const priorDelay = process.env.BILI_REPLAY_RETRY_BASE_MS;

afterEach(() => {
    const live = _liveUpstreamTimersForTest();
    _resetFetchUtilForTest();
    if (priorMax === undefined) delete process.env.BILI_REPLAY_RETRY_MAX;
    else process.env.BILI_REPLAY_RETRY_MAX = priorMax;
    if (priorDelay === undefined) delete process.env.BILI_REPLAY_RETRY_BASE_MS;
    else process.env.BILI_REPLAY_RETRY_BASE_MS = priorDelay;
    assert.equal(live, 0);
});

for (const status of [400, 503]) {
    test(`error-body failure at HTTP ${status} preserves the transport error without replay`, async () => {
        process.env.BILI_REPLAY_RETRY_MAX = "3";
        process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
        const failure = Object.assign(new Error("body timeout"), { code: "UND_ERR_BODY_TIMEOUT" });
        let sends = 0;
        const retries: ReplayRetryInfo[] = [];
        await withFetchTransport(async () => {
            sends++;
            return new Response(new ReadableStream<Uint8Array>({
                start(controller) { controller.error(failure); },
            }), { status });
        }, async () => {
            await assert.rejects(
                fetchWithRetry("https://upstream.example/api", {}, undefined, undefined, (info) => retries.push(info)),
                (error) => error === failure,
            );
        });
        assert.equal(sends, 1);
        assert.deepEqual(retries, []);
    });
}

test("aborting while an HTTP error body is read preserves cancellation", async () => {
    process.env.BILI_REPLAY_RETRY_MAX = "3";
    process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
    const controller = new AbortController();
    const failure = new DOMException("client disconnected", "AbortError");
    let sends = 0;
    const retries: ReplayRetryInfo[] = [];
    await withFetchTransport(async () => {
        sends++;
        return new Response(new ReadableStream<Uint8Array>({
            pull(stream) {
                controller.abort(failure);
                stream.error(failure);
            },
        }), { status: 503 });
    }, async () => {
        await assert.rejects(
            fetchWithRetry("https://upstream.example/api", {}, undefined, controller.signal, (info) => retries.push(info)),
            (error) => error === failure,
        );
    });
    assert.equal(sends, 1);
    assert.deepEqual(retries, []);
});

test("complete transient error bodies still retry and recover", async () => {
    process.env.BILI_REPLAY_RETRY_MAX = "3";
    process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
    let sends = 0;
    const retries: ReplayRetryInfo[] = [];
    await withFetchTransport(async () => ++sends === 1
        ? new Response("temporarily unavailable", { status: 503 })
        : new Response("recovered"), async () => {
        const result = await fetchWithRetry("https://upstream.example/api", {}, undefined, undefined, (info) => retries.push(info));
        try { assert.equal(await result.response.text(), "recovered"); }
        finally { result.clearTimer(); }
    });
    assert.equal(sends, 2);
    assert.equal(retries.length, 1);
    assert.equal(retries[0].detail, "temporarily unavailable");
});
