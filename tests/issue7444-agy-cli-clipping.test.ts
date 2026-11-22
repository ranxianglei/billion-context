import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { effectiveTokenCount } from "../src/server.ts";
import type { Session } from "../src/session.ts";
import type { CoreMessage } from "acp-kernel";

// #7444: agy-cli (opencode-agy-cli-auth) clips replayed history to 112 KiB
// (maxInitialPromptBytes, agy.exe's 128 KiB ACP prompt limit) on every replay
// (no_live / drop_live / model switch). bili forwards the full 7.0 MiB history
// (1287 msgs, ~2M chars), agy-cli clips it to 41 msgs / 44.5 KB, agy.exe
// reports [acp-usage] input=50032. The existing anchorImpossible guard cannot
// catch this: condition B requires the current payload to tower 8x over the
// producer's snapshot, but both are ~2M chars (bili sent the full history both
// times). The distinguishing fact: the outbound char-bound (localInputEstimate)
// towers 16x+ over the report AND is itself multi-megabyte (>= 500K chars).
// An honest report of a small-to-medium payload can legitimately under-report
// by 16x+ on dense code (#1820 B e2e: 186K chars over a 5k report = 37x), but
// the clipped-payload class only manifests on multi-MiB sessions.
//
// The fix adds a `reportClipped` condition to effectiveTokenCount that gates
// both usage-returning branches (main usage + grade), falling through to the
// local estimate so the nudge sees the true payload size and fires.

function sessionWith(anchor: number): Session {
    return {
        id: "s7444",
        meta: {},
        stats: {
            requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0,
            outputTokens: 0, cacheSamples: 0,
            lastInputTokens: anchor, lastInputTokensSource: "usage",
            contextTokens: anchor, contextTokensSource: "usage",
        } as never,
        metadata: {},
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
        transient: {},
    } as never as Session;
}

function bigHistory(count: number): CoreMessage[] {
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < count; i++) {
        msgs.push({ id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: "x".repeat(6000) });
    }
    return msgs;
}

test("T1 agy-cli clipping: a report from a clipped payload cannot size the full 2M-char history", () => {
    const session = sessionWith(50_032);
    // bili forwarded the full 2M-char history; agy-cli clipped it to 113 KB
    // before sending to agy.exe, which reported 50032 tokens for the clip.
    session.stats.localInputEstimate = 2_000_000; // outbound char-bound (full payload)
    session.stats.lastUsagePayloadUpper = 2_000_000; // producer's snapshot (same scale)
    // 334 messages × 6000 chars = 2,004,000 chars ≈ 2M
    const msgs = bigHistory(334);
    const verdict = effectiveTokenCount(session, msgs, 0);
    assert.equal(verdict.source, "estimate", "clipped report must not size the meter (#7444)");
    assert.ok(verdict.tokens > 50_032, `meter must see the true payload size (${verdict.tokens} > 50032)`);
    assert.ok(verdict.tokens >= 1_000_000, `meter must be in the megabyte range (${verdict.tokens})`);
});

test("T2 #1820 B honesty margin preserved: localInputEstimate=0 keeps the anchor", () => {
    // The unit-test #1820 B case sets localInputEstimate=0, so reportClipped
    // cannot fire (requires localInputEstimate > 25_000). The anchor retains
    // usage-grade authority.
    const honest = sessionWith(5_100);
    honest.stats.localInputEstimate = 0;
    honest.stats.lastUsagePayloadUpper = 220_000;
    const trusted = effectiveTokenCount(honest, bigHistory(40), 0); // ~240K upper
    assert.equal(trusted.source, "usage", "an anchor written by THIS-scale request stays ground truth (#1820 B)");
    assert.equal(trusted.tokens, 5_100);
});

test("T3 small-session guard: reportClipped does not trip below the 500K-char floor", () => {
    // A small session with a 30K-char outbound and a 5K report: the ratio is
    // 6x (< 16x) AND the outbound is below the 500K floor, so reportClipped is
    // false. The anchor retains authority.
    const small = sessionWith(5_000);
    small.stats.localInputEstimate = 30_000; // 30K chars, ratio 6x < 16x
    small.stats.lastUsagePayloadUpper = 30_000;
    const msgs = bigHistory(5); // 30K chars
    const verdict = effectiveTokenCount(small, msgs, 0);
    assert.equal(verdict.tokens, 5_000, "small-session anchors keep sizing (no false trips)");
    assert.equal(verdict.source, "usage");
});

test("T3b #1820 B e2e margin: dense-code 37x ratio below the 500K floor keeps the anchor", () => {
    // The #1820 B e2e harness: 186K chars of dense ASCII code, honest report of
    // 5K tokens. Ratio 37x > 16x, but the outbound (186K) is below the 500K
    // floor, so reportClipped is false. The anchor retains authority.
    const dense = sessionWith(5_000);
    dense.stats.localInputEstimate = 186_000; // 186K chars, ratio 37x > 16x
    dense.stats.lastUsagePayloadUpper = 186_000;
    const msgs = bigHistory(31); // 186K chars
    const verdict = effectiveTokenCount(dense, msgs, 0);
    assert.equal(verdict.tokens, 5_000, "dense-code honest anchors keep sizing below the 500K floor (#1820 B)");
    assert.equal(verdict.source, "usage");
});

test("T4 grade branch also gated: lastUsageGradeTokens cannot re-return the clipped anchor", () => {
    // Even if the main usage branch is gated, the grade branch (which reads
    // lastUsageGradeTokens, set to lastInputTokens at settle) would re-return
    // the same clipped value. Both branches must be gated.
    const session = sessionWith(50_032);
    session.stats.localInputEstimate = 2_000_000;
    session.stats.lastUsagePayloadUpper = 2_000_000;
    (session.stats as { lastUsageGradeTokens?: number }).lastUsageGradeTokens = 50_032;
    const msgs = bigHistory(334);
    const verdict = effectiveTokenCount(session, msgs, 0);
    assert.equal(verdict.source, "estimate", "grade branch must also be gated (#7444)");
    assert.ok(verdict.tokens > 50_032, `grade branch must not re-return the clipped anchor (${verdict.tokens})`);
});

test("T5 honest large-session report: ratio below 16x keeps the anchor", () => {
    // A large session where the report is 4x the char-bound / 4 (the typical
    // chars-per-token ratio): the report is an honest measurement of the full
    // payload. reportClipped requires 16x, so it does not fire.
    const session = sessionWith(500_000);
    // 2M chars / 4 = 500K tokens → ratio 4x < 16x
    session.stats.localInputEstimate = 2_000_000;
    session.stats.lastUsagePayloadUpper = 2_000_000;
    const msgs = bigHistory(334);
    const verdict = effectiveTokenCount(session, msgs, 0);
    assert.equal(verdict.tokens, 500_000, "honest large-session report keeps authority (ratio 4x < 16x)");
    assert.equal(verdict.source, "usage");
});
