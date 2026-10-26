// #3945: duplicate-id messages flip bytes of an ALREADY-SENT message. The
// BLOCKED binding in messageRefs.byRaw is keyed by message id but SHARED by
// every message carrying that id, while protection is decided per message.
// refs.ts migrated a stale BLOCKED entry to a fresh numeric ref as soon as
// ANY one message with that id lost protection — deleting the binding a
// still-protected sibling depended on, so the sibling's next render gained a
// tag it never had (mid-history rewrite of bytes the prefix cache banked).
// Found by the verif solver (tests/verif-generic-append-stability.test.ts Q2);
// these pins freeze the fixed contract: migration requires that NO message
// with that id is protected, and the unprotected-sibling path renders verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignRefs, BLOCKED_REF } from "../src/refs.js";
import { renderVisibleRefs } from "../src/render-refs.js";
import { createInitialState } from "../src/state.js";
import type { CoreMessage } from "../src/types.js";

const countTokens = (text: string) => Math.ceil(text.length / 4);

const user = (id: string, text: string): CoreMessage => ({
  id,
  role: "user",
  contentType: "text",
  text,
});

test("pin: an unprotected sibling never steals a BLOCKED binding from a protected one (#3945)", () => {
  const m1 = user("C", "shared id, protected");
  const m2 = user("D", "distinct id");
  const m3 = user("C", "shared id, NOT protected");
  const isProtected = (m: CoreMessage) => m === m1;

  const pass = assignRefs([m1, m2, m3], {
    existing: { byRaw: {}, byRef: {} },
    nextIndex: 1,
    isProtected,
  });

  // The binding survives: no migration was recorded for "C"…
  assert.equal(pass.map.byRaw["C"], BLOCKED_REF);
  assert.deepEqual(pass.migratedIds, []);
  // …and the sibling pair renders verbatim (BLOCKED ⇒ as-is, no tag).
  const state = createInitialState();
  state.messageRefs = pass.map;
  const rendered = renderVisibleRefs([m1, m2, m3], state, countTokens);
  assert.equal(rendered[0]!.text, "shared id, protected");
  assert.equal(rendered[2]!.text, "shared id, NOT protected");
});

test("pin: round-over-round bytes stay stable under the collision shape", () => {
  const m1 = user("C", "shared id, protected");
  const m2 = user("D", "distinct id");
  const m3 = user("C", "shared id, NOT protected");
  const isProtected = (m: CoreMessage) => m === m1;

  const state = createInitialState();
  state.messageRefs = { byRaw: {}, byRef: {} };
  let next = 1;
  let prevRender: string[] | null = null;
  for (let round = 0; round < 3; round++) {
    const pass = assignRefs([m1, m2, m3], {
      existing: state.messageRefs,
      nextIndex: next,
      isProtected,
    });
    state.messageRefs = pass.map;
    next = pass.nextIndex;
    const rendered = renderVisibleRefs([m1, m2, m3], state, countTokens);
    const texts = rendered.map((m) => m.text ?? "");
    if (prevRender) assert.deepEqual(texts, prevRender);
    prevRender = texts;
  }
  // The distinct-id message keeps its stable tag; the collided pair never
  // gains one.
  assert.ok((prevRender![1] ?? "").startsWith("<acp"));
  assert.equal(prevRender![0], "shared id, protected");
  assert.equal(prevRender![2], "shared id, NOT protected");
});

test("pin: migration still fires once every same-id message is unprotected (#2607 contract)", () => {
  const m1 = user("C", "shared id, was protected");
  const m3 = user("C", "shared id, never protected");
  const pass1 = assignRefs([m1], {
    existing: { byRaw: {}, byRef: {} },
    nextIndex: 1,
    isProtected: () => true,
  });
  assert.equal(pass1.map.byRaw["C"], BLOCKED_REF);

  const pass2 = assignRefs([m1, m3], {
    existing: pass1.map,
    nextIndex: pass1.nextIndex,
    isProtected: () => false,
  });
  assert.equal(pass2.map.byRaw["C"], "m00001");
  assert.deepEqual(pass2.migratedIds, ["C"]);
});

test("pin: all-unprotected duplicate ids mint exactly one ref", () => {
  const m1 = user("C", "first");
  const m3 = user("C", "second");
  const pass = assignRefs([m1, m3], {
    existing: { byRaw: {}, byRef: {} },
    nextIndex: 1,
    isProtected: () => false,
  });
  assert.equal(pass.map.byRaw["C"], "m00001");
  assert.equal(pass.map.byRef["m00001"], "C");
  assert.equal(pass.newlyAssigned, 1);
});
