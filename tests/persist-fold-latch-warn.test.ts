import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import type { CompressionBlock } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import { setLogCapture } from "../src/logger.ts";
import type { Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #7670: the pendingFoldUsage latch is intentionally NOT restored on cold load
// (see the stats comment in buildSession), so the [acp-drift] fold-coverage
// alert is off on the first post-load request — the exact round that could
// destroy the fold. buildSession now warns whenever a session with active fold
// blocks is loaded so the operator knows the alert is off. These tests pin both
// directions: active blocks ⇒ warn fires (positive), no active blocks ⇒ warn
// stays silent (negative).

function makeSession(id: string): Session {
    return {
        id,
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
    };
}

function makeBlock(active: boolean): CompressionBlock {
    return {
        blockId: "blk-1",
        runId: "run-1",
        tier: 1,
        summary: "test fold summary",
        directMessageIds: ["m00001"],
        effectiveMessageIds: ["m00001"],
        directBlockIds: [],
        compressedTokens: 100,
        createdAt: Date.now(),
        survivedCount: 0,
        generation: "young",
        active,
    };
}

const LATCH_MARKER = "pendingFoldUsage latch NOT restored";

test("#7670: cold-loading a session with active fold blocks warns that the [acp-drift] alert is off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-foldlatch-pos-"));
    const stores: SessionStore[] = [];
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        stores.push(store);
        const s = makeSession("foldlatch-positive");
        s.state.blocks.push(makeBlock(true));
        await store.writeNow(s);
        await store.flushAll([]);

        const captured: Array<{ level: string; msg: string }> = [];
        setLogCapture((level, msg) => captured.push({ level, msg }));
        try {
            const reloaded = new SessionStore({ dir, debounceMs: 5, enabled: true });
            stores.push(reloaded);
            const back = reloaded.loadSync("foldlatch-positive");
            assert.ok(back, "session reloaded");
            assert.equal(back.stats.pendingFoldUsage, undefined, "latch is not restored (intentional, #2129)");
            const warn = captured.find((c) => c.level === "warn" && c.msg.includes(LATCH_MARKER));
            assert.ok(warn, `a warn log naming the latch must fire on cold load, got: ${JSON.stringify(captured)}`);
            assert.ok(warn.msg.includes("foldlatch-positive"), "the warn names the session id");
            assert.ok(warn.msg.includes("1 active fold block"), "the warn counts the active blocks");
            await reloaded.flushAll([]);
        } finally {
            setLogCapture(null);
        }
    } finally {
        for (const st of stores) st.closeQuietly();
        rmrf(dir);
    }
});

test("#7670: cold-loading a session with NO active fold blocks stays silent (negative)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-foldlatch-neg-"));
    const stores: SessionStore[] = [];
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        stores.push(store);
        const s = makeSession("foldlatch-negative");
        // No blocks at all — the common case for a fresh session.
        await store.writeNow(s);
        await store.flushAll([]);

        const captured: Array<{ level: string; msg: string }> = [];
        setLogCapture((level, msg) => captured.push({ level, msg }));
        try {
            const reloaded = new SessionStore({ dir, debounceMs: 5, enabled: true });
            stores.push(reloaded);
            const back = reloaded.loadSync("foldlatch-negative");
            assert.ok(back, "session reloaded");
            const warn = captured.find((c) => c.level === "warn" && c.msg.includes(LATCH_MARKER));
            assert.equal(warn, undefined, `no latch warn expected for a blockless session, got: ${JSON.stringify(warn)}`);
            await reloaded.flushAll([]);
        } finally {
            setLogCapture(null);
        }
    } finally {
        for (const st of stores) st.closeQuietly();
        rmrf(dir);
    }
});

test("#7670: cold-loading a session whose fold blocks are all INACTIVE stays silent (negative)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-foldlatch-inact-"));
    const stores: SessionStore[] = [];
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        stores.push(store);
        const s = makeSession("foldlatch-inactive");
        s.state.blocks.push(makeBlock(false));
        await store.writeNow(s);
        await store.flushAll([]);

        const captured: Array<{ level: string; msg: string }> = [];
        setLogCapture((level, msg) => captured.push({ level, msg }));
        try {
            const reloaded = new SessionStore({ dir, debounceMs: 5, enabled: true });
            stores.push(reloaded);
            const back = reloaded.loadSync("foldlatch-inactive");
            assert.ok(back, "session reloaded");
            const warn = captured.find((c) => c.level === "warn" && c.msg.includes(LATCH_MARKER));
            assert.equal(warn, undefined, `no latch warn expected when every block is inactive, got: ${JSON.stringify(warn)}`);
            await reloaded.flushAll([]);
        } finally {
            setLogCapture(null);
        }
    } finally {
        for (const st of stores) st.closeQuietly();
        rmrf(dir);
    }
});
