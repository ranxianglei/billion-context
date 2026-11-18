import assert from "node:assert/strict";
import test from "node:test";
import {
    createContentStore, createCore, createInitialState, DEFAULT_CCR_CONFIG, defaultConfig, retrieveByRef, storeOriginal,
    type CoreMessage,
} from "acp-kernel";
import { openaiToCore } from "acp-kernel/wire";
import { adoptContentStore, executeRetrieve, storeEffectiveCcr } from "../src/store.ts";
import { createSession, isDroppedContentStore, lazyContentStore } from "../src/session.ts";

process.env.BILI_PERSIST = "0";

const original = "Compiler output: the deployment checks passed.\r\n".repeat(40);
const core = createCore();
const config = { ...defaultConfig(200_000), ccr: { ...DEFAULT_CCR_CONFIG, enabled: true, minToolTokens: 50 } };

function seeded() {
    const messages = openaiToCore({ messages: [
        { role: "user", content: "Run the deployment checks." },
        { role: "assistant", content: null, tool_calls: [{ id: "build", type: "function", function: { name: "bash", arguments: '{"command":"npm run check"}' } }] },
        { role: "tool", tool_call_id: "build", content: original },
    ] }).msgs;
    const turn = core.processTurn({ messages, state: createInitialState(), config, tokenCount: 600, renderTags: "none" });
    assert.equal(Object.keys(turn.contentStore.byRef).length, 1);
    return { messages, turn, ref: Object.keys(turn.contentStore.byRef)[0]! };
}

test("first adoption preserves a real kernel original and makes it retrievable", () => {
    const { turn, ref } = seeded();
    const session = createSession("adopt-first");
    storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
    adoptContentStore(session, turn.contentStore);
    assert.equal(session.contentStore, turn.contentStore);
    assert.equal(session.contentStoreDirty, true);
    assert.equal(session.stats.storedBytes, original.length);
    assert.ok(session.stats.storeBytesSaved > 0);
    assert.ok(executeRetrieve({ ref }, session).text.includes(original));
});

test("first empty adoption still installs its envelope without marking it dirty", () => {
    const session = createSession("adopt-first-empty");
    const empty = createContentStore();
    const stats = structuredClone(session.stats);
    adoptContentStore(session, empty);
    assert.equal(session.contentStore, empty);
    assert.equal(session.contentStoreDirty, undefined);
    assert.deepEqual(session.stats, stats);
});

for (const enabled of [true, false]) {
    for (const dirty of [true, false]) {
        test(`replayed no-growth kernel store keeps originals and accounting (CCR=${enabled}, dirty=${dirty})`, () => {
            const { messages, turn, ref } = seeded();
            const session = createSession(`adopt-replay-${enabled}-${dirty}`);
            adoptContentStore(session, turn.contentStore);
            session.contentStoreDirty = dirty;
            const stats = structuredClone(session.stats);
            const saved = JSON.stringify(session.contentStore);
            const replay = core.processTurn({ messages, state: turn.state,
                config: { ...config, ccr: { ...config.ccr, enabled } }, tokenCount: 600,
                contentStore: session.contentStore, renderTags: "none" });
            assert.equal(replay.contentStore, session.contentStore);
            adoptContentStore(session, replay.contentStore);
            assert.equal(JSON.stringify(session.contentStore), saved);
            assert.deepEqual(retrieveByRef(session.contentStore!, ref), retrieveByRef(turn.contentStore, ref));
            assert.deepEqual(session.stats, stats);
            assert.equal(session.contentStoreDirty, dirty);
        });
    }
}

test("a later kernel tool result adopts the new envelope and records growth once", () => {
    const { messages, turn, ref } = seeded();
    const session = createSession("adopt-growth");
    adoptContentStore(session, turn.contentStore);
    session.contentStoreDirty = false;
    const before = structuredClone(session.stats);
    const later = "Independent test report: all assertions passed.\n".repeat(50);
    const tail: CoreMessage[] = [
        { id: "later-call", role: "assistant", contentType: "tool-call", toolCallId: "later", toolName: "bash", text: '{"command":"npm test"}' },
        { id: "later-result", role: "tool", contentType: "tool-result", toolCallId: "later", toolName: "bash", text: later },
    ];
    const next = core.processTurn({ messages: [...messages, ...tail], state: turn.state,
        config, tokenCount: 1200, contentStore: turn.contentStore, renderTags: "none" });
    assert.notEqual(next.contentStore, turn.contentStore);
    assert.equal(Object.keys(next.contentStore.byRef).length, 2);
    adoptContentStore(session, next.contentStore);
    assert.equal(session.contentStore, next.contentStore);
    assert.equal(session.contentStoreDirty, true);
    assert.equal(session.stats.storedBytes, original.length + later.length);
    assert.ok(session.stats.storeBytesSaved > before.storeBytesSaved);
    assert.deepEqual(retrieveByRef(session.contentStore!, ref), retrieveByRef(turn.contentStore, ref));
    const after = structuredClone(session.stats);
    adoptContentStore(session, next.contentStore);
    assert.deepEqual(session.stats, after);
});

test("a distinct but equal incoming envelope is still installed without invented growth", () => {
    const { turn } = seeded();
    const session = createSession("adopt-equal-envelope");
    adoptContentStore(session, turn.contentStore);
    session.contentStoreDirty = false;
    const stats = structuredClone(session.stats);
    const incoming = structuredClone(turn.contentStore);
    adoptContentStore(session, incoming);
    assert.equal(session.contentStore, incoming);
    assert.deepEqual(session.stats, stats);
    assert.equal(session.contentStoreDirty, false);
});

test("another ref to deduplicated content still records the new reference", () => {
    const { turn } = seeded();
    const session = createSession("adopt-dedup-growth");
    adoptContentStore(session, turn.contentStore);
    session.contentStoreDirty = false;
    const before = structuredClone(session.stats);
    const next = storeOriginal(turn.contentStore, { ref: "m10000", rawId: "duplicate-result", text: original,
        tokens: 600, kind: "shell output", head: "Compiler output:" });
    adoptContentStore(session, next);
    assert.equal(Object.keys(next.byHash).length, 1);
    assert.equal(session.stats.storedBytes, before.storedBytes);
    assert.ok(session.stats.storeBytesSaved > before.storeBytesSaved);
    assert.equal(session.contentStoreDirty, true);
});

for (const available of [true, false]) {
    for (const enabled of [true, false]) {
        test(`same unmaterialized store preserves backing-store validation (available=${available}, CCR=${enabled})`, () => {
            const { turn: seed, ref } = seeded();
            const session = createSession(`adopt-lazy-${available}-${enabled}`);
            let loads = 0;
            const lazy = lazyContentStore(session.id, () => { loads++; return available ? seed.contentStore : null; });
            session.contentStore = lazy;
            const turn = core.processTurn({ messages: [{ id: "u", role: "user", contentType: "text", text: "Continue." }],
                state: createInitialState(), config: { ...config, ccr: { ...config.ccr, enabled } },
                tokenCount: 1, contentStore: lazy, renderTags: "none" });
            assert.equal(turn.contentStore, lazy);
            assert.equal(loads, 0);
            assert.equal(isDroppedContentStore(lazy), true);
            if (available) {
                adoptContentStore(session, turn.contentStore);
                assert.equal(loads, 1);
                assert.equal(isDroppedContentStore(lazy), false);
                assert.deepEqual(retrieveByRef(lazy, ref), retrieveByRef(seed.contentStore, ref));
                adoptContentStore(session, lazy);
                assert.equal(loads, 1);
            } else {
                assert.throws(() => adoptContentStore(session, turn.contentStore), /could not be re-materialized/);
                assert.equal(loads, 2);
                assert.equal(isDroppedContentStore(lazy), true);
            }
        });
    }
}

test("a readable new store recovers an unavailable previous lazy store", () => {
    const { turn } = seeded();
    const session = createSession("adopt-lazy-recovery");
    session.contentStore = lazyContentStore(session.id, () => null);
    adoptContentStore(session, turn.contentStore);
    assert.equal(session.contentStore, turn.contentStore);
    assert.equal(session.contentStoreDirty, true);
    assert.equal(session.stats.storedBytes, original.length);
});
