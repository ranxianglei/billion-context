import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/session.ts";
import type { CompressionBlock } from "acp-kernel";
import {
    applyCompactionArchive,
    historyGenerationsOf,
    markNativeCompactionBoundary,
    markCompactionBoundary,
    reconcileNativeCompactionBoundary,
} from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { executeRetrieve, adoptContentStore, storeEffectiveCcr } from "../src/store.ts";
import { resolveDecompress, executeSearchContext } from "../src/decompress-shared.ts";
import { codexCheckpointRecord, isNewCodexBoundary, parseCodexCheckpointSignal } from "../src/codex-checkpoint.ts";
import { historyNavNote, mergeGenerationSummaries, metaOf, type HistoryGeneration } from "../src/history-generations.ts";

const noLog = (_level: string, _msg: string): void => {};

function makeSession(id = `hg-${Math.random().toString(36).slice(2)}`): Session {
    return {
        id,
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

function enabledConfig(): Config {
    const config = defaultConfig(200000) as Config;
    return { ...config, ccr: { ...config.ccr, enabled: true } } as Config;
}

/** One active compressed block over m00001–m00007 with verbatim block content
 *  cached exactly like the server caches it at compress time. */
function sessionWithBlock(session = makeSession()): { session: Session; blockId: string; messages: CoreMessage[] } {
    const core = createCore();
    const config = enabledConfig();
    storeEffectiveCcr(session, config.ccr);
    const messages: CoreMessage[] = [];
    for (let i = 0; i < 12; i++) {
        messages.push({ id: `h_hist${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `history message ${i} ${"distinct".repeat(300)}` });
    }
    const turn = core.processTurn({ messages, state: session.state, config, tokenCount: 9999, renderTags: "text-only", contentStore: session.contentStore });
    session.state = turn.state;
    if (turn.contentStore) adoptContentStore(session, turn.contentStore);
    const firstRef = turn.state.messageRefs.byRaw[messages[0].id];
    const seventhRef = turn.state.messageRefs.byRaw[messages[6].id];
    const res = core.applyCompression({
        ranges: [{ startRef: firstRef, endRef: seventhRef, summary: "compressed early history that is long enough to pass the min summary length check" }],
        messages: turn.messages,
        state: turn.state,
        config,
    });
    session.state = res.state;
    const block = session.state.blocks[session.state.blocks.length - 1];
    // A stored original for m00001, exactly like the host's CCR capture.
    const original = messages[0].text ?? "";
    const hash = createHash("sha256").update(original).digest("hex");
    adoptContentStore(session, {
        version: 1,
        byHash: { [hash]: original },
        byRef: { m00001: { hash, rawId: messages[0].id, kind: "message", tokens: 500, chars: original.length, head: original.slice(0, 64) } },
    });
    session.blockContents.set(block.blockId, {
        one: { text: "early history verbatim (one-line)", count: 7 },
        full: { text: messages.slice(0, 7).map((m) => m.text).join("\n\n"), count: 7 },
    });
    return { session, blockId: block.blockId, messages };
}

/** Whole-block restores above 10k chars become a file pointer; read it so the
 *  assertion covers the real bytes either way. */
function textOf(result: { text: string }): string {
    const match = /written to: (\S+)/.exec(result.text);
    return match ? readFileSync(match[1], "utf8") : result.text;
}

function ctxFor(session: Session, messages: CoreMessage[]) {
    const core = createCore();
    return { core, config: enabledConfig(), messages, compressMessages: messages, session, log: () => {} };
}

function closeByCodexCheckpoint(session: Session, messages: CoreMessage[], checkpointId: string, seq = 1): boolean {
    const signal = parseCodexCheckpointSignal({
        "x-bili-codex-checkpoint": checkpointId,
        "x-bili-codex-checkpoint-seq": String(seq),
        "x-bili-codex-checkpoint-state": "fresh",
        "x-bili-codex-checkpoint-covered": "7",
    });
    assert.ok(signal, "signal parses");
    assert.ok(isNewCodexBoundary(null, signal!), "first sight is a boundary");
    markNativeCompactionBoundary(session);
    return reconcileNativeCompactionBoundary(session, {
        messages,
        cause: "codex-cloud-compaction",
        source: "dsh-codex-subscription",
        checkpointId,
    });
}

test("codex checkpoint boundary closes a read-only generation and keeps old refs restorable", () => {
    const { session, blockId, messages } = sessionWithBlock();
    const maxBlockBefore = Number(blockId.slice(1));
    assert.equal(closeByCodexCheckpoint(session, messages, "cp-gen-1"), true);

    const generations = historyGenerationsOf(session);
    assert.equal(generations.length, 1);
    const gen = generations[0];
    assert.equal(gen.cause, "codex-cloud-compaction");
    assert.equal(gen.checkpointId, "cp-gen-1");
    assert.deepEqual(gen.blockIds, [blockId]);
    assert.ok(gen.maxRefIndex >= 7);
    assert.ok(Object.keys(gen.blockContents).includes(blockId), "verbatim block content is archived");

    // Live state is fresh, but neither ids nor refs may restart.
    assert.equal(session.state.blocks.length, 0);
    assert.ok(session.state.nextBlockId > maxBlockBefore, "block ids never re-issue an archived bN");

    const ctx = ctxFor(session, messages);
    const whole = resolveDecompress({ blockId, full: true }, ctx);
    assert.match(whole.text, /read-only from history generation 1/);
    assert.match(textOf(whole), /history message 0/);
    assert.match(textOf(whole), /history message 6/);

    const ranged = resolveDecompress({ blockId, startId: "m00002", endId: "m00003" }, ctx);
    assert.match(ranged.text, /read-only/);
    assert.match(ranged.text, /m00002/);

    // A ref that left the live store still resolves from the frozen slice.
    const retrieved = executeRetrieve({ ref: "m00001" }, session);
    assert.equal(retrieved.outcome, "success");
    assert.match(retrieved.text, /history generation 1/);
    assert.match(retrieved.text, /history message 0/);

    // Cross-generation search sees the archived block without touching live state.
    const search = executeSearchContext({ query: "compressed early history" }, ctx.core, session.state, undefined, undefined, undefined, generations);
    assert.match(search.text, /generation 1/);
    assert.match(search.text, new RegExp(blockId));
    assert.equal(session.state.blocks.length, 0, "searching history never revives live blocks");
});

test("a compaction landing mid tool-call keeps the call and its output restorable", () => {
    const { session, messages } = sessionWithBlock();
    const call = {
        id: "h_tool_call_1",
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "shell", input: { command: "cat legacy.txt" } }],
    };
    const result = {
        id: "h_tool_result_1",
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call_1", toolName: "shell", output: { type: "text", value: "TOOL-OUTPUT-VERBATIM-42" } }],
    };
    const withTool = [...messages, call, result] as unknown as CoreMessage[];
    const turn = createCore().processTurn({ messages: withTool, state: session.state, config: enabledConfig(), tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const callRef = turn.state.messageRefs.byRaw[call.id];
    const resultRef = turn.state.messageRefs.byRaw[result.id];
    assert.ok(callRef && resultRef, "the tool pair has refs before the boundary");

    assert.equal(closeByCodexCheckpoint(session, withTool, "cp-mid-tool"), true);
    const gen = historyGenerationsOf(session)[0];
    assert.equal(gen.messageRefs.byRaw[call.id], callRef, "call ref survives the boundary unchanged");
    assert.equal(gen.messageRefs.byRaw[result.id], resultRef, "result ref survives the boundary unchanged");

    const out = resolveDecompress({ blockId: gen.blockIds[0], startId: callRef, endId: resultRef }, ctxFor(session, messages));
    const body = textOf(out);
    assert.match(body, /call_1/, "tool-call id is preserved");
    assert.match(body, /cat legacy\.txt/, "tool-call input is preserved");
    assert.match(body, /TOOL-OUTPUT-VERBATIM-42/, "tool output is preserved verbatim");
});

test("consecutive remote compactions archive each generation and keep every block id recoverable", () => {
    const { session, blockId: firstBlock, messages } = sessionWithBlock();
    assert.equal(closeByCodexCheckpoint(session, messages, "cp-a", 1), true);

    const second = sessionWithBlock(session);
    assert.notEqual(second.blockId, firstBlock, "second generation gets a fresh block id");
    assert.equal(closeByCodexCheckpoint(session, second.messages, "cp-b", 2), true);

    const generations = historyGenerationsOf(session);
    assert.deepEqual(generations.map((g) => g.checkpointId), ["cp-a", "cp-b"]);
    assert.deepEqual(generations.map((g) => g.generation), [1, 2]);

    const ctx = ctxFor(session, second.messages);
    assert.match(resolveDecompress({ blockId: firstBlock }, ctx).text, /generation 1/);
    assert.match(resolveDecompress({ blockId: second.blockId }, ctx).text, /generation 2/);
    assert.match(historyNavNote(session) ?? "", /Closed history generations — 2 generation\(s\)/);
});

test("generations survive a restart: old refs and blocks restore from the sidecar alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-hg-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        const { session, blockId, messages } = sessionWithBlock();
        assert.equal(closeByCodexCheckpoint(session, messages, "cp-restart"), true);
        store.scheduleSave(session);
        store.flushSync(session);

        const restored = store.loadSync(session.id);
        assert.ok(restored, "session reloads from disk");
        // Simulate the crash window: the record exists, the index was never written.
        delete restored!.metadata.historyGenerations;
        const generations = historyGenerationsOf(restored!);
        assert.equal(generations.length, 1, "index is recovered from the sidecar");
        const reopened = store.loadHistoryGenerations(restored!);
        assert.ok(reopened && reopened.generations[0].blocks.some((b) => b.blockId === blockId));

        const ctx = ctxFor(restored!, messages);
        const whole = resolveDecompress({ blockId, full: true }, ctx);
        assert.match(textOf(whole), /history message 0/);
        assert.match(whole.text, /generation 1/);
        assert.equal(executeRetrieve({ ref: "m00001" }, restored!).outcome, "success");
    } finally {
        _setStoreForTest(new SessionStore({ dir: process.env.BILI_SESSIONS_DIR, enabled: true, debounceMs: 0 }));
        rmSync(dir, { recursive: true, force: true });
    }
});

test("announced compaction boundary archives live blocks without duplicating a generation", () => {
    const { session, blockId, messages } = sessionWithBlock();
    session.lastMessages = messages;
    markCompactionBoundary(session, { cause: "client-native-compaction" });
    // Mirrors the server: capture active ids -> shortened-history turn (syncBlocks
    // deactivates the covered block) -> applyCompactionArchive consumes the boundary.
    const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
    const tail = messages.slice(7);
    const turn = createCore().processTurn({ messages: tail, state: session.state, config: enabledConfig(), tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    applyCompactionArchive(session, activeBefore, new Set(tail.map((m) => m.id)), noLog);
    const generations = historyGenerationsOf(session);
    assert.equal(generations.length, 1);
    assert.ok(generations[0].blockIds.includes(blockId));
    assert.ok(!session.state.blocks.some((b) => b.blockId === blockId && b.active));
});

test("checkpoint signal dedupe: same id+seq is not a new boundary, higher seq is", () => {
    const first = parseCodexCheckpointSignal({ "x-bili-codex-checkpoint": "cp-1", "x-bili-codex-checkpoint-seq": "1", "x-bili-codex-checkpoint-state": "fresh" });
    assert.ok(first);
    const record = codexCheckpointRecord(first!, 1000);
    assert.equal(isNewCodexBoundary(record, first!), false, "retry of the same checkpoint never rebases twice");
    const next = parseCodexCheckpointSignal({ "x-bili-codex-checkpoint": "cp-1", "x-bili-codex-checkpoint-seq": "2", "x-bili-codex-checkpoint-state": "fresh" });
    assert.equal(isNewCodexBoundary(record, next!), true, "consecutive checkpoint on the same id advances");
    const other = parseCodexCheckpointSignal({ "x-bili-codex-checkpoint": "cp-2", "x-bili-codex-checkpoint-seq": "1", "x-bili-codex-checkpoint-state": "fresh" });
    assert.equal(isNewCodexBoundary(record, other!), true);
    assert.equal(isNewCodexBoundary(record, { ...first!, state: "reuse" }), false, "reuse of the same checkpoint never rebases");
    const recovered = parseCodexCheckpointSignal({ "x-bili-codex-checkpoint": "cp-3", "x-bili-codex-checkpoint-seq": "1", "x-bili-codex-checkpoint-state": "reuse" });
    assert.equal(isNewCodexBoundary(record, recovered!), true, "a checkpoint first seen on reuse still closes its generation");
    assert.equal(parseCodexCheckpointSignal({ "x-bili-codex-checkpoint": "bad id", "x-bili-codex-checkpoint-seq": "1", "x-bili-codex-checkpoint-state": "fresh" }), null);
    assert.equal(parseCodexCheckpointSignal({ "x-bili-codex-checkpoint": "cp", "x-bili-codex-checkpoint-seq": "0", "x-bili-codex-checkpoint-state": "fresh" }), null);
});

test("a generation that cannot be persisted aborts the rebase, stays pending, and recovers on the next attempt", () => {
    const { session, blockId, messages } = sessionWithBlock();
    session.lastMessages = messages;
    const before = session.state.blocks.map((b) => b.blockId);
    const dir = mkdtempSync(join(tmpdir(), "bili-hg-fail-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    const originalSave = store.saveHistoryGenerations.bind(store);
    (store as unknown as { saveHistoryGenerations: () => boolean }).saveHistoryGenerations = () => false;
    _setStoreForTest(store);
    try {
        markNativeCompactionBoundary(session);
        const rebased = reconcileNativeCompactionBoundary(session, { messages, cause: "codex-cloud-compaction" });
        assert.equal(rebased, false, "an unpersisted generation must not reset the session");
        assert.deepEqual(session.state.blocks.map((b) => b.blockId), before, "live blocks stay untouched");
        assert.ok(session.state.blocks.some((b) => b.blockId === blockId && b.active), "the folded block is still active");
        const boundary = session.metadata.nativeCompactionBoundary as { archiveFailedAt?: number; pendingRebase?: boolean };
        assert.ok(boundary.archiveFailedAt, "the failure is recorded on the boundary");
        assert.equal(boundary.pendingRebase, true, "the boundary stays pending so the next request retries");

        // Persistence recovers: the next request's retry closes the generation and completes the rebase.
        store.saveHistoryGenerations = originalSave;
        const retried = reconcileNativeCompactionBoundary(session, { messages, cause: "codex-cloud-compaction" });
        assert.equal(retried, true, "recovery on the next attempt completes the rebase");
        assert.equal(historyGenerationsOf(session).length, 1, "the recovered attempt archives exactly one generation");
        assert.equal(session.state.blocks.length, 0, "live state resets only once the archive is durable");
    } finally {
        _setStoreForTest(new SessionStore({ dir: process.env.BILI_SESSIONS_DIR, enabled: true, debounceMs: 0 }));
        rmSync(dir, { recursive: true, force: true });
    }
});

function syntheticBlock(blockId: string, topic: string, summary: string): CompressionBlock {
    return {
        blockId, runId: "r1", tier: 1, topic, summary, directMessageIds: [], effectiveMessageIds: [],
        directBlockIds: [], compressedTokens: 10, createdAt: 1, survivedCount: 0, generation: "young", active: false,
    };
}

function syntheticGeneration(generation: number, blocks: CompressionBlock[]): HistoryGeneration {
    return {
        generation, id: `synthetic#g${generation}`, at: 1_700_000_000_000 + generation, cause: "codex-cloud-compaction",
        maxRefIndex: 4, firstRef: "m00001", lastRef: "m00004", messageCount: 4, blockCount: blocks.length,
        blockIds: blocks.map(b => b.blockId), tokensCompressed: 100,
        blocks, blockContents: {}, messageRefs: { byRaw: {}, byRef: {} }, messages: [],
    };
}

test("consecutive generations publish ONE consolidated summary, deduped by topic", () => {
    const session = makeSession();
    const generations = [
        syntheticGeneration(1, [syntheticBlock("b1", "alpha", "ALPHA-POINT-OLD"), syntheticBlock("b2", "gamma", "GAMMA-POINT")]),
        syntheticGeneration(2, [syntheticBlock("b3", "beta", "BETA-POINT-NEW"), syntheticBlock("b4", "alpha", "ALPHA-POINT-NEW")]),
    ];
    session.metadata.historyGenerations = generations.map(metaOf);
    const merged = mergeGenerationSummaries(generations);
    assert.ok(merged !== null, "two generations must merge into one summary");
    assert.ok(merged.includes("BETA-POINT-NEW"), "the newest generation's content is present");
    assert.ok(merged.includes("ALPHA-POINT-NEW"), "the newest summary wins for a repeated topic");
    assert.ok(!merged.includes("ALPHA-POINT-OLD"), "an older summary for the same topic is not repeated");
    assert.ok(merged.includes("GAMMA-POINT"), "topics only present in the older generation survive");
    const note = historyNavNote(session, generations);
    assert.ok(note !== null);
    assert.ok(note.includes("Consolidated summary of the closed history"), "the note carries the merged summary");
    assert.ok(note.indexOf("ALPHA-POINT-NEW") > note.indexOf("generation 1"), "the merged summary follows the generation index");
});
