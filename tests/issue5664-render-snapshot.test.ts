// #5664 — station 2/3: outbound-row render-snapshot plane for the v6 lane.
//
// Golden equation under test: on every engaged turn the outbound emit built
// as [cached prefix core rows] ++ [this round's rewritten window cores]
// passed through the FULL mapping chain fresh (fast rounds) must be BYTE-
// IDENTICAL to what the legacy full-pipeline path emits (arm / audit /
// rollback rounds). The kernel is untouched.
//
// CANONICAL-FLOW REGIME (#5643 ruling §5, owner 2026-11-05): stored rows
// hold the POST-REWRITE GENERIC CORE FORM — the only plane boundary the
// mapping layer (model/maxDim/toolArmed/voice/harden/serialize) can never
// alter — and NOTHING mapped/cached survives across turns: every emit runs
// the entire chain end-to-end. Equivalence with the full pass is the
// contract, enforced here against a legacy oracle.
//
// WITNESSED-REBASE REGIME (#5643 补充裁定 + owner ruling 2026-11-05):
// the table MUST evolve with compression. A structurally-WITNESSED diverged
// capture (fold layer's active-block multiset moved around the turn, dsh
// native-compaction detector fired, fold usage consumed pre→post, or the
// gate itself observed a signature move) REBASES the row table:
// truncate from the first divergence point + whole-suffix re-append as ONE
// transaction, checkpoint with S4 checksum, audit reset. An UNWITNESSED
// diverged capture still KILLS the lane permanently (persisted kind='dead')
// and rides legacy thereafter; checksum corruption stays durably dead.
// Storage is bounded by live elements (compaction SHRINKS the table); arm
// cast is legal exactly once, onto an empty table.
//
// Harness: unit-level against a REAL sqlite sidecar (UnifiedShadow shadow
// mode), mirroring tests/fastpath-v6-msgid.test.ts; the kernel runs as a
// real createCore() instance (the same regime probe-window.mts established
// for bounded-window byte reproduction).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import { coreToOpenai, openaiToCore, type OpenAIMessage } from "acp-kernel/wire";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import type { SessionStore as SessionStoreType } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { stripKernelSummaries } from "../src/server.ts";
import { hardenOpenaiAssistantContent, systemToUser } from "../src/util.ts";
import {
    evaluateWatermarkV6, finalizeWatermarkV6, watermarkV6DebugState, PF_SESSION_HEADER,
} from "../src/server/fastpath-v6.ts";
import { PF_TAIL_IDS_HEADER } from "../src/server/fastpath.ts";
import type { V6Outcome } from "../src/server/fastpath-v6.ts";
import {
    activeBlocksSignature, bumpAuditTick, commitRenderCapture, diffRowLists, renderPlaneGate, spliceOutboundRows, verifyRenderWindow,
    watermarkV6RenderDebugState, _resetWatermarkV6RenderTestState,
    type RenderCaps,
} from "../src/server/fastpath-v6-render.ts";

const ENV_V6 = "BILI_ROLLOUT_WATERMARK_V6_MSG_ID";
const ENV_RENDER = "BILI_ROLLOUT_WATERMARK_V6_RENDER";
const MODEL_LIMIT = 200_000;

type AgentState = ReturnType<typeof createInitialState>;

interface Msg { role: string; content: string }
function makeBody(messages: Msg[]): string { return JSON.stringify({ model: "m", messages }); }

type LogSink = { lines: { level: string; msg: string }[] } & ((level: string, msg: string) => void);
function makeLog(): LogSink {
    const l = { lines: [] as { level: string; msg: string }[] };
    return Object.assign((level: string, msg: string) => { l.lines.push({ level, msg }); }, { lines: l.lines });
}

/** Post-kernel → wire transform chain (production shape minus the image
 *  rescale pass — identity for text-only content, no multimodal parts here). */
function mapEgress(pms: CoreMessage[]): OpenAIMessage[] {
    return hardenOpenaiAssistantContent(coreToOpenai(systemToUser(pms))) as unknown as OpenAIMessage[];
}

function capsFor(strategy: string): RenderCaps {
    return { v: 1, strategy, droppable: false, multimodal: false };
}

/** Shallow-adopt a returned state into a stable object identity (the session
 *  holder keeps referencing the same object across turns). */
function adoptState(dst: AgentState, src: AgentState): void {
    for (const k of Object.keys(src) as (keyof AgentState)[]) (dst as unknown as Record<string, unknown>)[k] = src[k];
    // fields cleared on src but present on dst: none expected; state evolves additively
}

interface H { dir: string; store: SessionStoreType; log: LogSink; cleanup: () => void }
function makeH(tag: string): H {
    process.env[ENV_V6] = "1";
    process.env[ENV_RENDER] = "1";
    _resetStoreForTest();
    _resetWatermarkV6RenderTestState();
    const dir = mkdtempSync(path.join(os.tmpdir(), `rsn-${tag}-`));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as never);
    assert.ok(shadow, "shadow sidecar must open in the hermetic dir");
    const store = new SessionStore({ dir: path.join(dir, "sessions"), enabled: true, shadow });
    _setStoreForTest(store);
    const log = makeLog();
    return { dir, store, log, cleanup: () => { _resetStoreForTest(); _resetWatermarkV6RenderTestState(); rmSync(dir, { recursive: true, force: true }); } };
}

/** Arm turns carry no hit (first registration) — fall back to the
 *  full-parse oracle, which the v6 contract (§8-1) pins byte-equal to the
 *  assembled view. */
function viewOf(outcome: V6Outcome, bodyText: string): CoreMessage[] {
    return outcome.hit !== null ? [...outcome.hit.view] : (openaiToCore(JSON.parse(bodyText) as never) as unknown as { msgs: CoreMessage[] }).msgs;
}

/** One v6 identity-plane turn, SPLIT like production
 *  (prepare-openai: evaluate early → pipeline/egress/capture → finalize LAST;
 *  finalize is the only point that advances worlds.maxPos / pf_rows). */
function v6Eval(h: H, sessId: string, bodyText: string, idList: string[], echoSid?: string): { outcome: V6Outcome; sid: string | undefined; fin: () => void } {
    const headers: Record<string, string> = { "x-bili-plugin-conversation": "carrier" };
    if (idList.length > 0) headers[PF_TAIL_IDS_HEADER] = idList.map(encodeURIComponent).join(",");
    if (echoSid !== undefined) headers[PF_SESSION_HEADER] = echoSid;
    const req = { headers } as unknown as http.IncomingMessage;
    const session = { id: sessId } as unknown as Session;
    const outcome = evaluateWatermarkV6(bodyText, req, session, { pluginMode: true, titleGen: false, model: "m" }, h.log);
    assert.ok(outcome !== null, `v6 must engage (log=${JSON.stringify(h.log.lines.slice(-4))})`);
    return {
        outcome,
        sid: outcome.armed?.sid ?? echoSid,
        fin: () => { finalizeWatermarkV6(session, outcome, { bodyText }, h.log); },
    };
}

// ---------------------------------------------------------------------------
// Unit tier: pure plane mechanics.
// ---------------------------------------------------------------------------

test("unit: diffRowLists verdicts", () => {
    assert.equal(diffRowLists([], ["a"]), "append");
    assert.equal(diffRowLists(["a", "b"], ["a", "b"]), "equal");
    assert.equal(diffRowLists(["a", "b"], ["a", "b", "c"]), "append");
    assert.equal(diffRowLists(["a", "b"], ["a", "X"]), "diverged");   // middle mutation
    assert.equal(diffRowLists(["a", "b", "c"], ["a"]), "diverged");   // shrink
});

test("unit: cast → steady appends → hydrate-from-disk fold survives mirror loss", (t) => {
    const h = makeH("fold");
    try {
        const b1 = makeBody([{ role: "user", content: "hello" }]);
        const r1 = v6Eval(h, "s-fold", b1, ["id0"]);
        assert.equal(r1.outcome.decision, "arm");
        r1.fin();
        const sid = r1.sid!;
        const caps = capsFor("text-only");
        let op = commitRenderCapture({ sessionId: "s-fold", store: h.store, sid, mode: "legacy", caps, rowStrings: ['{"i":0}', '{"i":1}'], sums: { estCum: 2, textCum: 2, imgCum: 0 } });
        assert.equal(op.op, "cast");
        op = commitRenderCapture({ sessionId: "s-fold", store: h.store, sid, mode: "steady", caps, rowStrings: ['{"i":2}'], sums: { estCum: 1, textCum: 1, imgCum: 0 } });
        assert.equal(op.op, "append");
        op = commitRenderCapture({ sessionId: "s-fold", store: h.store, sid, mode: "steady", caps, rowStrings: ['{"i":3}'], sums: { estCum: 1, textCum: 1, imgCum: 0 } });
        assert.equal(op.op, "append");
        assert.equal(h.store.pfRenderRows(sid).length, 4);
        assert.equal(h.store.pfRenderCkptIntact(sid), true);

        // Kill every in-memory mirror — the next gate MUST rebuild from disk
        // via pfRenderMeta folding (ckpt rowCount + post-ckpt append log).
        // maxPos is synthetic here: prod wiring always feeds the live world
        // geometry (rows and plane grow together, one row per element), so
        // alignment holds; this unit isolates the FOLD mechanics, so feed the
        // geometry matching the four stored rows.
        _resetWatermarkV6RenderTestState();
        const g = renderPlaneGate({
            sessionId: "s-fold", session: { id: "s-fold", state: createInitialState() } as unknown as Session,
            store: h.store, engagedHit: true, armedTurn: false, isTitleGen: false, sid,
            maxPos: 3, tokenCount: 50, modelContextLimit: MODEL_LIMIT, caps,
            snapshotLaneActive: false, absorbActive: false, ccrOn: false, foldUsagePending: false, markerNonZero: false,
        });
        assert.ok(g.ok, `expected hydrated green gate, got ${JSON.stringify(g)}`);
        if (g.ok) {
            assert.equal(g.rw.rows.length, 4, "disk fold must reconstruct all four rows");
            assert.deepEqual(g.rw.rows.slice(-2), ['{"i":2}', '{"i":3}'], "appended tail must survive the fold");
        }
    } finally { h.cleanup(); }
});

test("gate: red reasons are a stable vocabulary", (t) => {
    const h = makeH("gate");
    try {
        const b1 = makeBody([{ role: "user", content: "hello" }]);
        const r1 = v6Eval(h, "s-gate", b1, ["id0"]);
        r1.fin();
        const sid = r1.sid!;
        const caps = capsFor("text-only");
        const cast = commitRenderCapture({ sessionId: "s-gate", store: h.store, sid, mode: "legacy", caps, rowStrings: ['{"a":1}'], sums: { estCum: 1, textCum: 1, imgCum: 0 } });
        assert.equal(cast.op, "cast");
        const geom = watermarkV6DebugState("s-gate").worlds[sid];
        const base = {
            sessionId: "s-gate", session: { id: "s-gate", state: createInitialState() } as unknown as Session,
            store: h.store, engagedHit: true, armedTurn: false, isTitleGen: false, sid,
            maxPos: geom!.maxPos, tokenCount: 500, modelContextLimit: MODEL_LIMIT, caps,
            snapshotLaneActive: false, absorbActive: false, ccrOn: false, foldUsagePending: false, markerNonZero: false,
        };
        const g0 = renderPlaneGate(base);
        assert.equal(g0.ok, true, `expected green gate, got ${JSON.stringify(g0)}`);
        assert.deepEqual(renderPlaneGate({ ...base, engagedHit: false }), { ok: false, reason: "not-engaged" });
        assert.deepEqual(renderPlaneGate({ ...base, armedTurn: true }), { ok: false, reason: "arm-turn" });
        assert.deepEqual(renderPlaneGate({ ...base, isTitleGen: true }), { ok: false, reason: "title-gen" });
        assert.deepEqual(renderPlaneGate({ ...base, tokenCount: Math.ceil(0.9 * MODEL_LIMIT) }), { ok: false, reason: "pressure" });
        assert.deepEqual(renderPlaneGate({ ...base, maxPos: -1 }), { ok: false, reason: "no-plane-geometry" });
        assert.deepEqual(renderPlaneGate({ ...base, caps: capsFor("none") }), { ok: false, reason: "caps-mismatch" });
        // audit cadence: PF_RENDER_AUDIT_EVERY default 8 — ticks land on 8 ⇒ red, 9 ⇒ green
        for (let i = 0; i < 8; i++) bumpAuditTick(sid);
        assert.deepEqual(renderPlaneGate(base), { ok: false, reason: "audit-due" });
        bumpAuditTick(sid);
        assert.equal(renderPlaneGate(base).ok, true);
    } finally { h.cleanup(); }
});

test("unit: S4 checksum tamper KILLS the plane durably (loudly logged)", (t) => {
    const h = makeH("s4");
    try {
        const b1 = makeBody([{ role: "user", content: "hello" }]);
        const r1 = v6Eval(h, "s-s4", b1, ["id0"]);
        r1.fin();
        const sid = r1.sid!;
        const caps = capsFor("text-only");
        const cast = commitRenderCapture({ sessionId: "s-s4", store: h.store, sid, mode: "legacy", caps, rowStrings: ['{"a":1}', '{"a":2}'], sums: { estCum: 2, textCum: 2, imgCum: 0 } });
        assert.equal(cast.op, "cast");
        assert.equal(h.store.pfRenderCkptIntact(sid), true);
        // Simulate silent corruption of the checkpoint checksum.
        const db = new DatabaseSync(path.join(h.dir, "index.db"));
        db.prepare(`UPDATE pf_render_ckpt SET checksum = 'deadbeef' WHERE sid = ?`).run(sid);
        db.close();
        assert.equal(h.store.pfRenderCkptIntact(sid), false);
        _resetWatermarkV6RenderTestState(); // memory copies gone ⇒ gate must hydrate
        const g = renderPlaneGate({
            sessionId: "s-s4", session: { id: "s-s4", state: createInitialState() } as unknown as Session,
            store: h.store, engagedHit: true, armedTurn: false, isTitleGen: false, sid,
            maxPos: 0, tokenCount: 10, modelContextLimit: MODEL_LIMIT, caps,
            snapshotLaneActive: false, absorbActive: false, ccrOn: false, foldUsagePending: false, markerNonZero: false,
        });
        // No-recast ruling: corruption is no longer self-healable via a
        // forced recast — the FIRST hydration attempt reports the DURABLE
        // reason and persists the death verdict.
        assert.deepEqual(g, { ok: false, reason: "lane-dead" });
        const meta = h.store.pfRenderMeta(sid);
        assert.ok(meta !== null && meta.log.some((e) => e.kind === "dead"), "corruption must persist a kind='dead' verdict");
    } finally { h.cleanup(); }
});

test("unit: structural divergence KILLS the plane permanently (no-recast ruling 2026-11-05)", (t) => {
    const h = makeH("die");
    try {
        const b1 = makeBody([{ role: "user", content: "hello" }]);
        const r1 = v6Eval(h, "s-die", b1, ["id0"]);
        r1.fin();
        const sid = r1.sid!;
        const caps = capsFor("text-only");
        assert.equal(commitRenderCapture({ sessionId: "s-die", store: h.store, sid, log: h.log, mode: "legacy", caps, rowStrings: ['{"i":0}', '{"i":1}'], sums: { estCum: 2, textCum: 2, imgCum: 0 } }).op, "cast");
        assert.equal(commitRenderCapture({ sessionId: "s-die", store: h.store, sid, log: h.log, mode: "steady", caps, rowStrings: ['{"i":2}'], sums: { estCum: 1, textCum: 1, imgCum: 0 } }).op, "append");
        // Middle-byte mutation lands on a full-path round. The old design
        // repaired with a recast; the ruling forbids that ⇒ kill instead.
        const logsBefore = h.log.lines.length;
        const op = commitRenderCapture({ sessionId: "s-die", store: h.store, sid, log: h.log, mode: "legacy", caps, rowStrings: ['{"i":0}', '{"X":9}', '{"i":2}'], sums: { estCum: 3, textCum: 3, imgCum: 0 } });
        assert.deepEqual(op, { committed: false, op: "none" });
        assert.equal(h.store.pfRenderRows(sid).length, 3, "stored rows stay immutable after a divergence");
        assert.equal(h.store.pfRenderCkptIntact(sid), true, "the kill writes NO checkpoint (strictly append-only)");
        assert.ok(h.log.lines.slice(logsBefore).some((l) => l.level === "error" && l.msg.includes("KILLED PERMANENTLY")),
            `kill must be loudly logged, got ${JSON.stringify(h.log.lines.slice(logsBefore))}`);
        const meta = h.store.pfRenderMeta(sid);
        assert.ok(meta !== null && meta.log.some((e) => e.kind === "dead"), "death verdict persisted as kind='dead'");
        const base = {
            sessionId: "s-die", session: { id: "s-die", state: createInitialState() } as unknown as Session,
            store: h.store, engagedHit: true, armedTurn: false, isTitleGen: false, sid,
            maxPos: 2, tokenCount: 50, modelContextLimit: MODEL_LIMIT, caps,
            snapshotLaneActive: false, absorbActive: false, ccrOn: false, foldUsagePending: false, markerNonZero: false,
        };
        assert.deepEqual(renderPlaneGate(base), { ok: false, reason: "lane-dead" }, "positive: dead sid reports the durable reason");
        // Negative side (#3617): neither re-capture nor a restart-wipe'd
        // re-arm can bring the lane back — no rewriting of stored rows EVER.
        assert.deepEqual(commitRenderCapture({ sessionId: "s-die", store: h.store, sid, mode: "legacy", caps, rowStrings: ['{"i":0}', '{"X":9}', '{"i":2}'], sums: { estCum: 3, textCum: 3, imgCum: 0 } }),
            { committed: false, op: "none" }, "re-capture into a dead plane is refused");
        assert.equal(h.store.pfRenderRows(sid).length, 3);
    } finally { h.cleanup(); }
});

test("unit: witnessed structural divergence REBASES the table (snapshot evolves with compression)", (t) => {
    const h = makeH("rebase");
    try {
        const b1 = makeBody([{ role: "user", content: "hello" }]);
        const r1 = v6Eval(h, "s-rb", b1, ["id0"]);
        r1.fin();
        const sid = r1.sid!;
        const caps = capsFor("text-only");
        const preSig = activeBlocksSignature([]);
        const newSig = activeBlocksSignature([{ blockId: "blkA", generation: "young", active: true }]);

        // Forge the table on a 3-row folded-free prefix.
        const cast = commitRenderCapture({ sessionId: "s-rb", store: h.store, sid, mode: "legacy", caps, rowStrings: ['{"i":0}', '{"i":1}', '{"i":2}'], sums: { estCum: 3, textCum: 3, imgCum: 0 }, witness: false, blocksSig: preSig });
        assert.equal(cast.op, "cast");

        // A fold lands outside bili's turn processing (#2432-class host OR
        // the /__bili/plugin/tool endpoint executing server-side): the next
        // model resend captures a SHRUNKEN + middle-rewritten list. With the
        // structural witness, this rebases instead of killing.
        const rb = commitRenderCapture({ sessionId: "s-rb", store: h.store, sid, log: h.log, mode: "legacy", caps, rowStrings: ['{"i":0}', '{"S":1}'], sums: { estCum: 2, textCum: 2, imgCum: 0 }, witness: true, blocksSig: newSig });
        assert.deepEqual(rb, { committed: true, op: "rebase" }, `witnessed diverged capture must rebase, got ${JSON.stringify(rb)}`);
        assert.deepEqual(h.store.pfRenderRows(sid).map((r) => r.rowJson), ['{"i":0}', '{"S":1}'], "the table now IS the compacted truth");
        assert.equal(h.store.pfRenderCkptIntact(sid), true, "rebase folds a fresh checkpoint with S4 checksum");
        const meta = h.store.pfRenderMeta(sid);
        assert.ok(meta !== null && JSON.parse(meta.ckpt!.metaJson).blocksSig === newSig, "checkpoint carries the post-event block signature");
        assert.ok(h.log.lines.some((l) => l.level === "info" && l.msg.includes("REBASED")), "rebase is logged at info level");

        // Steady appends continue at the RIGHT positions after a rebase.
        const ap = commitRenderCapture({ sessionId: "s-rb", store: h.store, sid, mode: "steady", caps, rowStrings: ['{"i":3}'], sums: { estCum: 1, textCum: 1, imgCum: 0 }, blocksSig: newSig });
        assert.equal(ap.op, "append");
        assert.deepEqual(h.store.pfRenderRows(sid).map((r) => ({ pos: r.pos, rowJson: r.rowJson })),
            [{ pos: 0, rowJson: '{"i":0}' }, { pos: 1, rowJson: '{"S":1}' }, { pos: 2, rowJson: '{"i":3}' }], "positions renumber from zero over the compacted table");

        // Restart: the disk fold must reproduce rows AND signature.
        // (The forged unit table ignores the identity plane's ledger size,
        // so maxPos mirrors s-die's hand-rolled alignment: 3 rows ⇒ 2.)
        _resetWatermarkV6RenderTestState();
        const base = {
            sessionId: "s-rb", session: { id: "s-rb", state: createInitialState() } as unknown as Session,
            store: h.store, engagedHit: true, armedTurn: false, isTitleGen: false, sid,
            maxPos: 2, tokenCount: 500, modelContextLimit: MODEL_LIMIT, caps,
            snapshotLaneActive: false, absorbActive: false, ccrOn: false, foldUsagePending: false, markerNonZero: false,
        };
        // Positive side of the pair: matching signature → green, rows intact.
        const gMatch = renderPlaneGate({ ...base, blocksSig: newSig });
        assert.ok(gMatch.ok, `matching post-rebase signature must gate green, got ${JSON.stringify(gMatch)}`);
        if (gMatch.ok) assert.equal(gMatch.rw.rows.length, 3, "hydrate must reconstruct the rebased table + tail append");
        // Negative side (#3617): a STALE session signature (pre-rebase) must
        // NOT gate green — exactly one red round precedes the next full pass.
        assert.deepEqual(renderPlaneGate({ ...base, blocksSig: preSig }), { ok: false, reason: "blocks-changed" }, "stale signature stays red");
    } finally { h.cleanup(); }
});

test("unit: plane death persists across restart (no re-arm ever)", (t) => {
    const h = makeH("pdeath");
    try {
        const b1 = makeBody([{ role: "user", content: "hello" }]);
        const r1 = v6Eval(h, "s-pdeath", b1, ["id0"]);
        r1.fin();
        const sid = r1.sid!;
        const caps = capsFor("text-only");
        assert.equal(commitRenderCapture({ sessionId: "s-pdeath", store: h.store, sid, mode: "legacy", caps, rowStrings: ['{"a":1}', '{"a":2}'], sums: { estCum: 2, textCum: 2, imgCum: 0 } }).op, "cast");
        assert.equal(commitRenderCapture({ sessionId: "s-pdeath", store: h.store, sid, mode: "legacy", caps, rowStrings: ['{"a":1}', '{"MUTATED":2}'], sums: { estCum: 2, textCum: 2, imgCum: 0 } }).committed, false);
        // Process-restart simulation: wipe ALL in-memory plane state (the
        // death set included) and reopen the SAME sidecar (cascade pattern).
        _resetWatermarkV6RenderTestState();
        const shadow2 = UnifiedShadow.maybeOpen(h.dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as never);
        assert.ok(shadow2, "second open must tolerate the existing sidecar");
        const store2 = new SessionStore({ dir: path.join(h.dir, "sessions"), enabled: true, shadow: shadow2 });
        const g = renderPlaneGate({
            sessionId: "s-pdeath", session: { id: "s-pdeath", state: createInitialState() } as unknown as Session,
            store: store2, engagedHit: true, armedTurn: false, isTitleGen: false, sid,
            maxPos: 1, tokenCount: 10, modelContextLimit: MODEL_LIMIT, caps,
            snapshotLaneActive: false, absorbActive: false, ccrOn: false, foldUsagePending: false, markerNonZero: false,
        });
        assert.deepEqual(g, { ok: false, reason: "lane-dead" }, "persisted kind='dead' verdict binds the NEW process too");
        assert.equal(store2.pfRenderRows(sid).length, 2, "row table stays frozen");
        // An explicit arming-style full capture through the new store is
        // refused — the lane is dead until session teardown, period.
        assert.equal(
            commitRenderCapture({ sessionId: "s-pdeath", store: store2, sid, mode: "legacy", caps, rowStrings: ['{"a":1}', '{"a":2}'], sums: { estCum: 2, textCum: 2, imgCum: 0 } }).committed,
            false, "re-arm through a fresh process is impossible",
        );
        shadow2.close();
    } finally { h.cleanup(); }
});

test("unit: thrown row-table read defers arming without killing (transient ≠ death)", () => {
    const h = makeH("defer");
    try {
        const b1 = makeBody([{ role: "user", content: "hello" }]);
        const r1 = v6Eval(h, "s-defer", b1, ["id0"]);
        r1.fin();
        const sid = r1.sid!;
        const caps = capsFor("text-only");
        // Prototype-chain wrapper: every store method resolves to the REAL
        // sidecar except pfRenderRows, which throws — a transient SELECT
        // failure while everything else is healthy.
        const flakyStore: SessionStore = Object.create(h.store);
        flakyStore.pfRenderRows = () => { throw new Error("io hiccup"); };
        assert.deepEqual(
            commitRenderCapture({ sessionId: "s-defer", store: flakyStore, sid, mode: "legacy", caps, rowStrings: ['{"i":0}', '{"i":1}'], sums: { estCum: 2, textCum: 2, imgCum: 0 } }),
            { committed: false, op: "none" }, "a thrown read must fail soft for this round, not crash the caller");
        // Negative side (#3617): no death verdict may persist from a transient
        // error — the very next round with a healthy store arms normally.
        assert.equal(commitRenderCapture({ sessionId: "s-defer", store: h.store, sid, mode: "legacy", caps, rowStrings: ['{"i":0}', '{"i":1}'], sums: { estCum: 2, textCum: 2, imgCum: 0 } }).op, "cast");
        assert.equal(h.store.pfRenderRows(sid).length, 2);
    } finally { h.cleanup(); }
});

// Review round 1 blind-spot pins (issue #5664): session teardown must wipe the
// three render tables in the same cascade, and re-running the migration on an
// already-v12 sidecar must be a no-op that leaves rows untouched.
test("unit: session cascade wipes render tables; v12 re-migration is a no-op", () => {
    const h = makeH("cascade");
    try {
        const b1 = makeBody([{ role: "user", content: "hello" }]);
        const r1 = v6Eval(h, "s-cas", b1, ["id0"]);
        r1.fin();
        const sid = r1.sid!;
        const cast = commitRenderCapture({ sessionId: "s-cas", store: h.store, sid, mode: "legacy", caps: capsFor("none"), rowStrings: ['{"a":1}', '{"b":2}'], sums: { estCum: 2, textCum: 2, imgCum: 0 } });
        assert.equal(cast.op, "cast");
        assert.equal(h.store.pfRenderRows(sid).length, 2);
        // Re-opening the sidecar re-runs the migrator on an already-v12
        // database: must be a no-op that leaves rows untouched (review round 1
        // blind spot: explicit 12→12 idempotency).
        const shadow2 = UnifiedShadow.maybeOpen(h.dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as never);
        assert.ok(shadow2, "second open must tolerate an already-migrated sidecar");
        assert.equal(shadow2.pfRenderAvailable(), true);
        assert.equal(shadow2.pfRenderRows(sid).length, 2);
        shadow2.close();
        // Session teardown cascades the render plane with the identity plane.
        h.store.pfDeleteForSession("s-cas");
        assert.equal(h.store.pfRenderRows(sid).length, 0);
        assert.equal(h.store.pfRenderCkptIntact(sid), true); // no checkpoint left = vacuously intact
    } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Golden tier: FAST emit == legacy emit at EVERY engaged turn, byte-for-byte,
// across arm → steady fast rounds → client compaction (turn 8) → audit
// cadence (fires for real at turn 10) → strategy flip (turn 14) → restart.
// No-recast ruling: the flip's byte divergence KILLS the plane at turn 14;
// every later round rides lane-dead legacy (bytes still oracle-exact), the
// stored table freezes at death, and the persisted verdict survives phase 3's
// process-restart reset (hydration refuses re-arm).
// ---------------------------------------------------------------------------

test("golden: cached-prefix splice equals the legacy full-path bytes end-to-end", async (t) => {
    const core = createCore({});
    const cfg = defaultConfig(MODEL_LIMIT);

    // ---- conversation script ------------------------------------------------
    // 16 elements e_0..e_15 arrive one per turn. From turn 8 the CLIENT body
    // drops e_1/e_3 (client-side compaction) — the lane ignores the drop
    // (ledger grows forward only), views and rows keep growing, and the
    // golden equation must still hold element-stable (ids follow elements,
    // never positions). Strategy flips text-only→none at turn 14 ⇒ caps flip
    // ⇒ forced legacy round; its bytes diverge from the stored rows ⇒ the
    // plane KILLS (no recast exists anymore) and turns 15-16 ride lane-dead.
    const ELEMENTS: Msg[] = Array.from({ length: 16 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `content number ${i}` }));
    const STABLE_ID = (i: number) => `eid-${i}`;
    const clientBody = (tn: number): Msg[] => {
        let els = ELEMENTS.slice(0, tn);
        if (tn >= 8) els = els.filter((_, i) => i !== 1 && i !== 3);
        return els;
    };
    const idsOf = (els: Msg[]) => els.map((el) => STABLE_ID(ELEMENTS.indexOf(el)));
    const strategyOf = (tn: number) => (tn < 14 ? "text-only" : "none");
    const gateSeq: string[] = [];

    // ---- phase 1: arm A — pure legacy full path over its own store ----------
    const hA = makeH("gold-a");
    let stateA: AgentState = createInitialState();
    let sidA: string | undefined;
    const goldens: { rows: string[]; decision: string }[] = [];
    for (let tn = 1; tn <= 16; tn++) {
        const body = clientBody(tn);
        const bodyText = makeBody(body);
        const v = v6Eval(hA, "s-gold-a", bodyText, idsOf(body), sidA);
        if (v.sid !== undefined) sidA = v.sid;
        const viewA = viewOf(v.outcome, bodyText);
        const tA = core.processTurn({ messages: viewA, state: stateA, config: cfg, tokenCount: 100 + viewA.length * 37, renderTags: strategyOf(tn) });
        adoptState(stateA, tA.state as unknown as AgentState);
        goldens.push({ rows: mapEgress(stripKernelSummaries(tA.messages, tA.state as never)).map((m) => JSON.stringify(m)), decision: v.outcome.decision });
        v.fin();
    }
    hA.cleanup();

    // ---- phase 2: arm B — render lane ON, replaying the identical script ----
    const hB = makeH("gold-b");
    const stateB: AgentState = createInitialState();
    const sessB = { id: "s-gold-b", state: stateB } as unknown as Session;
    let sidB: string | undefined;
    let fastRounds = 0, castOps = 0, legacyRounds = 0;
    let totalSubmittedRows = 0; // volume discipline pin (see final assert)
    let steadySubmittedRows = 0; // anti-duplicate-append pin (see final assert)
    let totalSubmittedText = 0;
    for (let tn = 1; tn <= 16; tn++) {
        const strategy = strategyOf(tn);
        const body = clientBody(tn);
        const bodyText = makeBody(body);
        const v = v6Eval(hB, "s-gold-b", bodyText, idsOf(body), sidB);
        if (v.sid !== undefined) sidB = v.sid;
        const hit = v.outcome.hit;
        const tokenCount = 100 + (hit !== null ? hit.view.length : body.length);
        const caps = capsFor(strategy);
        // Arm turn: no world exists pre-finalize ⇒ prod gate block skipped.
        const geom = sidB !== undefined ? watermarkV6DebugState("s-gold-b").worlds[sidB] : undefined;
        const gate = renderPlaneGate({
            sessionId: "s-gold-b", session: sessB, store: hB.store, engagedHit: hit !== null && v.outcome.armed === undefined,
            armedTurn: v.outcome.armed !== undefined, isTitleGen: false, sid: sidB ?? "unarmed",
            maxPos: geom?.maxPos ?? -1, tokenCount, modelContextLimit: MODEL_LIMIT, caps,
            snapshotLaneActive: false, absorbActive: false, ccrOn: false, foldUsagePending: false, markerNonZero: false,
            log: hB.log,
        });
        gateSeq.push(gate.ok ? "fast" : String(gate.reason));
        let rebuilt: OpenAIMessage[];
        let captureStrings: string[];
        let steadyAppendRows: string[] = [];
        let mode: "steady" | "legacy";
        if (gate.ok) {
            const sidNow = sidB;
            assert.ok(sidNow !== undefined, "green gate implies armed");
            assert.ok(geom, "green gate implies world geometry");
            const maxPos = geom.maxPos;
            bumpAuditTick(sidNow);
            const rw = gate.rw; const F = gate.F;
            // bounded window pass (mirrors prepare-openai.ts slot exactly)
            const posFrom = maxPos - F + 1;
            const winJson = hB.store.pfHydrateWindow(sidNow, posFrom, maxPos);
            const frozen: CoreMessage[] = [];
            for (let p = posFrom; p <= maxPos; p++) {
                const raw = winJson.get(p);
                assert.notEqual(raw, undefined, `window-core gap at pos ${p}`);
                // pf_rows.core_json holds a PLAIN CORES ARRAY per pos (an
                // element may carry several cores) — flatten + re-stamp,
                // mirroring fastpath-v6's own disk loader.
                const arr = JSON.parse(raw!) as CoreMessage[];
                for (const c of arr) frozen.push(Object.assign(c, { wireIndex: p }));
            }
            const scratch = structuredClone(stateB);
            const tW = core.processTurn({ messages: [...frozen, ...(v.outcome.hit?.windowCores ?? [])], state: scratch, config: cfg, tokenCount, renderTags: strategy });
            const liveRefs = stateB.messageRefs as unknown as { byRaw: Record<string, string>; byRef: Record<string, string> };
            const srcRefs = (scratch as AgentState).messageRefs as unknown as { byRaw: Record<string, string>; byRef: Record<string, string> };
            for (const [k, val] of Object.entries(srcRefs.byRaw)) if (!(k in liveRefs.byRaw)) liveRefs.byRaw[k] = val;
            for (const [k, val] of Object.entries(srcRefs.byRef)) if (!(k in liveRefs.byRef)) liveRefs.byRef[k] = val;
            for (const r of (scratch as AgentState).rules ?? []) if (!(stateB.rules ?? []).some((x) => x.id === r.id)) (stateB.rules ??= []).push(r);
            stateB.nextRuleId = Math.max(stateB.nextRuleId ?? 1, (scratch as AgentState).nextRuleId ?? 1);
            const pmW = stripKernelSummaries(tW.messages, tW.state as never);

            // #5643 §5 canonical-flow regime: rows store the POST-REWRITE
            // GENERIC CORE FORM — verify at that boundary, then pass the full
            // core sequence through the mapping chain fresh this turn.
            const vv = verifyRenderWindow(pmW.slice(0, F).map((m) => JSON.stringify(m)), rw, F);
            assert.equal(vv, true, `turn ${tn}: window verify failed — core form drifted vs stored rows`);
            rebuilt = mapEgress(spliceOutboundRows<CoreMessage>(rw, F, pmW));
            captureStrings = [...rw.rows.slice(0, rw.rows.length - F), ...pmW.slice(F).map((m) => JSON.stringify(m))];
            // steady-mode contract: only THIS turn's new rows are appended to
            // the plane (the slice past the F frozen window); the full list
            // stays in captureStrings for the golden equation below.
            steadyAppendRows = pmW.slice(F).map((m) => JSON.stringify(m));
            mode = "steady";
            fastRounds++;
        } else {
            // legacy full path over the engaged view (production shape)
            const tF = core.processTurn({ messages: hit !== null ? [...hit.view] : (openaiToCore(JSON.parse(bodyText) as never) as unknown as { msgs: CoreMessage[] }).msgs, state: stateB, config: cfg, tokenCount, renderTags: strategy });
            adoptState(stateB, tF.state as unknown as AgentState);
            const pmF = stripKernelSummaries(tF.messages, tF.state as never);
            const mappedAll = mapEgress(pmF);
            rebuilt = mappedAll;
            captureStrings = pmF.map((m) => JSON.stringify(m));
            mode = "legacy";
            legacyRounds++;
        }
        const srcRows = mode === "steady" ? steadyAppendRows : captureStrings;
        // Length-based deterministic stand-in for the token estimators: what
        // this tier exercises is the accumulation ALGEBRA — each row counted
        // exactly once with its own cost, tail-only deltas on steady rounds.
        const rowCost = (rs: string[]): number => rs.reduce((s, x) => s + x.length, 0);
        let op: { committed: boolean; op: "none" | "append" | "cast" | "rebase" } = { committed: false, op: "none" };
        // No-recast regime: once the lane dies, production stops paying for
        // capture strings entirely (the seam skips the station-2 commit); the
        // lane rides pure legacy until the session ends. Mirror that here.
        if (!(mode === "legacy" && !gate.ok && gate.reason === "lane-dead")) {
            op = commitRenderCapture({
                sessionId: "s-gold-b", store: hB.store, sid: sidB!, log: hB.log, mode, caps, rowStrings: srcRows,
                sums: { estCum: rowCost(srcRows), textCum: rowCost(srcRows), imgCum: 0 },
            });
        }
        totalSubmittedRows += srcRows.length;
        totalSubmittedText += rowCost(srcRows);
        if (mode === "steady") steadySubmittedRows += srcRows.length;
        if (op.committed && op.op === "cast") castOps++;
        // #5643 §5 shape pin: every stored row is POST-REWRITE CORE FORM —
        // core identity fields present, wire bytes impossible (neither field
        // exists on OpenAIMessage).
        if (op.committed) for (const s of srcRows) {
            const rowObj = JSON.parse(s) as { id?: unknown; contentType?: unknown };
            assert.equal(typeof rowObj.id, "string", "stored row must be core form, not mapped wire bytes");
            assert.equal(typeof rowObj.contentType, "string", "stored row must be core form, not mapped wire bytes");
        }
        // THE golden equation: lane emit == legacy oracle, byte for byte.
        assert.deepEqual(rebuilt.map((m) => JSON.stringify(m)), goldens[tn - 1].rows,
            `turn ${tn} (${mode}${gate.ok ? "" : `, reason=${gate.reason}`}): lane emit diverged from legacy oracle`);
        assert.equal(stateB.blocks.length, 0, "assumption pin: no folds materialize in this synthetic conv");
        v.fin(); // plane advances AFTER capture — same order as prepare-openai
        // Structural regression pin (review round 1, tail-only fix): while the
        // plane is ALIVE the render table must track the identity ledger
        // one-row-per-element at every turn boundary — a duplicate-append
        // corruption shows up here instantly instead of hiding behind the byte
        // equation. After a death the table freezes (nothing re-commits), so
        // pin the frozen invariant instead.
        const dbgNow = watermarkV6RenderDebugState("s-gold-b").sids.some((w) => w.dead);
        if (!dbgNow) {
            assert.equal(hB.store.pfRenderRows(sidB!).length, watermarkV6DebugState("s-gold-b").worlds[sidB!]!.maxPos + 1,
                `turn ${tn}: render table drifted from identity ledger (rows=${hB.store.pfRenderRows(sidB!).length})`);
        } else {
            assert.equal(hB.store.pfRenderRows(sidB!).length, 13, `turn ${tn} post-death: row table must stay frozen`);
        }
    }
    assert.equal(castOps, 1, "exactly one cast (the arm turn)");
    // Audit cadence exercised FOR REAL (review round 2): with the flip deferred
    // to turn 14, eight consecutive green rounds land tick=8 ⇒ turn 10 MUST ride
    // legacy as the scheduled audit itself, and the very next round recovers to
    // fast (any legacy full-capture zeroes the tick — a lockout would keep every
    // later turn red until restart/caps-flip/S4-heal).
    assert.deepEqual(gateSeq.filter((r) => r === "audit-due"), ["audit-due"], `expected exactly one audit-due round, got ${JSON.stringify(gateSeq)}`);
    assert.equal(gateSeq.indexOf("audit-due"), 9, `audit-due expected at loop index 9 (turn 10), got ${JSON.stringify(gateSeq)}`);
    assert.equal(gateSeq[10], "fast", `round right after the audit must recover to fast, got ${JSON.stringify(gateSeq)}`);
    // Exactly two fast waves before death: 2-9 (pre-audit) + 11-13 (post-audit).
    assert.ok(fastRounds >= 11, `expected ≥11 fast rounds (two audit waves minus the post-death rounds), got ${fastRounds}`);
    // NO-RECAST RULING pins: the API offers no recast op at all (the old
    // counter cannot even be written); the flip's divergent bytes die the
    // lane at turn 14, and every subsequent round reports the durable reason.
    assert.equal(gateSeq.indexOf("caps-mismatch"), 13, `flip red expected at loop index 13 (turn 14), got ${JSON.stringify(gateSeq)}`);
    assert.equal(gateSeq.indexOf("lane-dead"), 14, `first death report expected at loop index 14 (turn 15), got ${JSON.stringify(gateSeq)}`);
    assert.ok(legacyRounds >= 5, `arm + audit + flip + post-death rounds must ride legacy (got ${legacyRounds})`);
    // Volume discipline (steady deltas must stay O(new) per round, never
    // O(full list)): pre-tail-fix behavior re-submitted the whole list each
    // green round ⇒ ~8×final volume here.
    const finalRowCount = hB.store.pfRenderRows(sidB!).length;
    assert.equal(finalRowCount, 13, "row table froze at the death turn (no rewrite, no further commit)");
    // Volume discipline — steady rounds must stay O(new): every row enters
    // the table AT MOST ONCE via a steady append (a duplicate-append
    // corruption would push this past the table size). Legacy full lists are
    // inherent to their (rare) rounds and are not pinned.
    assert.ok(steadySubmittedRows <= finalRowCount,
        `steady-mode submissions ${steadySubmittedRows} exceeded table size ${finalRowCount} — rows must be appended at most once`);
    // S4 truth intact at the end; mirror froze together with the table
    assert.equal(hB.store.pfRenderCkptIntact(sidB!), true);
    const dbgLhs = watermarkV6RenderDebugState("s-gold-b");
    assert.ok(Array.isArray(dbgLhs.sids) && dbgLhs.sids.length > 0, "render debug state must list the mirror");
    const lastW = dbgLhs.sids[dbgLhs.sids.length - 1];
    assert.equal(lastW.dead, true, "debug state must surface the death verdict");
    assert.equal(lastW.rows, 13, "mirror row count froze at death");
    // Sums algebra pin (review P1-2): every row's cost entered the cumulative
    // ledger EXACTLY once — a frozen-window double-count would overshoot here.
    const finalRowCost = hB.store.pfRenderRows(sidB!).reduce((s, r) => s + (r.rowJson?.length ?? 0), 0);
    assert.ok(Math.abs(dbgLhs.sids[dbgLhs.sids.length - 1].textCum - finalRowCost) < Math.max(1, finalRowCost * 0.25),
        `cumulative text ledger drifted from row truth (cum=${dbgLhs.sids[dbgLhs.sids.length - 1].textCum} vs rows=${finalRowCost}; submitted=${totalSubmittedText})`);

    // ---- phase 3: restart hydration — mirrors wiped, disk must continue -----
    _resetWatermarkV6RenderTestState();
    const extraEl: Msg = { role: "user", content: "content number 16" };
    ELEMENTS.push(extraEl);
    const bodyT17 = clientBody(16).concat([extraEl]);
    const v17 = v6Eval(hB, "s-gold-b", makeBody(bodyT17), idsOf(bodyT17), sidB);
    const g17 = renderPlaneGate({
        sessionId: "s-gold-b", session: sessB, store: hB.store, engagedHit: true, armedTurn: false,
        isTitleGen: false, sid: sidB!, maxPos: watermarkV6DebugState("s-gold-b").worlds[sidB!]!.maxPos,
        tokenCount: 100, modelContextLimit: MODEL_LIMIT, caps: capsFor("none"),
        snapshotLaneActive: false, absorbActive: false, ccrOn: false, foldUsagePending: false, markerNonZero: false, log: hB.log,
    });
    // The persisted kind='dead' verdict survives the process-restart wipe:
    // hydration REFUSES to re-arm a dead plane (no-recast ruling — there is
    // no rebuild path), and the identity lane keeps working independently.
    assert.deepEqual(g17, { ok: false, reason: "lane-dead" },
        `post-restart gate must honor the persisted death verdict (got ${JSON.stringify(g17)})`);
    v17.fin();
    hB.cleanup();
});
