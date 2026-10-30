import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";

/**
 * #4986: the sampled ingest read-back verify must not report DIGEST DRIFT
 * when the in-memory messageRefs key order diverges from the stored
 * refs-row order. The golden corpora are exactly that shape: byRef sits in
 * ref-number order while byRaw — which finishPlan freezes into row ord at
 * full ingest — sits in a different key order, so the row-rebuilt leg's
 * byRef starts at m00041 while the live leg's starts at m00001. Identical
 * content, different key insertion order. Pre-fix, every such save logged
 * an error-level DIGEST DRIFT and dropped the ingest watermark (full-tail
 * re-ingest next save); post-fix the parity digest compares contents, not
 * key insertion order (#3407/#3113 philosophy).
 */

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4986-hermetic-"));
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

/** Windows: best-effort delete, swallowed on persistent EBUSY/EPERM. */
function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

test("ingest verify ignores messageRefs key-order divergence (#4986)", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4986-seed-"));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4986-store-"));
        try {
            const session = loadCorpusCase(seed, "folded", "corpus-folded", "anthropic");

            // Precondition: the corpus exhibits the divergent shape — the
            // row order (byRaw key order, what finishPlan stores as ord)
            // projects byRef to a DIFFERENT key sequence than the live map's
            // own key order. Without this the test would pass vacuously.
            const byRaw = session.state.messageRefs.byRaw;
            const byRef = session.state.messageRefs.byRef;
            const rowOrderProjectedRefs = Object.keys(byRaw)
                .map((rawId) => byRaw[rawId])
                .filter((ref) => ref !== "BLOCKED" && byRef[ref] !== undefined);
            assert.notEqual(
                Object.keys(byRef).join("\u0000"),
                rowOrderProjectedRefs.join("\u0000"),
                "folded corpus must carry byRef key order != stored refs-row order",
            );

            const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
            await store.writeNow(session);
            const shadow = (store as unknown as {
                shadow?: { stats: { verifySamples: number; verifyOk: number; verifyDrift: number } };
            }).shadow;
            assert.ok(shadow, "full mode must open the unified sidecar");
            // The FIRST ingest always samples the read-back verify...
            assert.equal(shadow.stats.verifySamples, 1, "first ingest must sample the read-back verify");
            // ...and key-order-only divergence is not drift.
            assert.equal(shadow.stats.verifyDrift, 0, "#4986: order-only ref-map divergence must not report DIGEST DRIFT");
            assert.equal(shadow.stats.verifyOk, 1);
            store.cancelAll();
        } finally {
            rmBestEffort(dir);
            rmBestEffort(seed);
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevMode;
        rmBestEffort(hermetic);
    }
});
