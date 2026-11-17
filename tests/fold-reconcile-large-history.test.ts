import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreMessage } from "acp-kernel";
import { planReconciliation, positionalFingerprint, type FoldAnchor } from "../src/fold-reconcile.ts";

function remintedHistory(count: number, gaps: number[]) {
    const order = Array.from({ length: count }, (_, i) => `old_${i}`);
    const messages: CoreMessage[] = order.map((_, i) => ({ id: `new_${i}`, role: "assistant", contentType: "text", text: `unchanged response ${i}` }));
    const positions = { ids: order, canon: messages.map(positionalFingerprint) };
    const anchors: Record<string, FoldAnchor> = {};
    for (const gap of gaps) {
        anchors[order[gap]] = { r: "assistant", c: "text", b: messages[gap].text!.length };
        messages[gap] = { ...messages[gap], text: `reformatted response ${gap}` };
    }
    return { order, messages, positions, anchors, covered: new Set(order) };
}

test("reconciles a gap bracketed by 150,000 verified positional claims", () => {
    const gap = 75_000;
    const h = remintedHistory(150_001, [gap]);
    const plan = planReconciliation(h.order, h.anchors, h.messages, h.covered, h.positions);
    assert.equal(plan.byPos, 150_000);
    assert.equal(plan.byOrder, 1);
    assert.equal(plan.claims.size, h.order.length);
    assert.deepEqual(plan.claims.get(h.order[gap]), [`new_${gap}`]);
    assert.deepEqual(plan.claims.get(h.order[0]), ["new_0"]);
    assert.deepEqual(plan.claims.get(h.order.at(-1)!), ["new_150000"]);
    assert.deepEqual(plan.unmatched, []);
});

test("keeps leading and trailing gaps outside the verified bracket", () => {
    const h = remintedHistory(20, [0, 10, 19]);
    const plan = planReconciliation(h.order, h.anchors, h.messages, h.covered, h.positions);
    assert.equal(plan.byPos, 17);
    assert.equal(plan.byOrder, 1);
    assert.deepEqual(plan.claims.get("old_10"), ["new_10"]);
    assert.deepEqual(plan.unmatched, ["old_0", "old_19"]);
});

test("does not infer a bracket without any verified positional claims", () => {
    const h = remintedHistory(5, [0, 1, 2, 3, 4]);
    const plan = planReconciliation(h.order, h.anchors, h.messages, h.covered, h.positions);
    assert.equal(plan.byPos, 0);
    assert.equal(plan.byOrder, 0);
    assert.equal(plan.claims.size, 0);
    assert.deepEqual(plan.unmatched, h.order);
});

test("keeps the zero-drift fast path for a large unchanged history", () => {
    const h = remintedHistory(150_001, []);
    for (let i = 0; i < h.messages.length; i++) h.messages[i].id = h.order[i];
    const plan = planReconciliation(h.order, h.anchors, h.messages, h.covered, h.positions);
    assert.equal(plan.claims.size, 0);
    assert.equal(plan.byPos, 0);
    assert.equal(plan.byOrder, 0);
    assert.deepEqual(plan.unmatched, []);
    assert.deepEqual(plan.newOrder, h.order);
});
