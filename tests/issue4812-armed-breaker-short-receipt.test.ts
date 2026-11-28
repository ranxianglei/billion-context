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

test("#4812: parse-failure receipts collapse per-repeat once the breaker climbs past the arm moment", () => {
    const ctx = makeCtx(fixtureMessages());

    const f1 = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.ok(f1.startsWith("[Compression FAILED:"), `failure 1 (got: ${f1.slice(0, 120)})`);
    assert.match(f1, /compress takes ONE 'content' STRING/, "failure 1 carries the full format lecture");
    assert.ok(!f1.includes("CIRCUIT BREAKER"), "failure 1 not armed");

    // 2nd identical parse failure: the one-liner replaces the lecture — the
    // field loop stacked a 200-word receipt per retry; one counter, stated
    // once, pointing back at the FIRST receipt that still teaches.
    const f2 = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.ok(f2.startsWith("[Compression FAILED again"), `failure 2 collapses to the one-liner (got: ${f2.slice(0, 120)})`);
    assert.match(f2, /2 time\(s\)/, "one-liner carries the repeat count");
    assert.doesNotMatch(f2, /compress takes ONE 'content' STRING/, "no repeated lecture on repeats");
    assert.ok(!f2.includes("CIRCUIT BREAKER"), "failure 2 not armed");

    const f3 = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.ok(f3.startsWith("[Compression FAILED again"), `failure 3 stays on the one-liner (got: ${f3.slice(0, 120)})`);
    assert.match(f3, /3 time\(s\)/, "count keeps climbing on the one-liner");
    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "arm-moment paragraph rides the one-liner verbatim");
    assert.doesNotMatch(f3, /compress takes ONE 'content' STRING/, "arm-moment receipt no longer repeats the lecture");

    // #7418 Option A: once armed, the 4th call is BLOCKED before execution —
    // the armed block refusal replaces the #4812 short receipt. The blocked
    // call does not call noteCompressLoopFailure, so the streak stays at 3.
    const f4 = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.ok(f4.startsWith("[Compression refused:"), `failure 4 is blocked (got: ${f4.slice(0, 120)})`);
    assert.match(f4, /the compress circuit breaker is armed \(3 consecutive failures/, "names the armed count (#7418)");
    assert.match(f4, /NOT because of your range selection/, "refusal states the reason is the streak, not range choice");
    assert.match(f4, /BLOCKED before execution/, "refusal states compress is blocked");
    assert.doesNotMatch(f4, /compress takes ONE 'content' STRING/, "no full lecture past the arm moment");
    assert.doesNotMatch(f4, /COMPRESS CIRCUIT BREAKER: 4 consecutive/, "no repeated verbatim paragraph either");
    assert.doesNotMatch(f4, /acp_status/, "no contradictory order beside the loop-noise stop (#2360)");
    assert.match(f4, /disarms on 10 minutes without a failing call/, "states the disarm condition (#7418)");
    assert.ok(f4.length < 700, `short refusal stays small (got ${f4.length} chars)`);

    const f5 = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.match(f5, /the compress circuit breaker is armed \(3 consecutive failures/, "still blocked while armed (#7418)");

    const streak = ctx.session.metadata["compressFailStreak"] as { n: number };
    assert.equal(streak.n, 3, "blocked calls do not increment the streak (#7418)");
});

test("#4812: a valid-parsing call while armed is now blocked (#7418)", () => {
    const ctx = makeCtx(fixtureMessages());
    for (let i = 0; i < 4; i++) applyRanges(parseCompressInput(malformedArgs()), ctx);
    // #7418 Option A: once armed, EVERY model-initiated compress call is
    // refused before execution — even a valid range that would be a substantial
    // success. The "success disarms while armed" recovery path is removed:
    // under the #7418 trigger conditions no successful spec exists, so probing
    // just extends the loop. The breaker disarms on 10 min without a failing
    // call (bounded cycle, no deadlock).
    const ok = applyRanges(parseCompressInput(validArgs("m00003", "m00008")), ctx).text;
    assert.match(ok, /the compress circuit breaker is armed/, "valid range is blocked while the breaker is armed (#7418)");
    assert.match(ok, /NOT because of your range selection/, "refusal states the reason is the streak, not range choice");
    assert.equal((ctx.session.metadata["compressFailStreak"] as { n: number }).n, 3, "blocked call does not clear the streak");
});

test("#4812: preflight lane (loopTracking:false) parse failures never arm and never collapse", () => {
    const ctx = makeCtx(fixtureMessages());
    for (let i = 0; i < 5; i++) {
        const out = applyRanges(parseCompressInput(malformedArgs()), ctx, { loopTracking: false }).text;
        assert.ok(out.startsWith("[Compression FAILED:"), "internal lane keeps the full failure receipt");
        assert.match(out, /compress takes ONE 'content' STRING/, "no collapse — internal lane never arms");
    }
    assert.equal(ctx.session.metadata["compressFailStreak"], undefined, "streak untouched across 5 internal failures");
});

test("#4812: after 10 min quiet the next parse failure restarts teaching (full lecture again)", () => {
    const ctx = makeCtx(fixtureMessages());
    ctx.session.metadata["compressFailStreak"] = { n: 5, lastAt: Date.now() - 11 * 60 * 1000 };
    const out = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED:"), "decayed streak restarts at n=1");
    assert.match(out, /compress takes ONE 'content' STRING/, "full lecture returned after quiet");
    assert.ok(!out.includes("CIRCUIT BREAKER"), "not re-armed on the first post-decay failure");
    const streak = ctx.session.metadata["compressFailStreak"] as { n: number };
    assert.equal(streak.n, 1, "metadata restarted at n=1");
});

test("#4812: seeded substrate-destruction cause gets the armed block refusal for blind parse failures (#7418)", () => {
    const ctx = makeCtx(fixtureMessages());
    ctx.session.metadata["compressFailStreak"] = { n: 3, lastAt: Date.now(), cause: "substrate-destruction — fold substrate destroyed by an out-of-band history rewrite" };
    const out = applyRanges(parseCompressInput(malformedArgs()), ctx).text;
    assert.ok(out.startsWith("[Compression refused:"), `substrate cause is blocked (#7418) (got: ${out.slice(0, 120)})`);
    assert.match(out, /the compress circuit breaker is armed \(3 consecutive failures/, "blocked while armed under the seeded cause");
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
