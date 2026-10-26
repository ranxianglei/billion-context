import assert from "node:assert";
import test from "node:test";

process.env.NODE_ENV = "test";

import { PrefixAffinityResolver, describeResumeMiss } from "../src/prefix-affinity.ts";

// #4264: a resume-inheritance miss must not be silent. These tests pin the
// diagnostics-only near-miss report: each of the three causes (equal-depth
// replay / parent-chain absence / head break) is asserted distinctly, plus
// the hit-path regression (matching behavior and results stay unchanged).

function user(text: string): Record<string, unknown> {
    return { role: "user", content: text };
}

test("resume-inheritance-miss: equal-depth replay under another id reports kind equal-depth, matching still null (#4264)", () => {
    const r = new PrefixAffinityResolver();
    const transcript = Array.from({ length: 10 }, (_, i) => user(`duplicate conversation turn ${i} with substance`));
    const fp = r.chainFingerprint(transcript)!;
    r.note("sess-one", fp.depth, fp.tailHash, fp.itemHashes);

    const before = r.findResumeParent(transcript, "sess-two");
    const report = r.diagnoseResumeMiss(transcript, "sess-two");
    const after = r.findResumeParent(transcript, "sess-two");
    assert.equal(before, null, "byte-exact equal-depth replay is not a resume (existing behavior)");
    assert.equal(after, null, "diagnostics must not mutate matching state");
    assert.equal(report.eligible, 1);
    assert.ok(report.best, "an eligible candidate must yield a near-miss report");
    assert.equal(report.best!.kind, "equal-depth");
    assert.equal(report.best!.sessionId, "sess-one");
    assert.equal(report.best!.chainDepth, 10);
    assert.equal(report.best!.incomingDepth, 10);
    assert.equal(report.best!.firstDivergence, null, "every inspectable cell matches");
    assert.equal(report.best!.tailWindowIntact, true);
    assert.match(describeResumeMiss(report), /EQUAL-DEPTH replay \(10 cells == incoming 10\)/);
    assert.match(describeResumeMiss(report), /either a duplicate conversation or a branch taken at the parent's last-request depth — content cannot distinguish/, "equal-depth must not assert a cause content cannot establish");
});

test("resume-inheritance-miss: head break names the first diverging cell with hash digests (#4264)", () => {
    const r = new PrefixAffinityResolver();
    const parent = Array.from({ length: 10 }, (_, i) => user(`stable parent turn ${i} with substance`));
    const fp = r.chainFingerprint(parent)!;
    r.note("sess-parent", fp.depth, fp.tailHash, fp.itemHashes);

    const edited = [...parent];
    edited[2] = user("edited third turn — different bytes");
    const incoming = [...edited, user("and the conversation goes on")];
    assert.equal(r.findResumeParent(incoming, "child"), null, "a mid-history edit breaks the head-anchored match");

    const report = r.diagnoseResumeMiss(incoming, "child");
    assert.equal(report.eligible, 1);
    assert.equal(report.best!.kind, "prefix-break");
    assert.equal(report.best!.sessionId, "sess-parent");
    assert.equal(report.best!.chainDepth, 10);
    assert.equal(report.best!.incomingDepth, 11);
    assert.equal(report.best!.windowStart, 0);
    assert.equal(report.best!.firstDivergence, 2, "divergence at exactly the edited cell");
    assert.equal(report.best!.tailWindowIntact, false);
    assert.match(report.best!.incomingCell!, /^[0-9a-f]{8}$/);
    assert.match(report.best!.storedCell!, /^[0-9a-f]{8}$/);
    assert.notEqual(report.best!.incomingCell, report.best!.storedCell);
    assert.match(describeResumeMiss(report), /first divergence at cell 2 \(stored [0-9a-f]{8} vs incoming [0-9a-f]{8}\)/);
});

test("resume-inheritance-miss: deep chain broken before the stored window reports the pre-window bound (#4264)", () => {
    const r = new PrefixAffinityResolver();
    const long = Array.from({ length: 130 }, (_, i) => user(`long chain message number ${i} with substance`));
    const fp = r.chainFingerprint(long)!;
    assert.equal(fp.itemHashes.length, 128, "per-item hashes stay capped");
    r.note("sess-long", fp.depth, fp.tailHash, fp.itemHashes);

    const drifted = [...long];
    drifted[0] = user("re-encoded first message — host rebuild drift");
    const incoming = [...drifted, user("thirteen-one")];
    assert.equal(r.findResumeParent(incoming, "child"), null);

    const report = r.diagnoseResumeMiss(incoming, "child");
    assert.equal(report.best!.kind, "prefix-break");
    assert.equal(report.best!.windowStart, 2, "cells 0..1 uninspectable for a 130-deep chain");
    assert.equal(report.best!.firstDivergence, null, "the whole inspectable overlap matched");
    assert.equal(report.best!.tailWindowIntact, true);
    assert.match(describeResumeMiss(report), /tail window \(cells 2\.\.129\) byte-intact — break sits BEFORE cell 2/);
});

test("resume-inheritance-miss: truncated replay is reported distinctly from a head break (#4264)", () => {
    const r = new PrefixAffinityResolver();
    const parent = Array.from({ length: 10 }, (_, i) => user(`full parent turn ${i} with substance`));
    const fp = r.chainFingerprint(parent)!;
    r.note("sess-parent", fp.depth, fp.tailHash, fp.itemHashes);

    const trimmed = parent.slice(0, 9);
    assert.equal(r.findResumeParent(trimmed, "child"), null, "trimmed history is not a resume");
    const report = r.diagnoseResumeMiss(trimmed, "child");
    assert.equal(report.best!.kind, "truncated");
    assert.equal(report.best!.chainDepth, 10);
    assert.equal(report.best!.incomingDepth, 9);
    assert.equal(report.best!.tailWindowIntact, true, "the visible cells form a clean prefix");
    assert.match(describeResumeMiss(report), /LONGER than the incoming history \(9 cells\)/);
});

test("resume-inheritance-miss: absent parent chains report zero eligible at debug granularity (#4264)", () => {
    const r = new PrefixAffinityResolver();
    const parent = Array.from({ length: 10 }, (_, i) => user(`orphaned branch turn ${i} with substance`));
    const report = r.diagnoseResumeMiss(parent, "child");
    assert.deepEqual(report, { eligible: 0 }, "nothing tracked — no near miss exists");
    assert.match(describeResumeMiss(report), /^no eligible tracked chain \(floor 8\)$/);
});

test("resume-inheritance-miss: scoped match reports the declared parent's own state (#4264)", () => {
    const r = new PrefixAffinityResolver();
    const other = Array.from({ length: 10 }, (_, i) => user(`unrelated tracked turn ${i} with substance`));
    const ofp = r.chainFingerprint(other)!;
    r.note("sess-other", ofp.depth, ofp.tailHash, ofp.itemHashes);
    const short = Array.from({ length: 7 }, (_, i) => user(`short declared turn ${i} with substance`));
    const sfp = r.chainFingerprint(short)!;
    r.note("sess-short", sfp.depth, sfp.tailHash, sfp.itemHashes);

    const candidate = Array.from({ length: 11 }, (_, i) => user(`declared child turn ${i} with substance`));
    assert.equal(r.findResumeParentWithin("sess-ghost", candidate, "child"), null);
    assert.deepEqual(r.diagnoseResumeMiss(candidate, "child", "sess-ghost"), { eligible: 0, declaredParentState: "untracked" });
    assert.match(describeResumeMiss(r.diagnoseResumeMiss(candidate, "child", "sess-ghost")), /declared parent chain untracked/);

    assert.equal(r.findResumeParentWithin("sess-short", candidate, "child"), null, "7-deep declared parent below the floor cannot match");
    const shallow = r.diagnoseResumeMiss(candidate, "child", "sess-short");
    assert.deepEqual(shallow, { eligible: 0, declaredParentState: "too-shallow" });
});

test("resume-inheritance-miss: scoped match judges only the declared parent's chain (#4264)", () => {
    const r = new PrefixAffinityResolver();
    const base = Array.from({ length: 10 }, (_, i) => user(`common base turn ${i} with substance`));
    const extA = [...base, user("extension A")];
    const extB = [...base, user("extension B")];
    const fpA = r.chainFingerprint(extA)!;
    r.note("sess-a", fpA.depth, fpA.tailHash, fpA.itemHashes);
    const fpB = r.chainFingerprint(extB)!;
    r.note("sess-b", fpB.depth, fpB.tailHash, fpB.itemHashes);

    const candidate = [...extA, user("and further along")];
    // Hit-path regression: the matching scoped parent still resolves exactly as before.
    assert.deepEqual(r.findResumeParentWithin("sess-a", candidate, "child"), { sessionId: "sess-a", sharedDepth: 11 });
    // Miss-path: the OTHER chain is out of scope even though it is tracked.
    assert.equal(r.findResumeParentWithin("sess-b", candidate, "child"), null);
    const report = r.diagnoseResumeMiss(candidate, "child", "sess-b");
    assert.equal(report.eligible, 1, "only the declared parent's chain is judged");
    assert.equal(report.best!.sessionId, "sess-b");
    assert.equal(report.best!.kind, "prefix-break");
    assert.equal(report.best!.firstDivergence, 10, "the two extensions differ at cell 10");
    assert.equal(report.best!.windowStart, 0);
    assert.match(describeResumeMiss(report), /closest sess-b \(chain 11, incoming 12\)/);
});

test("resume-inheritance-miss: the caller's own id stays excluded from the near-miss report (#4264)", () => {
    const r = new PrefixAffinityResolver();
    const transcript = Array.from({ length: 10 }, (_, i) => user(`self replay turn ${i} with substance`));
    const fp = r.chainFingerprint(transcript)!;
    r.note("self-id", fp.depth, fp.tailHash, fp.itemHashes);
    assert.equal(r.findResumeParent(transcript, "self-id"), null);
    assert.deepEqual(r.diagnoseResumeMiss(transcript, "self-id"), { eligible: 0 }, "self-exclusion mirrors the matcher");
});

test("resume-inheritance-miss: hit paths are byte-for-byte unchanged by the diagnostics surface (#4264)", () => {
    const r = new PrefixAffinityResolver();
    const parent = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? user(`parent turn ${i} with real substance`) : { role: "assistant", content: `parent reply ${i}` }));
    const fp = r.chainFingerprint(parent)!;
    r.note("sess-parent", fp.depth, fp.tailHash, fp.itemHashes);
    const resumed = [...parent, user("resumed conversation next question")];
    assert.deepEqual(r.findResumeParent(resumed, "sess-child"), { sessionId: "sess-parent", sharedDepth: 10 });
    // A HIT produces no miss report at all — the server only calls diagnose
    // on a null match, so nothing here may change the hit result.
    assert.deepEqual(r.findResumeParent(resumed, "sess-child"), { sessionId: "sess-parent", sharedDepth: 10 });
});
