import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { getSession } from "../src/session.ts";

/**
 * #403 refold wiring (bili proxy lane): a successful FULL-BLOCK decompress
 * rides the transient tool-result channel — the client keeps that tool result
 * in its re-sent history, so the model has the block's re-summarization
 * material in context. The wiring flips the kernel's restoredInline flag at
 * that moment so a later compress of the same span refolds the block in place
 * instead of dying on "already compressed" — the one-way-ratchet fix from
 * kernel #398/#403, which was otherwise inert in proxy mode (markBlockRestoredInline
 * had no host caller).
 */

function makeCtx() {
    const core = createCore();
    const config = defaultConfig(200000) as Config;
    const session = getSession(`refold-wiring-${Math.random().toString(36).slice(2)}`);
    return { core, config, session };
}

function compressARange() {
    const { core, config, session } = makeCtx();
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({
            id: `h_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${String(i + 1).padStart(5, "0")}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(3000)}`,
        });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "First summary: messages 1-2 covered the initial phase in detail." }] }), ctx as never);
    assert.match(out, /Compressed m00001–m00002 → 1 block\(s\)/, `compress must succeed: ${out}`);
    const block = [...session.state.blocks].slice(-1)[0]!;
    return { ctx, core, config, session, msgs, block };
}

test("full-block decompress flips restoredInline (proxy wiring)", () => {
    const { ctx, session, block } = compressARange();
    assert.notEqual(block.restoredInline, true, "fresh block is not marked");
    const out = resolveDecompress({ blockId: block.blockId }, ctx as never);
    assert.match(out, /Block b\d+ content/);
    const after = session.state.blocks.find((b) => b.blockId === block.blockId)!;
    assert.equal(after.restoredInline, true, "flag flipped by full-block restore");
    // idempotent: second restore keeps the flag (no state churn assertion, just behavior)
    resolveDecompress({ blockId: block.blockId }, ctx as never);
    assert.equal(session.state.blocks.find((b) => b.blockId === block.blockId)!.restoredInline, true);
});

test("full:true restore also flips the flag", () => {
    const { ctx, session, block } = compressARange();
    resolveDecompress({ blockId: block.blockId, full: true }, ctx as never);
    assert.equal(session.state.blocks.find((b) => b.blockId === block.blockId)!.restoredInline, true);
});

test("range restore (startId/endId) does NOT flip the flag — partial content is not refold material", () => {
    const { ctx, session, block } = compressARange();
    const out = resolveDecompress({ blockId: block.blockId, startId: "m00002", endId: "m00003" }, ctx as never);
    assert.ok(typeof out === "string" && out.length > 0);
    const after = session.state.blocks.find((b) => b.blockId === block.blockId)!;
    assert.notEqual(after.restoredInline, true, "partial restore must not mark the block");
});

test("toFile spill (>10K chars) does NOT flip the flag — material lives in a temp file, not the conversation", () => {
    const { ctx, session, block } = compressARange();
    // Force the spill path deterministically via the decompress cache entry.
    ctx.session.blockContents.set(block.blockId, { one: null, full: { text: "y".repeat(11000), count: 7 } });
    const out = resolveDecompress({ blockId: block.blockId }, ctx as never);
    assert.match(out, /written to:/, "spilled to file");
    assert.doesNotMatch(out, /Re-fold:/, "no hint on the toFile path");
    const after = session.state.blocks.find((b) => b.blockId === block.blockId)!;
    assert.notEqual(after.restoredInline, true, "toFile restore must not mark the block (frozen contract: file mode behavior fully unchanged)");
});

test("end-to-end: decompress then re-compress same span refolds in place (proxy-shaped empty view)", () => {
    const { ctx, session, block, msgs } = compressARange();
    resolveDecompress({ blockId: block.blockId }, ctx as never);
    // Proxy-shaped next round: the originals left the wire view; only the flag
    // tells the kernel the model holds the material via the kept tool result.
    ctx.messages = [];
    ctx.compressMessages = [];
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "Refolded summary: the model re-summarized from the restored content after finishing with the details." }] }), ctx as never);
    assert.match(out, /Compressed m00001–m00002 → 1 block\(s\)/, `refold must land: ${out}`);
    const after = session.state.blocks.find((b) => b.blockId === block.blockId)!;
    assert.ok(after, "same block survived (in place, not replaced)");
    assert.equal(after.summary, "Refolded summary: the model re-summarized from the restored content after finishing with the details.");
    assert.notEqual(after.restoredInline, true, "marker cleared after refold");
    assert.equal(session.state.blocks.length, 1, "no second block created");
    void msgs;
});

test("negative control: without the restore, re-compressing a consumed span is skipped (not refolded)", () => {
    const { ctx, session, block } = compressARange();
    ctx.messages = [];
    ctx.compressMessages = [];
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "Should never land — span already compressed and not restored." }] }), ctx as never);
    const after = session.state.blocks.find((b) => b.blockId === block.blockId)!;
    assert.equal(after.summary, "First summary: messages 1-2 covered the initial phase in detail.", "summary untouched");
    assert.match(out, /already compressed/, `rejected with the already-compressed diagnostic: ${out}`);
    assert.ok(!/Compressed m00001–m00002 → 1 block\(s\)/.test(out), "no in-place update without the flag");
});
