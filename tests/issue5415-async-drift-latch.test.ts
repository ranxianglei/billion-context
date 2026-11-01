/**
 * #5415: async storage backend — the drift latch never releases once engaged.
 *
 * #5408/#5409 gave the SYNC sidecar latched-sweep convergence: while drift-
 * latched the full re-ingest sweeps foreign rows out of the index even without
 * a raw tail (the envelope is what load routing serves under the latch, so the
 * index must converge to it — persist.ts lazySource serves the FILE for a
 * latched id on BOTH backends). The ASYNC backend twin (enqueueAsyncRecord)
 * kept `{ completeLog: hasRawTail }`, so a folded-resident save (no raw tail)
 * never swept here: foreign rows rode every replay, each sampled verify kept
 * drifting, the watermark was cleared every time, and the latch could never
 * release.
 *
 * Async-backend mirror of B1 in tests/issue5408-frozen-recovery.test.ts, driven
 * through the REAL async path (UnifiedShadow.fromBackend + SqliteBackend ->
 * record() -> enqueueAsyncRecord's serial queue):
 *
 *   A. POSITIVE GATE. A drift-latched folded save runs the authoritative-set
 *      sweep and retires the foreign row out of the index.
 *   B. NEGATIVE GATE. An UNLATCHED folded save leaves foreign rows untouched
 *      (no raw tail, no latch -> no sweep authority over the table).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { SqliteBackend } from "../src/storage/backend.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the #5408 suite: a developer machine with
// storage.unified in its real config must not leak a tier into these tests.
const HERMETIC = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5415-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC, "no-config.json");
delete process.env.BILI_STORAGE_UNIFIED;

const PREV_UNIFIED = process.env.BILI_STORAGE_UNIFIED;

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

function tmpDir(tag: string): string {
    return fs.mkdtempSync(path.join(HERMETIC, `${tag}-`));
}

function msg(i: number, text = `hello ${i}`): CoreMessage {
    return { id: `h_msg${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text } as CoreMessage;
}

function mkLegacy(id: string, lastMessages: LegacySessionLike["lastMessages"]): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: false,
    };
}

interface StatsView {
    ingests: number;
    verifyOk: number;
    verifyDrift: number;
}

function stats(shadow: UnifiedShadow): StatsView {
    return (shadow as unknown as { stats: StatsView }).stats;
}

/** Build an ASYNC-mode shadow (sync fast lane null) over a real SQLite store —
 *  record() routes through enqueueAsyncRecord's serial queue exactly like the
 *  mysql backend, but stays queryable via plain SQLite. */
function openAsyncShadow(dir: string): { shadow: UnifiedShadow; store: UnifiedStore } {
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const shadow = UnifiedShadow.fromBackend("shadow", new SqliteBackend(store), (r) => r as LegacySessionLike);
    return { shadow, store };
}

/** Count the session's live (non-retired) message rows. */
function countMessages(dir: string, sessionId: string): number | null {
    const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
    try {
        const row = conn.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND retired_at IS NULL").get(sessionId) as { n: number } | undefined;
        return row ? row.n : null;
    } finally {
        conn.close();
    }
}

/** Insert a foreign message row (identity absent from any plan this test
 *  produces) — the residue shape a second writer or a lost rewind leaves. */
function insertForeignRow(dir: string, sessionId: string): void {
    const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
    try {
        const row = conn.prepare("SELECT content_hash FROM messages WHERE session_id = ? ORDER BY seq LIMIT 1").get(sessionId) as { content_hash: string } | undefined;
        assert.ok(row, "base content row must exist");
        conn
            .prepare("INSERT INTO messages (session_id, seq, msg_id, role, kind, content_hash, identity) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(sessionId, 99_999, "foreign-msg", "user", "message", row.content_hash, "foreign-identity");
    } finally {
        conn.close();
    }
}

function foreignRowRetired(dir: string, sessionId: string): boolean | null {
    const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
    try {
        const row = conn.prepare("SELECT retired_at FROM messages WHERE session_id = ? AND msg_id = 'foreign-msg'").get(sessionId) as { retired_at: number | null } | undefined;
        return row ? row.retired_at !== null : null;
    } finally {
        conn.close();
    }
}

function latchDrift(shadow: UnifiedShadow, id: string): void {
    const sh = shadow as unknown as { driftedSessions?: Set<string> };
    if (!sh.driftedSessions) sh.driftedSessions = new Set();
    sh.driftedSessions.add(id);
}

/** Poll an async-queue effect to completion (bounded) instead of a fixed sleep. */
async function waitFor(fn: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (fn()) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

test("#5415 A: a drift-latched folded save sweeps the foreign row out of the async index", async () => {
    const dir = tmpDir("a-latched");
    try {
        const { shadow, store } = openAsyncShadow(dir);
        try {
            const ids = "a-latched";
            shadow.record(mkLegacy(ids, Array.from({ length: 5 }, (_, i) => msg(i))));
            await waitFor(() => (countMessages(dir, ids) ?? 0) >= 5, "first ingest to land 5 rows");
            insertForeignRow(dir, ids);
            assert.equal(foreignRowRetired(dir, ids), false, "foreign row present before the latched save");

            latchDrift(shadow, ids);
            shadow.record({ ...mkLegacy(ids, []), lastMessagesFolded: true });

            await waitFor(() => foreignRowRetired(dir, ids) === true, "latched folded save to run the authoritative-set sweep");
            assert.equal(foreignRowRetired(dir, ids), true, "latched folded save retires the foreign row on the async path too");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("#5415 B negative gate: an UNLATCHED folded save leaves foreign rows untouched on the async path", async () => {
    const dir = tmpDir("b-control");
    try {
        const { shadow, store } = openAsyncShadow(dir);
        try {
            const ids = "b-control";
            shadow.record(mkLegacy(ids, Array.from({ length: 5 }, (_, i) => msg(i))));
            await waitFor(() => (countMessages(dir, ids) ?? 0) >= 5, "first ingest to land 5 rows");
            insertForeignRow(dir, ids);

            // No latch: historical behavior — a folded save (no raw tail) does
            // not claim authoritative-set authority over the table.
            shadow.record({ ...mkLegacy(ids, []), lastMessagesFolded: true });
            await waitFor(() => stats(shadow).ingests >= 2, "folded save to process");

            assert.equal(foreignRowRetired(dir, ids), false, "unlatched folded save must not sweep (no raw tail, no latch)");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test.after(() => {
    if (PREV_UNIFIED === undefined) delete process.env.BILI_STORAGE_UNIFIED;
    else process.env.BILI_STORAGE_UNIFIED = PREV_UNIFIED;
});
