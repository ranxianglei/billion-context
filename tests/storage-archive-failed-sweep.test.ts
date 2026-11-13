import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { MysqlBackend, type Mysql2Module } from "../src/storage/mysql.ts";

/**
 * archiveSession used to append the session's export line to archive.jsonl
 * BEFORE the sweep transaction ran. A sweep that then failed (write lock held
 * by another process, constraint error) left the line behind while the
 * session stayed active and kept growing. The next successful archive
 * appended a second line; restoreArchived took the FIRST matching line (the
 * stale one), then dropped every line of that session — the newer export,
 * with everything said since the failed attempt, was gone.
 *
 * Pinned here, for both backends:
 *  - a failed sweep leaves no line in the archive log;
 *  - when the log does hold several lines for one session (logs written by
 *    earlier versions), restore takes the newest.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-archive-failed-sweep-")),
    "no-config.json",
);

interface CoreMsg { id: string; role: string; contentType: string; text: string }
const mkMsg = (id: string, text: string): CoreMsg => ({ id, role: "user", contentType: "text", text });

const mkSession = (id: string, msgs: CoreMsg[], lastSeen = 2_000): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen,
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

const two = [mkMsg("m1", "one"), mkMsg("m2", "two")];
const five = [...two, mkMsg("m3", "three"), mkMsg("m4", "four"), mkMsg("m5", "five")];

const logLines = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "") : []);
const linesOf = (file: string, sessionId: string): number => logLines(file).filter((l) => (JSON.parse(l) as { sessionId?: string }).sessionId === sessionId).length;

test("sqlite: a failed sweep leaves no archive line; the later archive restores in full", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-failed-sweep-"));
    const dbPath = path.join(dir, "index.db");
    const archiveDir = path.join(dir, "archive");
    const file = path.join(archiveDir, UnifiedStore.ARCHIVE_LOG_NAME);
    const store = UnifiedStore.open(dbPath);
    try {
        store.ingestSession(planIngest(mkSession("sess-A", two)));
        store.ingestSession(planIngest(mkSession("sess-B", [mkMsg("b1", "other session")])));
        assert.ok(store.archiveSession("sess-B", { archiveDir }).ok);
        const otherLine = logLines(file)[0];

        // Make the sweep fail at its last statement, after the row deletes.
        const side = openSqliteDatabase(dbPath).db;
        side.exec("CREATE TRIGGER fail_archive BEFORE UPDATE OF status ON sessions WHEN NEW.status = 'archived' BEGIN SELECT RAISE(ABORT, 'injected sweep failure'); END");
        assert.throws(() => store.archiveSession("sess-A", { archiveDir }), /injected sweep failure/);
        side.exec("DROP TRIGGER fail_archive");
        side.close();

        assert.equal((store.getSessionRow("sess-A") as unknown as { status?: string }).status, "active", "the session is still active");
        assert.equal(store.getMessages("sess-A").length, 2, "the sweep rolled back");
        assert.equal(linesOf(file, "sess-A"), 0, "a failed sweep leaves no line behind");
        assert.deepEqual(logLines(file), [otherLine], "the other session's line is untouched");

        // The session lives on, then archives for real.
        store.ingestSession(planIngest(mkSession("sess-A", five, 3_000)));
        assert.equal(store.getMessages("sess-A").length, 5);
        assert.ok(store.archiveSession("sess-A", { archiveDir }).ok);
        assert.equal(linesOf(file, "sess-A"), 1, "exactly one line for the one committed archive");
        assert.equal(store.getMessages("sess-A").length, 0);

        assert.deepEqual(store.restoreArchived("sess-A", { archiveDir }), { ok: true });
        assert.deepEqual(store.getMessages("sess-A").map((m) => m.msgId), ["m1", "m2", "m3", "m4", "m5"], "the messages added after the failed attempt are restored");
        assert.deepEqual(logLines(file), [otherLine], "only the restored session's line is removed");
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("sqlite: with several lines for one session in the log, restore takes the newest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-newest-line-"));
    const archiveDir = path.join(dir, "archive");
    const file = path.join(archiveDir, UnifiedStore.ARCHIVE_LOG_NAME);
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    try {
        // A log as earlier versions could leave it: the stale line of an
        // archive whose sweep never committed, then the real one.
        store.ingestSession(planIngest(mkSession("sess-A", two)));
        assert.ok(store.archiveSession("sess-A", { archiveDir }).ok);
        const staleLine = logLines(file)[0];
        assert.deepEqual(store.restoreArchived("sess-A", { archiveDir }), { ok: true });
        store.ingestSession(planIngest(mkSession("sess-A", five, 3_000)));
        store.ingestSession(planIngest(mkSession("sess-B", [mkMsg("b1", "other session")])));
        assert.ok(store.archiveSession("sess-B", { archiveDir }).ok);
        assert.ok(store.archiveSession("sess-A", { archiveDir }).ok);
        const [otherLine, newestLine] = logLines(file);
        fs.writeFileSync(file, [staleLine, otherLine, newestLine].join("\n") + "\n");

        assert.deepEqual(store.restoreArchived("sess-A", { archiveDir }), { ok: true });
        assert.deepEqual(store.getMessages("sess-A").map((m) => m.msgId), ["m1", "m2", "m3", "m4", "m5"], "restored from the newest line, not the first");
        assert.deepEqual(logLines(file), [otherLine], "every line of the restored session is removed, nothing else");
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** A mysql2 stand-in: the pool answers the archive reads from fixed rows,
 *  the transaction connection records what it is asked and can be told to
 *  fail one statement. */
function fakeMysql(opts: { messages: Record<string, unknown>[]; failOn?: () => RegExp | null }) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const sessionRow = {
        session_id: "sess-A", status: "active", namespace: "proxy", created_at: 1_000, updated_at: 2_000, next_block_id: 1, next_run_id: 1,
        meta_json: "{}", stats_json: "{}", metadata_json: "{}", kstate_json: "{}", tail_json: "{}",
    };
    const pool = {
        async query(sql: string, params: unknown[] = []) {
            if (/FROM sessions WHERE session_id = \?/.test(sql)) return [[sessionRow]];
            if (/FROM messages WHERE session_id = \?/.test(sql)) return [opts.messages];
            if (/SELECT bytes FROM content WHERE hash = \?/.test(sql)) return [[{ bytes: `body of ${String(params[0])}` }]];
            return [[]];
        },
        async getConnection() {
            return {
                async beginTransaction() { calls.push({ sql: "begin", params: [] }); },
                async commit() { calls.push({ sql: "commit", params: [] }); },
                async rollback() { calls.push({ sql: "rollback", params: [] }); },
                release() { /* nothing to free */ },
                async query(sql: string, params: unknown[] = []) {
                    calls.push({ sql, params });
                    const fail = opts.failOn?.() ?? null;
                    if (fail !== null && fail.test(sql)) throw new Error("injected sweep failure");
                    return [{ affectedRows: 1 }];
                },
            };
        },
    };
    const driver = { createPool: () => pool } as unknown as Mysql2Module;
    return { backend: new MysqlBackend("unused", driver), calls };
}

test("mysql: a failed sweep leaves no archive line; a committed one writes it before COMMIT", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-failed-sweep-mysql-"));
    const archiveDir = path.join(dir, "archive");
    const file = path.join(archiveDir, MysqlBackend.ARCHIVE_LOG_NAME);
    try {
        let fail: RegExp | null = /^UPDATE sessions SET status = 'archived'/;
        const { backend, calls } = fakeMysql({
            messages: [{ seq: 1, msg_id: "m1", ref: null, ref_num: null, role: "user", kind: "message", content_hash: "h1", identity: "i1", retired_at: null, ts: null }],
            failOn: () => fail,
        });
        await assert.rejects(backend.archiveSession("sess-A", { archiveDir }), /injected sweep failure/);
        assert.equal(calls[calls.length - 1].sql, "rollback");
        assert.equal(linesOf(file, "sess-A"), 0, "a failed sweep leaves no line behind");

        fail = null;
        calls.length = 0;
        let linesAtCommit = -1;
        const realPush = calls.push.bind(calls);
        calls.push = (...items) => {
            for (const it of items) if (it.sql === "commit") linesAtCommit = linesOf(file, "sess-A");
            return realPush(...items);
        };
        assert.equal((await backend.archiveSession("sess-A", { archiveDir })).ok, true);
        assert.equal(linesAtCommit, 1, "the export line is on disk before the sweep commits");
        assert.equal(linesOf(file, "sess-A"), 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("mysql: with several lines for one session in the log, restore takes the newest", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-newest-line-mysql-"));
    const archiveDir = path.join(dir, "archive");
    const file = path.join(archiveDir, MysqlBackend.ARCHIVE_LOG_NAME);
    const source = UnifiedStore.open(path.join(dir, "source.db"));
    try {
        // Build the two exports with the sqlite twin (same line format).
        source.ingestSession(planIngest(mkSession("sess-A", two)));
        assert.ok(source.archiveSession("sess-A", { archiveDir }).ok);
        const staleLine = logLines(file)[0];
        assert.deepEqual(source.restoreArchived("sess-A", { archiveDir }), { ok: true });
        source.ingestSession(planIngest(mkSession("sess-A", five, 3_000)));
        assert.ok(source.archiveSession("sess-A", { archiveDir }).ok);
        const newestLine = logLines(file)[0];
        fs.writeFileSync(file, [staleLine, newestLine].join("\n") + "\n");

        const { backend, calls } = fakeMysql({ messages: [] });
        assert.deepEqual(await backend.restoreArchived("sess-A", { archiveDir }), { ok: true });
        const restored = calls.filter((c) => c.sql.startsWith("INSERT INTO messages")).map((c) => c.params[2]);
        assert.deepEqual(restored, ["m1", "m2", "m3", "m4", "m5"], "restored from the newest line, not the first");
        assert.deepEqual(logLines(file), [], "every line of the restored session is removed");
    } finally {
        source.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
