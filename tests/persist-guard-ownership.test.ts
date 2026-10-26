import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { createInitialState } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

// #3049/#3406: the stale-disk guard's ownership fast path. The guard protects
// the shared sessions dir from counter rollback (#405/#2401); it used to re-read
// and re-parse the ENTIRE envelope on every save for two counters. In
// shadow/full mode the fast path proves "no other writer committed since our
// last landed write" with (unified-row counters === our token) + (envelope
// still byte-identical to the post-write stamp: same size, mtime not newer —
// #3406 replaced the old builtAtMs+1.5s grace window, which missed foreign
// writes landing inside it) and skips the read. These pins cover the collapse
// AND the escape hatches (cross-instance commit, foreign file write, the
// #3406 in-window race, legacy exactness).

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://upstream" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
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

function withMode(mode: "shadow" | "legacy", name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
    return test(name, { timeout: 120_000 }, async () => {
        const prev = process.env.BILI_STORAGE_UNIFIED;
        process.env.BILI_STORAGE_UNIFIED = mode === "shadow" ? "1" : "legacy";
        const dir = mkdtempSync(join(tmpdir(), `bili-guard-own-${mode}-`));
        try {
            await fn(dir);
        } catch (err) {
            // A teardown EBUSY must never mask the real failure (windows win22-1
            // #3498: the rmrf ladder's EBUSY replaced the actual error).
            try { rmrf(dir); } catch { /* keep the original error */ }
            if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
            else process.env.BILI_STORAGE_UNIFIED = prev;
            throw err;
        }
        rmrf(dir);
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
    }) as unknown as Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Fixed sleep(150) budgets assumed the 25ms debounce + disk write always fit
// in ~125ms of slack — loaded CI runners starve that (windows-22 shard red on
// #3626's head: the fifth debounced save had not landed when the test read).
// Poll for the landed state instead: same assertions, no time assumption.
function landedRequests(dir: string, id: string): number {
    try {
        return (JSON.parse(readFileSync(envelopeFileOf(dir, id), "utf8")) as { payload: { stats: { requests: number } } }).payload.stats.requests;
    } catch { return -1; } // envelope not written yet
}

async function waitForLanded(what: string, ok: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
        if (ok()) return;
        if (Date.now() > deadline) throw new Error(`${what}: did not land within 5s`);
        await sleep(25);
    }
}

function envelopeFileOf(dir: string, id: string): string {
    for (const d of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== "index.db")) {
        for (const f of readdirSync(join(dir, d.name))) {
            if (!f.endsWith(".json") || f.endsWith(".content-store.json") || f.includes(".tmp-")) continue;
            const p = join(dir, d.name, f);
            const parsed = JSON.parse(readFileSync(p, "utf8")) as { payload: { id: string } };
            if (parsed.payload.id === id) return p;
        }
    }
    throw new Error(`no envelope for ${id} under ${dir}`);
}

await withMode("shadow", "guard ownership: single-instance saves collapse to one full read; counters stay exact", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 1, enabled: true, log: () => {} });
    const s = makeSession("own-fast");
    const SAVES = 12;
    for (let i = 1; i <= SAVES; i++) {
        s.stats.requests = i;
        s.metadata.peak = `round-${i}`;
        await store.writeNow(s);
    }
    const file = envelopeFileOf(dir, "own-fast");
    const payload = (JSON.parse(readFileSync(file, "utf8")) as { payload: { stats: { requests: number }; metadata: { peak: string } } }).payload;
    assert.equal(payload.stats.requests, SAVES, "counters on disk track every save");
    assert.equal(payload.metadata.peak, `round-${SAVES}`);
    const fullReads = store.__staleGuardFullReadsForTests();
    assert.ok(fullReads <= 2, `fast path must collapse full reads (got ${fullReads} for ${SAVES} saves)`);
    store.closeQuietly();
});

await withMode("legacy", "guard ownership: legacy mode stays exact — one full read per save", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 1, enabled: true, log: () => {} });
    const s = makeSession("legacy-exact");
    const SAVES = 5;
    for (let i = 1; i <= SAVES; i++) {
        s.stats.requests = i;
        await store.writeNow(s);
    }
    assert.equal(store.__staleGuardFullReadsForTests(), SAVES, "no sidecar → no fast path → exact full read every save");
    store.closeQuietly();
});

await withMode("shadow", "guard ownership: a sibling instance's commit is detected and the stale write rejected", async (dir) => {
    const warnings: string[] = [];
    const log = (level: string, msg: string): void => {
        if (level === "warn") warnings.push(msg);
    };
    const storeA = new SessionStore({ dir, debounceMs: 1, enabled: true, log });
    const storeB = new SessionStore({ dir, debounceMs: 1, enabled: true, log });
    const a = makeSession("sib");
    a.stats.requests = 5;
    a.metadata.lineage = "A";
    await storeA.writeNow(a);

    // B commits a newer lineage through the SHARED index — the row counters
    // move past A's token, so A's fast path must fall back to the exact read.
    const b = makeSession("sib");
    b.stats.requests = 6;
    b.metadata.lineage = "B-newer";
    await storeB.writeNow(b);

    a.stats.requests = 5; // A is now stale but its counters did not regress
    await storeA.writeNow(a);

    const payload = (JSON.parse(readFileSync(envelopeFileOf(dir, "sib"), "utf8")) as { payload: { stats: { requests: number }; metadata: { lineage: string } } }).payload;
    assert.equal(payload.stats.requests, 6, "disk keeps the sibling's fresher counter");
    assert.equal(payload.metadata.lineage, "B-newer", "disk keeps the sibling's fresher lineage");
    assert.ok(warnings.some((w) => w.includes("rejected stale snapshot")), "the cross-instance catch-up still warns");
    storeA.closeQuietly();
    storeB.closeQuietly();
});

await withMode("shadow", "guard ownership: a foreign file write (legacy sibling / manual edit) trips the landed-write stamp check", async (dir) => {
    const warnings: string[] = [];
    const log = (level: string, msg: string): void => {
        if (level === "warn") warnings.push(msg);
    };
    const store = new SessionStore({ dir, debounceMs: 1, enabled: true, log });
    const s = makeSession("foreign");
    s.stats.requests = 3;
    await store.writeNow(s);

    // No sleep needed: the stamp ("written") records the size+mtime of OUR
    // landed write, so ANY foreign bytes — regardless of when they land —
    // mismatch the stamp and force the full read.
    const file = envelopeFileOf(dir, "foreign");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { payload: { stats: { requests: number }; metadata: Record<string, unknown> } };
    parsed.payload.stats.requests = 7; // a legacy sibling that never touches index.db
    parsed.payload.metadata.lineage = "foreign-newer";
    writeFileSync(file, JSON.stringify(parsed));

    // Same in-memory counters as before — the guard must still see the file.
    s.stats.requests = 3;
    await store.writeNow(s);

    const after = (JSON.parse(readFileSync(envelopeFileOf(dir, "foreign"), "utf8")) as { payload: { stats: { requests: number }; metadata: { lineage: string } } }).payload;
    assert.equal(after.stats.requests, 7, "disk keeps the foreign fresher counter");
    assert.equal(after.metadata.lineage, "foreign-newer");
    assert.ok(warnings.some((w) => w.includes("rejected stale snapshot")), "foreign write detection still warns");
    store.closeQuietly();
});

await withMode("shadow", "guard ownership: #3406 — a foreign write INSIDE the old grace window no longer clobbers the envelope", async (dir) => {
    const warnings: string[] = [];
    const log = (level: string, msg: string): void => {
        if (level === "warn") warnings.push(msg);
    };
    const store = new SessionStore({ dir, debounceMs: 1, enabled: true, log });
    const s = makeSession("in-window");
    s.stats.requests = 3;
    await store.writeNow(s);
    const fullReadsBefore = store.__staleGuardFullReadsForTests();

    // The #3406 item-2 race: a legacy-mode sibling (sidecar disabled, never
    // touches index.db) writes a NEWER envelope milliseconds after ours —
    // inside the 1.5s grace window the old #3286 fast path trusted blindly
    // (mtime was only compared against BUILD time, and no counter moved), so
    // the next save skipped the full read and clobbered the sibling's file.
    const file = envelopeFileOf(dir, "in-window");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { payload: { stats: { requests: number }; metadata: Record<string, unknown> } };
    parsed.payload.stats.requests = 9;
    parsed.payload.metadata.lineage = "sibling-newer";
    writeFileSync(file, JSON.stringify(parsed));

    // Same in-memory counters — only the landed-write stamp can catch it.
    s.stats.requests = 3;
    await store.writeNow(s);

    assert.equal(store.__staleGuardFullReadsForTests(), fullReadsBefore + 1, "size mismatch vs the landed-write stamp forces the full read (fast path must NOT fire)");
    const after = (JSON.parse(readFileSync(envelopeFileOf(dir, "in-window"), "utf8")) as { payload: { stats: { requests: number }; metadata: { lineage: string } } }).payload;
    assert.equal(after.stats.requests, 9, "the sibling's fresher envelope survives — no clobber");
    assert.equal(after.metadata.lineage, "sibling-newer");
    assert.ok(warnings.some((w) => w.includes("rejected stale snapshot")), "the in-window foreign write still warns");
    store.closeQuietly();
});

await withMode("shadow", "guard ownership: #3406 — DEBOUNCED saves stay stamped (host-owned debounce keeps the fast path live)", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 25, enabled: true, log: () => {} });
    const s = makeSession("deb-stamp");
    const SAVES = 5;
    for (let i = 1; i <= SAVES; i++) {
        s.stats.requests = i;
        store.scheduleSave(s);
        await waitForLanded(`deb-stamp save ${i}`, () => landedRequests(dir, "deb-stamp") >= i);
    }
    const file = envelopeFileOf(dir, "deb-stamp");
    const payload = (JSON.parse(readFileSync(file, "utf8")) as { payload: { stats: { requests: number } } }).payload;
    assert.equal(payload.stats.requests, SAVES, "coalesced builds still persist the freshest state");
    // Before the host-owned debounce, every debounced save landed through the
    // kernel-internal write path WITHOUT a stamp → the fast path died on every
    // per-turn save (full re-read of the envelope each time). The first save
    // has no token yet and must full-read; every later one must collapse.
    const fullReads = store.__staleGuardFullReadsForTests();
    assert.ok(fullReads <= 2, `debounced saves must collapse to the first full read (got ${fullReads} for ${SAVES} saves)`);
    store.closeQuietly();
});

await withMode("shadow", "guard ownership: #3406 — a foreign write between DEBOUNCED saves no longer clobbers the envelope", async (dir) => {
    const warnings: string[] = [];
    const log = (level: string, msg: string): void => {
        if (level === "warn") warnings.push(msg);
    };
    const store = new SessionStore({ dir, debounceMs: 25, enabled: true, log });
    const s = makeSession("deb-foreign");
    s.stats.requests = 3;
    store.scheduleSave(s);
    // Gate on the LANDED-WRITE STAMP, not just file presence: the stamp is applied
    // asynchronously after the write resolves (after the envelope is already on
    // disk), so a foreign write slipping into that gap is adopted as ours by the
    // stamp (#3406 residual gap) and the guard below never trips. Waiting only for
    // the file landed raced ~1-in-4 under loaded CI runners (#3652); the stamp gate
    // closes it deterministically.
    await waitForLanded("deb-foreign first save", () => landedRequests(dir, "deb-foreign") >= 3 && store.__ownWriteStampedForTests("deb-foreign"));
    const fullReadsBefore = store.__staleGuardFullReadsForTests();

    // The #3406 item-2 race on the production per-turn lane: a legacy-mode
    // sibling (never touches index.db) writes a NEWER envelope after ours.
    const file = envelopeFileOf(dir, "deb-foreign");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { payload: { stats: { requests: number }; metadata: Record<string, unknown> } };
    parsed.payload.stats.requests = 9;
    parsed.payload.metadata.lineage = "sibling-newer";
    writeFileSync(file, JSON.stringify(parsed));

    // Same in-memory counters — only the landed-write stamp can catch it.
    s.stats.requests = 3;
    store.scheduleSave(s);
    await waitForLanded("deb-foreign guard pass", () => store.__staleGuardFullReadsForTests() >= fullReadsBefore + 1);

    assert.equal(store.__staleGuardFullReadsForTests(), fullReadsBefore + 1, "size mismatch vs the landed-write stamp forces the full read (fast path must NOT fire)");
    const after = (JSON.parse(readFileSync(envelopeFileOf(dir, "deb-foreign"), "utf8")) as { payload: { stats: { requests: number }; metadata: { lineage: string } } }).payload;
    assert.equal(after.stats.requests, 9, "the sibling's fresher envelope survives — no clobber");
    assert.equal(after.metadata.lineage, "sibling-newer");
    assert.ok(warnings.some((w) => w.includes("rejected stale snapshot")), "the debounced-lane foreign write still warns");
    store.closeQuietly();
});

await withMode("shadow", "guard ownership: interleaved storm stays exact with the sidecar shared", async (dir) => {
    const warnings: string[] = [];
    const log = (level: string, msg: string): void => {
        if (level === "warn") warnings.push(msg);
    };
    const storeA = new SessionStore({ dir, debounceMs: 1, enabled: true, log });
    const storeB = new SessionStore({ dir, debounceMs: 1, enabled: true, log });
    const a = makeSession("storm");
    const b = makeSession("storm");
    for (let i = 1; i <= 30; i++) {
        a.stats.requests = i;
        a.metadata.peak = `a-${i}`;
        await storeA.writeNow(a);
        if (i % 6 === 0) {
            b.stats.requests = Math.max(0, i - 10); // always behind
            b.metadata.peak = `b-${i}`;
            await storeB.writeNow(b);
        }
    }
    const final = (JSON.parse(readFileSync(envelopeFileOf(dir, "storm"), "utf8")) as { payload: { stats: { requests: number }; metadata: { peak: string } } }).payload;
    assert.equal(final.stats.requests, 30, "storm: disk counter is the freshest lineage");
    assert.equal(final.metadata.peak, "a-30");
    assert.ok(warnings.some((w) => w.includes("rejected stale snapshot")), "lagging writes are still rejected under the fast path");
    storeA.closeQuietly();
    storeB.closeQuietly();
});
