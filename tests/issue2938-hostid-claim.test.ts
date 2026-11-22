// #2938 Tier-1 increment 2 — exact host-stable-id claim pass.
//
// Compound drift (id re-mint AND content change in one replay, the dsh model
// switch shape) defeats every content-based pass; the host's own self-minted
// identifiers — carried per request on the validated side channel and joined
// to vanished covered ids through the persisted derived→host table — are the
// only evidence left. These tests pin: the claim fires on exact equality, the
// double-uniqueness guards refuse ambiguity, and WITHOUT the view the legacy
// behavior is byte-identical (negative gate, #3617 discipline).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import {
    planReconciliation,
    normalizedIdentity,
    type FoldAnchor,
    type HostIdView,
} from "../src/fold-reconcile.js";
import { zipHostUnits } from "../src/hostid-channel.js";

function msg(id: string, role: string, text: string, extra?: Partial<CoreMessage>): CoreMessage {
    return { id, role, text, ...(extra ?? {}) } as CoreMessage;
}

function anchorOf(m: CoreMessage): FoldAnchor {
    const a: FoldAnchor = { n: normalizedIdentity(m), r: m.role, b: m.text?.length ?? 0 };
    if (m.toolCallId !== undefined && m.toolCallId !== "") a.t = m.toolCallId;
    return a;
}

test("zipHostUnits: aligned walk pairs every tool unit in order", () => {
    const msgs = [
        msg("a1", "assistant", "text"),
        msg("c1", "assistant", "", { toolCallId: "k1" }),
        msg("r1", "tool", "res", { toolCallId: "k1" }),
        msg("c2", "assistant", "", { toolCallId: "k2" }),
    ];
    const out = zipHostUnits(msgs, ["H1", "H2", "H3"]);
    assert.deepEqual([...out!.entries()], [["c1", "H1"], ["r1", "H2"], ["c2", "H3"]]);
});

test("zipHostUnits: count mismatch between walk and list degrades to undefined", () => {
    const msgs = [msg("c1", "assistant", "", { toolCallId: "k1" })];
    assert.equal(zipHostUnits(msgs, ["H1", "H2"]), undefined);
    assert.equal(zipHostUnits([], ["H1"]), undefined);
});

test("zipHostUnits: a host repeating its own id degrades to undefined", () => {
    const msgs = [
        msg("c1", "assistant", "", { toolCallId: "k1" }),
        msg("r1", "tool", "res", { toolCallId: "k1" }),
    ];
    assert.equal(zipHostUnits(msgs, ["H1", "H1"]), undefined);
});

test("zipHostUnits: empty list against a tool-free transcript yields an empty map", () => {
    const out = zipHostUnits([msg("a1", "assistant", "text")], []);
    assert.ok(out !== undefined && out.size === 0);
});

// One assistant preamble + two tool rounds. The NEW pass re-mints every
// toolCallId (dsh model-switch sanitize shape) AND changes the surrounding
// bytes, so positional (no stored copy), toolCallId-exact, twin and
// normalized-identity passes all starve — exactly the residual gap.
function fixture() {
    const oA1 = msg("o-a1", "assistant", "let me check things");
    const oC1 = msg("o-c1", "assistant", "", { toolCallId: "call_a" });
    const oR1 = msg("o-r1", "tool", "result one", { toolCallId: "call_a" });
    const oC2 = msg("o-c2", "assistant", "", { toolCallId: "call_b" });
    const oR2 = msg("o-r2", "tool", "result two", { toolCallId: "call_b" });
    const oldMsgs = [oA1, oC1, oR1, oC2, oR2];
    const oldOrder = oldMsgs.map((m) => m.id!);
    const anchors: Record<string, FoldAnchor> = {};
    for (const m of oldMsgs) anchors[m.id!] = anchorOf(m);

    const nA1 = msg("n-a1", "assistant", "let me check the things, now");
    const nC1 = msg("n-c1", "assistant", "", { toolCallId: "call_a_fc_0" });
    const nR1 = msg("n-r1", "tool", "result one (reworded)", { toolCallId: "call_a_fc_0" });
    const nC2 = msg("n-c2", "assistant", "", { toolCallId: "call_b_fc_1" });
    const nR2 = msg("n-r2", "tool", "result two (reworded)", { toolCallId: "call_b_fc_1" });
    const newMsgs = [nA1, nC1, nR1, nC2, nR2];

    const bindings: Record<string, string> = { "o-c1": "H1", "o-r1": "H2", "o-c2": "H3", "o-r2": "H4" };
    const channel = ["H1", "H2", "H3", "H4"];
    return { oldOrder, anchors, newMsgs, covered: new Set(oldOrder), bindings, channel };
}

test("compound drift: host-id pass claims every re-minted tool unit (zero tool unmatched)", () => {
    const f = fixture();
    const fresh = zipHostUnits(f.newMsgs, f.channel)!;
    const view: HostIdView = { fresh, bindings: f.bindings };
    const plan = planReconciliation(f.oldOrder, f.anchors, f.newMsgs, f.covered, undefined, view);
    assert.deepEqual(plan.claims.get("o-c1"), ["n-c1"]);
    assert.deepEqual(plan.claims.get("o-r1"), ["n-r1"]);
    assert.deepEqual(plan.claims.get("o-c2"), ["n-c2"]);
    assert.deepEqual(plan.claims.get("o-r2"), ["n-r2"]);
    assert.equal(plan.byHost, 4);
    // Only the genuinely-changed assistant preamble stays honestly unmatched.
    assert.deepEqual(plan.unmatched, ["o-a1"]);
});

test("negative gate: identical replay WITHOUT the view keeps legacy behavior", () => {
    const f = fixture();
    const plan = planReconciliation(f.oldOrder, f.anchors, f.newMsgs, f.covered);
    assert.equal(plan.byHost, 0);
    assert.equal(plan.claims.size, 0);
    assert.equal(plan.unmatched.length, 5);
});

test("ambiguity: two vanished ids bound to one host id → both refused", () => {
    const f = fixture();
    const badBindings: Record<string, string> = { ...f.bindings, "o-c2": "H1" };
    const view: HostIdView = { fresh: zipHostUnits(f.newMsgs, f.channel)!, bindings: badBindings };
    const plan = planReconciliation(f.oldOrder, f.anchors, f.newMsgs, f.covered, undefined, view);
    assert.equal(plan.claims.get("o-c1"), undefined);
    assert.equal(plan.claims.get("o-c2"), undefined);
    // Unambiguous partners still claim.
    assert.deepEqual(plan.claims.get("o-r1"), ["n-r1"]);
    assert.deepEqual(plan.claims.get("o-r2"), ["n-r2"]);
    assert.equal(plan.byHost, 2);
});

test("role gate: a result bound to a host id now sitting on a call unit → refused", () => {
    const f = fixture();
    // Only o-r1 carries H1 (no other missing id shares it, so the ambiguity
    // guard stays quiet): its anchor says role tool, but the fresh unit under
    // H1 is n-c1 (assistant call) → refused.
    const crossed: Record<string, string> = { "o-r1": "H1", "o-c2": "H3", "o-r2": "H4" };
    const view: HostIdView = { fresh: zipHostUnits(f.newMsgs, f.channel)!, bindings: crossed };
    const plan = planReconciliation(f.oldOrder, f.anchors, f.newMsgs, f.covered, undefined, view);
    assert.equal(plan.claims.get("o-r1"), undefined);
    assert.deepEqual(plan.claims.get("o-c2"), ["n-c2"]);
    assert.deepEqual(plan.claims.get("o-r2"), ["n-r2"]);
    assert.equal(plan.byHost, 2);
});
