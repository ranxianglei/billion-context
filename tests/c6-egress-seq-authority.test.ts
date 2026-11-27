/** C6 (PR #7684): the egress flow is the SEQ authority for egress-on
 *  sessions — every message's ledgerSeq and every block's coordinate pair is
 *  the egress_flow.log_seq number, not a look-up into the frozen legacy
 *  `messages` table.
 *
 *  Pre-fix, an egress-on session's block coordinates resolved through
 *  `SELECT msg_id, seq FROM messages …` (store.ts boundsForCovered) — a
 *  projection FROZEN at the arm turn (#7474 P2, ruling 7439) — so blocks
 *  folded AFTER arming bound to the stale frozen-table space (or [-1,-1]
 *  no-claim when their ids never landed there), and seq-based coverage in
 *  the kernel (prune / sync / fold recording) silently did nothing for
 *  exactly the sessions the egress plane exists for.
 *
 *  Pinned here (harness pattern: tests/identity-consolidate-e2e.test.ts):
 *   A. live egress-on (plane ON): the kernel-input cores carry
 *      ledgerSeq = flow num (the renumbered citation space — the system
 *      row holds 0, the first real message 1), so a REAL
 *      kernel fold ATTESTS its interval [10,40] in flow number space; the
 *      stamped cores are per-turn views only — the bytes recorded into the
 *      flow carry no ledgerSeq (the identity hash already stripped it).
 *   B. rollback re-ingest (plane OFF, arm marker still saved): unified
 *      ingest runs again and the store binds block coordinates from the
 *      flow (live ids → their flow numbers) or from the block's own
 *      kernel attestation (covered ids already gone from the live view —
 *      only the attestation knows the interval; pre-fix: [-1,-1]).
 *   C. buildEgressViewRows strips ledgerSeq (unit).
 *   D. the incremental tail pin maps at WIRE-ELEMENT granularity again:
 *      a split element (several cores, #pN siblings) counts as ONE
 *      element — the agentic shape that is normal traffic.
 */
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
// #7735: this file audits the legacy tables (rollback re-ingest) — force the full DDL so the
// legacy tables exist beside the egress tables (a plain fresh eg instance has 7 tables only).
process.env.BILI_TEST_FORCE_FULL_DDL = "1";
process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY = "1";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const hermetic = mkdtempSync(join(tmpdir(), "c6-seq-hermetic-"));
process.env.BILI_CONFIG_FILE = join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "full";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import type { BiliMessage } from "acp-kernel/wire";
import { recordEgressTurn, buildEgressViewRows } from "../src/storage/egress-record.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { egressStateView } from "../src/storage/egress-state.ts";
import { stampEgressSeqs } from "../src/server/egress-lane-io.ts";
import { tryIncrementalPin } from "../src/snapshot/stage0.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void };
type Db = ReturnType<typeof openSqliteDatabase>["db"];
type SessionStoreType = InstanceType<typeof SessionStore>;

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

// fold m00010..m00040 (refs) = raw9..raw39 → flow nums 10..40 (the
// renumbered citation space: system row = 0, raw0 = 1).
const SPEC = () => parseCompressInput({ content: [{ startId: "m00010", endId: "m00040", summary: "the thirty-one folded messages agree to refactor the cache layer" }] });

function makeCtx(sessionId: string, messages: CoreMessage[] = MESSAGES): Ctx {
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
        messages: [...messages],
        session,
        log: (_m: string) => undefined,
    } as Ctx;
    ctx.session.state.messageRefs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return ctx;
}

function persistable(ctx: Ctx, messages: CoreMessage[]): never {
    return {
        ...ctx.session,
        lastMessages: messages as never,
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    } as never;
}

function openStore(dir: string): SessionStoreType {
    const s = new SessionStore({ enabled: true, dir, debounceMs: 60000 });
    _setStoreForTest(s);
    return s;
}

function closeStore(store: SessionStoreType, dir: string, db: Db | null): void {
    _resetStoreForTest();
    store.closeQuietly();
    db?.close();
    try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        // transient EBUSY on Windows — the dir is in the OS tmpdir.
    }
}

/** A kernel-shaped compression block (only the fields the save/ingest seam reads). */
const mkBlock = (blockId: string, startSeq: number, endSeq: number, eff: string[]): never =>
    ({
        blockId,
        runId: `run-${blockId}`,
        tier: 1,
        summary: `summary ${blockId}`,
        directMessageIds: eff,
        effectiveMessageIds: eff,
        directBlockIds: [],
        compressedTokens: 10,
        createdAt: 1_700_000_000,
        survivedCount: 0,
        generation: "young",
        active: true,
        startSeq,
        endSeq,
    }) as never;

const bm = (id: string, extra: Record<string, unknown> = {}): BiliMessage =>
    ({ id, role: "user", content: [{ type: "text", text: id }], ...extra }) as unknown as BiliMessage;

test("A: live egress-on — kernel input carries flow numbers and a REAL fold attests [10,40] in that space", async () => {
    const dir = mkdtempSync(join(tmpdir(), "c6-seq-"));
    const store = openStore(dir);
    let db: Db | null = null;
    const vd = () => { if (db === null) db = openSqliteDatabase(join(dir, "index.db")).db; return db; };
    try {
        const sid = "c6-live";
        const ctx = makeCtx(sid);
        ctx.session.metadata["egressAuthority"] = true;
        const ustore = () => store.egressOpLogStore();

        const row1 = recordEgressTurn({ store: ustore()!, sessionId: sid, prev: undefined, conversation: ctx.messages, systemText: "sys", nowMs: 1_000_000 });
        assert.equal(row1.length, 81, "system + 80");
        await store.writeNow(persistable(ctx, ctx.messages));

        // --- (1) the stamp: ledgerSeq = flow num (system row = 0)
        const stamped = stampEgressSeqs(ustore()!, sid, ctx.messages) as BiliMessage[];
        assert.equal(stamped[0]!.ledgerSeq, 1, "raw0 is flow num 1 (the system row is num 0)");
        assert.equal(stamped[9]!.ledgerSeq, 10, "raw9 (ref m00010) is flow num 10");
        assert.equal(stamped[39]!.ledgerSeq, 40);
        assert.equal(ctx.messages[0]!.ledgerSeq, undefined, "source cores are never stamped in place");
        const twice = stampEgressSeqs(ustore()!, sid, stamped) as BiliMessage[];
        assert.equal(twice, stamped, "a no-op re-stamp returns the same array (reference contract)");

        // --- (2) the REAL fold attests its interval in FLOW number space
        ctx.messages = stamped as unknown as CoreMessage[];
        const res = applyRanges(SPEC(), ctx);
        assert.equal(res.outcome, "applied", `real fold expected, got: ${(res.text ?? "").slice(0, 200)}`);
        const folded = ctx.core.processTurn({
            messages: ctx.messages,
            state: ctx.session.state,
            config: ctx.config,
            tokenCount: 6000,
            tokenCountSource: "usage",
        }).messages;
        assert.equal(folded.length, 50, "80 - 31 + 1 summary");
        const blk = (ctx.session.state.blocks as { active?: boolean; startSeq?: number; endSeq?: number }[]).filter((b) => b.active)[0];
        assert.ok(blk, "an active block exists after the fold");
        assert.equal(blk.startSeq, 10, "block startSeq = flow num of raw9 (m00010)");
        assert.equal(blk.endSeq, 40, "block endSeq = flow num of raw39 (m00040)");

        // --- (3) the flow bytes never carry a stamp
        const row2 = recordEgressTurn({ store: ustore()!, sessionId: sid, prev: row1, conversation: folded, systemText: "sys", nowMs: 1_005_000 });
        assert.equal(row2.length, 51, "system + 50 folded");
        const view = egressStateView(vd(), sid);
        const firstRow = view.find((r) => r.msgid === "raw0");
        assert.ok(firstRow, "raw0 row exists in the flow view");
        assert.doesNotMatch((firstRow as { bytes?: string }).bytes ?? "", /ledgerSeq/, "recorded row bytes contain no ledgerSeq");
    } finally {
        closeStore(store, dir, db);
    }
});

test("B: rollback re-ingest (plane OFF) — block coordinates bind to the flow, and a kernel-attested block beats a vanished look-up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "c6-seq-"));
    const store = openStore(dir);
    let db: Db | null = null;
    const vd = () => { if (db === null) db = openSqliteDatabase(join(dir, "index.db")).db; return db; };
    const prevFlag = process.env.BILI_ROLLOUT_EGRESS_PLANE;
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "0"; // rollback phase: unified ingest runs
    try {
        const sid = "c6-rollback";
        const cores = [bm("c6-b1"), bm("c6-b2"), bm("c6-b3"), bm("c6-b4")];
        const ctx = makeCtx(sid, cores as unknown as CoreMessage[]);
        const ustore = () => store.egressOpLogStore();

        // pre-arm: a plain legacy session with a folded block covering
        // b1..b2 — the table space is still the source (b1=seq 0, b2=seq 1).
        const rowPre = recordEgressTurn({ store: ustore()!, sessionId: sid, prev: undefined, conversation: cores, systemText: "sys", nowMs: 1_000_000 });
        ctx.session.state.blocks = [mkBlock("b-pre", 0, 1, ["c6-b1", "c6-b2"])];
        await store.writeNow(persistable(ctx, ctx.messages));
        let pre = vd().prepare("SELECT start_seq, end_seq FROM blocks WHERE session_id = ? AND block_id = ?").get(sid, "b-pre") as { start_seq: number; end_seq: number } | undefined;
        if (!pre) throw new Error("b-pre not ingested");
        assert.deepEqual([pre.start_seq, pre.end_seq], [0, 1], "pre-arm: the frozen-table space (b1=seq 0, b2=seq 1)");

        // the plane arms (marker saved) + one more live turn (flow grows:
        // system=0, b1..b5 = 1..5) → rollback re-ingest binds from the FLOW
        ctx.session.metadata["egressAuthority"] = true;
        const c5 = bm("c6-b5");
        ctx.messages = [...ctx.messages, c5];
        recordEgressTurn({ store: ustore()!, sessionId: sid, prev: rowPre, conversation: ctx.messages, systemText: "sys", nowMs: 1_005_000 });
        await store.writeNow(persistable(ctx, ctx.messages));
        pre = vd().prepare("SELECT start_seq, end_seq FROM blocks WHERE session_id = ? AND block_id = ?").get(sid, "b-pre") as { start_seq: number; end_seq: number };
        assert.deepEqual([pre.start_seq, pre.end_seq], [1, 2], "arm marker present: coordinates rebind to the FLOW numbers b1=1, b2=2 (pre-fix: frozen-table 0..1)");

        // a kernel-attested block whose covered ids are GONE from the live
        // view and from the projection: only the attestation knows.
        const ctx2 = makeCtx(sid, [bm("c6-x1"), bm("c6-x2")] as unknown as CoreMessage[]);
        ctx2.session.metadata["egressAuthority"] = true;
        ctx2.session.state.blocks = [mkBlock("b-folded", 11, 41, ["gone-1", "gone-2"])];
        await store.writeNow(persistable(ctx2, ctx2.messages));
        const fRow = vd().prepare("SELECT start_seq, end_seq FROM blocks WHERE session_id = ? AND block_id = ?").get(sid, "b-folded") as { start_seq: number; end_seq: number } | undefined;
        if (!fRow) throw new Error("b-folded not ingested");
        assert.deepEqual([fRow.start_seq, fRow.end_seq], [11, 41], "the kernel attested interval wins over a vanished-id look-up (pre-fix: [-1,-1] no-claim)");
    } finally {
        process.env.BILI_ROLLOUT_EGRESS_PLANE = prevFlag ?? "1";
        closeStore(store, dir, db);
    }
});

test("C: buildEgressViewRows strips ledgerSeq — the stamp never lands in the flow", () => {
    const withStamp = [
        { ...bm("w1"), ledgerSeq: 42 },
        bm("w2"),
    ];
    const rows = buildEgressViewRows(withStamp, "c6-sys");
    const w1 = rows.find((r) => r.msgid === "w1")!;
    assert.doesNotMatch(w1.bytes, /ledgerSeq/, "the stamped core's recorded bytes carry no ledgerSeq");
    assert.ok(w1.bytes.includes("w1"));
});

test("D: the incremental tail pin maps at wire-element granularity (split cores count once)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "c6-seq-"));
    const store = openStore(dir);
    const log: string[] = [];
    try {
        const sid = "c6-pins";
        const asst = (id: string, text: string, contentType: string, wireIndex: number, extra: Record<string, unknown> = {}): BiliMessage =>
            bm(id, { role: "assistant", originalRole: "assistant", contentType, wireIndex, ...extra });
        // steady-state flow: prefix u0 + a SPLIT element (assistant text +
        // tool call = 2 cores: a1, a1#p1)
        const prefix = [
            bm("u0", { wireIndex: 0 }),
            asst("a1", "t", "text", 1),
            asst("a1#p1", "", "tool-call", 1, { toolName: "t", toolArgs: "{}" }),
        ];
        recordEgressTurn({ store: store.egressOpLogStore()!, sessionId: sid, prev: undefined, conversation: prefix, systemText: "sys", nowMs: 1_000_000 });
        const liveIds = store.snapPinLiveIds(sid);
        // #7836 Path A: the op-log stores a message's parts under ONE element
        // msgid (both parts of a1 are "a1" — no #pN in the log). Pin consumers
        // fold the run to elements (wireElementIds) and re-derive #pN
        // (tryIncrementalPin); the kernel keeps per-core uniqueness.
        assert.deepEqual(liveIds, ["u0", "a1", "a1"], "flow msgids in order, split parts sharing the element msgid (Path A; system row filtered)");

        const nextTurn = (): BiliMessage[] => [
            bm("u0", { wireIndex: 0 }),
            asst("a1", "t", "text", 1),
            asst("a1#p1", "", "tool-call", 1, { toolName: "t", toolArgs: "{}" }),
            bm("u2-0", { role: "tool", originalRole: "tool", wireIndex: 2, contentType: "tool-result", toolName: "t", toolResultText: "ok" }),
            bm("u2-1", { wireIndex: 2 }),
        ];
        // the host stamps per WIRE ELEMENT: anchor a1 + new element u2
        const pin = tryIncrementalPin(sid, "openai", nextTurn(), ["a1", "u2"], (m) => log.push(String(m)));
        assert.ok(pin, "the split steady-state pin succeeds (pre-fix: L < n+1 → degrade to full signal)");
        assert.deepEqual(
            (pin as BiliMessage[]).map((m) => m.id),
            ["u0", "a1", "a1#p1", "u2", "u2#p1"],
            "prefix raw (siblings included), new element leader u2 + derived sibling u2#p1",
        );
        // a wrong anchor still degrades (never rejects)
        const pinBad = tryIncrementalPin(sid, "openai", nextTurn(), ["WRONG", "u2"], (m) => log.push(String(m)));
        assert.equal(pinBad, null, "anchor mismatch degrades (returns null), never rejects");
        // 1:1 sessions keep the legacy per-core mapping (fresh 1:1 ledger)
        const sid2 = "c6-pins-1to1";
        recordEgressTurn({ store: store.egressOpLogStore()!, sessionId: sid2, prev: undefined, conversation: [bm("u0", { wireIndex: 0 }), asst("a1", "t", "text", 1)], systemText: "sys", nowMs: 1_000_000 });
        const p1 = tryIncrementalPin(sid2, "openai", [bm("u0", { wireIndex: 0 }), asst("a1", "t", "text", 1), bm("u2", { wireIndex: 2 })], ["a1", "u2"], (m) => log.push(String(m)));
        assert.ok(p1, "1:1 per-core pin still works");
        assert.deepEqual((p1 as BiliMessage[]).map((m) => m.id), ["u0", "a1", "u2"]);
        // the ledger grew with a 1:1 element z1 → the client's STALE anchor
        // (a1) no longer sits at the overlap position → degrade, never mis-map
        const rowD1 = recordEgressTurn({ store: store.egressOpLogStore()!, sessionId: sid, prev: undefined, conversation: [
            bm("u0", { wireIndex: 0 }),
            asst("a1", "t", "text", 1),
            asst("a1#p1", "", "tool-call", 1, { toolName: "t", toolArgs: "{}" }),
            bm("z1", { wireIndex: 2 }),
        ], systemText: "sys", nowMs: 1_005_000 });
        void rowD1;
        const stale = tryIncrementalPin(sid, "openai", [
            bm("u0", { wireIndex: 0 }),
            asst("a1", "t", "text", 1),
            asst("a1#p1", "", "tool-call", 1, { toolName: "t", toolArgs: "{}" }),
            bm("z1", { wireIndex: 2 }),
            bm("u2-0", { role: "tool", originalRole: "tool", wireIndex: 3, contentType: "tool-result", toolName: "t", toolResultText: "ok" }),
            bm("u2-1", { wireIndex: 3 }),
        ], ["a1", "u2"], (m) => log.push(String(m)));
        assert.equal(stale, null, "a stale anchor degrades to the full signal (returns null)");
        // and the FRESH anchor for the same turn pins again
        const fresh = tryIncrementalPin(sid, "openai", [
            bm("u0", { wireIndex: 0 }),
            asst("a1", "t", "text", 1),
            asst("a1#p1", "", "tool-call", 1, { toolName: "t", toolArgs: "{}" }),
            bm("z1", { wireIndex: 2 }),
            bm("u2-0", { role: "tool", originalRole: "tool", wireIndex: 3, contentType: "tool-result", toolName: "t", toolResultText: "ok" }),
            bm("u2-1", { wireIndex: 3 }),
        ], ["z1", "u2"], (m) => log.push(String(m)));
        assert.ok(fresh, "the fresh anchor pins");
        assert.deepEqual(
            (fresh as BiliMessage[]).map((m) => m.id),
            ["u0", "a1", "a1#p1", "z1", "u2", "u2#p1"],
            "the grown prefix maps raw, the new split element leader + sibling",
        );
    } finally {
        closeStore(store, dir, null);
    }
});
