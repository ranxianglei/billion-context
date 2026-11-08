import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { noteTruncatedUpstream, truncatedUpstreamOf, TRUNCATED_UPSTREAM_MAX_AGE_MS } from "../src/session.ts";
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
            id: "truncated-upstream-test",
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

function makeCompressibleCtx(): Ctx {
    const messages: CoreMessage[] = [
        { id: "raw_1", role: "user", contentType: "text", text: "x".repeat(20000) },
        { id: "raw_2", role: "assistant", contentType: "text", text: "x".repeat(20000) },
        { id: "raw_3", role: "user", contentType: "text", text: "x".repeat(5000) },
        { id: "raw_4", role: "assistant", contentType: "text", text: "x".repeat(5000) },
    ];
    const ctx = makeCtx(messages);
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

function runApply(ctx: Ctx, args: unknown): string {
    const ranges = parseCompressInput(args);
    return applyRanges(ranges, ctx).text;
}

// Positive: the stamp is what distinguishes a cut stream from a genuinely empty
// model call. Without this branch the #1366 receipt tells the model not to
// re-issue, which abandons a compression that a plain retry would complete.
test("#5981: empty args from a truncated stream get a re-issue receipt, not the no-re-issue one", () => {
    const ctx = makeCompressibleCtx();
    noteTruncatedUpstream(ctx.session, "openai", "read-error");
    const out = runApply(ctx, {});
    assert.ok(out.includes("ARGUMENTS LOST IN TRANSIT"), out);
    assert.ok(out.includes("RE-ISSUE the compress call"), out);
    assert.ok(out.includes("openai") && out.includes("read-error"), `names the transport cause: ${out}`);
    assert.ok(!out.includes("Do NOT re-issue"), "must not forbid the one correct action: " + out);
    assert.ok(out.includes("ONE 'content' STRING"), `keeps the retry target actionable: ${out}`);
});

test("#5981: the lost-in-transit receipt does not charge the model's failure ledgers", () => {
    const ctx = makeCompressibleCtx();
    noteTruncatedUpstream(ctx.session, "openai", "read-error");
    runApply(ctx, {});
    assert.equal(ctx.session.metadata["compressFailKeys"], undefined, "no #847 streak recorded for a transport failure");
});

// Negative direction (gate discipline, #3617): with no stamp the #1366 receipt
// must stay byte-identical — an empty companion call authored by the model is
// still not a re-issuable spec.
test("#5981: without a stamp the #1366 no-re-issue receipt is unchanged", () => {
    const ctx = makeCompressibleCtx();
    const out = runApply(ctx, {});
    assert.ok(out.includes("carried no content at all"), out);
    assert.ok(out.includes("Do NOT re-issue an empty call"), out);
    assert.ok(!out.includes("ARGUMENTS LOST IN TRANSIT"), "no truncation story without a stamp: " + out);
});

test("#5981: a stamp older than the TTL is treated as absent", () => {
    const ctx = makeCompressibleCtx();
    noteTruncatedUpstream(ctx.session, "openai", "read-error");
    const stamp = ctx.session.transient!.truncatedUpstream!;
    stamp.at = Date.now() - TRUNCATED_UPSTREAM_MAX_AGE_MS - 1;
    const out = runApply(ctx, {});
    assert.ok(out.includes("Do NOT re-issue an empty call"), out);
    assert.ok(!out.includes("ARGUMENTS LOST IN TRANSIT"), out);
});

test("#5981: reading the stamp does not consume it (one cut stream may dispatch several calls)", () => {
    const ctx = makeCompressibleCtx();
    noteTruncatedUpstream(ctx.session, "openai", "eof");
    const first = truncatedUpstreamOf(ctx.session);
    const second = truncatedUpstreamOf(ctx.session);
    assert.ok(first !== undefined && second !== undefined, "both reads see the stamp");
    assert.equal(first!.cause, "eof");
    const out = runApply(ctx, {});
    assert.ok(out.includes("ARGUMENTS LOST IN TRANSIT"), out);
});
