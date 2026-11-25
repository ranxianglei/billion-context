// Run with: node --max-old-space-size=512 --expose-gc --import tsx scripts/bench-bounded-boot-index.mjs [files-per-root]
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const count = Number(process.argv[2] ?? 10_000);
if (!Number.isSafeInteger(count) || count < 1) throw new Error("files-per-root must be a positive safe integer");
const root = mkdtempSync(path.join(tmpdir(), "bili-boot-index-bench-"));
const dir = path.join(root, "sessions");
let store;
try {
    process.env.BILI_SESSIONS_DIR = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_BACKEND = "sqlite";
    process.env.BILI_PERSIST_ZSTD = "0";
    delete process.env.BILI_CONFIG_FILE;
    delete process.env.BILI_ENCRYPTION_KEY;
    for (const kind of ["DATA", "STATE", "CONFIG", "CACHE"]) {
        process.env[`XDG_${kind}_HOME`] = path.join(root, kind.toLowerCase());
        mkdirSync(process.env[`XDG_${kind}_HOME`], { recursive: true });
    }
    const { SessionStore, relPathFor } = await import("../src/persist.ts");
    for (const [kind, base] of [["hot", dir], ["cold", `${dir}-cold`]]) {
        mkdirSync(path.join(base, "_unknown"), { recursive: true });
        for (let i = 0; i < count; i++) {
            const id = `bench-${kind}-${i}`;
            const payload = {
                version: 3, savedAt: 1000 + i, id, meta: { label: id },
                state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} } },
                blockContents: { b1: { one: null, full: { text: `original-${id}`, count: 1 } } },
                stats: { requests: i + 1 }, createdAt: 1000 + i,
            };
            writeFileSync(path.join(base, relPathFor(id)), JSON.stringify({ version: 3, savedAt: payload.savedAt, id, payload }));
        }
        writeFileSync(path.join(base, "_unknown", "ignored.content-store.json"), "{}");
    }
    let indexed = 0;
    store = new SessionStore({ dir, enabled: true, debounceMs: 0, log: (_level, message) => {
        const match = /^\[persist\] indexed (\d+) state files;/.exec(message);
        if (match) indexed = Number(match[1]);
    } });
    assert.ok(store.replicasAvailable(), "benchmark requires the SQLite sidecar");
    global.gc?.();
    const start = performance.now();
    const loaded = await store.boot({ maxSessions: 0, maxBytes: 64 * 1024 * 1024 });
    const bootMs = performance.now() - start;
    assert.equal(loaded.size, 0);
    assert.equal(indexed, count * 2, "both roots must be indexed and content-store companions excluded");
    await store.backgroundScanComplete();
    for (const kind of ["hot", "cold"]) {
        for (const i of new Set([0, count - 1])) {
            const id = `bench-${kind}-${i}`;
            const session = store.loadSync(id);
            assert.equal(session?.stats.requests, i + 1);
            assert.equal(session?.blockContents.get("b1")?.full?.text, `original-${id}`);
        }
    }
    console.log(JSON.stringify({
        files_per_root: count,
        indexed_files: indexed,
        warm_sessions: loaded.size,
        boot_ms: bootMs,
        max_rss_kib: process.resourceUsage().maxRSS,
        node: process.version,
    }));
} finally {
    await store?.backgroundScanComplete();
    store?.closeQuietly();
    rmSync(root, { recursive: true, force: true });
}
