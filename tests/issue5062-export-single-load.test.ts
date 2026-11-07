import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { Session, cacheBlockContent } from "../src/session.ts";
import { exportSession } from "../src/export.ts";
import { createInitialState } from "acp-kernel";

// #5062: exporting ONE session must not decode EVERY session on the machine.
// Gate discipline (#3617): the positive leg pins "fast path triggers when it
// should" (loadAll never runs), the negative leg pins "it does NOT trigger
// when it should not" (legacy mode without a unified index keeps the scan).

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-5062-hermetic-")),
    "no-config.json",
);
// Absent everywhere resolves to the shadow DEFAULT (#2815 rollout flip); pin
// the explicit legacy baseline and let each leg opt into unified.
process.env.BILI_STORAGE_UNIFIED = "legacy";

function makeSession(id: string, title: string): Session {
    const s: Session = {
        id,
        meta: { protocol: "responses", upstreamOrigin: "https://api.example.com/v1", title },
        stats: { requests: 3, tokensSaved: 0, inputTokens: 300, cachedTokens: 0, outputTokens: 90, cacheSamples: 1, lastInputTokens: 300, contextTokens: 30000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        state: createInitialState(),
        pendingRetrievals: [],
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
    s.state.blocks.push({
        blockId: "b0", runId: "r0", tier: 1, topic: `${title} notes`,
        summary: `${title}: marker-${id} folded here`,
        directMessageIds: ["m1"], effectiveMessageIds: ["m1"], directBlockIds: [],
        compressedTokens: 420, createdAt: Date.now(), survivedCount: 1, generation: "young", active: true,
    });
    cacheBlockContent(s, "b0", {
        one: { text: `${title} summary text marker-${id}`, count: 1 },
        full: { text: `user: ${title}\nassistant: ${title} answer marker-${id}`, count: 2 },
    });
    return s;
}

async function seedSessions(dir: string, ids: string[]): Promise<void> {
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    for (const id of ids) await store.writeNow(makeSession(id, `Title of ${id}`));
    await store.flushAll();
    store.cancelAll();
}

async function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
    process.env.BILI_STORAGE_UNIFIED = mode;
    try {
        return await fn();
    } finally {
        process.env.BILI_STORAGE_UNIFIED = "legacy";
    }
}

async function withLoadAllSpy<T>(fn: () => Promise<T>): Promise<{ result: T; loadAllCalls: number }> {
    const original = SessionStore.prototype.loadAll;
    let calls = 0;
    SessionStore.prototype.loadAll = async function (this: SessionStore) {
        calls += 1;
        return original.call(this);
    };
    try {
        const result = await fn();
        return { result, loadAllCalls: calls };
    } finally {
        SessionStore.prototype.loadAll = original;
    }
}

test("#5062 positive: selector export hydrates only the selected session (unified fast path)", async () => {
    await withMode("full", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5062-full-"));
        try {
            await seedSessions(dir, ["sess-alpha", "sess-beta", "sess-gamma"]);
            const { result, loadAllCalls } = await withLoadAllSpy(() => exportSession("sess-beta", { dir }));
            assert.equal(loadAllCalls, 0, "selector export must not decode every session on the machine");
            assert.ok(result.includes("Title of sess-beta"), "renders the selected session");
            assert.ok(!result.includes("sess-alpha") && !result.includes("sess-gamma"), "sibling sessions stay out of the artifact");

            const jsonl = await withLoadAllSpy(() => exportSession("sess-beta", { dir, jsonl: true }));
            assert.equal(jsonl.loadAllCalls, 0, "--jsonl selection rides the same single-id path");
            assert.ok(jsonl.result.includes('"sessionId":"sess-beta"'), "jsonl dump is for the selected session");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

test("#5062 negative: no unified index (legacy mode) keeps the historical full scan", async () => {
    await withMode("legacy", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5062-legacy-"));
        try {
            await seedSessions(dir, ["solo-session"]);
            const { result, loadAllCalls } = await withLoadAllSpy(() => exportSession("solo-session", { dir }));
            assert.ok(loadAllCalls >= 1, "the fast path must NOT trigger without a unified index");
            assert.ok(result.includes("Title of solo-session"), "legacy export output unchanged");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

test("#5062 parity: empty store + selector keeps the friendly notice, no throw", async () => {
    await withMode("full", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5062-empty-"));
        try {
            const out = await exportSession("anything", { dir });
            assert.match(out, /^No persisted sessions found\./);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

test("#5062 guard: summary facade misses (null) on network backends, serves rows on sqlite", async () => {
    // Decision table for SessionStore.unifiedSessionSummaries' #5062 guard:
    // the sync facade's miss value [] must never reach callers as an
    // authoritative row set (network backends), while the sqlite fast lane
    // keeps serving real rows untouched.
    await withMode("full", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5062-facade-"));
        try {
            const store = new SessionStore({ dir, enabled: true });
            const shadow = (store as unknown as {
                shadow?: { isAsyncBackend: boolean; sessionSummaries(): unknown[] };
            }).shadow;
            assert.ok(shadow, "full-mode store must attach a sidecar");
            const rows = [{ sessionId: "sess-x", hostTitle: null, title: "x", label: null, protocol: "responses", origin: "https://api.example.com/v1", namespace: "", statsJson: "{}", status: "active", updatedAt: 1, blocks: 1, latestBlockAt: 1 }];
            try {
                const setAsync = (v: boolean) => Object.defineProperty(shadow, "isAsyncBackend", { get: () => v, configurable: true });
                shadow.sessionSummaries = () => rows;
                setAsync(true);
                assert.equal(store.unifiedSessionSummaries(), null, "async backend: miss wins even when rows would be available");
                setAsync(false);
                assert.deepEqual(store.unifiedSessionSummaries(), rows, "sqlite fast lane still serves rows");
            } finally {
                store.closeQuietly();
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

test("#5062 parity: ambiguous prefix lists the candidates, unknown selector errors", async () => {
    await withMode("full", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5062-ambig-"));
        try {
            await seedSessions(dir, ["sess-alpha-1", "sess-alpha-2", "other-sess"]);
            await assert.rejects(
                () => exportSession("sess-alpha", { dir }),
                /selector "sess-alpha" matches 2 sessions/,
            );
            await assert.rejects(
                () => exportSession("nope", { dir }),
                /no session matches "nope"/,
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
