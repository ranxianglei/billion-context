// #7890: the "too small" refusal for a span that is inherently below the
// minimum in a LARGE conversation used to carry only the kernel's fixable-
// shaped "Combine more messages" advice — no stop signal — so the model
// walked spec space probing range variants of the same doomed span (11
// distinct too-small probes in one turn in the incident). The receipt must
// say the size is a property of the content, not the call shape, and stop
// the retry for this turn. Boundaries: the sub-floor-CONVERSATION case keeps
// the #1124 verdict without a double hint; a mixed batch (unknown refs +
// too small) keeps the ref-fixing advice; an armed breaker keeps its single
// hard-stop paragraph (one instruction per receipt, #2360 §2).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [] as CoreMessage[],
        session: {
            id: "issue7890-stop-hint",
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

function seedTurn(ctx: Ctx, turns: Array<[string, string]>): void {
    const msgs: CoreMessage[] = turns.map(([role, text], i) => ({ id: `raw${i}`, role: role as "user" | "assistant", text })) as unknown as CoreMessage[];
    ctx.messages = msgs;
    ctx.session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
}

const LONG_SUMMARY = "summary of a large conversation used by the too-small stop-hint cases";
const STOP_HINT = "do not retry this range in this turn";

// m00001–m00002 are tiny; m00003 is 6000 chars, so the conversation as a
// whole clears the 5000-char floor while the requested span cannot.
function seedLargeConversation(ctx: Ctx): void {
    seedTurn(ctx, [["user", "hello"], ["assistant", "hi"], ["user", "x".repeat(6000)]]);
}

test("#7890: small span in a large conversation gets the stop-retrying hint", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedLargeConversation(ctx);
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: LONG_SUMMARY }] }), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED"), out);
    assert.ok(out.includes("Total compressible content too small"), `kernel reason preserved: ${out}`);
    assert.ok(out.includes("Combine more messages"), `kernel advice preserved: ${out}`);
    assert.ok(out.includes("That size is a property of the content, not the call shape"), `content-property framing present: ${out}`);
    assert.ok(out.includes(STOP_HINT), `stop hint present: ${out}`);
    assert.ok(!out.includes("do not retry compress or call acp_status"), `#1124 verdict stays out of the large-conversation case: ${out}`);
});

test("#7890: sub-floor conversation keeps the #1124 verdict without the new hint", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "hello"], ["assistant", "hi there"]]);
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: LONG_SUMMARY }] }), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED"), out);
    assert.ok(out.includes("do not retry compress or call acp_status"), `#1124 verdict intact: ${out}`);
    assert.ok(!out.includes(STOP_HINT), `no double hint: ${out}`);
});

test("#7890: mixed batch (unknown ref + too small) keeps ref-fixing advice, no stop hint", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedLargeConversation(ctx);
    const out = applyRanges(parseCompressInput({ content: [
        { startId: "m00001", endId: "m00002", summary: LONG_SUMMARY },
        { startId: "m09999", endId: "m09999", summary: LONG_SUMMARY },
    ] }), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED"), out);
    assert.ok(out.includes("too small"), `too-small class still reported: ${out}`);
    assert.ok(!out.includes(STOP_HINT), `mixed batch keeps the ref-fixing advice: ${out}`);
});

test("#7890: minCompressRange 0 — no size gate, no hint", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    ctx.config.compress.minCompressRange = 0;
    seedTurn(ctx, [["user", "hello"], ["assistant", "hi there"]]);
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: LONG_SUMMARY }] }), ctx).text;
    assert.ok(!out.includes("too small"), out);
    assert.ok(!out.includes(STOP_HINT), out);
});

test("#7890: armed breaker (3rd consecutive failure) keeps the single hard-stop paragraph", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedLargeConversation(ctx);
    const spec = { content: [{ startId: "m00001", endId: "m00002", summary: LONG_SUMMARY }] };
    const first = applyRanges(parseCompressInput(spec), ctx).text;
    assert.ok(first.includes(STOP_HINT), `first failure carries the hint: ${first}`);
    const second = applyRanges(parseCompressInput(spec), ctx).text;
    assert.ok(second.includes(STOP_HINT), `second failure still diagnostic: ${second}`);
    const third = applyRanges(parseCompressInput(spec), ctx).text;
    assert.ok(third.includes("COMPRESS CIRCUIT BREAKER"), `breaker armed on third failure: ${third}`);
    assert.ok(!third.includes(STOP_HINT), `armed receipt keeps one instruction: ${third}`);
});
