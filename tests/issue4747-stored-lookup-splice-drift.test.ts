import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveStoredDecompositions, type StoredRow } from "../src/fold-decomposition-lookup.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

// #4747: with rows interleaved by seq (A1,B1,A2,B2 — the append shape of
// edits), incremental splice + index bookkeeping deleted the wrong element —
// one id's latest row lost, the other duplicated. Dedup must be
// order-independent: keep the max-seq row per id, sort once at the end.

function msg(id: string, role: string, text: string): CoreMessage {
    return { id, role, contentType: "text", text } as CoreMessage;
}

function sessionWithAnchors(ids: string[]): Session {
    const foldAnchors: Record<string, unknown> = {};
    for (const id of ids) foldAnchors[id] = { n: id, r: "assistant", c: "text", b: 10 };
    return { state: { blocks: [] }, metadata: { foldAnchors } } as unknown as Session;
}

const wireIds = new Set<string>();

describe("resolveStoredDecompositions interleaved edits (#4747)", () => {
    test("interleaved double edits keep both ids, each exactly once, latest wins", () => {
        const rows: StoredRow[] = [
            { seq: 1, msgId: "a", content: JSON.stringify(msg("a", "assistant", "A-OLD")) },
            { seq: 2, msgId: "b", content: JSON.stringify(msg("b", "assistant", "B-OLD")) },
            { seq: 3, msgId: "a", content: JSON.stringify(msg("a", "assistant", "A-NEW")) },
            { seq: 4, msgId: "b", content: JSON.stringify(msg("b", "assistant", "B-NEW")) },
        ];
        const source = { rows: () => rows };
        const out = resolveStoredDecompositions(sessionWithAnchors(["a", "b"]), "s1", wireIds, source);
        assert.ok(out !== undefined);
        assert.deepEqual(out!.map((m) => m.id), ["a", "b"], "both ids survive, sorted by surviving seq");
        assert.equal(out![0].text, "A-NEW", "latest version of a kept");
        assert.equal(out![1].text, "B-NEW", "latest version of b kept, no stale duplicate");
    });

    test("three interleaved edit rounds stay correct", () => {
        const rows: StoredRow[] = [
            { seq: 1, msgId: "a", content: JSON.stringify(msg("a", "assistant", "A1")) },
            { seq: 2, msgId: "b", content: JSON.stringify(msg("b", "assistant", "B1")) },
            { seq: 3, msgId: "a", content: JSON.stringify(msg("a", "assistant", "A2")) },
            { seq: 4, msgId: "b", content: JSON.stringify(msg("b", "assistant", "B2")) },
            { seq: 5, msgId: "a", content: JSON.stringify(msg("a", "assistant", "A3")) },
            { seq: 6, msgId: "b", content: JSON.stringify(msg("b", "assistant", "B3")) },
        ];
        const source = { rows: () => rows };
        const out = resolveStoredDecompositions(sessionWithAnchors(["a", "b"]), "s1", wireIds, source);
        assert.ok(out !== undefined);
        assert.deepEqual(out!.map((m) => m.id), ["a", "b"]);
        assert.equal(out![0].text, "A3");
        assert.equal(out![1].text, "B3");
    });

    test("out-of-order arrival still keeps max seq per id", () => {
        const rows: StoredRow[] = [
            { seq: 3, msgId: "a", content: JSON.stringify(msg("a", "assistant", "A-NEW")) },
            { seq: 1, msgId: "a", content: JSON.stringify(msg("a", "assistant", "A-OLD")) },
            { seq: 4, msgId: "b", content: JSON.stringify(msg("b", "assistant", "B-NEW")) },
            { seq: 2, msgId: "b", content: JSON.stringify(msg("b", "assistant", "B-OLD")) },
        ];
        const source = { rows: () => rows };
        const out = resolveStoredDecompositions(sessionWithAnchors(["a", "b"]), "s1", wireIds, source);
        assert.ok(out !== undefined);
        assert.deepEqual(out!.map((m) => m.id), ["a", "b"]);
        assert.equal(out![0].text, "A-NEW");
        assert.equal(out![1].text, "B-NEW");
    });
});
