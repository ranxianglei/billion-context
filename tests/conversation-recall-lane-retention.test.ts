import assert from "node:assert/strict";
import test from "node:test";

import {
    __resetConversationRecallForTests,
    conversationRecallStats,
    learnConversation,
    recallConversation,
} from "../src/agent/conversation-recall.ts";

test("lane eviction keeps a recent session even when its lane also has an older sibling", (t) => {
    __resetConversationRecallForTests();
    t.after(__resetConversationRecallForTests);
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    learnConversation("active-lane", "old-sibling", "old-boundary");
    for (let i = 0; i < 63; i++) {
        now++;
        learnConversation(`idle-lane-${i}`, `idle-${i}`, `idle-boundary-${i}`);
    }
    now++;
    learnConversation("active-lane", "recent-session", "recent-boundary");
    now++;
    learnConversation("new-lane", "new-session", "new-boundary");

    assert.equal(recallConversation("active-lane", new Set(["recent-boundary"])), "recent-session");
    assert.equal(recallConversation("idle-lane-0", new Set(["idle-boundary-0"])), undefined);
    assert.equal(recallConversation("new-lane", new Set(["new-boundary"])), "new-session");
    assert.equal(conversationRecallStats().lanes, 64);
});

test("record-only traffic leaves at most 64 remembered lanes", (t) => {
    __resetConversationRecallForTests();
    t.after(__resetConversationRecallForTests);
    let now = 1_000;
    t.mock.method(Date, "now", () => now++);
    for (let i = 0; i < 100; i++) {
        learnConversation(`lane-${i}`, `session-${i}`, `boundary-${i}`);
        assert.ok(conversationRecallStats().lanes <= 64);
    }
    assert.equal(recallConversation("lane-99", new Set(["boundary-99"])), "session-99");
    assert.equal(recallConversation("lane-0", new Set(["boundary-0"])), undefined);
});

test("a successful recall refreshes the activity of its entire lane", (t) => {
    __resetConversationRecallForTests();
    t.after(__resetConversationRecallForTests);
    let now = 1_000;
    t.mock.method(Date, "now", () => now++);
    learnConversation("active-lane", "old-sibling", "old-boundary");
    learnConversation("active-lane", "recent-session", "recent-boundary");
    for (let i = 0; i < 63; i++) learnConversation(`idle-lane-${i}`, `idle-${i}`, `idle-boundary-${i}`);
    assert.equal(recallConversation("active-lane", new Set(["recent-boundary"])), "recent-session");
    learnConversation("new-lane", "new-session", "new-boundary");
    assert.equal(recallConversation("active-lane", new Set(["recent-boundary"])), "recent-session");
    assert.equal(recallConversation("idle-lane-0", new Set(["idle-boundary-0"])), undefined);
});
