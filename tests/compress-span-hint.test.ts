// #1026: failed compress receipts must name the live compressible span so the
// model recovers in one retry instead of re-issuing refs an earlier fold
// already consumed (port of PR #1008's head commit, slimmed).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap, deactivateBlock } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, compressibleSpanHint, type RewriteCtx } from "../src/stream.ts";
import { liveCompressionRanges } from "../src/acp-status.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

function makeCtx(): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000, { preserveRecentMessages: 5, preserveRecentTokens: 0 }),
        messages: MESSAGES,
        session: {
            id: "span-hint-test",
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

/** refs m00001..m00080 + one ACTIVE kernel block covering m00001..m00020 */
function makeFoldedCtx(): Ctx {
    const ctx = makeCtx();
    ctx.session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
    const r = ctx.core.applyCompression({ ranges: [{ startRef: "m00001", endRef: "m00020", summary: "y".repeat(100) }], messages: MESSAGES, state: ctx.session.state, config: ctx.config });
    assert.equal(r.result.blocksCreated, 1, `seed fold must succeed: ${r.result.errors.join("; ")}`);
    ctx.session.state = r.state;
    return ctx;
}

test("#1026: hint uses live eligible ranges and excludes the protected tail", () => {
    const ctx = makeFoldedCtx();
    const hint = compressibleSpanHint(ctx);
    assert.ok(hint.includes("m00021–m00075"), `eligible span: ${hint}`);
    assert.ok(!hint.includes("m00080"), `protected tail is not advertised: ${hint}`);
});

test("#1026: INACTIVE blocks (decompressed) do not hold the boundary", () => {
    const ctx = makeFoldedCtx();
    ctx.session.state = deactivateBlock(ctx.session.state, [ctx.session.state.blocks[0]!.blockId]);
    ctx.session.state.blocks[0]!.expanded = true;
    const hint = compressibleSpanHint(ctx);
    assert.ok(hint.includes("m00001–m00075"), `decompressed block releases eligible history: ${hint}`);
});

test("#1026: exhausted refs do not blindly recommend an active-block merge", () => {
    const ctx = makeCtx();
    ctx.session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
    ctx.config = defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    const result = ctx.core.applyCompression({ ranges: [{ startRef: "m00001", endRef: "m00080", summary: "y".repeat(100) }], messages: MESSAGES, state: ctx.session.state, config: ctx.config });
    assert.equal(result.result.blocksCreated, 1);
    ctx.session.state = result.state;
    const hint = compressibleSpanHint(ctx);
    assert.match(hint, /continue the task without compressing/);
    assert.doesNotMatch(hint, /compress a run of ACTIVE blocks|startId b/);
});

test("#1026: no-valid-ranges receipt carries the live span", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeFoldedCtx();
    const out = applyRanges(parseCompressInput({ content: [{ summary: "no bounds" }] }), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED"), `failure receipt: ${out}`);
    assert.ok(out.includes("Current compressible ranges") && out.includes("m00021–m00075"), `eligible span inside receipt: ${out}`);
});

test("#1026: blocksCreated=0 receipt carries the live span", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeFoldedCtx();
    // stale refs (never assigned) → kernel rejects the range → 0 blocks
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m09999", endId: "m09999", summary: "s" }] }), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED"), `failure receipt: ${out}`);
    assert.ok(out.includes("Current compressible ranges") && out.includes("m00021–m00075"), `eligible span inside receipt: ${out}`);
});

// #2362: dead refs can never compress — the advertised live span must subtract
// them so a retry does not steer the model back into a doomed range.

test("#2362: dead refs are carved out of the advertised live span", () => {
    const ctx = makeFoldedCtx();
    ctx.session.state.deadRefs = ["m00041", "m00042", "m00055"];
    ctx.messages = ctx.messages.filter((m) => !ctx.session.state.deadRefs!.includes(ctx.session.state.messageRefs.byRaw[m.id]!));
    const hint = compressibleSpanHint(ctx);
    const live = liveCompressionRanges(ctx);
    assert.ok(live && live.ranges.length > 0);
    assert.match(hint, /Current compressible ranges/);
    for (const range of live.ranges) {
        assert.ok(!ctx.session.state.deadRefs.includes(range.startRef));
        assert.ok(!ctx.session.state.deadRefs.includes(range.endRef));
        const applied = ctx.core.applyCompression({ ranges: [{ startRef: range.startRef, endRef: range.endRef, summary: "retained source summary ".repeat(4) }], messages: ctx.messages, state: ctx.session.state, config: ctx.config });
        assert.equal(applied.result.blocksCreated, 1, applied.result.errors.join("; "));
    }
});

test("#2362: an all-dead span says there are no live raw refs and drops the retry push", () => {
    const ctx = makeFoldedCtx();
    const dead = Object.keys(ctx.session.state.messageRefs.byRef)
        .filter((r) => Number(r.slice(1)) > 20 && Number(r.slice(1)) <= 80);
    ctx.session.state.deadRefs = dead;
    ctx.messages = ctx.messages.filter((m) => !dead.includes(ctx.session.state.messageRefs.byRaw[m.id]!));
    const hint = compressibleSpanHint(ctx);
    assert.match(hint, /No eligible message ranges/);
    assert.ok(!hint.includes("Retry NOW"), `no retry push into a doomed span: ${hint}`);
});

test("#2362: failure receipts advertise the dead-subtracted span", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeFoldedCtx();
    ctx.session.state.deadRefs = ["m00041", "m00042", "m00055"];
    ctx.messages = ctx.messages.filter((m) => !ctx.session.state.deadRefs!.includes(ctx.session.state.messageRefs.byRaw[m.id]!));
    const out = applyRanges(parseCompressInput({ content: [{ summary: "no bounds" }] }), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED"), `failure receipt: ${out}`);
    assert.match(out, /Current compressible ranges/);
    assert.doesNotMatch(out, /m00041|m00042|m00055|m00080/);
});
