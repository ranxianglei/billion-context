import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { egressAppendTurn, egressStateView, egressStateAt } from "../src/storage/egress-state.ts";
import { type EgressOpLogStore } from "../src/storage/egress-record.ts";
import { recordAuthorityTurn, resolveEgressAuthority } from "../src/server/egress-lane-io.ts";
import { ROLLOUT_FEATURES, featureEnabled } from "../src/rollout.ts";
import type { BiliMessage } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";

/**
 * #7735 eg-series cleanup (identity row + legacy-table retirement + flag
 * defaults). Targeted local suite; the full-suite verdict is CI.
 *
 *  R1 identity row: an egress-on session's sessions row lands through the
 *     authority seam (its unified ingest is frozen), one row, first-parent
 *     wins, descriptive cols refresh, payload cols untouched; self-heals.
 *  R2 table gate: a fresh eg-mode DB materializes exactly the 7 CORE tables;
 *     flipping the flag off on a later open converges the 12 legacy tables.
 *  R3 l1 cleanup: the arm-turn dead row is deleted in the identity-row
 *     transaction; the R3 breaker row and armed rows survive.
 *  R4/R5 gates: the explicit-client affinity chain and the plugin-conversations
 *     persistence are skipped in eg mode (the gate predicate is pinned here;
 *     the full request-pipeline behavior rides the codex e2e suite, §4).
 *  R6: a fresh eg-mode DB never materializes the session-order writer's row
 *     (the writer is gone from master; the registry entry documents it).
 *  R7 kv cap: a serialized kv value over 256 chars throws loud unless
 *     whitelisted (the two frozen legacy blobs).
 *  R8 defaults: the three egress flags default to percent 0.
 */

const S = "sess-eg-cleanup";
const M = (id: string, text: string, role: BiliMessage["role"] = "user"): BiliMessage => ({ id, role, contentType: "text", text });
const quiet = () => {};

function mkdtemp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmrf(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Force the egressPlane flag (the env always wins over the baked-in percent). */
function withFlag<T>(on: boolean, fn: () => T): T {
    const saved = process.env.BILI_ROLLOUT_EGRESS_PLANE;
    process.env.BILI_ROLLOUT_EGRESS_PLANE = on ? "1" : "0";
    try {
        return fn();
    } finally {
        if (saved === undefined) delete process.env.BILI_ROLLOUT_EGRESS_PLANE;
        else process.env.BILI_ROLLOUT_EGRESS_PLANE = saved;
    }
}

type RawDb = ReturnType<typeof openSqliteDatabase>["db"];
function rawDbOf(store: UnifiedStore): RawDb {
    return (store as unknown as { db: RawDb }).db;
}
function tablesOf(db: RawDb): string[] {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

/** A minimal egress-on session: the fields egressIdentityColumnsOf reads plus
 *  the metadata the authority seam latches. */
function egSession(overrides?: { title?: string; derivedFrom?: string; forkPointSeq?: number }): Session {
    const now = Date.now();
    return {
        id: S,
        createdAt: now,
        lastSeen: now,
        meta: { protocol: "openai", label: "lane", title: overrides?.title ?? "initial title", hostTitle: "host title", upstreamOrigin: "test-origin" },
        metadata: {
            pluginAgent: "pi",
            ...(overrides?.derivedFrom ? { derivedFromSessionId: overrides.derivedFrom } : {}),
        },
    } as unknown as Session;
}

/** A raw EgressOpLogStore shim over a raw db (the egress tables only — no
 *  sessions table, so ensureEgressIdentity is absent and the seam skips it). */
function rawStore(db: RawDb): EgressOpLogStore {
    return {
        egressAppendTurn: (sid, ops, baseSeq, nowMs) => egressAppendTurn(db, sid, ops, nowMs, { baseSeq }),
        egressStateView: (sid) => egressStateView(db, sid),
        egressStateViewAt: (sid, seq) => egressStateAt(db, sid, seq),
        egressStateMaxSeq: (sid) => (db.prepare(`SELECT COALESCE(MAX(op_seq), 0) AS mx FROM egress_flow WHERE session_id = ?`).get(sid) as { mx: number }).mx,
        egressStateTruncateAfter: (sid, seq) => {
            const a = db.prepare(`DELETE FROM egress_state WHERE session_id = ? AND op_seq > ?`).run(sid, seq);
            const b = db.prepare(`DELETE FROM egress_flow WHERE session_id = ? AND op_seq > ?`).run(sid, seq);
            return Number(a.changes) + Number(b.changes);
        },
    };
}

// ---------------------------------------------------------------------------
// Group 1 — fresh-DB invariant (R2 + R6)
// ---------------------------------------------------------------------------

const CORE_TABLES = ["egress_block_flow", "egress_block_state", "egress_flow", "egress_state", "kv_store", "session_ext", "sessions"];
const LEGACY_TABLES = ["blocks", "ccr_entries", "checkpoints", "conversations", "content", "dead_refs", "l1_world", "message_media", "messages", "orphan_blocks", "refs", "state_fields"];

test("#7735 R2: a fresh eg-mode DB materializes exactly the 7 CORE tables", () => {
    const dir = mkdtemp("bili-7735-fresh-");
    try {
        withFlag(true, () => {
            const { db } = openSqliteDatabase(path.join(dir, "index.db"));
            try {
                migrateSchema(db, { legacyTables: false });
                assert.deepEqual(tablesOf(db), CORE_TABLES, "exactly the 7 CORE tables, nothing else");
                for (const t of LEGACY_TABLES) {
                    assert.ok(!tablesOf(db).includes(t), `${t} must not exist in a fresh eg-mode DB`);
                }
            } finally {
                db.close();
            }
        });
    } finally {
        rmrf(dir);
    }
});

test("#7735 R2+R6: eg-mode plugin turn — sessions row from row 1, egress rows, no legacy kv blobs", () => {
    const dir = mkdtemp("bili-7735-turn-");
    try {
        withFlag(true, () => {
            const store = UnifiedStore.open(path.join(dir, "index.db"));
            const db = rawDbOf(store);
            try {
                const session = egSession();
                // turn 1 (bootstrap): the authority seam latches + upserts the
                // identity row, then records the client bytes once.
                const a1 = resolveEgressAuthority({ session, st: store, sessionId: S, core: [M("m1", "alpha")], log: quiet, armed: true });
                assert.equal(a1.bootstrapping, true, "row-less session is the turn-1 bootstrap");
                recordAuthorityTurn(store, S, a1, "sys", quiet);

                // exactly the 7 CORE tables (the turn does not materialize legacy)
                assert.deepEqual(tablesOf(db), CORE_TABLES, "the turn keeps the store at the 7-table eg shape");

                // sessions: exactly 1 row, egressAuthority latched from row 1
                const rows = db.prepare("SELECT session_id, metadata_json FROM sessions WHERE session_id = ?").all(S) as { session_id: string; metadata_json: string }[];
                assert.equal(rows.length, 1, "exactly one sessions row");
                const meta = JSON.parse(rows[0].metadata_json) as Record<string, unknown>;
                assert.equal(meta["egressAuthority"], true, "the KDD#23 latch is present from row 1");

                // the egress 4 tables have rows
                for (const t of ["egress_flow", "egress_state"]) {
                    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE session_id = ?`).get(S) as { n: number }).n;
                    assert.ok(n > 0, `${t} has rows after the turn`);
                }

                // kv rows ⊆ the small-config set — no legacy blobs (R6: no
                // session-order; R4: no plugin-conversations; R5: no
                // prefix-affinity — the test traffic is an explicit id).
                const kvKeys = (db.prepare("SELECT namespace || '|' || key AS k FROM kv_store").all() as { k: string }[]).map((r) => r.k);
                for (const k of kvKeys) {
                    assert.ok(
                        k === "rollout|install-id" || k.startsWith("notices|") || k.startsWith("host-plugins|"),
                        `kv row ${k} is not in the small-config set`,
                    );
                }
                for (const banned of ["session-order|v1", "plugin-conversations|table", "prefix-affinity|v1"]) {
                    assert.ok(!kvKeys.includes(banned), `${banned} must not appear in a fresh eg-mode DB`);
                }
            } finally {
                store.close();
            }
        });
    } finally {
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// Group 2 — identity row (R1)
// ---------------------------------------------------------------------------

test("#7735 R1: identity row present from turn 1, refreshed on turn 2, lineage untouched", () => {
    const dir = mkdtemp("bili-7735-identity-");
    try {
        withFlag(true, () => {
            const store = UnifiedStore.open(path.join(dir, "index.db"));
            const db = rawDbOf(store);
            try {
                const session = egSession({ title: "title v1" });
                const a1 = resolveEgressAuthority({ session, st: store, sessionId: S, core: [M("m1", "alpha")], log: quiet, armed: true });
                recordAuthorityTurn(store, S, a1, "sys", quiet);

                const row1 = db.prepare("SELECT title, updated_at, parent_session_id, created_at, stats_json FROM sessions WHERE session_id = ?").get(S) as { title: string | null; updated_at: number; parent_session_id: string | null; created_at: number; stats_json: string | null };
                assert.equal(row1.title, "title v1", "descriptive col lands from the session meta");
                assert.equal(row1.parent_session_id, null, "no parent on a non-fork session");
                assert.equal(row1.stats_json, "{}", "payload cols stay at the DDL empty default (the ingest is frozen — the upsert never writes them)");
                const created1 = row1.created_at;
                const updated1 = row1.updated_at;

                // turn 2: title changes, lastSeen advances — the row refreshes,
                // stays ONE row, created_at is first-wins, parent stays null.
                session.meta.title = "title v2";
                session.lastSeen = updated1 + 5000;
                const a2 = resolveEgressAuthority({ session, st: store, sessionId: S, core: [M("m1", "alpha"), M("m2", "beta")], log: quiet, armed: true });
                recordAuthorityTurn(store, S, a2, "sys", quiet);

                const count = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get(S) as { n: number }).n;
                assert.equal(count, 1, "still exactly one row after turn 2");
                const row2 = db.prepare("SELECT title, updated_at, created_at, parent_session_id FROM sessions WHERE session_id = ?").get(S) as { title: string | null; updated_at: number; created_at: number; parent_session_id: string | null };
                assert.equal(row2.title, "title v2", "the descriptive col blind-overwrites (title follows the session)");
                assert.equal(row2.updated_at, session.lastSeen, "updated_at advances (the GC freshness watermark)");
                assert.equal(row2.created_at, created1, "created_at is first-wins");
                assert.equal(row2.parent_session_id, null, "lineage untouched");
            } finally {
                store.close();
            }
        });
    } finally {
        rmrf(dir);
    }
});

test("#7735 R1: a deleted identity row self-heals on the next turn", () => {
    const dir = mkdtemp("bili-7735-selfheal-");
    try {
        withFlag(true, () => {
            const store = UnifiedStore.open(path.join(dir, "index.db"));
            const db = rawDbOf(store);
            try {
                const session = egSession();
                const a1 = resolveEgressAuthority({ session, st: store, sessionId: S, core: [M("m1", "alpha")], log: quiet, armed: true });
                recordAuthorityTurn(store, S, a1, "sys", quiet);
                assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get(S) as { n: number }).n, 1, "row present after turn 1");

                // operator/bug deletes the row — the next turn rebuilds it.
                db.prepare("DELETE FROM sessions WHERE session_id = ?").run(S);
                assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get(S) as { n: number }).n, 0, "row deleted");

                const a2 = resolveEgressAuthority({ session, st: store, sessionId: S, core: [M("m1", "alpha"), M("m2", "beta")], log: quiet, armed: true });
                recordAuthorityTurn(store, S, a2, "sys", quiet);
                assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get(S) as { n: number }).n, 1, "the row self-heals on the next turn");
            } finally {
                store.close();
            }
        });
    } finally {
        rmrf(dir);
    }
});

test("#7735 R1: a pre-seeded fork row is NOT reparented by the per-turn upsert", () => {
    const dir = mkdtemp("bili-7735-fork-");
    try {
        withFlag(true, () => {
            const store = UnifiedStore.open(path.join(dir, "index.db"));
            const db = rawDbOf(store);
            try {
                // the fork path (store.ts point-fork) writes parent +
                // fork_point_seq directly; the per-turn identity upsert must
                // not clobber that lineage (first parent wins).
                db.prepare(
                    "INSERT INTO sessions (session_id, parent_session_id, fork_point_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                ).run(S, "parent-sess", 42, Date.now(), Date.now());

                const session = egSession(); // no derivedFromSessionId → parent null
                const a1 = resolveEgressAuthority({ session, st: store, sessionId: S, core: [M("m1", "alpha")], log: quiet, armed: true });
                recordAuthorityTurn(store, S, a1, "sys", quiet);

                const row = db.prepare("SELECT parent_session_id, fork_point_seq FROM sessions WHERE session_id = ?").get(S) as { parent_session_id: string | null; fork_point_seq: number | null };
                assert.equal(row.parent_session_id, "parent-sess", "the pre-seeded parent survives (COALESCE keeps the existing)");
                assert.equal(row.fork_point_seq, 42, "the pre-seeded fork point survives (CASE keeps it when a parent exists)");
            } finally {
                store.close();
            }
        });
    } finally {
        rmrf(dir);
    }
});

test("#7735 R1: flag=0 — the seam never latches, so no identity row from the seam (#3617 negative direction)", () => {
    const dir = mkdtemp("bili-7735-flagoff-");
    try {
        withFlag(false, () => {
            assert.equal(featureEnabled("egressPlane"), false, "forced 0 resolves OFF");
            const store = UnifiedStore.open(path.join(dir, "index.db"));
            const db = rawDbOf(store);
            try {
                const session = egSession();
                // flag off → the lane is not armed → the seam returns before
                // the latch, so ensureEgressIdentity is never called.
                const a = resolveEgressAuthority({ session, st: store, sessionId: S, core: [M("m1", "alpha")], log: quiet, armed: false });
                recordAuthorityTurn(store, S, a, "sys", quiet);
                assert.equal(session.metadata["egressAuthority"], undefined, "the latch is NOT set when the plane is off");
                assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get(S) as { n: number }).n, 0, "no seam identity row (the full ingest would carry the payload cols)");
            } finally {
                store.close();
            }
        });
    } finally {
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// Group 3 — l1 dead-row cleanup (R3)
// ---------------------------------------------------------------------------

test("#7735 R3: the arm-turn dead row is deleted; the R3 breaker row and armed rows survive", () => {
    const dir = mkdtemp("bili-7735-l1-");
    try {
        // a MIXED db: open with the flag OFF first so all 12 tables (incl.
        // l1_world) exist, then exercise the cleanup on that same store.
        //
        // l1_world.sess_raw is the PK — one row per session, so the three
        // shapes (dead / R3-breaker / armed) are mutually exclusive states of
        // the SAME row. Test each with its own session id (its own sess_raw).
        withFlag(false, () => {
            const store = UnifiedStore.open(path.join(dir, "index.db"));
            const db = rawDbOf(store);
            try {
                assert.ok(tablesOf(db).includes("l1_world"), "the mixed db has l1_world");
                const seed = (sid: string, witness: string, armedAt: number | null, r3: number | null) =>
                    db.prepare("INSERT INTO l1_world (sess_raw, ledger_id, witness_probe, issued_at, armed_at, r3_latched_at) VALUES (?, ?, ?, ?, ?, ?)").run(sid, sid, witness, 1, armedAt, r3);
                const exists = (sid: string) => (db.prepare("SELECT COUNT(*) AS n FROM l1_world WHERE sess_raw = ?").get(sid) as { n: number }).n;

                // case 1 — dead row: witness non-empty, armed_at/r3_latched_at
                // NULL → the cleanup deletes it (the arm-turn orphan).
                seed("s-dead", "dead-witness", null, null);
                assert.equal(exists("s-dead"), 1, "dead row seeded");
                const aDead = resolveEgressAuthority({ session: egSession({}), st: store, sessionId: "s-dead", core: [M("m1", "alpha")], log: quiet, armed: true });
                recordAuthorityTurn(store, "s-dead", aDead, "sys", quiet);
                assert.equal(exists("s-dead"), 0, "the dead row is deleted by the identity-row seam");

                // case 2 — R3 breaker row: witness '' + r3_latched_at set →
                // the cleanup must NOT delete it (breaker memory is never swept).
                seed("s-breaker", "", null, 100);
                assert.equal(exists("s-breaker"), 1, "breaker row seeded");
                const aBreaker = resolveEgressAuthority({ session: egSession({}), st: store, sessionId: "s-breaker", core: [M("m1", "alpha")], log: quiet, armed: true });
                recordAuthorityTurn(store, "s-breaker", aBreaker, "sys", quiet);
                assert.equal(exists("s-breaker"), 1, "the R3 breaker row survives (r3_latched_at IS NOT NULL)");

                // case 3 — armed row: armed_at set → the cleanup must NOT delete it.
                seed("s-armed", "armed-witness", 200, null);
                assert.equal(exists("s-armed"), 1, "armed row seeded");
                const aArmed = resolveEgressAuthority({ session: egSession({}), st: store, sessionId: "s-armed", core: [M("m1", "alpha")], log: quiet, armed: true });
                recordAuthorityTurn(store, "s-armed", aArmed, "sys", quiet);
                assert.equal(exists("s-armed"), 1, "the armed row survives (armed_at IS NOT NULL)");
            } finally {
                store.close();
            }
        });
    } finally {
        rmrf(dir);
    }
});

test("#7735 R3: a fresh eg-mode DB (no l1_world) skips the cleanup silently", () => {
    const dir = mkdtemp("bili-7735-l1-none-");
    try {
        withFlag(true, () => {
            const store = UnifiedStore.open(path.join(dir, "index.db"));
            const db = rawDbOf(store);
            try {
                assert.ok(!tablesOf(db).includes("l1_world"), "a fresh eg-mode DB has no l1_world");
                // must not throw — the cleanup probes for the table and skips.
                const session = egSession();
                const a1 = resolveEgressAuthority({ session, st: store, sessionId: S, core: [M("m1", "alpha")], log: quiet, armed: true });
                recordAuthorityTurn(store, S, a1, "sys", quiet);
                assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get(S) as { n: number }).n, 1, "the identity row still lands");
            } finally {
                store.close();
            }
        });
    } finally {
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// Group 4 — kv 256-char cap (R7)
// ---------------------------------------------------------------------------

test("#7735 R7: kv cap — 256 passes, 257 throws with the key, whitelisted big value passes", () => {
    const dir = mkdtemp("bili-7735-kv-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const v256 = "x".repeat(256);
            const v257 = "x".repeat(257);
            // an object serializes to `{"v":"xxx..."}` — the JSON envelope adds
            // 8 chars, so the value char count is offset from the raw length.
            store.setKv("cfg", "ok", { v: v256.slice(0, 248) }); // serialized ≤ 256
            assert.doesNotThrow(() => store.setKv("cfg", "ok", { v: v256.slice(0, 248) }), "a serialized value at the cap passes");

            assert.throws(
                () => store.setKv("cfg", "too-big", { v: v257 }),
                (err: unknown) => err instanceof Error && err.message.includes("cfg|too-big") && err.message.includes("256"),
                "a serialized value over the cap throws with namespace|key in the message",
            );

            // the whitelisted frozen blobs are exempt (the 1.88 MB affinity
            // chain and the conversations table keep working).
            assert.doesNotThrow(
                () => store.setKv("prefix-affinity", "v1", { chain: "y".repeat(100_000) }),
                "the whitelisted prefix-affinity|v1 key accepts a large value",
            );
            assert.doesNotThrow(
                () => store.setKv("plugin-conversations", "table", { map: "z".repeat(100_000) }),
                "the whitelisted plugin-conversations|table key accepts a large value",
            );
        } finally {
            store.close();
        }
    } finally {
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// Group 5 — affinity / conversations gates (R4 + R5), predicate level
// ---------------------------------------------------------------------------

test("#7735 R4+R5: the eg-mode gate is the egressPlane predicate (#3617 both directions)", () => {
    // The gates (handle.ts explicit-client branch, plugin.ts
    // writeConversationsFile) key off featureEnabled("egressPlane"). Pin the
    // predicate in both directions; the full request-pipeline behavior rides
    // the codex e2e suite (§4: the request-pipeline change needs it).
    const saved = process.env.BILI_ROLLOUT_EGRESS_PLANE;
    try {
        process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
        assert.equal(featureEnabled("egressPlane"), true, "eg mode: the gate predicate is ON (the branches skip)");
        process.env.BILI_ROLLOUT_EGRESS_PLANE = "0";
        assert.equal(featureEnabled("egressPlane"), false, "legacy mode: the gate predicate is OFF (the branches write as before)");
    } finally {
        if (saved === undefined) delete process.env.BILI_ROLLOUT_EGRESS_PLANE;
        else process.env.BILI_ROLLOUT_EGRESS_PLANE = saved;
    }
});

// ---------------------------------------------------------------------------
// Group 6 — convergence (R2)
// ---------------------------------------------------------------------------

test("#7735 R2: an eg-mode fresh DB converges to the 12 legacy tables when the flag flips off", () => {
    const dir = mkdtemp("bili-7735-converge-");
    const file = path.join(dir, "index.db");
    try {
        // born as a fresh eg-mode DB (7 tables)
        withFlag(true, () => {
            const { db } = openSqliteDatabase(file);
            try {
                migrateSchema(db, { legacyTables: false });
                assert.deepEqual(tablesOf(db), CORE_TABLES, "born with the 7 CORE tables");
            } finally {
                db.close();
            }
        });
        // the operator flips the flag off — the next open converges the 12
        // legacy tables (probe-first, idempotent; the CORE tables no-op).
        withFlag(false, () => {
            const { db } = openSqliteDatabase(file);
            try {
                migrateSchema(db, { legacyTables: true });
                const tables = tablesOf(db);
                for (const t of LEGACY_TABLES) {
                    assert.ok(tables.includes(t), `${t} is converged back on the flag-off open`);
                }
                assert.equal(tables.length, 19, "7 CORE + 12 legacy = 19 tables");
            } finally {
                db.close();
            }
        });
        // idempotent: opening again with the flag off is a no-op
        withFlag(false, () => {
            const { db } = openSqliteDatabase(file);
            try {
                migrateSchema(db, { legacyTables: true });
                assert.equal(tablesOf(db).length, 19, "the convergence is idempotent");
            } finally {
                db.close();
            }
        });
    } finally {
        rmrf(dir);
    }
});

test("#7735 R2: a legacy DB opened in eg mode keeps its 12 tables (K5: never drop)", () => {
    const dir = mkdtemp("bili-7735-keep-");
    const file = path.join(dir, "index.db");
    try {
        // born as a legacy DB (all 19 tables)
        withFlag(false, () => {
            const { db } = openSqliteDatabase(file);
            try {
                migrateSchema(db, { legacyTables: true });
                assert.equal(tablesOf(db).length, 19, "a legacy DB has all 19 tables");
            } finally {
                db.close();
            }
        });
        // reopened in eg mode — the 12 legacy tables are NOT dropped
        withFlag(true, () => {
            const { db } = openSqliteDatabase(file);
            try {
                migrateSchema(db, { legacyTables: false });
                const tables = tablesOf(db);
                for (const t of LEGACY_TABLES) {
                    assert.ok(tables.includes(t), `${t} survives the eg-mode reopen (K5: never drop)`);
                }
                assert.equal(tables.length, 19, "all 19 tables survive");
            } finally {
                db.close();
            }
        });
    } finally {
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// Group 7 — flag defaults (R8)
// ---------------------------------------------------------------------------

test("#7735 R8: the three egress flags default to percent 0 (the ci:full 100 is reverted)", () => {
    assert.equal(ROLLOUT_FEATURES["egressPlane"]?.percent, 0, "egressPlane defaults to 0 (off)");
    assert.equal(ROLLOUT_FEATURES["egressKstateRetireWrites"]?.percent, 0, "egressKstateRetireWrites defaults to 0 (off)");
    assert.equal(ROLLOUT_FEATURES["egressKstateRebuild"]?.percent, 0, "egressKstateRebuild defaults to 0 (off)");
});
