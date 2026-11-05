import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, storageStatusLabel } from "../src/persist.ts";
import { UnifiedStore } from "../src/storage/store.ts";


/**
 * Phase 3 (#2960): `storage.jsonWriter = "off"` — while the unified store
 * runs in full mode, the legacy JSON envelope is no longer written; the
 * SQLite index is the only persistent copy. Reads were already
 * unified-first (#2671 Phase 1.5) and boot enumerates the index union
 * (#2992), so an index-only session must survive a store restart with its
 * folds intact. Safety legs: the switch is ignored (warned once) under
 * shadow/legacy where JSON remains the sole source of truth, and
 * replicas/restore keep materializing JSON envelopes for portability.
 */

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: pin BOTH tiers so every
// leg controls its own mode explicitly (absent now defaults to full, #3818).
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

function loadCorpusCase(dir: string, name: string, id: string, protocol: string) {
    fs.cpSync(path.join(CORPUS_ROOT, name), path.join(dir, name), { recursive: true });
    const loader = new SessionStore({ dir: path.join(dir, name), debounceMs: 1, enabled: true });
    const loaded = loader.loadSync(id, { protocol, upstreamOrigin: "http://127.0.0.1:8199" });
    loader.cancelAll();
    loader.closeQuietly();
    assert.ok(loaded, `${name}: corpus loadSync returned null`);
    return loaded;
}

/** Session envelopes live at <proto>/<host>_<hash>.json; the per-session
 *  content-store sidecar (<...>.content-store.json) is intentionally still
 *  written under jsonWriter=off (cheap, keeps CCR portable), so the probe
 *  counts only real session records. */
function envelopeFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (p: string) => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            const full = path.join(p, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith(".json") && !e.name.endsWith(".content-store.json") && e.name !== "no-config.json") out.push(full);
        }
    };
    walk(dir);
    return out;
}

/** Windows: an ephemeral stray handle must not fail CI — best-effort delete
 *  with bounded retries, swallowed on persistent EBUSY/EPERM. */
function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

test("jsonWriter=off (full): no envelope written, index-only session survives restart, replicas still export JSON", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "off";
    try {
        assert.equal(storageStatusLabel(), "storage: full (unified-only, json envelope off)");
        const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-seed-"));
        const session = loadCorpusCase(seed, "folded", "corpus-folded", "anthropic");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-full-"));
        try {
            const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
            await store.writeNow(session);
            store.cancelAll();
            store.closeQuietly();

            // No session envelope on disk — the SQLite index is the only copy.
            assert.equal(envelopeFiles(dir).length, 0, "jsonWriter=off must not write a session envelope");
            assert.ok(fs.existsSync(path.join(dir, "index.db")), "index.db must exist");

            // The ingested row is present in the unified index (the
            // ingest-side digest invariant itself is covered by the
            // unified-storage suites).
            const db = UnifiedStore.open(path.join(dir, "index.db"));
            try {
                const row = db.getSessionRow(session.id);
                assert.ok(row, "session row must exist in the unified index");
            } finally {
                db.close();
            }

            // Restart: a fresh store resolves the session unified-first — no
            // envelope fallback leg exists at all — with folds intact.
            const reopen = new SessionStore({ dir, debounceMs: 1, enabled: true });
            try {
                const loaded = reopen.loadSync(session.id, { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
                assert.ok(loaded, "index-only session must load after restart");
                assert.ok(loaded.state.blocks.length > 0, "folds must survive the envelope-less round-trip");
                // Fold-state equality is the oracle Phase 3 promises:
                // cross-mode view digests deliberately differ (the unified
                // side keeps the raw tail, the envelope its bounded view),
                // so a cross-mode digest equality would be the wrong oracle.
                const rec = reopen as unknown as { shadow?: { viewFor(id: string): unknown } };
                const view = rec.shadow?.viewFor(session.id);
                assert.ok(view, "viewFor must resolve the ingested row");
                assert.equal(loaded.state.blocks.length, session.state.blocks.length, "block count must survive the index-only round-trip");
                assert.equal(loaded.state.nextBlockId, session.state.nextBlockId, "nextBlockId cursor must be intact");
                assert.equal(loaded.state.messageRefs.byRaw.size, session.state.messageRefs.byRaw.size, "messageRefs ledger must be intact");

                // Rollback story: replicas keep materializing JSON envelopes
                // (restore writes through the kernel store directly) — a
                // portable export even while the writer is off.
                const cp = await reopen.createReplica(session.id, { label: "json-writer-off-rollback" });
                const restored = await reopen.restoreReplica(cp.cp_id, { sessionId: session.id + "-rb" });
                assert.equal(restored.restoredFrom, session.id);
                const rb = envelopeFiles(dir).map((f) => path.basename(f));
                assert.ok(rb.some((n) => n.includes("-rb") || n.endsWith(".json")), "restore must write a JSON envelope for portability");
                reopen.cancelAll();
            } finally {
                reopen.closeQuietly();
            }
        } finally {
            rmBestEffort(dir);
            rmBestEffort(seed);
        }
    } finally {
        delete process.env.BILI_STORAGE_JSON_WRITER;
        process.env.BILI_STORAGE_UNIFIED = prevMode;
    }
});

test("jsonWriter=off is ignored under shadow (JSON stays the sole source of truth)", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "1"; // shadow
    process.env.BILI_STORAGE_JSON_WRITER = "off";
    try {
        assert.equal(storageStatusLabel(), "storage: shadow (dual-write dry-run → index.db)");
        const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-seed-"));
        const session = loadCorpusCase(seed, "folded", "corpus-folded", "anthropic");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-shadow-"));
        try {
            const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
            await store.writeNow(session);
            store.cancelAll();
            store.closeQuietly();
            assert.equal(envelopeFiles(dir).length, 1, "shadow mode must keep writing the envelope despite the off request");
            assert.ok(fs.existsSync(path.join(dir, "index.db")), "shadow sidecar still ingests");
        } finally {
            rmBestEffort(dir);
            rmBestEffort(seed);
        }
    } finally {
        delete process.env.BILI_STORAGE_JSON_WRITER;
        process.env.BILI_STORAGE_UNIFIED = prevMode;
    }
});

test("storage.jsonWriter file tier works via the config file (#2960)", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    delete process.env.BILI_STORAGE_UNIFIED; // let the file tier decide
    fs.writeFileSync(process.env.BILI_CONFIG_FILE!, JSON.stringify({ storage: { unified: "full", jsonWriter: "off" } }));
    try {
        assert.equal(storageStatusLabel(), "storage: full (unified-only, json envelope off)");
        const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-seed-"));
        const session = loadCorpusCase(seed, "tier2", "corpus-tier2", "chat");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-tier-"));
        try {
            const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
            await store.writeNow(session);
            store.cancelAll();
            store.closeQuietly();
            assert.equal(envelopeFiles(dir).length, 0, "file tier jsonWriter=off must suppress the envelope");
        } finally {
            rmBestEffort(dir);
            rmBestEffort(seed);
        }
    } finally {
        fs.writeFileSync(process.env.BILI_CONFIG_FILE!, "{}");
        process.env.BILI_STORAGE_UNIFIED = prevMode;
    }
});
