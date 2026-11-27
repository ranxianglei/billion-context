/**
 * #5597 (facet C, owner ruling B): the #6785 table-backed orphan journal keeps
 * MERGE/survive semantics for ordinary saves, but an AUTHORITATIVE clear (a
 * native-compaction rebase, resetSessionCompression) must drop the session's
 * journal rows — otherwise a ghost journal survives the clear, the verifier's
 * orphan-vs-live comparison fails on every sampled verify, and the drift
 * latches forever (#5589 field evidence).
 *
 * The clear is signalled by a generation counter: resetSessionCompression
 * bumps metadata.orphanJournalGeneration, the plan carries it, and a store
 * that sees a value ABOVE the persisted row's generation deletes that
 * session's orphan_blocks rows before merging. A plain empty plan (no bump)
 * still merges — this is the distinction the #6785 merge semantics lost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { MysqlBackend } from "../src/storage/mysql.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";

const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5597-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const T_CREATED = 1_700_000_000_000;
const T_SEEN = 1_700_000_000_500;

type OrphanMap = Map<string, { one: null; full: { text: string; count: number } }>;

function msg(i: number): CoreMessage {
    return { id: `h_msg${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `hello ${i}` } as CoreMessage;
}

function mkLegacy(id: string, blockContents: OrphanMap, generation = 0): LegacySessionLike {
    return {
        id,
        createdAt: T_CREATED,
        lastSeen: T_SEEN,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: generation > 0 ? { orphanJournalGeneration: generation } : {},
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        } as unknown as LegacySessionLike["state"],
        blockContents: blockContents as unknown as LegacySessionLike["blockContents"],
        lastMessages: [msg(0), msg(1)],
        lastMessagesFolded: false,
    };
}

function reapShape(): OrphanMap {
    return new Map([["blk-1", { one: null, full: { text: "T1", count: 2 } }]]);
}

function openStore(dir: string): UnifiedStore {
    return UnifiedStore.open(path.join(dir, "index.db"));
}

async function save(store: UnifiedStore, legacy: LegacySessionLike): Promise<void> {
    await store.ingestSession(planIngest(legacy));
}

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true });
    } catch {
        // best effort: a locked sqlite file must not fail the assertion path
    }
}

test("#5597-C: an authoritative clear drops the session's orphan journal rows", async () => {
    const dir = tmpdir("bili-5597-clear-");
    try {
        const store = openStore(dir);
        await save(store, mkLegacy("s1", reapShape()));
        assert.deepEqual(Object.keys(store.getOrphanViews("s1") ?? {}), ["blk-1"], "the reap journal must be persisted");
        // The rebase: blockContents cleared for good, generation bumped.
        await save(store, mkLegacy("s1", new Map(), 2));
        assert.equal(store.getOrphanViews("s1"), null, "an authoritative clear must not leave the ghost journal behind");
    } finally {
        rmBestEffort(dir);
    }
});

test("#5597-C: an ordinary empty plan keeps the journal (merge/survive)", async () => {
    const dir = tmpdir("bili-5597-merge-");
    try {
        const store = openStore(dir);
        await save(store, mkLegacy("s1", reapShape()));
        // No bump — a save whose live map no longer carries the block (LazyBlockContents
        // trimming) must NOT be read as an authoritative clear.
        await save(store, mkLegacy("s1", new Map()));
        assert.deepEqual(Object.keys(store.getOrphanViews("s1") ?? {}), ["blk-1"], "ordinary saves keep the journal");
    } finally {
        rmBestEffort(dir);
    }
});

test("#5597-C: a stale-generation save does not clear (no regression path)", async () => {
    const dir = tmpdir("bili-5597-stale-");
    try {
        const store = openStore(dir);
        await save(store, mkLegacy("s1", reapShape(), 2));
        assert.deepEqual(Object.keys(store.getOrphanViews("s1") ?? {}), ["blk-1"], "generation 2 journal persisted");
        // A delayed plan from before the rebase (generation 1) must not delete.
        await save(store, mkLegacy("s1", new Map(), 1));
        assert.deepEqual(Object.keys(store.getOrphanViews("s1") ?? {}), ["blk-1"], "a lower generation must never clear the journal");
    } finally {
        rmBestEffort(dir);
    }
});

test("#5597-C: a clear on one session does not touch another session's journal", async () => {
    const dir = tmpdir("bili-5597-scope-");
    try {
        const store = openStore(dir);
        await save(store, mkLegacy("s1", reapShape(), 2));
        await save(store, mkLegacy("s2", reapShape(), 2));
        await save(store, mkLegacy("s2", new Map(), 3));
        assert.equal(store.getOrphanViews("s2"), null, "s2 was cleared");
        assert.deepEqual(Object.keys(store.getOrphanViews("s1") ?? {}), ["blk-1"], "s1's journal is out of the clear's scope");
    } finally {
        rmBestEffort(dir);
    }
});

interface RecordedQuery {
    sql: string;
    params?: unknown[];
}

function fakeConnection(recorded: RecordedQuery[], metadataJson: unknown): { query: (sql: string, params?: unknown[]) => Promise<unknown> } {
    return {
        query: async (sql: string, params?: unknown[]) => {
            recorded.push({ sql, params });
            if (sql.startsWith("SELECT metadata_json FROM sessions")) {
                return [[{ metadata_json: metadataJson }], []];
            }
            if (sql.startsWith("SELECT orphans_json FROM sessions")) {
                return [[{ orphans_json: null }], []];
            }
            return [{ affectedRows: 1 }, []];
        },
    };
}

type ApplyOrphanBlocksOn = (
    c: unknown,
    sessionId: string,
    incomingJson: string | null,
    priorGeneration: number,
    generation: number,
) => Promise<void>;

function mysqlBackendWithoutPool(): MysqlBackend {
    return Object.create(MysqlBackend.prototype) as MysqlBackend;
}

test("#5597-C mysql: a generation bump issues the scoped DELETE", async () => {
    const backend = mysqlBackendWithoutPool();
    const recorded: RecordedQuery[] = [];
    const apply = (backend as unknown as { applyOrphanBlocksOn: ApplyOrphanBlocksOn }).applyOrphanBlocksOn.bind(backend);
    await apply(fakeConnection(recorded, JSON.stringify({ orphanJournalGeneration: 1 })), "s1", null, 1, 2);
    const deletes = recorded.filter((q) => q.sql.startsWith("DELETE FROM orphan_blocks"));
    assert.equal(deletes.length, 1, "one scoped DELETE on a clear");
    assert.deepEqual(deletes[0]?.params, ["s1"], "the DELETE must be scoped to the session");
});

test("#5597-C mysql: merge (same generation) issues no DELETE", async () => {
    const backend = mysqlBackendWithoutPool();
    const recorded: RecordedQuery[] = [];
    const apply = (backend as unknown as { applyOrphanBlocksOn: ApplyOrphanBlocksOn }).applyOrphanBlocksOn.bind(backend);
    await apply(
        fakeConnection(recorded, JSON.stringify({ orphanJournalGeneration: 2 })),
        "s1",
        JSON.stringify({ "blk-1": { one: null, full: { text: "T1" } } }),
        2,
        2,
    );
    assert.equal(recorded.filter((q) => q.sql.startsWith("DELETE FROM orphan_blocks")).length, 0, "a plain save must merge");
    assert.ok(
        recorded.some((q) => q.sql.startsWith("INSERT INTO orphan_blocks")),
        "incoming entries still merge onto the table",
    );
});
