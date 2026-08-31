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

test("#362: parse-level rejections surface per-entry reasons in the model-facing error", () => {
    const out = applyRanges(
        parseCompressInput({ content: [{ summary: "no bounds" }, { startId: "m00001", endId: "m00002" }] }),
        makeCtx(),
    );
    assert.ok(out.startsWith("[Compression FAILED"), `expected failure, got: ${out}`);
    assert.ok(out.includes("kind=no-valid-ranges"), `kind reported, got: ${out}`);
    assert.ok(out.includes("dropped=2"), `dropped count reported, got: ${out}`);
    assert.ok(out.includes("- entry 0: missing range bounds"), "reason for entry 0 present");
    assert.ok(out.includes("- entry 1: missing summary"), "reason for entry 1 present");
});

test("#362: shape drift (content vs ranges key) reports kind=missing-content", () => {
    const out = applyRanges(
        parseCompressInput({ ranges: [{ startId: "m00001", endId: "m00002", summary: "s" }] }),
        makeCtx(),
    );
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
