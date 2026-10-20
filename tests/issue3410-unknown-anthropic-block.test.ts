import assert from "node:assert/strict";
import test from "node:test";

import { REMOTE_IMAGE_TOKENS, countImagesInParsedBody, countImagesInRawBody, imageTokensInParsedBody, imageTokensInRawBody } from "../src/image-tokens.ts";
import { unknownAnthropicBlocks } from "../src/wire-drop-warn.ts";
import { _resetWireDropWarningsForTest, warnUnknownAnthropicBlocks } from "../src/server.ts";

// #3410: unknown anthropic top-level block types (document/PDF in the wild)
// must be preserved verbatim by the kernel sidecar, excluded from folding
// (kernel protected predicates), noticed once per session per type-set, and
// priced like the openai file precedent so the fold gate cannot undercount.

const PDF_B64 = "JVBERi0xLjcKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKdHJhaWxlcmM8PCRyb290IDEgMCBSDT4+CnN0YXJ0eHJlZgozMAolJUVPRg==";

const docBase64 = () => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_B64 } });
const docUrl = () => ({ type: "document", source: { type: "url", url: "https://files.example.com/report.pdf" } });
const docBare = () => ({ type: "document", source: { type: "text", text: "ref-only" } });
const imgUrl = () => ({ type: "image", source: { type: "url", url: "https://img.example.com/a.png" } });
const imgNoSource = () => ({ type: "image" });
const txt = () => ({ type: "text", text: "hello" });

function body(...content: unknown[]): Record<string, unknown> {
    return { model: "claude-test", max_tokens: 100, messages: [{ role: "user", content }] };
}

test("unknownAnthropicBlocks detects unknown top-level block types across all roles", () => {
    assert.equal(unknownAnthropicBlocks(null), null);
    assert.equal(unknownAnthropicBlocks({}), null);
    assert.equal(unknownAnthropicBlocks({ messages: "nope" }), null);
    assert.equal(unknownAnthropicBlocks(body(txt(), imgUrl())), null);
    assert.equal(unknownAnthropicBlocks(body({ role: "user", content: "plain string" } as never)), null);

    const r = unknownAnthropicBlocks({
        model: "claude-test",
        messages: [
            { role: "assistant", content: [txt(), docBase64()] },
            { role: "user", content: [{ type: "custom_thing", v: 1 }] },
            { role: "user", content: [docUrl()] },
        ],
    });
    assert.deepEqual(r, { count: 3, types: ["custom_thing", "document"], firstIndex: 0 });
});

test("warnUnknownAnthropicBlocks logs once per session per distinct type-set", () => {
    _resetWireDropWarningsForTest();
    const lines: string[] = [];
    const lg = (_level: string, msg: string) => lines.push(msg);

    const d = body(docBase64());
    warnUnknownAnthropicBlocks(d, "ses_a", lg);
    warnUnknownAnthropicBlocks(d, "ses_a", lg); // same session, same type-set → deduped
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[ses_a\]/);
    assert.match(lines[0], /document/);
    assert.match(lines[0], /#3410/);

    warnUnknownAnthropicBlocks(body({ type: "custom_thing", v: 1 }), "ses_a", lg); // new type-set → warns again
    assert.equal(lines.length, 2);
    warnUnknownAnthropicBlocks(d, "ses_b", lg); // new session → warns again
    assert.equal(lines.length, 3);
    warnUnknownAnthropicBlocks(body(txt(), imgUrl()), "ses_a", lg); // known types only → silent
    assert.equal(lines.length, 3);
    warnUnknownAnthropicBlocks(null, "ses_a", lg); // unparseable → silent
    assert.equal(lines.length, 3);

    _resetWireDropWarningsForTest();
    warnUnknownAnthropicBlocks(d, "ses_a", lg); // after reset → warns again
    assert.equal(lines.length, 4);
});

test("billing: anthropic document blocks are priced like the openai file precedent", () => {
    const b64CostBytes = Math.ceil(PDF_B64.length / 4);

    // base64 document: sized from its payload, identical to an image carrying the same bytes
    const docB64Cost = imageTokensInParsedBody("anthropic", body(docBase64()));
    assert.equal(docB64Cost, b64CostBytes);
    assert.equal(imageTokensInParsedBody("anthropic", body({ type: "image", source: { type: "base64", media_type: "application/pdf", data: PDF_B64 } })), b64CostBytes);

    // pixels mode: a PDF is not decodable as an image, so both fall back identically
    const docPixels = imageTokensInParsedBody("anthropic", body(docBase64()), "pixels");
    assert.equal(docPixels, imageTokensInParsedBody("anthropic", body({ type: "image", source: { type: "base64", media_type: "application/pdf", data: PDF_B64 } }), "pixels"));
    assert.ok(docPixels > 0);

    // url document: flat remote price
    assert.equal(imageTokensInParsedBody("anthropic", body(docUrl())), REMOTE_IMAGE_TOKENS);
    // bare/malformed-source document: flat remote price (never zero)
    assert.equal(imageTokensInParsedBody("anthropic", body(docBare())), REMOTE_IMAGE_TOKENS);

    // mixed content sums
    assert.equal(imageTokensInParsedBody("anthropic", body(txt(), docUrl(), imgUrl())), 2 * REMOTE_IMAGE_TOKENS);

    // regression anchors — image pricing is byte-for-byte what it was before #3410
    assert.equal(imageTokensInParsedBody("anthropic", body(imgUrl())), REMOTE_IMAGE_TOKENS);
    assert.equal(imageTokensInParsedBody("anthropic", body(imgNoSource())), 0);
    assert.equal(imageTokensInParsedBody("anthropic", body(txt())), 0);
});

test("billing: count walker stays in lockstep with the cost walker for every document shape", () => {
    const shapes: Array<[string, unknown]> = [
        ["base64", docBase64()],
        ["url", docUrl()],
        ["bare", docBare()],
        ["url image (anchor)", imgUrl()],
        ["sourceless image (anchor)", imgNoSource()],
        ["text (anchor)", txt()],
    ];
    for (const [name, part] of shapes) {
        const cost = imageTokensInParsedBody("anthropic", body(part));
        const count = countImagesInParsedBody("anthropic", body(part));
        assert.equal(count > 0, cost > 0, `${name}: cost/count sign mismatch (cost=${cost}, count=${count})`);
        assert.ok(count <= 1, `${name}: expected at most one media part, got ${count}`);
    }
    assert.equal(countImagesInParsedBody("anthropic", body(docBase64(), docUrl(), docBare())), 3);
});

test("billing: the raw-body probe admits document-only bodies (compact and spaced JSON)", () => {
    const compact = JSON.stringify(body(docBase64()));
    assert.ok(compact.includes('"type":"document"'));
    assert.equal(imageTokensInRawBody("anthropic", compact), Math.ceil(PDF_B64.length / 4));
    assert.equal(countImagesInRawBody("anthropic", compact), 1);

    const spaced = compact.replace(/"type":"/g, '"type": "');
    assert.ok(spaced.includes('"type": "document"'));
    assert.equal(imageTokensInRawBody("anthropic", spaced), Math.ceil(PDF_B64.length / 4));

    // clean bodies stay free — the probe must not over-admit
    assert.equal(imageTokensInRawBody("anthropic", JSON.stringify(body(txt()))), 0);
    assert.equal(countImagesInRawBody("anthropic", JSON.stringify(body(txt()))), 0);
});
