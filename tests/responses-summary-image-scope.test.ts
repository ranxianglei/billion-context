import assert from "node:assert/strict";
import { test } from "node:test";
import { assignRefs, createCore, defaultConfig, emptyRefMap } from "acp-kernel";
import { responsesToCore, type BiliMessage, type ResponseInputItem } from "acp-kernel/wire";
import { parseCompressInput } from "../src/compress-tool.js";
import { imagePlaceholders, imagePlaceholdersForSummary, messageImages } from "../src/image-note.js";
import { messageImageBytes } from "../src/image-restore.js";
import { createSession } from "../src/session.js";
import { applyRanges } from "../src/stream.js";

// Actual PNGs encoded by Jimp, with distinct dimensions and pixels.
const red = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAYAAACAcVaiAAAAHUlEQVR4AU3BoQEAAAiAMOT/n7UY2GZheRISEhIHfgkCCJUl8noAAAAASUVORK5CYII=";
const blue = "iVBORw0KGgoAAAANSUhEUgAAAAcAAAACCAYAAACUn8ZgAAAAE0lEQVR4AWNkYPj/nwEHYGLAAwBtQQICIRGfXAAAAABJRU5ErkJggg==";
const image = (b64: string) => ({ type: "input_image" as const, image_url: `data:image/png;base64,${b64}` });

function splitImages(): BiliMessage[] {
    return responsesToCore({ input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "Compare these screenshots." }, image(red), image(blue),
    ] }] }).msgs;
}

test("Responses summary notes bind each split image to its own recovery ref", () => {
    const messages = splitImages();
    const before = JSON.stringify(messages);
    assert.deepEqual(messages.map((message, i) => imagePlaceholdersForSummary(message, `m0000${i + 1}`)), [
        [], ["[image: png 3x5 · m00002]"], ["[image: png 7x2 · m00003]"],
    ]);
    assert.deepEqual(messages.slice(1).map(message => messageImages(message).map(ref => ref.b64)), [[red], [blue]]);
    assert.deepEqual(messages.slice(1).map(message => messageImageBytes(message).map(ref => ref.b64)), [[red], [blue]]);
    assert.equal(JSON.stringify(messages), before, "summary inspection preserves the shared source carrier");
});

test("a remote Responses image keeps one placeholder without borrowing a sibling's bytes", () => {
    const messages = responsesToCore({ input: [{ type: "message", role: "user", content: [
        image(red), { type: "input_image", image_url: "https://example.test/remote.png" }, image(blue),
    ] }] }).msgs;
    assert.deepEqual(messages.map(message => imagePlaceholders(message)), [
        ["[image: png 3x5]"], ["[image]"], ["[image: png 7x2]"],
    ]);
    assert.deepEqual(messageImageBytes(messages[1]), [], "a URL has no inline recovery bytes");
});

test("identical Responses images retain one note per distinct occurrence", () => {
    const messages = responsesToCore({ input: [{ type: "message", role: "user", content: [image(red), image(red)] }] }).msgs;
    assert.equal(new Set(messages.map(message => message.id)).size, 2);
    assert.deepEqual(messages.map((message, i) => imagePlaceholdersForSummary(message, `m0000${i + 1}`)), [
        ["[image: png 3x5 · m00001]"], ["[image: png 3x5 · m00002]"],
    ]);
});

test("unsplit Responses carriers and tool outputs still describe every carried image", () => {
    const user: BiliMessage = { id: "legacy", role: "user", contentType: "text", rawResponsesItem: {
        type: "message", role: "user", content: [image(red), image(blue)],
    } };
    assert.deepEqual(imagePlaceholders(user), ["[image: png 3x5]", "[image: png 7x2]"]);
    for (const type of ["function_call_output", "custom_tool_call_output"] as const) {
        const item: ResponseInputItem = { type, call_id: "shot", output: [
            { type: "input_text", text: "Two screenshots." }, image(red), image(blue),
        ] };
        const message: BiliMessage = { id: type, role: "tool", contentType: "tool-result", rawResponsesItem: item };
        assert.deepEqual(imagePlaceholders(message), ["[image: png 3x5]", "[image: png 7x2]"]);
    }
});

test("a real fold's image footer matches the split images' recovery ownership", () => {
    const messages = splitImages();
    messages.unshift({ id: "opening", role: "user", contentType: "text", text: "Original task. ".repeat(500) });
    messages.push(...Array.from({ length: 16 }, (_, i): BiliMessage => ({
        id: `history_${i}`, role: i % 2 === 0 ? "assistant" : "user", contentType: "text",
        text: `Historical detail ${i}. ${"retained context ".repeat(200)}`,
    })));
    const session = createSession("responses-summary-image-scope");
    session.state.messageRefs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    const summary = "Historical work completed; preserve the decisions and the captured visual evidence.";
    const before = JSON.stringify(messages);
    const result = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00008", summary }] }), {
        core: createCore(), config: defaultConfig(200_000), messages, session, log: () => {},
    }, { loopTracking: false });
    assert.equal(result.outcome, "applied");
    assert.equal(session.state.blocks.length, 1);
    assert.equal(session.state.blocks[0].summary, summary +
        "\n\n[folded images: [image: png 3x5 · m00003] [image: png 7x2 · m00004] — decompress({ imageRef }) restores pixels]");
    assert.equal(JSON.stringify(messages), before);
    assert.ok(!session.state.blocks[0].summary.includes(red));
    assert.ok(!session.state.blocks[0].summary.includes(blue));
});
