// #5714: DSH native main requests with a STABLE client-minted conversation
// id move onto an empty `|sub:` lane when the per-turn system/persona text
// rotates AND a host-side insertion shifts the whole old history to new
// indices. Follow-up to #4778 (grown + rewritten-at-SAME-indices) and the
// grown/shifted counterpart of #5686 (shorter + unchanged tail + changed tag).
//
// Topology (the issue's deterministic repro):
//   turn 1  claim fresh id, N alternating user/assistant turns, persona A
//   turn 2  same id+model, persona B, history = [host-inserted-cell, ...old]
//
// Pre-fix the tag-changed ladder defeats every rung:
//   - head-fragment rung : the inserted cell shifts every later index
//   - model-switch rung  : no model change
//   - chain rung         : a head insertion breaks the progressive hash
//   - #4778 rung         : requires >= CONTINUATION_MIN_RUN SAME-INDEX
//                          agreements — the shift makes them zero
//   - #5686 rung         : requires incoming SHORTER than recorded — false
//   => falls through to derived-persona, orphaning the root lane's folds.
//
// Fix (src/session-resolve.ts): the #4778 continuation rung measures the
// longest EXACT content-cell fragment agreement over ANY relative offset
// (not just the zero diagonal). A long verbatim stretch cannot occur between
// two distinct conversations (MESSAGE-IDENTITY: exact per-cell sha256, never
// fuzzy), so a shifted-but-preserved history migrates instead of forking.
// Every guardrail leg (overlap / length / mainShaped / threshold) keeps its
// designed fork alive — pinned below, both directions (#3617).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resetSessionOrderForTest, resolveSessionOrder, sessionOrderSkeletonOf, orderSkeletonOf } from "../src/session-resolve.ts";

const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const forkKey = (id: string, tag: string): string => `${id}|sub:${fp16(tag)}`;

type M = { role: string; content?: string | null };

/** N alternating user/assistant turns with DISTINCT fragments (main-shaped,
 *  unambiguously a real conversation — not an aux blob). */
const plain = (n: number, label: string): M[] =>
    Array.from({ length: n }, (_, i): M => ({ role: i % 2 === 0 ? "user" : "assistant", content: `${label}-${i + 1}-` + "x".repeat(120) }));

test("#5714 regression: grown history SHIFTED by a host-side insertion + persona rotation keeps the RAW key", () => {
    resetSessionOrderForTest();
    const id = "session-11111111-2222-3333-4444-555555555555";
    const oldHistory = plain(20, "main");
    // Turn 1: claim the fresh id under persona A, model fixed.
    const claim = resolveSessionOrder(id, oldHistory, "old-persona", "same-model");
    assert.equal(claim.key, id);
    assert.equal(claim.action, "claim");

    // Turn 2: persona rotates A→B AND a host cell is INSERTED at the head,
    // shifting the entire old history by one index. Pre-fix this returned
    // { key: |sub:<fp(B)>, action: "derived-persona" }.
    const shifted: M[] = [{ role: "user", content: "host-inserted-header-" + "h".repeat(120) }, ...oldHistory];
    const res = resolveSessionOrder(id, shifted, "new-persona", "same-model");
    assert.equal(res.key, id, "shifted-but-preserved history keeps the RAW key");
    assert.equal(res.action, "reanchor");
    assert.match(res.reason ?? "", /#4778|#5714/);
    // The skeleton re-anchored to the host's living truth (insertion included).
    assert.deepEqual(sessionOrderSkeletonOf(id), orderSkeletonOf(shifted));
});

test("#5714 regression (sb- UUID id shape): the same shifted topology migrates identically", () => {
    resetSessionOrderForTest();
    const id = "sb-9f8e7d6c-5b4a-3c2d-1e0f-abcdefabcdef";
    const oldHistory = plain(20, "main");
    resolveSessionOrder(id, oldHistory, "old-persona", "same-model");
    const shifted: M[] = [{ role: "user", content: "host-inserted-header-" + "h".repeat(120) }, ...oldHistory];
    const res = resolveSessionOrder(id, shifted, "new-persona", "same-model");
    assert.equal(res.key, id, "sb- shaped id also keeps the RAW key");
    assert.equal(res.action, "reanchor");
});

test("#5714 regression (deletion shift, negative offset): host-side DELETION of an early cell + persona rotation keeps the RAW key", () => {
    resetSessionOrderForTest();
    const id = "session-66666666-7777-8888-9999-aaaaaaaaaaaa";
    const oldHistory = plain(20, "main");
    // Turn 1: claim the fresh id under persona A, model fixed.
    const claim = resolveSessionOrder(id, oldHistory, "old-persona", "same-model");
    assert.equal(claim.key, id);
    assert.equal(claim.action, "claim");

    // Turn 2: persona rotates A→B AND the host DROPS an early cell from its
    // own log (index 1), shifting every later cell one index EARLIER, then
    // appends the fresh turn. The recorded body now sits inside the incoming
    // at NEGATIVE relative offset — the zero diagonal scores zero agreement,
    // so pre-fix this forked onto |sub:<fp(B)> exactly like the insertion case.
    const shifted: M[] = [...oldHistory.slice(1), ...plain(3, "next")];
    const res = resolveSessionOrder(id, shifted, "new-persona", "same-model");
    assert.equal(res.key, id, "deleted-and-shifted-but-preserved history keeps the RAW key");
    assert.equal(res.action, "reanchor");
    assert.match(res.reason ?? "", /#4778|#5714/);
    // The skeleton re-anchored to the host's living truth (deletion included).
    assert.deepEqual(sessionOrderSkeletonOf(id), orderSkeletonOf(shifted));
});

test("#5714 control: the SHORTER slice still reanchors through #5686 (fifth rung untouched)", () => {
    resetSessionOrderForTest();
    const id = "sess-5714-shorter";
    const oldHistory = plain(20, "main");
    resolveSessionOrder(id, oldHistory, "old-persona", "same-model");
    // Issue step 5: drop the first four cells, rotate the persona. Shorter
    // than recorded with a fragment-verified tail -> #5686 reanchor.
    const shorter = oldHistory.slice(4);
    const res = resolveSessionOrder(id, shorter, "new-persona", "same-model");
    assert.equal(res.key, id);
    assert.equal(res.action, "reanchor");
    assert.match(res.reason ?? "", /#5686/);
});

test("#5714 control: a SHIFTED stranger under the same id still forks (overlap gate holds across offsets)", () => {
    resetSessionOrderForTest();
    const id = "sess-5714-stranger";
    resolveSessionOrder(id, plain(20, "main"), "sys-A");
    // A DIFFERENT conversation, itself shifted by an unrelated leading cell.
    // It shares no verbatim stretch with the recorded one, so no offset
    // yields CONTINUATION_MIN_RUN exact agreements -> honest fork.
    const stranger: M[] = [{ role: "user", content: "other-task-seed-" + "z".repeat(120) }, ...plain(20, "stranger")];
    const res = resolveSessionOrder(id, stranger, "sys-B");
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, forkKey(id, "sys-B"));
});

test("#5714 control: a STALE shorter replay with a shift must not rewind the live skeleton (length gate)", () => {
    resetSessionOrderForTest();
    const id = "sess-5714-stale";
    const oldHistory = plain(20, "main");
    resolveSessionOrder(id, oldHistory, "sys-A");
    // Verbatim prefix (would agree across offsets) but the incoming is
    // SHORTER overall than the recorded skeleton — stale, not a continuation.
    const stale: M[] = [{ role: "user", content: "stale-head-" + "s".repeat(120) }, ...oldHistory.slice(0, 10)];
    const res = resolveSessionOrder(id, stale, "sys-B");
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, forkKey(id, "sys-B"));
});

test("#5714 control: scattered divergence below the threshold stays a fork even when shifted (threshold gate)", () => {
    resetSessionOrderForTest();
    const id = "sess-5714-thresh";
    const oldHistory = plain(20, "main");
    resolveSessionOrder(id, oldHistory, "sys-A");
    // Shift by one AND rewrite four well-spread cells so NO contiguous run of
    // eight verbatim cells survives at any offset. Not provably the same
    // conversation -> fork.
    const edited = oldHistory.map((m, i) => ((i === 3 || i === 8 || i === 13 || i === 17) ? { ...m, content: `edited-${i}-` + "e".repeat(120) } : m));
    const shifted: M[] = [{ role: "user", content: "thresh-head-" + "t".repeat(120) }, ...edited];
    const res = resolveSessionOrder(id, shifted, "sys-B");
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, forkKey(id, "sys-B"));
});

test("#5714 control: a shallow review blob with a different tag still forks (mainShaped gate)", () => {
    resetSessionOrderForTest();
    const id = "sess-5714-blob";
    resolveSessionOrder(id, plain(20, "main"), "sys-A");
    const blob: M[] = [{ role: "user", content: "Conversation transcript (flattened):\nuser: build it\nDecide: risky?" }];
    const res = resolveSessionOrder(id, blob, "review-policy");
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, forkKey(id, "review-policy"));
});
