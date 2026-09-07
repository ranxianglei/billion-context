import test from "node:test";
import assert from "node:assert/strict";
// The mechanism moved to acp-kernel's wire layer (kernel #215); these tests
// stay as host-level regression coverage over the bundled kernel export.
import { stripHistoricalImages } from "acp-kernel/wire";
import { DEFAULT_STRIP_IMAGES_KEEP_RECENT } from "../src/compress-settings.ts";

test("default keep-recent constant is 5", () => {
    assert.equal(DEFAULT_STRIP_IMAGES_KEEP_RECENT, 5);
});

test("openai: strips historical image_url parts, keeps recent-N verbatim", () => {
    const body = {
        model: "gpt-4o",
        messages: [
            { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
            { role: "assistant", content: "hello" },
            { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }] },
            { role: "user", content: [{ type: "text", text: "recent" }, { type: "image_url", image_url: { url: "data:image/png;base64,CCCC" } }] },
            { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,DDDD" } }] },
        ],
    };
    const r = stripHistoricalImages(body, "openai", 2);
    assert.equal(r.removed, 2);
    const msgs = (r.body as typeof body).messages;
    // idx0: mixed text+image -> image dropped, text kept
    assert.deepEqual(msgs[0].content, [{ type: "text", text: "hi" }]);
    // idx2: image-only -> collapsed to "[image]" placeholder
    assert.deepEqual(msgs[2].content, [{ type: "text", text: "[image]" }]);
    // idx3/idx4: within recent-N -> untouched, base64 still present
    assert.ok(JSON.stringify(msgs[3]).includes("CCCC"));
    assert.ok(JSON.stringify(msgs[4]).includes("DDDD"));
    // untouched message objects keep their references (only changed ones are rebuilt)
    assert.equal(msgs[1], body.messages[1]);
    assert.equal(msgs[3], body.messages[3]);
});

test("openai: body with no images returns the SAME reference, removed 0", () => {
    const body = { model: "m", messages: [{ role: "user", content: "plain" }] };
    const r = stripHistoricalImages(body, "openai", 5);
    assert.equal(r.removed, 0);
    assert.equal(r.body, body);
});

test("openai: keepRecent >= message count -> nothing stripped, same ref", () => {
    const body = {
        model: "m",
        messages: [
            { role: "user", content: [{ type: "image_url", image_url: { url: "data:x" } }] },
            { role: "user", content: [{ type: "image_url", image_url: { url: "data:y" } }] },
        ],
    };
    const r = stripHistoricalImages(body, "openai", 10);
    assert.equal(r.removed, 0);
    assert.equal(r.body, body);
});

test("openai: keepRecent 0 strips every image-bearing message", () => {
    const body = {
        model: "m",
        messages: [
            { role: "user", content: [{ type: "image_url", image_url: { url: "data:a" } }] },
            { role: "user", content: [{ type: "image_url", image_url: { url: "data:b" } }] },
        ],
    };
    const r = stripHistoricalImages(body, "openai", 0);
    assert.equal(r.removed, 2);
    const msgs = (r.body as typeof body).messages;
    assert.deepEqual(msgs[0].content, [{ type: "text", text: "[image]" }]);
    assert.deepEqual(msgs[1].content, [{ type: "text", text: "[image]" }]);
});

test("anthropic: strips historical image blocks, keeps mixed text + recent-N", () => {
    const body = {
        model: "claude",
        messages: [
            { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
            { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } }] },
            { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "CCCC" } }] },
        ],
    };
    const r = stripHistoricalImages(body, "anthropic", 2);
    assert.equal(r.removed, 1);
    const msgs = (r.body as typeof body).messages;
    assert.deepEqual(msgs[0].content, [{ type: "text", text: "look" }]);
    assert.ok(JSON.stringify(msgs[2]).includes("BBBB"));
    assert.ok(JSON.stringify(msgs[3]).includes("CCCC"));
});

test("responses: strips historical input_image parts, ignores non-message items", () => {
    const body = {
        model: "gpt",
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
            { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,BBBB" }] },
            { type: "function_call", name: "f", arguments: "{}" },
            { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,CCCC" }] },
        ],
    };
    const r = stripHistoricalImages(body, "responses", 2);
    assert.equal(r.removed, 2);
    const items = (r.body as typeof body).input;
    // idx0: mixed -> image dropped, input_text kept
    assert.deepEqual(items[0].content, [{ type: "input_text", text: "see" }]);
    // idx2: image-only -> responses uses input_text placeholder
    assert.deepEqual(items[2].content, [{ type: "input_text", text: "[image]" }]);
    // idx3: function_call has no content array -> untouched
    assert.deepEqual(items[3], body.input[3]);
    // idx4: recent-N -> untouched
    assert.ok(JSON.stringify(items[4]).includes("CCCC"));
});

test("protocol null / non-object body -> no-op same reference", () => {
    const body = { messages: [] };
    assert.equal(stripHistoricalImages(body, null, 5).body, body);
    assert.equal(stripHistoricalImages(null, "openai", 5).removed, 0);
    assert.equal(stripHistoricalImages("not-an-object", "openai", 5).removed, 0);
});
