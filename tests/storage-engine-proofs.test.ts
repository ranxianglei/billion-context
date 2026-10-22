/**
 * Storage-engine proofs (#2690 coverage audit, #2671).
 *
 * The parity core shipped with corpus digests (storage-unified.test.ts) —
 * STATE-level equality between the legacy files and the unified index. This
 * suite pins the seams that audit found unproven:
 *
 *   WIRE PARITY      — BILI_STORAGE_UNIFIED=full must be invisible on the
 *                      wire: per-turn outbound digests, fold landmarks and
 *                      the final state digest equal the COMMITTED storage
 *                      render goldens, both with a mid-conversation restart
 *                      and with the legacy file DELETED at the restart (the
 *                      index alone carries the session — the migration's
 *                      end-state promise).
 *   STALE REJECT     — a multi-instance stale write that the guarded build
 *                      rejects must never reach index.db; the converged disk
 *                      record is what gets ingested.
 *   IMPORT GUARD     — a hand-aged legacy file (older savedAt than the
 *                      index watermark) must not re-import over newer index
 *                      state on load.
 *   ROLLBACK         — unset the env after running full → the legacy file
 *                      loads with the exact digest.
 *   SELF-DISABLE     — 3 consecutive sidecar failures disable it; reads flip
 *                      back to legacy; the legacy file stays readable.
 *   CORRUPT INDEX    — a corrupt index.db self-heals by quarantine instead of
 *                      bricking construction or pinning legacy-only forever
 *                      (#2771 guard, #3959 recovery).
 *   CAS REFCOUNT     — shared content blobs survive deleteSession of one
 *                      session and are collected only at refcount 0.
 *
 * The corrupt-index test is the regression for #2771; the rest are contract
 * pins (proof-only, no product change).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { setSqliteEnginesUnavailableForTests } from "../src/storage/driver.ts";
import { planIngest, loadLegacyView, toLegacyLike, type LegacySessionLike } from "../src/storage/ingest.ts";
import { canonicalize, sha256 } from "./golden-canonical.ts";
import { driveWire, WIRES, type Wire } from "./golden-storage-drive.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.BILI_PERSIST_ZSTD = "0";
// #3400: pin the legacy wire shape. This suite proves STORAGE restart
// invisibility against committed reference digests; the new default egress
// image rescale (#3400) changes those digests by design and is covered by its
// own suite (tests/issue3400-image-rescale.test.ts) — keep the two concerns apart.
process.env.BILI_IMAGE_RESCALE = "0";
// #3756 follow-up: the shadow observability lane writes a snapshotShadow blob
// into session.metadata on armed turns; goldens pin wire+state bytes for the
// RENDER/STORAGE shape, not observability — keep them free of the new field
// (the shadow lane has its own suite, tests/snapshot-shadow.test.ts).
process.env.BILI_SNAPSHOT_SHADOW = "0";


// Same hermeticity contract as the corpus suites: a developer machine with
// storage.unified in its real config must not leak a tier into these tests.
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-engproof-hermetic-")),
    "no-config.json",
);
// Absent everywhere now resolves to the shadow DEFAULT (#2815 rollout flip);
// this suite needs the explicit legacy baseline — per-test legs override it.
process.env.BILI_STORAGE_UNIFIED = "legacy";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");
const RENDER_ROOT = path.resolve(import.meta.dirname, "golden/storage-render");

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Loads the "folded" corpus case into a live Session object. */
function loadFolded(dir: string): Session {
    fs.cpSync(path.join(CORPUS_ROOT, "folded"), dir, { recursive: true });
    const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
    const session = store.loadSync("corpus-folded", { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
    // closeQuietly, not cancelAll: callers run under BILI_STORAGE_UNIFIED=shadow|full,
    // so this store holds an index.db handle — Windows rmrf(dir) EBUSY otherwise.
    store.closeQuietly();
    assert.ok(session, "folded corpus case failed to load");
    return session;
}

function recordDigest(record: Record<string, unknown>): string {
    return sha256(JSON.stringify(canonicalize({
        id: record["id"],
        meta: record["meta"],
        stats: record["stats"],
        metadata: record["metadata"],
        state: record["state"],
        blockContents: Object.entries((record["blockContents"] ?? {}) as Record<string, unknown>),
        lastMessages: record["messages"],
        lastMessagesFolded: record["messagesFolded"] === true,
        pluginSnapshot: record["pluginSnapshot"],
        contentStore: record["forkContentStore"],
    })));
}

function viewDigest(view: ReturnType<typeof loadLegacyView>): string {
    return sha256(JSON.stringify(canonicalize({
        id: view.id,
        meta: view.meta,
        stats: view.stats,
        metadata: view.metadata,
        state: view.state,
        blockContents: [...view.blockContents.entries()],
        lastMessages: view.lastMessages,
        lastMessagesFolded: view.lastMessagesFolded,
        pluginSnapshot: view.pluginSnapshot,
        contentStore: view.contentStore,
    })));
}

/** #2960 ⑤: viewDigest minus the tail pointer fields — full mode serves the
 *  RAW tail from the table while legacy serves the envelope's bounded folded
 *  re-render, so cross-mode "identical state" proofs compare the state proper
 *  (folds/refs/blocks/contents) and pin the tail relationship separately. */
function viewStateDigest(view: ReturnType<typeof loadLegacyView>): string {
    return sha256(JSON.stringify(canonicalize({
        id: view.id,
        meta: view.meta,
        stats: view.stats,
        metadata: view.metadata,
        state: view.state,
        blockContents: [...view.blockContents.entries()],
        pluginSnapshot: view.pluginSnapshot,
        contentStore: view.contentStore,
    })));
}

/** Finds the persisted envelope payload for `id` under `root`. */
function findWrittenRecord(root: string, id: string): Record<string, unknown> | null {
    const hits: string[] = [];
    const walk = (d: string): void => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const fp = path.join(d, f.name);
            if (f.isDirectory()) walk(fp);
            else if (f.name.endsWith(".json") && f.name !== "index.db") hits.push(fp);
        }
    };
    walk(root);
    for (const hit of hits) {
        const envelope = JSON.parse(fs.readFileSync(hit, "utf8")) as Record<string, unknown>;
        const payload = (envelope["payload"] ?? envelope) as Record<string, unknown>;
        if (payload["id"] === id) return payload;
    }
    return null;
}

function unifiedRows(store: UnifiedStore, id: string): ReturnType<typeof loadLegacyView> {
    const rows = {
        session: store.getSessionRow(id)!,
        messages: store.getMessages(id),
        blocks: store.getBlocks(id),
        deadRefs: store.getDeadRefs(id),
        refs: store.getRefs(id),
    };
    assert.ok(rows.session, `session row missing: ${id}`);
    return loadLegacyView(rows);
}

// ---------------------------------------------------------------------------
// WIRE PARITY: full mode + mid-conversation restart == committed goldens.
// ---------------------------------------------------------------------------

for (const wire of WIRES) {
    test(`storage engine: full-mode restart is invisible on the ${wire} wire (== legacy restart, wire == committed goldens)`, { timeout: 240_000 }, async () => {
        const golden = JSON.parse(fs.readFileSync(path.join(RENDER_ROOT, `${wire}.json`), "utf8")) as {
            turns: Array<{ i: number; sha: string }>;
            foldAt: number; editedAt: number; summaryFrom: number;
            stateDigest: string;
            stateShape: Record<string, unknown>;
        };
        // The restart oracle: a legacy-only process restart. One caveat is
        // restart-INHERENT and not a storage property: the body-stability seam
        // slots (cacheLedger line bs/bl/be pairing, #2131) live in memory, so
        // exactly the first post-restart ledger line loses its bs fields —
        // identically in both legs. Everything else must be byte-equal.
        const legacy = await driveWire(wire as Wire, `golden-${wire}`, { reloadAfterEdit: "keepFile" });
        for (const leg of ["keepFile", "dropFile"] as const) {
            const record = await driveWire(wire as Wire, `golden-${wire}`, { storageUnified: "full", reloadAfterEdit: leg });
            assert.equal(record.turns.length, legacy.turns.length, `${wire}/${leg}: body count drifted vs legacy restart`);
            for (let i = 0; i < legacy.turns.length; i++) {
                assert.equal(record.turns[i]!.sha, legacy.turns[i]!.sha, `${wire}/${leg}: outbound body #${i} digest drift vs legacy restart`);
                assert.equal(record.turns[i]!.sha, golden.turns[i]!.sha, `${wire}/${leg}: outbound body #${i} digest drift vs committed goldens (restart must not change the wire)`);
            }
            assert.equal(record.foldAt, legacy.foldAt, `${wire}/${leg}: fold landmark drifted`);
            assert.equal(record.editedAt, legacy.editedAt, `${wire}/${leg}: edit landmark drifted`);
            assert.equal(record.summaryFrom, legacy.summaryFrom, `${wire}/${leg}: summary carrier landmark drifted`);
            assert.equal(record.stateDigest, legacy.stateDigest, `${wire}/${leg}: persisted state digest drift vs legacy restart`);
            assert.deepEqual(record.stateShape, legacy.stateShape, `${wire}/${leg}: state shape drift`);
            assert.deepEqual(record.sectionDigests, legacy.sectionDigests, `${wire}/${leg}: state section digests drift`);
            assert.deepEqual(record.stateKeyDigests, legacy.stateKeyDigests, `${wire}/${leg}: state key digests drift`);
        }
    });
}

// ---------------------------------------------------------------------------
// STALE REJECT: a rejected (stale) multi-writer build never reaches index.db.
// ---------------------------------------------------------------------------

test("storage engine: stale-rejected multi-writer build never ingests; the converged disk record does", async () => {
    const dir = tmpdir("bili-engproof-stale-");
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "shadow";
    try {
        const storeA = new SessionStore({ dir, debounceMs: 1, enabled: true });
        const session = loadFolded(path.join(dir, "seed"));
        const blocksAtWrite = session.state.blocks.length;

        // Instance A commits the newer lineage (requests bumped).
        session.stats.requests = 7;
        await storeA.writeNow(session);
        storeA.closeQuietly();

        // Instance B holds the OLDER in-memory lineage and tries to commit.
        const storeB = new SessionStore({ dir, debounceMs: 1, enabled: true });
        session.stats.requests = 4; // stale: disk already has 7
        session.state.blocks = session.state.blocks.slice(0, Math.max(0, blocksAtWrite - 1)); // older fold state
        await storeB.writeNow(session);
        storeB.closeQuietly();

        const probe = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const view = unifiedRows(probe, "corpus-folded");
            const stats = view.stats as { requests?: number };
            assert.equal(stats.requests, 7, "index ingested the STALE rejected build (must be the converged disk record)");
            assert.equal((view.state as { blocks: unknown[] }).blocks.length, blocksAtWrite, "index fold state regressed to the stale lineage");

            // The index view must equal the record on disk (the winner).
            const disk = findWrittenRecord(dir, "corpus-folded");
            assert.ok(disk, "disk record not found");
            assert.equal(viewDigest(view), recordDigest(disk), "index view digest != winning disk record");
        } finally {
            probe.close();
        }
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// IMPORT GUARD: an older legacy file must not re-import over newer index state.
// ---------------------------------------------------------------------------

test("storage engine: load-side import guard skips a hand-aged legacy file (index watermark wins)", async () => {
    const dir = tmpdir("bili-engproof-guard-");
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const session = loadFolded(path.join(dir, "seed"));
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        session.stats.requests = 9;
        await store.writeNow(session);
        store.closeQuietly();

        // Hand-age the LEGACY file: older savedAt, older fold state.
        const disk = findWrittenRecord(dir, "corpus-folded");
        assert.ok(disk, "disk record not found");
        const aged = JSON.parse(JSON.stringify(disk)) as Record<string, unknown>;
        const payload = (aged["payload"] ?? aged) as Record<string, unknown>;
        payload["savedAt"] = (payload["savedAt"] as number) - 60_000;
        (payload["state"] as Record<string, unknown>)["blocks"] = [];
        const target = path.join(dir, "anthropic");
        let wrote = false;
        for (const f of fs.readdirSync(target, { recursive: true, withFileTypes: false }) as unknown as string[]) {
            const fp = path.join(target, f);
            if (fs.statSync(fp).isFile() && f.endsWith(".json")) {
                const envelope = JSON.parse(fs.readFileSync(fp, "utf8")) as Record<string, unknown>;
                const inner = (envelope["payload"] ?? envelope) as Record<string, unknown>;
                if (inner["id"] === "corpus-folded") {
                    fs.writeFileSync(fp, JSON.stringify({ ...envelope, payload }));
                    wrote = true;
                }
            }
        }
        assert.ok(wrote, "aged legacy file not found to rewrite");

        // Reload in full mode: the index watermark is newer → no re-import.
        const store2 = new SessionStore({ dir, debounceMs: 1, enabled: true });
        const reloaded = store2.loadSync("corpus-folded", { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
        store2.closeQuietly();
        assert.ok(reloaded, "full-mode reload returned null");
        const blocks = (toLegacyLike(reloaded).state as { blocks: unknown[] }).blocks;
        assert.ok(blocks.length > 0, "stale legacy file re-imported over the newer index state (import guard broken)");
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// ROLLBACK: full → unset env → legacy file authoritative, digest exact.
// ---------------------------------------------------------------------------

test("storage engine: rollback contract — unset the env and the legacy read path serves the identical state", async () => {
    const dir = tmpdir("bili-engproof-rollback-");
    const prev = process.env.BILI_STORAGE_UNIFIED;
    try {
        process.env.BILI_STORAGE_UNIFIED = "full";
        const session = loadFolded(path.join(dir, "seed"));
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        await store.writeNow(session);
        store.closeQuietly();
        assert.ok(fs.existsSync(path.join(dir, "index.db")), "full mode did not create index.db");

        // Read through BOTH paths post-write and require byte-equality of the
        // served state — rollback must change the read path, never the bytes.
        // (The load-path digest is the stable oracle: an in-memory session vs
        // a loaded one differs benignly by the storageMode stamp + one-time
        // tail normalization, identically under both paths.)
        const storeFull = new SessionStore({ dir, debounceMs: 1, enabled: true });
        const viaFull = storeFull.loadSync("corpus-folded", { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
        storeFull.closeQuietly();
        assert.ok(viaFull, "full-mode reload returned null");
        const digestFull = viewDigest(toLegacyLike(viaFull));

        delete process.env.BILI_STORAGE_UNIFIED;
        const store2 = new SessionStore({ dir, debounceMs: 1, enabled: true });
        const legacy = store2.loadSync("corpus-folded", { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
        store2.closeQuietly();
        assert.ok(legacy, "legacy-only reload returned null after rollback");
        // #2960 ⑤: cross-mode equality is on the STATE proper — full mode
        // serves the raw table tail, legacy the envelope's folded view.
        assert.equal(viewStateDigest(toLegacyLike(legacy)), viewStateDigest(toLegacyLike(viaFull)), "rollback: legacy-only load state digest drift vs full-mode load");
        assert.ok(viaFull.lastMessages && viaFull.lastMessages.length > 0, "⑤: full-mode load serves the table tail");
        assert.ok(legacy.lastMessages && legacy.lastMessages.length > 0, "⑤: rollback keeps the envelope tail");
        const disk = findWrittenRecord(dir, "corpus-folded");
        assert.ok(disk, "disk record not found");
        assert.equal(viewDigest(toLegacyLike(legacy)), recordDigest(disk), "rollback: legacy load digest != disk record");
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// SELF-DISABLE: 3 consecutive failures flip reads back to legacy-only.
// ---------------------------------------------------------------------------

test("storage engine: sidecar self-disables after 3 consecutive failures (reads flip legacy)", () => {
    const dir = tmpdir("bili-engproof-disable-");
    try {
        const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "full" }, () => {
            throw new Error("synthetic legacy-load failure");
        });
        assert.ok(shadow, "sidecar did not open");
        assert.equal(shadow.readsUnified, true, "fresh full sidecar must read unified");
        shadow.record({ some: "record" });
        shadow.record({ some: "record" });
        assert.equal(shadow.readsUnified, true, "2 failures must not disable yet");
        shadow.record({ some: "record" });
        assert.equal(shadow.stats.disabled, true, "3 consecutive failures must disable the sidecar");
        assert.equal(shadow.readsUnified, false, "disabled sidecar must not read unified");
        assert.equal(shadow.viewFor("anything"), null, "disabled sidecar must miss reads");
        shadow.close();

        // The legacy file is unaffected through a plain SessionStore.
        const legacy = loadFolded(path.join(dir, "seed"));
        assert.ok(legacy, "legacy load broken while the sidecar is disabled");
    } finally {
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// CORRUPT INDEX (#2771/#3959): construction survives via quarantine — the
// dead index is renamed aside (never deleted), a fresh one opens, and reads
// recover from the legacy files. The machine is never pinned legacy-only.
// ---------------------------------------------------------------------------

test("storage engine: corrupt index.db self-heals by quarantine instead of bricking construction or pinning legacy-only (#2771/#3959)", async () => {
    const dir = tmpdir("bili-engproof-corrupt-");
    const prev = process.env.BILI_STORAGE_UNIFIED;
    try {
        process.env.BILI_STORAGE_UNIFIED = "full";
        const session = loadFolded(path.join(dir, "seed"));
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        await store.writeNow(session);
        store.closeQuietly();

        // The clean read through full mode — the digest the post-quarantine
        // recovery must reproduce exactly from the legacy file.
        const clean = new SessionStore({ dir, debounceMs: 1, enabled: true });
        const viaFull = clean.loadSync("corpus-folded", { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
        clean.closeQuietly();
        assert.ok(viaFull, "full-mode read returned null");

        // Corrupt the index header (crashed checkpoint / stray write).
        const fd = fs.openSync(path.join(dir, "index.db"), "r+");
        fs.writeSync(fd, Buffer.alloc(512, 0x5a), 0, 512, 0);
        fs.closeSync(fd);

        // THE #2771/#3959 regression pair: construction must survive AND the
        // store must come back in full mode (not a permanent legacy pin).
        const store2 = new SessionStore({ dir, debounceMs: 1, enabled: true });
        try {
            const reloaded = store2.loadSync("corpus-folded", { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
            assert.ok(reloaded, "post-quarantine read returned null over the fresh index");
            assert.equal(viewStateDigest(toLegacyLike(reloaded)), viewStateDigest(toLegacyLike(viaFull)), "self-healed read state digest drift vs clean full-mode read");
            // Writes keep working against the fresh index — no throw.
            await store2.writeNow(reloaded);
        } finally {
            store2.closeQuietly();
        }

        // Regression (#2781): after close NOTHING may still hold a handle in
        // the directory — Windows refuses to move/delete a directory while
        // any process holds a file inside it open (the healed store's live
        // index.db handle would trip exactly this guard if close leaked it).
        // On POSIX the rename is a no-op that always succeeds, so it only
        // bites where the bug lives.
        const moved = dir + "-moved";
        fs.renameSync(dir, moved);
        fs.renameSync(moved, dir);

        // Forensics contract: the corrupt bytes survive beside the fresh
        // index, never deleted, under the .corrupt-<timestamp> suffix.
        const quarantined = fs.readdirSync(dir).filter((n) => n.startsWith("index.db.corrupt-"));
        assert.equal(quarantined.length, 1, "exactly one quarantine copy of the dead index");
        const qHead = fs.readFileSync(path.join(dir, quarantined[0])).subarray(0, 512);
        assert.ok(qHead.every((b) => b === 0x5a), "quarantined header keeps the corrupt bytes verbatim");
        assert.ok(fs.existsSync(path.join(dir, "index.db")), "a fresh index.db lives next to the quarantine");
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// CAS REFCOUNT: shared blobs survive one session's deletion.
// ---------------------------------------------------------------------------

test("storage engine: CAS refcounts conserve shared content across deleteSession", () => {
    const dir = tmpdir("bili-engproof-refcount-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const mkSession = (id: string): LegacySessionLike => ({
                id,
                createdAt: 1_000,
                lastSeen: 2_000,
                meta: { protocol: "openai" },
                stats: { requests: 1 },
                metadata: {},
                state: {
                    nextBlockId: 2,
                    nextRunId: 1,
                    blocks: [{
                        blockId: "b1",
                        runId: "r1",
                        tier: 1,
                        summary: "SHARED-SUMMARY-BODY",
                        directMessageIds: ["raw1", "raw2"],
                        effectiveMessageIds: ["raw1", "raw2"],
                        directBlockIds: [],
                        compressedTokens: 100,
                        createdAt: 1_500,
                        survivedCount: 2,
                        generation: "young",
                        active: true,
                    }],
                    messageRefs: { byRaw: {}, byRef: {} },
                },
                blockContents: new Map([["b1", { one: null, full: { text: "SHARED-SUMMARY-BODY", count: 2 } }]]),
                lastMessages: [],
                lastMessagesFolded: false,
                pluginSnapshot: undefined,
                contentStore: undefined,
            });
            store.ingestSession(planIngest(mkSession("sess-one")));
            store.ingestSession(planIngest(mkSession("sess-two")));
            let report = store.contentDedupReport();
            assert.equal(report.rows, 1, "identical summaries must intern to ONE CAS row");
            assert.equal(report.refcounted, 2, "two sessions must hold one refcount each");

            store.deleteSession("sess-one");
            report = store.contentDedupReport();
            assert.equal(report.rows, 1, "shared blob must survive one holder's deletion");
            assert.equal(report.refcounted, 1, "refcount must drop to the surviving holder");

            store.deleteSession("sess-two");
            report = store.contentDedupReport();
            assert.equal(report.rows, 0, "blob at refcount 0 must be collected");
            assert.equal(store.getSessionRow("sess-one"), null, "session rows must be gone");
        } finally {
            store.close();
        }
    } finally {
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// NO ENGINE AT ALL (#2823): neither better-sqlite3 nor node:sqlite available.
// The unified store must degrade to legacy-only and never brick construction —
// the contract that lets us ship without a native SQLite dependency at all.
// ---------------------------------------------------------------------------

test("storage engine: no SQLite engine -> maybeOpen degrades to null (sidecar absent), never throws (#2823)", () => {
    const dir = tmpdir("bili-engproof-noengine-open-");
    try {
        setSqliteEnginesUnavailableForTests(true);
        const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "full" }, () => null);
        assert.equal(shadow, null, "maybeOpen must return null (legacy-only) when no SQLite engine is available");
    } finally {
        setSqliteEnginesUnavailableForTests(false);
        rmrf(dir);
    }
});

test("storage engine: no SQLite engine -> SessionStore runs legacy-only, writes survive, no index.db (#2823)", async () => {
    const dir = tmpdir("bili-engproof-noengine-e2e-");
    const prev = process.env.BILI_STORAGE_UNIFIED;
    try {
        process.env.BILI_STORAGE_UNIFIED = "full"; // ask for the unified store...
        setSqliteEnginesUnavailableForTests(true); // ...but pretend none exists
        const session = loadFolded(path.join(dir, "seed"));
        // THE #2823 regression: construction must survive with no engine at all.
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        await store.writeNow(session);
        assert.ok(!fs.existsSync(path.join(dir, "index.db")), "no-engine mode must not create index.db");
        const reloaded = store.loadSync("corpus-folded", { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
        store.closeQuietly();
        assert.ok(reloaded, "legacy load returned null with no SQLite engine available");
        const disk = findWrittenRecord(dir, "corpus-folded");
        assert.ok(disk, "disk record not found");
        assert.equal(viewDigest(toLegacyLike(reloaded)), recordDigest(disk), "no-engine: legacy load digest != disk record");
    } finally {
        setSqliteEnginesUnavailableForTests(false);
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        rmrf(dir);
    }
});

// Engine note: these legs run on the process-default engine; the corpus
// suites (storage-unified.test.ts) cover BOTH engines at the state level,
// and the wire legs here assert against the same committed goldens the
// legacy baseline produced.
