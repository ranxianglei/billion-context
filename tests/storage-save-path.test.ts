import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { markDirty, type Session } from "../src/session.ts";
import { planIngest, toLegacyLike } from "../src/storage/ingest.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";

/**
 * #3133: write-path cost fixes that survive the production save cycle.
 * The wire entry points hand the save path FRESHLY PARSED message objects
 * on every request (snapshotMessages), so the plan builder has no cross-save
 * memo — that is the documented state until the content/seq watermark design
 * lands (#3133). These regressions pin what must hold regardless:
 *  1. sampled verification — the read-back + double digest runs on the
 *     first ingest and then every VERIFY_EVERY_INGESTS-th; drift injected
 *     straight into the SQLite CAS is still caught on a sampled save.
 *  2. writerOff coalescing — a same-tick markDirty storm builds once per
 *     tick, not once per call.
 *  3. fresh-object stability — re-parsed (all-new identities) message
 *     arrays produce a byte-identical ingest plan; identity is content-keyed
 *     inside the plan, so a future watermark memo cannot change output.
 */

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: pin BOTH tiers so every
// leg controls its own mode explicitly (absent now defaults to full, #3818).
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-delta-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

function loadCorpusCase(name: string, id: string, protocol: string): Session {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-delta-seed-"));
    try {
        fs.cpSync(path.join(CORPUS_ROOT, name), path.join(seed, name), { recursive: true });
        const loader = new SessionStore({ dir: path.join(seed, name), debounceMs: 1, enabled: true });
        const loaded = loader.loadSync(id, { protocol, upstreamOrigin: "http://127.0.0.1:8199" });
        loader.cancelAll();
        loader.closeQuietly();
        assert.ok(loaded, `${name}: corpus loadSync returned null`);
        assert.ok((loaded.lastMessages?.length ?? 0) > 0, `${name}: corpus case must carry a non-empty tail`);
        return loaded;
    } finally {
        fs.rmSync(seed, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
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

interface ShadowStatsView {
    ingests: number;
    verifySamples: number;
    verifyOk: number;
    verifyDrift: number;
}

function shadowStats(store: SessionStore): ShadowStatsView {
    const shadow = (store as unknown as { shadow?: { stats: ShadowStatsView } }).shadow;
    assert.ok(shadow, "sidecar must be open in shadow mode");
    return shadow.stats;
}

const flushMicrotasks = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
};

test("fresh-object stability: re-parsed arrays produce a byte-identical plan", () => {
    const session = loadCorpusCase("folded", "corpus-folded", "anthropic");
    const legacy = toLegacyLike(session);
    const p1 = planIngest(legacy);
    // Simulate the production cycle: the next request re-parses the wire body
    // into an all-new object graph — fresh identities for every message,
    // kernel state (Maps) untouched because it never round-trips the wire.
    const reparsed = {
        ...legacy,
        lastMessages: JSON.parse(JSON.stringify(legacy.lastMessages)),
        pluginSnapshot: legacy.pluginSnapshot ? JSON.parse(JSON.stringify(legacy.pluginSnapshot)) : null,
    };
    const p2 = planIngest(reparsed);
    assert.deepEqual(p2, p1, "plan identity must be content-keyed, not object-keyed");
});

test("sampled verification: first ingest + every 20th read back; injected CAS drift is still caught", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "shadow";
    const session = loadCorpusCase("folded", "corpus-folded", "anthropic");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-delta-shadow-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        try {
            // 21 saves -> per-session ingests n=1..21 -> sampled at n=1 and n=21.
            for (let i = 0; i < 21; i++) await store.writeNow(session);
            const stats = shadowStats(store);
            assert.ok(stats.ingests >= 21, `expected at least 21 ingests, saw ${stats.ingests}`);
            assert.equal(stats.verifySamples, 2, "verify must run on ingest 1 and 21 only");
            assert.equal(stats.verifyOk, 2, "both sampled verifications must pass");
            assert.equal(stats.verifyDrift, 0);
        } finally {
            store.cancelAll();
            store.closeQuietly();
        }

        // Drift leg: tamper a CAS body AFTER a verified ingest. Re-ingests do
        // not repair it (putContent only bumps the refcount of a known hash),
        // so the next SAMPLED save (n=21) must report drift.
        const store2 = new SessionStore({ dir, debounceMs: 1, enabled: true });
        try {
            await store2.writeNow(session); // n=1: sampled, ok
            const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
            try {
                const row = conn
                    .prepare("SELECT content_hash FROM messages WHERE session_id = ? ORDER BY seq LIMIT 1")
                    .get(session.id) as { content_hash: string } | undefined;
                assert.ok(row, "messages row to tamper must exist");
                // Valid message JSON (a throw would be a failure, not drift).
                conn
                    .prepare("UPDATE content SET bytes = ? WHERE hash = ?")
                    .run(Buffer.from(JSON.stringify({ id: "tampered", role: "user", contentType: "text", text: "tampered" }), "utf8"), row.content_hash);
            } finally {
                conn.close();
            }
            for (let i = 0; i < 20; i++) await store2.writeNow(session); // n=2..21
            const stats = shadowStats(store2);
            assert.equal(stats.verifySamples, 2);
            assert.equal(stats.verifyOk, 1, "only the pre-tamper sample may pass");
            assert.equal(stats.verifyDrift, 1, "the sampled save at n=21 must catch the CAS drift");
        } finally {
            store2.cancelAll();
            store2.closeQuietly();
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevMode;
        rmBestEffort(dir);
    }
});

test("writerOff coalescing: a same-tick markDirty storm builds once per tick", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "off";
    const session = loadCorpusCase("folded", "corpus-folded", "anthropic");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-delta-writeroff-"));
    const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
    _setStoreForTest(store);
    try {
        const before = shadowStats(store).ingests;
        for (let i = 0; i < 5; i++) markDirty(session);
        // Armed, not yet built — the coalesced build runs at end of tick.
        assert.ok(store.hasPending(session.id), "armed writerOff build must count as pending");
        await flushMicrotasks();
        assert.equal(shadowStats(store).ingests - before, 1, "5 same-tick markDirty calls must build exactly once");
        assert.ok(!store.hasPending(session.id), "drained tick must leave nothing pending");

        // A second tick builds again — coalescing must not swallow future work.
        for (let i = 0; i < 5; i++) markDirty(session);
        await flushMicrotasks();
        assert.equal(shadowStats(store).ingests - before, 2, "a later tick must build again");
    } finally {
        store.cancelAll();
        store.closeQuietly();
        _setStoreForTest(new SessionStore({ enabled: false }));
        delete process.env.BILI_STORAGE_JSON_WRITER;
        process.env.BILI_STORAGE_UNIFIED = prevMode;
        rmBestEffort(dir);
    }
});

