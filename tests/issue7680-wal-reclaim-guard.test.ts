import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createInitialState } from "acp-kernel";
import { UnifiedStore } from "../src/storage/store.ts";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";
import { runSessionsCommand } from "../src/storage-maintenance.ts";

/**
 * #7680 — operator-explicit WAL-reclaim paths lack the live-foreign-writer guard.
 *
 * The #4612 guard (gc full-VACUUM refuses under a live peer) and the #7156 fix 2
 * (open/close TRUNCATE skipped under a live peer) cover SOME reclaim sites, but
 * two operator-explicit paths were left unguarded:
 *
 *   1. collectZeroRefContent's between-batch `PRAGMA wal_checkpoint(TRUNCATE)`
 *      (store.ts) — runs for ANY gc() with zero-ref rows (vacuum option
 *      irrelevant). A TRUNCATE reclaims the WAL + -shm index under a live peer;
 *      the peer then writes from a stale view -> #7156 corruption. The busy-catch
 *      does NOT protect (the shape needs the TRUNCATE to succeed while the peer
 *      holds a stale view, i.e. the peer is not in a write tx at that instant).
 *   2. `bili sessions rm` -> unifiedVacuum("full") (storage-maintenance.ts) —
 *      the full VACUUM holds the exclusive write lock across the O(db-size)
 *      rewrite (#4612 starvation) and its TRUNCATE reclaims the WAL (#7156).
 *      The #4612 guard lives in gc(), not on this path.
 *
 * Fix under test: both sites now check activeForeignWriter() /
 * unifiedActiveWriter() and skip the reclaim (TRUNCATE / full VACUUM) when a
 * live foreign writer is present. The deletes (site 1) and the session deletion
 * (site 2) still commit; the freed pages return on the next gc/vacuum after the
 * peer exits.
 *
 * Both-direction (gate discipline #3617): "triggers when it should" (peer
 * present -> reclaim skipped) AND "does NOT trigger when it should not" (no
 * peer -> reclaim runs).
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-7680-wal-reclaim-")),
    "no-config.json",
);

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

async function waitUntil(fn: () => boolean, ms: number, what: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** A live stand-in for "the other instance" (e.g. a running proxy). */
function spawnDummyWriter(): { pid: number; done(): Promise<void>; kill(): void } {
    const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const pid = child.pid!;
    return {
        pid,
        done: () => waitUntil(() => !alive(pid), 10_000, `dummy writer ${pid} to exit`),
        kill: () => child.kill("SIGTERM"),
    };
}

/** Seed zero-ref content rows directly (no session envelope). */
function seedZeroRefContent(dbPath: string, count: number): void {
    const raw = new DatabaseSync(dbPath);
    try {
        raw.exec("BEGIN");
        const ins = raw.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, 0, 'sha256', ?)");
        for (let i = 0; i < count; i++) {
            const body = Buffer.from(`7680-zero-ref ${i}`);
            ins.run(`7680-zero-ref-${i}`, body.length, body);
        }
        raw.exec("COMMIT");
    } finally {
        raw.close();
    }
}

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "responses", upstreamOrigin: "https://api.openai.com/v1", title: `title-${id}` },
        stats: { requests: 12, tokensSaved: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 50, cacheSamples: 1, lastInputTokens: 100, contextTokens: 99000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        createdAt: 1_000,
        lastSeen: Date.now(),
        state: createInitialState(),
        pendingRetrievals: [],
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

async function seedSession(dir: string, id: string): Promise<void> {
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    try {
        await store.writeNow(makeSession(id));
    } finally {
        store.closeQuietly();
    }
}

const SKIP_RE = /skipping the between-batch WAL checkpoint \(TRUNCATE\)/;

test("#7680 site 1: gc (no vacuum) with a live foreign writer — zero-ref deletes commit, the between-batch TRUNCATE is skipped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-7680-site1-peer-"));
    const dbPath = path.join(dir, "index.db");
    const dummy = spawnDummyWriter();
    try {
        await waitUntil(() => alive(dummy.pid), 10_000, "dummy writer to start");
        // The peer opened first: its lockfile entry is what our open() captures.
        fs.writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: dummy.pid, boot: Date.now() }));
        const store = UnifiedStore.open(dbPath);
        try {
            assert.equal(store.activeForeignWriter(), dummy.pid, "open captures the live foreign holder");
            seedZeroRefContent(dbPath, 5);
            const lines: string[] = [];
            setLogCapture((_level, msg) => { lines.push(msg); });
            let result!: { archived: number; contentRowsDeleted: number };
            try {
                // No vacuum option: the collectZeroRefContent path is reached
                // regardless of the vacuum option (the bug).
                result = store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "archive") });
            } finally {
                setLogCapture(null);
            }
            assert.equal(result.contentRowsDeleted, 5, "zero-ref deletes still commit despite the peer");
            const skips = lines.filter((m) => SKIP_RE.test(m));
            assert.ok(skips.length >= 1, `the between-batch TRUNCATE is skipped while the peer writes (got ${skips.length} skip lines)`);
            assert.match(skips[0], new RegExp(`live foreign writer pid ${dummy.pid}`), "the skip names the live peer");
            const raw = new DatabaseSync(dbPath, { readOnly: true });
            try {
                const left = raw.prepare("SELECT COUNT(*) AS n FROM content WHERE refcount <= 0").get() as { n: number };
                assert.equal(left.n, 0, "no zero-ref rows survive");
            } finally {
                raw.close();
            }
        } finally {
            store.close();
        }
    } finally {
        dummy.kill();
        await dummy.done().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("#7680 site 1: gc (no vacuum) with NO foreign writer — the between-batch TRUNCATE runs (no skip)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-7680-site1-nopeer-"));
    const dbPath = path.join(dir, "index.db");
    const store = UnifiedStore.open(dbPath);
    try {
        assert.equal(store.activeForeignWriter(), null, "clean open: no foreign writer");
        seedZeroRefContent(dbPath, 5);
        const lines: string[] = [];
        setLogCapture((_level, msg) => { lines.push(msg); });
        let result!: { archived: number; contentRowsDeleted: number };
        try {
            result = store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "archive") });
        } finally {
            setLogCapture(null);
        }
        assert.equal(result.contentRowsDeleted, 5, "zero-ref deletes commit");
        const skips = lines.filter((m) => SKIP_RE.test(m));
        assert.equal(skips.length, 0, "no skip: the TRUNCATE runs when no peer is present");
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("#7680 site 2: sessions rm with a live foreign writer — deletion commits, the full VACUUM is skipped with a note", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-7680-site2-peer-"));
    await seedSession(dir, "s-7680");
    const dummy = spawnDummyWriter();
    try {
        await waitUntil(() => alive(dummy.pid), 10_000, "dummy writer to start");
        // The peer's lockfile entry is captured when runSessionsCommand opens
        // its (fresh) SessionStore shadow — re-arm after the seed's own open.
        fs.writeFileSync(path.join(dir, "index.db.lock"), JSON.stringify({ pid: dummy.pid, boot: Date.now() }));
        const r = await runSessionsCommand({ sub: "rm", target: "s-7680", dir, json: true });
        assert.equal(r.code, 0, r.text);
        const data = JSON.parse(r.text) as { vacuumed: boolean; vacuumNote?: string };
        assert.equal(data.vacuumed, false, "the full VACUUM is skipped while the peer writes");
        assert.ok(data.vacuumNote, "a skip note is reported");
        assert.match(data.vacuumNote, new RegExp(`live foreign writer pid ${dummy.pid}`), "the note names the live peer");
        assert.match(data.vacuumNote, /deletion committed/, "the note confirms the deletion committed");
        const db = UnifiedStore.open(path.join(dir, "index.db"));
        assert.equal(db.sessionUpdatedAt("s-7680"), null, "the session row is gone");
        assert.equal(db.listSessionIds().includes("s-7680"), false);
        db.close();
    } finally {
        dummy.kill();
        await dummy.done().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("#7680 site 2: sessions rm with NO foreign writer — the full VACUUM runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-7680-site2-nopeer-"));
    await seedSession(dir, "s-7680b");
    try {
        const r = await runSessionsCommand({ sub: "rm", target: "s-7680b", dir, json: true });
        assert.equal(r.code, 0, r.text);
        const data = JSON.parse(r.text) as { vacuumed: boolean; vacuumNote?: string };
        assert.equal(data.vacuumed, true, "the full VACUUM runs when no peer is present");
        assert.equal(data.vacuumNote, undefined, "no skip note");
        const db = UnifiedStore.open(path.join(dir, "index.db"));
        assert.equal(db.sessionUpdatedAt("s-7680b"), null, "the session row is gone");
        db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
