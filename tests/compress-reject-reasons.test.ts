// #362诉求③: compress 参数被拒时, 拒绝原因(kernel invalidReasons)必须进入
// 模型可见的错误回执 — 否则模型只看到通用样板, 盲目重试同样的坏形状.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [] as CoreMessage[],
        session: {
            id: "reject-reasons-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 , retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
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

test("#362: parse-level rejections surface per-entry reasons in the model-facing error", () => {
    const out = applyRanges(
        parseCompressInput({ content: [{ summary: "no bounds" }, { startId: "m00001", endId: "m00002" }] }),
        makeCtx(),
    ).text;
    assert.ok(out.startsWith("[Compression FAILED"), `expected failure, got: ${out}`);
    assert.ok(out.includes("kind=no-valid-ranges"), `kind reported, got: ${out}`);
    assert.ok(out.includes("dropped=2"), `dropped count reported, got: ${out}`);
    // #1029: reasons are inlined on line 1 (the ❌ visibility marker keeps only
    // line 1 — the old bullet list reached clients as a dangling header).
    assert.ok(out.includes("entry 0: missing range bounds"), "reason for entry 0 present (inline)");
    assert.ok(out.includes("entry 1: missing summary"), "reason for entry 1 present (inline)");
});

test("#362: shape drift (content vs ranges key) reports kind=missing-content", () => {
    const out = applyRanges(
        parseCompressInput({ ranges: [{ startId: "m00001", endId: "m00002", summary: "s" }] }),
        makeCtx(),
    ).text;
    assert.ok(out.includes("kind=missing-content"), `kind reported, got: ${out}`);
    assert.ok(!out.includes("Rejected entries"), "no per-entry reasons for shape-level failure");
});

test("#362: truncated gateway-stringified args salvage complete entries, kind=truncated", () => {
    const complete = JSON.stringify({ startId: "m00001", endId: "m00002", summary: "complete entry" });
    const json = '{"content": [' + complete + ',{"startId":"m00003","sum';
    const parsed = parseCompressInput(json);
    assert.equal(parsed.ranges.length, 1, "complete entry salvaged");
    assert.equal(parsed.diagnostics.kind, "truncated");
});

test("#362: diagnostics flow — valid parse returns ranges + ok diagnostics", () => {
    const parsed = parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] });
    assert.equal(parsed.ranges.length, 1);
    assert.equal(parsed.diagnostics.ok, true);
    assert.equal(parsed.diagnostics.kind, "ok");
});

// ---------------------------------------------------------------------------
// Flat single-range: summary text in the content STRING + top-level bounds —
// the two schema-advertised shapes merged into one call. Live incident:
// six identical kind=content-not-array rejections in a single compress burst
// while the model retried the same valid-intent call.
// ---------------------------------------------------------------------------

test("flat single-range call with summary text in content parses (live incident shape)", () => {
    const parsed = parseCompressInput({
        content: "Investigated the repro loop; root cause was the parse gate rejecting valid payloads.",
        startId: "b114",
        endId: "b114",
        topic: "repro loop",
    });
    assert.equal(parsed.diagnostics.ok, true);
    assert.equal(parsed.diagnostics.flatSummarySalvage, true);
    assert.equal(parsed.ranges.length, 1);
    assert.equal(parsed.ranges[0]?.startRef, "b114");
    assert.equal(parsed.ranges[0]?.endRef, "b114");
    assert.ok(parsed.ranges[0]?.summary.startsWith("Investigated the repro loop"));
});

test("flat single-range salvage also unwraps a JSON-encoded summary object in content", () => {
    const parsed = parseCompressInput({
        content: JSON.stringify({ summary: "encoded summary body", topic: "inner" }),
        startId: "m00150",
        endId: "m00168",
    });
    assert.equal(parsed.diagnostics.ok, true);
    assert.equal(parsed.ranges[0]?.summary, "encoded summary body");
    assert.equal(parsed.ranges[0]?.topic, "inner");
});

test("line-form string content with refs headers is not redirected to flat salvage", () => {
    const parsed = parseCompressInput({
        content: "m00010–m00020 topic\nsummary line.",
        startId: "m00001",
        endId: "m00030",
    });
    assert.equal(parsed.diagnostics.ok, true);
    assert.equal(parsed.diagnostics.flatSummarySalvage, undefined);
    assert.equal(parsed.ranges[0]?.startRef, "m00010");
});

// ---------------------------------------------------------------------------
// #5949 field: v2 pointer echo ack + repeat-parse-failure receipt collapse
// ---------------------------------------------------------------------------

test("compress call echoing the v2 relocation pointer is acked as a no-op, not lectured", () => {
    const echo = { content: '{"content": "[bili] compression succeeded — summary relocated to its fold point above (block(s) b49); these ranges are already folded — do not re-compress them."}' };
    const ctx = makeCtx();
    const first = applyRanges(parseCompressInput(echo), ctx).text;
    assert.ok(first.startsWith("[bili: nothing was compressed"), `echo acked, got: ${first}`);
    assert.ok(!first.includes("Compression FAILED"), "echo is not a format failure");
    // No repeat-guard counter: the counter text was misread by the model as
    // "the user asked the same thing N times".
    assert.ok(!first.includes("Repeat-failure guard"), "no repeat-failure guard on echo");
    // Repeats stay counter-free acks (no failure streak accumulates).
    const second = applyRanges(parseCompressInput(echo), ctx).text;
    assert.ok(second.startsWith("[bili: nothing was compressed"), `repeat echo acked, got: ${second}`);
    assert.ok(!second.includes("Repeat-failure guard"), "no counter on repeat echo");
});

test("identical parse failures collapse to a one-line receipt from the 2nd on", () => {
    const bad = { content: "just prose with no refs at all" };
    const ctx = makeCtx();
    const first = applyRanges(parseCompressInput(bad), ctx).text;
    assert.ok(first.includes("compress takes ONE 'content' STRING"), `first failure keeps the full guide, got: ${first}`);
    const second = applyRanges(parseCompressInput(bad), ctx).text;
    assert.ok(second.includes("failed 2 time(s) the same way"), `second failure is a one-liner with the count, got: ${second}`);
    assert.ok(!second.includes("compress takes ONE 'content' STRING"), "format guide not repeated");
    assert.ok(!second.includes("Repeat-failure guard"), "single counter statement only");
    const third = applyRanges(parseCompressInput(bad), ctx).text;
    assert.ok(third.includes("failed 3 time(s) the same way"), `third failure keeps counting, got: ${third}`);
});
