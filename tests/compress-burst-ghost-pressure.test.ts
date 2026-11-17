import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { effectiveTokenCount } from "../src/server.ts";
import { usageAnchorCycleStale } from "../src/session.ts";

// #5135+#4383 field fix (billion-context, 2026-11-08 session 01a1b6b3): a
// compress BURST — turns whose only output is compress calls — never reaches
// an upstream settle, so the send chokepoint keeps stamping
// contextTokensSource="estimate" and usageAnchorCycleStale() stays true for
// the whole burst. Pre-fix, the #5135 credit exemption was gated on
// !anchorStale, so it was dead exactly when needed: right after a successful
// fold (applyRanges had already netted lastInputTokens down to 84K) the meter
// fell through to the raw INBOUND upper bound — the full resent history —
// and read 238112/212992 = 112% "pressure", re-nudging the model into the
// very compress loop the fold was supposed to end. Pending credit must
// override cycle-staleness; the next real settle clears the credit, so the
// meter cannot freeze.

function statsSession(over: Partial<Session["stats"]>): Session {
    return {
        id: "ghost-pressure-test",
        meta: {},
        stats: {
            requests: 1, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0,
            cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0,
            retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0,
            storeBytesSaved: 0, rangeRestores: 0,
            ...over,
        } as Session["stats"],
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    } as Session;
}

const msgs: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: "x".repeat(4096) },
    { id: "m2", role: "assistant", contentType: "text", text: "y".repeat(4096) },
];

test("pending compress credit overrides cycle-staleness (no phantom pressure mid-burst)", () => {
    const session = statsSession({
        lastInputTokens: 84_000,
        lastInputTokensSource: "usage",
        contextTokensSource: "estimate",       // mid-burst: no settle since the fold
        localInputEstimate: 238_112,           // the raw resent-history bound
        compressCreditTokens: 5_976,           // fold succeeded this burst
    });
    assert.equal(usageAnchorCycleStaleIsTrue(session), true, "precondition: anchor is cycle-stale");
    const eff = effectiveTokenCount(session, msgs);
    assert.deepEqual(eff, { tokens: 84_000, source: "usage" }, `netted post-fold usage must win, got ${JSON.stringify(eff)}`);
});

test("without credit the cycle-stale guard still refuses the frozen anchor", () => {
    const session = statsSession({
        lastInputTokens: 84_000,
        lastInputTokensSource: "usage",
        contextTokensSource: "estimate",
        localInputEstimate: 238_112,
        compressCreditTokens: 0,
    });
    const eff = effectiveTokenCount(session, msgs);
    assert.ok(!(eff.source === "usage" && eff.tokens === 84_000), "stale anchor must not masquerade as fresh usage when no fold backs it");
});

function usageAnchorCycleStaleIsTrue(s: Session): boolean {
    return usageAnchorCycleStale(s.stats);
}
