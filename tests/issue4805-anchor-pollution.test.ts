import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { settleUsageReport } from "../src/cache-ledger.ts";
import { effectiveTokenCount } from "../src/server.ts";
import { collectRequestIds, isForeignMembership, probeRequestMembership } from "../src/request-membership.ts";
import type { Session } from "../src/session.ts";
import type { CoreMessage } from "acp-kernel";

// #4805 / #4720 family: a tiny side-lane request (2 messages, its own short
// system prompt) riding the SAME session id settles a 5100-token usage sample
// over the main conversation's 300K-token anchor. The anchor write froze the
// nudge (growth 3900 < floor 22500) while the real context kept growing to
// 1.2M — compression permanently stopped, and once requests started failing
// (no usage on failure) nothing could repair the anchor. Two guards, each
// independently breaking the loop:
//  Final design (settle-side magnitude gate REJECTED during PR review):
//  a far-smaller usage sample CANNOT be distinguished from the #1492 B
//  self-heal (next real report superseding a poisoned 1.2M anchor) at the
//  settle chokepoint — magnitude alone is ambiguous there. Settle stays
//  unconditional (usage-grade truth always supersedes) and records WHICH
//  request produced the anchor (stats.lastUsagePayloadUpper = the producer's
//  own payload upper estimate, snapshotted at settle from localInputEstimate):
//  - effectiveTokenCount refuses an anchor only when the payload at hand
//    towers over BOTH the anchor and its producer's snapshot (8x each, >25K
//    absolute) — a #4805 side-lane sample (producer ~2600 upper, main payload
//    ~1.2M) is refused, while #1820 B's honest under-reporting anchor
//    (producer 220K upper, same-scale payload) keeps ground-truth authority.

function sessionWith(anchor: number): Session {
    return {
        id: "s4805",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: anchor, lastInputTokensSource: "usage", contextTokens: anchor } as never,
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

test("T1 settle keeps usage truth: the far-smaller sample supersedes AND snapshots its producer's payload", () => {
    const session = sessionWith(300_000);
    session.stats.localInputEstimate = 2_600; // the side-lane request's own outbound upper
    settleUsageReport(session, { total: 5_100, reportedCached: 128, output: 30, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 5_100, "usage-grade samples supersede unconditionally (#1492 B self-heal)");
    assert.equal(session.stats.lastUsagePayloadUpper, 2_600, "the anchor now carries its producing request's payload snapshot");
    assert.equal(session.stats.inputTokens, 5_100, "the sample still counts toward cumulative usage");
    // A same-lane report (producer at main scale) writes and re-snapshots.
    session.stats.localInputEstimate = 295_000;
    settleUsageReport(session, { total: 290_000, reportedCached: null, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 290_000, "main-lane reports keep updating the anchor");
    assert.equal(session.stats.lastUsagePayloadUpper, 295_000, "the snapshot follows the producing request");
});

test("T1b settle anchors: empty anchors always write; post-fold credit nets through", () => {
    const fresh = sessionWith(0);
    settleUsageReport(fresh, { total: 5_100, reportedCached: null });
    assert.equal(fresh.stats.lastInputTokens, 5_100, "first settle on an empty anchor always writes");

    const folded = sessionWith(300_000);
    (folded.stats as { compressCreditTokens?: number }).compressCreditTokens = 40_000;
    settleUsageReport(folded, { total: 30_000, reportedCached: null });
    assert.equal(folded.stats.lastInputTokens, 0, "a credit-carrying (post-fold) settle nets against the credit and writes — our own shrinkage is not side-lane");
});

test("T2 meter guard: a polluted anchor from a tiny producer cannot size a 1.2M-token payload", () => {
    const session = sessionWith(5_100);
    session.stats.contextTokens = 5_100;
    (session.stats as { contextTokensSource?: string }).contextTokensSource = "usage";
    session.stats.localInputEstimate = 0; // demotion below must come from the size guard alone
    session.stats.lastUsagePayloadUpper = 2_600; // the side-lane producer's own upper
    const msgs = bigHistory(800); // ~4.8M chars -> upper >> anchor*8 and >> snapshot*8
    const verdict = effectiveTokenCount(session, msgs, 0);
    assert.notEqual(verdict.tokens, 5_100, `the impossible anchor must not size a ${verdict.tokens}-token payload request`);
    assert.equal(verdict.source, "estimate", "falls through to the local measurement (#4805 size guard)");
    // #1820 B honesty margin: an anchor produced by a request at THIS scale keeps
    // authority even when its upstream under-reports 8x.
    const honest = sessionWith(5_100);
    honest.stats.contextTokens = 5_100;
    (honest.stats as { contextTokensSource?: string }).contextTokensSource = "usage";
    honest.stats.localInputEstimate = 0;
    honest.stats.lastUsagePayloadUpper = 220_000;
    const trusted = effectiveTokenCount(honest, bigHistory(40), 0); // ~240K upper
    assert.equal(trusted.source, "usage", "an anchor written by THIS-scale request stays ground truth (#1820 B)");
    // Small-session growth stays on the anchor: no absolute-gap trip below 25K.
    const small = sessionWith(800);
    const earlyMsgs = bigHistory(3);
    const early = effectiveTokenCount(small, earlyMsgs, 0);
    assert.equal(early.tokens, 800, "early-session anchors keep sizing small payloads (no false trips)");
});

// T3: the single-needle membership probe (#4805, second guard). The host
// stamps auxiliary personas with the SAME conversation id, so the session
// key alone cannot attribute a usage report — but one remembered id can:
// a main turn resents the whole history and contains the conversation's
// latest admitted id; a foreign payload never does.
test("T3 settle membership probe: a foreign payload cannot rewrite the anchor", () => {
    const session = sessionWith(0);
    // Main turn 1: no needle yet — abstention plants one and settles.
    probeRequestMembership(session, Array.from({ length: 12 }, (_, i) => `M${i}`), 300_000);
    settleUsageReport(session, { total: 300_000, reportedCached: null, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 300_000, "first settle plants the needle and writes");
    assert.equal(session.transient?.latestKnownMsgId, "M11", "needle = latest admitted id");
    // Foreign payload under the same session id: does not carry the needle.
    const foreignIds = ["X1", "X2", "X3", "X4", "X5"];
    probeRequestMembership(session, foreignIds, 2_600);
    assert.ok(isForeignMembership(session.transient?.requestMembership), "verdict marks the payload foreign");
    settleUsageReport(session, { total: 5_100, reportedCached: 128, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 300_000, "the foreign sample cannot touch the anchor (#4805)");
    assert.equal(session.stats.inputTokens, 305_100, "it still counts toward cumulative usage");
    assert.equal(session.stats.lastUsagePayloadUpper, 0, "no producer snapshot from a refused settle");
    // The needle never moves to a tiny foreign payload: repeat strikes stay gated.
    assert.equal(session.transient?.latestKnownMsgId, "M11", "the polluter cannot hijack the needle");
    probeRequestMembership(session, foreignIds, 2_600);
    assert.ok(isForeignMembership(session.transient?.requestMembership), "repeat foreign payloads stay foreign");
    settleUsageReport(session, { total: 4_800, reportedCached: null, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 300_000, "repeat pollution stays gated");
    // Main conversation recovers: carries the needle, the settle writes again.
    probeRequestMembership(session, [...Array.from({ length: 12 }, (_, i) => `M${i}`), "M12", "M13"], 320_000);
    assert.ok(!isForeignMembership(session.transient?.requestMembership), "main resends carry the needle");
    settleUsageReport(session, { total: 320_000, reportedCached: null, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 320_000, "main-lane reports keep updating the anchor");
    assert.equal(session.transient?.latestKnownMsgId, "M13", "the needle follows the conversation head");
});

test("T3b membership abstention: thin evidence settles exactly as before", () => {
    // First turn (no needle) must not gate anything.
    const fresh = sessionWith(0);
    probeRequestMembership(fresh, ["A", "B", "C", "D"], 5_000);
    assert.ok(!isForeignMembership(fresh.transient?.requestMembership), "no needle = abstain");
    settleUsageReport(fresh, { total: 5_100, reportedCached: null });
    assert.equal(fresh.stats.lastInputTokens, 5_100, "first-turn settles write");
    // No evidence at all (tool-less sidecar, envelope absent).
    const bare = sessionWith(0);
    probeRequestMembership(bare, [], 9_000);
    assert.equal(bare.transient?.requestMembership, undefined, "empty evidence records nothing");
    settleUsageReport(bare, { total: 9_000, reportedCached: null });
    assert.equal(bare.stats.lastInputTokens, 9_000, "no-evidence settles write");
    // #2821 re-mint: a main turn whose ids were ALL re-minted does not carry
    // the needle (one skipped settle) but IS main-scale, so it moves the
    // needle and the next resend joins.
    const churn = sessionWith(0);
    probeRequestMembership(churn, Array.from({ length: 20 }, (_, i) => `C${i}`), 200_000);
    settleUsageReport(churn, { total: 200_000, reportedCached: null });
    probeRequestMembership(churn, Array.from({ length: 20 }, (_, i) => `D${i}`), 210_000);
    assert.ok(isForeignMembership(churn.transient?.requestMembership), "full re-mint misses the needle (one skipped settle)");
    settleUsageReport(churn, { total: 210_000, reportedCached: null });
    assert.equal(churn.stats.lastInputTokens, 200_000, "the re-minted turn's settle is skipped once");
    assert.equal(churn.transient?.latestKnownMsgId, "D19", "main-scale re-mint moves the needle");
    probeRequestMembership(churn, Array.from({ length: 20 }, (_, i) => `D${i}`).concat("D20"), 215_000);
    assert.ok(!isForeignMembership(churn.transient?.requestMembership), "the re-minted family carries the new needle and heals");
    settleUsageReport(churn, { total: 220_000, reportedCached: null });
    assert.equal(churn.stats.lastInputTokens, 220_000, "self-heals on the next resend");
});

test("T3c evidence extraction: envelope first, tool-call ids as the wire fallback", () => {
    const msgs = [
        { id: "a", role: "user", text: "hi" },
        { id: "b", role: "assistant", text: "", toolCallId: "call_1" },
        { id: "c", role: "tool", text: "out", toolCallId: "call_1" },
        { id: "d", role: "assistant", text: "done" },
    ] as never;
    assert.deepEqual(collectRequestIds(undefined, msgs), ["call_1"], "tool-call ids extracted, call/result deduped");
    assert.deepEqual(collectRequestIds(["e1", "e2"], msgs), ["e1", "e2"], "envelope ids win when present");
    assert.deepEqual(collectRequestIds(["acp_summary_x", 7, ""], msgs), ["call_1"], "invalid envelope falls back to tool-call ids");
    assert.deepEqual(collectRequestIds(undefined, [{ id: "u", role: "user", text: "hi" } as never]), [], "tool-less history carries no evidence (abstain)");
});

test("T3d fork inheritance: a fork child carries the parent's needle from turn 1", () => {
    const parent = sessionWith(0);
    probeRequestMembership(parent, Array.from({ length: 12 }, (_, i) => `M${i}`), 300_000);
    settleUsageReport(parent, { total: 300_000, reportedCached: null });
    // Fork child (plugin.ts copies the needle alongside the stats seed).
    const child = sessionWith(0);
    (child.transient ??= {}).latestKnownMsgId = parent.transient?.latestKnownMsgId;
    (child.transient ??= {}).needlePayloadUpper = parent.transient?.needlePayloadUpper;
    // An auxiliary persona striking the CHILD first stays gated.
    probeRequestMembership(child, ["X1", "X2", "X3", "X4", "X5"], 2_600);
    assert.ok(isForeignMembership(child.transient?.requestMembership), "fork child gates first-strike pollution");
    settleUsageReport(child, { total: 5_100, reportedCached: null });
    assert.equal(child.stats.lastInputTokens, 0, "no anchor write on the gated settle");
    // The child's own first main turn joins the inherited family directly.
    probeRequestMembership(child, [...Array.from({ length: 12 }, (_, i) => `M${i}`), "M12"], 310_000);
    assert.ok(!isForeignMembership(child.transient?.requestMembership), "inherited family joins immediately");
});
