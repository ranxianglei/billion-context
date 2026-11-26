import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { reconcileNativeCompactionBoundary } from "../src/session.js";
import { noteCompressLoopFailure, type RewriteCtx } from "../src/stream.js";

_setStoreForTest(new SessionStore({ enabled: false }));

// #5984: after a host-native compaction rebase the ref space restarts, but the
// compress-failure accounting written against the pre-rebase generation
// survived — so (a) a pre-rebase streak carried across the boundary could arm
// mid-loop on the new refs, and (b) the stale-ref failures that are INEVITABLE
// while the model still carries its old refs in its own persisted history
// armed a hard-stop that then scrubbed the very acp_status recovery the model
// needed to get out. Two fixes under test here:
//   A — a rebase clears the #2146 consecutive-failure streak AND the #847
//       exact-spec repeat guard (the ref space they describe is gone).
//   B — a stale-ref failure inside the post-rebase grace window is counted as
//       proxy-caused (bili itself rebased) and does NOT advance the model
//       breaker, so the non-armed recovery hints stay visible until a success.

function makeSession(extraMetadata: Record<string, unknown> = {}): Session {
    return {
        id: `issue5984-${randomUUID()}`,
        meta: {},
        stats: {},
        metadata: { ...extraMetadata },
        state: { messageRefs: { byRaw: {}, byRef: {} }, blocks: [] },
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    } as unknown as Session;
}

function fakeCtx(session: Session): RewriteCtx {
    return { session, log: () => {} } as unknown as RewriteCtx;
}

const STALE_ERRS = "m00045–m00089: every ref is unknown to this session";

test("#5984 A: a native-compaction rebase clears the #2146 streak and the #847 guard", () => {
    const session = makeSession({
        nativeCompactionBoundary: { at: 1, pendingRebase: true },
        compressFailStreak: { n: 2, lastAt: Date.now() },
        compressFailKeys: ["m00001..m00002"],
    });
    // a live pre-rebase ref so the floor pin has something to capture
    session.state.messageRefs.byRaw["rawA"] = "m00010";
    session.state.messageRefs.byRef["m00010"] = "rawA";

    const rebased = reconcileNativeCompactionBoundary(session);
    assert.equal(rebased, true);
    assert.equal(session.metadata["compressFailStreak"], undefined, "#2146 streak must not carry across the generation break");
    assert.equal(session.metadata["compressFailKeys"], undefined, "#847 exact-spec guard must not carry across the generation break");
});

test("#5984 A (guard): no pending boundary → no rebase → accounting untouched", () => {
    const session = makeSession({ compressFailStreak: { n: 2, lastAt: Date.now() } });
    const rebased = reconcileNativeCompactionBoundary(session);
    assert.equal(rebased, false, "no pending boundary means no rebase happened");
    assert.notEqual(session.metadata["compressFailStreak"], undefined, "no rebase → the streak must be left alone");
});

test("#5984 B: stale-ref failures within the post-rebase grace never arm the breaker", () => {
    const session = makeSession({ nativeCompactionAt: Date.now() });
    const ctx = fakeCtx(session);
    for (let i = 1; i <= 5; i++) {
        const guard = noteCompressLoopFailure(ctx, "m00045..m00089", STALE_ERRS);
        assert.equal(guard, "", `failure ${i}: no pause paragraph — the non-armed recovery hints must stay visible`);
    }
    assert.equal(session.metadata["compressFailStreak"], undefined, "proxy-caused staleness must not advance the model-failure streak");
});

test("#5984 B (guard): the same stale-ref storm WITHOUT a recent rebase still arms at 3", () => {
    const session = makeSession({}); // never rebased
    const ctx = fakeCtx(session);
    const f1 = noteCompressLoopFailure(ctx, "a", STALE_ERRS);
    const f2 = noteCompressLoopFailure(ctx, "b", STALE_ERRS);
    const f3 = noteCompressLoopFailure(ctx, "c", STALE_ERRS);
    assert.equal(f1, "");
    assert.equal(f2, "");
    assert.match(f3, /CIRCUIT BREAKER/, "no rebase → normal model-failure accounting, arms at 3");
});

test("#5984 B (guard): a rebase older than the grace window stops the exemption", () => {
    const session = makeSession({ nativeCompactionAt: Date.now() - 31 * 60 * 1000 });
    const ctx = fakeCtx(session);
    noteCompressLoopFailure(ctx, "a", STALE_ERRS);
    noteCompressLoopFailure(ctx, "b", STALE_ERRS);
    const f3 = noteCompressLoopFailure(ctx, "c", STALE_ERRS);
    assert.match(f3, /CIRCUIT BREAKER/, "grace elapsed → stale-ref counts again, arms at 3");
});

test("#5984 B (guard): non-stale-ref failures are NOT exempted post-rebase", () => {
    const session = makeSession({ nativeCompactionAt: Date.now() });
    const ctx = fakeCtx(session);
    // parse-failure shape: errs === undefined → freshCause "" → not exempted
    noteCompressLoopFailure(ctx, "unparseable");
    noteCompressLoopFailure(ctx, "unparseable");
    const f3 = noteCompressLoopFailure(ctx, "unparseable");
    assert.match(f3, /CIRCUIT BREAKER/, "genuine model-format errors still arm even right after a rebase");
});
