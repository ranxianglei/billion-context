import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { createAnthropicAdapter } from "../src/loop/adapter-anthropic.ts";
import { createCommandcodeAdapter } from "../src/loop/adapter-commandcode.ts";
import { createGoogleAdapter } from "../src/loop/adapter-google.ts";
import { createOpenaiAdapter } from "../src/loop/adapter-openai.ts";
import { createResponsesAdapter } from "../src/loop/adapter-responses.ts";
import { runCompressLoop, type CompressLoopAdapter, type LoopCtx } from "../src/loop/core.ts";

const requestBody = { model: "cleanup-test", stream: true, messages: [{ role: "user", content: "Continue." }] };
const textFrame = (text: string, done = false) => `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
})}\n\n` + (done ? 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' : "");

function context(protocol: LoopCtx["protocol"] = "openai"): LoopCtx {
    return {
        core: createCore(), config: defaultConfig(200_000), protocol, visibilityMarkers: false,
        messages: [{ id: "request", role: "user", contentType: "text", text: "Continue." }],
        session: {
            id: "loop-stream-cleanup", meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0,
                cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0,
                retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {}, createdAt: Date.now(), lastSeen: Date.now(), state: createInitialState(),
            blockContents: new Map(), inFlight: 0, persisted: false, pendingRetrievals: [],
        },
        log: () => {},
    };
}

function loop(stream: ReadableStream<Uint8Array>, adapter = createOpenaiAdapter(requestBody),
    url = "http://127.0.0.1:1/unused", ctx = context()) {
    return runCompressLoop(stream, ctx, requestBody, { url, headers: { "content-type": "application/json" } },
        adapter, buildCompressSystemPrompt());
}

function openStream(frame: string, rejectCancel = false) {
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Buffer.from(frame)); },
        cancel() {
            cancels++;
            if (rejectCancel) return Promise.reject(new Error("cleanup failure"));
        },
    });
    return { stream, cancels: () => cancels };
}

async function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("stream cleanup did not settle")), ms);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

const wires: Array<{ name: string; protocol: LoopCtx["protocol"]; adapter: () => CompressLoopAdapter; frame: string }> = [
    { name: "OpenAI", protocol: "openai", adapter: () => createOpenaiAdapter(requestBody), frame: textFrame("visible") },
    { name: "Anthropic", protocol: "anthropic", adapter: () => createAnthropicAdapter(requestBody),
        frame: 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"visible"}}\n\n' },
    { name: "Google", protocol: "google", adapter: () => createGoogleAdapter(requestBody),
        frame: 'data: {"candidates":[{"content":{"parts":[{"text":"visible"}]}}]}\n\n' },
    { name: "Responses", protocol: "responses", adapter: () => createResponsesAdapter(),
        frame: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg-1","output_index":0,"content_index":0,"delta":"visible"}\n\n' },
    { name: "CommandCode", protocol: "openai", adapter: () => createCommandcodeAdapter(requestBody),
        frame: '{"type":"text-delta","text":"visible"}\n' },
];

for (const wire of wires) {
    test(`${wire.name}: returning from the loop cancels and unlocks its unread response`, async () => {
        const source = openStream(wire.frame);
        const iterator = loop(source.stream, wire.adapter(), undefined, context(wire.protocol));
        try {
            const first = await within(iterator.next());
            assert.equal(first.done, false);
            assert.ok(first.value.length > 0);
            await within(iterator.return(undefined));
            assert.equal(source.stream.locked, false);
            assert.equal(source.cancels(), 1, "the adapter released its reader but the loop must also cancel the body");
            await iterator.return(undefined);
            assert.equal(source.cancels(), 1);
        } finally {
            await iterator.return(undefined);
            await source.stream.cancel();
        }
    });
}

test("cleanup does not await a tee sibling that still owns its branch", async () => {
    const source = openStream(textFrame("visible"));
    const [read, retained] = source.stream.tee();
    const iterator = loop(read);
    try {
        await within(iterator.next());
        await within(iterator.return(undefined));
        const reader = retained.getReader();
        const first = await reader.read();
        assert.equal(Buffer.from(first.value!).toString("utf8"), textFrame("visible"));
        reader.releaseLock();
        await within(retained.cancel());
        assert.equal(source.cancels(), 1, "both branch owners released the underlying source");
    } finally {
        await iterator.return(undefined);
        await Promise.all([read.cancel(), retained.cancel()]);
    }
});

test("a rejected body cancellation does not replace a normal consumer return", async () => {
    const source = openStream(textFrame("visible"), true);
    const iterator = loop(source.stream);
    try {
        await iterator.next();
        await iterator.return(undefined);
        assert.equal(source.cancels(), 1);
        assert.equal(source.stream.locked, false);
    } finally {
        await iterator.return(undefined);
        await source.stream.cancel().catch(() => {});
    }
});

test("parser exceptions retain their cause while releasing the unread response", async () => {
    const source = openStream("input", true);
    const expected = new Error("parser rejected the upstream frame");
    const adapter: CompressLoopAdapter = {
        ...createOpenaiAdapter(requestBody),
        async *parseStream(body) {
            const reader = body.getReader();
            try {
                await reader.read();
                throw expected;
            } finally { reader.releaseLock(); }
        },
    };
    try {
        await assert.rejects(async () => {
            for await (const _chunk of loop(source.stream, adapter)) { /* drains until the parser fails */ }
        }, error => error === expected);
        assert.equal(source.cancels(), 1);
        assert.equal(source.stream.locked, false);
    } finally { await source.stream.cancel().catch(() => {}); }
});

test("fully consumed responses keep their client bytes and do not cancel a closed source", async () => {
    let cancels = 0;
    const source = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Buffer.from(textFrame("complete", true))); controller.close(); },
        cancel() { cancels++; },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of loop(source)) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    assert.ok(text.startsWith(textFrame("complete")));
    assert.equal((text.match(/data: \[DONE\]/g) ?? []).length, 1);
    assert.equal((text.match(/"finish_reason":"stop"/g) ?? []).length, 1);
    assert.equal(cancels, 0);
    assert.equal(source.locked, false);
});

interface HttpRecord { raw: string; closed: Promise<void> }
async function rig(t: TestContext, respond: (res: http.ServerResponse, index: number) => void) {
    const requests: HttpRecord[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const closed = new Promise<void>(resolve => res.once("close", resolve));
            requests.push({ raw: Buffer.concat(chunks).toString("utf8"), closed });
            res.writeHead(200, { "content-type": "text/event-stream" });
            respond(res, requests.length);
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
    const initial = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody) });
    assert.ok(initial.body);
    t.after(() => initial.body!.cancel().catch(() => {}));
    return { url, requests, initial };
}

test("an in-band error releases the old HTTP response before retrying its logical request", async t => {
    const { url, requests, initial } = await rig(t, (res, index) => {
        if (index === 1) res.write('data: {"error":{"code":"upstream_busy","message":"retry this turn"}}\n\n');
        else res.end(textFrame("recovered", true));
    });
    const chunks: Buffer[] = [];
    for await (const chunk of loop(initial.body!, createOpenaiAdapter(requestBody), url)) chunks.push(chunk);
    assert.equal(requests.length, 2, "the existing one-shot retry still runs");
    assert.equal(requests[1].raw, requests[0].raw, "retry keeps the same logical request body");
    const client = Buffer.concat(chunks).toString("utf8");
    assert.match(client, /recovered/);
    assert.doesNotMatch(client, /upstream_busy|stream truncated/);
    await within(requests[0].closed);
});

test("returning after visible output closes an initial real HTTP response", async t => {
    const { url, requests, initial } = await rig(t, res => res.write(textFrame("ongoing")));
    const iterator = loop(initial.body!, createOpenaiAdapter(requestBody), url);
    try {
        const first = await within(iterator.next());
        assert.ok(first.value?.toString().includes("ongoing"));
        await iterator.return(undefined);
        await within(requests[0].closed);
        assert.equal(requests.length, 1);
    } finally { await iterator.return(undefined); }
});

test("returning after a proxy tool closes the current HTTP continuation response", async t => {
    const statusCall = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: "status-1", type: "function", function: { name: "acp_status", arguments: "{}" } }],
    }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
    const { url, requests, initial } = await rig(t, (res, index) => {
        if (index === 1) res.end(statusCall);
        else res.write(textFrame("continuation"));
    });
    const iterator = loop(initial.body!, createOpenaiAdapter(requestBody), url);
    try {
        const first = await within(iterator.next());
        assert.ok(first.value?.toString().includes("continuation"));
        assert.equal(requests.length, 2);
        assert.match(requests[1].raw, /status-1/);
        await iterator.return(undefined);
        await within(requests[1].closed);
    } finally { await iterator.return(undefined); }
});
