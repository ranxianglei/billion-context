import test from "node:test";
import assert from "node:assert/strict";
import { planForkAdoption } from "../src/fork-adoption.ts";
import type { Session } from "../src/session.ts";

/**
 * #1486 unit pin for planForkAdoption's seedAllRefs semantics. The e2e resume
 * scenario (resume-ref-inheritance.test.ts) resends the parent transcript in
 * the same order, so fresh numbering coincides with the parent's — mutation
 * `seedAllRefs: false` survives it. These unit cases craft the hazard
 * directly: the parent assigned refs to messages the resumed client does NOT
 * resend (folded originals, pruned tool noise). Without seeding the refs of
 * every PRESENT message, the seeded prefix ends at the block edge and the
 * child cursor restarts below the parent's max — surviving messages get
 * renumbered and the model's stale citations (it cites any ref it has ever
 * seen) resolve to the wrong messages.
 */

type MinimalSession = { state: { blocks: unknown[]; messageRefs: Record<string, Record<string, string>>; tokenSnapshot?: Record<string, number> } };

function fakeParent(): Session {
    const byRaw: Record<string, string> = {
        raw1: "m00001", raw2: "m00002", raw3: "m00003", raw4: "m00004",
        raw5: "m00005", raw6: "m00006", raw7: "m00007", raw8: "m00008",
    };
    const byRef: Record<string, string> = {};
    for (const [raw, ref] of Object.entries(byRaw)) byRef[ref] = raw;
    const s: MinimalSession = {
        state: {
            blocks: [
                { blockId: "b1", active: true, effectiveMessageIds: ["raw1", "raw2", "raw3"], directBlockIds: [], compressedTokens: 900 },
            ],
            messageRefs: { byRaw, byRef },
            tokenSnapshot: {},
        },
    };
    return s as unknown as Session;
}

test("planForkAdoption seedAllRefs: present-but-uncovered refs keep their parent numbers and hold the cursor at the parent max (#1486)", () => {
    const parent = fakeParent();
    // Resumed body: the block's originals (raw1-3) ARE resent, the tail
    // (raw5-8) is resent; raw4 was pruned tool noise the client never resends
    // — a numbering hole between the block edge and the tail.
    const incoming = new Set(["raw1", "raw2", "raw3", "raw5", "raw6", "raw7", "raw8"]);
    const plan = planForkAdoption(parent, incoming, { seedAllRefs: true, includeBlocks: true });
    assert.equal(plan.refs.byRaw.raw5, "m00005", "present tail message keeps its parent ref");
    assert.equal(plan.refs.byRaw.raw8, "m00008", "last present message keeps its parent ref");
    assert.equal(plan.maxRef, "m00008", "cursor holds at the PARENT max (raw8), not at the block edge — raw4's number is never re-issued");
});

test("planForkAdoption default (no seedAllRefs) seeds only block coverage — documents the resume hazard it exists to close", () => {
    const parent = fakeParent();
    const incoming = new Set(["raw1", "raw2", "raw3", "raw5", "raw6", "raw7", "raw8"]);
    const plan = planForkAdoption(parent, incoming, { seedAllRefs: false, includeBlocks: true });
    assert.equal(plan.refs.byRaw.raw5, undefined, "present-but-uncovered ref is NOT seeded by default");
    assert.equal(plan.maxRef, "m00003", "default cursor stops at the block edge — a resumed child would renumber the tail (why maybeAdoptResume passes seedAllRefs: true)");
});
