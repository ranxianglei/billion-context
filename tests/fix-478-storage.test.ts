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

const DAY_MS = 86400_000;

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

function paddedSession(id: string, textLen: number): Session {
    const s = makeSession(id);
    s.blockContents.set("b1", { one: null, full: { text: "x".repeat(textLen), count: 1 } });
    return s;
}

function backdate(files: string[], savedAt: number): void {
    for (const f of files) {
        const env = JSON.parse(readFileSync(f, "utf8"));
        env.savedAt = savedAt;
        writeFileSync(f, JSON.stringify(env));
    }
}

function withDir<T>(name: string, fn: (dir: string) => Promise<T> | T): Promise<unknown> {
    return test(name, async () => {
        const dir = mkdtempSync(join(tmpdir(), "bili-478-"));
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
// double the count.
await withDir("boot() prunes expired sessions in a single directory walk", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    for (let i = 0; i < 300; i++) await store.writeNow(makeSession(`exp-${i}`));
    const expiredFiles = jsonFilesUnder(dir);
    assert.equal(expiredFiles.length, 300);
    backdate(expiredFiles, Date.now() - 100 * DAY_MS);
    await store.writeNow(makeSession("fresh-1"));
    await store.writeNow(makeSession("fresh-2"));
    writeFileSync(join(dir, ".bili-migration-286.done"), String(Date.now()), "utf8");

    const cold = new SessionStore({ dir, debounceMs: 5, enabled: true, retentionDays: 90, maxBytes: 0 });
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
    assert.equal(map.size, 2, "expired records dropped from the loaded map");
    assert.ok(map.has("fresh-1") && map.has("fresh-2"));
    assert.equal(jsonFilesUnder(dir).length, 2, "expired files deleted, volume stable");
});

await withDir("#286 migration runs exactly once ever (completion marker)", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    await store.writeNow(makeSession("old-hash-id", { label: "conv-123" }));

    const lines: string[] = [];
    setLogCapture((_level, msg) => lines.push(msg));
    try {
        const cold1 = new SessionStore({ dir, debounceMs: 5, enabled: true, retentionDays: 90, maxBytes: 0 });
        const map1 = await cold1.boot();
        assert.ok(map1.has("conv-123"), "rekeyed under the client conversation id");
        assert.ok(!map1.has("old-hash-id"));
        assert.equal(lines.filter((m) => m.includes("one-time migration")).length, 1);
        assert.ok(existsSync(join(dir, ".bili-migration-286.done")), "completion marker written");
        assert.equal(jsonFilesUnder(dir).length, 1, "loser file deleted");

        lines.length = 0;
        const cold2 = new SessionStore({ dir, debounceMs: 5, enabled: true, retentionDays: 90, maxBytes: 0 });
        const map2 = await cold2.boot();
        assert.ok(map2.has("conv-123"));
        assert.equal(lines.filter((m) => m.includes("one-time migration")).length, 0, "marker suppresses the rescan");
        assert.equal(jsonFilesUnder(dir).length, 1, "second boot changes nothing");
    } finally {
        setLogCapture(null);
    }
});

await withDir("size budget prunes oldest-first until under maxBytes", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true, retentionDays: 0, maxBytes: 12_000 });
    for (let i = 0; i < 6; i++) await store.writeNow(paddedSession(`sz-${i}`, 4000));
    const byId = new Map<string, string>();
    for (const f of jsonFilesUnder(dir)) byId.set(JSON.parse(readFileSync(f, "utf8")).id, f);
    const base = Date.now() - 10 * DAY_MS;
    for (let i = 0; i < 6; i++) {
        const env = JSON.parse(readFileSync(byId.get(`sz-${i}`)!, "utf8"));
        env.savedAt = base + i * 60_000;
        writeFileSync(byId.get(`sz-${i}`)!, JSON.stringify(env));
    }
    writeFileSync(join(dir, ".bili-migration-286.done"), "1", "utf8");

    const lines: string[] = [];
    setLogCapture((_level, msg) => lines.push(msg));
    let map: Map<string, Session>;
    try {
        const cold = new SessionStore({ dir, debounceMs: 5, enabled: true, retentionDays: 0, maxBytes: 12_000 });
        map = await cold.boot();
    } finally {
        setLogCapture(null);
    }

    assert.ok(map.size < 6, "over-budget corpus was pruned");
    assert.ok(map.has("sz-5"), "newest record survives");
    assert.ok(!map.has("sz-0"), "oldest record pruned first");
    const remainingBytes = jsonFilesUnder(dir).reduce((n, f) => n + statSync(f).size, 0);
    assert.ok(remainingBytes <= 12_000, `survivors fit the budget (${remainingBytes} <= 12000)`);
    assert.ok(lines.some((m) => m.includes("[persist] gc:") && m.includes("over-budget")), "gc logged the pruning");
});

await withDir("retentionDays:0 + maxBytes:0 disable both GC passes", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    for (let i = 0; i < 3; i++) await store.writeNow(paddedSession(`keep-${i}`, 4000));
    backdate(jsonFilesUnder(dir), Date.now() - 100 * DAY_MS);

    const cold = new SessionStore({ dir, debounceMs: 5, enabled: true, retentionDays: 0, maxBytes: 0 });
    const map = await cold.boot();
    assert.equal(map.size, 3, "GC fully disabled — expired + oversized corpus untouched");
    assert.equal(jsonFilesUnder(dir).length, 3);
});
