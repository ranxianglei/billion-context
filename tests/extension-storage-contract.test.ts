import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UnifiedStore } from "../src/storage/store.ts";
import { MysqlBackend, type Mysql2Module } from "../src/storage/mysql.ts";

const LIMIT = 4 * 1024 * 1024;

/** Read the raw kv row's value_json straight from the db (bypasses the CAS
 *  resolution) so the test can tell inline storage from a CAS ref. */
function rawKvValueJson(dbPath: string, namespace: string, key: string): string {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const row = db.prepare("SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?").get(namespace, key) as
            | { value_json: string }
            | undefined;
        return row?.value_json ?? "";
    } finally {
        db.close();
    }
}

test("SQLite extension values over the 4 MiB inline cap route to the content CAS", () => {
    const dir = mkdtempSync(join(tmpdir(), "extension-bytes-"));
    const dbPath = join(dir, "index.db");
    const store = UnifiedStore.open(dbPath);
    try {
        // Under the cap: stored inline (the kv row holds the full payload).
        store.setKv("test", "boundary", "a".repeat(LIMIT - 2));
        assert.equal((store.getKv("test", "boundary") as string).length, LIMIT - 2);
        assert.ok(Buffer.byteLength(rawKvValueJson(dbPath, "test", "boundary"), "utf8") > LIMIT - 4, "under-cap value is inline");

        // #7378: over the cap (measured in UTF-8 bytes) no longer throws — it
        // routes to the content CAS. "界" is 3 bytes, so 1398102 of them is
        // 4194306 bytes > LIMIT even though the JS length is under LIMIT.
        const over = "界".repeat(Math.floor(LIMIT / 3) + 1);
        store.setKv("test", "over", over); // no throw (the regression)
        const refJson = rawKvValueJson(dbPath, "test", "over");
        assert.ok(Buffer.byteLength(refJson, "utf8") < 256, "over-cap kv row is a small CAS ref");
        assert.ok((JSON.parse(refJson) as Record<string, unknown>)["$biliCas"], "kv row carries the $biliCas ref");
        assert.equal(store.getKv("test", "over"), over, "over-cap value round-trips byte-exact");
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

function mysqlFixture() {
    const queries: unknown[][] = [];
    const backend = new MysqlBackend({}, {
        createPool: () => ({ async query(sql: string, args: unknown[]) {
            queries.push([sql, ...args]);
            return [sql.startsWith("SELECT") ? [] : { affectedRows: 1 }];
        } }),
    } as unknown as Mysql2Module);
    return { backend, queries };
}

for (const invalid of ["", "x".repeat(257), "bad\u0000key", "bad\u007fkey"]) {
    test(`MySQL extension operations reject invalid keys before SQL (${JSON.stringify(invalid.slice(0, 20))})`, async () => {
        const { backend: b, queries } = mysqlFixture();
        for (const run of [
            () => b.setKv(invalid, "key", 1), () => b.setKv("ns", invalid, 1),
            () => b.getKv(invalid, "key"), () => b.getKv("ns", invalid),
            () => b.deleteKv(invalid), () => b.deleteKv("ns", invalid),
            () => b.listKv(invalid),
            () => b.setSessionExt(invalid, "key", 1), () => b.setSessionExt("session", invalid, 1),
            () => b.getSessionExt(invalid, "key"), () => b.getSessionExt("session", invalid),
            () => b.listSessionExt(invalid), () => b.deleteSessionExt(invalid),
            () => b.deleteSessionExt("session", invalid),
        ]) await assert.rejects(run, /extension/);
        if (invalid !== "") await assert.rejects(() => b.listKv("ns", invalid), /extension/);
        assert.equal(queries.length, 0);
    });
}

test("MySQL extension writes reject non-serializable values; setKv routes over-budget to the CAS", async () => {
    const { backend, queries } = mysqlFixture();
    // Non-serializable values are rejected by BOTH setKv and setSessionExt,
    // before any SQL is issued.
    for (const value of [undefined, () => 1]) {
        await assert.rejects(() => backend.setKv("ns", "key", value), /JSON-serializable/);
        await assert.rejects(() => backend.setSessionExt("session", "key", value), /JSON-serializable/);
    }
    assert.equal(queries.length, 0, "no SQL issued for rejected values");

    // #7378: an over-budget value is routed to the content CAS by setKv (no
    // throw — it issues the CAS + kv SQL), while setSessionExt still rejects it
    // (session_ext values stay inline by design).
    const over = "界".repeat(Math.ceil(LIMIT / 3));
    await backend.setKv("ns", "key", over); // resolves (routes to the CAS)
    assert.ok(queries.length > 0, "setKv issued SQL for the over-budget value (CAS routing)");
    const casQueries = queries.length;
    await assert.rejects(() => backend.setSessionExt("session", "key", over), /exceeds.*bytes/);
    assert.equal(queries.length, casQueries, "setSessionExt rejected before any SQL");

    // A small value is stored inline (the kv row holds the full payload).
    // setKv now issues a SELECT (read the old row's CAS ref) before the INSERT,
    // so the value_json lands on the second query.
    queries.length = 0;
    await backend.setKv("ns", "key", { valid: "界" });
    await backend.setSessionExt("session", "key", null);
    assert.equal(queries[1][3], '{"valid":"界"}');
    assert.equal(queries[2][3], "null");
    await backend.listKv("ns", "");
    await backend.deleteKv("ns");
    await backend.deleteSessionExt("session");
});
