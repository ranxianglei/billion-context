import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { snapshotMessages } from "../src/session.ts";
import type { CoreMessage } from "acp-kernel";

/**
 * #6780 P0: with the pure-SQLite default (#6480, JSON writer off) the prepare
 * phase runs TWO full unified-index ingests per turn BEFORE the model call —
 * the synchronous durability ingest (#6326, ingestRowsNow) and the coalesced
 * writer-off save armed by prepare's own markDirty (5a80e2b8 removed the
 * debounce on this lane). The second one is a no-op delta (the watermark was
 * already advanced) that still pays the three-table full reads, the
 * whole-record re-serialization and a second commit round-trip — ~1.3s of
 * #6780's pre-forward cost on the reporter's 23k-message session.
 *
 * Pinned here (writer-off mode, exactly what the prepare phase does):
 *   1. When nothing changed between ingestRowsNow and the coalesced build,
 *      the build SKIPS the heavy legs — the sidecar record() is not called a
 *      second time — but the settle protocol still lands (lastSaveLanded).
 *   2. When the state DID change after the arm (re-snapshot + markDirty),
 *      the full build still runs — the arm is a hint, never a commitment.
 */

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: pin BOTH tiers so every
// leg controls its own mode explicitly (absent now defaults to full, #3818).
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6780-hermetic-"));
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

/** Windows: an ephemeral stray handle must not fail CI — best-effort delete
 *  with bounded retries, swallowed on persistent EBUSY/EPERM. */
function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

test("#6780 P0: the writer-off coalesced save skips the duplicate ingest when ingestRowsNow already covered this tick's state", async () => {
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    const prevWriter = process.env.BILI_STORAGE_JSON_WRITER;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "off"; // no envelope — the writer-off coalesced lane
    try {
        const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6780-seed-"));
        const session = loadCorpusCase(seed, "folded", "corpus-folded", "anthropic");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6780-dedup-"));
        try {
            const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
            // Exactly what the prepare phase does before the model call: the
            // synchronous durability ingest, then the plain markDirty.
            store.ingestRowsNow(session);

            const anyStore = store as unknown as {
                shadow: { record: (...args: unknown[]) => unknown };
                scheduleSave: (s: typeof session) => void;
                lastSaveLanded: Map<string, boolean>;
            };
            let ingests = 0;
            const realRecord = anyStore.shadow.record.bind(anyStore.shadow);
            anyStore.shadow.record = (...args: unknown[]) => { ingests++; return realRecord(...args); };

            // prepare's own markDirty (bump + scheduleSave — session.markDirty
            // would hit the module-singleton store, not this one).
            session.revisionEpoch = (session.revisionEpoch ?? 0) + 1;
            anyStore.scheduleSave(session);
            // The coalesced build runs in a microtask.
            await new Promise((r) => setTimeout(r, 50));

            assert.equal(ingests, 0, "state unchanged since ingestRowsNow — the coalesced save must NOT re-run the full rebuild + full delta-ingest");
            assert.equal(anyStore.lastSaveLanded.get(session.id), true, "the settle protocol must still land on the skip path");

            // Counterfactual: the state changes AFTER the arm (a re-snapshot
            // swaps lastMessages without bumping the epoch; the follow-up
            // markDirty bumps it) → the full build must still run.
            snapshotMessages(session, [...(session.lastMessages ?? []), { id: "m-dedup-probe", role: "user", contentType: "text", text: "probe" } as unknown as CoreMessage]);
            session.revisionEpoch = (session.revisionEpoch ?? 0) + 1;
            anyStore.scheduleSave(session);
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(ingests, 1, "a changed state must still take the full build (the arm never commits)");

            store.cancelAll();
            store.closeQuietly();
        } finally {
            rmBestEffort(dir);
            rmBestEffort(seed);
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevUnified;
        process.env.BILI_STORAGE_JSON_WRITER = prevWriter;
    }
});
