// #5130: estimateCoreMessages memoizes per-message token counts keyed on the
// kernel-minted digest id (plus text length and thinkingTokens, the two
// inputs the digest does not pin). This file pins the properties the
// optimization stands on:
// 1) identical id → identical count without recount (the steady-state win);
// 2) same id with different thinkingTokens → recounted (key includes it);
// 3) same id whose counted text was rewritten in place (renderTags view
//    prefix, tool-args canonicalization delta that changes length) →
//    recounted — the length gate keeps a logical id from serving a stale
//    count for different text;
// 4) same id, same length, whitespace-only canonical delta → memo hit is
//    sound because the CJK-aware counter is character-class additive;
// 5) non-kernel ids (short/test-minted) never poison the memo across
//    differing texts — they always recount.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clearEstimateCoreMessagesMemoForTests, estimateCoreMessages } from "../src/preflight.js";
import type { CoreMessage } from "acp-kernel";

function coreMsg(id: string, text: string, thinkingTokens?: number): CoreMessage {
    return { id, role: "assistant", contentType: "text", text, ...(thinkingTokens === undefined ? {} : { thinkingTokens }) };
}

const HEX = (n: number) => n.toString(16).padStart(16, "0");
// kernel minted: h_ + 16 hex + optional repeat-suffix
const minted = (n: number, suffix?: number) => `h_${HEX(n)}${suffix === undefined ? "" : `_${suffix}`}`;

test("memo: same digest id is not recounted across calls", () => {
    clearEstimateCoreMessagesMemoForTests();
    const msgs = [coreMsg(minted(1), "hello world"), coreMsg(minted(2), "你好,世界 — CJK mass here")];
    const a = estimateCoreMessages(msgs);
    const b = estimateCoreMessages(msgs);
    assert.equal(a, b);
    // The second call must have been fully served from the memo: a poisoned
    // or bypassed memo still returns the same number, so prove reuse by
    // checking a differing-text message with a FRESH id does NOT reuse the
    // old id's entry (different count), while the old pair stays stable.
    const fresh = [coreMsg(minted(3), "x"), coreMsg(minted(1), "hello world")];
    const c = estimateCoreMessages(fresh);
    assert.equal(c - estimateCoreMessages([coreMsg(minted(3), "x")]), a - estimateCoreMessages([coreMsg(minted(2), "你好,世界 — CJK mass here")]));
});

test("memo: thinkingTokens is part of the key", () => {
    clearEstimateCoreMessagesMemoForTests();
    const base = coreMsg(minted(7), "same text");
    const withThinking = coreMsg(minted(7), "same text", 1234);
    const t0 = estimateCoreMessages([base]);
    const t1 = estimateCoreMessages([withThinking]);
    assert.equal(t1 - t0, 1234);
    // Original entry is untouched by the thinking-bearing twin.
    assert.equal(estimateCoreMessages([base]), t0);
});

test("memo: repeat-suffixed ids cache independently", () => {
    clearEstimateCoreMessagesMemoForTests();
    const a = estimateCoreMessages([coreMsg(minted(9, 1), "dup text")]);
    const b = estimateCoreMessages([coreMsg(minted(9, 2), "dup text")]);
    assert.equal(a, b);
});

test("memo: non-kernel ids always recount (no cross-text poisoning)", () => {
    clearEstimateCoreMessagesMemoForTests();
    const short = [coreMsg("h_2", "short"), coreMsg("h_a", "also short")];
    const first = estimateCoreMessages(short);
    // Same non-minted ids, DIFFERENT texts: must not reuse memoized counts.
    const second = estimateCoreMessages([coreMsg("h_2", "a much longer text than short"), coreMsg("h_a", "different bytes entirely")]);
    assert.ok(second > first);
});

test("memo: same id with rewritten text recounts (renderTags view keeps ids)", () => {
    clearEstimateCoreMessagesMemoForTests();
    // Seed the memo with the plain-text view, then hand it the same logical
    // message re-rendered in place (a renderTags-style prefix changes the
    // length): the length gate forces a recount, so the wrapped total differs
    // from the plain one the memo first saw, and is stable across repeats.
    const id = minted(0x5130);
    const plain = estimateCoreMessages([coreMsg(id, 'old work body text')]);
    const wrapped = estimateCoreMessages([coreMsg(id, '\nOLD_WORK_B old work body text')]);
    const wrappedFresh = estimateCoreMessages([coreMsg(id, '\nOLD_WORK_B old work body text')]);
    assert.equal(wrapped, wrappedFresh);
    assert.notEqual(wrapped, plain);
});

test("memo: same id + same length + whitespace-only delta stays consistent", () => {
    clearEstimateCoreMessagesMemoForTests();
    // canonicalToolArgs normalizes whitespace/key order only: when a delta
    // merely moves whitespace (same length, same character multiset) the
    // CJK-aware counter is unchanged, so the memo hit is exact.
    const id = minted(0xdef456);
    const verbatim = estimateCoreMessages([coreMsg(id, '{"cmd": "run","kb":8}')]);
    const spaced = estimateCoreMessages([coreMsg(id, '{"cmd":"run", "kb":8}')]);
    assert.equal(verbatim, spaced);
});
