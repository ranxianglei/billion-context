import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import type { ParsedStreamEvent } from "../src/loop/core.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { responsesToCore, patchResponsesInput, injectResponsesDeveloperMessage, type ResponseInputItem } from "../src/responses.ts";

function makeCtx(messages: CoreMessage[] = []): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
    proxyUrl?: string;
    textProtocol?: boolean;
    debug?: boolean;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "ns-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: () => {},
    };
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function toStream(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}

const NS_NAME = "agents.spawn_agent";
const NS_ITEM_ID = "fc_ns_1";
const NS_CALL_ID = "call_ns_1";
const NS_ARGS = JSON.stringify({ prompt: "review the auth module" });

function nsFunctionCallStream(): string {
    return [
        sse("response.created", { response: { id: "resp_ns", status: "in_progress", output: [] } }),
        sse("response.output_item.added", {
            output_index: 0,
            item: { type: "function_call", id: NS_ITEM_ID, call_id: NS_CALL_ID, name: NS_NAME, arguments: "" },
        }),
        sse("response.function_call_arguments.delta", { item_id: NS_ITEM_ID, delta: NS_ARGS }),
        sse("response.function_call_arguments.done", { item_id: NS_ITEM_ID, arguments: NS_ARGS }),
        sse("response.output_item.done", {
            output_index: 0,
            item: { type: "function_call", id: NS_ITEM_ID, call_id: NS_CALL_ID, name: NS_NAME, arguments: NS_ARGS },
        }),
        sse("response.completed", {
            response: {
                id: "resp_ns",
                status: "completed",
                output: [{ type: "function_call", id: NS_ITEM_ID, call_id: NS_CALL_ID, name: NS_NAME, arguments: NS_ARGS }],
            },
        }),
    ].join("");
}

const SYS_PROMPT = buildCompressSystemPrompt();

async function drain(stream: ReadableStream<Uint8Array>, ctx: ReturnType<typeof makeCtx>, textProtocol: boolean): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(
        stream,
        ctx,
        { model: "gpt-test", input: [] },
        { url: "http://mock", headers: {} },
        createResponsesAdapter(textProtocol),
        SYS_PROMPT,
    )) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function collectParseEvents(stream: ReadableStream<Uint8Array>, textProtocol: boolean): Promise<ParsedStreamEvent[]> {
    const adapter = createResponsesAdapter(textProtocol);
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, 1)) events.push(ev);
    return events;
}

function metaText(events: ParsedStreamEvent[]): string {
    return events.filter((e) => e.kind === "meta").map((e) => (e as { chunk: Buffer }).chunk.toString("utf8")).join("");
}

test("parseStream: proxy function_call (compress) is intercepted, not passed through", async () => {
    const stream = toStream([
        sse("response.output_item.added", { output_index: 0, item: { type: "function_call", id: "fc_c", call_id: "call_c", name: "compress", arguments: "" } }),
        sse("response.function_call_arguments.delta", { item_id: "fc_c", delta: "{}" }),
        sse("response.output_item.done", { output_index: 0, item: { type: "function_call", id: "fc_c", call_id: "call_c", name: "compress", arguments: "{}" } }),
    ].join(""));
    const events = await collectParseEvents(stream, false);
    const toolCalls = events.filter((e) => e.kind === "tool_call") as { kind: "tool_call"; name: string; passthrough?: boolean }[];
    assert.ok(toolCalls.some((c) => c.name === "compress" && !c.passthrough), "compress yields an intercepted tool_call");
    assert.ok(!metaText(events).includes("\"name\":\"compress\""), "compress added/done events are NOT passed through raw");
});

test("parseStream: non-proxy namespaced function_call is passed through raw with a passthrough signal", async () => {
    const events = await collectParseEvents(toStream(nsFunctionCallStream()), false);
    const metaJoined = metaText(events);
    assert.ok(metaJoined.includes(`"id":"${NS_ITEM_ID}"`), "original item id preserved in raw passthrough");
    assert.ok(metaJoined.includes(`"name":"${NS_NAME}"`), "namespaced name preserved in raw passthrough");
    const passthrough = events.filter((e) => e.kind === "tool_call" && (e as { passthrough?: boolean }).passthrough) as { kind: "tool_call"; name: string }[];
    assert.equal(passthrough.length, 1, "exactly one passthrough tool_call signal");
    assert.equal(passthrough[0].name, NS_NAME, "passthrough signal carries the namespaced name");
});

for (const textProtocol of [false, true]) {
    test(`end-to-end: namespaced function_call survives with ORIGINAL item id — textProtocol=${textProtocol}`, async () => {
        const ctx = makeCtx([{ id: "u1", role: "user", contentType: "text", text: "spawn a sub-agent to review auth" }]);
        const out = await drain(toStream(nsFunctionCallStream()), ctx, textProtocol);
        assert.ok(out.includes(`"name":"${NS_NAME}"`), `namespaced name present in forwarded SSE:\n${out}`);
        assert.ok(out.includes(`"id":"${NS_ITEM_ID}"`), `ORIGINAL item id preserved (raw passthrough):\n${out}`);
        assert.ok(!out.includes("fc-proxy-"), `no reconstructed fc-proxy id (raw passthrough):\n${out}`);
        assert.ok(out.includes(`"call_id":"${NS_CALL_ID}"`), `call_id preserved:\n${out}`);
        assert.ok(out.includes("review the auth module"), `arguments content preserved:\n${out}`);
    });
}

test("namespaced tool declaration survives responsesToCore -> patchResponsesInput -> injectResponsesDeveloperMessage", () => {
    const spawnTool = { type: "function", name: NS_NAME, description: "spawn sub-agent", parameters: { type: "object", properties: {} } };
    const input: ResponseInputItem[] = [{ type: "message", role: "user", content: "spawn a sub-agent to review auth" }];
    const projection = responsesToCore({ model: "gpt-test", input, tools: [spawnTool] });
    const rebuilt = patchResponsesInput(projection, projection.msgs);
    const finalInput = injectResponsesDeveloperMessage(rebuilt, "system-prompt");
    assert.ok(Array.isArray(finalInput), "rebuilt input is an array");
    assert.ok(finalInput.some((i) => (i as { type: string }).type === "message"), "user message survives rebuild");
});
