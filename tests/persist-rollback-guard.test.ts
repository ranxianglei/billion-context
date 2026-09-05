import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { createInitialState } from "acp-kernel";

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://upstream" },
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

type Warnings = string[];

function withTempStore(name: string, fn: (store: SessionStore, dir: string, warnings: Warnings) => Promise<void> | void): Promise<void> {
    return test(name, async () => {
        const dir = mkdtempSync(join(tmpdir(), "bili-rollback-"));
        const warnings: Warnings = [];
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true, log: (level, msg) => {
            if (level === "warn") warnings.push(msg);
        } });
        try {
            await fn(store, dir, warnings);
        } finally {
            store.cancelAll();
            rmSync(dir, { recursive: true, force: true });
        }
    }) as unknown as Promise<void>;
}

await withTempStore("writeNow rejects a stale snapshot and keeps the newer disk state", async (store, _dir, warnings) => {
    const s = makeSession("sess-stale");
    s.stats.requests = 5;
    s.state.nextBlockId = 3;
    await store.writeNow(s);
    // Simulate the OTHER instance having advanced disk state, while this
    // process holds an older in-memory copy (e.g. dual-instance sharing the
    // sessions dir): requests rolled back 5 -> 4.
    s.stats.requests = 4;
    await store.writeNow(s);
    const reloaded = store.loadSync("sess-stale", { protocol: "openai", upstreamOrigin: "http://upstream" });
    assert.ok(reloaded);
    assert.equal(reloaded.stats.requests, 5, "disk keeps the newer counter — no rollback");
    assert.ok(warnings.some((w) => w.includes("rejected stale snapshot") && w.includes("sess-stale")));
});

await withTempStore("tie on requests but stale nextBlockId is still rejected", async (store, _dir, warnings) => {
    const s = makeSession("sess-blocks");
    s.stats.requests = 5;
    s.state.nextBlockId = 3;
    await store.writeNow(s);
    s.stats.requests = 5;
    s.state.nextBlockId = 2;
    await store.writeNow(s);
    const reloaded = store.loadSync("sess-blocks", { protocol: "openai", upstreamOrigin: "http://upstream" });
    assert.ok(reloaded);
    assert.equal(reloaded.state.nextBlockId, 3, "disk keeps the newer block cursor");
    assert.ok(warnings.some((w) => w.includes("sess-blocks")));
});

await withTempStore("fresher incoming snapshot passes through untouched", async (store, _dir, warnings) => {
    const s = makeSession("sess-fresh");
    s.stats.requests = 5;
    s.state.nextBlockId = 3;
    await store.writeNow(s);
    s.stats.requests = 6;
    s.state.nextBlockId = 4;
    await store.writeNow(s);
    const reloaded = store.loadSync("sess-fresh", { protocol: "openai", upstreamOrigin: "http://upstream" });
    assert.ok(reloaded);
    assert.equal(reloaded.stats.requests, 6);
    assert.equal(reloaded.state.nextBlockId, 4);
    assert.equal(warnings.length, 0, "no warning on legitimate writes");
});

await withTempStore("flushSync of a stale snapshot returns true so eviction stays safe", async (store) => {
    const s = makeSession("sess-flush");
    s.stats.requests = 9;
    await store.writeNow(s);
    s.stats.requests = 2;
    assert.equal(store.flushSync(s), true, "write of the disk's own payload counts as success");
    const reloaded = store.loadSync("sess-flush", { protocol: "openai", upstreamOrigin: "http://upstream" });
    assert.ok(reloaded);
    assert.equal(reloaded.stats.requests, 9);
});

await withTempStore("stale warning is throttled to once per window", async (store, _dir, warnings) => {
    const s = makeSession("sess-throttle");
    s.stats.requests = 5;
    await store.writeNow(s);
    s.stats.requests = 4;
    await store.writeNow(s);
    await store.writeNow(s);
    await store.writeNow(s);
    assert.equal(warnings.filter((w) => w.includes("sess-throttle")).length, 1, "one warn per 60s window");
});

await withTempStore("debounced scheduleSave also guards against rollback", async (store) => {
    const s = makeSession("sched-1");
    s.stats.requests = 7;
    await store.writeNow(s);
    s.stats.requests = 6;
    store.scheduleSave(s);
    await new Promise((r) => setTimeout(r, 30));
    const reloaded = store.loadSync("sched-1", { protocol: "openai", upstreamOrigin: "http://upstream" });
    assert.ok(reloaded);
    assert.equal(reloaded.stats.requests, 7, "debounced write does not roll back");
});
