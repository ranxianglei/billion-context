import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { defaultConfig } from "acp-kernel";
import { createGoogleAdapter } from "../src/loop/adapter-google.ts";
import type { ParsedStreamEvent } from "../src/loop/core.ts";
import { sseEventData } from "../src/sse-util.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { closeServers } from "./server-close-guard.ts";

function candidate(parts: Array<Record<string, unknown>>, finishReason?: string): Record<string, unknown> {
    return { candidates: [{ index: 0, content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }] };
}

const first = candidate([{ text: "First café 🛰️. " }]);
const signed = { thought: true, text: 'Nested delimiters: [{"quoted":"\\\\ and \\\""}] 🌏.', thoughtSignature: "c2lnbmVk" };
const middle = candidate([signed, { text: "Second answer. " }]);
const args = { query: 'escaped \\" quote and } ] [ {', nested: [{ values: [1, true, null, "多字节"] }], empty: {} };
const call = candidate([{ functionCall: { id: "lookup-1", name: "lookup", args }, thoughtSignature: "dG9vbC1zaWc=" }]);
const last = { ...candidate([], "STOP"), usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 3 } };
const frames = [first, middle, call, last];

function arrayStream(wire: Buffer, chunkSize: number | number[], failAfterData = false): ReadableStream<Uint8Array> {
    let offset = 0;
    let reads = 0;
    return new ReadableStream({ pull(controller) {
        if (offset === wire.length) {
            if (failAfterData) controller.error(new Error("Synthetic stream interruption."));
            else controller.close();
            return;
        }
        const size = typeof chunkSize === "number" ? chunkSize : chunkSize[reads++ % chunkSize.length]!;
        controller.enqueue(wire.subarray(offset, offset + size));
        offset = Math.min(offset + size, wire.length);
    } });
}

async function collect(wire: string, chunkSize: number | number[], failAfterData = false): Promise<ParsedStreamEvent[]> {
    const events: ParsedStreamEvent[] = [];
    for await (const event of createGoogleAdapter({}).parseStream(arrayStream(Buffer.from(wire), chunkSize, failAfterData), 1)) events.push(event);
    return events;
}

test("Google array keeps a partial escaped string after a completed element in the same read", async () => {
    const wire = JSON.stringify(frames);
    const middleStart = wire.indexOf(JSON.stringify(middle));
    const splitAfterEscape = wire.indexOf("\\", middleStart) + 1;
    assert.ok(splitAfterEscape > middleStart);
    const firstReadBytes = Buffer.byteLength(wire.slice(0, splitAfterEscape));
    const events = await collect(wire, [firstReadBytes, 1, 2, 7]);
    const control = await collect(wire, Buffer.byteLength(wire));
    assert.deepEqual(semanticEvents(events), semanticEvents(control));
    assert.deepEqual(forwarded(events), forwarded(control));
});

test("Google array ignores later whitespace chunks after the top-level array closes", async () => {
    const wire = JSON.stringify([first, last]);
    const control = await collect(wire, 73);
    const events = await collect(wire + " \r\n\t".repeat(8192), [Buffer.byteLength(wire), 17]);
    assert.deepEqual(semanticEvents(events), semanticEvents(control));
    assert.deepEqual(forwarded(events), forwarded(control));
});

test("Google array preserves several elements in one read while the consumer yields", async () => {
    const wire = JSON.stringify(frames);
    const events: ParsedStreamEvent[] = [];
    for await (const event of createGoogleAdapter({}).parseStream(arrayStream(Buffer.from(wire), Buffer.byteLength(wire)), 1)) {
        events.push(event);
        await nextTurn();
    }
    assert.deepEqual(semanticEvents(events), semanticEvents(await collect(wire, 23)));
});

function semanticEvents(events: ParsedStreamEvent[]): Array<Record<string, unknown>> {
    return events.map(event => {
        const { raw: _raw, chunk, ...rest } = event as ParsedStreamEvent & { raw?: Buffer; chunk?: Buffer };
        return chunk ? { ...rest, frame: JSON.parse(sseEventData(chunk.toString())!) as unknown } : rest;
    });
}

function forwarded(events: ParsedStreamEvent[]): Array<Record<string, unknown>> {
    return events.flatMap(event => {
        const raw = "raw" in event && event.raw ? event.raw : event.kind === "meta" ? event.chunk : undefined;
        return raw ? [JSON.parse(sseEventData(raw.toString())!) as Record<string, unknown>] : [];
    });
}

for (const pretty of [false, true]) {
    for (const chunkSize of [1, 2, 7, 31, 113, 4096]) {
        test(`Google array framing preserves nested values and split UTF-8 (${pretty ? "pretty" : "compact"}, ${chunkSize}-byte chunks)`, async () => {
            const control = await collect(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), 43);
            const wire = `\ufeff \n${JSON.stringify(frames, null, pretty ? 2 : undefined)}\n`;
            const events = await collect(wire, chunkSize);
            assert.deepEqual(semanticEvents(events), semanticEvents(control));
            assert.deepEqual(forwarded(events), forwarded(control));
            const tool = events.find(event => event.kind === "tool_call");
            assert.ok(tool && tool.kind === "tool_call");
            assert.deepEqual(JSON.parse(tool.arguments), args);
            assert.equal(tool.signature, "dG9vbC1zaWc=");
            assert.deepEqual(events.filter(event => event.kind === "reasoning").map(event => event.delta), [signed.text]);
        });
    }
}

for (const interrupted of [false, true]) {
    test(`Google array retains complete-prefix output before an ${interrupted ? "interrupted" : "incomplete"} element`, async () => {
        const wire = `[${JSON.stringify(first)},${JSON.stringify(middle)},{"candidates":[{"content":{"parts":[{"text":"unfinished`;
        const events = await collect(wire, 19, interrupted);
        assert.deepEqual(forwarded(events), [first, middle]);
        assert.equal(events.filter(event => event.kind === "done").length, 0);
        assert.ok(!JSON.stringify(events).includes("unfinished"));
    });
}

test("Google array emits an element before the next network read can finish", { timeout: 5000 }, async t => {
    let resume!: () => void;
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    t.signal.addEventListener("abort", resume, { once: true });
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
        if (pulls++ === 0) controller.enqueue(Buffer.from(`[${JSON.stringify(first)},`));
        else {
            await resumed;
            controller.enqueue(Buffer.from(`${JSON.stringify(last)}]`));
            controller.close();
        }
    } });
    const iterator = createGoogleAdapter({}).parseStream(stream, 1);
    try {
        const event = await iterator.next();
        assert.equal(event.value?.kind, "text");
        if (event.value?.kind === "text") assert.equal(event.value.delta, "First café 🛰️. ");
    } finally {
        resume();
        for await (const _event of iterator) { /* finish the remaining response */ }
    }
});

test("Google array response reaches the actual HTTP compression loop", { timeout: 15000 }, async () => {
    let requests = 0;
    let toolInjected = false;
    const output = [first, middle, candidate([{ text: "Last answer." }]), last];
    const upstream = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests++;
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        toolInjected = JSON.stringify(body.tools).includes("compress");
        res.writeHead(200, { "content-type": "application/json" });
        for (let i = 0; i < output.length; i++) {
            res.write(`${i === 0 ? "[" : ","}${JSON.stringify(output[i])}`);
            await nextTurn();
        }
        res.end("]");
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress === "object");
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts: ProxyOptions = {
        port: 0, host: "127.0.0.1", upstream: `http://127.0.0.1:${upstreamAddress.port}`,
        routes: {}, proxy: "", proxyMode: "direct", proxySource: "direct",
        modelContextLimit: 200000, kernelConfig: defaultConfig(200000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, chainContentDetection: false,
        autoUpdate: false, mitm: { enabled: false, domains: [] },
    };
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer(opts);
        if (!proxy.listening) await once(proxy, "listening");
        const address = proxy.address();
        assert.ok(address && typeof address === "object");
        const response = await fetch(`http://127.0.0.1:${address.port}/v1beta/models/gemini-test:streamGenerateContent`, {
            method: "POST", headers: { "content-type": "application/json", "x-acp-session": "google-array-buffer" },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Explain the result." }] }] }),
        });
        assert.equal(response.status, 200);
        const wire = await response.text();
        const received = wire.split("\n\n").map(sseEventData).filter((value): value is string => value !== null && value !== undefined).map(value => JSON.parse(value) as { candidates?: Array<{ content?: { parts?: unknown[] }; finishReason?: string }> });
        const parts = received.flatMap(frame => frame.candidates?.[0]?.content?.parts ?? []);
        assert.deepEqual(parts, [{ text: "First café 🛰️. " }, signed, { text: "Second answer. " }, { text: "Last answer." }]);
        assert.ok(received.some(frame => frame.candidates?.[0]?.finishReason === "STOP"));
        assert.equal(requests, 1);
        assert.equal(toolInjected, true);
    } finally {
        await closeServers(proxy ? [proxy, upstream] : [upstream]);
    }
});
