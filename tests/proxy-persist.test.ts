import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/persist.ts";
import { createInitialState } from "acp-kernel";
import type { Session, BlockContent } from "../src/session.ts";

function makeSession(id: string): Session {
    return {
        id,
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        requests: 0,
        condensedToolResults: 0,
        tokensSaved: 0,
        blockContents: new Map(),
    };
}

function withTempStore<T>(name: string, fn: (store: SessionStore, dir: string) => Promise<T> | T): Promise<T> {
    return test(name, async () => {
        const dir = mkdtempSync(join(tmpdir(), "bili-persist-"));
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        try {
            await fn(store, dir);
        } finally {
            store.cancelAll();
            rmSync(dir, { recursive: true, force: true });
        }
    }) as unknown as Promise<T>;
}

async function settle(ms = 30): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

await withTempStore("writeNow round-trips state + blockContents", async (store, dir) => {
    const s = makeSession("sess-1");
    s.requests = 42;
    s.tokensSaved = 1234;
    s.state.nextBlockId = 7;
    const content: BlockContent = { one: { text: "one-text", count: 3 }, full: { text: "full-text", count: 9 } };
    s.blockContents.set("b1", content);

    await store.writeNow(s);

    const files = readdirSync(dir);
    assert.ok(files.some((f) => f.endsWith(".json")), "a session json file was written");
    const raw = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    assert.equal(raw.id, "sess-1");
    assert.equal(raw.requests, 42);
    assert.equal(raw.tokensSaved, 1234);
    assert.equal(raw.state.nextBlockId, 7);
    assert.deepEqual(raw.blockContents.b1, { one: { text: "one-text", count: 3 }, full: { text: "full-text", count: 9 } });
});

await withTempStore("loadSync restores a persisted session", async (store) => {
    const s = makeSession("sess-2");
    s.tokensSaved = 999;
    s.state.nextBlockId = 3;
    await store.writeNow(s);

    const loaded = store.loadSync("sess-2");
    assert.ok(loaded, "loaded from disk");
    assert.equal(loaded!.id, "sess-2");
    assert.equal(loaded!.tokensSaved, 999);
    assert.equal(loaded!.state.nextBlockId, 3);
    assert.ok(loaded!.blockContents instanceof Map, "blockContents restored as a Map");
});

await withTempStore("loadSync returns null for unknown id", async (store) => {
    assert.equal(store.loadSync("does-not-exist"), null);
});

await withTempStore("scheduleSave debounces and eventually writes", async (store, dir) => {
    const s = makeSession("debounce-1");
    s.requests = 1;
    store.scheduleSave(s);
    s.requests = 2; // mutate again before timer fires → should coalesce
    store.scheduleSave(s);
    s.requests = 3;
    store.scheduleSave(s);
    await settle();
    assert.equal(readdirSync(dir).length, 1, "exactly one write happened");
    const loaded = store.loadSync("debounce-1");
    assert.equal(loaded!.requests, 3, "latest value persisted");
});

await withTempStore("loadAll bulk-loads every session from disk", async (store) => {
    await store.writeNow(makeSession("a"));
    await store.writeNow(makeSession("b"));
    await store.writeNow(makeSession("c"));
    const all = await store.loadAll();
    assert.equal(all.size, 3);
    assert.ok(all.has("a") && all.has("b") && all.has("c"));
});

await withTempStore("flushSync writes immediately (for eviction)", async (store, dir) => {
    const s = makeSession("evict-1");
    s.tokensSaved = 555;
    store.flushSync(s);
    assert.equal(readdirSync(dir).length, 1);
    assert.equal(store.loadSync("evict-1")!.tokensSaved, 555);
});

await withTempStore("flushAll flushes all pending debounce writes", async (store) => {
    const a = makeSession("fa-1");
    const b = makeSession("fa-2");
    store.scheduleSave(a);
    store.scheduleSave(b);
    await store.flushAll([a, b]);
    assert.ok(store.loadSync("fa-1"));
    assert.ok(store.loadSync("fa-2"));
});

await withTempStore("corrupt file is skipped by loadAll (no crash)", async (store, dir) => {
    const { writeFileSync } = await import("node:fs");
    // Write a valid file via the store so the filename matches the body id
    // (loadAll verifies fileNameFor(id) === name).
    await store.writeNow(makeSession("good"));
    writeFileSync(join(dir, "corrupt.json"), "{ this is not valid json");
    const all = await store.loadAll();
    assert.equal(all.size, 1);
    assert.ok(all.has("good"));
});

await withTempStore("collision-prone ids do NOT share a file (hashed names)", async (store, dir) => {
    // A naive sanitizer would map both to "a_b" → one file, cross-contamination.
    const s2 = makeSession("a_b");
    const s3 = makeSession("a/b");
    await store.writeNow(s2);
    await store.writeNow(s3);
    const jsonFiles = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(jsonFiles.length, 2, "distinct ids → distinct files");
    assert.ok(store.loadSync("a_b")!.id === "a_b");
    assert.ok(store.loadSync("a/b")!.id === "a/b");
});

await withTempStore("disabled store writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-disabled-"));
    const store = new SessionStore({ dir, enabled: false });
    try {
        const s = makeSession("x");
        await store.writeNow(s);
        store.scheduleSave(s);
        store.flushSync(s);
        assert.equal(readdirSync(dir).length, 0, "nothing written when disabled");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

await withTempStore("flushSync returns true on success, false on failure", async (store, dir) => {
    const s = makeSession("flush-bool");
    assert.equal(store.flushSync(s), true, "returns true on success");
    // Make the directory a file to force write failure.
    const { rmSync, writeFileSync: wf } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
    wf(dir, "block", "utf8"); // dir path is now a file → mkdir/write fails
    assert.equal(store.flushSync(makeSession("flush-bool-2")), false, "returns false on write failure");
});

await withTempStore("loadSync returns null when body id does not match", async (store, dir) => {
    const { writeFileSync: wf } = await import("node:fs");
    // Hand-write a file whose name hashes to "real-id" but body says "fake-id".
    const real = makeSession("real-id");
    await store.writeNow(real);
    const file = readdirSync(dir)[0];
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    parsed.id = "different-id";
    wf(join(dir, file), JSON.stringify(parsed));
    // Asking for "real-id" finds the file by hash, but body id mismatches → null.
    assert.equal(store.loadSync("real-id"), null, "body id mismatch rejected");
});

await withTempStore("loadAll skips file whose filename does not match body id", async (store, dir) => {
    const { renameSync: rn } = await import("node:fs");
    await store.writeNow(makeSession("legit"));
    // Rename the legit file to a name that doesn't match any body id.
    const files = readdirSync(dir);
    rn(join(dir, files[0]), join(dir, "mismatched.json"));
    const all = await store.loadAll();
    assert.equal(all.size, 0, "filename/body mismatch rejected at loadAll");
});

await withTempStore("temp files are unique per write (no rename collision)", async (store) => {
    // Two rapid writeNow calls must not share a temp file.
    const s = makeSession("uniq-tmp");
    await Promise.all([store.writeNow(s), store.writeNow(s), store.writeNow(s)]);
    // All three completed without throwing ENOENT on rename.
    assert.ok(store.loadSync("uniq-tmp"));
});

await withTempStore("hasPending reflects the debounce timer", async (store) => {
    const s = makeSession("pending-check");
    assert.equal(store.hasPending(s.id), false);
    store.scheduleSave(s);
    assert.equal(store.hasPending(s.id), true);
    await settle();
    assert.equal(store.hasPending(s.id), false);
});
