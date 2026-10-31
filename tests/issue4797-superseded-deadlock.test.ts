import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, defaultConfig, assignRefs, createInitialState, restampRefsToLedger, emptyRefMap, type CoreMessage, type CompressionState } from "acp-kernel";
import { applyRanges, supersededRefRejection, type RewriteCtx } from "../src/stream.ts";

// #4797: the ledger-alignment restamp's superseded map collided with the LIVE
// numbering (a vacated old number is re-occupied as another message's seq+1
// target in the same pass), and the compress-input guard consulted superseded
// before the live map — so acp_status advertised live refs the guard then
// refused, with a refusal text pointing straight back at acp_status. The
// proxy's own preflight rescue was refused by the same gate. Dead loop: the
// session could never compress again.
//
// This file pins the field shape end-to-end at the guard + kernel boundary:
//  T1 advertised-range deadlock — live refs cited exactly as acp_status lists
//     them pass and FOLD (RED on master: refused "superseded");
//  T2 identity translation — a genuinely old cite folds the SAME message;
//  T3 processTurn stability — the restamped session keeps folding on the
//     post-restamp numbering (regression net for the kernel clone fixes).

// Same drifted shape as kernel/tests/ref-restamp-collision.test.ts:
// rows/seq a=0..f=5; old refs a=m1 b=m3 c=BLOCKED d=m4 e=m6 f=m7.
// Post-restamp: b→m2, e→m5, f takes e's vacated m6. Superseded (post-prune):
// {m3→b, m7→f} — m6 is live for f and MUST NOT sit in the map.
function restampedSession(): { session: RewriteCtx["session"]; messages: CoreMessage[] } {
    const state: CompressionState = createInitialState();
    const map = emptyRefMap();
    map.byRaw.a = "m00001"; map.byRef.m00001 = "a";
    map.byRaw.b = "m00003"; map.byRef.m00003 = "b";
    map.byRaw.c = "BLOCKED";
    map.byRaw.d = "m00004"; map.byRef.m00004 = "d";
    map.byRaw.e = "m00006"; map.byRef.m00006 = "e";
    map.byRaw.f = "m00007"; map.byRef.m00007 = "f";
    state.messageRefs = map;
    const seq = new Map([["a", 0], ["b", 1], ["c", 2], ["d", 3], ["e", 4], ["f", 5]]);
    const outcome = restampRefsToLedger(state, seq);
    const messages: CoreMessage[] = [
        { id: "a", role: "user", contentType: "text", text: "message a body " + "with enough substance to be worth folding someday. ".repeat(120) },
        { id: "b", role: "assistant", contentType: "text", text: "message b body " + "with enough substance to be worth folding someday. ".repeat(120) },
        { id: "d", role: "user", contentType: "text", text: "message d body " + "with enough substance to be worth folding someday. ".repeat(120) },
        { id: "e", role: "assistant", contentType: "text", text: "message e body " + "with enough substance to be worth folding someday. ".repeat(120) },
        { id: "f", role: "user", contentType: "text", text: "message f body " + "with enough substance to be worth folding someday. ".repeat(120) },
    ];
    const session = {
        id: "issue4797",
        meta: { protocol: "anthropic" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state,
        restampSuperseded: outcome.superseded,
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

test("T1: refs exactly as acp_status advertises them (live, inside the collision band) are accepted and fold — the #4797 deadlock is gone", () => {
    const { ctx, logs } = makeCtx();
    // Post-restamp live numbering: d=m4, e=m5, f=m6 — m6 is ALSO e's old
    // number (the collision band). The OLD guard span-scanned m4..m6, hit the
    // superseded key m6 (old-kernel map), and refused — master-RED shape.
    const res = applyRanges(spec("m00004", "m00006") as never, ctx);
    const text = typeof (res as { text?: string }).text === "string" ? (res as { text?: string }).text! : "";
    assert.ok(!text.includes("REFUSED"), `live advertised refs must not be refused; got: ${text.slice(0, 200)}`);
    // The fold actually happened and covered d, e, f.
    const covered = ctx.session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : []));
    for (const id of ["d", "e", "f"]) assert.ok(covered.includes(id), `fold must cover ${id}`);
    assert.ok(logs.some((l) => l.includes("compress requested")), "compress executed");
});

test("T2: a genuinely OLD cite (superseded, not live) translates onto the SAME message and folds it", () => {
    const { ctx, logs } = makeCtx();
    // The model remembers b's pre-restamp number m00003 (it saw the tag in an
    // earlier turn). m00003 is vacated (b now holds m00002) — translation must
    // fold b, never refuse, never touch m00003's post-restamp neighbors.
    const res = applyRanges(spec("m00003", "m00003") as never, ctx);
    const text = typeof (res as { text?: string }).text === "string" ? (res as { text?: string }).text! : "";
    assert.ok(!text.includes("REFUSED"), `translatable old cite must not be refused; got: ${text.slice(0, 200)}`);
    const covered = ctx.session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : []));
    assert.ok(covered.includes("b"), "translated fold covers the cited message b");
    assert.ok(!covered.includes("a"), "neighbor a untouched");
    assert.ok(logs.some((l) => l.includes("translated") && l.includes("superseded")), "translation is logged for diagnosability");
});

test("T3: the restamped session keeps folding on the live numbering across processTurns (kernel clone regression net)", () => {
    const { ctx } = makeCtx();
    const core = ctx.core;
    // One turn passes through the sync clone — refs re-derive, flag survives.
    const turn = core.processTurn({ messages: ctx.messages, state: ctx.session.state, config: ctx.config, tokenCount: 10, renderTags: "none" });
    ctx.session.state = turn.state;
    const res = applyRanges(spec("m00004", "m00004") as never, ctx);
    const text = typeof (res as { text?: string }).text === "string" ? (res as { text?: string }).text! : "";
    assert.ok(!text.includes("REFUSED"), `post-turn fold must not be refused; got: ${text.slice(0, 200)}`);
});

test("T4: guard contract — dead-end superseded cite still refuses honestly; no-map session is untouched", () => {
    const { session } = restampedSession();
    // Hand-corrupt the map: a superseded key whose raw id lost its mapping.
    (session as { restampSuperseded?: Map<string, string> }).restampSuperseded = new Map([["m00003", "ghost"]]);
    delete (session as { state: CompressionState }).state.messageRefs.byRaw.ghost;
    const res = supersededRefRejection([{ startRef: "m00003", endRef: "m00003" }], session);
    assert.ok(res.rejection !== null, "dead-end translation refuses");
    assert.match(res.rejection, /acp_status/);
    const clean = supersededRefRejection([{ startRef: "m00001", endRef: "m00002" }], session);
    assert.equal(clean.rejection, null, "live refs pass even with a map present");
});
