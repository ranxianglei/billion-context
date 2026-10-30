/**
 * #4666: duplicate message rows must be cleaned up by the v8 migration on
 * BOTH backends.
 *
 * Pre-#4390 wireIndex-split generations left libraries with several rows per
 * logical message (same session_id + msg_id, different content_hash, identical
 * identity once id/wireIndex are stripped). The sqlite v8 migration step
 * (src/storage/schema.ts) backfilled identity AND collapsed each group to its
 * lowest-seq arrival, handing the dropped rows' CAS refs back. The MySQL
 * upgrade (src/storage/mysql.ts init()) did the backfill but skipped the
 * collapse — affected libraries replay every duplicate forever, and #4390's
 * historian sweep can never remove them (both rows "hit" the incoming
 * identity set).
 *
 * This suite pins, on both lanes:
 *  - the v8 upgrade collapses each (session_id, msg_id, identity) group to
 *    its lowest seq and refunds every dropped row's CAS refs (media + text);
 *  - the MySQL data step is gated on the bili_meta schema_version STAMP, not
 *    column presence — a crash between the ALTERs and the backfill re-runs on
 *    the next boot instead of stranding rows at identity='';
 *  - the decRef floor (refcount > 0) keeps an already-corrupt ledger from
 *    going negative during migration;
 *  - verifyProjections covers RETIRED rows too (a tombstone-only mutation
 *    keeps projections intact — drift there must fail the check).
 *
 * The MySQL lane additionally pins the review rework (#4678 round 2):
 *  - the data step streams one session per transaction over 500-row pages
 *    (parity with schema.ts' #4677 rework) — a duplicate whose two
 *    generations sit on different pages is still paired;
 *  - concurrent boots serialize on a server-side named lock: the second
 *    instance's data step waits while another holds it, and sessions created
 *    BEHIND the lock are still processed (enumeration happens after acquire,
 *    not before).
 *
 * The sqlite lane always runs; the mysql lane needs BILI_MYSQL_TEST_DSN (CI:
 * the mysql-contract job, same service as storage-backend-contract) and runs
 * in an isolated throwaway database so the shared CI database is untouched.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore, sha256Hex } from "../src/storage/store.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { STORAGE_DDL_V1_FOR_TESTS } from "../src/storage/schema.ts";
import { identityOfStoredContent } from "../src/storage/identity.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { openBackend, type StorageBackend } from "../src/storage/backend.ts";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: a developer machine with
// storage settings in its real config must not leak into these tests.
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4666-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");

const MYSQL_DSN = process.env.BILI_MYSQL_TEST_DSN ?? "";

type RawDb = ReturnType<typeof openSqliteDatabase>["db"];

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The dirty fixture: four (msg_id, identity) groups over one session.
 *  mA: dup pair (seq 5 kept, seq 9 dropped, media on the dropped row)
 *  mB: triple (seq 2 kept, seq 7 + seq 11 dropped)
 *  mC: unique clean row (survives, identity backfilled)
 *  mD: dup pair whose dropped row points at a content row ALREADY at
 *      refcount 0 (corrupt ledger — the decRef floor must hold it at 0). */
const FIXTURE = (() => {
    const cA1 = JSON.stringify({ id: "mA", role: "user", contentType: "text", text: "alpha", wireIndex: 1 });
    const cA2 = JSON.stringify({ id: "mA", role: "user", contentType: "text", text: "alpha", wireIndex: 9 });
    const cB1 = JSON.stringify({ id: "mB", role: "user", contentType: "text", text: "beta", wireIndex: 0 });
    const cB2 = JSON.stringify({ id: "mB", role: "user", contentType: "text", text: "beta", wireIndex: 3 });
    const cB3 = JSON.stringify({ id: "mB", role: "user", contentType: "text", text: "beta", wireIndex: 4 });
    const cC1 = JSON.stringify({ id: "mC", role: "assistant", contentType: "text", text: "gamma" });
    const cD1 = JSON.stringify({ id: "mD", role: "user", contentType: "text", text: "delta", wireIndex: 1 });
    const cD2 = JSON.stringify({ id: "mD", role: "user", contentType: "text", text: "delta", wireIndex: 2 });
    const MEDIA = "media-bytes-on-the-dropped-row";
    return { cA1, cA2, cB1, cB2, cB3, cC1, cD1, cD2, MEDIA };
})();

function putContentRow(db: RawDb, body: string, refcount: number): string {
    const bytes = Buffer.from(body, "utf8");
    const hash = sha256Hex(bytes);
    db.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, ?, 'sha256', ?)")
        .run(hash, bytes.byteLength, refcount, body);
    return hash;
}

function seedDirtyFixture(db: RawDb, session: string): Record<string, string> {
    const hashes: Record<string, string> = {};
    for (const key of ["cA1", "cA2", "cB1", "cB2", "cB3", "cC1", "cD1", "MEDIA"] as (keyof typeof FIXTURE)[]) {
        hashes[key] = putContentRow(db, FIXTURE[key], 1);
    }
    // The corrupt-ledger row: correct bytes/hash, refcount already 0.
    hashes.cD2 = putContentRow(db, FIXTURE.cD2, 0);
    const insMsg = db.prepare(
        "INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash) VALUES (?, ?, ?, NULL, NULL, ?, 'message', ?)",
    );
    const rows: [number, string, string, keyof typeof FIXTURE][] = [
        [1, "mC", "assistant", "cC1"],
        [2, "mB", "user", "cB1"],
        [3, "mD", "user", "cD1"],
        [4, "mD", "user", "cD2"],
        [5, "mA", "user", "cA1"],
        [7, "mB", "user", "cB2"],
        [9, "mA", "user", "cA2"],
        [11, "mB", "user", "cB3"],
    ];
    for (const [seq, msgId, role, key] of rows) insMsg.run(session, seq, msgId, role, hashes[key]);
    db.prepare("INSERT INTO message_media (session_id, seq, media_hash) VALUES (?, ?, ?)").run(session, 9, hashes.MEDIA);
    return hashes;
}

/** Builds a faithful pre-v8 library: the current DDL minus the two v8
 *  columns (regex-strip discipline of the schema-v2 proof in
 *  storage-unified.test.ts), dirty fixture rows, user_version = 7. */
function buildLegacyDirtySqliteDir(): string {
    const dir = tmpdir("bili-4666-sqlite-legacy-");
    const { db } = openSqliteDatabase(path.join(dir, "index.db"));
    const ddl = STORAGE_DDL_V1_FOR_TESTS
        .replace(/^\s*identity\s+TEXT NOT NULL DEFAULT '',\n/m, "")
        .replace(/^\s*retired_at\s+INTEGER,\n/m, "");
    db.exec(ddl);
    seedDirtyFixture(db, "s1");
    db.exec("PRAGMA user_version = 7");
    db.close();
    return dir;
}

function refcountOf(db: RawDb, hash: string): number | null {
    const r = db.prepare("SELECT refcount FROM content WHERE hash = ?").get(hash) as { refcount: number } | undefined;
    return r?.refcount ?? null;
}

test("#4666 sqlite: v8 migration collapses wireIndex-split duplicates and refunds their CAS refs", () => {
    const dir = buildLegacyDirtySqliteDir();
    let store: UnifiedStore | undefined;
    let check: RawDb | undefined;
    try {
        store = UnifiedStore.open(path.join(dir, "index.db"));
        check = openSqliteDatabase(path.join(dir, "index.db")).db;

        const ver = check.prepare("PRAGMA user_version").get() as { user_version: number };
        assert.equal(ver.user_version, 9, "stamped to v9");

        // Exactly the lowest-seq arrival of each (msg_id, identity) group.
        const survivors = check
            .prepare("SELECT seq, msg_id, content_hash, identity FROM messages WHERE session_id = 's1' ORDER BY seq")
            .all() as { seq: number; msg_id: string; content_hash: string; identity: string }[];
        assert.deepEqual(
            survivors.map((r) => r.seq),
            [1, 2, 3, 5],
            "groups collapse to their first arrival; everything else is gone",
        );
        const bySeq = new Map(survivors.map((r) => [r.seq, r]));
        assert.equal(bySeq.get(5)!.content_hash, sha256Hex(FIXTURE.cA1), "kept generation is the lowest-seq bytes");
        assert.equal(bySeq.get(5)!.identity, identityOfStoredContent(FIXTURE.cA1), "identity backfilled from stored bytes");
        assert.equal(bySeq.get(2)!.identity, identityOfStoredContent(FIXTURE.cB1));
        assert.equal(bySeq.get(3)!.identity, identityOfStoredContent(FIXTURE.cD1));
        assert.equal(bySeq.get(1)!.identity, identityOfStoredContent(FIXTURE.cC1), "unique row backfilled too");

        // Refunds: every dropped row handed its CAS refs back (text + media).
        const h = (body: string) => sha256Hex(body);
        assert.equal(refcountOf(check, h(FIXTURE.cA2)), 0, "dropped dup refunded");
        assert.equal(refcountOf(check, h(FIXTURE.cB2)), 0);
        assert.equal(refcountOf(check, h(FIXTURE.cB3)), 0);
        assert.equal(refcountOf(check, h(FIXTURE.MEDIA)), 0, "media mapping of the dropped row released");
        assert.equal(refcountOf(check, h(FIXTURE.cA1)), 1, "kept rows untouched");
        assert.equal(refcountOf(check, h(FIXTURE.cB1)), 1);
        assert.equal(refcountOf(check, h(FIXTURE.cD1)), 1);
        assert.equal(refcountOf(check, h(FIXTURE.cC1)), 1);
        // Corrupt-ledger floor: the dropped row pointed at a content row
        // already at 0 — the floor holds it at 0 instead of driving -1.
        assert.equal(refcountOf(check, h(FIXTURE.cD2)), 0, "decRef floor: never negative");

        const mediaLeft = check.prepare("SELECT COUNT(*) AS n FROM message_media WHERE session_id = 's1'").get() as { n: number };
        assert.equal(mediaLeft.n, 0, "no media mappings survive on dropped rows");

        // Replay view: the survivor is byte-exact.
        const msgs = store.getMessages("s1");
        assert.equal(msgs.length, 4, "replay shows one row per logical message");
        const kept = msgs.find((m) => m.contentHash === h(FIXTURE.cA1))!;
        assert.equal(kept.content, FIXTURE.cA1, "kept generation replays verbatim");
    } finally {
        check?.close();
        store?.close();
        rmBestEffort(dir);
        fs.rmSync(hermetic, { recursive: true, force: true });
    }
});

interface CoreMsg { id: string; role: string; contentType: string; text: string }
const mkMsg = (id: string, text: string): CoreMsg => ({ id, role: "user", contentType: "text", text });

function mkSession(id: string, msgs: CoreMsg[]): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai", label: `label-${id}` },
        stats: {},
        metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
        blockContents: new Map(),
        lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    } as unknown as LegacySessionLike;
}

/** Both store shapes (sync sqlite / async mysql) behind one helper. */
type Ingester = {
    ingestSession(input: ReturnType<typeof planIngest>, delta?: unknown, opts?: { completeLog?: boolean }): boolean | Promise<boolean>;
};

async function retireSecondMessage(store: Ingester, sid: string): Promise<void> {
    const m1 = mkMsg("vm1", "first ".repeat(20));
    const m2 = mkMsg("vm2", "second ".repeat(20));
    assert.equal(await store.ingestSession(planIngest(mkSession(sid, [m1, m2])), undefined, { completeLog: true }), true, "initial complete ingest applies");
    assert.equal(await store.ingestSession(planIngest(mkSession(sid, [m1])), undefined, { completeLog: true }), true, "shorter authoritative log applies");
}

test("#4666 sqlite: verifyProjections catches projection drift on RETIRED rows", async () => {
    const dir = tmpdir("bili-4666-sqlite-retired-");
    let store: UnifiedStore | undefined;
    try {
        store = UnifiedStore.open(path.join(dir, "index.db"));
        const sid = "sess-retired";
        await retireSecondMessage(store, sid);

        const all = store.getMessages(sid, { includeRetired: true });
        assert.equal(all.length, 2, "rewind left the second message as a tombstone");
        assert.equal(all.filter((m) => m.retiredAt !== null).length, 1, "exactly one retired row");

        // Control: intact projections pass even WITH a retired row present.
        const clean = store.verifyProjections(sid);
        assert.ok(clean.ok, `intact projections verify (${clean.ok ? clean.checks : clean.error})`);

        // Corrupt a projection on the RETIRED row only.
        const db = (store as unknown as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }).db;
        db.prepare("UPDATE messages SET role = 'system' WHERE session_id = ? AND retired_at IS NOT NULL").run(sid);
        const broken = store.verifyProjections(sid);
        assert.equal(broken.ok, false, "retired-row drift must fail the check");
        assert.match(broken.ok ? "" : broken.error, /\.role/, "failure names the drifted field");
    } finally {
        store?.close();
        rmBestEffort(dir);
        fs.rmSync(hermetic, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// MySQL lane: same pins against a real MySQL 8.0 (BILI_MYSQL_TEST_DSN).
// Each test runs in its own throwaway database — the surgery below mutates
// table shapes, so the shared CI database stays untouched.
// ---------------------------------------------------------------------------

interface MysqlConn {
    query(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
    release(): void;
}

interface MysqlHarness {
    dsn: string;
    q(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
    connection(): Promise<MysqlConn>;
    stamp(): Promise<string>;
    refcount(hash: string): Promise<number | null>;
    insContent(body: string, refcount: number): Promise<string>;
    insMsg(sid: string, seq: number, msgId: string, role: string, contentHash: string): Promise<void>;
    rewindToV7(): Promise<void>;
}

async function createMysqlHarness(t: TestContext): Promise<MysqlHarness> {
    const driver = await import("mysql2/promise");
    const dbname = `bili_i4666_${Date.now()}`;
    const admin = driver.createPool(MYSQL_DSN);
    await admin.query(`CREATE DATABASE ${dbname} CHARACTER SET utf8mb4`);
    const url = new URL(MYSQL_DSN);
    url.pathname = `/${dbname}`;
    const dsn = url.toString();
    const raw = driver.createPool(dsn);
    t.after(async () => {
        await raw.end();
        await admin.query(`DROP DATABASE IF EXISTS ${dbname}`);
        await admin.end();
    });
    const q = async (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> => {
        const [rows] = (await raw.query(sql, args)) as unknown as [Record<string, unknown>[]];
        return rows;
    };
    return {
        dsn,
        q,
        connection: async () => {
            const conn = await raw.getConnection();
            return {
                query: async (sql, args = []) => ((await conn.query(sql, args)) as unknown as [Record<string, unknown>[]])[0],
                release: () => conn.release(),
            };
        },
        stamp: async () => String((await q("SELECT meta_value FROM bili_meta WHERE meta_key = 'schema_version'"))[0]?.meta_value ?? ""),
        refcount: async (hash) => {
            const rows = await q("SELECT refcount FROM content WHERE hash = ?", [hash]);
            return rows.length > 0 ? Number(rows[0].refcount) : null;
        },
        insContent: async (body, rc) => {
            const hash = sha256Hex(body);
            await q("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, ?, 'sha256', ?)", [hash, Buffer.byteLength(body), rc, body]);
            return hash;
        },
        insMsg: async (sid, seq, msgId, role, contentHash) => {
            // Deliberately no identity column in the insert list: valid both
            // before the ALTER adds it and after (the DEFAULT '' marks such
            // rows as unbackfilled either way).
            await q(
                "INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash) VALUES (?, ?, ?, NULL, NULL, ?, 'message', ?)",
                [sid, seq, msgId, role, contentHash],
            );
        },
        rewindToV7: async () => {
            await q("ALTER TABLE messages DROP INDEX idx_messages_identity, DROP COLUMN identity, DROP COLUMN retired_at");
            await q("UPDATE bili_meta SET meta_value = '7' WHERE meta_key = 'schema_version'");
        },
    };
}

async function seedDirtyFixtureMysql(H: MysqlHarness, session: string): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    for (const key of ["cA1", "cA2", "cB1", "cB2", "cB3", "cC1", "cD1", "MEDIA"] as (keyof typeof FIXTURE)[]) {
        hashes[key] = await H.insContent(FIXTURE[key], 1);
    }
    // The corrupt-ledger row: correct bytes/hash, refcount already 0.
    hashes.cD2 = await H.insContent(FIXTURE.cD2, 0);
    const rows: [number, string, string, keyof typeof FIXTURE][] = [
        [1, "mC", "assistant", "cC1"],
        [2, "mB", "user", "cB1"],
        [3, "mD", "user", "cD1"],
        [4, "mD", "user", "cD2"],
        [5, "mA", "user", "cA1"],
        [7, "mB", "user", "cB2"],
        [9, "mA", "user", "cA2"],
        [11, "mB", "user", "cB3"],
    ];
    for (const [seq, msgId, role, key] of rows) await H.insMsg(session, seq, msgId, role, hashes[key]);
    await H.q("INSERT INTO message_media (session_id, seq, media_hash) VALUES (?, 9, ?)", [session, hashes.MEDIA]);
    return hashes;
}

test("#4666 mysql: v8 upgrade collapses duplicates, crash-safe stamp gate, retired-row verification",
    { skip: MYSQL_DSN.length === 0 ? "set BILI_MYSQL_TEST_DSN to run" : false },
    async (t) => {
        const H = await createMysqlHarness(t);
        let be: StorageBackend | undefined;
        try {
            // Fresh install lands at v9.
            be = await openBackend("mysql", H.dsn);
            await be.init?.();
            assert.equal(await H.stamp(), "9", "fresh install stamped v9");

            // Downgrade to the legacy v7 shape and plant the dirty fixture.
            await H.rewindToV7();
            const hashes = await seedDirtyFixtureMysql(H, "s1");

            // Fresh boot migrates: ALTERs + streaming backfill/dedup.
            await be.close();
            be = await openBackend("mysql", H.dsn);
            await be.init?.();
            assert.equal(await H.stamp(), "9", "upgrade stamped v9");

            const survivors = await H.q("SELECT seq, msg_id, content_hash, identity FROM messages WHERE session_id = 's1' ORDER BY seq");
            assert.deepEqual(
                survivors.map((r) => Number(r.seq)),
                [1, 2, 3, 5],
                "groups collapse to their first arrival (the pre-fix tree kept all eight)",
            );
            const bySeq = new Map(survivors.map((r) => [Number(r.seq), r]));
            assert.equal(String(bySeq.get(5)!.content_hash), hashes.cA1, "kept generation is the lowest-seq bytes");
            assert.equal(String(bySeq.get(5)!.identity), identityOfStoredContent(FIXTURE.cA1), "identity backfilled from stored bytes");
            assert.equal(String(bySeq.get(1)!.identity), identityOfStoredContent(FIXTURE.cC1), "unique row backfilled too");

            assert.equal(await H.refcount(hashes.cA2), 0, "dropped dup refunded");
            assert.equal(await H.refcount(hashes.cB2), 0);
            assert.equal(await H.refcount(hashes.cB3), 0);
            assert.equal(await H.refcount(hashes.MEDIA), 0, "media mapping of the dropped row released");
            assert.equal(await H.refcount(hashes.cA1), 1, "kept rows untouched");
            assert.equal(await H.refcount(hashes.cB1), 1);
            assert.equal(await H.refcount(hashes.cD1), 1);
            assert.equal(await H.refcount(hashes.cC1), 1);
            assert.equal(await H.refcount(hashes.cD2), 0, "decRef floor: corrupt ledger held at 0, not driven negative");
            const mediaLeft = await H.q("SELECT COUNT(*) AS n FROM message_media WHERE session_id = 's1'");
            assert.equal(Number(mediaLeft[0].n), 0, "no media mappings survive on dropped rows");

            const replay = await be.getMessages("s1");
            assert.equal(replay.length, 4, "replay shows one row per logical message");
            assert.equal(replay.find((m) => m.contentHash === hashes.cA1)!.content, FIXTURE.cA1, "kept generation replays verbatim");

            // Crash-recovery arm: columns present but the stamp still says 7
            // (crash between the ALTERs and the data step) plus unbackfilled
            // legacy rows — the gate keys on the STAMP, so init re-runs. One
            // planted row additionally points at content bytes MISSING from
            // the CAS: the LEFT JOIN must terminate its session via the
            // printable absent marker instead of rescanning forever.
            const cE1 = JSON.stringify({ id: "mE", role: "user", contentType: "text", text: "eps", wireIndex: 1 });
            const cE2 = JSON.stringify({ id: "mE", role: "user", contentType: "text", text: "eps", wireIndex: 2 });
            await H.q("UPDATE bili_meta SET meta_value = '7' WHERE meta_key = 'schema_version'");
            await H.insContent(cE1, 1);
            await H.insContent(cE2, 1);
            await H.insMsg("s2", 5, "mE", "user", sha256Hex(cE1));
            await H.insMsg("s2", 9, "mE", "user", sha256Hex(cE2));
            // Parity literal with ABSENT_IDENTITY in src/storage/{schema,mysql}.ts.
            const GHOST_HASH = "0".repeat(64);
            await H.insMsg("s2", 13, "mX", "user", GHOST_HASH);

            await be.close();
            be = await openBackend("mysql", H.dsn);
            await be.init?.();
            assert.equal(await H.stamp(), "9", "re-run completed and stamped v9");
            const eRows = await H.q("SELECT seq, identity FROM messages WHERE session_id = 's2' ORDER BY seq");
            assert.deepEqual(eRows.map((r) => Number(r.seq)), [5, 13], "unbackfilled dup pair collapsed; the CAS-missing row survives (not a duplicate)");
            assert.notEqual(String(eRows[0].identity), "", "identity backfilled on the re-run");
            assert.equal(String(eRows[1].identity), "absent:", "CAS-missing row gets the printable absent marker, byte-exact");

            // Retired-row projection coverage (same pins as the sqlite lane).
            const sid = "sess-mysql-retired";
            await retireSecondMessage(be, sid);
            const retired = await H.q("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND retired_at IS NOT NULL", [sid]);
            assert.equal(Number(retired[0].n), 1, "rewind left the second message as a tombstone");
            const clean = await be.verifyProjections(sid);
            assert.ok(clean.ok, `intact projections verify with a retired row present (${clean.ok ? clean.checks : clean.error})`);
            await H.q("UPDATE messages SET role = 'system' WHERE session_id = ? AND retired_at IS NOT NULL", [sid]);
            const broken = await be.verifyProjections(sid);
            assert.equal(broken.ok, false, "retired-row drift must fail the check");
            assert.match(broken.ok ? "" : broken.error, /\.role/, "failure names the drifted field");
        } finally {
            await be?.close();
        }
    },
);

test("#4666 mysql: backfill streams across the 500-row page boundary",
    { skip: MYSQL_DSN.length === 0 ? "set BILI_MYSQL_TEST_DSN to run" : false },
    async (t) => {
        const H = await createMysqlHarness(t);
        let be: StorageBackend | undefined;
        try {
            be = await openBackend("mysql", H.dsn);
            await be.init?.();
            await H.rewindToV7();

            // 503 rows: the keeper sits on page 1, the second generation of
            // the SAME logical message past the 500-row seam — only an
            // ordered cursor scan pairs them (a single-snapshot scan that
            // loses cross-page context would leave the duplicate behind).
            const cP1 = JSON.stringify({ id: "mA", role: "user", contentType: "text", text: "paged", wireIndex: 1 });
            const cP2 = JSON.stringify({ id: "mA", role: "user", contentType: "text", text: "paged", wireIndex: 2 });
            const hP1 = await H.insContent(cP1, 1);
            const hP2 = await H.insContent(cP2, 1);
            await H.insMsg("s_page", 1, "mA", "user", hP1);
            for (let i = 2; i <= 502; i++) {
                const id = `mF${String(i).padStart(3, "0")}`;
                const body = JSON.stringify({ id, role: "user", contentType: "text", text: `filler ${i}` });
                await H.insMsg("s_page", i, id, "user", await H.insContent(body, 1));
            }
            await H.insMsg("s_page", 503, "mA", "user", hP2);

            await be.close();
            be = await openBackend("mysql", H.dsn);
            await be.init?.();
            const survivors = await H.q("SELECT seq, content_hash FROM messages WHERE session_id = 's_page' ORDER BY seq");
            assert.equal(survivors.length, 502, "the cross-page duplicate was paired and dropped");
            const seqs = survivors.map((r) => Number(r.seq));
            for (let i = 0; i < seqs.length; i++) assert.equal(seqs[i], i + 1, `no gap at the page seam (seq ${i + 1} missing)`);
            assert.equal(String(survivors[0].content_hash), hP1, "keeper is the page-1 arrival");
            assert.equal(await H.refcount(hP2), 0, "cross-page dup refunded");
            assert.equal(await H.refcount(hP1), 1, "keeper untouched");
        } finally {
            await be?.close();
        }
    },
);

test("#4666 mysql: concurrent boots serialize on the migration lock",
    { skip: MYSQL_DSN.length === 0 ? "set BILI_MYSQL_TEST_DSN to run" : false },
    async (t) => {
        const H = await createMysqlHarness(t);
        let be: StorageBackend | undefined;
        try {
            be = await openBackend("mysql", H.dsn);
            await be.init?.();
            await H.rewindToV7();
            await seedDirtyFixtureMysql(H, "s1");
            await be.close();

            // Hold the migration lock from a separate connection — the shape
            // of another bili process mid-upgrade against the same library.
            const locker = await H.connection();
            const held = await locker.query("SELECT GET_LOCK(CONCAT('bili_v8_upgrade_', DATABASE()), 5) AS ok");
            assert.equal(Number(held[0].ok), 1, "test holds the migration lock");

            be = await openBackend("mysql", H.dsn);
            const migrating = be.init?.();
            // While we hold the lock the migrator cannot touch data — whether
            // it is already parked at GET_LOCK or has not reached it yet. An
            // UNLOCKED migrator would have finished this tiny fixture long ago
            // and stamped v8, so these two asserts are the discriminator.
            await sleep(500);
            assert.equal(await H.stamp(), "7", "data step waits for the lock instead of racing");
            const rowCount = await H.q("SELECT COUNT(*) AS n FROM messages WHERE session_id = 's1'");
            assert.equal(Number(rowCount[0].n), 8, "a racing migrator would have deleted the duplicates by now");

            // Plant a marker pair WHILE holding the lock: a migrator that
            // enumerates its sessions before acquiring the lock never sees it.
            const cL1 = JSON.stringify({ id: "mL", role: "user", contentType: "text", text: "lock", wireIndex: 1 });
            const cL2 = JSON.stringify({ id: "mL", role: "user", contentType: "text", text: "lock", wireIndex: 2 });
            await H.insContent(cL1, 1);
            await H.insContent(cL2, 1);
            await H.insMsg("s_lock", 3, "mL", "user", sha256Hex(cL1));
            await H.insMsg("s_lock", 7, "mL", "user", sha256Hex(cL2));

            const released = await locker.query("SELECT RELEASE_LOCK(CONCAT('bili_v8_upgrade_', DATABASE())) AS ok");
            assert.equal(Number(released[0].ok), 1, "lock released exactly once");
            locker.release();
            await migrating;
            assert.equal(await H.stamp(), "9", "migration completed after the lock freed");
            const s1 = await H.q("SELECT seq FROM messages WHERE session_id = 's1' ORDER BY seq");
            assert.deepEqual(s1.map((r) => Number(r.seq)), [1, 2, 3, 5], "fixture collapsed exactly once — no double-delete");
            const sLock = await H.q("SELECT seq, identity FROM messages WHERE session_id = 's_lock' ORDER BY seq");
            assert.deepEqual(sLock.map((r) => Number(r.seq)), [3], "marker planted behind the lock was processed ⇒ enumeration happened after acquire");
            assert.notEqual(String(sLock[0].identity), "", "marker keeper backfilled");
        } finally {
            await be?.close();
        }
    },
);
