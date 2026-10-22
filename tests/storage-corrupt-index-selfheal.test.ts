import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, truncateSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { setSqliteEnginesUnavailableForTests } from "../src/storage/driver.ts";
import { _resetStorageRuntimeStatusForTest, storageStatusWire } from "../src/storage/runtime-status.ts";
import { rmrf } from "./tmp-rm.ts";

/**
 * #3959: a corrupt index.db used to pin a machine to legacy-only forever —
 * open failed with SQLITE_CORRUPT, the log said "delete the file to reset
 * the index", and every restart re-failed until someone deleted it by hand.
 * Now genuine corruption-class errors quarantine the dead file (rename to
 * `.corrupt-<ts>`, never delete) and open a fresh index; the legacy JSON
 * session files remain the source of truth, so nothing is lost. Gate
 * discipline (#3617): both directions pinned — corruption recovers, and
 * non-corruption failures (CANTOPEN, no-engine) do NOT trip quarantine.
 */

const GARBAGE = "this is definitely not a sqlite database, just plain text garbage bytes 0123456789";

const ENV_KEYS = ["BILI_SESSIONS_DIR", "BILI_CONFIG_FILE", "XDG_CACHE_HOME", "XDG_STATE_HOME", "BILI_STORAGE_UNIFIED", "BILI_ENCRYPTION_KEY"] as const;

function isolateEnv(base: string, sessions: string): Record<string, string | undefined> {
    const snap: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) snap[k] = process.env[k];
    process.env.BILI_SESSIONS_DIR = sessions;
    process.env.BILI_STORAGE_UNIFIED = "shadow";
    process.env.BILI_CONFIG_FILE = path.join(base, "absent-config.json");
    process.env.XDG_CACHE_HOME = path.join(base, "cache");
    process.env.XDG_STATE_HOME = path.join(base, "state");
    delete process.env.BILI_ENCRYPTION_KEY;
    return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
    for (const k of ENV_KEYS) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
    }
}

function quarantineFiles(sessions: string): string[] {
    return readdirSync(sessions).filter((f) => f.startsWith("index.db.corrupt-"));
}

test("#3959: non-SQLite bytes in index.db are quarantined and a fresh index opens", () => {
    const base = mkdtempSync(path.join(tmpdir(), "corrupt-index-notadb-"));
    const sessions = path.join(base, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path.join(sessions, "index.db"), GARBAGE);
    const snap = isolateEnv(base, sessions);
    let shadow: UnifiedShadow | null = null;
    try {
        _resetStorageRuntimeStatusForTest();
        shadow = UnifiedShadow.maybeOpen(sessions);
        assert.ok(shadow, "sidecar self-heals instead of degrading");
        assert.equal(shadow.stats.disabled, false);
        assert.equal(shadow.stats.lastError, null);
        const wire = storageStatusWire();
        assert.equal(wire.degraded, false, "wire reports healthy after self-heal");
        assert.equal(wire.effective, "shadow");
        const qs = quarantineFiles(sessions);
        assert.equal(qs.length, 1, "exactly one quarantine file");
        assert.equal(readFileSync(path.join(sessions, qs[0]), "utf8"), GARBAGE, "original bytes preserved for forensics");
        assert.ok(existsSync(path.join(sessions, "index.db")), "fresh index.db created in place");
    } finally {
        shadow?.close();
        _resetStorageRuntimeStatusForTest();
        restoreEnv(snap);
        rmrf(base);
    }
});

test("#3959: a truncated real db (database disk image is malformed) is quarantined and a fresh index opens", () => {
    const base = mkdtempSync(path.join(tmpdir(), "corrupt-index-truncated-"));
    const sessions = path.join(base, "sessions");
    mkdirSync(sessions, { recursive: true });
    const dbPath = path.join(sessions, "index.db");
    // Build a real db with committed data so truncation lands mid-page.
    const direct = UnifiedStore.open(dbPath);
    direct.setKv("selfheal-probe", "key", "x".repeat(4000));
    direct.close();
    const size = statSync(dbPath).size;
    truncateSync(dbPath, Math.floor(size / 2));
    const snap = isolateEnv(base, sessions);
    let shadow: UnifiedShadow | null = null;
    try {
        _resetStorageRuntimeStatusForTest();
        shadow = UnifiedShadow.maybeOpen(sessions);
        assert.ok(shadow, "sidecar self-heals a malformed db");
        const wire = storageStatusWire();
        assert.equal(wire.degraded, false, "wire reports healthy after self-heal");
        assert.equal(wire.effective, "shadow");
        const qs = quarantineFiles(sessions);
        assert.equal(qs.length, 1, "exactly one quarantine file");
        assert.equal(statSync(path.join(sessions, qs[0])).size, Math.floor(size / 2), "truncated bytes preserved for forensics");
        assert.ok(existsSync(dbPath), "fresh index.db created in place");
    } finally {
        shadow?.close();
        _resetStorageRuntimeStatusForTest();
        restoreEnv(snap);
        rmrf(base);
    }
});

test("#3959 negative: CANTOPEN (a directory named index.db) degrades WITHOUT quarantining anything", () => {
    const base = mkdtempSync(path.join(tmpdir(), "corrupt-index-cantopen-"));
    const sessions = path.join(base, "sessions");
    mkdirSync(sessions, { recursive: true });
    // A DIRECTORY named index.db: SQLite refuses it (SQLITE_CANTOPEN)
    // deterministically on every platform — the same error class as the
    // AV-lock / OneDrive / integrity-label field reports (#3823), where the
    // "file" situation may be perfectly fine once the OS lock clears.
    mkdirSync(path.join(sessions, "index.db"));
    const snap = isolateEnv(base, sessions);
    try {
        _resetStorageRuntimeStatusForTest();
        const shadow = UnifiedShadow.maybeOpen(sessions);
        assert.equal(shadow, null, "still degrades to legacy-only");
        assert.deepEqual(quarantineFiles(sessions), [], "no quarantine side effect on CANTOPEN");
        assert.ok(existsSync(path.join(sessions, "index.db")), "the obstructing entry is left untouched");
        const wire = storageStatusWire();
        assert.equal(wire.degraded, true);
        assert.ok(wire.reason?.startsWith("index database failed to open"), `reason names the open failure (got: ${wire.reason})`);
    } finally {
        _resetStorageRuntimeStatusForTest();
        restoreEnv(snap);
        rmrf(base);
    }
});

test("#3959 negative: a no-engine failure degrades WITHOUT quarantining anything", () => {
    const base = mkdtempSync(path.join(tmpdir(), "corrupt-index-noengine-"));
    const sessions = path.join(base, "sessions");
    mkdirSync(sessions, { recursive: true });
    // A valid empty db file sits there — the failure class is "no engine",
    // not "bad file": quarantining would move a healthy file aside.
    const direct = UnifiedStore.open(path.join(sessions, "index.db"));
    direct.close();
    const snap = isolateEnv(base, sessions);
    try {
        _resetStorageRuntimeStatusForTest();
        setSqliteEnginesUnavailableForTests(true);
        const shadow = UnifiedShadow.maybeOpen(sessions);
        assert.equal(shadow, null, "still degrades to legacy-only");
        assert.deepEqual(quarantineFiles(sessions), [], "no quarantine side effect without an engine");
        const wire = storageStatusWire();
        assert.equal(wire.degraded, true);
        assert.ok(wire.reason, "reason recorded");
    } finally {
        setSqliteEnginesUnavailableForTests(false);
        _resetStorageRuntimeStatusForTest();
        restoreEnv(snap);
        rmrf(base);
    }
});
