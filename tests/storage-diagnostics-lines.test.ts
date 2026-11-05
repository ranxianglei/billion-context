/**
 * Storage diagnostics blob lines (#3040 surface, #3788 additions) — hermetic.
 *
 * Pins the `--- storage ---` block rendered by storageDiagnosticsLines(),
 * specifically the bootstrap-failure-marker lines: the absolute cooldown
 * expiry time and the force-retry lever (delete the marker file and restart)
 * must be visible whenever a failure marker exists on disk (#3788: the user
 * had to wait out a full 6h cooldown armed by an OLDER version without any
 * way to see WHEN it expires or how to skip it).
 *
 * Both directions asserted per gate discipline: marker present -> lines
 * present with exact values; marker absent -> neither line appears.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmrf } from "./tmp-rm.ts";
import { _resetStorageRuntimeStatusForTest, storageDiagnosticsLines } from "../src/storage/runtime-status.ts";
import { COOLDOWN_MS } from "../src/storage/engine-bootstrap.ts";

// Same hermeticity contract as storage-engine-bootstrap.test.ts: a developer
// machine's real config must not leak into these tests (own process per file).
const HERMETIC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-diag-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC_ROOT, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "shadow";
delete process.env.BILI_SQLITE_AUTO_DOWNLOAD;
delete process.env.BILI_UPDATE_REGISTRY;

/** Fresh isolated XDG cache dir; returns cleanup. */
function isolateCache(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-diag-cache-"));
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = dir;
    return dir;
}

function restoreCache(prev: string | undefined): void {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
}

function resetAll(): void {
    _resetStorageRuntimeStatusForTest();
}

function lines(): string[] {
    return storageDiagnosticsLines({ sessions: 0, storageLogLines: [] });
}

test("diagnostics: no failure marker -> no marker lines at all", () => {
    const cachePrev = isolateCache();
    try {
        resetAll();
        const out = lines();
        assert.ok(!out.some((l) => l.includes("bootstrap failure marker:")), `marker line must be absent: ${out.filter((l) => l.includes("marker")).join(" | ")}`);
        assert.ok(!out.some((l) => l.startsWith("force immediate retry:")), "force-retry hint must be absent");
    } finally {
        resetAll();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("diagnostics: fresh marker -> expiry timestamp and force-retry path pinned (#3788)", () => {
    const cachePrev = isolateCache();
    try {
        const sqliteDir = path.join(cachePrev, "billion-context", "sqlite");
        const marker = path.join(sqliteDir, ".bootstrap-failed.json");
        const atMs = Date.now() - 5 * 60_000;
        fs.mkdirSync(sqliteDir, { recursive: true });
        fs.writeFileSync(marker, JSON.stringify({ atMs, reason: "The operation was aborted due to timeout" }));
        resetAll();
        const out = lines();
        const markerLine = out.find((l) => l.startsWith("bootstrap failure marker:"));
        assert.ok(markerLine, `marker line missing: ${out.join(" | ")}`);
        assert.ok(markerLine.includes(`at=${new Date(atMs).toISOString()}`), `at= not exact: ${markerLine}`);
        assert.ok(markerLine.includes(`reason="The operation was aborted due to timeout"`), `reason not quoted verbatim: ${markerLine}`);
        const expiryIso = new Date(atMs + COOLDOWN_MS).toISOString();
        assert.ok(markerLine.includes(`until ${expiryIso}`), `absolute cooldown expiry missing/wrong: ${markerLine}`);
        assert.match(markerLine, /\(cooldown ~\d+m remaining, until /, "relative remaining kept next to the absolute expiry");
        const retryLine = out.find((l) => l.startsWith("force immediate retry:"));
        assert.ok(retryLine, `force-retry hint missing: ${out.join(" | ")}`);
        assert.ok(retryLine.endsWith(`delete ${marker} and restart`), `marker path not named exactly: ${retryLine}`);
    } finally {
        resetAll();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("diagnostics: expired marker -> line present without the remaining-suffix, retry lever still shown", () => {
    const cachePrev = isolateCache();
    try {
        const sqliteDir = path.join(cachePrev, "billion-context", "sqlite");
        const marker = path.join(sqliteDir, ".bootstrap-failed.json");
        const atMs = Date.now() - 7 * 3600_000;
        fs.mkdirSync(sqliteDir, { recursive: true });
        fs.writeFileSync(marker, JSON.stringify({ atMs, reason: "offline" }));
        resetAll();
        const out = lines();
        const markerLine = out.find((l) => l.startsWith("bootstrap failure marker:"));
        assert.ok(markerLine, `marker line missing: ${out.join(" | ")}`);
        assert.ok(!markerLine.includes("remaining"), `expired marker must not claim remaining cooldown: ${markerLine}`);
        assert.ok(out.some((l) => l.startsWith(`force immediate retry: delete ${marker}`)), "force-retry lever still visible for an expired-but-present marker");
    } finally {
        resetAll();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});
