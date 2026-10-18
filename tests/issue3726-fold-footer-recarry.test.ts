import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig, summaryMessageId } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

// #3726: the folded-images footer ("[folded images: … — decompress({ imageRef })
// restores pixels]") is the ONLY pointer to archived pixels: the mNNNNN refs
// inside it are the keys decompress({ imageRef }) / the host original-image tool
// accept. Tier-1 folds derive it from live wire messages; once T1 has pruned
// those messages, higher-tier distills and tier promotions cannot re-derive it —
// these lanes pin that the refs survive every subsequent fold.

function pngB64(w: number, h: number): string {
    const b = Buffer.alloc(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b.toString("base64");
}

const PNG_B64 = pngB64(1024, 768);
const FOOTER_OPEN = "[folded images: ";

function countFooterSpans(summary: string): number {
    return summary.split(FOOTER_OPEN).length - 1;
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function imgMsg(id: string): CoreMessage {
    return {
        id,
        role: "user",
        contentType: "text",
        text: "[image]",
        imageMediaType: "image/png",
        imageBase64: PNG_B64,
    } as CoreMessage;
}

function makeSession(): Session {
    return {
        id: `issue3726-${randomUUID()}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

function makeCtx(messages: CoreMessage[], config?: Config): RewriteCtx & { session: Session; config: Config } {
    const session = makeSession();
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: config ?? defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 }), messages, session, log: () => {} };
}

function compress(args: { content: Array<{ startId: string; endId: string; summary: string; topic?: string }> }): ReturnType<typeof parseCompressInput> {
    return parseCompressInput(JSON.parse(JSON.stringify(args)));
}

/** Replace the wire view with the post-prune shape: rendered summary stubs for
 *  the given blocks plus any trailing live messages (what the NEXT request sees
 *  after a fold — the originals are gone from the wire). */
function pruneView(ctx: ReturnType<typeof makeCtx>, blockIds: string[], trailing: CoreMessage[] = []): void {
    ctx.messages = [
        ...blockIds.map((id) => ({ id: summaryMessageId(id), role: "system" as const, contentType: "text" as const, text: `(rendered ${id})` })),
        ...trailing,
    ];
}

function t1Fold(ctx: ReturnType<typeof makeCtx>, startId: string, endId: string, summary: string): void {
    const out = applyRanges(compress({ content: [{ startId, endId, summary }] }), ctx).text;
    assert.ok(out.startsWith("[Compressed "), `T1 fold failed: ${out.slice(0, 160)}`);
}

test("#3726: T1 fold appends the ref-carrying folded-images footer (baseline)", () => {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "user", "a".repeat(3000)),
        imgMsg("raw_2"),
        textMsg("raw_3", "assistant", "b".repeat(3000)),
    ];
    const ctx = makeCtx(msgs);
    t1Fold(ctx, "m00001", "m00003", "Baseline fold of the first screenshot pass: tail reads flat like a paddle, neck runs long past the shoulder, legs proportionally short against the motorcycle frame.");
    const blocks = ctx.session.state.blocks;
    assert.equal(blocks.length, 1);
    assert.equal(countFooterSpans(blocks[0].summary), 1);
    assert.ok(blocks[0].summary.includes("[image: png 1024x768 · m00002]"), blocks[0].summary);
});

test("#3726: bN-cited tier promotion recarries the footer once originals are off-wire", () => {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "user", "a".repeat(3000)),
        imgMsg("raw_2"),
        textMsg("raw_3", "assistant", "b".repeat(3000)),
    ];
    const ctx = makeCtx(msgs);
    t1Fold(ctx, "m00001", "m00003", "Baseline fold of the first screenshot pass: tail reads flat like a paddle, neck runs long past the shoulder, legs proportionally short against the motorcycle frame.");
    assert.ok(ctx.session.state.blocks[0]!.summary.includes("[image: png 1024x768 · m00002]"), "precondition: T1 footer landed");

    pruneView(ctx, ["b1"]);
    const out = applyRanges(compress({ content: [{ startId: "b1", endId: "b1", summary: "Tier-two distill of the visual iteration loop around the tail shape.", topic: "visual" }] }), ctx).text;
    assert.ok(out.startsWith("[Compressed "), `tier promotion failed: ${out.slice(0, 160)}`);
    const active = ctx.session.state.blocks.filter((b) => b.active);
    assert.equal(active.length, 1);
    const promoted = active[0]!;
    assert.notEqual(promoted.blockId, "b1", "promotion creates a new block consuming b1");
    assert.equal(promoted.tier, 2);
    assert.equal(countFooterSpans(promoted.summary), 1);
    assert.ok(promoted.summary.includes("[image: png 1024x768 · m00002]"), `recarried footer missing: ${promoted.summary}`);
});

test("#3726: multi-block merge unions the footers of every consumed image block", () => {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "user", "a".repeat(3000)),
        imgMsg("raw_2"),
        textMsg("raw_3", "assistant", "b".repeat(2000)),
        textMsg("raw_4", "user", "c".repeat(3000)),
        imgMsg("raw_5"),
        textMsg("raw_6", "assistant", "d".repeat(2000)),
    ];
    const ctx = makeCtx(msgs);
    t1Fold(ctx, "m00001", "m00003", "First screenshot pass recorded: the tail reads flat, like a paddle.");
    t1Fold(ctx, "m00004", "m00006", "Second screenshot pass recorded: the neck runs long past the shoulder.");
    const byId = new Map(ctx.session.state.blocks.map((b) => [b.blockId, b]));
    assert.ok(byId.get("b1")!.summary.includes("· m00002]"), "precondition: b1 footer");
    assert.ok(byId.get("b2")!.summary.includes("· m00005]"), "precondition: b2 footer");

    pruneView(ctx, ["b1", "b2"]);
    const out = applyRanges(compress({ content: [{ startId: "b1", endId: "b2", summary: "Merged visual passes: tail now tapers correctly, neck still too long.", topic: "visual" }] }), ctx).text;
    assert.ok(out.startsWith("[Compressed "), `merge failed: ${out.slice(0, 160)}`);
    const active = ctx.session.state.blocks.filter((b) => b.active);
    assert.equal(active.length, 1);
    const merged = active[0]!;
    assert.equal(countFooterSpans(merged.summary), 1);
    assert.ok(merged.summary.includes("[image: png 1024x768 · m00002]"), `m00002 lost: ${merged.summary}`);
    assert.ok(merged.summary.includes("[image: png 1024x768 · m00005]"), `m00005 lost: ${merged.summary}`);
});

test("#3726: a model-carried footer in the submitted summary normalizes to exactly one span", () => {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "user", "a".repeat(3000)),
        imgMsg("raw_2"),
        textMsg("raw_3", "assistant", "b".repeat(3000)),
    ];
    const ctx = makeCtx(msgs);
    t1Fold(ctx, "m00001", "m00003", "Baseline fold of the first screenshot pass: tail reads flat like a paddle, neck runs long past the shoulder, legs proportionally short against the motorcycle frame.");

    pruneView(ctx, ["b1"]);
    const carried = "Tier-two distill of the visual loop.\n\n[folded images: [image: png 1024x768 · m00002] — decompress({ imageRef }) restores pixels]";
    const out = applyRanges(compress({ content: [{ startId: "b1", endId: "b1", summary: carried }] }), ctx).text;
    assert.ok(out.startsWith("[Compressed "), `promotion failed: ${out.slice(0, 160)}`);
    const active = ctx.session.state.blocks.filter((b) => b.active);
    assert.equal(active.length, 1);
    const promoted = active[0]!;
    assert.equal(countFooterSpans(promoted.summary), 1, `duplicate footers: ${promoted.summary}`);
    assert.ok(promoted.summary.includes("[image: png 1024x768 · m00002]"), promoted.summary);
});

test("#3726: in-place refold (#398) of a folded image block recarries the footer from its own previous summary", () => {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "user", "a".repeat(3000)),
        imgMsg("raw_2"),
        textMsg("raw_3", "assistant", "b".repeat(3000)),
    ];
    const ctx = makeCtx(msgs);
    t1Fold(ctx, "m00001", "m00003", "Baseline fold of the first screenshot pass: tail reads flat like a paddle, neck runs long past the shoulder, legs proportionally short against the motorcycle frame.");
    assert.ok(ctx.session.state.blocks[0]!.summary.includes("[image: png 1024x768 · m00002]"), "precondition: T1 footer landed");

    // Inline restore flags restoredInline; the originals stay OFF the wire —
    // the model holds the material via the kept tool result, so the next
    // request's view cannot re-derive the image notes.
    resolveDecompress({ blockId: "b1" }, ctx);
    ctx.messages = [];
    // #2748: the net-shrink gate requires the new summary to be strictly
    // smaller than the stored one, so the refold condenses further.
    const out = applyRanges(compress({ content: [{ startId: "m00001", endId: "m00003", summary: "Condensed visual pass: tail tapers now; neck still long." }] }), ctx).text;
    assert.match(out, /Compressed m00001–m00003 → 1 block\(s\)/, `refold must land: ${out.slice(0, 200)}`);
    const blocks = ctx.session.state.blocks;
    assert.equal(blocks.length, 1, "in-place refold keeps a single block");
    const b1 = blocks[0]!;
    assert.equal(b1.blockId, "b1", "refold updates the same block id");
    assert.equal(b1.tier, 1, "refold keeps the tier");
    assert.ok(b1.summary.startsWith("Condensed visual pass:"), b1.summary);
    assert.equal(countFooterSpans(b1.summary), 1, `footer lost or duplicated on refold: ${b1.summary}`);
    assert.ok(b1.summary.includes("[image: png 1024x768 · m00002]"), `recarried footer missing: ${b1.summary}`);
});

test("#3726 negative: a text-only fold gains no footer", () => {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "user", "a".repeat(3000)),
        textMsg("raw_2", "assistant", "b".repeat(3000)),
    ];
    const ctx = makeCtx(msgs);
    t1Fold(ctx, "m00001", "m00002", "Text-only pass folded: layout notes reviewed, no screenshots taken.");
    const blocks = ctx.session.state.blocks;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].summary, "Text-only pass folded: layout notes reviewed, no screenshots taken.", "no footer appended to an image-free fold");
});
