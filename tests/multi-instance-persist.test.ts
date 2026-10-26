import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { createInitialState } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

// Unit-tier pins for the TWO-INSTANCE residuals documented in src/persist.ts
// (the design deliberately rejects an election/lock; one state dir should have
// one live instance — but two CAN share a dir, and their interleavings have
// contracts worth pinning). The end-to-end shape (two live proxies) is covered
// by tests/multi-instance-live.test.ts; these tests drive two SessionStore
// objects over one dir directly.
//
// These pins document CURRENT behavior. The catch-up re-clobber pin in
// particular is expected to turn RED when someone tightens the guard
// (persist.ts:81-84 documents the residual) — that is its job: the change
// should be conscious, not accidental.

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

function withTempDir(name: string, fn: (dir: string) => Promise<void> | void): Promise<void> {
    return test(name, { timeout: 60_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), "bili-multiinst-"));
        try {
            await fn(dir);
        } finally {
            rmrf(dir);
        }
    }) as unknown as Promise<void>;
}

function envelopeOf(dir: string, id: string): { file: string; payload: { stats: { requests: number }; metadata: Record<string, unknown> } } {
    for (const d of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
        for (const f of readdirSync(join(dir, d.name))) {
            if (!f.endsWith(".json") || f.endsWith(".content-store.json") || f.includes(".tmp-")) continue;
            const p = join(dir, d.name, f);
            const parsed = JSON.parse(readFileSync(p, "utf8"));
            if (parsed.id === id) return { file: p, payload: parsed.payload };
        }
    }
    throw new Error(`no envelope for ${id} under ${dir}`);
}

await withTempDir("interleaved storm: file stays valid and never rolls back", async (dir) => {
    const warnings: string[] = [];
    const log = (level: string, msg: string): void => {
        if (level === "warn") warnings.push(msg);
    };
    const storeA = new SessionStore({ dir, debounceMs: 1, enabled: true, log });
    const storeB = new SessionStore({ dir, debounceMs: 1, enabled: true, log });
    const a = makeSession("storm");
    const b = makeSession("storm");
    b.stats.requests = 0;

    // A is the live writer; B is a lagging resident whose debounced writes
    // land late. 120 interleave rounds; sample disk validity throughout.
    let peak = 0;
    for (let i = 1; i <= 120; i++) {
        a.stats.requests = i;
        a.metadata.peak = `a-${i}`;
        await storeA.writeNow(a);
        if (i % 6 === 0) {
            b.stats.requests = Math.max(0, i - 40); // always behind
            b.metadata.peak = `b-${i}`;
            await storeB.writeNow(b);
        }
        if (i % 10 === 0) {
            const v = envelopeOf(dir, "storm"); // throws if torn/unparseable
            peak = Math.max(peak, v.payload.stats.requests);
            assert.ok(v.payload.stats.requests >= 1, "storm: disk counter vanished");
        }
    }
    const final = envelopeOf(dir, "storm");
    assert.equal(final.payload.stats.requests, 120, "final disk counter must be the freshest lineage (A's 120)");
    assert.equal(final.payload.metadata.peak, "a-120");
    assert.ok(warnings.some((w) => w.includes("rejected stale snapshot")), "lagging writes must be rejected with the stale warn");
    assert.ok(peak > 0, "sampling actually observed the file");
    storeA.cancelAll();
    storeB.cancelAll();
});

await withTempDir("documented residual: counter catch-up re-clobbers newer content (persist.ts:81-84) — pin, not endorsement", async (dir) => {
    const warnings: string[] = [];
    const log = (level: string, msg: string): void => {
        if (level === "warn") warnings.push(msg);
    };
    const storeA = new SessionStore({ dir, debounceMs: 1, enabled: true, log });
    const storeB = new SessionStore({ dir, debounceMs: 1, enabled: true, log });

    // Instance A writes the newer lineage at counter 10.
    const a = makeSession("reclob");
    a.stats.requests = 10;
    a.metadata.lineage = "A-newer";
    await storeA.writeNow(a);

    // Instance B hydrated BEFORE A's write (its view is older) and only now
    // catches up on the COUNTER — its content is still the old lineage.
    const b = makeSession("reclob");
    b.stats.requests = 10; // caught up numerically
    b.metadata.lineage = "B-older";
    await storeB.writeNow(b);

    // Tie on requests AND nextBlockId → staleDiskPayload returns null → the
    // write passes through and B's OLDER content replaces A's newer payload.
    // persist.ts:81-84 documents this residual; the guard cannot see content
    // lineage, only counters. This pin documents the CURRENT contract so a
    // future tightening (content fingerprints / writer epochs) flips it
    // intentionally instead of silently.
    const after = envelopeOf(dir, "reclob");
    assert.equal(after.payload.metadata.lineage, "B-older", "CURRENT behavior: tie passthrough clobbers newer content");
    assert.equal(after.payload.stats.requests, 10, "counter itself does not roll back");
    assert.ok(!warnings.some((w) => w.includes("rejected stale snapshot")), "the clobbering write is silently accepted — that is the residual");
    storeA.cancelAll();
    storeB.cancelAll();
});

await withTempDir("content-store companion has no guard: last writer wins (documented degradation)", async (dir) => {
    const storeA = new SessionStore({ dir, debounceMs: 1, enabled: true, log: () => {} });
    const storeB = new SessionStore({ dir, debounceMs: 1, enabled: true, log: () => {} });

    const mkEntry = (rawId: string): { hash: string; rawId: string; kind: string; tokens: number; chars: number; head: string } => ({ hash: `h-${rawId}`, rawId, kind: "shell output", tokens: 3, chars: 9, head: "A payload" });
    const mkStore = (rawId: string): NonNullable<Session["contentStore"]> => ({ version: 1, byHash: { [`h-${rawId}`]: `payload ${rawId}` }, byRef: { [rawId]: mkEntry(rawId) } });
    const a = makeSession("ccs");
    a.stats.requests = 5;
    a.contentStore = mkStore("r1");
    a.contentStoreDirty = true;
    await storeA.writeNow(a);

    const b = makeSession("ccs");
    b.stats.requests = 6; // fresher main record
    b.contentStore = mkStore("r2");
    b.contentStoreDirty = true;
    await storeB.writeNow(b);

    // The main envelope guard sees requests 6 > 5 → fine. The CONTENT-STORE
    // companion file (persist.ts saveContentStore) has no lineage guard at
    // all: B's byRef REPLACES A's — refs only A stored are now missing from
    // disk (degraded retrieves, not main-record corruption). Pinned as-is.
    let companion: string | null = null;
    for (const d of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
        for (const f of readdirSync(join(dir, d.name))) {
            if (f.endsWith(".content-store.json")) companion = join(dir, d.name, f);
        }
    }
    assert.ok(companion, "content-store companion file must exist");
    const parsed = JSON.parse(readFileSync(companion!, "utf8")) as { byRef: Record<string, { rawId: string }> };
    assert.deepEqual(Object.keys(parsed.byRef).sort(), ["r2"], "CURRENT behavior: companion is last-writer-wins, A's r1 is gone");
    storeA.cancelAll();
    storeB.cancelAll();
});
