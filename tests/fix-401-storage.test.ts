import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import fsShared from "node:fs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

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

function makeSession(id: string, meta: Session["meta"] = {}): Session {
    return {
        id,
        meta,
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

function withDir<T>(name: string, fn: (dir: string) => Promise<T> | T): Promise<unknown> {
    return test(name, async () => {
        const dir = mkdtempSync(join(tmpdir(), "bili-401-"));
        try {
            await fn(dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
}

await withDir("leaf block persists a single copy (one:null) and round-trips", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    const s = makeSession("leaf-1");
    s.blockContents.set("b1", { one: null, full: { text: "body-text", count: 2 } });
    await store.writeNow(s);

    const [file] = jsonFilesUnder(dir);
    const raw = JSON.parse(readFileSync(file, "utf8")).payload;
    assert.equal(raw.blockContents.b1.one, null, "byte-identical leaf view is stored once");
    assert.deepEqual(raw.blockContents.b1.full, { text: "body-text", count: 2 });

    const loaded = store.loadSync("leaf-1");
    assert.ok(loaded, "loaded from disk");
    const bc = loaded!.blockContents.get("b1");
    assert.equal(bc!.one, null, "null one-view survives the round-trip");
    assert.deepEqual(bc!.full, { text: "body-text", count: 2 });
});

await withDir("legacy byte-identical one/full pair normalizes to single copy on load", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    const s = makeSession("dup-1");
    s.blockContents.set("b1", { one: { text: "same", count: 1 }, full: { text: "same", count: 1 } });
    await store.writeNow(s);
    // Simulate a pre-fix file: both views persisted, byte-identical.
    const [file] = jsonFilesUnder(dir);
    const env = JSON.parse(readFileSync(file, "utf8"));
    env.payload.blockContents.b1 = { one: { text: "same", count: 1 }, full: { text: "same", count: 1 } };
    writeFileSync(file, JSON.stringify(env));

    const loaded = store.loadSync("dup-1");
    assert.ok(loaded);
    assert.equal(loaded!.blockContents.get("b1")!.one, null, "identical pair collapses to full-only");
    assert.deepEqual(loaded!.blockContents.get("b1")!.full, { text: "same", count: 1 });

    await store.writeNow(loaded!);
    const raw2 = JSON.parse(readFileSync(jsonFilesUnder(dir)[0], "utf8")).payload;
    assert.equal(raw2.blockContents.b1.one, null, "next persist stores the collapsed form");
});

// The kernel walks with `fs.readFileSync` on the shared node:fs object
// (dist/persist/index.js: `import fs from "fs"`), so patching the default
// export counts every file read during boot — a second loadAll pass would
// double the count. Sessions are permanent (#401: a year-long conversation
// must never be lost), so boot must not delete anything either.
await withDir("boot() loads everything in a single directory walk and deletes nothing", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    for (let i = 0; i < 300; i++) await store.writeNow(makeSession(`keep-${i}`));
    await store.writeNow(makeSession("keep-300"));
    await store.writeNow(makeSession("keep-301"));
    assert.equal(jsonFilesUnder(dir).length, 302);
    writeFileSync(join(dir, ".bili-migration-286.done"), String(Date.now()), "utf8");

    const cold = new SessionStore({ dir, debounceMs: 5, enabled: true });
    const origReadFileSync = fsShared.readFileSync;
    let reads = 0;
    Object.assign(fsShared, {
        readFileSync: (...args: Parameters<typeof fsShared.readFileSync>): unknown => {
            reads++;
            return origReadFileSync(...args);
        },
    });
    let map: Map<string, Session>;
    try {
        map = await cold.boot();
    } finally {
        Object.assign(fsShared, { readFileSync: origReadFileSync });
    }

    assert.equal(reads, 302, "exactly one read per session file — a single walk+parse pass");
    assert.equal(map.size, 302, "every session loads");
    assert.ok(map.has("keep-0") && map.has("keep-301"));
    assert.equal(jsonFilesUnder(dir).length, 302, "nothing deleted — sessions are permanent");
});

await withDir("#286 migration runs exactly once ever (completion marker)", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    await store.writeNow(makeSession("old-hash-id", { label: "conv-123" }));

    const lines: string[] = [];
    setLogCapture((_level, msg) => lines.push(msg));
    try {
        const cold1 = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const map1 = await cold1.boot();
        assert.ok(map1.has("conv-123"), "rekeyed under the client conversation id");
        assert.ok(!map1.has("old-hash-id"));
        assert.equal(lines.filter((m) => m.includes("one-time migration")).length, 1);
        assert.ok(existsSync(join(dir, ".bili-migration-286.done")), "completion marker written");
        assert.equal(jsonFilesUnder(dir).length, 1, "loser file deleted");

        lines.length = 0;
        const cold2 = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const map2 = await cold2.boot();
        assert.ok(map2.has("conv-123"));
        assert.equal(lines.filter((m) => m.includes("one-time migration")).length, 0, "marker suppresses the rescan");
        assert.equal(jsonFilesUnder(dir).length, 1, "second boot changes nothing");
    } finally {
        setLogCapture(null);
    }
});
