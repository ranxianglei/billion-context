import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import { pruneRefsToLiveIds, REF_FLOOR_RAW_ID, type Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "bili-orphan-ref-"));
process.env.BILI_CONFIG_FILE = path.join(ROOT, "no-config.json");
process.env.BILI_PERSIST_ZSTD = "0";
delete process.env.BILI_STORAGE_JSON_WRITER;
test.after(() => rmrf(ROOT));

function makeSession(id: string): Session {
    return {
        id, meta: { protocol: "openai", upstreamOrigin: "http://up:1", label: id },
        stats: {
            requests: 1, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0,
            cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0,
            retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0,
            storeBytesSaved: 0, rangeRestores: 0,
        },
        metadata: { source: "test" }, state: createInitialState(),
        createdAt: 1, lastSeen: 2, inFlight: 0, persisted: false, pendingRetrievals: [],
        blockContents: new Map(),
    };
}

type StoreInternals = {
    tombstoneOrphanRefs(id: string, session: Session): void;
    unifiedLiveMsgIds(id: string): Set<string> | null;
};

function internals(store: SessionStore): StoreInternals {
    return store as unknown as StoreInternals;
}

test("pruneRefsToLiveIds tombstones orphan refs into deadRefs", () => {
    const session = makeSession("s1");
    const state = session.state;
    state.messageRefs.byRaw = {
        "live-1": "m00001",
        "live-2": "m00002",
        "orphan-1": "m00003",
    };
    state.messageRefs.byRef = {
        "m00001": "live-1",
        "m00002": "live-2",
        "m00003": "orphan-1",
    };

    const liveRawIds = new Set(["live-1", "live-2"]);
    pruneRefsToLiveIds(session, liveRawIds, state.messageRefs.byRaw, state.messageRefs.byRef);

    assert.equal(state.messageRefs.byRaw["orphan-1"], undefined);
    assert.equal(state.messageRefs.byRef["m00003"], undefined);
    assert.equal(state.messageRefs.byRaw["live-1"], "m00001");
    assert.equal(state.messageRefs.byRaw["live-2"], "m00002");
    assert.ok(state.deadRefs);
    assert.ok(state.deadRefs.includes("m00003"));
    assert.ok(state.messageRefs.byRaw[REF_FLOOR_RAW_ID]);
});

test("pruneRefsToLiveIds is a no-op when no orphans exist", () => {
    const session = makeSession("s2");
    const state = session.state;
    state.messageRefs.byRaw = {
        "live-1": "m00001",
        "live-2": "m00002",
    };
    state.messageRefs.byRef = {
        "m00001": "live-1",
        "m00002": "live-2",
    };

    const liveRawIds = new Set(["live-1", "live-2"]);
    pruneRefsToLiveIds(session, liveRawIds, state.messageRefs.byRaw, state.messageRefs.byRef);

    assert.equal(state.deadRefs, undefined);
    assert.equal(Object.keys(state.messageRefs.byRaw).length, 2);
});

test("tombstoneOrphanRefs removes orphan refs when live set is available", () => {
    const dir = mkdtempSync(path.join(ROOT, "tombstone-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 60_000 });

    const session = makeSession("tombstone-test");
    const state = session.state;
    state.messageRefs.byRaw = {
        "live-1": "m00001",
        "orphan-a": "m00002",
        "orphan-b": "m00003",
    };
    const byRef = {
        "m00001": "live-1",
        "m00002": "orphan-a",
        "m00003": "orphan-b",
    };
    state.messageRefs.byRef = byRef;

    // Mock unifiedLiveMsgIds to return only the live rawIds.
    const internals_ = internals(store);
    const origLiveMsgIds = internals_.unifiedLiveMsgIds.bind(store);
    const mockable = store as unknown as { unifiedLiveMsgIds: (id: string) => Set<string> | null };
    mockable.unifiedLiveMsgIds = () => new Set(["live-1"]);

    try {
        internals_.tombstoneOrphanRefs("tombstone-test", session);
    } finally {
        mockable.unifiedLiveMsgIds = origLiveMsgIds;
    }

    // Orphans removed from byRaw/byRef.
    assert.equal(state.messageRefs.byRaw["orphan-a"], undefined);
    assert.equal(state.messageRefs.byRaw["orphan-b"], undefined);
    // Live ref preserved.
    assert.equal(state.messageRefs.byRaw["live-1"], "m00001");
    // Orphan refs tombstoned into deadRefs.
    assert.ok(state.deadRefs);
    assert.ok(state.deadRefs.includes("m00002"));
    assert.ok(state.deadRefs.includes("m00003"));
});

test("tombstoneOrphanRefs is a no-op when unified store is unavailable", () => {
    const dir = mkdtempSync(path.join(ROOT, "tombstone-off-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 60_000 });

    const session = makeSession("tombstone-off-test");
    const state = session.state;
    state.messageRefs.byRaw = {
        "orphan-a": "m00001",
    };
    state.messageRefs.byRef = {
        "m00001": "orphan-a",
    };

    // Mock unifiedLiveMsgIds to return null (store unavailable).
    const internals_ = internals(store);
    const origLiveMsgIds = internals_.unifiedLiveMsgIds.bind(store);
    const mockable = store as unknown as { unifiedLiveMsgIds: (id: string) => Set<string> | null };
    mockable.unifiedLiveMsgIds = () => null;

    try {
        internals_.tombstoneOrphanRefs("tombstone-off-test", session);
    } finally {
        mockable.unifiedLiveMsgIds = origLiveMsgIds;
    }

    // Orphan stays in byRaw (no tombstone).
    assert.equal(state.messageRefs.byRaw["orphan-a"], "m00001");
    assert.equal(state.deadRefs, undefined);
});

test("tombstoneOrphanRefs is a no-op when no orphans exist", () => {
    const dir = mkdtempSync(path.join(ROOT, "tombstone-none-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 60_000 });

    const session = makeSession("tombstone-none-test");
    const state = session.state;
    state.messageRefs.byRaw = {
        "live-1": "m00001",
    };
    state.messageRefs.byRef = {
        "m00001": "live-1",
    };

    // All refs are live → no orphans.
    const internals_ = internals(store);
    const origLiveMsgIds = internals_.unifiedLiveMsgIds.bind(store);
    const mockable = store as unknown as { unifiedLiveMsgIds: (id: string) => Set<string> | null };
    mockable.unifiedLiveMsgIds = () => new Set(["live-1"]);

    try {
        internals_.tombstoneOrphanRefs("tombstone-none-test", session);
    } finally {
        mockable.unifiedLiveMsgIds = origLiveMsgIds;
    }

    // No orphans → no deadRefs, ref preserved.
    assert.equal(state.deadRefs, undefined);
    assert.equal(state.messageRefs.byRaw["live-1"], "m00001");
});

test("tombstoneOrphanRefs preserves REF_FLOOR_RAW_ID", () => {
    const dir = mkdtempSync(path.join(ROOT, "tombstone-floor-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 60_000 });

    const session = makeSession("tombstone-floor-test");
    const state = session.state;
    state.messageRefs.byRaw = {
        [REF_FLOOR_RAW_ID]: "m00010",
        "orphan-a": "m00001",
        "live-1": "m00002",
    };
    state.messageRefs.byRef = {
        "m00001": "orphan-a",
        "m00002": "live-1",
    };

    const internals_ = internals(store);
    const origLiveMsgIds = internals_.unifiedLiveMsgIds.bind(store);
    const mockable = store as unknown as { unifiedLiveMsgIds: (id: string) => Set<string> | null };
    mockable.unifiedLiveMsgIds = () => new Set(["live-1"]);

    try {
        internals_.tombstoneOrphanRefs("tombstone-floor-test", session);
    } finally {
        mockable.unifiedLiveMsgIds = origLiveMsgIds;
    }

    // REF_FLOOR_RAW_ID preserved (not treated as orphan).
    assert.ok(state.messageRefs.byRaw[REF_FLOOR_RAW_ID]);
    // Orphan tombstoned.
    assert.equal(state.messageRefs.byRaw["orphan-a"], undefined);
    assert.ok(state.deadRefs);
    assert.ok(state.deadRefs.includes("m00001"));
});

test("tombstoneOrphanRefs preserves multi-generation msg_ids (edits)", () => {
    const dir = mkdtempSync(path.join(ROOT, "tombstone-multigen-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 60_000 });

    const session = makeSession("tombstone-multigen-test");
    const state = session.state;
    // "edited-1" is a multi-generation msg_id (an edit left two rows in the
    // log). It has live rows, so it is NOT an orphan — even though seqByRaw
    // would exclude it (n > 1).
    state.messageRefs.byRaw = {
        "edited-1": "m00001",
        "orphan-a": "m00002",
    };
    state.messageRefs.byRef = {
        "m00001": "edited-1",
        "m00002": "orphan-a",
    };

    // Mock unifiedLiveMsgIds to return only "edited-1" (the new method
    // includes multi-generation ids — "edited-1" has live rows even though
    // seqByRaw would exclude it). "orphan-a" has NO live rows.
    const internals_ = internals(store);
    const origLiveMsgIds = internals_.unifiedLiveMsgIds.bind(store);
    const mockable = store as unknown as { unifiedLiveMsgIds: (id: string) => Set<string> | null };
    mockable.unifiedLiveMsgIds = () => new Set(["edited-1"]);

    try {
        internals_.tombstoneOrphanRefs("tombstone-multigen-test", session);
    } finally {
        mockable.unifiedLiveMsgIds = origLiveMsgIds;
    }

    // edited-1 is live (multi-generation) → preserved.
    assert.equal(state.messageRefs.byRaw["edited-1"], "m00001");
    // orphan-a is NOT in the live set → tombstoned.
    assert.equal(state.messageRefs.byRaw["orphan-a"], undefined);
    assert.ok(state.deadRefs);
    assert.ok(state.deadRefs.includes("m00002"));
    assert.ok(!state.deadRefs.includes("m00001"));
});
