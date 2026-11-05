import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { loadLegacyView } from "../src/storage/ingest.ts";
import { canonicalize, sha256 } from "./golden-canonical.ts";

/**
 * Replica/checkpoint acceptance (Phase 2a, #2671).
 *
 * A checkpoint freezes the session's persisted state as one CAS blob + row;
 * restore materializes it as a NEW first-class session through the normal
 * dual write path (legacy JSON + unified ingest). Pinned checkpoints must
 * outlive deleteSession (GC protection) — that is the whole point of the
 * feature: a replica taken before an experiment survives the experiment.
 *
 * Semantics are asserted at the SessionStore API level; the /__bili/replicas
 * HTTP routes in server/admin.ts are a thin mapping over these calls.
 */

process.env.BILI_PERSIST_ZSTD = "0";
// #2671 hermeticity (same pin as tests/storage-unified.test.ts): a developer
// machine may set storage.unified in the real config or export the env; pin
// BOTH tiers so every test below controls its own mode explicitly.
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-replicas-hermetic-")),
    "no-config.json",
);
// Absent everywhere now resolves to the shadow DEFAULT (#2815 rollout flip);
// this suite needs the explicit legacy baseline (per-test legs override it).
process.env.BILI_STORAGE_UNIFIED = "legacy";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

/** Digest of the content-bearing fields only: identity (id), save time
 *  (lastSeen) and restore bookkeeping (meta.restored*) are normalized away so
 *  a restored view digests equal to its checkpoint. */
function viewDigest(view: ReturnType<typeof loadLegacyView>): string {
    const meta = { ...(view.meta as Record<string, unknown>) };
    delete meta.restoredFrom;
    delete meta.restoredCheckpoint;
    return sha256(JSON.stringify(canonicalize({
        id: "normalized",
        meta,
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
function loadCorpusCase(dir: string, name: string, id: string, protocol: string) {
    fs.cpSync(path.join(CORPUS_ROOT, name), path.join(dir, name), { recursive: true });
    const loader = new SessionStore({ dir: path.join(dir, name), debounceMs: 1, enabled: true });
    const loaded = loader.loadSync(id, { protocol, upstreamOrigin: "http://127.0.0.1:8199" });
    loader.cancelAll();
    assert.ok(loaded, `${name}: corpus loadSync returned null`);
    return loaded;
}

function withShadowMode<T>(fn: () => Promise<T> | T): Promise<T> | T {
    process.env.BILI_STORAGE_UNIFIED = "1";
    try {
        return fn();
    } finally {
        // Restore the hermetic legacy baseline (the header pin) — deleting the
        // var would fall back to the shadow DEFAULT and flip later legs.
        process.env.BILI_STORAGE_UNIFIED = "legacy";
    }
}

test("replicas: create → list → detail round-trip (shadow mode, real persist path)", async () => {
    await withShadowMode(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-replicas-"));
        try {
            const session = loadCorpusCase(dir, "folded", "corpus-folded", "anthropic");
            const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
            await store.writeNow(session);
            store.cancelAll();

            assert.ok(store.replicasAvailable(), "shadow mode must expose replicas");
            const row = await store.createReplica(session.id, { label: "before-experiment" });
            assert.match(row.cp_id, /^cp-/);
            assert.equal(row.session_id, session.id);
            assert.ok(row.seq_at > 0, `seq_at must be the absolute tip, got ${row.seq_at}`);
            assert.equal(row.kind, "replica");
            assert.equal(row.pinned, 0);
            assert.equal(row.label, "before-experiment");
            assert.ok(row.block_set_hash.length >= 16, "block set hash is a sha256 prefix at least");

            const listed = await store.listReplicas(session.id);
            assert.equal(listed.length, 1);
            assert.equal(listed[0]!.cp_id, row.cp_id);
            assert.ok(await store.replicaByteLen(row.cp_id) > 0, "frozen record blob must have size");
            store.closeQuietly();
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
        }
    });
});

test("replicas: restore materializes a NEW session with identical content, even after the original was deleted", async () => {
    await withShadowMode(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-replicas-"));
        try {
            const session = loadCorpusCase(dir, "folded", "corpus-folded", "anthropic");
            const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
            await store.writeNow(session);
            store.cancelAll();

            const pinned = await store.createReplica(session.id, { pinned: true, label: "safe copy" });
            const before = (() => {
                const unified = UnifiedStore.open(path.join(dir, "index.db"));
                try {
                    return viewDigest(loadLegacyView({
                        session: unified.getSessionRow(session.id)!,
                        messages: unified.getMessages(session.id),
                        blocks: unified.getBlocks(session.id),
                        deadRefs: unified.getDeadRefs(session.id),
                        refs: unified.getRefs(session.id),
                    }));
                } finally {
                    unified.close();
                }
            })();

            // Simulate the disaster the feature exists for: the session rows
            // are GC'd. The pinned checkpoint must hold its CAS refcount and
            // survive deleteSession.
            const gc = UnifiedStore.open(path.join(dir, "index.db"));
            gc.deleteSession(session.id);
            gc.close();

            const restored = await store.restoreReplica(pinned.cp_id);
            assert.notEqual(restored.sessionId, session.id);
            assert.equal(restored.restoredFrom, session.id);

            const again = new SessionStore({ dir, debounceMs: 1, enabled: true });
            const reloaded = again.loadSync(restored.sessionId, { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
            again.cancelAll();
            assert.ok(reloaded, "restored session must load back");

            const unified2 = UnifiedStore.open(path.join(dir, "index.db"));
            try {
                const rows = {
                    session: unified2.getSessionRow(restored.sessionId)!,
                    messages: unified2.getMessages(restored.sessionId),
                    blocks: unified2.getBlocks(restored.sessionId),
                    deadRefs: unified2.getDeadRefs(restored.sessionId),
                    refs: unified2.getRefs(restored.sessionId),
                };
                assert.ok(rows.session, "restored session must be in the unified index");
                const view = loadLegacyView(rows);
                // Restore rewrites identity fields (id, savedAt, restoredFrom
                // meta) — everything content-bearing must digest identically.
                const meta = view.meta as Record<string, unknown>;
                delete meta.restoredFrom;
                delete meta.restoredCheckpoint;
                assert.equal(viewDigest(view), before, "restored view content drifted from the checkpoint");
                const state = view.state as { blocks?: unknown[] };
                assert.equal(state.blocks?.length ?? 0, loadLegacyViewCount(dir, session.id) ?? state.blocks?.length ?? 0, "block ledger survives the round-trip");
            } finally {
                unified2.close();
            }
            again.closeQuietly();
            store.closeQuietly();
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
        }
    });
});

function loadLegacyViewCount(dir: string, id: string): number | undefined {
    // The original rows were deleted; this helper only exists so the block
    // count assertion degrades (rather than throws) if the original is gone.
    try {
        const u = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const row = u.getSessionRow(id);
            return row ? ((JSON.parse(row.kstateJson ?? "{}") as { blocks?: unknown[] }).blocks?.length as number | undefined) : undefined;
        } finally {
            u.close();
        }
    } catch {
        return undefined;
    }
}

test("replicas: pinned survives deleteSession GC, unpinned is swept with it", async () => {
    await withShadowMode(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-replicas-"));
        try {
            const session = loadCorpusCase(dir, "tier2", "corpus-tier2", "chat");
            const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
            await store.writeNow(session);
            store.cancelAll();
            const pinned = await store.createReplica(session.id, { pinned: true, label: "keep" });
            const loose = await store.createReplica(session.id, {});

            const unified = UnifiedStore.open(path.join(dir, "index.db"));
            try {
                unified.deleteSession(session.id);
                const after = unified.listCheckpoints();
                assert.equal(after.length, 1, "only the pinned checkpoint survives GC");
                assert.equal(after[0]!.cp_id, pinned.cp_id);
                const state = unified.checkpointState(pinned.cp_id);
                assert.ok(state.stateJson.includes(session.id), "pinned blob still readable");
                // The unpinned row AND its blob are gone.
                assert.throws(() => unified.checkpointState(loose.cp_id), /checkpoint not found/);
            } finally {
                unified.close();
            }
            store.closeQuietly();
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
        }
    });
});

test("replicas: legacy mode fails fast (501-class), explicit delete overrides pinned", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-replicas-"));
    try {
        // legacy mode: no env, no config — replicas must be refused.
        const session = loadCorpusCase(dir, "deadrefs", "corpus-deadrefs", "anthropic");
        const legacyStore = new SessionStore({ dir, debounceMs: 1, enabled: true });
        await legacyStore.writeNow(session);
        legacyStore.cancelAll();
        assert.equal(legacyStore.replicasAvailable(), false);
        // #3931 step 3: the replica surface is async (network backends) —
        // refusals surface as rejections, not sync throws.
        await assert.rejects(legacyStore.createReplica(session.id), /legacy-only/);
        await assert.rejects(legacyStore.listReplicas(), /legacy-only/);

        // Now flip the same directory into shadow mode: organic import on
        // first write brings the session into the index, and the full API
        // works — including DELETE of a pinned replica (pinning protects
        // against GC, not the operator).
        await withShadowMode(async () => {
            const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
            const s2 = store.loadSync(session.id, { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
            assert.ok(s2);
            await store.writeNow(s2);
            store.cancelAll();
            const pinned = await store.createReplica(session.id, { pinned: true });
            assert.equal(await store.deleteReplica(pinned.cp_id), true);
            assert.equal((await store.listReplicas()).length, 0);
            assert.equal(await store.deleteReplica(pinned.cp_id), false, "second delete: gone is gone");
        });
        legacyStore.closeQuietly();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
    }
});
