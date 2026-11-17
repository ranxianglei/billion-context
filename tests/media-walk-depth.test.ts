import assert from "node:assert/strict";
import test from "node:test";
import { mediaBytesOfWireBody } from "../src/agent/media-bytes.ts";

function nested(raw: string): string {
    return '{"wrapper":['.repeat(10_000) + raw + "]}".repeat(10_000);
}

test("media accounting handles deeply nested JSON objects and arrays", () => {
    const raw = nested('{"source":{"type":"base64","data":"aGVsbG8="}}');
    assert.equal(mediaBytesOfWireBody(raw), Buffer.byteLength("aGVsbG8="));
});

test("deep text remains billed as text and malformed JSON is ignored", () => {
    assert.equal(mediaBytesOfWireBody(nested('{"type":"text","text":"data:image/png;base64,aGVsbG8="}')), 0);
    assert.equal(mediaBytesOfWireBody('{"source":'), 0);
});

test("iterative traversal preserves sibling media accounting rules", () => {
    const media = "data:image/png;base64,aGVsbG8=";
    const raw = JSON.stringify({
        content: [
            { source: { type: "base64", data: "ab==" } },
            { type: "redacted_thinking", data: "cd==" },
            { image_url: media },
            { image_url: { url: media } },
            { file_data: media },
            { input_audio: { data: "ef==" } },
            { inlineData: { data: "gh==" } },
            { type: "text", text: media },
            { url: "https://example.com/image.png" },
            null,
        ],
    });
    assert.equal(mediaBytesOfWireBody(raw), 4 * 4 + 3 * Buffer.byteLength(media));
});
