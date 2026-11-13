import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, beyondFrontierNote, frontierClampNote, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "summary ".repeat(20);

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue2146-${randomUUID()}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
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

function makeCtx(messages: CoreMessage[], config?: Config, logs?: string[]): RewriteCtx & { session: Session; config: Config } {
    const session = makeSession();
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: config ?? defaultConfig(200000), messages, session, log: logs ? (m) => logs.push(m) : () => {} };
}

function compressArgs(startId: string, endId: string) {
    return JSON.parse(JSON.stringify({ content: [{ startId, endId, summary: SUMMARY }] }));
}

// Two sub-gate small messages + six big ones: three DISTINCT failing specs
// (single-message ranges + the pair, all under the 5000-char gate) and one
// guaranteed-success spec (m00003–m00008, 30000 chars).
function fixtureMessages(): CoreMessage[] {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
    ];
    for (let i = 3; i <= 8; i++) msgs.push(textMsg(`raw_${i}`, "assistant", "x".repeat(5000)));
    return msgs;
}

test("#2146: distinct-spec failure streak arms the circuit breaker at 3", () => {
    const logs: string[] = [];
    const ctx = makeCtx(fixtureMessages(), undefined, logs);

    const f1 = applyRanges(parseCompressInput(compressArgs("m00001", "m00001")), ctx).text;
    assert.ok(f1.startsWith("[Compression FAILED:"), `first attempt fails at gate (got: ${f1.slice(0, 120)})`);
    assert.ok(!f1.includes("CIRCUIT BREAKER"), "failure 1 carries no breaker");

    const f2 = applyRanges(parseCompressInput(compressArgs("m00002", "m00002")), ctx).text;
    assert.ok(f2.startsWith("[Compression FAILED:"), "failure 2");
    assert.ok(!f2.includes("CIRCUIT BREAKER"), "failure 2 (different spec) still carries no breaker");

    const f3 = applyRanges(parseCompressInput(compressArgs("m00001", "m00002")), ctx).text;
    assert.ok(f3.startsWith("[Compression FAILED:"), "failure 3");
    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "third consecutive failure on a THIRD distinct spec arms the breaker");
    assert.match(f3, /STOP calling compress/, "breaker demands a full stop");

    const f4 = applyRanges(parseCompressInput(compressArgs("m00001", "m00002")), ctx).text;
    assert.match(f4, /COMPRESS CIRCUIT BREAKER: 4 consecutive/, "count continues while armed");

    assert.ok(logs.some((l) => l.includes("[warn: compress-loop] circuit breaker armed after 3 consecutive")), "arm event logged for operator diagnosis");
    assert.ok(logs.some((l) => l.includes("[warn: compress-loop] failure 4 in armed streak")), "subsequent armed failures logged");
});

test("#2146: success clears the streak; later failures start fresh", () => {
    const ctx = makeCtx(fixtureMessages());
    applyRanges(parseCompressInput(compressArgs("m00001", "m00001")), ctx);
    applyRanges(parseCompressInput(compressArgs("m00002", "m00002")), ctx);
    const armed = applyRanges(parseCompressInput(compressArgs("m00001", "m00002")), ctx).text;
    assert.match(armed, /CIRCUIT BREAKER/, "precondition: streak armed");

    const ok = applyRanges(parseCompressInput(compressArgs("m00003", "m00008")), ctx).text;
    assert.ok(ok.startsWith("[Compressed "), `large range compresses (got: ${ok.slice(0, 120)})`);
    assert.equal(ctx.session.metadata["compressFailStreak"], undefined, "loop streak cleared on success");

    const after = applyRanges(parseCompressInput(compressArgs("m00001", "m00002")), ctx).text;
    assert.ok(after.startsWith("[Compression FAILED:"), "small range still fails after the successful compress");
    assert.ok(!after.includes("CIRCUIT BREAKER"), "post-success failure restarts the streak at 1");
});

test("#2146: streak decays after 10 min quiet but continues within the window", () => {
    const ctx = makeCtx(fixtureMessages());
    ctx.session.metadata["compressFailStreak"] = { n: 2, lastAt: Date.now() - 11 * 60 * 1000 };
    const decayed = applyRanges(parseCompressInput(compressArgs("m00001", "m00001")), ctx).text;
    assert.ok(decayed.startsWith("[Compression FAILED:"), "fails as expected");
    assert.ok(!decayed.includes("CIRCUIT BREAKER"), "11-min-old streak decays — failure counts as #1 again");
    const s1 = ctx.session.metadata["compressFailStreak"] as { n?: number } | undefined;
    assert.equal(s1?.n, 1, "metadata restarted at n=1");

    ctx.session.metadata["compressFailStreak"] = { n: 2, lastAt: Date.now() - 9 * 60 * 1000 };
    const continued = applyRanges(parseCompressInput(compressArgs("m00002", "m00002")), ctx).text;
    assert.match(continued, /CIRCUIT BREAKER: 3 consecutive/, "9-min-old streak is still live — arms at 3");
});

test("#2146: all-refs-above-frontier gets the deterministic stale-generation diagnosis", () => {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
    ];
    const ctx = makeCtx(msgs);
    const out = applyRanges(parseCompressInput(compressArgs("m00006", "m00010")), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED:"), `unknown refs fail (got: ${out.slice(0, 120)})`);
    assert.match(out, /above this session's highest ref \(m00002\)/, "names the frontier");
    assert.match(out, /stale artifacts/, "attributes the cause to stale-generation history");

    const mixed = applyRanges(parseCompressInput(compressArgs("m00001", "m00010")), ctx).text;
    assert.ok(mixed.startsWith("[Compression FAILED:"), "still fails");
    assert.ok(!mixed.includes("above this session's highest ref"), "note suppressed when any endpoint is inside the frontier");
});

test("#2146: beyondFrontierNote unit shapes", () => {
    const res = assignRefs([textMsg("r1", "assistant", "abc"), textMsg("r2", "assistant", "def")], { existing: emptyRefMap(), nextIndex: 0 });
    const state = createInitialState();
    state.messageRefs = res.map;
    assert.match(beyondFrontierNote(state, [{ startRef: "m00006", endRef: "m00010" }]), /\(m00002\)/);
    assert.equal(beyondFrontierNote(state, [{ startRef: "m00001", endRef: "m00006" }]), "", "in-frontier start suppresses");
    assert.equal(beyondFrontierNote(state, [{ startRef: "b1", endRef: "m00010" }]), "", "block-id endpoints have no cross-namespace ordering");
    assert.equal(beyondFrontierNote(state, []), "", "empty range list");
    const emptyState = createInitialState();
    assert.equal(beyondFrontierNote(emptyState, [{ startRef: "m00001", endRef: "m00002" }]), "", "no mapped refs");
});

test("#4252: partially-past-frontier ranges get the ceiling clamp note", () => {
    const res = assignRefs([textMsg("r1", "assistant", "abc"), textMsg("r2", "assistant", "def")], { existing: emptyRefMap(), nextIndex: 0 });
    const state = createInitialState();
    state.messageRefs = res.map;
    // start inside, end above: the incident shape (allocation lags rendering)
    const note = frontierClampNote(state, [{ startRef: "m00001", endRef: "m00006" }], "");
    assert.match(note, /highest stored ref \(m00002\)/, "names the ceiling");
    assert.match(note, /Retry with endId ≤ m00002/, "gives the actionable clamp");
    // suppressed when the all-above note already fired
    assert.equal(frontierClampNote(state, [{ startRef: "m00006", endRef: "m00010" }], "beyond"), "", "beyond note takes precedence");
    // fully in-frontier ranges get nothing
    assert.equal(frontierClampNote(state, [{ startRef: "m00001", endRef: "m00002" }], ""), "", "in-frontier suppresses");
    // b-refs have no cross-namespace ordering — never fire
    assert.equal(frontierClampNote(state, [{ startRef: "b1", endRef: "b9" }], ""), "", "block-id endpoints ignored");
    // empty state / empty ranges
    assert.equal(frontierClampNote(createInitialState(), [{ startRef: "m00001", endRef: "m00002" }], ""), "", "no mapped refs");
    assert.equal(frontierClampNote(state, [], ""), "", "empty range list");
});

test("#4252: mixed receipt names the ceiling instead of generic guidance", () => {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
    ];
    const ctx = makeCtx(msgs);
    const mixed = applyRanges(parseCompressInput(compressArgs("m00001", "m00010")), ctx).text;
    assert.ok(mixed.startsWith("[Compression FAILED:"), "still fails");
    assert.match(mixed, /highest stored ref \(m00002\)/, "clamp note present for start-in/end-out");
    assert.match(mixed, /Retry with endId ≤ m00002/, "actionable clamp in the receipt");
    assert.match(mixed, /m00010/, "the above-frontier endpoint stays verbatim (typo-correctable)");
});

test("#2146: loopTracking:false (preflight lane) never touches the model-facing streak", () => {
    const ctx = makeCtx(fixtureMessages());
    for (let i = 0; i < 5; i++) {
        const out = applyRanges(parseCompressInput(compressArgs(i % 2 === 0 ? "m00001" : "m00002", i % 2 === 0 ? "m00001" : "m00002")), ctx, { loopTracking: false }).text;
        assert.ok(out.startsWith("[Compression FAILED:"), "internal-lane call still reports its failure");
        assert.ok(!out.includes("CIRCUIT BREAKER"), "internal lane never shows the breaker");
    }
    assert.equal(ctx.session.metadata["compressFailStreak"], undefined, "streak untouched across 5 internal failures");

    const tracked = applyRanges(parseCompressInput(compressArgs("m00001", "m00001")), ctx).text;
    assert.ok(!tracked.includes("CIRCUIT BREAKER"), "first tracked failure after the internal storm starts fresh");
});

test("#2146: stale-generation receipts scrub the phantom refs; in-frontier failures keep them verbatim", () => {
    const ctx = makeCtx(fixtureMessages());
    const stale = applyRanges(parseCompressInput(compressArgs("m00010", "m00014")), ctx).text;
    assert.ok(stale.startsWith("[Compression FAILED:"), `unknown refs fail (got: ${stale.slice(0, 120)})`);
    assert.match(stale, /above this session's highest ref \(m00008\)/, "frontier diagnosis present");
    assert.doesNotMatch(stale, /m00010|m00014/, "phantom endpoints are NOT echoed back into the client-persisted receipt");
    assert.match(stale, /\[stale-ref\]/, "scrubbed marker takes their place");

    const mixed = applyRanges(parseCompressInput(compressArgs("m00001", "m00009")), ctx).text;
    assert.ok(mixed.startsWith("[Compressed "), "#4521 flip: an out-frontier endId clamps to the highest allocated ref instead of failing");
    assert.match(mixed, /endId="m00009" is above this session's highest allocated ref \(m00008\)/, "the receipt names the clamp");
    assert.match(mixed, /clamped to it/, "the model is told what happened to its endpoint");
    assert.match(mixed, /m00009/, "the above-frontier endpoint stays verbatim (typo-correctable)");
});
