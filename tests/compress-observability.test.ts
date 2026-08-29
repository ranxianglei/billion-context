import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session, LastCompressInfo } from "../src/session.ts";
import { lastCompressSuffix } from "../src/session.ts";
import { maxShrinkPerCompress } from "../src/fetch-util.ts";
import { withStagedCompressGuidance } from "../src/compress-tool.ts";
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
            id: "compress-obs-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
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
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
    ]));
}

const COMPRESS_ARGS = { content: [{ startId: "m00001", endId: "m00002", summary: "OBS-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] };

function runApply(ctx: Ctx, args: unknown): string {
    const ranges = parseCompressInput(args);
    return applyRanges(ranges, ctx);
}

test("#189: applyRanges records lastCompress (shrink ratio + fold point) and logs observability", () => {
    const ctx = makeCompressibleCtx();
    ctx.session.stats.lastInputTokens = 100000;
    const out = runApply(ctx, COMPRESS_ARGS);
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out}`);
    const lc = ctx.session.lastCompress;
    assert.ok(lc, "lastCompress recorded");
    assert.ok(lc!.shrinkRatio > 0, `shrinkRatio > 0 (got ${lc!.shrinkRatio})`);
    assert.ok(lc!.shrinkRatio <= 1, `shrinkRatio <= 1 (got ${lc!.shrinkRatio})`);
    assert.equal(lc!.foldPoint, "m00001", "fold point is the earliest range start");
    assert.ok(lc!.blocks >= 1, "blocks >= 1");
    assert.ok(lc!.tokensCompressed > 0, "tokensCompressed > 0");
    assert.ok(lc!.at > 0, "timestamp set");
    const obs = ctx.logs.find((l) => l.includes("[acp-compress-obs]"));
    assert.ok(obs, "observability line logged");
    assert.ok(obs!.includes("foldPoint=m00001"), `obs has fold point: ${obs}`);
    assert.ok(obs!.includes("shrink"), `obs has shrink: ${obs}`);
});

test("#189: fold point picks the EARLIEST range start across multiple ranges", () => {
    const ctx = makeCompressibleCtx();
    ctx.session.stats.lastInputTokens = 100000;
    const args = { content: [
        { startId: "m00005", endId: "m00006", summary: "OBS-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" },
        { startId: "m00001", endId: "m00002", summary: "OBS-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" },
    ] };
    runApply(ctx, args);
    assert.equal(ctx.session.lastCompress?.foldPoint, "m00001", "earliest start wins regardless of arg order");
});

test("#189: no pre-compress context → shrinkRatio 0 (no div-by-zero), still records", () => {
    const ctx = makeCompressibleCtx();
    ctx.session.stats.lastInputTokens = 0;
    const out = runApply(ctx, COMPRESS_ARGS);
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out}`);
    assert.equal(ctx.session.lastCompress?.shrinkRatio, 0, "shrinkRatio 0 when preContext is 0");
});

test("#189: failed compress records no lastCompress", () => {
    const ctx = makeCompressibleCtx();
    ctx.session.stats.lastInputTokens = 100000;
    // Sub-viability range (kernel minCompressRange) → compress FAILS.
    const badArgs = { content: [{ startId: "m00007", endId: "m00007", summary: "s" }] };
    const out = runApply(ctx, badArgs);
    assert.ok(out.startsWith("[Compression FAILED"), `expected failure, got: ${out}`);
    assert.equal(ctx.session.lastCompress, undefined, "no lastCompress on failure");
});

test("#349: empty compress args → actionable no-valid-ranges message (missing-content)", () => {
    const ctx = makeCompressibleCtx();
    const out = runApply(ctx, {});
    assert.ok(out.startsWith("[Compression FAILED"), `expected failure, got: ${out}`);
    assert.ok(out.includes("non-empty 'content' array"), `steers to a content array: ${out}`);
    assert.ok(out.includes("startId, endId, summary"), `names the required fields: ${out}`);
    assert.ok(!out.includes("Check your startId/endId parameters"), "old misleading hint removed");
});

test("#189: staged-compress steering note appended when shrink exceeds the configured max", () => {
    const prev = process.env.BILI_MAX_SHRINK_PER_COMPRESS;
    process.env.BILI_MAX_SHRINK_PER_COMPRESS = "0.05";
    try {
        const ctx = makeCompressibleCtx();
        ctx.session.stats.lastInputTokens = 100000;
        const out = runApply(ctx, COMPRESS_ARGS);
        assert.ok(out.includes("[Staged-compress:"), `steering note present: ${out}`);
        assert.ok(out.includes("TAIL-biased"), "note steers toward tail-biased ranges");
    } finally {
        if (prev === undefined) delete process.env.BILI_MAX_SHRINK_PER_COMPRESS;
        else process.env.BILI_MAX_SHRINK_PER_COMPRESS = prev;
    }
});

test("#189: no steering note when the switch is off (default)", () => {
    const prev = process.env.BILI_MAX_SHRINK_PER_COMPRESS;
    delete process.env.BILI_MAX_SHRINK_PER_COMPRESS;
    try {
        const ctx = makeCompressibleCtx();
        ctx.session.stats.lastInputTokens = 100000;
        const out = runApply(ctx, COMPRESS_ARGS);
        assert.ok(!out.includes("[Staged-compress:"), `no note when switch off: ${out}`);
    } finally {
        if (prev !== undefined) process.env.BILI_MAX_SHRINK_PER_COMPRESS = prev;
    }
});

test("#189: no steering note when shrink is under the configured max", () => {
    const prev = process.env.BILI_MAX_SHRINK_PER_COMPRESS;
    process.env.BILI_MAX_SHRINK_PER_COMPRESS = "0.9";
    try {
        const ctx = makeCompressibleCtx();
        ctx.session.stats.lastInputTokens = 100000;
        const out = runApply(ctx, COMPRESS_ARGS);
        assert.ok(!out.includes("[Staged-compress:"), `no note when under max: ${out}`);
    } finally {
        if (prev === undefined) delete process.env.BILI_MAX_SHRINK_PER_COMPRESS;
        else process.env.BILI_MAX_SHRINK_PER_COMPRESS = prev;
    }
});

test("#189: lastCompressSuffix formats the correlation; empty when unset", () => {
    assert.equal(lastCompressSuffix(undefined), "");
    const info: LastCompressInfo = { at: 123, shrinkRatio: 0.57, foldPoint: "m00100", blocks: 3, tokensCompressed: 74000 };
    const s = lastCompressSuffix(info);
    assert.ok(s.includes("shrink 57%"), s);
    assert.ok(s.includes("foldPoint=m00100"), s);
    assert.ok(s.includes("blocks=3"), s);
    assert.ok(s.includes("~74000tok"), s);
});

test("#189: maxShrinkPerCompress parses the env fraction; rejects out-of-range", () => {
    const prev = process.env.BILI_MAX_SHRINK_PER_COMPRESS;
    try {
        delete process.env.BILI_MAX_SHRINK_PER_COMPRESS;
        assert.equal(maxShrinkPerCompress(), undefined, "unset → undefined");
        process.env.BILI_MAX_SHRINK_PER_COMPRESS = "0.3";
        assert.equal(maxShrinkPerCompress(), 0.3, "valid fraction");
        process.env.BILI_MAX_SHRINK_PER_COMPRESS = "0";
        assert.equal(maxShrinkPerCompress(), undefined, "0 → undefined");
        process.env.BILI_MAX_SHRINK_PER_COMPRESS = "1.5";
        assert.equal(maxShrinkPerCompress(), undefined, ">1 → undefined");
        process.env.BILI_MAX_SHRINK_PER_COMPRESS = "abc";
        assert.equal(maxShrinkPerCompress(), undefined, "non-numeric → undefined");
    } finally {
        if (prev === undefined) delete process.env.BILI_MAX_SHRINK_PER_COMPRESS;
        else process.env.BILI_MAX_SHRINK_PER_COMPRESS = prev;
    }
});

test("#189: withStagedCompressGuidance appends only when the switch is on", () => {
    const prev = process.env.BILI_MAX_SHRINK_PER_COMPRESS;
    try {
        delete process.env.BILI_MAX_SHRINK_PER_COMPRESS;
        assert.equal(withStagedCompressGuidance("NUDGE"), "NUDGE", "off → unchanged");
        process.env.BILI_MAX_SHRINK_PER_COMPRESS = "0.3";
        const out = withStagedCompressGuidance("NUDGE");
        assert.ok(out.startsWith("NUDGE"), "keeps the original nudge");
        assert.ok(out.includes("Smooth-transition guidance"), "appends guidance");
        assert.ok(out.includes("TAIL-biased"), "steers toward tail-biased ranges");
    } finally {
        if (prev === undefined) delete process.env.BILI_MAX_SHRINK_PER_COMPRESS;
        else process.env.BILI_MAX_SHRINK_PER_COMPRESS = prev;
    }
});
