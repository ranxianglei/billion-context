import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gcDebugDir, type DumpGcPolicy } from "../src/state-gc.ts";
import { rmrf } from "./tmp-rm.ts";

// #2412: retention GC for debug dump dirs. Core contract under test:
//   - default-off semantics (empty policy never deletes anything);
//   - FIFO-by-mtime trim with deterministic name tiebreak;
//   - age bound applies before the byte bound, both can be active;
//   - err-*/summary-err-* incident dumps are never touched;
//   - 30 s per-dir throttle keeps repeated calls cheap;
//   - best-effort: missing dirs / subdirectories never throw.

const NOW = Date.parse("2026-10-10T00:00:00Z");
const HOUR = 3_600_000;
const KB = 1024;

function makeFile(dir: string, name: string, sizeBytes: number, ageMs: number): void {
    const p = path.join(dir, name);
    writeFileSync(p, "x".repeat(sizeBytes));
    const t = new Date(NOW - ageMs);
    utimesSync(p, t, t);
}

function names(dir: string): string[] {
    return readdirSync(dir).sort();
}

test("empty policy deletes nothing; missing dir is a no-op", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-stategc-off-"));
    try {
        makeFile(dir, "a.txt", 5 * KB, HOUR);
        assert.equal(gcDebugDir(dir, {}, NOW), 0);
        assert.deepEqual(names(dir), ["a.txt"]);
        assert.equal(gcDebugDir("/nonexistent/bili-stategc-missing", { maxBytes: 1 }, NOW), 0);
    } finally { rmrf(dir); }
});

test("byte cap trims oldest-first until under the bound", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-stategc-bytes-"));
    try {
        makeFile(dir, "f-d.txt", 100 * KB, 1 * HOUR);
        makeFile(dir, "f-c.txt", 100 * KB, 2 * HOUR);
        makeFile(dir, "f-b.txt", 100 * KB, 3 * HOUR);
        makeFile(dir, "f-a.txt", 100 * KB, 4 * HOUR);
        // 400 KB total > 250 KB cap → drop f-a, then f-b → 200 KB left.
        const policy: DumpGcPolicy = { maxBytes: 250 * KB };
        assert.equal(gcDebugDir(dir, policy, NOW), 2);
        assert.deepEqual(names(dir), ["f-c.txt", "f-d.txt"]);
    } finally { rmrf(dir); }
});

test("age bound drops everything older than the cutoff regardless of bytes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-stategc-age-"));
    try {
        makeFile(dir, "young.txt", KB, 30 * 60_000);
        makeFile(dir, "mid.txt", KB, 2 * HOUR);
        makeFile(dir, "old.txt", KB, 3 * 24 * HOUR);
        assert.equal(gcDebugDir(dir, { maxAgeMs: 1 * HOUR }, NOW), 2);
        assert.deepEqual(names(dir), ["young.txt"]);
    } finally { rmrf(dir); }
});

test("combined policy: age pass first, then byte pass on survivors", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-stategc-combined-"));
    try {
        makeFile(dir, "old-big.txt", 90 * KB, 2 * 24 * HOUR);
        makeFile(dir, "mid.txt", 60 * KB, 2 * HOUR);
        makeFile(dir, "young.txt", 60 * KB, 10 * 60_000);
        // Age pass drops old-big; survivors 120 KB > 100 KB → drop mid.
        assert.equal(gcDebugDir(dir, { maxBytes: 100 * KB, maxAgeMs: 1 * HOUR }, NOW), 2);
        assert.deepEqual(names(dir), ["young.txt"]);
    } finally { rmrf(dir); }
});

test("err-* and summary-err-* incident dumps are never deleted", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-stategc-protected-"));
    try {
        makeFile(dir, "err-111-sid-400.json", 90 * KB, 5 * 24 * HOUR);
        makeFile(dir, "summary-err-222-sid-400.json", 90 * KB, 4 * 24 * HOUR);
        makeFile(dir, "plain-old.txt", 90 * KB, 3 * 24 * HOUR);
        makeFile(dir, "plain-new.txt", 10 * KB, 60_000);
        // Unprotected total 100 KB > 100_000 cap → only plain-old goes; the
        // older, larger incident dumps survive.
        assert.equal(gcDebugDir(dir, { maxBytes: 100_000 }, NOW), 1);
        assert.deepEqual(names(dir), ["err-111-sid-400.json", "plain-new.txt", "summary-err-222-sid-400.json"]);
    } finally { rmrf(dir); }
});

test("per-dir throttle skips re-sweeps within 30 s", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-stategc-throttle-"));
    try {
        makeFile(dir, "a.txt", 100 * KB, 4 * HOUR);
        makeFile(dir, "b.txt", 100 * KB, 3 * HOUR);
        assert.equal(gcDebugDir(dir, { maxBytes: 100 * KB }, NOW), 1);
        // A new over-cap file lands while throttled: not swept yet.
        makeFile(dir, "c.txt", 100 * KB, 2 * HOUR);
        assert.equal(gcDebugDir(dir, { maxBytes: 100 * KB }, NOW + 10_000), 0);
        assert.ok(readdirSync(dir).includes("c.txt"));
        // After the window elapses the next visit sweeps again: oldest-first
        // means the older survivor goes, not the newer over-cap file.
        assert.equal(gcDebugDir(dir, { maxBytes: 100 * KB }, NOW + 31_000), 1);
        assert.deepEqual(names(dir), ["c.txt"]);
    } finally { rmrf(dir); }
});

test("equal mtimes break ties by name (deterministic)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-stategc-tie-"));
    try {
        makeFile(dir, "b.txt", 60 * KB, HOUR);
        makeFile(dir, "a.txt", 60 * KB, HOUR);
        // 120 KB > 70 KB → exactly one file goes: the alphabetically first.
        assert.equal(gcDebugDir(dir, { maxBytes: 70_000 }, NOW), 1);
        assert.deepEqual(names(dir), ["b.txt"]);
    } finally { rmrf(dir); }
});

test("subdirectories are ignored (dump dirs are flat-file)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-stategc-subdir-"));
    try {
        const sub = path.join(dir, "nested");
        mkdirSync(sub);
        writeFileSync(path.join(sub, "inner.txt"), "y".repeat(500 * KB));
        makeFile(dir, "top.txt", 10 * KB, HOUR);
        assert.equal(gcDebugDir(dir, { maxBytes: 1 }, NOW), 1);
        assert.deepEqual(names(dir), ["nested"]);
        assert.deepEqual(readdirSync(sub), ["inner.txt"]);
    } finally { rmrf(dir); }
});
