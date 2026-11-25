import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";
import { createAnthropicAdapter } from "../src/loop/adapter-anthropic.ts";
import type { ParsedStreamEvent } from "../src/loop/core.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startServer } from "../src/server.ts";
import { sseEventData } from "../src/sse-util.ts";

const citations: Array<Record<string, unknown>> = [
    { type: "char_location", cited_text: "source quote", document_index: 0, document_title: "Source", start_char_index: 0, end_char_index: 12 },
    { type: "page_location", cited_text: "source quote", document_index: 1, document_title: "PDF", start_page_number: 2, end_page_number: 3 },
    { type: "content_block_location", cited_text: "source quote", document_index: 2, document_title: "Blocks", start_block_index: 1, end_block_index: 2 },
    { type: "web_search_result_location", cited_text: "source quote", encrypted_index: "opaque-reference", title: "Web", url: "https://example.test/source" },
    { type: "search_result_location", cited_text: "source quote", search_result_index: 1, start_block_index: 0, end_block_index: 1, title: "Search", source: "https://example.test/result" },
];

function wire(events: Array<Record<string, unknown>>): string {
    return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function start(id: string): Record<string, unknown> {
    return { type: "message_start", message: { id, type: "message", role: "assistant", content: [], model: "claude-test", usage: { input_tokens: 10, output_tokens: 0 } } };
}

function finish(stopReason = "end_turn"): Array<Record<string, unknown>> {
    return [
        { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 8 } },
        { type: "message_stop" },
    ];
}

function textBlock(index: number, citation: Record<string, unknown>): Array<Record<string, unknown>> {
    return [
        { type: "content_block_start", index, content_block: { type: "text", text: "", citations: [] } },
        { type: "content_block_delta", index, delta: { type: "text_delta", text: "According to the source." } },
        { type: "content_block_delta", index, delta: { type: "citations_delta", citation } },
        { type: "content_block_stop", index },
    ];
}

const serverArguments = '{"query":"星云 sources"}';
function serverToolBlocks(): Array<Record<string, unknown>> {
    return [
        { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_search", name: "web_search", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: serverArguments.slice(0, 13) } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: serverArguments.slice(13) } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_search", content: [] } },
        { type: "content_block_stop", index: 1 },
    ];
}

function chunked(text: string, size = 7): ReadableStream<Uint8Array> {
    const bytes = Buffer.from(text);
    let offset = 0;
    return new ReadableStream({ pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset = Math.min(offset + size, bytes.length);
    } });
}

async function parse(adapter: ReturnType<typeof createAnthropicAdapter>, events: Array<Record<string, unknown>>, round: number): Promise<ParsedStreamEvent[]> {
    const result: ParsedStreamEvent[] = [];
    for await (const event of adapter.parseStream(chunked(wire(events)), round)) result.push(event);
    return result;
}

interface Frame {
    type: string;
    index?: number;
    content_block?: { type: string; id?: string; tool_use_id?: string };
    delta?: { type?: string; citation?: Record<string, unknown>; partial_json?: string; stop_reason?: string };
}

function frames(events: ParsedStreamEvent[]): Frame[] {
    return events.flatMap(event => {
        const raw = "raw" in event && event.raw ? event.raw : event.kind === "meta" ? event.chunk : undefined;
        return raw ? raw.toString().split("\n\n").flatMap(frame => {
            const data = sseEventData(frame);
            return data ? [JSON.parse(data) as Frame] : [];
        }) : [];
    });
}

for (const round of [1, 2]) {
    for (const citation of citations) {
        test(`Anthropic ${String(citation.type)} citation survives round ${round}`, async () => {
            const adapter = createAnthropicAdapter({ model: "claude-test" });
            const parsed = await parse(adapter, [start(`msg_${round}`), ...textBlock(0, citation), ...finish()], round);
            const forwarded = frames(parsed);
            const deltas = forwarded.filter(frame => frame.delta?.type === "citations_delta");
            assert.equal(deltas.length, 1);
            assert.deepEqual(deltas[0], { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation } });
            assert.deepEqual(parsed.filter(event => event.kind === "text").map(event => event.delta), ["According to the source."]);
            const metadata = parsed.filter(event => event.kind === "meta" && event.chunk.toString().includes('"citations_delta"'));
            assert.equal(metadata.length, 1);
            assert.equal(metadata[0].kind === "meta" && metadata[0].firstRoundOnly, round === 1);
        });
    }
}

for (const round of [1, 2]) {
    test(`provider-owned tool arguments survive round ${round} without becoming client tool calls`, async () => {
        const parsed = await parse(createAnthropicAdapter({ model: "claude-test" }),
            [start(`msg_server_${round}`), ...serverToolBlocks(), ...finish()], round);
        const forwarded = frames(parsed);
        const deltas = forwarded.filter(frame => frame.delta?.type === "input_json_delta");
        assert.equal(deltas.length, 2);
        assert.equal(deltas.map(frame => frame.delta!.partial_json).join(""), serverArguments);
        assert.ok(deltas.every(frame => frame.index === 0));
        assert.equal(parsed.filter(event => event.kind === "tool_call").length, 0);
        assert.equal(forwarded.find(frame => frame.content_block?.type === "web_search_tool_result")?.content_block?.tool_use_id, "srvtoolu_search");
    });
}

test("later-round citations and server arguments use the client's existing block index space", async () => {
    const adapter = createAnthropicAdapter({ model: "claude-test" });
    const all: ParsedStreamEvent[] = [];
    all.push(...await parse(adapter, [start("msg_first"), ...textBlock(0, citations[0]), ...finish()], 1));
    for (const round of [2, 3]) {
        const parsed = await parse(adapter, [start(`msg_${round}`), ...serverToolBlocks(), ...textBlock(2, citations[3]), ...finish()], round);
        const forwarded = frames(parsed);
        const serverIndex = forwarded.find(frame => frame.content_block?.type === "server_tool_use")?.index;
        const textIndex = forwarded.find(frame => frame.content_block?.type === "text")?.index;
        assert.equal(serverIndex, 1 + (round - 2) * 3);
        assert.equal(textIndex, 3 + (round - 2) * 3);
        assert.deepEqual(forwarded.filter(frame => frame.delta?.type === "input_json_delta").map(frame => frame.index), [serverIndex, serverIndex]);
        assert.deepEqual(forwarded.filter(frame => frame.delta?.type === "citations_delta").map(frame => frame.index), [textIndex]);
        all.push(...parsed);
    }
    assert.equal(frames(all).filter(frame => frame.type === "message_start").length, 1);
});

test("opaque block deltas keep their payload in the same forwarding path as round one", async () => {
    const delta = { type: "provider_extension_delta", payload: { nested: ["original", 7, false] } };
    for (const round of [1, 2]) {
        const parsed = await parse(createAnthropicAdapter({}), [start("msg_extension"),
            { type: "content_block_start", index: 0, content_block: { type: "provider_extension", payload: {} } },
            { type: "content_block_delta", index: 0, delta },
            { type: "content_block_stop", index: 0 }, ...finish()], round);
        assert.deepEqual(frames(parsed).find(frame => frame.delta?.type === delta.type), { type: "content_block_delta", index: 0, delta });
    }
});

test("an opaque delta cannot expose a later-round thinking block whose start is still held", async () => {
    const adapter = createAnthropicAdapter({});
    await parse(adapter, [start("msg_first"), ...textBlock(0, citations[0]), ...finish()], 1);
    const parsed = await parse(adapter, [start("msg_hidden"),
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "provider_extension_delta", payload: "private-pending-thinking" } },
        { type: "content_block_stop", index: 0 }, ...finish()], 2);
    assert.ok(!frames(parsed).some(frame => frame.type.startsWith("content_block_")));
});

test("later-round deltas without a released block start do not create orphan frames", async () => {
    for (const round of [1, 2]) {
        const parsed = await parse(createAnthropicAdapter({}), [start("msg_missing_start"),
            { type: "content_block_delta", index: 7, delta: { type: "citations_delta", citation: citations[0] } },
            ...finish()], round);
        assert.equal(frames(parsed).filter(frame => frame.delta?.type === "citations_delta").length, round === 1 ? 1 : 0);
    }
});

test("proxy-owned tool input still goes only to the dedicated tool-call accumulator", async () => {
    const parsed = await parse(createAnthropicAdapter({}), [start("msg_proxy"),
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "status_call", name: "acp_status", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "content_block_stop", index: 0 }, ...finish("tool_use")], 2);
    const calls = parsed.filter(event => event.kind === "tool_call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind === "tool_call" && calls[0].arguments, "{}");
    assert.equal(frames(parsed).filter(frame => frame.delta?.type === "input_json_delta").length, 0);
});

test("actual HTTP tool continuation preserves citations and provider-owned tool input", { timeout: 15000 }, async () => {
    const requests: Array<Record<string, unknown>> = [];
    const initial = [start("msg_status"),
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "status_call", name: "acp_status", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "content_block_stop", index: 0 }, ...finish("tool_use")];
    const continuation = [start("msg_answer"), ...serverToolBlocks(), ...textBlock(2, citations[0]), ...finish()];
    const upstream = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(wire(requests.length === 1 ? initial : continuation));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts: ProxyOptions = {
        port: 0, host: "127.0.0.1", upstream: `http://127.0.0.1:${upstreamAddress.port}`,
        routes: {}, proxy: "", proxyMode: "direct", proxySource: "direct", modelContextLimit: 200000,
        kernelConfig: defaultConfig(200000), compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false,
        passthrough: false, chainContentDetection: false, autoUpdate: false, mitm: { enabled: false, domains: [] },
    };
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer(opts);
        if (!proxy.listening) await once(proxy, "listening");
        const address = proxy.address();
        assert.ok(address && typeof address !== "string");
        const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
            method: "POST", headers: { "content-type": "application/json", "x-acp-session": "anthropic-continuation-deltas" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true,
                tools: [{ type: "web_search_20250305", name: "web_search" }],
                messages: [
                    { role: "user", content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "source quote" }, title: "Source", citations: { enabled: true } }, { type: "text", text: "Review this source." }] },
                    { role: "assistant", content: "I have read the source." },
                    { role: "user", content: "Give a sourced answer." },
                ],
            }),
        });
        assert.equal(response.status, 200);
        const raw = await response.text();
        const forwarded = raw.split("\n\n").map(sseEventData).filter((value): value is string => value !== null).map(value => JSON.parse(value) as Frame);
        assert.equal(requests.length, 2);
        assert.ok(JSON.stringify(requests[0].tools).includes('"acp_status"'));
        assert.ok(JSON.stringify(requests[1]).includes('"tool_use_id":"status_call"'));
        assert.ok(raw.includes("According to the source."));
        const serverIndex = forwarded.find(frame => frame.content_block?.type === "server_tool_use")?.index;
        const deltas = forwarded.filter(frame => frame.delta?.type === "input_json_delta");
        assert.equal(deltas.map(frame => frame.delta!.partial_json).join(""), serverArguments);
        assert.ok(deltas.every(frame => frame.index === serverIndex));
        const cited = forwarded.filter(frame => frame.delta?.type === "citations_delta");
        assert.equal(cited.length, 1);
        assert.deepEqual(cited[0].delta?.citation, citations[0]);
        assert.ok(forwarded.some(frame => frame.type === "content_block_start" && frame.content_block?.type === "text" && frame.index === cited[0].index));
        assert.ok(forwarded.some(frame => frame.delta?.stop_reason === "end_turn"));
        assert.equal(forwarded.filter(frame => frame.type === "message_start").length, 1);
    } finally {
        for (const server of [proxy, upstream]) if (server) {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    }
});
