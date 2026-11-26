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
 *   W*  the world verdicts — echo/extend/shrink/reanchor/issue/resync ± pairs
 *       (acceptance 5, #7064 D1: NO verdict diverges), matchAppendWindow.
 *   A*  store seam — M2 seqs-carrier gating (±), #7 reanchor one-round
 *       convergence (acceptance 7), M4 codec-level pin.
 *   R*  red gates — R3 identity fault (400 + zero side effects + breaker),
 *       reanchor one cheap UPDATE (no reject).
 *   S*  the stage-0 store seam — M1 seed → M2 append → M1 echo round trip
 *       through SQLite.
 *   B*  HTTP e2e — R3 400 funnel, pure-continuation passthrough.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BiliMessage } from "acp-kernel/wire";
import { openaiToCore } from "acp-kernel/wire";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import {
    matchAppendWindow,
    matchWindow,
    windowOf,
    WORLD_HEAD_K,
    WORLD_TAIL_K,
} from "../src/snapshot/identity.ts";
import type { WorldWindow } from "../src/snapshot/types.ts";
import {
    FoundationRejectError,
    R3FaultTracker,
    checkR3Identity,
    r3FaultTracker,
    stage0Decide,
} from "../src/snapshot/plane.ts";
import { runStage0 } from "../src/snapshot/stage0.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { snapL1Lookup, snapL1WindowRead, snapL1Record, type DbLike } from "../src/storage/snap.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5874-p3-"));
const configPath = path.join(hermetic, "config.json");
fs.writeFileSync(configPath, "{}");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type StoredWorld = {
    ledgerId: string;
    window: WorldWindow;
    issuedAt: number;
    armedAt?: number;
};

interface WorldMatchInputLocal {
    stored: WorldWindow | null;
    issuedAt: number;
    incoming: string[];
    sessRaw: string;
    ledgerId: string;
    now: number;
    resync?: boolean;
}

const now0 = 1_700_000_000_000;

/** A stored world cursor (windows) for ids 0..n-1 (1-based ids m1.., 1-based
 *  pos, the issue/resync shape). */
function world(n: number): StoredWorld {
    const ids = Array.from({ length: n }, (_, i) => `m${i + 1}`);
    return {
        ledgerId: "sid-t",
        window: windowOf(ids, n),
        issuedAt: now0,
    };
}

function matchInput(stored: StoredWorld | null, incoming: string[], extra: Partial<WorldMatchInputLocal> = {}): WorldMatchInputLocal {
    return {
        stored: stored === null ? null : stored.window,
        issuedAt: stored === null ? 0 : stored.issuedAt,
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
    };
}

// ---------------------------------------------------------------------------
// W — the world verdicts (acceptance 5: each verdict with paired +/- tests)
// ---------------------------------------------------------------------------

test("W1 echo: the same window state → echo, cursor untouched, B1 origin frozen", () => {
    const stored = world(4);
    const d = matchWindow(matchInput(stored, ["m1", "m2", "m3", "m4"]));
    assert.equal(d.mode, "echo");
    assert.equal(d.window, stored.window, "the stored cursor is returned VERBATIM (B1: origin ids never re-minted)");
    assert.deepEqual(d.newIdPos, []);
});

test("W2 echo +/- : one id changed → NOT echo (a middle rewrite is a reanchor, D1: never a reject)", () => {
    const stored = world(4);
    const d = matchWindow(matchInput(stored, ["m1", "m2", "X", "m4"]));
    assert.notEqual(d.mode, "echo");
    assert.equal(d.mode, "reanchor");
});

test("W3 extend: a tail extension → extend, fresh pos at maxPos+1", () => {
    const stored = world(4);
    const d = matchWindow(matchInput(stored, ["m1", "m2", "m3", "m4", "m5"]));
    assert.equal(d.mode, "extend");
    assert.deepEqual(d.newIdPos, [{ id: "m5", pos: 5 }]);
});

test("W4 extend +/- : the extension with a GAP in the middle → reanchor (D1: no scatter reject)", () => {
    const stored = world(4);
    const d = matchWindow(matchInput(stored, ["m1", "m3", "m5"]));
    assert.equal(d.mode, "reanchor");
});

test("W5 issue: no stored cursor → issue, fresh pos 0.., issued now", () => {
    const d = matchWindow(matchInput(null, ["a", "b"]));
    assert.equal(d.mode, "issue");
    assert.deepEqual(d.newIdPos, [{ id: "a", pos: 1 }, { id: "b", pos: 2 }]);
    assert.equal(d.issuedAt, now0 + 1);
});

test("W6 issue +/- : resync with a stored cursor → re-issue pos 1.. from the client array", () => {
    const stored = world(4);
    const d = matchWindow(matchInput(stored, ["X", "Y", "Z"], { resync: true }));
    assert.equal(d.mode, "resync");
    assert.deepEqual(d.newIdPos, [{ id: "X", pos: 1 }, { id: "Y", pos: 2 }, { id: "Z", pos: 3 }]);
});

test("W7 head swap → reanchor (D1: NEVER diverge — the cursor re-issues, nothing is rejected)", () => {
    const stored = world(4);
    const d = matchWindow(matchInput(stored, ["OTHER", "m1", "m2", "m3"]));
    assert.equal(d.mode, "reanchor");
});

test("W8 survivor order broken → reanchor (D1: never diverge)", () => {
    const stored = world(4);
    const d = matchWindow(matchInput(stored, ["m1", "m3", "m2", "m4"]));
    assert.equal(d.mode, "reanchor");
});

test("W9 fold-explained head drop → shrink (legal, no new ids)", () => {
    const stored = world(4);
    // m1 vanished (covered by a live fold); the rest are intact — the whole
    // incoming is a suffix of the stored tail.
    const d = matchWindow(matchInput(stored, ["m2", "m3", "m4"]));
    assert.equal(d.mode, "shrink");
    assert.deepEqual(d.newIdPos, []);
    assert.deepEqual(d.goneIds, ["m1"], "the windowed gone-set sees the dropped head anchor");
});

test("W10 matchAppendWindow: pure M2 addition — head unchanged, tail extended", () => {
    const stored = world(4);
    const d = matchAppendWindow(stored.window, ["m5", "m6"]);
    assert.equal(d.mode, "extend");
    assert.deepEqual(d.newIdPos, [{ id: "m5", pos: 5 }, { id: "m6", pos: 6 }]);
    assert.deepEqual(
        d.window.tailIds,
        ["m1", "m2", "m3", "m4", "m5", "m6"],
        "the stored order is preserved, new ids appended",
    );
    assert.equal(d.window.count, 6);
});

test("W11 matchAppendWindow +/- : the next M1 full resend echoes (the round-trip)", () => {
    const stored = world(4);
    const app = matchAppendWindow(stored.window, ["m5"]);
    const re = matchWindow({ ...matchInput(stored, ["m1", "m2", "m3", "m4", "m5"]), stored: app.window });
    assert.equal(re.mode, "echo");
    assert.deepEqual(re.newIdPos, []);
});

test("W10b matchAppendWindow: >WORLD_TAIL_K stored — the head stays the TRUE head (PR#6785 review)", () => {
    // count 600 > WORLD_TAIL_K(512): stored.tailIds holds only m89..m600, so
    // `[...tailIds, ...new].slice(0, WORLD_HEAD_K)` is a MIDDLE slice. The
    // pre-fix code stored it as headIds, breaking the echo gate
    // (matchWindow's sameArr(s.headIds, incoming[0..K-1])) for every later
    // full-resend turn of a >512-element session: perpetual re-anchor +
    // window upsert (the steady-state no-write contract).
    const n = WORLD_TAIL_K + 88; // 600
    const stored = world(n);
    assert.equal(stored.window.tailIds.length, WORLD_TAIL_K);
    assert.equal(stored.window.tailIds[0], `m${n - WORLD_TAIL_K + 1}`); // m89
    const d = matchAppendWindow(stored.window, [`m${n + 1}`, `m${n + 2}`]);
    assert.equal(d.mode, "extend");
    assert.equal(d.window.count, n + 2);
    assert.equal(d.window.headIds.length, WORLD_HEAD_K);
    assert.equal(d.window.headIds[0], "m1", "head is UNCHANGED by an append");
    assert.deepEqual(d.window.headIds, stored.window.headIds);
    // and the head check the echo gate performs really passes now:
    const full = Array.from({ length: n + 2 }, (_, i) => `m${i + 1}`);
    assert.deepEqual(d.window.headIds, full.slice(0, WORLD_HEAD_K));
});

// ---------------------------------------------------------------------------
// A — the stage-0 store seam (M2 gating, resync convergence, codec pin)
// ---------------------------------------------------------------------------

function storeWithRows(n: number, sid: string): UnifiedStore {
    const store = openPlane(path.join(hermetic, `a-${sid}-${n}`, "index.db"));
    store.ingestSession(planIngest(plainSession(sid, n)));
    return store;
}

test("A1b #2 +/- : the M2 branch REQUIRES the seqs carrier (no seqs → matchWindow path)", () => {
    const sid = "a1b";
    const store = storeWithRows(10, sid);
    store.snapStage0(sid, Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
    // All-unknown WITHOUT seqs: a full (re-minted) array → matchWindow →
    // no anchor overlap → reanchor (D1: the cursor re-issues, never rejects).
    const d = store.snapStage0(sid, ["m11"]);
    assert.equal(d.decision.mode, "reanchor");
});

test("A1c #2 +/- : a non-contiguous seqs run falls back to matchWindow", () => {
    const sid = "a1c";
    const store = storeWithRows(10, sid);
    store.snapStage0(sid, Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
    const d = store.snapStage0(sid, ["m11"], { seqs: [15] });
    assert.notEqual(d.decision.mode, "extend", "seqs[0]=15 != frontier+1=11 → not the M2 append");
});

test("A4 #7 reanchor: a structural change re-issues the cursor, one-round convergence (D1: no reject)", () => {
    const sid = "a4";
    const store = storeWithRows(10, sid);
    const ten = Array.from({ length: 10 }, (_, i) => `m${i + 1}`);
    const seed = store.snapStage0(sid, ten);
    assert.equal(seed.decision.mode, "issue");
    const db = (store as unknown as { db: DbLike }).db;
    const sessRaw = sid; // plainSession id == conversation id
    const before = snapL1WindowRead(db, sessRaw);
    assert.ok(before && before.window, "the seed cursor is persisted");

    const d = store.snapStage0(sid, ["OTHER", "m1", "m2"]);
    assert.equal(d.decision.mode, "reanchor", "D1: a head swap re-anchors — it never rejects");
    assert.deepEqual(d.decision.window.tailIds, ["OTHER", "m1", "m2"], "the new cursor follows the incoming");

    // The next turn with the same array converges to echo (one-round).
    const re = store.snapStage0(sid, ["OTHER", "m1", "m2"]);
    assert.equal(re.decision.mode, "echo");

    // An explicit re-baseline still re-issues from the client array.
    const rs = store.snapStage0(sid, ["OTHER", "m1", "m2"], { resync: true });
    assert.equal(rs.decision.mode, "resync");
    assert.deepEqual(rs.decision.window.tailIds, ["OTHER", "m1", "m2"]);
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

test("R5 R2: reanchor = one cheap cursor re-issue (stage0Decide NEVER rejects a structural disagreement)", () => {
    const dir = path.join(hermetic, "r5");
    fs.mkdirSync(dir, { recursive: true });
    const db = (openPlane(path.join(dir, "index.db")) as unknown as { db: DbLike }).db;
    // The l1 row is recorded by the store facade before stage0 (the lane
    // path) — do it here so the pure function has its world to match.
    snapL1Record(db, "s5", "s5", "witness", now0);
    // Seed the world: issue a 3-id cursor.
    const seed = stage0Decide({ db, sessRaw: "s5", ledgerId: "s5", incoming: ["a", "b", "c"], maxSeq: 0, explainedGone: new Set(), now: now0 });
    assert.equal(seed.decision.mode, "issue");
    // A structural disagreement (head swap): the verdict is reanchor — the
    // cursor re-issues (D1: no reject, no lane reset; middle-tamper is the
    // ledger probes' job, not the cursor's).
    const d = stage0Decide({ db, sessRaw: "s5", ledgerId: "s5", incoming: ["OTHER", "a", "b"], maxSeq: 0, explainedGone: new Set(), now: now0 + 1 });
    assert.equal(d.decision.mode, "reanchor");
    const l1 = snapL1Lookup(db, "s5");
    assert.ok(l1, "the seed l1 row exists");
    const env = snapL1WindowRead(db, "s5");
    assert.ok(env && env.window, "the reanchor persisted the new cursor");
    assert.deepEqual(env!.window!.tailIds, ["OTHER", "a", "b"], "the re-issued cursor follows the incoming");
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
    assert.equal(m1.decision.mode, "extend");
    assert.deepEqual(m1.decision.newIdPos, [{ id: "m4", pos: 4 }]);

    // M2: ONLY the new id + the seqs carrier (3 live rows seq 1..3 →
    // frontier 3, the next seq is 4).
    store.ingestSession(planIngest(plainSession(sid, 4)));
    const m2 = store.snapStage0(sid, ["m5"], { seqs: [4] });
    assert.equal(m2.decision.mode, "extend", "the M2 append");
    assert.deepEqual(m2.decision.newIdPos, [{ id: "m5", pos: 5 }]);
    assert.deepEqual(m2.decision.window.tailIds, ["m1", "m2", "m3", "m4", "m5"]);

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
test("M3.2: the R3 latch placeholder is RETIRED (discussions/7591) — new latches land on the sessions row, and PRE-UPGRADE placeholders still self-heal", () => {
    const p = path.join(hermetic, "m3.2", "index.db");
    const a = openPlane(p);
    // Conversation binding: ledger sid "sid-cb" → raw conversation id "conv-cb".
    const db = (a as unknown as { db: DbLike }).db;
    db.exec("INSERT INTO conversations (namespace, conversation_id, session_id, claimed_at) VALUES ('default', 'conv-cb', 'sid-cb', 0)");
    // NEW CONTRACT (2026-11-23 identity-tables-consolidate; owner ruling
    // 2026-11-24 GATES the sessions-row latch carrier on egressPlane): with
    // the switch on, the latch fires on the sessions row — no l1 placeholder
    // is ever created, so the raw→wrong-ledger trap is structurally
    // impossible for new latches.
    const _prevEgress = process.env.BILI_ROLLOUT_EGRESS_PLANE;
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
    try {
        a.snapR3Latch("sid-cb");
        assert.equal(db.prepare("SELECT sess_raw FROM l1_world WHERE sess_raw = ?").get("conv-cb"), undefined, "no l1 placeholder row is created anymore");
        assert.equal(a.snapR3Latched("sid-cb"), true, "the latch is readable via the sessions row");
        // The operator unlatches (POST /__bili/snapshot/r3-unlatch {sessRaw}).
        assert.equal(a.snapR3LatchClear("conv-cb"), null, "no l1 row, no sessions row for the RAW id → nothing persisted to clear");
        assert.equal(a.snapR3LatchClear("sid-cb"), "sid-cb", "clearing by the ledger sid hits the sessions row");
    } finally {
        if (_prevEgress === undefined) delete process.env.BILI_ROLLOUT_EGRESS_PLANE; else process.env.BILI_ROLLOUT_EGRESS_PLANE = _prevEgress;
    }
    // The next turn: conv-bound bookkeeping — an empty stored set anchors
    // (no red, no rebind needed). Flag-independent (sid-cb is not egress-on).
    assert.equal(a.snapStage0("sid-cb", ["m1"]).decision.mode, "anchor");
    // LEGACY GUARD: a PRE-UPGRADE placeholder (written by the old code path,
    // ledger_id = sessRaw, witness_probe "") must STILL self-heal — old
    // databases carry these rows, and the rebind path is kept for them.
    db.exec("INSERT INTO l1_world (sess_raw, ledger_id, witness_probe, issued_at, r3_latched_at) VALUES ('conv-old', 'conv-old', '', 1, 2)");
    db.exec("INSERT INTO conversations (namespace, conversation_id, session_id, claimed_at) VALUES ('default', 'conv-old', 'sid-old', 0)");
    assert.equal(a.snapR3Latched("sid-old"), true, "the pre-upgrade placeholder is still read as latched (l1 fallback)");
    // Unlatch the legacy row — the clear returns the bound ledger id (raw).
    assert.equal(a.snapR3LatchClear("conv-old"), "conv-old");
    // BEFORE the #6785 fix this threw FoundationRejectError (red) forever.
    // The placeholder is rebindable — stage-0 succeeds and anchors the REAL
    // ledger.
    const d = a.snapStage0("sid-old", ["m1"]);
    assert.ok(d, "stage-0 completed — no R3 400 after unlatch");
    const row = db.prepare("SELECT ledger_id, witness_probe FROM l1_world WHERE sess_raw = ?").get("conv-old") as { ledger_id: string; witness_probe: string };
    assert.equal(row.ledger_id, "sid-old", "the legacy placeholder was rebound to the real ledger sid");
    assert.notEqual(row.witness_probe, "", "the rebased row carries a real witness probe");
    // And the FOLLOWING round is a clean echo (the mapping is stable now).
    assert.doesNotThrow(() => a.snapStage0("sid-old", ["m1"]));
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

test("B1: a declared host that collects broken msgids (empty entry in the array) → 400 + x-bili-snapshot: identity, no upstream forward", async () => {
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
                        { type: "message", role: "user", content: "third" },
                    ],
                    // a short array (the tail form) whose entries are broken:
                    // an empty id is never something a real client sends —
                    // this is the collection fault the B1 channel is for
                    biliMsgIds: ["b1m1", ""],
                }),
            });
            assert.equal(res.status, 400, "the identity fault is a 400 (the B1 control channel — not the generic 503)");
            assert.equal(res.headers.get("x-bili-snapshot"), "identity");
            // #7574 item 5: the refusal also says "no pin this turn — resend in
            // full form", the same contract as the msgid delta re-anchor 400.
            assert.equal(res.headers.get("x-bili-msgid-mode"), "full");
            const err = JSON.parse(await res.text()) as { error: { type: string; message: string } };
            assert.equal(err.error.type, "snapshot_identity_fault");
            assert.ok(err.error.message.includes("R3"), "the error names the fault class");
            assert.equal(bodies.length, 0, "zero side effects: the upstream was never contacted");
        },
        { env: { BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY: "1" } },
    );
});

test("#7574: a well-formed short id array on an empty ledger no longer fails the turn — it is served and the response asks for the full list", async () => {
    // Before #7574 this was the B1 "count mismatch" case: a short array on a
    // session the server has no ledger for was answered with 400 (three of
    // them latched the session to the unpinned path). With the incremental
    // form on by default, this is simply an incremental client on its first
    // turn after the server lost the ledger (restored / recreated database,
    // removed session) — nothing is broken, nothing can be anchored, so the
    // turn runs without the pin and the client rebuilds the ledger next turn.
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
                    biliMsgIds: ["tail-anchor"], // 1 well-formed id for 2 elements = the tail form
                }),
            });
            assert.equal(res.status, 200, "the turn is served");
            await res.text();
            assert.equal(bodies.length, 1, "the upstream was contacted");
            assert.equal(res.headers.get("x-bili-msgid-mode"), "full", "and the client is told to send the full list next turn");
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

// ---------------------------------------------------------------------------
// D2/D3 — the #7064 lane-level contracts (runStage0, both-wire shared)
// ---------------------------------------------------------------------------
// D2: a conversation-bound sid (host identity registered) NEVER takes the
//     R3 fault path — a short/missing declared array degrades to
//     content-derived ids instead of 400/latch, on miss AND hit turns.
// D3: the world cursor (tail anchor) stays LIVE across watermark-hit runs —
//     a hit turn with a valid declared array refreshes the cursor.

type DLog = { level: string, msg: string };

function d23Harness(t: test.TestContext) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bili-5874-d23-"));
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ["BILI_STORAGE_UNIFIED", "BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY", "BILI_ROLLOUT_PLUGIN_MSG_ID_INCREMENTAL", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) {
        prevEnv[k] = process.env[k];
        process.env[k] = k.startsWith("XDG") ? dir : (k === "BILI_STORAGE_UNIFIED" ? "full" : "1");
    }
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    // runStage0 talks to the store through the SessionStore seam — give it
    // the snap delegates, delegating to the real UnifiedStore.
    _setStoreForTest({
        setSessionCommitListener() { /* the seam only needs the snap delegates */ },
        snapStage0: (sid: string, ids: string[], opts?: { seqs?: number[] | null }) => store.snapStage0(sid, ids, opts),
        snapConvBound: (sid: string) => store.snapConvBound(sid),
        snapMsgIdLiveIds: (sid: string) => store.snapMsgIdLiveIds(sid),
        snapPinLiveIds: (sid: string) => store.snapPinLiveIds(sid),
        snapR3Latched: (sid: string) => store.snapR3Latched(sid),
    } as unknown as Parameters<typeof _setStoreForTest>[0]);
    t.after(() => {
        for (const [k, v] of Object.entries(prevEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
    return { dir, store };
}

function dMsgs(n: number): BiliMessage[] {
    const arr: { role: string, content: string }[] = [{ role: "system", content: "sys" }];
    for (let i = 1; i <= n; i++) arr.push({ role: i % 2 ? "user" : "assistant", content: `c${i}` });
    return (openaiToCore({ messages: arr } as never)).msgs;
}

test("#7064 D2: a conversation-bound sid never takes the R3 fault path", async (t) => {
    const { store } = d23Harness(t);
    const sid = "d2-sid";
    const db = store as unknown as { db: DbLike };
    db.db.prepare(`INSERT INTO conversations (namespace, conversation_id, session_id, claimed_at) VALUES ('default', 'd2-conv', ?, 0)`).run(sid);
    const logs: DLog[] = [];
    const log = (level: string, msg: string) => logs.push({ level, msg });
    try {
        assert.ok(store.snapConvBound(sid), "the conversations row makes the sid conversation-bound");
        // a non-bound sid with a BROKEN array 400s (control; #7574: only a
        // broken entry is a collection fault — a well-formed short array is
        // the tail form, see the test below):
        assert.throws(() => runStage0({
            sessionId: "d2-sid-nobound",
            lane: "openai",
            msgs: dMsgs(5),
            incomingMsgIds: ["a", ""], // 2 ids for 6 messages, one of them empty
            incomingSeqs: null,
            pluginMode: true,
            log,
        }), FoundationRejectError, "non-bound sid: R3 fault 400s");
        const r = runStage0({
            sessionId: sid,
            lane: "openai",
            msgs: dMsgs(5),
            incomingMsgIds: ["a", ""], // the same broken array — bound: no throw
            incomingSeqs: null,
            pluginMode: true,
            log,
        });
        assert.equal(r.pinned, null, "the pin is rejected — content-derived ids");
        assert.ok(logs.some((l) => l.level === "warn" && l.msg.includes("conversation-bound sid skips the R3 fault")), `the degrade is logged: ${logs.map((l) => l.msg).join(" | ")}`);
        // and a watermark-HIT turn: same degrade, no throw, no latch (D3 arm).
        r3FaultTracker.clearLatched(sid);
        const r2 = runStage0({
            sessionId: sid,
            lane: "openai",
            msgs: dMsgs(5),
            incomingMsgIds: [" "], // worse: 1 id for 6, and it is whitespace
            incomingSeqs: null,
            pluginMode: true,
            wpHit: { view: [] as BiliMessage[], lastSeq: 5 },
            log,
        });
        assert.equal(r2.pinned, null);
        assert.ok(!r3FaultTracker.isLatched(sid), "no fault was recorded for the bound sid");
        // store seam: a bound sid whose pin DID apply skips the id verdict
        // entirely — mode "anchor", no reject possible (D1 floor).
        const msgs = dMsgs(2);
        const res = store.snapStage0(sid, msgs.map((m) => m.id), {});
        assert.ok(res !== null, "stage0 ran");
        assert.equal(res.decision.mode, "anchor");
        assert.equal(res.decision.witness, "anchor: conversation-bound, id verdict skipped");
        assert.equal(snapL1WindowRead(db.db, sid)?.window ?? null, null, "anchor persists nothing — the ledger rows are the identity");
    } finally {
        r3FaultTracker.clearLatched(sid);
        r3FaultTracker.clearLatched("d2-sid-nobound");
    }
});

test("#7574: a well-formed tail on an empty ledger is not a fault — no throw, no strike, the full signal, and the full list rebuilds the ledger next turn", async (t) => {
    const { store } = d23Harness(t);
    const sid = "d7574-sid";
    const logs: DLog[] = [];
    const log = (level: string, msg: string): void => { logs.push({ level, msg }); };
    try {
        assert.equal(store.snapConvBound(sid), false, "a plain sid (not conversation-bound) — the case that used to 400");
        // the client is in incremental mode and sends its tail; the server has no ledger
        const r1 = runStage0({
            sessionId: sid, lane: "openai", msgs: dMsgs(5),
            incomingMsgIds: ["anchor", "new-1"], incomingSeqs: null,
            pluginMode: true, log,
        });
        assert.equal(r1.pinned, null, "nothing to anchor against — the turn runs on content-derived ids");
        assert.equal(r1.pinMode, "full", "the response asks for the full list");
        assert.ok(!r3FaultTracker.isLatched(sid), "no fault, no latch");
        assert.ok(logs.some((l) => l.level === "warn" && l.msg.includes("tail form on an empty ledger")), `the reason is logged: ${logs.map((l) => l.msg).join(" | ")}`);
        // next turn the client sends the full list: the pin applies and the ledger is rebuilt
        const ids = ["u1", "a1", "u2", "a2", "u3"];
        const core = dMsgs(5);
        const r2 = runStage0({
            sessionId: sid, lane: "openai", msgs: core.map((m, i) => ({ ...m, id: `h-${i}` })),
            incomingMsgIds: ids, incomingSeqs: null,
            pluginMode: true, log,
        });
        assert.deepEqual(r2.pinned?.map((m) => m.id), ids, "the full list pins every element");
        assert.equal(r2.pinMode, "incremental");
    } finally {
        r3FaultTracker.clearLatched(sid);
    }
});

test("#6785-review D2: an idempotent re-render of a conv-bound sid is an echo (no cursor write)", async (t) => {
    const { store } = d23Harness(t);
    const sid = "d2-echo-sid";
    const db = store as unknown as { db: DbLike };
    db.db.prepare(`INSERT INTO conversations (namespace, conversation_id, session_id, claimed_at) VALUES ('default', 'd2-echo-conv', ?, 0)`).run(sid);
    try {
        const ids = dMsgs(4).map((m) => m.id);
        // turn 1: the cursor issues (anchor — no stored window yet).
        const r1 = store.snapStage0(sid, ids, {});
        assert.equal(r1.decision.mode, "anchor", "first turn anchors");
        assert.equal(r1.decision.newIdPos.length, ids.length, "every id issued");
        const w1 = snapL1WindowRead(db.db, "d2-echo-conv")?.window;
        assert.ok(w1 !== null && w1 !== undefined, "the cursor persisted under the conversation key");
        // turn 2: the SAME array (an idempotent re-render) moves the cursor
        // nowhere — it must take the zero-side-effect echo instead of a
        // per-turn re-anchor + upsert.
        const r2 = store.snapStage0(sid, ids, {});
        assert.equal(r2.decision.mode, "echo", "re-render ⇒ echo");
        assert.equal(r2.decision.replay, true);
        assert.equal(r2.decision.newIdPos.length, 0);
        const w2 = snapL1WindowRead(db.db, "d2-echo-conv")?.window;
        assert.ok(w2 !== null && w2 !== undefined);
        assert.equal(w2.maxPos, w1.maxPos, "the cursor is unchanged");
        assert.deepEqual(w2.tailIds, w1.tailIds, "the window is unchanged");
        // turn 3: a REAL append still advances (one fresh pos).
        const r3 = store.snapStage0(sid, [...ids, "m-fresh"], {});
        assert.equal(r3.decision.mode, "anchor", "a real append anchors");
        assert.deepEqual(r3.decision.newIdPos.map((x) => x.id), ["m-fresh"], "only the new id issued");
    } finally {
        r3FaultTracker.clearLatched(sid);
    }
});


test("#7064 D3: the tail anchor stays live across watermark-hit runs", async (t) => {
    const { store } = d23Harness(t);
    const sid = "d3-sid";
    const db = store as unknown as { db: DbLike };
    const logs: DLog[] = [];
    const log = (level: string, msg: string) => logs.push({ level, msg });
    try {
        const msgs1 = dMsgs(4);
        const ids1 = msgs1.map((m) => m.id);
        const r1 = runStage0({
            sessionId: sid,
            lane: "openai",
            msgs: msgs1,
            incomingMsgIds: ids1,
            incomingSeqs: null,
            pluginMode: true,
            log,
        });
        assert.notEqual(r1.pinned, null, "turn 1 pins the host ids");
        assert.equal(r1.anchorAdvanced, true, "the cursor issued");
        assert.equal(snapL1WindowRead(db.db, sid)?.window?.maxPos ?? -1, ids1.length, "cursor issued at the full array length");
        // turn 2 is a watermark HIT (wpHit stubbed) and the host appended one
        // message — pre-slimming this turn would have skipped stage-0 and the
        // cursor would have gone stale.
        const msgs2 = dMsgs(5);
        const ids2 = msgs2.map((m) => m.id);
        const r2 = runStage0({
            sessionId: sid,
            lane: "openai",
            msgs: msgs2,
            incomingMsgIds: ids2,
            incomingSeqs: null,
            pluginMode: true,
            wpHit: { view: msgs1, lastSeq: ids1.length },
            log,
        });
        assert.notEqual(r2.pinned, null, "the hit turn pins too (c3623bf1)");
        assert.equal(r2.anchorAdvanced, true, "the hit turn refreshes the cursor (D3 尾锚常活)");
        const w = snapL1WindowRead(db.db, sid)?.window;
        assert.ok(w !== null && w !== undefined, "the window was refreshed");
        assert.equal(w.maxPos, ids2.length, "the cursor now spans the hit turn's array");
        assert.deepEqual(w.tailIds.slice(-1), [ids2[ids2.length - 1]], "the new tail id is in the window");
        // a plain echo still reports no advance (epoch bump stays quiet).
        const r3 = runStage0({
            sessionId: sid,
            lane: "openai",
            msgs: msgs2,
            incomingMsgIds: ids2,
            incomingSeqs: null,
            pluginMode: true,
            wpHit: { view: msgs2, lastSeq: ids2.length },
            log,
        });
        assert.equal(r3.anchorAdvanced, false, "an echo turn does not bump the epoch");
    } finally {
        r3FaultTracker.clearLatched(sid);
    }
});

// ---------------------------------------------------------------------------
// I* — #7064 §8: the INCREMENTAL pin (steady state rides x-bili-pf-tail-ids,
// the prefix is re-stamped from the ledger, the full form is a snapshot turn)
// ---------------------------------------------------------------------------

/** Seed the ledger's messages table (what ingestRowsNow does in production,
 *  after the pin) so snapMsgIdLiveIds has rows to pin from. */
function seedLedger(db: DbLike, sid: string, ids: string[]): void {
    ids.forEach((id, seq) => {
        const hash = `h-${sid}-${seq}`;
        db.prepare("INSERT OR IGNORE INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, 1, 0, 'sha256', x'00')").run(hash);
        db.prepare("INSERT OR IGNORE INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at) VALUES (?, ?, ?, NULL, ?, 'user', 'message', ?, '', NULL)").run(sid, seq, id, seq + 1, hash);
    });
}

test("#7064 §8 I1: bootstrap full pin signals 'incremental'; steady turn pins prefix from the ledger + tail from the header", (t: test.TestContext) => {
    const { store } = d23Harness(t);
    const sid = "i1-sid";
    const db = (store as unknown as { db: DbLike }).db;
    const log = (level: string, msg: string): void => {};
    // bootstrap: the full list arrives on an EMPTY ledger.
    const r0 = runStage0({
        sessionId: sid, lane: "openai", msgs: dMsgs(5),
        incomingMsgIds: ["a1", "a2", "a3", "a4", "a5"], incomingSeqs: null,
        pluginMode: true, log,
    });
    assert.notEqual(r0.pinned, null, "bootstrap pins the full list");
    assert.equal(r0.pinMode, "incremental", "a successful pin ⇒ the NEXT turn may go incremental (this is what upgrades the client out of full-list mode)");
    // ingest lands the rows (production order: pin in-request, flush after).
    seedLedger(db, sid, ["a1", "a2", "a3", "a4", "a5"]);
    // steady state: no full list, only the tail (anchor a5 + new core a6).
    const r1 = runStage0({
        sessionId: sid, lane: "openai", msgs: dMsgs(6),
        incomingMsgIds: undefined, incomingSeqs: null,
        incomingTailIds: ["a5", "a6"], pluginMode: true, log,
    });
    assert.notEqual(r1.pinned, null, "the incremental pin applied");
    assert.equal(r1.pinMode, "incremental");
    assert.deepEqual(r1.pinned!.map((m) => m.id).slice(0, 5), ["a1", "a2", "a3", "a4", "a5"], "the prefix is re-stamped from the LEDGER, not the client");
    assert.equal(r1.pinned![5].id, "a6", "the new core is pinned from the tail");
    assert.equal(r1.anchorAdvanced, true, "the cursor extended");
});

test("#7064 §8 I2: any structural mismatch degrades to the 'full' signal — never a reject", (t: test.TestContext) => {
    const { store } = d23Harness(t);
    const db = (store as unknown as { db: DbLike }).db;
    const log = (level: string, msg: string): void => {};
    const sid = "i2-sid";
    seedLedger(db, sid, ["b1", "b2", "b3"]);
    const cases: Array<[string, string[]]> = [
        // 2026-11-19: a whole-history tail is now LEGAL (tail-aligned
        // overlap covers rows 0..2 and pins the one new core) — the old
        // "anchor mismatch" shape is replaced by a drift row INSIDE the
        // overlap, which is what the new rule actually rejects.
        ["overlap row drift (b1 vs b9, list otherwise tail-aligned)", ["b9", "b2", "b3", "x4"]],
        ["list too short to reach into the ledger (no overlap to verify)", ["?"]],
        ["list longer than the view (not a tail of THIS turn)", ["b3", "x4", "x5"]],
    ];
    for (const [name, tail] of cases) {
        const r = runStage0({
            sessionId: sid, lane: "openai", msgs: dMsgs(4),
            incomingMsgIds: undefined, incomingSeqs: null,
            incomingTailIds: tail, pluginMode: true, log,
        });
        assert.equal(r.pinned, null, `${name}: no pin`);
        assert.equal(r.pinMode, "full", `${name}: the full signal re-converges next turn`);
    }
    // a malformed header (null) is simply not the incremental form — no
    // pin, no signal, byte-identical to pre-§8.
    const r2 = runStage0({
        sessionId: sid, lane: "openai", msgs: dMsgs(4),
        incomingMsgIds: undefined, incomingSeqs: null,
        incomingTailIds: null, pluginMode: true, log,
    });
    assert.equal(r2.pinned, null);
    assert.equal(r2.pinMode, null, "malformed tail ⇒ the incremental form was not attempted");
});

test("#7064 §8 I3: empty ledger (true bootstrap) takes the full signal; full form wins when both arrive; a '?' NEW slot keeps its content-derived id", (t: test.TestContext) => {
    const { store } = d23Harness(t);
    const db = (store as unknown as { db: DbLike }).db;
    const log = (level: string, msg: string): void => {};
    // (a) empty ledger + tail only ⇒ 'full' (the list must bootstrap).
    const ra = runStage0({
        sessionId: "i3a-sid", lane: "openai", msgs: dMsgs(2),
        incomingMsgIds: undefined, incomingSeqs: null,
        incomingTailIds: ["c1", "c2"], pluginMode: true, log,
    });
    assert.equal(ra.pinned, null, "no ledger ⇒ nothing to pin a prefix from");
    assert.equal(ra.pinMode, "full");
    // (b) BOTH forms present ⇒ the full form runs (bootstrap/reanchor must
    // stay reachable regardless of the mode the client is in).
    seedLedger(db, "i3b-sid", ["d1", "d2", "d3"]);
    const rb = runStage0({
        sessionId: "i3b-sid", lane: "openai", msgs: dMsgs(4),
        incomingMsgIds: ["d1", "d2", "d3", "d4"], incomingSeqs: null,
        incomingTailIds: ["d3", "d4"], pluginMode: true, log,
    });
    assert.notEqual(rb.pinned, null, "the full pin applied");
    assert.equal(rb.pinMode, "incremental", "successful full pin ⇒ incremental signal");
    // (c) a '?' NEW slot (id-less element) keeps its content-derived id —
    // only the ledger prefix is re-stamped, the tail is trusted per-slot.
    seedLedger(db, "i3c-sid", ["e1", "e2"]);
    const rc = runStage0({
        sessionId: "i3c-sid", lane: "openai", msgs: dMsgs(3),
        incomingMsgIds: undefined, incomingSeqs: null,
        incomingTailIds: ["e2", "?"], pluginMode: true, log,
    });
    assert.notEqual(rc.pinned, null);
    assert.notEqual(rc.pinned![2].id, "?", "the '?' slot was NOT pinned verbatim");
    assert.equal(rc.pinned![2].id, dMsgs(3)[2].id, "the '?' slot keeps the core's pre-existing content-derived id");
    assert.equal(rc.pinMode, "incremental");
});

test("#7064 §8 phase 2 I4: the TAIL form rides the declared channel itself (responses/anthropic steady state); the body short array wins over the pf header", (t: test.TestContext) => {
    const { store } = d23Harness(t);
    const db = (store as unknown as { db: DbLike }).db;
    const log = (level: string, msg: string): void => {};
    // bootstrap on the ledger with the FULL list (any carrier — here the
    // declared channel, exactly as the responses/anthropic lanes see it).
    seedLedger(db, "i4-sid", ["f1", "f2", "f3"]);
    const r0 = runStage0({
        sessionId: "i4-sid", lane: "responses", msgs: dMsgs(3),
        incomingMsgIds: ["f1", "f2", "f3"], incomingSeqs: null,
        pluginMode: true, log,
    });
    assert.notEqual(r0.pinned, null, "the full form pinned at bootstrap");
    // steady state: the SAME field now carries the short tail (anchor +
    // new cores) — len !== view ⇒ the two-form rule takes the tail path
    // (no pf header at all on these lanes).
    const r1 = runStage0({
        sessionId: "i4-sid", lane: "responses", msgs: dMsgs(4),
        incomingMsgIds: ["f3", "f4"], incomingSeqs: null,
        pluginMode: true, log,
    });
    assert.notEqual(r1.pinned, null, "the short declared array pinned as the tail form");
    assert.deepEqual(r1.pinned!.map((m) => m.id), ["f1", "f2", "f3", "f4"], "prefix re-stamped from the ledger, tail from the array");
    assert.equal(r1.pinMode, "incremental");
    // both carriers present (openai lane shape): the body short array is
    // the host-declared channel and WINS over the pf-tail-ids header.
    const r2 = runStage0({
        sessionId: "i4-sid", lane: "openai", msgs: dMsgs(4),
        incomingMsgIds: ["f3", "f4"], incomingSeqs: null,
        incomingTailIds: ["f3", "f9"], pluginMode: true, log,
    });
    assert.notEqual(r2.pinned, null);
    assert.deepEqual(r2.pinned!.map((m) => m.id), ["f1", "f2", "f3", "f4"], "the body tail won (f9 from the header was NOT used)");
});

test("#7064 §8 phase 2 I5: an invalid entry in the TAIL form degrades to 'full' (drift class — NEVER an R3 throw), on every lane", (t: test.TestContext) => {
    const { store } = d23Harness(t);
    const db = (store as unknown as { db: DbLike }).db;
    const log = (level: string, msg: string): void => {};
    seedLedger(db, "i5-sid", ["g1", "g2"]);
    const mk = (badId: string) => runStage0({
        sessionId: "i5-sid", lane: "anthropic", msgs: dMsgs(3),
        incomingMsgIds: ["g2", badId], incomingSeqs: null,
        pluginMode: true, log,
    });
    for (const badId of ["g2", "acp_summary_x", "bad id", "x".repeat(513)]) {
        const r = mk(badId);
        assert.equal(r.pinned, null, `bad tail entry ${JSON.stringify(badId)} ⇒ no pin`);
        assert.equal(r.pinMode, "full", `bad tail entry ${JSON.stringify(badId)} ⇒ the client re-sends the full list next turn`);
    }
    // the anchor slot is screened too (it is a NEW-core slot: i >= C).
    const rA = runStage0({
        sessionId: "i5-sid", lane: "anthropic", msgs: dMsgs(3),
        incomingMsgIds: ["g3", "g4"], incomingSeqs: null,
        pluginMode: true, log,
    });
    assert.equal(rA.pinned, null, "anchor ≠ ledger frontier ⇒ drift, not a fault");
    assert.equal(rA.pinMode, "full");
});

test("#7064 §8 phase 2 I6: the flag OFF leaves a short array pinned-less and signals 'full' (rollback self-heals the client back to the full form)", (t: test.TestContext) => {
    const { store } = d23Harness(t);
    const db = (store as unknown as { db: DbLike }).db;
    const log = (level: string, msg: string): void => {};
    seedLedger(db, "i6-sid", ["h1", "h2"]);
    const prev = process.env["BILI_ROLLOUT_PLUGIN_MSG_ID_INCREMENTAL"];
    process.env["BILI_ROLLOUT_PLUGIN_MSG_ID_INCREMENTAL"] = "0";
    try {
        const r = runStage0({
            sessionId: "i6-sid", lane: "responses", msgs: dMsgs(3),
            incomingMsgIds: ["h2", "h3"], incomingSeqs: null,
            pluginMode: true, log,
        });
        assert.equal(r.pinned, null, "flag off ⇒ only the full pin runs server-side");
        assert.equal(r.pinMode, "full", "…and the client is told to go back to the full form (no 4xx, no pin until it does)");
    } finally {
        if (prev === undefined) delete process.env["BILI_ROLLOUT_PLUGIN_MSG_ID_INCREMENTAL"];
        else process.env["BILI_ROLLOUT_PLUGIN_MSG_ID_INCREMENTAL"] = prev;
    }
});

test("#7064 §8 2026-11-19 I7: an over-ceiling session's TRUNCATED tail pins (the ed71f127 deadlock fix) — the overlap row-by-row proves more than the anchor did", (t: test.TestContext) => {
    const { store } = d23Harness(t);
    const db = (store as unknown as { db: DbLike }).db;
    const log = (level: string, msg: string): void => {};
    const sid = "i7-sid";
    // a 3000-turn session: the ledger holds all rows; the client's carrier
    // is over its 8KiB budget this turn (a big growth turn), so the BODY
    // carries its TRUNCATED retained list — the last 2048 ids of the view,
    // NOT the full form (the client no longer HAS a full list).
    const C = 3000;
    const ledgerIds = Array.from({ length: C }, (_, i) => `k${i}`);
    seedLedger(db, sid, ledgerIds);
    const T = C + 2; // two new cores this turn
    const retained = 2048; // the client's over-ceiling retention window
    const list = Array.from({ length: retained }, (_, i) => ledgerIds[C - retained + i])
        .concat(["new1", "new2"]);
    const r = runStage0({
        sessionId: sid, lane: "openai", msgs: dMsgs(T),
        incomingMsgIds: list, incomingSeqs: null,
        pluginMode: true, log,
    });
    assert.notEqual(r.pinned, null, "the truncated tail PINS — the 2047-row overlap matched the ledger");
    assert.equal(r.pinMode, "incremental", "…and re-upgrades the client to the carrier (no dead 'full' loop)");
    assert.deepEqual(r.pinned!.map((m) => m.id).slice(0, C), ledgerIds, "the full prefix re-stamped from the LEDGER");
    assert.equal(r.pinned![C].id, "new1");
    assert.equal(r.pinned![C + 1].id, "new2");
    // the SAME turn with one drift row inside the overlap ⇒ no pin, 'full'.
    const drifted = list.slice();
    drifted[0] = "k0-rewritten";
    const rd = runStage0({
        sessionId: sid, lane: "openai", msgs: dMsgs(T),
        incomingMsgIds: drifted, incomingSeqs: null,
        pluginMode: true, log,
    });
    assert.equal(rd.pinned, null, "one drift row in the overlap ⇒ degrade");
    assert.equal(rd.pinMode, "full", "…drift class, never a reject");
});

test("#7064 §8 2026-11-19 I8: the steady-state form is the 1-row-overlap special case — behavior unchanged", (t: test.TestContext) => {
    const { store } = d23Harness(t);
    const db = (store as unknown as { db: DbLike }).db;
    const log = (level: string, msg: string): void => {};
    seedLedger(db, "i8-sid", ["j1", "j2"]);
    // anchor + new (L = N+1): overlap = exactly 1 row = the old anchor check.
    const ok = runStage0({
        sessionId: "i8-sid", lane: "openai", msgs: dMsgs(3),
        incomingMsgIds: ["j2", "j3"], incomingSeqs: null,
        pluginMode: true, log,
    });
    assert.notEqual(ok.pinned, null);
    assert.deepEqual(ok.pinned!.map((m) => m.id), ["j1", "j2", "j3"]);
    // anchor ≠ frontier ⇒ the 1-row overlap drifts ⇒ degrade (same verdict
    // as the old anchor rule, same shape).
    const bad = runStage0({
        sessionId: "i8-sid", lane: "openai", msgs: dMsgs(3),
        incomingMsgIds: ["j9", "j3"], incomingSeqs: null,
        pluginMode: true, log,
    });
    assert.equal(bad.pinned, null);
    assert.equal(bad.pinMode, "full");
});
