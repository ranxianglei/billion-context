// #5161: external-summary mode drops `summary` from required in the advertised
// compress schema (src/external-summary-surface.ts adaptSchema), so the model's
// own compress calls carry {startId,endId,topic?} — no summary. Those calls
// stay visible while their blocks are active (hideConsumedCompressCalls leaves
// summary-less entries unchanged), and the #2749 guard re-parses EVERY visible
// past compress call on every fold (visibleSummaryStubs) — each summary-less
// entry failed validation ("missing summary") and logged one false
// `[acp-compress-input] rejected` warn per call per fold (~550/day in the
// report, bursts growing with session length). Fix: the scan parses quiet
// (parseCompressInput {quiet:true}). Guard outcome is unaffected: a summary-less
// entry yields no ranges and can never enter the stub set.
//
// Acceptance mapping (issue #5161):
//  - "N summary-less calls + one new compress logs zero rejected lines":
//    test "external-mode history stays silent".
//  - Gate both directions (#3617): a genuinely malformed LIVE call STILL logs
//    ("live path still reports"), and the quiet scan still parses and harvests
//    real stubs ("quiet scan still harvests stubs").
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { applyRanges, visibleSummaryStubs, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { setLogCapture } from "../src/logger.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [] as CoreMessage[],
        session: {
            id: `ext5161-${Math.random().toString(36).slice(2)}`,
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

// Same fixture discipline as tests/stub-resubmission-guard.test.ts: kernel soft
// protection disabled so small deterministic seeds are compressible at any ref.
function seedTurn(ctx: Ctx, head: Array<[string, string]>): void {
    const msgs: CoreMessage[] = head.map(([role, text], i) => ({ id: `raw${i}`, role: role as "user" | "assistant", contentType: "text", text }));
    ctx.messages = msgs;
    ctx.session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
    ctx.config.preserveRecentMessages = 0;
    ctx.config.preserveRecentTokens = 0;
    ctx.config.compress.minCompressRange = 0;
    ctx.config.compress.minSummaryLength = 0;
}

/** Run fn under the logger's programmatic capture seam and return its result
 *  plus every raw message line loggerLog emitted during fn. */
function withLogCapture<T>(fn: () => T): { result: T; lines: string[] } {
    const lines: string[] = [];
    setLogCapture((_level, msg) => { lines.push(msg); });
    try {
        return { result: fn(), lines };
    } finally {
        setLogCapture(null);
    }
}

const ACP_INPUT_LINES = (lines: string[]): string[] => lines.filter((l) => l.includes("[acp-compress-input]"));

test("#5161 external-mode history stays silent: N summary-less compress calls + one new compress logs zero [acp-compress-input] lines", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [
        ["user", "early setup exchange"], ["assistant", "a".repeat(1000)],
        ["user", "middle question"], ["assistant", "b".repeat(1000)],
        ["user", "late question"], ["assistant", "c".repeat(1000)],
    ]);
    // Past external-mode compress calls: the advertised schema makes summary
    // optional, so the model's args carry none. No block claims their call ids
    // ⇒ orphan ⇒ visible between folds (#3769) — the exact shape the #2749 scan
    // used to mis-log once per call per fold.
    const N = 3;
    const calls: CoreMessage[] = Array.from({ length: N }, (_, i) => ({
        id: `mc-ext${i + 1}`,
        role: "assistant" as const,
        contentType: "tool-call" as const,
        toolName: "compress",
        toolCallId: `call-ext${i + 1}`,
        text: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", topic: `T${i + 1}` }] }),
    }));
    const view = [...ctx.messages, ...calls];
    ctx.messages = view;
    ctx.session.state.messageRefs = assignRefs(view, { existing: emptyRefMap(), nextIndex: 0 }).map;
    const { result: out, lines } = withLogCapture(() =>
        applyRanges(parseCompressInput({ content: [{ startId: "m00003", endId: "m00004", topic: "new", summary: "Fresh summary of the middle exchange." }] }, "call-new"), ctx).text,
    );
    assert.ok(out.startsWith("[Compressed m00003–m00004"), out.split("\n")[0]);
    const noise = ACP_INPUT_LINES(lines);
    assert.equal(noise.length, 0, `expected zero [acp-compress-input] lines, got: ${noise.join(" || ")}`);
});

test("#5161 live path still reports: a genuinely summary-less LIVE call logs exactly one rejected warn (negative direction)", () => {
    const { lines } = withLogCapture(() => {
        parseCompressInput({ content: [{ startId: "m00001", endId: "m00003" }] });
    });
    const rejected = ACP_INPUT_LINES(lines).filter((l) => l.includes("rejected"));
    assert.equal(rejected.length, 1, lines.join(" || "));
    assert.ok(rejected[0]!.includes("missing summary"), rejected[0]);
});

test("#5161 quiet scan still parses: stub-shaped summaries are harvested, summary-less entries contribute nothing", () => {
    const ctx = makeCtx();
    seedTurn(ctx, [
        ["user", "early setup exchange"], ["assistant", "a".repeat(1000)],
        ["user", "more detail"], ["assistant", "b".repeat(1000)],
    ]);
    // Structural band of a kernel-emitted display stub: 199-char safePrefix + U+2026.
    const STUB = "s".repeat(199) + "\u2026";
    assert.equal(STUB.length, 200);
    const view: CoreMessage[] = [
        ...ctx.messages,
        { id: "mc-stub", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "call-stub", text: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: STUB }] }) },
        { id: "mc-nosum", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "call-nosum", text: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002" }] }) },
    ];
    const { result: stubs, lines } = withLogCapture(() => visibleSummaryStubs(view, ctx.session.state));
    assert.equal(ACP_INPUT_LINES(lines).length, 0, lines.join(" || "));
    assert.ok(stubs.has(STUB), "stub-shaped visible summary still harvested");
    assert.equal(stubs.size, 1, "summary-less entry contributes nothing");
});
