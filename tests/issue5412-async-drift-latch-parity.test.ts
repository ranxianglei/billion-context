/**
 * #5412: the async (network-backend) ingest twin must sweep foreign rows
 * while drift-latched, exactly like the sync path.
 *
 * The #5409 fix (#5408 path 1) promoted the sync path's full re-ingest to
 * `completeLog = hasRawTail || driftedSessions.has(id)` so a latched save
 * claims authoritative-set authority and its stale sweep retires residue
 * rows even without a raw tail. The async port
 * (`UnifiedShadow.enqueueAsyncRecord`) was not updated: under the same
 * latch it kept ingesting `{ completeLog: hasRawTail }`, i.e. false — every
 * latched save re-took the incomplete view, the next sample drifted again,
 * and a session frozen via the #4323 escalation could never converge back
 * to clean on an async backend (mysql etc.). Positive gate pinned here:
 * latched folded save → foreign row retired. Negative gate: an UNLATCHED
 * folded save leaves foreign rows untouched (no raw tail, no latch) — the
 * historical behavior must not leak into async either way.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { openBackend } from "../src/storage/backend.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
// Hermeticity pin, same family as the #4323/#5408 suites: a developer
// machine with storage.unified in its real config must not leak a tier.
const HERMETIC = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5412-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC, "no-config.json");
delete process.env.BILI_STORAGE_UNIFIED;

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

/** Give the serial backend queue a turn so enqueueAsyncRecord drains. */
function settle(ms = 300): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
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

/** Async-lane shadow over a REAL sqlite backend: sync === null forces
 *  record() onto enqueueAsyncRecord — the same queue an opt-in network
 *  backend runs on, without needing a live mysql server. */
function openAsyncShadow(dir: string): Promise<{ shadow: UnifiedShadow }> {
    const indexPath = path.join(dir, "index.db");
    return openBackend("sqlite", indexPath).then((backend) => ({
        shadow: UnifiedShadow.fromBackend("shadow", backend, (r) => r as LegacySessionLike),
    }));
}

/** Insert a foreign message row (identity absent from any plan this test
 *  produces) — the residue shape a second writer or a lost rewind leaves.
 *  (Replicated from the #5408 suite.) */
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

test("#5412 A: an async drift-latched folded save sweeps the foreign row out of the index", async () => {
    const dir = tmpDir("latched");
    try {
        const { shadow } = await openAsyncShadow(dir);
        const ids = "5412-latched";
        try {
            shadow.record(mkLegacy(ids, Array.from({ length: 5 }, (_, i) => msg(i))));
            await settle();
            insertForeignRow(dir, ids);
            assert.equal(foreignRowRetired(dir, ids), false, "foreign row present before the latched save");

            latchDrift(shadow, ids);
            shadow.record({ ...mkLegacy(ids, []), lastMessagesFolded: true });
            await settle();

            assert.equal(foreignRowRetired(dir, ids), true, "latched folded save on the async queue must run the authoritative-set sweep and retire the foreign row");
        } finally {
            shadow.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("#5412 B negative gate: an async UNLATCHED folded save leaves foreign rows untouched", async () => {
    const dir = tmpDir("control");
    try {
        const { shadow } = await openAsyncShadow(dir);
        const ids = "5412-control";
        try {
            shadow.record(mkLegacy(ids, Array.from({ length: 5 }, (_, i) => msg(i))));
            await settle();
            insertForeignRow(dir, ids);

            // No latch: the historical behavior — a folded save (no raw tail)
            // does not claim authoritative-set authority over the table.
            shadow.record({ ...mkLegacy(ids, []), lastMessagesFolded: true });
            await settle();

            assert.equal(foreignRowRetired(dir, ids), false, "unlatched folded save must not sweep (no raw tail, no latch)");
        } finally {
            shadow.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});
