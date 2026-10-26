import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { applyCompactionArchive, markCompactionBoundary, preCompactionArchiveOf } from "../src/session.ts";
import { reconcileFoldCoverage } from "../src/fold-reconcile.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { executeProxyTool, type LoopCtx } from "../src/loop/core.ts";

function makeSession(): Session {
    return {
        id: `test-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        pendingRetrievals: [],
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
function runShortenedTurn(session: Session, tail: CoreMessage[], boundary: boolean, log: (level: string, msg: string) => void = noLog): string {
    const core = createCore();
    const config = defaultConfig(200000);
    const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
    if (boundary) markCompactionBoundary(session);
    const turn = core.processTurn({ messages: tail, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    applyCompactionArchive(session, activeBefore, new Set(tail.map((m) => m.id)), log);
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
    const logs: string[] = [];
    runShortenedTurn(session, tail, true, (_level, msg) => logs.push(msg));
    const liveIds = new Set(tail.map((m) => m.id));
    for (const rawId of Object.keys(session.state.messageRefs.byRaw)) {
        assert.ok(liveIds.has(rawId), `byRaw entry ${rawId} should have been pruned`);
    }
    assert.ok(Object.keys(session.state.messageRefs.byRaw).length < before, "byRaw shrank after the boundary");
    assert.ok(logs.some((msg) => msg.includes(`pruned ref maps to ${tail.length} live raw id(s)`)), "log reports the surviving ref count");
});

test("compaction archive: the boundary log reports the surviving raw-id count (#1513)", () => {
    const { session, tail } = sessionWithActiveBlock();
    const lines: string[] = [];
    // Inline mirror of runShortenedTurn with a capturing logger (the helper
    // applies the archive itself; a second apply finds no boundary left).
    const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
    markCompactionBoundary(session);
    const core = createCore();
    const config = defaultConfig(200000);
    const turn = core.processTurn({ messages: tail, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    applyCompactionArchive(session, activeBefore, new Set(tail.map((m) => m.id)), (_level, msg) => lines.push(msg));
    const boundary = lines.find((l) => l.includes("native compaction boundary"));
    assert.ok(boundary, `boundary log emitted: ${JSON.stringify(lines)}`);
    // prunedByRaw is a plain object — .length would render "undefined" (#1513)
    assert.match(boundary!, /pruned ref maps to \d+ live raw id\(s\)/);
    const live = Object.keys(session.state.messageRefs.byRaw).length;
    assert.ok(boundary!.includes(`pruned ref maps to ${live} live raw id(s)`), `count matches survivors (${live}): ${boundary}`);
    assert.ok(live > 0, "fixture keeps live refs so the count is meaningful");
});

test("compaction archive: decompress on an archived block gives an explicit reason, not silent/wrong content", () => {
    const { session, blockId, tail } = sessionWithActiveBlock();
    runShortenedTurn(session, tail, true);
    const ctx = { core: createCore(), config: defaultConfig(200000), messages: tail, session, log: (_msg: string) => {} };
    const out = resolveDecompress({ blockId }, ctx).text;
    assert.match(out, /decompress FAILED/);
    assert.match(out, /pre-compaction archive/);
    assert.match(out, /no longer reachable/);
});

test("compaction archive: acp_status surfaces the archive aggregated by default, per-block on demand (#3105)", () => {
    const { session, blockId, tail } = sessionWithActiveBlock();
    runShortenedTurn(session, tail, true);
    const ctx: LoopCtx = { core: createCore(), config: defaultConfig(200000), messages: tail, session, log: (_msg: string) => {} };
    const out = executeProxyTool("acp_status", {}, ctx).text;
    assert.match(out, /PRE-COMPACTION ARCHIVE — 1 block\(s\)/);
    assert.match(out, /decompress is unavailable/);
    assert.doesNotMatch(out, /^\s{2}b\S+ — /m, "default view aggregates by reason — no per-block lines (#3105)");
    assert.match(out, /1: content replaced by client native compaction summary/);
    assert.match(out, /acp_status\(\{ archiveDetail: true \}\)/, "default view points at the on-demand detail call");
    const detail = executeProxyTool("acp_status", { archiveDetail: true }, ctx).text;
    const perBlock = detail.match(/^\s{2}(b\S+) — .+$/gm) ?? [];
    assert.ok(perBlock.some((line) => line.trim().startsWith(`${blockId} —`)), `detail mode names the archived block (${blockId}) with its reason`);
});

// #3105 fixtures: archives seeded directly on the metadata (the render path
// under test reads preCompactionArchiveOf, which trusts that record).
function sessionWithArchive(entries: Record<string, { at: number; reason: string }>): Session {
    const session = makeSession();
    session.metadata.preCompactionArchive = entries;
    return session;
}

function archiveCtx(session: Session): LoopCtx {
    return { core: createCore(), config: defaultConfig(200000), messages: [], session, log: (_msg: string) => {} };
}

test("compaction archive: hundreds of same-reason blocks aggregate to a constant-size section (#3105)", () => {
    const reason = "covered substrate destroyed by unannounced client history rewrite (#2695)";
    const entries: Record<string, { at: number; reason: string }> = {};
    for (let i = 1; i <= 300; i++) entries[`b${i}`] = { at: i, reason };
    const out = executeProxyTool("acp_status", {}, archiveCtx(sessionWithArchive(entries))).text;
    assert.match(out, /PRE-COMPACTION ARCHIVE — 300 block\(s\)/);
    assert.equal((out.match(/unannounced client history rewrite/g) ?? []).length, 1, "reason stated once, not once per block");
    assert.match(out, /300: covered substrate destroyed by unannounced client history rewrite \(#2695\)/);
    assert.doesNotMatch(out, /^\s{2}b\d+ — /m, "no per-block lines in the default view");
    const section = out.split("PRE-COMPACTION ARCHIVE — ")[1]!.split("\n\n")[0]!;
    assert.equal(section.split("\n").length, 3, `section is header + reason-count + hint only, constant size for 300 blocks (got ${section.length} chars)`);
});

test("compaction archive: distinct reasons keep separate accurate counts (#3105)", () => {
    const entries: Record<string, { at: number; reason: string }> = {
        b1: { at: 1, reason: "content replaced by client native compaction summary" },
        b2: { at: 2, reason: "content replaced by client native compaction summary" },
        b3: { at: 3, reason: "content replaced by client native compaction summary" },
        b4: { at: 4, reason: "covered substrate destroyed by unannounced client history rewrite (#2695)" },
        b5: { at: 5, reason: "covered substrate destroyed by unannounced client history rewrite (#2695)" },
    };
    const out = executeProxyTool("acp_status", {}, archiveCtx(sessionWithArchive(entries))).text;
    assert.match(out, /PRE-COMPACTION ARCHIVE — 5 block\(s\)/);
    assert.match(out, /3: content replaced by client native compaction summary/);
    assert.match(out, /2: covered substrate destroyed by unannounced client history rewrite \(#2695\)/);
});

test("compaction archive: archiveDetail lists per-block ids capped at 50 with an omitted count (#3105)", () => {
    const reason = "covered substrate destroyed by unannounced client history rewrite (#2695)";
    const entries: Record<string, { at: number; reason: string }> = {};
    for (let i = 1; i <= 60; i++) entries[`b${i}`] = { at: i, reason };
    const detail = executeProxyTool("acp_status", { archiveDetail: true }, archiveCtx(sessionWithArchive(entries))).text;
    assert.match(detail, /PRE-COMPACTION ARCHIVE — 60 block\(s\)/);
    assert.equal(detail.match(/^\s{2}b\d+ — /gm)?.length, 50, "per-block listing capped at 50");
    assert.match(detail, /\(\+10 more; showing first 50 of 60\)/, "omitted count made explicit");
});

test("zombie reap (#2695): decompress on a reaped block names the reap reason, not \"not found\"", () => {
    // Consumer-path proof: the reap path removes the block from state.blocks,
    // so core.decompress() misses — the preCompactionArchive entry the reap
    // writes must surface as an honest failure. "[Block bN not found]" would
    // tell the model a ref it legitimately cited never existed.
    _setStoreForTest(new SessionStore({ enabled: false }));
    const session = makeSession();
    const ids = ["c1", "c2", "c3", "c4", "c5"];
    session.state.blocks.push({ active: true, blockId: "bReap", effectiveMessageIds: ids, createdAt: 1, compressedTokens: 4000, summary: "reapable summary".repeat(40) } as never);
    session.blockContents.set("bReap", { full: { text: "original covered payload", count: ids.length }, one: { text: "original covered payload", count: ids.length } });
    const cov = (m: CoreMessage[]) => reconcileFoldCoverage(session, m, { sessionId: session.id, mode: "repair" });
    const originals = ids.map((id, i) => ({ id, role: "user", contentType: "text", text: `covered original ${i} payload words` }) as CoreMessage);
    const filler = (tag: string) => Array.from({ length: 12 }, (_, i) => ({ id: `${tag}${i}`, role: "user", contentType: "text", text: `filler turn ${tag} index ${i} padding words` }) as CoreMessage);
    cov([...originals, ...filler("f0")]);
    cov(filler("h1"));
    cov(filler("h2"));
    cov(filler("h3"));
    assert.equal(session.state.blocks.length, 0, "three consecutive total-loss passes reaped the block (#2695)");
    assert.ok(session.blockContents.has("bReap"), "blockContents retained (#395 semantics)");
    const ctx = { core: createCore(), config: defaultConfig(200000), messages: [], session, log: (_msg: string) => {} };
    const out = resolveDecompress({ blockId: "bReap" }, ctx).text;
    assert.match(out, /decompress FAILED: block bReap is an archived block/);
    assert.match(out, /unannounced client history rewrite \(#2695\)/);
    assert.doesNotMatch(out, /not found/);
});
