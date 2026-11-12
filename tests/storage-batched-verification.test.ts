import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CompressionBlock, CoreMessage } from "acp-kernel";
import { SqliteBackend } from "../src/storage/backend.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { UnifiedStore } from "../src/storage/store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-batched-verify-"));
process.env.BILI_CONFIG_FILE = path.join(root, "no-config.json");
process.env.BILI_PERSIST_ZSTD = "0";
after(() => fs.rmSync(root, { recursive: true, force: true }));

function message(i: number): CoreMessage {
    return { id: `raw-${i}`, role: "user", contentType: "text", text: `message ${i}` };
}

function session(): LegacySessionLike {
    const blocks: CompressionBlock[] = Array.from({ length: 70 }, (_, i) => ({
        blockId: `b${i + 1}`, runId: `run-${i}`, tier: 1, summary: `summary ${i}`,
        directMessageIds: [], effectiveMessageIds: [], directBlockIds: [],
        compressedTokens: 10, createdAt: 1_700_000_000_000, survivedCount: 1,
        generation: "young", active: i % 3 !== 0,
    }));
    const messages = Array.from({ length: 80 }, (_, i) => message(i));
    messages[69] = {
        ...messages[69],
        rawOpenaiContent: { type: "image_url", image_url: { url: `data:image/png;base64,${"QUJD".repeat(700)}` } },
    } as CoreMessage;
    const blockContents: LegacySessionLike["blockContents"] = new Map(
        [...blocks].reverse().map((b) => [b.blockId, { one: null, full: { text: `original ${b.blockId}`, count: 2 } }]),
    );
    blockContents.set("b-orphan", { one: null, full: { text: "retained orphan", count: 1 } });
    return {
        id: "batched-session", createdAt: 1_700_000_000_000, lastSeen: 1_700_000_000_500,
        meta: { protocol: "responses" }, stats: { requests: 1 }, metadata: {},
        state: {
            blocks,
            messageRefs: { byRaw: { ghost: "m00001", protected: "BLOCKED" }, byRef: { m00001: "ghost" } },
            nextBlockId: 71, nextRunId: 71,
        },
        blockContents, lastMessages: messages, lastMessagesFolded: false,
        pluginSnapshot: [messages[75], messages[1], messages[75], messages[40]],
    };
}

function fixture(t: TestContext, asyncLane = false) {
    const dir = fs.mkdtempSync(path.join(root, "case-"));
    const dbPath = path.join(dir, "index.db");
    const store = UnifiedStore.open(dbPath);
    const load = (record: unknown) => record as LegacySessionLike;
    // Exercise the network facade's queue against the real SQLite contract adapter.
    const shadow = Reflect.construct(UnifiedShadow, ["shadow", asyncLane ? null : store, load, asyncLane ? new SqliteBackend(store) : undefined]) as UnifiedShadow;
    let closed = false;
    const close = async () => {
        if (!closed) {
            closed = true;
            await shadow.closeAsync();
        }
    };
    t.after(async () => {
        await close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { store, shadow, dbPath, close, view: session() };
}

function changeBeforeRead(t: TestContext, store: UnifiedStore, dbPath: string, mutate: (db: ReturnType<typeof openSqliteDatabase>["db"]) => void): void {
    const getSessionRow = store.getSessionRow.bind(store);
    let changed = false;
    t.mock.method(store, "getSessionRow", (id: string) => {
        if (!changed) {
            changed = true;
            const { db } = openSqliteDatabase(dbPath);
            try { mutate(db); } finally { db.close(); }
        }
        return getSessionRow(id);
    });
}

for (const asyncLane of [false, true]) {
    test(`sampled verification bounds reads and preserves live contents (${asyncLane ? "async" : "sync"})`, async (t) => {
        const { store, shadow, view, close } = fixture(t, asyncLane);
        store.ingestSession(planIngest({ ...view, pluginSnapshot: undefined, lastMessages: Array.from({ length: 200 }, (_, i) => message(i + 1000)) }));
        const originalContents = structuredClone(view.blockContents);
        const messageReads: { requested: number[] | undefined; returned: number }[] = [];
        const blockReads: { limit: number | undefined; returned: number }[] = [];
        const getMessages = store.getMessages.bind(store);
        const getBlocks = store.getBlocks.bind(store);
        t.mock.method(store, "getMessages", (id: string, opts?: Parameters<UnifiedStore["getMessages"]>[1]) => {
            const rows = getMessages(id, opts);
            messageReads.push({ requested: opts?.seqs ? [...opts.seqs] : undefined, returned: rows.length });
            return rows;
        });
        t.mock.method(store, "getBlocks", (id: string, opts?: Parameters<UnifiedStore["getBlocks"]>[1]) => {
            const rows = getBlocks(id, opts);
            blockReads.push({ limit: opts?.limit, returned: rows.length });
            return rows;
        });
        shadow.record(view);
        if (asyncLane) await close();
        assert.equal(shadow.stats.verifyOk, 1, shadow.stats.lastError ?? "sample must pass");
        assert.equal(shadow.stats.verifyDrift, 0);
        assert.deepEqual(view.blockContents, originalContents);
        assert.ok(messageReads.length >= 3 && blockReads.length >= 3);
        assert.ok(messageReads.every((r) => r.requested && r.requested.length <= 32 && r.returned <= 32));
        assert.equal(messageReads.reduce((n, r) => n + r.returned, 0), 80, "only referenced messages are hydrated");
        assert.ok(blockReads.every((r) => r.limit === 32 && r.returned <= 32));
    });
}

test("a changed message beyond the first batch trips drift and clears the watermark", (t) => {
    const { store, shadow, dbPath, view } = fixture(t);
    changeBeforeRead(t, store, dbPath, (db) => {
        const row = db.prepare("SELECT content_hash FROM messages WHERE session_id = ? AND msg_id = ?").get(view.id, "raw-70") as { content_hash: string };
        db.prepare("UPDATE content SET bytes = ? WHERE hash = ?").run(Buffer.from(JSON.stringify({ ...message(70), text: "changed" })), row.content_hash);
    });
    shadow.record(view);
    assert.equal(shadow.stats.verifyDrift, 1, shadow.stats.lastError ?? "changed content must drift");
    assert.equal(store.ingestWatermark(view.id), null);
    assert.ok(shadow.driftedSessions.has(view.id));
});

test("later block batches detect changed, missing and extra block contents", (t) => {
    for (const kind of ["changed", "missing", "extra"] as const) {
        const { store, shadow, dbPath, view } = fixture(t);
        changeBeforeRead(t, store, dbPath, (db) => {
            if (kind === "changed") {
                const row = db.prepare("SELECT summary_hash FROM blocks WHERE session_id = ? AND block_id = ?").get(view.id, "b69") as { summary_hash: string };
                db.prepare("UPDATE content SET bytes = ? WHERE hash = ?").run(Buffer.from(JSON.stringify({ text: "changed original", count: 2 })), row.summary_hash);
            } else if (kind === "missing") {
                db.prepare("DELETE FROM blocks WHERE session_id = ? AND block_id = ?").run(view.id, "b69");
            } else {
                const orphans = { "b-orphan": view.blockContents.get("b-orphan"), unexpected: { one: null, full: { text: "extra original", count: 1 } } };
                db.prepare("UPDATE sessions SET orphans_json = ? WHERE session_id = ?").run(JSON.stringify(orphans), view.id);
            }
        });
        shadow.record(view);
        assert.equal(shadow.stats.verifyDrift, 1, `${kind}: ${shadow.stats.lastError}`);
        assert.equal(store.ingestWatermark(view.id), null, kind);
    }
});

test("missing and retired tail rows remain visible as drift", (t) => {
    for (const retired of [false, true]) {
        const { store, shadow, dbPath, view } = fixture(t);
        changeBeforeRead(t, store, dbPath, (db) => {
            const sql = retired
                ? "UPDATE messages SET retired_at = 1700000000000 WHERE session_id = ? AND msg_id = ?"
                : "DELETE FROM messages WHERE session_id = ? AND msg_id = ?";
            db.prepare(sql).run(view.id, "raw-70");
        });
        shadow.record(view);
        assert.equal(shadow.stats.verifyDrift, 1, shadow.stats.lastError ?? "missing referenced message must drift");
        assert.equal(store.ingestWatermark(view.id), null);
    }
});
