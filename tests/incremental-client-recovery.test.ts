// #3369 — incremental-turn client recovery semantics. One 409 must reset the
// conversation (next turn re-seeds with resync:true, which can never 409);
// only a streak of consecutive 409s with no ack between trips the sticky kill
// switch. 503 handling lives in the adapters (state untouched, probe cache
// dropped) — see omp-native-incremental.test.ts for the seam wiring.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_TEST_CONTEXT = "1";

const { __resetIncrementalClientForTests, noteIncrementalAck, noteIncrementalRejection, planIncrementalTurn } = await import("../src/agent/incremental-client.ts");

const SID = "inc-recovery-1";

function msgs(n: number): { role: string; content: string }[] {
    return Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));
}

test("#3369: one 409 resets — the next plan re-seeds with resync:true (full set, sinceSeq 0)", () => {
    __resetIncrementalClientForTests();
    noteIncrementalAck(SID, 3, msgs(3), undefined);
    const delta = planIncrementalTurn({ conversationId: SID, messages: msgs(5), system: undefined });
    assert.equal(delta.mode, "delta");

    const verdict = noteIncrementalRejection(SID);
    assert.equal(verdict, "reset", "first 409 is transient drift");
    const next = planIncrementalTurn({ conversationId: SID, messages: msgs(5), system: undefined });
    // "seed" and "resync" build the identical wire body (resync:true full set);
    // after a reset the state is gone, so the next plan is a fresh seed.
    assert.ok(next.mode === "seed" || next.mode === "resync", "re-seed after drift");
    if (next.mode === "seed" || next.mode === "resync") {
        const body = JSON.parse(next.body) as Record<string, unknown>;
        assert.equal(body.resync, true);
        assert.equal(body.sinceSeq, 0);
        assert.equal((body.messages as unknown[]).length, 5, "full history, not a delta");
    }
});

test("#3369: three consecutive 409s (no ack between) trip the sticky kill switch", () => {
    __resetIncrementalClientForTests();
    noteIncrementalAck(SID, 1, msgs(1), undefined);
    assert.equal(noteIncrementalRejection(SID), "reset");
    assert.equal(noteIncrementalRejection(SID), "reset");
    assert.equal(noteIncrementalRejection(SID), "dead", "circuit trips on the third consecutive rejection");
    assert.equal(planIncrementalTurn({ conversationId: SID, messages: msgs(3), system: undefined }).mode, "skip");
});

test("#3369: an ack clears the rejection circuit", () => {
    __resetIncrementalClientForTests();
    noteIncrementalAck(SID, 1, msgs(1), undefined);
    assert.equal(noteIncrementalRejection(SID), "reset");
    assert.equal(noteIncrementalRejection(SID), "reset");
    // recovery: the re-seed landed and was acked
    noteIncrementalAck(SID, 5, msgs(5), undefined);
    assert.equal(noteIncrementalRejection(SID), "reset", "circuit restarted from zero after the ack");
    assert.equal(noteIncrementalRejection(SID), "reset");
    assert.equal(noteIncrementalRejection(SID), "dead", "third consecutive rejection after exactly one ack still trips");
});

test("#3369: rejection with no prior state is a no-op reset (a seed/resync cannot 409)", () => {
    __resetIncrementalClientForTests();
    assert.equal(noteIncrementalRejection(SID), "reset");
    const next = planIncrementalTurn({ conversationId: SID, messages: msgs(2), system: undefined });
    assert.equal(next.mode, "seed");
});
