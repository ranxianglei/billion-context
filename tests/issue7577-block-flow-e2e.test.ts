/**
 * #7577 dual-clock E2E: a REAL fold (production applyRanges machinery, on an
 * isolated DB) driven through the production seams — recordEgressTurn at
 * prepare, store.writeNow (the block recorder lives inside ingestSession) at
 * save — then a restart and point forks. This is the sequence the unit tests
 * never reproduced, and the one the shared-clock design broke:
 *
 *   turn 1  message ops            (I×n)
 *   turn 2  fold: D×n + I summary, then SAVE writes the block I row
 *   turn 3  message ops again
 *
 * Under the old shared op_seq pool the turn-3 append started two op_seqs
 * past the last flow row; every egress read afterwards threw
 * "op_seq jumps from X to Y" and walk-back recovery truncated each turn's
 * own row. Pinned here:
 *   1. the flow stays DENSE (op_seq strictly +1) across the interleaving —
 *      applied on the raw rows, not just "the view did not throw";
 *   2. egressStateView/egressStateAt never throw after the fold — at the
 *      original freeze point (turn 3) and after a full RESTART;
 *   3. the block row carries the flow_op_seq pointer (== the fold's own
 *      compaction-base point) and its snapshot is self-contained: one/full
 *      keep the covered ORIGINALS while the SUMMARY text lives in the flow
 *      (the designed split); the fold's OWN coordinates are honestly NULL
 *      (snapEgressPinLiveIds resolves against the LIVE view, and this block's
 *      covered rows were D'd from it by the same turn's ops before the save);
 *   4. after restart: the view is byte-equal, tsStamps derive, and the block
 *      table replays to the live block set;
 *   5. fork-to-now copies all four tables (row counts + byte-equal views);
 *      the flow is append-only (7773: no compaction base rows — the fold's
 *      D batch is the only record of the fold), so a point fork BELOW the
 *      fold's flow watermark reconstructs the EXACT pre-fold view from the
 *      retained rows (pinned), while a point fork AT the block's pointer
 *      yields the folded view plus the block, and the fork-to-now child has
 *      one more row — the point is real.
 */

process.env.BILI_PERSIST_ZSTD = "0";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const hermetic = mkdtempSync(join(tmpdir(), "bili-egress-block-e2e-hermetic-"));
process.env.BILI_CONFIG_FILE = join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_ROLLOUT_EGRESS_PLANE = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { createSession } from "../src/session.ts";
import { recordEgressTurn } from "../src/storage/egress-record.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { egressStateView, egressStateAt } from "../src/storage/egress-state.ts";
import { egressBlockReplay } from "../src/storage/egress-block.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void };

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

// fold m00010..m00040 (refs) = raw9..raw39 → 31 messages collapse into the
// summary; raw0..raw8 + summary + raw40..raw79 remain (50 messages).
const SPEC = () => parseCompressInput({ content: [{ startId: "m00010", endId: "m00040", summary: "the thirty-one folded messages agree to refactor the cache layer" }] });

function makeCtx(sessionId: string): Ctx {
    const session = {
        id: sessionId,
        meta: { protocol: "anthropic" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {} as Record<string, unknown>,
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
    const ctx = {
        core: createCore(),
        config: defaultConfig(200000, { preserveRecentMessages: 5, preserveRecentTokens: 0 }),
        messages: [...MESSAGES],
        session,
        log: (_m: string) => undefined,
    } as Ctx;
    ctx.session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return ctx;
}

/** The session record shape SessionStore.writeNow ingests (same adaptation
 *  the #3982 compress-from-store tests use; lastMessages = the message log).
 */
function persistable(session: Ctx["session"], messages: CoreMessage[]): never {
    return {
        ...session,
        lastMessages: messages as never,
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    } as never;
}

const VIEW_KEY = (rows: { msgid: string; bytes: unknown }[]) => rows.map((r) => [r.msgid, r.bytes]);

test("dual-clock e2e: real fold on an isolated DB survives save, restart, and point forks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-egress-block-e2e-"));
    let store = new SessionStore({ enabled: true, dir, debounceMs: 60000 });
    _setStoreForTest(store);
    assert.ok(await store.waitForReplicas(5000), "unified store ready");
    /** the read-only verification handle; index.db exists once the unified
     *  store is open (opened straight-line so the finally-close typechecks). */
    const dbv = openSqliteDatabase(join(dir, "index.db")).db;
    try {
        const sid = "sess-dualclock-e2e";
        const ctx = makeCtx(sid);
        ctx.session.metadata["egressAuthority"] = true;
        const ustore = () => store.egressOpLogStore();
        assert.ok(ustore(), "unified store reachable");

        // ---------------- turn 1: plain messages ---------------------------
        const row1 = recordEgressTurn({ store: ustore()!, sessionId: sid, prev: undefined, conversation: ctx.messages, systemText: "sys", nowMs: 1_000_000 });
        assert.equal(row1.length, 81, "system row + 80 messages");
        await store.writeNow(persistable(ctx.session, ctx.messages));
        const wm1 = ustore()!.egressStateMaxSeq(sid);
        assert.equal(wm1, 81);

        // ---------------- turn 2: the REAL fold ----------------------------
        const res = applyRanges(SPEC(), ctx);
        assert.equal(res.outcome, "applied", `real fold expected, got: ${(res.text ?? "").slice(0, 200)}`);
        // materialize the folded conversation exactly like production does:
        // applyRanges only commits state — the NEXT prepare's core.processTurn
        // folds the state into the outbound view (prepare-openai.ts:516).
        const folded = ctx.core.processTurn({
            messages: ctx.messages,
            state: ctx.session.state,
            config: ctx.config,
            tokenCount: 6000,
            tokenCountSource: "usage",
        }).messages;
        assert.equal(folded.length, 50, "80 - 31 + 1 summary");
        const activeBlocks = ctx.session.state.blocks.filter((b) => b.active);
        assert.equal(activeBlocks.length, 1, "one block landed");
        const blk = activeBlocks[0]!;

        const row2 = recordEgressTurn({ store: ustore()!, sessionId: sid, prev: row1, conversation: folded, systemText: "sys", nowMs: 1_005_000 });
        assert.equal(row2.length, 51, "system row + 50 folded messages");
        // SAVE after the fold — the production interleaving: the block I row
        // lands in eg_block_flow AFTER this turn's message ops.
        await store.writeNow(persistable(ctx.session, folded));

        // the block row exists with the REAL kernel snapshot
        const bview = ustore()!.egressBlockView(sid);
        assert.equal(bview.size, 1, "the recorder recorded the fold's block");
        const bsnap = bview.get(blk.blockId)!;
        assert.ok(bsnap, "block keyed by its id");
        assert.equal(bsnap.active, true);
        assert.equal(bsnap.reaped, false);
        // Coordinate semantics, pinned to the REAL production behavior:
        // startMsgid/endMsgid resolve against the egress LIVE view at save
        // time (snapEgressPinLiveIds) — but this block's covered rows were D'd
        // from that view by THIS turn's ops before the save runs, so a fold's
        // OWN block coordinates are honestly NULL. The self-contained content
        // guarantee (#7439-2) is the one/full payload, not the coordinates.
        assert.equal(bsnap.startMsgid, null, "fold's own block: covered rows already left the live view");
        assert.equal(bsnap.endMsgid, null);
        // one/full carry the covered ORIGINALS (collectBlockContent, cached at
        // applyRanges) — the SUMMARY text itself lives in the FLOW as the
        // summary message. Both sides of that split, asserted on the raw data:
        assert.ok((bsnap.full ?? "").includes("lorem ipsum"), "block table keeps the covered originals");
        assert.ok(row2.some((r) => String(r.bytes).includes("refactor the cache layer")), "flow keeps the summary message");

        // ---------------- turn 3: the message ops AFTER the fold -----------
        // (under the old shared clock, THIS append started two op_seqs past
        // the last flow row and every read from here on threw.)
        const mNext: CoreMessage = { id: "raw80", role: "user", text: "and one more turn" } as CoreMessage;
        ctx.messages = [...folded, mNext];
        const row3 = recordEgressTurn({ store: ustore()!, sessionId: sid, prev: row2, conversation: ctx.messages, systemText: "sys", nowMs: 1_010_000 });
        assert.equal(row3.length, 52);
        await store.writeNow(persistable(ctx.session, ctx.messages));

        // 1. flow density on the RAW rows — strictly +1, no gaps
        const seqs = (dbv.prepare(`SELECT op_seq FROM eg_flow WHERE session_id = ? ORDER BY op_seq`).all(sid) as { op_seq: number }[]).map((r) => r.op_seq);
        assert.ok(seqs.length > 0, "flow rows exist");
        for (let i = 1; i < seqs.length; i++) {
            assert.equal(seqs[i], seqs[i - 1]! + 1, `flow stays dense at op ${seqs[i]} (was: jump from ${seqs[i - 1]})`);
        }
        // 2. readability at the original freeze point
        const view3 = egressStateView(dbv, sid);
        assert.equal(view3.length, 52, "the post-fold view is readable (the original bug froze here)");
        assert.deepEqual(VIEW_KEY(view3), VIEW_KEY(row3), "view equals the recorded turn-3 rows");
        const midSeq = seqs[Math.floor(seqs.length / 2)]!;
        assert.ok(egressStateAt(dbv, sid, midSeq).length > 0, "point-in-time reads work inside the log");

        // 3. the block row's dual-clock fields, on the raw rows
        const ptrRow = dbv.prepare(`SELECT op_seq, flow_op_seq FROM eg_block_flow WHERE session_id = ?`).get(sid) as { op_seq: number; flow_op_seq: number };
        assert.equal(ptrRow.op_seq, 1, "the block table numbers itself (its first and only row is op 1)");
        assert.ok(ptrRow.flow_op_seq <= ustore()!.egressStateMaxSeq(sid), "pointer within the flow's span");
        const statePtr = dbv.prepare(`SELECT op_seq, flow_op_seq FROM eg_block_state WHERE session_id = ?`).get(sid) as { op_seq: number; flow_op_seq: number };
        assert.deepEqual([statePtr.op_seq, statePtr.flow_op_seq], [ptrRow.op_seq, ptrRow.flow_op_seq], "state replica row carries the same clock fields");

        // ---------------- restart: new store over the same DB --------------
        await store.closeQuietly();
        store = new SessionStore({ enabled: true, dir, debounceMs: 60000 });
        _setStoreForTest(store);
        assert.ok(await store.waitForReplicas(5000), "unified store ready after restart");
        const db2 = store.egressOpLogStore()!;
        const reloaded = await store.loadAsync(sid);
        assert.ok(reloaded, "session loads after restart");
        const view4 = egressStateView(dbv, sid);
        assert.deepEqual(VIEW_KEY(view4), VIEW_KEY(row3), "post-restart view is byte-equal (replay works over the interleaved log)");
        const tsStamps = db2.egressTsStamps(sid);
        assert.ok(tsStamps && Object.keys(tsStamps).length >= 52, "tsStamps derive from the log after the trim");
        const replayed = egressBlockReplay(dbv, sid, (dbv.prepare(`SELECT COALESCE(MAX(op_seq), 0) AS mx FROM eg_block_flow WHERE session_id = ?`).get(sid) as { mx: number }).mx);
        assert.equal(replayed.blocks.size, 1, "block table replays to the live set");
        assert.equal(replayed.blocks.get(blk.blockId)?.active, true);

        // ---------------- fork-to-now: all four tables ---------------------
        const parentMax = db2.egressStateMaxSeq(sid);
        const { childId, opSeq } = await store.forkEgressSnapshot(sid);
        assert.equal(opSeq, parentMax);
        const child = await store.loadAsync(childId);
        assert.ok(child, "fork-to-now child loads");
        const childView = egressStateView(dbv, childId);
        assert.deepEqual(VIEW_KEY(childView), VIEW_KEY(row3), "child flow is byte-equal to the parent's");
        assert.equal(db2.egressBlockView(childId).get(blk.blockId)?.active, true, "child inherited the block");
        for (const t of ["eg_flow", "eg_block_flow", "eg_state", "eg_block_state"]) {
            const n = (s: string) => (dbv.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE session_id = ?`).get(s) as { n: number }).n;
            assert.equal(n(childId), n(sid), `${t} row count carried over`);
        }

        // ---------------- point fork: BELOW the fold watermark ------------
        // The flow keeps every row it ever wrote (append-only, 7773), so ANY
        // point below the high water is reconstructable: the fork copies the
        // retained rows and rebuilds the state view by replay.
        // (The admin endpoint still refuses these points with 400 — a
        // conservative gate on the public surface, not a data constraint.)
        assert.ok(ptrRow.flow_op_seq > wm1, "the block row's pointer is past turn 1 (save ran after the fold's own flow ops — 7773 has no compaction base; the pointer is the flow watermark at save time)");
        const floorId = "child-belowbase";
        const floorSession = createSession(floorId);
        floorSession.metadata["egressAuthority"] = true;
        assert.ok(store.flushSync(floorSession), "below-base child session row persisted");
        assert.ok(db2.egressPointForkSession(sid, floorId, wm1), "a point below the newest base is copyable again — the flow keeps its rows (#7439)");
        const floorView = egressStateView(dbv, floorId);
        assert.deepEqual(VIEW_KEY(floorView), VIEW_KEY(row1), "the below-base child rebuilt turn 1's EXACT pre-fold view (81 originals, no summary) from the retained rows");

        // ---------------- point fork: AT the base watermark ----------------
        const foldId = "child-fold";
        const foldSession = createSession(foldId);
        foldSession.metadata["egressAuthority"] = true;
        assert.ok(store.flushSync(foldSession), "fold child session row persisted");
        const foldWm = ptrRow.flow_op_seq; // = baseSeq: the flow point the block row points at
        assert.ok(db2.egressPointForkSession(sid, foldId, foldWm), "point fork at the fold watermark");
        const foldView = egressStateView(dbv, foldId);
        assert.deepEqual(
            foldView.map((r) => r.msgid),
            row2.map((r) => r.msgid),
            "fold child has the FOLDED view (summary in, 31 originals out) — while the fork-to-now child above has 52 rows: the point is real within the retained range",
        );
        const foldBlocks = db2.egressBlockView(foldId);
        assert.equal(foldBlocks.size, 1, "the fold's block IS in scope at its own pointer");
        assert.equal(foldBlocks.get(blk.blockId)?.active, true);
        assert.ok((foldBlocks.get(blk.blockId)?.full ?? "").includes("lorem ipsum"), "forked block keeps its self-contained coverage");

        // the parent is untouched by the forks
        assert.equal(egressStateView(dbv, sid).length, 52);
    } finally {
        await store.closeQuietly();
        dbv.close();
    }
});
