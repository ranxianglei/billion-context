// #5874 v2 step 3 — egress cache through the D-lane render (maybeSnapshotView):
// the warm path must be BYTE-IDENTICAL to the cold derive, the content load
// must provably skip the cached prefix, and any ledger move must degrade the
// round to the live derive (never a partial splice, never a guess).
//
// Gate discipline (#3617): every positive case has its negative twin.
process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "shadow";

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-5874-lane-")), "no-config.json");
process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";

import type { BiliMessage } from "acp-kernel/wire";
import type { CoreMessage } from "acp-kernel";
import { maybeSnapshotView } from "../src/server/snapshot-render.ts";
import { _resetStoreForTest } from "../src/persist.ts";
import { _setStoreForTest } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import {
    planIngest,
    type LegacySessionLike,
} from "../src/storage/ingest.js";
import { UnifiedStore } from "../src/storage/store.js";
import { openSqliteDatabase, type SqliteDatabase } from "../src/storage/driver.js";

function msg(id: string, text: string, role: BiliMessage["role"] = "user"): BiliMessage {
    return { id, role, contentType: "text", text } as BiliMessage;
}

function plainSession(n: number): LegacySessionLike {
    const lastMessages: CoreMessage[] = [];
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    for (let i = 1; i <= n; i++) {
        const id = `m${i}`;
        lastMessages.push({ id, role: i % 2 === 1 ? "user" : "assistant", text: `text ${i}`, contentType: "text" } as CoreMessage);
        byRaw[id] = String(1000 + i);
        byRef[String(1000 + i)] = id;
    }
    return {
        id: "sess-es",
        createdAt: 1000,
        lastSeen: 2000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw, byRef } },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: true,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

/** Production fold shape: every original stays in the log, the summary
 *  lands under a NEW id (m7). */
function foldedSession(covered: string[]): LegacySessionLike {
    const base = plainSession(6);
    const blk = {
        blockId: "blk-f1",
        runId: "run-f1",
        createdAt: 2000,
        tier: 1,
        active: true,
        summary: "summary f1",
        effectiveMessageIds: covered,
        directBlockIds: [],
        compressedTokens: covered.length * 10,
        survivedCount: 6 - covered.length,
        generation: "young",
    };
    base.state.blocks = [blk as never];
    base.state.nextBlockId = 2;
    base.lastMessages = [...(base.lastMessages ?? []), { id: "m7", role: "assistant", text: "summary f1", contentType: "text" } as CoreMessage];
    (base.state.messageRefs as { byRaw: Record<string, string>; byRef: Record<string, string> }).byRaw["m7"] = "1007";
    (base.state.messageRefs as { byRaw: Record<string, string>; byRef: Record<string, string> }).byRef["1007"] = "m7";
    return base;
}

/** The client's re-sent history for the folded session: originals + summary. */
const CLIENT: BiliMessage[] = [
    msg("m1", "text 1", "user"),
    msg("m2", "text 2", "assistant"),
    msg("m3", "text 3", "user"),
    msg("m4", "text 4", "assistant"),
    msg("m5", "text 5", "user"),
    msg("m6", "text 6", "assistant"),
    msg("m7", "summary f1", "assistant"),
];

function makeSession(): Session {
    return {
        id: "sess-es",
        state: {
            blocks: [{
                blockId: "blk-f1",
                active: true,
                effectiveMessageIds: ["m5", "m6"],
            }],
        },
        metadata: {},
    } as unknown as Session;
}

function setup() {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-5874-lane-"));
    const dbPath = path.join(dir, "store.db");
    const store = UnifiedStore.open(dbPath);
    assert.ok(store.ingestSession(planIngest(plainSession(6))), "seed");
    assert.ok(store.ingestSession(planIngest(foldedSession(["m5", "m6"])), undefined, { completeLog: true }), "fold");

    // A persist-shaped facade over the real store (the D-lane reads the
    // persist wrapper's unified* names) with counters baked in: proves the
    // warm turn actually took the cache path (egressReadView consulted) and
    // that the content load skipped the cached prefix (the intervals passed
    // to unifiedUncoveredRows).
    let reads = 0;
    const uncoveredIntervals: number[][][] = [];
    const facade = {
        unifiedMessageIdRows: (sid: string) => store.messageIdRows(sid),
        unifiedTailSeqs: (sid: string) => store.tailSeqs(sid),
        unifiedTailViewRows: (sid: string) => store.getMessages(sid),
        unifiedUncoveredRows: (sid: string, intervals: readonly [number, number][]) => {
            uncoveredIntervals.push(intervals.map(([a, b]) => [a, b]));
            return store.uncoveredRows(sid, intervals);
        },
        egressReadView: (sid: string) => { reads++; return store.egressReadView(sid); },
        egressCut: (sid: string, ids: string[], prefixJson: string | undefined, nowMs: number) => store.egressCut(sid, ids, prefixJson, nowMs),
        closeQuietly: () => { /* facade: real store closed by the test */ },
    } as unknown as Parameters<typeof _setStoreForTest>[0];
    _setStoreForTest(facade);
    return { dir, dbPath, store, raw: () => openSqliteDatabase(dbPath).db as unknown as SqliteDatabase, reads: () => reads, uncovered: () => uncoveredIntervals };
}

test("#5874-v2 L1: warm render is byte-identical to the cold derive and skips the cached prefix (+/-)", () => {
    const h = setup();
    try {
        // Cold turn: no cache row yet — the full live derive.
        assert.equal(h.store.egressReadView("sess-es"), null, "no cache row before the first render");
        const cold = maybeSnapshotView(makeSession(), CLIENT, { sessionId: "sess-es" });
        const coldReads = h.reads();
        assert.ok(coldReads >= 1, "cold turn consults the cache");

        // The cold render's cut materialized the stable prefix.
        const row = h.store.egressReadView("sess-es");
        assert.ok(row, "cold render cut a cache row");

        // Warm turn: the SAME client bytes must render byte-identically —
        // with the content load provably skipping the cached prefix.
        const coldIntervals = h.uncovered().length;
        const warm = maybeSnapshotView(makeSession(), CLIENT, { sessionId: "sess-es" });
        const warmIntervals = h.uncovered();
        assert.equal(warmIntervals.length, coldIntervals + 1, "one content-load pass on the warm turn");
        assert.deepEqual(JSON.stringify(warm), JSON.stringify(cold), "warm ≡ cold, byte for byte");
        const last = warmIntervals[warmIntervals.length - 1];
        assert.ok(last.length > 0 && last[0][0] === 0, "content load now starts by skipping from seq 0 (cached prefix)");
        const prefixIds = (JSON.parse(row.prefix) as Array<{ msgId: string }>).map((r) => r.msgId);
        assert.ok(prefixIds.includes("m1") && prefixIds.includes("m4"), "cached prefix spans the stable region below the fold");
        // The anchor still renders (covered suppression is untouched by the cache).
        const ids = warm.map((m) => m.id);
        assert.ok(ids.includes("acp_summary_blk-f1"), "anchor renders on the warm turn");
        assert.ok(!ids.includes("m5") && !ids.includes("m6"), "covered rows stay suppressed on the warm turn");
    } finally {
        h.store.close();
        rmSync(h.dir, { recursive: true, force: true });
        _resetStoreForTest();
    }
});

test("#5874-v2 L2: a same-id content move degrades the round to the live derive (+/-)", () => {
    const h = setup();
    try {
        const cold = maybeSnapshotView(makeSession(), CLIENT, { sessionId: "sess-es" });
        const armed = h.store.egressReadView("sess-es");
        assert.ok(armed, "cache armed by the cold turn");
        const warm = maybeSnapshotView(makeSession(), CLIENT, { sessionId: "sess-es" });
        assert.deepEqual(JSON.stringify(warm), JSON.stringify(cold), "baseline: warm ≡ cold");

        // The ledger moves: m2 gains a new generation (a same-id rewrite
        // through the real ingest path). The id-bound hash re-derive inside
        // egressReadView must catch it: the next round derives live and the
        // revised bytes render.
        const revised = plainSession(6);
        (revised.lastMessages as unknown as Array<{ id: string; text: string }>).find((m) => m.id === "m2")!.text = "text 2 REVISED";
        revised.lastMessages = [...(revised.lastMessages ?? []), { id: "m7", role: "assistant", text: "summary f1", contentType: "text" } as CoreMessage];
        assert.ok(h.store.ingestSession(planIngest(revised), undefined, { completeLog: true }), "rewrite m2");
        assert.equal(h.store.egressReadView("sess-es"), null, "hash move ⇒ the cache row is rejected");

        const client2 = CLIENT.map((m) => m.id === "m2" ? msg("m2", "text 2 REVISED", "assistant") : m);
        const coldPath = maybeSnapshotView(makeSession(), client2, { sessionId: "sess-es" });
        // The render itself: the engine re-derived live (the session object
        // carries the render latch, not a degrade marker).
        assert.ok(coldPath.some((m) => m.id === "m2" && m.text === "text 2 REVISED"), "revised bytes ride the outbound");
        assert.ok(coldPath.some((m) => m.id === "acp_summary_blk-f1"), "anchor still renders");
        // And the cut re-materialized the new stable prefix.
        const recut = h.store.egressReadView("sess-es");
        assert.ok(recut, "re-cut after the degrade");
        assert.notEqual(recut.inputHash, armed.inputHash, "re-cut aggregate reflects the moved ledger");
    } finally {
        h.store.close();
        rmSync(h.dir, { recursive: true, force: true });
        _resetStoreForTest();
    }
});

test("#5874-v2 L3: a cached row the ledger no longer carries degrades the splice (+/-)", () => {
    const h = setup();
    try {
        maybeSnapshotView(makeSession(), CLIENT, { sessionId: "sess-es" });
        const row = h.store.egressReadView("sess-es");
        assert.ok(row, "cache armed");

        // (±) Server canonical first: the client alone cannot delete a LIVE
        // message. Dropping m4 from the re-sent history does NOT remove it
        // from the server-rendered prefix — the ledger is the identity
        // source of truth, and the cache is happily serving it.
        const clientNoM4 = CLIENT.filter((m) => m.id !== "m4");
        const serverAuthSession = makeSession();
        const serverAuth = maybeSnapshotView(serverAuthSession, clientNoM4, { sessionId: "sess-es" });
        assert.ok(serverAuth.some((m) => m.id === "m4"), "live m4 still renders on the server canonical prefix");
        assert.equal(serverAuthSession.metadata["snapshotRenderDegradeReason"], undefined, "a head edit alone is not a degrade");

        // The real rewind: the ingest completeLog sweep retires m4 (the
        // client no longer carries it). The store's id-bound hash is
        // retirement-stable ⇒ the store STILL HITS — the reject must happen
        // at the lane splice's row-liveness check, which cannot bind m4's
        // dead seq. The engine re-derives live (full content load, no
        // [0, …] skip), renders the post-rewind ledger, and the cut
        // self-heals the cache row to the post-edit ledger.
        const rewound = foldedSession(["m5", "m6"]);
        (rewound.lastMessages as unknown as Array<{ id: string }>).splice(3, 1); // drop m4
        const refs = rewound.state.messageRefs as { byRaw: Record<string, string>; byRef: Record<string, string> };
        delete refs.byRaw["m4"];
        delete refs.byRef["1004"];
        assert.ok(h.store.ingestSession(planIngest(rewound), undefined, { completeLog: true }), "rewind ingest");
        assert.ok(h.store.egressReadView("sess-es"), "store hit survives the retirement (id-bound hash)");

        const before = h.uncovered().length;
        const rejectSession = makeSession();
        const rejectView = maybeSnapshotView(rejectSession, clientNoM4, { sessionId: "sess-es" });
        const rejectIds = rejectView.map((m) => m.id);
        assert.ok(!rejectIds.includes("m4"), "retired m4 does not render");
        assert.ok(rejectIds.includes("m1"), "prefix below the join still renders");
        assert.ok(rejectIds.includes("acp_summary_blk-f1"), "anchor still renders");
        assert.equal(rejectSession.metadata["snapshotRenderDegradeReason"], undefined, "splice reject is not a lane degrade — live derive serves");
        // The splice rejected: the reject turn's content load did NOT skip
        // the cached prefix (no [0, …]-into-stable-region interval).
        const rejectIntervals = h.uncovered().slice(before);
        for (const iv of rejectIntervals) {
            assert.ok(iv.length === 0 || iv[0][0] !== 0 || iv.reduce((m, r) => Math.max(m, r[1]), -1) < 5, "cached prefix was NOT spliced on the reject turn");
        }
        // The cut self-healed: the fresh cache row no longer carries m4.
        const healed = h.store.egressReadView("sess-es");
        assert.ok(healed);
        const healedIds = (JSON.parse(healed.prefix) as Array<{ msgId: string }>).map((r) => r.msgId);
        assert.ok(!healedIds.includes("m4"), "self-healed cache row drops m4");
    } finally {
        h.store.close();
        rmSync(h.dir, { recursive: true, force: true });
        _resetStoreForTest();
    }
});
