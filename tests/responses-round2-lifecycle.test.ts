import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

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

test("responses wire round-2: lifecycle references stay valid and remapped ids fit the API limit (codex #212, #242)", async () => {
    const upstreamRound2Id = "msg_083f5e89ab47276e016a8d80c2a5c4819780d41a8c32999fc8";
    assert.equal(upstreamRound2Id.length, 54, "fixture matches the length of a real Codex message id");
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "acp_status", arguments: "" } }),
        sse("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 0, delta: "{}" }),
        sse("response.function_call_arguments.done", { item_id: "fc_1", output_index: 0, arguments: "{}" }),
        sse("response.output_item.done", { output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "acp_status", arguments: "{}" } }),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ].join("");

    const round2 = [
        sse("response.created", { response: { id: "resp_2", status: "in_progress" } }),
        sse("response.output_item.added", { output_index: 0, item: { type: "message", id: upstreamRound2Id, role: "assistant", content: [] } }),
        sse("response.content_part.added", { item_id: upstreamRound2Id, output_index: 0, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { item_id: upstreamRound2Id, output_index: 0, delta: "after " }),
        sse("response.output_text.delta", { item_id: upstreamRound2Id, output_index: 0, delta: "compress" }),
        sse("response.output_text.done", { item_id: upstreamRound2Id, output_index: 0, text: "after compress" }),
        sse("response.content_part.done", { item_id: upstreamRound2Id, output_index: 0, part: { type: "output_text", text: "after compress" } }),
        sse("response.output_item.done", { output_index: 0, item: { type: "message", id: upstreamRound2Id, role: "assistant", content: [{ type: "output_text", text: "after compress" }] } }),
        sse("response.completed", { response: { id: "resp_2", status: "completed", output: [] } }),
    ].join("");

    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(round2, { status: 200 });
    }) as typeof fetch;

    const chunks: Buffer[] = [];
    try {
        const ctx = makeCtx("resp-round2");
        for await (const chunk of runCompressLoop(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-5", input: [], stream: true },
            { url: "http://mock", headers: {} },
            createResponsesAdapter(),
            buildCompressSystemPrompt(),
        )) {
            chunks.push(chunk);
        }
    } finally {
        globalThis.fetch = orig;
    }
    assert.equal(fetchCalls, 1, "re-request after proxy tool");
    const out = Buffer.concat(chunks).toString("utf8");
    const events = parseOut(out);

    const deltas = events.filter((e) => e.event === "response.output_text.delta");
    assert.ok(deltas.length >= 3, "text streamed (marker + round-2 text)");
    const addedIds = new Set(
        events
            .filter((e) => e.event === "response.output_item.added")
            .map((e) => (e.data.item as Record<string, unknown> | undefined)?.id),
    );
    const orphans = deltas.filter((e) => !addedIds.has(e.data.item_id));
    assert.equal(
        orphans.length,
        0,
        `every output_text.delta.item_id must have been introduced by a forwarded output_item.added first; orphan deltas: ${JSON.stringify(orphans.map((e) => e.data.item_id))} (codex logs "OutputTextDelta without active item" for each)`,
    );

    const round2Item = events.find(
        (e) => e.event === "response.output_item.added" && typeof e.data.item?.id === "string" && String(e.data.item.id).startsWith("msg-proxy-2-"),
    );
    assert.ok(round2Item, "round-2 message item forwarded with remapped id (native streaming, not buffered)");
    const round2Id = String((round2Item.data.item as Record<string, unknown>).id);
    assert.ok(round2Id.length <= 64, `remapped message id must fit the Responses API's 64-character limit; got ${round2Id.length}`);
    const round2Deltas = deltas.filter((e) => e.data.item_id === round2Id);
    assert.equal(round2Deltas.map((e) => e.data.delta).join(""), "after compress", "round-2 text content streamed in order");
    assert.ok(
        events.some((e) => e.event === "response.output_item.done" && (e.data.item as Record<string, unknown>)?.id === round2Id),
        "round-2 message item closed with output_item.done",
    );
});
