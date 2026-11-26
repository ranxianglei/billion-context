import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { identityOfStoredContent } from "../src/storage/identity.ts";
import { openBackend, type StorageBackend } from "../src/storage/backend.ts";

/**
 * #4665 — archive/restore must carry the v8 row state (#4390) across:
 *
 * The dump SELECT and restore INSERT predated the identity/retired_at
 * columns, so every restored row landed with identity='' (the full-ingest
 * JOIN key — which #4390 moved off content_hash — can never match again,
 * so the next full save re-mints every message at a fresh seq beside the
 * restored copy = duplicate messages until the sweep converges) and with
 * retired_at=NULL (a rolled-back row resurrects as a live message).
 *
 * Pinned here: the JSONL dump carries both fields verbatim; restore writes
 * them back; a re-ingest after restore is seq-stable (no re-mint); a
 * pre-fix dump lacking both fields falls back to recomputing identity from
 * the CAS body (the v8 migration backfill formula).
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue4665-")),
    "no-config.json",
);

interface CoreMsg { id: string; role: string; contentType: string; text: string }
const mkMsg = (id: string, text: string): CoreMsg => ({ id, role: "user", contentType: "text", text });

const mkSession = (id: string, msgs: CoreMsg[]): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen: 2_000,
    meta: { protocol: "openai" },
    stats: {},
    metadata: { label: `label-${id}` },
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

type Row = { seq: number; msg_id: string; identity: string; retired_at: number | null };

function rowsOf(store: UnifiedStore, sessionId: string): Row[] {
    const db = (store as unknown as { db: { prepare: (q: string) => { all: (...a: unknown[]) => unknown[] } } }).db;
    return db
        .prepare("SELECT seq, msg_id, identity, retired_at FROM messages WHERE session_id = ? ORDER BY seq")
        .all(sessionId) as Row[];
}

type DumpLine = {
    sessionId: string;
    content: Record<string, string>;
    messages: Record<string, unknown>[];
};

function readDumpLine(exportPath: string, sessionId: string): DumpLine {
    const lines = fs.readFileSync(exportPath, "utf8").split("\n").filter((l) => l.trim());
    for (const l of lines) {
        const parsed = JSON.parse(l) as DumpLine & { sessionId?: string };
        if (parsed.sessionId === sessionId) return parsed;
    }
    throw new Error(`no dump line for ${sessionId}`);
}

test("#4665: dump carries identity + retired_at; restore round-trips both; re-ingest stays seq-stable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue4665-rt-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const sid = "s4665-rt";
        const a = mkMsg("m-a", "alpha ".repeat(30));
        const b = mkMsg("m-b", "bravo ".repeat(30));
        const c = mkMsg("m-c", "charlie ".repeat(30));
        store.ingestSession(planIngest(mkSession(sid, [a, b, c])), undefined, { completeLog: true });
        // Head truncation retires m-a (historian tombstone, #4390).
        store.ingestSession(planIngest(mkSession(sid, [b, c])), undefined, { completeLog: true });

        const before = rowsOf(store, sid);
        assert.equal(before.length, 3, "3 rows: 2 live + 1 retired");
        for (const r of before) assert.ok(r.identity.length > 0, `${r.msg_id} has a real identity pre-archive`);
        const retA = before.find((r) => r.msg_id === "m-a")!;
        assert.ok(retA.retired_at !== null, "m-a is retired pre-archive");
        assert.equal(before.find((r) => r.msg_id === "m-b")!.retired_at, null, "m-b live pre-archive");

        const archiveDir = path.join(dir, "archive");
        assert.ok(store.archiveSession(sid, { archiveDir }).ok);
        const line = readDumpLine(path.join(archiveDir, UnifiedStore.ARCHIVE_LOG_NAME), sid);
        assert.equal(line.messages.length, 3, "dump carries retired rows too (historian bytes stay)");
        for (const m of line.messages) {
            const src = before.find((r) => r.msg_id === m.msg_id)!;
            assert.equal(m.identity, src.identity, `${m.msg_id}: dump carries the stored identity`);
            assert.equal(m.retired_at ?? null, src.retired_at, `${m.msg_id}: dump carries the retire state`);
        }

        assert.ok(store.restoreArchived(sid, { archiveDir }).ok);
        const after = rowsOf(store, sid);
        assert.equal(after.length, 3, "restore brings exactly the archived rows back");
        for (const r of before) {
            const back = after.find((x) => x.msg_id === r.msg_id)!;
            assert.equal(back.seq, r.seq, `${r.msg_id}: original seq`);
            assert.equal(back.identity, r.identity, `${r.msg_id}: identity survives archive/restore`);
            assert.equal(back.retired_at, r.retired_at, `${r.msg_id}: retire state survives archive/restore`);
        }
        // The replay surface agrees: m-a stays out, no resurrection.
        assert.deepEqual(
            store.getMessages(sid).map((r) => r.msgId),
            ["m-b", "m-c"],
            "restored retired row does NOT resurrect into the live view",
        );

        // The actual bug: with restored identities intact the next full
        // ingest JOINs onto the same rows — no re-mint, no duplicate window.
        store.ingestSession(planIngest(mkSession(sid, [b, c])), undefined, { completeLog: true });
        const stable = rowsOf(store, sid);
        assert.equal(stable.length, 3, "re-ingest after restore mints nothing new");
        for (const r of before) {
            const now = stable.find((x) => x.msg_id === r.msg_id)!;
            assert.equal(now.seq, r.seq, `${r.msg_id}: seq unchanged across archive→restore→re-ingest`);
        }
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("#4665: pre-fix dump (no identity/retired_at fields) restores via recomputed identity", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue4665-legacy-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const sid = "s4665-legacy";
        const x = mkMsg("m-x", "x-ray ".repeat(30));
        const y = mkMsg("m-y", "yankee ".repeat(30));
        store.ingestSession(planIngest(mkSession(sid, [x, y])), undefined, { completeLog: true });

        const archiveDir = path.join(dir, "archive");
        assert.ok(store.archiveSession(sid, { archiveDir }).ok);
        const logPath = path.join(archiveDir, UnifiedStore.ARCHIVE_LOG_NAME);
        // Simulate an archive written before this fix: strip both fields.
        const stripped = fs
            .readFileSync(logPath, "utf8")
            .split("\n")
            .map((l) => {
                if (!l.trim()) return l;
                const parsed = JSON.parse(l) as DumpLine;
                if (parsed.sessionId !== sid) return l;
                for (const m of parsed.messages) { delete m.identity; delete m.retired_at; }
                return JSON.stringify(parsed);
            })
            .join("\n");
        fs.writeFileSync(logPath, stripped);
        // Capture BEFORE restore: the restore rewrite drops the restored
        // session's line from the log.
        const line = readDumpLine(logPath, sid);
        assert.ok(!("identity" in line.messages[0]), "fixture really lacks the fields");

        assert.ok(store.restoreArchived(sid, { archiveDir }).ok);
        const rows = rowsOf(store, sid);
        assert.equal(rows.length, 2);
        for (const r of rows) {
            const dumped = line.messages.find((m) => m.msg_id === r.msg_id)!;
            const expected = identityOfStoredContent(line.content[dumped.content_hash as string]);
            assert.equal(r.identity, expected, `${r.msg_id}: legacy dump falls back to the CAS-body identity`);
            assert.equal(r.retired_at, null, `${r.msg_id}: legacy dumps cannot recover retire state → live (documented boundary)`);
        }
        // The fallback re-connects the JOIN: a full re-ingest lands on the
        // same rows instead of minting duplicates.
        store.ingestSession(planIngest(mkSession(sid, [x, y])), undefined, { completeLog: true });
        const stable = rowsOf(store, sid);
        assert.equal(stable.length, 2, "legacy-restore re-ingest mints nothing new");
        assert.deepEqual(
            stable.map((r) => [r.msg_id, r.seq]),
            rows.map((r) => [r.msg_id, r.seq]),
            "seqs stable after the fallback restore",
        );
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

const MYSQL_DSN = process.env.BILI_MYSQL_TEST_DSN ?? "";

test("mysql lane: #4665 round-trip carries identity + retired_at", { skip: MYSQL_DSN.length === 0 ? "set BILI_MYSQL_TEST_DSN to run" : false }, async () => {
    // The interface hides includeRetired/retiredAt; the concrete backend
    // exposes them (same seam the contract suite asserts through).
    const { MysqlBackend } = await import("../src/storage/mysql.ts");
    const opened = await openBackend("mysql", MYSQL_DSN);
    assert.ok(opened instanceof MysqlBackend, "mysql lane opens the real backend");
    const backend = opened;
    await backend.init?.();
    try {
        const sid = `s4665-${Date.now()}`;
        const a = mkMsg("m-a", "alpha ".repeat(30));
        const b = mkMsg("m-b", "bravo ".repeat(30));
        const c = mkMsg("m-c", "charlie ".repeat(30));
        assert.ok(await backend.ingestSession(planIngest(mkSession(sid, [a, b, c])), undefined, { completeLog: true }));
        assert.ok(await backend.ingestSession(planIngest(mkSession(sid, [b, c])), undefined, { completeLog: true }));

        const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue4665-mysql-"));
        try {
            const archived = await backend.archiveSession(sid, { archiveDir });
            assert.ok(archived.ok && archived.exportPath, `archive ok (${archived.reason ?? ""})`);
            const line = readDumpLine(archived.exportPath!, sid);
            assert.equal(line.messages.length, 3, "mysql dump carries retired rows too");
            for (const m of line.messages) {
                assert.equal(typeof m.identity, "string", `${m.msg_id}: mysql dump carries identity`);
                assert.ok((m.identity as string).length > 0, `${m.msg_id}: non-empty identity`);
                assert.ok("retired_at" in m, `${m.msg_id}: mysql dump carries retired_at`);
            }

            assert.ok(await backend.restoreArchived(sid, { archiveDir }), "restore ok");
            const all = await backend.getMessages(sid, { includeRetired: true });
            assert.equal(all.length, 3, "all rows back incl. the retired one");
            const retA = all.find((r) => r.msgId === "m-a")!;
            assert.ok(retA.retiredAt !== null, "retired state survives the mysql round-trip");
            assert.deepEqual(
                (await backend.getMessages(sid)).map((r) => r.msgId),
                ["m-b", "m-c"],
                "live view excludes the restored retired row",
            );
            // Re-ingest stability: the JOIN reconnects, nothing re-minted.
            assert.ok(await backend.ingestSession(planIngest(mkSession(sid, [b, c])), undefined, { completeLog: true }));
            const stable = await backend.getMessages(sid, { includeRetired: true });
            assert.equal(stable.length, 3, "mysql re-ingest after restore mints nothing new");
            assert.deepEqual(
                stable.map((r) => [r.seq, r.msgId]).sort(),
                all.map((r) => [r.seq, r.msgId]).sort(),
                "seqs unchanged across archive→restore→re-ingest",
            );
        } finally {
            fs.rmSync(archiveDir, { recursive: true, force: true });
        }
        await backend.deleteSession(sid);
    } finally {
        await backend.close();
    }
});
