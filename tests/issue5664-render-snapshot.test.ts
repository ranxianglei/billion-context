// #5664 — station 2/3: outbound-row render-snapshot plane for the v6 lane.
//
// Golden equation under test: on every engaged turn the emit array built as
// [cached prefix rows] + [freshly mapped tail] (fast rounds) must be BYTE-
// IDENTICAL to what the legacy full-pipeline path emits (arm / audit /
// caps-flip rollback rounds). The kernel is untouched; this lane caches
// egress bytes, not semantics — equivalence with the full pass is the
// contract. B-version compaction semantics hold throughout: client-side
// element deletion is IGNORED by the identity plane (ledger grows forward
// only), so both arms grow identically and stay byte-comparable.
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
    bumpAuditTick, commitRenderCapture, diffRowLists, renderPlaneGate, spliceOutboundRows, verifyRenderWindow,
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
    return { v: 1, model: "m", strategy, maxDim: 1_600, toolArmed: false, droppable: false, multimodal: false };
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
    assert.equal(diffRowLists(["a", "b"], ["a", "X"]), "recast");   // middle mutation
    assert.equal(diffRowLists(["a", "b", "c"], ["a"]), "recast");   // shrink
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

test("unit: S4 checksum tamper kills the mirror (hydrate-failed, loudly logged)", (t) => {
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
        assert.deepEqual(g, { ok: false, reason: "hydrate-failed" });
    } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Golden tier: FAST emit == legacy emit at EVERY engaged turn, byte-for-byte,
// across arm → steady fast rounds → client compaction (turn 8) → strategy
// recast (turn 10) → audit cadence → restart-hydration continuation.
// ---------------------------------------------------------------------------

test("golden: cached-prefix splice equals the legacy full-path bytes end-to-end", async (t) => {
    const core = createCore({});
    const cfg = defaultConfig(MODEL_LIMIT);

    // ---- conversation script ------------------------------------------------
    // 16 elements e_0..e_15 arrive one per turn. From turn 8 the CLIENT body
    // drops e_1/e_3 (client-side compaction) — the lane ignores the drop
    // (ledger grows forward only), views and rows keep growing, and the
    // golden equation must still hold element-stable (ids follow elements,
    // never positions). Strategy flips text-only→none at turn 10 ⇒ caps flip
    // ⇒ forced legacy recast round, then steady on the new byte form.
    const ELEMENTS: Msg[] = Array.from({ length: 16 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `content number ${i}` }));
    const STABLE_ID = (i: number) => `eid-${i}`;
    const clientBody = (tn: number): Msg[] => {
        let els = ELEMENTS.slice(0, tn);
        if (tn >= 8) els = els.filter((_, i) => i !== 1 && i !== 3);
        return els;
    };
    const idsOf = (els: Msg[]) => els.map((el) => STABLE_ID(ELEMENTS.indexOf(el)));
    const strategyOf = (tn: number) => (tn < 10 ? "text-only" : "none");

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
    let fastRounds = 0, castOps = 0, recastOps = 0, legacyRounds = 0;
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
        let rebuilt: OpenAIMessage[];
        let captureStrings: string[];
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

            const mappedAll = mapEgress(pmW);
            const committedTail = mappedAll.slice(0, Math.min(F + (v.outcome.hit?.windowCores.length ?? 0), mappedAll.length));
            const vv = verifyRenderWindow(committedTail.slice(0, F).map((m) => JSON.stringify(m)), rw, F);
            if (!vv) {
                for (let k = 0; k < F; k++) {
                    const a = JSON.stringify(committedTail[k]); const b = rw.rows[rw.rows.length - F + k];

                }
            }
            assert.equal(vv, true, `turn ${tn}: window verify failed — tail bytes drifted vs stored rows`);
            rebuilt = spliceOutboundRows<OpenAIMessage>(rw, F, committedTail);
            captureStrings = [...rw.rows.slice(0, rw.rows.length - F), ...committedTail.map((m) => JSON.stringify(m))];
            mode = "steady";
            fastRounds++;
        } else {
            // legacy full path over the engaged view (production shape)
            const tF = core.processTurn({ messages: hit !== null ? [...hit.view] : (openaiToCore(JSON.parse(bodyText) as never) as unknown as { msgs: CoreMessage[] }).msgs, state: stateB, config: cfg, tokenCount, renderTags: strategy });
            adoptState(stateB, tF.state as unknown as AgentState);
            const mappedAll = mapEgress(stripKernelSummaries(tF.messages, tF.state as never));
            rebuilt = mappedAll;
            captureStrings = mappedAll.map((m) => JSON.stringify(m));
            mode = "legacy";
            legacyRounds++;
        }
        const op = commitRenderCapture({
            sessionId: "s-gold-b", store: hB.store, sid: sidB!, mode, caps, rowStrings: captureStrings,
            sums: { estCum: 0, textCum: 0, imgCum: 0 },
        });
        if (op.committed) {
            if (op.op === "cast") castOps++;
            else if (op.op === "recast") recastOps++;
        }
        // THE golden equation: lane emit == legacy oracle, byte for byte.
        assert.deepEqual(rebuilt.map((m) => JSON.stringify(m)), goldens[tn - 1].rows,
            `turn ${tn} (${mode}${gate.ok ? "" : `, reason=${gate.reason}`}): lane emit diverged from legacy oracle`);
        assert.equal(stateB.blocks.length, 0, "assumption pin: no folds materialize in this synthetic conv");
        v.fin(); // plane advances AFTER capture — same order as prepare-openai
    }
    assert.equal(castOps, 1, "exactly one cast (the arm turn)");
    assert.ok(fastRounds >= 6, `expected several fast rounds, got ${fastRounds} (audit too aggressive?)`);
    assert.ok(recastOps >= 1, "strategy flip at turn 10 must force ≥1 recast");
    assert.ok(legacyRounds >= 2, `arm + audit/caps-flip rounds must ride legacy (got ${legacyRounds})`);
    // S4 truth intact at the end; mirror agrees with the last golden shape
    assert.equal(hB.store.pfRenderCkptIntact(sidB!), true);
    const dbgLhs = watermarkV6RenderDebugState("s-gold-b");
    assert.ok(Array.isArray(dbgLhs.sids) && dbgLhs.sids.length > 0, "render debug state must list the mirror");
    const lhsRows = dbgLhs.sids[dbgLhs.sids.length - 1].rows;
    const rhsRows = goldens[goldens.length - 1].rows.length;
    assert.equal(lhsRows, rhsRows, "mirror row count must equal last golden row count");

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
    assert.ok(g17.ok === true || g17.reason === "audit-due",
        `post-restart gate must hydrate from disk (got ${JSON.stringify(g17)})`);
    if (g17.ok) assert.equal(g17.rw.rows.length, goldens.at(-1)!.rows.length, "hydrated row count must match the pre-restate capture");
    v17.fin();
    hB.cleanup();
});
