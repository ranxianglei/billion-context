/**
 * #4082 negotiated conversation recall — unit stakes for the recall table.
 *
 * The table is the fallback identity for dispatches whose host attribution
 * is missing (dsh retries / model switches / post-resume resends): while
 * attribution works we learn lane → (sid, boundary), and a later
 * unattributed dispatch whose history CONTAINS a remembered boundary is
 * provably that session's continuation. See src/agent/conversation-recall.ts.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import {
    __ageConversationRecallForTests,
    __resetConversationRecallForTests,
    conversationRecallStats,
    learnConversation,
    recallBoundaryOfMessages,
    recallConversation,
    recallHistoryFingerprints,
    recallLaneKey,
} from "../src/agent/conversation-recall.ts";

const MSG_A = { role: "user", content: "first question about the failed build" };
const MSG_B = { role: "assistant", content: "the root cause is a stale dist" };
const MSG_C = { role: "user", content: "ok, rebuild and rerun the tests" };

function historyFps(...msgs: unknown[]): Set<string> {
    return recallHistoryFingerprints(msgs);
}

test("recall: a continuation containing the learned boundary is claimed uniquely", () => {
    __resetConversationRecallForTests();
    const lane = recallLaneKey("https://api.example.com/v1/messages");
    const boundary = recallBoundaryOfMessages([MSG_A, MSG_B]);
    assert.ok(boundary !== undefined);
    learnConversation(lane, "sess-1", boundary);

    // Same body resent (retry) — contains the boundary.
    assert.equal(recallConversation(lane, historyFps(MSG_A, MSG_B)), "sess-1");
    // Continuation with one more message — still contains it.
    assert.equal(recallConversation(lane, historyFps(MSG_A, MSG_B, MSG_C)), "sess-1");
    const stats = conversationRecallStats();
    assert.equal(stats.recalled, 2);
});

test("recall: model switch keeps the lane (history unchanged), fork divergence misses", () => {
    __resetConversationRecallForTests();
    // The lane key must NOT include the model: #3918 is a switch-model retry
    // on the same endpoint + key with the identical history.
    const l1 = recallLaneKey("https://api.example.com/v1/messages");
    const l2 = recallLaneKey("https://api.example.com/v1/messages?x=1");
    assert.equal(l1, l2, "query noise must not split the lane");

    const boundary = recallBoundaryOfMessages([MSG_A, MSG_B]);
    assert.ok(boundary !== undefined);
    learnConversation(l1, "sess-1", boundary);

    // Fork diverging after the shared prefix: its history does NOT contain
    // the parent's latest boundary (MSG_B) — a different story is told.
    const FORK_MSG = { role: "user", content: "actually, take a different approach entirely" };
    assert.equal(recallConversation(l1, historyFps(MSG_A, FORK_MSG)), undefined);
    assert.equal(conversationRecallStats().rejectedNoBoundary, 1);
});

test("recall: two sessions on one lane disambiguate by boundary, ambiguity refuses", () => {
    __resetConversationRecallForTests();
    const lane = recallLaneKey("https://api.example.com/v1/messages");
    const b1 = recallBoundaryOfMessages([MSG_A, MSG_B]);
    const b2 = recallBoundaryOfMessages([MSG_C]);
    assert.ok(b1 !== undefined && b2 !== undefined);
    learnConversation(lane, "sess-1", b1);
    learnConversation(lane, "sess-2", b2);

    assert.equal(recallConversation(lane, historyFps(MSG_A, MSG_B)), "sess-1");
    assert.equal(recallConversation(lane, historyFps(MSG_C)), "sess-2");

    // If BOTH boundaries appear (an interleaved body that merged two
    // conversations) the claim is ambiguous — refuse rather than guess.
    assert.equal(recallConversation(lane, historyFps(MSG_A, MSG_B, MSG_C)), undefined);
});

test("recall: unknown lane and TTL expiry keep today's direct-send behavior", () => {
    __resetConversationRecallForTests();
    const lane = recallLaneKey("https://api.example.com/v1/messages");
    assert.equal(recallConversation("https://other.example.com/api", historyFps(MSG_A)), undefined);
    assert.equal(conversationRecallStats().rejectedNoLane, 1);

    const boundary = recallBoundaryOfMessages([MSG_A, MSG_B]);
    assert.ok(boundary !== undefined);
    learnConversation(lane, "sess-1", boundary);
    __ageConversationRecallForTests(11 * 60_000);
    assert.equal(recallConversation(lane, historyFps(MSG_A, MSG_B)), undefined);
    assert.ok(conversationRecallStats().expired >= 1);
});

test("recall: per-lane LRU cap evicts the idle session, not the active one", () => {
    __resetConversationRecallForTests();
    const lane = recallLaneKey("https://api.example.com/v1/messages");
    const b1 = recallBoundaryOfMessages([MSG_A, MSG_B]);
    assert.ok(b1 !== undefined);
    learnConversation(lane, "sess-1", b1);
    // Fill the lane past the cap with distinct sessions.
    for (let i = 2; i <= 10; i++) {
        const b = recallBoundaryOfMessages([{ role: "user", content: `filler number ${i}` }]);
        assert.ok(b !== undefined);
        learnConversation(lane, `sess-${i}`, b);
    }
    // sess-1 was evicted (idle oldest); the freshest filler survives.
    assert.equal(recallConversation(lane, historyFps(MSG_A, MSG_B)), undefined);
    assert.equal(recallConversation(lane, historyFps({ role: "user", content: "filler number 10" })), "sess-10");
});
