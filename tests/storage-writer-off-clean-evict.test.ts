import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-clean-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_STORAGE_JSON_WRITER = "off";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir is harmless */
    }
}

let records = 0;
const originalRecord = UnifiedShadow.prototype.record;
UnifiedShadow.prototype.record = function (this: UnifiedShadow, ...args: Parameters<UnifiedShadow["record"]>): void {
    records++;
    originalRecord.apply(this, args);
};

test("jsonWriter=off: flushSync of a session whose index copy already covers its revision does not rebuild it", async () => {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-clean-seed-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-clean-"));
    try {
        fs.cpSync(path.join(CORPUS_ROOT, "folded"), path.join(seed, "folded"), { recursive: true });
        const loader = new SessionStore({ dir: path.join(seed, "folded"), debounceMs: 1, enabled: true });
        const session = loader.loadSync("corpus-folded", { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
        loader.cancelAll();
        loader.closeQuietly();
        assert.ok(session);

        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        try {
            session.inFlight = 0;
            session.revisionEpoch = (session.revisionEpoch ?? 0) + 1;
            assert.equal(store.flushSync(session), true, "first flush builds the index copy");
            const first = records;
            assert.ok(first > 0, "the first flush must record the session");

            await sleep(30);
            assert.equal(store.flushSync(session), true, "a clean flush still reports success (eviction may proceed)");
            assert.equal(records, first, "an unchanged session must not be rebuilt and re-ingested");

            await sleep(30);
            session.revisionEpoch = (session.revisionEpoch ?? 0) + 1;
            assert.equal(store.flushSync(session), true);
            assert.ok(records > first, "a newer revision must be written");
        } finally {
            store.cancelAll();
            store.closeQuietly();
        }
    } finally {
        rmBestEffort(dir);
        rmBestEffort(seed);
    }
});
