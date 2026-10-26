// #3859: the no-visible-context gate (#3126) had a span-overlap exemption —
// any requested range touching an active block was handed to the kernel even
// when the message view was empty. The kernel cannot anchor ANY endpoint on an
// empty view (visibleBlockAnchor/activeOwnerAnchor need a visible
// representation), so every such call failed with "cannot be anchored" AND its
// dead-ref pass tombstoned each boundary ref not point-covered by an active
// block — live refs recorded DEAD while the session was merely evicted from
// the resident pool. Span overlap ≠ per-ref coverage, which is exactly how
// m00774–m00860-style ranges (overlapping some of 15 blocks, boundary refs in
// the gaps) escaped the gate. On an empty view the gate now yields to the
// kernel only when EVERY message-ref boundary of every range is point-covered
// by an active block (the #403/#2748 state-alone refolds and their
// diagnostics); anything else is refused up front, zero state writes. These
// tests pin: the reporter's multi-range shape → refused; a mixed batch with
// ONE uncovered range → refused as a whole; pure block-ref calls (never
// tombstoned) → still reach the kernel's own diagnostics; non-empty views
// never hit the gate at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

function makeCtx(): Ctx {
    const logs: string[] = [];
    const ctx: Ctx = {
        core: createCore(),
        config: defaultConfig(200000, { preserveRecentMessages: 5, preserveRecentTokens: 0 }),
        // View present while the setup folds run; each eviction-scenario test
        // clears it afterwards (state survives, the message bytes do not).
        messages: MESSAGES,
        session: {
            id: "issue3859-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: (m: string) => { logs.push(m); },
        logs,
    };
    ctx.session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return ctx;
}

const fold = (ctx: Ctx, startId: string, endId: string, summary: string) =>
    applyRanges(parseCompressInput({ content: [{ startId, endId, summary }] }), ctx);

test("#3859: multi-range request overlapping active blocks is refused on an empty view, nothing recorded dead", () => {
    const ctx = makeCtx();
    // Three active blocks with gaps between them (the reporter's 15-block
    // shape, scaled down): m00001–m00020, m00030–m00050, m00060–m00078.
    assert.equal(fold(ctx, "m00001", "m00020", "z".repeat(60)).outcome, "applied");
    assert.equal(fold(ctx, "m00030", "m00050", "z".repeat(60)).outcome, "applied");
    assert.equal(fold(ctx, "m00060", "m00078", "z".repeat(60)).outcome, "applied");
    const blocksBefore = ctx.session.state.blocks.length;
    // Eviction: the view drops out, refs survive.
    ctx.messages = [];
    ctx.compressMessages = [];
    // The reporter's pattern: ranges that partially overlap blocks with their
    // boundary refs in the gaps (m00028/m00058 sit in the inter-block gaps,
    // m00079–m00080 past the last block — none of them is covered by ANY
    // block), plus a second partial overlap. Pre-fix, the first two made the
    // whole call touchable and the kernel tombstoned those four boundary refs.
    const res = applyRanges(parseCompressInput({ content: [
        { startId: "m00015", endId: "m00028", summary: "y".repeat(100) },
        { startId: "m00045", endId: "m00058", summary: "y".repeat(100) },
        { startId: "m00079", endId: "m00080", summary: "y".repeat(100) },
    ] }), ctx);
    assert.equal(res.outcome, "refused");
    assert.equal(res.reason, "gate:no-visible-context", `whole batch refused as one unit: ${res.text}`);
    assert.ok(res.text.includes("no visible context"), `honest cause: ${res.text}`);
    assert.ok(res.text.includes("Do NOT retry now"), `retry veto until next model request: ${res.text}`);
    assert.equal(res.blocksCreated, 0);
    assert.equal(ctx.session.state.deadRefs, undefined, "no refs recorded dead — the #3859 corruption");
    assert.equal(ctx.session.state.blocks.length, blocksBefore, "existing blocks untouched");
});

test("#3859: a batch mixing a state-alone refold with an uncovered range is refused as a whole", () => {
    const ctx = makeCtx();
    assert.equal(fold(ctx, "m00001", "m00020", "z".repeat(60)).outcome, "applied");
    const blockId = ctx.session.state.blocks[0]!.blockId;
    resolveDecompress({ blockId }, ctx as never); // flips restoredInline while the view still exists
    ctx.messages = [];
    ctx.compressMessages = [];
    // First range alone would be vouchable (restoredInline refold from state);
    // the second has boundary refs past the last block → the WHOLE batch is
    // refused instead of half-landing while tombstoning the second half.
    const res = applyRanges(parseCompressInput({ content: [
        { startId: "m00001", endId: "m00020", summary: "refolded" },
        { startId: "m00079", endId: "m00080", summary: "y".repeat(100) },
    ] }), ctx);
    assert.equal(res.outcome, "refused");
    assert.equal(res.reason, "gate:no-visible-context", `batch-level refusal: ${res.text}`);
    assert.equal(ctx.session.state.deadRefs, undefined, "no refs recorded dead");
    assert.equal(ctx.session.state.blocks.find((b) => b.blockId === blockId)?.summary, "z".repeat(60), "the vouchable half waits for the next turn, not a partial landing");
});

test("#3859: a pure block-ref distillation call on an empty view still reaches the kernel — no dead refs", () => {
    const ctx = makeCtx();
    assert.equal(fold(ctx, "m00001", "m00020", "z".repeat(60)).outcome, "applied");
    assert.equal(fold(ctx, "m00030", "m00050", "z".repeat(60)).outcome, "applied");
    ctx.messages = [];
    ctx.compressMessages = [];
    // Block-ref boundaries are never examined by the kernel's dead-ref pass,
    // so this shape stays vouchable and lands on the kernel's own
    // already-compressed diagnostic (pre-fix behavior preserved) rather than
    // a new DEAD record or a vague refusal.
    const res = applyRanges(parseCompressInput({ content: [{ startId: "b1", endId: "b2", summary: "tier-2 ".repeat(20) }] }), ctx);
    assert.notEqual(res.reason, "gate:no-visible-context", `block-ref shape must pass the gate: ${res.text}`);
    assert.ok(res.text.includes("already compressed"), `kernel diagnostic preserved: ${res.text}`);
    assert.equal(ctx.session.state.deadRefs, undefined);
    assert.equal(ctx.session.state.blocks.length, 2, "no blocks created or destroyed");
});

test("#3859 negative row: the same block-overlapping ranges on a NON-EMPTY view never hit the gate", () => {
    const ctx = makeCtx(); // view stays present for the whole test
    assert.equal(fold(ctx, "m00001", "m00020", "z".repeat(60)).outcome, "applied");
    assert.equal(fold(ctx, "m00030", "m00050", "z".repeat(60)).outcome, "applied");
    // View still holds the conversation (proxy-shaped round): the gate must
    // stay silent and the kernel applies its own per-range diagnostics.
    const res = fold(ctx, "m00015", "m00028", "y".repeat(100));
    assert.notEqual(res.reason, "gate:no-visible-context", `non-empty view must bypass the gate: ${res.text}`);
});
