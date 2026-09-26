import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { foldCoverage } from "../src/session.ts";

function makeSession(): Session {
    return {
        id: `test-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

// #1195 scenario fixture: 24 distinct messages, m00001-m00007 compressed into
// one active block. 24 keeps the fold range outside the kernel's protected
// tail (preserveRecentMessages: 5 + preserveRecentTokens: 5e3 cover roughly
// the last 10 of these ~503-token messages), mirroring production where folds
// target well-aged history. stableResend re-sends identical bytes (ids
// unchanged); driftedResend mutates one covered message's bytes (its
// content-hash id changes, as a client resume/edit/re-serialization would do).
function driftFixture(): { session: Session; coveredIds: string[]; stableResend: CoreMessage[]; driftedResend: CoreMessage[] } {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const mk = (i: number): CoreMessage => ({ id: `h_stable${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `message ${i} ${"x".repeat(2000)}` });
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 24; i++) msgs.push(mk(i));
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00007", summary: "compressed early history that is long enough to pass the min summary length check" }],
        messages: turn.messages,
        state: turn.state,
        config,
    });
    session.state = res.state;
    const block = session.state.blocks[session.state.blocks.length - 1];
    assert.ok(block.active, "fixture block must be active");
    assert.ok(block.effectiveMessageIds.length > 0, "fixture block must cover message ids");
    const coveredIds = [...block.effectiveMessageIds];
    const fullResend = (): CoreMessage[] => {
        const out: CoreMessage[] = [];
        for (let i = 0; i < 24; i++) out.push(mk(i));
        return out;
    };
    const stableResend = fullResend();
    const driftedResend = fullResend().map((m, i) => (i === 3 ? { ...m, id: `h_drifted${i}`, text: `message 3 EDITED ${"x".repeat(1994)}` } : m));
    return { session, coveredIds, stableResend, driftedResend };
}

test("foldCoverage: null when nothing was covered", () => {
    assert.equal(foldCoverage(new Set(), ["a", "b"]), null);
});

test("foldCoverage: null when every covered id is present in the resent history", () => {
    const { coveredIds, stableResend } = driftFixture();
    assert.equal(foldCoverage(new Set(coveredIds), stableResend.map((m) => m.id)), null);
});

test("foldCoverage: reports the gap when a covered id drifted out of the resent history", () => {
    const { coveredIds, driftedResend } = driftFixture();
    const gap = foldCoverage(new Set(coveredIds), driftedResend.map((m) => m.id));
    assert.ok(gap !== null, "drifted resend must produce a coverage gap");
    assert.equal(gap.expected, coveredIds.length);
    assert.equal(gap.matched, coveredIds.length - 1);
});

// Mirrors the server.ts prepare* capture/check pair: snapshot covered ids
// before processTurn (with pendingFoldUsage armed), run the post-compress
// resend through processTurn, then evaluate the gap after credit clearing.
// Stable resend → silent; drifted resend → the #1195 warning condition holds.
test("server-side materialization check stays silent on stable resend and fires on drift", () => {
    for (const label of ["stable", "drifted"] as const) {
        const fx = driftFixture();
        const resend = label === "stable" ? fx.stableResend : fx.driftedResend;
        const { session, coveredIds } = fx;
        session.stats.pendingFoldUsage = true;
        const core = createCore();
        const config = defaultConfig(200000);
        const foldCoveredBefore = session.stats.pendingFoldUsage === true
            ? new Set(session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])))
            : null;
        assert.deepEqual([...foldCoveredBefore!].sort(), [...coveredIds].sort());
        const turn = core.processTurn({ messages: resend, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
        session.state = turn.state;
        session.stats.compressCreditTokens = 0;
        session.stats.pendingFoldUsage = false;
        const gap = foldCoverage(foldCoveredBefore!, resend.map((m) => m.id));
        if (label === "stable") {
            assert.equal(gap, null, "stable resend must not trip the drift check");
        } else {
            assert.ok(gap !== null, "drifted resend must trip the drift check");
            assert.equal(gap.matched, gap.expected - 1);
        }
    }
});
