import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { UnifiedStore } from "../src/storage/store.ts";

/**
 * #2690 review-fix acceptance (storage-review-fixes).
 *
 * Owner review (issuecomment-6108173553) blocking items, asserted at the
 * SessionStore/UnifiedStore level:
 *   1. refs rows are authoritatively replaced per ingest — a renumbered
 *      byRaw map (native compaction drops a front key ⇒ surviving keys shift
 *      ords) must not trip the (session_id, ord) PK and must leave no ghost
 *      rows behind.
 *   2. blocks rows are authoritatively replaced — a block that leaves the
 *      incoming state (destroyed substrate) is deleted, and a later save of
 *      the same state must not resurrect it (upsert-only zombies, #2695).
 *   3. a corrupt index.db must degrade to legacy-only (warn + shadow null),
 *      never brick the proxy on construction or on save/load.
 *   4. restoreReplica refuses to overwrite a live session id (409 upstream).
 *   5. restoreReplica materializes the content-store sidecar for the restored
 *      id so CCR originals survive the next live save + restart cycle
 *      (buildRecord drops forkContentStore without a fork receipt).
 */

process.env.BILI_PERSIST_ZSTD = "0";
// #2671 hermeticity (same pin as tests/storage-unified.test.ts): a developer
// machine may set storage.unified in the real config or export the env; pin
// BOTH tiers so every test below controls its own mode explicitly.
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-review-fix-hermetic-")),
    "no-config.json",
);
// Absent everywhere now resolves to the shadow DEFAULT (#2815 rollout flip);
// this suite needs the explicit legacy baseline — per-test legs override it.
process.env.BILI_STORAGE_UNIFIED = "legacy";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

function loadCorpusCase(dir: string, name: string, id: string, protocol: string) {
    fs.cpSync(path.join(CORPUS_ROOT, name), path.join(dir, name), { recursive: true });
    const loader = new SessionStore({ dir: path.join(dir, name), debounceMs: 1, enabled: true });
    const loaded = loader.loadSync(id, { protocol, upstreamOrigin: "http://127.0.0.1:8199" });
    loader.cancelAll();
    assert.ok(loaded, `${name}: corpus loadSync returned null`);
    return loaded;
}

async function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
    process.env.BILI_STORAGE_UNIFIED = mode;
    try {
        return await fn();
    } finally {
        // Restore the hermetic legacy baseline — deleting would land on the
        // shadow DEFAULT and flip later legs.
        process.env.BILI_STORAGE_UNIFIED = "legacy";
    }
}

function rmBestEffort(dir: string) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
}

test("review 1: renumbered refs re-ingest without PK conflicts and leave no ghost rows", async () => {
    await withMode("shadow", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-review-refs-"));
        try {
            const session = loadCorpusCase(dir, "folded", "corpus-folded", "anthropic");
            const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
            await store.writeNow(session);
            store.cancelAll();

            const before = UnifiedStore.open(path.join(dir, "index.db"));
            const refsBefore = before.getRefs(session.id);
            before.close();
            assert.ok(refsBefore.length > 1, "corpus must carry a multi-entry ref ledger");

            // Simulate the reviewer's scenario: the front key of the byRaw map
            // vanishes (DSH native compaction drops a resent message), so every
            // surviving key shifts down one ord. Old code: INSERT OR REPLACE on
            // (session_id, raw_id) left the moved rows colliding on (session_id,
            // ord) → UNIQUE constraint failed → 3-strike self-disable.
            const byRaw = session.state.messageRefs.byRaw as Record<string, string>;
            const firstKey = Object.keys(byRaw)[0]!;
            delete byRaw[firstKey];

            await store.writeNow(session);
            store.closeQuietly();

            const after = UnifiedStore.open(path.join(dir, "index.db"));
            const refsAfter = after.getRefs(session.id);
            after.close();
            assert.equal(refsAfter.length, Object.keys(byRaw).length, "ghost ref rows must be gone");
            assert.ok(refsAfter.every((r) => byRaw[r.rawId] === r.ref), "refs rows must mirror the live byRaw map exactly");
            assert.deepEqual(refsAfter.map((r) => r.ord), refsAfter.map((_, i) => i), "ords must be compact 0..n-1");
            assert.ok(!refsAfter.some((r) => r.rawId === firstKey), "the dropped raw id must not linger");
        } finally {
            rmBestEffort(dir);
        }
    });
});

test("review 2: destroyed-substrate blocks are deleted and cannot resurrect on a later save", async () => {
    await withMode("shadow", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-review-blocks-"));
        try {
            const session = loadCorpusCase(dir, "tier2", "corpus-tier2", "chat");
            const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
            await store.writeNow(session);
            store.cancelAll();

            const victim = session.state.blocks[0]!;
            assert.ok(session.state.blocks.length > 1, "tier2 corpus must carry more than one block");
            session.state.blocks = session.state.blocks.filter((b) => b.blockId !== victim.blockId);
            session.blockContents.delete(victim.blockId);

            await store.writeNow(session);
            let unified = UnifiedStore.open(path.join(dir, "index.db"));
            assert.ok(!unified.getBlocks(session.id).some((b) => b.blockId === victim.blockId), "destroyed block row must be deleted");
            unified.close();

            // Zombie guard: a follow-up save of the SAME (still block-less)
            // state must not resurrect the row via upsert-only paths (#2695).
            await store.writeNow(session);
            store.closeQuietly();
            unified = UnifiedStore.open(path.join(dir, "index.db"));
            assert.ok(!unified.getBlocks(session.id).some((b) => b.blockId === victim.blockId), "block must stay dead after a second save");
            unified.close();
        } finally {
            rmBestEffort(dir);
        }
    });
});

test("review 3: corrupt index.db degrades to legacy-only instead of bricking the proxy", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-review-corrupt-"));
    try {
        const session = loadCorpusCase(dir, "folded", "corpus-folded", "anthropic");
        fs.writeFileSync(path.join(dir, "index.db"), Buffer.concat([
            Buffer.from("SQLite format 3\0"),
            crypto.randomBytes(4096),
        ]));

        process.env.BILI_STORAGE_UNIFIED = "shadow";
        let store: SessionStore;
        try {
            store = new SessionStore({ dir, debounceMs: 1, enabled: true }); // must NOT throw
            await store.writeNow(session);
            const reloaded = store.loadSync(session.id, { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
            assert.ok(reloaded, "legacy fallback load must succeed");
            assert.equal(store.replicasAvailable(), false, "shadow is unavailable while degraded");
            await store.flushAll(); // flush the JSON record to disk (closeQuietly only cancels)
        } finally {
            store!.closeQuietly();
            delete process.env.BILI_STORAGE_UNIFIED;
        }

        // And a later process (fresh handle) still works the same way.
        process.env.BILI_STORAGE_UNIFIED = "shadow";
        try {
            const again = new SessionStore({ dir, debounceMs: 1, enabled: true });
            assert.ok(again.loadSync(session.id, { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" }), "second process must load via legacy");
            again.closeQuietly();
        } finally {
            delete process.env.BILI_STORAGE_UNIFIED;
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reviews 4+5: restore refuses live-id overwrite and materializes the CCR sidecar", async () => {
    await withMode("shadow", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-review-restore-"));
        try {
            const session = loadCorpusCase(dir, "ccr", "corpus-ccr", "responses");
            // Graft a content store so the replica freezes real CCR payloads
            // (same graft as tests/export-jsonl.test.ts).
            session.contentStore = {
                version: 1,
                byHash: { h1: "THE ORIGINAL LONG TEXT" },
                byRef: { m00001: { hash: "h1", rawId: "raw-1", kind: "file read", tokens: 5, chars: 22, head: "ORIGINAL HEAD" } },
            } as typeof session.contentStore;
            session.contentStoreDirty = true;
            const store = new SessionStore({ dir: path.join(dir, "ccr"), debounceMs: 1, enabled: true });
            await store.writeNow(session);
            store.cancelAll();

            const replica = await store.createReplica(session.id, { pinned: true, label: "safe copy" });

            // Review 6 (HTTP half): caller-chosen id that already exists must
            // throw (admin maps to 409), never silently clobber a live session.
            await assert.rejects(
                store.restoreReplica(replica.cp_id, { sessionId: session.id }),
                /already exists/,
            );

            const out = await store.restoreReplica(replica.cp_id);
            assert.ok(out.sessionId.startsWith("restore-"), "default restore target is a fresh id");
            store.closeQuietly();

            // Review 6 (durability half): the restored id must own a materialized
            // content-store sidecar — the record alone loses forkContentStore on
            // the next live save (no fork receipt), so the sidecar is the layer
            // that survives save/restart cycles. Prove it through the REAL load
            // path (fresh handle, no cache): loadSync + loadContentStore must
            // hand back the stored CCR originals.
            const fresh = new SessionStore({ dir: path.join(dir, "ccr"), debounceMs: 1, enabled: true });
            const restored = fresh.loadSync(out.sessionId, { protocol: "responses", upstreamOrigin: "http://127.0.0.1:8199" });
            assert.ok(restored, "restored session must reload from disk");
            const ccr = fresh.loadContentStore(restored);
            assert.ok(ccr, "restored session must resolve a content-store sidecar");
            assert.equal(ccr!.byHash.h1, "THE ORIGINAL LONG TEXT", "CCR originals must survive the restore");
            fresh.closeQuietly();
        } finally {
            rmBestEffort(dir);
        }
    });
});
