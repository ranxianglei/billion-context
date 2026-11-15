/**
 * #5744 (companion to issue5744-incremental-refs.test.ts): the refs ledger was
 * the dominant O(full history) leg, but the SAME full-replace shape existed on
 * two more tables maintained by ingestSession — ccr_entries (DELETE-all +
 * re-INSERT-all every save, which also destroyed and recreated every CAS blob
 * via release-to-zero) and blocks (per-block re-hash + upsert + CAS
 * bump/release dance even when the block was byte-identical). This suite pins
 * the incremental treatment of those two legs:
 *  1. statement budgets: steady-state saves touching ccr_entries / blocks cost
 *     a constant number of statements regardless of stored-set size (the old
 *     code paid ~4H and ~6B respectively);
 *  2. end-state equality: add/change/delete of ccr keys lands EXACTLY the
 *     incoming set with honest refcounts (no zero-refcount rows, deleted blobs
 *     reclaimed);
 *  3. convergence: a forced full-path save (watermark cleared) reproduces the
 *     exact same table state the diff path left behind — the "incoming set is
 *     authoritative" contract holds on both paths.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore, sha256Hex } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage, CompressionBlock } from "../kernel/src/types.js";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5744c-hermetic-"));
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

const CCR_KEYS = 400;
const BLOCKS = 60;

function ccrStore(vary: number) {
    const byRef: Record<string, unknown> = {};
    for (let i = 0; i < CCR_KEYS; i++) byRef[`m${String(i).padStart(5, "0")}`] = { text: `ccr payload ${i}`, vary };
    return { version: 1 as const, byHash: {} as Record<string, string>, byRef };
}

function blockFixture(ord: number, mutate = false): CompressionBlock {
    const coveredIds = [`h_msg${ord * 2}`, `h_msg${ord * 2 + 1}`];
    return {
        blockId: `blk${ord}`,
        runId: `run${ord}`,
        summary: mutate ? `mutated summary ${ord}` : `summary body ${ord} ${"x".repeat(64)}`,
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

/** Full-history presentation; byRaw/byRef cover exactly the presented ids. */
function mkLegacy(id: string, count: number, ccrVary: number, mutateBlock: number | null): LegacySessionLike {
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
        const b = blockFixture(ord, mutateBlock === ord);
        blocks.push(b);
        blockContents.set(`blk${ord}`, {
            one: { text: `one ${ord}`, count: 1 },
            full: { text: b.summary as string, count: 2 },
        });
    }
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000 + count,
        meta: { protocol: "anthropic" },
        stats: { requests: count },
        metadata: {},
        state: {
            blocks,
            messageRefs: { byRaw, byRef },
            nextBlockId: BLOCKS + 1,
            nextRunId: 1,
        },
        blockContents,
        lastMessages,
        lastMessagesFolded: false,
        contentStore: ccrStore(ccrVary),
    } as LegacySessionLike;
}

interface Meters {
    ccr: () => number;
    blocks: () => number;
    reset: () => void;
    dispose: () => void;
}

function instrument(store: UnifiedStore): Meters {
    const db = (store as unknown as {
        db: { prepare(q: string): unknown } & Record<string, unknown>;
    }).db;
    const orig = (db.prepare as (q: string) => { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown }).bind(db);
    let ccr = 0;
    let blocks = 0;
    db.prepare = ((q: string) => {
        const stmt = orig(q);
        const isCcr = q.includes("ccr_entries");
        const isBlocks = /\bblocks\b/.test(q);
        return {
            run: (...args: unknown[]) => {
                if (isCcr) ccr += 1;
                if (isBlocks) blocks += 1;
                return stmt.run(...args);
            },
            get: (...args: unknown[]) => {
                if (isCcr) ccr += 1;
                if (isBlocks) blocks += 1;
                return stmt.get(...args);
            },
            all: (...args: unknown[]) => {
                if (isCcr) ccr += 1;
                if (isBlocks) blocks += 1;
                return stmt.all(...args);
            },
        };
    }) as typeof orig;
    return {
        ccr: () => ccr,
        blocks: () => blocks,
        reset: () => { ccr = 0; blocks = 0; },
        dispose: () => { db.prepare = orig; },
    };
}

function openPair(dir: string): { shadow: UnifiedShadow; store: UnifiedStore } {
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
    assert.ok(shadow, "shadow mode sidecar must open");
    return { shadow, store };
}

const SID = "sess-diff";

test("#5744: steady-state saves touch ccr_entries and blocks with a constant statement budget", (t) => {
    const dir = tmpdir("bili-5744c-budget-");
    t.after(() => rmBestEffort(dir));
    const { shadow, store } = openPair(dir);
    t.after(() => shadow.close());
    t.after(() => store.close());
    // Instrument the store the SHADOW actually writes through — openPair's
    // standalone handle is a second connection to the same file, and a meter
    // on it would read zero and make every budget below vacuous.
    const m = instrument((shadow as unknown as { sync: UnifiedStore }).sync);
    t.after(() => m.dispose());

    // Turn 0: cold full ingest — allowed to pay whatever a first ingest costs.
    shadow.record(mkLegacy(SID, 300, 0, null));
    m.reset();

    // Steady state: append 2 messages, identical ccr store and blocks.
    for (let turn = 1; turn <= 4; turn++) {
        shadow.record(mkLegacy(SID, 300 + turn * 2, 0, null));
        // One indexed read of the stored set per table; nothing else may touch
        // the table in steady state. (Old code: ccr ~4*CCR_KEYS, blocks ~6*BLOCKS.)
        // The >= 1 floors prove the meter sees the write path at all.
        assert.ok(m.ccr() >= 1 && m.ccr() <= 2, `turn ${turn}: ccr_entries touched ${m.ccr()} times, want 1..2`);
        assert.ok(m.blocks() >= 1 && m.blocks() <= 3, `turn ${turn}: blocks touched ${m.blocks()} times, want 1..3`);
        m.reset();
    }
});

test("#5744: ccr add/change/delete lands exactly the incoming set with honest refcounts", (t) => {
    const dir = tmpdir("bili-5744c-ccr-");
    t.after(() => rmBestEffort(dir));
    const { shadow, store } = openPair(dir);
    t.after(() => shadow.close());
    t.after(() => store.close());

    shadow.record(mkLegacy(SID, 100, 0, null));

    // Mutate the store: drop key idx 2, change value of idx 5, append a new key.
    const mutated = ccrStore(7);
    delete mutated.byRef[refToken(2)];
    (mutated.byRef[refToken(5)] as { text: string }).text = "changed value 5";
    mutated.byRef["mNEWKEY"] = { text: "brand new entry" };
    const legacy = mkLegacy(SID, 102, 0, null);
    legacy.contentStore = mutated;
    shadow.record(legacy);

    const rows = (store as unknown as { db: { prepare(q: string): { all(...a: unknown[]): Array<Record<string, unknown>> } } }).db
        .prepare("SELECT ord, ccr_key, content_hash FROM ccr_entries WHERE session_id = ? ORDER BY ord")
        .all(SID);
    assert.equal(rows.length, CCR_KEYS, "entry count survives the mutation (dropped one, added one)");
    for (let i = 0; i < rows.length; i++) {
        assert.equal(rows[i].ord as number, i, `ord ${i} is dense`);
    }
    const byKey = new Map(rows.map((r) => [r.ccr_key as string, r]));
    assert.equal(byKey.has(refToken(2)), false, "deleted key is gone");
    assert.equal(byKey.has("mNEWKEY"), true, "new key landed");
    const newHash = sha256Hex(JSON.stringify(mutated.byRef["mNEWKEY"]));
    assert.equal(byKey.get("mNEWKEY")?.content_hash as string, newHash, "new key holds the digest of its value");
    const changedHash = sha256Hex(JSON.stringify((mutated.byRef[refToken(5)] as object)));
    assert.equal(byKey.get(refToken(5))?.content_hash as string, changedHash, "changed key holds the NEW digest");

    // Refcount honesty: no zero/negative-refcount rows anywhere; the dropped
    // key's blob was reclaimed (delete-on-zero) since nothing else references it.
    const bad = (store as unknown as { db: { prepare(q: string): { all(): Array<Record<string, unknown>> } } }).db
        .prepare("SELECT COUNT(*) AS n FROM content WHERE refcount <= 0").all()[0];
    assert.equal(bad.n as number, 0, "no zero-refcount content rows");
    const droppedHash = sha256Hex(JSON.stringify({ text: "ccr payload 2", vary: 0 }));
    const leftover = (store as unknown as { db: { prepare(q: string): { get(...a: unknown[]): unknown } } }).db
        .prepare("SELECT 1 FROM content WHERE hash = ?").get(droppedHash);
    assert.equal(leftover, undefined, "dropped key's blob was reclaimed");
});

test("#5744: a changed block releases its old summary blob and keeps refcounts honest", (t) => {
    const dir = tmpdir("bili-5744c-blocks-");
    t.after(() => rmBestEffort(dir));
    const { shadow, store } = openPair(dir);
    t.after(() => shadow.close());
    t.after(() => store.close());

    shadow.record(mkLegacy(SID, 100, 0, null));
    const oldSummaryJson = JSON.stringify({ text: blockFixture(3).summary as string, count: 2 });
    const oldHash = sha256Hex(oldSummaryJson);
    const db = (store as unknown as { db: { prepare(q: string): { get(...a: unknown[]): unknown } } }).db;
    assert.notEqual(db.prepare("SELECT 1 FROM content WHERE hash = ?").get(oldHash), undefined, "baseline summary blob present");

    shadow.record(mkLegacy(SID, 102, 0, 3));

    assert.equal(db.prepare("SELECT 1 FROM content WHERE hash = ?").get(oldHash), undefined, "replaced summary blob released to zero");
    const bad = (store as unknown as { db: { prepare(q: string): { all(): Array<Record<string, unknown>> } } }).db
        .prepare("SELECT COUNT(*) AS n FROM content WHERE refcount <= 0").all()[0];
    assert.equal(bad.n as number, 0, "no zero-refcount content rows after the replacement");
});

test("#5744: forced full-path save converges to the exact state the diff path left behind", (t) => {
    const dir = tmpdir("bili-5744c-converge-");
    t.after(() => rmBestEffort(dir));
    const { shadow, store } = openPair(dir);
    t.after(() => shadow.close());
    t.after(() => store.close());
    const rawDb = (store as unknown as { db: { prepare(q: string): { all(...a: unknown[]): unknown[] } } }).db;

    shadow.record(mkLegacy(SID, 200, 0, null));
    shadow.record(mkLegacy(SID, 202, 0, null)); // delta turns

    const snapshot = (): string => JSON.stringify([
        rawDb.prepare("SELECT ord, raw_id, ref, ref_num FROM refs WHERE session_id = ? ORDER BY ord").all(SID),
        rawDb.prepare("SELECT ord, ccr_key, content_hash FROM ccr_entries WHERE session_id = ? ORDER BY ord").all(SID),
        rawDb.prepare("SELECT block_id, ord, start_seq, end_seq, tier, summary_hash, one_hash, active, covered_hash FROM blocks WHERE session_id = ? ORDER BY ord").all(SID),
    ]);
    const diffState = snapshot();

    // Force the next save down the full path: drop the watermark, keep the raw
    // tail (complete-log full ingest). The authoritative-set contract means the
    // three tables must come out BYTE-IDENTICAL to what the diff path wrote.
    (shadow as unknown as { sync: { clearIngestWatermark(id: string): void } }).sync.clearIngestWatermark(SID);
    shadow.record(mkLegacy(SID, 202, 0, null));
    assert.equal(snapshot(), diffState, "full-path save reproduces the diff-path end state exactly");
});

test("#5744: slow-ingest diagnostics expose WAL size and the last checkpoint triple", (t) => {
    const dir = tmpdir("bili-5744c-waldiag-");
    t.after(() => rmBestEffort(dir));
    const { shadow, store } = openPair(dir);
    t.after(() => shadow.close());
    t.after(() => store.close());

    // Exactly 20 ingests so the periodic checkpoint tick (every 20th successful
    // ingest) fires on the store the shadow writes through.
    for (let turn = 0; turn < 20; turn++) {
        shadow.record(mkLegacy(SID, 10 + turn, 0, null));
    }
    const syncStore = (shadow as unknown as { sync: UnifiedStore }).sync;
    const suffix = syncStore.walDiagnosticsSuffix();
    assert.ok(typeof suffix === "string" && suffix.length > 0, "WAL forensics available once a WAL file exists");
    assert.ok(suffix.includes("WAL"), `suffix carries the WAL size: ${suffix}`);
    assert.ok(suffix.includes("lastCheckpoint=(busy="), `last tick triple present: ${suffix}`);
    assert.ok(suffix.includes("checkpointed=") && suffix.includes("took="), `tick duration present: ${suffix}`);
});
