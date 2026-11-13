import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { Config } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import { createGoogleAdapter } from "../src/loop/adapter-google.ts";
import { runCompressLoop } from "../src/loop/core.ts";
import type { LoopCtx, ParsedStreamEvent } from "../src/loop/core.ts";
import { pipePluginChatWithStrip } from "../src/plugin.ts";

const quota = { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota exhausted for fixture-model" };
const unavailable = { code: 503, status: "UNAVAILABLE", message: "fixture service temporarily unavailable" };
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const answer = (value: string, done = false) => ({
    candidates: [{ content: { role: "model", parts: [{ text: value }] }, ...(done ? { finishReason: "STOP" } : {}) }],
});

async function parse(body: string, round = 1): Promise<ParsedStreamEvent[]> {
    const events: ParsedStreamEvent[] = [];
    for await (const event of createGoogleAdapter({}).parseStream(new Response(body).body!, round)) events.push(event);
    return events;
}

for (const wire of ["sse", "array"] as const) {
    test(`#6629: Google ${wire} errors are terminal error events, including continuation rounds`, async () => {
        const frames = [{ error: quota }, answer("must not follow the error", true)];
        const body = wire === "sse" ? frames.map(sse).join("") : JSON.stringify(frames);
        const events = await parse(body, 2);
        assert.deepEqual(events, [{ kind: "error", message: "RESOURCE_EXHAUSTED (429): quota exhausted for fixture-model" }]);
    });
}

test("#6629: text and reported usage survive a later Google error", async () => {
    const events = await parse(
        sse({ ...answer("already received "), usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, thoughtsTokenCount: 2, cachedContentTokenCount: 6 } }) +
        sse({ error: quota }),
    );
    assert.equal(events.filter((e) => e.kind === "text").map((e) => e.delta).join(""), "already received ");
    assert.deepEqual(events.filter((e) => e.kind === "usage"), [{ kind: "usage", inputTokens: 8, cachedTokens: 6, outputTokens: 5 }]);
    assert.equal(events.at(-1)?.kind, "error");
    assert.equal(events.some((e) => e.kind === "done"), false);
});

test("#6629: absent and null errors leave successful content unchanged", async () => {
    for (const extra of [{}, { error: null }]) {
        const events = await parse(sse({ ...answer("ordinary answer", true), ...extra }));
        assert.equal(events.some((e) => e.kind === "error"), false);
        assert.equal(events.filter((e) => e.kind === "text").map((e) => e.delta).join(""), "ordinary answer");
        assert.ok(events.some((e) => e.kind === "done" && e.finishReason === "STOP"));
    }
});

test("#6629: Google safety feedback remains a terminal policy response", async () => {
    const frame = sse({ promptFeedback: { blockReason: "SAFETY" } });
    const events = await parse(frame);
    assert.deepEqual(events, [{ kind: "meta", chunk: Buffer.from(frame) }, { kind: "done", finishReason: "SAFETY" }]);
});

function context(id: string, logs: string[]): LoopCtx {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [],
        protocol: "google",
        session: {
            id, meta: {}, metadata: {},
            stats: {
                requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0,
                cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0,
                retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0,
                storeBytesSaved: 0, rangeRestores: 0,
            },
            state: createInitialState(),
            createdAt: Date.now(), lastSeen: Date.now(), blockContents: new Map(),
            inFlight: 0, persisted: false, pendingRetrievals: [],
        },
        log: (message) => logs.push(message),
    };
}

async function loop(responses: string[], id: string): Promise<{ output: string; requests: string[]; logs: string[] }> {
    const requests: string[] = [];
    const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(responses[Math.min(requests.length - 1, responses.length - 1)]);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/v1beta/models/fixture:streamGenerateContent?alt=sse`;
    const body = { contents: [] };
    const headers = { "content-type": "application/json" };
    const logs: string[] = [];
    const signal = AbortSignal.timeout(5000);
    try {
        const first = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
        assert.ok(first.body);
        const output: Buffer[] = [];
        for await (const chunk of runCompressLoop(
            first.body, context(id, logs), body, { url, headers },
            createGoogleAdapter(body, undefined, undefined, "fixture"), "", signal,
        )) output.push(chunk);
        return { output: Buffer.concat(output).toString("utf8"), requests, logs };
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

function errors(output: string): Array<Record<string, unknown>> {
    return output.split("\n\n").filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)) as { error?: Record<string, unknown> })
        .flatMap((frame) => frame.error ? [frame.error] : []);
}

test("#6629: a first-frame Google error can use the existing one-shot retry", { timeout: 8000 }, async () => {
    const result = await loop([sse({ error: unavailable }), sse(answer("recovered response", true))], "google-error-recovery");
    assert.equal(result.requests.length, 2);
    assert.equal(result.requests[0], result.requests[1], "retry preserves the exact request body");
    assert.match(result.output, /recovered response/);
    assert.deepEqual(errors(result.output), []);
    assert.ok(result.logs.some((line) => line.includes("UNAVAILABLE (503)")));
});

test("#6629: repeated Google errors exhaust one retry and retain the provider cause", { timeout: 8000 }, async () => {
    const result = await loop([sse({ error: unavailable })], "google-error-persistent");
    assert.equal(result.requests.length, 2);
    assert.equal(result.requests[0], result.requests[1]);
    const failures = errors(result.output);
    assert.equal(failures.length, 1);
    assert.match(String(failures[0].message), /UNAVAILABLE \(503\): fixture service temporarily unavailable/);
    assert.doesNotMatch(result.output, /finishReason/);
});

test("#6629: a Google error after a proxy tool keeps its cause without replaying visible text", { timeout: 8000 }, async () => {
    const call = { functionCall: { name: "acp_status", args: {} }, thoughtSignature: "signed-call-byte-for-byte" };
    const first = sse({ candidates: [{ content: { role: "model", parts: [call] }, finishReason: "STOP" }] });
    const result = await loop([first, sse(answer("partial answer ")) + sse({ error: quota })], "google-error-after-tool");
    assert.equal(result.requests.length, 2, "visible content must not be replayed");
    assert.match(result.requests[1], /functionResponse/);
    const rebuilt = JSON.parse(result.requests[1]) as { contents: Array<{ parts: unknown[] }> };
    assert.ok(rebuilt.contents.some((content) => content.parts.some((part) => JSON.stringify(part) === JSON.stringify(call))));
    assert.match(result.output, /partial answer /);
    const failures = errors(result.output);
    assert.equal(failures.length, 1);
    assert.match(String(failures[0].message), /RESOURCE_EXHAUSTED \(429\): quota exhausted for fixture-model/);
    assert.doesNotMatch(result.output, /finishReason/);
});

test("#6629: the plugin-owned Google path still forwards the provider error verbatim", async () => {
    const frame = sse({ error: quota });
    const chunks: Buffer[] = [];
    const response = {
        destroyed: false, writableEnded: false,
        write(chunk: Buffer | string) { chunks.push(Buffer.from(chunk)); return true; },
        end() { this.writableEnded = true; return this; },
        once() { return this; },
    };
    await pipePluginChatWithStrip(new Response(frame).body!, response as unknown as http.ServerResponse, "google");
    assert.equal(Buffer.concat(chunks).toString("utf8"), frame);
});
