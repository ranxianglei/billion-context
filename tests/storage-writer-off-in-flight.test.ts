import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { UnifiedStore } from "../src/storage/store.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-inflight-hermetic-"));
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

function hasRow(dir: string, id: string): boolean {
    const db = UnifiedStore.open(path.join(dir, "index.db"));
    try {
        return db.getSessionRow(id) !== undefined && db.getSessionRow(id) !== null;
    } finally {
        db.close();
    }
}

test("jsonWriter=off: a save armed during a request lands after the request releases the session, not mid-request", async () => {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-inflight-seed-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-inflight-"));
    try {
        fs.cpSync(path.join(CORPUS_ROOT, "folded"), path.join(seed, "folded"), { recursive: true });
        const loader = new SessionStore({ dir: path.join(seed, "folded"), debounceMs: 1, enabled: true });
        const session = loader.loadSync("corpus-folded", { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
        loader.cancelAll();
        loader.closeQuietly();
        assert.ok(session);

        const store = new SessionStore({ dir, debounceMs: 20, enabled: true });
        try {
            session.inFlight = 1;
            store.scheduleSave(session);
            await sleep(120);
            assert.equal(store.hasPending(session.id), true, "the build must stay armed while the request holds the session");
            assert.equal(fs.existsSync(path.join(dir, "index.db")) && hasRow(dir, session.id), false, "no index build may run mid-request");

            session.inFlight = 0;
            await sleep(200);
            assert.equal(store.hasPending(session.id), false, "the armed build must land once the request released the session");
            assert.equal(hasRow(dir, session.id), true, "the session row must be in the index after release");
            assert.equal(await store.afterNextFlush(session.id), true);
        } finally {
            store.cancelAll();
            store.closeQuietly();
        }
    } finally {
        rmBestEffort(dir);
        rmBestEffort(seed);
    }
});

test("jsonWriter=off: an idle session still saves right away", async () => {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-idle-seed-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jw-idle-"));
    try {
        fs.cpSync(path.join(CORPUS_ROOT, "folded"), path.join(seed, "folded"), { recursive: true });
        const loader = new SessionStore({ dir: path.join(seed, "folded"), debounceMs: 1, enabled: true });
        const session = loader.loadSync("corpus-folded", { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
        loader.cancelAll();
        loader.closeQuietly();
        assert.ok(session);
        const store = new SessionStore({ dir, debounceMs: 5000, enabled: true });
        try {
            session.inFlight = 0;
            store.scheduleSave(session);
            await sleep(50);
            assert.equal(store.hasPending(session.id), false);
            assert.equal(hasRow(dir, session.id), true);
        } finally {
            store.cancelAll();
            store.closeQuietly();
        }
    } finally {
        rmBestEffort(dir);
        rmBestEffort(seed);
    }
});
