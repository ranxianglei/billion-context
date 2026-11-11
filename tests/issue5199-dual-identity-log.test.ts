import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, defaultConfig, createInitialState, emptyRefMap, type CoreMessage, type CompressionState } from "acp-kernel";
import { applyRanges, supersededRefRejection, type RewriteCtx } from "../src/stream.ts";

// #5199: after a restart, the cold-load ledger restamp can hand a pre-restart
// ref to ANOTHER message (a vacated number re-issued as someone else's seq+1
// target in the same pass). The host guard resolves endpoints live-first, so
// a replayed pre-restart compress call citing the OLD number applies to the
// NEW owner and returns success — silently folding the wrong message. The
// live-first resolution is the accepted trade (rejecting dead-loops like
// #4797; translating to the old owner would mistranslate legitimate
// post-restamp cites); what was missing was visibility. This file pins:
//  T1 dual-identity application — citing m00006 (live for f, e's old label)
//     folds f, NOT e, returns success, and the prominent warning fires;
//  T2 negative control — an ordinary live cite produces NO warning;
//  T3 resolution contract — dualIdentity dedupes singleton endpoints, clean
//     ranges stay empty, the no-map fast path carries an empty list;
//  T4 translation path intact — a genuinely-vacated cite still translates
//     onto the same message with no dual-identity entry.

// Pre-#5196 restamped-session shape, built DIRECTLY rather than via
// restampRefsToLedger: #5196 slot-retirement changed the kernel so a fresh
// restamp no longer re-issues a vacated number (in this shape f would park on
// m8 instead of taking e's vacated m6), so the restamp path can no longer
// reproduce the fixture. Sessions restamped BEFORE #5196 still carry exactly
// this persisted shape, which we build verbatim so the host-guard pin stays
// independent of the kernel's current restamp algorithm:
//   LIVE: a=m1 b=m2 d=m4 e=m5 f=m6 ; superseded {m3→b, m6→e, m7→f}.
//   m6 is therefore dual-identity: live for f AND still e's recorded old label.
function restampedSession(): { session: RewriteCtx["session"]; messages: CoreMessage[] } {
    const state: CompressionState = createInitialState();
    const map = emptyRefMap();
    map.byRaw.a = "m00001"; map.byRef.m00001 = "a";
    map.byRaw.b = "m00002"; map.byRef.m00002 = "b";
    map.byRaw.c = "BLOCKED";
    map.byRaw.d = "m00004"; map.byRef.m00004 = "d";
    map.byRaw.e = "m00005"; map.byRef.m00005 = "e";
    map.byRaw.f = "m00006"; map.byRef.m00006 = "f";
    state.messageRefs = map;
    // The persisted superseded map such a legacy session carries: each vacated
    // number mapped to its pre-restamp owner. m6→e is the dual-identity entry
    // (m6 is live for f yet still recorded as e's old label).
    const superseded = new Map([
        ["m00003", "b"],
        ["m00006", "e"],
        ["m00007", "f"],
    ]);
    const messages: CoreMessage[] = [
        { id: "a", role: "user", contentType: "text", text: "message a body " + "with enough substance to be worth folding someday. ".repeat(120) },
        { id: "b", role: "assistant", contentType: "text", text: "message b body " + "with enough substance to be worth folding someday. ".repeat(120) },
        { id: "d", role: "user", contentType: "text", text: "message d body " + "with enough substance to be worth folding someday. ".repeat(120) },
        { id: "e", role: "assistant", contentType: "text", text: "message e body " + "with enough substance to be worth folding someday. ".repeat(120) },
        { id: "f", role: "user", contentType: "text", text: "message f body " + "with enough substance to be worth folding someday. ".repeat(120) },
    ];
    const session = {
        id: "issue5199",
        meta: { protocol: "anthropic" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state,
        restampSuperseded: superseded,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    } as never as RewriteCtx["session"];
    return { session, messages };
}

function makeCtx(): { ctx: RewriteCtx; logs: string[] } {
    const logs: string[] = [];
    const { session, messages } = restampedSession();
    const ctx = {
        core: createCore(),
        config: defaultConfig(100_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 }),
        messages,
        compressMessages: messages,
        session,
        log: (m: string) => { logs.push(m); },
    } as never as RewriteCtx;
    return { ctx, logs };
}

const SUMMARY = "Folded span covering the debugging arc with decisions, files touched, and outcomes preserved for later recall.".slice(0, 500);

function spec(startRef: string, endRef: string): { ranges: { startRef: string; endRef: string; summary: string }[]; diagnostics: unknown } {
    return { ranges: [{ startRef, endRef, summary: SUMMARY.repeat(2) }], diagnostics: [] };
}

test("T1: citing a dual-identity ref (live for f, e's pre-restamp label) folds f, succeeds, and logs the reused-number warning", () => {
    const { ctx, logs } = makeCtx();
    // Fixture precondition: m00006 is live for f while still recorded as e's
    // old label — the exact shape #5199 reproduces in production.
    const byRef = ctx.session.state.messageRefs?.byRef ?? {};
    assert.equal(byRef["m00006"], "f");
    assert.equal(ctx.session.restampSuperseded?.get("m00006"), "e");
    const res = applyRanges(spec("m00006", "m00006") as never, ctx);
    const text = typeof (res as { text?: string }).text === "string" ? (res as { text?: string }).text! : "";
    assert.ok(!text.includes("REFUSED"), `dual-identity cite must not be refused (live-first trade); got: ${text.slice(0, 200)}`);
    const covered = ctx.session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : []));
    assert.ok(covered.includes("f"), "fold covers the CURRENT owner f");
    assert.ok(!covered.includes("e"), "the intended-but-old owner e is NOT folded");
    const warn = logs.find((l) => l.includes("reused ref number"));
    assert.ok(warn !== undefined, `prominent warning must fire; logs: ${logs.join(" | ")}`);
    assert.ok(warn!.includes("m00006"), "warning names the reused ref");
});

test("T2: an ordinary live cite (no dual identity) folds cleanly with NO warning", () => {
    const { ctx, logs } = makeCtx();
    const res = applyRanges(spec("m00004", "m00004") as never, ctx);
    const text = typeof (res as { text?: string }).text === "string" ? (res as { text?: string }).text! : "";
    assert.ok(!text.includes("REFUSED"), `clean live cite must not be refused; got: ${text.slice(0, 200)}`);
    const covered = ctx.session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : []));
    assert.ok(covered.includes("d"), "fold covers d");
    assert.ok(!logs.some((l) => l.includes("reused ref number")), "no warning for non-dual identities");
});

test("T3: resolution contract — singleton dedupe, clean ranges empty, no-map fast path empty", () => {
    const { session } = restampedSession();
    // Singleton range: both endpoints hit the same dual-identity ref once.
    const res = supersededRefRejection([{ startRef: "m00006", endRef: "m00006" }], session);
    assert.equal(res.rejection, null);
    assert.deepEqual(res.dualIdentity, ["m00006"]);
    // Clean live range: nothing flagged.
    const clean = supersededRefRejection([{ startRef: "m00004", endRef: "m00005" }], session);
    assert.equal(clean.rejection, null);
    assert.deepEqual(clean.dualIdentity, []);
    // No-map fast path: field present and empty.
    (session as { restampSuperseded?: Map<string, string> }).restampSuperseded = undefined;
    const bare = supersededRefRejection([{ startRef: "m00004", endRef: "m00005" }], session);
    assert.deepEqual(bare.dualIdentity, []);
});

test("T4: genuinely-vacated cites still translate onto the same message, with no dual-identity entry", () => {
    const { ctx, logs } = makeCtx();
    // m00003 is b's pre-restamp label; b now holds m00002. Translation must
    // fold b — and flag nothing (the number is vacated, not re-issued).
    const res = applyRanges(spec("m00003", "m00003") as never, ctx);
    const text = typeof (res as { text?: string }).text === "string" ? (res as { text?: string }).text! : "";
    assert.ok(!text.includes("REFUSED"), `translatable old cite must not be refused; got: ${text.slice(0, 200)}`);
    const covered = ctx.session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : []));
    assert.ok(covered.includes("b"), "translated fold covers the cited message b");
    assert.ok(!covered.includes("a"), "neighbor a untouched");
    assert.ok(logs.some((l) => l.includes("translated") && l.includes("superseded")), "translation still logged");
    assert.ok(!logs.some((l) => l.includes("reused ref number")), "vacated (non-re-issued) numbers are not dual-identity");
});
