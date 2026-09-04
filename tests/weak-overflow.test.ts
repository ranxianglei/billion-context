import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { noteWeakOverflow, resetWeakOverflow } from "../src/weak-overflow.ts";
import type { Session } from "../src/session.ts";

const ids: string[] = [];

function makeSession(window: number, learned?: number): Session {
    const metadata: Record<string, unknown> = { effectiveContextLimit: window };
    if (learned !== undefined) metadata.learnedContextLimit = learned;
    const session = {
        id: `weak-${Math.random().toString(36).slice(2, 8)}`,
        metadata,
        stats: { lastInputTokens: 0 },
    } as unknown as Session;
    ids.push(session.id);
    return session;
}

beforeEach(() => {
    for (const id of ids) resetWeakOverflow(id);
    ids.length = 0;
});

test("low usage is ignored entirely", () => {
    const session = makeSession(100000);
    for (let i = 0; i < 10; i++) noteWeakOverflow(session, { inputTokens: 50000, reason: "test" });
    assert.equal(session.metadata.learnedContextLimit, undefined);
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 0);
});

test("three high-usage events learn a conservative window and arm emergency", () => {
    const session = makeSession(100000);
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r1" });
    noteWeakOverflow(session, { inputTokens: 96000, reason: "r2" });
    assert.equal(session.metadata.learnedContextLimit, undefined, "not before the 3rd event");
    noteWeakOverflow(session, { inputTokens: 97000, reason: "r3" });
    assert.equal(session.metadata.learnedContextLimit, 97000, "learns the LAST failing input size");
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 97000, "emergency shrink armed");
});

test("model-scoped learning lands in learnedContextLimits", () => {
    const session = makeSession(100000);
    noteWeakOverflow(session, { inputTokens: 95000, model: "qwen", reason: "r1" });
    noteWeakOverflow(session, { inputTokens: 95000, model: "qwen", reason: "r2" });
    noteWeakOverflow(session, { inputTokens: 95000, model: "qwen", reason: "r3" });
    assert.deepEqual(session.metadata.learnedContextLimits, { qwen: 95000 });
    assert.equal(session.metadata.learnedContextLimit, undefined);
});

test("shrink-only: never grows a previously learned smaller window", () => {
    const session = makeSession(100000, 50000);
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r1" });
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r2" });
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r3" });
    assert.equal(session.metadata.learnedContextLimit, 50000, "smaller learned value wins");
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 95000, "emergency shrink still armed");
});

test("events older than the window do not accumulate", () => {
    const session = makeSession(100000);
    const realNow = Date.now;
    let t = realNow();
    Date.now = () => t;
    try {
        noteWeakOverflow(session, { inputTokens: 95000, reason: "r1" });
        t += 16 * 60 * 1000;
        noteWeakOverflow(session, { inputTokens: 95000, reason: "r2" });
        t += 1000;
        noteWeakOverflow(session, { inputTokens: 95000, reason: "r3" });
        assert.equal(session.metadata.learnedContextLimit, undefined, "only r2+r3 are in the window — 2 < 3");
    } finally {
        Date.now = realNow;
    }
});

test("unknown window disables the signal", () => {
    const session = makeSession(0);
    noteWeakOverflow(session, { inputTokens: 95000, reason: "r" });
    assert.equal(session.metadata.learnedContextLimit, undefined);
    assert.equal((session.stats as { lastInputTokens: number }).lastInputTokens, 0);
});

test("falls back to lastInputTokens when inputTokens is absent", () => {
    const session = makeSession(100000);
    (session.stats as { lastInputTokens: number }).lastInputTokens = 92000;
    noteWeakOverflow(session, { reason: "r1" });
    noteWeakOverflow(session, { reason: "r2" });
    noteWeakOverflow(session, { reason: "r3" });
    assert.equal(session.metadata.learnedContextLimit, 92000);
});
