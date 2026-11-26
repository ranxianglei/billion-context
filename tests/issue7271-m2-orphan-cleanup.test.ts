import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getSession, _resetSessionsForTest, _sessionsSizeForTest, removeOrphanSession, acquireInFlight } from "../src/session.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";

test("#7271 M2: removeOrphanSession removes a session from the in-memory map even when inFlight > 0", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-7271-m2-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    _resetSessionsForTest(256);
    _setStoreForTest(store);
    try {
        const session = getSession("orphan-7271");
        assert.equal(session.stats.requests, 0);
        assert.equal(_sessionsSizeForTest(), 1);

        // Simulate the creating request still being in flight
        acquireInFlight(session);
        assert.equal(session.inFlight, 1);

        // removeOrphanSession must succeed even with inFlight > 0
        assert.equal(removeOrphanSession(session.id), true);
        assert.equal(_sessionsSizeForTest(), 0);

        // A second call returns false (session already gone)
        assert.equal(removeOrphanSession(session.id), false);
    } finally {
        await store.flushAll();
        _resetSessionsForTest(256);
        _setStoreForTest(new SessionStore({ dir, enabled: false }));
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#7271 M2: removeOrphanSession returns false for a non-existent session", () => {
    _resetSessionsForTest(256);
    try {
        assert.equal(removeOrphanSession("does-not-exist"), false);
    } finally {
        _resetSessionsForTest(256);
    }
});
