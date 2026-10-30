import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "acp-kernel";
import { SessionStore, _setStoreForTest, relPathFor } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { buildOverview, buildSessionList, _diskScanStatsForTest, _resetDiskCacheForTest } from "../src/web/sessions-data.ts";
import { rmrf } from "./tmp-rm.ts";

// #4990 regression: the web read surface (overview / session list / detail)
// rides the persist process singleton instead of constructing its own
// SessionStore. A locally-constructed store re-ran the open-time path —
// integrity check, lockfile, migration pass, WAL checkpoint — on the live
// main thread every time the proxy's first GET /__bili/overview landed
// (~20s stall on a ~900MiB database in v0.1.208).

// Plain JSON session files so seeds stay deterministic (#1080)
process.env.BILI_PERSIST_ZSTD = "0";

// #2671 hermeticity: pin the config file so a developer machine's storage /
// persist knobs cannot leak into these lifecycle assertions.
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-4990-hermetic-")),
    "no-config.json",
);

interface Stats {
    requests: number; tokensSaved: number; inputTokens: number; cachedTokens: number; outputTokens: number; cacheSamples: number; lastInputTokens: number; contextTokens: number; retrieveCalls: number; retrieveHits: number; retrieveMisses: number; storedBytes: number; storeBytesSaved: number; compressCreditTokens: number; rangeRestores: number; wholeBlockRestores?: number; wholeBlockRestoresPreciseAvailable?: number;
}

function zeroStats(): Stats {
    return { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, compressCreditTokens: 0, rangeRestores: 0, wholeBlockRestores: 0, wholeBlockRestoresPreciseAvailable: 0 };
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

test("#4990 first overview rides the engine store — no second SessionStore opens", async () => {
    const dirEngine = mkdtempSync(path.join(tmpdir(), "bili-4990-engine-"));
    const dirEnv = mkdtempSync(path.join(tmpdir(), "bili-4990-env-"));
    const prevDir = process.env.BILI_SESSIONS_DIR;
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    try {
        // Engine side (what the running proxy owns): a full-mode store on its own
        // directory holding one row whose JSON twin vanished.
        process.env.BILI_STORAGE_UNIFIED = "full";
        const seeder = new SessionStore({ dir: dirEngine, debounceMs: 0, enabled: true });
        await seeder.writeNow(makeSession("engine-only", { protocol: "openai", title: "Engine Only" }, { requests: 2, contextTokens: 300 }));
        seeder.closeQuietly();
        rmSync(path.join(dirEngine, relPathFor("engine-only", "openai")), { force: true });

        const engine = new SessionStore({ dir: dirEngine, debounceMs: 0, enabled: true });

        // Proxy side: BILI_SESSIONS_DIR points at an EMPTY directory. The pre-fix
        // web surface constructed its own store here (opening index.db in dirEnv
        // at construction) and listed nothing; the fixed surface must ride `engine`.
        process.env.BILI_SESSIONS_DIR = dirEnv;
        _resetDiskCacheForTest();
        _setStoreForTest(engine);

        const list = await buildSessionList();
        assert.deepEqual(list.map((s) => s.id), ["engine-only"], "overview served from the engine sidecar, not an env-dir walk");
        assert.equal(list[0].title, "Engine Only");

        const overview = await buildOverview();
        assert.equal(overview.sessions, 1);
        assert.equal(overview.requests, 2);

        // Structural proof: no second store ever opened against the env dir.
        assert.ok(!existsSync(path.join(dirEnv, "index.db")), "second store never opened against BILI_SESSIONS_DIR");
        // Full-mode authoritative path skips the file walk entirely.
        assert.equal(_diskScanStatsForTest().decodedTotal, 0, "no legacy JSON decode happened");
    } finally {
        _resetDiskCacheForTest();
        if (prevDir === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prevDir;
        if (prevMode === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prevMode;
        rmrf(dirEngine);
        rmrf(dirEnv);
    }
});

test("#4990 persistence-disabled engine store degrades to file walk (BILI_PERSIST=0 path)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-4990-off-"));
    const prevDir = process.env.BILI_SESSIONS_DIR;
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    try {
        process.env.BILI_STORAGE_UNIFIED = "full";
        const seeder = new SessionStore({ dir, debounceMs: 0, enabled: true });
        await seeder.writeNow(makeSession("has-file", { protocol: "anthropic", title: "Has File" }, { requests: 3, contextTokens: 500 }));
        await seeder.writeNow(makeSession("fileless", { protocol: "openai", title: "Fileless" }, { requests: 1, contextTokens: 100 }));
        seeder.closeQuietly();
        rmSync(path.join(dir, relPathFor("fileless", "openai")), { force: true });

        // Persistence switched off mid-lifetime: same directory, disabled store —
        // no sidecar, no index-authoritative rows. Overview must fall back to the
        // legacy file walk without crashing and without opening a sidecar.
        process.env.BILI_SESSIONS_DIR = dir;
        _resetDiskCacheForTest();
        _setStoreForTest(new SessionStore({ dir, enabled: false }));

        const list = await buildSessionList();
        const ids = list.map((s) => s.id);
        assert.ok(ids.includes("has-file"), "envelope-bearing session survives via file walk");
        assert.ok(!ids.includes("fileless"), "row-only session drops while persistence is off (disclosed degradation)");
        assert.equal(_diskScanStatsForTest().decodedTotal, 1, "surviving session served by decoding its file");
    } finally {
        _resetDiskCacheForTest();
        if (prevDir === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prevDir;
        if (prevMode === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prevMode;
        rmrf(dir);
    }
});
