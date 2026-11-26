import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { CoreMessage } from "acp-kernel";
import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { _setStoreForTest } from "../src/persist.ts";
import { reconcilePluginFoldCallIds, isPluginFoldCallId } from "../src/plugin.ts";

// #7497: reconcilePluginFoldCallIds must recognize LINE-FORMAT compress args
// (content is a plain string "m00150–m0220 topic\n<summary>…"), not just the
// JSON shape ({content:[{startId,endId}]}). Before the fix, line-format calls
// fell through to the flat {startId,endId} branch, matched nothing, and the
// plugin_ block's compressCallId was never reconciled to the real client id —
// so the kernel judged the re-sent carrier an orphan and could sweep it.

_setStoreForTest(new (await import("../src/persist.ts")).SessionStore({ enabled: false }));

function makeSession(): Session {
    return {
        id: `issue7497-${randomUUID()}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
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

function makeBlock(blockId: string, startRef: string, endRef: string, compressCallId: string) {
    return {
        blockId,
        runId: `run_${blockId}`,
        tier: 1 as const,
        summary: "summary",
        directMessageIds: [],
        effectiveMessageIds: [],
        directBlockIds: [],
        compressedTokens: 1000,
        createdAt: Date.now(),
        survivedCount: 0,
        generation: "young" as const,
        active: true,
        compressCallId,
        startRef,
        endRef,
    };
}

function toolCall(id: string, text: string): CoreMessage {
    return { id: `tc_${id}`, role: "assistant", contentType: "tool-call", toolCallId: id, toolName: "compress", text };
}

function toolResult(id: string, text: string): CoreMessage {
    return { id: `tr_${id}`, role: "tool", contentType: "tool-result", toolCallId: id, text };
}

test("#7497: line-format compress call reconciles plugin_ block to real client id", () => {
    const session = makeSession();
    // A plugin_ block (legacy synthetic id) covering m00150–m00220.
    const block = makeBlock("b1", "m00150", "m00220", "plugin_fold_1");
    session.state.blocks.push(block);
    assert.ok(isPluginFoldCallId(block.compressCallId));

    // The client re-sends the compress call in LINE FORMAT:
    // content is a plain string "m00150–m0220 topic\n<summary>…".
    const lineFormatArgs = JSON.stringify({
        content: "m00150–m00220 task setup\nsummary line one\nsummary line two",
    });
    const messages: CoreMessage[] = [
        toolCall("call_123", lineFormatArgs),
        toolResult("call_123", "[Compressed 1 range]\n · b1 full summary (m00150–m00220): task setup"),
    ];

    const changed = reconcilePluginFoldCallIds(session, messages);
    assert.equal(changed, 1);
    assert.equal(block.compressCallId, "call_123");
    assert.ok(!isPluginFoldCallId(block.compressCallId));
});

test("#7497: JSON-format compress call still reconciles (regression guard)", () => {
    const session = makeSession();
    const block = makeBlock("b1", "m00150", "m00220", "plugin_fold_1");
    session.state.blocks.push(block);

    // JSON format: content is an array of {startId, endId} objects.
    const jsonArgs = JSON.stringify({
        content: [{ startId: "m00150", endId: "m00220", summary: "task setup" }],
    });
    const messages: CoreMessage[] = [
        toolCall("call_456", jsonArgs),
        toolResult("call_456", "[Compressed 1 range]\n · b1 full summary (m00150–m00220): task setup"),
    ];

    const changed = reconcilePluginFoldCallIds(session, messages);
    assert.equal(changed, 1);
    assert.equal(block.compressCallId, "call_456");
});

test("#7497: line-format call with no matching block does not reconcile", () => {
    const session = makeSession();
    // Block covers m00300–m00400, but the call references m00150–m00220.
    const block = makeBlock("b1", "m00300", "m00400", "plugin_fold_1");
    session.state.blocks.push(block);

    const lineFormatArgs = JSON.stringify({
        content: "m00150–m00220 task setup\nsummary",
    });
    const messages: CoreMessage[] = [
        toolCall("call_789", lineFormatArgs),
        toolResult("call_789", "[Compressed 1 range]\n · b1 full summary (m00150–m00220): task setup"),
    ];

    const changed = reconcilePluginFoldCallIds(session, messages);
    assert.equal(changed, 0);
    assert.equal(block.compressCallId, "plugin_fold_1");
});

test("#7497: line-format call with m-refs not padded to 5 digits still matches", () => {
    const session = makeSession();
    // Block covers m00150–m00220 (padded).
    const block = makeBlock("b1", "m00150", "m00220", "plugin_fold_1");
    session.state.blocks.push(block);

    // Line-format call uses unpadded refs: "m150–m220".
    const lineFormatArgs = JSON.stringify({
        content: "m150–m220 task setup\nsummary",
    });
    const messages: CoreMessage[] = [
        toolCall("call_abc", lineFormatArgs),
        toolResult("call_abc", "[Compressed 1 range]\n · b1 full summary (m00150–m00220): task setup"),
    ];

    const changed = reconcilePluginFoldCallIds(session, messages);
    assert.equal(changed, 1);
    assert.equal(block.compressCallId, "call_abc");
});

test("#7497: line-format call with multiple range blocks extracts all ranges", () => {
    const session = makeSession();
    // Two blocks: b1 covers m00150–m00220, b2 covers m00300–m00400.
    const block1 = makeBlock("b1", "m00150", "m00220", "plugin_fold_1");
    const block2 = makeBlock("b2", "m00300", "m00400", "plugin_fold_2");
    session.state.blocks.push(block1, block2);

    // Line-format call with TWO range blocks in the content.
    const lineFormatArgs = JSON.stringify({
        content: "m00150–m00220 first task\nsummary one\nm00300–m00400 second task\nsummary two",
    });
    const messages: CoreMessage[] = [
        toolCall("call_multi", lineFormatArgs),
        toolResult("call_multi", "[Compressed 2 ranges]\n · b1 full summary (m00150–m00220): first task\n · b2 full summary (m00300–m00400): second task"),
    ];

    const changed = reconcilePluginFoldCallIds(session, messages);
    // Both blocks reconcile to the same call id.
    assert.equal(changed, 2);
    assert.equal(block1.compressCallId, "call_multi");
    assert.equal(block2.compressCallId, "call_multi");
});

test("#7497: non-plugin block is not reconciled (regression guard)", () => {
    const session = makeSession();
    // Block with a real client id (not plugin_).
    const block = makeBlock("b1", "m00150", "m00220", "call_real");
    session.state.blocks.push(block);

    const lineFormatArgs = JSON.stringify({
        content: "m00150–m00220 task setup\nsummary",
    });
    const messages: CoreMessage[] = [
        toolCall("call_other", lineFormatArgs),
        toolResult("call_other", "[Compressed 1 range]\n · b1 full summary (m00150–m00220): task setup"),
    ];

    const changed = reconcilePluginFoldCallIds(session, messages);
    // Non-plugin blocks are not reconciled.
    assert.equal(changed, 0);
    assert.equal(block.compressCallId, "call_real");
});
