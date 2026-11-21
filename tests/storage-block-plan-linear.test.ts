import test from "node:test";
import assert from "node:assert/strict";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";

class CountedMap<K, V> extends Map<K, V> {
    probes = 0;
    iterations = 0;
    override has(key: K): boolean { this.probes++; return super.has(key); }
    override [Symbol.iterator]() { this.iterations++; return super[Symbol.iterator](); }
}

for (const sparse of [false, true]) {
    test(`block planning completes views once (${sparse ? "sparse" : "complete"})`, () => {
        const count = 256;
        const views = new CountedMap<string, { one: null; full: { text: string; count: number } }>();
        const source: LegacySessionLike = {
            id: "linear", createdAt: 1000, lastSeen: 2000, meta: {}, stats: {}, metadata: {},
            state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, nextBlockId: 257, nextRunId: 2 },
            blockContents: views, lastMessages: [], lastMessagesFolded: false,
        };
        for (let i = 0; i < count; i++) {
            source.state.blocks.push({ blockId: `b${i}`, runId: "r1", tier: 1, summary: `fallback ${i}`,
                directMessageIds: [], effectiveMessageIds: [], directBlockIds: [], compressedTokens: 2,
                createdAt: 1000, survivedCount: 1, generation: "young", active: i % 2 === 0 });
            if (!sparse || i % 2 === 0) views.set(`b${i}`, { one: null, full: { text: `exact λ\u0000 ${i}`, count: 1 } });
        }
        const before = [...views];
        const expected = planIngest({ ...source, blockContents: new Map(before) });
        views.probes = 0;
        views.iterations = 0;
        const actual = planIngest(source);
        assert.deepEqual(actual, expected);
        assert.ok(views.probes <= count * 2, `quadratic membership probes: ${views.probes}`);
        assert.ok(views.iterations <= 3, `repeated sparse-map copies: ${views.iterations}`);
        assert.deepEqual([...views], before, "planning must not fill or mutate the caller map");
        assert.equal(actual.blocks.length, count);
        assert.equal(JSON.parse(actual.blocks[1].summary).text, sparse ? "fallback 1" : "exact λ\u0000 1");
    });
}
