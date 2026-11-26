// #7762: a summary-length validation failure (the one compress failure class
// the CALLER can fix — pass summaryMaxChars, or shorten/split the offending
// summary) used to count toward the compress loop breaker (#2146) exactly like
// the unfixable loop-noise class. Three consecutive over-long summaries armed
// the breaker, whose STOP text ("do not try other ranges, do not re-issue any
// previous range") forbade the very remedy the kernel's per-range error
// advertises in the SAME receipt ("Or pass summaryMaxChars to increase the
// limit") — a long session was left unable to compress. Length-class failures
// are now excluded from the streak: they are fixable, not loop noise.
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

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue7762-${randomUUID()}`,
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

// A range whose total content is >= minCompressRange (5000) so it passes the
// size gate and reaches the summary-length validation; the summary itself is
// over the (small) configured cap.
function lengthFailCtx(): RewriteCtx & { session: Session; config: Config } {
    const msgs = [
        textMsg("raw_1", "assistant", "a".repeat(3000)),
        textMsg("raw_2", "user", "b".repeat(3000)),
    ];
    const config = defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    config.compress.maxSummaryLength = 100;
    return makeCtx(msgs, config);
}

function overLongArgs(): unknown {
    return JSON.parse(JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s".repeat(300) }] }));
}

test("#7762: repeated summary-length failures do NOT arm the compress loop breaker", () => {
    const ctx = lengthFailCtx();
    // Four consecutive over-long summaries — well past the threshold of 3.
    for (let i = 0; i < 4; i++) {
        const out = applyRanges(parseCompressInput(overLongArgs()), ctx).text;
        assert.ok(out.startsWith("[Compression FAILED:"), `attempt ${i + 1} fails on length (got: ${out.slice(0, 100)})`);
        assert.match(out, /Summary too long/, "kernel reports the length failure");
        assert.match(out, /pass summaryMaxChars/, "the fixable remedy stays advertised");
        assert.ok(!out.includes("CIRCUIT BREAKER"), `attempt ${i + 1} must NOT arm the breaker`);
        assert.ok(!out.includes("STOP calling compress now"), `attempt ${i + 1} must NOT carry the STOP order`);
    }
    assert.equal(compressBreakerArmed(ctx.session), false, "breaker stays disarmed after repeated length failures");
    assert.equal(ctx.session.metadata["compressFailStreak"], undefined, "no streak written for length-class failures");
});

test("#7762: a length failure does not extend an existing unfixable-failure streak", () => {
    const ctx = lengthFailCtx();
    // Seed a 2-failure streak (below the threshold of 3) from a prior
    // unfixable failure; the length failure must not push it to the threshold.
    ctx.session.metadata["compressFailStreak"] = { n: 2, lastAt: Date.now() };
    const out = applyRanges(parseCompressInput(overLongArgs()), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED:"), "length failure");
    assert.ok(!out.includes("CIRCUIT BREAKER"), "the length failure must not arm the breaker");
    const st = ctx.session.metadata["compressFailStreak"] as { n: number } | undefined;
    assert.equal(st?.n, 2, "streak count unchanged by the length failure");
});

test("#7762 (control): a non-length gate failure still arms the breaker at three", () => {
    // A sub-gate range (1600 chars < 5000 minCompressRange) is a NON-length
    // failure — it must still count and arm, proving the exclusion is scoped
    // to the summary-length class and not a blanket no-op of the breaker.
    const msgs = [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "user", "b".repeat(800)),
    ];
    const ctx = makeCtx(msgs, defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 }));
    const args = JSON.parse(JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s".repeat(60) }] }));
    for (let i = 0; i < 2; i++) {
        const out = applyRanges(parseCompressInput(args), ctx).text;
        assert.ok(out.startsWith("[Compression FAILED:"), `control attempt ${i + 1} fails at the size gate`);
        assert.ok(!out.includes("CIRCUIT BREAKER"), `control attempt ${i + 1} below threshold`);
    }
    const third = applyRanges(parseCompressInput(args), ctx).text;
    assert.match(third, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "third non-length failure still arms the breaker");
});
