import assert from "node:assert/strict";
import { test } from "node:test";
import { countImagesInParsedBody, countImagesInRawBody, imageTokensInParsedBody, imageTokensInRawBody } from "../src/image-tokens.js";

type Protocol = Parameters<typeof imageTokensInRawBody>[0];

const cases: Array<{ name: string; protocol: Protocol; raw: string }> = [
    {
        name: "Anthropic image with JSON newline and tab separators",
        protocol: "anthropic",
        raw: '{"messages":[{"role":"user","content":[{"type"\t:\n"image","source":{"type":"base64","media_type":"image/png","data":"QUJDRA=="}}]}]}',
    },
    {
        name: "pretty-printed Anthropic opaque thinking payload",
        protocol: "anthropic",
        raw: JSON.stringify({ messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "QUJDRA==" }] }] }, null, 2),
    },
    {
        name: "OpenAI custom attachment after a multiline content separator",
        protocol: "openai",
        raw: '{"messages":[{"role":"user","content"\n:\t[{"type":"image","attachment":{"data":"QUJDRA=="}}]}]}',
    },
    {
        name: "Responses custom attachment after a multiline content separator",
        protocol: "responses",
        raw: '{"input":[{"type":"message","role":"user","content"\r\n:\t[{"type":"image","attachment":{"data":"QUJDRA=="}}]}]}',
    },
    {
        name: "Google inline data with a Unicode-escaped field name",
        protocol: "google",
        raw: '{"contents":[{"role":"user","parts":[{"inline\\u0044ata":{"mimeType":"image/png","data":"QUJDRA=="}}]}]}',
    },
    {
        name: "Anthropic image with a Unicode-escaped discriminator",
        protocol: "anthropic",
        raw: '{"messages":[{"role":"user","content":[{"type":"im\\u0061ge","source":{"type":"base64","media_type":"image/png","data":"QUJDRA=="}}]}]}',
    },
];

for (const { name, protocol, raw } of cases) {
    test(`raw media accounting matches parsed accounting: ${name}`, () => {
        const parsed: unknown = JSON.parse(raw);
        const expectedTokens = imageTokensInParsedBody(protocol, parsed, "bytes");
        const expectedCount = countImagesInParsedBody(protocol, parsed);
        assert.ok(expectedTokens > 0);
        assert.equal(expectedCount, 1);
        for (const body of [raw, Buffer.from(raw)]) {
            assert.equal(imageTokensInRawBody(protocol, body, "bytes"), expectedTokens);
            assert.equal(countImagesInRawBody(protocol, body), expectedCount);
        }
    });
}

test("compact media accounting and configured image caps stay unchanged", () => {
    const body = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "QUJDRA==" } }] }] };
    assert.equal(imageTokensInRawBody("anthropic", JSON.stringify(body), "bytes", 1), 1);
    assert.equal(countImagesInRawBody("anthropic", JSON.stringify(body)), 1);
});

test("plain text with Unicode escapes and malformed probe hits stay uncharged", () => {
    for (const raw of ['{"messages":[{"role":"user","content":"\\u4e2d文 image"}]}', '{"messages":[{"content"\n:[broken'] ) {
        assert.equal(imageTokensInRawBody("openai", raw, "bytes"), 0);
        assert.equal(countImagesInRawBody("openai", raw), 0);
    }
});
