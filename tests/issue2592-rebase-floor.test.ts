import assert from "node:assert/strict";
import test from "node:test";

import { highestUsedIndex, indexToRef } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { REF_FLOOR_RAW_ID, reconcileNativeCompactionBoundary, reserveRefsThrough, type Session } from "../src/session.js";
import { rebaseNote } from "../src/stream.js";

/** #2592/F5: the rebase must pin the pre-rebase ref high-water mark, so refs
 *  the model still remembers from the compacted generation are never
 *  re-allocated onto different raw content (silent misattribution). */
test("#2592 F5: reconcileNativeCompactionBoundary pins the pre-rebase ref floor", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const session = {
        state: {
            messageRefs: { byRaw: { rawA: "m00001", rawB: "m00007", rawC: "m00012" }, byRef: { m00001: "rawA", m00007: "rawB", m00012: "rawC" } },
            blocks: [],
        },
        blockContents: new Map(),
        pendingRetrievals: [],
        metadata: { nativeCompactionBoundary: { at: 1, pendingRebase: true } },
        stats: {},
    } as unknown as Session;
    const rebased = reconcileNativeCompactionBoundary(session);
    assert.equal(rebased, true, "boundary consumed");
    assert.equal((session.metadata.nativeCompactionBoundary as { pendingRebase?: boolean }).pendingRebase, false, "boundary no longer pending");
    // The fresh state carries ONLY the synthetic floor entry — old raw ids are
    // gone (rebase semantics) but the number space above the floor stays
    // reserved (refs are never reused within a session).
    assert.equal(session.state.messageRefs.byRaw[REF_FLOOR_RAW_ID], "m00012", "floor pinned to the pre-rebase high-water mark");
    assert.equal(Object.keys(session.state.messageRefs.byRaw).length, 1, "fresh state holds only the floor entry");
    // And the floor keeps its meaning: the next allocated ref starts above it.
    assert.equal(highestUsedIndex(session.state.messageRefs), 12);
    assert.equal(indexToRef(highestUsedIndex(session.state.messageRefs)), "m00012");
});

test("#2592 F5: a rebase on an empty ref map is a plain reset (no floor entry)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const session = {
        state: { messageRefs: { byRaw: {}, byRef: {} }, blocks: [] },
        blockContents: new Map(),
        pendingRetrievals: [],
        metadata: { nativeCompactionBoundary: { at: 1, pendingRebase: true } },
        stats: {},
    } as unknown as Session;
    assert.equal(reconcileNativeCompactionBoundary(session), true);
    assert.equal(session.state.messageRefs.byRaw[REF_FLOOR_RAW_ID], undefined, "no refs existed pre-rebase — nothing to pin");
    assert.equal((session.metadata.nativeCompactionBoundary as { rebasedAt?: number }).rebasedAt !== undefined, true, "boundary consumed regardless");
});

test("#2592 F5 (guard): reserveRefsThrough never lowers an existing floor", () => {
    const session = {
        state: { messageRefs: { byRaw: { rawA: "m00010", [REF_FLOOR_RAW_ID]: "m00040" }, byRef: { m00010: "rawA" } }, blocks: [] },
    } as unknown as Session;
    assert.equal(reserveRefsThrough(session, 20), false, "floor already above 20 — no-op");
    assert.equal(session.state.messageRefs.byRaw[REF_FLOOR_RAW_ID], "m00040", "floor untouched");
});

/** #2592/F3-lite: when a rebased session's compress cites below-frontier refs
 *  that resolve to nothing, the receipt names the rebase as the deterministic
 *  cause instead of letting the model hunt for typos. */
test("#2592 F3: rebaseNote fires for stale refs on a rebased session", () => {
    const errs = "m00008–m00010: every ref is unknown to this session";
    const note = rebaseNote({ metadata: { nativeCompactionAt: 123 } } as unknown as Session, errs, "");
    assert.ok(note.includes("rebased (host-native compaction)"), "names the cause");
    assert.ok(note.includes("no retry can revive them"), "shuts down the retry instinct");
});

test("#2592 F3: rebaseNote stays silent when #2146 already covers it", () => {
    const errs = "m90001–m90010: every ref is unknown to this session";
    assert.equal(rebaseNote({ metadata: { nativeCompactionAt: 123 } } as unknown as Session, errs, "All requested refs are above…"), "", "beyond-frontier note already names the earlier generation");
});

test("#2592 F3: rebaseNote stays silent without a rebase or without stale refs", () => {
    const errs = "m00008–m00010: every ref is unknown to this session";
    assert.equal(rebaseNote({ metadata: {} } as unknown as Session, errs, ""), "", "session was never rebased — could be a typo, do not claim a rebase");
    assert.equal(rebaseNote({ metadata: { nativeCompactionAt: 123 } } as unknown as Session, "m00001–m00002: already compressed", ""), "", "failure is not stale-ref class — no rebase note");
});
