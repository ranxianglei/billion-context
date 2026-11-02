import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, relPathFor } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { exportSession } from "../src/export.ts";
import { createInitialState } from "acp-kernel";

/**
 * #5062 (from #5026): exporting ONE session must not decode EVERY persisted
 * session. On a machine holding several long-lived sessions the old
 * `loadAll()`-first flow OOMed the V8 heap (exit 134) before the documented
 * bad-session→handoff workaround could even run. Selection now resolves from
 * the unified summary rows (one SQL, the same authority `listSessions` uses)
 * and hydrates ONLY the winner via loadSync. Gate discipline (#3617): both
 * directions are pinned — the unified leg proves loadAll is never walked,
 * the legacy leg proves the historical walk still happens (byte-for-byte
 * fallback), and the error surfaces stay byte-identical.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-issue5062-hermetic-")),
    "no-config.json",
);
// Explicit legacy baseline; per-test legs override with withMode().
process.env.BILI_STORAGE_UNIFIED = "legacy";

function makeSession(id: string, title: string, label: string): Session {
    return {
        id,
        meta: { protocol: "responses", upstreamOrigin: "https://api.openai.com/v1", title, label },
        stats: { requests: 12, tokensSaved: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 50, cacheSamples: 1, lastInputTokens: 100, contextTokens: 99000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        state: createInitialState(),
        pendingRetrievals: [],
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

async function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
    process.env.BILI_STORAGE_UNIFIED = mode;
    try {
        return await fn();
    } finally {
        process.env.BILI_STORAGE_UNIFIED = "legacy";
    }
}

async function seedSessions(dir: string, specs: Array<[string, string, string]>): Promise<void> {
    const store = new SessionStore({ dir, enabled: true, debounceMs: 1 });
    for (const [id, title, label] of specs) await store.writeNow(makeSession(id, title, label));
    await store.flushAll(); // closes the unified handle (Windows: open index.db blocks rmSync)
    store.cancelAll();
}

function spyLoadAll(): { count: () => number; restore: () => void } {
    const original = SessionStore.prototype.loadAll;
    let calls = 0;
    SessionStore.prototype.loadAll = function (this: SessionStore) {
        calls++;
        return original.call(this);
    };
    return {
        count: () => calls,
        restore: () => { SessionStore.prototype.loadAll = original; },
    };
}

const SPECS: Array<[string, string, string]> = [
    ["abc123", "Fix auth bug", "fix-auth"],
    ["abc456", "Fix net retry", "fix-net"],
    ["def789", "Deploy pipeline", "deploy"],
];

test("unified (full) mode selects from summary rows without walking the directory", async () => {
    await withMode("full", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-issue5062-full-"));
        try {
            await seedSessions(dir, SPECS);
            const spy = spyLoadAll();
            try {
                const byId = await exportSession("abc123", { dir });
                assert.match(byId, /# billion-context session handoff/);
                assert.match(byId, /Fix auth bug/);
                assert.doesNotMatch(byId, /Fix net retry/);

                const byLabel = await exportSession("fix-net", { dir });
                assert.match(byLabel, /Fix net retry/);

                const listing = await exportSession(undefined, { dir });
                assert.match(listing, /Persisted sessions:/);
                assert.match(listing, /abc123/);
                assert.match(listing, /abc456/);
                assert.match(listing, /def789/);

                // The whole point of #5062: no selection path may decode the
                // rest of the store.
                assert.equal(spy.count(), 0, "loadAll must never be walked in unified mode");
            } finally {
                spy.restore();
            }
        } finally {
            try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
        }
    });
});

test("unified mode keeps the historical error surface byte-for-byte", async () => {
    await withMode("full", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-issue5062-errors-"));
        try {
            await seedSessions(dir, SPECS);
            const spy = spyLoadAll();
            try {
                await assert.rejects(
                    () => exportSession("nope", { dir }),
                    /no session matches "nope" \(run "bili export" to list sessions\)/,
                );
                await assert.rejects(
                    () => exportSession("abc", { dir }),
                    /selector "abc" matches 2 sessions .*use the full session id/,
                );
                // Selection failures resolve entirely from the rows — the walk
                // never starts.
                assert.equal(spy.count(), 0);
            } finally {
                spy.restore();
            }
        } finally {
            try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
        }
    });
});

test("legacy mode: one undecodable session cannot block exporting the rest (#5026 story)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-issue5062-corrupt-"));
    try {
        await seedSessions(dir, SPECS);
        // The #5026 shape: one bad envelope among healthy ones. The walk skips
        // it (logged), healthy sessions still export, and selecting the bad
        // one fails with the plain no-match error — never a crash.
        writeFileSync(path.join(dir, relPathFor("def789", "responses", "https://api.openai.com/v1")), "{ not valid json");
        const spy = spyLoadAll();
        try {
            const md = await exportSession("abc123", { dir });
            assert.match(md, /Fix auth bug/);

            await assert.rejects(
                () => exportSession("def789", { dir }),
                /no session matches "def789"/,
            );
            assert.ok(spy.count() >= 1, "legacy mode resolves through the walk");
        } finally {
            spy.restore();
        }
    } finally {
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
    }
});

test("fresh full-mode store (index exists, zero rows) still reports the empty-store message", async () => {
    await withMode("full", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-issue5062-empty-"));
        try {
            const spy = spyLoadAll();
            try {
                const text = await exportSession("nope", { dir });
                assert.match(text, /^No persisted sessions found\./);
                assert.ok(spy.count() >= 1, "zero-row index falls through to the walk");
            } finally {
                spy.restore();
            }
        } finally {
            try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
        }
    });
});

test("legacy mode keeps the historical full walk (fallback leg unchanged)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-issue5062-legacy-"));
    try {
        await seedSessions(dir, SPECS);
        const spy = spyLoadAll();
        try {
            const md = await exportSession("abc123", { dir });
            assert.match(md, /# billion-context session handoff/);
            assert.match(md, /Fix auth bug/);
            assert.equal(spy.count(), 1, "legacy mode must still take the walk");

            const listing = await exportSession(undefined, { dir });
            assert.match(listing, /Persisted sessions:/);
            assert.match(listing, /def789/);

            const emptyDir = mkdtempSync(path.join(tmpdir(), "bili-issue5062-empty-legacy-"));
            try {
                const text = await exportSession("nope", { dir: emptyDir });
                assert.match(text, /^No persisted sessions found\./);
            } finally {
                try { rmSync(emptyDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
            }
        } finally {
            spy.restore();
        }
    } finally {
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
    }
});

test("unifiedSessionSummaries reports network backends as unavailable (null), not empty", () => {
    // #5062 side finding: the sync facade's miss value on a mysql backend is
    // [] — which callers read as "zero sessions" and blank the list on healthy
    // installs. The contract is null = unavailable = file walk (same guard the
    // webSummaryBaseline surface carries).
    const dir = mkdtempSync(path.join(tmpdir(), "bili-issue5062-shadow-"));
    try {
        const store = new SessionStore({ dir, enabled: true, debounceMs: 1 });
        const shim = store as unknown as { shadow: unknown };
        shim.shadow = {
            readsUnified: true,
            isAsyncBackend: true,
            sessionSummaries: () => [{ sessionId: "should-not-be-read" }],
            close: () => {},
        };
        assert.equal(store.unifiedSessionSummaries(), null, "async backend must yield null, not []");

        shim.shadow = {
            readsUnified: true,
            isAsyncBackend: false,
            sessionSummaries: () => [{ sessionId: "row" }],
            close: () => {},
        };
        assert.deepEqual(
            (store.unifiedSessionSummaries() as Array<{ sessionId: string }> | null)?.map((r) => r.sessionId),
            ["row"],
            "sync backend keeps serving its rows",
        );
        store.closeQuietly();
    } finally {
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
    }
});
