// #5844: the host-upgrade REPACK shape — a dsh desktop upgrade (0.2.1-rc.3 →
// 0.2.2-rc.1) changed BOTH the system prompt (persona tagHash rotated,
// tagChanged) AND the message-record layout (assistant text segments stopped
// owning their own records; they were folded into the adjacent tool_use
// record). The long session's replay is then STRICTLY SHORTER than the
// recorded skeleton, head-diverged, with every logical turn content-identical
// but regrouped into different source messages. Every existing escape loses:
// head fragments broken (granularity changed), #4778 length-gated (shorter),
// and #5686's fragment tail is disjoint by construction — the old run hashed
// [frag(text), frag(calls)] per turn while the new run hashes one combined
// record, so the per-source-message `frags` never agree even though the
// logical conversation is byte-identical. Result (field, v0.1.212): the whole
// main conversation re-keys onto `<id>|sub:<fp>` with ZERO blocks, preflight
// folds ~2.5M tokens from scratch, and the resume dies in a 413 retryable=
// false loop until the user hand-edits stateDir()/session-order.json.
//
// Fix (src/session-resolve.ts): the #5686 shorter-tail rung gains a parallel
// evidence class — the last ≤TAIL_WINDOW turns compared by CANONICAL form
// (kind + logical text/calls, the identity chain's own hashing input via
// neutralTurnCanonical) instead of per-source-message fragments. A repack
// changes the envelope, not the logical bytes; a content-verified tail
// cannot belong to a different conversation (MESSAGE-IDENTITY doctrine,
// exact comparison — no fuzzy similarity). Old persisted skeletons carry no
// canon column → the check degrades to absent → byte-fragment path only, so
// pre-change snapshots behave EXACTLY as before.
//
// Scope honesty: this rung rescues the repack shape when the removed/altered
// cells sit OUTSIDE the tail window. Cells mutated INSIDE the last eight
// positions still fork (the guardrail below) — safe direction, no substrate
// loss. The grown+shifted sibling (#5714) needs subsequence alignment and is
// tracked separately.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOrderSnapshot, orderSkeletonOf, orderSnapshot, resetSessionOrderForTest, resolveSessionOrder, sessionOrderSkeletonOf } from "../src/session-resolve.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";
const testRoot = mkdtempSync(join(tmpdir(), "bili-5844-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

type M = { role: string; content?: unknown };
const ID = "sess-5844-anchor";
const S1 = "You are DeepSeek Harness.\nModel: GLM-A.";
const S2 = "You are DeepSeek Harness NEXT.\nModel: GLM-B.\nBudget day 2."; // upgrade re-stamp
const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

/** Old-host turn: assistant prose is its OWN record, then a tool_use record. */
function oldTurn(i: number): M[] {
    return [
        { role: "user", content: `question ${i}. ` + "q".repeat(60) },
        { role: "assistant", content: `prose ${i}. ` + "p".repeat(80) },
        { role: "assistant", content: [{ type: "tool_use", id: `tu-${i}`, name: "read_file", input: { path: `f${i}.txt` } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${i}`, content: `result ${i}. ` + "r".repeat(60) }] },
    ];
}

/** New-host turn: prose MERGED into the tool_use record (same logical content). */
function newTurn(i: number): M[] {
    return [
        { role: "user", content: `question ${i}. ` + "q".repeat(60) },
        { role: "assistant", content: [
            { type: "text", text: `prose ${i}. ` + "p".repeat(80) },
            { type: "tool_use", id: `tu-${i}`, name: "read_file", input: { path: `f${i}.txt` } },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${i}`, content: `result ${i}. ` + "r".repeat(60) }] },
    ];
}

/** Standalone commentary records the OLD host persisted; the NEW host no
 *  longer emits them (→ strictly shorter replay). Outside the tail window so
 *  the last eight logical turns stay intact. */
const COMMENTARY_AT = [2, 5, 8, 11, 14];
const TURNS = 30;

const seed: M[] = [{ role: "system", content: S1 }];
for (let i = 0; i < TURNS; i++) {
    seed.push(...oldTurn(i));
    if (COMMENTARY_AT.includes(i)) seed.push({ role: "assistant", content: `interim commentary ${i}. ` + "c".repeat(80) });
}
const incoming: M[] = [{ role: "system", content: S2 }];
for (let i = 0; i < TURNS; i++) incoming.push(...newTurn(i)); // commentaries gone, records repacked

const SEED_CELLS = orderSkeletonOf(seed).length;
const IN_CELLS = orderSkeletonOf(incoming).length;

test("#5844: tag-changed STRICTLY-SHORTER repacked-tail replay re-anchors instead of forking", () => {
    resetSessionOrderForTest();
    assert.ok(IN_CELLS < SEED_CELLS, "shape premise: the repack replay is strictly shorter");
    const claim = resolveSessionOrder(ID, seed, S1);
    assert.equal(claim.action, "claim");
    assert.equal(claim.key, ID);

    const res = resolveSessionOrder(ID, incoming, S2);
    assert.equal(res.key, ID, "anchor kept on the raw id — no |sub: fork");
    assert.equal(res.action, "reanchor");
    assert.match(res.reason ?? "", /#5844/, "the content-verified-tail path is distinguishable in the log surface");
    assert.equal(sessionOrderSkeletonOf(ID)?.length, IN_CELLS, "skeleton follows the living (repacked) end");
});

test("#5844 guardrail: repacked replay with a MUTATED tail cell still forks (stranger wearing the skeleton)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder(ID, seed, S1);
    const mutated: M[] = [...incoming];
    // Mutate the FINAL tool result's text while keeping the repacked layout
    // (same kinds, same record shape): the fork must come from the
    // canonical-fingerprint mismatch itself, not from a kind break (a kind
    // break dies earlier in tailAligns and would pass even without the canon
    // comparison). A tool-result turn carries its text in the canonical form
    // (unlike an assistant calls turn, whose canon is calls+role only for
    // cross-wire neutrality — see affinity-neutral.ts header).
    const lastTr = mutated.length - 1;
    assert.equal((mutated[lastTr] as M).role, "user", "shape premise: the replay ends with a tool-result record");
    mutated[lastTr] = { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${TURNS - 1}`, content: "mutated final result — different conversation, same skeleton" }] };
    const res = resolveSessionOrder(ID, mutated, S2);
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, `${ID}|sub:${fp16(S2)}`);
});

test("#5844 degradation: a skeleton hydrated WITHOUT the canon column behaves exactly pre-change (fork)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder(ID, seed, S1);
    const snap = orderSnapshot();
    assert.ok(snap.some((e) => e.id === ID && Array.isArray(e.canon)), "live skeleton carries the canon column");
    const stripped = snap.map(({ canon: _dropped, ...rest }) => rest);
    resetSessionOrderForTest();
    assert.equal(applyOrderSnapshot(stripped), 1);
    const res = resolveSessionOrder(ID, incoming, S2);
    assert.equal(res.action, "derived-persona", "no canon evidence → byte-fragment path only → fork, exactly as before this change");
    assert.equal(res.key, `${ID}|sub:${fp16(S2)}`);
});

test("#5844 persistence round-trip: the canon column survives snapshot → hydrate, so a restart keeps the rescue", () => {
    resetSessionOrderForTest();
    resolveSessionOrder(ID, seed, S1);
    const snap = orderSnapshot();
    resetSessionOrderForTest();
    assert.equal(applyOrderSnapshot(snap), 1);
    const res = resolveSessionOrder(ID, incoming, S2);
    assert.equal(res.key, ID);
    assert.equal(res.action, "reanchor");
});

test("#5844 hardening: a MALFORMED persisted canon degrades to absent (never trusted)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder(ID, seed, S1);
    const snap = orderSnapshot();
    // Non-fingerprint elements (hand-edited or corrupted file) must drop the
    // whole column: the repack shape falls back to the byte-fragment path.
    const malformed = snap.map((e) => (e.id === ID ? { ...e, canon: ["not-a-fingerprint"] } : e));
    resetSessionOrderForTest();
    assert.equal(applyOrderSnapshot(malformed), 1);
    const res = resolveSessionOrder(ID, incoming, S2);
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, `${ID}|sub:${fp16(S2)}`);
});

test("#5844 symmetry regression: tag-INVARIANT repacked shorter replay re-anchors (pre-existing owner-rule-1 branch untouched)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder(ID, seed, S1);
    const sameTagIncoming: M[] = [{ role: "system", content: S1 }, ...incoming.slice(1)];
    const res = resolveSessionOrder(ID, sameTagIncoming, S1);
    assert.equal(res.key, ID);
    assert.equal(res.action, "reanchor");
});
