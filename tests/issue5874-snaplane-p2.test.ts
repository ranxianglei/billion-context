/**
 * #5874 P2 — mapEgress: the snap plane is the DIRECT outbound egress
 * authority (owner ruling 2026-11-11 — no per-round diff against the legacy
 * view; the legacy bytes remain only the one-round crash-grade fallback).
 *
 * Model under test:
 *   WRITE (incremental, event-level): the save carries the lane's tagged
 *   processTurn output (planeMessages = the kernel's OWN tagged view). The
 *   plane persists exactly those bytes (invariant v) — surviving rows keep
 *   their tagged form, the pinned first user stays active, covered ranges
 *   are flipped covered (rows retained for the pair-safe walk, materialized
 *   from the legacy CAS only when the plane never recorded them), each
 *   active block's rendered anchor is stored at a negative pos, and rows the
 *   host no longer presents are deleted. No diff, no fuzzy matching: a view
 *   entry is addressed to its ledger row by message id (steady state), with
 *   a tag-stripped identity fallback for the rare kernel remint edge.
 *   EGRESS (direct): the outbound view is assembled from the plane rows
 *   alone — the non-anchor rows in pos order (covered ones included, for
 *   pairing parity) walked with EXACT kernel prune/rebuild semantics
 *   (earliest-covered anchor → pair-safe → pin clamp; alias-coverage /
 *   stale-summary skips; pinned first user served),
 *   each active block's stored anchor row re-inserted at its pair-safe
 *   index — then run through the lane's transform (identical to what the
 *   lane ran on the legacy view). Byte-identical to the legacy egress by
 *   construction, because the plane rows ARE the transform input.
 *
 * Unit scope:
 *   W*  write side — seed+fold, steady-state no-op, tail append, host
 *        removal, unaddressable-entry death.
 *   E*  egress assembly — kernel-view parity, no-fold passthrough,
 *        no-plane / row-unparsable degrade, #4311 visible-compress-call
 *        skip, remint coverage via row alias (core_ids), renderAnchor fallback.
 *   G*  the gate — config off, cohort, plane miss, plane dead, and the
 *        plane being served directly regardless of the legacy bytes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SUMMARY_HEADER, type CompressionState } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { _resetSnapPlaneDeadForTests, isSnapPlaneDead, type SnapView } from "../src/storage/snap.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { _setStoreForTest, SessionStore } from "../src/persist.ts";
import type { UnifiedShadow } from "../src/storage/shadow.ts";
import {
    applySnapEgress,
    buildSnapEgressView,
    snapEgressStatusWire,
    _resetSnapEgressForTests,
    type SnapEgressProtocol,
} from "../src/server/snap-egress.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5874-p2-"));
const configPath = path.join(hermetic, "config.json");
fs.writeFileSync(configPath, "{}");
process.env.BILI_CONFIG_FILE = configPath;

function setConfig(v: unknown): void {
    fs.writeFileSync(configPath, JSON.stringify(v));
}

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function openPlane(p: string): UnifiedStore {
    return UnifiedStore.open(p, undefined, { snapBase: { enabled: true, shadowWrite: true } });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const refOf = (i: number): string => `m${String(i + 1).padStart(5, "0")}`;
const tagOf = (i: number): string => `<acp tokens="4" type="text">${refOf(i)}</acp>\n`;
const roleOf = (i: number): "user" | "assistant" => (i % 2 === 0 ? "user" : "assistant");

/** Legacy (client-resent, untagged) core message i (1-based id). */
function plainMsg(i: number): { id: string; role: "user" | "assistant"; contentType: "text"; text: string } {
    return { id: `m${i}`, role: roleOf(i - 1), contentType: "text", text: `message ${i}` };
}

/** Tagged view entry for message i (what the kernel's processTurn output
 *  carries — render-refs prepends the ref tag to the text). */
function taggedMsg(i: number): BiliMessage {
    const m = plainMsg(i);
    return { ...m, text: tagOf(i - 1) + m.text } as BiliMessage;
}

const ANCHOR_ID = "acp_summary_blk-c1";
const ANCHOR_TEXT = `${SUMMARY_HEADER} — fold topic\nfolded 1-8`;
function anchorMsg(): BiliMessage {
    return { id: ANCHOR_ID, role: "system", contentType: "text", text: ANCHOR_TEXT } as BiliMessage;
}

function session(id: string, msgs: Array<{ id: string; text: string; role?: "user" | "assistant" }>): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
        blockContents: new Map(),
        lastMessages: msgs.map((m, i) => ({
            id: m.id,
            role: (m.role ?? (i % 2 === 0 ? "user" : "assistant")) as "user" | "assistant",
            contentType: "text" as const,
            text: m.text,
        })),
        lastMessagesFolded: true,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

/** A folded session: `count` messages, block covers msgs[from..to). */
function foldedSession(
    sid: string,
    opts: { from?: number; to?: number; count?: number } = {},
): { sess: LegacySessionLike; blk: Record<string, unknown>; msgs: Array<{ id: string; text: string }> } {
    const { from = 0, to = 8, count = 12 } = opts;
    const msgs = Array.from({ length: count }, (_, i) => ({ id: `m${i + 1}`, text: `message ${i + 1}` }));
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    msgs.forEach((m, i) => {
        byRaw[m.id] = refOf(i);
        byRef[refOf(i)] = m.id;
    });
    const blk = {
        blockId: "blk-c1",
        runId: 1,
        createdAt: 1_000,
        tier: 1,
        active: true,
        summary: "folded 1-8",
        topic: "fold topic",
        kind: "fold",
        reason: "test",
        effectiveMessageIds: msgs.slice(from, to).map((m) => m.id),
        directMessageIds: [] as string[],
    };
    const sess = session(sid, msgs);
    sess.state = { blocks: [blk as never], nextBlockId: 2, nextRunId: 2, messageRefs: { byRaw, byRef } };
    return { sess, blk, msgs };
}

/** The kernel's tagged processTurn output for the folded session: pinned
 *  first user, the rendered anchor, then the surviving tail. */
function foldedView(count = 12): BiliMessage[] {
    return [taggedMsg(1), anchorMsg(), ...Array.from({ length: count - 8 }, (_, i) => taggedMsg(9 + i))];
}

function stateFor(blk: Record<string, unknown>): CompressionState {
    return { blocks: [blk as never], messageRefs: { byRaw: {}, byRef: {} } } as unknown as CompressionState;
}

const NO_COMPRESS = (name: string): boolean => name === "compress";

function egressRows(store: UnifiedStore, sid: string): SnapView["rows"] {
    const view = store.snapEgressView(sid);
    assert.ok(view, "the plane must have rows after ingest");
    return view.rows;
}

/** G-tests: the egress reads the plane through getStore() (a SessionStore),
 *  so register one whose sidecar wraps the store under test. SessionStore's
 *  replicasAvailable() reads shadow.stats.disabled and the read path only
 *  calls snapEgressView, so a minimal UnifiedShadow-shaped wrapper over the
 *  raw UnifiedStore is sufficient (private ctor — no public seam exists). */
function registerStore(store: UnifiedStore): void {
    const shadow = {
        stats: { disabled: false },
        snapEgressView: (sid: string) => store.snapEgressView(sid),
    } as unknown as UnifiedShadow;
    _setStoreForTest(new SessionStore({ enabled: true, shadow, log: () => {} }));
}

test.beforeEach(() => {
    _resetSnapEgressForTests();
    _resetSnapPlaneDeadForTests();
    setConfig({});
});

// ---------------------------------------------------------------------------
// W* — write side: incremental event-level persistence of the tagged view
// ---------------------------------------------------------------------------

test("W1 seed+fold: surviving rows tagged, covered flipped, anchor at negative pos, A/B green", () => {
    const store = openPlane(path.join(tmpDir("bili-5874-w1-"), "index.db"));
    const sid = "w1";
    const { sess, msgs } = foldedSession(sid);
    sess.lastPlaneMessages = foldedView();
    store.ingestSession(planIngest(sess));

    // The fold is committed and the structural A/B check did NOT kill the
    // plane (pin row stays active inside the covered interval).
    assert.equal(isSnapPlaneDead(sid), false, "fold must pass the structural A/B check");

    const rows = egressRows(store, sid);
    const byPos = new Map(rows.map((r) => [r.pos, r]));
    assert.equal(rows.length, 13, "12 ledger rows + 1 anchor row");
    // Anchor row at the most-negative pos, active, kernel's own bytes.
    assert.equal(byPos.get(-1)!.active, 1);
    assert.equal(byPos.get(-1)!.postJson, JSON.stringify(anchorMsg()));
    assert.ok(byPos.get(-1)!.coreIds.includes(ANCHOR_ID));
    // Pinned first user: active, tagged bytes.
    assert.equal(byPos.get(0)!.active, 1);
    assert.equal(byPos.get(0)!.postJson, JSON.stringify(taggedMsg(1)));
    // Covered rows: retained (pair-safe walk needs them), flipped covered,
    // legacy bytes (they were never in the tagged view).
    for (let i = 2; i <= 8; i++) {
        const r = byPos.get(i - 1)!;
        assert.equal(r.active, 0, `row ${i - 1} covered`);
        assert.equal(r.coverRef, "blk-c1");
        assert.equal(r.postJson, JSON.stringify(plainMsg(i)));
    }
    // Surviving tail: active, tagged bytes.
    for (let i = 9; i <= 12; i++) {
        const r = byPos.get(i - 1)!;
        assert.equal(r.active, 1);
        assert.equal(r.postJson, JSON.stringify(taggedMsg(i)));
    }
});

test("W2 steady state: an identical tagged save is a no-op (no rewrites, no new fold point)", () => {
    const store = openPlane(path.join(tmpDir("bili-5874-w2-"), "index.db"));
    const sid = "w2";
    const { sess } = foldedSession(sid);
    sess.lastPlaneMessages = foldedView();
    store.ingestSession(planIngest(sess));
    const snap1 = JSON.stringify(egressRows(store, sid));
    const stats1 = store.sessionStorageStats(sid).rows;
    assert.equal(stats1.snapRows, 13, "seed must materialize the plane");
    assert.ok(stats1.snapCkpts >= 1, "the seed fold must checkpoint");

    const sess2 = foldedSession(sid).sess;
    sess2.lastPlaneMessages = foldedView();
    store.ingestSession(planIngest(sess2));
    const stats2 = store.sessionStorageStats(sid).rows;
    assert.equal(JSON.stringify(egressRows(store, sid)), snap1, "steady-state save must not rewrite rows");
    assert.equal(stats2.snapCkpts, stats1.snapCkpts, "a no-op round must not add a fold point");
});

test("W3 tail append: new tail rows are cast tagged, nothing else changes", () => {
    const store = openPlane(path.join(tmpDir("bili-5874-w3-"), "index.db"));
    const sid = "w3";
    const { sess } = foldedSession(sid);
    sess.lastPlaneMessages = foldedView();
    store.ingestSession(planIngest(sess));

    // Next turn: two more messages, no new fold.
    const { sess: sess2 } = foldedSession(sid, { count: 14 });
    sess2.lastPlaneMessages = foldedView(14);
    store.ingestSession(planIngest(sess2));

    const rows = egressRows(store, sid);
    const byPos = new Map(rows.map((r) => [r.pos, r]));
    assert.equal(byPos.get(12)!.active, 1);
    assert.equal(byPos.get(12)!.postJson, JSON.stringify(taggedMsg(13)));
    assert.equal(byPos.get(13)!.active, 1);
    assert.equal(byPos.get(13)!.postJson, JSON.stringify(taggedMsg(14)));
    // The earlier rows are untouched.
    assert.equal(byPos.get(0)!.postJson, JSON.stringify(taggedMsg(1)));
    assert.equal(byPos.get(-1)!.postJson, JSON.stringify(anchorMsg()));
});

test("W4 host removal: an active row the view no longer presents is deleted", () => {
    const store = openPlane(path.join(tmpDir("bili-5874-w4-"), "index.db"));
    const sid = "w4";
    const { sess } = foldedSession(sid);
    sess.lastPlaneMessages = foldedView();
    store.ingestSession(planIngest(sess));

    // Host edit: m11 drops out of the transcript (and the tagged view).
    const { sess: sess2 } = foldedSession(sid);
    sess2.lastMessages = sess2.lastMessages!.filter((m) => m.id !== "m11");
    sess2.lastPlaneMessages = foldedView().filter((m) => m.id !== "m11");
    store.ingestSession(planIngest(sess2));

    const byPos = new Map(egressRows(store, sid).map((r) => [r.pos, r]));
    // Host-removed rows are physically GC'd (cover_ref='deleted' is the GC
    // marker; only BLOCK-covered rows are retained for the pair-safe walk).
    assert.equal(byPos.get(10), undefined, "m11 row GC'd");
    // Everything else intact.
    assert.equal(byPos.get(0)!.active, 1);
    assert.equal(byPos.get(9)!.active, 1, "m10 still active");
    assert.equal(byPos.get(11)!.active, 1, "m12 still active");
});

test("W5 unaddressable view entry: the save latches the sid dead, legacy keeps the round", () => {
    const store = openPlane(path.join(tmpDir("bili-5874-w5-"), "index.db"));
    const sid = "w5";
    const { sess } = foldedSession(sid);
    // A view entry with no live ledger row: not by id, not by identity.
    sess.lastPlaneMessages = [
        ...foldedView(),
        { id: "ghost-msg", role: "assistant", contentType: "text", text: "a content no legacy row carries" } as BiliMessage,
    ];
    store.ingestSession(planIngest(sess));

    assert.equal(isSnapPlaneDead(sid), true, "unaddressable entry must latch the sid dead");
});

// ---------------------------------------------------------------------------
// E* — egress assembly: kernel prune/rebuild parity over the plane rows
// ---------------------------------------------------------------------------

test("E1 folded plane: egress output is byte-identical to the kernel's tagged view", () => {
    const store = openPlane(path.join(tmpDir("bili-5874-e1-"), "index.db"));
    const sid = "e1";
    const { sess, blk } = foldedSession(sid);
    sess.lastPlaneMessages = foldedView();
    store.ingestSession(planIngest(sess));

    const out = buildSnapEgressView(store.snapEgressView(sid)!, stateFor(blk), NO_COMPRESS);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual(
        out.msgs.map((m) => JSON.stringify(m)),
        foldedView().map((m) => JSON.stringify(m)),
        "the egress view must equal the kernel's tagged view, byte for byte",
    );
});

test("E2 no fold: the plane rows are served verbatim in pos order", () => {
    const store = openPlane(path.join(tmpDir("bili-5874-e2-"), "index.db"));
    const sid = "e2";
    const sess = session(sid, Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, text: `message ${i + 1}`, role: roleOf(i) })));
    const view = Array.from({ length: 12 }, (_, i) => taggedMsg(i + 1));
    sess.lastPlaneMessages = view;
    store.ingestSession(planIngest(sess));

    const out = buildSnapEgressView(store.snapEgressView(sid)!, { blocks: [] } as unknown as CompressionState, NO_COMPRESS);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual(
        out.msgs.map((m) => JSON.stringify(m)),
        view.map((m) => JSON.stringify(m)),
    );
});

test("E3 empty plane: no-plane degrade", () => {
    const out = buildSnapEgressView({ rows: [] } as unknown as SnapView, { blocks: [] } as unknown as CompressionState, NO_COMPRESS);
    assert.deepEqual(out, { ok: false, reason: "no-plane" });
});

test("E4 corrupt row: row-unparsable degrade", () => {
    const view = {
        rows: [{ pos: 0, coreIds: ["m1"], preJson: null, postJson: "{not-json", tokensEst: 1, active: 1, coverRef: null, rowSum: 1 }],
    } as unknown as SnapView;
    const out = buildSnapEgressView(view, { blocks: [] } as unknown as CompressionState, NO_COMPRESS);
    assert.deepEqual(out, { ok: false, reason: "row-unparsable" });
});

test("E5 #4311: a visible compress tool-call suppresses its block's summary render", () => {
    // The kernel's own tagged output for this fold: the block covers m1..m3,
    // the first-user pin m1 survives, the visible compress call m4 (the wire
    // evidence of the fold) and the live tail m5 remain — and #4311
    // suppressed the separate summary render, so NO anchor entry. The plane
    // persists exactly that (invariant v): m1/m4/m5 active, m2/m3 compacted.
    const compressCall: BiliMessage = {
        id: "m4",
        role: "assistant",
        contentType: "tool-call",
        text: "",
        toolCallId: "tc-1",
        toolName: "compress",
    } as BiliMessage;
    const view = {
        rows: [
            { pos: 0, coreIds: ["m1"], preJson: null, postJson: JSON.stringify(taggedMsg(1)), tokensEst: 1, active: 1, coverRef: null, rowSum: 1 },
            { pos: 1, coreIds: ["m2"], preJson: null, postJson: JSON.stringify(plainMsg(2)), tokensEst: 1, active: 0, coverRef: "blk-c1", rowSum: 1 },
            { pos: 2, coreIds: ["m3"], preJson: null, postJson: JSON.stringify(plainMsg(3)), tokensEst: 1, active: 0, coverRef: "blk-c1", rowSum: 1 },
            { pos: 3, coreIds: ["m4"], preJson: null, postJson: JSON.stringify(compressCall), tokensEst: 1, active: 1, coverRef: null, rowSum: 1 },
            { pos: 4, coreIds: ["m5"], preJson: null, postJson: JSON.stringify(taggedMsg(5)), tokensEst: 1, active: 1, coverRef: null, rowSum: 1 },
        ],
    } as unknown as SnapView;
    const blk = {
        blockId: "blk-c1",
        active: true,
        summary: "folded",
        effectiveMessageIds: ["m1", "m2", "m3"],
        directMessageIds: [],
        compressCallId: "tc-1",
    };
    const out = buildSnapEgressView(view, stateFor(blk), NO_COMPRESS);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    // The visible call suppresses the block's separate summary render —
    // the plane serves pin + call + tail verbatim, no anchor.
    assert.deepEqual(
        out.msgs.map((m) => m.id),
        ["m1", "m4", "m5"],
    );
});

test("E6 remint: a reminted id is covered through its ALIAS (core_ids keeps the old id)", () => {
    const m1 = { id: "m1", role: "user" as const, contentType: "text" as const, text: "message 1" };
    // Post-remint plane: the block's effIds still carry the OLD ids (m2..m4
    // — or the reconcile re-keyed them to the client's re-minted forms), but
    // the covered run is read from the rows' OWN cover_ref, so no id
    // resolution is involved. m2 was re-appended under its reminted id m2_k2
    // (core_ids keeps the old alias); all three covered rows are inactive.
    const m2k = { id: "m2_k2", role: "assistant" as const, contentType: "text" as const, text: "message 2" };
    const m3 = { id: "m3", role: "assistant" as const, contentType: "text" as const, text: "message 3" };
    const m4 = { id: "m4", role: "assistant" as const, contentType: "text" as const, text: "message 4" };
    const view = {
        rows: [
            { pos: 0, coreIds: ["m1"], preJson: null, postJson: JSON.stringify(m1), tokensEst: 1, active: 1, coverRef: null, rowSum: 1 },
            { pos: 1, coreIds: ["m2_k2", "m2"], preJson: null, postJson: JSON.stringify(m2k), tokensEst: 1, active: 0, coverRef: "blk-c1", rowSum: 1 },
            { pos: 2, coreIds: ["m3"], preJson: null, postJson: JSON.stringify(m3), tokensEst: 1, active: 0, coverRef: "blk-c1", rowSum: 1 },
            { pos: 3, coreIds: ["m4"], preJson: null, postJson: JSON.stringify(m4), tokensEst: 1, active: 0, coverRef: "blk-c1", rowSum: 1 },
        ],
    } as unknown as SnapView;
    // The block's ids do NOT resolve against any active row — coverage must
    // come from cover_ref alone, and the anchor takes the first row above
    // the covered run (after the pinned first user).
    const blk = {
        blockId: "blk-c1",
        active: true,
        summary: "folded",
        effectiveMessageIds: ["m2", "m3", "m4"],
        directMessageIds: [],
        startSeq: -1,
        endSeq: -1,
    };
    const out = buildSnapEgressView(view, stateFor(blk), NO_COMPRESS);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual(
        out.msgs.map((m) => m.id),
        ["m1", ANCHOR_ID],
        "pin first, anchor after the covered run, covered rows skipped",
    );
});

test("E7 anchor row missing from the plane: renderAnchor fallback is byte-parity", () => {
    const store = openPlane(path.join(tmpDir("bili-5874-e7-"), "index.db"));
    const sid = "e7";
    const { sess, blk } = foldedSession(sid);
    sess.lastPlaneMessages = foldedView();
    store.ingestSession(planIngest(sess));

    // Drop the anchor row from the egress view (degenerate plane).
    const full = store.snapEgressView(sid)!;
    const degenerate = { ...full, rows: full.rows.filter((r) => r.pos >= 0) };
    const out = buildSnapEgressView(degenerate, stateFor(blk), NO_COMPRESS);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    const expected = foldedView().map((m) => JSON.stringify(m));
    assert.deepEqual(out.msgs.map((m) => JSON.stringify(m)), expected, "the fallback render must match the stored anchor bytes");
});

// ---------------------------------------------------------------------------
// G* — the gate: direct authority with the one-round crash-grade fallback
// ---------------------------------------------------------------------------

test("G1 config off: the legacy bytes are served", () => {
    const dir = tmpDir("bili-5874-g1-");
    const store = openPlane(path.join(dir, "index.db"));
    registerStore(store);
    const sid = "g1";
    const { sess, blk } = foldedSession(sid);
    sess.lastPlaneMessages = foldedView();
    store.ingestSession(planIngest(sess));

    setConfig({ storage: { snapBase: { egress: false } } });
    const legacy = [taggedMsg(99)];
    const out = applySnapEgress(stateFor(blk), legacy, {
        sessionId: sid,
        protocol: "openai",
        log: (_l: string, _m: string) => {},
        transform: (m: BiliMessage[]) => m,
    });
    assert.equal(out, legacy, "gate off must return the legacy array verbatim");
    assert.equal(snapEgressStatusWire().plane, 0);
});

test("G2 cohort: a protocol outside egressCohorts serves the legacy bytes", () => {
    const dir = tmpDir("bili-5874-g2-");
    const store = openPlane(path.join(dir, "index.db"));
    registerStore(store);
    const sid = "g2";
    const { sess, blk } = foldedSession(sid);
    sess.lastPlaneMessages = foldedView();
    store.ingestSession(planIngest(sess));

    // egress: true is explicit now (opt-in since the 2026-11-13 soak revert);
    // this test exercises COHORT exclusion, not the master opt-in gate.
    setConfig({ storage: { snapBase: { egress: true, egressCohorts: ["anthropic"] } } });
    const legacy = [taggedMsg(99)];
    const out = applySnapEgress(stateFor(blk), legacy, {
        sessionId: sid,
        protocol: "openai",
        log: (_l: string, _m: string) => {},
        transform: (m: BiliMessage[]) => m,
    });
    assert.equal(out, legacy);
    assert.equal(snapEgressStatusWire().plane, 0);
});

test("G3 plane miss: an sid the plane never recorded serves the legacy bytes", () => {
    const dir = tmpDir("bili-5874-g3-");
    const store = openPlane(path.join(dir, "index.db"));
    registerStore(store);
    setConfig({ storage: { snapBase: { egress: true } } });
    const legacy = [taggedMsg(99)];
    const out = applySnapEgress({ blocks: [] } as unknown as CompressionState, legacy, {
        sessionId: "never-ingested",
        protocol: "openai",
        log: (_l: string, _m: string) => {},
        transform: (m: BiliMessage[]) => m,
    });
    assert.equal(out, legacy);
    assert.equal(snapEgressStatusWire().planeMiss, 1);
});

test("G4 plane dead: a latched sid serves the legacy bytes", () => {
    const dir = tmpDir("bili-5874-g4-");
    const store = openPlane(path.join(dir, "index.db"));
    registerStore(store);
    const sid = "g4";
    const { sess } = foldedSession(sid);
    sess.lastPlaneMessages = [
        ...foldedView(),
        { id: "ghost-msg", role: "assistant", contentType: "text", text: "no legacy row" } as BiliMessage,
    ];
    store.ingestSession(planIngest(sess)); // latches dead
    setConfig({ storage: { snapBase: { egress: true } } });

    const legacy = [taggedMsg(99)];
    const out = applySnapEgress({ blocks: [] } as unknown as CompressionState, legacy, {
        sessionId: sid,
        protocol: "openai",
        log: (_l: string, _m: string) => {},
        transform: (m: BiliMessage[]) => m,
    });
    assert.equal(out, legacy);
    assert.equal(snapEgressStatusWire().plane, 0);
    assert.equal(snapEgressStatusWire().planeMiss, 0, "dead is not a miss");
});

test("G5 direct authority: the plane is served regardless of the legacy bytes", () => {
    const dir = tmpDir("bili-5874-g5-");
    const store = openPlane(path.join(dir, "index.db"));
    registerStore(store);
    const sid = "g5";
    const { sess, blk } = foldedSession(sid);
    sess.lastPlaneMessages = foldedView();
    store.ingestSession(planIngest(sess));
    setConfig({ storage: { snapBase: { egress: true } } });

    const legacy = [{ id: "sentinel", role: "user", contentType: "text", text: "not served" } as BiliMessage];
    const out = applySnapEgress(stateFor(blk), legacy, {
        sessionId: sid,
        protocol: "openai",
        log: (_l: string, _m: string) => {},
        transform: (m: BiliMessage[]) => m.map((x) => ({ ...x, text: `X${x.text}` })),
    });
    const wire = snapEgressStatusWire();
    assert.equal(wire.plane, 1);
    assert.equal(wire.degrade, 0);
    // The plane view, through the lane transform — never the legacy bytes.
    assert.deepEqual(
        out.map((m) => JSON.stringify(m)),
        foldedView().map((m) => JSON.stringify({ ...m, text: `X${m.text}` })),
    );
    assert.ok(!out.some((m) => m.id === "sentinel"));
});
