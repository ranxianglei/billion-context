// #5558: with external-summary configured, a compress request whose ranges are
// ALL protected or already covered by an active block used to fall through to a
// generic "Compression FAILED ... protection checks" refused receipt — mislabeling
// an idempotent no-op as a fresh failure so a replaying model kept retrying. Now
// the external lane reuses the normal path's success-shaped no-op receipt (#4521):
// outcome "applied", reason "noop", zero blocks, NO payer call. Genuine kernel
// errors (too small / cannot anchor) keep the original refused receipt untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { applyConfiguredCompression } from "../src/external-summary-compress.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

function makeCtx(preserveRecentMessages: number): Ctx {
    const logs: string[] = [];
    const ctx: Ctx = {
        core: createCore(),
        config: defaultConfig(200000, { preserveRecentMessages, preserveRecentTokens: 0 }),
        messages: MESSAGES,
        session: {
            id: "issue5558-test",
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

function withExternalSummary(ctx: Ctx, preserveRecentMessages: number): Ctx {
    // summary.example.test never resolves: if the no-op path ever dispatched a
    // payer call the batch would fail and the outcome could not be "applied".
    ctx.config = {
        ...defaultConfig(200000, { preserveRecentMessages, preserveRecentTokens: 0 }),
        externalSummary: { enabled: true, targets: [{ name: "sum-sm", protocol: "openai", url: "https://summary.example.test/v1/chat/completions", model: "sm", apiKey: "sk-test-5558", contextWindow: 128000, outputTokens: 8192, stream: false }] },
    } as typeof ctx.config;
    return ctx;
}

// >= minSummaryLength (50): the normal path validates summary length, the ext
// path treats it as an ignored hint — one value satisfies both lanes.
const RANGE = () => ({ content: [{ startId: "m00010", endId: "m00040", summary: "y".repeat(100) }] });

test("#5558: fully protected range -> ext lane returns an applied no-op, not a failure", async () => {
    const ctx = withExternalSummary(makeCtx(75), 75); // last 75 protected => m00010..m00040 fully inside
    const res = await applyConfiguredCompression(RANGE(), ctx);
    assert.equal(res.outcome, "applied", `expected idempotent no-op, got: ${res.text}`);
    assert.equal(res.reason, "noop");
    assert.equal(res.blocksCreated, 0);
    assert.equal(ctx.session.state.blocks.length, 0, "no block created");
    assert.ok(res.text.startsWith("[Compression no-op"), `success-shaped receipt: ${res.text}`);
    assert.ok(res.text.includes("protected zone"), `receipt names the cause: ${res.text}`);
    // The whole point: no retry re-arm (breaker/streak) on a legal no-op.
    assert.equal(ctx.session.metadata["compressFailStreak"], undefined, "no failure streak recorded");
});

test("#5558: replaying an already-covered range -> ext lane reports the covering block as a no-op", async () => {
    const ctx = makeCtx(5);
    const setup = applyRanges(parseCompressInput(RANGE()), ctx);
    assert.equal(setup.outcome, "applied", `setup fold lands: ${setup.text}`);
    assert.equal(ctx.session.state.blocks.length, 1);
    const res = await applyConfiguredCompression(RANGE(), withExternalSummary(ctx, 5));
    assert.equal(res.outcome, "applied", `expected idempotent no-op, got: ${res.text}`);
    assert.equal(res.reason, "noop");
    assert.equal(res.blocksCreated, 0);
    assert.equal(ctx.session.state.blocks.length, 1, "existing covering block untouched, none added");
    assert.ok(res.text.startsWith("[Compression no-op"), `success-shaped receipt: ${res.text}`);
    assert.ok(res.text.includes("already covered"), `receipt names the covering block: ${res.text}`);
    assert.equal(ctx.session.metadata["compressFailStreak"], undefined, "no failure streak recorded");
});

test("#5558: a genuinely uncompressible range (too small) keeps the refused receipt", async () => {
    const ctx = makeCtx(5);
    ctx.messages = [{ id: "rawA", role: "user", text: "hi" }] as unknown as CoreMessage[];
    ctx.session.state.messageRefs = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    withExternalSummary(ctx, 5);
    const res = await applyConfiguredCompression({ content: [{ startId: "m00001", endId: "m00001", summary: "hint" }] }, ctx);
    assert.equal(res.outcome, "refused", `genuine kernel error must stay refused: ${res.text}`);
    assert.equal(res.blocksCreated, 0);
    assert.ok(res.text.startsWith("[Compression FAILED"), `original genuine-error receipt preserved: ${res.text}`);
});

test("#5558: the shared no-op receipt did not change the normal path (applyRanges)", async () => {
    const ctx = makeCtx(5);
    applyRanges(parseCompressInput(RANGE()), ctx); // establish coverage
    const res = applyRanges(parseCompressInput(RANGE()), ctx);
    assert.equal(res.outcome, "applied", `normal path no-op intact: ${res.text}`);
    assert.equal(res.reason, "noop");
    assert.ok(res.text.startsWith("[Compression no-op"), `normal path uses the same receipt owner: ${res.text}`);
});
