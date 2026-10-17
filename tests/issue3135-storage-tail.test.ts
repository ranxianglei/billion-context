/**
 * #3135 storage tail — two legs:
 *   ② BILI_PERSIST=0 (enabled:false) with a full request must read as an
 *     INTENTIONAL opt-out (legacy effective, not degraded, real reason),
 *     never as a permanent "no SQLite engine available" degradation.
 *   ④ digest drift must be visible on the status wire, and a drifted
 *     dual-write full-mode session must fall back to the still-written
 *     legacy file instead of silently serving the index view.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInitialState } from "acp-kernel";
import { SessionStore, relPathFor } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { _resetStorageRuntimeStatusForTest, storageDiagnosticsLines, storageStatusWire } from "../src/storage/runtime-status.ts";
import { setSqliteEnginesUnavailableForTests } from "../src/storage/driver.ts";

// Plain JSON envelopes so seed mutations stay deterministic (#1080)
process.env.BILI_PERSIST_ZSTD = "0";

function makeSession(id: string, meta: Session["meta"] = {}, requests = 0): Session {
    return {
        id,
        meta,
        stats: { requests, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, retrieveDelivered: 0, storedBytes: 0, storeBytesSaved: 0, compressCreditTokens: 0, rangeRestores: 0 },
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

test("persistence disabled is an intentional opt-out, not a degradation (#3135②)", () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3135-persist-off-"));
    try {
        _resetStorageRuntimeStatusForTest();
        setSqliteEnginesUnavailableForTests(true);
        // enabled:false is exactly what BILI_PERSIST=0 resolves to at the
        // getStore()/server-init boundary.
        new SessionStore({ dir, enabled: false });
        const wire = storageStatusWire();
        assert.equal(wire.requested, "full");
        assert.equal(wire.effective, "legacy");
        assert.equal(wire.degraded, false, "persistence off must not read as a degradation");
        assert.equal(wire.intentionalOptOut, true);
        assert.equal(wire.reason, null);
        const blob = storageDiagnosticsLines({ sessions: 0, storageLogLines: [] }).join("\n");
        assert.ok(blob.includes("persistence disabled"), `diagnostics must name the real cause, got:\n${blob}`);
        assert.ok(!blob.includes("no SQLite engine available"), "the bogus engine-missing reason must not surface");
    } finally {
        setSqliteEnginesUnavailableForTests(false);
        _resetStorageRuntimeStatusForTest();
        if (prevMode === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prevMode;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("digest drift is wire-visible and dual-write full falls back to the file (#3135④)", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3135-drift-"));
    try {
        _resetStorageRuntimeStatusForTest();
        const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
        const session = makeSession("ses_drift", { protocol: "openai" }, 9);
        await store.writeNow(session);
        const wire = storageStatusWire();
        assert.equal(typeof wire.verifyOk, "number");
        assert.equal(typeof wire.verifyDrift, "number");
        assert.ok(wire.verifyOk >= 1, "a clean ingest must tally verifyOk");
        assert.equal(wire.verifyDrift, 0);

        // Index-first read serves the index value.
        assert.equal(store.loadSync(session.id)?.stats.requests, 9);

        // Mutate ONLY the file at the SAME savedAt (so the freshness guard
        // does not re-import): the file now disagrees with the index row.
        const file = path.join(dir, relPathFor(session.id, "openai"));
        const envelope = JSON.parse(fs.readFileSync(file, "utf8")) as { payload: { stats: { requests: number } } };
        envelope.payload.stats.requests = 42;
        fs.writeFileSync(file, JSON.stringify(envelope));
        assert.equal(store.loadSync(session.id)?.stats.requests, 9, "without drift the index view still wins");

        // Mark this session's row drifted (whitebox: the detection itself is
        // covered by the unified-storage digest suites) → the dual-write
        // session must answer from the still-written legacy file.
        const driftMap = (store as unknown as { shadow?: { driftBySession: Map<string, number> } }).shadow?.driftBySession;
        assert.ok(driftMap, "shadow sidecar must exist in full mode");
        driftMap.set(session.id, 1);
        assert.equal(store.loadSync(session.id)?.stats.requests, 42, "drifted dual-write session must fall back to the legacy file");

        // A later CLEAN sampled verify proves the row consistent again and
        // clears the per-session mark → index-first serving resumes. #3133
        // samples read-back verification (first ingest + every 20th), so the
        // mark stays sticky until the NEXT sample point actually verifies —
        // drive the per-session counter there (one ingest already ran).
        session.stats.requests = 77;
        for (let i = 0; i < 20; i++) await store.writeNow(session);
        assert.equal(store.loadSync(session.id)?.stats.requests, 77, "clean verified ingest must clear the drift mark");
        assert.ok(driftMap.get(session.id) === undefined, "clean verified ingest must clear the per-session drift entry");
        store.cancelAll();
        store.closeQuietly();
    } finally {
        _resetStorageRuntimeStatusForTest();
        if (prevMode === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prevMode;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("digest drift under jsonWriter=off keeps serving the index view (sole copy, #3135④)", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    const prevWriter = process.env.BILI_STORAGE_JSON_WRITER;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "off";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3135-drift-writeroff-"));
    try {
        _resetStorageRuntimeStatusForTest();
        const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
        const session = makeSession("ses_drift_woff", { protocol: "openai" }, 9);
        await store.writeNow(session);
        assert.ok(!fs.existsSync(path.join(dir, relPathFor(session.id, "openai"))), "writerOff leaves no file fallback");
        const driftMap = (store as unknown as { shadow?: { driftBySession: Map<string, number> } }).shadow?.driftBySession;
        assert.ok(driftMap, "shadow sidecar must exist in full mode");
        driftMap.set(session.id, 1);
        // No file exists to fall back to — the index view stays the best
        // copy even while marked drifted (visibility rides the wire/stats).
        assert.equal(store.loadSync(session.id)?.stats.requests, 9, "writerOff must keep serving the index view under drift");
        store.cancelAll();
        store.closeQuietly();
    } finally {
        _resetStorageRuntimeStatusForTest();
        if (prevMode === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prevMode;
        if (prevWriter === undefined) delete process.env.BILI_STORAGE_JSON_WRITER; else process.env.BILI_STORAGE_JSON_WRITER = prevWriter;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
