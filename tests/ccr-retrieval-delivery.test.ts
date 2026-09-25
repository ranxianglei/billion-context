import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createContentStore, storeOriginal, type CoreMessage } from "acp-kernel";
import { SessionStore, _buildRecordForTest, _setStoreForTest } from "../src/persist.ts";
import {
    drainPendingRetrievals,
    executeRetrieve,
    requeueRetrievalsOnFailure,
    storeEffectiveCcr,
    trackRetrievalDrain,
} from "../src/store.ts";
import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";

/**
 * #1343: the retrieve ack promises "the full text rides the next request",
 * but delivery rode volatile state with four loss windows. The fixes:
 *  - W1: the queue persists with the session file (restart survives);
 *  - W2: a failed forward requeues the drained batch (drain ticket);
 *  - W3: disarm drops the queue LOUDLY;
 *  - W4: the queue is bounded; oldest is dropped with a log line.
 */

function freshSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

function injection(id: string, text: string): CoreMessage {
    return { id, role: "user", contentType: "text", text };
}

test("W2: a failed forward requeues the drained batch, in order, exactly once", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const session = freshSession("w2");
    session.pendingRetrievals.push(injection("i1", "full text one"), injection("i2", "full text two"));

    const drained = drainPendingRetrievals(session);
    trackRetrievalDrain(session, drained);
    assert.equal(session.pendingRetrievals.length, 0, "drained");

    requeueRetrievalsOnFailure(session, "upstream network failure");
    assert.equal(session.pendingRetrievals.length, 2, "batch back on the queue");
    assert.equal(session.pendingRetrievals[0]!.text, "full text one", "order preserved");
    assert.equal(session.lastRetrievalDrain, undefined, "ticket consumed");

    requeueRetrievalsOnFailure(session, "upstream 502");
    assert.equal(session.pendingRetrievals.length, 2, "second failure must not duplicate");
});

test("W2 guard: a delivered batch is never resurrected by a later failure", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const session = freshSession("w2-guard");
    session.pendingRetrievals.push(injection("i1", "delivered text"));

    const delivered = drainPendingRetrievals(session);
    trackRetrievalDrain(session, delivered);
    // forward succeeded; next request drains again (empty) — the new drain
    // must invalidate the stale ticket.
    drainPendingRetrievals(session);
    requeueRetrievalsOnFailure(session, "upstream 500");
    assert.equal(session.pendingRetrievals.length, 0, "delivered batch stays delivered");
});

test("W3: disarming a lane with a queued batch drops it loudly (observable behavior)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const session = freshSession("w3");
    session.pendingRetrievals.push(injection("i1", "stray text"));
    storeEffectiveCcr(session, undefined);
    assert.equal(session.pendingRetrievals.length, 0, "queue cleared on disarm");
    // Re-arming keeps working (no crash on empty queue).
    storeEffectiveCcr(session, { enabled: true });
    assert.equal(session.pendingRetrievals.length, 0);
});

test("W4: the retrieval queue is bounded; oldest is dropped on overflow", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const session = freshSession("w4");
    let store = createContentStore();
    for (let i = 1; i <= 6; i++) {
        store = storeOriginal(store, { ref: `m0000${i}`, rawId: `u${i}`, text: `CONTENT-${i}`, kind: "file read", tokens: 2, head: `CONTENT-${i}` });
    }
    session.contentStore = store;
    for (let i = 1; i <= 6; i++) {
        executeRetrieve({ ref: `m0000${i}` }, session);
    }
    assert.equal(session.pendingRetrievals.length, 4, "queue capped at 4");
    assert.ok(
        session.pendingRetrievals.every((m) => !m.text.includes("CONTENT-1") && !m.text.includes("CONTENT-2")),
        "oldest dropped, newest kept",
    );
});

test("W1: the queue persists with the session file and survives reload", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-1343-"));
    try {
        const persist = new SessionStore({ dir, enabled: true, debounceMs: 0 });
        _setStoreForTest(persist);
        const session = freshSession("w1");
        session.pendingRetrievals.push(injection("i1", "undelivered full text"));

        const record = _buildRecordForTest(session);
        assert.equal(record.pendingRetrievals?.length, 1, "record carries the queue");
        assert.deepEqual(record.pendingRetrievals!.map((m) => m.text), ["undelivered full text"]);
        // Empty queue writes nothing (old files stay byte-compatible).
        const empty = _buildRecordForTest(freshSession("w1b"));
        assert.equal(empty.pendingRetrievals, undefined);

        // Full disk round-trip: writeNow → loadSync restores the queue.
        await persist.writeNow(session);
        const restored = new SessionStore({ dir, enabled: true, debounceMs: 0 }).loadSync("w1");
        assert.ok(restored, "session reloaded from disk");
        assert.equal(restored!.pendingRetrievals.length, 1, "queue survives restart (#1343 W1)");
        assert.equal(restored!.pendingRetrievals[0]!.text, "undelivered full text");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
