/**
 * #4110 recall fingerprint degeneracy — regression stakes.
 *
 * recallFingerprintOfMessage hashed only {role, content}: on the OpenAI wire
 * every pure tool-call assistant message carries content:null, so ALL such
 * messages across ALL sessions shared ONE fingerprint. Session A learning a
 * boundary of that shape + session B's unattributed retry containing any
 * same-class message + exactly one lane hit ⇒ B was adopted into A
 * (cross-session pollution, #2438 unfold/refold damage class).
 *
 * Fix under test: tool_calls are part of the fingerprint (retries resend
 * them byte-identically, so stability holds), and messages with neither
 * content nor tool_calls (null/undefined/""/[]) are refused on BOTH sides —
 * never learned as a boundary, never matched. Both directions asserted
 * (#3617): the bug shape is refused AND legitimate recall still fires.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import {
    __resetConversationRecallForTests,
    conversationRecallStats,
    learnConversation,
    recallBoundaryOfMessages,
    recallConversation,
    recallHistoryFingerprints,
    recallLaneKey,
} from "../src/agent/conversation-recall.ts";

const LANE = recallLaneKey("https://api.anthropic.com/v1/messages");

const USER_A = { role: "user", content: "session A: investigate the flaky test" };
const USER_B = { role: "user", content: "session B: write the release notes" };

/** OpenAI wire shape: pure tool-call turn — content:null, calls attached. */
function toolCallTurn(callId: string, fnName = "get_weather", args = "{\"city\":\"sf\"}") {
    return {
        role: "assistant",
        content: null,
        tool_calls: [{ id: callId, type: "function", function: { name: fnName, arguments: args } }],
    };
}

function historyFps(...msgs: unknown[]): Set<string> {
    return recallHistoryFingerprints(msgs);
}

test("issue4110: pure tool-call turns fingerprint distinctly per call id", () => {
    __resetConversationRecallForTests();
    const a1 = toolCallTurn("call_A1");
    const b1 = toolCallTurn("call_B1");
    const fpA1 = recallBoundaryOfMessages([USER_A, a1]);
    const fpB1 = recallBoundaryOfMessages([USER_B, b1]);
    assert.ok(fpA1 !== undefined, "tool-call turns carry evidence (content:null + tool_calls)");
    assert.ok(fpB1 !== undefined);
    assert.notEqual(fpA1, fpB1, "same-class messages from different sessions must NOT share a fingerprint");
    // Byte-stable: an identical resend (the retry) yields the identical fp.
    assert.equal(recallBoundaryOfMessages([USER_A, a1]), fpA1);
});

test("issue4110: cross-session mis-adoption refused — B's retry is NOT stamped into A", () => {
    __resetConversationRecallForTests();
    // Session A attributed dispatch: history ends in a pure tool-call turn.
    const boundaryA = recallBoundaryOfMessages([USER_A, toolCallTurn("call_A1")]);
    assert.ok(boundaryA !== undefined);
    learnConversation(LANE, "sess-A", boundaryA);

    // Session B, attribution lost (plugin reload): its retry history contains
    // its OWN same-class tool-call turn — pre-#4110 this hit A's degenerate
    // boundary with exactly 1 lane hit and adopted B into A. Now: no hit.
    const bRetry = historyFps(USER_B, { role: "assistant", content: "B's own text turn" }, toolCallTurn("call_B1"));
    assert.equal(recallConversation(LANE, bRetry), undefined, "same-class message from another session must not match");
    assert.equal(conversationRecallStats().rejectedNoBoundary, 1);

    // Positive control on the same lane: A's own retry (byte-identical
    // tool-call history) is still claimed — the feature is not disabled.
    assert.equal(recallConversation(LANE, historyFps(USER_A, toolCallTurn("call_A1"))), "sess-A");
});

test("issue4110: degenerate messages (no content AND no tool_calls) fingerprint nowhere", () => {
    __resetConversationRecallForTests();
    for (const content of [null, undefined, "", []]) {
        const m = { role: "assistant", content };
        assert.equal(recallHistoryFingerprints([m]).size, 0, `content ${String(content)} without tool_calls carries no evidence`);
    }
    // All-degenerate history has no boundary at all — nothing to learn.
    assert.equal(recallBoundaryOfMessages([{ role: "assistant", content: null }]), undefined);
});

test("issue4110: degenerate trailing message is not learned as a boundary (walk-back)", () => {
    __resetConversationRecallForTests();
    // A dispatch whose LAST message is degenerate: the boundary falls back to
    // the last message that proves something — the degenerate tail never
    // enters the table.
    const boundary = recallBoundaryOfMessages([USER_A, { role: "assistant", content: null }]);
    const userFp = recallBoundaryOfMessages([USER_A]);
    assert.ok(boundary !== undefined && userFp !== undefined);
    assert.equal(boundary, userFp, "degenerate tail is skipped, the last real message is the boundary");

    learnConversation(LANE, "sess-A", boundary);
    // Session B's history containing its own degenerate assistant turn
    // (pre-#4110 identical fingerprint to A's learned boundary) cannot hit.
    const bHistory = historyFps(USER_B, { role: "assistant", content: null });
    assert.equal(recallConversation(LANE, bHistory), undefined, "degenerate messages match nothing");
    // Positive control: A's own retry containing USER_A still recalls.
    assert.equal(recallConversation(LANE, historyFps(USER_A)), "sess-A");
});
