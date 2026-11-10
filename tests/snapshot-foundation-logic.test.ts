/**
 * #5874 — snapshot-table compression foundation: hermetic logic tests.
 *
 * These pin the pure decision layer (stages 0, 2–3, 4) with NO server, NO
 * kernel, NO I/O — the same discipline as the lane-decisions matrix (#3617:
 * positive AND negative pairs). Coverage:
 *
 *   - checksums: canonicalJson / envelopeChecksum / s4Aggregate / stateChecksum
 *   - stage 0 identity (matchWorld): issue / echo / probe / scatter /
 *     delete / diverge (head + order) / resync + the T3 B1-trap ×3-restart
 *     oracle (the world origin never moves except on issue/resync)
 *   - stage 2–3 reconcile: cast / append / no-op / update / compact /
 *     delete / the three R2 no-join breaks / the ckpt coverage map (T7) /
 *     the ckpt cadence
 *   - hydrate: the green/red lanes (R1 ×3, R4, off, no-tables, legal
 *     advance)
 *   - lane decision: the full token vocabulary incl. R2 resyncNextTurn
 *   - stage 4 egress: view build + the corrupt-post tripwire
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    canonicalJson,
    envelopeChecksum,
    matchWorld,
    reconcile,
    buildEgressView,
    hydratePlane,
    parseEnvelope,
    decideSnapshotLane,
    s4Aggregate,
    stateChecksum,
    sha256hex,
} from "../src/snapshot/index.ts";
import type { SnapshotRowView, WorldEnvelopeEntry } from "../src/snapshot/types.ts";
import type { SnapRow } from "../src/storage/store.ts";

// ---------------------------------------------------------------------------
// checksums
// ---------------------------------------------------------------------------

test("canonicalJson: sorted keys, recursive, no whitespace, undefined dropped", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, 4] } }), '{"a":{"c":[3,4],"d":2},"b":1}');
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
    assert.equal(canonicalJson([1, "x", null]), '[1,"x",null]');
});

test("envelopeChecksum: order-sensitive, content-sensitive, idempotent", () => {
    const a = ["m1", "m2", "m3"];
    assert.equal(envelopeChecksum(a), envelopeChecksum([...a]));
    assert.notEqual(envelopeChecksum(a), envelopeChecksum(["m3", "m2", "m1"]));
    assert.notEqual(envelopeChecksum(a), envelopeChecksum(["m1", "m2", "m4"]));
});

test("s4Aggregate: pos-ordered, corruption-sensitive, stable on empty", () => {
    const rows = [
        { pos: 1, postJson: '[{"id":"c1"}]' },
        { pos: 2, postJson: '[{"id":"c2"}]' },
    ];
    assert.equal(s4Aggregate(rows), s4Aggregate([...rows]));
    // pos-ordered by design (a row's material is "pos:checksum") — input
    // order must not move the aggregate.
    assert.equal(s4Aggregate(rows), s4Aggregate([...rows].reverse()));
    assert.notEqual(s4Aggregate(rows), s4Aggregate([{ pos: 1, postJson: '[{"id":"c1"}]' }, { pos: 2, postJson: "[{}]" }]));
    // Whitespace/canonical differences inside the post form are detected
    // (s4 hashes the canonical parse, not the raw bytes).
    assert.equal(s4Aggregate([{ pos: 1, postJson: '{"a":1,"b":2}' }]), s4Aggregate([{ pos: 1, postJson: '{"b":2,"a":1}' }]));
    assert.notEqual(s4Aggregate([]), s4Aggregate([{ pos: 1, postJson: "[]" }]));
});

test("stateChecksum: canonical over the kernel state (key-order churn-proof)", () => {
    assert.equal(stateChecksum({ a: 1, b: 2 }), stateChecksum({ b: 2, a: 1 }));
    assert.notEqual(stateChecksum({ a: 1 }), stateChecksum({ a: 2 }));
});

// ---------------------------------------------------------------------------
// stage 0 — identity (matchWorld)
// ---------------------------------------------------------------------------

const T0 = 1_000_000;

test("matchWorld: issue — no stored world issues a fresh ledger identity + arm", () => {
    const d = matchWorld({
        stored: null,
        incoming: ["a", "b"],
        sessRaw: "raw-1",
        ledgerId: "sid-1",
        now: T0,
    });
    assert.equal(d.mode, "issue");
    assert.deepEqual(d.envelope, [
        { id: "a", pos: 1 },
        { id: "b", pos: 2 },
    ]);
    assert.equal(d.issuedLedgerId, "sid-1");
    assert.equal(d.issuedAt, T0);
    assert.equal(d.armedAt, T0);
    assert.equal(d.envelopeChecksum, envelopeChecksum(["a", "b"]));
});

test("matchWorld: echo — positional match carries the world origin (B1)", () => {
    const stored: WorldEnvelopeEntry[] = [
        { id: "a", pos: 1 },
        { id: "b", pos: 2 },
    ];
    const d = matchWorld({
        stored: { ledgerId: "sid-1", envelope: stored, envelopeChecksum: envelopeChecksum(["a", "b"]), issuedAt: T0 },
        incoming: ["a", "b"],
        sessRaw: "raw-1",
        ledgerId: "sid-1",
        now: T0 + 5,
    });
    assert.equal(d.mode, "echo");
    assert.equal(d.issuedAt, T0, "B1 trap: origin never moves on echo");
    assert.equal(d.armedAt, undefined);
    assert.equal(d.issuedLedgerId, undefined);
    assert.deepEqual(d.newIdPos, []);
    assert.deepEqual(d.goneIds, []);
});

test("matchWorld: probe — tail append issues fresh pos to the new ids", () => {
    const stored: WorldEnvelopeEntry[] = [
        { id: "a", pos: 1 },
        { id: "b", pos: 2 },
    ];
    const d = matchWorld({
        stored: { ledgerId: "sid-1", envelope: stored, envelopeChecksum: envelopeChecksum(["a", "b"]), issuedAt: T0 },
        incoming: ["a", "b", "c", "d"],
        sessRaw: "raw-1",
        ledgerId: "sid-1",
        now: T0 + 5,
    });
    assert.equal(d.mode, "probe");
    assert.deepEqual(d.newIdPos, [
        { id: "c", pos: 3 },
        { id: "d", pos: 4 },
    ]);
    assert.deepEqual(d.goneIds, []);
    assert.equal(d.issuedAt, T0, "B1 trap: origin never moves on probe");
});

test("matchWorld: scatter — interleaved new ids get fresh pos, survivors keep pos", () => {
    // a and c are known (pos 1, 3); a new id "x" is inserted in the middle.
    const stored: WorldEnvelopeEntry[] = [
        { id: "a", pos: 1 },
        { id: "c", pos: 3 },
    ];
    const d = matchWorld({
        stored: { ledgerId: "sid-1", envelope: stored, envelopeChecksum: envelopeChecksum(["a", "c"]), issuedAt: T0 },
        incoming: ["a", "x", "c"],
        sessRaw: "raw-1",
        ledgerId: "sid-1",
        now: T0 + 5,
    });
    assert.equal(d.mode, "scatter");
    assert.deepEqual(d.newIdPos, [{ id: "x", pos: 4 }]);
    assert.deepEqual(d.envelope, [
        { id: "a", pos: 1 },
        { id: "x", pos: 4 },
        { id: "c", pos: 3 },
    ]);
    assert.equal(d.issuedAt, T0, "B1 trap: origin never moves on scatter");
});

test("matchWorld: delete — a gone id is reported, survivors keep pos + order", () => {
    const stored: WorldEnvelopeEntry[] = [
        { id: "a", pos: 1 },
        { id: "b", pos: 2 },
        { id: "c", pos: 3 },
    ];
    const d = matchWorld({
        stored: { ledgerId: "sid-1", envelope: stored, envelopeChecksum: envelopeChecksum(["a", "b", "c"]), issuedAt: T0 },
        incoming: ["a", "c"],
        sessRaw: "raw-1",
        ledgerId: "sid-1",
        now: T0 + 5,
    });
    assert.equal(d.mode, "probe"); // canon shrink
    assert.deepEqual(d.goneIds, ["b"]);
    assert.deepEqual(d.envelope, [
        { id: "a", pos: 1 },
        { id: "c", pos: 3 },
    ]);
    assert.equal(d.issuedAt, T0);
});

test("matchWorld: diverge (head) — head changed → canon NOT updated, zero side effects", () => {
    const stored: WorldEnvelopeEntry[] = [
        { id: "a", pos: 1 },
        { id: "b", pos: 2 },
    ];
    const d = matchWorld({
        stored: { ledgerId: "sid-1", envelope: stored, envelopeChecksum: envelopeChecksum(["a", "b"]), issuedAt: T0 },
        incoming: ["z", "b"],
        sessRaw: "raw-1",
        ledgerId: "sid-1",
        now: T0 + 5,
    });
    assert.equal(d.mode, "diverge");
    assert.deepEqual(d.envelope, stored, "the canon is returned UNCHANGED");
    assert.deepEqual(d.newIdPos, []);
    assert.equal(d.issuedLedgerId, undefined, "diverge issues nothing");
    assert.ok(d.witness?.includes("head"), "witness names the head move");
});

test("matchWorld: diverge (head-drop unexplained) — a head vanishes without fold evidence", () => {
    const stored: WorldEnvelopeEntry[] = [
        { id: "a", pos: 1 },
        { id: "b", pos: 2 },
        { id: "c", pos: 3 },
    ];
    const d = matchWorld({
        stored: { ledgerId: "sid-1", envelope: stored, envelopeChecksum: envelopeChecksum(["a", "b", "c"]), issuedAt: T0 },
        incoming: ["b", "c"],
        sessRaw: "raw-1",
        ledgerId: "sid-1",
        now: T0 + 5,
    });
    assert.equal(d.mode, "diverge");
    assert.ok(d.witness?.includes("head"));
});

test("matchWorld: post-fold shrink — covered head gone is LEGAL (live-head rule)", () => {
    // The fold absorbed a+b (their rows went inactive with a coverRef);
    // the client now re-sends from the first survivor c. The live head is c
    // in BOTH canon and envelope → no divergence, fresh pos for the new ids.
    const stored: WorldEnvelopeEntry[] = [
        { id: "a", pos: 1 },
        { id: "b", pos: 2 },
        { id: "c", pos: 3 },
        { id: "d", pos: 4 },
    ];
    const d = matchWorld({
        stored: { ledgerId: "sid-1", envelope: stored, envelopeChecksum: envelopeChecksum(["a", "b", "c", "d"]), issuedAt: T0 },
        incoming: ["c", "d", "e"],
        explainedGone: new Set(["a", "b"]),
        sessRaw: "raw-1",
        ledgerId: "sid-1",
        now: T0 + 5,
    });
    assert.equal(d.mode, "scatter", "shrink + tail append interleaved with covered gone");
    assert.deepEqual(d.goneIds, ["a", "b"]);
    assert.deepEqual(d.newIdPos, [{ id: "e", pos: 5 }]);
    assert.deepEqual(d.envelope, [
        { id: "c", pos: 3 },
        { id: "d", pos: 4 },
        { id: "e", pos: 5 },
    ]);
    assert.equal(d.issuedAt, T0, "B1 trap: origin survives the fold");
});

test("matchWorld: diverge (order) — a known id reordered → history rewrite", () => {
    const stored: WorldEnvelopeEntry[] = [
        { id: "a", pos: 1 },
        { id: "b", pos: 2 },
        { id: "c", pos: 3 },
    ];
    const d = matchWorld({
        stored: { ledgerId: "sid-1", envelope: stored, envelopeChecksum: envelopeChecksum(["a", "b", "c"]), issuedAt: T0 },
        incoming: ["a", "c", "b"], // b and c swapped
        sessRaw: "raw-1",
        ledgerId: "sid-1",
        now: T0 + 5,
    });
    assert.equal(d.mode, "diverge");
    assert.equal(d.issuedLedgerId, undefined);
});

test("matchWorld: resync — explicit re-baseline re-issues + re-arms", () => {
    const stored: WorldEnvelopeEntry[] = [{ id: "a", pos: 1 }];
    const d = matchWorld({
        stored: { ledgerId: "sid-1", envelope: stored, envelopeChecksum: envelopeChecksum(["a"]), issuedAt: T0 },
        incoming: ["a", "b"],
        sessRaw: "raw-1",
        ledgerId: "sid-1",
        now: T0 + 9,
        resync: true,
    });
    assert.equal(d.mode, "resync");
    assert.equal(d.issuedAt, T0 + 9, "resync moves the origin (explicit re-baseline)");
    assert.equal(d.armedAt, T0 + 9);
    assert.equal(d.issuedLedgerId, "sid-1");
});

// ---------------------------------------------------------------------------
// T3 — the B1-trap ×3-restart oracle
// ---------------------------------------------------------------------------

test("T3: B1 trap — across 3 restarts the world origin never moves; the frontier only advances via issue/resync", () => {
    // Turn 1 (fresh process): issue the world.
    const d1 = matchWorld({ stored: null, incoming: ["a"], sessRaw: "r", ledgerId: "s", now: 100 });
    assert.equal(d1.mode, "issue");
    const issuedAt = d1.issuedAt;
    // Persist the canon (the caller's job; here we just hold it).
    let canon = d1.envelope;

    // "Restart" 1: hydrate from the stored canon + an echo turn.
    let storedWorld = {
        ledgerId: "s",
        envelope: canon,
        envelopeChecksum: envelopeChecksum(["a"]),
        issuedAt,
        armedAt: 100,
    };
    const plane1 = hydratePlane({
        sessionId: "s",
        flagOn: true,
        world: { ...storedWorld, envelopeJson: JSON.stringify(canon) },
        rows: [],
        ckpt: null,
        frontier: 0,
    });
    assert.equal(plane1.health, "green");
    assert.equal(plane1.world?.issuedAt, issuedAt);

    // Turn 2 (post-restart): echo — the origin is carried, not reset.
    const d2 = matchWorld({ stored: storedWorld, incoming: ["a"], sessRaw: "r", ledgerId: "s", now: 200 });
    assert.equal(d2.mode, "echo");
    assert.equal(d2.issuedAt, issuedAt, "echo carries the origin");

    // "Restart" 2: hydrate again, then a probe turn (tail append).
    const plane2 = hydratePlane({
        sessionId: "s",
        flagOn: true,
        world: { ...storedWorld, envelopeJson: JSON.stringify(canon) },
        rows: [],
        ckpt: null,
        frontier: 0,
    });
    assert.equal(plane2.world?.issuedAt, issuedAt);
    const d3 = matchWorld({ stored: storedWorld, incoming: ["a", "b"], sessRaw: "r", ledgerId: "s", now: 300 });
    assert.equal(d3.mode, "probe");
    assert.equal(d3.issuedAt, issuedAt, "probe carries the origin");
    canon = d3.envelope;
    storedWorld = { ...storedWorld, envelope: canon, envelopeChecksum: d3.envelopeChecksum };

    // "Restart" 3: hydrate — origin STILL the issue-time value.
    const plane3 = hydratePlane({
        sessionId: "s",
        flagOn: true,
        world: { ...storedWorld, envelopeJson: JSON.stringify(canon) },
        rows: [],
        ckpt: null,
        frontier: 0,
    });
    assert.equal(plane3.world?.issuedAt, issuedAt, "3 restarts later the origin is unchanged");

    // Only a resync moves the origin.
    const d4 = matchWorld({ stored: storedWorld, incoming: ["a", "b"], sessRaw: "r", ledgerId: "s", now: 400, resync: true });
    assert.equal(d4.issuedAt, 400);
});

// ---------------------------------------------------------------------------
// stage 2–3 — reconcile
// ---------------------------------------------------------------------------

function row(pos: number, post: unknown, over: Partial<SnapshotRowView> = {}): SnapshotRowView {
    const postJson = JSON.stringify(post);
    return {
        pos,
        coreIds: (post as Array<{ id: string }>).map((c) => c.id),
        postJson,
        preJson: null,
        tokensEst: 1,
        active: true,
        coverRef: null,
        updatedAt: 0,
        ...over,
    };
}
const core = (id: string) => ({ id });

test("reconcile: first turn — every element is a cast", () => {
    const out = reconcile({
        sessionId: "s",
        currentRows: new Map(),
        envelope: ["a", "b"],
        posMap: { a: 1, b: 2 },
        parsedCores: [[core("ca1"), core("ca2")], [core("cb1")]],
        blockCoverage: [],
        modelView: [core("ca1"), core("ca2"), core("cb1")],
        foldedThisTurn: false,
        kernelState: {},
        now: 1,
        turnCount: 0,
        ckptEveryNTurns: 16,
    });
    assert.equal(out.joinOk, true);
    assert.deepEqual(out.events.map((e) => [e.kind, e.pos]).sort(), [["cast", 1], ["cast", 2]]);
    assert.equal(out.rows.length, 2);
    assert.equal(out.ckpt, undefined, "no fold, turn 0 → no ckpt");
});

test("reconcile: append — a new pos is an append (not a cast)", () => {
    const cur = new Map<number, SnapshotRowView>([[1, row(1, [core("ca1")])]]);
    const out = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: ["a", "b"],
        posMap: { a: 1, b: 2 },
        parsedCores: [[core("ca1")], [core("cb1")]],
        blockCoverage: [],
        modelView: [core("ca1"), core("cb1")],
        foldedThisTurn: false,
        kernelState: {},
        now: 2,
        turnCount: 1,
        ckptEveryNTurns: 16,
    });
    assert.equal(out.joinOk, true);
    assert.deepEqual(out.events, [{ kind: "append", pos: 2, coreIds: ["cb1"], evidence: "new@2" }]);
});

test("reconcile: no-op turn — identical form upserts nothing (free turn)", () => {
    const cur = new Map<number, SnapshotRowView>([
        [1, row(1, [core("ca1")])],
        [2, row(2, [core("cb1")])],
    ]);
    const out = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: ["a", "b"],
        posMap: { a: 1, b: 2 },
        parsedCores: [[core("ca1")], [core("cb1")]],
        blockCoverage: [],
        modelView: [core("ca1"), core("cb1")],
        foldedThisTurn: false,
        kernelState: {},
        now: 3,
        turnCount: 2,
        ckptEveryNTurns: 16,
    });
    assert.equal(out.joinOk, true);
    assert.deepEqual(out.events, []);
    assert.deepEqual(out.rows, []);
});

test("reconcile: update — a changed tail element carries a CAS pre ref (ruling A)", () => {
    const cur = new Map<number, SnapshotRowView>([
        [1, row(1, [core("ca1")])],
        [2, row(2, [core("cb1")])],
    ]);
    // Element b's content changed → its core id is now cb1'.
    const out = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: ["a", "b"],
        posMap: { a: 1, b: 2 },
        parsedCores: [[core("ca1")], [core("cb1x")]],
        blockCoverage: [],
        modelView: [core("ca1"), core("cb1x")],
        foldedThisTurn: false,
        kernelState: {},
        now: 4,
        turnCount: 3,
        ckptEveryNTurns: 16,
    });
    assert.equal(out.joinOk, true);
    assert.equal(out.events.length, 1);
    assert.equal(out.events[0]!.kind, "update");
    assert.equal(out.events[0]!.pos, 2);
    assert.ok(out.events[0]!.preHash, "the pre form is hashed");
    assert.equal(out.preContents.length, 1);
    assert.equal(out.preContents[0]!.content, JSON.stringify([core("cb1")]));
    assert.equal(out.rows[0]!.preJson, out.preContents[0]!.hash, "the row stores the CAS digest");
    assert.equal(out.rows[0]!.postJson, JSON.stringify([core("cb1x")]));
});

test("reconcile: compact — a fold absorbs the covered range; the summary rides the host's tool-result element", () => {
    const cur = new Map<number, SnapshotRowView>([
        [1, row(1, [core("ca1")])],
        [2, row(2, [core("cb1")])],
        [3, row(3, [core("cc1")])],
    ]);
    // The fold happened: the host's envelope is now [compress-call, compress-result]
    // (fresh msgids → fresh pos 4/5); the covered elements a/b/c are GONE from
    // the envelope, so their pos resolves via the stored rows' coreIds.
    // The block's coverage also carries the rendered summary core id — a
    // kernel-internal core that resolves to neither source → ignored.
    const out = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: ["pc", "pr"],
        posMap: { a: 1, b: 2, c: 3, pc: 4, pr: 5 },
        parsedCores: [[core("pcx")], [core("prx")]],
        blockCoverage: [{ blockId: "blk1", coreIds: ["ca1", "cb1", "cc1", "acp_summary_blk1"] }],
        modelView: [core("pcx"), core("prx")],
        foldedThisTurn: true,
        kernelState: { blocks: ["blk1"] },
        now: 5,
        turnCount: 4,
        ckptEveryNTurns: 16,
    });
    assert.equal(out.joinOk, true);
    const byPos = new Map(out.events.map((e) => [e.pos, e]));
    assert.equal(byPos.get(1)!.kind, "compact");
    assert.equal(byPos.get(1)!.blockId, "blk1");
    assert.equal(byPos.get(2)!.kind, "compact");
    assert.equal(byPos.get(3)!.kind, "compact");
    assert.equal(byPos.get(4)!.kind, "append");
    assert.equal(byPos.get(5)!.kind, "append");
    for (const p of [1, 2, 3]) {
        const r = out.rows.find((r) => r.pos === p)!;
        assert.equal(r.active, false);
        assert.equal(r.coverRef, "blk1");
    }
    assert.equal(out.rows.find((r) => r.pos === 2)!.postJson, JSON.stringify([core("cb1")]), "the pre form is kept for decompress");
    // The summary content is a plain tail row (the tool-result element), not a
    // special summary row.
    assert.equal(out.rows.find((r) => r.pos === 5)!.postJson, JSON.stringify([core("prx")]));
    assert.equal(out.rows.find((r) => r.pos === 5)!.active, true);
});

test("T7: the ckpt coverage map survives the fold (the post-compaction basis)", () => {
    const cur = new Map<number, SnapshotRowView>([
        [1, row(1, [core("ca1")])],
        [2, row(2, [core("cb1")])],
        [3, row(3, [core("cc1")])],
    ]);
    const out = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: ["pc", "pr"],
        posMap: { a: 1, b: 2, c: 3, pc: 4, pr: 5 },
        parsedCores: [[core("pcx")], [core("prx")]],
        blockCoverage: [{ blockId: "blk1", coreIds: ["ca1", "cb1", "cc1"] }],
        modelView: [core("pcx"), core("prx")],
        foldedThisTurn: true,
        kernelState: { blocks: ["blk1"] },
        now: 6,
        turnCount: 5,
        ckptEveryNTurns: 16,
    });
    assert.ok(out.ckpt, "a fold emits a ckpt");
    assert.deepEqual(out.ckpt!.meta.coverage, { "1": { lo: 1, hi: 3, blockId: "blk1" } });
    assert.equal(out.ckpt!.meta.stateChecksum, stateChecksum({ blocks: ["blk1"] }));
    // The S4 aggregate is over the ACTIVE rows (the two new tail rows only).
    assert.equal(
        out.ckpt!.s4,
        s4Aggregate([
            { pos: 4, postJson: JSON.stringify([core("pcx")]) },
            { pos: 5, postJson: JSON.stringify([core("prx")]) },
        ]),
    );
    // Hydrating the ckpt meta round-trips the coverage map. Rows after the
    // fold: pos 1/2/3 deactivated with coverRef (pre forms kept), pos 4/5
    // active tail. The S4 recomputation is over the ACTIVE rows only, so it
    // matches the ckpt S4 (no log advance needed → green, not R1).
    const plane = hydratePlane({
        sessionId: "s",
        flagOn: true,
        world: { ledgerId: "s", envelopeJson: JSON.stringify([{ id: "pc", pos: 4 }, { id: "pr", pos: 5 }]), envelopeChecksum: envelopeChecksum(["pc", "pr"]), issuedAt: 1 },
        rows: [
            { pos: 1, coreIds: JSON.stringify(["ca1"]), preJson: null, postJson: JSON.stringify([core("ca1")]), tokensEst: 1, active: false, coverRef: "blk1", updatedAt: 6 },
            { pos: 2, coreIds: JSON.stringify(["cb1"]), preJson: null, postJson: JSON.stringify([core("cb1")]), tokensEst: 1, active: false, coverRef: "blk1", updatedAt: 6 },
            { pos: 3, coreIds: JSON.stringify(["cc1"]), preJson: null, postJson: JSON.stringify([core("cc1")]), tokensEst: 1, active: false, coverRef: "blk1", updatedAt: 6 },
            { pos: 4, coreIds: JSON.stringify(["pcx"]), preJson: null, postJson: JSON.stringify([core("pcx")]), tokensEst: 1, active: true, coverRef: null, updatedAt: 6 },
            { pos: 5, coreIds: JSON.stringify(["prx"]), preJson: null, postJson: JSON.stringify([core("prx")]), tokensEst: 1, active: true, coverRef: null, updatedAt: 6 },
        ],
        ckpt: { ckptSeq: 5, metaJson: JSON.stringify(out.ckpt!.meta), checksum: out.ckpt!.s4, updatedAt: 6 },
        frontier: 5,
    });
    assert.equal(plane.health, "green");
    assert.deepEqual(plane.meta?.coverage, { "1": { lo: 1, hi: 3, blockId: "blk1" } });
    assert.equal(plane.rows?.size, 2, "only the active tail rows are in the read view");
});

test("reconcile: the ckpt cadence fires at the Nth turn even without a fold", () => {
    const cur = new Map<number, SnapshotRowView>([[1, row(1, [core("ca1")])]]);
    const out = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: ["a"],
        posMap: { a: 1 },
        parsedCores: [[core("ca1")]],
        blockCoverage: [],
        modelView: [core("ca1")],
        foldedThisTurn: false,
        kernelState: {},
        now: 7,
        turnCount: 16, // the 16th turn
        ckptEveryNTurns: 16,
    });
    assert.ok(out.ckpt, "turn 16 % 16 == 0 → ckpt");
    assert.deepEqual(out.ckpt!.meta.coverage, {});
    // Turn 1 does not fire.
    const out1 = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: ["a"],
        posMap: { a: 1 },
        parsedCores: [[core("ca1")]],
        blockCoverage: [],
        modelView: [core("ca1")],
        foldedThisTurn: false,
        kernelState: {},
        now: 8,
        turnCount: 1,
        ckptEveryNTurns: 16,
    });
    assert.equal(out1.ckpt, undefined);
});

test("reconcile: delete — a dropped element deactivates with no cover anchor", () => {
    const cur = new Map<number, SnapshotRowView>([
        [1, row(1, [core("ca1")])],
        [2, row(2, [core("cb1")])],
        [3, row(3, [core("cc1")])],
    ]);
    // The client dropped element c: the envelope is now [a, b].
    const out = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: ["a", "b"],
        posMap: { a: 1, b: 2 },
        parsedCores: [[core("ca1")], [core("cb1")]],
        blockCoverage: [],
        modelView: [core("ca1"), core("cb1")],
        foldedThisTurn: false,
        kernelState: {},
        now: 9,
        turnCount: 6,
        ckptEveryNTurns: 16,
    });
    assert.equal(out.joinOk, true);
    assert.deepEqual(out.events, [{ kind: "delete", pos: 3, coreIds: ["cc1"], evidence: "dropped@3" }]);
    assert.equal(out.rows[0]!.active, false);
    assert.equal(out.rows[0]!.coverRef, null);
});

test("R2: an unexplained disappearance (no core, not covered) breaks the join", () => {
    const cur = new Map<number, SnapshotRowView>([[1, row(1, [core("ca1")])]]);
    // Element a's core is absent from the model view and no block covers it.
    const out = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: ["a"],
        posMap: { a: 1 },
        parsedCores: [[core("ca1")]],
        blockCoverage: [],
        modelView: [],
        foldedThisTurn: false,
        kernelState: {},
        now: 10,
        turnCount: 7,
        ckptEveryNTurns: 16,
    });
    assert.equal(out.joinOk, false);
    assert.deepEqual(out.events, []);
    assert.deepEqual(out.rows, []);
});

test("R2: two blocks claiming the same pos break the join", () => {
    const cur = new Map<number, SnapshotRowView>([[1, row(1, [core("ca1")])]]);
    const out = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: ["a"],
        posMap: { a: 1 },
        parsedCores: [[core("ca1")]],
        blockCoverage: [
            { blockId: "b1", coreIds: ["ca1"] },
            { blockId: "b2", coreIds: ["ca1"] },
        ],
        modelView: [core("acp_summary_b1"), core("acp_summary_b2")],
        foldedThisTurn: false,
        kernelState: {},
        now: 11,
        turnCount: 8,
        ckptEveryNTurns: 16,
    });
    assert.equal(out.joinOk, false);
});

test("R2: a block whose coverage is kernel-internal only does NOT break the join", () => {
    const cur = new Map<number, SnapshotRowView>([[1, row(1, [core("ca1")])]]);
    // The block covers only a rendered summary core (a re-fold of an earlier
    // fold): the id resolves to neither the envelope nor any stored row →
    // ignored, no compact events, the join stays intact.
    const out = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: ["a"],
        posMap: { a: 1 },
        parsedCores: [[core("ca1")]],
        blockCoverage: [{ blockId: "b1", coreIds: ["acp_summary_x"] }],
        modelView: [core("ca1")],
        foldedThisTurn: false,
        kernelState: {},
        now: 12,
        turnCount: 9,
        ckptEveryNTurns: 16,
    });
    assert.equal(out.joinOk, true);
    assert.deepEqual(out.events, []);
});

test("R2: an element with no parse, no stored row, not covered breaks the join", () => {
    // Mode-B unexplained: a new envelope element the span parse did not
    // re-parse and the ledger never saw → no evidence → the turn is legacy.
    const out = reconcile({
        sessionId: "s",
        currentRows: new Map(),
        envelope: ["a"],
        posMap: { a: 1 },
        parsedCores: [[]],
        blockCoverage: [],
        modelView: [],
        foldedThisTurn: false,
        kernelState: {},
        now: 13,
        turnCount: 10,
        ckptEveryNTurns: 16,
    });
    assert.equal(out.joinOk, false);
    assert.deepEqual(out.events, []);
    assert.deepEqual(out.rows, []);
});

// ---------------------------------------------------------------------------
// hydrate — the green/red lanes
// ---------------------------------------------------------------------------

const WORLD = {
    ledgerId: "s",
    envelopeJson: JSON.stringify([{ id: "a", pos: 1 }]),
    envelopeChecksum: envelopeChecksum(["a"]),
    issuedAt: 1,
    armedAt: 1,
};

test("hydrate: flag off → red 'off'", () => {
    const p = hydratePlane({ sessionId: "s", flagOn: false, world: WORLD, rows: [], ckpt: null, frontier: 0 });
    assert.equal(p.health, "red");
    assert.equal(p.reason, "off");
});

test("hydrate: no world → red 'no-tables'", () => {
    const p = hydratePlane({ sessionId: "s", flagOn: true, world: null, rows: [], ckpt: null, frontier: 0 });
    assert.equal(p.health, "red");
    assert.equal(p.reason, "no-tables");
});

test("R4: a structural-pending marker lost across a restart → conservatively dead", () => {
    const p = hydratePlane({ sessionId: "s", flagOn: true, world: WORLD, rows: [], ckpt: null, frontier: 0, structuralPending: true });
    assert.equal(p.health, "red");
    assert.equal(p.reason, "R4");
});

test("R1: a corrupt ckpt meta → permanently dead", () => {
    const p = hydratePlane({ sessionId: "s", flagOn: true, world: WORLD, rows: [], ckpt: { ckptSeq: 1, metaJson: "{not json", checksum: "x", updatedAt: 1 }, frontier: 1 });
    assert.equal(p.health, "red");
    assert.equal(p.reason, "R1");
});

test("R1: a stateChecksum mismatch → permanently dead", () => {
    const meta = { v: 1, kernelState: { a: 1 }, stateChecksum: "WRONG", coverage: {}, s4: "" };
    const p = hydratePlane({ sessionId: "s", flagOn: true, world: WORLD, rows: [], ckpt: { ckptSeq: 1, metaJson: JSON.stringify(meta), checksum: "x", updatedAt: 1 }, frontier: 1 });
    assert.equal(p.health, "red");
    assert.equal(p.reason, "R1");
});

test("R1: an S4 drift with NO log advance → corruption → permanently dead", () => {
    const rows: SnapRow[] = [
        { sessionId: "s", pos: 1, coreIds: '["ca1"]', preJson: null, postJson: JSON.stringify([core("ca1")]), tokensEst: 1, active: true, coverRef: null, updatedAt: 1 },
    ];
    const meta = { v: 1, kernelState: {}, stateChecksum: stateChecksum({}), coverage: {}, s4: "MISMATCH" };
    const p = hydratePlane({ sessionId: "s", flagOn: true, world: WORLD, rows, ckpt: { ckptSeq: 1, metaJson: JSON.stringify(meta), checksum: "x", updatedAt: 1 }, frontier: 1 });
    assert.equal(p.health, "red");
    assert.equal(p.reason, "R1");
});

test("hydrate: an S4 drift WITH a log advance is a legal move → green", () => {
    const rows: SnapRow[] = [
        { sessionId: "s", pos: 1, coreIds: '["ca1"]', preJson: null, postJson: JSON.stringify([core("ca1")]), tokensEst: 1, active: true, coverRef: null, updatedAt: 1 },
        { sessionId: "s", pos: 2, coreIds: '["cb1"]', preJson: null, postJson: JSON.stringify([core("cb1")]), tokensEst: 1, active: true, coverRef: null, updatedAt: 2 },
    ];
    const meta = { v: 1, kernelState: {}, stateChecksum: stateChecksum({}), coverage: {}, s4: "OLD" };
    const p = hydratePlane({ sessionId: "s", flagOn: true, world: WORLD, rows, ckpt: { ckptSeq: 1, metaJson: JSON.stringify(meta), checksum: "x", updatedAt: 1 }, frontier: 5 });
    assert.equal(p.health, "green");
    assert.equal(p.rows?.size, 2, "both active rows are readable");
    assert.equal(p.turnCount, 1, "turnCount = the ckpt seq");
});

test("hydrate: no ckpt yet (first turns) → green with an empty meta", () => {
    const rows: SnapRow[] = [
        { sessionId: "s", pos: 1, coreIds: '["ca1"]', preJson: null, postJson: JSON.stringify([core("ca1")]), tokensEst: 1, active: true, coverRef: null, updatedAt: 1 },
    ];
    const p = hydratePlane({ sessionId: "s", flagOn: true, world: WORLD, rows, ckpt: null, frontier: 1 });
    assert.equal(p.health, "green");
    assert.equal(p.meta, undefined);
    assert.equal(p.rows?.get(1)?.postJson, JSON.stringify([core("ca1")]));
});

test("parseEnvelope: the {id,pos} canon + the bare-id fallback", () => {
    const { envelope, posMap } = parseEnvelope(JSON.stringify([{ id: "a", pos: 1 }, { id: "x", pos: 4 }]));
    assert.deepEqual(envelope, [
        { id: "a", pos: 1 },
        { id: "x", pos: 4 },
    ]);
    assert.deepEqual(posMap, { a: 1, x: 4 });
    const bare = parseEnvelope(JSON.stringify(["m1", "m2"]));
    assert.deepEqual(bare.posMap, { m1: 1, m2: 2 });
    assert.deepEqual(parseEnvelope("{bad"), { envelope: [], posMap: {} });
});

// ---------------------------------------------------------------------------
// lane decision
// ---------------------------------------------------------------------------

function greenPlane() {
    return hydratePlane({ sessionId: "s", flagOn: true, world: WORLD, rows: [], ckpt: null, frontier: 0 })!;
}

test("lane: a green plane → snapshot lane, token 'hit'", () => {
    const d = decideSnapshotLane(true, greenPlane());
    assert.equal(d.lane, "snapshot");
    assert.equal(d.token, "hit");
    assert.ok(d.plane);
});

test("lane: not in the cohort → legacy, token 'miss'", () => {
    const d = decideSnapshotLane(false, greenPlane());
    assert.equal(d.lane, "legacy");
    assert.equal(d.token, "miss");
});

test("lane: no plane yet (fresh session) → legacy, token 'arm'", () => {
    const d = decideSnapshotLane(true, null);
    assert.equal(d.lane, "legacy");
    assert.equal(d.token, "arm");
});

test("lane: R3 (cohort identity fault) → legacy, token 'red:R3'", () => {
    const d = decideSnapshotLane(true, greenPlane(), "R3");
    assert.equal(d.lane, "legacy");
    assert.equal(d.token, "red:R3");
    assert.equal(d.redGate, "R3");
});

test("lane: R2 (join break) → legacy + resyncNextTurn (per-turn, plane survives)", () => {
    const d = decideSnapshotLane(true, greenPlane(), "R2");
    assert.equal(d.lane, "legacy");
    assert.equal(d.token, "red:R2");
    assert.equal(d.resyncNextTurn, true);
});

test("lane: R1/R4 (plane death) → legacy, no resync", () => {
    for (const gate of ["R1", "R4"] as const) {
        const d = decideSnapshotLane(true, greenPlane(), gate);
        assert.equal(d.lane, "legacy");
        assert.equal(d.token, `red:${gate}`);
        assert.equal(d.resyncNextTurn, false);
    }
});

test("lane: a red 'off'/'no-tables' plane → degrade (not a red gate)", () => {
    const off = hydratePlane({ sessionId: "s", flagOn: false, world: WORLD, rows: [], ckpt: null, frontier: 0 })!;
    const d = decideSnapshotLane(true, off);
    assert.equal(d.lane, "legacy");
    assert.equal(d.token, "degrade");
    assert.equal(d.redGate, undefined);
});

// ---------------------------------------------------------------------------
// stage 4 — egress
// ---------------------------------------------------------------------------

test("egress: active rows (host order) ++ fresh tail cores", () => {
    const out = buildEgressView({
        activeRows: [
            { pos: 1, postJson: JSON.stringify([core("ca1")]) },
            { pos: 3, postJson: JSON.stringify([core("cc1")]) }, // host order, not pos order
        ],
        tailCores: [[core("cx1")]],
    });
    assert.deepEqual(out.cores, [core("ca1"), core("cc1"), core("cx1")]);
    assert.equal(out.prefixCount, 2);
    assert.equal(out.tailCount, 1);
});

test("egress: a corrupt post form trips (never emit garbage bytes)", () => {
    assert.throws(
        () => buildEgressView({ activeRows: [{ pos: 1, postJson: "{bad json" }], tailCores: [] }),
        /corrupt post form/,
    );
    assert.throws(
        () => buildEgressView({ activeRows: [{ pos: 1, postJson: '{"a":1}' }], tailCores: [] }),
        /not an array/,
    );
});

test("sha256hex: stable lowercase-hex", () => {
    assert.equal(sha256hex("abc"), sha256hex("abc"));
    assert.match(sha256hex("abc"), /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// pinned head (kernel rebuildMessages never hides the first user core run)
// ---------------------------------------------------------------------------

test("reconcile: pinned head — a covered first-user row stays ACTIVE (T4 byte parity)", () => {
    const cur = new Map<number, SnapshotRowView>([
        [1, row(1, [core("ca1")])],
        [2, row(2, [core("cb1")])],
        [3, row(3, [core("cc1")])],
    ]);
    // Fold covers pos 1-3; pos 1 is the pinned first-user core → stays active.
    const out = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: ["pc", "pr"],
        posMap: { a: 1, b: 2, c: 3, pc: 4, pr: 5 },
        parsedCores: [[core("pcx")], [core("prx")]],
        blockCoverage: [{ blockId: "blk1", coreIds: ["ca1", "cb1", "cc1"] }],
        modelView: [core("pcx"), core("prx")],
        pinnedHeadIds: ["ca1"],
        foldedThisTurn: true,
        kernelState: { blocks: ["blk1"] },
        now: 6,
        turnCount: 5,
        ckptEveryNTurns: 16,
    });
    assert.equal(out.joinOk, true);
    const r1 = out.rows.find((r) => r.pos === 1)!;
    assert.equal(r1.active, true, "the pinned head stays in the egress");
    assert.equal(r1.coverRef, "blk1", "…with the covering block as its lifecycle anchor");
    const byPos = new Map(out.events.map((e) => [e.pos, e]));
    assert.equal(byPos.get(1)!.kind, "compact");
    assert.equal(byPos.get(1)!.blockId, "blk1");
    // The other covered rows deactivate.
    assert.equal(out.rows.find((r) => r.pos === 2)!.active, false);
    assert.equal(out.rows.find((r) => r.pos === 3)!.active, false);
    // The ckpt's S4 covers the pinned head + the fresh tail.
    assert.notEqual(out.ckpt, undefined);
});

test("reconcile: re-pin — an inactive covered row returns to the egress (self-heal)", () => {
    // The fold commit had no envelope to know pos 1 would be re-rendered →
    // it deactivated the row; the model turn's pinned-head evidence now
    // covers it → an update event flips liveness back on.
    const cur = new Map<number, SnapshotRowView>([
        [1, row(1, [core("ca1")], { active: false, coverRef: "blk1" })],
        [2, row(2, [core("cb1")], { active: false, coverRef: "blk1" })],
    ]);
    const out = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: ["a", "pc", "pr"],
        posMap: { a: 1, pc: 3, pr: 4 },
        parsedCores: [[core("ca1")], [core("pcx")], [core("prx")]],
        blockCoverage: [{ blockId: "blk1", coreIds: ["ca1", "cb1"] }],
        modelView: [core("ca1"), core("pcx"), core("prx")],
        pinnedHeadIds: ["ca1"],
        foldedThisTurn: false,
        kernelState: {},
        now: 7,
        turnCount: 6,
        ckptEveryNTurns: 16,
    });
    assert.equal(out.joinOk, true);
    const r1 = out.rows.find((r) => r.pos === 1)!;
    assert.equal(r1.active, true);
    assert.equal(r1.coverRef, "blk1");
    const ev1 = out.events.find((e) => e.pos === 1)!;
    assert.equal(ev1.kind, "update");
    assert.equal(ev1.evidence, "repinned@1");
    // pos 2 (covered, NOT pinned) stays inactive — no event (already so).
    assert.equal(out.rows.find((r) => r.pos === 2), undefined);
});

test("reconcile: fold-only commit (scopeFull:false) — the tail is carried, not swept", () => {
    const cur = new Map<number, SnapshotRowView>([
        [1, row(1, [core("ca1")])],
        [2, row(2, [core("cb1")])],
        [3, row(3, [core("cc1")])], // tail — outside the fold's authority
    ]);
    const out = reconcile({
        sessionId: "s",
        currentRows: cur,
        envelope: [],
        posMap: {},
        parsedCores: [],
        blockCoverage: [{ blockId: "blk1", coreIds: ["ca1", "cb1"] }],
        modelView: [],
        pinnedHeadIds: ["ca1"],
        foldedThisTurn: true,
        kernelState: { blocks: ["blk1"] },
        now: 8,
        turnCount: 7,
        ckptEveryNTurns: 1, // every fold is a ckpt boundary
        scopeFull: false,
    });
    assert.equal(out.joinOk, true);
    const byPos = new Map(out.events.map((e) => [e.pos, e]));
    assert.equal(byPos.get(1)!.kind, "compact"); // pinned head: anchored, stays active
    assert.equal(byPos.get(2)!.kind, "compact");
    assert.equal(byPos.has(3), false, "the tail row gets NO event from a fold-only commit");
    assert.equal(out.rows.find((r) => r.pos === 1)!.active, true);
    assert.equal(out.rows.find((r) => r.pos === 2)!.active, false);
    // The ckpt S4 covers the pinned head (pos 1) AND the carried tail (pos 3);
    // an S4 that skipped the live tail would red-flag the next hydrate.
    assert.notEqual(out.ckpt, undefined);
    const expectedS4 = s4Aggregate([
        { pos: 1, postJson: JSON.stringify([core("ca1")]) },
        { pos: 3, postJson: JSON.stringify([core("cc1")]) },
    ]);
    assert.equal(out.ckpt!.s4, expectedS4);
});
