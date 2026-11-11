/**
 * #5412: the async (network-backend) ingest twin must sweep foreign rows
 * while drift-latched, exactly like the sync path.
 *
 * The #5409 fix (#5408 path 1) promoted the sync path's full re-ingest to
 * `completeLog = hasRawTail || driftedSessions.has(id)` so a latched save
 * claims authoritative-set authority and its stale sweep retires residue
 * rows even without a raw tail. The async port
 * (`UnifiedShadow.enqueueAsyncRecord`) originally kept
 * `{ completeLog: hasRawTail }`: under the latch that is always false, so
 * every latched save re-took the incomplete view, each sampled verify kept
 * drifting, the watermark was cleared every time, and a session frozen via
 * the #4323 escalation could never release its latch on an async backend
 * (mysql etc.). Fixed in #5420 by mirroring the sync condition verbatim.
 *
 * Gates (async-lane shadow over a REAL sqlite backend via openBackend —
 * sync === null forces record() onto enqueueAsyncRecord's serial queue, the
 * same queue an opt-in network backend runs on):
 *   A. POSITIVE GATE. A drift-latched folded save runs the authoritative-set
 *      sweep and retires the foreign row out of the index.
 *   B. NEGATIVE GATE. An UNLATCHED folded save leaves foreign rows untouched
 *      (no raw tail, no latch -> no sweep authority over the table) — the
 *      historical behavior must not leak into async either way.
 *
 * Hardened 2026-11-11 during review of PR #5421: the original gates waited
 * a fixed settle(300ms) for the serial queue to drain, which could false-red
 * gate A on loaded runners and pass gate B vacuously if the folded save had
 * not been processed yet. Both gates now poll bounded conditions (row
 * retired / ingests counter) instead of sleeping; cleanup uses closeAsync()
 * (close() is a no-op in async mode and leaked the sqlite handle); the
 * BILI_STORAGE_UNIFIED restore captures the previous value before deleting
 * it.
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
const PREV_UNIFIED = process.env.BILI_STORAGE_UNIFIED;
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

/** Async-lane shadow over a REAL sqlite backend: sync === null forces
 *  record() onto enqueueAsyncRecord — the same queue an opt-in network
 *  backend runs on, without needing a live mysql server. */
function openAsyncShadow(dir: string): Promise<{ shadow: UnifiedShadow }> {
    const indexPath = path.join(dir, "index.db");
    return openBackend("sqlite", indexPath).then((backend) => ({
        shadow: UnifiedShadow.fromBackend("shadow", backend, (r) => r as LegacySessionLike),
    }));
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

/** Poll an async-queue effect to completion (bounded) instead of a fixed sleep. */
async function waitFor(fn: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (fn()) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

test("#5412 A: an async drift-latched folded save sweeps the foreign row out of the index", async () => {
    const dir = tmpDir("latched");
    try {
        const { shadow } = await openAsyncShadow(dir);
        const ids = "5412-latched";
        try {
            shadow.record(mkLegacy(ids, Array.from({ length: 5 }, (_, i) => msg(i))));
            await waitFor(() => (countMessages(dir, ids) ?? 0) >= 5, "first ingest to land 5 rows");
            insertForeignRow(dir, ids);
            assert.equal(foreignRowRetired(dir, ids), false, "foreign row present before the latched save");

            latchDrift(shadow, ids);
            shadow.record({ ...mkLegacy(ids, []), lastMessagesFolded: true });

            await waitFor(() => foreignRowRetired(dir, ids) === true, "latched folded save to run the authoritative-set sweep");
            assert.equal(foreignRowRetired(dir, ids), true, "latched folded save on the async queue must run the authoritative-set sweep and retire the foreign row");
        } finally {
            await shadow.closeAsync();
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
            await waitFor(() => (countMessages(dir, ids) ?? 0) >= 5, "first ingest to land 5 rows");
            insertForeignRow(dir, ids);

            // No latch: the historical behavior — a folded save (no raw tail)
            // does not claim authoritative-set authority over the table.
            shadow.record({ ...mkLegacy(ids, []), lastMessagesFolded: true });
            await waitFor(() => stats(shadow).ingests >= 2, "folded save to process");

            assert.equal(foreignRowRetired(dir, ids), false, "unlatched folded save must not sweep (no raw tail, no latch)");
        } finally {
            await shadow.closeAsync();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test.after(() => {
    if (PREV_UNIFIED === undefined) delete process.env.BILI_STORAGE_UNIFIED;
    else process.env.BILI_STORAGE_UNIFIED = PREV_UNIFIED;
});
