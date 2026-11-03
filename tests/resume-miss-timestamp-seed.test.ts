import test from "node:test";
import assert from "node:assert/strict";
import { BLOCKED_REF } from "acp-kernel";
import { planForkAdoption, applyForkAdoption, seedTimestampsFromParent } from "../src/fork-adoption.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { Session } from "../src/session.ts";

/**
 * #5608/#4313 regression pins for the timestamp-ledger carry. A stamp is keyed
 * by raw id (SHA-256 of message identity) and renders into the ACP tag's
 * time= attribute — cache-relevant bytes. Two paths used to drop them:
 *  1. resume/fork ADOPTION seeded refs/blocks/latches but never tsStamps, so
 *     the first replay rendered time-less tags where the original process
 *     rendered time-stamped ones (byte flip at every tagged message);
 *  2. a resume-inheritance MISS starts fresh state, so the stamp node minted
 *     "now" for days-old history (the 1–12% one-generation cache collapse in
 *     #5608, shapes B/C).
 * Both now ride seedTimestampsFromParent.
 */

type MinimalSession = { state: { tsStamps?: Record<string, number> } };

function freshChild(): Session {
    return { state: {} } as unknown as Session;
}

test("seedTimestampsFromParent: empty child inherits the whole parent ledger", () => {
    const parent = { state: { tsStamps: { rawA: 1000, rawB: 2000 } } } as unknown as Session;
    const child = freshChild();
    const n = seedTimestampsFromParent(child, parent);
    assert.equal(n, 2);
    assert.deepEqual((child.state as MinimalSession["state"]).tsStamps, { rawA: 1000, rawB: 2000 });
});

test("seedTimestampsFromParent: child entries win on conflict (its own first-sight beats the parent's)", () => {
    const parent = { state: { tsStamps: { rawA: 1000, rawC: 3000 } } } as unknown as Session;
    const child = { state: { tsStamps: { rawA: 4242 } } } as unknown as Session;
    const n = seedTimestampsFromParent(child, parent);
    assert.equal(n, 1, "only the absent id is seeded");
    const stamps = (child.state as MinimalSession["state"]).tsStamps!;
    assert.equal(stamps.rawA, 4242, "child value preserved");
    assert.equal(stamps.rawC, 3000);
});

test("seedTimestampsFromParent: no aliasing — child gets its own map", () => {
    const parent = { state: { tsStamps: { rawA: 1000 } } } as unknown as Session;
    const child = freshChild();
    seedTimestampsFromParent(child, parent);
    (child.state as MinimalSession["state"]).tsStamps!.rawA = 9999;
    assert.equal((parent.state as MinimalSession["state"]).tsStamps!.rawA, 1000, "parent ledger untouched");
});

test("seedTimestampsFromParent: undefined parent or missing ledger is a no-op returning 0", () => {
    const child = freshChild();
    assert.equal(seedTimestampsFromParent(child, undefined), 0);
    const bareParent = { state: {} } as unknown as Session;
    assert.equal(seedTimestampsFromParent(child, bareParent), 0);
    assert.equal((child.state as MinimalSession["state"]).tsStamps, undefined, "no empty map materialized when nothing seeded");
});

test("applyForkAdoption carries the timestamp ledger into the adopted child (#5608)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const parent = {
        state: {
            blocks: [] as unknown[],
            tokenSnapshot: {} as Record<string, number>,
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw: { r1: "m00001" }, byRef: { m00001: "r1" } },
            tsStamps: { r1: 1730000000 },
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
    const plan = planForkAdoption(parent, new Set(["r1"]), { seedAllRefs: true, includeBlocks: false });
    applyForkAdoption(child, plan, parent);
    assert.deepEqual((child.state as MinimalSession["state"]).tsStamps, { r1: 1730000000 }, "stamp rides the adoption — first replay re-renders the provider-cached time attr");
});

test("applyForkAdoption without a parent ledger leaves the child stamp-free (honest NULL, node mints on arrival)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const parent = {
        state: {
            blocks: [] as unknown[],
            tokenSnapshot: {} as Record<string, number>,
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw: { p1: BLOCKED_REF, r1: "m00001" }, byRef: { m00001: "r1" } },
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
    const plan = planForkAdoption(parent, new Set(["p1", "r1"]), { seedAllRefs: true, includeBlocks: false });
    applyForkAdoption(child, plan, parent);
    assert.equal((child.state as MinimalSession["state"]).tsStamps, undefined);
});
