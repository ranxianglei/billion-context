// #3982 compress-from-store: an evicted session (no live in-memory view)
// must fold against the unified-store view instead of refusing forever
// (#3918 Phase 4). These tests pin:
//   1. view recovered from the store → compress proceeds, block lands, refs
//      resolve — the fold is identical to the after-model-request path;
//   2. no store (legacy/hermetic) → the #3126 refusal stays byte-identical;
//   3. a corrupt row → refuse (never guess from a half-readable view);
//   4. a live view present → the store is never consulted (zero behavior
//      change for the resident fast path).
// The recovery is read-only (peek, never creates a store) and only fires when
// the effective view is EMPTY — a partial live view stays authoritative.

// Storage-family discipline (#4076/#4077): the recovery tests below are
// full-mode stories (unified store is the read path). Pin the mode so the CI
// runner's legacy preload cannot flip the story under them; the no-store test
// builds an explicit enabled:false store and is mode-independent.
process.env.BILI_STORAGE_UNIFIED = "full";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

const SPEC = () => parseCompressInput({ content: [{ startId: "m00010", endId: "m00040", summary: "y".repeat(100) }] });

function makeCtx(opts?: { id?: string; messages?: CoreMessage[]; refs?: boolean }): Ctx {
    const logs: string[] = [];
    const ctx: Ctx = {
        core: createCore(),
        config: defaultConfig(200000, { preserveRecentMessages: 5, preserveRecentTokens: 0 }),
        messages: opts?.messages ?? [],
        session: {
            id: opts?.id ?? "sess-cfs",
            meta: { protocol: "anthropic" },
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: (m: string) => { logs.push(m); },
        logs,
    };
    if (opts?.refs) {
        ctx.session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
    }
    return ctx;
}

function makeStoredSession(id: string, lastMessages: CoreMessage[]) {
    const ctx = makeCtx({ id });
    return {
        ...ctx.session,
        lastMessages: lastMessages as never,
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    } as never;
}

test("compress-from-store: evicted view is recovered from the unified store and the fold lands (#3982)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfs-store-"));
    process.env.BILI_PERSIST_ZSTD = "0";
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        await store.writeNow(makeStoredSession("sess-cfs", MESSAGES));
        const ctx = makeCtx({ id: "sess-cfs", refs: true });
        const res = applyRanges(SPEC(), ctx);
        assert.equal(res.outcome, "applied", `expected a real fold, got: ${(res.text ?? "").slice(0, 200)}`);
        assert.ok(ctx.session.state.blocks.length > 0, "block landed in state");
        assert.ok(ctx.logs.some((l) => l.includes("view recovered from the unified store")), "recovery is logged");
        const active = ctx.session.state.blocks.filter((b) => b.active);
        assert.equal(active.length, 1);
        assert.equal(active[0].effectiveMessageIds.length, 31, "m00010..m00040 coverage");
        // #3982 review: a recovered fold must cache its block content like the
        // live-view path does — collecting against the empty ctx.messages would
        // leave later decompress/range-restore of this block empty.
        const cached = ctx.session.blockContents.get(active[0].blockId);
        assert.ok(cached && cached.full.count === 31, "recovered fold caches block content for later decompress");
    } finally {
        await store.closeQuietly();
        rmSync(dir, { recursive: true, force: true });
        _setStoreForTest(new SessionStore({ enabled: false }));
        delete process.env.BILI_PERSIST_ZSTD;
    }
});

test("compress-from-store: no store available → the #3126 refusal stays byte-identical", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx({ id: "sess-nostore", refs: true });
    const res = applyRanges(SPEC(), ctx);
    assert.equal(res.outcome, "refused");
    assert.match(res.reason ?? "", /no-visible-context/);
    assert.ok(res.text.includes("no live message view"), "honest refusal text preserved");
    assert.equal(ctx.session.state.blocks.length, 0, "nothing folded");
});

test("compress-from-store: a corrupt stored row refuses instead of guessing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfs-bad-"));
    process.env.BILI_PERSIST_ZSTD = "0";
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        await store.writeNow(makeStoredSession("sess-bad", MESSAGES));
        const db = new DatabaseSync(join(dir, "index.db"));
        db.exec(`UPDATE content SET bytes = CAST('{"broken' AS BLOB) WHERE hash = (SELECT content_hash FROM messages WHERE session_id = 'sess-bad' AND seq = 5)`);
        db.close();
        const ctx = makeCtx({ id: "sess-bad", refs: true });
        const res = applyRanges(SPEC(), ctx);
        assert.equal(res.outcome, "refused", "corrupt row must not produce a half-view fold");
        assert.match(res.reason ?? "", /no-visible-context/);
        assert.equal(ctx.session.state.blocks.length, 0);
    } finally {
        await store.closeQuietly();
        rmSync(dir, { recursive: true, force: true });
        _setStoreForTest(new SessionStore({ enabled: false }));
        delete process.env.BILI_PERSIST_ZSTD;
    }
});

test("compress-from-store: a live view keeps the store out of the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfs-live-"));
    process.env.BILI_PERSIST_ZSTD = "0";
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        // Stored rows deliberately diverge from the live view: if the store
        // were consulted despite the live view, the fold would cover the
        // wrong ids.
        const staleRows = MESSAGES.map((m, i) => ({ ...m, id: `stale${i}`, text: "stale " + m.text }));
        await store.writeNow(makeStoredSession("sess-live", staleRows));
        const ctx = makeCtx({ id: "sess-live", messages: MESSAGES, refs: true });
        const res = applyRanges(SPEC(), ctx);
        assert.equal(res.outcome, "applied", "live view folds normally");
        assert.ok(!ctx.logs.some((l) => l.includes("view recovered from the unified store")), "no recovery when a live view exists");
        const active = ctx.session.state.blocks.filter((b) => b.active);
        assert.equal(active.length, 1);
        assert.ok(active[0].effectiveMessageIds.includes("raw10"), "coverage follows the LIVE view ids");
    } finally {
        await store.closeQuietly();
        rmSync(dir, { recursive: true, force: true });
        _setStoreForTest(new SessionStore({ enabled: false }));
        delete process.env.BILI_PERSIST_ZSTD;
    }
});
