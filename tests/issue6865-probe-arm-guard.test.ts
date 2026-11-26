import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

// #6865: the #5974 corrective-pass probe (server.ts preflightCompressIfNeeded)
// measured the fresh rebuild and wrote a local estimate onto the session
// baseline WITHOUT an overflow-arm guard. In the caliber-delta case (post-fold
// local probe slightly above the armed wall, but the payload actually fits) the
// probe demoted the ACTIVE overflow-arm evidence tag to "estimate" BEFORE the
// post-rebuild anchor write ran — silently disarming the evidence floor that
// keeps an armed session folding instead of trusting optimistic estimates. The
// next turn then fit-forwarded on a stale optimistic estimate until the upstream
// 400 re-armed it: the exact fold → forward → 400 livelock #5880 fixed, re-opened
// on the probe path.
//
// The fix extracts the probe's baseline write into applyProbeBaselineAnchor
// (session.ts) with the same overflow-arm guard as armFailureShrink (relay.ts
// #2484). These unit pins lock BOTH directions (#3617 gate discipline):
//   armed   → the overflow-arm tag AND its value survive the probe write;
//   unarmed → the #1987 anchor behavior is unchanged (larger probe raises the
//             floor, smaller probe never lowers it);
//   usage   → a newer larger local estimate still retires an older usage sample
//             (#604 behavior preserved).

import { createInitialState } from "acp-kernel";
import { applyProbeBaselineAnchor } from "../src/session.ts";
import type { Session } from "../src/session.ts";

function makeSession(lastInputTokens: number, source: Session["stats"]["lastInputTokensSource"]): Session {
    const now = Date.now();
    return {
        id: "s6865-unit",
        meta: {},
        metadata: {},
        state: createInitialState(),
        stats: {
            requests: 1,
            tokensSaved: 0,
            inputTokens: 0,
            cachedTokens: 0,
            outputTokens: 0,
            cacheSamples: 0,
            lastInputTokens,
            lastInputTokensSource: source,
            compressCreditTokens: 0,
            contextTokens: lastInputTokens,
            retrieveCalls: 0,
            retrieveHits: 0,
            retrieveMisses: 0,
            storedBytes: 0,
            storeBytesSaved: 0,
            rangeRestores: 0,
        },
        pendingRetrievals: [],
        createdAt: now,
        lastSeen: now,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    } as unknown as Session;
}

test("#6865 armed: an active overflow-arm tag survives the probe baseline write", () => {
    // Incident shape: the arm holds the netted measured value; the #5974 probe's
    // fresh rebuilt-view estimate measures slightly HIGHER (caliber delta). The
    // pre-fix inequality-based write demoted the tag to "estimate" here.
    const s = makeSession(783_000, "overflow-arm");
    applyProbeBaselineAnchor(s, 783_353);
    assert.equal(s.stats.lastInputTokensSource, "overflow-arm", "armed tag must not be demoted by the probe");
    assert.equal(s.stats.lastInputTokens, 783_000, "arm value must not be overwritten by the probe estimate");
});

test("#6865 unarmed: estimate-grade sessions keep the #1987 anchor behavior (both directions)", () => {
    const up = makeSession(100_000, "estimate");
    applyProbeBaselineAnchor(up, 120_000);
    assert.equal(up.stats.lastInputTokens, 120_000, "larger probe must still anchor the baseline (#1987)");
    assert.equal(up.stats.lastInputTokensSource, "estimate");

    const down = makeSession(100_000, "estimate");
    applyProbeBaselineAnchor(down, 80_000);
    assert.equal(down.stats.lastInputTokens, 100_000, "smaller probe must not lower the floor");
    assert.equal(down.stats.lastInputTokensSource, "estimate");
});

test("#6865 usage: a newer larger probe estimate still retires an older usage sample (#604)", () => {
    const u = makeSession(100_000, "usage");
    applyProbeBaselineAnchor(u, 120_000);
    assert.equal(u.stats.lastInputTokens, 120_000);
    assert.equal(u.stats.lastInputTokensSource, "estimate", "usage→estimate overwrite stays #604 behavior");
});

test("#6865 unarmed-fresh: a session with no source tag anchors on a larger probe", () => {
    const f = makeSession(0, undefined);
    applyProbeBaselineAnchor(f, 55_000);
    assert.equal(f.stats.lastInputTokens, 55_000, "a fresh session must anchor on the probe estimate");
    assert.equal(f.stats.lastInputTokensSource, "estimate");
});
