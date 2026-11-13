/**
 * #6325: the sessions-row upsert unconditionally overwrote the four large JSON
 * columns (metadata_json / kstate_json / tail_json / ccr_json) on EVERY save —
 * delta or full — so a steady-state turn that only appended a couple of
 * messages still rewrote ~13 MB of overflow pages into the WAL. This suite
 * pins the per-column write change-detection:
 *  1. skip: a steady-state save whose large columns are byte-identical to the
 *     last-written bytes carries the "unchanged" flags (0) in the upsert, so
 *     the UPDATE leg keeps the stored value (CASE WHEN);
 *  2. write: a save that actually mutates a column carries the "changed" flag
 *     (1) and the new bytes land;
 *  3. correctness: the stored bytes after an unchanged save are the same, and
 *     after a changed save are the new values — no stale-column divergence;
 *  4. re-arm: clearLastWrittenColumns (the drift-heal path) forces the next
 *     save back to a full write of every column.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage, CompressionBlock } from "../kernel/src/types.js";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6325-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

const refToken = (i: number): string => `m${String(i + 1).padStart(5, "0")}`;

function msg(i: number): CoreMessage {
    return { id: `h_msg${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `hello ${i}` } as CoreMessage;
}

const BLOCKS = 4;

function blockFixture(ord: number): CompressionBlock {
    const coveredIds = [`h_msg${ord * 2}`, `h_msg${ord * 2 + 1}`];
    return {
        blockId: `blk${ord}`,
        runId: `run${ord}`,
        summary: `summary body ${ord} ${"x".repeat(64)}`,
        effectiveMessageIds: coveredIds,
        directMessageIds: [],
        directBlockIds: [],
        compressedTokens: 100 + ord,
        survivedCount: 2,
        generation: "young",
        active: true,
        createdAt: 1_000 + ord,
        tier: 1,
    } as CompressionBlock;
}

/**
 * Full-history presentation. `metadata` is caller-controlled so a test can
 * flip it between saves; the ccr store and blocks are constant across saves
 * (only the message count / refs grow), which is exactly the steady-state
 * shape #6325 measures.
 */
function mkLegacy(id: string, count: number, metadata: Record<string, unknown>): LegacySessionLike {
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    const lastMessages: CoreMessage[] = [];
    for (let i = 0; i < count; i++) {
        const ref = refToken(i);
        byRaw[`h_msg${i}`] = ref;
        byRef[ref] = `h_msg${i}`;
        lastMessages.push(msg(i));
    }
    const blocks: CompressionBlock[] = [];
    const blockContents = new Map<string, { one: unknown; full: unknown }>();
    for (let ord = 0; ord < BLOCKS; ord++) {
        const b = blockFixture(ord);
        blocks.push(b);
        blockContents.set(`blk${ord}`, {
            one: { text: `one ${ord}`, count: 1 },
            full: { text: b.summary as string, count: 2 },
        });
    }
    const byRefCcr: Record<string, unknown> = {};
    for (let i = 0; i < Math.min(count, 8); i++) byRefCcr[refToken(i)] = { text: `ccr payload ${i}` };
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000 + count,
        meta: { protocol: "anthropic" },
        stats: { requests: count },
        metadata,
        state: {
            blocks,
            messageRefs: { byRaw, byRef },
            nextBlockId: BLOCKS + 1,
            nextRunId: 1,
        },
        blockContents,
        lastMessages,
        lastMessagesFolded: false,
        contentStore: { version: 1 as const, byHash: {} as Record<string, string>, byRef: byRefCcr },
    } as LegacySessionLike;
}

interface UpsertFlags {
    metadataChanged: number;
    kstateChanged: number;
    tailChanged: number;
    ccrChanged: number;
}

/** Wrap the shadow's real store db.prepare to capture the sessions-upsert flags. */
function instrumentFlags(store: UnifiedStore): { last: () => UpsertFlags | null; dispose: () => void } {
    const db = (store as unknown as {
        db: { prepare(q: string): unknown } & Record<string, unknown>;
    }).db;
    const orig = (db.prepare as (q: string) => { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown }).bind(db);
    let last: UpsertFlags | null = null;
    db.prepare = ((q: string) => {
        const stmt = orig(q);
        const isSessionsUpsert = q.includes("INSERT INTO sessions") && q.includes("@metadataChanged");
        return {
            run: (...args: unknown[]) => {
                if (isSessionsUpsert) {
                    const p = args[0] as Record<string, unknown>;
                    last = {
                        metadataChanged: p.metadataChanged as number,
                        kstateChanged: p.kstateChanged as number,
                        tailChanged: p.tailChanged as number,
                        ccrChanged: p.ccrChanged as number,
                    };
                }
                return stmt.run(...args);
            },
            get: (...args: unknown[]) => stmt.get(...args),
            all: (...args: unknown[]) => stmt.all(...args),
        };
    }) as typeof orig;
    return { last: () => last, dispose: () => { db.prepare = orig; } };
}

function openPair(dir: string): { shadow: UnifiedShadow; store: UnifiedStore } {
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
    assert.ok(shadow, "shadow mode sidecar must open");
    return { shadow, store };
}

const SID = "sess-colchg";

function readColumn(store: UnifiedStore, col: string): string | null {
    const row = (store as unknown as { db: { prepare(q: string): { get(...a: unknown[]): Record<string, unknown> | undefined } } }).db
        .prepare(`SELECT ${col} AS v FROM sessions WHERE session_id = ?`).get(SID);
    return row ? (row.v as string | null) : null;
}

test("#6325: first save writes every large column (no last-written entry yet)", (t) => {
    const dir = tmpdir("bili-6325-first-");
    t.after(() => rmBestEffort(dir));
    const { shadow, store } = openPair(dir);
    t.after(() => shadow.close());
    t.after(() => store.close());
    const m = instrumentFlags((shadow as unknown as { sync: UnifiedStore }).sync);
    t.after(() => m.dispose());

    shadow.record(mkLegacy(SID, 100, { marker: "v1" }));
    const f = m.last();
    assert.ok(f, "sessions upsert observed");
    assert.equal(f!.metadataChanged, 1, "first save writes metadata_json");
    assert.equal(f!.kstateChanged, 1, "first save writes kstate_json");
    assert.equal(f!.ccrChanged, 1, "first save writes ccr_json");
});

test("#6325: steady-state save skips byte-identical large columns, writes the ones that moved", (t) => {
    const dir = tmpdir("bili-6325-skip-");
    t.after(() => rmBestEffort(dir));
    const { shadow, store } = openPair(dir);
    t.after(() => shadow.close());
    t.after(() => store.close());
    const m = instrumentFlags((shadow as unknown as { sync: UnifiedStore }).sync);
    t.after(() => m.dispose());

    // Turn 0: cold full ingest.
    shadow.record(mkLegacy(SID, 100, { marker: "v1" }));
    const metaAfter0 = readColumn(store, "metadata_json");
    const ccrAfter0 = readColumn(store, "ccr_json");
    assert.ok(metaAfter0, "metadata_json present after first save");

    // Steady state: append 2 messages, SAME metadata + ccr store + blocks. The
    // appended refs land in the separate refs table (not a large column), so all
    // four large columns are byte-identical to the last write → all skipped.
    shadow.record(mkLegacy(SID, 102, { marker: "v1" }));
    const f = m.last();
    assert.ok(f, "upsert observed on the steady-state save");
    assert.equal(f!.metadataChanged, 0, "byte-identical metadata_json is skipped");
    assert.equal(f!.ccrChanged, 0, "byte-identical ccr_json is skipped");
    assert.equal(f!.kstateChanged, 0, "no new blocks/folds → kstate_json skipped");

    // Correctness: the skipped columns still hold the stored bytes.
    assert.equal(readColumn(store, "metadata_json"), metaAfter0, "skipped metadata_json keeps its stored bytes");
    assert.equal(readColumn(store, "ccr_json"), ccrAfter0, "skipped ccr_json keeps its stored bytes");
});

test("#6325: a mutated column is detected and the new bytes land", (t) => {
    const dir = tmpdir("bili-6325-mutate-");
    t.after(() => rmBestEffort(dir));
    const { shadow, store } = openPair(dir);
    t.after(() => shadow.close());
    t.after(() => store.close());
    const m = instrumentFlags((shadow as unknown as { sync: UnifiedStore }).sync);
    t.after(() => m.dispose());

    shadow.record(mkLegacy(SID, 100, { marker: "v1" }));
    const metaV1 = readColumn(store, "metadata_json");

    // Flip the metadata: the column must be detected as changed and rewritten.
    shadow.record(mkLegacy(SID, 102, { marker: "v2", extra: "new-key" }));
    const f = m.last();
    assert.ok(f, "upsert observed");
    assert.equal(f!.metadataChanged, 1, "mutated metadata_json is detected as changed");
    const metaV2 = readColumn(store, "metadata_json");
    assert.notEqual(metaV2, metaV1, "metadata_json holds the NEW bytes");
    assert.ok((metaV2 as string).includes("v2"), "new marker present in stored metadata_json");
});

test("#6325: clearLastWrittenColumns re-arms a full write of every column", (t) => {
    const dir = tmpdir("bili-6325-rearm-");
    t.after(() => rmBestEffort(dir));
    const { shadow, store } = openPair(dir);
    t.after(() => shadow.close());
    t.after(() => store.close());
    const syncStore = (shadow as unknown as { sync: UnifiedStore }).sync;
    const m = instrumentFlags(syncStore);
    t.after(() => m.dispose());

    shadow.record(mkLegacy(SID, 100, { marker: "v1" }));
    shadow.record(mkLegacy(SID, 102, { marker: "v1" })); // steady state (skips)
    assert.equal(m.last()!.metadataChanged, 0, "precondition: steady-state save skips metadata");

    // The drift-heal path clears the last-written entry: the next save must
    // full-write every column again (conservative re-arm).
    syncStore.clearLastWrittenColumns(SID);
    shadow.record(mkLegacy(SID, 104, { marker: "v1" }));
    const f = m.last();
    assert.ok(f, "upsert observed after re-arm");
    assert.equal(f!.metadataChanged, 1, "re-armed save writes metadata_json");
    assert.equal(f!.ccrChanged, 1, "re-armed save writes ccr_json");
});
