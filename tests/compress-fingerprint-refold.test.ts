// #1294: compress receipt carries a per-block summary fingerprint (P1) and an
// inline decompress ends with the frozen re-fold hint carrying the kernel K1
// refs (P2). Deterministic unit coverage only — the in-place refold e2e
// (compress → inline decompress → refold updates the SAME block id) requires
// the acp-kernel refold-in-place branch (#398) and is exercised manually on
// top of an overlaid kernel build.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressionState, CoreMessage } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [] as CoreMessage[],
        session: {
            id: `fpr-${Math.random().toString(36).slice(2)}`,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
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

/** n small alternating messages appended AFTER the case's own turns so every
 *  test keeps a realistic "recent activity" tail; protection is disabled in
 *  seedTurn instead (see there), so ranges address only the head messages. */
function tail(n: number): Array<[string, string]> {
    return Array.from({ length: n }, (_, i): [string, string] => [i % 2 === 0 ? "user" : "assistant", `recent ${i}`]);
}

function seedTurn(ctx: Ctx, head: Array<[string, string]>, tailN = 5): void {
    const turns = [...head, ...tail(tailN)];
    const msgs: CoreMessage[] = turns.map(([role, text], i) => ({ id: `raw${i}`, role: role as "user" | "assistant", contentType: "text", text }));
    ctx.messages = msgs;
    ctx.session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
    // Disable the kernel's soft protected zone (last-N msgs / last-N tokens /
    // last user message) so small deterministic seeds are compressible at any
    // ref; production defaults (5 msgs / 5000 tokens) stay asserted elsewhere.
    ctx.config.preserveRecentMessages = 0;
    ctx.config.preserveRecentTokens = 0;
    ctx.config.compress.minCompressRange = 0;
    ctx.config.compress.minSummaryLength = 0;
}

function storedSummary(state: CompressionState, blockId: string): string {
    const block = state.blocks.find((b) => b.blockId === blockId);
    assert.ok(block, `block ${blockId} exists in state`);
    return block.summary;
}

/** m-ref span of a block from its recorded coverage (null when unresolvable). */
function spanOf(state: CompressionState, blockId: string): [string, string] | null {
    const block = state.blocks.find((b) => b.blockId === blockId);
    if (!block) return null;
    const nums: number[] = [];
    for (const raw of block.effectiveMessageIds) {
        const m = /^m(\d+)$/.exec(state.messageRefs.byRaw[raw] ?? "");
        if (m) nums.push(Number(m[1]));
    }
    if (nums.length === 0) return null;
    const pad = (x: number) => `m${String(x).padStart(5, "0")}`;
    return [pad(Math.min(...nums)), pad(Math.max(...nums))];
}

test("#1294 P1: long two-section summary yields an exact fingerprint line", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [
        ["user", "A historical exchange covering setup steps."],
        ["assistant", "x".repeat(3000)],
        ["user", "Follow-up questions about the configuration."],
        ["assistant", "y".repeat(3000)],
    ]);
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", summary: "First section describing the initial exploration and decisions made.\nSecond section capturing the tool outputs consumed along the way." }] }), ctx);
    assert.ok(out.startsWith("[Compressed m00001–m00004 → 1 block(s)"), out.split("\n")[0]);
    const s = storedSummary(ctx.session.state, "b1");
    const head = s.slice(0, 30).replace(/\r?\n/g, " ");
    const tailText = s.slice(-100).replace(/\r?\n/g, " ");
    assert.ok(out.includes(`\n · b1 summary ${s.length}ch · head "${head}" … tail "${tailText}"`), out);
    assert.equal(out.split("\n").length, 2, "one header line + one fingerprint line (embedded newline flattened inside)");
});

test("#1294 P1: short summary (< 30 chars) — head equals tail equals the whole summary", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "hello there"], ["assistant", "x".repeat(500)]]);
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "tiny fold" }] }), ctx);
    assert.ok(out.includes(`\n · b1 summary 9ch · head "tiny fold" … tail "tiny fold"`), out);
});

test("#1294 P1: mixed CJK/Latin summary with newlines is flattened deterministically", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "配置说明与 discussion"], ["assistant", "z".repeat(500)]]);
    const summary = "第一段中文摘要：记录了构建流程。\n第二段 mixed Latin and 中文 continuation padding to cross the thirty character head boundary clearly.";
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary }] }), ctx);
    const s = storedSummary(ctx.session.state, "b1");
    const head = s.slice(0, 30).replace(/\r?\n/g, " ");
    const tailText = s.slice(-100).replace(/\r?\n/g, " ");
    assert.ok(out.includes(`\n · b1 summary ${s.length}ch · head "${head}" … tail "${tailText}"`), out);
    assert.ok(head.includes(" "), "newline inside the head window became a space");
});

test("#1294 P1: one fingerprint line per created block in a multi-range call", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [
        ["user", "early part"], ["assistant", "a".repeat(1000)],
        ["user", "middle part"], ["assistant", "b".repeat(1000)],
    ]);
    const out = applyRanges(parseCompressInput({ content: [
        { startId: "m00001", endId: "m00002", summary: "early summary one" },
        { startId: "m00003", endId: "m00004", summary: "late summary two" },
    ] }), ctx);
    assert.match(out, /→ 2 block\(s\)/, out.split("\n")[0]);
    const s1 = storedSummary(ctx.session.state, "b1");
    const s2 = storedSummary(ctx.session.state, "b2");
    assert.ok(out.includes(`\n · b1 summary ${s1.length}ch · head "early summary one" … tail "early summary one"`), out);
    assert.ok(out.includes(`\n · b2 summary ${s2.length}ch · head "late summary two" … tail "late summary two"`), out);
});

test("#1294 P1: a failed re-compress emits no fingerprint lines and keeps its receipt shape", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "hello there"], ["assistant", "x".repeat(500)]]);
    const ok = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "one" }] }), ctx);
    assert.ok(ok.includes("tokens saved"), ok);
    const again = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "two" }] }), ctx);
    assert.ok(again.startsWith("[Compression FAILED"), again.split("\n")[0]);
    assert.doesNotMatch(again, /… tail "/);
});

test("#1294 P2: inline decompress ends with the frozen re-fold hint and exact K1 refs", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "setup steps discussed early"], ["assistant", "a".repeat(400)]]);
    const applied = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "Early history covered the initial setup conversation between user and assistant." }] }), ctx);
    assert.ok(applied.includes("tokens saved"), applied);
    const [lo, hi] = spanOf(ctx.session.state, "b1")!;
    const out = resolveDecompress({ blockId: "b1" }, ctx);
    assert.match(out, /^\[Block b1 content/, out.slice(0, 60));
    assert.ok(out.endsWith(`\n\nRe-fold: call compress("${lo}–${hi}", <fresh summary>) → updates block b1 in place (same id, new summary).`), out);
});

test("#1294 P2: spans that are not derivable degrade to the generic hint (no refs)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "hello there"], ["assistant", "x".repeat(500)]]);
    const applied = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "Short stored summary for the degraded-hint path." }] }), ctx);
    assert.ok(applied.includes("tokens saved"), applied);
    // Strip the kernel's recorded span (multi-segment / older-generation
    // blocks carry no start/end refs) so resolveBlockSpan falls through to the
    // byRaw lookup — which we also wipe — forcing the undecidable-span path.
    for (const b of ctx.session.state.blocks) {
        if (b.blockId === "b1") { delete b.startRef; delete b.endRef; }
    }
    ctx.session.state.messageRefs.byRaw = {};
    const out = resolveDecompress({ blockId: "b1" }, ctx);
    assert.ok(out.endsWith("\n\nRe-fold: call compress over the restored messages with a fresh summary → updates block b1 in place (same id, new summary)."), out);
});

test("#1294 P2: large bodies spill to a temp file and carry NO re-fold hint", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "big payload"], ["assistant", "q".repeat(12000)]]);
    const applied = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "Large assistant output folded away; see the block for the full body when needed again." }] }), ctx);
    assert.ok(applied.includes("tokens saved"), applied);
    const out = resolveDecompress({ blockId: "b1" }, ctx);
    assert.match(out, /written to:\s*\S+/, out.slice(0, 200));
    assert.doesNotMatch(out, /Re-fold:/, "toFile path stays byte-identical to before");
});
