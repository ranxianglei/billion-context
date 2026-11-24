/**
 * #7577 (c): the admin replicas endpoint, for an egress-on session, takes the
 * point-fork path instead of the checkpoint path. This covers the store-level
 * primitive `forkEgressSnapshot` end to end (not just the HTTP mapping):
 *
 *   1. an egress-on PARENT (resident, persisted, carrying egress content rows)
 *      forks to now: the child is a NEW id, is loadable, and its egress content
 *      is byte-equal to the parent's;
 *   2. the child is an INDEPENDENT snapshot: mutating + re-persisting the
 *      parent afterwards leaves the child's persisted kernel-state untouched
 *      (the deep copy in forkEgressSnapshot, not a live alias);
 *   3. the egress-off / not-resident rejections throw (both directions #3617).
 *
 * egress-on here means ONLY `metadata.egressAuthority === true` — the store
 * primitive does not consult the rollout (featureEnabled), so no egress arming
 * is needed to test the fork machinery in isolation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = mkdtempSync(join(tmpdir(), "bili-egress-fork-hermetic-"));
process.env.BILI_CONFIG_FILE = join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_ROLLOUT_EGRESS_PLANE = "0";

// import AFTER the env is set (persist.js reads the storage mode at import
// for some lazy paths; the constructor re-resolves, but keep it tidy).
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { createSession, _resetSessionsForTest, peekSession } from "../src/session.js";
import { recordEgressTurn, type EgressOpLogStore } from "../src/storage/egress-record.js";
import type { CoreMessage } from "acp-kernel";

const M = (id: string, text: string, role: string = "user"): CoreMessage => ({ id, role, contentType: "text", text }) as CoreMessage;

test("(c) forkEgressSnapshot: egress-on parent forks to now — loadable, content-equal, independent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-egress-fork-"));
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    try {
        const ready = await store.waitForReplicas(5000);
        assert.ok(ready, "unified store ready");
        _setStoreForTest(store);
        _resetSessionsForTest();

        // --- parent: a resident, persisted egress-on session -----------------
        // createSession only builds the object; RESIDENCY is established by
        // loadAsync (it registers into the live session map that
        // forkEgressSnapshot's peekSession probe reads).
        const seed = createSession("parent-eg");
        seed.metadata["egressAuthority"] = true;
        seed.state.terminalStreak = 7; // a kstate marker to prove snapshot independence
        assert.ok(store.flushSync(seed), "parent persisted");
        const parent = (await store.loadAsync("parent-eg")) as typeof seed;
        assert.ok(parent, "parent loaded resident");
        assert.equal(parent.state.terminalStreak, 7, "the marker round-trips through persistence");

        // give the parent egress CONTENT (the content authority it will hand over)
        const ustore = store.egressOpLogStore();
        assert.ok(ustore, "egress op-log store reachable");
        const ops: EgressOpLogStore = {
            egressAppendTurn: (s, o, b, n) => ustore!.egressAppendTurn(s, o, b, n),
            egressStateView: (s) => ustore!.egressStateView(s),
            egressStateViewAt: (s, x) => ustore!.egressStateViewAt(s, x),
            egressStateMaxSeq: (s) => ustore!.egressStateMaxSeq(s),
            egressStateBaseSeq: (s) => ustore!.egressStateBaseSeq?.(s),
            egressStateTruncateAfter: (s, x) => ustore!.egressStateTruncateAfter(s, x),
        };
        const msgs: CoreMessage[] = [M("m1", "hello world"), M("m2", "hi there", "assistant")];
        const recorded = recordEgressTurn({ store: ops, sessionId: "parent-eg", prev: undefined, conversation: msgs, systemText: "sys", nowMs: 1000 });
        // the view carries the system row too; assert the two message rows are present
        assert.ok(recorded.some((r) => r.msgid === "m1") && recorded.some((r) => r.msgid === "m2"), "m1 and m2 recorded on the parent");
        // #7577 (dual clocks, owner ruling 2026-11-24): the fork watermark
        // is the FLOW high water — the block table numbers itself and aligns
        // via its flow_op_seq pointer, so there is no shared clock to chase.
        const parentHighWater = ustore.egressStateMaxSeq("parent-eg");
        assert.ok(parentHighWater >= 1, "parent has egress history");

        // --- fork to now ------------------------------------------------------
        const { childId, opSeq } = await store.forkEgressSnapshot("parent-eg");
        assert.ok(childId.startsWith("fork-"), `child is a fresh id: ${childId}`);
        assert.equal(opSeq, parentHighWater, "opSeq = parent high water (fork-to-now)");
        assert.equal(peekSession(childId), undefined, "the child is NOT registered resident (it is a persisted snapshot)");

        // the child is loadable and its egress content is byte-equal to the parent's
        const child = await store.loadAsync(childId);
        assert.ok(child, "child loads from disk");
        const childView = ustore.egressStateView(childId);
        const parentView = ustore.egressStateView("parent-eg");
        assert.equal(childView.length, parentView.length, "child inherited every egress row");
        assert.deepEqual(
            childView.map((r) => [r.msgid, r.bytes, r.ref]),
            parentView.map((r) => [r.msgid, r.bytes, r.ref]),
            "child egress content is byte-equal to the parent's",
        );
        // the kernel-state marker was COPIED at fork time (snapshot, not alias)
        assert.equal(child.state.terminalStreak, 7, "child kstate captured the parent's value at fork time");
        // and the child points back at its origin
        assert.equal(child.metadata["derivedFromSessionId"], "parent-eg", "child records its derivation");

        // --- independence: mutate + re-persist the PARENT; the child is untouched
        parent.state.terminalStreak = 99;
        assert.ok(store.flushSync(parent), "parent re-persisted after mutation");
        assert.equal((await store.loadAsync("parent-eg"))!.state.terminalStreak, 99, "parent now persists the new value");
        const child2 = await store.loadAsync(childId);
        assert.ok(child2, "child still loads");
        assert.equal(child2.state.terminalStreak, 7, "child's persisted kstate is the fork-time snapshot — the parent's later mutation does not reach it");
        assert.deepEqual(
            ustore.egressStateView(childId).map((r) => [r.msgid, r.bytes]),
            parentView.map((r) => [r.msgid, r.bytes]),
            "child egress content still equals the ORIGINAL parent view (parent rows were not rewritten into the child)",
        );
    } finally {
        store.closeQuietly();
        _resetSessionsForTest();
    }
});

test("(c) rejections: not-egress-on and already-exists both throw (both directions #3617)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-egress-fork-rej-"));
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    try {
        const ready = await store.waitForReplicas(5000);
        assert.ok(ready, "unified store ready");
        _setStoreForTest(store);
        _resetSessionsForTest();

        // an egress-OFF session cannot take the point-fork path (resident first)
        const plainSeed = createSession("plain-eg");
        assert.ok(store.flushSync(plainSeed), "plain session persisted");
        assert.ok(await store.loadAsync("plain-eg"), "plain loaded resident");
        await assert.rejects(
            () => store.forkEgressSnapshot("plain-eg"),
            /not an egress-on session/,
            "egress-off session is rejected",
        );

        // an egress-on parent whose child id already exists is rejected (never clobber)
        const p2 = createSession("parent-eg2");
        p2.metadata["egressAuthority"] = true;
        assert.ok(store.flushSync(p2), "parent persisted");
        assert.ok(await store.loadAsync("parent-eg2"), "parent loaded resident");
        const existingSeed = createSession("taken-child");
        assert.ok(store.flushSync(existingSeed), "existing child persisted");
        assert.ok(await store.loadAsync("taken-child"), "existing child resident");
        await assert.rejects(
            () => store.forkEgressSnapshot("parent-eg2", "taken-child"),
            /already exists/,
            "fork into an existing session id is rejected",
        );
    } finally {
        store.closeQuietly();
        _resetSessionsForTest();
    }
});

test("(c) guard: a NON-resident egress-on session is rejected by createReplica (D5 — no checkpoint for egress-on, loaded or not)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-egress-fork-guard-"));
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    try {
        const ready = await store.waitForReplicas(5000);
        assert.ok(ready, "unified store ready");
        _setStoreForTest(store);
        _resetSessionsForTest();

        // egress-on parent, persisted but NOT loaded (non-resident) — the
        // admin endpoint's resident probe misses it, and the old resident-only
        // guard would have let a checkpoint row through for it.
        const seed = createSession("parent-nr");
        seed.metadata["egressAuthority"] = true;
        assert.ok(store.flushSync(seed), "parent persisted");
        assert.equal(peekSession("parent-nr"), undefined, "parent is non-resident");

        await assert.rejects(
            () => store.createReplica("parent-nr"),
            /use the point-fork path/,
            "non-resident egress-on session is rejected by the guard",
        );
        assert.equal((await store.listReplicas("parent-nr")).length, 0, "no checkpoint row was created for the egress-on session");

        // both directions (#3617): a non-resident egress-OFF session still
        // takes the checkpoint path — the guard must not over-reject.
        const plain = createSession("plain-nr");
        assert.ok(store.flushSync(plain), "plain session persisted");
        assert.equal(peekSession("plain-nr"), undefined, "plain is non-resident");
        const row = await store.createReplica("plain-nr");
        assert.ok(row.cp_id, "non-resident egress-off session still checkpoints");
        assert.equal((await store.listReplicas("plain-nr")).length, 1, "exactly one checkpoint row");
    } finally {
        store.closeQuietly();
        _resetSessionsForTest();
    }
});
