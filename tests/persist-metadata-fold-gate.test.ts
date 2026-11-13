import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import { isDroppedMetadata, type Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// This suite exercises the legacy envelope fold gate — the storage default
// flipped to pure-sqlite (index-only, no envelope); pin explicit dual-write
// so the on-disk JSON record these assertions read keeps being written.
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_STORAGE_JSON_WRITER = "1";

// #5506: the post-settle resident-metadata fold (runIdleSpillIfIdle →
// dropResidentMetadata) replaced the live metadata object with a fresh
// disk-backed lazy proxy even when the live object carried mutations that NO
// save had ever committed (direct field writes do not bump revisionEpoch, so
// the old epoch-equality gate let the fold through). The next save then
// rebuilt metadata purely from disk bytes and the unsaved mutation was lost
// until the host happened to re-stamp it — observed in production as the PFA
// stamp silently missing after restart, and as the load-dependent CI flake
// "PFA stamp must be on disk after restart" in
// tests/issue2129-restart-measurement-state.test.ts:327.
// The fix gates the fold on a fingerprint match between the live persisted-shape
// metadata and the bytes last CONFIRMED committed to disk. These tests pin both
// directions: divergent ⇒ fold refused (negative), matching ⇒ fold proceeds
// (positive), never-saved ⇒ fold refused (conservative default).

function makeSession(id: string): Session {
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

const foldGate = (store: SessionStore): { dropResidentMetadata(session: Session): void } =>
    store as unknown as { dropResidentMetadata(session: Session): void };

test("metadata fold is refused while live metadata diverges from the last committed bytes (#5506)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-fpgate-neg-"));
    const stores: SessionStore[] = [];
    try {
        const store = new SessionStore({ dir, debounceMs: 60000, enabled: true });
        stores.push(store);
        const s = makeSession("fpgate-negative");
        s.metadata.anonymousPrefixAffinity = { depth: 22, tailHash: "test-tail", via: "prefix" };
        await store.writeNow(s);
        // A late stamp lands WITHOUT markDirty (the #5506 hazard class: direct
        // writes bump no epoch). If writeNow's own post-save fold already ran,
        // this set re-materializes the proxy from disk and adds the key in memory.
        (s.metadata as Record<string, unknown>).lateStamp = "unsaved";
        foldGate(store).dropResidentMetadata(s);
        assert.equal(isDroppedMetadata(s.metadata), false, "fold must be refused while live metadata diverges from committed bytes");
        assert.equal((s.metadata as Record<string, unknown>).lateStamp, "unsaved", "the unsaved mutation must stay resident");
    } finally {
        // #6480: the explicit dual-write pin opens index.db in this dir; an
        // unclosed store pins the file and teardown hits Windows EBUSY
        // (#2799/#2908 family). Release the handle before deleting.
        for (const store of stores) store.closeQuietly();
        rmrf(dir);
    }
});

test("metadata fold proceeds once the divergent mutation has been committed (#5506 positive direction)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-fpgate-pos-"));
    const stores: SessionStore[] = [];
    try {
        const store = new SessionStore({ dir, debounceMs: 60000, enabled: true });
        stores.push(store);
        const s = makeSession("fpgate-positive");
        s.metadata.anonymousPrefixAffinity = { depth: 22, tailHash: "test-tail", via: "prefix" };
        await store.writeNow(s);
        (s.metadata as Record<string, unknown>).lateStamp = "unsaved";
        foldGate(store).dropResidentMetadata(s);
        assert.equal(isDroppedMetadata(s.metadata), false, "precondition: fold refused while divergent");
        // Commit the mutation; the post-save fold must now see matching fingerprints.
        await store.writeNow(s);
        assert.equal(isDroppedMetadata(s.metadata), true, "fold must proceed once live == committed");
        const reloaded = new SessionStore({ dir, debounceMs: 60000, enabled: true });
        stores.push(reloaded);
        const back = reloaded.loadSync("fpgate-positive");
        assert.ok(back, "session reloaded");
        assert.equal((back?.metadata as Record<string, unknown>).lateStamp, "unsaved", "committed mutation survives the round trip");
        await reloaded.flushAll([]);
    } finally {
        // #6480: the explicit dual-write pin opens index.db in this dir; an
        // unclosed store pins the file and teardown hits Windows EBUSY
        // (#2799/#2908 family). Release the handle before deleting.
        for (const store of stores) store.closeQuietly();
        rmrf(dir);
    }
});

test("metadata fold stays closed for a session with no committed save yet (#5506 conservative default)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-fpgate-cold-"));
    const stores: SessionStore[] = [];
    try {
        const store = new SessionStore({ dir, debounceMs: 60000, enabled: true });
        stores.push(store);
        const s = makeSession("fpgate-cold");
        (s.metadata as Record<string, unknown>).onlyInMemory = true;
        foldGate(store).dropResidentMetadata(s);
        assert.equal(isDroppedMetadata(s.metadata), false, "no commit proof yet ⇒ fold must stay closed");
        assert.equal((s.metadata as Record<string, unknown>).onlyInMemory, true);
    } finally {
        // #6480: the explicit dual-write pin opens index.db in this dir; an
        // unclosed store pins the file and teardown hits Windows EBUSY
        // (#2799/#2908 family). Release the handle before deleting.
        for (const store of stores) store.closeQuietly();
        rmrf(dir);
    }
});
