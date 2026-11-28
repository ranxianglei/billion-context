/**
 * egress usage plane (8th egress table, owner ruling 2026-11-27) — the cache
 * ledger is in-memory; on a 7+1-table instance it survives a restart ONLY
 * through the eg_usage event stream (M/S/F rows), replayed on load.
 *
 * Coverage:
 *   A. storage layer — table creation, append/op_seq, rows, fork copy
 *      (full + point prefix, idempotent re-fork), delete, stats row
 *      (roundtrip / 1024-char cap / best-effort warn-once);
 *   B. emission — settleUsageReport emits the S row carrying the EXACT
 *      recordCacheSample arguments (+ lastModel), an M row precedes S on a
 *      restart sample, F rows come from recordCacheFoldsFromBlocks and
 *      precede the next S;
 *   C. replay golden — re-applying the stream to a fresh session rebuilds a
 *      BYTE-EQUAL ledger (deepEqual, no field exclusions when driven without
 *      body capture — the documented boundaries are seam-forensics counters,
 *      per-line body-evidence fields, the #2202 coverage fraction and the
 *      #4731 xMeasured adjustment, none of which fire without captures);
 *   D. persist load wiring — the replay runs only for an egressAuthority
 *      session into an EMPTY ledger (a restored envelope ledger wins), and a
 *      corrupt stream degrades to an empty ledger with a warn, never a throw.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CompressionBlock } from "acp-kernel";
import {
    getCacheLedger,
    recordCacheFoldsFromBlocks,
    recordCacheSample,
    rebuildCacheLedgerFromUsageEvents,
    settleUsageReport,
    setEgressUsageSink,
    setEgressUsageStatsSink,
    type EgressUsageEvent as LedgerEvent,
} from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import {
    egressUsageAppend,
    egressUsageDelete,
    egressUsageForkCopy,
    egressUsageForkCopyPrefix,
    egressUsageRows,
    readUsageStats,
    writeUsageStats,
    writeUsageStatsBestEffort,
    USAGE_STAT_KEY,
    USAGE_STATS_MAX_CHARS,
    type EgressUsageEvent as StoreEvent,
} from "../src/storage/egress-usage.ts";
import { setLogCapture } from "../src/logger.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
const testRoot = mkdtempSync(join(tmpdir(), "bili-egress-usage-"));
test.after(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* leaked temp dir is harmless */ }
});

function openEgStore(dir: string): UnifiedStore {
    const saved = process.env.BILI_ROLLOUT_EGRESS_PLANE;
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
    let store: UnifiedStore;
    try {
        store = UnifiedStore.open(join(dir, "index.db"));
    } finally {
        if (saved === undefined) delete process.env.BILI_ROLLOUT_EGRESS_PLANE; else process.env.BILI_ROLLOUT_EGRESS_PLANE = saved;
    }
    return store;
}

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `eu-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

/** tokenSnapshot: m00001..m00020 @ 500 tok each; byRef maps ref→raw. */
function withView20(session: Session): void {
    const st = session.state as { messageRefs: { byRaw: Record<string, string>; byRef: Record<string, string> }; tokenSnapshot: Record<string, number>; blocks: CompressionBlock[] };
    for (let i = 1; i <= 20; i++) {
        const ref = `m${String(i).padStart(5, "0")}`;
        st.messageRefs.byRef[ref] = `raw${i}`;
        st.messageRefs.byRaw[`raw${i}`] = ref;
        st.tokenSnapshot[ref] = 500;
    }
}

function block(id: string, at: number, S: number, sigmaChars: number, startRef?: string): CompressionBlock {
    return {
        blockId: id,
        createdAt: at,
        compressedTokens: S,
        summary: "s".repeat(sigmaChars),
        startRef,
    } as unknown as CompressionBlock;
}

function identityInput(sid: string, over: Partial<Parameters<UnifiedStore["ensureEgressIdentity"]>[0]> = {}) {
    return {
        sessionId: sid,
        parentSessionId: null,
        protocol: "openai",
        label: "host-" + sid,
        title: "first title",
        hostTitle: null,
        namespace: "dsh",
        origin: "http://127.0.0.1:8199",
        createdAt: 1000,
        updatedAt: 2000,
        metaJson: JSON.stringify({ protocol: "openai" }),
        metadataJson: JSON.stringify({ egressAuthority: true }),
        ...over,
    };
}

const T0 = Date.parse("2026-09-15T10:00:00Z");

// A deterministic live scenario shared by the emission and replay tests:
// cold opener → fold b1 → post-fold sample → growth → fold b2 → growth.
// Fold claims stay clean (each post-fold sample is warm enough), so no
// seam-forensics counter fires and the replay boundary list stays empty.
const SAMPLES = [
    { at: T0 + 1000, input: 10000, cached: 9000 },
    { at: T0 + 2000, input: 6000, cached: 5000 },
    { at: T0 + 3000, input: 7000, cached: 6000 },
    { at: T0 + 4000, input: 7500, cached: 7000 },
];
const FOLDS: Array<{ id: string; at: number; S: number; sigmaChars: number; startRef?: string; V?: number; Vp?: number }> = [
    { id: "b1", at: T0 + 1500, S: 5000, sigmaChars: 8192, startRef: "m00010", V: 10000, Vp: 5000 },
    { id: "b2", at: T0 + 3500, S: 2000, sigmaChars: 4096, startRef: "m00015", V: 7000, Vp: 5000 },
];

// ---------------------------------------------------------------------------
// A: storage layer
// ---------------------------------------------------------------------------

test("A1: a fresh eg-mode database carries the eg_usage table (the 8th egress table)", () => {
    const dir = mkdtempSync(join(testRoot, "a1-"));
    const store = openEgStore(dir);
    const db = (store as unknown as { db: Parameters<typeof egressUsageAppend>[0] }).db;
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('eg_block_flow', 'eg_block_state', 'eg_flow', 'eg_state', 'eg_usage')").all() as { name: string }[]).map((r) => r.name).sort();
    assert.deepEqual(tables, ["eg_block_flow", "eg_block_state", "eg_flow", "eg_state", "eg_usage"].sort());
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_eg_usage_at'").all() as unknown[]).length;
    assert.equal(idx, 1, "the (session_id, at, op_seq) index exists");
});

test("A2: append assigns op_seq = MAX+1 per session and rows round-trip in op order", () => {
    const dir = mkdtempSync(join(testRoot, "a2-"));
    const store = openEgStore(dir);
    const db = (store as unknown as { db: Parameters<typeof egressUsageAppend>[0] }).db;
    const evs1: StoreEvent[] = [
        { type: "S", at: 100, payload: { s: { at: 100, input: 10, cached: 9 }, model: "m" } },
        { type: "M", at: 110 },
        { type: "F", at: 120, payload: { at: 120, S: 5, sigma: 2, bid: "b1" } },
    ];
    assert.equal(egressUsageAppend(db, "s1", evs1), 3);
    assert.equal(egressUsageAppend(db, "s1", []), 0);
    // a different session keeps its own numbering space
    assert.equal(egressUsageAppend(db, "s2", [{ type: "S", at: 130, payload: {} }]), 1);
    const rows = egressUsageRows(db, "s1");
    assert.deepEqual(rows.map((r) => [r.opSeq, r.rowType, r.at]), [[1, "S", 100], [2, "M", 110], [3, "F", 120]]);
    assert.equal(rows[0].payloadText, JSON.stringify({ s: { at: 100, input: 10, cached: 9 }, model: "m" }));
    assert.equal(rows[1].payloadText, "null");
    assert.equal(egressUsageRows(db, "s2").length, 1);
    assert.equal(egressUsageRows(db, "s3").length, 0);
    // invalid input throws and rolls the whole batch back
    assert.throws(() => egressUsageAppend(db, "s1", [{ type: "X" as never, at: 1 }]), /unknown row_type/);
    assert.throws(() => egressUsageAppend(db, "s1", [{ type: "S", at: -5, payload: {} }]), /bad event at=/);
    assert.equal(egressUsageRows(db, "s1").length, 3, "the failed batch left the stream untouched");
});

test("A3: fork-to-now copies the WHOLE stream; re-fork is idempotent; point-fork copies the at<=watermark prefix", () => {
    const dir = mkdtempSync(join(testRoot, "a3-"));
    const store = openEgStore(dir);
    const db = (store as unknown as { db: Parameters<typeof egressUsageAppend>[0] }).db;
    egressUsageAppend(db, "p", [
        { type: "S", at: 100, payload: { n: 1 } },
        { type: "F", at: 200, payload: { n: 2 } },
        { type: "S", at: 300, payload: { n: 3 } },
        { type: "S", at: 400, payload: { n: 4 } },
    ]);
    egressUsageForkCopy(db, "p", "c");
    assert.deepEqual(egressUsageRows(db, "c").map((r) => [r.opSeq, r.rowType, r.at]), [[1, "S", 100], [2, "F", 200], [3, "S", 300], [4, "S", 400]]);
    // idempotent re-fork of the same pair: replace, not duplicate
    egressUsageForkCopy(db, "p", "c");
    assert.equal(egressUsageRows(db, "c").length, 4);
    assert.throws(() => egressUsageForkCopy(db, "p", "p"), /same session/);
    egressUsageForkCopyPrefix(db, "p", "c2", 200);
    assert.deepEqual(egressUsageRows(db, "c2").map((r) => [r.opSeq, r.rowType, r.at]), [[1, "S", 100], [2, "F", 200]]);
    // re-fork into a child that already has its own newer rows: the copy
    // replaces the child's stream (the parent's stream is the fork truth)
    egressUsageAppend(db, "c2", [{ type: "S", at: 500, payload: { n: 9 } }]);
    egressUsageForkCopyPrefix(db, "p", "c2", 400);
    assert.equal(egressUsageRows(db, "c2").length, 4);
});

test("A4: delete drops the stream", () => {
    const dir = mkdtempSync(join(testRoot, "a4-"));
    const store = openEgStore(dir);
    const db = (store as unknown as { db: Parameters<typeof egressUsageAppend>[0] }).db;
    egressUsageAppend(db, "s1", [{ type: "S", at: 1, payload: {} }, { type: "M", at: 2 }]);
    assert.equal(egressUsageDelete(db, "s1"), 2);
    assert.equal(egressUsageRows(db, "s1").length, 0);
    assert.equal(egressUsageDelete(db, "s1"), 0);
});

test("A5: the materialized stats row — roundtrip, 1024-char cap, best-effort warn-once", () => {
    const dir = mkdtempSync(join(testRoot, "a5-"));
    const store = openEgStore(dir);
    const db = (store as unknown as { db: Parameters<typeof readUsageStats>[0] }).db;
    assert.equal(readUsageStats(db, "s1"), null);
    writeUsageStats(db, "s1", '{"requests":3,"input":90}');
    assert.equal(readUsageStats(db, "s1"), '{"requests":3,"input":90}');
    writeUsageStats(db, "s1", '{"requests":4}');
    assert.equal(readUsageStats(db, "s1"), '{"requests":4}');
    assert.throws(() => writeUsageStats(db, "s1", ""), /empty value/);
    assert.throws(() => writeUsageStats(db, "s1", "[1,2]"), /must be a JSON object/);
    const tooBig = JSON.stringify({ pad: "x".repeat(USAGE_STATS_MAX_CHARS - 5) });
    assert.ok(tooBig.length > USAGE_STATS_MAX_CHARS);
    assert.throws(() => writeUsageStats(db, "s1", tooBig), new RegExp(String(USAGE_STATS_MAX_CHARS)));
    const logs: string[] = [];
    assert.equal(writeUsageStatsBestEffort(db, "s1", tooBig, (m) => logs.push(m)), false);
    assert.ok(logs.length === 1 && logs[0].includes("egress usage stats"), "warns once with the reason");
    assert.equal(readUsageStats(db, "s1"), '{"requests":4}', "the failed write leaves the old row intact");
    assert.equal(writeUsageStatsBestEffort(db, "s1", '{"requests":5}', (m) => logs.push(m)), true);
    assert.equal(readUsageStats(db, "s1"), '{"requests":5}');
    assert.equal(logs.length, 1, "the second failure class stays silent only per-process — success does not re-warn");
    // the key namespace is stable
    const row = (db.prepare("SELECT key FROM session_ext WHERE session_id = ? AND key = ?").get("s1", USAGE_STAT_KEY) as { key: string } | undefined);
    assert.equal(row?.key, "usage:stats");
});

// ---------------------------------------------------------------------------
// B: emission
// ---------------------------------------------------------------------------

test("B1: settle emits the S row with the EXACT sample arguments and lastModel; folds emit F rows ahead of the next S", () => {
    setEgressUsageStatsSink(null);
    const session = makeSession();
    withView20(session);
    session.metadata.lastModel = "claude-test";
    const stream: LedgerEvent[] = [];
    const sink = (events: LedgerEvent[]) => stream.push(...events);
    setEgressUsageSink((_, events) => sink(events));
    try {
        // cold opener
        settleUsageReport(session, { total: SAMPLES[0].input, reportedCached: SAMPLES[0].cached, output: 7, protocol: "openai" });
        assert.equal(stream.length, 1);
        assert.equal(stream[0].type, "S");
        assert.deepEqual(stream[0].payload, {
            s: {
                at: stream[0].at, input: 10000, cached: 9000, output: 7, protocol: "openai",
                upstream: undefined, keyFp: undefined, sysFp: undefined, canonFp: undefined, mode: undefined, effFp: undefined,
            },
            model: "claude-test",
        });
        // fold b1 (eager site) then the post-fold sample
        recordCacheFoldsFromBlocks(session, [block("b1", FOLDS[0].at, FOLDS[0].S, FOLDS[0].sigmaChars, FOLDS[0].startRef)], { V: FOLDS[0].V, Vp: FOLDS[0].Vp });
        assert.equal(stream.length, 2);
        const f1 = stream[1];
        assert.equal(f1.type, "F");
        assert.deepEqual(f1.payload, { at: FOLDS[0].at, S: FOLDS[0].S, sigma: Math.ceil(FOLDS[0].sigmaChars / 4), X: 4500, V: 10000, Vp: 5000, bid: "b1" });
        settleUsageReport(session, { total: SAMPLES[1].input, reportedCached: SAMPLES[1].cached, protocol: "openai" });
        assert.equal(stream.length, 3);
        assert.equal(stream[2].type, "S", "the F row precedes the post-fold S row");
        // a zero-total placeholder still settles (a quarantined sample line
        // with cached=null — it is ledger state, so it rides the stream too)
        settleUsageReport(session, { total: 0, reportedCached: null, protocol: "openai" });
        assert.equal(stream.length, 4);
        const s3 = stream[3];
        assert.equal(s3.type, "S");
        assert.equal(s3.payload.s.input, 0);
        assert.equal(s3.payload.s.cached, null);
    } finally {
        setEgressUsageSink(null);
    }
});

test("B2: the restart sample emits M before S (and only on the rs=1 sample)", () => {
    setEgressUsageStatsSink(null);
    const session = makeSession();
    withView20(session);
    const stream: LedgerEvent[] = [];
    setEgressUsageSink((_, events) => stream.push(...events));
    try {
        settleUsageReport(session, { total: 10000, reportedCached: 9000, protocol: "openai" });
        assert.deepEqual(stream.map((e) => e.type), ["S"], "no boot boundary on the first-ever sample");
        // simulate the process restart: the persisted ledger carried a
        // different boot id, so the first known sample is flagged rs=1
        getCacheLedger(session).lastBoot = "previous-boot";
        settleUsageReport(session, { total: 10500, reportedCached: 10000, protocol: "openai" });
        assert.deepEqual(stream.map((e) => e.type), ["S", "M", "S"], "M precedes exactly the rs=1 S row");
        assert.equal(stream[1].at, stream[2].at, "M carries the sample's at");
        settleUsageReport(session, { total: 11000, reportedCached: 10500, protocol: "openai" });
        assert.deepEqual(stream.map((e) => e.type), ["S", "M", "S", "S"], "the second sample of the new boot is a plain S");
    } finally {
        setEgressUsageSink(null);
    }
});

test("B3: the stats sink gets the bounded JSON with every S (and only a valid object)", () => {
    const session = makeSession();
    withView20(session);
    const stats: string[] = [];
    setEgressUsageSink(null);
    setEgressUsageStatsSink((_, json) => stats.push(json));
    try {
        settleUsageReport(session, { total: 10000, reportedCached: 9000, protocol: "openai" });
        assert.equal(stats.length, 1);
        const o = JSON.parse(stats[0]) as Record<string, number>;
        assert.equal(o.requests, 1);
        assert.equal(o.input, 10000);
        assert.ok(stats[0].length <= USAGE_STATS_MAX_CHARS);
    } finally {
        setEgressUsageStatsSink(null);
    }
});

// ---------------------------------------------------------------------------
// C: replay golden
// ---------------------------------------------------------------------------

test("C1: replaying the event stream into a fresh session rebuilds a byte-equal ledger", () => {
    setEgressUsageSink(null);
    setEgressUsageStatsSink(null);
    const live = makeSession();
    withView20(live);
    const stream: LedgerEvent[] = [];
    setEgressUsageSink((_, events) => stream.push(...events));
    try {
        let fi = 0;
        for (let i = 0; i < SAMPLES.length; i++) {
            if (fi < FOLDS.length && i === (fi === 0 ? 1 : 3)) {
                const f = FOLDS[fi];
                (live.state as { blocks: CompressionBlock[] }).blocks.push(block(f.id, f.at, f.S, f.sigmaChars, f.startRef));
                recordCacheFoldsFromBlocks(live, [block(f.id, f.at, f.S, f.sigmaChars, f.startRef)], { V: f.V, Vp: f.Vp });
                fi += 1;
            }
            settleUsageReport(live, { total: SAMPLES[i].input, reportedCached: SAMPLES[i].cached, protocol: "openai" });
        }
    } finally {
        setEgressUsageSink(null);
    }
    assert.deepEqual(stream.map((e) => e.type), ["S", "F", "S", "S", "F", "S"], "the stream is the live mutation order");

    // the fresh session must mirror the block rows (the live ledger saw the
    // same objects; replay re-pushes the stored fold rows, not the blocks)
    const fresh = makeSession();
    withView20(fresh);
    for (const f of FOLDS) (fresh.state as { blocks: CompressionBlock[] }).blocks.push(block(f.id, f.at, f.S, f.sigmaChars, f.startRef));
    const n = rebuildCacheLedgerFromUsageEvents(fresh, stream as Array<{ type: "M" | "S" | "F"; at: number; payload?: unknown }>);
    assert.deepEqual(n, { lines: SAMPLES.length, folds: FOLDS.length });
    assert.deepEqual(getCacheLedger(fresh), getCacheLedger(live), "the rebuilt ledger is byte-equal to the live one");
});

function recordCacheSampleDirect(session: Session, s: { at: number; input: number; cached: number | null }): void {
    recordCacheSample(session, { at: s.at, input: s.input, cached: s.cached });
}

test("C2: an M row in the stream re-arms the restart sentinel — the next replayed sample is rs=1", () => {
    const a = makeSession();
    withView20(a);
    recordCacheSampleDirect(a, { at: T0 + 1000, input: 10000, cached: 9000 });
    const aLed = getCacheLedger(a);
    assert.equal(aLed.lines[0].rs, undefined);

    // restart: the stream grew an M + a fresh sample
    const b = makeSession();
    withView20(b);
    recordCacheSampleDirect(b, { at: T0 + 1000, input: 10000, cached: 9000 });
    getCacheLedger(b).lastBoot = "other";
    recordCacheSampleDirect(b, { at: T0 + 2000, input: 10500, cached: 10000 });
    assert.equal(getCacheLedger(b).lines[1].rs, 1, "live: the post-restart sample is flagged");

    const c = makeSession();
    withView20(c);
    rebuildCacheLedgerFromUsageEvents(c, [
        { type: "S", at: T0 + 1000, payload: { s: { at: T0 + 1000, input: 10000, cached: 9000 }, model: undefined } },
        { type: "M", at: T0 + 2000 },
        { type: "S", at: T0 + 2000, payload: { s: { at: T0 + 2000, input: 10500, cached: 10000 }, model: undefined } },
    ]);
    assert.equal(getCacheLedger(c).lines[0].rs, undefined);
    assert.equal(getCacheLedger(c).lines[1].rs, 1, "replay: the M row makes exactly the same sample restart-flagged");
});

test("C3: corrupt stream entries are skipped, never fatal; all-S-corrupt degrades to an empty ledger", () => {
    const s = makeSession();
    withView20(s);
    const n = rebuildCacheLedgerFromUsageEvents(s, [
        { type: "S", at: T0 + 1, payload: { s: { at: T0 + 1, input: 100, cached: 90 } } },
        { type: "S", at: T0 + 2, payload: null },
        { type: "S", at: T0 + 3, payload: { s: { at: "nope", input: 5, cached: 1 } } },
        { type: "F", at: T0 + 4, payload: { at: T0 + 4, S: "bad", sigma: 1, bid: "b1" } },
        { type: "M", at: T0 + 5 },
    ]);
    assert.deepEqual(n, { lines: 1, folds: 0 });

    const t = makeSession();
    withView20(t);
    const n2 = rebuildCacheLedgerFromUsageEvents(t, [{ type: "S", at: T0, payload: null }]);
    assert.deepEqual(n2, { lines: 0, folds: 0 });
});

// ---------------------------------------------------------------------------
// D: persist load wiring
// ---------------------------------------------------------------------------

async function driveLoad(sid: string, over: Partial<Parameters<UnifiedStore["ensureEgressIdentity"]>[0]>, rows: StoreEvent[] | null): Promise<Session | null> {
    const dir = mkdtempSync(join(testRoot, "d-"));
    const sdir = join(dir, "sessions");
    const savedPlane = process.env.BILI_ROLLOUT_EGRESS_PLANE;
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
    const store = openEgStore(sdir);
    try {
        store.ensureEgressIdentity(identityInput(sid, over));
        if (rows) store.egressUsageAppend(sid, rows);
        const sess = new SessionStore({ dir: sdir, enabled: true, debounceMs: 15 });
        _setStoreForTest(sess);
        try {
            return await sess.loadAsync(sid);
        } finally {
            sess.cancelAll();
        }
    } finally {
        if (savedPlane === undefined) delete process.env.BILI_ROLLOUT_EGRESS_PLANE; else process.env.BILI_ROLLOUT_EGRESS_PLANE = savedPlane;
    }
}

test("D1: an egressAuthority session loads with its ledger replayed from the stream", async () => {
    const logs: string[] = [];
    setLogCapture((level, msg) => logs.push(`${level}:${msg}`));
    try {
        const s = await driveLoad("d1-s1", {}, [
            { type: "S", at: T0 + 1000, payload: { s: { at: T0 + 1000, input: 10000, cached: 9000 }, model: "claude-test" } },
            { type: "F", at: T0 + 1500, payload: { at: T0 + 1500, S: 5000, sigma: 2048, X: 4500, V: 10000, Vp: 5000, bid: "b1" } },
            { type: "S", at: T0 + 2000, payload: { s: { at: T0 + 2000, input: 6000, cached: 5000 }, model: "claude-test" } },
        ]);
        assert.ok(s, "the identity row loads");
        const led = getCacheLedger(s);
        assert.equal(led.lines.length, 2);
        assert.equal(led.folds.length, 1);
        assert.equal(led.agg.requests, 2);
        assert.ok(logs.some((l) => l.includes("rebuilt the cache ledger")), "the rebuild is logged");
    } finally {
        setLogCapture(null);
    }
});

test("D2: a non-egress session does not replay even when the stream exists", async () => {
    const s = await driveLoad("d2-s1", { metadataJson: JSON.stringify({}) }, [
        { type: "S", at: T0 + 1000, payload: { s: { at: T0 + 1000, input: 10000, cached: 9000 } } },
    ]);
    assert.ok(s);
    assert.equal(getCacheLedger(s).lines.length, 0);
});

test("D3: a corrupt stream degrades to an empty ledger with a warn (never a throw)", async () => {
    const logs: string[] = [];
    setLogCapture((level, msg) => logs.push(`${level}:${msg}`));
    try {
        const dir = mkdtempSync(join(testRoot, "d3-"));
        const sdir = join(dir, "sessions");
        const savedPlane = process.env.BILI_ROLLOUT_EGRESS_PLANE;
        process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
        const store = openEgStore(sdir);
        try {
            store.ensureEgressIdentity(identityInput("d3-s1"));
            // raw SQL: a payload that is not JSON at all
            (store as unknown as { db: Parameters<typeof egressUsageAppend>[0] }).db
                .prepare("INSERT INTO eg_usage (session_id, op_seq, row_type, at, payload, created_at) VALUES ('d3-s1', 1, 'S', ?, 'not-json', 1)")
                .run(T0);
            const sess = new SessionStore({ dir: sdir, enabled: true, debounceMs: 15 });
            _setStoreForTest(sess);
            try {
                const s = await sess.loadAsync("d3-s1");
                assert.ok(s, "the session loads despite the corrupt stream");
                assert.equal(getCacheLedger(s).lines.length, 0);
                assert.ok(logs.some((l) => l.includes("info") && l.includes("rebuilt the cache ledger")), "the (empty) rebuild path was taken — the bad row was skipped, not fatal");
            } finally {
                sess.cancelAll();
            }
        } finally {
            if (savedPlane === undefined) delete process.env.BILI_ROLLOUT_EGRESS_PLANE; else process.env.BILI_ROLLOUT_EGRESS_PLANE = savedPlane;
        }
    } finally {
        setLogCapture(null);
    }
});
