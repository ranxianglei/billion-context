import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig, countMessageTokens } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { getCacheLedger } from "../src/cache-ledger.ts";

// #3307 P1 regression: the observability denominator V must measure the LIVE
// context being managed (ctx.messages / processedMessages — what gets billed
// next), NOT the client's un-shrunken resend (ctx.compressMessages). A stateless
// client (codex_webui) re-sends its FULL history every turn, so the old
// `compressMessages ?? messages` basis made V ~50x the billed input and read every
// real fold as a ~1% shrink. These tests pin the corrected basis and verify the
// numerator/denominator share one view's net change (Vp === V - S).

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeSession() {
    return {
        id: "fold-view-basis-test",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 100000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

// The raw resend: refs are assigned over THIS array (fold geometry maps onto
// compressMessages), mirroring production where processTurn ran over the client's
// un-shrunken history. Big enough per message to clear the kernel's min range.
function makeRaw(n: number): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (let i = 1; i <= n; i++) out.push({ id: `raw_${i}`, role: i % 2 === 1 ? "user" : "assistant", contentType: "text", text: `RAW-${i}-` + "x".repeat(20000) });
    return out;
}

// The compressed live view (ctx.messages / processedMessages) BEFORE this fold:
// an early span already summarized, plus the recent turns still unfolded — so it is
// far smaller than the raw resend yet still LARGER than any single fold target (the
// pre-fold live view contains the about-to-be-folded content unfolded, hence V >= S).
function makeLiveView(): CoreMessage[] {
    // Production reality: the live view derives from the SAME resent cores as
    // compressMessages, so the about-to-be-folded span carries the SAME ids in
    // both views (raw_1/raw_2 here) — the #4224 union map resolves coverage
    // through them. Only the already-summarized prefix carries a view-local id.
    return [
        { id: "sum_early", role: "user", contentType: "text", text: "[summary] ancient turns folded away" },
        { id: "raw_1", role: "assistant", contentType: "text", text: "LIVE-" + "y".repeat(20000) },
        { id: "raw_2", role: "user", contentType: "text", text: "LIVE-" + "z".repeat(20000) },
        { id: "live_c", role: "assistant", contentType: "text", text: "LIVE-" + "w".repeat(20000) },
    ];
}

function totalTokens(msgs: CoreMessage[]): number {
    return msgs.reduce((n, m) => n + countMessageTokens(m), 0);
}

// refs come from the RAW array (geometry space); messages is the smaller live view.
function makeCtx(raw: CoreMessage[], live: CoreMessage[]): Ctx {
    const logs: string[] = [];
    const session = makeSession();
    const res = assignRefs(raw, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: live,
        compressMessages: raw,
        session,
        log: (m: string) => { logs.push(m); },
        logs,
    };
}

const SUMMARY = "OBS-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK";
const ARGS_1_2 = { content: [{ startId: "m00001", endId: "m00002", summary: SUMMARY }] };
const ARGS_3_4 = { content: [{ startId: "m00003", endId: "m00004", summary: SUMMARY }] };

test("#3307 P1: V tracks the live view (ctx.messages), never the raw resend (compressMessages)", () => {
    const raw = makeRaw(6);
    const live = makeLiveView();
    const rawTotal = totalTokens(raw);
    const liveTotal = totalTokens(live);
    assert.ok(rawTotal > liveTotal, `precondition: raw (${rawTotal}) must exceed live (${liveTotal}) so the assertion means something`);

    const ctx = makeCtx(raw, live);
    getCacheLedger(ctx.session); // bootstrap the ledger before its first fold (#1911 pattern)
    const out = applyRanges(parseCompressInput(ARGS_1_2), ctx as never).text;
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out}`);

    const folds = getCacheLedger(ctx.session).folds;
    assert.equal(folds.length, 1, "one fold recorded");
    assert.equal(folds[0].V, liveTotal, `V is the pre-fold LIVE view size (${liveTotal}), not the raw resend`);
    assert.notEqual(folds[0].V, rawTotal, "V must NOT be the bloated raw-inbound total");
});

test("#3307 P1: numerator/denominator share one view's net change (Vp === V - S)", () => {
    const ctx = makeCtx(makeRaw(6), makeLiveView());
    getCacheLedger(ctx.session);
    const out = applyRanges(parseCompressInput(ARGS_1_2), ctx as never).text;
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out}`);
    const folds = getCacheLedger(ctx.session).folds;
    const S = folds[0].S, V = folds[0].V, Vp = folds[0].Vp;
    assert.ok(S !== undefined, "S recorded");
    assert.ok(V !== undefined, "V recorded");
    assert.ok(Vp !== undefined, "Vp recorded");
    assert.ok(S > 0, "S = tokens removed from the view");
    assert.ok(V > 0, "V = pre-fold live view size");
    assert.equal(Vp, V - S, "post-fold live view === pre-fold live view - removed (same-view net change)");
    assert.ok(Vp >= 0, "post-fold live view is non-negative");
});

test("#3307 P1: multi-level folding keeps tracking the live view on the second fold", () => {
    const raw = makeRaw(8);
    const live = makeLiveView();
    const liveTotal = totalTokens(live);
    const ctx = makeCtx(raw, live);
    getCacheLedger(ctx.session);
    const o1 = applyRanges(parseCompressInput(ARGS_1_2), ctx as never).text;
    assert.ok(o1.startsWith("[Compressed"), `first fold failed: ${o1}`);
    const o2 = applyRanges(parseCompressInput(ARGS_3_4), ctx as never).text;
    assert.ok(o2.startsWith("[Compressed"), `second fold failed: ${o2}`);
    const folds = getCacheLedger(ctx.session).folds;
    assert.equal(folds.length, 2, "two folds recorded");
    assert.equal(folds[0].V, liveTotal, "first fold V = live view");
    assert.equal(folds[1].V, liveTotal, "second fold STILL tracks the live view, not the raw resend");
});

test("#3307 P1: re-folding still measures V off the already-shrunk live view", () => {
    const raw = makeRaw(8);
    const live0 = makeLiveView();
    const ctx = makeCtx(raw, live0);
    getCacheLedger(ctx.session);
    const o1 = applyRanges(parseCompressInput(ARGS_1_2), ctx as never).text;
    assert.ok(o1.startsWith("[Compressed"), `first fold failed: ${o1}`);
    assert.equal(getCacheLedger(ctx.session).folds[0].V, totalTokens(live0), "fold-1 V = pre-fold live view");
    // Re-folding: after fold-1 the live view has SHRUNK — the folded region is now a
    // summary. V must track THIS current (smaller, summary-bearing) view, not the raw
    // resend nor a stale pre-fold snapshot. This is the topology the existing multi-level
    // test did not pin (it held the live view constant across folds).
    const live1: CoreMessage[] = [
        { id: "sum_early", role: "user", contentType: "text", text: "[summary] ancient turns folded away" },
        { id: "sum_fold1", role: "user", contentType: "text", text: "[summary] fold-1 region collapsed" },
        { id: "live_b", role: "user", contentType: "text", text: "LIVE-" + "z".repeat(20000) },
        { id: "live_c", role: "assistant", contentType: "text", text: "LIVE-" + "w".repeat(20000) },
    ];
    assert.ok(totalTokens(live1) < totalTokens(live0), "precondition: the live view shrank after fold-1");
    ctx.messages = live1;
    const o2 = applyRanges(parseCompressInput(ARGS_3_4), ctx as never).text;
    assert.ok(o2.startsWith("[Compressed"), `re-fold failed: ${o2}`);
    const folds = getCacheLedger(ctx.session).folds;
    assert.equal(folds.length, 2, "two folds recorded");
    assert.equal(folds[1].V, totalTokens(live1), "re-fold V tracks the CURRENT (shrunken) live view, never the raw resend or a stale snapshot");
});

test("#3307 P1 baseline: when messages == compressMessages (no raw/live split) V is unchanged", () => {
    const raw = makeRaw(6);
    const total = totalTokens(raw);
    const ctx = makeCtx(raw, raw); // single-level: the live view IS the raw array
    getCacheLedger(ctx.session);
    const out = applyRanges(parseCompressInput(ARGS_1_2), ctx as never).text;
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out}`);
    assert.equal(getCacheLedger(ctx.session).folds[0].V, total, "V equals the (single) view size — old behavior preserved when no separate raw resend exists");
});
