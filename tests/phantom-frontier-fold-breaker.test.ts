// 2026-11-25 (session 01a20b76, qwen3.8-27b, local sglang): the model
// confabulated a multi-phase plan it had not executed yet, then compressed
// it as history with endIds far above the session's highest allocated ref
// (m04152–m04235, then m04249–m04300). The kernel clamped each to the live
// frontier and reported a ~2K-token SUCCESS — which discharged the breaker
// streak (#7300's ≥500-tok gate saw a "substantial" fold), so the 3-strike
// breaker never armed while the model walked m04261 → m04300 → m04365 →
// m04433 → m04503. Two receipts compounded it: the clamped success carried
// no frontier pointer ("NOTHING numbered above hiId exists" only lives on
// the failure path), and the forwarding layer's PARTIAL marker unconditionally
// ordered "Retry ONLY the failed range(s)" — contradicting the kernel's
// stale-ref verdict in the same receipt and driving the next phantom batch.
//
// Pinned here:
//   1. a fold the kernel clamped from a phantom endId does NOT discharge the
//      breaker streak, even when the net saving is substantial;
//   2. a clamped-success receipt re-states the frontier snapshot (the same
//      line the failure path carries); an un-clamped success gains nothing;
//   3. hasFrontierClampWarning matches the kernel's frontier-clamp snap
//      sentence and stays silent for the harmless snap variants;
//   4. the PARTIAL marker's retry order is conditional on the per-range
//      error text (stale/above-frontier ranges are "can NEVER fold").

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, hasFrontierClampWarning, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { partialOutcomeNote } from "../src/proxy-tool-result.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "summary ".repeat(20); // 160 chars → ~40 tokens

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `phantom-frontier-${randomUUID()}`,
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

// Two sub-gate messages (800 chars each → "too small" failures) plus six
// 5000-char messages (30000 chars → a guaranteed SUBSTANTIAL fold when
// summarized with the short 160-char summary). Same geometry as
// tests/issue7300-compress-loop-trivial.test.ts.
function substantialFixture(): CoreMessage[] {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
    ];
    for (let i = 3; i <= 8; i++) msgs.push(textMsg(`raw_${i}`, "assistant", "x".repeat(5000)));
    return msgs;
}

test("a phantom-clamped SUBSTANTIAL fold does NOT discharge the breaker streak", () => {
    const logs: string[] = [];
    const ctx = makeCtx(substantialFixture(), undefined, logs);

    const f1 = applyRanges(parseCompressInput(compressArgs("m00001", "m00001")), ctx).text;
    assert.ok(f1.startsWith("[Compression FAILED:"), `failure 1 at the too-small gate (got: ${f1.slice(0, 120)})`);
    const f2 = applyRanges(parseCompressInput(compressArgs("m00002", "m00002")), ctx).text;
    assert.ok(f2.startsWith("[Compression FAILED:"), "failure 2");

    // m00099 is far above the highest allocated ref (m00008): the kernel
    // clamps it to m00008 and folds m00003–m00008 — 30000 chars → ~7500 tok
    // folded, ~40 tok summary, net ≥ 500 → SUBSTANTIAL by the #7300 gate.
    // Pre-fix this discharged the streak; post-fix it must NOT (the model is
    // probing numbers that cannot exist, not "compression is working").
    const clamped = applyRanges(parseCompressInput(compressArgs("m00003", "m00099")), ctx).text;
    assert.ok(clamped.startsWith("[Compressed m00003–m00008"), `clamped fold succeeds with the effective (clamped) headline (got: ${clamped.slice(0, 120)})`);
    assert.ok(clamped.includes("is above this session's highest allocated ref (m00008)"), "kernel's frontier-clamp snap note rides the receipt");
    const afterClamped = ctx.session.metadata["compressFailStreak"] as { n?: number } | undefined;
    assert.equal(afterClamped?.n, 2, "phantom-clamped success must NOT reset the streak (still n=2)");
    assert.ok(logs.some((l) => l.includes("frontier-clamped success")), "operator log records the withheld discharge");

    // One more failure → n=3 → the breaker must arm, proving the clamped
    // success did not discharge it (the pre-fix behavior reset here, so the
    // loop never armed — the incident's shape).
    const f3 = applyRanges(parseCompressInput(compressArgs("m00001", "m00002")), ctx).text;
    assert.ok(f3.startsWith("[Compression FAILED:"), "failure 3");
    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "breaker must arm — the clamped success must not have reset the strikes");
});

test("a clamped-success receipt re-states the frontier; an un-clamped success gains nothing", () => {
    const clampedCtx = makeCtx(substantialFixture());
    const clamped = applyRanges(parseCompressInput(compressArgs("m00003", "m00099")), clampedCtx).text;
    assert.ok(clamped.startsWith("[Compressed "), "clamped fold succeeds");
    assert.ok(clamped.includes("NOTHING numbered above m00008 exists"), "the frontier snapshot (failure-path line) is re-stated on a clamped success");
    assert.ok(clamped.includes("request only refs inside the newest such snapshot"), "the re-anchor instruction is present");

    const plainCtx = makeCtx(substantialFixture());
    const plain = applyRanges(parseCompressInput(compressArgs("m00003", "m00008")), plainCtx).text;
    assert.ok(plain.startsWith("[Compressed m00003–m00008"), "un-clamped fold succeeds");
    assert.ok(!plain.includes("is above this session's highest allocated ref"), "no clamp note on a legal range");
    assert.ok(!plain.includes("NOTHING numbered above"), "no frontier snapshot on an un-clamped success (receipt stays byte-lean)");
});

test("hasFrontierClampWarning matches only the kernel's frontier-clamp snap", () => {
    assert.equal(hasFrontierClampWarning([
        'endId="m00099" is above this session\'s highest allocated ref (m00008) — clamped to it (refs are minted in order and never pre-allocated, so higher numbers do not exist yet). The range folds up to the last visible message.',
    ]), true, "the frontier clamp itself");
    assert.equal(hasFrontierClampWarning([]), false, "no warnings");
    assert.equal(hasFrontierClampWarning([
        'startId="m00010" no longer backs any visible message (its content was pruned or removed by the client) — anchored to the nearest visible message instead, so the range folds slightly less than requested.',
        'endId="m00020" refers to a message already compressed into an active block — anchored to the active block covering it instead.',
    ]), false, "the harmless snap variants stay silent");
});

test("the PARTIAL marker's retry order is conditional on the per-range error text", () => {
    const note = partialOutcomeNote(1);
    assert.ok(note.startsWith("[acp-result: PARTIAL — 1 block(s) created; some requested range(s) were NOT folded."), "prefix unchanged");
    assert.match(note, /Retry ONLY the failed range\(s\) listed above, and only if their error text says they may resolve on retry/, "retry is now conditional");
    assert.match(note, /can NEVER fold \(those numbers do not exist\): do NOT retry it, call acp_status for the live ranges instead/, "stale/above-frontier ranges are named non-retryable");
    assert.ok(note.endsWith("Do not re-fold the ranges that were applied.]"), "tail unchanged");
    assert.ok(!partialOutcomeNote(undefined).includes("block(s) created"), "count still drops when unknown");
});
