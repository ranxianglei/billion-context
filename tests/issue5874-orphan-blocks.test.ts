/**
 * #6785 step 7 — the reaped-block journal leaves the sessions row.
 *
 * One row per reaped block in orphan_blocks (immutable content; refreshed
 * views UPDATE); the legacy sessions.orphans_json column migrates onto the
 * table on first ingest and then retires (NULL). #4242 merge semantics stay:
 * incoming entries win on key collision; entries the live session no longer
 * carries survive (table is INSERT/UPDATE, never DELETE within a session).
 * Every fallback is pinned in BOTH directions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, LegacyViewBuilder, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import type { CompressionBlock } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-orphan-blocks-")),
    "no-config.json",
);

type RawDb = ReturnType<typeof openSqliteDatabase>["db"];

interface Env {
    dir: string;
    store: UnifiedStore;
    raw: () => RawDb;
}

function env(): Env {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-orphan-test-"));
    const dbPath = path.join(dir, "index.db");
    const store = UnifiedStore.open(dbPath);
    return { dir, store, raw: () => openSqliteDatabase(dbPath).db };
}

const block = (i: number, summary: string): CompressionBlock => ({
    blockId: `b${i}`,
    runId: `r${i}`,
    tier: 1,
    summary,
    directMessageIds: [],
    effectiveMessageIds: [`m${i}`],
    directBlockIds: [],
    compressedTokens: 10,
    createdAt: 1_000 + i,
    survivedCount: 0,
    generation: "young",
    active: true,
});

/** A session whose blockContents carry an ORPHAN (b-gone) that state.blocks
 *  no longer lists — the #2695 reap shape. */
const mkSession = (id: string, orphan?: { one: unknown; full: unknown }): LegacySessionLike => {
    const blocks = [block(1, `${id} b1`)];
    const contents = new Map<string, { one: unknown; full: unknown }>([
        ["b1", { one: null, full: { text: `${id} b1 ORIGINAL TEXT`, count: 1 } }],
    ]);
    if (orphan) contents.set("b-gone", orphan);
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: {},
        metadata: {},
        state: { blocks, nextBlockId: 2, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
        blockContents: contents,
        lastMessages: undefined,
        lastMessagesFolded: undefined,
        pluginSnapshot: undefined,
        contentStore: undefined,
    } as unknown as LegacySessionLike;
};

const ingest = (store: UnifiedStore, legacy: LegacySessionLike) => {
    store.ingestSession(planIngest(legacy), undefined, { completeLog: true });
};

const loadView = (store: UnifiedStore, id: string) => {
    const rows = store.readSnapshot(() => {
        const session = store.getSessionRow(id);
        if (session === null) return null;
        return {
            session,
            messages: store.getMessages(id),
            blocks: store.getBlocks(id),
            refs: store.getRefs(id),
            deadRefs: store.getDeadRefs(id),
        };
    });
    if (rows === null) throw new Error(`no rows for ${id}`);
    const builder = new LegacyViewBuilder(rows.session, rows.refs, rows.deadRefs);
    builder.addBlocks(rows.blocks);
    builder.addMessages(rows.messages);
    builder.addCcrEntries(store.getCcrEntries(id));
    builder.addOrphanViews(store.getOrphanViews(id) ?? {});
    return builder.finish();
};

test("orphan_blocks T1: write shape — one row per reaped block, column retires", () => {
    const e = env();
    ingest(e.store, mkSession("sess-obs", { one: null, full: { text: "REAPED FULL TEXT", count: 9 } }));
    const db = e.raw();
    const rows = db.prepare("SELECT block_id, one_json, full_json FROM orphan_blocks WHERE session_id = ?").all("sess-obs") as { block_id: string; one_json: string | null; full_json: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].block_id, "b-gone");
    assert.equal(rows[0].one_json === null || rows[0].one_json === "null", true);
    assert.equal(JSON.parse(rows[0].full_json).text, "REAPED FULL TEXT");
    const col = db.prepare("SELECT orphans_json FROM sessions WHERE session_id = ?").get("sess-obs") as { orphans_json: string | null };
    assert.equal(col.orphans_json, null);
    const view = loadView(e.store, "sess-obs");
    assert.equal((view.blockContents.get("b-gone")?.full as { text: string }).text, "REAPED FULL TEXT");
    e.store.close();
});

test("orphan_blocks T2: steady-state re-ingest is a no-op; refresh updates in place", () => {
    const e = env();
    ingest(e.store, mkSession("sess-noop", { one: null, full: { text: "STABLE TEXT", count: 1 } }));
    const pick = () => JSON.stringify(e.raw().prepare("SELECT block_id, one_json, full_json FROM orphan_blocks WHERE session_id = ?").all("sess-noop"));
    const before = pick();
    ingest(e.store, mkSession("sess-noop", { one: null, full: { text: "STABLE TEXT", count: 1 } }));
    assert.equal(pick(), before);
    ingest(e.store, mkSession("sess-noop", { one: null, full: { text: "REFRESHED TEXT", count: 2 } }));
    const rows = e.raw().prepare("SELECT block_id, full_json FROM orphan_blocks WHERE session_id = ?").all("sess-noop") as { block_id: string; full_json: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].block_id, "b-gone");
    assert.equal(JSON.parse(rows[0].full_json).text, "REFRESHED TEXT");
    e.store.close();
});

test("orphan_blocks T3: legacy column migrates onto the table once, column retires", () => {
    const e = env();
    e.store.ingestSession(planIngest(mkSession("sess-mig")), undefined, { completeLog: true });
    const db = e.raw();
    db.prepare("UPDATE sessions SET orphans_json = ? WHERE session_id = ?").run(JSON.stringify({ "b-old": { one: null, full: { text: "LEGACY ORPHAN", count: 3 } } }), "sess-mig");
    db.prepare("DELETE FROM orphan_blocks WHERE session_id = ?").run("sess-mig");
    ingest(e.store, mkSession("sess-mig", { one: null, full: { text: "NEW ORPHAN", count: 4 } }));
    const rows = db.prepare("SELECT block_id, full_json FROM orphan_blocks WHERE session_id = ? ORDER BY block_id").all("sess-mig") as { block_id: string; full_json: string }[];
    assert.deepEqual(rows.map((r) => r.block_id), ["b-gone", "b-old"]);
    assert.equal(JSON.parse(rows[0].full_json).text, "NEW ORPHAN");
    assert.equal(JSON.parse(rows[1].full_json).text, "LEGACY ORPHAN");
    const col = db.prepare("SELECT orphans_json FROM sessions WHERE session_id = ?").get("sess-mig") as { orphans_json: string | null };
    assert.equal(col.orphans_json, null);
    const merged = e.store.getOrphanViews("sess-mig");
    assert.ok(merged !== null && Object.keys(merged).length === 2);
    assert.equal(JSON.parse(JSON.stringify(merged!["b-old"].full)).text, "LEGACY ORPHAN");
    e.store.close();
});

test("orphan_blocks T4: read union — table and legacy column give the same view; corrupt column keeps table rows", () => {
    const e = env();
    ingest(e.store, mkSession("sess-union", { one: null, full: { text: "UNION TEXT", count: 5 } }));
    const viewA = loadView(e.store, "sess-union");
    const a = JSON.stringify([...viewA.blockContents.entries()].map(([k, v]) => [k, JSON.stringify(v)]).sort());
    // Legacy column only (table emptied to simulate a pre-upgrade read).
    e.raw().prepare("UPDATE sessions SET orphans_json = ? WHERE session_id = ?").run(JSON.stringify({ "b-gone": { one: null, full: { text: "UNION TEXT", count: 5 } } }), "sess-union");
    e.raw().prepare("DELETE FROM orphan_blocks WHERE session_id = ?").run("sess-union");
    const viewB = loadView(e.store, "sess-union");
    const b = JSON.stringify([...viewB.blockContents.entries()].map(([k, v]) => [k, JSON.stringify(v)]).sort());
    assert.equal(b, a);
    assert.ok(a.includes("UNION TEXT"), "the orphan text must ride the view");
    // Corrupt column with NO table rows: nothing serves (never a fake store).
    e.raw().prepare("UPDATE sessions SET orphans_json = 'not json' WHERE session_id = ?").run("sess-union");
    assert.equal(e.store.getOrphanViews("sess-union"), null);
    // Corrupt column WITH table rows: the table stays authoritative.
    ingest(e.store, mkSession("sess-union", { one: null, full: { text: "UNION TEXT", count: 5 } }));
    e.raw().prepare("UPDATE sessions SET orphans_json = 'not json' WHERE session_id = ?").run("sess-union");
    const merged = e.store.getOrphanViews("sess-union");
    assert.ok(merged !== null && merged["b-gone"] !== undefined, "corrupt column must not drop table rows");
    e.store.close();
});

test("orphan_blocks T5: cascade — deleteSession and archiveSession drop the rows", () => {
    const e = env();
    ingest(e.store, mkSession("sess-casc", { one: null, full: { text: "CASC", count: 1 } }));
    e.store.deleteSession("sess-casc");
    assert.equal((e.raw().prepare("SELECT COUNT(*) AS n FROM orphan_blocks WHERE session_id = ?").get("sess-casc") as unknown as { n: number }).n, 0);
    ingest(e.store, mkSession("sess-arch", { one: null, full: { text: "ARCH", count: 1 } }));
    e.store.archiveSession("sess-arch", { archiveDir: e.dir });
    assert.equal((e.raw().prepare("SELECT COUNT(*) AS n FROM orphan_blocks WHERE session_id = ?").get("sess-arch") as unknown as { n: number }).n, 0);
    e.store.close();
});

test("orphan_blocks T6: stats count the journal rows", () => {
    const e = env();
    ingest(e.store, mkSession("sess-stats", { one: null, full: { text: "STATS", count: 1 } }));
    assert.equal(e.store.sessionStorageStats("sess-stats").rows.orphanBlocks, 1);
    e.store.close();
});
