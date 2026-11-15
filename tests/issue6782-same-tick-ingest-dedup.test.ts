import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, recordToLegacyView } from "../src/persist.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";

/**
 * #6782 (direction 1): same-tick ingest dedup — when `ingestRowsNow` already
 * ingested the current content in the same tick (the prepare phase), the
 * `markDirty`-triggered writer-off coalesced build must skip the redundant
 * `guardedBuild` (the rows are already durable; the second ingest is an empty
 * delta that pays the full fixed cost — 3-table full read + tail_json rewrite
 * + tx commit — for nothing).
 *
 * Pinned here:
 *   1. `ingestRowsNow` + `markDirty` in the same tick → the writer-off
 *      coalesced build skips the redundant `guardedBuild` (shadow.stats.ingests
 *      stays at 1, not 2).
 *   2. A content change between `ingestRowsNow` and the microtask (a new
 *      `lastMessages` reference) → the build is NOT skipped (shadow.stats.ingests
 *      is 2).
 *   3. A revision bump beyond +1 (an extra `markDirty` between `ingestRowsNow`
 *      and the microtask) → the build is NOT skipped (shadow.stats.ingests is 2).
 */

process.env.BILI_PERSIST_ZSTD = "0";
// Hermeticity pin: pin BOTH tiers so every leg controls its own mode.
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6782-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "anthropic", upstreamOrigin: "http://upstream" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
        lastMessages: [{ id: "m00001", role: "user", contentType: "text", text: "hello" }],
        lastMessagesFolded: false,
    };
}

/** Wait for all pending microtasks to run (the writer-off coalesced build is
 *  scheduled via queueMicrotask). */
function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => queueMicrotask(resolve));
}

function openStore(dir: string): { store: SessionStore; shadow: UnifiedShadow } {
    const shadow = UnifiedShadow.maybeOpen(dir, process.env, recordToLegacyView);
    assert.ok(shadow, "UnifiedShadow.maybeOpen must succeed in full mode");
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true, shadow });
    return { store, shadow };
}

test("#6782: same-tick ingestRowsNow + markDirty → writer-off build skips the redundant guardedBuild", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    const prevWriter = process.env.BILI_STORAGE_JSON_WRITER;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "off"; // writer-off: the coalesced microtask path
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6782-dedup-"));
        try {
            const { store, shadow } = openStore(dir);
            const session = makeSession("s-dedup");
            session.revisionEpoch = 0; // a real session always has a revision (set at creation/load)

            // Simulate the prepare phase: ingestRowsNow (ingest #1) + markDirty
            // (schedules the writer-off coalesced build).
            store.ingestRowsNow(session);
            assert.equal(shadow.stats.ingests, 1, "ingestRowsNow must perform exactly one ingest");

            // markDirty bumps the revision and schedules the writer-off build.
            session.revisionEpoch = (session.revisionEpoch ?? 0) + 1;
            store.scheduleSave(session);

            // Wait for the microtask to run.
            await flushMicrotasks();

            // The writer-off build must have SKIPPED the redundant guardedBuild
            // (the rows are already durable from ingestRowsNow). So the ingest
            // count must still be 1 (not 2).
            assert.equal(shadow.stats.ingests, 1,
                `the writer-off coalesced build must skip the redundant guardedBuild (ingests=${shadow.stats.ingests}, expected 1 — the second ingest is an empty delta that pays the full fixed cost for nothing, #6782 direction 1)`);

            store.cancelAll();
            store.closeQuietly();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevMode;
        if (prevWriter === undefined) delete process.env.BILI_STORAGE_JSON_WRITER;
        else process.env.BILI_STORAGE_JSON_WRITER = prevWriter;
    }
});

test("#6782: a content change between ingestRowsNow and the microtask → the build is NOT skipped", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    const prevWriter = process.env.BILI_STORAGE_JSON_WRITER;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "off";
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6782-changed-"));
        try {
            const { store, shadow } = openStore(dir);
            const session = makeSession("s-changed");
            session.revisionEpoch = 0;

            // Simulate the prepare phase: ingestRowsNow (ingest #1).
            store.ingestRowsNow(session);
            assert.equal(shadow.stats.ingests, 1, "ingestRowsNow must perform exactly one ingest");

            // Simulate a content change: a NEW lastMessages reference (as
            // snapshotMessages would set in a new request).
            session.lastMessages = [{ id: "m00002", role: "user", contentType: "text", text: "changed" }];

            // markDirty bumps the revision and schedules the writer-off build.
            session.revisionEpoch = (session.revisionEpoch ?? 0) + 1;
            store.scheduleSave(session);

            // Wait for the microtask to run.
            await flushMicrotasks();

            // The writer-off build must NOT skip the guardedBuild (the content
            // changed since ingestRowsNow). So the ingest count must be 2.
            assert.equal(shadow.stats.ingests, 2,
                `the writer-off build must NOT skip when the content changed (ingests=${shadow.stats.ingests}, expected 2 — the tail reference changed, so the dedup signal is stale)`);

            store.cancelAll();
            store.closeQuietly();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevMode;
        if (prevWriter === undefined) delete process.env.BILI_STORAGE_JSON_WRITER;
        else process.env.BILI_STORAGE_JSON_WRITER = prevWriter;
    }
});

test("#6782: a revision bump beyond +1 → the build is NOT skipped", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    const prevWriter = process.env.BILI_STORAGE_JSON_WRITER;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "off";
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6782-rev-"));
        try {
            const { store, shadow } = openStore(dir);
            const session = makeSession("s-rev");
            session.revisionEpoch = 0;

            // Simulate the prepare phase: ingestRowsNow (ingest #1).
            store.ingestRowsNow(session);
            assert.equal(shadow.stats.ingests, 1, "ingestRowsNow must perform exactly one ingest");

            // Simulate an EXTRA markDirty (revision bump beyond +1). This
            // represents a content mutation between ingestRowsNow and the
            // microtask that is NOT the unconditional markDirty at line 628.
            session.revisionEpoch = (session.revisionEpoch ?? 0) + 1;
            session.revisionEpoch = (session.revisionEpoch ?? 0) + 1; // +2 total
            store.scheduleSave(session);

            // Wait for the microtask to run.
            await flushMicrotasks();

            // The writer-off build must NOT skip the guardedBuild (the revision
            // bumped by more than +1 since ingestRowsNow). So the ingest count
            // must be 2.
            assert.equal(shadow.stats.ingests, 2,
                `the writer-off build must NOT skip when the revision bumped beyond +1 (ingests=${shadow.stats.ingests}, expected 2 — an extra markDirty means the content may have changed)`);

            store.cancelAll();
            store.closeQuietly();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevMode;
        if (prevWriter === undefined) delete process.env.BILI_STORAGE_JSON_WRITER;
        else process.env.BILI_STORAGE_JSON_WRITER = prevWriter;
    }
});
