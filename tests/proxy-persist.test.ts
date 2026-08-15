import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { SessionStore } from "../src/persist.ts";
import { createInitialState } from "acp-kernel";
import type { Session, BlockContent } from "../src/session.ts";

/** Recursively collect *.json files under dir (sessions are namespaced into
 *  protocol/ subdirs). */
function jsonFilesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        if (name.startsWith(".tmp-")) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...jsonFilesUnder(full));
        else if (name.endsWith(".json")) out.push(full);
    }
    return out;
}

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
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
    s.stats.requests = 42;
    s.stats.tokensSaved = 1234;
    s.state.nextBlockId = 7;
    const content: BlockContent = { one: { text: "one-text", count: 3 }, full: { text: "full-text", count: 9 } };
    s.blockContents.set("b1", content);

    await store.writeNow(s);

    const files = jsonFilesUnder(dir);
    assert.ok(files.length > 0, "a session json file was written");
    const raw = JSON.parse(readFileSync(files[0], "utf8"));
    assert.equal(raw.id, "sess-1");
    assert.equal(raw.requests, undefined);
    assert.equal(raw.stats.requests, 42);
    assert.equal(raw.stats.tokensSaved, 1234);
    assert.equal(raw.state.nextBlockId, 7);
    assert.deepEqual(raw.blockContents.b1, { one: { text: "one-text", count: 3 }, full: { text: "full-text", count: 9 } });
});

await withTempStore("loadSync restores a persisted session", async (store) => {
    const s = makeSession("sess-2");
    s.stats.tokensSaved = 999;
    s.state.nextBlockId = 3;
    await store.writeNow(s);

    const loaded = store.loadSync("sess-2");
    assert.ok(loaded, "loaded from disk");
    assert.equal(loaded!.id, "sess-2");
    assert.equal(loaded!.stats.tokensSaved, 999);
    assert.equal(loaded!.state.nextBlockId, 3);
    assert.ok(loaded!.blockContents instanceof Map, "blockContents restored as a Map");
});

await withTempStore("loadSync returns null for unknown id", async (store) => {
    assert.equal(store.loadSync("does-not-exist"), null);
});

await withTempStore("scheduleSave debounces and eventually writes", async (store, dir) => {
    const s = makeSession("debounce-1");
    s.stats.requests = 1;
    store.scheduleSave(s);
    s.stats.requests = 2; // mutate again before timer fires → should coalesce
    store.scheduleSave(s);
    s.stats.requests = 3;
    store.scheduleSave(s);
    await settle();
    assert.equal(readdirSync(dir).length, 1, "exactly one top-level entry (the _unknown subdir) happened");
    const loaded = store.loadSync("debounce-1");
    assert.equal(loaded!.stats.requests, 3, "latest value persisted");
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
    s.stats.tokensSaved = 555;
    store.flushSync(s);
    assert.equal(readdirSync(dir).length, 1);
    assert.equal(store.loadSync("evict-1")!.stats.tokensSaved, 555);
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
    const jsonFiles = jsonFilesUnder(dir);
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
    const file = jsonFilesUnder(dir)[0];
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    parsed.id = "different-id";
    wf(file, JSON.stringify(parsed));
    // Asking for "real-id" finds the file by hash, but body id mismatches → null.
    assert.equal(store.loadSync("real-id"), null, "body id mismatch rejected");
});

await withTempStore("loadAll skips file whose filename does not match body id", async (store, dir) => {
    const { renameSync: rn } = await import("node:fs");
    await store.writeNow(makeSession("legit"));
    // Rename the legit file to a name that doesn't match any body id.
    const files = jsonFilesUnder(dir);
    rn(files[0], join(dir, "mismatched.json"));
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

// Regression (2026-08-15, windows-latest CI flake on PR #158): the writeNow
// per-session chain cleaned itself up via `next.finally(...)` — a derived
// promise nobody held. When the chain rejected (the test's tmpdir was
// removed before the async write hit the disk → ENOENT), that orphan
// surfaced as a process-level unhandledRejection and failed the whole test
// file. In production the same leak means a transient persist failure
// (disk full, EPERM) crashes the proxy. The caller of writeNow still gets
// the real rejection; only the cleanup side-effect must swallow.
await withTempStore("writeNow rejection does not leak an unhandled rejection", async (store) => {
    // Deterministic failure: point the store at a path whose parent is a
    // regular FILE, so mkdir(recursive) cannot recreate the directory and
    // the tmp-file write fails with ENOENT.
    const blocker = join(tmpdir(), `bili-persist-blocker-${Date.now()}-${process.pid}`);
    writeFileSync(blocker, "x");
    const dead = new SessionStore({ dir: join(blocker, "sessions"), debounceMs: 5, enabled: true });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
        const s = makeSession("orphan-check");
        await assert.rejects(dead.writeNow(s), /ENOENT|ENOTDIR/);
        await settle(50); // give any orphan a chance to surface
    } finally {
        process.off("unhandledRejection", onUnhandled);
        rmSync(blocker, { force: true });
    }
    assert.equal(unhandled.length, 0, `orphan rejection leaked: ${unhandled.map(String).join("; ")}`);
});

await withTempStore("sessions are namespaced by protocol + provider on disk", async (store, dir) => {
    // A human should be able to tell sessions apart at a glance from the path:
    //   anthropic/dashscope_<hash>.json
    //   openai/zhipu_<hash>.json
    //   responses/comfly_<hash>.json
    const anth = makeSession("sess-anth");
    anth.meta.protocol = "anthropic";
    anth.meta.upstreamOrigin = "https://coding.dashscope.aliyuncs.com";
    await store.writeNow(anth);

    const oai = makeSession("sess-oai");
    oai.meta.protocol = "openai";
    oai.meta.upstreamOrigin = "https://open.bigmodel.cn";
    await store.writeNow(oai);

    const resp = makeSession("sess-resp");
    resp.meta.protocol = "responses";
    resp.meta.upstreamOrigin = "https://ai.comfly.org";
    await store.writeNow(resp);

    const all = jsonFilesUnder(dir);
    assert.equal(all.length, 3, "three sessions written");
    const rel = all.map((f) => relative(dir, f).split(sep).join("/"));
    assert.ok(rel.some((p) => p.startsWith("anthropic/") && /dashscope/.test(p)), `anthropic/dashscope path: ${rel.join(", ")}`);
    assert.ok(rel.some((p) => p.startsWith("openai/") && /bigmodel/.test(p)), `openai/bigmodel path: ${rel.join(", ")}`);
    assert.ok(rel.some((p) => p.startsWith("responses/") && /comfly/.test(p)), `responses/comfly path: ${rel.join(", ")}`);
});

await withTempStore("protocol-less session lands under _unknown/ (legacy compat)", async (store, dir) => {
    // A session with no protocol meta (e.g. created before meta was captured)
    // still persists — under _unknown/ so it never collides with a namespaced
    // protocol subdir, and still loads back.
    const s = makeSession("legacy-1");
    await store.writeNow(s);
    const all = jsonFilesUnder(dir);
    assert.equal(all.length, 1);
    assert.ok(all[0].includes("_unknown"), `legacy file under _unknown: ${all[0]}`);
    const loaded = store.loadSync("legacy-1");
    assert.ok(loaded && loaded.id === "legacy-1", "legacy session loads back");
});

await withTempStore("loadSync uses protocol meta to locate namespaced file", async (store) => {
    // After an LRU eviction, loadSync must find the file by protocol/host,
    // not by scanning. Passing the meta must hit the right path.
    const s = makeSession("meta-1");
    s.meta.protocol = "openai";
    s.meta.upstreamOrigin = "https://open.bigmodel.cn";
    await store.writeNow(s);
    // With correct meta → found.
    assert.ok(store.loadSync("meta-1", { protocol: "openai", upstreamOrigin: "https://open.bigmodel.cn" }));
    // With wrong meta → not found at the namespaced path (and no _unknown fallback
    // because protocol is given, so it does not scan the legacy location).
    assert.equal(store.loadSync("meta-1", { protocol: "anthropic", upstreamOrigin: "https://other.example" }), null);
});
