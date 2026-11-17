import assert from "node:assert/strict";
import { test } from "node:test";
import { assignRefs, createCore, defaultConfig, emptyRefMap } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { parseCompressInput } from "../src/compress-tool.js";
import { createSession } from "../src/session.js";
import { applyRanges, type RewriteCtx } from "../src/stream.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const summary = "Historical work completed; preserve the decisions and the captured visual evidence.";
const footer = (notes: string[]) => `\n\n[folded images: ${notes.join(" ")} — decompress({ imageRef }) restores pixels]`;

function context(): RewriteCtx & { messages: BiliMessage[] } {
    const messages: BiliMessage[] = Array.from({ length: 16 }, (_, i) => ({
        id: `history_${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text",
        text: `Historical detail ${i}. ${"retained context ".repeat(200)}`,
    }));
    const session = createSession("fold-image-note-test");
    session.state.messageRefs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return { core: createCore(), config: defaultConfig(200_000), messages, session, log: () => {} };
}

function fold(ctx: RewriteCtx, ranges = [{ startId: "m00001", endId: "m00006", summary }]) {
    return applyRanges(parseCompressInput({ content: ranges }), ctx, { loopTracking: false });
}

test("a real fold retains image order, repeated images and exact recovery refs across wire sidecars", () => {
    const ctx = context();
    ctx.messages[0].rawAnthropicBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: png } };
    ctx.messages[2].rawOpenaiContentParts = [{ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }];
    ctx.messages[3].rawResponsesItem = { type: "message", role: "user", content: [
        { type: "input_image", image_url: `data:image/png;base64,${png}` },
        { type: "input_image", image_url: `data:image/png;base64,${png}` },
    ] };
    ctx.messages[4].rawGoogleParts = [{ inlineData: { mimeType: "image/png", data: png } }];
    const before = JSON.stringify(ctx.messages);
    assert.equal(fold(ctx).outcome, "applied");
    assert.equal(ctx.session.state.blocks.length, 1);
    const block = ctx.session.state.blocks[0];
    assert.equal(block.summary, summary + footer([
        "[image: png 1x1 · m00001]", "[image: png 1x1 · m00003]",
        "[image: png 1x1 · m00004]", "[image: png 1x1 · m00004]", "[image: png 1x1 · m00005]",
    ]));
    assert.deepEqual(block.directMessageIds, ctx.messages.slice(0, 6).map(m => m.id));
    assert.equal(JSON.stringify(ctx.messages), before, "source sidecars remain byte-identical");
    assert.ok(!block.summary.includes(png));
});

test("image notes use the unpruned compression view when the visible view no longer carries pixels", () => {
    const ctx = context();
    const full: BiliMessage[] = ctx.messages.map(m => ({ ...m }));
    full[1].imageBase64 = png;
    full[1].imageMediaType = "image/png";
    ctx.compressMessages = full;
    assert.equal(fold(ctx).outcome, "applied");
    assert.equal(ctx.session.state.blocks[0].summary, summary + footer(["[image: png 1x1 · m00002]"]));
});

test("a repeated raw id keeps the first visible message's image note", () => {
    const ctx = context();
    ctx.messages[0].imageBase64 = png;
    ctx.messages[0].imageMediaType = "image/png";
    ctx.messages[1] = { ...ctx.messages[0], imageBase64: "", imageMediaType: "image/jpeg" };
    assert.equal(fold(ctx).outcome, "applied");
    assert.equal(ctx.session.state.blocks[0].summary, summary + footer(["[image: png 1x1 · m00001]"]));
});

test("multiple new blocks receive only their own direct images", () => {
    const ctx = context();
    ctx.messages[0].imageBase64 = png;
    ctx.messages[0].imageMediaType = "image/png";
    ctx.messages[4].rawGoogleParts = [{ fileData: { mimeType: "image/jpeg", fileUri: "https://example.com/shot.jpg" } }];
    assert.equal(fold(ctx, [
        { startId: "m00001", endId: "m00002", summary },
        { startId: "m00005", endId: "m00006", summary },
    ]).outcome, "applied");
    assert.deepEqual(ctx.session.state.blocks.map(b => b.summary), [
        summary + footer(["[image: png 1x1 · m00001]"]),
        summary + "\n\nMEDIA REFS (verbatim re-access handles — preserve when distilling):\n- https://example.com/shot.jpg" + footer(["[image: jpeg · m00005]"]),
    ]);
});

test("an already-covered no-op does not append image notes again", () => {
    const ctx = context();
    ctx.messages[0].imageBase64 = png;
    ctx.messages[0].imageMediaType = "image/png";
    assert.equal(fold(ctx).outcome, "applied");
    const original = ctx.session.state.blocks[0].summary;
    const again = fold(ctx);
    assert.equal(again.blocksCreated, 0);
    assert.equal(ctx.session.state.blocks.length, 1);
    assert.equal(ctx.session.state.blocks[0].summary, original);
});

test("plain-text folds retain the exact summary without an image footer", () => {
    const ctx = context();
    assert.equal(fold(ctx).outcome, "applied");
    assert.equal(ctx.session.state.blocks[0].summary, summary);
});
