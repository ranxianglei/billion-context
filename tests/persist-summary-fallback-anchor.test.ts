import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { createInitialState, createCore, defaultConfig } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://upstream", activePack: "lean" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 , compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        pendingRetrievals: [],
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

test("fallback successor learned without a new fold survives host persist/reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-fallback-anchor-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    const reader = new SessionStore({ dir, debounceMs: 5, enabled: true });
    try {
        const s = makeSession("fallback-persistence");
        s.state.blocks.push({ blockId: "b1", runId: "r1", tier: 1, summary: "Synthetic summary", directMessageIds: ["missing"], effectiveMessageIds: ["missing"], directBlockIds: [], compressedTokens: 100, createdAt: 0, survivedCount: 1, generation: "old", active: true, startSeq: 10, endSeq: 10 });
        await store.writeNow(s);
        const core = createCore();
        const config = defaultConfig(200_000);
        const messages = [
            { id: "opening", role: "user" as const, contentType: "text" as const, text: "Opening" },
            { id: "covered", role: "assistant" as const, contentType: "text" as const, text: "Past work", ledgerSeq: 10 },
            { id: "task", role: "user" as const, contentType: "text" as const, text: "Current task" },
        ];
        const first = core.processTurn({ messages, state: s.state, config, tokenCount: 100, renderTags: "none" });
        s.state = first.state;
        assert.equal(s.state.blocks[0]!.fallbackUserMessageId, "task");
        await store.writeNow(s);
        const restored = reader.loadSync(s.id, { protocol: "openai", upstreamOrigin: "http://upstream" });
        assert.ok(restored);
        assert.equal(restored.state.blocks[0]!.fallbackUserMessageId, "task");
        const second = core.processTurn({ messages: [...messages, { id: "new-task", role: "user", contentType: "text", text: "New task" }], state: restored.state, config, tokenCount: 100, renderTags: "none" });
        assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
    } finally {
        store.cancelAll(); reader.cancelAll(); rmrf(dir);
    }
});

test("unified store persists a fallback-only block payload update", async () => {
    const { UnifiedStore } = await import("../src/storage/store.ts");
    const { planIngest, loadLegacyView } = await import("../src/storage/ingest.ts");
    const dir = mkdtempSync(join(tmpdir(), "bili-fallback-unified-"));
    const db = UnifiedStore.open(join(dir, "index.db"));
    try {
        const s = makeSession("fallback-unified");
        s.state.blocks.push({ blockId: "b1", runId: "r1", tier: 1, summary: "Synthetic summary", directMessageIds: ["missing"], effectiveMessageIds: ["missing"], directBlockIds: [], compressedTokens: 100, createdAt: 0, survivedCount: 1, generation: "old", active: true });
        const plan = () => planIngest(s as unknown as import("../src/storage/ingest.ts").LegacySessionLike);
        db.ingestSession(plan());
        // No fold, coverage, summary, token-count or timestamp changes.
        s.state.blocks[0]!.fallbackUserMessageId = "stable-user";
        db.ingestSession(plan());
        const session = db.getSessionRow(s.id);
        assert.ok(session);
        const restored = loadLegacyView({ session, messages: db.getMessages(s.id), blocks: db.getBlocks(s.id), deadRefs: db.getDeadRefs(s.id), refs: db.getRefs(s.id) });
        assert.equal((restored.state.blocks as typeof s.state.blocks)[0]!.fallbackUserMessageId, "stable-user");
    } finally {
        db.close(); rmrf(dir);
    }
});
