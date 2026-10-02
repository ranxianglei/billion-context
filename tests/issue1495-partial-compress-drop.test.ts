// #1495: 批量压缩静默丢条目 — kernel 的宽容解析器会从损坏的参数里抢救完整条目
// (被网关 stringify+截断的数组、单条损坏), 但 applyRanges 在"部分成功"时把
// invalidItems/invalidReasons/kind=truncated 全部丢掉: 模型收到干净的
// "[Compressed X, Y → 2 block(s)]" 回执, 第 3 条从未折叠却无任何失败说明.
// 非全量回执必须显式说出丢了什么(解析层拒绝、truncated salvage 丢失、apply 层逐条错误);
// 让部分应用可见、可补发.
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
            id: "issue1495-partial-drop-test",
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

const S = "PARTIAL-DROP-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK";

function freshCtx(): Ctx {
    // Default preserveRecentMessages: 5 → folding m00001–m00002 succeeds and
    // drains every compressible range (m00003–m00007 stay protected).
    const msgs = [
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
    ];
    const ctx = withRefs(makeCtx(msgs));
    ctx.session.stats.lastInputTokens = 80000;
    return ctx;
}

test("#1495: valid + invalid entry mix — success receipt names the rejected entry and its reason", () => {
    const out = applyRanges(parseCompressInput({ content: [
        { startId: "m00001", endId: "m00002", summary: S },
        { summary: "no bounds" },
    ]}), freshCtx());
    assert.ok(out.startsWith("[Compressed"), `partial success expected, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("1 of the submitted entry was REJECTED and NOT compressed"), `dropped entry must be named:\n${out}`);
    assert.ok(out.includes("entry 1: missing range bounds"), `rejection reason inline:\n${out}`);
});

test("#1495: truncated gateway-stringified array — salvage loss is named, lost range not listed as applied", () => {
    const complete = JSON.stringify({ startId: "m00001", endId: "m00002", summary: S });
    const damaged = `{"content": [${complete},{"startId":"m00003","endId":"m00004","sum`;
    const parsed = parseCompressInput(damaged);
    assert.equal(parsed.ranges.length, 1, "one complete entry salvaged");
    assert.equal(parsed.diagnostics.kind, "truncated");
    const ctx = freshCtx();
    const out = applyRanges(parsed, ctx);
    assert.ok(out.startsWith("[Compressed"), `salvage success expected, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("arrived TRUNCATED"), `truncation loss must be named:\n${out}`);
    assert.ok(out.includes("was LOST, not compressed"), `salvage loss guidance:\n${out}`);
    // #1495 追踪: 模型在有损网关下退回逐条调用 — 回执必须教它把补发合并回一次单字符串调用.
    assert.ok(out.includes("Re-issue ALL missing ranges TOGETHER in ONE new call"), `batch re-issue teaching:\n${out}`);
    assert.ok(out.includes("single plain string"), `single-string form teaching:\n${out}`);
    assert.ok(!out.includes("m00003–m00004"), "lost range must not appear in the applied detail:\n" + out);
    assert.ok(ctx.logs.some((l) => l.includes("compress PARTIAL") && l.includes("kind=truncated")), `server-side PARTIAL log for truncated salvage:\n${ctx.logs.join("\n")}`);
});

test("#1495: apply-layer per-range error surfaces on partial success (unknown refs)", () => {
    const out = applyRanges(parseCompressInput({ content: [
        { startId: "m00001", endId: "m00002", summary: S },
        { startId: "m00099", endId: "m00100", summary: S },
    ]}), freshCtx());
    assert.ok(out.startsWith("[Compressed"), `partial success expected, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("Errors:"), `apply-layer error must be surfaced:\n${out}`);
});

test("#1495: clean call — no drop/error annotation (existing output unchanged)", () => {
    const out = applyRanges(parseCompressInput({ content: [
        { startId: "m00001", endId: "m00002", summary: S },
    ]}), freshCtx());
    assert.ok(out.startsWith("[Compressed"), `success expected, got: ${out.slice(0, 160)}`);
    assert.ok(!out.includes("REJECTED"), `clean call must stay unannotated:\n${out}`);
    assert.ok(!out.includes("TRUNCATED"), `clean call must stay unannotated:\n${out}`);
    assert.ok(!out.includes("Errors:"), `clean call must stay unannotated:\n${out}`);
});
