import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { noteOutboundContextEstimates, settleUsageReport } from "../src/cache-ledger.ts";
import { effectiveTokenCount } from "../src/server.ts";
import { membershipBlocksSettlement, probeRequestMembership } from "../src/request-membership.ts";
import { resetSessionCompression } from "../src/session.ts";
import type { Session } from "../src/session.ts";
import type { CoreMessage } from "acp-kernel";

// #5925: two residual holes in the #4805 anchor-pollution defense.
//  (a) the settle gate failed OPEN on absent evidence — a request carrying no
//      message ids at all left requestMembership deleted, and
//      isForeignMembership(undefined) read as "member", so a side-lane sample
//      settled over the known family's anchor; right after a fold (credit
//      window open) it nets to max(0, tiny - credit) = 0, growth drops below
//      the 22500 floor, and the nudge never fires again (#4805 end state).
//  (b) the outbound estimate channel was ungated — the same foreign request
//      also rewrote localInputEstimate, pinning effectiveTokenCount's
//      min(localInputEstimate, raw) fallback at foreign scale even with the
//      anchor guarded.
// Fix: ONE three-state admission predicate — proven member admits, proven
// foreign refuses, absent verdict admits ONLY while no needle is planted
// (bootstrap) — applied at BOTH scale-state writers, plus a needle clear at
// rebase (the rebuilt conversation starts a fresh host id generation; a dead
// needle would stall bootstrap forever). The compress-credit meter branch is
// deliberately NOT gated with anchorImpossible: #5135 proved the guard fires
// on the session's OWN honest credited anchor when the client resends covered
// originals (credited 180K vs resent upper 38.7M chars ≈ 64x tower).

function sessionWith(anchor: number): Session {
    return {
        id: "s5925",
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

test("T1 hole (a): a no-id sample cannot settle over the known family's anchor", () => {
    const session = sessionWith(300_000);
    probeRequestMembership(session, Array.from({ length: 12 }, (_, i) => `M${i}`), 300_000);
    assert.equal(session.transient?.latestKnownMsgId, "M11", "the main turn plants the needle");
    // A side-lane request under the same session id carries no ids at all.
    assert.equal(probeRequestMembership(session, [], 2_600), null);
    assert.equal(session.transient!.requestMembership, undefined, "no evidence records no verdict");
    settleUsageReport(session, { total: 5_100, reportedCached: 128, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 300_000, "absent verdict fails closed once the family is known");
    assert.equal(session.stats.lastUsageGradeTokens, undefined, "the grade reading is not rewritten either");
    assert.equal(session.stats.lastUsagePayloadUpper, undefined, "no producer snapshot from a refused settle");
    assert.equal(session.stats.inputTokens, 5_100, "the refused sample still bills cumulatively");
    assert.equal(session.transient?.latestKnownMsgId, "M11", "the polluter cannot move the needle");
});

test("T2 impact chain: the refusal keeps the credited post-fold anchor alive", () => {
    const session = sessionWith(300_000);
    probeRequestMembership(session, Array.from({ length: 12 }, (_, i) => `M${i}`), 300_000);
    // Post-fold: credit pending, the honest main report nets through it.
    (session.stats as { compressCreditTokens?: number }).compressCreditTokens = 40_000;
    settleUsageReport(session, { total: 340_000, reportedCached: null, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 300_000, "the honest report nets through the pending credit");
    // A foreign no-id sample lands while the credit window is still open.
    probeRequestMembership(session, [], 2_600);
    settleUsageReport(session, { total: 5_100, reportedCached: null, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 300_000, "pre-fix this wrote max(0, 5100-40000)=0 and froze the nudge below the 22500 floor");
    assert.equal(session.stats.lastUsageGradeTokens, 300_000, "the grade reading survives too");
    const verdict = effectiveTokenCount(session, bigHistory(800), 0);
    assert.equal(verdict.tokens, 300_000, "the meter keeps sizing from the credited anchor");
    assert.equal(verdict.source, "usage");
});

test("T3 bootstrap unchanged: no-id samples still write before any family is known", () => {
    const fresh = sessionWith(0);
    assert.equal(probeRequestMembership(fresh, [], 9_000), null);
    assert.equal(fresh.transient?.requestMembership, undefined);
    assert.equal(fresh.transient?.latestKnownMsgId, undefined);
    settleUsageReport(fresh, { total: 9_000, reportedCached: null, protocol: "openai" });
    assert.equal(fresh.stats.lastInputTokens, 9_000, "first-turn no-evidence settles keep writing");
});

test("T4 hole (b): a no-id foreign request cannot poison the estimate channel either", () => {
    const session = sessionWith(300_000);
    session.stats.localInputEstimate = 295_000;
    (session.stats as { contextTokensSource?: string }).contextTokensSource = "estimate";
    probeRequestMembership(session, Array.from({ length: 12 }, (_, i) => `M${i}`), 300_000);
    probeRequestMembership(session, [], 2_600);
    noteOutboundContextEstimates(session, { upperBound: 2_600, scaledText: 2_000, imageTokens: 0, calibrated: false });
    assert.equal(session.stats.localInputEstimate, 295_000, "the session scale reading survives the foreign sample");
    assert.equal((session.stats as { contextTokensSource?: string }).contextTokensSource, "estimate", "the freshness mark is untouched");
    // Control: the same send with no family known writes freely.
    const bare = sessionWith(0);
    probeRequestMembership(bare, [], 2_600);
    noteOutboundContextEstimates(bare, { upperBound: 2_600, scaledText: 2_000, imageTokens: 0, calibrated: false });
    assert.equal(bare.stats.localInputEstimate, 2_600, "bootstrap keeps measuring");
});

test("T5 heal: the next id-carrying report re-admits and advances the anchor", () => {
    const session = sessionWith(300_000);
    probeRequestMembership(session, Array.from({ length: 12 }, (_, i) => `M${i}`), 300_000);
    probeRequestMembership(session, [], 2_600);
    settleUsageReport(session, { total: 5_100, reportedCached: null, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 300_000, "refused while the verdict is absent");
    probeRequestMembership(session, [...Array.from({ length: 12 }, (_, i) => `M${i}`), "M12"], 320_000);
    settleUsageReport(session, { total: 320_000, reportedCached: null, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 320_000, "the anchor resumes advancing");
    assert.equal(session.transient?.latestKnownMsgId, "M12", "the needle follows the conversation head");
});

test("T6 rebase: resetSessionCompression clears the dead needle so bootstrap reopens", () => {
    const session = sessionWith(300_000);
    probeRequestMembership(session, Array.from({ length: 12 }, (_, i) => `M${i}`), 300_000);
    assert.equal(session.transient?.latestKnownMsgId, "M11");
    resetSessionCompression(session);
    assert.equal(session.transient?.latestKnownMsgId, undefined, "the rebuilt conversation starts a fresh id generation");
    assert.equal(session.transient?.needlePayloadUpper, undefined);
    // Post-rebase first report: host ids re-minted, none matching the old family.
    probeRequestMembership(session, ["N0", "N1", "N2"], 12_000);
    settleUsageReport(session, { total: 12_000, reportedCached: null, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 12_000, "post-rebase bootstrap is not stalled by a pre-rebase needle");
});

test("T7 admission predicate truth table", () => {
    const mk = (t: Record<string, unknown> | undefined): Session => ({
        id: "s5925p",
        meta: {},
        stats: {} as never,
        metadata: {},
        createdAt: 0,
        lastSeen: 0,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
        transient: t,
    } as never as Session);
    assert.equal(membershipBlocksSettlement(mk(undefined)), false, "no transient admits");
    assert.equal(membershipBlocksSettlement(mk({})), false, "bootstrap: nothing known yet admits");
    assert.equal(membershipBlocksSettlement(mk({ requestMembership: { member: true, needle: "n" } })), false, "proven member admits");
    assert.equal(membershipBlocksSettlement(mk({ requestMembership: { member: false, needle: "n" } })), true, "proven foreign refuses");
    assert.equal(membershipBlocksSettlement(mk({ latestKnownMsgId: "n" })), true, "absent verdict over a known family refuses (the #5925 hole)");
    assert.equal(membershipBlocksSettlement(mk({ latestKnownMsgId: "n", requestMembership: { member: true, needle: "n" } })), false, "an explicit member verdict outranks the needle rule");
});
