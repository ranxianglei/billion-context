import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import type { Session } from "../src/session.ts";

/**
 * #3069 extension namespaces (schema v4): session_ext (per-session
 * arbitrary state) and kv_store (namespaced cross-session state).
 *
 *  1. round-trips: set/get/list/delete for both tables, upsert semantics,
 *     JSON value fidelity (objects survive), unknown keys → undefined;
 *  2. lifecycle: session_ext is swept by deleteSession; kv_store survives
 *     (caller-managed); whole-namespace deleteKv retires a lane;
 *  3. guards: control chars / oversize values / non-serializable values
 *     throw with clear messages;
 *  4. migration: a v3 database upgrades to the current schema (v7) in
 *     place (tables appear, user_version flips), idempotently.
 *
 * Extension state works in shadow AND full mode (side-table substrate like
 * checkpoints — it is not part of the legacy load path).
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-ext-hermetic-")),
    "no-config.json",
);
process.env.BILI_STORAGE_UNIFIED = "legacy";

function withMode<T>(mode: string, fn: () => T): T {
    process.env.BILI_STORAGE_UNIFIED = mode;
    try {
        return fn();
    } finally {
        process.env.BILI_STORAGE_UNIFIED = "legacy";
    }
}

async function seedSession(dir: string, id: string): Promise<Session> {
    const store = new SessionStore({ dir, enabled: true, debounceMs: 60000 });
    const session: Session = {
        id,
        created: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        protocol: "anthropic",
        metadata: { label: id },
        state: { blocks: {} },
        blockContents: new Map(),
        contentStore: { byHash: new Map(), byRef: new Map() } as never,
        stats: { requests: 1, requestFailures: 0, inputTokens: 10, outputTokens: 5 },
    } as unknown as Session;
    await store.writeNow(session);
    store.closeQuietly();
    return session;
}

test("extension namespaces round-trip through SessionStore (shadow mode)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ext-roundtrip-"));
    try {
        await seedSession(tmp + "/sessions", "ext-rt");
        withMode("shadow", () => {
            const store = new SessionStore({ dir: tmp + "/sessions", enabled: true, debounceMs: 60000 });
            try {
                store.setSessionExt("ext-rt", "r3:memory", { warm: false, saved: 42 });
                store.setSessionExt("ext-rt", "web:pin", "pinned-note");
                assert.deepEqual(store.getSessionExt("ext-rt", "r3:memory"), { warm: false, saved: 42 });
                assert.equal(store.getSessionExt("ext-rt", "web:pin"), "pinned-note");
                assert.equal(store.getSessionExt("ext-rt", "missing"), undefined);

                // upsert overwrites and bumps updated_at
                const before = store.listSessionExt("ext-rt").find((r) => r.key === "r3:memory")!.updatedAt;
                store.setSessionExt("ext-rt", "r3:memory", { warm: true, saved: 42 });
                const after = store.listSessionExt("ext-rt").find((r) => r.key === "r3:memory")!;
                assert.deepEqual(after.value, { warm: true, saved: 42 });
                assert.ok(after.updatedAt >= before);

                // kv: namespace isolation + key-prefix listing + deletes
                store.setKv("lane:18835", "counters", { turns: 3 });
                store.setKv("lane:18835", "prefs:theme", "dark");
                store.setKv("lane:18820", "counters", { turns: 9 });
                assert.deepEqual(store.getKv("lane:18835", "counters"), { turns: 3 });
                assert.deepEqual(store.listKv("lane:18835").map((r) => r.key).sort(), ["counters", "prefs:theme"]);
                assert.deepEqual(store.listKv(undefined, "prefs:").map((r) => r.key), ["prefs:theme"]);
                assert.equal(store.deleteKv("lane:18835", "counters"), 1);
                assert.equal(store.getKv("lane:18835", "counters"), undefined);
                assert.equal(store.deleteKv("lane:18835"), 1); // retire the lane namespace
                assert.deepEqual(store.listKv("lane:18835"), []);
                assert.deepEqual(store.listKv("lane:18820").map((r) => r.key), ["counters"]);

                // LIKE metacharacters in prefixes are escaped, not treated as wildcards
                store.setKv("lane:x", "a%b", 1);
                store.setKv("lane:x", "a_b", 2);
                store.setKv("lane:x", "acb", 3);
                assert.deepEqual(store.listKv("lane:x", "a%b").map((r) => r.key), ["a%b"]);
                assert.deepEqual(store.listKv("lane:x", "a_b").map((r) => r.key), ["a_b"]);

                assert.equal(store.deleteSessionExt("ext-rt", "web:pin"), 1);
                assert.deepEqual(store.listSessionExt("ext-rt").map((r) => r.key), ["r3:memory"]);
            } finally {
                store.closeQuietly();
            }
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("session_ext dies with the session; kv_store survives deleteSession", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ext-sweep-"));
    try {
        await seedSession(tmp + "/sessions", "ext-sweep");
        withMode("1", () => { // full
            const store = new SessionStore({ dir: tmp + "/sessions", enabled: true, debounceMs: 60000 });
            try {
                store.setSessionExt("ext-sweep", "ui:flags", { folded: true });
                store.setKv("host:dsh", "lane-ext-sweep", "alive");
            } finally {
                store.closeQuietly();
            }
            const unified = UnifiedStore.open(path.join(tmp, "sessions", "index.db"));
            try {
                unified.deleteSession("ext-sweep");
                assert.deepEqual(unified.listSessionExt("ext-sweep"), [], "session_ext rows must be swept with the session");
                assert.deepEqual(unified.listKv("host:dsh").map((r) => r.key), ["lane-ext-sweep"], "kv_store is caller-managed and survives");
            } finally {
                unified.close();
            }
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("guards reject hostile keys and oversize values", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ext-guards-"));
    try {
        withMode("shadow", () => {
            const store = new SessionStore({ dir: tmp + "/sessions", enabled: true, debounceMs: 60000 });
            try {
                assert.throws(() => store.setSessionExt("s", "", 1), /non-empty string/);
                assert.throws(() => store.setSessionExt("s", "bad\u0007key", 1), /control characters/);
                assert.throws(() => store.setKv("".padEnd(300, "n"), "k", 1), /at most 256/);
                assert.throws(() => store.setKv("ns", "k", undefined), /JSON-serializable/);
                assert.throws(() => store.setKv("ns", "k", { big: "x".repeat(5 * 1024 * 1024) }), /4194304 bytes/);
            } finally {
                store.closeQuietly();
            }
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("v3 databases migrate to v8 in place, idempotently", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ext-migrate-"));
    try {
        const dbPath = path.join(tmp, "index.db");
        // Build a current (v8) database, then roll the extension tables and
        // version marker back to the v3 shape — exactly what an upgraded
        // production lane's file looks like to the new code.
        const fresh = UnifiedStore.open(dbPath);
        fresh.close();
        const { DatabaseSync } = await import("node:sqlite");
        const rollback = new DatabaseSync(dbPath);
        rollback.exec("DROP TABLE session_ext");
        rollback.exec("DROP TABLE kv_store");
        rollback.exec("PRAGMA user_version = 3");
        rollback.close();

        const migrated = UnifiedStore.open(dbPath);
        try {
            const ver = (migrated as unknown as { db: { prepare(q: string): { get(): unknown } } }).db.prepare("PRAGMA user_version").get() as { user_version: number };
            assert.equal(ver.user_version, 8, "open() runs migrateSchema: v3 → v8");
            migrated.setKv("probe", "alive", true);
            assert.deepEqual(migrated.getKv("probe", "alive"), true);
            assert.deepEqual(migrated.listSessionIds(), [], "existing v3 content untouched");
        } finally {
            migrated.close();
        }
        // Reopening a v8 database is a no-op (idempotent migration).
        const again = UnifiedStore.open(dbPath);
        const ver2 = (again as unknown as { db: { prepare(q: string): { get(): unknown } } }).db.prepare("PRAGMA user_version").get() as { user_version: number };
        assert.equal(ver2.user_version, 8);
        again.close();
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("legacy-only instances fail fast with the 501-able message", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ext-legacy-"));
    try {
        withMode("legacy", () => {
            const store = new SessionStore({ dir: tmp + "/sessions", enabled: true, debounceMs: 60000 });
            try {
                assert.equal(store.replicasAvailable(), false);
                assert.throws(() => store.setSessionExt("s", "k", 1), /legacy-only/);
                assert.throws(() => store.setKv("ns", "k", 1), /legacy-only/);
            } finally {
                store.closeQuietly();
            }
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
