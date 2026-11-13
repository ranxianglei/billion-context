import test from "node:test";
import assert from "node:assert/strict";
import type { FoldAnchor } from "../src/fold-reconcile.ts";
import { resolveStoredDecompositions, type StoredRow } from "../src/fold-decomposition-lookup.ts";
import type { Session } from "../src/session.ts";

// #4732 cluster: the dedup loop in resolveStoredDecompositions kept splice
// indices in a Map that went stale the moment one splice shifted later
// entries — a second duplicate of a SHIFTED id then removed the wrong element
// (or none), dropping one id's latest decomposition entirely and duplicating
// the other's. Interleave A₁,B₁,A₂,B₂ must yield exactly [A₂,B₂].

function sessionWith(ids: string[]): Session {
    const anchors: Record<string, FoldAnchor> = {};
    for (const id of ids) anchors[id] = { n: id, r: "assistant", c: "text", b: 10 };
    return { state: { blocks: [] }, metadata: { foldAnchors: anchors } } as unknown as Session;
}

test("interleaved duplicate decompositions keep exactly the latest row per id", () => {
    const rows: StoredRow[] = [
        { msgId: "a1", seq: 1, content: JSON.stringify({ id: "a1", role: "assistant", text: "A-OLD" }) },
        { msgId: "b1", seq: 2, content: JSON.stringify({ id: "b1", role: "assistant", text: "B-OLD" }) },
        { msgId: "a1", seq: 3, content: JSON.stringify({ id: "a1", role: "assistant", text: "A-NEW" }) },
        { msgId: "b1", seq: 4, content: JSON.stringify({ id: "b1", role: "assistant", text: "B-NEW" }) },
    ];
    const source = { rows: () => rows };
    const out = resolveStoredDecompositions(sessionWith(["a1", "b1"]), "s1", new Set(), source);
    assert.ok(out, "returns messages");
    assert.deepEqual(
        out.map((m) => (m as { text?: string }).text),
        ["A-NEW", "B-NEW"],
        "exactly the latest decomposition per id, in seq order — no stale row, no drop",
    );
});

test("triple interleave A,B,A,B,A keeps only A₃ (index shift under repeated splices)", () => {
    const rows: StoredRow[] = [
        { msgId: "a", seq: 1, content: JSON.stringify({ id: "a", role: "assistant", text: "A1" }) },
        { msgId: "b", seq: 2, content: JSON.stringify({ id: "b", role: "assistant", text: "B1" }) },
        { msgId: "a", seq: 3, content: JSON.stringify({ id: "a", role: "assistant", text: "A2" }) },
        { msgId: "b", seq: 4, content: JSON.stringify({ id: "b", role: "assistant", text: "B2" }) },
        { msgId: "a", seq: 5, content: JSON.stringify({ id: "a", role: "assistant", text: "A3" }) },
    ];
    const source = { rows: () => rows };
    const out = resolveStoredDecompositions(sessionWith(["a", "b"]), "s1", new Set(), source);
    assert.ok(out);
    assert.deepEqual(
        out.map((m) => (m as { text?: string }).text),
        ["B2", "A3"],
    );
});
