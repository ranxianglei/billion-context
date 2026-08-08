import { test } from "node:test";
import assert from "node:assert/strict";
import { reapOrphanBlocks } from "../src/orphan-gc.ts";
import { deactivateBlock, createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

function makeSession(): Session {
    return {
        id: `test-${Math.random().toString(36).slice(2)}`,
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        requests: 0,
        tokensSaved: 0,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

/** Build a visible context where a block's effectiveMessageIds are absent. */
function sessionWithOrphanBlock(): { session: Session; orphanBlockId: string } {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    // 12 messages, compress m00001-m00007 (all distinct content).
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({
            id: `h_distinct${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `message ${i} ${"x".repeat(2000)}`,
        });
    }
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
    return { session, orphanBlockId: block.blockId };
}

test("reapOrphanBlocks: active block with hits is never reaped", () => {
    const { session, orphanBlockId } = sessionWithOrphanBlock();
    // Build a visible context that still CONTAINS the effective ids. We need
    // the post-fold messages (which carry the original ids for non-covered
    // messages). Simplest: reuse a fresh context where those ids appear.
    const visible: CoreMessage[] = [];
    for (let i = 0; i < 12; i++) {
        visible.push({ id: `h_distinct${i}`, role: "user", contentType: "text", text: `x${i}` });
    }
    for (let i = 0; i < 10; i++) {
        reapOrphanBlocks(session, visible, deactivateBlock);
    }
    const block = session.state.blocks.find((b) => b.blockId === orphanBlockId);
    assert.equal(block?.active, true, "block with present ids stays active across many turns");
});

test("reapOrphanBlocks: fully orphaned block is reaped after threshold turns", () => {
    const { session, orphanBlockId } = sessionWithOrphanBlock();
    // Visible context where NONE of the block's effective ids appear (client
    // deleted the whole summarized range).
    const visible: CoreMessage[] = [
        { id: "h_other1", role: "user", contentType: "text", text: "new content" },
        { id: "h_other2", role: "assistant", contentType: "text", text: "new reply" },
    ];
    // Below threshold: still active.
    reapOrphanBlocks(session, visible, deactivateBlock);
    reapOrphanBlocks(session, visible, deactivateBlock);
    let block = session.state.blocks.find((b) => b.blockId === orphanBlockId);
    assert.equal(block?.active, true, "still active before threshold (streak 2 < 3)");

    // 3rd consecutive orphan turn: reaped.
    const { reaped } = reapOrphanBlocks(session, visible, deactivateBlock);
    assert.ok(reaped.includes(orphanBlockId), "orphan block reaped at threshold");
    block = session.state.blocks.find((b) => b.blockId === orphanBlockId);
    assert.equal(block?.active, false, "deactivated after reap");
});

test("reapOrphanBlocks: orphan streak resets when a hit returns", () => {
    const { session, orphanBlockId } = sessionWithOrphanBlock();
    const orphanVisible: CoreMessage[] = [{ id: "h_other", role: "user", contentType: "text", text: "x" }];
    const hitVisible: CoreMessage[] = [];
    // Include at least one effective id.
    const block = session.state.blocks.find((b) => b.blockId === orphanBlockId)!;
    const anEffectiveId = block.effectiveMessageIds[0];
    hitVisible.push({ id: anEffectiveId, role: "user", contentType: "text", text: "hit" });

    // Two orphan turns (streak 2).
    reapOrphanBlocks(session, orphanVisible, deactivateBlock);
    reapOrphanBlocks(session, orphanVisible, deactivateBlock);
    // One hit turn resets streak.
    reapOrphanBlocks(session, hitVisible, deactivateBlock);
    // Two more orphan turns — should NOT reap yet (streak reset to 0, now 2).
    reapOrphanBlocks(session, orphanVisible, deactivateBlock);
    reapOrphanBlocks(session, orphanVisible, deactivateBlock);
    const b = session.state.blocks.find((b) => b.blockId === orphanBlockId);
    assert.equal(b?.active, true, "streak reset by intervening hit; not reaped");
});

test("reapOrphanBlocks: reaping also clears the blockContents cache entry", () => {
    const { session, orphanBlockId } = sessionWithOrphanBlock();
    session.blockContents.set(orphanBlockId, { one: { text: "x", count: 1 }, full: { text: "x", count: 1 } });
    const orphanVisible: CoreMessage[] = [{ id: "h_other", role: "user", contentType: "text", text: "x" }];
    reapOrphanBlocks(session, orphanVisible, deactivateBlock);
    reapOrphanBlocks(session, orphanVisible, deactivateBlock);
    reapOrphanBlocks(session, orphanVisible, deactivateBlock);
    assert.ok(!session.blockContents.has(orphanBlockId), "cache entry deleted alongside block deactivation");
});
