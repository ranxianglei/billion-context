import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreMessage } from "acp-kernel";
import { canonicalTextOf, normalizedIdentity, planReconciliation, wordBagDigest, type FoldAnchor } from "../src/fold-reconcile.ts";
import { simhashHex } from "../src/affinity-simhash.ts";

// A resumed session whose folds are all inactive presents every stored id as
// missing while the wire carries a different, re-minted history. The shape
// pass and the residual census then weigh each unclaimed anchor against the
// candidates on word evidence. Those digests depend only on a candidate's
// text, so the work must stay linear in anchors + candidates: re-tokenizing
// every candidate for every anchor blocked a live proxy's event loop past the
// 300 s watchdog (9.6k stored refs x 1.3k inbound messages).
const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split(" ");

function prose(seed: number, words: number): string {
    const out: string[] = [`msg${seed}`]; // one seed-unique word: no two seeds share a word bag
    for (let i = 0; i < words; i++) out.push(`${WORDS[(seed * 7 + i * 3) % WORDS.length]}${(seed + i) % 97}`);
    return out.join(" ");
}

function anchorFor(text: string): FoldAnchor {
    const canon = canonicalTextOf(text);
    return { r: "assistant", c: "text", b: text.length, wh: wordBagDigest(canon), sh: simhashHex(canon) };
}

function remintedSession(stored: number, inbound: number, words: number) {
    const order = Array.from({ length: stored }, (_, i) => `old_${i}`);
    const anchors: Record<string, FoldAnchor> = {};
    order.forEach((id, i) => { anchors[id] = anchorFor(prose(i, words)); });
    const msgs: CoreMessage[] = Array.from({ length: inbound }, (_, i) => ({ id: `new_${i}`, role: "assistant", contentType: "text", text: prose(100_000 + i, words) }));
    return { order, anchors, msgs, covered: new Set(order) };
}

test("residual census over a fully re-minted history stays linear", () => {
    const h = remintedSession(3_000, 1_500, 400);
    const t0 = process.hrtime.bigint();
    const plan = planReconciliation(h.order, h.anchors, h.msgs, h.covered);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(plan.claims.size, 0);
    assert.equal(plan.unmatched.length, h.order.length);
    assert.equal(plan.absentEverywhere.length, h.order.length);
    assert.deepEqual(plan.nearDupResidual, []);
    // Linear work here is well under a second; the per-pair form re-tokenized
    // 4.5M ~2.5 KB texts and took minutes.
    assert.ok(ms < 5_000, `3k anchors x 1.5k candidates took ${ms.toFixed(0)}ms`);
});

test("shape pass still pairs re-wrapped user text by unwrapped identity, in order", () => {
    const stored = Array.from({ length: 6 }, (_, i) => prose(i, 12));
    const order = stored.map((_, i) => `old_${i}`);
    const anchors: Record<string, FoldAnchor> = {};
    stored.forEach((text, i) => {
        const canon = canonicalTextOf(text);
        anchors[order[i]] = { r: "user", c: "text", b: text.length, n: normalizedIdentity({ id: order[i], role: "user", contentType: "text", text }), wh: wordBagDigest(canon), sh: simhashHex(canon) };
    });
    // The host re-wraps each line under a fresh id; an unrelated user message sits in front.
    const msgs: CoreMessage[] = [{ id: "noise", role: "user", contentType: "text", text: prose(99, 12) }];
    stored.forEach((text, i) => msgs.push({ id: `new_${i}`, role: "user", contentType: "text", text: text.replace(/ /g, (_, at: number) => (at % 3 === 0 ? "\n" : " ")) }));
    const plan = planReconciliation(order, anchors, msgs, new Set(order));
    for (let i = 0; i < stored.length; i++) assert.deepEqual(plan.claims.get(`old_${i}`), [`new_${i}`]);
    assert.equal(plan.byShape, stored.length);
});

test("shape pass still pairs a re-minted word-bag twin with the first candidate in order", () => {
    const h = remintedSession(8, 8, 40);
    // Two inbound copies of old_3's words under fresh ids: the earlier one wins.
    h.msgs.splice(2, 0, { id: "twin_a", role: "assistant", contentType: "text", text: prose(3, 40) });
    h.msgs.push({ id: "twin_b", role: "assistant", contentType: "text", text: prose(3, 40) });
    const plan = planReconciliation(h.order, h.anchors, h.msgs, h.covered);
    assert.deepEqual(plan.claims.get("old_3"), ["twin_a"]);
    assert.equal(plan.byShape, 1);
    // The census runs over the pre-shape unmatched list: old_3 is still listed
    // there, and the unclaimed twin_b carries its bag — near-duplicate residue.
    // No other anchor shares a bag with any candidate.
    assert.deepEqual(plan.nearDupResidual, ["old_3"]);
    assert.equal(plan.absentEverywhere.length, h.order.length - 1);
});
