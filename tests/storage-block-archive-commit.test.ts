import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CompressionBlock } from "acp-kernel";
import { executeAcpRewrite } from "../src/acp-block-ops.ts";
import { createSession } from "../src/session.ts";
import { openSqliteDatabase, type SqliteDatabase } from "../src/storage/driver.ts";
import { planIngest, toLegacyLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

process.env.BILI_STORAGE_UNIFIED = "full";

function block(blockId: string, summary: string): CompressionBlock {
    return {
        blockId, runId: "r1", tier: 1, summary, active: true, createdAt: 1_000,
        directMessageIds: ["foreign-message"], effectiveMessageIds: ["foreign-message"],
        directBlockIds: [], compressedTokens: 1_000, survivedCount: 0, generation: "young",
    };
}

function fixture() {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-block-archive-commit-"));
    const dbPath = path.join(dir, "index.db");
    const archiveDir = path.join(dir, "archive");
    const file = path.join(archiveDir, UnifiedStore.BLOCK_ARCHIVE_LOG_NAME);
    const store = UnifiedStore.open(dbPath);
    const db = (store as unknown as { db: SqliteDatabase }).db;
    db.exec("PRAGMA busy_timeout = 1");
    const session = createSession("block-archive-session");
    session.lastMessages = [{ id: "native", role: "user", contentType: "text", text: "Current session history." }];
    session.state.blocks = [block("b1", "Original retained summary."), block("b2", "Unrelated block.")];
    session.state.nextBlockId = 3;
    store.ingestSession(planIngest(toLegacyLike(session)));
    return {
        dir, dbPath, archiveDir, file, store, db, session,
        close() {
            store.close();
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        },
    };
}

function lines(file: string): string[] {
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line.trim()) : [];
}

test("block archive leaves no export behind when another SQLite writer holds the lock", () => {
    const h = fixture();
    try {
        assert.ok(h.store.archiveBlock(h.session.id, "b2", h).ok);
        const other = lines(h.file);
        const before = h.store.getBlocks(h.session.id);
        const second = openSqliteDatabase(h.dbPath).db;
        second.exec("BEGIN IMMEDIATE");
        try {
            for (let attempt = 0; attempt < 3; attempt++) {
                assert.throws(() => h.store.archiveBlock(h.session.id, "b1", h), /database is locked|SQLITE_BUSY/);
            }
        } finally {
            second.exec("ROLLBACK");
            second.close();
        }
        assert.deepEqual(h.store.getBlocks(h.session.id), before);
        assert.deepEqual(lines(h.file), other, "failed attempts must not append stale copies beside unrelated archives");
        assert.ok(h.store.archiveBlock(h.session.id, "b1", h).ok);
        assert.equal(lines(h.file).length, 2);
        assert.deepEqual(h.store.restoreBlock(h.session.id, "b1", h), { ok: true });
        assert.deepEqual(h.store.getBlocks(h.session.id), before);
        assert.deepEqual(lines(h.file), other);
    } finally { h.close(); }
});

test("a failed content sweep rolls back the block and does not publish its export", () => {
    const h = fixture();
    try {
        const before = h.store.getBlocks(h.session.id);
        h.db.exec("CREATE TRIGGER reject_content_sweep BEFORE DELETE ON content BEGIN SELECT RAISE(ABORT, 'blocked content sweep'); END");
        assert.throws(() => h.store.archiveBlock(h.session.id, "b1", h), /blocked content sweep/);
        h.db.exec("DROP TRIGGER reject_content_sweep");
        assert.deepEqual(h.store.getBlocks(h.session.id), before);
        assert.deepEqual(lines(h.file), []);
    } finally { h.close(); }
});

test("an archive append failure keeps the live block and its original bytes", () => {
    const h = fixture();
    try {
        const before = h.store.getBlocks(h.session.id);
        mkdirSync(h.file, { recursive: true });
        assert.throws(() => h.store.archiveBlock(h.session.id, "b1", h), /EISDIR|EPERM|EACCES/);
        assert.deepEqual(h.store.getBlocks(h.session.id), before);
        rmSync(h.file, { recursive: true });
        assert.ok(h.store.archiveBlock(h.session.id, "b1", h).ok);
        assert.deepEqual(h.store.restoreBlock(h.session.id, "b1", h), { ok: true });
        assert.deepEqual(h.store.getBlocks(h.session.id), before);
    } finally { h.close(); }
});

test("a failed archive followed by acp_rewrite and a successful retry restores the later summary", () => {
    const h = fixture();
    try {
        const second = openSqliteDatabase(h.dbPath).db;
        second.exec("BEGIN IMMEDIATE");
        try {
            assert.throws(() => h.store.archiveBlock(h.session.id, "b1", h), /database is locked|SQLITE_BUSY/);
        } finally {
            second.exec("ROLLBACK");
            second.close();
        }
        executeAcpRewrite({ blockId: "b1", summary: "The accepted replacement after the failed maintenance attempt." }, h.session);
        assert.equal(h.session.state.blocks[0].summary, "The accepted replacement after the failed maintenance attempt.");
        h.store.ingestSession(planIngest(toLegacyLike(h.session)));
        const latest = h.store.getBlocks(h.session.id);
        assert.ok(h.store.archiveBlock(h.session.id, "b1", h).ok);
        assert.deepEqual(h.store.restoreBlock(h.session.id, "b1", h), { ok: true });
        assert.deepEqual(h.store.getBlocks(h.session.id), latest);
        assert.deepEqual(lines(h.file), []);
    } finally { h.close(); }
});

test("restore uses the newest archived block after a supported summary rewrite", () => {
    const h = fixture();
    try {
        assert.ok(h.store.archiveBlock(h.session.id, "b1", h).ok);
        const stale = lines(h.file)[0];
        assert.deepEqual(h.store.restoreBlock(h.session.id, "b1", h), { ok: true });
        executeAcpRewrite({ blockId: "b1", summary: "Corrected summary with the later decision." }, h.session);
        assert.equal(h.session.state.blocks[0].summary, "Corrected summary with the later decision.");
        h.store.ingestSession(planIngest(toLegacyLike(h.session)));
        const latest = h.store.getBlocks(h.session.id).find((entry) => entry.blockId === "b1");
        assert.ok(latest);
        assert.ok(h.store.archiveBlock(h.session.id, "b2", h).ok);
        assert.ok(h.store.archiveBlock(h.session.id, "b1", h).ok);
        const [other, newest] = lines(h.file);
        writeFileSync(h.file, `${stale}\n${other}\n${newest}\n{\"sessionId\":`);
        assert.deepEqual(h.store.restoreBlock(h.session.id, "b1", h), { ok: true });
        assert.deepEqual(h.store.getBlocks(h.session.id), [latest], "the current payload and summary must both be restored");
        assert.deepEqual(lines(h.file), [other]);
        assert.deepEqual(h.store.restoreBlock(h.session.id, "b1", h), { ok: false, reason: "not-found" });
        assert.deepEqual(h.store.restoreBlock(h.session.id, "b2", h), { ok: true });
        assert.equal(h.store.getBlocks(h.session.id).length, 2);
    } finally { h.close(); }
});

test("a live block stays authoritative when stale archive entries also exist", () => {
    const h = fixture();
    try {
        assert.ok(h.store.archiveBlock(h.session.id, "b1", h).ok);
        const archived = lines(h.file)[0];
        executeAcpRewrite({ blockId: "b1", summary: "Authoritative live summary." }, h.session);
        h.store.ingestSession(planIngest(toLegacyLike(h.session)));
        const before = h.store.getBlocks(h.session.id);
        const refs = h.db.prepare("SELECT hash, refcount FROM content ORDER BY hash").all();
        writeFileSync(h.file, `${archived}\n${archived}\n`);
        assert.deepEqual(h.store.restoreBlock(h.session.id, "b1", h), { ok: true });
        assert.deepEqual(h.store.getBlocks(h.session.id), before);
        assert.deepEqual(h.db.prepare("SELECT hash, refcount FROM content ORDER BY hash").all(), refs);
        assert.deepEqual(lines(h.file), []);
    } finally { h.close(); }
});
