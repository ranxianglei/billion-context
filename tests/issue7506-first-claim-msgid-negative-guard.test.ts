// #7506 ①: first-claim msgid NEGATIVE guard in src/session-resolve.ts.
//
// The in-memory skeleton can be lost even though the conversation's rows
// survive — SIGKILL on the 500ms persist debounce, or LRU eviction of a cold
// id while its unified-store rows stay (the #3397 persistence saves the
// process from a clean restart, not from death). When the id has rows in the
// unified store and the incoming stamped ids have ZERO overlap with them, the
// request is NOT a continuation of that conversation — a different
// conversation reusing the id (the #1916 review-steals-raw race, now with the
// store as the witness instead of the tag). The guard refuses the raw claim:
// shallow → aux, main-shaped → task. A legitimate continuation ALWAYS overlaps
// (host-minted stable UUIDs resent unchanged, #4491) and is never rejected.
//
// Pins:
//   N1 new id (no stored rows) + main-shaped      → claim raw (guard inert)
//   N2 skeleton lost + stored rows + zero overlap + shallow   → aux  (fires)
//   N3 skeleton lost + stored rows + zero overlap + main-shaped → task (fires)
//   N4 skeleton lost + stored rows + overlap > 0   → claim raw (inert)
//   N5 skeleton lost + stored rows + no stamped ids → claim raw (degrade)
//   N6 skeleton lost + store unavailable (null)    → claim raw (degrade)

import test from "node:test";
import assert from "node:assert/strict";

const {
    resolveSessionOrder,
    resetSessionOrderForTest,
} = await import("../src/session-resolve.ts");

type Msg = { role: string; content: string };
const uid = (t: string, i: number) => `${t}-msgid-${String(i + 1).padStart(3, "0")}`;

/** Alternating user/assistant, i-th cell carries stable host id `${tag}-msgid-${i}`. */
function chain(n: number, tag: string): Msg[] {
    const out: Msg[] = [];
    for (let i = 0; i < n; i++) {
        out.push({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `${tag} ${i}: realistic body ${"x".repeat(80)}-${i}`,
        });
    }
    return out;
}
const idsOf = (n: number, tag: string) => Array.from({ length: n }, (_, i) => uid(tag, i));

/** Fake unified-store msg_id view: the test stands in for
 *  getStore().unifiedAllMessageIds(key) — full historical id set (#5312). */
function fakeStore(): { rows: Map<string, string[]>; lookup: (k: string) => readonly string[] | null } {
    const rows = new Map<string, string[]>();
    return { rows, lookup: (k) => (rows.has(k) ? (rows.get(k) as string[]) : []) };
}

const SYSTEM_A = "You are dsh, desktop shell agent. env block. ".repeat(24);

test("#7506 ① N1: new id (no stored rows) + main-shaped → claim raw (guard inert)", () => {
    resetSessionOrderForTest();
    const raw = "session-7506-n1";
    const store = fakeStore(); // empty — no stored rows
    // No skeleton (reset) + no stored rows → the guard is inert; main-shaped
    // claims raw exactly as before.
    const res = resolveSessionOrder(raw, chain(6, "a"), SYSTEM_A, undefined, undefined, undefined, idsOf(6, "a"), store.lookup);
    assert.equal(res.action, "claim");
    assert.equal(res.key, raw);
});

test("#7506 ① N2: skeleton lost + stored rows + zero overlap + shallow → aux (guard fires)", () => {
    resetSessionOrderForTest();
    const raw = "session-7506-n2";
    const store = fakeStore();
    // The id HAS stored rows (the conversation's rows survive the skeleton
    // loss) but the resolver memory is wiped (first claim).
    store.rows.set(raw, idsOf(10, "stored"));
    // A shallow review blob (one user message, persona-tagged) arrives with
    // stamped ids that have ZERO overlap with the stored rows → NOT a
    // continuation → aux (the #1916 review-steals-raw race, store-witnessed).
    const blob = [{ role: "user", content: "review this. " + "r".repeat(120) }];
    const res = resolveSessionOrder(raw, blob, SYSTEM_A, undefined, undefined, undefined, ["blob-1", "blob-2"], store.lookup);
    assert.equal(res.action, "derived-aux");
    assert.equal(res.key, `${raw}|sub:aux`);
    assert.match(res.reason ?? "", /zero msgid overlap/);
});

test("#7506 ① N3: skeleton lost + stored rows + zero overlap + main-shaped → task (guard fires)", () => {
    resetSessionOrderForTest();
    const raw = "session-7506-n3";
    const store = fakeStore();
    store.rows.set(raw, idsOf(10, "stored"));
    // A main-shaped history (6 alternating cells) arrives with stamped ids
    // that have ZERO overlap with the stored rows → NOT a continuation → task
    // (the #150 subagent-reuses-main-id race, store-witnessed).
    const res = resolveSessionOrder(raw, chain(6, "stranger"), SYSTEM_A, undefined, undefined, undefined, ["s-1", "s-2", "s-3", "s-4", "s-5", "s-6"], store.lookup);
    assert.equal(res.action, "derived-task");
    assert.ok(res.key.startsWith(`${raw}|sub:task:`), res.key);
    assert.match(res.reason ?? "", /zero msgid overlap/);
});

test("#7506 ① N4: skeleton lost + stored rows + overlap > 0 → claim raw (guard inert)", () => {
    resetSessionOrderForTest();
    const raw = "session-7506-n4";
    const store = fakeStore();
    store.rows.set(raw, idsOf(10, "a"));
    // A main-shaped history arrives with stamped ids that OVERLAP the stored
    // rows → a legitimate continuation → claim raw (the guard is inert — the
    // #4491 contract: host-minted stable UUIDs resent unchanged).
    const res = resolveSessionOrder(raw, chain(6, "a"), SYSTEM_A, undefined, undefined, undefined, idsOf(6, "a"), store.lookup);
    assert.equal(res.action, "claim");
    assert.equal(res.key, raw);
});

test("#7506 ① N5: skeleton lost + stored rows + no stamped ids → claim raw (degrade to pre-change path)", () => {
    resetSessionOrderForTest();
    const raw = "session-7506-n5";
    const store = fakeStore();
    store.rows.set(raw, idsOf(10, "a"));
    // No stamped ids riding the wire → the guard degrades to the pre-change
    // byte-evidence path → main-shaped claims raw.
    const res = resolveSessionOrder(raw, chain(6, "a"), SYSTEM_A, undefined, undefined, undefined, undefined, store.lookup);
    assert.equal(res.action, "claim");
    assert.equal(res.key, raw);
});

test("#7506 ① N6: skeleton lost + store unavailable (null) → claim raw (degrade to pre-change path)", () => {
    resetSessionOrderForTest();
    const raw = "session-7506-n6";
    // The store view is unavailable (latch-off / legacy epoch, #4407/#5536) →
    // the guard degrades to the pre-change byte-evidence path → main-shaped
    // claims raw.
    const res = resolveSessionOrder(raw, chain(6, "a"), SYSTEM_A, undefined, undefined, undefined, idsOf(6, "a"), () => null);
    assert.equal(res.action, "claim");
    assert.equal(res.key, raw);
});
