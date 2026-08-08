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
    writeFileSync(join(dir, "good.json"), JSON.stringify({ version: 1, id: "good", createdAt: 0, requests: 0, condensedToolResults: 0, tokensSaved: 0, state: createInitialState(), blockContents: {} }));
    writeFileSync(join(dir, "corrupt.json"), "{ this is not valid json");
    const all = await store.loadAll();
    assert.equal(all.size, 1);
    assert.ok(all.has("good"));
});

await withTempStore("unsafe session id is sanitized in filename but preserved in content", async (store, dir) => {
    const s = makeSession("../../etc/passwd"); // path-traversal attempt
    await store.writeNow(s);
    const files = readdirSync(dir);
    assert.ok(files.every((f) => !f.includes("..")), "no traversal segments in filename");
    const loaded = store.loadSync("../../etc/passwd");
    assert.equal(loaded!.id, "../../etc/passwd", "real id preserved inside file");
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
