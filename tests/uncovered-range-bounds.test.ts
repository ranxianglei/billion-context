import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

function fixture(count: number) {
    const dir = mkdtempSync(join(tmpdir(), "uncovered-ranges-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    const plan = planIngest({
        id: "session", createdAt: 1, lastSeen: 2, meta: {}, stats: {}, metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
        blockContents: new Map(), lastMessages: Array.from({ length: count }, (_, i) => ({
            id: `message-${i + 1}`, role: "user", contentType: "text", text: `body ${i + 1}`,
        })), lastMessagesFolded: false,
    } as unknown as LegacySessionLike);
    store.ingestSession(plan, undefined, { completeLog: true });
    return { store, plan, close() {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    } };
}

test("over a thousand disjoint folded ranges remain queryable without SQLite expression limits", () => {
    const f = fixture(2003);
    try {
        const ranges: [number, number][] = Array.from({ length: 1001 }, (_, i) => [2 * i + 1, 2 * i + 1]);
        ranges.reverse();
        const before = JSON.stringify(ranges);
        const rows = f.store.uncoveredRows("session", ranges);
        assert.deepEqual(rows.map((row) => row.seq), Array.from({ length: 1002 }, (_, i) => 2 * i));
        assert.equal(JSON.parse(rows.at(-1)!.content).text, "body 2003");
        assert.equal(JSON.stringify(ranges), before);
        assert.equal(new Set(rows.map((row) => row.seq)).size, rows.length);
    } finally { f.close(); }
});

test("bounded range queries preserve inclusive overlap, empty and reversed-range behavior", () => {
    const f = fixture(12);
    try {
        const cases: [Array<[number, number]>, number[]][] = [
            [[], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
            [[[4, 8], [2, 5], [8, 9], [4, 8]], [0, 1, 10, 11]],
            [[[2, 2], [3, 3], [4, 4]], [0, 1, 5, 6, 7, 8, 9, 10, 11]],
            [[[7, 3]], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
            [[[-100, 100]], []],
            [[[-5, -1], [12, 15]], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
        ];
        for (const [ranges, expected] of cases) assert.deepEqual(f.store.uncoveredRows("session", ranges).map((row) => row.seq), expected);
        f.plan.messages = f.plan.messages.slice(1);
        f.store.ingestSession(f.plan, undefined, { completeLog: true });
        assert.deepEqual(f.store.uncoveredRows("session", [[3, 12]]).map((row) => row.seq), [1, 2]);
    } finally { f.close(); }
});
