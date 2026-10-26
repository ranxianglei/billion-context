import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultCountTokens, countMessageTokens, type CoreMessage } from "acp-kernel";
import { projectThinkingMass, countSystemAndToolsTokens } from "../src/server.ts";
import { estimateCoreMessages } from "../src/preflight.ts";
import { settleUsageReport } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";
import type { BiliMessage } from "acp-kernel/wire";

// #2407: signature-only thinking blocks bill upstream but project as empty
// text (#1320); the projection attributes the residual to
// CoreMessage.thinkingTokens — but estimateCoreMessages counted only m.text,
// so the k̂ calibration denominator (prepare sites) divided a bill that
// includes thinking by an estimate that excludes it. Thinking-heavy routes
// learned an inflated k̂ (billed/est attributes the thinking share to
// "estimator undercount"). Fix: estimateCoreMessages goes through the
// kernel's countMessageTokens (text + thinkingTokens), the same caliber the
// kernel's own meters use; acp_status's est-view total follows.

let seq = 0;
function sigOnly(sigLen: number): BiliMessage {
    seq++;
    return { id: `sig-${seq}`, role: "assistant", contentType: "reasoning", thinkingSignature: "s".repeat(sigLen) };
}
function textMsg(textLen: number): BiliMessage {
    seq++;
    return { id: `txt-${seq}`, role: "user", contentType: "text", text: "x".repeat(textLen) };
}

let sessSeq = 0;
function makeSession(): Session {
    sessSeq += 1;
    return {
        id: `i2407-${sessSeq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

test("#2407 estimateCoreMessages counts host-projected thinking mass", () => {
    const plain: CoreMessage[] = [{ id: "a", role: "user", contentType: "text", text: "hello world" }];
    assert.equal(estimateCoreMessages(plain), defaultCountTokens("hello world"), "no thinking → unchanged text-only caliber");
    const withThinking: CoreMessage[] = [{ ...plain[0]!, id: "b", thinkingTokens: 5000 }];
    assert.equal(estimateCoreMessages(withThinking), defaultCountTokens("hello world") + 5000, "thinking mass added");
    assert.equal(estimateCoreMessages(withThinking), countMessageTokens(withThinking[0]!, defaultCountTokens), "exactly the kernel countMessageTokens caliber");
});

test("#2407 projection absorbs the residual: estimate == measured afterwards", () => {
    const msgs = [textMsg(40_000), sigOnly(3000), sigOnly(1000)];
    const overhead = countSystemAndToolsTokens("", []);
    const measured = estimateCoreMessages(msgs) + overhead + 60_000;
    projectThinkingMass(msgs, { providerInputTokens: measured, measured: true, systemText: "", tools: [], imageTokens: 0 });
    // Post-projection the estimator sees the full billed mass — this is the
    // invariant the k̂ denominator relies on: est(text+thinking)+overhead ≈ bill.
    assert.equal(estimateCoreMessages(msgs) + overhead, measured, "estimate closes exactly onto the measured total");
});

test("#2407 k̂ sample stays caliber-honest on a thinking route (no inflation)", () => {
    // Simulate the production pair on a thinking route:
    //   text 10,000 + projected thinking 8,000 + overhead 2,000 = est 20,000
    //   billed 21,000 (5% tokenizer gap on the TEXT caliber)
    // k̂ must learn ~1.05, not 21000/12000 = 1.75 (pre-fix behavior: the
    // denominator dropped the thinking share, the numerator kept it).
    const s = makeSession();
    const est = 10_000 + 8_000 + 2_000;
    for (let i = 0; i < 3; i++) settleUsageReport(s, { total: 21_000, reportedCached: null, upstream: "https://api.thinking.test" }, est);
    const k = s.stats.calibratedEstimate;
    assert.ok(typeof k === "number", "k̂ published");
    assert.ok(Math.abs(k - 1.05) < 0.01, `k̂ ≈ 1.05 (caliber-honest), got ${k}`);
    assert.ok(k < 1.2, `no thinking inflation (pre-fix would learn ~1.75), got ${k}`);
});

test("#2407 k̂ inflation bounded pre-fix scenario now stays under the clamp-free path", () => {
    // Heavier thinking share: text 4,000 + thinking 16,000 + overhead 2,000
    // vs billed 21,000. Pre-fix denominator was 6,000 → sample 3.5 → a
    // sustained route would publish k̂=3.5 and over-trigger 3.5×. Post-fix the
    // sample is 21,000/22,000 ≈ 0.95 — the text caliber was accurate all along.
    const s = makeSession();
    const est = 4_000 + 16_000 + 2_000;
    for (let i = 0; i < 3; i++) settleUsageReport(s, { total: 21_000, reportedCached: null, upstream: "https://api.thinking2.test" }, est);
    const k = s.stats.calibratedEstimate;
    assert.ok(typeof k === "number", "k̂ published");
    assert.ok(Math.abs(k - 21_000 / est) < 0.01, `k̂ ≈ ${21_000 / est}`);
});
