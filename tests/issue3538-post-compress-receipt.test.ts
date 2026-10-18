// #3538: a successful compress receipt reminds the model that folding history
// completes no task — the observed drift reworded open acceptance criteria as
// delivered inside summaries, then closed out on the rewritten state. The note
// is model-facing only; the server log copy stays excerpt-free (#1718).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";

const NOTE = "Compression only folds history — it completes no task.";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [] as CoreMessage[],
        session: {
            id: `i3538-${Math.random().toString(36).slice(2)}`,
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

function seed(ctx: Ctx): [string, string] {
    const turns: Array<[string, string]> = [];
    for (let i = 0; i < 12; i++) {
        turns.push([i % 2 === 0 ? "user" : "assistant", `message ${i} ${"filler ".repeat(20)}`]);
    }
    const msgs: CoreMessage[] = turns.map(([role, text], i) => ({ id: `raw${i}`, role: role as "user" | "assistant", contentType: "text", text }));
    ctx.messages = msgs;
    ctx.session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
    ctx.config.preserveRecentMessages = 0;
    ctx.config.preserveRecentTokens = 0;
    ctx.config.compress.minCompressRange = 0;
    ctx.config.compress.minSummaryLength = 0;
    return ["m00001", "m00012"];
}

test("successful compress receipt carries the task-state reminder (#3538)", () => {
    const ctx = makeCtx();
    const [start, end] = seed(ctx);
    const result = applyRanges(
        parseCompressInput({ content: [{ startId: start, endId: end, summary: "Folded early work.\nOpen objectives: ship feature B (m00001)." }] }),
        ctx,
    );
    assert.equal(result.outcome, "applied", result.text);
    assert.ok(result.text.includes(NOTE), `model-facing receipt keeps the reminder, got: ${result.text}`);
    assert.ok(result.text.includes("re-check every still-unmet acceptance criterion"), "reminder points at the Open objectives entries");
    assert.ok(!ctx.logs.some((line) => line.includes(NOTE)), "server log copy stays free of the reminder");
});

test("refused compress receipts do not carry the reminder (#3538)", () => {
    const ctx = makeCtx();
    const [, end] = seed(ctx);
    const result = applyRanges(
        parseCompressInput({ content: [{ startId: "m99999", endId: end, summary: "unknown refs" }] }),
        ctx,
    );
    assert.notEqual(result.outcome, "ok");
    assert.ok(!result.text.includes(NOTE), "no success reminder on failure receipts");
});
