import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { assignRefs, createCore, defaultConfig, emptyRefMap, type CoreMessage } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { liveCompressionRanges } from "../src/acp-status.ts";

function spanContains(start: string, end: string, n: number): boolean {
    const a = Number(start.replace(/\D/g, ""));
    const b = Number(end.replace(/\D/g, ""));
    return n >= Math.min(a, b) && n <= Math.max(a, b);
}

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "The earlier synthetic work is complete; preserve its conclusions and the remaining recent messages.";

function makeCtx(count: number, preserveRecentMessages = 5): RewriteCtx {
    const messages: CoreMessage[] = Array.from({ length: count }, (_, i) => ({
        id: `raw-${i + 1}`,
        role: i === count - 1 ? "user" : "assistant",
        contentType: "text",
        text: `Synthetic message ${i + 1}. ` + "x".repeat(6000),
    }));
    const session = getSession(`compress-recovery-${randomUUID()}`);
    session.state.messageRefs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return {
        core: createCore(),
        config: defaultConfig(200000, { preserveRecentMessages, preserveRecentTokens: 0 }),
        messages,
        session,
        log: () => {},
    };
}

function request(ctx: RewriteCtx, startId: string, endId: string, summary = SUMMARY) {
    return applyRanges(parseCompressInput({ content: [{ startId, endId, summary }] }), ctx);
}

function fold(ctx: RewriteCtx, startId: string, endId: string) {
    const result = request(ctx, startId, endId);
    assert.equal(result.outcome, "applied", result.text);
}

function advertisedRanges(text: string): Array<[string, string]> {
    const hint = text.split("Current compressible ranges (use these refs exactly as listed):")[1];
    assert.ok(hint, `a rejection with eligible content must provide fresh ranges: ${text}`);
    return [...hint.matchAll(/(m\d+)\s*[–-]\s*(m\d+)/g)].map((match) => [match[1], match[2]]);
}

test("already-folded rejection recommends ranges that exclude protected messages and actually compress", () => {
    const ctx = makeCtx(12);
    fold(ctx, "m00001", "m00002");
    const rejected = request(ctx, "m00001", "m00002");
    assert.equal(rejected.outcome, "refused");
    const ranges = advertisedRanges(rejected.text);
    assert.ok(ranges.length > 0);
    for (const [start, end] of ranges) {
        assert.ok(Number(start.slice(1)) >= 3 && Number(end.slice(1)) <= 7, `${start}..${end} must exclude covered and protected refs`);
        assert.equal(request(ctx, start, end).outcome, "applied", `${start}..${end} must pass the real submit gate`);
    }
    assert.equal(rejected.text.split("\n").length, 1, "failure remains visible as one complete marker line");
});

test("fully protected tail yields a stop instruction rather than a misleading retry span", () => {
    const ctx = makeCtx(7);
    fold(ctx, "m00001", "m00002");
    const blocksBefore = JSON.stringify(ctx.session.state.blocks);
    for (let attempt = 0; attempt < 2; attempt++) {
        const rejected = request(ctx, "m00003", "m00007");
        assert.equal(rejected.outcome, "refused");
        assert.match(rejected.text, /continue the task without compressing/);
        assert.doesNotMatch(rejected.text, /Live compressible refs|Retry NOW|extend your range/);
        assert.equal(JSON.stringify(ctx.session.state.blocks), blocksBefore, "failed attempts must not change history coverage");
    }
});

test("malformed request with no eligible ranges does not ask for a corrected retry", () => {
    const ctx = makeCtx(7);
    fold(ctx, "m00001", "m00002");
    const result = applyRanges(parseCompressInput({ content: [{ summary: SUMMARY }] }), ctx);
    assert.equal(result.outcome, "refused");
    assert.match(result.text, /continue the task without compressing/);
    assert.doesNotMatch(result.text, /Retry NOW|Re-issue the compress call with a valid content array/);
});

test("sub-minimum raw leftovers are not advertised as compressible", () => {
    const ctx = makeCtx(5, 1);
    fold(ctx, "m00001", "m00002");
    ctx.messages[2].text = "a".repeat(600);
    ctx.messages[3].text = "b".repeat(600);
    const result = request(ctx, "m00001", "m00002");
    assert.equal(result.outcome, "refused");
    assert.match(result.text, /continue the task without compressing/);
    assert.doesNotMatch(result.text, /Live compressible refs|Retry NOW/);
});

test("recovery includes eligible gaps before the highest active block boundary", () => {
    const ctx = makeCtx(19, 2);
    fold(ctx, "m00004", "m00008");
    fold(ctx, "m00012", "m00016");
    const result = request(ctx, "m00012", "m00016");
    assert.equal(result.outcome, "refused");
    const ranges = advertisedRanges(result.text);
    assert.ok(ranges.some(([start]) => start === "m00001"), "eligible old gaps must remain discoverable");
    assert.ok(ranges.some(([start, end]) => Number(start.slice(1)) <= 9 && Number(end.slice(1)) >= 11), `eligible middle gaps must remain discoverable: ${result.text}`);
    assert.ok(ranges.every(([, end]) => Number(end.slice(1)) <= 17), "protected tail must stay excluded");
    for (const [start, end] of ranges) {
        const retry = request(ctx, start, end);
        assert.equal(retry.outcome, "applied", `advertised gap range must pass the submit gate: ${retry.text}`);
    }
});

test("token-based recent protection is honored even beyond the last-message count", () => {
    const ctx = makeCtx(7, 1);
    fold(ctx, "m00001", "m00002");
    ctx.config.preserveRecentTokens = 10000;
    const result = request(ctx, "m00003", "m00004");
    assert.equal(result.outcome, "refused");
    assert.match(result.text, /protected zone/);
    assert.match(result.text, /continue the task without compressing/);
    assert.doesNotMatch(result.text, /Live compressible refs|Retry NOW/);
});

test("failure recovery does not stop an active block-distillation nudge", () => {
    const ctx = makeCtx(12, 0);
    ctx.config = defaultConfig(200000, {
        preserveRecentMessages: 0,
        preserveRecentTokens: 0,
        tiers: { enabled: true, tier2Trigger: 2, tier3Trigger: 3 },
    });
    ctx.session.stats.lastInputTokens = 200000;
    ctx.session.stats.lastInputTokensSource = "usage";
    for (const [start, end] of [["m00001", "m00004"], ["m00005", "m00008"], ["m00009", "m00012"]]) {
        const result = request(ctx, start, end, "y".repeat(10000));
        assert.equal(result.outcome, "applied", result.text);
    }
    const result = request(ctx, "m00009", "m00012");
    assert.equal(result.outcome, "refused");
    assert.match(result.text, /block-distillation nudge is active/);
    assert.doesNotMatch(result.text, /continue the task without compressing|Retry NOW/);
});

test("failed live eligibility check never falls back to a guessed ref span", () => {
    const ctx = makeCtx(12);
    fold(ctx, "m00001", "m00002");
    ctx.core = { ...ctx.core, processTurn: () => { throw new Error("synthetic live eligibility failure"); } };
    const result = request(ctx, "m00001", "m00002");
    assert.equal(result.outcome, "refused");
    assert.match(result.text, /eligibility could not be determined/);
    assert.match(result.text, /acp_status before retrying/);
    assert.doesNotMatch(result.text, /Live compressible refs|Retry NOW/);
});

test("unexpected compression exceptions and their repeat guard use current eligibility", () => {
    const ctx = makeCtx(7);
    fold(ctx, "m00001", "m00002");
    const before = JSON.stringify(ctx.session.state.blocks);
    ctx.core = { ...ctx.core, applyCompression: () => { throw new Error("synthetic compression exception"); } };
    for (let i = 0; i < 2; i++) {
        const result = request(ctx, "m00003", "m00007");
        assert.equal(result.outcome, "refused");
        assert.match(result.text, /synthetic compression exception/);
        assert.match(result.text, /continue the task without compressing/);
        assert.doesNotMatch(result.text, /Live compressible refs|Retry NOW|extend your range/);
        assert.equal(result.text.split("\n").length, 1);
    }
    assert.equal(JSON.stringify(ctx.session.state.blocks), before);
});

test("#3192: a dropped message's DEAD ref is never re-advertised by the receipt or acp_status", () => {
    const ctx = makeCtx(12);
    // A client history rewrite drops message #5 (ref m00005) from the resent view;
    // the failed compress recorded it as DEAD. Positionally the neighbours stay
    // contiguous, so buildCompressibleRanges emits ONE span m00001–m00007 that
    // brackets the dead ref — the exact self-contradiction from the issue.
    ctx.messages.splice(4, 1);
    ctx.session.state.deadRefs = ["m00005"];

    const rejected = request(ctx, "m00001", "m00005");
    assert.equal(rejected.outcome, "refused");
    assert.match(rejected.text, /cannot be anchored/);
    // No advertised compressible span may cross the dead ref m00005 — the red gate
    // on the unfixed kernel (it advertised one span m00001–m00007 crossing m00005).
    const advertised = advertisedRanges(rejected.text);
    assert.ok(advertised.length > 0, `receipt must advertise the surviving sub-spans: ${rejected.text}`);
    for (const [start, end] of advertised) {
        assert.ok(!spanContains(start, end, 5), `${start}..${end} must not span the dead ref m00005`);
    }
    // The kernel SPLIT around the hole into adjacent live sub-spans (not a whole-span
    // drop): the run before the hole ends at/before m00004, the run after starts at/
    // after m00006. Both present proves the split rather than a silent drop.
    assert.ok(
        advertised.some(([start, end]) => Number(start.slice(1)) <= 4 && Number(end.slice(1)) <= 4),
        `pre-hole sub-span must be advertised: ${JSON.stringify(advertised)}`,
    );
    assert.ok(
        advertised.some(([start, end]) => Number(start.slice(1)) >= 6 && Number(end.slice(1)) >= 6),
        `post-hole sub-span must be advertised: ${JSON.stringify(advertised)}`,
    );

    // Receipt and acp_status share ONE eligibility source (liveCompressionRanges);
    // pin that source so the two surfaces cannot drift apart again (#2778 promise).
    const live = liveCompressionRanges(ctx);
    assert.ok(live);
    for (const r of live.ranges) {
        assert.ok(!spanContains(r.startRef, r.endRef, 5), `${r.startRef}..${r.endRef} must not span the dead ref m00005`);
    }
});
