import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createCodexCatalogFetch } from "../src/server/codex-catalog-cache.js";
import type { fetchWithTimeout } from "../src/fetch-util.js";

type FetchResult = Awaited<ReturnType<typeof fetchWithTimeout>>;
const url = "https://chatgpt.com/backend-api/codex/models";
const init = { headers: { authorization: "Bearer SYNTHETIC" } };
const catalog = JSON.stringify({ models: [{ slug: "synthetic", context_window: 10000, model_messages: {} }] });
const result = (): FetchResult => ({ response: new Response(catalog), clearTimer() {}, stopIdleTimer() {} });
const create = (deadlineMs = 10) => createCodexCatalogFetch({ directory: null, deadlineMs });
const never = () => new Promise<FetchResult>(() => {});

function stalled() {
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    const cleanup = { timer: 0, idle: 0 };
    const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"models":[')); },
        cancel() { cancelled(); },
    }));
    return {
        cancellation,
        cleanup,
        result: {
            response,
            clearTimer() { cleanup.timer++; },
            stopIdleTimer() { cleanup.idle++; },
        },
    };
}

async function warm(fetch: ReturnType<typeof createCodexCatalogFetch>) {
    assert.equal(await (await fetch(async () => result(), url, init)).response.text(), catalog);
}

test("cold catalog deadline defaults to ten seconds and warm deadline stays four seconds", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const cold = createCodexCatalogFetch({ directory: null });
        let coldSettled = false;
        const coldFailure = cold(never, url, init).catch((error: unknown) => error).finally(() => { coldSettled = true; });
        t.mock.timers.tick(9999);
        await setImmediate();
        assert.equal(coldSettled, false);
        t.mock.timers.tick(1);
        await setImmediate();
        assert.equal(coldSettled, true);
        const coldError = await coldFailure;
        assert.ok(coldError instanceof Error && "code" in coldError && coldError.code === "ETIMEDOUT");

        const hot = createCodexCatalogFetch({ directory: null });
        await warm(hot);
        let warmSettled = false;
        const waiting = hot(never, url, init).finally(() => { warmSettled = true; });
        t.mock.timers.tick(3999);
        await setImmediate();
        assert.equal(warmSettled, false);
        t.mock.timers.tick(1);
        const cached = await waiting;
        assert.equal(cached.response.headers.get("x-bili-model-catalog"), "offline-cache");
        assert.equal(await cached.response.text(), catalog);
    } finally {
        t.mock.timers.reset();
    }
});

test("cold catalog operation that ignores cancellation still reaches its deadline", { timeout: 2000 }, async () => {
    await assert.rejects(create()(never, url, init), { name: "TimeoutError", code: "ETIMEDOUT" });
});

test("warm catalog operation that ignores cancellation returns the valid cache", { timeout: 2000 }, async () => {
    const fetch = create();
    await warm(fetch);
    const cached = await fetch(never, url, init);
    assert.equal(cached.response.headers.get("x-bili-model-catalog"), "offline-cache");
    assert.equal(await cached.response.text(), catalog);
});

test("cold catalog body that never closes is cancelled and its transport timers are cleared", { timeout: 2000 }, async () => {
    const pending = stalled();
    await assert.rejects(create()(async () => pending.result, url, init), { code: "ETIMEDOUT" });
    await pending.cancellation;
    assert.deepEqual(pending.cleanup, { timer: 1, idle: 1 });
});

test("warm catalog body that never closes is cancelled before replaying cached metadata", { timeout: 2000 }, async () => {
    const fetch = create();
    await warm(fetch);
    const pending = stalled();
    const cached = await fetch(async () => pending.result, url, init);
    assert.equal(await cached.response.text(), catalog);
    assert.equal(cached.response.headers.get("x-bili-model-catalog"), "offline-cache");
    await pending.cancellation;
    assert.deepEqual(pending.cleanup, { timer: 1, idle: 1 });
});

test("an operation returning after the deadline has its late response discarded", { timeout: 2000 }, async () => {
    let complete!: (value: FetchResult) => void;
    const operation = new Promise<FetchResult>((resolve) => { complete = resolve; });
    await assert.rejects(create()(() => operation, url, init), { code: "ETIMEDOUT" });
    const late = stalled();
    complete(late.result);
    await late.cancellation;
    assert.deepEqual(late.cleanup, { timer: 1, idle: 1 });
});

test("caller cancellation stays cancellation during cold and warm body reads", { timeout: 2000 }, async () => {
    for (const cached of [false, true]) {
        const fetch = create(1000);
        if (cached) await warm(fetch);
        const controller = new AbortController();
        const reason = new Error("synthetic caller cancellation");
        const pending = stalled();
        const waiting = fetch(async () => pending.result, url, init, controller.signal);
        await setImmediate();
        controller.abort(reason);
        await assert.rejects(waiting, (error: unknown) => error === reason);
        await pending.cancellation;
        assert.deepEqual(pending.cleanup, { timer: 1, idle: 1 });
    }
});

test("caller cancellation during an operation cleans up its late response", { timeout: 2000 }, async () => {
    const fetch = create(1000);
    await warm(fetch);
    let complete!: (value: FetchResult) => void;
    const operation = new Promise<FetchResult>((resolve) => { complete = resolve; });
    const controller = new AbortController();
    const reason = new Error("synthetic caller cancellation");
    const waiting = fetch(() => operation, url, init, controller.signal);
    controller.abort(reason);
    await assert.rejects(waiting, (error: unknown) => error === reason);
    const late = stalled();
    complete(late.result);
    await late.cancellation;
    assert.deepEqual(late.cleanup, { timer: 1, idle: 1 });
});

test("inference requests keep their original signal and transport behavior", async () => {
    const controller = new AbortController();
    const expected = result();
    const actual = await create(0)(async (signal) => {
        assert.equal(signal, controller.signal);
        await setImmediate();
        return expected;
    }, url.replace("/models", "/responses"), { ...init, method: "POST" }, controller.signal);
    assert.equal(actual, expected);
});
