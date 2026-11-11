/**
 * #5874 2×2 — stage-0 identity enrollment (M1/M2 inbound) + seed/delta
 * egress (M1–M4 outbound), acceptance items from the brief (comment
 * 19544722, tracking #6181).
 *
 *   M1 full-inbound + snapshot egress   (the #5901 behavior, extended)
 *   M2 incremental-inbound + snapshot   (this PR: matchAppend + seqs carrier)
 *   M3 incremental-inbound + delta      (this PR: selectOutbound, responses)
 *   M4 full-inbound + delta             (this PR: selectOutbound, responses)
 *
 * Unit scope (the lane wiring is e2e-verified by CI; these are the brief's
 * acceptance pins 1–8 + the red-gate matrix):
 *   W*  the world verdicts — echo/probe/scatter/issue/diverge/resync ± pairs
 *       (acceptance 5), the B1 origin-immutability trap, matchAppend.
 *   A*  assembly — #2 M1-vs-M2 kernel-input byte identity, T5 scattered NEW
 *       (acceptance 4), #7 resync one-round convergence (acceptance 7),
 *       R4 table-gap throw, anchor placement.
 *   D*  delta egress — #8 seed/delta/no-op pins (acceptance 8).
 *   R*  red gates — R3 identity fault (400 + zero side effects + breaker),
 *       R2 diverge zero side effects.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BiliMessage } from "acp-kernel/wire";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import {
    matchWorld,
    matchAppend,
} from "../src/snapshot/identity.ts";
import type { WorldEnvelopeEntry, WorldDecision } from "../src/snapshot/types.ts";
import { envelopeChecksum } from "../src/snapshot/checksums.ts";
import {
    assembleKernelInput,
    shouldResync,
} from "../src/snapshot/assemble.ts";
import {
    selectOutbound,
    isFullResend,
    type EgressElement,
    type DeltaState,
} from "../src/snapshot/delta.ts";
import {
    FoundationRejectError,
    R3FaultTracker,
    checkR3Identity,
    stage0Decide,
} from "../src/snapshot/plane.ts";
import { snapL1Lookup, snapL1EnvelopeRead, snapL1Record } from "../src/storage/snap.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5874-p3-"));
const configPath = path.join(hermetic, "config.json");
fs.writeFileSync(configPath, "{}");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type StoredCanon = {
    ledgerId: string;
    envelope: WorldEnvelopeEntry[];
    envelopeChecksum: string;
    issuedAt: number;
    armedAt?: number;
};

interface WorldMatchInputLocal {
    stored: StoredCanon | null;
    incoming: string[];
    explainedGone?: Set<string>;
    sessRaw: string;
    ledgerId: string;
    now: number;
    resync?: boolean;
}

const now0 = 1_700_000_000_000;

/** A stored element envelope (canon) for ids 0..n-1 (1-based ids m1..
 *  1-based pos, the issue/resync shape). */
function canon(n: number): StoredCanon {
    const ids = Array.from({ length: n }, (_, i) => `m${i + 1}`);
    return {
        ledgerId: "sid-t",
        envelope: ids.map((id, i) => ({ id, pos: i + 1 })),
        envelopeChecksum: envelopeChecksum(ids),
        issuedAt: now0,
    };
}

function matchInput(stored: StoredCanon | null, incoming: string[], extra: Partial<WorldMatchInputLocal> = {}): WorldMatchInputLocal {
    return {
        stored,
        incoming,
        sessRaw: "sess-t",
        ledgerId: "sid-t",
        now: now0 + 1,
        ...extra,
    };
}

function openPlane(p: string): UnifiedStore {
    return UnifiedStore.open(p, undefined, { snapBase: { enabled: true, shadowWrite: true } });
}

/** A plain (untagged) core message — the lane's converted form. */
function core(i: number, id?: string): BiliMessage {
    return {
        id: id ?? `m${i}`,
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        contentType: "text",
        text: `message ${i}`,
    } as BiliMessage;
}

function plainSession(id: string, n: number): LegacySessionLike {
    const msgs = Array.from({ length: n }, (_, i) => ({
        id: `m${i + 1}`,
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        contentType: "text" as const,
        text: `message ${i + 1}`,
    }));
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    msgs.forEach((m, i) => {
        byRaw[m.id] = `m${String(i + 1).padStart(5, "0")}`;
        byRef[`m${String(i + 1).padStart(5, "0")}`] = m.id;
    });
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw, byRef } },
        blockContents: new Map(),
        lastMessages: msgs,
        lastMessagesFolded: true,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

// ---------------------------------------------------------------------------
// W — the world verdicts (acceptance 5: each verdict with paired +/- tests)
// ---------------------------------------------------------------------------

test("W1 echo: the same envelope checksums → echo, canon untouched, B1 origin frozen", () => {
    const stored = canon(4);
    const ids = stored.envelope.map((e) => e.id);
    const d = matchWorld(matchInput(stored, ids));
    assert.equal(d.mode, "echo");
    assert.deepEqual(d.newIdPos, []);
    assert.deepEqual(d.goneIds, []);
    assert.equal(d.issuedAt, now0, "B1: the origin never moves on echo");
    assert.equal(d.envelopeChecksum, stored.envelopeChecksum);
});

test("W2 echo +/- : one id changed → NOT echo (the checksum is content-binding)", () => {
    const stored = canon(4);
    const d = matchWorld(matchInput(stored, ["m1", "m2", "m3", "mX"]));
    assert.notEqual(d.mode, "echo");
    // mX is a new interleaved span (the head is stable, survivor order holds)
    // → scatter; the replaced m4 is reported gone (reconcile: delete).
    assert.equal(d.mode, "scatter");
    assert.deepEqual(d.newIdPos, [{ id: "mX", pos: 5 }]);
    assert.deepEqual(d.goneIds, ["m4"]);
});

test("W3 probe: a tail extension → probe, fresh pos at maxPos+1", () => {
    const d = matchWorld(matchInput(canon(4), ["m1", "m2", "m3", "m4", "m5"]));
    assert.equal(d.mode, "probe");
    assert.deepEqual(d.newIdPos, [{ id: "m5", pos: 5 }]);
    assert.deepEqual(d.goneIds, []);
});

test("W4 probe +/- : the extension with a GAP in the middle → scatter", () => {
    const d = matchWorld(matchInput(canon(4), ["m1", "m2", "NEW", "m3", "m4"]));
    assert.equal(d.mode, "scatter", "an interleaved new id is a scatter, not a probe");
    assert.deepEqual(d.newIdPos, [{ id: "NEW", pos: 5 }]);
});

test("W5 issue: no stored canon → issue, fresh pos 0.., armed now", () => {
    const d = matchWorld(matchInput(null, ["a", "b"]));
    assert.equal(d.mode, "issue");
    assert.deepEqual(d.newIdPos, [{ id: "a", pos: 1 }, { id: "b", pos: 2 }]);
    assert.equal(d.armedAt, now0 + 1, "the issue arms the lane now");
});

test("W6 issue +/- : resync with a stored canon → re-issue pos 1.. from the client array", () => {
    const d = matchWorld(matchInput(canon(3), ["x", "y", "z"], { resync: true }));
    assert.equal(d.mode, "resync");
    assert.deepEqual(d.newIdPos, [{ id: "x", pos: 1 }, { id: "y", pos: 2 }, { id: "z", pos: 3 }]);
});

test("W7 diverge: head moved → diverge, canon untouched", () => {
    const d = matchWorld(matchInput(canon(4), ["OTHER", "m1", "m2", "m3"]));
    assert.equal(d.mode, "diverge");
    assert.equal(d.witness, "head m1 -> OTHER; orderBroken=false");
});

test("W8 diverge: survivor order broken → diverge", () => {
    const d = matchWorld(matchInput(canon(4), ["m1", "m3", "m2", "m4"]));
    assert.equal(d.mode, "diverge");
    assert.equal(d.witness, "head m1 -> m1; orderBroken=true");
});

test("W9 diverge +/- : a fold-explained gone at the head is NOT a head move", () => {
    const d = matchWorld(matchInput(canon(4), ["m2", "m3", "m4"], { explainedGone: new Set(["m1"]) }));
    assert.notEqual(d.mode, "diverge");
    assert.equal(d.mode, "probe", "the shrink with a fold-explained gone is a deletions-only probe");
    assert.deepEqual(d.goneIds, ["m1"]);
});

test("W10 matchAppend: pure M2 addition — canon order preserved, whole-sequence checksum", () => {
    const stored = canon(4);
    const d = matchAppend(stored, ["m5", "m6"]);
    assert.equal(d.mode, "probe");
    assert.deepEqual(
        d.envelope.map((e) => [e.id, e.pos]),
        [["m1", 1], ["m2", 2], ["m3", 3], ["m4", 4], ["m5", 5], ["m6", 6]],
    );
    assert.deepEqual(d.newIdPos, [{ id: "m5", pos: 5 }, { id: "m6", pos: 6 }]);
    // The next M1 full resend (all six ids) must ECHO against this canon.
    assert.equal(d.envelopeChecksum, envelopeChecksum(["m1", "m2", "m3", "m4", "m5", "m6"]));
    assert.equal(d.issuedAt, now0, "B1: the origin never moves on extend");
});

test("W11 matchAppend +/- : the next M1 full resend echoes (the round-trip)", () => {
    const stored = canon(4);
    const app = matchAppend(stored, ["m5"]);
    const d = matchWorld(matchInput(
        { ...stored, envelopeChecksum: app.envelopeChecksum, envelope: app.envelope },
        ["m1", "m2", "m3", "m4", "m5"],
    ));
    assert.equal(d.mode, "echo");
});

// ---------------------------------------------------------------------------
// A — assembly (acceptance 2, 4, 7 + R4 + anchors)
// ---------------------------------------------------------------------------

function storeWithRows(n: number, sid: string): UnifiedStore {
    const store = openPlane(path.join(hermetic, `a-${sid}-${n}`, "index.db"));
    store.ingestSession(planIngest(plainSession(sid, n)));
    return store;
}

test("A1 #2 M1 vs M2: same turn, full-inbound vs incremental-inbound kernel input byte-identical", () => {
    const sid = "a1";
    const store = storeWithRows(10, sid);
    const cores = store.snapStage0Cores(sid);
    assert.equal(cores.rows.length, 10);

    const newCore = core(11);
    const rowCores = cores.rows.map((r) => ({ pos: r.pos, ids: r.ids, msg: JSON.parse(r.postJson) as BiliMessage }));
    const ten = Array.from({ length: 10 }, (_, i) => `m${i + 1}`);

    // Seed the world (first turn: the client's full array of 10).
    const seed = store.snapStage0(sid, ten);
    assert.equal(seed.decision.mode, "issue");

    // M1: the client full-resends all 11 (the plane holds 10 → the 11th is
    // the only new span). seqs present but the array is NOT all-unknown →
    // the matchWorld path (probe/scatter), new id appended.
    const m1 = store.snapStage0(sid, [...ten, newCore.id], { seqs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
    assert.equal(m1.decision.mode, "probe");
    assert.deepEqual(m1.decision.newIdPos, [{ id: "m11", pos: 11 }]);
    const asm1 = assembleKernelInput({ decision: m1.decision, rows: rowCores, newCores: [newCore] });

    // A FRESH store for the M2 leg (the same plane state, a different client
    // behavior on the SAME turn): the client sends ONLY the new element,
    // with the seqs carrier locating it after the plane frontier (10).
    const store2 = storeWithRows(10, sid);
    // Enroll the canon first (the M2 branch requires a stored canon): the
    // seed turn was the M1 full resend of 10.
    store2.snapStage0(sid, ten);
    const m2 = store2.snapStage0(sid, [newCore.id], { seqs: [11] });
    assert.equal(m2.decision.mode, "probe", "a contiguous all-unknown seqs run is the M2 append");
    assert.deepEqual(m2.decision.newIdPos, [{ id: "m11", pos: 11 }]);
    const cores2 = store2.snapStage0Cores(sid);
    const asm2 = assembleKernelInput({
        decision: m2.decision,
        rows: cores2.rows.map((r) => ({ pos: r.pos, ids: r.ids, msg: JSON.parse(r.postJson) as BiliMessage })),
        newCores: [newCore],
    });

    assert.equal(asm1.oldCount, 10);
    assert.equal(asm2.oldCount, 10);
    assert.equal(
        JSON.stringify(asm1.kernelInput),
        JSON.stringify(asm2.kernelInput),
        "#2: the assembled kernel input cores are byte-identical (M1 vs M2)",
    );
});

test("A1b #2 +/- : the M2 branch REQUIRES the seqs carrier (no seqs → matchWorld path)", () => {
    const sid = "a1b";
    const store = storeWithRows(10, sid);
    store.snapStage0(sid, Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
    // All-unknown WITHOUT seqs: a full (re-minted) envelope → matchWorld →
    // the old canon ids are gone → head moved → diverge (never guess).
    const d = store.snapStage0(sid, ["m11"]);
    assert.equal(d.decision.mode, "diverge");
});

test("A1c #2 +/- : a non-contiguous seqs run falls back to matchWorld", () => {
    const sid = "a1c";
    const store = storeWithRows(10, sid);
    store.snapStage0(sid, Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
    const d = store.snapStage0(sid, ["m11"], { seqs: [15] });
    assert.notEqual(d.decision.mode, "probe", "seqs[0]=15 != frontier+1=11 → not the M2 append");
});

test("A2 T5: a scattered NEW span lands at its CONVERSATION position (envelope order, not pos order)", () => {
    const sid = "a2";
    const store = storeWithRows(10, sid);
    const ten = Array.from({ length: 10 }, (_, i) => `m${i + 1}`);
    store.snapStage0(sid, ten); // seed (issue)
    const d = store.snapStage0(sid, ["m1", "m2", "m3", "NEW", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]);
    assert.equal(d.decision.mode, "scatter");
    assert.deepEqual(d.decision.newIdPos, [{ id: "NEW", pos: 11 }]);
    const cores = store.snapStage0Cores(sid);
    const newCore = { ...core(1), id: "NEW", text: "edited message" } as BiliMessage;
    const asm = assembleKernelInput({
        decision: d.decision,
        rows: cores.rows.map((r) => ({ pos: r.pos, ids: r.ids, msg: JSON.parse(r.postJson) as BiliMessage })),
        newCores: [newCore],
    });
    const ids = asm.kernelInput.map((m) => m.id);
    assert.deepEqual(ids, ["m1", "m2", "m3", "NEW", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]);
    assert.equal(asm.kernelInput[3]!.text, "edited message");
    assert.equal(asm.oldCount, 10);
});

test("A3 R4: an envelope element that is neither new nor a plane row → throw (table gap)", () => {
    const stored = canon(4);
    const d = matchWorld(matchInput(stored, ["m1", "m2", "m3", "m4", "m5"]));
    // Only rows 1-3 exist (the table is behind the client).
    assert.throws(
        () =>
            assembleKernelInput({
                decision: d,
                rows: [
                    { pos: 0, ids: ["m1"], msg: core(1) },
                    { pos: 1, ids: ["m2"], msg: core(2) },
                    { pos: 2, ids: ["m3"], msg: core(3) },
                ],
                newCores: [core(5, "m5")],
            }),
        /table behind the client/,
    );
});

test("A3b R4 +/- : a fold-explained gone in the envelope is SKIPPED (skipIds), no throw", () => {
    const stored = canon(4);
    // m1 was fold-covered (explained gone); the client still lists it.
    const d = matchWorld(matchInput(stored, ["m1", "m2", "m3", "m4"], { explainedGone: new Set(["m1"]) }));
    assert.equal(d.mode, "echo", "checksum match is positional — the gone is reconciled out of band");
    const asm = assembleKernelInput({
        decision: d,
        rows: [
            { pos: 2, ids: ["m2"], msg: core(2) },
            { pos: 3, ids: ["m3"], msg: core(3) },
            { pos: 4, ids: ["m4"], msg: core(4) },
        ],
        newCores: [],
        skipIds: new Set(["m1"]),
    });
    assert.deepEqual(asm.kernelInput.map((m) => m.id), ["m2", "m3", "m4"]);
});

test("A4 #7 resync: diverge → zero side effects (the canon is untouched), shouldResync true", () => {
    const sid = "a4";
    const store = storeWithRows(10, sid);
    const ten = Array.from({ length: 10 }, (_, i) => `m${i + 1}`);
    const seed = store.snapStage0(sid, ten);
    assert.equal(seed.decision.mode, "issue");
    const db = (store as unknown as { db: import("../src/storage/snap.ts").DbLike }).db;
    const sessRaw = sid; // plainSession id == conversation id
    const before = snapL1EnvelopeRead(db, sessRaw);
    assert.ok(before && before.envelopeChecksum);

    const d = store.snapStage0(sid, ["OTHER", "m1", "m2"]);
    assert.equal(d.decision.mode, "diverge");
    assert.equal(d.diverge, true);
    assert.ok(shouldResync(d.decision, 10));

    // Zero side effects: the diverge turn persisted nothing.
    const after = snapL1EnvelopeRead(db, sessRaw);
    assert.equal(after!.envelopeChecksum, before!.envelopeChecksum, "the diverge wrote nothing");

    // The resync: reset + re-issue from the client's CURRENT array →
    // one-round convergence.
    store.snapStage0Reset(sid);
    const re = store.snapStage0(sid, ["OTHER", "m1", "m2"], { resync: true });
    assert.equal(re.decision.mode, "resync");
    assert.deepEqual(
        re.decision.envelope.map((e) => e.id),
        ["OTHER", "m1", "m2"],
    );
    assert.equal(shouldResync(re.decision, 0), true, "the resync turn itself resets (the lane re-seeds from it)");
});

test("A4b #7 +/- : a plain issue on an EMPTY plane is the NORMAL seed (not a resync)", () => {
    const sid = "a4b";
    const store = openPlane(path.join(hermetic, "a4b", "index.db"));
    const d = store.snapStage0(sid, ["a", "b", "c"]);
    assert.equal(d.decision.mode, "issue");
    assert.equal(shouldResync(d.decision, 0), false, "seed must not loop the reset");
});

test("A5 anchor placement: the anchor renders before the first element past the covered run", () => {
    const stored = canon(6);
    const d = matchWorld(matchInput(stored, ["m1", "m2", "m3", "m4", "m5", "m6"]));
    const rows = Array.from({ length: 6 }, (_, i) => ({ pos: i, ids: [`m${i + 1}`], msg: core(i + 1) }));
    const anchor = { id: "acp_summary_b1", role: "system", contentType: "text", text: "[Compressed conversation section]" } as BiliMessage;
    // The block covered rows through pos 3 (1-based: m1..m3); m1 (the pin)
    // stays active, m2/m3 flipped. The served elements: pos 1..6 → the
    // anchor sits before the first served element with pos > 3.
    const asm = assembleKernelInput({
        decision: d,
        rows,
        newCores: [],
        anchors: [{ msg: anchor, blockId: "b1" }],
        coverMax: { b1: 3 },
    });
    const ids = asm.kernelInput.map((m) => m.id);
    assert.equal(ids.indexOf("acp_summary_b1"), 3, "the anchor precedes m4 (pos 4, the first past the run)");
    assert.deepEqual(ids, ["m1", "m2", "m3", "acp_summary_b1", "m4", "m5", "m6"]);
});

test("A5b anchor +/- : no coverMax evidence (covered rows GC'd) → the view start", () => {
    const stored = canon(3);
    const d = matchWorld(matchInput(stored, ["m1", "m2", "m3"]));
    const anchor = { id: "acp_summary_b1", role: "system", contentType: "text", text: "[Compressed conversation section]" } as BiliMessage;
    const asm = assembleKernelInput({
        decision: d,
        rows: [
            { pos: 1, ids: ["m1"], msg: core(1) },
            { pos: 2, ids: ["m2"], msg: core(2) },
            { pos: 3, ids: ["m3"], msg: core(3) },
        ],
        newCores: [],
        anchors: [{ msg: anchor, blockId: "b1" }],
    });
    assert.deepEqual(asm.kernelInput.map((m) => m.id), ["acp_summary_b1", "m1", "m2", "m3"]);
});

test("A6 P5: the new-core count must match the verdict (a parse of a non-new span throws)", () => {
    const stored = canon(2);
    const d = matchWorld(matchInput(stored, ["m1", "m2"]));
    assert.throws(
        () =>
            assembleKernelInput({
                decision: d,
                rows: [{ pos: 0, ids: ["m1"], msg: core(1) }, { pos: 1, ids: ["m2"], msg: core(2) }],
                newCores: [core(9)],
            }),
        /newCores length/,
    );
});

// ---------------------------------------------------------------------------
// D — delta egress (acceptance 8)
// ---------------------------------------------------------------------------

function elementsOf(n: number): EgressElement[] {
    const els: EgressElement[] = Array.from({ length: n }, (_, i) => ({
        msg: core(i + 1),
        pos: i,
        isAnchor: false,
    }));
    els.splice(2, 0, {
        msg: { id: "acp_summary_b1", role: "system", contentType: "text", text: "s" } as BiliMessage,
        pos: -1,
        isAnchor: true,
        anchorId: "b1",
    });
    return els;
}

test("D1 #8 seed: the first round (null state) is a FULL resend of the whole view", () => {
    const els = elementsOf(5);
    const sel = selectOutbound(els, null);
    assert.equal(sel.reseed, true);
    // A reseed IS the full view (the lane sends the whole view; `delta` is
    // empty and isFullResend only flags the delta-grown-to-full case).
    assert.equal(isFullResend(sel, els), false);
    assert.equal(sel.nextState.frontierPos, 4, "the seed frontier covers every sent data row");
    assert.deepEqual(sel.nextState.servedAnchors, ["b1"]);
});

test("D2 #8 delta: the next round sends ONLY rows past the frontier (plus unsent anchors)", () => {
    const els = elementsOf(5);
    const seed = selectOutbound(els, null);
    // One new tail row (pos 5) + the anchor re-sent? NO — the anchor was
    // already served: the delta is exactly the one new row.
    const els2 = [...els, { msg: core(6), pos: 5, isAnchor: false }];
    const sel = selectOutbound(els2, seed.nextState);
    assert.equal(sel.reseed, false);
    assert.deepEqual(sel.delta.map((e) => e.pos), [5]);
    assert.equal(sel.nextState.frontierPos, 5);
    assert.deepEqual(sel.nextState.servedAnchors, ["b1"]);
});

test("D3 #8 no-op: a steady round with nothing new sends an empty delta (the plane round rides the provider cache)", () => {
    const els = elementsOf(5);
    const seed = selectOutbound(els, null);
    const sel = selectOutbound(els, seed.nextState);
    assert.equal(sel.reseed, false);
    assert.deepEqual(sel.delta, []);
});

test("D4 #8 +/- : an unsent anchor (a NEW fold) rides the next delta", () => {
    const els = elementsOf(5);
    const seed = selectOutbound(els, null);
    const els2 = [
        ...els,
        { msg: { id: "acp_summary_b2", role: "system", contentType: "text", text: "s2" } as BiliMessage, pos: -2, isAnchor: true, anchorId: "b2" },
        { msg: core(6), pos: 5, isAnchor: false },
    ];
    const sel = selectOutbound(els2, seed.nextState);
    assert.deepEqual(sel.delta.map((e) => e.anchorId ?? e.pos), ["b2", 5]);
    assert.deepEqual(sel.nextState.servedAnchors.sort(), ["b1", "b2"]);
});

test("D5 isFullResend: the delta grown to the whole view is a re-seed in disguise", () => {
    // A view with NO anchors: 5 data rows, state frontier -1 (nothing sent)
    // → the delta covers every element → full resend.
    const els: EgressElement[] = Array.from({ length: 5 }, (_, i) => ({
        msg: core(i + 1),
        pos: i,
        isAnchor: false,
    }));
    const state: DeltaState = { frontierPos: -1, servedAnchors: [] };
    const sel = selectOutbound(els, state);
    assert.equal(isFullResend(sel, els), true, "5 of 5 unsent → the delta IS the full view");
    // +/- : the frontier already past the data, an UNSENT anchor rides alone
    // → the delta is 1 element, NOT a full resend.
    const els2 = [...els, {
        msg: { id: "acp_summary_b9", role: "system", contentType: "text", text: "s" } as BiliMessage,
        pos: -1,
        isAnchor: true,
        anchorId: "b9",
    }];
    const sel2 = selectOutbound(els2, { frontierPos: 4, servedAnchors: [] });
    assert.deepEqual(sel2.delta.map((e) => e.anchorId), ["b9"]);
    assert.equal(isFullResend(sel2, els2), false, "one anchor alone is not a full resend");
});

// ---------------------------------------------------------------------------
// R — red gates
// ---------------------------------------------------------------------------

test("R1 R3: a declared host that fails to collect msgids → the fault (400 source)", () => {
    assert.equal(checkR3Identity(true, 5, undefined), false, "declared, no msgids");
    assert.equal(checkR3Identity(true, 5, ["a", "b", "c"]), false, "declared, wrong length");
    assert.equal(checkR3Identity(true, 5, ["a", "b", "c", "d", "e"]), true, "declared, complete");
    assert.equal(checkR3Identity(false, 5, undefined), true, "non-cohort: never a fault");
    assert.equal(checkR3Identity(true, 0, undefined), true, "no elements: nothing to collect");
});

test("R2 R3: FoundationRejectError is the 400 control channel (zero side effects are the caller's, the error is the signal)", () => {
    const err = new FoundationRejectError("envelope fault");
    assert.ok(err instanceof Error);
    assert.equal(err.status, 400);
    assert.match(err.message, /R3 identity fault/);
});

test("R3 R3 breaker: 3 faults in the 10-minute window latch; the latch rejects further faults and outlives the window", () => {
    const t = new R3FaultTracker(60_000, 3);
    const t0 = 1_000_000;
    assert.equal(t.recordFault("s", t0).latched, false);
    assert.equal(t.recordFault("s", t0 + 1_000).latched, false);
    assert.equal(t.recordFault("s", t0 + 2_000).latched, true, "the third strike latches");
    assert.equal(t.isLatched("s"), true);
    // Latched sids reject immediately — even after the window would expire.
    assert.equal(t.recordFault("s", t0 + 999_999).latched, true);
    // A different sid is unaffected.
    assert.equal(t.isLatched("other"), false);
    t.clearLatched("s");
    assert.equal(t.isLatched("s"), false);
});

test("R4 R3 +/- : the window expires (a new window restarts the strike count)", () => {
    const t = new R3FaultTracker(1000, 3);
    t.recordFault("s", 0);
    t.recordFault("s", 100);
    t.recordFault("s", 200); // latched? strikeCap 3 → yes
    assert.equal(t.isLatched("s"), true);
    t.clearLatched("s");
    // Fresh window: two faults do NOT re-latch.
    t.recordFault("s", 5_000);
    t.recordFault("s", 6_000);
    assert.equal(t.isLatched("s"), false);
});

test("R5 R2: diverge = zero side effects (stage0Decide writes nothing on a structural disagreement)", () => {
    const dir = path.join(hermetic, "r5");
    fs.mkdirSync(dir, { recursive: true });
    const db = (openPlane(path.join(dir, "index.db")) as unknown as { db: import("../src/storage/snap.ts").DbLike }).db;
    // The l1 row is recorded by the store facade before stage0 (the lane
    // path) — do it here so the pure function has its world to match.
    snapL1Record(db, "s5", "s5", "witness", now0);
    // Seed the world: issue a 3-id envelope.
    const seed = stage0Decide({ db, sessRaw: "s5", ledgerId: "s5", incoming: ["a", "b", "c"], now: now0 });
    assert.equal(seed.decision.mode, "issue");
    // A structural disagreement (head moved): the verdict is diverge and the
    // stored envelope is UNCHANGED (zero side effects — the lane runs the
    // legacy round and the client converges next turn).
    const d = stage0Decide({ db, sessRaw: "s5", ledgerId: "s5", incoming: ["OTHER", "a", "b"], now: now0 + 1 });
    assert.equal(d.diverge, true);
    const l1 = snapL1Lookup(db, "s5");
    assert.ok(l1, "the seed l1 row exists");
    const env = snapL1EnvelopeRead(db, "s5");
    assert.equal(env!.envelopeChecksum, seed.decision.envelopeChecksum, "the diverge persisted nothing");
});

// ---------------------------------------------------------------------------
// S — the stage-0 store seam (M1 seed → M2 append round trip through SQLite)
// ---------------------------------------------------------------------------

test("S1 the full M1→M2 round trip: seed (issue) → M1 probe → M2 append → M1 echo", () => {
    const dir = path.join(hermetic, "s1");
    fs.mkdirSync(dir, { recursive: true });
    const store = openPlane(path.join(dir, "index.db"));
    const sid = "s1";
    store.ingestSession(planIngest(plainSession(sid, 3)));
    const rows = () => store.snapStage0Cores(sid).rows.map((r) => r.ids[0]!);

    // Seed: the client's first full array (3 ids).
    const seed = store.snapStage0(sid, ["m1", "m2", "m3"]);
    assert.equal(seed.decision.mode, "issue");

    // M1 tail extension: full resend + one new id (1-based pos: seed is 1..3
    // → m4 lands at pos 4).
    const m1 = store.snapStage0(sid, ["m1", "m2", "m3", "m4"]);
    assert.equal(m1.decision.mode, "probe");
    assert.deepEqual(m1.decision.newIdPos, [{ id: "m4", pos: 4 }]);

    // M2: ONLY the new id + the seqs carrier (4 rows pos 0..3 → frontier 4,
    // the next seq is 5).
    store.ingestSession(planIngest(plainSession(sid, 4)));
    const m2 = store.snapStage0(sid, ["m5"], { seqs: [5] });
    assert.equal(m2.decision.mode, "probe", "the M2 append");
    assert.deepEqual(m2.decision.newIdPos, [{ id: "m5", pos: 5 }]);
    assert.deepEqual(m2.decision.envelope.map((e) => e.id), ["m1", "m2", "m3", "m4", "m5"]);

    // The next M1 full resend must ECHO the matchAppend canon.
    const echo = store.snapStage0(sid, ["m1", "m2", "m3", "m4", "m5"]);
    assert.equal(echo.decision.mode, "echo", "M1 full resend echoes the M2-persisted canon");
    assert.deepEqual(echo.decision.newIdPos, []);
    void rows;
});
