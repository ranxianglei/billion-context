/**
 * #3285 (2026-11-21 per-session rework): watermark trust no longer crosses
 * process boundaries via a GLOBAL open-time reset.
 *
 * The pre-rework implementation dropped EVERY session's ingest watermark in
 * one `UPDATE sessions SET last_ingested_seq = NULL` at writer init
 * (UnifiedShadow.maybeOpen). That made OPEN a write and touched every other
 * session — the exact first-write hazard #7156 demonstrated (a second live
 * writer corrupting the db during that window). The trust boundary is in fact
 * per-session: a process only needs to distrust watermarks it did not set,
 * for the session it is about to save. So the invalidation moved to
 * UnifiedStore.primeIngestTrust(sessionId) — first touch of a session in THIS
 * process drops any foreign-set watermark for that ONE session (the next save
 * then takes the exact full path, re-establishing trust from this process's
 * own view); later touches trust this process's own watermarks. Per
 * (process, session) the trust decision is byte-identical to the global
 * reset; untouched sessions keep their watermarks, and open performs no write.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites.
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-psit-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir is harmless */
    }
}

function msg(i: number): CoreMessage {
    return { id: `h_msg${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `hello ${i}` } as CoreMessage;
}

function mkLegacy(id: string, lastMessages: CoreMessage[]): LegacySessionLike {
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

function countMessages(dbPath: string, sessionId: string): number {
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    try {
        return (ro.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(sessionId) as { n: number }).n;
    } finally {
        ro.close();
    }
}

test("#3285 per-session trust: open no longer clears watermarks; prime is per-session, idempotent, and full-ingest re-establishes trust", () => {
    const dir = tmpdir("bili-psit-");
    const p = path.join(dir, "index.db");
    try {
        // --- "process A": save two sessions; each gets its own watermark.
        const a = UnifiedStore.open(p);
        a.ingestSession(planIngest(mkLegacy("sessX", [msg(1), msg(2)])));
        a.ingestSession(planIngest(mkLegacy("sessY", [msg(3), msg(4)])));
        assert.ok(a.ingestWatermark("sessX"), "process A's save of sessX set its watermark");
        assert.ok(a.ingestWatermark("sessY"), "process A's save of sessY set its watermark");
        a.close();

        // --- "process B" opens the SAME db: open performs NO write and must
        // NOT clear either watermark (the old global reset wiped both here).
        const b = UnifiedStore.open(p);
        assert.ok(b.ingestWatermark("sessX"), "process B's OPEN no longer clears sessX's foreign watermark");
        assert.ok(b.ingestWatermark("sessY"), "process B's OPEN no longer clears sessY's foreign watermark");

        // Prime ONLY sessX: its foreign watermark is dropped; sessY — never
        // touched by this process — keeps its watermark.
        b.primeIngestTrust("sessX");
        assert.equal(b.ingestWatermark("sessX"), null, "primeIngestTrust dropped the foreign watermark for the ONE primed session");
        assert.ok(b.ingestWatermark("sessY"), "untouched sessions keep their watermarks");

        // Idempotent per (process, session): the second touch trusts this
        // process's own watermarks and writes nothing.
        const wmAfterFirstPrime = b.ingestWatermark("sessX");
        b.primeIngestTrust("sessX");
        assert.equal(b.ingestWatermark("sessX"), wmAfterFirstPrime, "second prime in the same process is a no-op");

        // The distrust gate did its job: the next save of sessX takes the
        // exact FULL path (watermark null → authoritative replace), not a
        // delta against rows this process never verified — and re-establishes
        // trust from this process's own view.
        b.ingestSession(planIngest(mkLegacy("sessX", [msg(1), msg(2), msg(5)])));
        assert.ok(b.ingestWatermark("sessX"), "the full re-ingest re-established this process's own watermark");
        assert.equal(countMessages(p, "sessX"), 3, "full path replaced sessX's rows (3 rows, not 2 stale + 1 appended)");
        b.close();
    } finally {
        rmBestEffort(dir);
    }
});
