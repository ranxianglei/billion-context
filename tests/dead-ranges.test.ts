import assert from "node:assert/strict";
import test from "node:test";
import type { CompressionBlock } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { deadSkipKeys, filterDeadRanges, parseStructuralEmptyVerdict, recordDeadRange } from "../src/dead-ranges.ts";

const LIVELOCK = "range m00016..m00036: Range m00016..m00036 contains no new compressible messages — every message in it is already covered by active block(s) b3. Nothing was compressed. To rewrite or merge those blocks, reference them by block ID (b3..b3); otherwise run acp_st";
const LIVELOCK_MULTI = "Range m00010..m00242 contains no new compressible messages — every message in it is already covered by active block(s) b2, b5. Nothing was compressed.";
const UNNAMED = "Range m00001..m00099 contains no compressible messages — all are already covered by active blocks or protected.";

test("parseStructuralEmptyVerdict recognizes both structural wordings and names the covering blocks", () => {
    assert.deepEqual(parseStructuralEmptyVerdict(LIVELOCK), ["b3"]);
    assert.deepEqual(parseStructuralEmptyVerdict(LIVELOCK_MULTI), ["b2", "b5"]);
    assert.deepEqual(parseStructuralEmptyVerdict(UNNAMED), []);
});

test("parseStructuralEmptyVerdict rejects non-structural verdicts (they stay retryable)", () => {
    assert.equal(parseStructuralEmptyVerdict("Range m00001..m00005 is below the minimum compressible range"), null);
    assert.equal(parseStructuralEmptyVerdict("Range intersects the protected recent zone; relax first"), null);
    assert.equal(parseStructuralEmptyVerdict("unknown ref m99999"), null);
    assert.equal(parseStructuralEmptyVerdict("summary length 12 below minSummaryLength 64"), null);
    assert.equal(parseStructuralEmptyVerdict(""), null);
});

test("parseStructuralEmptyVerdict survives kernel truncation of the name list", () => {
    const truncated = "Range m00001..m00900 contains no new compressible messages — every message in it is already covered by active block(s) b2, b5,";
    assert.deepEqual(parseStructuralEmptyVerdict(truncated), ["b2", "b5"]);
});

const block = (id: string): CompressionBlock => ({ blockId: id, runId: "r0", tier: 1, summary: "", directMessageIds: [], effectiveMessageIds: [], directBlockIds: [], compressedTokens: 0, createdAt: Date.now(), survivedCount: 0, generation: "young", active: true });

function makeSession(blockIds: string[]): Session {
    return {
        id: "dead-ranges-unit", meta: {}, metadata: {},
        state: { blocks: blockIds.map(block), messageRefs: { byRaw: {}, byRef: {} }, nudge: {}, stats: {}, nextBlockId: blockIds.length + 1 },
        createdAt: Date.now(), lastSeen: Date.now(), blockContents: new Map(), inFlight: 0, persisted: false, pendingRetrievals: [],
    } as unknown as Session;
}

test("recorded dead ranges persist in deadSkipKeys until a block lifecycle change", () => {
    const session = makeSession(["b1", "b2", "b3"]);
    recordDeadRange(session, "m00016", "m00036", ["b3"]);
    recordDeadRange(session, "m00001", "m00005", []);
    assert.deepEqual([...deadSkipKeys(session)].sort(), ["m00001:m00005", "m00016:m00036"]);
    // Append-only growth never invalidates: only block lifecycle does.
    session.state.blocks.push(block("b9"));
    assert.ok(deadSkipKeys(session).has("m00016:m00036"), "a NEW unrelated block must not wake entries");
    // A named covering block dying wakes its entry (coverage left the span).
    session.state.blocks.find((b) => b.blockId === "b3")!.active = false;
    const after = deadSkipKeys(session);
    assert.ok(!after.has("m00016:m00036"), "entry must die when a covering block goes inactive");
    // Subsumption: ANY recorded-active block dying wakes every entry conservatively.
    assert.ok(!after.has("m00001:m00005"), "snapshot subsumption wakes all entries on any block death");
});

test("re-recording upserts and the cap evicts oldest first", () => {
    const session = makeSession(["b1"]);
    recordDeadRange(session, "m00016", "m00036", ["b1"]);
    recordDeadRange(session, "m00016", "m00036", ["b1", "b2"]);
    const store = session.metadata!.preflightDeadRanges as Array<{ blocks: string[] }>;
    assert.equal(store.length, 1, "same key must upsert, not duplicate");
    assert.deepEqual(store[0].blocks, ["b1", "b2"], "re-record refreshes the diagnostics");
    for (let i = 0; i < 70; i++) recordDeadRange(session, `m${String(i).padStart(5, "0")}`, `m${String(i + 1).padStart(5, "0")}`, []);
    const capped = session.metadata!.preflightDeadRanges as Array<{ key: string }>;
    assert.equal(capped.length, 64, "store must stay bounded");
    assert.ok(!capped.some((e) => e.key === "m00000:m00001"), "oldest entry evicted");
    assert.ok(capped.some((e) => e.key === "m00069:m00070"), "newest entry kept");
});

test("filterDeadRanges drops exact keys only — wider containing ranges keep their live members", () => {
    const session = makeSession(["b1"]);
    recordDeadRange(session, "m00016", "m00036", ["b1"]);
    const out = filterDeadRanges(session, [
        { startRef: "m00016", endRef: "m00036" },
        { startRef: "m00001", endRef: "m00040" },
        { startRef: "m00020", endRef: "m00030" },
    ]);
    assert.deepEqual(out, [{ startRef: "m00001", endRef: "m00040" }, { startRef: "m00020", endRef: "m00030" }]);
});

test("the store survives a JSON persistence round-trip", () => {
    const session = makeSession(["b1", "b2"]);
    recordDeadRange(session, "m00016", "m00036", ["b2"]);
    const revived = JSON.parse(JSON.stringify({ metadata: session.metadata })) as { metadata: Record<string, unknown> };
    const restored: Session = makeSession(["b1", "b2"]);
    restored.metadata = revived.metadata;
    assert.deepEqual([...deadSkipKeys(restored)], ["m00016:m00036"]);
    restored.state.blocks.find((b) => b.blockId === "b2")!.active = false;
    assert.deepEqual([...deadSkipKeys(restored)], [], "revived entries invalidate like fresh ones");
});
