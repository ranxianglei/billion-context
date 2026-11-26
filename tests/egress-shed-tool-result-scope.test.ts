import assert from "node:assert/strict";
import test from "node:test";
import { READ_ORIGINAL_IMAGE_TOOL_NAME } from "../src/compress-tool.ts";
import { shedWireImages, shedWireImagesToCount } from "../src/egress-shed.ts";

const image = (size: number, fill: number) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.alloc(size, fill).toString("base64") } });
const restored = { type: "tool_result", tool_use_id: "restore", content: [image(3000, 3)] };
const ordinary = { type: "tool_result", tool_use_id: "screen", content: [image(3000, 7)] };
const calls = { role: "assistant", content: [
    { type: "tool_use", id: "restore", name: READ_ORIGINAL_IMAGE_TOOL_NAME, input: { imageRef: "m00123" } },
    { type: "tool_use", id: "screen", name: "screenshot", input: {} },
] };
const tail = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `tail ${i}` }));

for (const reverse of [false, true]) {
    test(`image count exempts only the matching tool result (${reverse ? "last" : "first"} restored output)`, async () => {
        const content = reverse ? [ordinary, restored] : [restored, ordinary];
        const body = JSON.stringify({ messages: [calls, { role: "user", content }] });
        const out = await shedWireImagesToCount(body, "anthropic", 0);
        const next = JSON.parse(out.body).messages[1].content;
        assert.equal(out.stats.archived, 1);
        assert.deepEqual(next[reverse ? 1 : 0], restored);
        assert.match(next[reverse ? 0 : 1].content[0].text, /omitted for size limit/);
        assert.equal(JSON.stringify({ messages: [calls, { role: "user", content }] }), body);
    });
}

test("byte shedding can archive a large sibling output beside a restored original", async () => {
    const body = JSON.stringify({ messages: [calls, { role: "user", content: [restored, ordinary] }, ...tail] });
    const out = await shedWireImages(body, "anthropic", 6000);
    const content = JSON.parse(out.body).messages[1].content;
    assert.equal(out.stats.archived, 1);
    assert.ok(out.stats.finalBytes <= 6000);
    assert.deepEqual(content[0], restored);
    assert.match(content[1].content[0].text, /omitted for size limit/);
});

test("ordinary top-level images stay eligible beside an exempt tool result", async () => {
    const body = JSON.stringify({ messages: [calls, { role: "user", content: [restored, image(3000, 9)] }] });
    const out = await shedWireImagesToCount(body, "anthropic", 0);
    const content = JSON.parse(out.body).messages[1].content;
    assert.equal(out.stats.archived, 1);
    assert.deepEqual(content[0], restored);
    assert.equal(content[1].type, "text");
});

test("a message containing only a restored output remains byte-for-byte unchanged", async () => {
    const body = JSON.stringify({ messages: [calls, { role: "user", content: [restored] }] }, null, 2);
    assert.equal((await shedWireImagesToCount(body, "anthropic", 0)).body, body);
    assert.equal((await shedWireImages(body, "anthropic", 1)).body, body);
});

test("ordinary sibling outputs in the protected tail are not archived for byte pressure", async () => {
    const body = JSON.stringify({ messages: [calls, { role: "user", content: [restored, ordinary] }] });
    const out = await shedWireImages(body, "anthropic", 6000);
    assert.equal(out.stats.archived, 0);
    assert.equal(out.body, body, "the synthetic image cannot downscale, so protected-tail behavior is unchanged");
});
