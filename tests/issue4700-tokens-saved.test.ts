import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(messages: CoreMessage[]): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "issue4700-tokens-saved",
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
}

function withRefs(ctx: Ctx): Ctx {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

// Same shape as tests/compress-observability.test.ts: seven compressible
// messages, refs m00001–m00007, m00005–m00007 inside the protected zone
// (last three + most recent user message).
function makeCompressibleCtx(): Ctx {
    return withRefs(makeCtx([
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
    ]));
}

const SUMMARY = "OBS-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK";

function runApply(ctx: Ctx, args: unknown): string {
    const ranges = parseCompressInput(args);
    return applyRanges(ranges, ctx).text;
}

test("#4700: tool-driven fold credits session.stats.tokensSaved with the gross covered tokens", () => {
    const ctx = makeCompressibleCtx();
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00002", summary: SUMMARY }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out}`);
    const blocks = ctx.session.state.blocks;
    assert.equal(blocks.length, 1, "one block created");
    const credited = ctx.session.stats.tokensSaved;
    assert.ok(credited > 0, `tokensSaved credited (got ${credited})`);
    assert.equal(credited, blocks[0].compressedTokens, "credit == the block's gross compressedTokens");
    assert.equal(credited, ctx.session.lastCompress?.tokensCompressed, "credit == lastCompress.tokensCompressed (same caliber the obs log reports)");
});

test("#4700: consecutive folds accumulate (reporter's 12789+8214 → 21003 shape)", () => {
    const ctx = makeCompressibleCtx();
    runApply(ctx, { content: [{ startId: "m00001", endId: "m00002", summary: SUMMARY }] });
    const first = ctx.session.stats.tokensSaved;
    assert.ok(first > 0, `first fold credited (got ${first})`);
    runApply(ctx, { content: [{ startId: "m00003", endId: "m00004", summary: SUMMARY }] });
    const second = ctx.session.stats.tokensSaved - first;
    assert.equal(second, ctx.session.state.blocks[1].compressedTokens, "second credit == its block's gross");
    assert.equal(ctx.session.stats.tokensSaved, ctx.session.state.blocks[0].compressedTokens + ctx.session.state.blocks[1].compressedTokens, "lifetime total == sum over created blocks");
});

test("#4700: refused fold credits nothing", () => {
    const ctx = makeCompressibleCtx();
    // Entirely inside the protected zone (last three + most recent user message).
    const out = runApply(ctx, { content: [{ startId: "m00005", endId: "m00007", summary: SUMMARY }] });
    assert.ok(!out.startsWith("[Compressed"), `expected refusal, got: ${out}`);
    assert.equal(ctx.session.stats.tokensSaved, 0, "no credit on refusal");
    assert.equal(ctx.session.state.blocks.length, 0, "no block created");
});

test("#4700: repeat call over an already folded range credits nothing again", () => {
    const ctx = makeCompressibleCtx();
    runApply(ctx, { content: [{ startId: "m00001", endId: "m00002", summary: SUMMARY }] });
    const once = ctx.session.stats.tokensSaved;
    assert.ok(once > 0, `fold credited (got ${once})`);
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00002", summary: SUMMARY }] });
    assert.ok(!out.startsWith("[Compressed"), `expected refusal, got: ${out}`);
    assert.equal(ctx.session.stats.tokensSaved, once, "no double credit");
});

test("#4700: SAVED column survives full deactivation — mirrors the web derivation", () => {
    const ctx = makeCompressibleCtx();
    runApply(ctx, { content: [{ startId: "m00001", endId: "m00002", summary: SUMMARY }] });
    runApply(ctx, { content: [{ startId: "m00003", endId: "m00004", summary: SUMMARY }] });
    const total = ctx.session.stats.tokensSaved;
    assert.ok(total > 0, `both folds credited (got ${total})`);
    // Client-side /compact archives the pre-compaction blocks: every fold
    // block flips to active:false while its mass stays out of the wire.
    for (const b of ctx.session.state.blocks) b.active = false;
    // Mirrors src/web/sessions-data.ts:693-695 — before #4700 this derived
    // 0 here (dead counter + zero active blocks), which IS the reported bug.
    let blocksSaved = 0;
    for (const b of ctx.session.state.blocks) if (b.active !== false) blocksSaved += b.compressedTokens ?? 0;
    const displayed = Math.max(ctx.session.stats.tokensSaved ?? 0, blocksSaved);
    assert.equal(displayed, total, "SAVED keeps the lifetime total after deactivation");
    assert.ok(displayed > 0, "column no longer collapses to 0");
});
