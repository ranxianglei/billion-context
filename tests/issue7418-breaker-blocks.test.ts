// #7418: the compress circuit breaker (#2146) armed after 3 consecutive
// failures but only APPENDED prose to the receipt — no code path ever actually
// refused execution, so a looping model kept calling compress (and failing) to
// the 70th+ attempt while the breaker sat armed. The fix: once the breaker is
// armed (n >= threshold, within the decay window), applyRanges refuses EVERY
// model-initiated compress call with a terminal refusal BEFORE execution. The
// breaker disarms on 10 min without a failing call (a blocked model makes no
// new failing call, so the quiet window runs from the last failure — bounded
// cycle, no deadlock). This is the enforcement layer #7197 found missing.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, compressBreakerArmed, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "summary ".repeat(20);

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue7418-${randomUUID()}`,
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

function makeCtx(messages: CoreMessage[], config?: Config): RewriteCtx & { session: Session; config: Config } {
    const session = makeSession();
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: config ?? defaultConfig(200000), messages, session, log: () => {} };
}

function compressArgs(startId: string, endId: string) {
    return JSON.parse(JSON.stringify({ content: [{ startId, endId, summary: SUMMARY }] }));
}

test("#7418: armed breaker BLOCKS compress execution — terminal refusal before applyCompression", () => {
    // Six big messages (compressible). The breaker is armed (n=4, fresh).
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const ctx = makeCtx(msgs);
    ctx.session.metadata["compressFailStreak"] = { n: 4, lastAt: Date.now() };
    assert.equal(compressBreakerArmed(ctx.session), true, "breaker is armed before the call");

    // The call must be REFUSED before execution — not run, not folded.
    const r = applyRanges(parseCompressInput(compressArgs("m00001", "m00003")), ctx);
    assert.equal(r.outcome, "refused", "armed breaker refuses the call");
    assert.equal(r.blocksCreated, 0, "no range was folded");
    assert.equal(r.reason, "breaker-armed", "reason identifies the armed breaker");
    assert.match(r.text, /compress circuit breaker is armed \(4 consecutive failures/, "receipt names the armed counter");
    assert.match(r.text, /NOT because of your range selection/, "receipt states the refusal is due to the streak, not range choice");
    assert.match(r.text, /refused before execution and no range is folded|BLOCKED before execution/, "receipt states nothing was folded");
    assert.match(r.text, /disarms on 10 minutes without a failing call/, "receipt states the disarm condition");
    // The refusal must NOT carry the "try a different range" hint that
    // #7418 identified as the loop driver.
    assert.doesNotMatch(r.text, /Combine more messages into your range/, "no retry-inviting hint");
    assert.doesNotMatch(r.text, /try another range/i, "no 'try another range' wording");
    // The breaker must STILL be armed after the refusal (the refusal does not
    // charge the ledger, so the streak is unchanged — the quiet window runs
    // from the last failing call, not from this refusal).
    assert.equal(compressBreakerArmed(ctx.session), true, "breaker stays armed after the refusal");
    const st = ctx.session.metadata["compressFailStreak"] as { n: number };
    assert.equal(st.n, 4, "streak unchanged by the refusal (no ledger charge)");
});

test("#7418: armed breaker blocks REPEATED calls — the loop is actually stopped", () => {
    // The #7418 repro: the model kept calling compress (and failing) to the
    // 70th+ attempt while the breaker sat armed. After the fix, EVERY call
    // while armed is refused before execution — the loop is stopped, not just
    // advised against.
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const ctx = makeCtx(msgs);
    ctx.session.metadata["compressFailStreak"] = { n: 78, lastAt: Date.now() };

    // Simulate the loop: 10 consecutive calls with DIFFERENT specs, all must be refused.
    const specs: Array<[string, string]> = [
        ["m00001", "m00003"],
        ["m00004", "m00006"],
        ["m00001", "m00002"],
        ["m00005", "m00006"],
        ["m00002", "m00004"],
        ["m00003", "m00005"],
        ["m00001", "m00004"],
        ["m00002", "m00005"],
        ["m00003", "m00006"],
        ["m00001", "m00006"],
    ];
    for (let i = 0; i < specs.length; i++) {
        const [s, e] = specs[i];
        const r = applyRanges(parseCompressInput(compressArgs(s, e)), ctx);
        assert.equal(r.outcome, "refused", `call ${i + 1} (spec ${s}..${e}) refused while armed`);
        assert.equal(r.blocksCreated, 0, `call ${i + 1} folded nothing`);
        assert.equal(r.reason, "breaker-armed", `call ${i + 1} refused by the armed breaker`);
    }
    // The streak must NOT have climbed (the refusals don't charge the ledger).
    const st = ctx.session.metadata["compressFailStreak"] as { n: number };
    assert.equal(st.n, 78, "streak did not climb across 10 refused calls");
});

test("#7418: disarmed breaker does NOT block — the normal path proceeds", () => {
    // Negative case: with the breaker disarmed (n=2, below threshold), the
    // call must NOT be blocked by the armed-breaker check — it proceeds to the
    // normal execution path.
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const ctx = makeCtx(msgs);
    ctx.session.metadata["compressFailStreak"] = { n: 2, lastAt: Date.now() };
    assert.equal(compressBreakerArmed(ctx.session), false, "breaker is disarmed (below threshold)");

    const r = applyRanges(parseCompressInput(compressArgs("m00001", "m00003")), ctx);
    assert.notEqual(r.reason, "breaker-armed", "not blocked by the disarmed breaker");
    assert.doesNotMatch(r.text, /compress circuit breaker is armed/, "no armed-blocker receipt");
});

test("#7418: decayed breaker does NOT block — the quiet window lapses the arm", () => {
    // Negative case: with the breaker decayed (n=4 but lastAt 11 min ago,
    // beyond the 10-min decay window), the call must NOT be blocked.
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const ctx = makeCtx(msgs);
    ctx.session.metadata["compressFailStreak"] = { n: 4, lastAt: Date.now() - 11 * 60 * 1000 };
    assert.equal(compressBreakerArmed(ctx.session), false, "breaker is decayed (reads disarmed)");

    const r = applyRanges(parseCompressInput(compressArgs("m00001", "m00003")), ctx);
    assert.notEqual(r.reason, "breaker-armed", "not blocked by the decayed breaker");
});

test("#7418: preflight overflow-compress (loopTracking=false) is exempt from the armed-block", () => {
    // The preflight overflow-compress is bili's OWN internal lane — its
    // failures have separate reporting and must not be blocked by the
    // model-facing breaker (same exemption as the requireNudge gate).
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const ctx = makeCtx(msgs);
    ctx.session.metadata["compressFailStreak"] = { n: 4, lastAt: Date.now() };
    assert.equal(compressBreakerArmed(ctx.session), true, "breaker is armed");

    const r = applyRanges(parseCompressInput(compressArgs("m00001", "m00003")), ctx, { loopTracking: false });
    assert.notEqual(r.reason, "breaker-armed", "preflight lane is exempt from the armed-block");
});
