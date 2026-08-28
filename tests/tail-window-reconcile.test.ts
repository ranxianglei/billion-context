import assert from "node:assert";
import test from "node:test";

process.env.NODE_ENV = "test";

import { PrefixAffinityResolver } from "../src/prefix-affinity.ts";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { anthropicToCore, type AnthropicRequestBody } from "acp-kernel/wire";

function user(text: string): Record<string, unknown> {
    return { role: "user", content: text };
}

// N distinct user messages (content long enough to clear MIN_CANONICAL_BYTES).
function chain(n: number, prefix = "msg"): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < n; i++) out.push(user(`${prefix} ${i} with enough substance to hash`));
    return out;
}

test("tail-window: truncated replay (drop oldest) reattaches the original session", () => {
    const r = new PrefixAffinityResolver();
    const full = chain(10);
    const a = r.resolve(full)!;
    assert.equal(a.via, "new");
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes);

    // Client keeps a fixed recent window: drops the 2 oldest, appends 1 new.
    // Incoming head (first 8) == stored tail (last 8) → tail-window reattach.
    const truncated = [...full.slice(2), user("a brand new tenth-plus turn here")];
    const b = r.resolve(truncated)!;
    assert.equal(b.sessionId, a.sessionId, "truncated replay must reattach the original session");
    assert.equal(b.via, "tail-window");
    assert.equal(b.matchedDepth, 8, "window is capped at TAIL_WINDOW=8");
    assert.equal(b.storedDepth, 10);
    assert.equal(b.incomingDepth, 9);
});

test("tail-window: append-only continuation still resolves via prefix (regression)", () => {
    const r = new PrefixAffinityResolver();
    const base = chain(4);
    const a = r.resolve(base)!;
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes);
    const b = r.resolve([...base, user("an appended continuation turn")])!;
    assert.equal(b.sessionId, a.sessionId);
    assert.equal(b.via, "prefix", "a true prefix extension must not be misread as a tail reattach");
    assert.equal(b.matchedDepth, 4);
});

test("tail-window: brand-new conversation resolves via new (regression)", () => {
    const r = new PrefixAffinityResolver();
    const a = r.resolve(chain(3, "alpha"))!;
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes);
    const b = r.resolve(chain(3, "beta"))!;
    assert.equal(b.via, "new");
    assert.equal(b.matchedDepth, 0);
    assert.notEqual(b.sessionId, a.sessionId);
});

test("fork lineage: divergent continuation records forked lineage (UI/debug only)", () => {
    const r = new PrefixAffinityResolver();
    const shared = chain(4, "shared");
    const a = r.resolve(shared)!;
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes);

    // Replace the 4th item: shares a 3-item prefix, diverges at item 4.
    const divergent = [...shared.slice(0, 3), user("a divergent fourth turn here")];
    const b = r.resolve(divergent)!;
    assert.equal(b.via, "new", "a divergence must not steal the stored chain");
    assert.notEqual(b.sessionId, a.sessionId);
    assert.equal(b.lineage?.reason, "forked");
    assert.deepEqual(b.lineage?.parents, [a.sessionId]);
    assert.equal(b.lineage?.sharedPrefix, 3);
});

test("truncated lineage: ambiguous multi-candidate records truncated lineage", () => {
    const r = new PrefixAffinityResolver();
    // Two tracked chains that share the same trailing 8 items but differ in
    // their oldest items. A truncated replay whose head == that shared tail is
    // ambiguous → new session with a "truncated" lineage naming both parents.
    const tail = chain(8, "common-tail");
    const aFull = [...chain(2, "branch-a-head"), ...tail];
    const bFull = [...chain(2, "branch-b-head"), ...tail];
    const a = r.resolve(aFull)!;
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes);
    const b = r.resolve(bFull)!;
    r.note(b.sessionId, b.incomingDepth, b.tailHash, b.itemHashes);

    const incoming = [...tail, user("a fresh turn after truncation")];
    const c = r.resolve(incoming)!;
    assert.equal(c.via, "new", "an ambiguous tail match must not guess a parent");
    assert.equal(c.lineage?.reason, "truncated");
    assert.ok(c.lineage?.parents.includes(a.sessionId));
    assert.ok(c.lineage?.parents.includes(b.sessionId));
});

// Kernel reconcile anchor (#316 / PR-B): a truncated replay against
// block-bearing state must NOT throw, must deactivate the affected block
// gracefully (active → false), and must revive it (survivedCount++) when the
// full history returns. This is what makes tail-window reattach safe with zero
// kernel changes.
test("kernel reconcile: truncated replay deactivates blocks, full replay revives them (no throw)", () => {
    const core = createCore();
    const config = defaultConfig(200000);
    const state = createInitialState();
    const body: AnthropicRequestBody = { model: "claude-test", messages: [] };
    for (let i = 0; i < 40; i++) body.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i} ${"y".repeat(500)}` });
    const { msgs } = anthropicToCore(body);
    const turn = core.processTurn({ messages: msgs, state, config, tokenCount: 9999, renderTags: "text-only" });
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00015", summary: "early history summary long enough to pass min length check".repeat(3) }],
        state: turn.state, config, messages: turn.messages,
    });
    let st = res.state;
    const block = st.blocks[0];
    assert.ok(block, "a compression block should exist");
    assert.equal(block.active, true, "block starts active");
    const survivedBefore = block.survivedCount;

    // Truncated replay: drop the 10 oldest messages (which include the covered ones).
    const truncated = core.processTurn({ messages: msgs.slice(10), state: st, config, tokenCount: 9999, renderTags: "text-only" });
    st = truncated.state;
    const deactivated = st.blocks.find((b) => b.blockId === block.blockId);
    assert.ok(deactivated, "block still present after truncation");
    assert.equal(deactivated.active, false, "block must deactivate gracefully when its messages are truncated away");

    // Full replay: the messages return → the block revives.
    const full = core.processTurn({ messages: msgs, state: st, config, tokenCount: 9999, renderTags: "text-only" });
    st = full.state;
    const revived = st.blocks.find((b) => b.blockId === block.blockId);
    assert.ok(revived, "block still present after full replay");
    assert.equal(revived.active, true, "block must revive when its messages return");
    assert.equal(revived.survivedCount, survivedBefore + 1, "survivedCount must increment on revival");
});
