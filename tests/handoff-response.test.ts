import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { CoreMessage } from "acp-kernel";
import { createSession, snapshotMessages, type Session } from "../src/session.ts";
import { createHandoffReply } from "../src/server/handoff-response.ts";
import { pipePluginChatWithStrip, pipePluginJson, pipePluginResponsesWithStrip } from "../src/plugin.ts";

type Protocol = "openai" | "anthropic" | "responses" | "google";

async function serve(protocol: string, stream: boolean, chunks: Array<string | Buffer>, opts: { error?: boolean; abort?: boolean; advance?: (session: Session) => void; capture?: boolean } = {}) {
    const session = createSession(`handoff-test-${Math.random()}`);
    session.stats.requests = 1;
    const server = createServer((_req, res) => {
        const reply = opts.capture === false ? undefined : createHandoffReply(session, () => !opts.abort && !res.destroyed);
        const input = new ReadableStream<Uint8Array>({ start(controller) {
            for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
            if (opts.error) controller.enqueue(Buffer.from(event({ type: "error", error: { message: "failed" } })));
            opts.advance?.(session);
            controller.close();
        } });
        const wireProtocol = protocol as Protocol;
        const run = !stream ? pipePluginJson(input, res, undefined, wireProtocol, undefined, undefined, undefined, reply)
            : protocol === "responses" ? pipePluginResponsesWithStrip(input, res, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reply)
                : pipePluginChatWithStrip(input, res, wireProtocol, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reply);
        void run.catch((error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}`);
        return { wire: Buffer.from(await response.arrayBuffer()), session };
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

function event(value: unknown, ending = "\r\n\r\n"): string {
    return `data: ${JSON.stringify(value)}${ending}`;
}

const cases: Array<{ protocol: Protocol; stream: string[]; json: string; args: string }> = [
    {
        protocol: "openai",
        stream: [event({ choices: [{ delta: { content: "hé", tool_calls: [{ index: 0, id: "call_1", function: { name: "look", arguments: "{\"q\":" } }] } }] }), event({ choices: [{ delta: { content: "llo", tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] }, finish_reason: "tool_calls" }] }), "data: [DONE]\r\n\r\n"],
        json: JSON.stringify({ choices: [{ message: { role: "assistant", content: "héllo", tool_calls: [{ id: "call_1", type: "function", function: { name: "look", arguments: "{\"q\":\"x\"}" } }] } }] }),
        args: "{\"q\":\"x\"}",
    },
    {
        protocol: "anthropic",
        stream: [event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "héllo" } }), event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_1", name: "look", input: {} } }), event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"q\":\"x\"}" } }), event({ type: "message_stop" })],
        json: JSON.stringify({ role: "assistant", content: [{ type: "text", text: "héllo" }, { type: "tool_use", id: "tool_1", name: "look", input: { q: "x" } }] }),
        args: "{\"q\":\"x\"}",
    },
    {
        protocol: "responses",
        stream: [event({ type: "response.output_text.delta", delta: "héllo" }), event({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "fc_1", name: "look", arguments: "{\"q\":\"x\"}" } }), event({ type: "response.completed", response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "héllo" }] }, { type: "function_call", call_id: "fc_1", name: "look", arguments: "{\"q\":\"x\"}" }] } })],
        json: JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "héllo" }] }, { type: "function_call", call_id: "fc_1", name: "look", arguments: "{\"q\":\"x\"}" }] }),
        args: "{\"q\":\"x\"}",
    },
    {
        protocol: "google",
        stream: [event({ candidates: [{ content: { role: "model", parts: [{ text: "hé" }] } }] }), event({ candidates: [{ content: { role: "model", parts: [{ text: "llo" }, { functionCall: { name: "look", args: { q: "x" } } }] }, finishReason: "STOP" }] })],
        json: JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "héllo" }, { functionCall: { name: "look", args: { q: "x" } } }] }, finishReason: "STOP" }] }),
        args: "{\"q\":\"x\"}",
    },
];

function captured(session: Session): CoreMessage[] {
    return (session.metadata.handoffResponse as { messages?: CoreMessage[] } | undefined)?.messages ?? [];
}

function assertReply(session: Session, args: string) {
    const messages = captured(session);
    assert.equal(messages.filter((m) => m.contentType === "text").map((m) => m.text).join(""), "héllo");
    const tool = messages.find((m) => m.contentType === "tool-call");
    assert.equal(tool?.toolName, "look");
    assert.equal(tool?.text, args);
}

for (const c of cases) {
    test(`${c.protocol}: captures stream text and tool output through production parser`, async () => {
        const chunks = c.stream.map((part) => Buffer.from(part));
        // Split the multibyte character across writes, while retaining CRLF framing.
        const textFrame = chunks.find((b) => b.includes(Buffer.from("hé")));
        if (textFrame) {
            const at = textFrame.indexOf(Buffer.from("é"));
            if (at >= 0) chunks.splice(chunks.indexOf(textFrame), 1, textFrame.subarray(0, at + 1), textFrame.subarray(at + 1, at + 2), textFrame.subarray(at + 2));
        }
        const { wire, session } = await serve(c.protocol, true, chunks);
        const baseline = await serve(c.protocol, true, chunks, { capture: false });
        assert.deepEqual(wire, baseline.wire);
        assertReply(session, c.args);
    });
    test(`${c.protocol}: captures JSON text and tool output through production codec`, async () => {
        const { wire, session } = await serve(c.protocol, false, [c.json]);
        const baseline = await serve(c.protocol, false, [c.json], { capture: false });
        assert.deepEqual(wire, baseline.wire);
        assertReply(session, c.args);
    });
}

test("Responses retains filtered deltas and reasoning when completion has no output", async () => {
    const chunks = [
        event({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "thinking" }),
        event({ type: "response.output_text.delta", output_index: 1, delta: "\x3cacp tokens=\"2\" type=\"text\"\x3em00001\x3c/acp\x3e" }),
        event({ type: "response.output_text.delta", output_index: 1, delta: "answer" }),
        event({ type: "response.completed", response: { status: "completed", output: [] } }),
    ];
    const result = await serve("responses", true, chunks);
    const baseline = await serve("responses", true, chunks, { capture: false });
    assert.deepEqual(result.wire, baseline.wire);
    assert.deepEqual(captured(result.session).map((m) => [m.contentType, m.text]), [["reasoning", "thinking"], ["text", "answer"]]);
});

test("handoff captures flushed prose tails and preserves thinking bytes", async () => {
    for (const protocol of ["openai", "responses"] as const) {
        const thinking = "think \x3cacp tokens=\"1\"\x3em00002\x3c/acp\x3e";
        const chunks = protocol === "openai" ? [
            event({ choices: [{ delta: { reasoning_content: thinking } }] }),
            event({ choices: [{ delta: { content: "answer <" } }] }),
            event({ choices: [{ delta: {}, finish_reason: "stop" }] }),
            "data: [DONE]\n\n",
        ] : [
            event({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: thinking }),
            event({ type: "response.output_text.delta", output_index: 1, delta: "answer <" }),
            event({ type: "response.completed", response: { output: [] } }),
        ];
        const result = await serve(protocol, true, chunks);
        const baseline = await serve(protocol, true, chunks, { capture: false });
        assert.deepEqual(result.wire, baseline.wire);
        assert.equal(captured(result.session).filter((m) => m.contentType === "text").map((m) => m.text).join(""), "answer <");
        assert.equal(captured(result.session).filter((m) => m.contentType === "reasoning").map((m) => m.text).join(""), thinking);
    }
});

test("Anthropic captures initial text and thinking blocks verbatim", async () => {
    const chunks = [
        event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "think" } }),
        event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "answer" } }),
        event({ type: "message_stop" }),
    ];
    const result = await serve("anthropic", true, chunks);
    const baseline = await serve("anthropic", true, chunks, { capture: false });
    assert.deepEqual(result.wire, baseline.wire);
    assert.deepEqual(captured(result.session).map((m) => [m.contentType, m.text]), [["reasoning", "think"], ["text", "answer"]]);
});

test("does not capture without semantic terminal, on error, abort, unsupported protocol, or oversize body", async () => {
    const incomplete = await serve("openai", true, [event({ choices: [{ delta: { content: "partial" } }] })]);
    assert.equal(incomplete.session.metadata.handoffResponse, undefined);
    const failed = await serve("openai", true, [event({ choices: [{ delta: { content: "x" } }] }), event({ error: { message: "bad" } }), event({ choices: [{ finish_reason: "stop" }] })]);
    assert.equal(failed.session.metadata.handoffResponse, undefined);
    const aborted = await serve("openai", true, [event({ choices: [{ delta: { content: "partial" } }] })], { abort: true });
    assert.equal(aborted.session.metadata.handoffResponse, undefined);
    const unsupported = await serve("unsupported", false, ["{}"]);
    assert.equal(unsupported.session.metadata.handoffResponse, undefined);
    const session = createSession("handoff-cap-test");
    const reply = createHandoffReply(session);
    reply.append("large", "text", "界".repeat(500_001));
    reply.save();
    assert.equal(session.metadata.handoffResponse, undefined);
});

test("Responses incomplete outputs and oversized multibyte replies are omitted without changing bytes", async () => {
    const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] }];
    for (const stream of [true, false]) {
        const body = stream ? event({ type: "response.incomplete", response: { status: "incomplete", output } }) : JSON.stringify({ status: "incomplete", output });
        const { wire, session } = await serve("responses", stream, [body]);
        const baseline = await serve("responses", stream, [body], { capture: false });
        assert.deepEqual(wire, baseline.wire);
        assert.equal(session.metadata.handoffResponse, undefined);
    }
    const session = createSession("handoff-cap-test");
    const reply = createHandoffReply(session);
    reply.append("large", "text", "界".repeat(500_001));
    reply.save();
    assert.equal(session.metadata.handoffResponse, undefined);
});

test("malformed SSE remains byte-identical and does not prevent valid terminal capture", async () => {
    const raw = "data: {broken\r\n\r\ndata: [DONE]\r\n\r\n";
    const { wire, session } = await serve("openai", true, [raw]);
    const baseline = await serve("openai", true, [raw], { capture: false });
    assert.deepEqual(wire, baseline.wire);
    assert.equal(session.metadata.handoffResponse, undefined);
});

test("an older response cannot attach to a newer request snapshot", async () => {
    for (const advance of [
        (session: Session) => { session.stats.requests++; },
        (session: Session) => { snapshotMessages(session, [{ id: "new", role: "user", contentType: "text", text: "new request" }]); },
    ]) {
        const body = event({ choices: [{ delta: { content: "old answer" }, finish_reason: "stop" }] });
        const { wire, session } = await serve("openai", true, [body], { advance });
        const baseline = await serve("openai", true, [body], { capture: false, advance });
        assert.deepEqual(wire, baseline.wire);
        assert.equal(session.metadata.handoffResponse, undefined);
    }
});

test("snapshotMessages clears handoff metadata and does not mutate lastMessages", () => {
    const session: Session = createSession("handoff-snapshot-test");
    const previous: CoreMessage[] = [{ id: "previous", role: "user", contentType: "text", text: "previous" }];
    session.lastMessages = previous;
    session.metadata.handoffResponse = { request: 1, messages: [] };
    const next: CoreMessage[] = [{ id: "next", role: "user", contentType: "text", text: "next" }];
    snapshotMessages(session, next);
    assert.equal(session.metadata.handoffResponse, undefined);
    assert.deepEqual(session.lastMessages, next);
    assert.notEqual(session.lastMessages, previous);
    assert.deepEqual(previous, [{ id: "previous", role: "user", contentType: "text", text: "previous" }]);
});


test("captures ordered interleaved text, reasoning, and multiple tools", () => {
    const session = createSession("handoff-order-test");
    const reply = createHandoffReply(session);
    reply.append("0", "text", "first");
    reply.tool("1", "search", "call_1", "{\"q\":1}");
    reply.append("2", "reasoning", "thinking");
    reply.append("3", "text", "second");
    reply.tool("4", "fetch", "call_2", "{\"url\":\"x\"}");
    reply.save();
    assert.deepEqual(captured(session).map((m) => [m.contentType, m.text, m.toolName, m.toolCallId]), [
        ["text", "first", undefined, undefined],
        ["tool-call", "{\"q\":1}", "search", "call_1"],
        ["reasoning", "thinking", undefined, undefined],
        ["text", "second", undefined, undefined],
        ["tool-call", "{\"url\":\"x\"}", "fetch", "call_2"],
    ]);
});

test("request count, snapshot changes, failed acceptance, and discard prevent stale saves", () => {
    const session = createSession("handoff-stale-test");
    session.stats.requests = 1;
    const changedCount = createHandoffReply(session);
    changedCount.append("0", "text", "old");
    session.stats.requests++;
    changedCount.save();
    assert.equal(session.metadata.handoffResponse, undefined);
    const changedSnapshot = createHandoffReply(session);
    changedSnapshot.append("0", "text", "old");
    snapshotMessages(session, [{ id: "new", role: "user", contentType: "text", text: "new request" }]);
    changedSnapshot.save();
    assert.equal(session.metadata.handoffResponse, undefined);
    const rejected = createHandoffReply(session, () => false);
    rejected.append("0", "text", "unaccepted");
    rejected.save();
    assert.equal(session.metadata.handoffResponse, undefined);
    const discarded = createHandoffReply(session);
    discarded.append("0", "text", "partial");
    discarded.discard();
    discarded.append("1", "text", "later");
    discarded.save();
    assert.equal(session.metadata.handoffResponse, undefined);
});
