import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "summary ".repeat(20);

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue4812-${randomUUID()}`,
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

// Same shape as the #2146 fixture: two sub-gate messages plus six big ones, so
// m00003–m00008 is a guaranteed-success spec while single-message ranges fail
// at the kernel gate.
function fixtureMessages(): CoreMessage[] {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
    ];
    for (let i = 3; i <= 8; i++) msgs.push(textMsg(`raw_${i}`, "assistant", "x".repeat(5000)));
    return msgs;
}

// The #4812 field shape: content is a plain summary string with no mNNNNN refs
// header anywhere — parses to zero ranges every time, exactly like the
// reporter's six identical attempts.
function malformedArgs() {
    return JSON.parse(JSON.stringify({ content: ["just some summary prose without any message refs"] }));
}

function validArgs(startId: string, endId: string) {
    return JSON.parse(JSON.stringify({ content: [{ startId, endId, summary: SUMMARY }] }));
}

test("#4812: parse-failure receipts collapse to a short refusal once the breaker climbs past the arm moment", () => {
    const ctx = makeCtx(fixtureMessages());

    const f1 = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.ok(f1.startsWith("[Compression FAILED:"), `failure 1 (got: ${f1.slice(0, 120)})`);
    assert.match(f1, /compress takes exactly ONE argument shape/, "failure 1 carries the full format lecture");
    assert.ok(!f1.includes("CIRCUIT BREAKER"), "failure 1 not armed");

    const f2 = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.match(f2, /compress takes exactly ONE argument shape/, "failure 2 still carries the lecture");
    assert.ok(!f2.includes("CIRCUIT BREAKER"), "failure 2 not armed");

    const f3 = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "arm moment keeps its verbatim paragraph");
    assert.match(f3, /compress takes exactly ONE argument shape/, "arm-moment receipt keeps the full lecture (unchanged)");

    const f4 = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.ok(f4.startsWith("[Compression refused:"), `failure 4 collapses (got: ${f4.slice(0, 120)})`);
    assert.match(f4, /still armed \(4 consecutive failures\)/, "names the armed count");
    assert.doesNotMatch(f4, /compress takes exactly ONE argument shape/, "no full lecture past the arm moment");
    assert.doesNotMatch(f4, /COMPRESS CIRCUIT BREAKER: 4 consecutive/, "no repeated verbatim paragraph either");
    assert.doesNotMatch(f4, /acp_status/, "no contradictory order beside the loop-noise stop (#2360)");
    assert.match(f4, /ONE plain string holding every range/, "keeps a one-line format reminder");
    assert.match(f4, /disarms on one successful fold or 10 minutes/, "states the disarm conditions");
    assert.ok(f4.length < 700, `short refusal stays small (got ${f4.length} chars)`);

    const f5 = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.match(f5, /still armed \(5 consecutive failures\)/, "count keeps climbing while refused");

    const streak = ctx.session.metadata["compressFailStreak"] as { n: number };
    assert.equal(streak.n, 5, "refused calls keep counting (lastAt refreshes — hammering cannot ride out the decay)");
});

test("#4812: a valid-parsing call while armed is never blocked — success clears the breaker", () => {
    const ctx = makeCtx(fixtureMessages());
    for (let i = 0; i < 4; i++) applyRanges(parseCompressInput(malformedArgs()), ctx);
    const ok = applyRanges(parseCompressInput(validArgs("m00003", "m00008")), ctx).text;
    assert.ok(ok.startsWith("[Compressed "), `valid range compresses while armed (got: ${ok.slice(0, 120)})`);
    assert.equal(ctx.session.metadata["compressFailStreak"], undefined, "success clears the streak");
});

test("#4812: preflight lane (loopTracking:false) parse failures never arm and never collapse", () => {
    const ctx = makeCtx(fixtureMessages());
    for (let i = 0; i < 5; i++) {
        const out = applyRanges(parseCompressInput(malformedArgs()), ctx, { loopTracking: false }).text;
        assert.ok(out.startsWith("[Compression FAILED:"), "internal lane keeps the full failure receipt");
        assert.match(out, /compress takes exactly ONE argument shape/, "no collapse — internal lane never arms");
    }
    assert.equal(ctx.session.metadata["compressFailStreak"], undefined, "streak untouched across 5 internal failures");
});

test("#4812: after 10 min quiet the next parse failure restarts teaching (full lecture again)", () => {
    const ctx = makeCtx(fixtureMessages());
    ctx.session.metadata["compressFailStreak"] = { n: 5, lastAt: Date.now() - 11 * 60 * 1000 };
    const out = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED:"), "decayed streak restarts at n=1");
    assert.match(out, /compress takes exactly ONE argument shape/, "full lecture returned after quiet");
    assert.ok(!out.includes("CIRCUIT BREAKER"), "not re-armed on the first post-decay failure");
    const streak = ctx.session.metadata["compressFailStreak"] as { n: number };
    assert.equal(streak.n, 1, "metadata restarted at n=1");
});

test("#4812: seeded substrate-destruction cause still gets the short refusal for blind parse failures", () => {
    const ctx = makeCtx(fixtureMessages());
    ctx.session.metadata["compressFailStreak"] = { n: 3, lastAt: Date.now(), cause: "substrate-destruction — fold substrate destroyed by an out-of-band history rewrite" };
    const out = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.ok(out.startsWith("[Compression refused:"), `substrate cause collapses too (got: ${out.slice(0, 120)})`);
    assert.match(out, /still armed \(4 consecutive failures\)/, "count continues under the seeded cause");
});

test("#4812: empty-companion and corrupt-args lectures collapse under the same rule", () => {
    const ctx = makeCtx(fixtureMessages());
    for (let i = 0; i < 3; i++) applyRanges(parseCompressInput(JSON.parse("{}")), ctx);
    const empty = applyRanges(parseCompressInput(JSON.parse("{}")), ctx).text;
    assert.ok(empty.startsWith("[Compression refused:"), `empty call collapses at n=4 (got: ${empty.slice(0, 120)})`);

    const ctx2 = makeCtx(fixtureMessages());
    for (let i = 0; i < 3; i++) applyRanges(parseCompressInput("{ not json"), ctx2);
    const corrupt = applyRanges(parseCompressInput("{ not json"), ctx2).text;
    assert.ok(corrupt.startsWith("[Compression refused:"), `corrupt args collapse at n=4 (got: ${corrupt.slice(0, 120)})`);
});
