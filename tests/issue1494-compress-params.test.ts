// #1494: two param-shape defects in the compress receipt path.
// (A) Entries dropped at PARSE time vanished from a partial-success call — a
//     3-entry batch that lost one read as a clean 2-block success with no
//     failure note, and nothing was logged server-side either.
// (B) Retrying the lost range with `content` as the single entry object (or a
//     bare top-level array / string-encoded variants of the same drift) hit
//     kernel kind=content-not-array / not-object — a hard failure on a shape
//     the kernel's own salvage ladder already tolerates at the TOP level.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { normalizeCompressInput, parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [] as CoreMessage[],
        session: {
            id: `i1494-${Math.random().toString(36).slice(2)}`,
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
 *  seedTurn instead, so ranges address only the head messages. */
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
    // ref; production defaults stay asserted elsewhere.
    ctx.config.preserveRecentMessages = 0;
    ctx.config.preserveRecentTokens = 0;
    ctx.config.compress.minCompressRange = 0;
    ctx.config.compress.minSummaryLength = 0;
}

test("#1494 B: content given as the single entry object is normalized to a one-element array", () => {
    const parsed = parseCompressInput({ content: { startId: "m00001", endId: "m00002", summary: "solo" } });
    assert.equal(parsed.ranges.length, 1);
    assert.equal(parsed.diagnostics.ok, true);
    assert.equal(parsed.diagnostics.kind, "ok");
});

test("#1494 B: bare top-level entry array is normalized to {content:[…]}", () => {
    const parsed = parseCompressInput([{ startId: "m00001", endId: "m00002", summary: "solo" }]);
    assert.equal(parsed.ranges.length, 1);
    assert.equal(parsed.diagnostics.kind, "ok");
});

test("#1494 B: string-encoded single-object content (chat-wire shape drift) is recovered", () => {
    const parsed = parseCompressInput(JSON.stringify({ content: { startId: "m00001", endId: "m00002", summary: "solo" } }));
    assert.equal(parsed.ranges.length, 1);
    assert.equal(parsed.diagnostics.kind, "ok");
});

test("#1494 B: fenced + double-stringified variant is recovered too", () => {
    const inner = JSON.stringify({ content: { startId: "m00001", endId: "m00002", summary: "solo" } });
    const parsed = parseCompressInput("```json\n" + JSON.stringify(inner) + "\n```");
    assert.equal(parsed.ranges.length, 1);
    assert.equal(parsed.diagnostics.kind, "ok");
});

test("#1494 B: garbage object content degrades to per-entry reasons, not opaque content-not-array", () => {
    const parsed = parseCompressInput({ content: { foo: 1 } });
    assert.equal(parsed.ranges.length, 0);
    assert.notEqual(parsed.diagnostics.kind, "content-not-array");
    assert.ok((parsed.diagnostics.invalidReasons ?? []).some((r) => r.includes("missing range bounds")), JSON.stringify(parsed.diagnostics));
});

test("#1494 B: canonical inputs pass through normalization unchanged", () => {
    const canonical = { content: [{ startId: "m00001", endId: "m00002", summary: "s" }] };
    assert.deepEqual(normalizeCompressInput(canonical), canonical);
    assert.deepEqual(normalizeCompressInput({}), {});
    assert.equal(normalizeCompressInput(""), "");
    const lineForm = '{"content":["m00001–m00002 topic\\nsummary body"]}';
    assert.equal(normalizeCompressInput(lineForm), lineForm, "non-object-shaped string content is untouched");
    // #1366 empty-call detection must keep seeing the original empty shape.
    const emptyParsed = parseCompressInput({});
    assert.ok(emptyParsed.diagnostics.kind === "missing-content" || emptyParsed.diagnostics.kind === "not-object", emptyParsed.diagnostics.kind);
});

test("#1494 A: a parse-dropped entry is surfaced in the SUCCESS receipt and logged", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "hello there"], ["assistant", "x".repeat(500)]], 2);
    const out = applyRanges(parseCompressInput({ content: [
        { startId: "m00001", endId: "m00002", summary: "valid fold" },
        { startId: "m00003" },
    ] }), ctx);
    assert.ok(out.startsWith("[Compressed m00001–m00002 → 1 block(s)"), out.split("\n")[0]);
    assert.ok(out.includes("1 of the submitted entry was REJECTED and NOT compressed"), out);
    assert.ok(out.includes("entry 1: missing range bounds"), out);
    // #1523: the old "in a new compress call" anchor taught one-range-per-call; the receipt now steers to one batched call.
    assert.ok(out.includes("Re-issue the rejected range in ONE new compress call, batched with everything else still pending — never one range per call."), out);
    assert.ok(ctx.logs.some((l) => l.includes("compress PARTIAL") && l.includes("rejected")), ctx.logs.join("\n"));
    assert.equal(ctx.session.state.blocks.filter((b) => b.active).length, 1);
});

test("#1494 A: a parse-dropped entry is surfaced in the FAILED receipt too (0-blocks apply failure)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "hello there"], ["assistant", "x".repeat(500)]], 2);
    // Force the apply-time gate: one entry survives parsing but its range is
    // below minCompressRange → blocksCreated === 0 (FAILED branch) while the
    // garbage sibling was dropped at parse — the receipt must still name it.
    ctx.config.compress.minCompressRange = 10_000;
    const out = applyRanges(parseCompressInput({ content: [
        { startId: "m00001", endId: "m00002", summary: "valid but too small" },
        { startId: "m00003" },
    ] }), ctx);
    assert.ok(out.startsWith("[Compression FAILED:"), out.split("\n")[0]);
    assert.ok(out.includes("1 of the submitted entry was REJECTED and NOT compressed"), out);
    assert.ok(out.includes("entry 1: missing range bounds"), out);
    assert.equal(ctx.session.state.blocks.filter((b) => b.active).length, 0);
});

test("#1494 A+B: single-object content folds end-to-end through applyRanges", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [["user", "hello there"], ["assistant", "x".repeat(500)]]);
    const out = applyRanges(parseCompressInput({ content: { startId: "m00001", endId: "m00002", summary: "solo fold via normalized content" } }), ctx);
    assert.ok(out.startsWith("[Compressed m00001–m00002 → 1 block(s)"), out.split("\n")[0]);
    assert.ok(!out.includes("REJECTED"), out);
});
