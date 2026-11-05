// #2749: in plugin mode the model's only persistent record of a folded block's
// summary is the ~200-char display stub hideConsumedCompressCalls writes into
// the re-sent call args (kernel/src/hide-consumed.ts SUMMARY_STUB_CHARS=200);
// the full-text acp_summary anchor is stripped there in plugin mode (#1316).
// Asked to summarize again (tier distillation / refold), a model can copy the
// visible fragment verbatim and submit it as if it were the full summary —
// minSummaryLength (50) accepts it and a large range folds under the truncated
// record (worst variant: self-refold silently shrinks the block's canonical
// summary). applyRanges now rejects any submitted summary that is byte-identical
// to a currently-visible display stub (exact match only).
//
// Acceptance mapping (issue #2749):
//  - criterion 1 (canonical content/hash stable across save → history reduction
//    → next request → full decompress): test "canonical integrity pin".
//  - criterion 2 (known preview/stub re-submission handled explicitly): tests
//    "rejects byte-identical", "self-refold shrink blocked".
//  - criterion 3 (normal short summaries / ellipsis prose still usable): tests
//    "legitimate summaries pass" + "±1-char drift passes (exact-match contract)".
//  - kernel-format drift tripwire: test "host harvest tracks kernel-emitted stubs".
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressionState, CoreMessage } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap, hideConsumedCompressCalls } from "acp-kernel";
import { applyRanges, findVisibleStubResubmissions, visibleSummaryStubs, type RewriteCtx } from "../src/stream.ts";
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
            id: `stub-${Math.random().toString(36).slice(2)}`,
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

/** Same fixture discipline as tests/compress-fingerprint-refold.test.ts: head
 *  turns under test + a realistic recent tail; kernel soft protection disabled
 *  so small deterministic seeds are compressible at any ref. */
function seedTurn(ctx: Ctx, head: Array<[string, string]>, tailN = 5): void {
    const turns = [...head, ...Array.from({ length: tailN }, (_, i): [string, string] => [i % 2 === 0 ? "user" : "assistant", `recent ${i}`])];
    const msgs: CoreMessage[] = turns.map(([role, text], i) => ({ id: `raw${i}`, role: role as "user" | "assistant", contentType: "text", text }));
    ctx.messages = msgs;
    ctx.session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
    ctx.config.preserveRecentMessages = 0;
    ctx.config.preserveRecentTokens = 0;
    ctx.config.compress.minCompressRange = 0;
    ctx.config.compress.minSummaryLength = 0;
}

/** The shape of the incident: a long, information-dense summary with long
 *  paths, mid-flight verification state and an unfinished goal at the tail —
 *  well past the 200-char display-stub cut, so the stub loses real content. */
const LONG_SUMMARY = [
    "TASK STATE: implementing the context-gate in src/loop/core.ts of the billion-context checkout under /var/lib/ework-daemon/share/opencode-workdir/ranxianglei--billion-context/2749/ework-daemon",
    "",
    "## Decisions",
    "- chose observer pattern over polling because the gate must react to usage deltas the moment they land",
    "- pinned CHECK_INTERVAL_MS = 180000; threshold moved old->new 5% -> 35%, flagged in the reply per behavior-change policy",
    "",
    "## Verification done",
    "- npm run typecheck clean; targeted node --import tsx --test tests/gate.test.ts green (12/12)",
    "",
    "## Open",
    "- TODO: wire the advisory rollback path in src/advisory.ts (blocked on #1588 contract)",
    "- pending: e2e A/B against the issue repro before merge",
].join("\n");

assert.ok(LONG_SUMMARY.length > 200, "fixture must exceed the display-stub window");

const STUB_200 = LONG_SUMMARY.slice(0, 199) + "\u2026"; // ASCII fixture ⇒ no surrogate snap ⇒ exactly 200 chars

function storedSummary(state: CompressionState, blockId: string): string {
    const block = state.blocks.find((b) => b.blockId === blockId);
    assert.ok(block, `block ${blockId} exists in state`);
    return block.summary;
}

/** Simulate the NEXT client request after the fold: the client resends its
 *  persisted history, which includes the compress tool-call carrying the FULL
 *  original arguments (clients persist what the model wrote; the stubbing is
 *  outbound-only). Returns the outbound view the model would see. */
function nextRequestView(ctx: Ctx, callId: string, startRef: string, endRef: string): CoreMessage[] {
    const call: CoreMessage = {
        id: "mc-call",
        role: "assistant",
        contentType: "tool-call",
        toolName: "compress",
        toolCallId: callId,
        text: JSON.stringify({ content: [{ startId: startRef, endId: endRef, topic: "T", summary: LONG_SUMMARY }] }),
    };
    // The call message itself carries a ref in production (assignRefs covers
    // every message incl. tool calls) — mirror the kernel's own fixtures.
    ctx.session.state.messageRefs.byRaw["mc-call"] = "m00090";
    ctx.session.state.messageRefs.byRef["m00090"] = "mc-call";
    const view = [...ctx.messages, call];
    return hideConsumedCompressCalls(ctx.session.state, view).messages;
}

test("#2749 canonical integrity pin: full summary survives save → history reduction → next request → full decompress byte-identical", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [
        ["user", "A historical exchange covering setup steps."],
        ["assistant", "x".repeat(3000)],
        ["user", "Follow-up questions about the configuration."],
        ["assistant", "y".repeat(3000)],
    ]);
    // The fold is linked to its tool-call id exactly as production does
    // (src/loop/core.ts passes callId); the resent "call-b1" below then
    // classifies active instead of orphan.
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", topic: "T", summary: LONG_SUMMARY }] }, "call-b1"), ctx).text;
    assert.ok(out.startsWith("[Compressed m00001–m00004 → 1 block(s)"), out.split("\n")[0]);
    // (a) saved canonically in full — no trimming, no truncation.
    assert.equal(storedSummary(ctx.session.state, "b1"), LONG_SUMMARY);
    // (b) the next request's VISIBLE copy is reduced to the 200-char stub…
    const visible = nextRequestView(ctx, "call-b1", "m00001", "m00004");
    const visCall = visible.find((m) => m.toolCallId === "call-b1");
    assert.ok(visCall, "kept-visible compress call present in next request view");
    const visEntries = JSON.parse((visCall!.text ?? "").replace(/^[^{]*/, "")) as { content: Array<{ summary?: string }> };
    const visSummary = visEntries.content[0]!.summary!;
    assert.equal(visSummary, STUB_200, "visible arg reduced to exactly the 200-char stub");
    assert.equal(visSummary.length, 200);
    assert.ok(visSummary.endsWith("…"));
    // …while the canonical block summary is untouched by the reduction.
    assert.equal(storedSummary(ctx.session.state, "b1"), LONG_SUMMARY, "canonical summary unchanged by outbound reduction");
    // (c) full decompress still restores the original content.
    const dec = resolveDecompress({ blockId: "b1", full: true }, ctx).text;
    assert.match(dec, /^\[Block b1 content/, dec.slice(0, 60));
    assert.ok(dec.includes("x".repeat(3000)), "decompress restores the original message bodies");
});

test("#2749 rejects a byte-identical stub re-submission; state unchanged, refusal names the range", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [
        ["user", "early part"], ["assistant", "a".repeat(1000)],
        ["user", "middle part"], ["assistant", "b".repeat(1000)],
        ["user", "late part one"], ["assistant", "c".repeat(1000)],
        ["user", "late part two"], ["assistant", "d".repeat(1000)],
        ["user", "late part three"], ["assistant", "e".repeat(1000)],
    ]);
    const ok = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", topic: "T", summary: LONG_SUMMARY }] }, "call-b1"), ctx).text;
    assert.ok(ok.startsWith("[Compressed m00001–m00002 → 1 block(s)"), ok.split("\n")[0]);
    // Next request: the model sees its own call reduced to the stub.
    ctx.messages = nextRequestView(ctx, "call-b1", "m00001", "m00002").map((m) => ({ ...m }));
    const beforeBlocks = ctx.session.state.blocks.length;
    const beforeSummary = storedSummary(ctx.session.state, "b1");
    // The model "recalls" only what it can see and folds the late tail under it.
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00005", endId: "m00009", summary: STUB_200 }] }), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED"), out.split("\n")[0]);
    assert.ok(out.includes("display stub"), out);
    assert.ok(out.includes("m00005–m00009"), out);
    assert.ok(!out.includes(STUB_200), "refusal must not echo the business fragment back");
    assert.equal(ctx.session.state.blocks.length, beforeBlocks, "nothing compressed");
    assert.equal(storedSummary(ctx.session.state, "b1"), beforeSummary, "canonical summary untouched");
    const logLine = ctx.logs.find((l) => l.includes("byte-identical to a currently-visible display stub")) ?? "";
    assert.ok(logLine, ctx.logs.join("\n"));
    assert.ok(!logLine.includes(STUB_200), "log line carries refs only, never the fragment");
});

test("#2749 self-refold under the block's own stub is blocked (silent-shrink worst variant)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [
        ["user", "setup steps discussed early"], ["assistant", "a".repeat(4000)],
        ["user", "more detail on the setup"], ["assistant", "b".repeat(4000)],
    ]);
    const ok = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", topic: "T", summary: LONG_SUMMARY }] }, "call-b1"), ctx).text;
    assert.ok(ok.startsWith("[Compressed m00001–m00002 → 1 block(s)"), ok.split("\n")[0]);
    ctx.messages = nextRequestView(ctx, "call-b1", "m00001", "m00002").map((m) => ({ ...m }));
    // Re-fold the SAME span submitting the block's own stub as the new summary.
    const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: STUB_200 }] }), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED"), out.split("\n")[0]);
    assert.ok(out.includes("display stub"), out);
    assert.equal(storedSummary(ctx.session.state, "b1"), LONG_SUMMARY, "canonical summary NOT shrunk by the rejected re-fold");
    assert.equal(ctx.session.state.blocks.length, 1);
});

test("#2749 legitimate summaries still pass: short, ellipsis-prose, and ±1-char drift", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [
        ["user", "early part"], ["assistant", "a".repeat(4000)],
        ["user", "middle part"], ["assistant", "b".repeat(4000)],
        ["user", "late one"], ["assistant", "c".repeat(4000)],
        ["user", "late two"], ["assistant", "d".repeat(4000)],
        ["user", "late three"], ["assistant", "e".repeat(4000)],
        ["user", "late four"], ["assistant", "f".repeat(4000)],
        ["user", "late five"], ["assistant", "g".repeat(4000)],
    ]);
    const ok = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", topic: "T", summary: LONG_SUMMARY }] }, "call-b1"), ctx).text;
    assert.ok(ok.startsWith("[Compressed m00001–m00002 → 1 block(s)"), ok.split("\n")[0]);
    ctx.messages = nextRequestView(ctx, "call-b1", "m00001", "m00002").map((m) => ({ ...m }));

    // (a) short summary containing an ellipsis — normal prose, must pass.
    const a = applyRanges(parseCompressInput({ content: [{ startId: "m00003", endId: "m00004", summary: "Folded the middle exchange; key details omitted…" }] }), ctx).text;
    assert.ok(a.startsWith("[Compressed m00003–m00004"), a.split("\n")[0]);

    // (b) long (>200 char) genuine prose containing ellipses mid-text — must pass.
    const prose = "Captured the verification pass: typecheck clean, targeted suite 12/12 green… then the e2e lane against the mock upstream reproduced the retry illusion described in the ticket, which points at upstream rate limiting rather than over-compression.";
    assert.ok(prose.length > 200 && prose.includes("…") && prose !== STUB_200);
    const b = applyRanges(parseCompressInput({ content: [{ startId: "m00005", endId: "m00006", summary: prose }] }), ctx).text;
    assert.ok(b.startsWith("[Compressed m00005–m00006"), b.split("\n")[0]);

    // (c) ±1-char transcription drift of the stub (the observed 199/201 shapes):
    // exact-match-only contract — drifted copies are NOT the stub, they pass.
    const driftShort = STUB_200.slice(0, -2);              // 198 chars, no ellipsis
    const c = applyRanges(parseCompressInput({ content: [{ startId: "m00007", endId: "m00008", summary: driftShort }] }), ctx).text;
    assert.ok(c.startsWith("[Compressed m00007–m00008"), c.split("\n")[0]);
    const driftLong = `${STUB_200}z`;                      // 201 chars
    const d = applyRanges(parseCompressInput({ content: [{ startId: "m00009", endId: "m00010", summary: driftLong }] }), ctx).text;
    assert.ok(d.startsWith("[Compressed m00009–m00010"), d.split("\n")[0]);
});

test("#2749 host harvest tracks kernel-emitted stubs (format-drift tripwire)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, [
        ["user", "early part"], ["assistant", "a".repeat(1000)],
    ]);
    const ok = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", topic: "T", summary: LONG_SUMMARY }] }, "call-b1"), ctx).text;
    assert.ok(ok.startsWith("[Compressed"), ok.split("\n")[0]);
    const view = nextRequestView(ctx, "call-b1", "m00001", "m00002");
    const visCall = view.find((m) => m.toolCallId === "call-b1")!;
    const visEntries = JSON.parse((visCall.text ?? "").replace(/^[^{]*/, "")) as { content: Array<{ summary?: string }> };
    const kernelStub = visEntries.content[0]!.summary!;
    // The structural band assumption behind the harvest filter:
    assert.ok(kernelStub.length === 199 || kernelStub.length === 200, `kernel stub length ${kernelStub.length}`);
    assert.ok(kernelStub.endsWith("\u2026"), "kernel stub ends with U+2026");
    // Whatever the kernel emitted, the host harvest picks it up byte-identically:
    const harvested = visibleSummaryStubs(view, ctx.session.state);
    assert.ok(harvested.has(kernelStub), "harvest contains the kernel-emitted stub");
    // …and flags a re-submission of exactly that text:
    const hits = findVisibleStubResubmissions(
        { ...ctx, messages: view } as RewriteCtx,
        parseCompressInput({ content: [{ startId: "m00003", endId: "m00005", summary: kernelStub }] }).ranges,
    );
    assert.deepEqual(hits, [{ startRef: "m00003", endRef: "m00005" }]);
    // …and stays silent for any other text:
    assert.equal(findVisibleStubResubmissions({ ...ctx, messages: view } as RewriteCtx, parseCompressInput({ content: [{ startId: "m00003", endId: "m00005", summary: "a completely fresh summary" }] }).ranges).length, 0);
});
