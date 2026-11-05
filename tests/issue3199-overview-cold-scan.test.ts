import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "acp-kernel";
import type { CompressionBlock } from "acp-kernel";
import { flatFileNameFor } from "acp-kernel/persist";
import { SessionStore, _setStoreForTest, fileNameMatchesId } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { buildSessionList, _resetDiskCacheForTest, _diskScanStatsForTest } from "../src/web/sessions-data.ts";
import { rmrf } from "./tmp-rm.ts";

// #3199: Web UI first paint stalled 78-180s+ on a cold instance — in shadow
// mode the web lists ignored the unified index (full-only gate) and decoded
// the ENTIRE corpus on the event loop, and boot parsed the whole corpus
// before the listener started. These tests pin both fixes:
//   T1 — shadow mode adopts fresh index rows WITHOUT decoding their files;
//        only files newer than their row (or never recorded) are decoded;
//        ghost rows (file vanished) drop from the shadow list.
//   T2 — unified-mode boot parses only the warm window (newest files within
//        the budget); label aliases for recorded sessions are SQL-seeded
//        synchronously; the rest fills in the background.
//   T3 — legacy-mode boot keeps the synchronous full parse (control).

// Plain JSON session files so seeds and round-trips stay deterministic (#1080)
process.env.BILI_PERSIST_ZSTD = "0";

// Hermetic config: a developer machine's real billion-context.json must not
// leak storage settings into this suite's tmp-dir stores (same discipline as
// tests/web-sessions.test.ts).
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-3199-hermetic-")),
    "no-config.json",
);
// Absent everywhere resolves to the shadow DEFAULT (#2815 rollout flip); pin
// the explicit legacy baseline — legs flip per test.
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

function withSessionsDir<T>(name: string, fn: (dir: string) => Promise<T>): void {
    test(name, async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-3199-"));
        const prev = process.env.BILI_SESSIONS_DIR;
        process.env.BILI_SESSIONS_DIR = dir;
        try {
            await fn(dir);
        } finally {
            if (prev === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prev;
            _resetSessionsForTest();
            _resetDiskCacheForTest();
            rmrf(dir);
        }
    });
}

/** Flip the suite's legacy baseline to shadow for one body and restore after
 *  — _resetDiskCacheForTest() re-creates the disk-store singleton (mode is
 *  resolved at construction), so each leg sees its own engine honestly. */
function withShadowMode<T>(name: string, fn: (dir: string) => Promise<T>): void {
    withSessionsDir(name, async (dir) => {
        const prev = process.env.BILI_STORAGE_UNIFIED;
        process.env.BILI_STORAGE_UNIFIED = "shadow";
        try {
            await fn(dir);
        } finally {
            if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prev;
        }
    });
}

/** id → absolute envelope path, by scanning the corpus (layout-independent). */
function fileById(root: string, id: string): string | null {
    const walk = (r: string): string[] => {
        const out: string[] = [];
        for (const e of readdirSync(r, { withFileTypes: true })) {
            const p = path.join(r, e.name);
            if (e.isDirectory()) out.push(...walk(p));
            else if (e.name.endsWith(".json")) out.push(p);
        }
        return out;
    };
    for (const p of walk(root)) {
        try {
            const env = JSON.parse(readFileSync(p, "utf8")) as { id?: unknown; payload?: { id?: unknown } };
            if (env.id === id || env.payload?.id === id) return p;
        } catch {
            // non-JSON / unreadable: not our file
        }
    }
    return null;
}

withShadowMode("#3199 T1: shadow list adopts fresh rows without decoding; stale/unrecorded files win; ghosts drop", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    assert.ok(store.replicasAvailable(), "sidecar must be live for this leg (engine available)");

    const sFresh = makeSession("s3199-fresh", { protocol: "openai", title: "Fresh", label: "s3199-fresh" }, { requests: 3, inputTokens: 800, cachedTokens: 200, outputTokens: 40, contextTokens: 400 });
    sFresh.state.blocks.push(mkBlock("bf1", 1500, true, "Fresh topic"));
    await store.writeNow(sFresh);

    const sStale = makeSession("s3199-stale", { protocol: "openai", title: "Stale Title", label: "s3199-stale" }, { requests: 2, inputTokens: 500, cachedTokens: 100, contextTokens: 300, tokensSaved: 111 });
    sStale.state.blocks.push(mkBlock("bs1", 700, true, "Old topic"));
    await store.writeNow(sStale);

    const sGhost = makeSession("s3199-ghost", { protocol: "openai", title: "Ghost" }, { requests: 2, inputTokens: 500, cachedTokens: 100, contextTokens: 300 });
    await store.writeNow(sGhost);
    store.closeQuietly();

    // External rewrite of the stale session AFTER its row was ingested: bump
    // the values, then stamp the mtime 6 minutes into the future so
    // mtime - row.updated_at deterministically exceeds the 5-minute freshness
    // window (normal writes always land slightly AFTER their row).
    const staleFile = fileById(dir, "s3199-stale");
    assert.ok(staleFile, "stale session file present");
    const env = JSON.parse(readFileSync(staleFile, "utf8")) as Record<string, unknown>;
    const payload = (env.payload ?? env) as Record<string, any>;
    payload.meta = { protocol: "openai", title: "Stale Rewritten", label: "s3199-stale" };
    payload.stats = { ...zeroStats(), requests: 9, inputTokens: 500, cachedTokens: 100, contextTokens: 300, tokensSaved: 4242 };
    payload.state = stateWith([mkBlock("bs2", 3333, true, "New topic")]);
    payload.savedAt = Date.now();
    env.savedAt = payload.savedAt;
    writeFileSync(staleFile, JSON.stringify(env), "utf8");
    const future = Date.now() / 1000 + 6 * 60;
    utimesSync(staleFile, future, future);

    // Ghost: the JSON twin vanishes (hand-deleted) — the shadow list must DROP
    // the orphan row (in shadow the tree is the truth base; full mode keeps
    // such rows, pinned by the R2.2 file-less test).
    const ghostFile = fileById(dir, "s3199-ghost");
    assert.ok(ghostFile, "ghost session file present before deletion");
    rmSync(ghostFile);

    // Unrecorded: a valid session file that was never ingested (pre-shadow
    // era file) — no row exists, so the walk must decode and list it.
    const unrecId = "s3199-unrecorded";
    const unrecName = flatFileNameFor(unrecId);
    assert.ok(fileNameMatchesId(unrecName, unrecId), "flat name is addressable for its id");
    writeFileSync(path.join(dir, unrecName), JSON.stringify({
        version: 2,
        savedAt: Date.now(),
        id: unrecId,
        meta: { protocol: "openai", title: "Unrecorded", label: unrecId },
        stats: { ...zeroStats(), requests: 5, inputTokens: 900, cachedTokens: 100, contextTokens: 500, tokensSaved: 2222 },
        state: stateWith([mkBlock("bu1", 2000, true, "Unrecorded topic")]),
    }), "utf8");

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();

    const list = await buildSessionList();
    assert.deepEqual(list.map((x) => x.id).sort(), ["s3199-fresh", "s3199-stale", "s3199-unrecorded"], "ghost row dropped, unrecorded file listed");

    // Structural proof of the fix: exactly the two files whose rows were
    // missing/stale got decoded — the fresh row was adopted from SQL alone.
    assert.equal(_diskScanStatsForTest().decodedTotal, 2, "only stale + unrecorded files may be decoded");

    const fresh = list.find((x) => x.id === "s3199-fresh");
    assert.ok(fresh, "fresh row listed");
    assert.equal(fresh!.title, "Fresh");
    assert.equal(fresh!.requests, 3);
    assert.equal(fresh!.tokensSaved, 1500, "active-block sum floor from the row");
    assert.equal(fresh!.blocks, 1);
    assert.equal(fresh!.firstBlockHint, "Fresh topic");
    assert.equal(fresh!.live, false);

    const stale = list.find((x) => x.id === "s3199-stale");
    assert.ok(stale, "stale file listed");
    assert.equal(stale!.title, "Stale Rewritten", "file values beat the lagging row");
    assert.equal(stale!.requests, 9);
    assert.equal(stale!.tokensSaved, 4242);

    const unrec = list.find((x) => x.id === unrecId);
    assert.ok(unrec, "unrecorded file listed");
    assert.equal(unrec!.title, "Unrecorded");
    assert.equal(unrec!.requests, 5);

    // Live pool still overrides disk entries in the merge.
    const live = getSession("s3199-live", { protocol: "openai", label: "s3199-live" });
    live.stats.requests = 2;
    live.stats.contextTokens = 100;
    const list2 = await buildSessionList();
    const liveRow = list2.find((x) => x.id === "s3199-live");
    assert.ok(liveRow, "live session listed");
    assert.equal(liveRow!.live, true);
    assert.equal(_diskScanStatsForTest().decodedTotal, 2, "second list served from the (mtime,size) cache");
});

withShadowMode("#3199 T2: unified boot parses only the warm window; aliases SQL-seeded; rest fills in background", async (dir) => {
    const N = 12;
    const seeder = new SessionStore({ dir, debounceMs: 0, enabled: true });
    assert.ok(seeder.replicasAvailable(), "sidecar must be live for this leg (engine available)");
    for (let i = 0; i < N; i++) {
        const id = `s3199-boot-${i}`;
        // Older half carries a distinct label (alias candidate); the newest
        // four use label === id (canonical — never aliased).
        const label = i >= N - 4 ? id : `s3199-label-${i}`;
        const s = makeSession(id, { protocol: "openai", title: `Boot ${i}`, label }, { requests: i + 1, contextTokens: 100 * (i + 1) });
        await seeder.writeNow(s);
    }
    seeder.closeQuietly();

    // Stagger mtimes by one minute: i = N-1 is newest. Track the largest
    // on-disk size so the byte budget below can never trim an intended winner
    // (file sizes grow a few bytes as token counts cross digit boundaries).
    const base = Math.floor(Date.now() / 1000) - N * 60;
    let maxFileSize = 0;
    for (let i = 0; i < N; i++) {
        const f = fileById(dir, `s3199-boot-${i}`);
        assert.ok(f, `session file for i=${i}`);
        maxFileSize = Math.max(maxFileSize, statSync(f).size);
        const t = base + i * 60;
        utimesSync(f, t, t);
    }

    // An UNRECORDED labeled file: no index row exists, so its alias can only
    // come from the post-boot background scan. Stamped OLDER than every boot
    // file on BOTH signals (mtime and savedAt) so it cannot win a warm slot
    // in the savedAt arbitration.
    const strayId = "s3199-stray";
    const strayLabel = "s3199-stray-label";
    const strayFile = path.join(dir, flatFileNameFor(strayId));
    writeFileSync(strayFile, JSON.stringify({
        version: 2,
        savedAt: (base - 60) * 1000,
        id: strayId,
        meta: { protocol: "openai", title: "Stray", label: strayLabel },
        stats: { ...zeroStats(), requests: 7, contextTokens: 700 },
        state: stateWith([]),
    }), "utf8");
    utimesSync(strayFile, base - 60, base - 60);

    // Byte budget sized to ~4-5 files: the parse window stops after a full
    // budget's worth of candidates instead of draining the whole corpus, yet
    // 4×maxFileSize always fits so the trim can never drop an intended winner.
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    const booted = await store.boot({ maxSessions: 4, maxBytes: maxFileSize * 5 });
    // Lexicographic order ("boot-10" < "boot-8") — same comparator on both sides.
    assert.deepEqual([...booted.keys()].sort(), ["s3199-boot-10", "s3199-boot-11", "s3199-boot-8", "s3199-boot-9"], "warm set = 4 newest by mtime, arbitrated by savedAt");

    // Label-based resume of a NON-warm recorded session works SYNCHRONOUSLY —
    // the alias came from the index rows, not from parsing the file. Alias
    // resume re-keys the session to the requested label by design, so assert
    // the data (contextTokens 800 = i 7) proves the right file was read.
    const resumed = store.loadSync("s3199-label-7");
    assert.ok(resumed, "SQL-seeded alias resolves before any background work");
    assert.equal(resumed!.id, "s3199-label-7");
    assert.equal(resumed!.stats.contextTokens, 800);

    // The unrecorded label is only resolvable once the background scan reaches
    // its file (it was outside the warm window by construction).
    await store.backgroundScanComplete();
    const stray = store.loadSync(strayLabel);
    assert.ok(stray, "background scan recorded the unrecorded label alias");
    assert.equal(stray!.id, strayLabel);
    assert.equal(stray!.stats.contextTokens, 700);
    store.closeQuietly();
});

withSessionsDir("#3199 T3: legacy boot keeps the synchronous full parse (control)", async (dir) => {
    const seeder = new SessionStore({ dir, debounceMs: 0, enabled: true });
    for (let i = 0; i < 4; i++) {
        const s = makeSession(`s3199-leg-${i}`, { protocol: "openai", title: `Leg ${i}`, label: `s3199-leg-label-${i}` }, { requests: i + 1, contextTokens: 100 * (i + 1) });
        await seeder.writeNow(s);
    }
    seeder.closeQuietly();

    const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
    await store.boot({ maxSessions: 2, maxBytes: 10 * 1024 * 1024 });
    // No background phase in legacy mode: even the OLDEST alias resolves
    // immediately after boot returns. Alias resume re-keys to the label by
    // design; the data proves the right file was read.
    const loaded = store.loadSync("s3199-leg-label-0");
    assert.ok(loaded, "legacy boot completes alias bookkeeping synchronously");
    assert.equal(loaded!.id, "s3199-leg-label-0");
    assert.equal(loaded!.stats.contextTokens, 100);
    store.closeQuietly();
});
