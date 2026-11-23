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

// #7300: the breaker streak used to reset on ANY successful compress, so the
// incident's "fail×N → trivial-success×1 → fail×N" loop (398 calls, 289
// "too small" fails, 92 trivial successes netting only 86–290 tokens) never
// armed the 3-strike breaker. A trivial success — one whose NET saving (folded
// mass minus the new summary mass) is below COMPRESS_LOOP_DISCHARGE_MIN_TOKENS
// (500) — is the model still probing a barely-over-minimum range, not
// "compression is working", and must not discharge the streak.

const SUMMARY = "summary ".repeat(20); // 160 chars → ~40 tokens (substantial folds)
const TRIVIAL_SUMMARY = "s".repeat(3500); // 3500 chars → ~875 tokens

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue7300-${randomUUID()}`,
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

function compressArgs(startId: string, endId: string, summary: string = SUMMARY) {
    return JSON.parse(JSON.stringify({ content: [{ startId, endId, summary }] }));
}

// Two sub-gate messages (800 chars each → "too small" failures), one
// barely-over-minimum message (5000 chars → a trivial fold when its summary is
// long enough that the net saving stays under 500 tokens), and four 5000-char
// padding messages after it. The padding must accumulate ≥ preserveRecentTokens
// (5000 tok) so the tail-token protection rule stops BEFORE reaching m00003 —
// otherwise the whole small session sits inside the protected zone and the
// trivial fold is a no-op.
function trivialFixture(): CoreMessage[] {
    return [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
        textMsg("raw_3", "assistant", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "c".repeat(5000)),
        textMsg("raw_5", "assistant", "d".repeat(5000)),
        textMsg("raw_6", "assistant", "e".repeat(5000)),
        textMsg("raw_7", "assistant", "f".repeat(5000)),
    ];
}

// The same two sub-gate messages plus six 5000-char messages (30000 chars → a
// guaranteed substantial fold when summarized with the short 160-char summary).
function substantialFixture(): CoreMessage[] {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
    ];
    for (let i = 3; i <= 8; i++) msgs.push(textMsg(`raw_${i}`, "assistant", "x".repeat(5000)));
    return msgs;
}

test("#7300: a trivial success (net saving < 500 tok) does NOT discharge the breaker", () => {
    const logs: string[] = [];
    const ctx = makeCtx(trivialFixture(), undefined, logs);

    const f1 = applyRanges(parseCompressInput(compressArgs("m00001", "m00001")), ctx).text;
    assert.ok(f1.startsWith("[Compression FAILED:"), `failure 1 at the too-small gate (got: ${f1.slice(0, 120)})`);
    assert.ok(!f1.includes("CIRCUIT BREAKER"), "failure 1 carries no breaker");

    const f2 = applyRanges(parseCompressInput(compressArgs("m00002", "m00002")), ctx).text;
    assert.ok(f2.startsWith("[Compression FAILED:"), "failure 2");
    assert.ok(!f2.includes("CIRCUIT BREAKER"), "failure 2 still carries no breaker");

    // m00003 is 5000 chars (just over the 5000-char minimum) summarized to
    // 3500 chars: folded mass ≈ 1250 tok, new summary ≈ 875 tok, net saving
    // ≈ 375 tok < 500 → a TRIVIAL success. It must NOT reset the streak.
    const trivial = applyRanges(parseCompressInput(compressArgs("m00003", "m00003", TRIVIAL_SUMMARY)), ctx).text;
    assert.ok(trivial.startsWith("[Compressed "), `trivial fold succeeds (got: ${trivial.slice(0, 120)})`);
    const afterTrivial = ctx.session.metadata["compressFailStreak"] as { n?: number } | undefined;
    assert.equal(afterTrivial?.n, 2, "trivial success must NOT reset the streak (still n=2)");

    // One more failure → n=3 → the breaker must arm, proving the trivial
    // success did not discharge it (the pre-fix behavior reset here, so the
    // loop never armed).
    const f3 = applyRanges(parseCompressInput(compressArgs("m00001", "m00002")), ctx).text;
    assert.ok(f3.startsWith("[Compression FAILED:"), "failure 3");
    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "breaker must arm — the trivial success must not have reset the strikes");
    assert.ok(logs.some((l) => l.includes("[warn: compress-loop] circuit breaker armed after 3 consecutive")), "arm event logged for operator diagnosis");
});

test("#7300: a substantial success (net saving ≥ 500 tok) DOES discharge the breaker (negative direction)", () => {
    const ctx = makeCtx(substantialFixture());

    const f1 = applyRanges(parseCompressInput(compressArgs("m00001", "m00001")), ctx).text;
    assert.ok(f1.startsWith("[Compression FAILED:"), "failure 1");
    const f2 = applyRanges(parseCompressInput(compressArgs("m00002", "m00002")), ctx).text;
    assert.ok(f2.startsWith("[Compression FAILED:"), "failure 2");

    // m00003–m00008 is 30000 chars summarized to 160 chars: folded mass
    // ≈ 7500 tok, new summary ≈ 40 tok, net saving ≈ 7460 tok ≥ 500 → a
    // SUBSTANTIAL success. It MUST reset the streak.
    const substantial = applyRanges(parseCompressInput(compressArgs("m00003", "m00008")), ctx).text;
    assert.ok(substantial.startsWith("[Compressed "), `substantial fold succeeds (got: ${substantial.slice(0, 120)})`);
    assert.equal(ctx.session.metadata["compressFailStreak"], undefined, "substantial success clears the streak");

    // A later failure restarts the streak at 1 — no breaker.
    const after = applyRanges(parseCompressInput(compressArgs("m00001", "m00002")), ctx).text;
    assert.ok(after.startsWith("[Compression FAILED:"), "small range still fails after the successful compress");
    assert.ok(!after.includes("CIRCUIT BREAKER"), "post-substantial-success failure restarts the streak at 1");
});

test("#7300: a trivial success alone (no prior failures) is a no-op on the streak", () => {
    const ctx = makeCtx(trivialFixture());
    const trivial = applyRanges(parseCompressInput(compressArgs("m00003", "m00003", TRIVIAL_SUMMARY)), ctx).text;
    assert.ok(trivial.startsWith("[Compressed "), "trivial fold succeeds");
    assert.equal(ctx.session.metadata["compressFailStreak"], undefined, "no streak exists to clear — trivial success is a no-op");
});
