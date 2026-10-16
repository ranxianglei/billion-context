import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "acp-kernel";
import type { CompressionBlock, CoreMessage } from "acp-kernel";
import { buildTrajectory, capText, TRAJ_RECORD_CAP, TRAJ_TOTAL_CAP, TRAJ_RECORDS_CAP } from "../src/web/sessions-data.ts";
import { SYSTEM_SURFACE_SUFFIX } from "../src/system-surface.ts";
import type { SystemSurfaceRecord } from "../src/system-surface.ts";
import type { Session } from "../src/session.ts";

// #3201: the web UI trajectory view — a protocol-neutral ledger of what the
// last outbound context actually contained (messages + fold markers + system
// surface). buildTrajectory is pure over the in-memory Session, so these tests
// pin its ordering, anchoring and capping rules without any disk or server.

function makeSession(partial?: Partial<Session>): Session {
    return {
        id: "traj-1",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
        ...partial,
    };
}

function mkBlock(over: Partial<CompressionBlock> & Pick<CompressionBlock, "blockId">): CompressionBlock {
    return {
        runId: "r1",
        tier: 1,
        summary: "a summary",
        directMessageIds: [],
        effectiveMessageIds: [],
        directBlockIds: [],
        compressedTokens: 100,
        createdAt: 1,
        survivedCount: 0,
        generation: "young",
        active: true,
        ...over,
    };
}

test("buildTrajectory returns undefined without lastMessages", () => {
    assert.equal(buildTrajectory(makeSession()), undefined);
    assert.equal(buildTrajectory(makeSession({ lastMessages: [] })), undefined);
});

test("buildTrajectory maps kinds, counts turns, resolves refs", () => {
    const msgs: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "hello" },
        { id: "a1", role: "assistant", contentType: "reasoning", text: "thinking" },
        { id: "a2", role: "assistant", contentType: "tool-call", text: "{\"x\":1}", toolName: "bash", toolCallId: "tc1" },
        { id: "t1", role: "tool", contentType: "tool-result", text: "ok" },
        { id: "u2", role: "user", contentType: "text", text: "again" },
    ];
    const s = makeSession({ lastMessages: msgs });
    s.state.messageRefs.byRaw = { u1: "m00001", a1: "m00002", a2: "m00003", t1: "m00004", u2: "m00005" };
    const traj = buildTrajectory(s)!;
    assert.deepEqual(traj.records.map((r) => r.kind), ["user", "reasoning", "tool-call", "tool-result", "user"]);
    assert.equal(traj.turns, 2);
    assert.deepEqual(traj.records.map((r) => r.turn), [1, 1, 1, 1, 2]);
    assert.deepEqual(traj.records.map((r) => r.ref), ["m00001", "m00002", "m00003", "m00004", "m00005"]);
    assert.deepEqual(traj.records.map((r) => r.n), [1, 2, 3, 4, 5]);
    assert.equal(traj.records[2].toolName, "bash");
    assert.equal(traj.records[2].toolCallId, "tc1");
    assert.equal(traj.truncatedTotal, false);
});

test("buildTrajectory carries thinkingTokens and token estimates", () => {
    const s = makeSession({
        lastMessages: [
            { id: "a1", role: "assistant", contentType: "reasoning", text: "abc", thinkingTokens: 42 },
            { id: "e1", role: "user", contentType: "text" },
        ],
    });
    const traj = buildTrajectory(s)!;
    assert.equal(traj.records[0].thinkingTokens, 42);
    const est = traj.records[0].tokens;
    assert.equal(typeof est, "number");
    assert.ok((est ?? 0) > 0);
    assert.ok(!("tokens" in traj.records[1]), "empty text must not carry a token estimate");
});

test("fold markers insert after the anchor record; unanchored blocks are listed", () => {
    const msgs: CoreMessage[] = [
        { id: "m1", role: "user", contentType: "text", text: "one" },
        { id: "m2", role: "assistant", contentType: "text", text: "two" },
        { id: "m3", role: "user", contentType: "text", text: "three" },
    ];
    const s = makeSession({ lastMessages: msgs });
    s.state.messageRefs.byRaw = { m1: "m00001", m2: "m00002", m3: "m00003" };
    // Two blocks end at the same ref (tiers ascend away from the anchor); one
    // ends at a ref that is not visible (folded snapshot) and must stay honest;
    // one inactive / one without endRef must be ignored entirely.
    s.state.blocks.push(
        mkBlock({ blockId: "bA", tier: 1, endRef: "m00002", topic: "topic A" }),
        mkBlock({ blockId: "bB", tier: 2, endRef: "m00002" }),
        mkBlock({ blockId: "bC", endRef: "m99999" }),
        mkBlock({ blockId: "bD", active: false, endRef: "m00002" }),
        mkBlock({ blockId: "bE" }),
    );
    const traj = buildTrajectory(s)!;
    assert.deepEqual(traj.records.map((r) => r.kind), ["user", "assistant", "compacted", "compacted", "user"]);
    const folded = traj.records.filter((r) => r.kind === "compacted");
    assert.deepEqual(folded.map((r) => r.blockId), ["bA", "bB"], "same-anchor blocks order by tier");
    assert.equal(folded[0].turn, 1, "fold marker inherits the anchor's turn");
    assert.equal(folded[0].topic, "topic A");
    assert.equal(folded[0].compressedTokens, 100);
    assert.deepEqual(traj.unanchoredBlocks, ["bC"]);
    assert.deepEqual(traj.records.map((r) => r.n), [1, 2, 3, 4, 5], "n renumbered after inserts");
});

test("capText enforces per-record and total budgets", () => {
    const budget = { totalChars: 0, truncatedTotal: false };
    const big = "x".repeat(TRAJ_RECORD_CAP + 5_000);
    const r1 = capText(big, budget);
    assert.equal(r1.truncated, true);
    assert.equal(r1.text.length, TRAJ_RECORD_CAP);
    assert.equal(budget.totalChars, TRAJ_RECORD_CAP);

    const near = { totalChars: TRAJ_TOTAL_CAP - 100, truncatedTotal: false };
    const r2 = capText("y".repeat(500), near);
    assert.equal(r2.text.length, 100, "only the remaining total room is allowed");
    assert.equal(r2.truncated, true);

    const r3 = capText("z".repeat(10), { totalChars: TRAJ_TOTAL_CAP, truncatedTotal: false });
    assert.equal(r3.text.length, 0);
    assert.equal(r3.truncated, true);

    const ok = { totalChars: 0, truncatedTotal: false };
    const r4 = capText("hello", ok);
    assert.equal(r4.text, "hello");
    assert.equal(r4.truncated, false);
    assert.equal(ok.totalChars, 5);
});

test("buildTrajectory caps the record count", () => {
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < TRAJ_RECORDS_CAP + 10; i++) {
        msgs.push({ id: `m${i}`, role: "user", contentType: "text", text: "x" });
    }
    const traj = buildTrajectory(makeSession({ lastMessages: msgs }))!;
    assert.equal(traj.records.length, TRAJ_RECORDS_CAP);
    assert.equal(traj.recordsCapped, true);
});

test("system surface and prompt tokens map onto trajectory.system", () => {
    const surface: SystemSurfaceRecord = {
        v: 1, hash: "h", systemText: "sys", systemTruncated: false,
        toolsJson: "[{\"name\":\"bash\"}]", toolsTruncated: false, toolNames: ["bash"], updatedAt: 123,
    };
    const withSurface = makeSession({
        lastMessages: [{ id: "u1", role: "user", contentType: "text", text: "hi" }],
        systemSurface: surface,
        metadata: { systemPromptTokens: 777 },
    });
    const traj = buildTrajectory(withSurface)!;
    assert.equal(traj.system?.text, "sys");
    assert.equal(traj.system?.tokens, 777);
    assert.equal(traj.system?.updatedAt, 123);
    assert.deepEqual(traj.system?.toolNames, ["bash"]);

    const bare = buildTrajectory(makeSession({ lastMessages: [{ id: "u1", role: "user", contentType: "text", text: "hi" }] }))!;
    assert.ok(!("system" in bare), "no sidecar → no system section");
});

test("folded snapshot flag propagates", () => {
    const traj = buildTrajectory(makeSession({
        lastMessages: [{ id: "u1", role: "user", contentType: "text", text: "hi" }],
        lastMessagesFolded: true,
    }))!;
    assert.equal(traj.folded, true);
});

test("sidecar suffix is stable for walkers to exclude", () => {
    assert.equal(SYSTEM_SURFACE_SUFFIX, ".system-surface.json");
});
