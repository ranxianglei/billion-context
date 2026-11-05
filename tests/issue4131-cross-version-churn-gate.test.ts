import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

// #4131: cross-version restart (v0.1.197 → v0.1.202, kernel 0.0.122 → 0.0.136)
// re-mints non-text message ids by design (#3642 D1 accepted the one-time mass
// churn and promised the reconcile ladder would absorb it). The #1001 rewrite
// detector ran OUTSIDE that ladder on raw-id hash identity alone, marked a
// compaction boundary anyway, and applyCompactionArchive pruned the ref map +
// tombstoned hundreds of still-cited refs — destroying fold coverage for a
// transform. Gate discipline: both directions asserted — explained churn is
// suppressed, genuine destruction still escalates, legacy callers unchanged.

import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { applyCompactionArchive, detectUnannouncedHistoryRewrite, markCompactionBoundary } from "../src/session.ts";
import { reconcileFoldCoverage } from "../src/fold-reconcile.ts";

const noLog = (_level: string, _msg: string): void => {};

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

// 24 real messages → processTurn assigns m00001..m00024 → compress the first
// half so the session carries one active block (same shape as
// tests/fix-1001-history-rewrite.test.ts).
function sessionWithBlockAndRefs(): { session: Session; blockId: string; all: CoreMessage[] } {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 24; i++) {
        msgs.push({ id: `h_distinct${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `message ${i} ${"x".repeat(2000)}` });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00012", summary: "compressed early history that is long enough to pass the min summary length check" }],
        messages: turn.messages,
        state: turn.state,
        config,
    });
    session.state = res.state;
    return { session, blockId: session.state.blocks[session.state.blocks.length - 1].blockId, all: msgs };
}

const repair = () => ({ mode: "repair" as const, sessionId: "s-4131", log: noLog });

// #3642 incident shape: bili's own cross-build id re-mint — bytes unchanged,
// ~2/3 of message ids re-minted (non-text cores), order preserved.
function remint(all: CoreMessage[]): CoreMessage[] {
    return all.map((m, i) => (i % 3 === 0 ? m : { ...m, id: `v2_${m.id}` }));
}

test("#4131 POSITIVE: cross-build id re-mint with full re-anchor does NOT mark a destructive boundary", () => {
    const { session, all } = sessionWithBlockAndRefs();
    const knownBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
    assert.equal(knownBefore.size, 24);

    // seed anchors/order metadata with a clean pass over the original history
    // (production does this on every pre-restart turn)
    const pass1 = reconcileFoldCoverage(session, all, repair());
    assert.equal(pass1.kind, "resend", `clean first pass: ${JSON.stringify(pass1)}`);

    const reminted = remint(all);
    assert.equal(reminted.filter((m, i) => i % 3 !== 0).length, 16, "fixture re-mints 16 of 24 ids");

    // sanity: the hash-identity collapse alone WOULD trip the legacy detector
    const legacy = detectUnannouncedHistoryRewrite(session, knownBefore, reminted.map((m) => m.id));
    assert.equal(legacy.detected, true, `legacy gate must fire on this shape (${JSON.stringify(legacy)})`);
    assert.equal(legacy.churnExplained, false);

    // the real verdict from THIS pass's fold-reconcile
    const pass2 = reconcileFoldCoverage(session, reminted, repair());
    assert.ok(pass2.kind === "reanchored" || pass2.kind === "resend", `expected full recovery verdict: ${JSON.stringify(pass2)}`);
    assert.equal(pass2.unmatched, 0, `every covered id must be found on the wire: ${JSON.stringify(pass2)}`);

    const det = detectUnannouncedHistoryRewrite(session, knownBefore, reminted.map((m) => m.id), pass2);
    assert.equal(det.churnExplained, true, `explained churn must be flagged (${JSON.stringify(det)})`);
    assert.equal(det.detected, false, "destructive boundary must be suppressed");
    assert.equal(session.metadata.compactionBoundary, undefined, "no boundary recorded");
    assert.equal(session.state.deadRefs, undefined, "no refs tombstoned");
});

test("#4131 NEGATIVE 1: genuine client rewrite (covered substrate gone) still escalates despite the verdict", () => {
    const { session, all } = sessionWithBlockAndRefs();
    const knownBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
    reconcileFoldCoverage(session, all, repair());

    // #1001 shape: client kept the last 8 originals, appended 16 brand-new
    // messages — the covered head (m00001–m00012) is truly gone
    const rewritten: CoreMessage[] = [
        ...all.slice(16),
        ...Array.from({ length: 16 }, (_, k): CoreMessage => ({ id: `h_new${k}`, role: k % 2 === 0 ? "user" : "assistant", contentType: "text", text: `new ${k}` })),
    ];
    const pass = reconcileFoldCoverage(session, rewritten, repair());
    assert.ok(pass.unmatched > 0, `covered substrate must stay honestly unmatched: ${JSON.stringify(pass)}`);

    const det = detectUnannouncedHistoryRewrite(session, knownBefore, rewritten.map((m) => m.id), pass);
    assert.equal(det.churnExplained, false, `partial loss must not be explained away (${JSON.stringify(det)})`);
    assert.equal(det.detected, true, "genuine rewrite keeps the legacy escalation path");
});

test("#4131 NEGATIVE 2: append-only growth is neither detected nor explained", () => {
    const { session, all } = sessionWithBlockAndRefs();
    const knownBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
    const appended: CoreMessage[] = [
        ...all,
        ...Array.from({ length: 4 }, (_, k): CoreMessage => ({ id: `h_new${k}`, role: k % 2 === 0 ? "user" : "assistant", contentType: "text", text: `new ${k}` })),
    ];
    const pass = reconcileFoldCoverage(session, appended, repair());
    assert.equal(pass.kind, "resend");
    const det = detectUnannouncedHistoryRewrite(session, knownBefore, appended.map((m) => m.id), pass);
    assert.equal(det.detected, false);
    assert.equal(det.churnExplained, false);
});

test("#4131 NEGATIVE 3: off/noop verdicts carry no evidence and do NOT suppress the legacy gate", () => {
    const { session, all } = sessionWithBlockAndRefs();
    const knownBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
    reconcileFoldCoverage(session, all, repair());
    const reminted = remint(all);
    for (const verdict of [
        { kind: "noop" as const, unmatched: 0 },
        { kind: "off" as const, unmatched: 0 },
        null,
        undefined,
    ]) {
        const det = detectUnannouncedHistoryRewrite(session, knownBefore, reminted.map((m) => m.id), verdict);
        assert.equal(det.detected, true, `verdict ${String(verdict?.kind ?? "absent")} must not suppress`);
        assert.equal(det.churnExplained, false);
    }
});

test("#4131 fix②: prune log names the dropped refs' block coverage instead of staying silent", () => {
    const { session, blockId, all } = sessionWithBlockAndRefs();
    markCompactionBoundary(session);
    const logs: string[] = [];
    // live set = the tail only: every covered id of the active block is dropped
    applyCompactionArchive(session, new Set([blockId]), new Set(all.slice(16).map((m) => m.id)), (l, m) => logs.push(`${l}: ${m}`));
    const line = logs.find((l) => l.includes("native compaction boundary"));
    assert.ok(line, `archive log line present: ${logs.join(" | ")}`);
    assert.match(line!, /; 16 ref\(s\) dropped, covering block\(s\)/, `coverage cost named in log: ${line}`);
    assert.ok(line!.includes(blockId), `affected block id named in log: ${line}`);
    // tombstoning behavior itself is unchanged by #4131
    assert.ok(Array.isArray(session.state.deadRefs) && session.state.deadRefs.length > 0, "dropped refs still tombstoned for citation honesty (#3302)");
});
