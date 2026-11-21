import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, test } from "node:test";
import { createCore, type Config } from "acp-kernel";
import { compressLoopAnthropicJson } from "../src/compress-loop-anthropic.ts";
import { withFetchTransport } from "../src/fetch-transport.ts";
import {
    _liveUpstreamTimersForTest,
    _resetFetchUtilForTest,
    fetchWithRetry,
    UpstreamHttpError,
    type ReplayRetryInfo,
} from "../src/fetch-util.ts";
import { getSession } from "../src/session.ts";

const budget = 1 << 20;
const marker = "[upstream error body truncated after 1048576 bytes]\n";
const url = "https://retry-body.example/v1/messages";
const priorMax = process.env.BILI_REPLAY_RETRY_MAX;
const priorDelay = process.env.BILI_REPLAY_RETRY_BASE_MS;

beforeEach(() => {
    process.env.BILI_REPLAY_RETRY_MAX = "2";
    process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
});

afterEach(() => {
    const live = _liveUpstreamTimersForTest();
    _resetFetchUtilForTest();
    if (priorMax === undefined) delete process.env.BILI_REPLAY_RETRY_MAX;
    else process.env.BILI_REPLAY_RETRY_MAX = priorMax;
    if (priorDelay === undefined) delete process.env.BILI_REPLAY_RETRY_BASE_MS;
    else process.env.BILI_REPLAY_RETRY_BASE_MS = priorDelay;
    assert.equal(live, 0);
});

function chunked(chunks: Uint8Array[], status = 400): Response {
    let i = 0;
    return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) controller.enqueue(chunks[i++]);
            else controller.close();
        },
    }), { status });
}

async function rejection(response: Response): Promise<UpstreamHttpError> {
    process.env.BILI_REPLAY_RETRY_MAX = "1";
    return withFetchTransport(async () => response, async () => {
        try {
            const result = await fetchWithRetry(url, {}, undefined, undefined);
            result.clearTimer();
            assert.fail("expected an HTTP rejection");
        } catch (error) {
            assert.ok(error instanceof UpstreamHttpError);
            return error;
        }
    });
}

for (const length of [0, 37, budget - 1, budget]) {
    test(`complete ${length}-byte errors retain their exact diagnostic`, async () => {
        const text = "x".repeat(length);
        const error = await rejection(new Response(text, { status: 400 }));
        assert.equal(error.body.length, length);
        assert.ok(error.body === text);
        assert.equal(error.status, 400);
        assert.equal(error.attempts, 1);
    });
}

test("a body-less rejection retains an empty diagnostic", async () => {
    assert.equal((await rejection(new Response(null, { status: 400 }))).body, "");
});

for (const length of [budget + 1, 8 * budget]) {
    test(`a ${length}-byte error keeps only a marked byte-budget prefix`, async () => {
        const error = await rejection(new Response("x".repeat(length), { status: 400 }));
        assert.ok(error.body.startsWith(marker));
        assert.equal(Buffer.byteLength(error.body), marker.length + budget);
        assert.ok(error.body.slice(marker.length) === "x".repeat(budget));
    });
}

test("a truncated JSON prefix is visibly diagnostic rather than a complete envelope", async () => {
    const envelope = '{"error":{"code":"request_failed"}}';
    const error = await rejection(new Response(envelope + " ".repeat(budget), { status: 400 }));
    assert.ok(error.body.startsWith(marker + envelope));
    assert.throws(() => JSON.parse(error.body), SyntaxError);
});

test("complete split UTF-8, BOM, and invalid input decode exactly like Response.text", async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("错误 🌍"), Buffer.from([0xff])]);
    const expected = await new Response(bytes).text();
    const error = await rejection(chunked([bytes.subarray(0, 4), bytes.subarray(4, 9), bytes.subarray(9)]));
    assert.equal(error.body, expected);
});

for (const split of [false, true]) {
    test(`the byte cap does not invent a replacement character for a cut code point (split=${split})`, async () => {
        const ascii = Buffer.alloc(budget - 2, 120);
        const emoji = Buffer.from("🌍tail");
        const chunks = split ? [ascii, emoji.subarray(0, 1), emoji.subarray(1)] : [Buffer.concat([ascii, emoji])];
        const error = await rejection(chunked(chunks));
        assert.ok(error.body.startsWith(marker));
        assert.equal(error.body.length, marker.length + budget - 2);
        assert.ok(error.body.slice(marker.length) === ascii.toString());
        assert.ok(!error.body.includes("\ufffd"));
    });
}

test("multibyte diagnostics are capped by bytes rather than JavaScript characters", async () => {
    const error = await rejection(new Response("界".repeat(budget), { status: 400 }));
    assert.ok(error.body.startsWith(marker));
    assert.equal(error.body.length - marker.length, Math.floor(budget / 3));
    assert.equal(Buffer.byteLength(error.body) - marker.length, Math.floor(budget / 3) * 3);
});

for (const status of [429, 503]) {
    test(`HTTP ${status} still retries with a bounded diagnostic and preserves the recovered body`, async () => {
        let sends = 0;
        const retries: ReplayRetryInfo[] = [];
        await withFetchTransport(async () => ++sends === 1
            ? new Response("x".repeat(2 * budget), { status })
            : new Response("recovered"), async () => {
            const result = await fetchWithRetry(url, {}, undefined, undefined, (info) => retries.push(info));
            try { assert.equal(await result.response.text(), "recovered"); }
            finally { result.clearTimer(); }
        });
        assert.equal(sends, 2);
        assert.equal(retries.length, 1);
        assert.equal(retries[0].status, status);
        assert.equal(retries[0].attempt, 1);
        assert.equal(retries[0].maxAttempts, 2);
        assert.equal(retries[0].delayMs, 0);
        assert.ok(retries[0].detail.startsWith(marker));
        assert.equal(retries[0].detail.length, marker.length + budget);
    });
}

test("transient prose inside the retained prefix still permits recovery", async () => {
    let sends = 0;
    await withFetchTransport(async () => ++sends === 1
        ? new Response("please retry " + "x".repeat(budget), { status: 400 })
        : new Response("recovered"), async () => {
        const result = await fetchWithRetry(url, {}, undefined, undefined);
        try { assert.equal(await result.response.text(), "recovered"); }
        finally { result.clearTimer(); }
    });
    assert.equal(sends, 2);
});

test("prose beyond the byte budget is not used to replay an otherwise permanent rejection", async () => {
    let sends = 0;
    await withFetchTransport(async () => ++sends === 1
        ? new Response("x".repeat(budget) + " please retry", { status: 400 })
        : new Response("unexpected replay"), async () => {
        await assert.rejects(fetchWithRetry(url, {}, undefined, undefined).then((result) => {
            result.clearTimer();
            return result;
        }), (error) =>
            error instanceof UpstreamHttpError && error.status === 400 && error.attempts === 1);
    });
    assert.equal(sends, 1);
});

test("oversized rejections keep the existing finite attempt limit", async () => {
    let sends = 0;
    const retries: ReplayRetryInfo[] = [];
    await withFetchTransport(async () => {
        sends++;
        return new Response("x".repeat(budget + 1), { status: 503 });
    }, async () => {
        await assert.rejects(fetchWithRetry(url, {}, undefined, undefined, (info) => retries.push(info)), (error) =>
            error instanceof UpstreamHttpError && error.attempts === 2 && error.body.startsWith(marker));
    });
    assert.equal(sends, 2);
    assert.equal(retries.length, 1);
});

for (const cancelKind of ["reject", "never settle"] as const) {
    test(`overflow returns without waiting for a cancellation that will ${cancelKind}`, async () => {
        let canceled = 0;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(budget + 1));
                watchdog = setTimeout(() => controller.error(new Error("the reader waited for the tail")), 500);
            },
            cancel() {
                canceled++;
                if (cancelKind === "reject") throw new Error("transport cancellation failed");
                return new Promise<void>(() => {});
            },
        }), { status: 400 });
        try {
            const error = await rejection(response);
            assert.ok(error.body.startsWith(marker));
            assert.equal(canceled, 1);
        } finally {
            clearTimeout(watchdog);
        }
    });
}

test("a read failure after a partial error body retains its original identity", async () => {
    const failure = Object.assign(new Error("read failed after partial data"), { code: "UND_ERR_BODY_TIMEOUT" });
    let pulls = 0;
    let sends = 0;
    const retries: ReplayRetryInfo[] = [];
    await withFetchTransport(async () => {
        sends++;
        return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
                if (++pulls === 1) controller.enqueue(Buffer.from("partial error"));
                else controller.error(failure);
            },
        }), { status: 503 });
    }, async () => {
        await assert.rejects(fetchWithRetry(url, {}, undefined, undefined, (info) => retries.push(info)),
            (error) => error === failure);
    });
    assert.equal(sends, 1);
    assert.deepEqual(retries, []);
});

test("successful response streams are not capped", async () => {
    const bytes = Buffer.alloc(2 * budget, 120);
    await withFetchTransport(async () => new Response(bytes), async () => {
        const result = await fetchWithRetry(url, {}, undefined, undefined);
        try { assert.ok(Buffer.from(await result.response.arrayBuffer()).equals(bytes)); }
        finally { result.clearTimer(); }
    });
});

test("the real Anthropic tool loop recovers without waiting for an endless HTTP error tail", async () => {
    const requests: string[] = [];
    let canceledErrorBody = false;
    const final = { type: "message", role: "assistant", content: [{ type: "text", text: "after-status" }], stop_reason: "end_turn" };
    const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push(Buffer.concat(chunks).toString());
        if (requests.length === 1) {
            res.writeHead(503, { "content-type": "text/plain" });
            res.on("close", () => { canceledErrorBody = true; });
            res.write(Buffer.alloc(budget + 1, 120));
        } else {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(final));
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 5_000);
    try {
        const result = await compressLoopAnthropicJson(
            { type: "message", role: "assistant", content: [{ type: "tool_use", id: "status-call", name: "acp_status", input: {} }], stop_reason: "tool_use" },
            { core: createCore(), config: { modelContextLimit: 200000 } as Config, messages: [], session: getSession("retry-body-budget-http"), log: () => {} },
            { signal: abort.signal },
            { messages: [{ role: "user", content: "run acp_status" }] },
            { url: `http://127.0.0.1:${address.port}/v1/messages`, headers: { "content-type": "application/json" } },
        );
        assert.deepEqual(result, final);
        assert.equal(requests.length, 2);
        assert.equal(requests[0], requests[1], "the retry resends the same executed tool result");
        const sent = JSON.parse(requests[1]) as { messages: Array<{ content: Array<{ type: string; tool_use_id?: string; content?: string }> }> };
        const receipt = sent.messages.at(-1)?.content[0];
        assert.equal(receipt?.type, "tool_result");
        assert.equal(receipt?.tool_use_id, "status-call");
        assert.ok(receipt?.content && receipt.content.length > 0);
        assert.equal(canceledErrorBody, true);
    } finally {
        clearTimeout(deadline);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
