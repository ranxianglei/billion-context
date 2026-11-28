import { test } from "node:test";
import assert from "node:assert/strict";
import { assignRefs, createCore, createInitialState, emptyRefMap, type Config } from "acp-kernel";
import { rewriteJsonResponse, applyRanges } from "../src/stream.ts";
import type { Session } from "../src/session.ts";
import { parseCompressInput } from "../src/compress-tool.ts";

function makeTestCtx(id = "test-friction") {
    const core = createCore();
    const config = { modelContextLimit: 200000, compress: { minCompressRange: 100 } } as Config;
    const session: Session = {
        id,
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
    };
    return {
        core,
        config,
        messages: [
            { id: "m1", role: "user" as const, contentType: "text" as const, text: "hello ".repeat(30) },
            { id: "m2", role: "assistant" as const, contentType: "text" as const, text: "world ".repeat(30) },
            { id: "m3", role: "user" as const, contentType: "text" as const, text: "next question" },
        ],
        session,
        log: () => {},
    };
}

test("rewriteJsonResponse drops proxy tool failure text instead of leaking FAILED to client text blocks", () => {
    const ctx = makeTestCtx();
    const body = {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [
            {
                type: "tool_use",
                id: "call_compress",
                name: "compress",
                input: {
                    content: [
                        { startId: "m99998", endId: "m99999", summary: "invalid non-existent range" }
                    ]
                }
            }
        ],
        stop_reason: "tool_use"
    };

    const rewritten = rewriteJsonResponse(structuredClone(body), ctx) as {
        content: Array<{ type: string; text?: string }>;
        stop_reason: string;
    };

    const textBlocks = rewritten.content.filter((c) => c.type === "text");
    for (const blk of textBlocks) {
        assert.ok(!blk.text?.includes("Compression FAILED"), `Leaked failure to client text: ${blk.text}`);
    }
    assert.equal(rewritten.stop_reason, "end_turn");
});

test("rewriteJsonResponse preserves successful proxy tool result notes", () => {
    const ctx = makeTestCtx();
    ctx.session.state.messageRefs = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 }).map;

    const body = {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [
            {
                type: "tool_use",
                id: "call_compress",
                name: "compress",
                input: {
                    content: [
                        { startId: "m00001", endId: "m00002", summary: "valid summary of initial turns" }
                    ]
                }
            }
        ],
        stop_reason: "tool_use"
    };

    const rewritten = rewriteJsonResponse(structuredClone(body), ctx) as {
        content: Array<{ type: string; text?: string }>;
        stop_reason: string;
    };

    const textBlocks = rewritten.content.filter((c) => c.type === "text");
    assert.equal(textBlocks.length, 1);
    assert.ok(textBlocks[0].text?.includes("Compressed"), "Expected successful Compressed block");
    assert.equal(rewritten.stop_reason, "end_turn");
});

test("applyRanges provides idempotent ack when re-submitting an already covered range", () => {
    const ctx = makeTestCtx();
    ctx.session.state.messageRefs = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 }).map;

    const input = parseCompressInput({
        content: [
            { startId: "m00001", endId: "m00002", summary: "initial compression" }
        ]
    });

    const firstResult = applyRanges(input, ctx);
    assert.equal(firstResult.outcome, "applied");
    assert.ok(firstResult.text.includes("Compressed m00001–m00002"));

    const secondInput = parseCompressInput({
        content: [
            { startId: "m00001", endId: "m00002", summary: "re-submitted compression" }
        ]
    });
    const secondResult = applyRanges(secondInput, ctx);

    assert.notEqual(secondResult.outcome, "refused");
    assert.ok(!secondResult.text.includes("Compression FAILED"), `Unexpected failure: ${secondResult.text}`);
    assert.ok(secondResult.text.includes("already covered") || secondResult.text.includes("idempotent") || secondResult.text.includes("Compressed"), `Expected idempotent ack, got: ${secondResult.text}`);
});
