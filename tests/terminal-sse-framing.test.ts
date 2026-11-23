import assert from "node:assert/strict";
import { test } from "node:test";
import { observeResponsesTerminalState } from "../src/stream-terminal.ts";

function stream(parts: string[]) {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const part of parts) controller.enqueue(encoder.encode(part));
            controller.close();
        },
    });
}

for (const tail of [
    "event: response.completed\n",
    'event: response.completed\ndata: {"type":',
    'data: {"type":"response.completed"}\n',
    "event: response.completed\n\n",
    "event: response.completed\ndata: {broken}\n\n",
]) {
    test(`an undispatched or invalid terminal SSE event is not completed: ${JSON.stringify(tail)}`, async () => {
        assert.equal(await observeResponsesTerminalState(stream([tail]), true), "unknown");
    });
}

for (const eol of ["\n", "\r\n", "\r"]) {
    test(`multiline data with ${JSON.stringify(eol)} separators is assembled before classification`, async () => {
        const input = ['data: {"type":', 'data: "response.completed"}', "", ""].join(eol);
        assert.equal(await observeResponsesTerminalState(stream([...input]), true), "completed");
    });
}

test("a terminal header cannot override a failure in its data", async () => {
    const input = 'event: response.completed\ndata: {"type":"response.failed"}\n\n';
    assert.equal(await observeResponsesTerminalState(stream([input]), true), "failed");
});
