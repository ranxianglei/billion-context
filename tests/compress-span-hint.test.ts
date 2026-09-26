// #1026: failed compress receipts must name the live compressible span so the
// model recovers in one retry instead of re-issuing refs an earlier fold
// already consumed (port of PR #1008's head commit, slimmed).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap, deactivateBlock } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, compressibleSpanHint, type RewriteCtx } from "../src/stream.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

const MESSAGES: CoreMessage[] = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
}));

function makeCtx(): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: MESSAGES,
        session: {
            id: "span-hint-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: (m: string) => { logs.push(m); },
        logs,
    };
}

/** refs m00001..m00080 + one ACTIVE kernel block covering m00002..m00020 */
function makeFoldedCtx(): Ctx {
    const ctx = makeCtx();
    ctx.session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
    const r = ctx.core.applyCompression({ ranges: [{ startRef: "m00002", endRef: "m00020", summary: "y".repeat(100) }], messages: MESSAGES, state: ctx.session.state, config: ctx.config });
    assert.equal(r.result.blocksCreated, 1, `seed fold must succeed: ${r.result.errors.join("; ")}`);
    ctx.session.state = r.state;
    return ctx;
}

test("#1026: hint names the raw span past the highest ACTIVE block boundary", () => {
    const ctx = makeFoldedCtx();
    const hint = compressibleSpanHint(ctx.session.state);
    assert.ok(hint.includes("m00021–m00080"), `span past boundary: ${hint}`);
    assert.ok(hint.includes("inside active blocks"), `explains the covered prefix: ${hint}`);
    // #1366: the covered-prefix claim must stay hedged — blocks need not be contiguous,
    // and a flat "everything up to N" misled a model into skipping a live gap.
    assert.ok(hint.includes("isolated free gaps may still exist"), `gap hedge present: ${hint}`);
});

test("#1026: INACTIVE blocks (decompressed) do not hold the boundary", () => {
    const ctx = makeFoldedCtx();
    ctx.session.state = deactivateBlock(ctx.session.state, [ctx.session.state.blocks[0]!.blockId]);
    const hint = compressibleSpanHint(ctx.session.state);
    assert.ok(hint.includes("m00001–m00080"), `decompressed block releases the boundary: ${hint}`);
});

test("#1026: exhausted refs fall back to compressing ACTIVE blocks by real id", () => {
    const ctx = makeCtx();
    ctx.session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
    // fake blocks: only the shape compressibleSpanHint reads
    ctx.session.state.blocks = [
        { blockId: "b7", endRef: "m00025", active: true },
        { blockId: "b11", endRef: "m00080", active: true },
        { blockId: "b13", endRef: "m00080", active: false },
    ] as never;
    const hint = compressibleSpanHint(ctx.session.state);
    assert.ok(hint.includes("compress a run of ACTIVE blocks"), `fallback wording: ${hint}`);
    assert.ok(hint.includes("startId b7, endId b11"), `real block ids, inactive excluded: ${hint}`);
});

test("#1026: no-valid-ranges receipt carries the live span", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeFoldedCtx();
    const out = applyRanges(parseCompressInput({ content: [{ summary: "no bounds" }] }), ctx);
    assert.ok(out.startsWith("[Compression FAILED"), `failure receipt: ${out}`);
    assert.ok(out.includes("Live compressible refs: m00021–m00080"), `span inside receipt: ${out}`);
});

test("#1026: blocksCreated=0 receipt carries the live span", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeFoldedCtx();
    // stale refs (never assigned) → kernel rejects the range → 0 blocks
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m09999", endId: "m09999", summary: "s" }] }), ctx);
    assert.ok(out.startsWith("[Compression FAILED"), `failure receipt: ${out}`);
    assert.ok(out.includes("Live compressible refs: m00021–m00080"), `span inside receipt: ${out}`);
});
