import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionStore, relPathFor } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { createInitialState } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

// #5805: `storage.jsonWriter=off` (index-only persistence) never writes the
// envelope, so the #3406 landed-write stamp can never exist — and the stale-disk
// guard fell back to a FULL read + parse of the whole envelope on every save
// (138 MB / turn on a large session). The guard now compares the envelope's
// current stat against the stat recorded at OUR last build under index-only
// lanes: an unchanged file proves no foreign writer landed, and the unified row
// counters already prove no sibling committed. Both directions are pinned here:
// repeated saves must collapse to the fast path, and a foreign envelope write
// must still force the exact read.

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = mkdtempSync(join(tmpdir(), "bili-5805-hermetic-"));
process.env.BILI_CONFIG_FILE = join(hermetic, "no-config.json");

function makeSession(id: string, requests = 0): Session {
    return {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://upstream" },
        stats: { requests, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
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

function envelopeFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (p: string): void => {
        for (const e of readdirSync(p, { withFileTypes: true })) {
            const full = join(p, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith(".json") && !e.name.endsWith(".content-store.json") && e.name !== "no-config.json") out.push(full);
        }
    };
    walk(dir);
    return out;
}

function withFullWriterOff(name: string, fn: (dir: string) => Promise<void>): Promise<void> {
    return test(name, { timeout: 120_000 }, async () => {
        const prevMode = process.env.BILI_STORAGE_UNIFIED;
        const prevOff = process.env.BILI_STORAGE_JSON_WRITER;
        process.env.BILI_STORAGE_UNIFIED = "full";
        process.env.BILI_STORAGE_JSON_WRITER = "off";
        const dir = mkdtempSync(join(tmpdir(), "bili-5805-"));
        try {
            await fn(dir);
        } finally {
            rmrf(dir);
            if (prevMode === undefined) delete process.env.BILI_STORAGE_UNIFIED;
            else process.env.BILI_STORAGE_UNIFIED = prevMode;
            if (prevOff === undefined) delete process.env.BILI_STORAGE_JSON_WRITER;
            else process.env.BILI_STORAGE_JSON_WRITER = prevOff;
        }
    }) as unknown as Promise<void>;
}

await withFullWriterOff("issue5805: index-only saves stop re-reading the envelope after the first build", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 1, enabled: true, log: () => {} });
    try {
        const s = makeSession("jw-5805-fast");
        const SAVES = 10;
        for (let i = 1; i <= SAVES; i++) {
            s.stats.requests = i;
            s.metadata.peak = `round-${i}`;
            await store.writeNow(s);
        }
        assert.equal(envelopeFiles(dir).length, 0, "index-only lane must never write the session envelope");
        const fullReads = store.__staleGuardFullReadsForTests();
        assert.ok(fullReads <= 2, `ownership fast path must collapse the envelope re-read inside the index-only lane (got ${fullReads} full reads for ${SAVES} saves)`);
    } finally {
        store.closeQuietly();
    }
});

await withFullWriterOff("issue5805: a foreign envelope write still forces the exact read, then returns to the fast path", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 1, enabled: true, log: () => {} });
    const siblingDir = mkdtempSync(join(tmpdir(), "bili-5805-sibling-"));
    try {
        const s = makeSession("jw-5805-foreign");
        s.stats.requests = 1;
        await store.writeNow(s);
        const afterFirst = store.__staleGuardFullReadsForTests();

        // A legacy-mode sibling (or a manual edit) drops a newer-shaped record
        // where this session's envelope would live — the landed-write stamp no
        // longer exists in the index-only lane, so the stat comparison is the
        // only proof the file was untouched.
        const prevMode = process.env.BILI_STORAGE_UNIFIED;
        process.env.BILI_STORAGE_UNIFIED = "legacy";
        try {
            const sibling = new SessionStore({ dir: siblingDir, debounceMs: 1, enabled: true, log: () => {} });
            try {
                await sibling.writeNow(makeSession(s.id, 0));
            } finally {
                sibling.closeQuietly();
            }
        } finally {
            process.env.BILI_STORAGE_UNIFIED = prevMode;
        }
        const rel = relPathFor(s.id, s.meta.protocol, s.meta.upstreamOrigin);
        const planted = join(dir, rel);
        mkdirSync(dirname(planted), { recursive: true });
        cpSync(join(siblingDir, rel), planted);

        s.stats.requests = 2;
        await store.writeNow(s);
        const afterForeign = store.__staleGuardFullReadsForTests();
        assert.ok(afterForeign > afterFirst, "a foreign envelope write must force the exact full read");

        s.stats.requests = 3;
        await store.writeNow(s);
        assert.equal(store.__staleGuardFullReadsForTests(), afterForeign, "an untouched envelope returns to the ownership fast path");
    } finally {
        rmrf(siblingDir);
        store.closeQuietly();
    }
});

await withFullWriterOff("issue5805: a same-size foreign rewrite landing sub-ms later still trips the exact read", async (dir) => {
    const warnings: string[] = [];
    const log = (level: string, msg: string): void => {
        if (level === "warn") warnings.push(msg);
    };
    const store = new SessionStore({ dir, debounceMs: 1, enabled: true, log });
    const siblingDir = mkdtempSync(join(tmpdir(), "bili-5805-sibling2-"));
    try {
        const s = makeSession("jw-5805-subms");

        // Pin the envelope's mtime to an EXACT whole millisecond (M0) so the
        // key recorded at our build equals round(key): a foreign rewrite at
        // +0.4 ms then sits INSIDE the half-millisecond window a Math.round-
        // based key would treat as unchanged (same size, same rounded mtime)
        // and skip. NOTE: fs.utimesSync interprets NUMBER args as SECONDS —
        // pass M0/1000, not M0.
        const prevMode = process.env.BILI_STORAGE_UNIFIED;
        process.env.BILI_STORAGE_UNIFIED = "legacy";
        let sibling: SessionStore | undefined;
        try {
            sibling = new SessionStore({ dir: siblingDir, debounceMs: 1, enabled: true, log: () => {} });
            await sibling.writeNow(makeSession(s.id, 0));
        } finally {
            process.env.BILI_STORAGE_UNIFIED = prevMode;
            sibling?.closeQuietly();
        }
        const rel = relPathFor(s.id, s.meta.protocol, s.meta.upstreamOrigin);
        const planted = join(dir, rel);
        mkdirSync(dirname(planted), { recursive: true });
        cpSync(join(siblingDir, rel), planted);
        const m0 = Math.floor(statSync(planted).mtimeMs);
        utimesSync(planted, 0, m0 / 1000); // whole-ms pin; numeric arg = SECONDS

        s.stats.requests = 1;
        await store.writeNow(s);
        const readsAfterSeed = store.__staleGuardFullReadsForTests();
        assert.ok(readsAfterSeed >= 1 && readsAfterSeed <= 2, `first save after boot takes 1-2 exact reads (got ${readsAfterSeed})`);

        // Same-BYTE-SIZE foreign rewrite (only the counter digit changes),
        // stamped 0.4 ms AFTER our recorded stat — newer than ours, yet it
        // rounds to the same whole millisecond.
        const raw = readFileSync(planted, "utf8");
        const hits = [...raw.matchAll(/"requests"\s*:\s*0\b/g)];
        assert.equal(hits.length, 1, "planted envelope carries exactly one stats.requests=0 cell");
        const hit = hits[0];
        const foreign = raw.slice(0, hit.index!) + hit[0].slice(0, -1) + "7" + raw.slice(hit.index! + hit[0].length);
        assert.ok(foreign.length === raw.length && foreign !== raw, "rewrite keeps the byte size identical");
        writeFileSync(planted, foreign);
        utimesSync(planted, 0, m0 / 1000 + 0.0004); // NEWER than recorded by 0.4 ms — still the same rounded ms

        s.stats.requests = 2;
        await store.writeNow(s);
        assert.ok(
            store.__staleGuardFullReadsForTests() > readsAfterSeed,
            "a same-size foreign rewrite at +0.4 ms must force the exact read (no rounded-key blind spot)",
        );
        assert.ok(warnings.some((w) => w.includes("rejected stale snapshot")), "the fresher foreign counter converges onto memory, not the other way around");

        // The re-recorded stat absorbs the foreign bytes — steady state resumes.
        const readsSettled = store.__staleGuardFullReadsForTests();
        await store.writeNow(s);
        assert.equal(store.__staleGuardFullReadsForTests(), readsSettled, "post-convergence saves return to the fast path");
    } finally {
        rmrf(siblingDir);
        store.closeQuietly();
    }
});
