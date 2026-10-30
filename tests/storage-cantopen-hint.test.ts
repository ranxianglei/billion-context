import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sqliteOpenFailureHint } from "../src/storage/shadow.ts";
import { _resetStorageRuntimeStatusForTest, storageStatusWire } from "../src/storage/runtime-status.ts";
import { SessionStore } from "../src/persist.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

/**
 * #3823 + #4614: on win32, two open-time error strings are OS-level
 * environment refusals, not a corrupt file, so the generic "delete the file
 * to reset the index" advice misleads for that class (for READONLY it is
 * worse than useless — deleting may destroy the only copy of recent session
 * state in unified-full mode):
 *  - CANTOPEN ("unable to open database file"): AV/Defender lock, OneDrive
 *    placeholders, MAX_PATH, low-integrity process;
 *  - READONLY ("attempt to write a readonly database"): an EXISTING index.db
 *    opened but the first write was refused — the same integrity-control
 *    mechanism once the file already exists (#4614 field report).
 * Each hint fires exactly when win32 && its signature and stays silent
 * otherwise; when a hint fires the degrade line drops the delete advice,
 * and a genuine corrupt-file failure keeps it — all directions pinned
 * (#3617 gate discipline).
 */

const CANT_OPEN = "Error: [storage:node:sqlite] Error: unable to open database file";
// #4614/#5103 field shape: the db OPENS fine but writes are refused — same
// OS-level refusal class, different SQLite errno.
const READONLY = "Error: [storage:node:sqlite] Error: attempt to write a readonly database";

function stubPlatform(platform: string): () => void {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    return () => Object.defineProperty(process, "platform", original!);
}

test("hint: win32 + CANTOPEN carries the OS-level suspects", () => {
    const restore = stubPlatform("win32");
    try {
        const hint = sqliteOpenFailureHint(CANT_OPEN);
        assert.ok(hint.includes("win32"), "names the platform");
        assert.ok(hint.includes("antivirus"), "points at AV exclusions");
        assert.ok(hint.includes("%USERPROFILE%\\.local\\share\\billion-context\\"), "names the exclusion target");
        assert.ok(hint.includes("deleting the file will not clear a lock"), "corrects the delete-file advice");
    } finally {
        restore();
    }
});

test("hint: win32 + readonly-write points at integrity control with the CORRECT fix direction (#5103/#5154)", () => {
    const restore = stubPlatform("win32");
    try {
        const hint = sqliteOpenFailureHint(READONLY);
        assert.ok(hint.includes("win32"), "names the platform");
        assert.ok(hint.includes("integrity"), "names Windows integrity control");
        assert.ok(hint.includes("icacls"), "gives the label-check command");
        assert.ok(
            hint.includes("icacls <path-to-node.exe> /setintegritylevel Medium"),
            "the fix restores the PROCESS (node.exe) to Medium — #5154 root cause",
        );
        assert.ok(
            !hint.includes('"(OI)(CI)Low"') && !hint.includes("(OI)(CI)Low /T"),
            "must NOT advise relabeling the sessions dir Low — that direction was the #5154 trap",
        );
        assert.ok(hint.includes("do NOT delete"), "forbids deleting the live index");
    } finally {
        restore();
    }
});

test("hint: non-CANTOPEN errors stay silent even on win32", () => {
    const restore = stubPlatform("win32");
    try {
        assert.equal(sqliteOpenFailureHint("Error: [storage:node:sqlite] file is not a database"), "");
        assert.equal(
            sqliteOpenFailureHint("no SQLite engine available (node:sqlite missing, better-sqlite3 not installed)"),
            "",
        );
    } finally {
        restore();
    }
});

test("hint: non-win32 platforms stay silent even on CANTOPEN", () => {
    for (const p of ["linux", "darwin"]) {
        const restore = stubPlatform(p);
        try {
            assert.equal(sqliteOpenFailureHint(CANT_OPEN), "", `expected no hint on ${p}`);
            assert.equal(sqliteOpenFailureHint(READONLY), "", `expected no hint on ${p}`);
        } finally {
            restore();
        }
    }
});

test("hint: win32 + READONLY names integrity-control suspects and forbids deletion (#4614)", () => {
    const restore = stubPlatform("win32");
    try {
        const hint = sqliteOpenFailureHint(READONLY);
        assert.ok(hint.includes("win32"), "names the platform");
        assert.ok(hint.includes("readonly"), "echoes the failure class");
        assert.ok(hint.includes("integrity"), "points at Windows integrity control");
        assert.ok(hint.includes("icacls"), "gives the label-check command");
        assert.ok(hint.includes("do NOT delete"), "forbids deleting the live index");
    } finally {
        restore();
    }
});

test("hint: non-win32 platforms stay silent even on READONLY", () => {
    for (const p of ["linux", "darwin"]) {
        const restore = stubPlatform(p);
        try {
            assert.equal(sqliteOpenFailureHint(READONLY), "", `expected no hint on ${p}`);
        } finally {
            restore();
        }
    }
});

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

test("#3823 wiring: an unopenable index.db degrades with the platform-appropriate reason", () => {
    const base = mkdtempSync(path.join(tmpdir(), "cantopen-hint-"));
    const sessions = path.join(base, "sessions");
    mkdirSync(sessions, { recursive: true });
    // A DIRECTORY named index.db: SQLite refuses to open it (SQLITE_CANTOPEN)
    // deterministically on every platform — the same error class the field
    // reports carry, minus the environment-specific cause.
    mkdirSync(path.join(sessions, "index.db"));
    const snap = isolateEnv(base, sessions);
    const logs: string[] = [];
    setLogCapture((level, msg) => logs.push(`${level} ${msg}`));
    try {
        _resetStorageRuntimeStatusForTest();
        new SessionStore({ dir: sessions, enabled: true });
        const wire = storageStatusWire();
        assert.equal(wire.degraded, true, "the sidecar must be degraded");
        assert.equal(wire.effective, "legacy", "legacy JSON keeps serving");
        assert.ok(
            wire.reason?.startsWith("index database failed to open"),
            `reason names the open failure (got: ${wire.reason})`,
        );
        const degradeLine = logs.find((l) => l.includes("unified sidecar failed to open"));
        assert.ok(degradeLine, "the degrade warn was logged");
        if (process.platform === "win32") {
            assert.ok(wire.reason?.includes("(win32:"), "win32 runner carries the OS-level hint");
            assert.ok(
                !degradeLine.includes("delete the file to reset the index"),
                "an OS-level refusal must not carry the delete advice",
            );
        } else {
            assert.ok(!wire.reason?.includes("(win32:"), "non-win32 runner stays un-hinted");
            assert.ok(
                degradeLine.includes("; delete the file to reset the index"),
                "a genuine open failure keeps the delete advice off-hint platforms",
            );
        }
    } finally {
        setLogCapture(null);
        _resetStorageRuntimeStatusForTest();
        restoreEnv(snap);
        rmrf(base);
    }
});

// #4614: the field-reported READONLY signature — an EXISTING index.db that
// opens but refuses the first write. Deterministic cross-platform repro: a
// 0444 regular file (root bypasses permission bits, so skip under root;
// chmod is inert on win32, so skip there — the win32 branch of the hint is
// unit-pinned above with a platform stub instead).
test("#4614 wiring: an unwritable existing index.db degrades carrying the readonly signature", () => {
    if (process.platform === "win32") return;
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const base = mkdtempSync(path.join(tmpdir(), "readonly-hint-"));
    const sessions = path.join(base, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path.join(sessions, "index.db"), "");
    chmodSync(path.join(sessions, "index.db"), 0o444);
    const snap = isolateEnv(base, sessions);
    const logs: string[] = [];
    setLogCapture((level, msg) => logs.push(`${level} ${msg}`));
    try {
        _resetStorageRuntimeStatusForTest();
        new SessionStore({ dir: sessions, enabled: true });
        const wire = storageStatusWire();
        assert.equal(wire.degraded, true, "the sidecar must be degraded");
        assert.equal(wire.effective, "legacy", "legacy JSON keeps serving");
        assert.ok(
            wire.reason?.includes("attempt to write a readonly database"),
            `reason carries the readonly signature (got: ${wire.reason})`,
        );
        const degradeLine = logs.find((l) => l.includes("unified sidecar failed to open"));
        assert.ok(degradeLine, "the degrade warn was logged");
        assert.ok(!degradeLine.includes("(win32:"), "non-win32 stays un-hinted");
    } finally {
        setLogCapture(null);
        _resetStorageRuntimeStatusForTest();
        restoreEnv(snap);
        rmrf(base);
    }
});

// #3617 negative direction on ALL runners: when the OS-level hint fires
// (stubbed win32 + CANTOPEN), the degrade line must drop the delete advice —
// including for READONLY-class refusals where deleting destroys the only copy
// of recent session state in unified-full mode.
test("wiring: an OS-level refusal drops the delete advice from the degrade line", () => {
    const base = mkdtempSync(path.join(tmpdir(), "readonly-hint-"));
    const sessions = path.join(base, "sessions");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(path.join(sessions, "index.db"));
    const snap = isolateEnv(base, sessions);
    const logs: string[] = [];
    setLogCapture((level, msg) => logs.push(`${level} ${msg}`));
    const restore = stubPlatform("win32");
    try {
        _resetStorageRuntimeStatusForTest();
        new SessionStore({ dir: sessions, enabled: true });
        const wire = storageStatusWire();
        assert.ok(wire.reason?.includes("(win32:"), "stubbed win32 carries the OS-level hint in the diagnostic");
        const degradeLine = logs.find((l) => l.includes("unified sidecar failed to open"));
        assert.ok(degradeLine, "the degrade warn was logged");
        assert.ok(degradeLine.includes("(win32:"), "the warn line carries the hint");
        assert.ok(
            !degradeLine.includes("delete the file to reset the index"),
            "an OS-level refusal must not carry the delete advice",
        );
    } finally {
        restore();
        setLogCapture(null);
        _resetStorageRuntimeStatusForTest();
        restoreEnv(snap);
        rmrf(base);
    }
});
