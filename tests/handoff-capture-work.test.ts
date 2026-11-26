import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { CoreMessage } from "acp-kernel";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import { createSession, type Session } from "../src/session.ts";
import { createHandoffReply, HANDOFF_REPLY_MAX_BYTES } from "../src/server/handoff-response.ts";

function captured(session: Session): CoreMessage[] {
    return (session.metadata.handoffResponse as { messages?: CoreMessage[] } | undefined)?.messages ?? [];
}

for (const kind of ["text", "reasoning"] as const) {
    test(`handoff ${kind} metering visits appended text once rather than every accumulated prefix`, (t) => {
        const session = createSession(`handoff-work-${kind}`);
        const reply = createHandoffReply(session);
        const delta = "界😀".repeat(8);
        const count = 2400;
        const byteLength = Buffer.byteLength;
        let measuredChars = 0;
        t.mock.method(Buffer, "byteLength", (...args: Parameters<typeof Buffer.byteLength>) => {
            if (typeof args[0] === "string") measuredChars += args[0].length;
            return byteLength(...args);
        });
        for (let i = 0; i < count; i++) reply.append("one", kind, delta);
        reply.save();
        t.mock.restoreAll();
        assert.equal(captured(session)[0]?.text, delta.repeat(count));
        assert.equal(captured(session)[0]?.contentType, kind);
        assert.ok(measuredChars <= delta.length * count * 2, `${measuredChars} characters scanned for ${delta.length * count} input characters`);
    });
}

test("production HTTP streaming capture meters work proportional to received frames", async (t) => {
    const delta = "界😀".repeat(8);
    const count = 1000;
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
    const ending = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const chunks = Array.from({ length: count }, () => Buffer.from(frame));
    chunks.push(Buffer.from(ending));
    const session = createSession("handoff-http-work");
    let record = true;
    const server = createServer((_req, res) => {
        const source = new ReadableStream<Uint8Array>({ start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        } });
        const reply = record ? createHandoffReply(session) : undefined;
        void pipePluginChatWithStrip(source, res, "openai", undefined, undefined, undefined, undefined, undefined, undefined, undefined, reply)
            .catch((error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const byteLength = Buffer.byteLength;
    let measuredChars = 0;
    try {
        t.mock.method(Buffer, "byteLength", (...args: Parameters<typeof Buffer.byteLength>) => {
            if (typeof args[0] === "string") measuredChars += args[0].length;
            return byteLength(...args);
        });
        const response = await fetch(`http://127.0.0.1:${address.port}`);
        const wire = Buffer.from(await response.arrayBuffer());
        t.mock.restoreAll();
        assert.equal(captured(session)[0]?.text, delta.repeat(count));
        record = false;
        const baseline = await fetch(`http://127.0.0.1:${address.port}`);
        assert.deepEqual(wire, Buffer.from(await baseline.arrayBuffer()), "recording leaves forwarded bytes unchanged");
        const inputChars = count * frame.length + ending.length;
        assert.ok(measuredChars <= inputChars * 10, `${measuredChars} characters scanned for ${inputChars} wire characters`);
    } finally {
        t.mock.restoreAll();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

const TEXT_BUDGET = HANDOFF_REPLY_MAX_BYTES - 128;

for (const [name, parts] of [
    ["split surrogate pair", ["x".repeat(TEXT_BUDGET - 4) + "\ud83d", "\ude00"]],
    ["lone high surrogate", ["x".repeat(TEXT_BUDGET - 4), "\ud83d", "x"]],
    ["lone low surrogate", ["x".repeat(TEXT_BUDGET - 4), "\ude00", "x"]],
    ["complete emoji", ["x".repeat(TEXT_BUDGET - 4), "😀"]],
    ["BMP multibyte", ["x".repeat(TEXT_BUDGET - 3), "界"]],
] as const) {
    test(`keeps the exact UTF-8 budget at ${name}`, () => {
        const session = createSession(`handoff-budget-${name}`);
        const reply = createHandoffReply(session);
        for (const part of parts) reply.append("one", "text", part);
        reply.save();
        assert.equal(Buffer.byteLength(parts.join("")), TEXT_BUDGET);
        assert.equal(captured(session)[0]?.text, parts.join(""));
        delete session.metadata.handoffResponse;
        reply.append("one", "text", "a");
        reply.save();
        assert.equal(session.metadata.handoffResponse, undefined, "one byte over the cap still discards the entire capture");
    });
}

test("meters independent entries against the shared reply budget", () => {
    const session = createSession("handoff-shared-budget");
    const reply = createHandoffReply(session);
    reply.append("thinking", "reasoning", "思考");
    reply.append("answer", "text", "a".repeat(HANDOFF_REPLY_MAX_BYTES - 256 - Buffer.byteLength("思考")));
    reply.save();
    assert.equal(captured(session).length, 2);
    delete session.metadata.handoffResponse;
    reply.append("thinking", "reasoning", "!");
    reply.save();
    assert.equal(session.metadata.handoffResponse, undefined);
});

test("tool replacement releases its previous budget before a new entry is appended", () => {
    const session = createSession("handoff-tool-replacement");
    const reply = createHandoffReply(session);
    reply.tool("tool", "look", "call", "a".repeat(TEXT_BUDGET - 8));
    reply.tool("tool", "x", "y", "{}");
    reply.append("answer", "text", "a".repeat(HANDOFF_REPLY_MAX_BYTES - 256 - 4));
    reply.save();
    assert.equal(captured(session).length, 2);
    assert.equal(captured(session)[0]?.text, "{}");
    assert.equal(captured(session)[0]?.toolName, "x");
});

test("appending to a replaced tool entry counts text but drops its former tool fields", () => {
    const session = createSession("handoff-tool-to-text");
    const reply = createHandoffReply(session);
    reply.tool("one", "long-tool-name", "long-call-id", "界");
    reply.append("one", "reasoning", "a".repeat(TEXT_BUDGET - 3));
    reply.save();
    assert.equal(captured(session)[0]?.contentType, "reasoning");
    assert.equal(captured(session)[0]?.toolName, undefined);
    assert.equal(captured(session)[0]?.toolCallId, undefined);
    assert.equal(Buffer.byteLength(captured(session)[0]?.text ?? ""), TEXT_BUDGET);
});

test("whole-response replacement resets entry budgets and supports later appends", () => {
    const session = createSession("handoff-replace-budget");
    const reply = createHandoffReply(session);
    reply.append("old", "text", "a".repeat(TEXT_BUDGET));
    reply.replace([{ id: "replacement", role: "assistant", contentType: "text", text: "\ud83d" }]);
    reply.append("0", "text", "\ude00");
    reply.append("0", "text", "a".repeat(TEXT_BUDGET - 4));
    reply.save();
    assert.equal(captured(session).length, 1);
    assert.equal(captured(session)[0]?.text, "😀" + "a".repeat(TEXT_BUDGET - 4));
});

test("a saved response remains immutable when the same capture accepts another delta", () => {
    const session = createSession("handoff-save-boundary");
    const reply = createHandoffReply(session);
    reply.append("one", "text", "before");
    reply.save();
    const before = captured(session);
    reply.append("one", "text", " after");
    reply.save();
    assert.equal(before[0]?.text, "before");
    assert.equal(captured(session)[0]?.text, "before after");
});
