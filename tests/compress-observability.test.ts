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
import { getCacheLedger } from "../src/cache-ledger.ts";

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

test("#1911: no usage baseline → shrinkRatio is the view coverage, never 0 or >1", () => {
    const ctx = makeCompressibleCtx();
    ctx.session.stats.lastInputTokens = 0;
    const out = runApply(ctx, COMPRESS_ARGS);
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out}`);
    const ratio = ctx.session.lastCompress?.shrinkRatio;
    assert.ok(ratio !== undefined && ratio > 0 && ratio <= 1, `coverage-based ratio in (0,1] (got ${ratio})`);
    const obs = ctx.logs.find((l) => l.includes("[acp-compress-obs]"));
    assert.ok(obs!.includes("~10000/16250"), `view-space denominator in obs: ${obs}`);
    assert.ok(obs!.includes("postCtx≈6250"), `post-fold context measured from the view, not the billed baseline: ${obs}`);
});

test("#1911: stale-low baseline cannot produce shrink>100% or postCtx≈0 artifacts", () => {
    const ctx = makeCompressibleCtx();
    ctx.session.stats.lastInputTokens = 1000;
    const out = runApply(ctx, COMPRESS_ARGS);
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out}`);
    assert.equal(Math.round(ctx.session.lastCompress!.shrinkRatio * 100), 62, "ratio is coverage of the live view (10000/16250), never 1000%");
    const obs = ctx.logs.find((l) => l.includes("[acp-compress-obs]"));
    assert.ok(obs!.includes("shrink 62%"), `impossible ratio gone: ${obs}`);
    assert.ok(obs!.includes("~10000/16250"), obs);
    assert.ok(obs!.includes("postCtx≈6250"), `postCtx from the view, not clamped to 0: ${obs}`);
    assert.ok(!ctx.logs.some((l) => l.includes("[warn: degenerate-fold]")), "a partial fold is not a degenerate reset");
    assert.equal(ctx.session.stats.compressCreditTokens, 10000, "credit still accumulates for the usage netting");
    assert.equal(ctx.session.stats.lastInputTokens, 0, "billed baseline keeps master's plain netting clamp — a post-fold estimate must not enter the usage-grade field (#1592/#1839 provenance)");
});

test("#1911: healthy baseline keeps the exact old netting", () => {
    const ctx = makeCompressibleCtx();
    ctx.session.stats.lastInputTokens = 100000;
    runApply(ctx, COMPRESS_ARGS);
    assert.equal(ctx.session.stats.lastInputTokens, 90000, "netted below the folded mass → unchanged behavior");
});

test("#1911: full-context fold reports honest 100%/postCtx≈0 and gets the degenerate-reset warn marker", () => {
    const ctx = makeCompressibleCtx();
    ctx.config.preserveRecentMessages = 0;
    ctx.config.preserveRecentTokens = 0;
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00007", summary: "OBS-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 120)}`);
    const obs = ctx.logs.find((l) => l.includes("[acp-compress-obs]"));
    assert.ok(obs!.includes("shrink 100%"), `full coverage reported honestly: ${obs}`);
    assert.ok(obs!.includes("postCtx≈0"), obs);
    const warn = ctx.logs.find((l) => l.includes("[warn: degenerate-fold]"));
    assert.ok(warn, "degenerate reset carries its own warn marker for host-side auditing");
    assert.ok(warn!.includes("covers 100% of the live context"), warn);
});

test("#1911: cache ledger fold stores live-view geometry (V/Vp), never the billed baseline", () => {
    const ctx = makeCompressibleCtx();
    ctx.session.stats.lastInputTokens = 100000; // billed scalar — pre-fix code stored this as V
    getCacheLedger(ctx.session); // production: ledger predates its first compress (bootstrap lastBlockId below the new block)
    runApply(ctx, COMPRESS_ARGS);
    const folds = getCacheLedger(ctx.session).folds;
    assert.equal(folds.length, 1, "one fold recorded");
    assert.equal(folds[0].S, 10000, "S = tokens removed from the view");
    assert.equal(folds[0].V, 16250, "V is the pre-fold LIVE view size, not the billed baseline");
    assert.equal(folds[0].Vp, 6250, "Vp is the post-fold live view");
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

test("#1366: truly-empty call gets the targeted no-re-issue receipt (no loop bait)", () => {
    const ctx = makeCompressibleCtx();
    const out = runApply(ctx, {});
    assert.ok(out.startsWith("[Compression FAILED"), `expected failure, got: ${out}`);
    assert.ok(out.includes("carried no content at all"), out);
    assert.ok(out.includes("kind=missing-content"), out);
    assert.ok(out.includes("Do NOT re-issue an empty call"), out);
    assert.ok(!out.includes("Re-issue the compress call with a valid content array"), "old loop-bait tail gone: " + out);
    assert.ok(out.includes("non-empty 'content' array") && out.includes("{startId, endId, summary}"), "#349 steering kept");
});

test("#1366: empty-string arguments get the same targeted receipt (kind=empty-input)", () => {
    const ctx = makeCompressibleCtx();
    const out = runApply(ctx, "");
    assert.ok(out.includes("carried no content at all"), out);
    assert.ok(out.includes("kind=empty-input"), out);
    assert.ok(!out.includes("Re-issue the compress call with a valid content array"), out);
});

test("#1366: empty calls are still recorded by the #847 repeat-failure guard", () => {
    const ctx = makeCompressibleCtx();
    runApply(ctx, {});
    const keys = ctx.session.metadata["compressFailKeys"] as unknown[];
    assert.equal(keys.length, 1, "failure recorded");
    assert.match(String(keys[0]), /^parse:missing-content:0:/, String(keys));
});

test("#1366/#362: shape drift ({ranges: …}) keeps the format lecture — re-issue IS right there", () => {
    const ctx = makeCompressibleCtx();
    const out = runApply(ctx, { ranges: [{ startId: "m00001", endId: "m00002", summary: "s" }] });
    assert.ok(out.includes("kind=missing-content"), out);
    assert.ok(out.includes("Re-issue ALL intended ranges in ONE compress call"), "lecture retained: " + out);
    assert.ok(!out.includes("carried no content at all"), "not mislabeled as empty: " + out);
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
