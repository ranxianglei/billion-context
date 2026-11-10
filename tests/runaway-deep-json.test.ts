import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapStreamWithRunawayGuard, type RunawayVerdict } from "../src/runaway-guard.ts";

const encoder = new TextEncoder();
const nested = (value: string) => '{"nested":'.repeat(20_000) + value + "}".repeat(20_000);

async function inspect(json: string) {
    const input = `data: ${json}\n\n`;
    const verdicts: RunawayVerdict[] = [];
    const chunks: Uint8Array[] = [];
    const source = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(input));
            controller.close();
        },
    });
    for await (const chunk of wrapStreamWithRunawayGuard(source, (v) => verdicts.push(v))) chunks.push(chunk);
    return { input, verdicts, output: Buffer.concat(chunks).toString("utf8") };
}

test("deep non-runaway JSON is forwarded without exhausting the call stack", async () => {
    const result = await inspect(nested('{"content":"normal text"}'));
    assert.deepEqual(result.verdicts, []);
    assert.equal(result.output, result.input);
});

test("deep model text still triggers the text-run guard", async () => {
    const result = await inspect(nested(JSON.stringify({ content: "=".repeat(200) })));
    assert.equal(result.verdicts.length, 1);
    assert.equal(result.verdicts[0].reason, "text-run");
    assert.equal(result.output, "");
});

test("deep tool-argument objects are skipped without traversing their text leaves", async () => {
    const result = await inspect(`{"tool_calls":[${nested(JSON.stringify({ content: "=".repeat(200) }))}]}`);
    assert.deepEqual(result.verdicts, []);
    assert.equal(result.output, result.input);
});

test("iterative traversal preserves text order across nested arrays and objects", async () => {
    const result = await inspect(JSON.stringify({
        choices: [{ delta: { content: ["=".repeat(100), { text: "reset" }, "=".repeat(100)] } }],
        text: "=".repeat(100),
    }));
    assert.equal(result.verdicts.length, 1);
    assert.equal(result.verdicts[0].reason, "text-run");
});
