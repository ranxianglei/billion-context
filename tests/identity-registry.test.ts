import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, relPathFor } from "../src/persist.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import type { Session } from "../src/session.ts";

/**
 * #2960 identity registry (R2 v1): the unified index keys sessions by the
 * REAL conversation id, with the owning agent (`namespace`, from
 * metadata.pluginAgent) and the persistence-time `origin` recorded as
 * identity columns. This file pins the three faces of that contract:
 *
 *  1. provider switch (#2847): after an origin change mid-conversation, a
 *     full-mode load still finds the fold ledger — the unified-first lookup
 *     never consults the origin-sharded filename;
 *  2. namespace/origin columns are recorded on every ingest (proxy default,
 *     plugin agents carried through);
 *  3. legacy-mode contrast: the SAME switched lookup misses (the defect
 *     unified closes), and boot() collapses same-id cross-origin files by
 *     freshest savedAt (kernel StateStore dedupe).
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-identity-hermetic-")),
    "no-config.json",
);
// Absent everywhere now resolves to the shadow DEFAULT (#2815 rollout flip);
// this suite needs the explicit legacy baseline — per-test legs override it.
process.env.BILI_STORAGE_UNIFIED = "legacy";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");
const CORPUS_ID = "corpus-folded";
const ORIGIN_A = "http://127.0.0.1:8199";
const ORIGIN_B = "http://10.0.0.9:7000";

function corpusDir(tmp: string): string {
    const dir = path.join(tmp, "folded");
    fs.cpSync(path.join(CORPUS_ROOT, "folded"), dir, { recursive: true });
    return dir;
}

function readCorpusRecord(dir: string): Record<string, unknown> {
    const file = path.join(dir, relPathFor(CORPUS_ID, "anthropic", ORIGIN_A));
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { payload?: Record<string, unknown> };
    return raw.payload ?? raw;
}

function writeRecordFile(dir: string, origin: string, record: Record<string, unknown>): void {
    const file = path.join(dir, relPathFor(CORPUS_ID, "anthropic", origin));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 3, savedAt: record.savedAt, id: CORPUS_ID, payload: record }));
}

function activeBlocks(s: Session): number {
    return (s.state as { blocks?: { active?: boolean }[] }).blocks?.filter((b) => b.active).length ?? 0;
}

test("full mode: provider switch keeps the fold ledger (unified-first, #2847)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-id-switch-"));
    process.env.BILI_STORAGE_UNIFIED = "full";
    let loader: SessionStore | null = null;
    let db: UnifiedStore | null = null;
    try {
        const dir = corpusDir(tmp);
        loader = new SessionStore({ dir, debounceMs: 1, enabled: true });
        // First open under the ORIGINAL origin: organic import into the index.
        const before = loader.loadSync(CORPUS_ID, { protocol: "anthropic", upstreamOrigin: ORIGIN_A });
        assert.ok(before, "corpus loadSync under the original origin");
        assert.equal(activeBlocks(before), 1, "fold arrived with the first open");

        // The switch: same conversation, different upstream origin. Legacy
        // mode would compose a NEW filename and miss; full mode must serve
        // the unified row (b1 still active).
        const after = loader.loadSync(CORPUS_ID, { protocol: "anthropic", upstreamOrigin: ORIGIN_B });
        assert.ok(after, "switched-origin loadSync still resolves (unified-first)");
        assert.equal(activeBlocks(after), 1, "fold ledger survives the origin switch");

        db = UnifiedStore.open(path.join(dir, "index.db"));
        const row = db.getSessionRow(CORPUS_ID);
        assert.ok(row, "index row present");
        assert.equal(row.namespace, "proxy", "bare proxy lane defaults to namespace=proxy");
        assert.equal(row.origin, ORIGIN_A, "origin column carries the shard origin at ingest time");
    } finally {
        // #3818: absent now resolves to the full DEFAULT — restore the
        // suite's declared legacy baseline instead of deleting the var.
        process.env.BILI_STORAGE_UNIFIED = "legacy";
        loader?.closeQuietly();
        db?.close();
        try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
    }
});

test("full mode: plugin lane namespaces the row (metadata.pluginAgent)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-id-ns-"));
    process.env.BILI_STORAGE_UNIFIED = "full";
    let loader: SessionStore | null = null;
    let db: UnifiedStore | null = null;
    try {
        const dir = corpusDir(tmp);
        loader = new SessionStore({ dir, debounceMs: 1, enabled: true });
        assert.ok(loader.loadSync(CORPUS_ID, { protocol: "anthropic", upstreamOrigin: ORIGIN_A }));
        loader.closeQuietly();

        // A later rewrite of the file adopts the conversation into a plugin
        // lane (pluginAgent stamped, fresh savedAt) — the stale-guard lets
        // the newer record re-ingest and the namespace column flips.
        const record = readCorpusRecord(dir);
        const meta = (record.meta ?? {}) as Record<string, unknown>;
        record.meta = { ...meta };
        record.metadata = { ...((record.metadata as Record<string, unknown>) ?? {}), pluginAgent: "dsh" };
        record.savedAt = ((record.savedAt as number) ?? 0) + 5000;
        writeRecordFile(dir, ORIGIN_A, record);

        const loader2 = new SessionStore({ dir, debounceMs: 1, enabled: true });
        // boot() is the file-reconciliation entry: its stale-guard compares
        // payload.savedAt against the row and re-ingests the newer record
        // (loadSync would serve the existing unified row without reading
        // the file).
        const booted = await loader2.boot();
        assert.ok(booted.get(CORPUS_ID) ?? [...booted.values()][0], "reload after plugin adoption");
        loader2.closeQuietly();

        db = UnifiedStore.open(path.join(dir, "index.db"));
        // #286 boot rekey may rename the row id to its label form — find the
        // single row either way (identity of the CONVERSATION, not the row
        // key, is what this test pins).
        const row = db.getSessionRow(CORPUS_ID) ?? db.getSessionRow("corpus-corpus-folded");
        assert.ok(row);
        assert.equal(row.namespace, "dsh", "pluginAgent lands in the namespace column");
        assert.equal(row.origin, ORIGIN_A);
    } finally {
        // #3818: absent now resolves to the full DEFAULT — restore the
        // suite's declared legacy baseline instead of deleting the var.
        process.env.BILI_STORAGE_UNIFIED = "legacy";
        loader?.closeQuietly();
        db?.close();
        try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
    }
});

test("legacy mode: switched-origin lookup misses (the defect unified closes) + boot keeps freshest", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-id-legacy-"));
    let loader: SessionStore | null = null;
    try {
        const dir = corpusDir(tmp);
        loader = new SessionStore({ dir, debounceMs: 1, enabled: true });
        assert.ok(loader.loadSync(CORPUS_ID, { protocol: "anthropic", upstreamOrigin: ORIGIN_A }), "original origin loads");
        // The file only exists under ORIGIN_A's shard: the switched lookup
        // has no file to read and no index to consult.
        assert.equal(loader.loadSync(CORPUS_ID, { protocol: "anthropic", upstreamOrigin: ORIGIN_B }), null,
            "legacy mode composes the origin-sharded filename and misses (#2847)");
        loader.closeQuietly();
        loader = null;

        // Boot across BOTH shards (a switch left a stale ORIGIN_A file next to
        // the fresher ORIGIN_B one): one session, freshest savedAt wins.
        const older = readCorpusRecord(dir);
        const newer = structuredClone(older) as Record<string, unknown>;
        newer.savedAt = ((older.savedAt as number) ?? 0) + 10_000;
        newer.meta = { ...((newer.meta as Record<string, unknown>) ?? {}), upstreamOrigin: ORIGIN_B };
        newer.stats = { ...((newer.stats as Record<string, unknown>) ?? {}), requests: 42 };
        // The payload's meta must match the shard it is written under
        // (kernel StateStore validates the canonical filename against the
        // record body — a real switch re-persists with updated meta).
        writeRecordFile(dir, ORIGIN_B, newer);

        const booter = new SessionStore({ dir, debounceMs: 1, enabled: true });
        const booted = await booter.boot();
        assert.equal(booted.size, 1, "same conversation id under two origins collapses to one session");
        const session = [...booted.values()][0];
        assert.ok(session, "booted session present");
        assert.equal((session.stats as { requests?: number }).requests, 42, "freshest savedAt won regardless of scan order");
        booter.closeQuietly();
    } finally {
        loader?.closeQuietly();
        try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
    }
});

/**
 * #2960 R2.1: identity index + boot union + list fast path.
 *
 *  4. conversations table: ingest claims (namespace, conversation_id) →
 *     session_id (first claimant wins), deleteSession sweeps the binding;
 *  5. full-mode boot union: an index row whose legacy file disappeared
 *     stays enumerable (the index is self-sufficient);
 *  6. export listSessions fast path (full mode): summaries served from one
 *     SQL — parity with the legacy walk over the same corpus.
 */

test("R2.1 identity index: ingest claims, first claimant wins, deleteSession sweeps", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-id-idx-"));
    process.env.BILI_STORAGE_UNIFIED = "full";
    let loader: SessionStore | null = null;
    let db: UnifiedStore | null = null;
    try {
        const dir = corpusDir(tmp);
        loader = new SessionStore({ dir, debounceMs: 1, enabled: true });
        assert.ok(loader.loadSync(CORPUS_ID, { protocol: "anthropic", upstreamOrigin: ORIGIN_A }));
        assert.equal(loader.lookupConversation("proxy", CORPUS_ID), CORPUS_ID, "identity lookup resolves the row key");

        db = UnifiedStore.open(path.join(dir, "index.db"));
        const rowId = db.getSessionRow(CORPUS_ID) ? CORPUS_ID : "corpus-corpus-folded"; // #286 boot rekey
        // First-claimant: the binding exists exactly once for the namespace.
        const bindings = db.listConversationBindings("proxy");
        assert.equal(bindings.length, 1, "one binding under namespace=proxy");
        assert.equal(bindings[0].sessionId, rowId, "binding points at the sessions row key");

        // deleteSession must sweep the binding along with the row.
        db.deleteSession(rowId);
        assert.equal(db.lookupConversation("proxy", CORPUS_ID), null, "identity binding swept with the session");
        assert.equal(db.getSessionRow(rowId), null, "row gone");
    } finally {
        // #3818: absent now resolves to the full DEFAULT — restore the
        // suite's declared legacy baseline instead of deleting the var.
        process.env.BILI_STORAGE_UNIFIED = "legacy";
        loader?.closeQuietly();
        db?.close();
        try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
    }
});

test("R2.1 boot union: full mode keeps index rows whose legacy file disappeared", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-id-union-"));
    process.env.BILI_STORAGE_UNIFIED = "full";
    let loader: SessionStore | null = null;
    try {
        const dir = corpusDir(tmp);
        loader = new SessionStore({ dir, debounceMs: 1, enabled: true });
        assert.ok(loader.loadSync(CORPUS_ID, { protocol: "anthropic", upstreamOrigin: ORIGIN_A }), "organic import");
        loader.closeQuietly();
        loader = null;

        // The file vanishes (deleted by hand / Phase 3 future): the index is
        // self-sufficient — boot and loadAll still enumerate the row.
        fs.rmSync(path.join(dir, relPathFor(CORPUS_ID, "anthropic", ORIGIN_A)), { force: true });

        loader = new SessionStore({ dir, debounceMs: 1, enabled: true });
        const booted = await loader.boot();
        const found = [...booted.values()].find((s) => s.id === CORPUS_ID || s.id === "corpus-corpus-folded");
        assert.ok(found, "index row enumerable at boot with no legacy file (boot union)");
        assert.equal(activeBlocks(found!), 1, "fold ledger intact from the index alone");

        const loaded = await loader.loadAll();
        assert.ok([...loaded.values()].some((s) => s.id === found!.id), "loadAll union sees the file-less row too");
    } finally {
        // #3818: absent now resolves to the full DEFAULT — restore the
        // suite's declared legacy baseline instead of deleting the var.
        process.env.BILI_STORAGE_UNIFIED = "legacy";
        loader?.closeQuietly();
        try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
    }
});

test("R2.1 list fast path: full-mode summaries match the legacy walk (parity)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-id-fast-"));
    const { listSessions } = await import("../src/export.ts");
    let loader: SessionStore | null = null;
    try {
        const dir = corpusDir(tmp);
        // Legacy baseline FIRST (no index yet): the walk over the corpus.
        process.env.BILI_STORAGE_UNIFIED = "legacy";
        const legacyList = await listSessions({ dir });
        assert.equal(legacyList.length, 1, "legacy walk finds the corpus session");

        // Full mode: organic import, then the fast path serves the same
        // summary shape from the sessions table.
        process.env.BILI_STORAGE_UNIFIED = "full";
        loader = new SessionStore({ dir, debounceMs: 1, enabled: true });
        assert.ok(loader.loadSync(CORPUS_ID, { protocol: "anthropic", upstreamOrigin: ORIGIN_A }));
        loader.closeQuietly();
        loader = null;

        const fastList = await listSessions({ dir });
        assert.equal(fastList.length, 1, "fast path finds the session");
        const a = legacyList[0]!;
        const b = fastList[0]!;
        assert.equal(b.id, a.id, "id parity");
        assert.equal(b.title, a.title, "title parity (host_title ?? title)");
        assert.equal(b.label, a.label, "label parity");
        assert.equal(b.protocol, a.protocol, "protocol parity");
        assert.equal(b.upstreamOrigin, ORIGIN_A, "origin column surfaces where the walk reads meta");
        assert.equal(b.blocks, a.blocks, "block count parity (all blocks)");
        assert.equal(b.savedAt, a.savedAt, "savedAt parity (latest block created_at)");
        assert.equal(b.contextTokens, a.contextTokens, "contextTokens parity (stats_json)");
    } finally {
        // #3818: absent now resolves to the full DEFAULT — restore the
        // suite's declared legacy baseline instead of deleting the var.
        process.env.BILI_STORAGE_UNIFIED = "legacy";
        loader?.closeQuietly();
        try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
    }
});
