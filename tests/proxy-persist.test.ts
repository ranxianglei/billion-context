import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { SessionStore } from "../src/persist.ts";
import { setLogCapture } from "../src/logger.ts";
import { dirname, join, relative, sep } from "node:path";
import type { Session, BlockContent } from "../src/session.ts";
import { createInitialState } from "acp-kernel";
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

/** Poll probe() until it returns non-nullish, failing after deadlineMs.
 *  Used where a write can legitimately land late: acp-kernel retries
 *  transient ENOENT/ENOTDIR (CI Windows temp sweeps) with backoff, so a
 *  debounced flush may surface seconds after its 5ms timer — a fixed
 *  sleep would flake even though the data is safe. */
async function waitFor<T>(probe: () => T | null | undefined, deadlineMs: number, what: string): Promise<T> {
    const start = Date.now();
    for (;;) {
        const v = probe();
        if (v != null) return v;
        if (Date.now() - start > deadlineMs) throw new Error(`timed out after ${deadlineMs}ms waiting for ${what}`);
        await settle(10);
    }
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
    // Files are envelope-wrapped {version, savedAt, id, payload}; the record
    // itself moved under `payload` (acp-kernel StateStore mechanism).
    const envelope = JSON.parse(readFileSync(files[0], "utf8"));
    assert.equal(envelope.version, 3);
    assert.equal(envelope.id, "sess-1");
    const raw = envelope.payload;
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
    // Poll rather than one fixed settle(): if the flush hits a transient
    // ENOENT (temp sweep) the kernel retries with backoff, so the write can
    // land well past the 5ms debounce. Deadline covers the retry ladder
    // (~1.5s) with headroom.
    const loaded = await waitFor(() => store.loadSync("debounce-1"), 5000, "debounced write to land");
    assert.equal(readdirSync(dir).length, 1, "exactly one top-level entry (the _unknown subdir) happened");
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

await withTempStore("loadSync uses protocol meta to locate namespaced file", async (store, dir) => {
    // After an LRU eviction, loadSync must find the file by protocol/host,
    // not by scanning. Passing the meta must hit the right path.
    const s = makeSession("meta-1");
    s.meta.protocol = "openai";
    s.meta.upstreamOrigin = "https://open.bigmodel.cn";
    await store.writeNow(s);
    // With correct meta → found.
    assert.ok(store.loadSync("meta-1", { protocol: "openai", upstreamOrigin: "https://open.bigmodel.cn" }));
    // A fresh store with WRONG meta → not found at the namespaced path (and
    // no scan: the flat fallback name differs from the namespaced file). In
    // the SAME store a wrong-meta probe still resolves via the kernel's
    // discovered-file cache — the id is authoritative, the meta is only a
    // path hint — which is why the isolation probe uses a second store.
    const cold = new SessionStore({ dir });
    assert.equal(cold.loadSync("meta-1", { protocol: "anthropic", upstreamOrigin: "https://other.example" }), null);
});

await withTempStore("pre-envelope flat file is adopted and re-persisted as envelope", async (store, dir) => {
    // Files written before the acp-kernel StateStore extraction are FLAT
    // records (no {version,savedAt,id,payload} wrapper). They must keep
    // loading via the kernel's legacy adoption hook, and the next dirty
    // write migrates them to the envelope format.
    const flat = {
        version: 3,
        savedAt: Date.now(),
        id: "flat-1",
        meta: { protocol: "openai", upstreamOrigin: "https://open.bigmodel.cn" },
        stats: { requests: 5, tokensSaved: 111 },
        createdAt: Date.now() - 1000,
        state: createInitialState(),
        blockContents: {},
    };
    const hash = createHash("sha256").update("flat-1", "utf8").digest("hex").slice(0, 24);
    const file = join(dir, "openai", `open.bigmodel.cn_${hash}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(flat));

    const loaded = store.loadSync("flat-1", { protocol: "openai", upstreamOrigin: "https://open.bigmodel.cn" });
    assert.ok(loaded && loaded.id === "flat-1", "flat file adopted on load");
    assert.equal(loaded!.stats.requests, 5, "stats survive adoption");
    loaded!.stats.requests = 6;
    await store.writeNow(loaded!);

    const envelope = JSON.parse(readFileSync(file, "utf8"));
    assert.ok("payload" in envelope, "re-persisted as envelope");
    assert.equal(envelope.payload.stats.requests, 6, "payload carries the update");
});

await withTempStore("one-time migration re-keys legacy hash-id sessions to their client-provided label (#286)", async (store, dir) => {
    const label = "conv-legacy-1";
    const legacyA = "legacy-" + "a".repeat(24);
    const legacyB = "legacy-" + "b".repeat(24);

    const a = makeSession(legacyA);
    a.meta.label = label;
    a.meta.protocol = "responses";
    a.meta.upstreamOrigin = "https://chatgpt.com";
    a.stats.requests = 7;
    await store.writeNow(a);

    const b = makeSession(legacyB);
    b.meta.label = label;
    b.meta.protocol = "responses";
    b.meta.upstreamOrigin = "https://chatgpt.com";
    b.stats.requests = 1;
    await store.writeNow(b);

    const fileB = jsonFilesUnder(dir).find((f) => JSON.parse(readFileSync(f, "utf8")).id === legacyB)!;
    const envB = JSON.parse(readFileSync(fileB, "utf8"));
    envB.savedAt -= 1000; // A is newer → A wins the same-label collision
    writeFileSync(fileB, JSON.stringify(envB));

    // A fresh store mirrors a new process: no discovered-file cache.
    const cold = new SessionStore({ dir, debounceMs: 5, enabled: true });
    try {
        await cold.migrateLegacyIds();

        const all = await cold.loadAll();
        assert.ok(all.has(label), "re-keyed under the client-provided label");
        assert.ok(!all.has(legacyA) && !all.has(legacyB), "legacy ids no longer resolve");
        assert.equal(all.get(label)!.stats.requests, 7, "newest savedAt wins the collision");
        assert.equal(jsonFilesUnder(dir).length, 1, "loser and old files removed");

        await cold.migrateLegacyIds();
        assert.equal((await cold.loadAll()).size, 1, "second migration is a no-op");
    } finally {
        cold.cancelAll();
    }
});

await withTempStore("migration leaves anonymous pfa sessions untouched (#499)", async (store, dir) => {
    // Anonymous prefix-affinity sessions (#309) all share the display label
    // "prefix-affinity" ≠ their id, which trips the #286 self-termination
    // invariant: without the guard, every boot re-keys them all to the single
    // id "prefix-affinity" and deletes every sibling but the newest — silent
    // loss of saved compression state for anonymous clients.
    const mk = (id: string, requests: number) => {
        const s = makeSession(id);
        s.meta.label = "prefix-affinity";
        s.meta.protocol = "openai";
        s.meta.upstreamOrigin = "https://relay.example/v1";
        s.stats.requests = requests;
        return s;
    };
    await store.writeNow(mk("pfa-bc1eaaaaaaaaaaaa", 7));
    await store.writeNow(mk("pfa-8588bbbbbbbbbbbb", 3));

    const fileB = jsonFilesUnder(dir).find((f) => JSON.parse(readFileSync(f, "utf8")).id === "pfa-8588bbbbbbbbbbbb")!;
    const envB = JSON.parse(readFileSync(fileB, "utf8"));
    envB.savedAt -= 1000; // bc1e is newer → it would win a label collision if migrated
    writeFileSync(fileB, JSON.stringify(envB));

    const legacy = makeSession("legacy-" + "c".repeat(24));
    legacy.meta.label = "conv-legacy-499";
    legacy.meta.protocol = "responses";
    legacy.meta.upstreamOrigin = "https://chatgpt.com";
    legacy.stats.requests = 2;
    await store.writeNow(legacy);

    const cold = new SessionStore({ dir, debounceMs: 5, enabled: true });
    try {
        await cold.migrateLegacyIds();
        const all = await cold.loadAll();
        assert.ok(all.has("pfa-bc1eaaaaaaaaaaaa"), "newer anonymous session survives");
        assert.ok(all.has("pfa-8588bbbbbbbbbbbb"), "older anonymous sibling survives (no shared-label deletion)");
        assert.equal(all.get("pfa-bc1eaaaaaaaaaaaa")!.stats.requests, 7, "state intact");
        assert.ok(!all.has("legacy-" + "c".repeat(24)), "true legacy session is still re-keyed");
        assert.ok(all.has("conv-legacy-499"), "legacy re-key still works alongside the guard");
        assert.equal(all.size, 3, "exactly the two pfa sessions plus the re-keyed legacy one");
    } finally {
        cold.cancelAll();
    }
});

test("SessionStore routes write failures through the EPERM detector (no false alert on non-lock error)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-eperm-wire-"));
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "block", "utf8");
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    try {
        store.scheduleSave(makeSession("wire-1"));
        // acp-kernel 0.0.53 retries the whole write cycle on transient
        // ENOTDIR (~1.5s ladder) before the failure line is logged — poll
        // with headroom instead of a fixed settle().
        await waitFor(
            () => captured.find((c) => c.level === "error" && c.msg.startsWith("[persist] write failed for ")) ?? null,
            5000,
            "kernel write-failure line to reach the wrapped log",
        );
        const failLines = captured.filter((c) => c.level === "error" && c.msg.startsWith("[persist] write failed for "));
        assert.ok(failLines.some((c) => c.msg.includes("wire-1")), "failure is for our session id");
        assert.equal(captured.filter((c) => c.msg.includes("Defender exclusions")).length, 0, "no EPERM alert for a non-lock (ENOTDIR) error");
    } finally {
        setLogCapture(null);
        store.cancelAll();
        rmSync(dir, { force: true });
    }
});
