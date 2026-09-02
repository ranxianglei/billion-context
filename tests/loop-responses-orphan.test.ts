import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #440: responses adapter must not emit response.failed with no preceding
// response.created (orphan stream crashes codex; same class as #413).

const BODY = { model: "gpt-5", input: [], stream: true };

function sse(event: string, obj: Record<string, unknown>): string {
    return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...obj })}\n\n`;
}

function makeCtx(id: string) {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: {
            id,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        } as unknown as Session,
        log: () => {},
        protocol: "responses" as const,
    };
}

async function drain(stream: ReadableStream<Uint8Array>, ctx: ReturnType<typeof makeCtx>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(
        stream,
        ctx,
        BODY,
        { url: "http://mock", headers: {} },
        createResponsesAdapter(),
        buildCompressSystemPrompt(),
    )) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

interface OutEvent { event: string; data: Record<string, unknown> }

function parseOut(out: string): OutEvent[] {
    const events: OutEvent[] = [];
    for (const block of out.split("\n\n")) {
        let event = "";
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (!event || dataLines.length === 0) continue;
        try {
            events.push({ event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> });
        } catch { }
    }
    return events;
}

function assertCreatedBeforeFailed(events: OutEvent[]): void {
    const failedIdx = events.findIndex((e) => e.event === "response.failed");
    assert.ok(failedIdx >= 0, "stream has a response.failed");
    const createdIdx = events.findIndex((e) => e.event === "response.created");
    assert.ok(createdIdx >= 0, "stream has a response.created");
    assert.ok(createdIdx < failedIdx, `response.created (idx ${createdIdx}) precedes response.failed (idx ${failedIdx})`);
}

function mockFetch(handler: () => Response): { calls: () => number; restore: () => void } {
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        n++;
        return handler();
    }) as typeof fetch;
    return { calls: () => n, restore: () => { globalThis.fetch = orig; } };
}

test("#440 T1: 0-event EOF → first event is response.created, failed preceded by created", async () => {
    process.env.BILI_REPLAY_RETRY_MAX = "1";
    const ctx = makeCtx("resp-orphan-t1");
    const mock = mockFetch(() => new Response('{"error":"boom"}', { status: 500, headers: { "content-type": "application/json" } }));
    try {
        const out = await drain(new Response("", { status: 200 }).body!, ctx);
        assert.equal(mock.calls(), 1, "zero-side-effect truncation retried exactly once (responses adapter too)");
        const events = parseOut(out);
        assert.ok(events.length > 0, "stream non-empty");
        assert.equal(events[0].event, "response.created", `first event must be response.created (got ${events[0].event})`);
        assertCreatedBeforeFailed(events);
    } finally {
        mock.restore();
        delete process.env.BILI_REPLAY_RETRY_MAX;
    }
});

test("#440 T2: truncation after created forwarded → single created, failed references same id, no retry", async () => {
    const round1 = sse("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } });
    const ctx = makeCtx("resp-orphan-t2");
    const mock = mockFetch(() => new Response("{}", { status: 200 }));
    try {
        const out = await drain(new Response(round1, { status: 200 }).body!, ctx);
        assert.equal(mock.calls(), 0, "no retry: created already reached the client");
        const events = parseOut(out);
    const created = events.filter((e) => e.event === "response.created");
    assert.equal(created.length, 1, `exactly one response.created (no synthetic duplicate); got ${created.length}`);
    assertCreatedBeforeFailed(events);
    const failed = events.find((e) => e.event === "response.failed")!;
    const failedId = (failed.data.response as Record<string, unknown>)?.id;
    assert.equal(failedId, "resp_1", "failed references the forwarded created's id");
    } finally {
        mock.restore();
    }
});

test("#440 T4: 0-event EOF → retry succeeds → clean completion, no failed event", async () => {
    const created = sse("response.created", { response: { id: "resp_retry", status: "in_progress", output: [] } });
    const item = sse("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } });
    const textDelta = sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "RETRY OK" });
    const textDone = sse("response.output_text.done", { item_id: "msg_1", output_index: 0, content_index: 0, text: "RETRY OK" });
    const itemDone = sse("response.output_item.done", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "RETRY OK", annotations: [] }] } });
    const completed = sse("response.completed", { response: { id: "resp_retry", status: "completed", output: [] } });
    const mock = mockFetch(() => new Response(created + item + textDelta + textDone + itemDone + completed, { status: 200 }));
    const ctx = makeCtx("resp-orphan-t4");
    try {
        const out = await drain(new Response("", { status: 200 }).body!, ctx);
        assert.equal(mock.calls(), 1, "retried once");
        assert.ok(out.includes("RETRY OK"), "retried round's content delivered");
        assert.ok(!out.includes("response.failed"), "no failed event on successful retry");
    } finally {
        mock.restore();
    }
});

test("#440 T3: emitError with no created forwarded → synthesizes created before failed", () => {
    const adapter = createResponsesAdapter();
    const out = adapter.emitError("upstream stream truncated").toString("utf8");
    const events = parseOut(out);
    assert.equal(events[0].event, "response.created", "emitError leads with a synthesized response.created");
    assertCreatedBeforeFailed(events);
    const createdId = (events[0].data.response as Record<string, unknown>)?.id;
    const failedId = (events.find((e) => e.event === "response.failed")!.data.response as Record<string, unknown>)?.id;
    assert.equal(createdId, failedId, "synthesized created and failed share an id");
});
