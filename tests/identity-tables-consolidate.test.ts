/**
 * 身份表收拢 (proposal discussions/7591, the #7439 follow-up) — the
 * identity-table consolidation contract:
 *   - S1: sessions.r3_latched_at lands on fresh AND pre-existing databases
 *     (probe-first, no version bump);
 *   - S2: the R3 breaker latch writes to the SESSIONS row (the l1_world
 *     placeholder-row ceremony is retired), survives a restart, stays
 *     readable from the legacy l1 column (fallback), and the roster is
 *     the union of both carriers;
 *   - S3: an egress-on session's stage-0 is STATELESS — echo/anchor is
 *     replay math against the op log, no l1 row is ever read or written;
 *     legacy sessions still run the full l1 path (byte-identical
 *     discipline);
 *   - S5: GC freshness is egress-aware and egress-on sessions are EXCLUDED
 *     from archiving (archiveSession would delete the op log without
 *     exporting it — data loss until the archive format carries it).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { egressStateAppend } from "../src/storage/egress-state.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { runStage0 } from "../src/snapshot/stage0.ts";
import { FoundationRejectError } from "../src/snapshot/plane.ts";
import type { BiliMessage } from "acp-kernel/wire";
const { _setStoreForTest, _resetStoreForTest } = await import("../src/persist.ts");

process.env.BILI_PERSIST_ZSTD = "0";
// egress-on tests drive the op log as the identity authority — snapPinLiveIds
// only reads the egress view when the egressPlane rollout is on (master's #7583
// gate); force it on so the stateless stage-0 branch is exercised.
process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-identity-consolidate-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const OLD_SESSIONS_DDL = `CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    parent_session_id TEXT,
    fork_point_seq INTEGER,
    protocol TEXT,
    label TEXT,
    title TEXT,
    host_title TEXT,
    namespace TEXT NOT NULL DEFAULT 'proxy',
    origin TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    next_block_id INTEGER NOT NULL DEFAULT 1,
    next_run_id INTEGER NOT NULL DEFAULT 1,
    meta_json TEXT,
    stats_json TEXT,
    metadata_json TEXT,
    kstate_json TEXT,
    tail_json TEXT,
    ccr_json TEXT,
    last_ingested_seq INTEGER,
    orphans_json TEXT
);`;

function openStore(): { store: UnifiedStore; db: ReturnType<typeof openSqliteDatabase>["db"]; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-identity-consolidate-"));
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const db = (store as unknown as { db: ReturnType<typeof openSqliteDatabase>["db"] }).db;
    return { store, db, dir };
}

function closeStore(h: { store: UnifiedStore; dir: string }): void {
    try { h.store.close(); } catch { /* already closed */ }
    try {
        fs.rmSync(h.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* leaked temp dir on a Windows runner is harmless */ }
}

function insertSession(db: ReturnType<typeof openSqliteDatabase>["db"], sid: string, atMs: number, metadata?: Record<string, unknown>): void {
    db.prepare("INSERT INTO sessions (session_id, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?)")
        .run(sid, atMs, atMs, metadata ? JSON.stringify(metadata) : "{}");
}

function egressOnRow(db: ReturnType<typeof openSqliteDatabase>["db"], sid: string, atMs: number, msgids: string[]): void {
    insertSession(db, sid, atMs, { egressAuthority: true });
    let after: string | null = null;
    for (const m of msgids) {
        egressStateAppend(db, sid, [
            { type: "I", msgid: m, after, ref: "", tokens: 3, typeTag: "text", bytes: `{"id":"${m}","role":"user","text":"${m}"}`, role: "user" },
        ], atMs);
        after = m;
    }
}

test("S1: sessions.r3_latched_at is on fresh stores and probe-added to pre-existing databases", () => {
    // fresh
    {
        const h = openStore();
        try {
            const cols = (h.db.prepare("PRAGMA table_info(sessions)").all() as unknown as { name: string }[]).map((c) => c.name);
            assert.ok(cols.includes("r3_latched_at"), "fresh store carries the column from the base DDL");
        } finally {
            closeStore(h);
        }
    }
    // pre-existing (column absent — a db from before this change)
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-identity-consolidate-"));
        const { db } = openSqliteDatabase(path.join(dir, "index.db"));
        try {
            db.exec(OLD_SESSIONS_DDL);
            migrateSchema(db);
            const cols = (db.prepare("PRAGMA table_info(sessions)").all() as unknown as { name: string }[]).map((c) => c.name);
            assert.ok(cols.includes("r3_latched_at"), "migrateSchema probe-first adds the column to the pre-existing sessions table");
        } finally {
            db.close();
            try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* harmless */ }
        }
    }
});

test("S2: the R3 latch lands on the sessions row — survives a restart, no l1 row, clear + roster work", () => {
    const h = openStore();
    const sid = "sess-r3-on-sessions-row";
    try {
        h.store.snapR3Latch(sid);
        const row = h.db.prepare("SELECT r3_latched_at FROM sessions WHERE session_id = ?").get(sid) as { r3_latched_at: number | null };
        assert.ok(row && row.r3_latched_at != null && row.r3_latched_at > 0, "the latch is on the sessions row");
        const l1 = h.db.prepare("SELECT sess_raw FROM l1_world WHERE sess_raw = ?").get(sid);
        assert.equal(l1, undefined, "no l1 placeholder row is created anymore");

        // restart: a fresh store over the SAME db must see the latch
        h.store.close();
        const h2store = UnifiedStore.open(path.join(h.dir, "index.db"));
        const h2 = { store: h2store, db: (h2store as unknown as { db: ReturnType<typeof openSqliteDatabase>["db"] }).db, dir: h.dir };
        try {
            assert.equal(h2.store.snapR3Latched(sid), true, "the latch survives a restart via the sessions row");
            const roster = h2.store.snapR3LatchedList();
            assert.ok(roster.some((r) => r.sessRaw === sid), "the roster carries the sessions-row latch");
            const cleared = h2.store.snapR3LatchClear(sid);
            assert.equal(cleared, sid, "clearing returns the resolvable sid");
            assert.equal(h2.store.snapR3Latched(sid), false, "cleared");
            const row2 = h2.db.prepare("SELECT r3_latched_at FROM sessions WHERE session_id = ?").get(sid) as { r3_latched_at: number | null };
            assert.ok(row2.r3_latched_at == null, "the column went back to NULL");
        } finally {
            closeStore(h2);
        }
    } finally {
        closeStore(h);
    }
});

test("S2: the minimal latch row is completed by a later ingest upsert without losing the latch", () => {
    const h = openStore();
    const sid = "sess-r3-minimal-row";
    try {
        h.store.snapR3Latch(sid); // no sessions row yet — the minimal upsert
        const latchBefore = (h.db.prepare("SELECT r3_latched_at FROM sessions WHERE session_id = ?").get(sid) as { r3_latched_at: number }).r3_latched_at;
        // the arm-turn ingest upsert fills the rest (same ON CONFLICT shape as the save path)
        h.db.prepare("INSERT INTO sessions (session_id, created_at, updated_at, label, metadata_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET label = excluded.label, metadata_json = excluded.metadata_json")
            .run(sid, Date.now(), Date.now(), "filled-later", JSON.stringify({ pluginAgent: "pi" }));
        const after = h.db.prepare("SELECT r3_latched_at, label FROM sessions WHERE session_id = ?").get(sid) as { r3_latched_at: number; label: string };
        assert.equal(after.label, "filled-later", "the ingest upsert filled the row");
        assert.equal(after.r3_latched_at, latchBefore, "the latch survived the ingest upsert");
        assert.equal(h.store.snapR3Latched(sid), true);
    } finally {
        closeStore(h);
    }
});

test("S2: legacy l1 latches stay readable (fallback) and the roster is the union of both carriers", () => {
    const h = openStore();
    const legacySid = "sess-legacy-l1-latch";
    const freshSid = "sess-fresh-sessions-latch";
    try {
        // a pre-migration latch living only in l1_world
        h.db.prepare("INSERT INTO l1_world (sess_raw, ledger_id, witness_probe, issued_at, r3_latched_at) VALUES (?, ?, 'w', ?, ?)")
            .run(legacySid, legacySid, 1000, 1234);
        assert.equal(h.store.snapR3Latched(legacySid), true, "the legacy l1 latch is still readable");
        h.store.snapR3Latch(freshSid);
        const roster = h.store.snapR3LatchedList();
        assert.ok(roster.some((r) => r.sessRaw === legacySid && r.latchedAt === 1234), "legacy latch in the roster");
        assert.ok(roster.some((r) => r.sessRaw === freshSid && r.latchedAt > 1234), "sessions-row latch in the roster");
        // a NEW latch on the legacy sid lands on the sessions row; the l1
        // column is left untouched (read-fallback only, nothing new there)
        h.store.snapR3Latch(legacySid);
        const l1col = (h.db.prepare("SELECT r3_latched_at FROM l1_world WHERE sess_raw = ?").get(legacySid) as { r3_latched_at: number }).r3_latched_at;
        assert.equal(l1col, 1234, "no new latch value ever lands on the l1 column");
        const dedup = h.store.snapR3LatchedList().filter((r) => r.sessRaw === legacySid);
        assert.equal(dedup.length, 1, "the roster dedupes per raw id");
        assert.ok(dedup[0].latchedAt > 1234, "the newer latch wins the dedupe");
    } finally {
        closeStore(h);
    }
});

/** Owner ruling 2026-11-24 (discussions/7591): the latch CARRIER switch is gated
 *  on egressPlane — with it OFF, `snapR3Latch` must write the LEGACY l1_world
 *  carrier (placeholder-row shape, byte-identical to pre-migration), not the
 *  sessions row. This is what keeps the PR from changing any behavior until
 *  the owner flips egressPlane. */
test("S2 (owner ruling 2026-11-24): egressPlane OFF → latch writes the legacy l1 carrier, nothing on sessions", () => {
    const h = openStore();
    const sid = "sess-r3-flag-off-l1";
    try {
        // the file forces egressPlane ON at module load; flip it off here
        // (featureEnabled re-reads the env on every call).
        delete process.env.BILI_ROLLOUT_EGRESS_PLANE;
        try {
            h.store.snapR3Latch(sid);
            // legacy l1 carrier: the placeholder row, byte-identical to pre-migration
            const l1 = h.db.prepare("SELECT ledger_id, witness_probe, r3_latched_at FROM l1_world WHERE sess_raw = ?").get(sid) as { ledger_id: string; witness_probe: string; r3_latched_at: number };
            assert.ok(l1, "egressPlane off → the latch lands on the legacy l1_world carrier");
            assert.equal(l1.ledger_id, sid, "the placeholder row carries sessRaw as ledger_id (pre-migration shape)");
            assert.equal(l1.witness_probe, "", "witness_probe stays the empty sentinel (pre-migration shape)");
            assert.ok(l1.r3_latched_at > 0, "the latch value is on the l1 column");
            // and NOTHING on the sessions carrier
            const sess = h.db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(sid);
            assert.equal(sess, undefined, "no sessions row is created on the flag-off path");
            // still readable through the dual-carrier read (sessions ?? l1 fallback)
            assert.equal(h.store.snapR3Latched(sid), true, "the flag-off latch is readable via the l1 fallback");
            // conv-bound session: the flag-off l1 write must key by the
            // conversation RAW id (not the ledger sid) — matching the read
            // path and pre-migration byte-for-byte (regression guard).
            h.db.prepare("INSERT INTO conversations (namespace, conversation_id, session_id, claimed_at) VALUES (?, ?, ?, 0)")
                .run("default", "conv-ro", "sid-ro");
            h.store.snapR3Latch("sid-ro");
            const l1ro = h.db.prepare("SELECT ledger_id FROM l1_world WHERE sess_raw = ?").get("conv-ro") as { ledger_id: string } | undefined;
            assert.ok(l1ro, "the conv-bound flag-off latch is keyed by the conversation raw id");
            assert.equal(l1ro.ledger_id, "conv-ro", "placeholder ledger_id = sessRaw (pre-migration shape)");
            assert.equal(h.db.prepare("SELECT sess_raw FROM l1_world WHERE sess_raw = ?").get("sid-ro"), undefined, "NOT keyed by the ledger sid");
            assert.equal(h.store.snapR3Latched("sid-ro"), true, "readable via the l1 fallback (keyed by sessRaw)");
        } finally {
            process.env.BILI_ROLLOUT_EGRESS_PLANE = "1"; // restore for the rest of the file
        }
    } finally {
        closeStore(h);
    }
});

test("S3: egress-on stage-0 is stateless — echo/anchor against the op log, no l1 row, reset is a no-op", () => {
    const h = openStore();
    const sid = "sess-egress-stateless-stage0";
    try {
        egressOnRow(h.db, sid, Date.now(), ["m1", "m2"]);
        // echo: every id is in the flow, no seqs carrier
        const echo = h.store.snapStage0(sid, ["m1", "m2"], { seqs: null });
        assert.equal(echo.decision.mode, "echo", "a full resend of the flow's ids is an echo");
        assert.equal(echo.decision.replay, true);
        // anchor: a grown array — new id past the flow frontier
        const anchor = h.store.snapStage0(sid, ["m1", "m2", "m3"], { seqs: null });
        assert.equal(anchor.decision.mode, "anchor");
        assert.deepEqual(anchor.decision.newIdPos, [{ id: "m3", pos: 3 }], "the new core gets pos = canonical message frontier + 1 (== live.length with no folds)");
        // the statelessness itself: NO l1 row was read or written, and the
        // conversations row does not exist for this sid — nothing to read.
        assert.equal((h.db.prepare("SELECT count(*) AS n FROM l1_world").get() as { n: number }).n, 0, "stage-0 never touched l1_world");
        assert.equal((h.db.prepare("SELECT count(*) AS n FROM conversations WHERE session_id = ?").get(sid) as { n: number }).n, 0);
        // seqs past the flow frontier are NOT a replay
        const offFrontier = h.store.snapStage0(sid, ["m1", "m2"], { seqs: [9999] });
        assert.equal(offFrontier.decision.mode, "anchor", "seqs beyond the flow frontier are a fresh anchor, not an echo");
        // the storage-fault escape hatch must not blow up without an l1 row
        h.store.snapStage0Reset(sid);
        assert.equal((h.db.prepare("SELECT count(*) AS n FROM l1_world").get() as { n: number }).n, 0, "reset is a no-op for egress-on sessions");
    } finally {
        closeStore(h);
    }
});

test("S3: legacy stage-0 is untouched — the l1 path still records and decides", () => {
    const h = openStore();
    const sid = "sess-legacy-stage0-unchanged";
    try {
        insertSession(h.db, sid, Date.now());
        const first = h.store.snapStage0(sid, ["a", "b"], { seqs: null });
        assert.notEqual(first.decision.mode, "echo", "a legacy fresh session is not an echo");
        const l1 = h.db.prepare("SELECT sess_raw, tail_json FROM l1_world WHERE sess_raw = ?").get(sid) as { sess_raw: string; tail_json: string } | undefined;
        assert.ok(l1, "the legacy session still gets its l1 row");
        assert.ok(l1!.tail_json.includes("a") && l1!.tail_json.includes("b"), "the cursor window recorded the incoming ids");
        const second = h.store.snapStage0(sid, ["a", "b"], { seqs: null });
        assert.equal(second.decision.mode, "echo", "the next identical array echoes (legacy replay guard intact)");
    } finally {
        closeStore(h);
    }
});

test("S5: GC — an idle egress-on session is neither planned nor archived; a legacy idle session still is", () => {
    const h = openStore();
    const egressSid = "sess-gc-egress-idle";
    const legacySid = "sess-gc-legacy-idle";
    try {
        const old = Date.now() - 100 * 86_400_000; // 100 days idle
        egressOnRow(h.db, egressSid, old, ["m1", "m2"]);
        insertSession(h.db, legacySid, old);
        const plan = h.store.gcPlan(30);
        assert.ok(!plan.candidates.some((c) => c.sessionId === egressSid), "the idle egress-on session is NOT a gc candidate (op log is its activity; archiving it would be data loss)");
        assert.ok(plan.candidates.some((c) => c.sessionId === legacySid), "the idle legacy session still is");
        const out = h.store.gc({ archiveAfterDays: 30, archiveDir: path.join(h.dir, "archive"), vacuum: "incremental" });
        assert.equal(out.archived, 1, "exactly the legacy session archived");
        assert.equal((h.db.prepare("SELECT status FROM sessions WHERE session_id = ?").get(egressSid) as { status: string }).status, "active", "the egress-on session stayed active");
        assert.equal((h.db.prepare("SELECT status FROM sessions WHERE session_id = ?").get(legacySid) as { status: string }).status, "archived", "the legacy session archived");
        assert.equal((h.db.prepare("SELECT count(*) AS n FROM egress_flow WHERE session_id = ?").get(egressSid) as { n: number }).n, 2, "the op log is intact");
    } finally {
        closeStore(h);
    }
});

test("S5: GC — an egress-on session with RECENT op-log activity is not stale even though updated_at froze", () => {
    const h = openStore();
    const sid = "sess-gc-egress-active";
    try {
        insertSession(h.db, sid, Date.now() - 100 * 86_400_000, { egressAuthority: true }); // row froze 100 days ago
        egressStateAppend(h.db, sid, [
            { type: "I", msgid: "m1", after: null, ref: "", tokens: 3, typeTag: "text", bytes: '{"id":"m1","role":"user","text":"m1"}', role: "user" },
        ], Date.now() - 60_000); // but the op log moved a minute ago
        const plan = h.store.gcPlan(30);
        assert.ok(!plan.candidates.some((c) => c.sessionId === sid), "freshness = max(updated_at, last op-log row) — the session is active");
    } finally {
        closeStore(h);
    }
});

test("S2 (review M1): a session latched in BOTH carriers clears both — the legacy fallback cannot re-latch it", () => {
    const h = openStore();
    const sid = "sess-r3-both-carriers";
    try {
        // pre-migration latch (l1 row) AND post-migration re-latch (sessions row)
        h.db.prepare("INSERT INTO l1_world (sess_raw, ledger_id, witness_probe, issued_at, r3_latched_at) VALUES (?, ?, 'w', ?, ?)")
            .run(sid, sid, 1000, 1111);
        h.store.snapR3Latch(sid); // lands on the sessions row
        assert.equal(h.store.snapR3Latched(sid), true, "latched");
        const l1col = (h.db.prepare("SELECT r3_latched_at FROM l1_world WHERE sess_raw = ?").get(sid) as { r3_latched_at: number | null }).r3_latched_at;
        const sessCol = (h.db.prepare("SELECT r3_latched_at FROM sessions WHERE session_id = ?").get(sid) as { r3_latched_at: number | null }).r3_latched_at;
        assert.ok(l1col != null && sessCol != null, "both carriers hold a latch under the same key");

        const cleared = h.store.snapR3LatchClear(sid);
        assert.equal(cleared, sid, "clear returns the sid (a carrier was latched)");
        assert.equal(h.store.snapR3Latched(sid), false, "the session is fully unlatched — the legacy read-fallback did NOT re-latch it");
        const l1after = (h.db.prepare("SELECT r3_latched_at FROM l1_world WHERE sess_raw = ?").get(sid) as { r3_latched_at: number | null }).r3_latched_at;
        const sessAfter = (h.db.prepare("SELECT r3_latched_at FROM sessions WHERE session_id = ?").get(sid) as { r3_latched_at: number | null }).r3_latched_at;
        assert.ok(l1after == null, "the l1 carrier was cleared");
        assert.ok(sessAfter == null, "the sessions carrier was cleared");
    } finally {
        closeStore(h);
    }
});

test("S4 (review L3): an egress-on (conversation-bound) session DEGRADES on an R3 identity fault instead of 400ing", () => {
    // The S4 contract: for an egress-on session the lane passes convBound from
    // the in-memory metadata (pluginAgent != null) because there is no
    // conversations row to look up. When convBound is true, a REJECTED pin that
    // fails R3 identity (malformed array vs the message count) degrades to the
    // content-derived ids (no throw). When convBound is false (legacy), the
    // same input is an R3 identity fault → FoundationRejectError (400).
    // NOTE (#7574): a WELL-FORMED short tail on an empty ledger no longer
    // faults — it runs without the pin regardless of convBound — so this test
    // uses a MALFORMED tail (a duplicate entry) to reach the R3-fault branch.
    const prevFlag = process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY;
    process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY = "1"; // rollout on
    const mk = (id: string): BiliMessage => ({ id, role: "user", content: [{ type: "text", text: id }] } as unknown as BiliMessage);
    const msgs = [mk("a"), mk("b"), mk("c")]; // N = 3 messages
    const base = { lane: "openai", incomingSeqs: null, log: () => {} } as const;
    const stub = {
        snapR3Latched: () => false,          // fresh sid, not latched
        snapPinLiveIds: () => [] as string[], // empty ledger
        snapConvBound: () => false,          // not consulted (convBound passed explicitly)
        closeQuietly: () => {},              // _resetStoreForTest closes the stub
    };
    try {
        _setStoreForTest(stub as unknown as Parameters<typeof _setStoreForTest>[0]);
        // convBound = true (egress-on + pluginAgent) → degrade, no throw
        const ok = runStage0({ sessionId: "sess-egress-convbound-true", msgs, incomingMsgIds: ["x", "x"], pluginMode: true, convBound: true, ...base });
        assert.equal(ok.pinned, null, "the pin is rejected (duplicate) and nothing is pinned");
        // convBound = false (legacy) → R3 identity fault → 400
        assert.throws(
            () => runStage0({ sessionId: "sess-legacy-convbound-false", msgs, incomingMsgIds: ["p", "p"], pluginMode: true, convBound: false, ...base }),
            FoundationRejectError,
            "the same malformed input is an R3 identity fault for a non-conversation-bound session",
        );
    } finally {
        _resetStoreForTest();
        if (prevFlag === undefined) delete process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY;
        else process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY = prevFlag;
    }
});
