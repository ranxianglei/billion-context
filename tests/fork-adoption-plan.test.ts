import test from "node:test";
import assert from "node:assert/strict";
import { BLOCKED_REF, createInitialState, syncBlocks, type CompressionBlock, type CoreMessage } from "acp-kernel";
import { planForkAdoption, applyForkAdoption } from "../src/fork-adoption.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
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

test("resume adoption never writes the kernel BLOCKED sentinel into byRef (#2620)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const parent = {
        state: {
            blocks: [] as unknown[],
            tokenSnapshot: {} as Record<string, number>,
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw: { p1: BLOCKED_REF, p2: BLOCKED_REF, r1: "m00001" }, byRef: { m00001: "r1" } },
        },
    } as unknown as Session;
    const child = {
        state: {
            blocks: [] as unknown[],
            tokenSnapshot: {} as Record<string, number>,
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw: {} as Record<string, string>, byRef: {} as Record<string, string> },
        },
        blockContents: new Map(),
    } as unknown as Session;
    const plan = planForkAdoption(parent, new Set(["p1", "p2", "r1"]), { seedAllRefs: true, includeBlocks: false });
    assert.equal(plan.refs.byRaw.p1, BLOCKED_REF, "plan carries the sentinel in byRaw");
    assert.equal(plan.refs.byRef[BLOCKED_REF], undefined, "plan builder already excludes the sentinel from byRef");
    applyForkAdoption(child, plan, parent);
    assert.equal(child.state.messageRefs.byRaw.p1, BLOCKED_REF);
    assert.equal(child.state.messageRefs.byRef["m00001"], "r1");
    assert.equal(child.state.messageRefs.byRef[BLOCKED_REF], undefined, "applier must not reintroduce byRef[BLOCKED]");
});

function retainedParent(blocks: CompressionBlock[]): Session {
    return {
        state: { ...createInitialState(), blocks },
        blockContents: new Map(),
    } as Session;
}

function retainedBlock(blockId = "b1"): CompressionBlock {
    return {
        blockId, runId: "r1", tier: 1, summary: "saved summary",
        directMessageIds: ["raw1", "raw2"], effectiveMessageIds: ["raw1", "raw2"],
        directBlockIds: [], compressedTokens: 2000, createdAt: 1,
        survivedCount: 0, generation: "young", active: true,
    };
}

const returningPrefix: CoreMessage[] = [
    { id: "raw1", role: "user", contentType: "text", text: "question" },
    { id: "raw2", role: "assistant", contentType: "text", text: "answer" },
];

test("fork adoption restores fully present folds deactivated by the parent's last short view", () => {
    const parent = retainedParent([retainedBlock()]);
    parent.state = syncBlocks([{ id: "side", role: "user", contentType: "text", text: "short view" }], parent.state).state;
    assert.equal(parent.state.blocks[0].active, false);
    const before = structuredClone(parent.state);
    assert.equal(syncBlocks(returningPrefix, parent.state).state.blocks[0].active, true, "ordinary replay already recovers this retained fold");
    const plan = planForkAdoption(parent, new Set(returningPrefix.map(m => m.id)));
    assert.equal(plan.adoptedActive, 1, "fork replay must recover the same fully present fold");
    assert.equal(plan.blocks[0].active, true);
    assert.equal(plan.adoptedTokens, 2000);
    assert.deepEqual(parent.state, before, "planning never changes the source session");
    plan.blocks[0].effectiveMessageIds.push("child-only");
    assert.deepEqual(parent.state, before, "the restored block is independently owned");
});

test("fork recovery preserves expanded, consumed, missing and blocks-disabled exclusions", () => {
    const inactive = retainedBlock();
    inactive.active = false;
    const expanded = { ...retainedBlock(), active: false, expanded: true };
    assert.equal(planForkAdoption(retainedParent([expanded]), new Set(["raw1", "raw2"])).adoptedActive, 0);
    assert.equal(planForkAdoption(retainedParent([inactive]), new Set(["raw1"])).adoptedActive, 0);
    assert.equal(planForkAdoption(retainedParent([inactive]), new Set(["unrelated"])).adoptedActive, 0);
    assert.equal(planForkAdoption(retainedParent([inactive]), new Set(["raw1", "raw2"]), { includeBlocks: false }).adoptedActive, 0);
    const tier = { ...retainedBlock("b2"), tier: 2 as const, directBlockIds: ["b1"], active: false };
    const plan = planForkAdoption(retainedParent([inactive, tier]), new Set(["raw1", "raw2"]));
    assert.equal(plan.adoptedActive, 1, "a recovered tier fold consumes its retained child");
    assert.equal(plan.blocks.find(b => b.blockId === "b1")?.active, false);
    assert.equal(plan.blocks.find(b => b.blockId === "b2")?.active, true);
});

test("fork adoption deep-copies adopted blocks: mutating the child never leaks into the source", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const parent = retainedParent([retainedBlock()]);
    parent.state = syncBlocks([{ id: "side", role: "user", contentType: "text", text: "short view" }], parent.state).state;
    const child = { state: createInitialState(), blockContents: new Map() } as unknown as Session;
    const plan = planForkAdoption(parent, new Set(["raw1", "raw2"]));
    applyForkAdoption(child, plan, parent);
    assert.equal(child.state.blocks.length, 1);
    assert.equal(child.state.blocks[0].active, true);
    child.state.blocks[0].summary = "MUTATED";
    child.state.blocks[0].directMessageIds.push("leak");
    assert.equal(parent.state.blocks[0].summary, "saved summary", "mutating the adopted child must not touch the source summary");
    assert.deepEqual(parent.state.blocks[0].directMessageIds, ["raw1", "raw2"], "mutating the adopted child must not touch the source ids");
});

test("fork recovery counts incomplete spans as straddled even while inactive in the source", () => {
    const inactive = retainedBlock();
    inactive.active = false;
    const plan = planForkAdoption(retainedParent([inactive]), new Set(["raw1"]));
    assert.equal(plan.adoptedActive, 0);
    assert.equal(plan.straddled, 1, "a partial span is straddled whether or not the source's last view deactivated it");
});

test("fork adoption carries the covered refs of adopted folds into the child numbering", () => {
    const parent = retainedParent([retainedBlock()]);
    parent.state.messageRefs.byRaw.raw1 = "m00001";
    parent.state.messageRefs.byRaw.raw2 = "m00002";
    parent.state.messageRefs.byRef["m00001"] = "raw1";
    parent.state.messageRefs.byRef["m00002"] = "raw2";
    const plan = planForkAdoption(parent, new Set(["raw1", "raw2"]));
    assert.equal(plan.refs.byRaw.raw1, "m00001", "covered ref rides along with its fold");
    assert.equal(plan.refs.byRaw.raw2, "m00002");
    assert.equal(plan.refs.byRef["m00001"], "raw1");
});
