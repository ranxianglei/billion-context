import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { applyCompactionArchive, markCompactionBoundary, preCompactionArchiveOf } from "../src/session.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { executeProxyTool, type LoopCtx } from "../src/loop/core.ts";

function makeSession(): Session {
    return {
        id: `test-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

const noLog = (_level: string, _msg: string): void => {};

// One active block over m00001-m00007; tail = m00008-m00012 (omp's post-compact resend).
function sessionWithActiveBlock(): { session: Session; blockId: string; tail: CoreMessage[] } {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({ id: `h_distinct${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `message ${i} ${"x".repeat(2000)}` });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00007", summary: "compressed early history that is long enough to pass the min summary length check" }],
        messages: turn.messages,
        state: turn.state,
        config,
    });
    session.state = res.state;
    const block = session.state.blocks[session.state.blocks.length - 1];
    const tail: CoreMessage[] = [];
    for (let i = 7; i < 12; i++) {
        tail.push({ id: `h_distinct${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `message ${i} ${"x".repeat(2000)}` });
    }
    return { session, blockId: block.blockId, tail };
}

// Mirrors server.ts prepareAnthropic: capture active ids → shortened-history
// turn (syncBlocks deactivates) → applyCompactionArchive.
function runShortenedTurn(session: Session, tail: CoreMessage[], boundary: boolean): string {
    const core = createCore();
    const config = defaultConfig(200000);
    const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
    if (boundary) markCompactionBoundary(session);
    const turn = core.processTurn({ messages: tail, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    applyCompactionArchive(session, activeBefore, new Set(tail.map((m) => m.id)), noLog);
    return [...activeBefore].join(",");
}

test("compaction archive: shortened-history resend degrades the block into an auditable archive", () => {
    const { session, blockId, tail } = sessionWithActiveBlock();
    runShortenedTurn(session, tail, true);
    const block = session.state.blocks.find((b) => b.blockId === blockId);
    assert.equal(block?.active, false, "syncBlocks deactivates the block whose raw ids left the history");
    const archive = preCompactionArchiveOf(session);
    assert.ok(archive[blockId] !== undefined, "block is recorded in the pre-compaction archive (not silently deactivated)");
    assert.match(archive[blockId]!.reason, /native compaction/);
    const boundary = session.metadata.compactionBoundary as Record<string, unknown>;
    assert.equal(boundary.pending, false, "boundary is consumed");
    assert.ok(Array.isArray(boundary.archivedBlocks) && (boundary.archivedBlocks as string[]).includes(blockId), "archivedBlocks records the generation");
});

test("compaction archive: WITHOUT the boundary the block is silently deactivated (old behavior preserved)", () => {
    const { session, blockId, tail } = sessionWithActiveBlock();
    runShortenedTurn(session, tail, false);
    const block = session.state.blocks.find((b) => b.blockId === blockId);
    assert.equal(block?.active, false, "still deactivated by syncBlocks");
    const archive = preCompactionArchiveOf(session);
    assert.equal(archive[blockId], undefined, "no archive entry without a marked boundary");
});

test("compaction archive: byRaw/byRef are pruned to live ids (stops the additive leak)", () => {
    const { session, tail } = sessionWithActiveBlock();
    const before = Object.keys(session.state.messageRefs.byRaw).length;
    runShortenedTurn(session, tail, true);
    const liveIds = new Set(tail.map((m) => m.id));
    for (const rawId of Object.keys(session.state.messageRefs.byRaw)) {
        assert.ok(liveIds.has(rawId), `byRaw entry ${rawId} should have been pruned`);
    }
    assert.ok(Object.keys(session.state.messageRefs.byRaw).length < before, "byRaw shrank after the boundary");
});

test("compaction archive: decompress on an archived block gives an explicit reason, not silent/wrong content", () => {
    const { session, blockId, tail } = sessionWithActiveBlock();
    runShortenedTurn(session, tail, true);
    const ctx = { core: createCore(), config: defaultConfig(200000), messages: tail, session, log: (_msg: string) => {} };
    const out = resolveDecompress({ blockId }, ctx);
    assert.match(out, /decompress FAILED/);
    assert.match(out, /pre-compaction archive/);
    assert.match(out, /no longer reachable/);
});

test("compaction archive: acp_status surfaces the archive instead of listing it as active", () => {
    const { session, blockId, tail } = sessionWithActiveBlock();
    runShortenedTurn(session, tail, true);
    const ctx: LoopCtx = { core: createCore(), config: defaultConfig(200000), messages: tail, session, log: (_msg: string) => {} };
    const out = executeProxyTool("acp_status", {}, ctx);
    assert.match(out, /PRE-COMPACTION ARCHIVE/);
    assert.match(out, /decompress is unavailable/);
    assert.ok(out.includes(blockId), "acp_status names the archived block");
});
