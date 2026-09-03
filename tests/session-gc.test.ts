import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import { gcSessionFiles, gcOptionsFromEnv } from "../src/session-gc.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { initSessions, _resetSessionsForTest, _sessionsSizeForTest } from "../src/session.ts";
import type { Session } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

const DAY = 86_400_000;

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
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

function jsonFilesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        if (name.startsWith(".tmp-")) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...jsonFilesUnder(full));
        else if (name.endsWith(".json")) out.push(full);
    }
    return out;
}

function withTempDir<T>(name: string, fn: (dir: string) => Promise<T> | T): Promise<void> {
    return test(name, async () => {
        const dir = mkdtempSync(join(tmpdir(), "bili-session-gc-"));
        try {
            await fn(dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
}

function touchAt(file: string, msAgo: number, size = 1000): void {
    writeFileSync(file, "x".repeat(size));
    const t = new Date(Date.now() - msAgo);
    utimesSync(file, t, t);
}

await withTempDir("retention pass deletes expired units, keeps fresh", (dir) => {
    const now = Date.now();
    const oldA = join(dir, "old-a.json");
    const oldB = join(dir, "old-b.json");
    const fresh = join(dir, "fresh.json");
    touchAt(oldA, 100 * DAY);
    touchAt(oldB, 91 * DAY);
    touchAt(fresh, 1 * DAY);
    const res = gcSessionFiles(dir, { retentionMs: 90 * DAY, maxBytes: 0, nowMs: now })!;
    assert.ok(!existsSync(oldA), "100d-old file removed");
    assert.ok(!existsSync(oldB), "91d-old file removed");
    assert.ok(existsSync(fresh), "fresh file kept");
    assert.equal(res.deletedUnits, 2);
    assert.equal(res.deletedFiles, 2);
    assert.equal(res.bytesFreed, 2000);
    assert.equal(res.remainingBytes, 1000);
});

await withTempDir("budget pass drops oldest units until under maxBytes", (dir) => {
    const now = Date.now();
    // 4 fresh-ish files of 10KB each (total 40KB > 25KB budget), distinct ages.
    const f1 = join(dir, "a.json");
    const f2 = join(dir, "b.json");
    const f3 = join(dir, "c.json");
    const f4 = join(dir, "d.json");
    touchAt(f1, 4 * DAY, 10_000);
    touchAt(f2, 3 * DAY, 10_000);
    touchAt(f3, 2 * DAY, 10_000);
    touchAt(f4, 1 * DAY, 10_000);
    const res = gcSessionFiles(dir, { retentionMs: 0, maxBytes: 25_000, nowMs: now })!;
    assert.ok(!existsSync(f1) && !existsSync(f2), "two oldest dropped");
    assert.ok(existsSync(f3) && existsSync(f4), "newest two kept");
    assert.equal(res.deletedUnits, 2);
    assert.equal(res.remainingBytes, 20_000);
});

await withTempDir("both passes disabled (0/0) deletes nothing", (dir) => {
    const now = Date.now();
    const old = join(dir, "ancient.json");
    touchAt(old, 999 * DAY, 10_000);
    const res = gcSessionFiles(dir, { retentionMs: 0, maxBytes: 0, nowMs: now })!;
    assert.ok(existsSync(old));
    assert.equal(res.deletedUnits, 0);
});

await withTempDir("canonical + spill sibling form one unit (age = newest mtime)", (dir) => {
    const now = Date.now();
    const main = join(dir, "sess.json");
    const spill = join(dir, "sess.fb.json");
    touchAt(main, 100 * DAY, 4000);
    touchAt(spill, 1 * DAY, 6000);
    let res = gcSessionFiles(dir, { retentionMs: 90 * DAY, maxBytes: 0, nowMs: now })!;
    assert.ok(existsSync(main) && existsSync(spill), "recent spill keeps the whole unit alive");
    assert.equal(res.deletedUnits, 0);
    // Now age both past retention → both files removed together.
    const t = new Date(now - 100 * DAY);
    utimesSync(main, t, t);
    utimesSync(spill, t, t);
    res = gcSessionFiles(dir, { retentionMs: 90 * DAY, maxBytes: 0, nowMs: now })!;
    assert.ok(!existsSync(main) && !existsSync(spill), "unit deleted as a pair");
    assert.equal(res.deletedUnits, 1);
    assert.equal(res.deletedFiles, 2);
});

await withTempDir(".tmp-* in-flight files are never touched", (dir) => {
    const now = Date.now();
    const tmp = join(dir, ".tmp-pending.json");
    touchAt(tmp, 999 * DAY);
    const res = gcSessionFiles(dir, { retentionMs: 90 * DAY, maxBytes: 100, nowMs: now });
    assert.ok(existsSync(tmp), ".tmp- file untouched even under budget pressure");
    assert.equal(res?.deletedFiles ?? 0, 0);
});

await withTempDir("missing or empty dir returns null without throwing", () => {
    assert.equal(gcSessionFiles(join(tmpdir(), "does-not-exist-bili-gc"), { retentionMs: 90 * DAY, maxBytes: 100 }), null);
    const empty = mkdtempSync(join(tmpdir(), "bili-session-gc-empty-"));
    try {
        assert.equal(gcSessionFiles(empty, { retentionMs: 90 * DAY, maxBytes: 100 }), null);
    } finally {
        rmSync(empty, { recursive: true, force: true });
    }
});

await withTempDir("gcOptionsFromEnv: defaults 90d / 1GiB, overrides incl. 0=off", () => {
    const d = gcOptionsFromEnv();
    assert.equal(d.retentionMs, 90 * DAY);
    assert.equal(d.maxBytes, 1024 * 1024 * 1024);
    process.env.BILI_SESSION_RETENTION_DAYS = "0";
    process.env.BILI_SESSION_MAX_BYTES = "1048576";
    try {
        const o = gcOptionsFromEnv();
        assert.equal(o.retentionMs, 0);
        assert.equal(o.maxBytes, 1_048_576);
    } finally {
        delete process.env.BILI_SESSION_RETENTION_DAYS;
        delete process.env.BILI_SESSION_MAX_BYTES;
    }
});

// Acceptance (#407): a directory holding 300 expired session files plus 5
// live ones. One startup must (a) remove the expired files BEFORE any read,
// (b) parse/load only the 5 survivors, and (c) leave the total stable across
// boots. If the expired files were ever parsed they would land in the pool
// (MAX_SESSIONS raised above 305), so pool size is the read probe.
await withTempDir("startup: 300 expired files GC'd before the single load pass, total stays stable", async (dir) => {
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    _resetSessionsForTest(1000);
    const lines: string[] = [];
    setLogCapture((level, msg) => lines.push(`${level}: ${msg}`));
    try {
        const past = new Date(Date.now() - 120 * DAY);
        for (let i = 0; i < 300; i++) {
            const s = makeSession(`expired-${i}`);
            s.stats.requests = 1000 + i;
            await store.writeNow(s);
        }
        for (const f of jsonFilesUnder(dir)) utimesSync(f, past, past);
        for (let i = 0; i < 5; i++) {
            const s = makeSession(`fresh-${i}`);
            s.stats.requests = 500 + i;
            await store.writeNow(s);
        }
        assert.equal(jsonFilesUnder(dir).length, 305, "fixture: 300 expired + 5 fresh");

        await initSessions();
        assert.equal(_sessionsSizeForTest(), 5, "only the 5 fresh sessions were loaded (expired never parsed)");
        assert.equal(jsonFilesUnder(dir).length, 5, "expired files removed before load");
        assert.ok(lines.some((l) => l.includes("[gc]") && l.includes("removed 300")), "GC logged the sweep");

        _resetSessionsForTest(1000);
        const before = jsonFilesUnder(dir).length;
        await initSessions();
        assert.equal(_sessionsSizeForTest(), 5, "second boot loads the same 5");
        assert.equal(jsonFilesUnder(dir).length, before, "second boot changes nothing on disk");
        const sample = readFileSync(jsonFilesUnder(dir)[0], "utf8");
        assert.ok(sample.length > 0, "surviving files intact");
    } finally {
        setLogCapture(null);
        store.cancelAll();
        _resetSessionsForTest();
    }
});
