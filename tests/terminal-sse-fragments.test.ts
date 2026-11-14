import assert from "node:assert/strict";
import { test } from "node:test";
import { observeResponsesTerminalState } from "../src/stream-terminal.ts";

function stream(bytes: Uint8Array, chunkBytes: number) {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset === bytes.length) {
                controller.close();
                return;
            }
            const end = Math.min(offset + chunkBytes, bytes.length);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
        },
    });
}

for (const separator of ["\n\n", "\n\r", "\r\n\n", "\r\n\r", "\r\r", "\r\r\n"]) {
    test(`fragmented terminal frames retain mixed line separators ${JSON.stringify(separator)}`, async () => {
        const input = [
            'event: response.completed\r\ndata: {invalid}',
            'data: {"type":"response.created","response":{"label":"雪😀"}}',
            'event: response.completed\r\ndata: {"type":"response.failed"}',
            'data: {"type":"response.completed"}',
            "",
        ].join(separator);
        const bytes = new TextEncoder().encode(input);
        for (const size of [1, 2, 3, 7, 64, bytes.length]) {
            assert.equal(await observeResponsesTerminalState(stream(bytes, size), true), "failed", `chunk size ${size}`);
        }
    });
}

test("large fragmented compaction frames preserve terminal and truncation decisions", async () => {
    const created = `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "x".repeat(2 << 20) } })}\r\n\r\n`;
    const terminal = 'data: {"type":"response.completed"}\r\n';
    const encoder = new TextEncoder();
    for (const [tail, expected] of [[terminal, "unknown"], [terminal + "\r", "completed"]] as const) {
        const bytes = encoder.encode(created + tail);
        assert.equal(await observeResponsesTerminalState(stream(bytes, 4096), true), expected);
    }
});
