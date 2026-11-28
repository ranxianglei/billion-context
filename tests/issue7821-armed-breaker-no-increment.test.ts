// #7821: while the compress circuit breaker is already armed, a further
// failure (parse or stale-ref) was counted as a NEW failure — incrementing n
// and refreshing lastAt — so the 10-minute decay could never elapse while the
// model kept retrying, and the armed receipt withheld the specific cause.
// Armed refusals must be REFUSALS, not new failures: they must not increment
// n, must not refresh lastAt, and must surface the last failure's cause so the
// model can self-correct even while the breaker is armed.

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
        id: `issue7821-${randomUUID()}`,
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

function streakOf(session: Session): { n: number; lastAt: number } | undefined {
    return session.metadata["compressFailStreak"] as { n: number; lastAt: number } | undefined;
}

test("#7821: armed parse-failure refusal does NOT increment n or refresh lastAt", () => {
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const ctx = makeCtx(msgs);

    // Arm the breaker at n=5 with a known lastAt.
    const armedLastAt = Date.now() - 5 * 60 * 1000;
    ctx.session.metadata["compressFailStreak"] = { n: 5, lastAt: armedLastAt, cause: "parse:no-valid-ranges" };
    assert.equal(compressBreakerArmed(ctx.session), true, "setup: breaker must be armed");

    // A parse failure (empty content) while armed must be a REFUSAL, not a new
    // failure: n stays at 5, lastAt is not refreshed.
    const r = applyRanges(parseCompressInput({ content: [] }), ctx);
    const st = streakOf(ctx.session);
    assert.equal(st?.n, 5, "armed parse-failure refusal must not increment n");
    assert.equal(st?.lastAt, armedLastAt, "armed parse-failure refusal must not refresh lastAt");
    assert.ok(r.text.startsWith("[Compression refused:"), `armed refusal receipt (got: ${r.text.slice(0, 80)})`);
    assert.match(r.text, /compress circuit breaker is still armed \(5 consecutive failures\)/, "receipt names the (unchanged) counter");
});

test("#7821: armed parse-failure refusal surfaces the last failure's cause", () => {
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const ctx = makeCtx(msgs);

    // Arm the breaker with a specific cause.
    ctx.session.metadata["compressFailStreak"] = { n: 4, lastAt: Date.now() - 2 * 60 * 1000, cause: "line entry: missing summary after the refs header line" };
    assert.equal(compressBreakerArmed(ctx.session), true, "setup: breaker must be armed");

    // A fresh parse failure while armed: the receipt must carry the specific
    // cause (invalidReasons[0]) so the model can self-correct.
    const r = applyRanges(parseCompressInput({ content: "m00001–m00002" }), ctx);
    assert.ok(r.text.startsWith("[Compression refused:"), `armed refusal receipt (got: ${r.text.slice(0, 80)})`);
    assert.match(r.text, /Last failure:/, "receipt names the last failure's cause");
});

test("#7821: un-armed parse-failure STILL increments n (normal behavior preserved)", () => {
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const ctx = makeCtx(msgs);

    // Below threshold: a parse failure must still increment n.
    ctx.session.metadata["compressFailStreak"] = { n: 2, lastAt: Date.now() };
    assert.equal(compressBreakerArmed(ctx.session), false, "setup: breaker must be disarmed");

    applyRanges(parseCompressInput({ content: [] }), ctx);
    const st = streakOf(ctx.session);
    assert.equal(st?.n, 3, "un-armed parse-failure still increments n");
});

test("#7821: armed stale-ref refusal does NOT increment n or refresh lastAt", () => {
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const ctx = makeCtx(msgs);

    // Arm the breaker at n=6 with a known lastAt.
    const armedLastAt = Date.now() - 3 * 60 * 1000;
    ctx.session.metadata["compressFailStreak"] = { n: 6, lastAt: armedLastAt, cause: "stale-ref — the refs belong to another session generation" };
    assert.equal(compressBreakerArmed(ctx.session), true, "setup: breaker must be armed");

    // A stale-ref failure (m99999 is far above the highest mapped ref) while
    // armed must be a REFUSAL, not a new failure: n stays at 6, lastAt is not
    // refreshed.
    const r = applyRanges(parseCompressInput(compressArgs("m99999", "m99999")), ctx);
    const st = streakOf(ctx.session);
    assert.equal(st?.n, 6, "armed stale-ref refusal must not increment n");
    assert.equal(st?.lastAt, armedLastAt, "armed stale-ref refusal must not refresh lastAt");
    assert.ok(r.text.startsWith("[Compression FAILED:"), `stale-ref receipt (got: ${r.text.slice(0, 80)})`);
});

test("#7821: the decay can elapse while the breaker is armed (no re-arming by refusal)", () => {
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const ctx = makeCtx(msgs);

    // Arm the breaker at n=5, with lastAt just inside the decay window.
    ctx.session.metadata["compressFailStreak"] = { n: 5, lastAt: Date.now() - 9 * 60 * 1000, cause: "parse:no-valid-ranges" };
    assert.equal(compressBreakerArmed(ctx.session), true, "setup: breaker must be armed");

    // A parse failure while armed must NOT refresh lastAt — so after the decay
    // window elapses the breaker reads as disarmed (the model can try again).
    applyRanges(parseCompressInput({ content: [] }), ctx);
    const st = streakOf(ctx.session);
    assert.equal(st?.n, 5, "n unchanged");
    assert.ok(st!.lastAt <= Date.now() - 9 * 60 * 1000 + 1000, "lastAt not refreshed (still ~9 min old)");
});
