import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

/**
 * #5756 — lazy completeLog sweep.
 *
 * The historian sweep (store.ts / mysql.ts) retires every stored row whose
 * identity is absent from the presented window. Before the fix it re-ran the
 * FULL statement triple for EVERY absent row on EVERY save — the tombstone
 * UPDATE (a no-op once `AND retired_at IS NULL` stops matching) plus the
 * message_media SELECT+DELETE+release pass — so a stable 3k-message session
 * with a 160-row window burned ~3k×3 statements per save for pure
 * bookkeeping (#5756 lane B, ~8900 of its 9653 stmts/save). The fix skips
 * already-retired rows entirely; first retirement still does the full work.
 *
 * Regression pin (issue's own metric — statements per save): save 2 pays
 * 3×N first-time-retirement statements for the N slid-out rows; save 3
 * (window slides by K on the same corpus) must NOT pay them again. The
 * assertion requires save2−save3 to exceed half the N-triple cost, leaving a
 * 2× cushion above the ~dozen-statement drift between adjacent saves.
 * Sentinel timestamps additionally pin the data-level invariant that
 * pre-existing tombstones are left byte-identical.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue5756-")),
    "no-config.json",
);

const IMG_B64 = "a".repeat(4096);
// Year-2001 timestamp — no Date.now() write can collide with it, so a
// surviving sentinel proves the row was never re-touched.
const SENTINEL = 1_000_000_000_000;

interface CoreMsg { id: string; role: string; contentType: string; text: string; imageBase64?: string; imageMediaType?: string }

const mkMsg = (id: string, text: string, image?: string): CoreMsg => ({
    id,
    role: "user",
    contentType: image !== undefined ? "image" : "text",
    text,
    ...(image !== undefined ? { imageBase64: image, imageMediaType: "image/png" } : {}),
});

const mkSession = (id: string, msgs: CoreMsg[]): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen: 2_000,
    meta: { protocol: "openai" },
    stats: {},
    metadata: {},
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

interface RawStmt { run(...a: unknown[]): unknown; all(...a: unknown[]): { n?: number | null }[] }
interface RawDb { prepare(q: string): RawStmt }

test("#5756: repeated completeLog saves skip already-retired rows (no re-stamp, no media re-sweep)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-issue5756-"));
    try {
        const W = 120, K = 4;
        const SID = "sess-lazy";
        const base: CoreMsg[] = Array.from({ length: 300 }, (_, i) => mkMsg(`m-${i}`, `body ${i}`, i === 0 ? IMG_B64 : undefined));
        const c304 = [...base, mkMsg("m-300", "turn 300"), mkMsg("m-301", "turn 301"), mkMsg("m-302", "turn 302"), mkMsg("m-303", "turn 303")];
        const c308 = [...c304, mkMsg("m-304", "turn 304"), mkMsg("m-305", "turn 305"), mkMsg("m-306", "turn 306"), mkMsg("m-307", "turn 307")];
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const raw = (store as unknown as { db: RawDb }).db;
        const count = (sql: string, ...p: unknown[]): number => Number(raw.prepare(sql).all(...p)[0]?.n ?? 0);
        const retiredCount = () => count("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND retired_at IS NOT NULL", SID);
        const liveCount = () => count("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND retired_at IS NULL", SID);
        const sentinelCount = () => count("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND retired_at = ?", SID, SENTINEL);

        // Statement counter: wraps db.prepare around each save so the test
        // measures the issue's own metric (statements per save) on whatever
        // sqlite engine the driver picked.
        const origPrepare = raw.prepare.bind(raw);
        let stmts = 0;
        const saveWindowCounted = (corpus: CoreMsg[]): number => {
            stmts = 0;
            raw.prepare = (q: string) => { stmts++; return origPrepare(q); };
            try {
                store.ingestSession(planIngest(mkSession(SID, corpus.slice(corpus.length - W))), undefined, { completeLog: true });
            } finally {
                raw.prepare = origPrepare;
            }
            return stmts;
        };

        // Save 1: full-history baseline (e.g. initial sync).
        store.ingestSession(planIngest(mkSession(SID, base)), undefined, { completeLog: true });
        assert.equal(liveCount(), 300);

        // Save 2: history grew to 304, window shows the last W rows → FIRST
        // retirement of the 304-W slid-out rows (including the image row):
        // the full cleanup work happens exactly once here.
        const save2 = saveWindowCounted(c304);
        assert.equal(retiredCount(), 304 - W, "first retirement tombstones the slid-out prefix");
        assert.equal(liveCount(), W);
        assert.equal(store.mediaRefCount(IMG_B64), 0, "first retirement released the swept image ref");

        // Stamp every existing tombstone with the sentinel.
        raw.prepare("UPDATE messages SET retired_at = ? WHERE session_id = ? AND retired_at IS NOT NULL").run(SENTINEL, SID);
        assert.equal(sentinelCount(), 304 - W);

        // Save 3: history grew by K, window still W → exactly K NEW rows
        // retire for the first time; the 304-W pre-existing tombstones must
        // neither be re-stamped nor re-swept.
        const save3 = saveWindowCounted(c308);
        assert.equal(sentinelCount(), 304 - W, "pre-existing tombstones were left byte-identical");
        assert.equal(retiredCount(), 308 - W, "exactly K new rows retired");
        assert.equal(liveCount(), W);
        assert.equal(store.mediaRefCount(IMG_B64), 0, "media accounting stable across repeat sweeps");
        // THE regression pin: save 2 paid 3×(304-W) first-time-retirement
        // statements; a steady-state save must not pay them again. Old code
        // re-ran the triple for every already-retired row (save3 ≈ save2);
        // fixed code skips them (save3 ≈ save2 − 3×N).
        assert.ok(
            save2 - save3 > (3 * (304 - W)) / 2,
            `steady-state save re-paid the first-time retirement work (save2=${save2} stmts, save3=${save3} stmts)`,
        );

        // Save 4: identical window, pure steady-state save — zero drift.
        saveWindowCounted(c308);
        assert.equal(sentinelCount(), 304 - W);
        assert.equal(retiredCount(), 308 - W);
        assert.equal(liveCount(), W);

        // Rewind-redo (#4390/#4506): the full history comes back — every
        // tombstone reactivates in place and the image mapping is restored.
        store.ingestSession(planIngest(mkSession(SID, c308)), undefined, { completeLog: true });
        assert.equal(retiredCount(), 0, "rewind-redo reactivated every tombstone");
        assert.equal(liveCount(), 308);
        assert.equal(store.mediaRefCount(IMG_B64), 1, "reactivated image row re-owns its media ref");
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});
