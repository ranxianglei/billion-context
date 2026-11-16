import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { MysqlBackend, type Mysql2Module } from "../src/storage/mysql.ts";

const LIMIT = 4 * 1024 * 1024;

test("SQLite extension limits measure UTF-8 bytes before changing the existing value", () => {
    const dir = mkdtempSync(join(tmpdir(), "extension-bytes-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    try {
        store.setKv("test", "value", "keep");
        const multibyte = "界".repeat(Math.ceil(LIMIT / 3));
        assert.throws(() => store.setKv("test", "value", multibyte), /exceeds.*bytes/);
        assert.equal(store.getKv("test", "value"), "keep");
        store.setKv("test", "boundary", "a".repeat(LIMIT - 2));
        assert.equal((store.getKv("test", "boundary") as string).length, LIMIT - 2);
        assert.throws(() => store.setKv("test", "boundary", "a".repeat(LIMIT - 1)), /exceeds.*bytes/);
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

test("MySQL extension writes reject undefined and over-budget values consistently", async () => {
    const { backend, queries } = mysqlFixture();
    for (const value of [undefined, () => 1, "界".repeat(Math.ceil(LIMIT / 3))]) {
        await assert.rejects(() => backend.setKv("ns", "key", value), /JSON-serializable|exceeds.*bytes/);
        await assert.rejects(() => backend.setSessionExt("session", "key", value), /JSON-serializable|exceeds.*bytes/);
    }
    assert.equal(queries.length, 0);
    await backend.setKv("ns", "key", { valid: "界" });
    await backend.setSessionExt("session", "key", null);
    assert.equal(queries[0][3], '{"valid":"界"}');
    assert.equal(queries[1][3], "null");
    await backend.listKv("ns", "");
    await backend.deleteKv("ns");
    await backend.deleteSessionExt("session");
});
