/**
 * #4949: two defects in the unified-store resilience path, pinned together
 * because they share one failure domain (transient storage failure):
 *
 *   A. ERROR MASKING — src/storage/driver.ts's node:sqlite transaction
 *      emulation ran ROLLBACK unconditionally in its catch block. When an
 *      I/O-class failure (disk full / SQLITE_FULL) aborts BEGIN or COMMIT,
 *      SQLite has already rolled the transaction back by itself, so the
 *      follow-up ROLLBACK throws "cannot rollback - no transaction is
 *      active" and REPLACES the original error — operators saw the
 *      confusing secondary error instead of the real disk-full cause (the
 *      exact signature reported in #4949). Constraint-class failures (FK
 *      etc.) do NOT trigger the mask — verified during triage — which is
 *      why the repro below injects a COMMIT-phase I/O abort with real
 *      SQLite auto-abort semantics.
 *
 *   B. PERMANENT BREAKER — src/storage/shadow.ts's 3-strike circuit breaker
 *      used to have no recovery path: once stats.disabled flipped, every
 *      facade missed until process restart, even after storage healed. The
 *      breaker itself is GONE now (owner policy 2026-10-30: index writes are
 *      NEVER abandoned — "100 real-world failure shapes", not just 3): every
 *      save attempts the index write regardless of prior failures, errors
 *      still surface to the caller (the JSON envelope serves meanwhile), and
 *      healing needs no probe or cooldown — the next save simply lands.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { openSqliteDatabase, setDatabaseSyncFactoryForTests, setPreferredSqliteEngineForTests, type NodeSqliteDatabase } from "../src/storage/driver.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import { setLogCapture } from "../src/logger.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: a developer machine with
// storage.unified in its real config must not leak a tier into these tests.
const HERMETIC = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4949-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC, "no-config.json");
delete process.env.BILI_STORAGE_UNIFIED;

type Captured = { level: string; msg: string };

function captureLogs(): { captured: Captured[]; stop: () => void } {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    return { captured, stop: () => setLogCapture(null) };
}

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

interface ShadowStatsView {
    ingests: number;
    disabled: boolean;
    lastError: string | null;
}

function stats(shadow: UnifiedShadow): ShadowStatsView {
    return (shadow as unknown as { stats: ShadowStatsView }).stats;
}

/** Adapter over a REAL DatabaseSync: while unhealthy, write-control
 *  statements fail with a disk-full-shaped error exactly where the engine
 *  would (BEGIN/COMMIT/savepoint/row writes). Reads stay alive — a full disk
 *  does not make the database unreadable. ROLLBACK is deliberately NOT
 *  gated: the real engine answers it, which is what makes the pre-fix mask
 *  ("cannot rollback - no transaction is active") observable. */
class FlakyHandle implements NodeSqliteDatabase {
    unhealthy = false;
    beginAttempts = 0;
    constructor(private readonly real: InstanceType<typeof DatabaseSync>) {}
    exec(sql: string): unknown {
        const t = sql.trim();
        if (this.unhealthy && /^(BEGIN|SAVEPOINT|INSERT|UPDATE|DELETE|COMMIT)\b/i.test(t)) {
            if (/^BEGIN\b/i.test(t)) this.beginAttempts++;
            throw new Error("SQLITE_FULL: database or disk is full");
        }
        return this.real.exec(sql);
    }
    prepare(sql: string) {
        const s = this.real.prepare(sql);
        return {
            run: (...args: unknown[]) => s.run(...(args as SQLInputValue[])),
            get: (...args: unknown[]) => s.get(...(args as SQLInputValue[])),
            all: (...args: unknown[]) => s.all(...(args as SQLInputValue[])),
        };
    }
    getAutoCommit(): boolean {
        return true;
    }
    get open(): boolean {
        return this.real.isOpen;
    }
    close(): void {
        this.real.close();
    }
}

/** Adapter whose COMMIT behaves like a real I/O-class commit failure:
 *  SQLite aborts the transaction by itself before surfacing the error. */
class CommitAbortHandle implements NodeSqliteDatabase {
    private abortMessage: string | null = null;
    constructor(private readonly real: InstanceType<typeof DatabaseSync>) {}
    armCommitAbort(message: string): void {
        this.abortMessage = message;
    }
    exec(sql: string): unknown {
        const t = sql.trim();
        if (this.abortMessage !== null && /^COMMIT\b/i.test(t)) {
            const m = this.abortMessage;
            this.abortMessage = null;
            this.real.exec("ROLLBACK");
            throw new Error(m);
        }
        return this.real.exec(sql);
    }
    prepare(sql: string) {
        const s = this.real.prepare(sql);
        return {
            run: (...args: unknown[]) => s.run(...(args as SQLInputValue[])),
            get: (...args: unknown[]) => s.get(...(args as SQLInputValue[])),
            all: (...args: unknown[]) => s.all(...(args as SQLInputValue[])),
        };
    }
    getAutoCommit(): boolean {
        return true;
    }
    get open(): boolean {
        return this.real.isOpen;
    }
    close(): void {
        this.real.close();
    }
}

// ---------------------------------------------------------------------------
// A. Commit-phase I/O failure must surface the ORIGINAL error, never the
//    secondary "cannot rollback" mask.
// ---------------------------------------------------------------------------

test("#4949 A: a failed COMMIT surfaces the original error, not 'cannot rollback'", () => {
    const dir = tmpDir("mask");
    const dbPath = path.join(dir, "index.db");
    try {
        const real = new DatabaseSync(dbPath);
        real.exec("CREATE TABLE t(x INTEGER)");
        real.exec("INSERT INTO t(x) VALUES (0)");
        const handle = new CommitAbortHandle(real);
        setDatabaseSyncFactoryForTests(() => handle);
        const { db } = openSqliteDatabase(dbPath, "node:sqlite");
        try {
            assert.equal(db.transaction(() => 42), 42, "sanity: plain transactions work");

            handle.armCommitAbort("SQLITE_FULL: database or disk is full");
            let thrown: unknown;
            try {
                db.transaction(() => {
                    db.exec("INSERT INTO t(x) VALUES (2)");
                    return 1;
                });
            } catch (e) {
                thrown = e;
            }
            assert.ok(thrown instanceof Error, "the failed transaction must throw");
            const err = thrown as Error;
            // The reported #4949 signature: pre-fix this threw
            // "cannot rollback - no transaction is active" instead.
            assert.match(err.message, /disk is full/, `original error must survive: ${err.message}`);
            assert.doesNotMatch(err.message, /cannot rollback/, `secondary mask leaked: ${err.message}`);

            // State bookkeeping survived the aborted transaction: the next
            // real transaction commits cleanly and the aborted row is gone.
            assert.equal(db.transaction(() => { db.exec("INSERT INTO t(x) VALUES (3)"); return 7; }), 7);
            const rows = db.prepare("SELECT x FROM t ORDER BY x").all() as { x: number | bigint }[];
            assert.deepEqual(rows.map((r) => Number(r.x)), [0, 3], "aborted insert must not persist");
        } finally {
            setDatabaseSyncFactoryForTests(null);
            handle.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

// ---------------------------------------------------------------------------
// A2. The nested-savepoint path keeps working through the guarded rollback
//     (constraint-class commit failure: the transaction survives, so the
//     rollback MUST still run — this pins that the guard swallows ONLY the
//     secondary error, never the primary cleanup).
// ---------------------------------------------------------------------------

test("#4949 A2: nested transactions roll back cleanly on a constraint failure", () => {
    const dir = tmpDir("nest");
    const dbPath = path.join(dir, "index.db");
    try {
        setPreferredSqliteEngineForTests("node:sqlite");
        const { db } = openSqliteDatabase(dbPath, "node:sqlite");
        try {
            db.exec("CREATE TABLE p(id INTEGER PRIMARY KEY)");
            db.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)");

            let thrown: unknown;
            try {
                db.transaction(() => {
                    db.transaction(() => {
                        db.exec("INSERT INTO c(id, pid) VALUES (1, 999)");
                    });
                    return "outer";
                });
            } catch (e) {
                thrown = e;
            }
            assert.ok(thrown instanceof Error, "the failed transaction must throw");
            const err = thrown as Error;
            assert.match(err.message, /FOREIGN KEY/, `original constraint error must survive: ${err.message}`);
            assert.doesNotMatch(err.message, /cannot rollback/, `unexpected secondary error: ${err.message}`);

            const rows = db.prepare("SELECT COUNT(*) AS n FROM c").get() as { n: number | bigint };
            assert.equal(Number(rows.n), 0, "nothing may persist from a failed nested tree");
            assert.equal(db.transaction(() => { db.exec("INSERT INTO p(id) VALUES (1)"); return "ok"; }), "ok");
        } finally {
            db.close();
            setPreferredSqliteEngineForTests(null);
        }
    } finally {
        rmBestEffort(dir);
    }
});

// ---------------------------------------------------------------------------
// B. Full breaker loop: 3 strikes disable with the TRUE error visible, the
//    cooldown gates probe frequency, healing + one probe re-enables, and the
//    triggering record lands in the unified store.
// ---------------------------------------------------------------------------

test("#4949 B: a failing sidecar never self-disables — every save retries, healing is instant", () => {
    const dir = tmpDir("breaker");
    const dbPath = path.join(dir, "index.db");
    try {
        const real = new DatabaseSync(dbPath);
        const flaky = new FlakyHandle(real);
        setDatabaseSyncFactoryForTests(() => flaky);
        setPreferredSqliteEngineForTests("node:sqlite");
        const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
        assert.ok(shadow, "shadow sidecar must open");
        const { captured, stop } = captureLogs();
        try {
            // Warm: the store is healthy, one real ingest lands.
            shadow.record(mkLegacy("s1", [msg(0)]));
            assert.equal(stats(shadow).disabled, false);
            assert.ok(stats(shadow).ingests >= 1, "warm ingest must land");

            // Storage exhausts: three consecutive failures surface loudly —
            // but NOTHING disables: index writes are never abandoned (the
            // 3-strike breaker was removed per owner policy 2026-10-30).
            flaky.unhealthy = true;
            for (let i = 1; i <= 3; i++) {
                shadow.record(mkLegacy("s1", Array.from({ length: i + 1 }, (_, j) => msg(j))));
            }
            assert.equal(stats(shadow).disabled, false, "consecutive failures must NOT disable the sidecar any more");
            const lastErr = stats(shadow).lastError ?? "";
            assert.match(lastErr, /disk is full/, `status wire must carry the real cause: ${lastErr}`);
            assert.doesNotMatch(lastErr, /cannot rollback/, `masked error reached the status wire: ${lastErr}`);

            // Rapid saves keep retrying — nothing is muted and nothing is
            // gated: every save still reaches the broken store (each failed
            // record costs >= 1 real BEGIN; the store may internally
            // re-enter its guarded BEGIN/SAVEPOINT cycle before surfacing).
            const beginsBeforeRapid = flaky.beginAttempts;
            shadow.record(mkLegacy("s1", [msg(0), msg(1)]));
            shadow.record(mkLegacy("s1", [msg(0), msg(1)]));
            const delta = flaky.beginAttempts - beginsBeforeRapid;
            assert.ok(delta >= 2 && delta <= 8, `both rapid saves must attempt real index writes (saw ${delta} BEGINs)`);
            // The facade keeps working through the whole outage (shadow mode
            // serves JSON reads regardless; full mode's unified reads are
            // unaffected by ingest failures by design of readsUnified).
            assert.equal(stats(shadow).disabled, false, "still not disabled after rapid failing saves");
            assert.equal(captured.filter((e) => e.msg.includes("RE-ENABLED")).length, 0, "no RE-ENABLED surface may exist any more");

            // Operator frees space: the store heals. NO probe, NO cooldown —
            // the very next save lands in the index straight away.
            flaky.unhealthy = false;
            const ingestsBefore = stats(shadow).ingests;
            shadow.record(mkLegacy("s1", Array.from({ length: 7 }, (_, j) => msg(j))));
            assert.ok(stats(shadow).ingests > ingestsBefore, "the post-heal record lands immediately");
            // The last observed failure stays visible for operators (there is
            // no auto-cleanup of the error surface any more) — what is gone
            // is the ABANDONMENT: the next write already landed above.
            assert.match(stats(shadow).lastError ?? "", /disk is full/, "the error surface still names the cause");
        } finally {
            stop();
            shadow.close();
            setDatabaseSyncFactoryForTests(null);
            setPreferredSqliteEngineForTests(null);
        }
    } finally {
        rmBestEffort(dir);
    }
});

// ---------------------------------------------------------------------------
// C. The breaker itself must not come back: there is no self-disable, no
//    cooldown constant, no probe state anywhere in the shadow module.
// ---------------------------------------------------------------------------

test("#4949 C: the 3-strike breaker is gone for good (no re-disable surface left)", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname ?? ".", "..", "src", "storage", "shadow.ts"), "utf8");
    assert.doesNotMatch(src, /REENABLE_PROBE_COOLDOWN_MS/, "no re-enable cooldown constant may exist");
    assert.doesNotMatch(src, /nextReenableProbeAt/, "no probe-state field may exist");
    assert.match(src, /NEVER gives up on index writes/, "the no-abandonment policy is documented at the top of the module");
});
