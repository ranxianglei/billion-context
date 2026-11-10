import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapStreamWithRunawayGuard, type RunawayVerdict } from "../src/runaway-guard.ts";

const encoder = new TextEncoder();
const delta = (content: string) => JSON.stringify({ choices: [{ delta: { content } }] });
const frame = (content: string, eol = "\n") => `data: ${delta(content)}${eol}${eol}`;

async function inspect(parts: string[]) {
    const verdicts: RunawayVerdict[] = [];
    const chunks: Uint8Array[] = [];
    const source = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const part of parts) controller.enqueue(encoder.encode(part));
            controller.close();
        },
    });
    for await (const chunk of wrapStreamWithRunawayGuard(source, (v) => verdicts.push(v))) chunks.push(chunk);
    return { verdicts, output: Buffer.concat(chunks).toString("utf8") };
}

for (const eol of ["\n", "\r\n"]) {
    test(`runaway guard inspects every SSE frame in one chunk (${JSON.stringify(eol)})`, async () => {
        const result = await inspect([frame("=".repeat(100), eol) + frame("=".repeat(100), eol)]);
        assert.equal(result.verdicts.length, 1);
        assert.equal(result.verdicts[0].reason, "text-run");
        assert.equal(result.output, "");
    });

    test(`batched SSE preserves a reset between separate near-threshold runs (${JSON.stringify(eol)})`, async () => {
        const body = frame("=".repeat(199), eol) + frame("different", eol) + frame("=".repeat(199), eol);
        const result = await inspect([body]);
        assert.deepEqual(result.verdicts, []);
        assert.equal(result.output, body);
    });
}

test("NDJSON fallback preserves a partial last event until its next chunk", async () => {
    const prefix = `${delta("ab".repeat(33_000))}\n`;
    const run = `${delta("=".repeat(200))}\n`;
    const tail = `${delta("finished")}\n`;
    const result = await inspect([prefix + run.slice(0, 60), run.slice(60) + tail]);
    assert.equal(result.verdicts.length, 1);
    assert.equal(result.verdicts[0].reason, "text-run");
    assert.equal(result.output, prefix + run.slice(0, 60));
});

test("a large SSE event split before its final newline stays in SSE mode", async () => {
    const body = frame("ab".repeat(33_000));
    const result = await inspect([body.slice(0, -1), body.slice(-1) + frame("=".repeat(200))]);
    assert.equal(result.verdicts.length, 1);
    assert.equal(result.verdicts[0].reason, "text-run");
});

test("batched SSE keeps tool arguments out of the text-run counter", async () => {
    const args = JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: delta("=".repeat(200)) } }] } }] });
    const body = frame("normal reply") + `data: ${args}\n\n` + frame(" done");
    const result = await inspect([body]);
    assert.deepEqual(result.verdicts, []);
    assert.equal(result.output, body);
});
