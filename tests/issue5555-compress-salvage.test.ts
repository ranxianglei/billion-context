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
            id: "salvage-test",
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

function makeCompressibleCtx(): Ctx {
    return withRefs(makeCtx([
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
    ]));
}

const SUMMARY = "SALVAGE-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK";

function runApply(ctx: Ctx, args: unknown): string {
    const ranges = parseCompressInput(args);
    return applyRanges(ranges, ctx).text;
}

// #5555 false-ad sweep: post-#4252 compress takes ONE 'content' string, but models
// encode the OLD range object/array AS that JSON string (the qwen3-27b incident
// shape). decodeContentStringEntries must salvage both so the call succeeds instead
// of refusing kind=content-not-array. Pre-fix master refuses cases 1-3.

test("#5555: object-in-string content (the qwen3-27b incident shape) is salvaged and compresses", () => {
    const ctx = makeCompressibleCtx();
    const args = { content: JSON.stringify({ startId: "m00001", endId: "m00002", summary: SUMMARY }) };
    const out = runApply(ctx, args);
    assert.ok(out.startsWith("[Compressed"), `object-in-string must salvage+compress, got: ${out}`);
});

test("#5555: array-in-string content (JSON-encoded array carried as the string) is salvaged and compresses", () => {
    const ctx = makeCompressibleCtx();
    const args = { content: JSON.stringify([
        { startId: "m00001", endId: "m00002", summary: SUMMARY },
        { startId: "m00003", endId: "m00004", summary: SUMMARY },
    ]) };
    const out = runApply(ctx, args);
    assert.ok(out.startsWith("[Compressed"), `array-in-string must salvage+compress, got: ${out}`);
});

test("#5555: double-wrapped whole-string args (string args whose content is itself a JSON string) is salvaged", () => {
    const ctx = makeCompressibleCtx();
    const inner = { content: JSON.stringify({ startId: "m00001", endId: "m00002", summary: SUMMARY }) };
    const out = runApply(ctx, JSON.stringify(inner));
    assert.ok(out.startsWith("[Compressed"), `double-wrapped string args must salvage+compress, got: ${out}`);
});

test("#5555 negative control: a non-entries JSON string is NOT salvaged (guard stays strict)", () => {
    const ctx = makeCompressibleCtx();
    // Negative control: a scalar JSON string must NOT be adopted as entries (pins guard strictness).
    const out = runApply(ctx, { content: "42" });
    assert.ok(out.startsWith("[Compression FAILED"), `scalar JSON string must stay refused, got: ${out}`);
});
