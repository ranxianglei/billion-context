import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { identityOfStoredContent } from "../src/storage/identity.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { rmrf } from "./tmp-rm.ts";

function sha256(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
}

test("non-object stored content preserves its raw-byte identity", () => {
    for (const raw of ["null", " null ", "true", "false", "42", '"text"', "[]", '[{"id":"inside-array"}]', "not JSON"]) {
        assert.equal(identityOfStoredContent(raw), sha256(raw), raw);
    }
});

test("message identities still exclude positional metadata and retain content", () => {
    const first = JSON.stringify({ id: "old", wireIndex: 0, ledgerSeq: 1, role: "user", content: "hello" });
    const second = JSON.stringify({ id: "new", wireIndex: 7, ledgerSeq: 8, role: "user", content: "hello" });
    assert.equal(identityOfStoredContent(first), identityOfStoredContent(second));
    assert.notEqual(identityOfStoredContent(first), identityOfStoredContent(second.replace("hello", "changed")));
});

test("v8 identity migration can finish with a JSON-null content row", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "bili-null-identity-"));
    const previousZstd = process.env.BILI_PERSIST_ZSTD;
    const previousConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_PERSIST_ZSTD = "0";
    process.env.BILI_CONFIG_FILE = path.join(dir, "no-config.json");
    let db: ReturnType<typeof openSqliteDatabase>["db"] | undefined;
    try {
        db = openSqliteDatabase(path.join(dir, "sessions.db")).db;
        migrateSchema(db);
        const raw = "null";
        const hash = sha256(raw);
        db.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, 1, 'sha256', ?)").run(hash, Buffer.byteLength(raw), Buffer.from(raw));
        db.prepare("INSERT INTO messages (session_id, seq, msg_id, role, kind, content_hash) VALUES (?, ?, ?, ?, 'message', ?)").run("null-session", 1, "null-message", "user", hash);
        db.exec("UPDATE messages SET identity = ''");
        db.exec("PRAGMA user_version = 7");

        const migrated = migrateSchema(db);
        assert.equal(migrated.from, 7);
        assert.equal(migrated.to, 11);
        const row = db.prepare("SELECT identity, content_hash FROM messages WHERE session_id = ?").get("null-session") as { identity: string; content_hash: string };
        assert.equal(row.identity, hash);
        assert.equal(row.content_hash, hash);
        const content = db.prepare("SELECT bytes, refcount FROM content WHERE hash = ?").get(hash) as { bytes: Uint8Array; refcount: number };
        assert.equal(Buffer.from(content.bytes).toString(), raw);
        assert.equal(content.refcount, 1);
        assert.equal(migrateSchema(db).from, 11);
    } finally {
        db?.close();
        if (previousZstd === undefined) delete process.env.BILI_PERSIST_ZSTD;
        else process.env.BILI_PERSIST_ZSTD = previousZstd;
        if (previousConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previousConfig;
        rmrf(dir);
    }
});
