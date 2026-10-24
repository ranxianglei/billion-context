import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "acp-kernel";
import type { CompressionBlock } from "acp-kernel";
import { flatFileNameFor } from "acp-kernel/persist";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #4515: at maxSessions==0 (the #2803 default) the bounded boot used to
// decode+parse a whole 64MB-decode window of the newest files synchronously
// only to pop every candidate — pure waste on the pre-listen critical path,
// and the leading contributor to cold starts blowing the native spawn budget.
// Pin the fix: full-mode boot at maxSessions==0 warms NOTHING, yet loses no
// alias bookkeeping — recorded labels resolve from the index synchronously,
// unrecorded labels fill in once the background scan finishes.

// Plain JSON session files so seeds and round-trips stay deterministic (#1080)
process.env.BILI_PERSIST_ZSTD = "0";

// Hermetic config: a developer machine's real billion-context.json must not
// leak storage settings into this suite's tmp-dir stores (same discipline as
// tests/web-sessions.test.ts).
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-4515-hermetic-")),
    "no-config.json",
);
// Absent everywhere resolves to the shadow DEFAULT (#2815 rollout flip); pin
// the explicit legacy baseline — the single leg flips to full.
process.env.BILI_STORAGE_UNIFIED = "legacy";

interface Stats {
    requests: number;
    tokensSaved: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    cacheSamples: number;
    lastInputTokens: number;
    contextTokens: number;
    retrieveCalls: number;
    retrieveHits: number;
    retrieveMisses: number;
    storedBytes: number;
    storeBytesSaved: number;
    compressCreditTokens: number;
    rangeRestores: number;
}

function zeroStats(): Stats {
    return { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, compressCreditTokens: 0, rangeRestores: 0 };
}

function makeSession(id: string, meta: Session["meta"] = {}, patch: Partial<Stats> = {}, lastSeen = Date.now()): Session {
    return {
        id,
        meta,
        stats: { ...zeroStats(), ...patch },
        metadata: {},
        state: createInitialState(),
        createdAt: lastSeen,
        lastSeen,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

/** Full persisted-state shape (kernel initial state + our blocks) so hand-
 *  written records survive both summary extraction AND buildSession's compat
 *  pass in the loadSync legs. */
function stateWith(blocks: CompressionBlock[]): unknown {
    const s = JSON.parse(JSON.stringify(createInitialState())) as { blocks: unknown[] };
    s.blocks = blocks;
    return s;
}

const mkBlock = (blockId: string, compressedTokens: number, active: boolean, topic = "T"): CompressionBlock => ({
    blockId,
    runId: "r1",
    tier: 1,
    topic,
    summary: "S",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    compressedTokens,
    createdAt: Date.now(),
    survivedCount: 1,
    generation: "young",
    active,
});

test("#4515: full-mode boot at maxSessions==0 warms nothing but keeps every alias", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-4515-"));
    const prevDir = process.env.BILI_SESSIONS_DIR;
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_SESSIONS_DIR = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const seeder = new SessionStore({ dir, debounceMs: 0, enabled: true });
        assert.ok(seeder.replicasAvailable(), "sidecar must be live for this leg (engine available)");

        // Recorded labeled session: writeNow double-ingests it, so an index
        // row AND a file both exist. Its alias is SQL-seeded at boot.
        const sRec = makeSession("s4515-rec", { protocol: "openai", title: "Recorded", label: "s4515-rec-label" }, { requests: 3, contextTokens: 800 });
        sRec.state.blocks.push(mkBlock("b4515-1", 1500, true, "Recorded topic"));
        await seeder.writeNow(sRec);
        seeder.closeQuietly();

        // Unrecorded labeled file: hand-written, NEVER ingested, so no index
        // row exists. Its alias can ONLY come from the post-boot background
        // scan — exactly the bookkeeping the skipped sync window used to do
        // for in-window files.
        const strayId = "s4515-stray";
        const strayLabel = "s4515-stray-label";
        writeFileSync(path.join(dir, flatFileNameFor(strayId)), JSON.stringify({
            version: 2,
            savedAt: Date.now(),
            id: strayId,
            meta: { protocol: "openai", title: "Stray", label: strayLabel },
            stats: { ...zeroStats(), requests: 7, contextTokens: 700 },
            state: stateWith([]),
        }), "utf8");

        const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
        const booted = await store.boot({ maxSessions: 0, maxBytes: 64 * 1024 * 1024 });
        assert.equal(booted.size, 0, "maxSessions==0 warms nothing");
        // Sharp teeth on the fix itself: NOTHING was decoded synchronously — the
        // warm window is skipped entirely at maxSessions==0, not just trimmed.
        assert.equal(store.lastBootSyncParsedFilesForTest(), 0, "no state file decoded synchronously at maxSessions==0");

        // Recorded label resolves SYNCHRONOUSLY — the alias came from the index
        // rows (seedIndexedAliases), independent of the skipped file window.
        const rec = store.loadSync("s4515-rec-label");
        assert.ok(rec, "SQL-seeded alias resolves before any background work");
        assert.equal(rec!.id, "s4515-rec-label");
        assert.equal(rec!.stats.contextTokens, 800);

        // Unrecorded label fills in once the background scan reaches its file —
        // proof the skipped sync window lost no corpus bookkeeping.
        await store.backgroundScanComplete();
        const stray = store.loadSync(strayLabel);
        assert.ok(stray, "background scan recorded the unrecorded label alias");
        assert.equal(stray!.id, strayLabel);
        assert.equal(stray!.stats.contextTokens, 700);
        store.closeQuietly();
    } finally {
        if (prevDir === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prevDir;
        if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prevUnified;
        rmrf(dir);
    }
});
