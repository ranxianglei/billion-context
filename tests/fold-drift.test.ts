import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { foldCoverage } from "../src/session.ts";
import { responsesToCore } from "acp-kernel/wire";
import { reconcileFoldCoverage, METADATA_DRIFT_ESCALATED, type FoldAnchor } from "../src/fold-reconcile.ts";

test("projected short requests preserve real kernel folds until the main history returns", () => {
    const { session, stableResend, coveredIds } = driftFixture();
    const core = createCore();
    const config = defaultConfig(200_000);
    const opts = { mode: "repair" as const };
    reconcileFoldCoverage(session, stableResend, opts);
    const blockIds = session.state.blocks.map((b) => b.blockId);
    const input = Array.from({ length: 6 }, (_, i) => ({
        type: "message" as const, role: "user" as const,
        content: Array.from({ length: 13 }, (_, j) => ({ type: "input_text" as const, text: `short utility ${i} part ${j}` })),
    }));
    const { msgs } = responsesToCore({ input });
    assert.ok(msgs.length >= 10);
    for (let i = 0; i < 4; i++) {
        reconcileFoldCoverage(session, msgs, { ...opts, inboundMessageCount: input.length });
        session.state = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 0 }).state;
        assert.deepEqual(session.state.blocks.map((b) => b.blockId), blockIds, "sync may deactivate but must retain every fold");
    }
    reconcileFoldCoverage(session, stableResend, opts);
    session.state = core.processTurn({ messages: stableResend, state: session.state, config, tokenCount: 0 }).state;
    assert.deepEqual(session.state.blocks.map((b) => b.blockId), blockIds);
    assert.ok(session.state.blocks.every((b) => b.active));
    assert.deepEqual(session.state.blocks[0].effectiveMessageIds, coveredIds);
});

function makeSession(): Session {
    return {
        id: `test-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
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

// #2903: legacy foldAnchors persisted by ≤0.1.191 builds carry no content-type
// class (`c`), so once their id leaves the wire the reconciler can never match
// them again — they read as "missing" every pass and can never be backfilled
// (the #2732 backfill needs live bytes). That permanent bili self-debt must NOT
// count as non-reasoning loss in the destroy classifier, or a healthy long
// session latches foldDriftEscalated after 3 passes; but a genuine client-side
// rewrite/deletion still carries a concrete class and MUST keep escalating.
// Drives reconcileFoldCoverage directly over a synthetic pre-0.1.192 ledger.
function escalationFixture(legacyCount: number, realCount: number): { session: Session; resend: CoreMessage[] } {
    const session = makeSession();
    const coveredIds: string[] = [];
    const anchors: Record<string, FoldAnchor> = {};
    for (let i = 0; i < legacyCount; i++) {
        const id = `cov_legacy_${i}`;
        coveredIds.push(id);
        anchors[id] = { n: `anc_legacy_${i}`, r: "user", b: 128 }; // ≤0.1.191 shape: no `c`
    }
    for (let i = 0; i < realCount; i++) {
        const id = `cov_real_${i}`;
        coveredIds.push(id);
        anchors[id] = { n: `anc_real_${i}`, r: "user", c: "text", b: 128 }; // known non-reasoning
    }
    session.state.blocks = [{
        blockId: "b0", runId: "r0", tier: 1, summary: "fold", directMessageIds: coveredIds,
        effectiveMessageIds: coveredIds, directBlockIds: [], compressedTokens: 1000, createdAt: Date.now(),
        survivedCount: 0, generation: "young", active: true,
    }];
    // Mirror the victim lane (dsh plugin): disables the proxy-only orphan-reap so
    // the assertion isolates the drift-escalation path.
    session.metadata = { pluginAgent: "dsh", foldAnchors: anchors, foldAnchorOrder: [...coveredIds] };
    // Resend carrying none of the covered ids → every covered id is unmatched each
    // pass and nothing reanchors (the fake `n` values never equal a live sha256).
    const resend: CoreMessage[] = [];
    for (let i = 0; i < 24; i++) resend.push({ id: `wire_${i}`, role: "user", contentType: "text", text: `fresh turn ${i} ${"y".repeat(64)}` });
    return { session, resend };
}

function runEscalationPasses(session: Session, resend: CoreMessage[], passes: number): void {
    for (let i = 0; i < passes; i++) reconcileFoldCoverage(session, resend, { mode: "repair" });
}

test("#2903: pure-legacy anchor debt never latches foldDriftEscalated", () => {
    const { session, resend } = escalationFixture(20, 0);
    runEscalationPasses(session, resend, 4);
    // Prove the total-loss path actually ran (streak reached the escalate pass) —
    // otherwise the not-escalated assertion would be vacuous.
    assert.ok((session.metadata["foldDriftStreak"] as number) >= 3, "fixture must drive the total-loss streak to the escalate pass");
    assert.notEqual(session.metadata[METADATA_DRIFT_ESCALATED], true,
        "legacy (no-class) anchors are bili self-debt, not client destruction — must not escalate");
});

test("#2903: legacy debt + real missing still escalates (no wholesale silencing)", () => {
    const { session, resend } = escalationFixture(40, 10);
    runEscalationPasses(session, resend, 4);
    assert.equal(session.metadata[METADATA_DRIFT_ESCALATED], true,
        "a concrete-class missing message alongside legacy debt still counts toward the destroy threshold");
});

test("#2903: genuine client-side loss alone still escalates (detection intact)", () => {
    const { session, resend } = escalationFixture(0, 10);
    runEscalationPasses(session, resend, 4);
    assert.equal(session.metadata[METADATA_DRIFT_ESCALATED], true,
        "pure known-class missing ids (real rewrite/deletion) must still escalate");
});
