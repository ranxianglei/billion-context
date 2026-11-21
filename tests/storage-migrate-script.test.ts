import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPool, type Pool } from "mysql2/promise";
import { openBackend } from "../src/storage/backend.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { STORAGE_SCHEMA_VERSION } from "../src/storage/schema.ts";

/**
 * #4936: scripts/migrate-storage.ts (sqlite index.db -> MySQL) pinned at the
 * seams that a wrong guess would break silently in production:
 *   - the schema-version gate (refuses unknown-newer and pre-v7 sources
 *     BEFORE any mysql contact — asserted with an unreachable DSN),
 *   - end-to-end migration against a real MySQL when BILI_MYSQL_TEST_DSN is
 *     set (CI mysql-contract job): row parity, content byte parity,
 *     read-back view parity, and the v7 identity backfill on the target.
 * The DSN-gated cases skip locally; the gate cases always run.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-migrate-script-hermetic-")),
    "no-config.json",
);

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/migrate-storage.ts");
const MYSQL_DSN = process.env.BILI_MYSQL_TEST_DSN ?? "";

interface CoreMsg { id: string; role: string; contentType: string; text: string }
const mkMsg = (id: string, text: string): CoreMsg => ({ id, role: "user", contentType: "text", text });

const mkSession = (id: string, msgs: CoreMsg[]): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen: 2_000,
    meta: { protocol: "openai", label: `label-${id}` },
    stats: {},
    metadata: { },
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

/** A consistent one-session store through the app's own sqlite backend
 *  (full DDL + user_version stamp + stamped identities). */
async function makeFixture(dir: string, id: string): Promise<string> {
    const file = path.join(dir, "index.db");
    const be = await openBackend("sqlite", file);
    try {
        await be.ingestSession(planIngest(mkSession(id, [
            mkMsg("m1", "alpha " + "a".repeat(512)),
            mkMsg("m2", "beta " + "b".repeat(512)),
        ])));
    } finally {
        await be.close();
    }
    return file;
}

function stamp(file: string, version: number, blankIdentity: boolean): void {
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${version}`);
    if (blankIdentity) db.exec("UPDATE messages SET identity = ''");
    db.close();
}

interface RunResult { code: number; out: string; err: string }

function runScript(args: string[]): Promise<RunResult> {
    return new Promise((resolve) => {
        execFile("node", ["--import", "tsx", SCRIPT, ...args], { cwd: ROOT }, (error, stdout, stderr) => {
            const code = error && typeof (error as { code?: unknown }).code === "number"
                ? (error as { code: number }).code
                : 0;
            resolve({ code, out: String(stdout), err: String(stderr) });
        });
    });
}

/** Run fn against a freshly created target database, dropped afterwards so
 *  repeated CI runs never see each other's rows (the script's count-parity
 *  check would otherwise fail on leftovers). */
async function withFreshSchema(fn: (targetDsn: string) => Promise<void>): Promise<void> {
    const u = new URL(MYSQL_DSN);
    const admin = `mysql://${u.username}:${u.password}@${u.hostname}:${u.port}`;
    const name = `bili_mig_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const adminPool: Pool = await createPool({ uri: admin, waitForConnections: true, connectionLimit: 1 });
    try {
        await adminPool.query(`CREATE DATABASE ${name}`);
        try {
            await fn(`${admin}/${name}`);
        } finally {
            await adminPool.query(`DROP DATABASE IF EXISTS ${name}`);
        }
    } finally {
        await adminPool.end();
    }
}

test("migrate-storage: refuses sources newer than this build's schema before any mysql contact", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-migrate-script-"));
    try {
        const db = await makeFixture(dir, "gate-newer");
        stamp(db, STORAGE_SCHEMA_VERSION + 1, false);
        const r = await runScript(["--from", db, "--to", "mysql://u:p@127.0.0.1:1/x"]);
        assert.equal(r.code, 2, `stderr: ${r.err}`);
        assert.match(r.err, /schema version .* unsupported/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("migrate-storage: refuses sources missing backend tables before any mysql contact", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-migrate-script-"));
    try {
        const db = await makeFixture(dir, "gate-tables");
        const raw = new DatabaseSync(db);
        raw.exec("DROP TABLE message_media");
        raw.close();
        const r = await runScript(["--from", db, "--to", "mysql://u:p@127.0.0.1:1/x"]);
        assert.equal(r.code, 2, `stderr: ${r.err}`);
        assert.match(r.err, /missing tables message_media/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("migrate-storage: v8 source migrates end-to-end with row, byte and view parity", { skip: MYSQL_DSN ? false : "BILI_MYSQL_TEST_DSN not set" }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-migrate-script-"));
    try {
        const db = await makeFixture(dir, "mig-v8");
        await withFreshSchema(async (target) => {
            const r = await runScript(["--from", db, "--to", target]);
            assert.equal(r.code, 0, `stdout: ${r.out}\nstderr: ${r.err}`);
            assert.match(r.out, /content:\s+\d+ rows ok/);
            assert.match(r.out, /messages:\s+\d+ rows ok/);
            assert.match(r.out, /content bytes: \d+ ok/);
            assert.match(r.out, /read-back parity: 1 sessions identical/);
            assert.match(r.out, /\[migrate\] done/);
            const pool: Pool = await createPool({ uri: target, supportBigNumbers: true });
            try {
                const [msgs] = (await pool.query("SELECT COUNT(*) AS n, SUM(CASE WHEN identity = '' THEN 1 ELSE 0 END) AS n_empty FROM messages")) as unknown as [{ n: number | string; n_empty: number | string | null }[]];
                assert.equal(Number(msgs[0].n), 2, "both messages copied");
                assert.equal(Number(msgs[0].n_empty ?? 0), 0, "v8 source already carries stamped identities");
            } finally {
                await pool.end();
            }
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("migrate-storage: v7 source passes the gate and --dry-run stops after schema ensure", { skip: MYSQL_DSN ? false : "BILI_MYSQL_TEST_DSN not set" }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-migrate-script-"));
    try {
        const db = await makeFixture(dir, "mig-v7-dry");
        stamp(db, 7, true);
        await withFreshSchema(async (target) => {
            const r = await runScript(["--from", db, "--to", target, "--dry-run"]);
            assert.equal(r.code, 0, `stdout: ${r.out}\nstderr: ${r.err}`);
            assert.match(r.out, /--dry-run: schema ensured, no rows copied/);
            const pool: Pool = await createPool({ uri: target, supportBigNumbers: true });
            try {
                const [rows] = (await pool.query("SELECT COUNT(*) AS n FROM sessions")) as unknown as [{ n: number | string }[]];
                assert.equal(Number(rows[0].n), 0, "dry-run copied nothing");
            } finally {
                await pool.end();
            }
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("migrate-storage: v7 source gets message identities backfilled on the target", { skip: MYSQL_DSN ? false : "BILI_MYSQL_TEST_DSN not set" }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-migrate-script-"));
    try {
        const db = await makeFixture(dir, "mig-v7-backfill");
        stamp(db, 7, true);
        await withFreshSchema(async (target) => {
            const r = await runScript(["--from", db, "--to", target]);
            assert.equal(r.code, 0, `stdout: ${r.out}\nstderr: ${r.err}`);
            assert.match(r.out, /backfilled identity for 2 empty row\(s\)/);
            const pool: Pool = await createPool({ uri: target, supportBigNumbers: true });
            try {
                const [rows] = (await pool.query("SELECT identity FROM messages")) as unknown as [{ identity: string }[]];
                for (const row of rows) assert.match(row.identity, /^[0-9a-f]{64}$/, "identity recomputed from CAS bytes");
            } finally {
                await pool.end();
            }
            // Documented side effect: read-back parity opens the source
            // through the app backend, which auto-migrates the copy in place.
            const ver = (new DatabaseSync(db, { readOnly: true }).prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
            assert.equal(ver, STORAGE_SCHEMA_VERSION);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
