import test from "node:test";
import assert from "node:assert/strict";
import { computeAnthropicMessageMarks } from "../src/loop/cache-control.ts";
import { planForkAdoption, applyForkAdoption } from "../src/fork-adoption.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { Session } from "../src/session.ts";

/**
 * #5519: a fork/resume that adopts its parent's compression state starts with
 * NO Anthropic cache-breakpoint ledger of its own — the plain single-tail
 * push left its first turns one anchor deep while the shared prefix ran
 * hundreds of messages long behind no cached segment at all. The fix arms a
 * one-shot ladder init in applyForkAdoption: the child's FIRST anthropic-owned
 * mark pass seeds tail + half + quarter across its stable region, then hands
 * back to the sticky #1637 dynamics unchanged. These pins cover both halves:
 * the adoption side (flag armed, parent ledger NOT copied) and the compute
 * side (seed shape, stickiness afterward, retirement, fallbacks, consumption).
 */

function fakeSession(): Session {
    return {
        state: {
            blocks: [] as unknown[],
            tokenSnapshot: {} as Record<string, number>,
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw: {} as Record<string, string>, byRef: {} as Record<string, string> },
        },
        blockContents: new Map(),
        metadata: {},
    } as unknown as Session;
}

function fakeParent(markIds: string[]): Session {
    const byRaw: Record<string, string> = { raw1: "m00001", raw2: "m00002", raw3: "m00003" };
    const byRef: Record<string, string> = {};
    for (const [raw, ref] of Object.entries(byRaw)) byRef[ref] = raw;
    return {
        state: {
            blocks: [
                { blockId: "b1", active: true, effectiveMessageIds: ["raw1", "raw2", "raw3"], directBlockIds: [], compressedTokens: 900 },
            ],
            tokenSnapshot: {},
            nextBlockId: 2,
            nextRunId: 1,
            messageRefs: { byRaw, byRef },
        },
        blockContents: new Map(),
        metadata: { anthropicCacheMarkIds: markIds },
    } as unknown as Session;
}

// Message-shaped fixtures: computeAnthropicMessageMarks reads m.id off each entry.
const ids = (n: number): { id?: string }[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));

test("#5519 status quo pin: a non-fork session's first turn still marks only the tail", () => {
    const s = fakeSession();
    const marks = computeAnthropicMessageMarks(ids(5), 0, s);
    assert.deepEqual([...marks.keys()], ["p4"], "single tail mark, unchanged behavior");
    assert.deepEqual(s.metadata["anthropicCacheMarkIds"], ["p4"]);
});

test("#5519 adoption arms the one-shot ladder init and copies NO parent ledger", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const parent = fakeParent(["a", "b", "c"]);
    const child = fakeSession();
    const plan = planForkAdoption(parent, new Set(["raw1", "raw2", "raw3"]), { seedAllRefs: true });
    assert.equal(plan.adoptedActive, 1, "fixture sanity: the block is adoptable");
    applyForkAdoption(child, plan, parent);
    assert.equal(child.metadata["cacheMarkLadderInitPending"], true, "ladder init armed");
    assert.equal(child.metadata["anthropicCacheMarkIds"], undefined, "parent positions are stale for the child's view — never copied verbatim");
});

test("#5519 fork first turn seeds quarter + half + tail across the stable region", () => {
    const s = fakeSession();
    s.metadata["cacheMarkLadderInitPending"] = true;
    const marks = computeAnthropicMessageMarks(ids(13), 0, s);
    // lastIndex = 12 → floor(12*0.25)=3, floor(12*0.5)=6, tail=12
    assert.deepEqual([...marks.keys()], ["p3", "p6", "p12"]);
    assert.deepEqual(s.metadata["anthropicCacheMarkIds"], ["p3", "p6", "p12"], "positional order like the steady-state accumulator");
    assert.equal(s.metadata["cacheMarkLadderInitPending"], undefined, "one-shot: flag consumed");
});

test("#5519 seeded ladder obeys the #1637 sticky dynamics from turn 2 on (cap freeze)", () => {
    const s = fakeSession();
    s.metadata["cacheMarkLadderInitPending"] = true;
    computeAnthropicMessageMarks(ids(13), 0, s);
    const second = computeAnthropicMessageMarks(ids(15), 0, s);
    assert.deepEqual([...second.keys()], ["p3", "p6", "p12"], "cap full: no advance, existing marks byte-stable");
});

test("#5519 fold retirement still frees slots in a seeded ladder", () => {
    const s = fakeSession();
    s.metadata["cacheMarkLadderInitPending"] = true;
    computeAnthropicMessageMarks(ids(13), 0, s);
    // a fold covers p0..p5: p3 retires, p6/p12 survive, tail grows to p14
    const foldedView = [...ids(13).slice(6), { id: "p13" }, { id: "p14" }];
    const third = computeAnthropicMessageMarks(foldedView, 0, s);
    assert.equal(third.has("p3"), false, "folded mark retired");
    assert.ok(third.has("p6") && third.has("p12"), "survivors keep their marks");
    assert.ok(third.has("p14"), "freed slot picks up the new tail");
    assert.equal(third.size, 3, "cap holds");
});

test("#5519 short stable region falls back to the single-tail push", () => {
    const s = fakeSession();
    s.metadata["cacheMarkLadderInitPending"] = true;
    const marks = computeAnthropicMessageMarks(ids(2), 0, s);
    assert.deepEqual([...marks.keys()], ["p1"], "no degenerate quarter/half anchors");
    assert.equal(s.metadata["cacheMarkLadderInitPending"], undefined, "flag consumed even on the fallback path");
});

test("#5519 flag is consumed without relayout when the child already has live marks", () => {
    const s = fakeSession();
    s.metadata["cacheMarkLadderInitPending"] = true;
    s.metadata["anthropicCacheMarkIds"] = ["q1"];
    // boot-reconcile retry shape: the session already served requests under its
    // own identity — q1 is live at the head, its ladder must not be torn down
    const history = [{ id: "q1" }, ...ids(12)];
    const marks = computeAnthropicMessageMarks(history, 0, s);
    assert.deepEqual([...marks.keys()], ["q1", "p11"], "existing ladder keeps its marks; only the tail advances");
    assert.equal(s.metadata["cacheMarkLadderInitPending"], undefined);
});

test("#5519 ephemeral tails stay outside the seeded ladder", () => {
    const s = fakeSession();
    s.metadata["cacheMarkLadderInitPending"] = true;
    const marks = computeAnthropicMessageMarks([...ids(13), { id: "t1" }, { id: "t2" }], 2, s);
    assert.deepEqual([...marks.keys()], ["p3", "p6", "p12"], "anchors computed over the STABLE region only");
    assert.equal(marks.has("t1"), false);
    assert.equal(marks.has("t2"), false);
});
