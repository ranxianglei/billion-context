// #1124 (piece 1 of the #1121 split; root-cause factor 3 of #1112): when the
// WHOLE visible conversation holds fewer tokens than compress.minCompressRange,
// NO range combination can succeed — the kernel sums range tokens against the
// single threshold. The failure receipt must say so conclusively instead of
// steering the model back into compress retries and acp_status/search_context
// inspection loops. Receipt tests only — re-applied standalone per the owner's
// split directive on #1121 (the surface-gating half stays out of scope).
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
            id: "fix-1124-receipt",
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

const LONG_SUMMARY = "summary of a tiny conversation used by the zero-floor control case";

test("#1124: sub-floor conversation gets a conclusive verdict, not retry advice", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "hello"], ["assistant", "hi there"]]);
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: LONG_SUMMARY }] }), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED"), out);
    assert.ok(out.includes("Total compressible content too small"), `kernel reason preserved: ${out}`);
    assert.ok(out.includes("do not retry compress or call acp_status/search_context"), `conclusive verdict present: ${out}`);
});

test("#1124: verdict only when NO range can succeed; a viable larger range keeps generic advice", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "hello"], ["assistant", "hi"], ["user", "x".repeat(6000)]]);
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: LONG_SUMMARY }] }), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED"), out);
    assert.ok(out.includes("Combine more messages"), `generic advice kept: ${out}`);
    assert.ok(!out.includes("do not retry compress"), `no conclusive verdict while a range could succeed: ${out}`);
});

test("#1124: minCompressRange 0 keeps legacy behavior (tiny compress is not size-rejected)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    ctx.config.compress.minCompressRange = 0;
    seedTurn(ctx, [["user", "hello"], ["assistant", "hi there"]]);
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: LONG_SUMMARY }] }), ctx).text;
    assert.ok(!out.includes("Total compressible content too small"), out);
    assert.ok(!out.includes("do not retry compress"), out);
});
