// #6011 CC Task-subagent cache-miss cluster: three parallel subagent runs
// under ONE conversation id share byte-identical leading cells (the shared
// Task boilerplate), so every byte-level rung and the D1-B discriminator
// collide — pre-fix all runs merged onto one persona lane and each fresh
// run re-preflighted the merged history from zero (the reported storm).
//
// The fix keys forked lanes off the host-minted message ids via the
// STANDARD sessionId+msgid store-matching pipeline (no parallel ledger):
//   - stamped-id forks mint `<rawId>|sub:m:<first inbound id>` — the FULL
//     untruncated id (unique per run by construction), so parallel runs
//     separate from their FIRST fork;
//   - later rounds continue their own lane via the sibling rung: the
//     incoming ids matched against the Pinned ROWS of every candidate
//     sub-lane (`<raw>|sub:` keys from the skeleton table ∪ the store's
//     session list), #5719 overlap semantics generalized from the raw key
//     to its children — exactly-one-overlap ⇒ continue, multiple ⇒ warn +
//     degrade to a fresh mint (never guess), none ⇒ mint;
//   - the match witness is the unified-store rows (live AND retired), so a
//     client-side compaction erasing the first id cannot break continuity;
//   - the raw-lane store-overlap rescue (#5719) still outranks the sibling
//     rung; no stamped ids keeps the legacy fork keys byte-identically.
//
// T1      three parallel same-shape runs → three distinct |sub:m:<full id> lanes
// T1c     control: same inputs WITHOUT ids → one legacy lane (collision pinned)
// T2      round two continues its own lane via the store rung; no cross-bind
// T3      compaction erasing the FIRST id → continuity holds (retired rows match)
// T3b     total amnesia (no surviving id on the wire) → fresh coherent lane
// T4      two lanes both overlapping → ambiguous → degrade to fresh mint
// T5      store-backed raw identity outranks the sibling rung
// T6      restart: continuation survives with the store as sole witness
// T7      malformed stamped ids degrade to the legacy fork key
// T8      tag-less shallow blob rides |sub:aux and gets no skeleton entry
// T9      lane gone from the skeleton table but present in the store list → found
// T10     store unavailable → mint, no crash

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { resolveSessionOrder, resetSessionOrderForTest, orderSnapshot, applyOrderSnapshot } = await import("../src/session-resolve.ts");

type Msg = { role: string; content: string };

const fp16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);
const uid = (t: string, i: number): string => `${t}-msgid-${String(i + 1).padStart(3, "0")}`;
const idsOf = (n: number, t: string): string[] => Array.from({ length: n }, (_, i) => uid(t, i));

function chain(n: number, tag: string): Msg[] {
    return Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `${tag}-cell-${i + 1} ${"x".repeat(80)}`,
    }));
}

function fakeStore(opts?: { unavailable?: boolean }): {
    rows: Map<string, string[]>;
    lookup: (k: string) => readonly string[] | null;
    list: () => string[] | null;
} {
    const rows = new Map<string, string[]>();
    if (opts?.unavailable) {
        return { rows, lookup: () => null, list: () => null };
    }
    return {
        rows,
        lookup: (k: string): readonly string[] | null => rows.get(k) ?? null,
        list: (): string[] | null => [...rows.keys()],
    };
}

const MAIN_SYS = "main conversation system prompt";
const SUB_SYS = "task subagent system prompt";
// The shared Task boilerplate: byte-identical across parallel runs, which is
// exactly why the D1-B fragment discriminator cannot tell them apart.
const BOILER = "You are a Task subagent. Complete the assigned task and report your findings.";
const DISC = BOILER.slice(0, 1024);
const SHARED_HEAD: Msg[] = [
    { role: "user", content: BOILER },
    { role: "assistant", content: "Understood. Starting work." },
];

/** A subagent run's resent history: the shared boilerplate head, then cells
 *  that diverge per run (parallel independent executions). */
function runHistory(run: string, cells: number): Msg[] {
    const out: Msg[] = [...SHARED_HEAD];
    for (let i = out.length; i < cells; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `${run}-diverge-${i + 1} ${"z".repeat(72)}` });
    }
    return out;
}

test("#6011 T1: three parallel same-shape subagent runs land on distinct full-id msgid lanes", () => {
    resetSessionOrderForTest();
    const raw = "cc-6011-t1";
    const store = fakeStore();
    assert.equal(resolveSessionOrder(raw, chain(8, "main"), MAIN_SYS, undefined, undefined, undefined, idsOf(8, "main"), store.lookup, store.list).action, "claim");
    const keys: string[] = [];
    for (const run of ["A", "B", "C"]) {
        const res = resolveSessionOrder(raw, runHistory(run, 3), SUB_SYS, undefined, undefined, DISC, idsOf(3, run), store.lookup, store.list);
        assert.equal(res.action, "derived-persona", `run ${run}`);
        keys.push(res.key);
    }
    assert.equal(new Set(keys).size, 3, `runs separated: ${keys.join(", ")}`);
    // FULL untruncated first id — no fp16 truncation (owner ruling: truncated
    // fingerprints collide, host uuids are unique by construction).
    assert.equal(keys[0], `${raw}|sub:m:${uid("A", 0)}`);
    assert.equal(keys[1], `${raw}|sub:m:${uid("B", 0)}`);
    assert.equal(keys[2], `${raw}|sub:m:${uid("C", 0)}`);
});

test("#6011 T1-control: without stamped ids the same inputs collide on ONE legacy lane (pre-fix behavior pinned)", () => {
    resetSessionOrderForTest();
    const raw = "cc-6011-t1c";
    resolveSessionOrder(raw, chain(8, "main"), MAIN_SYS);
    const legacyKey = `${raw}|sub:${fp16(SUB_SYS)}:${fp16(DISC)}`;
    for (const run of ["A", "B", "C"]) {
        const res = resolveSessionOrder(raw, runHistory(run, 3), SUB_SYS, undefined, undefined, DISC);
        assert.equal(res.key, legacyKey, `run ${run} collides on the legacy disc key pre-fix`);
    }
});

test("#6011 T2: round two continues its own lane via the store-overlap rung; no cross-bind", () => {
    resetSessionOrderForTest();
    const raw = "cc-6011-t2";
    const store = fakeStore();
    resolveSessionOrder(raw, chain(8, "main"), MAIN_SYS, undefined, undefined, undefined, idsOf(8, "main"), store.lookup, store.list);
    const rA1 = resolveSessionOrder(raw, runHistory("A", 3), SUB_SYS, undefined, undefined, DISC, idsOf(3, "A"), store.lookup, store.list);
    const rB1 = resolveSessionOrder(raw, runHistory("B", 3), SUB_SYS, undefined, undefined, DISC, idsOf(3, "B"), store.lookup, store.list);
    assert.notEqual(rA1.key, rB1.key, "round one already separates the runs");
    // Ingest pinned the rounds' ids onto the canonical rows under each lane.
    store.rows.set(rA1.key, idsOf(3, "A"));
    store.rows.set(rB1.key, idsOf(3, "B"));
    // Round two: the full resend grew by two cells; the inbound ids still
    // cover the pinned head.
    const rA2 = resolveSessionOrder(raw, runHistory("A", 5), SUB_SYS, undefined, undefined, DISC, idsOf(5, "A"), store.lookup, store.list);
    assert.equal(rA2.key, rA1.key, "A round two stays on A's lane");
    assert.equal(rA2.action, "continue");
    assert.match(rA2.reason ?? "", /#6011/, "sibling-rung reason cites #6011");
    const rB2 = resolveSessionOrder(raw, runHistory("B", 5), SUB_SYS, undefined, undefined, DISC, idsOf(5, "B"), store.lookup, store.list);
    assert.equal(rB2.key, rB1.key, "B round two lands on B's lane, never A's");
});

test("#6011 T3: compaction erasing the FIRST id still continues (retired rows stay matchable)", () => {
    resetSessionOrderForTest();
    const raw = "cc-6011-t3";
    const store = fakeStore();
    resolveSessionOrder(raw, chain(8, "main"), MAIN_SYS, undefined, undefined, undefined, idsOf(8, "main"), store.lookup, store.list);
    const rA1 = resolveSessionOrder(raw, runHistory("A", 3), SUB_SYS, undefined, undefined, DISC, idsOf(3, "A"), store.lookup, store.list);
    store.rows.set(rA1.key, idsOf(3, "A"));
    // Compaction replaces the head cell with a summary (new host id); the
    // tail cells keep theirs. The first id is GONE from the wire — the match
    // must not depend on it because store rows are retire-don't-delete and
    // everyMessageIds spans live AND retired rows.
    const compacted: Msg[] = [
        { role: "user", content: "<summary of earlier subagent work>" + "s".repeat(96) },
        { role: "assistant", content: "post-compact ack " + "t".repeat(80) },
        { role: "user", content: "next subagent request " + "u".repeat(80) },
    ];
    const res = resolveSessionOrder(raw, compacted, SUB_SYS, undefined, undefined, DISC, ["a-cmp-1", uid("A", 1), uid("A", 2)], store.lookup, store.list);
    assert.equal(res.key, rA1.key, "first id erased, tail ids still overlap the pinned rows");
    assert.equal(res.action, "continue");
});

test("#6011 T3b: total amnesia (no surviving id on the wire) splits onto a fresh coherent lane (bounded)", () => {
    resetSessionOrderForTest();
    const raw = "cc-6011-t3b";
    const store = fakeStore();
    resolveSessionOrder(raw, chain(8, "main"), MAIN_SYS, undefined, undefined, undefined, idsOf(8, "main"), store.lookup, store.list);
    const rA1 = resolveSessionOrder(raw, runHistory("A", 3), SUB_SYS, undefined, undefined, DISC, idsOf(3, "A"), store.lookup, store.list);
    store.rows.set(rA1.key, idsOf(3, "A"));
    // Every previously-pinned id is gone from the wire (archive/delete-class
    // wipe): nothing overlaps, the run mints its own new lane rather than
    // merging into a stranger's.
    const compacted: Msg[] = [
        { role: "user", content: "<summary of earlier subagent work>" + "s".repeat(96) },
        { role: "assistant", content: "post-compact ack " + "t".repeat(80) },
    ];
    const res = resolveSessionOrder(raw, compacted, SUB_SYS, undefined, undefined, DISC, ["a-cmp-1"], store.lookup, store.list);
    assert.equal(res.action, "derived-persona");
    assert.notEqual(res.key, rA1.key, "erased everything → fresh lane, bounded split");
    assert.equal(res.key, `${raw}|sub:m:a-cmp-1`);
});

test("#6011 T4: two lanes both overlapping the incoming ids degrades to a fresh mint (never guesses)", () => {
    resetSessionOrderForTest();
    const raw = "cc-6011-t4";
    const store = fakeStore();
    resolveSessionOrder(raw, chain(8, "main"), MAIN_SYS);
    // Two runs whose id sets share x-002 (a forked-history shape).
    const r1 = resolveSessionOrder(raw, runHistory("S1", 3), SUB_SYS, undefined, undefined, "disc-S1", ["x-001", "x-002"], store.lookup, store.list);
    const r2 = resolveSessionOrder(raw, runHistory("S2", 3), SUB_SYS, undefined, undefined, "disc-S2", ["x-002", "x-003"], store.lookup, store.list);
    assert.notEqual(r1.key, r2.key);
    store.rows.set(r1.key, ["x-001", "x-002"]);
    store.rows.set(r2.key, ["x-002", "x-003"]);
    // A request overlapping BOTH lanes (via x-002): the sibling rung must
    // refuse to pick. First inbound id chosen off-lane so the degraded mint
    // cannot textually coincide with either lane's own mint key.
    const stranger: Msg[] = [
        { role: "user", content: "totally different opener " + "p".repeat(90) },
        { role: "assistant", content: "stranger answer " + "q".repeat(90) },
        { role: "user", content: "stranger followup " + "r".repeat(90) },
    ];
    const res = resolveSessionOrder(raw, stranger, SUB_SYS, undefined, undefined, "disc-X", ["y-new", "x-002"], store.lookup, store.list);
    assert.equal(res.action, "derived-persona", "ambiguous overlap never continues a lane");
    assert.notEqual(res.key, r1.key, "never continues lane 1");
    assert.notEqual(res.key, r2.key, "never continues lane 2");
    assert.equal(res.key, `${raw}|sub:m:y-new`, "degrades to a fresh mint keyed off the first inbound id");
});

test("#6011 T5: store-backed raw identity outranks the sibling rung", () => {
    resetSessionOrderForTest();
    const raw = "cc-6011-t5";
    const store = fakeStore();
    const mainIds = idsOf(8, "main");
    resolveSessionOrder(raw, chain(8, "main"), MAIN_SYS, undefined, undefined, undefined, mainIds, store.lookup, store.list);
    store.rows.set(raw, [...mainIds, "y-pinned"]);
    // A subagent run whose ids never touch the raw store rows mints its lane.
    const rS = resolveSessionOrder(raw, runHistory("S", 3), SUB_SYS, undefined, undefined, "disc-S", ["x-001", "x-002", "x-003"], store.lookup, store.list);
    assert.match(rS.key, /\|sub:m:/, "S mints its own msgid lane");
    store.rows.set(rS.key, ["x-001", "x-002", "x-003"]);
    // A later request overlaps BOTH the raw store rows (y-pinned) and S's
    // lane rows (x-001): the unified-store raw identity wins.
    const stranger: Msg[] = [
        { role: "user", content: "totally different opener " + "p".repeat(90) },
        { role: "assistant", content: "stranger answer " + "q".repeat(90) },
        { role: "user", content: "stranger followup " + "r".repeat(90) },
    ];
    const res = resolveSessionOrder(raw, stranger, SUB_SYS, undefined, undefined, "disc-X", ["x-001", "y-pinned"], store.lookup, store.list);
    assert.equal(res.key, raw, "raw-lane rescue precedes the sibling rung");
    assert.equal(res.action, "reanchor");
});

test("#6011 T6: restart — the store alone keeps lanes alive (no parallel ledger to lose)", () => {
    resetSessionOrderForTest();
    const raw = "cc-6011-t6";
    const store = fakeStore();
    resolveSessionOrder(raw, chain(8, "main"), MAIN_SYS, undefined, undefined, undefined, idsOf(8, "main"), store.lookup, store.list);
    const rA1 = resolveSessionOrder(raw, runHistory("A", 3), SUB_SYS, undefined, undefined, DISC, idsOf(3, "A"), store.lookup, store.list);
    store.rows.set(rA1.key, idsOf(3, "A"));
    // Restart: the skeleton table hydrates from disk (the lane entry rides
    // along, but carries no id witness anymore)…
    const snap = orderSnapshot();
    assert.ok(snap.some((e) => e.id === rA1.key), "lane skeleton entry persists");
    resetSessionOrderForTest();
    applyOrderSnapshot(snap);
    // …and continuity comes purely from the store rows.
    const rA2 = resolveSessionOrder(raw, runHistory("A", 5), SUB_SYS, undefined, undefined, DISC, idsOf(5, "A"), store.lookup, store.list);
    assert.equal(rA2.key, rA1.key, "post-restart round two continues the lane via store overlap");
    assert.equal(rA2.action, "continue");
});

test("#6011 T7: malformed stamped ids degrade to the legacy fork key", () => {
    resetSessionOrderForTest();
    const raw = "cc-6011-t7";
    resolveSessionOrder(raw, chain(8, "main"), MAIN_SYS);
    const disc = "some discriminator";
    const legacyKey = `${raw}|sub:${fp16(SUB_SYS)}:${fp16(disc)}`;
    for (const bad of [[""], [uid("m", 0), 42], []]) {
        const res = resolveSessionOrder(raw, runHistory("X", 3), SUB_SYS, undefined, undefined, disc, bad as unknown as string[]);
        assert.equal(res.key, legacyKey, `legacy key for ${JSON.stringify(bad)}`);
        assert.ok(!res.key.includes(":m:"), "never mints an m: key from malformed ids");
    }
});

test("#6011 T8: tag-less shallow blob rides |sub:aux and gets no skeleton entry", () => {
    resetSessionOrderForTest();
    const raw = "cc-6011-t8";
    const store = fakeStore();
    const res = resolveSessionOrder(raw, [{ role: "user", content: "shallow blob request " + "w".repeat(64) }], undefined, undefined, undefined, undefined, ["aux-id-1"], store.lookup, store.list);
    assert.equal(res.key, `${raw}|sub:aux`);
    assert.equal(res.action, "derived-aux");
    assert.ok(orderSnapshot().every((e) => e.id !== `${raw}|sub:aux`), "the shared aux key gets no skeleton entry");
});

test("#6011 T9: lane missing from the skeleton table but present in the store list is still found", () => {
    resetSessionOrderForTest();
    const raw = "cc-6011-t9";
    const store = fakeStore();
    // Simulates a lost/corrupted order-skeleton file while the unified store
    // survived: the lane key lives ONLY in the store's session list.
    const laneKey = `${raw}|sub:m:x-001`;
    store.rows.set(laneKey, ["x-001", "x-002"]);
    resolveSessionOrder(raw, chain(8, "main"), MAIN_SYS);
    const res = resolveSessionOrder(raw, runHistory("S", 3), SUB_SYS, undefined, undefined, DISC, ["x-001", "x-002"], store.lookup, store.list);
    assert.equal(res.key, laneKey, "store session list supplies the candidate the skeleton table lost");
    assert.equal(res.action, "continue");
});

test("#6011 T10: store unavailable → mint, no crash", () => {
    resetSessionOrderForTest();
    const raw = "cc-6011-t10";
    const store = fakeStore({ unavailable: true });
    resolveSessionOrder(raw, chain(8, "main"), MAIN_SYS, undefined, undefined, undefined, idsOf(8, "main"), store.lookup, store.list);
    const keys: string[] = [];
    for (const run of ["A", "B", "C"]) {
        const res = resolveSessionOrder(raw, runHistory(run, 3), SUB_SYS, undefined, undefined, DISC, idsOf(3, run), store.lookup, store.list);
        assert.equal(res.action, "derived-persona", `run ${run}`);
        keys.push(res.key);
    }
    assert.equal(new Set(keys).size, 3, "still separated by the mint key");
    assert.equal(keys[0], `${raw}|sub:m:${uid("A", 0)}`);
});
