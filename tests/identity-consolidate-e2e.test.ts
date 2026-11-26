/**
 * 身份表收拢 (proposal discussions/7591, PR 7617) — the REAL-flow E2E:
 * an isolated production-shaped DB driven through the production seams,
 * the same way the 7581 dual-clock E2E drives its folds:
 *
 *   runStage0 (the lane's stage-0)  →  SessionStore facade  →  UnifiedStore
 *   recordEgressTurn @ prepare,    writeNow @ save,     real kernel fold,
 *   full process RESTART,          GC + manual archive through the facade.
 *
 * Pinned end-to-end:
 *   A. the legacy path is untouched — a non-egress session still runs the
 *      full l1 ledger path (row created, second turn echoes from it);
 *   B. an egress-on session's stage-0 is STATELESS across a restart —
 *      echo/anchor is replay math against the op log, its positions come
 *      from the message frontier (egressMessageHighWater), and NO l1 row
 *      is ever read or written for it
 *      (its convBound verdict is lane-supplied; the store lookup would
 *      hit the claim row the normal save path writes — which is exactly
 *      why the lane passes the in-memory value);
 *   C. the position frontier is the message frontier, NOT the live-view
 *      length — after a REAL kernel fold the live view is 50 rows while
 *      the frontier is 82. The fold's compaction physically removed the I
 *      rows its base subsumed (#7574), so raw MAX(log_seq) is 0 right
 *      after a fold: the frontier lives in the base payload's highWater,
 *      and the stateless branch must read it through egressMessageHighWater
 *      (the review-critical fix this test pins);
 *   D. the R3 latch lands on the SESSIONS row (no l1 row for the sid),
 *      survives a restart, and the operator clear releases it;
 *   F. double-latched migration state (pre-migration l1 latch +
 *      post-migration sessions latch under one key): reads are latched,
 *      one clear releases BOTH carriers (review M1, real facade);
 *   E. GC: egress-aware freshness skips the idle egress-on session whose
 *      op log is recent (its updated_at is 40 days old — pre-fix it
 *      archived here and lost the op log), the legacy twin archives;
 *      manual archive: egress-on refused, legacy proceeds.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY = "1";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const hermetic = mkdtempSync(join(tmpdir(), "bili-identity-e2e-hermetic-"));
process.env.BILI_CONFIG_FILE = join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "full";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { runStage0 } from "../src/snapshot/stage0.ts";
import { FoundationRejectError } from "../src/snapshot/plane.ts";
import type { BiliMessage } from "acp-kernel/wire";
import { recordEgressTurn } from "../src/storage/egress-record.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { egressStateView } from "../src/storage/egress-state.ts";
import { EGRESS_SYSTEM_MSGID } from "../src/storage/egress-record.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void };

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

// fold m00010..m00040 (refs) = raw9..raw39 → 31 messages collapse into the
// summary; raw0..raw8 + summary + raw40..raw79 remain (50 messages).
const SPEC = () => parseCompressInput({ content: [{ startId: "m00010", endId: "m00040", summary: "the thirty-one folded messages agree to refactor the cache layer" }] });

function makeCtx(sessionId: string, messages: CoreMessage[] = MESSAGES): Ctx {
    const session = {
        id: sessionId,
        meta: { protocol: "anthropic" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, rangeRestores: 0 },
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

/** The session record shape SessionStore.writeNow ingests (same adaptation
 *  the #3982/#7577 tests use; lastMessages = the message log). */
function persistable(ctx: Ctx, messages: CoreMessage[]): never {
    return {
        ...ctx.session,
        lastMessages: messages as never,
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    } as never;
}

type Db = ReturnType<typeof openSqliteDatabase>["db"];

function openStore(dir: string): SessionStore {
    const s = new SessionStore({ enabled: true, dir, debounceMs: 60000 });
    _setStoreForTest(s);
    return s;
}

function closeStore(store: SessionStore, dir: string, db: Db | null): void {
    _resetStoreForTest();
    store.closeQuietly();
    db?.close(); // the test's own read-only handle — must close before rmSync
    try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        // Windows: a SQLite handle can still be releasing asynchronously after
        // closeQuietly (EBUSY on unlink); the dir is in the OS tmpdir and is
        // transient — a cleanup failure must not fail the test.
    }
}

const bm = (id: string): BiliMessage => ({ id, role: "user", content: [{ type: "text", text: id }] } as unknown as BiliMessage);
const STAGE0_BASE = { lane: "openai", incomingSeqs: null, log: () => {} } as const;

const L1_COUNT = (db: Db, sid: string) => (db.prepare("SELECT count(*) AS n FROM l1_world WHERE sess_raw = ?").get(sid) as { n: number }).n;
const FLOW_SEQS = (db: Db, sid: string) => (db.prepare("SELECT op_seq FROM egress_flow WHERE session_id = ? ORDER BY op_seq").all(sid) as { op_seq: number }[]).map((r) => r.op_seq);
const assertDense = (seqs: number[]) => {
    for (let i = 1; i < seqs.length; i++) {
        assert.equal(seqs[i], seqs[i - 1]! + 1, `flow stays dense at op ${seqs[i]}`);
    }
};

test("A: a legacy (non-egress) session still runs the full l1 path — byte-identical discipline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-identity-e2e-"));
    let store = openStore(dir);
    let db: Db | null = null;
    const vd = () => { if (db === null) db = openSqliteDatabase(join(dir, "index.db")).db; return db; };
    try {
        const sid = "sess-legacy-e2e";
        const ctx = makeCtx(sid, [bm("l1"), bm("l2"), bm("l3"), bm("l4"), bm("l5")]);
        await store.writeNow(persistable(ctx, ctx.messages));

        const u = () => store.egressOpLogStore();
        const d1 = u()!.snapStage0(sid, ["l1", "l2", "l3", "l4", "l5"]);
        assert.equal(d1.decision.mode, "issue", "first turn issues the cursor (legacy verdict vocabulary)");
        const r1 = runStage0({ sessionId: sid, msgs: ctx.messages as unknown as BiliMessage[], incomingMsgIds: ["l1", "l2", "l3", "l4", "l5"], pluginMode: true, ...STAGE0_BASE });
        assert.ok(r1.cohortRan && r1.pinned !== null, "the lane's full-form pin applied");
        assert.equal(L1_COUNT(vd(), sid), 1, "the l1 ledger row landed (legacy path intact)");
        assert.equal(FLOW_SEQS(vd(), sid).length, 0, "no egress flow row for a non-egress session");

        const d2 = u()!.snapStage0(sid, ["l1", "l2", "l3", "l4", "l5"]);
        const r2 = runStage0({ sessionId: sid, msgs: ctx.messages as unknown as BiliMessage[], incomingMsgIds: ["l1", "l2", "l3", "l4", "l5"], pluginMode: true, ...STAGE0_BASE });
        assert.equal(d2.decision.mode, "echo", "second turn echoes from the l1 ledger");
        assert.equal(d2.decision.replay, true);
        assert.ok(r2.pinned !== null && r2.pinned.length === 5, "the full-form pin re-stamps every turn (#6785: the pin runs on watermark-hit turns too) — the ECHO is the decision, not the pin");
    } finally {
        closeStore(store, dir, db);
    }
});


test("B: an egress-on session runs a STATELESS stage-0 — no l1 row ever, across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-identity-e2e-"));
    let store = openStore(dir);
    let db: Db | null = null;
    const vd = () => { if (db === null) db = openSqliteDatabase(join(dir, "index.db")).db; return db; };
    const ids = ["m1", "m2", "m3", "m4", "m5"];
    const msgs = ids.map(bm);
    try {
        const sid = "sess-egress-convbound";
        const ctx = makeCtx(sid, msgs);
        ctx.session.metadata["egressAuthority"] = true;
        ctx.session.metadata["pluginAgent"] = "claude";
        const ustore = () => store.egressOpLogStore();

        // turn 1 prepare: NO flow row exists yet and the egress save path is
        // index-only (the op log, not a sessions row, is what marks the
        // session egress-on) — so the FIRST turn runs the legacy path and
        // leaves one dormant l1 row; stateless-ness starts at turn 2.
        const d1 = ustore()!.snapStage0(sid, [...ids]);
        assert.equal(d1.decision.mode, "issue", "turn 1 is still the legacy path — the flag is not durable yet");
        const r1 = runStage0({ sessionId: sid, msgs, incomingMsgIds: [...ids], pluginMode: true, convBound: true, ...STAGE0_BASE });
        assert.ok(r1.cohortRan && r1.pinned !== null, "the lane's full-form pin applied");
        assert.equal(L1_COUNT(vd(), sid), 1, "the turn-1 legacy l1 row (dormant — never routed again once the flow row exists)");

        // turn 1 save: the op log lands
        const row1 = recordEgressTurn({ store: ustore()!, sessionId: sid, prev: undefined, conversation: msgs as unknown as CoreMessage[], systemText: "sys", nowMs: 1_000_000 });
        assert.equal(row1.length, 6, "system row + 5 messages");
        await store.writeNow(persistable(ctx, ctx.messages));

        // turn 2: echo — the same 5 ids are all in the flow, now STATELESS
        const d2 = ustore()!.snapStage0(sid, [...ids]);
        const r2 = runStage0({ sessionId: sid, msgs, incomingMsgIds: [...ids], pluginMode: true, convBound: true, ...STAGE0_BASE });
        assert.equal(d2.decision.mode, "echo", "the egress verdict is replay math, not ledger math");
        assert.equal(d2.decision.replay, true);
        assert.equal(d2.decision.window.maxPos, 5, "frontier = MAX(log_seq): the system row is 0 (outside the citation space), the 5 messages 1..5");
        assert.ok(r2.pinned !== null && r2.pinned.length === 5, "the full-form pin re-stamps every turn (#6785) — the ECHO is the decision, not the pin");

        // turn 3: grown array — the new id lands AT the frontier, past it
        const msgs3 = [...msgs, bm("m6")];
        const d3 = ustore()!.snapStage0(sid, [...ids, "m6"]);
        const r3 = runStage0({ sessionId: sid, msgs: msgs3, incomingMsgIds: [...ids, "m6"], pluginMode: true, convBound: true, ...STAGE0_BASE });
        assert.equal(d3.decision.mode, "anchor");
        assert.deepEqual(d3.decision.newIdPos, [{ id: "m6", pos: 6 }], "the new id's position comes from MAX(log_seq)");
        assert.equal(d3.decision.window.maxPos, 6);
        assert.ok(r3.cohortRan && r3.pinned !== null);
        const row3 = recordEgressTurn({ store: ustore()!, sessionId: sid, prev: row1, conversation: msgs3 as unknown as CoreMessage[], systemText: "sys", nowMs: 1_005_000 });
        assert.equal(row3.length, 7);
        await store.writeNow(persistable(ctx, msgs3));

        // stateless from turn 2 on, pinned on the raw rows
        assert.equal(L1_COUNT(vd(), sid), 1, "still exactly the dormant turn-1 row — no l1 row ever moves again");
        assertDense(FLOW_SEQS(vd(), sid));
        assert.equal(FLOW_SEQS(vd(), sid).length, 7, "6 I-rows (turn 1) + 1 (turn 3)");
        assert.equal(egressStateView(vd(), sid).length, 7, "system row + 6 live messages");

        // ---- RESTART: the verdict survives with no ledger to read -------
        await store.closeQuietly();
        _resetStoreForTest();
        store = openStore(dir);
        assert.ok(await store.waitForReplicas(5000), "unified store ready after restart");
        assert.equal(await store.loadAsync(sid), null, "by design on this branch (#7474 P2): an egress-on session lands NO sessions row — the op log is the only authority; nothing to load");
        const d4 = store.egressOpLogStore()!.snapStage0(sid, [...ids, "m6"]);
        const r4 = runStage0({ sessionId: sid, msgs: msgs3, incomingMsgIds: [...ids, "m6"], pluginMode: true, convBound: true, ...STAGE0_BASE });
        assert.equal(d4.decision.mode, "echo", "echo after restart — the op log is the authority");
        assert.equal(d4.decision.window.maxPos, 6);
        assert.equal(L1_COUNT(vd(), sid), 1, "still just the dormant turn-1 row");
        assert.equal(store.egressOpLogStore()!.snapR3Latched(sid), false, "not latched");
    } finally {
        closeStore(store, dir, db);
    }
});

test("C: after a REAL kernel fold the position frontier is MAX(log_seq), not the live-view length", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-identity-e2e-"));
    let store = openStore(dir);
    let db: Db | null = null;
    const vd = () => { if (db === null) db = openSqliteDatabase(join(dir, "index.db")).db; return db; };
    try {
        const sid = "sess-egress-fold";
        const ctx = makeCtx(sid);
        ctx.session.metadata["egressAuthority"] = true;
        ctx.session.metadata["pluginAgent"] = "claude";
        await store.writeNow(persistable(ctx, ctx.messages));
        const ustore = () => store.egressOpLogStore();

        const row1 = recordEgressTurn({ store: ustore()!, sessionId: sid, prev: undefined, conversation: ctx.messages, systemText: "sys", nowMs: 1_000_000 });
        assert.equal(row1.length, 81, "system + 80");
        await store.writeNow(persistable(ctx, ctx.messages));

        // the real fold (production applyRanges → next-prepare processTurn)
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

        const row2 = recordEgressTurn({ store: ustore()!, sessionId: sid, prev: row1, conversation: folded, systemText: "sys", nowMs: 1_005_000 });
        assert.equal(row2.length, 51, "system + 50 folded");
        await store.writeNow(persistable(ctx, folded));

        // the split this test pins: the live view SHRANK, the frontier did not —
        // and the #7574 compaction detail that makes it subtle: the fold's own
        // writeBase PHYSICALLY removed the I rows it subsumed, so right after a
        // fold the flow holds the B base row ONLY and raw MAX(log_seq) is 0.
        // The frontier survives exclusively in the base payload's highWater —
        // egressMessageHighWater is the rule (same as nextSeqs) that reads it.
        const view = egressStateView(vd(), sid);
        assert.equal(view.length, 51, "system row + the folded 50 — the live view SHRANK");
        const flowTypes = (vd().prepare("SELECT row_type FROM egress_flow WHERE session_id = ? ORDER BY op_seq").all(sid) as { row_type: string }[]).map((r) => r.row_type);
        assert.deepEqual(flowTypes, ["B"], "the compaction left only the base row in the flow — everything it subsumed is physically gone");
        const basePayload = JSON.parse((vd().prepare("SELECT payload FROM egress_flow WHERE session_id = ? AND row_type = 'B' ORDER BY op_seq DESC LIMIT 1").get(sid) as { payload: string }).payload) as { highWater: number };
        assert.equal(basePayload.highWater, 81, "the system row is 0, the 80 originals 1..80, the fold's summary I-row 81 — the base carries the frontier");

        // a steady-state turn echoing three LIVE ids: the verdict carries the
        // FRONTIER as maxPos. Pre-fix (raw MAX(log_seq), no base fallback) this
        // computed 0 the turn right after every fold — and every persisted
        // witness from this session on would have lied about where the world's
        // positions live; under the live-length math it would say 50.
        const tail = view.filter((r) => r.msgid !== EGRESS_SYSTEM_MSGID).slice(-3).map((r) => r.msgid);
        const d = store.egressOpLogStore()!.snapStage0(sid, tail);
        assert.equal(d.decision.mode, "echo", "the live tail is all in the flow — echo");
        assert.equal(d.decision.window.maxPos, 81, "maxPos = 81 (the base highWater) — NOT 0 (raw MAX(log_seq) post-compaction) and NOT 50 (the live count)");
        runStage0({ sessionId: sid, msgs: tail.map(bm), incomingMsgIds: tail, pluginMode: true, convBound: true, ...STAGE0_BASE });
    } finally {
        closeStore(store, dir, db);
    }
});

test("D: the R3 latch lands on the sessions row, survives a restart, and the clear releases it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-identity-e2e-"));
    let store = openStore(dir);
    let db: Db | null = null;
    const vd = () => { if (db === null) db = openSqliteDatabase(join(dir, "index.db")).db; return db; };
    const sid = "sess-egress-r3";
    try {
        const ctx = makeCtx(sid, [bm("a"), bm("b"), bm("c")]);
        ctx.session.metadata["egressAuthority"] = true;
        await store.writeNow(persistable(ctx, ctx.messages));
        // NO op log turn here — deliberately: the R3 fault path requires an
        // EMPTY ledger (the #7574 exemption). With a non-empty ledger the
        // mismatching tail silently degrades to the full signal (drift-class
        // contract: never rejects); on an empty ledger a BROKEN short array
        // (duplicate entry) is a collection fault (B1/D2). The host declares
        // the channel but collects only 2 of 3; the sid is NOT convBound
        // (no pluginAgent → the claim row is the proxy namespace → the store
        // lookup says false).
        const bad = () => runStage0({ sessionId: sid, msgs: ctx.messages as unknown as BiliMessage[], incomingMsgIds: ["a", "a"], pluginMode: true, ...STAGE0_BASE });
        assert.throws(() => bad(), FoundationRejectError, "strike 1 → 400");
        assert.throws(() => bad(), FoundationRejectError, "strike 2 → 400");
        const r3 = bad();
        assert.equal(r3.pinned, null, "strike 3 latches — the turn degrades to content-derived ids, no throw");
        assert.equal(store.snapR3Latched(sid), true, "the store-level latch read is latched (sessions carrier)");

        const col = (vd().prepare("SELECT r3_latched_at FROM sessions WHERE session_id = ?").get(sid) as { r3_latched_at: number | null }).r3_latched_at;
        assert.ok(col != null && col > 0, "the latch timestamp is on the SESSIONS row");
        assert.equal(L1_COUNT(vd(), sid), 0, "and nowhere on l1 — the placeholder-row ceremony is retired");
        assert.ok(store.snapR3LatchedList().some((r) => r.sessRaw === sid), "the roster sees it");

        // ---- RESTART: a restarted proxy must not re-arm the broken host ---
        await store.closeQuietly();
        _resetStoreForTest();
        store = openStore(dir);
        assert.ok(await store.waitForReplicas(5000), "unified store ready after restart");
        assert.equal(store.snapR3Latched(sid), true, "the latch persisted");
        assert.equal(store.snapR3LatchClear(sid), sid, "one clear reports the release (returns the sid — the sessions carrier was latched)");
        assert.equal(store.snapR3Latched(sid), false, "the session is fully unlatched");
    } finally {
        closeStore(store, dir, db);
    }
});

test("F: double-latched migration state — one clear releases BOTH carriers (review M1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-identity-e2e-"));
    const store = openStore(dir);
    let db: Db | null = null;
    const vd = () => { if (db === null) db = openSqliteDatabase(join(dir, "index.db")).db; return db; };
    const sid = "sess-double-latched";
    try {
        const ctx = makeCtx(sid, [bm("x")]);
        ctx.session.metadata["egressAuthority"] = true;
        await store.writeNow(persistable(ctx, ctx.messages));
        // pre-migration latch (l1 placeholder row), then the post-migration
        // re-latch lands on the sessions row — same raw key, both set
        vd().prepare("INSERT INTO l1_world (sess_raw, ledger_id, witness_probe, issued_at, r3_latched_at) VALUES (?, ?, '', ?, ?)")
            .run(sid, sid, 1_000_000, 1_000_000);
        store.snapR3Latch(sid);
        assert.equal((vd().prepare("SELECT r3_latched_at FROM l1_world WHERE sess_raw = ?").get(sid) as { r3_latched_at: number | null }).r3_latched_at, 1_000_000, "legacy carrier holds its latch");
        assert.ok((vd().prepare("SELECT r3_latched_at FROM sessions WHERE session_id = ?").get(sid) as { r3_latched_at: number | null }).r3_latched_at != null, "sessions carrier holds its latch");
        assert.equal(store.snapR3Latched(sid), true, "read: latched");

        const cleared = store.snapR3LatchClear(sid);
        assert.equal(cleared, sid, "the clear reports a release (the sessions carrier hit)");
        assert.equal(store.snapR3Latched(sid), false, "the legacy READ-FALLBACK did not re-latch the session");
        assert.equal((vd().prepare("SELECT r3_latched_at FROM l1_world WHERE sess_raw = ?").get(sid) as { r3_latched_at: number | null }).r3_latched_at, null, "the l1 carrier was cleared too");
    } finally {
        closeStore(store, dir, db);
    }
});

test("E: GC and manual archive — the idle egress-on session with a recent op log survives; the legacy twin archives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-identity-e2e-"));
    const store = openStore(dir);
    let db: Db | null = null;
    const vd = () => { if (db === null) db = openSqliteDatabase(join(dir, "index.db")).db; return db; };
    const now = Date.now();
    const OLD = now - 40 * 86_400_000;
    try {
        await store.waitForReplicas(5000);
        const eSid = "sess-egress-idle";
        const lSid = "sess-legacy-idle";
        const mSid = "sess-legacy-manual";
        const ustore = () => store.egressOpLogStore();
        assert.ok(ustore(), "unified store ready");
        // idle egress-on: the sessions row is 40 days old, the OP LOG is fresh
        vd().prepare("INSERT INTO sessions (session_id, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?)").run(eSid, OLD, OLD, JSON.stringify({ egressAuthority: true }));
        recordEgressTurn({ store: ustore()!, sessionId: eSid, prev: undefined, conversation: [bm("e1")] as unknown as CoreMessage[], systemText: "sys", nowMs: now });
        // legacy twins: 40 days old, no op log, a couple of content rows each
        const contentHash = (s: string) => {
            const bytes = Buffer.from(`${s} body`);
            vd().prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, 2, 'sha256', ?)").run(s, bytes.length, bytes);
            return s;
        };
        // the age-sweep victim is 40 days old; the manual-archive twin is
        // fresh (it must survive the sweep to be archived by hand below)
        for (const s of [lSid, mSid]) {
            const ts = s === mSid ? now : OLD;
            vd().prepare("INSERT INTO sessions (session_id, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?)").run(s, ts, ts, JSON.stringify({}));
            contentHash(s);
            vd().prepare("INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, ts) VALUES (?, 1, ?, 'r1', 1, 'user', 'text', ?, ?)").run(s, `${s}-m1`, s, now);
        }

        // ---- the age sweep (GC) ------------------------------------------
        const gc = store.unifiedGc({ archiveAfterDays: 30 });
        assert.ok(gc, "unified gc available");
        assert.equal(gc.archived, 1, "exactly the legacy twin archived");
        const status = (s: string) => (vd().prepare("SELECT status FROM sessions WHERE session_id = ?").get(s) as { status: string }).status;
        assert.equal(status(lSid), "archived", "legacy twin archived by the age sweep");
        assert.equal(status(eSid), "active", "the egress-on session survived — freshness = the op log (its updated_at alone would have archived it pre-fix)");
        assert.equal((vd().prepare("SELECT count(*) AS n FROM egress_flow WHERE session_id = ?").get(eSid) as { n: number }).n, 2, "its op log is intact");

        // ---- manual archive (bili sessions archive) -----------------------
        const refused = store.unifiedArchiveSession(eSid);
        assert.equal(refused?.ok, false, "manual archive refuses the egress-on session");
        assert.match(refused?.reason ?? "", /egress-on/, "the reason names the missing op-log export");
        assert.equal(status(eSid), "active", "the refusal left the session untouched");
        const ok = store.unifiedArchiveSession(mSid);
        assert.ok(ok?.ok, "manual archive proceeds for the legacy session");
    } finally {
        closeStore(store, dir, db);
    }
});
