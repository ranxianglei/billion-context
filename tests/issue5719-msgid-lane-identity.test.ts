// #5719: sessionid+msgid LAST-RESORT identity rung in src/session-resolve.ts.
//
// Incident (issue #5719, trigger input #5517): a full dsh compaction (one
// checkpoint user message replaces the middle of the conversation) landed in
// the SAME TURN as a volatile-field rewrite of the static system prompt
// (Web-GUI port digits). Every byte-level escape rung needed evidence
// (fragments / cells / chain continuity) that the compound event destroyed
// simultaneously, so the resolver FORKED `<raw>|sub:<fp>` — a zero-state lane
// under an UNCHANGED client session id. Host-minted per-message ids (#4491
// biliMsgIds) survive BOTH destructive forces: dsh re-sends the unchanged
// UUIDs for the cells it keeps (v0.2.2-rc.2 replays the full shadowed
// region, #2193), so ANY overlap between the incoming ids and the message
// ROWS RECORDED under the key proves same-conversation and re-anchors the
// raw lane.
//
// Single-source discipline (owner ruling: JSON recording is deprecated — the
// identity evidence lives ONLY in the unified store): the recorded side is
// the messages.msg_id column, pinned at ingest by #4491 (msgid-pin). There
// is NO parallel id ledger in the session-order skeletons — T5 locks that.
// The resolver never touches storage itself; it receives a LAZY lookup
// `(key) => readonly string[] | null` invoked at most once, only at a fork
// exit with non-empty inbound ids. null = store unavailable (latch-off /
// legacy epoch, #4407/#5536) → exactly the byte-evidence-only pre-change
// path (T8).
//
// These pins lock the rung's contract:
//   T1 incident shape + overlapping ids     → reanchor raw (NO fork)
//   T2 same shape, disjoint ids             → fork (guard rail intact)
//   T3 no stamped ids at all                → EXACTLY the pre-change path
//   T4 malformed ids                        → degrade to absent → fork
//   T5 stored rows outlive the wire         → ids no longer riding the
//        projection still prove identity; AND no JSON id ledger exists
//        (skeleton snapshots carry no ids field)
//   T6 restart                              → memory wiped, STORE survives ⇒
//        rescue works from the FIRST post-restart request
//   T7 personaConversationOrder forwards    → observer + inbound ids + lazy
//        lookup, resolved key returned
//   T8 store unavailable (lookup → null)    → byte-only degradation, fork

import test from "node:test";
import assert from "node:assert/strict";

const {
    resolveSessionOrder,
    personaConversationOrder,
    resetSessionOrderForTest,
    orderSnapshot,
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

/** The composite-field-failure history (4 cells, one surviving host id at
 *  position [2]). Reused by several pins with different id sets. */
function incidentHistory(tag: string, survivor: string, filler: string): Msg[] {
    return [
        { role: "user", content: `<bili-snapshot v1 conv="${tag}" seq="9" /> checkpoint condensing the prior exchange. ` + "z".repeat(120) },
        { role: "user", content: "continuation probe after the restart. " + "q".repeat(120) },
        { role: "assistant", content: "surviving cell, original slot 7. " + "w".repeat(120) },
        { role: "user", content: "the new live turn. " + filler },
    ];
}

const SYSTEM_A = "You are dsh, desktop shell agent. env block. ".repeat(24);
const SYSTEM_B = SYSTEM_A.replace("env block.", "env block (v2 rebuild, new gui port 62335).");

test("#5719 T1: composite field failure + overlapping host ids re-anchor the raw lane", () => {
    resetSessionOrderForTest();
    const raw = "session-5719-t1";
    const store = fakeStore();
    // Seed: ten alternating cells under system prompt A; ingest pins the
    // host ids onto canonical rows (fake store mirrors messages.msg_id).
    const seeded = resolveSessionOrder(raw, chain(10, "a"), SYSTEM_A, "deepseek-v4-flash", undefined, undefined, idsOf(10, "a"), store.lookup);
    assert.equal(seeded.key, raw);
    assert.equal(seeded.action, "claim");
    store.rows.set(raw, idsOf(10, "a"));

    // The incident turn: full compaction replaced the middle, ONE surviving
    // cell keeps its host UUID — and the system text drifted to B in the
    // same turn. Every byte rung fails (no assistant-main shape, head
    // misaligned, no model header, no chain, no 8-run fragment evidence, no
    // verified tail — #5686 needs tailAligns). Only the store overlap remains.
    const res = resolveSessionOrder(
        raw,
        incidentHistory(raw, uid("a", 7), "e".repeat(120)),
        SYSTEM_B,
        "deepseek-v4-flash",
        undefined,
        undefined,
        ["chk-5719-1", "pro-5719-1", uid("a", 7), "liv-5719-1"],
        store.lookup,
    );
    assert.equal(res.key, raw, `expected raw re-anchor, got ${res.key} (${res.action})`);
    assert.equal(res.action, "reanchor");
    // #5734 realignment (after 30a8bc2d): this incident cell carries the authored
    // checkpoint's conv declaration, so the self-declaration rung now fires BEFORE
    // the store-overlap rung — same outcome (reanchor on the raw key), earlier
    // reason. Pre-#5734 the pin read /msgid identity \(#5719\)/ +
    // /1 host message id\(s\) match/.
    assert.match(res.reason ?? "", /self-authored checkpoint declares this raw id/);
    assert.match(res.reason ?? "", /#5719/);
});

test("#5719 T2: same composite failure but DISJOINT ids still forks (owner rule 3 guard rail)", () => {
    resetSessionOrderForTest();
    const raw = "session-5719-t2";
    const store = fakeStore();
    assert.equal(resolveSessionOrder(raw, chain(10, "b"), SYSTEM_A, undefined, undefined, undefined, idsOf(10, "b"), store.lookup).key, raw);
    store.rows.set(raw, idsOf(10, "b"));
    const stranger = [
        { role: "user", content: "totally unrelated task one. " + "p".repeat(120) },
        { role: "user", content: "totally unrelated task two. " + "r".repeat(120) },
        { role: "assistant", content: "stranger reply. " + "s".repeat(120) },
        { role: "user", content: "stranger next. " + "t".repeat(120) },
    ];
    const res = resolveSessionOrder(raw, stranger, SYSTEM_B, undefined, undefined, undefined, ["x-1", "x-2", "x-3", "x-4"], store.lookup);
    assert.equal(res.action, "derived-persona");
    assert.ok(res.key.startsWith(`${raw}|sub:`), res.key);
});

test("#5719 T3: no stamped ids → byte-for-byte the pre-change path (fork)", () => {
    resetSessionOrderForTest();
    const raw = "session-5719-t3";
    assert.equal(resolveSessionOrder(raw, chain(10, "c"), SYSTEM_A).key, raw);
    const res = resolveSessionOrder(raw, [
        { role: "user", content: "no ids riding this one. " + "m".repeat(120) },
        { role: "user", content: "second shapeless cell. " + "n".repeat(120) },
        { role: "assistant", content: "reply. " + "o".repeat(120) },
    ], SYSTEM_B);
    assert.equal(res.action, "derived-persona");
    assert.ok(res.key.startsWith(`${raw}|sub:`), res.key);
});

test("#5719 T4: malformed id arrays degrade to ABSENT (never half-trusted) → fork", () => {
    resetSessionOrderForTest();
    const raw = "session-5719-t4";
    const store = fakeStore();
    assert.equal(resolveSessionOrder(raw, chain(10, "d"), SYSTEM_A, undefined, undefined, undefined, idsOf(10, "d"), store.lookup).key, raw);
    store.rows.set(raw, idsOf(10, "d")); // store side is FINE — the wire side must still gate
    const shape = [
        { role: "user", content: "a. " + "f".repeat(120) },
        { role: "user", content: "b. " + "g".repeat(120) },
        { role: "assistant", content: "c. " + "h".repeat(120) },
        { role: "user", content: "d. " + "i".repeat(120) },
    ];
    for (const bad of [["", uid("d", 3)], [uid("d", 3), 42], ["acp_summary_evil"], []] as unknown[]) {
        const r = resolveSessionOrder(raw, shape, SYSTEM_B, undefined, undefined, undefined, bad as string[], store.lookup);
        assert.ok(r.key.startsWith(`${raw}|sub:`), `bad=${JSON.stringify(bad)} → ${r.key} (${r.action})`);
    }
});

test("#5719 T5: stored rows outlive the wire — and NO JSON id ledger exists", () => {
    resetSessionOrderForTest();
    const raw = "session-5719-t5";
    const store = fakeStore();
    assert.equal(resolveSessionOrder(raw, chain(6, "e"), SYSTEM_A, undefined, undefined, undefined, idsOf(6, "e"), store.lookup).key, raw);
    // Ingest pins all six; then two more turns ride the wire and are pinned
    // too — the store view is a SUPERSET of any single later projection.
    store.rows.set(raw, [...idsOf(6, "e"), "e-new-1", "e-new-2"]);
    const cont = resolveSessionOrder(raw, [...chain(6, "e"), { role: "user", content: "more. " + "j".repeat(80) }, { role: "assistant", content: "ok. " + "k".repeat(80) }], SYSTEM_A, undefined, undefined, undefined, [...idsOf(6, "e"), "e-new-1", "e-new-2"], store.lookup);
    assert.equal(cont.key, raw);
    assert.equal(cont.action, "continue");

    // Later: composite field failure again; e-005 rides the visible tail, but
    // an EARLIER compacted-away id (e-002) is the decisive overlap candidate
    // in principle — the store holds it either way: retired rows keep their msg_id
    // rows (retire-don't-delete, #4390) and the lookup reads the FULL
    // historical id set (#5312 allMessageIds), so compacted-away ids
    // remain rescuable even when they never ride the wire again.
    const late = resolveSessionOrder(
        raw,
        incidentHistory(raw, uid("e", 4), "o".repeat(120)),
        SYSTEM_B,
        undefined,
        undefined,
        undefined,
        ["c2-a", "c2-b", uid("e", 4), "c2-c"],
        store.lookup,
    );
    assert.equal(late.key, raw, late.reason);
    assert.equal(late.action, "reanchor");

    // Single-source pin: identity evidence must NOT ride the session-order
    // skeletons (the deprecated JSON recording surface).
    const snap = orderSnapshot().find((e) => e.id === raw);
    assert.ok(snap !== undefined, "skeleton itself still persists (#3397)");
    assert.equal((snap as { ids?: unknown } | undefined)?.ids, undefined, "no ids field on the JSON snapshot row");
});

test("#5719 T6: restart wipes memory — the STORE survives, rescue works from the FIRST request", () => {
    resetSessionOrderForTest();
    const raw = "session-5719-t6";
    const store = fakeStore(); // lives across the simulated process restart
    assert.equal(resolveSessionOrder(raw, chain(8, "f"), SYSTEM_A, undefined, undefined, undefined, idsOf(8, "f"), store.lookup).key, raw);
    store.rows.set(raw, idsOf(8, "f"));

    // Simulated process restart: resolver memory wiped (disk skeleton
    // hydration is #3397 machinery, orthogonal here).
    resetSessionOrderForTest();

    const res = resolveSessionOrder(
        raw,
        incidentHistory(raw, uid("f", 7), "s".repeat(120)),
        SYSTEM_B,
        undefined,
        undefined,
        undefined,
        ["pr-1", "pr-2", uid("f", 7), "pr-3"],
        store.lookup,
    );
    assert.equal(res.key, raw, `post-restart must NOT fork: ${res.key} (${res.action})`);
    // First sight after the wipe claims the raw lane itself — either way the
    // <id>|sub: disaster of #5719 cannot happen.
    assert.ok(res.action === "claim" || res.action === "reanchor", res.action);
});

test("#5719 T7: personaConversationOrder forwards observer + ids + lazy lookup", () => {
    resetSessionOrderForTest();
    const raw = "session-5719-t7";
    const store = fakeStore();
    assert.equal(personaConversationOrder(raw, chain(10, "g"), SYSTEM_A, undefined, undefined, undefined, undefined, idsOf(10, "g"), store.lookup), raw);
    store.rows.set(raw, idsOf(10, "g"));
    const seen: Array<{ id: string; key: string; reason?: string }> = [];
    let lookups = 0;
    const counting = (k: string): readonly string[] | null => {
        lookups++;
        return store.lookup(k);
    };
    const key = personaConversationOrder(
        raw,
        incidentHistory(raw, uid("g", 5), "w".repeat(120)),
        SYSTEM_B,
        undefined,
        undefined,
        undefined,
        (id, r) => {
            seen.push({ id, key: r.key, reason: r.reason });
        },
        ["z-1", "z-2", uid("g", 5), "z-3"],
        counting,
    );
    assert.equal(key, raw);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, raw);
    assert.equal(seen[0].key, raw);
    assert.ok(lookups <= 1, `lazy contract: store queried at most once (got ${lookups})`);
});

test("#5719 T8: store unavailable (lookup → null) — self-declared checkpoint still re-anchors (#5734)", () => {
    resetSessionOrderForTest();
    const raw = "session-5719-t8";
    assert.equal(resolveSessionOrder(raw, chain(10, "h"), SYSTEM_A).key, raw);
    // Overlapping ids WOULD prove identity — and the unified store view is
    // null (latch-off / legacy epoch, #4407/#5536). Pre-#5734 this degraded to
    // byte evidence only → fork (action "derived-persona", key `${raw}|sub:`).
    // #5734 (30a8bc2d): the checkpoint's conv declaration rides the WIRE, so the
    // self-declaration rung re-anchors on the raw key even with a null store.
    const res = resolveSessionOrder(
        raw,
        incidentHistory(raw, uid("h", 3), "v".repeat(120)),
        SYSTEM_B,
        undefined,
        undefined,
        undefined,
        ["s-1", "s-2", uid("h", 3), "s-3"],
        () => null,
    );
    assert.equal(res.action, "reanchor");
    assert.equal(res.key, raw);
    assert.match(res.reason ?? "", /self-authored checkpoint declares this raw id/);
});
