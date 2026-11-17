import assert from "node:assert/strict";
import { test } from "node:test";
import { observeResponsesTerminalState } from "../src/stream-terminal.ts";

function chunked(text: string, size: number): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset === bytes.length) return controller.close();
            controller.enqueue(bytes.subarray(offset, offset + size));
            offset = Math.min(bytes.length, offset + size);
        },
    });
}

for (const eol of ["\n", "\r\n", "\r"]) {
    test(`large native compaction terminal frames keep ${JSON.stringify(eol)} boundaries`, async () => {
        const payload = JSON.stringify({ type: "response.completed", response: {
            output: [{ type: "compaction", encrypted_content: "x".repeat(2 * 1024 * 1024) }],
        } });
        const wire = ["event: response.created", 'data: {"type":"response.created"}', "",
            "event: response.completed", `data: ${payload}`, "", ""].join(eol);
        assert.equal(await observeResponsesTerminalState(chunked(wire, 8191), true), "completed");
    });
}

test("a long invalid frame cannot consume the following terminal frame", async () => {
    const wire = `data: ${"x".repeat(2 * 1024 * 1024)}\r\n\r\n`
        + 'data: {"type":"response.failed"}\r\n\r\n';
    assert.equal(await observeResponsesTerminalState(chunked(wire, 8191), true), "failed");
});

test("chunked Unicode and multiline JSON retain the first terminal verdict", async () => {
    const wire = ['\ufeffevent: response.completed', 'data: {"text":"你好🙂",',
        'data: "type":"response.failed"}', "", 'data: {"type":"response.completed"}', "", ""].join("\r\n");
    assert.equal(await observeResponsesTerminalState(chunked(wire, 1), true), "failed");
});

test("an unterminated large terminal event stays unknown", async () => {
    const wire = `data: ${JSON.stringify({ type: "response.completed", text: "x".repeat(2 * 1024 * 1024) })}\n`;
    assert.equal(await observeResponsesTerminalState(chunked(wire, 8191), true), "unknown");
});
