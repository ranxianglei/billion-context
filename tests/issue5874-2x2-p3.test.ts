/**
 * #5874 2×2 — stage-0 identity enrollment (M1/M2 inbound) acceptance items
 * (brief comment 19544722, tracking #6181), pure-incremental v2 shape:
 *
 *   M1 full-inbound + snapshot egress   (the #5901 behavior)
 *   M2 incremental-inbound + snapshot   (matchAppend + seqs carrier)
 *
 * The OUTBOUND axis (snapshot/delta egress) is a separate follow-up — the
 * stored plane it built on is retired in the v2 redesign; what remains
 * here is the INBOUND identity engine (l1_world + stage-0 six verdicts +
 * the R3 gate) with its paired ± pins.
 *
 * Unit scope:
 *   W*  the world verdicts — echo/probe/scatter/issue/diverge/resync ± pairs
 *       (acceptance 5), the B1 origin-immutability trap, matchAppend.
 *   A*  store seam — M2 seqs-carrier gating (±), #7 resync one-round
 *       convergence (acceptance 7), M4 codec-level pin.
 *   R*  red gates — R3 identity fault (400 + zero side effects + breaker),
 *       R2 diverge zero side effects.
 *   S*  the stage-0 store seam — M1 seed → M2 append → M1 echo round trip
 *       through SQLite.
 *   B*  HTTP e2e — R3 400 funnel, pure-continuation passthrough.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BiliMessage } from "acp-kernel/wire";
import { openaiToCore } from "acp-kernel/wire";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import {
    matchWorld,
    matchAppend,
} from "../src/snapshot/identity.ts";
import type { WorldEnvelopeEntry } from "../src/snapshot/types.ts";
import { envelopeChecksum } from "../src/snapshot/checksums.ts";
import {
    FoundationRejectError,
    R3FaultTracker,
    checkR3Identity,
    stage0Decide,
} from "../src/snapshot/plane.ts";
import { snapL1Lookup, snapL1EnvelopeRead, snapL1Record, type DbLike } from "../src/storage/snap.ts";

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
    return UnifiedStore.open(p);
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
    const d = matchWorld(matchInput(stored, ["m1", "m2", "m3", "m4"]));
    assert.equal(d.mode, "echo");
    assert.deepEqual(d.envelope, stored.envelope, "the stored canon is returned VERBATIM (B1: origin ids never re-minted)");
    assert.equal(d.envelopeChecksum, stored.envelopeChecksum);
    assert.deepEqual(d.newIdPos, []);
});

test("W2 echo +/- : one id changed → NOT echo (the checksum is content-binding)", () => {
    const stored = canon(4);
    const d = matchWorld(matchInput(stored, ["m1", "m2", "X", "m4"]));
    assert.notEqual(d.mode, "echo");
});

test("W3 probe: a tail extension → probe, fresh pos at maxPos+1", () => {
    const stored = canon(4);
    const d = matchWorld(matchInput(stored, ["m1", "m2", "m3", "m4", "m5"]));
    assert.equal(d.mode, "probe");
    assert.deepEqual(d.newIdPos, [{ id: "m5", pos: 5 }]);
});

test("W4 probe +/- : the extension with a GAP in the middle → scatter", () => {
    const stored = canon(4);
    const d = matchWorld(matchInput(stored, ["m1", "m3", "m5"]));
    assert.equal(d.mode, "scatter");
});

test("W5 issue: no stored canon → issue, fresh pos 0.., armed now", () => {
    const d = matchWorld(matchInput(null, ["a", "b"]));
    assert.equal(d.mode, "issue");
    assert.deepEqual(d.newIdPos, [{ id: "a", pos: 1 }, { id: "b", pos: 2 }]);
    assert.equal(d.armedAt, now0 + 1);
});

test("W6 issue +/- : resync with a stored canon → re-issue pos 1.. from the client array", () => {
    const stored = canon(4);
    const d = matchWorld(matchInput(stored, ["X", "Y", "Z"], { resync: true }));
    assert.equal(d.mode, "resync");
    assert.deepEqual(d.newIdPos, [{ id: "X", pos: 1 }, { id: "Y", pos: 2 }, { id: "Z", pos: 3 }]);
});

test("W7 diverge: head moved → diverge, canon untouched", () => {
    const stored = canon(4);
    const d = matchWorld(matchInput(stored, ["OTHER", "m1", "m2", "m3"]));
    assert.equal(d.mode, "diverge");
});

test("W8 diverge: survivor order broken → diverge", () => {
    const stored = canon(4);
    const d = matchWorld(matchInput(stored, ["m1", "m3", "m2", "m4"]));
    assert.equal(d.mode, "diverge");
});

test("W9 diverge +/- : a fold-explained gone at the head is NOT a head move", () => {
    const stored = canon(4);
    // m1 is covered by a live fold (legally vanished); the rest are intact.
    const d = matchWorld(matchInput(stored, ["m2", "m3", "m4"], { explainedGone: new Set(["m1"]) }));
    assert.equal(d.mode, "probe");
    assert.deepEqual(d.newIdPos, []);
});

test("W10 matchAppend: pure M2 addition — canon order preserved, whole-sequence checksum", () => {
    const stored = canon(4);
    const d = matchAppend(stored, ["m5", "m6"]);
    assert.equal(d.mode, "probe");
    assert.deepEqual(d.newIdPos, [{ id: "m5", pos: 5 }, { id: "m6", pos: 6 }]);
    assert.deepEqual(
        d.envelope.map((e) => e.id),
        ["m1", "m2", "m3", "m4", "m5", "m6"],
        "the stored order is preserved, new ids appended",
    );
    assert.equal(d.envelopeChecksum, envelopeChecksum(["m1", "m2", "m3", "m4", "m5", "m6"]));
});

test("W11 matchAppend +/- : the next M1 full resend echoes (the round-trip)", () => {
    const stored = canon(4);
    const app = matchAppend(stored, ["m5"]);
    const re = matchWorld(matchInput({ ...stored, envelope: app.envelope, envelopeChecksum: app.envelopeChecksum }, ["m1", "m2", "m3", "m4", "m5"]));
    assert.equal(re.mode, "echo");
    assert.deepEqual(re.newIdPos, []);
});

// ---------------------------------------------------------------------------
// A — the stage-0 store seam (M2 gating, resync convergence, codec pin)
// ---------------------------------------------------------------------------

function storeWithRows(n: number, sid: string): UnifiedStore {
    const store = openPlane(path.join(hermetic, `a-${sid}-${n}`, "index.db"));
    store.ingestSession(planIngest(plainSession(sid, n)));
    return store;
}

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

test("A4 #7 resync: diverge → zero side effects (the canon is untouched), resync one-round convergence", () => {
    const sid = "a4";
    const store = storeWithRows(10, sid);
    const ten = Array.from({ length: 10 }, (_, i) => `m${i + 1}`);
    const seed = store.snapStage0(sid, ten);
    assert.equal(seed.decision.mode, "issue");
    const db = (store as unknown as { db: DbLike }).db;
    const sessRaw = sid; // plainSession id == conversation id
    const before = snapL1EnvelopeRead(db, sessRaw);
    assert.ok(before && before.envelopeChecksum);

    const d = store.snapStage0(sid, ["OTHER", "m1", "m2"]);
    assert.equal(d.decision.mode, "diverge");
    assert.equal(d.diverge, true);

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
});

test("A4b #7 +/- : a plain issue is the NORMAL seed (not a resync)", () => {
    const sid = "a4b";
    const store = openPlane(path.join(hermetic, "a4b", "index.db"));
    const d = store.snapStage0(sid, ["a", "b", "c"]);
    assert.equal(d.decision.mode, "issue");
    assert.notEqual(d.decision.mode, "resync", "seed must not loop the reset");
});

test("A1d M4: the codec-level pin — parsing the new element ALONE (M2 wire) yields the same core as parsing it inside the full array (M1 wire), wireIndex aside", () => {
    const contents = Array.from({ length: 11 }, (_, i) => `codec content ${i + 1}`);
    const fullBody = { model: "gpt-m4", messages: contents.map((c) => ({ role: "user", content: c })) };
    const full = openaiToCore(fullBody as never);
    assert.equal(full.msgs.length, 11);
    // M2 wire: the client sends ONLY the 11th element — a fresh parse with a
    // fresh ClusterCounter. The canonical id derives from (role, contentType,
    // text), so the counter state cannot change the id for an element whose
    // content appears once.
    const inc = openaiToCore({ model: "gpt-m4", messages: [fullBody.messages[10]!] } as never);
    assert.equal(inc.msgs.length, 1);
    const strip = (m: BiliMessage): Record<string, unknown> => {
        const c = { ...(m as unknown as Record<string, unknown>) };
        delete c.wireIndex; // position on the wire — legitimately differs (10 vs 0)
        return c;
    };
    assert.equal(
        JSON.stringify(strip(full.msgs[10]!)),
        JSON.stringify(strip(inc.msgs[0]!)),
        "the new element's core is byte-identical between the full-array parse (M1) and the standalone parse (M2) — the M2 parse of ONLY the new span is assembly-equivalent by construction, not by luck",
    );
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
    const db = (openPlane(path.join(dir, "index.db")) as unknown as { db: DbLike }).db;
    // The l1 row is recorded by the store facade before stage0 (the lane
    // path) — do it here so the pure function has its world to match.
    snapL1Record(db, "s5", "s5", "witness", now0);
    // Seed the world: issue a 3-id envelope.
    const seed = stage0Decide({ db, sessRaw: "s5", ledgerId: "s5", incoming: ["a", "b", "c"], maxSeq: 0, explainedGone: new Set(), now: now0 });
    assert.equal(seed.decision.mode, "issue");
    // A structural disagreement (head moved): the verdict is diverge and the
    // stored envelope is UNCHANGED (zero side effects — the lane runs the
    // legacy round and the client converges next turn).
    const d = stage0Decide({ db, sessRaw: "s5", ledgerId: "s5", incoming: ["OTHER", "a", "b"], maxSeq: 0, explainedGone: new Set(), now: now0 + 1 });
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

    // Seed: the client's first full array (3 ids).
    const seed = store.snapStage0(sid, ["m1", "m2", "m3"]);
    assert.equal(seed.decision.mode, "issue");

    // M1 tail extension: full resend + one new id (1-based pos: seed is 1..3
    // → m4 lands at pos 4).
    const m1 = store.snapStage0(sid, ["m1", "m2", "m3", "m4"]);
    assert.equal(m1.decision.mode, "probe");
    assert.deepEqual(m1.decision.newIdPos, [{ id: "m4", pos: 4 }]);

    // M2: ONLY the new id + the seqs carrier (3 live rows seq 1..3 →
    // frontier 3, the next seq is 4).
    store.ingestSession(planIngest(plainSession(sid, 4)));
    const m2 = store.snapStage0(sid, ["m5"], { seqs: [4] });
    assert.equal(m2.decision.mode, "probe", "the M2 append");
    assert.deepEqual(m2.decision.newIdPos, [{ id: "m5", pos: 5 }]);
    assert.deepEqual(m2.decision.envelope.map((e) => e.id), ["m1", "m2", "m3", "m4", "m5"]);

    // The next M1 full resend must ECHO the matchAppend canon.
    const echo = store.snapStage0(sid, ["m1", "m2", "m3", "m4", "m5"]);
    assert.equal(echo.decision.mode, "echo", "M1 full resend echoes the M2-persisted canon");
    assert.deepEqual(echo.decision.newIdPos, []);
});

// ---------------------------------------------------------------------------
// M3 — the R3 latch persistence seam
// ---------------------------------------------------------------------------

test("M3: the R3 latch persists across store instances — a latched session degrades forever, never 400s again", () => {
    const p = path.join(hermetic, "m3", "index.db");
    const a = openPlane(p);
    assert.equal(a.snapR3Latched("sid-m3"), false);
    a.snapR3Latch("sid-m3");
    // A FRESH instance over the same file — the process restart case: the
    // in-memory breaker is cold, the persisted latch must carry the state.
    const b = openPlane(p);
    assert.equal(b.snapR3Latched("sid-m3"), true, "the latch survives a new store instance (process restart)");
    assert.equal(b.snapR3Latched("other-sid"), false, "other sessions are unaffected");
});

// #6785 review: the operator escape hatch — the latch must be VISIBLE
// (roster) and CLEARABLE (persisted), or a mislatched session is bricked to
// the legacy path with no remedy.
test("M3.1: the latch roster lists the stuck sids and the clear PERSISTS (survives a restart)", () => {
    const p = path.join(hermetic, "m3-unlatch", "index.db");
    const a = openPlane(p);
    a.snapR3Latch("sid-u");
    a.snapR3Latch("sid-v");
    const roster = a.snapR3LatchedList();
    assert.deepEqual(roster.map((r) => r.sessRaw).sort(), ["sid-u", "sid-v"], "both latched sids visible in the roster");
    for (const r of roster) {
        assert.equal(r.ledgerId, r.sessRaw, "no conversation binding → the bound ledger id is the raw id itself");
        assert.ok(r.latchedAt > 0, "the latch carries its timestamp (the operator sees how old the stick is)");
    }
    const ledger = a.snapR3LatchClear("sid-u");
    assert.equal(ledger, "sid-u", "the clear returns the bound ledger id (the in-memory breaker key)");
    assert.equal(a.snapR3Latched("sid-u"), false, "cleared in the same instance");
    assert.equal(a.snapR3Latched("sid-v"), true, "the other latch is untouched");
    // The process-restart case: the clear must have persisted.
    const b = openPlane(p);
    assert.equal(b.snapR3Latched("sid-u"), false, "the clear survives a new store instance");
    assert.deepEqual(b.snapR3LatchedList().map((r) => r.sessRaw), ["sid-v"]);
    assert.equal(b.snapR3LatchClear("no-such-sid"), null, "no row → null (the route reports persistedRowCleared=false)");
});

// #6785 review (fix): the unlatch PLACEHOLDER trap. snapR3LatchWrite can run
// BEFORE the first stage-0 round — the placeholder row carries
// ledger_id = sessRaw and witness_probe "" (legitimate rows always carry a
// hashed probe). For a conversation-bound session the raw id ≠ the ledger
// sid, so without a self-heal the placeholder would map sessRaw → a
// DIFFERENT ledger forever and 400 every turn after the operator unlatched.
test("M3.2: unlatching an R3 LATCH PLACEHOLDER self-heals — the next stage-0 rebinds to the real ledger (no permanent 400)", () => {
    const p = path.join(hermetic, "m3.2", "index.db");
    const a = openPlane(p);
    // Conversation binding: ledger sid "sid-cb" → raw conversation id "conv-cb".
    const db = (a as unknown as { db: DbLike }).db;
    db.exec("INSERT INTO conversations (namespace, conversation_id, session_id, claimed_at) VALUES ('default', 'conv-cb', 'sid-cb', 0)");
    // The latch fires on the real sid — the placeholder row is keyed by the
    // resolved raw id and carries ledger_id = sessRaw (the real sid unknown).
    a.snapR3Latch("sid-cb");
    let row = db.prepare("SELECT ledger_id, witness_probe FROM l1_world WHERE sess_raw = ?").get("conv-cb") as { ledger_id: string; witness_probe: string };
    assert.equal(row.ledger_id, "conv-cb", "placeholder: the ledger id IS the raw id (the real sid was unknown at latch time)");
    assert.equal(row.witness_probe, "", "placeholder: no witness probe yet (legitimate rows always carry a hash)");
    // The operator unlatches (POST /__bili/snapshot/r3-unlatch {sessRaw}).
    assert.equal(a.snapR3LatchClear("conv-cb"), "conv-cb");
    // The next turn: BEFORE the fix this threw FoundationRejectError (red)
    // forever. Now the placeholder is rebindable — stage-0 succeeds and the
    // row anchors the REAL ledger.
    const d = a.snapStage0("sid-cb", ["m1"]);
    assert.ok(d, "stage-0 completed — no R3 400 after unlatch");
    row = db.prepare("SELECT ledger_id, witness_probe FROM l1_world WHERE sess_raw = ?").get("conv-cb") as { ledger_id: string; witness_probe: string };
    assert.equal(row.ledger_id, "sid-cb", "the placeholder was rebound to the real ledger sid");
    assert.notEqual(row.witness_probe, "", "the rebased row carries a real witness probe");
    // And the FOLLOWING round is a clean echo (the mapping is stable now).
    assert.doesNotThrow(() => a.snapStage0("sid-cb", ["m1"]));
});

// #6785 review (regression guard for the self-heal): a REAL ledger row
// (hashed witness probe) under a different sid must STILL hard-400 — the
// placeholder marker (probe "") is the ONLY rebindable shape.
test("M3.2b: a REAL ledger mapping still red 400s after unlatch (the self-heal never masks a genuine R3 conflict)", () => {
    const p = path.join(hermetic, "m3.2b", "index.db");
    const a = openPlane(p);
    const db = (a as unknown as { db: DbLike }).db;
    // Real ledger "s1" (no conversation binding → raw = ledger) issues its
    // l1 row with a hashed witness probe.
    assert.equal(a.snapStage0("s1", ["a", "b"]).decision.mode, "issue");
    // A conversation-bound session whose raw id collides with that ledger.
    db.exec("INSERT INTO conversations (namespace, conversation_id, session_id, claimed_at) VALUES ('default', 's1', 's2', 0)");
    a.snapR3Latch("s2"); // latch write is a no-op on the ledger fields (COALESCE keeps "s1")
    a.snapR3LatchClear("s1");
    assert.throws(
        () => a.snapStage0("s2", ["a", "b"]),
        (e: unknown) => e instanceof FoundationRejectError && /l1 ledger conflict/.test(String(e)),
        "genuine conflict (real probe, different ledger) still hard-rejects",
    );
});

// ── HTTP e2e (real proxy + fake upstream) ───────────────────────────────────

import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

function listenT(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}
function closeT(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
function sseDone(id = "resp_done"): string {
    const sse = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    return [
        sse("response.output_item.done", { item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok" }] }, output_index: 0 }),
        sse("response.completed", { response: { id, status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } }),
    ].join("");
}

type UpstreamBehavior = (n: number, body: string) => { status: number; payload: string };

async function withProxyT(
    behavior: UpstreamBehavior,
    fn: (url: string, bodies: string[]) => Promise<void>,
    opts: { env?: Record<string, string> } = {},
): Promise<void> {
    const bodies: string[] = [];
    let reqN = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            bodies.push(body);
            const { status, payload } = behavior(++reqN, body);
            const streaming = payload.startsWith("event: ");
            res.writeHead(status, streaming ? { "content-type": "text/event-stream", "cache-control": "no-cache" } : { "content-type": "application/json" });
            res.write(payload);
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listenT(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const savedEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(opts.env ?? {})) { savedEnv[k] = process.env[k]; process.env[k] = v; }
    try {
        _setStoreForTest(new SessionStore({ enabled: false }));
        const proxyOpts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-e2e": { context: 400_000 } } } },
            modelContextLimit: 400_000,
            kernelConfig: defaultConfig(400_000),
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: true,
            logFile: "off",
            debug: false,
            passthrough: false,
            autoUpdate: false,
            compat: { roles: {} },
            streamErrorShape: "protocol",
            passthroughSource: null,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            advisoryCheck: false,
            releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        const proxy = await startServer(proxyOpts);
        await listenT(proxy);
        const proxyPort = (proxy.address() as { port: number }).port;
        try {
            await fn(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, bodies);
        } finally {
            await closeT(proxy);
        }
    } finally {
        await closeT(upstream);
        for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        delete process.env.BILI_STORAGE_UNIFIED;
        _setStoreForTest(new SessionStore({ enabled: false }));
    }
}

const PLUGIN_HEADERS = { "content-type": "application/json", "x-bili-plugin": "e2e-agent", "x-acp-session": "e2e-sess" } as Record<string, string>;

test("B1: a declared host that fails to collect msgids (count mismatch) → 400 + x-bili-snapshot: identity, no upstream forward", async () => {
    await withProxyT(
        () => ({ status: 200, payload: sseDone() }),
        async (url, bodies) => {
            const res = await fetch(url, {
                method: "POST",
                headers: PLUGIN_HEADERS,
                body: JSON.stringify({
                    model: "gpt-e2e",
                    stream: true,
                    input: [
                        { type: "message", role: "user", content: "first" },
                        { type: "message", role: "user", content: "second" },
                    ],
                    biliMsgIds: ["b1m1"], // 1 declared vs 2 elements — the R3 fault
                }),
            });
            assert.equal(res.status, 400, "the identity fault is a 400 (the B1 control channel — not the generic 503)");
            assert.equal(res.headers.get("x-bili-snapshot"), "identity");
            const err = JSON.parse(await res.text()) as { error: { type: string; message: string } };
            assert.equal(err.error.type, "snapshot_identity_fault");
            assert.ok(err.error.message.includes("R3"), "the error names the fault class");
            assert.equal(bodies.length, 0, "zero side effects: the upstream was never contacted");
        },
        { env: { BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY: "1" } },
    );
});

test("M3.2: the admin unlatch routes exist and are gated (501 in legacy mode, 400 on a malformed body)", async () => {
    await withProxyT(
        () => ({ status: 200, payload: sseDone() }),
        async (url) => {
            const base = url.slice(0, url.indexOf("/bili/"));
            const listRes = await fetch(`${base}/__bili/snapshot/r3-latches`);
            assert.equal(listRes.status, 501, "legacy mode → 501 (the knob, not the URL, is missing)");
            const badRes = await fetch(`${base}/__bili/snapshot/r3-unlatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
            assert.equal(badRes.status, 400, "a body without sessRaw is rejected before touching the store");
            const unlatchRes = await fetch(`${base}/__bili/snapshot/r3-unlatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessRaw: "e2e-sess" }) });
            assert.equal(unlatchRes.status, 501, "a well-formed body still 501s in legacy mode (unified store required)");
        },
        {},
    );
});

test("B3: a plugin chained round with EMPTY input is a pure continuation — the raw body passes through verbatim (no dev injection, id kept)", async () => {
    await withProxyT(
        () => ({ status: 200, payload: sseDone() }),
        async (url, bodies) => {
            const reqBody = { model: "gpt-e2e", stream: true, previous_response_id: "resp_b3", input: [] };
            const res = await fetch(url, { method: "POST", headers: PLUGIN_HEADERS, body: JSON.stringify(reqBody) });
            assert.equal(res.status, 200);
            await res.text();
            assert.equal(bodies.length, 1);
            const fwd = JSON.parse(bodies[0]!) as Record<string, unknown>;
            assert.equal(fwd.previous_response_id, "resp_b3", "the chain id is forwarded intact");
            assert.deepEqual(fwd.input, [], "the empty input passes through (NOT rebuilt, NOT dropped)");
            assert.ok(!JSON.stringify(fwd).includes("You are bili"), "no developer-message injection on the pure continuation (the B3 blind-response fix)");
        },
        {},
    );
});
