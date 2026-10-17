/**
 * SQLite engine self-bootstrap (#2833) — hermetic suite.
 *
 * Coverage:
 *   RESOLUTION ORDER — builtin -> host -> self-downloaded -> none, including
 *                      the #2825 no-engine degrade contract under the new
 *                      detection shape.
 *   BOOTSTRAP FLOW   — happy path against a mock registry (download, sha512
 *                      verify, minimal-tarball extract, cache layout, loader
 *                      registration driving a real open), cache hit (zero
 *                      re-fetch), integrity mismatch (quarantine + cooldown),
 *                      cooldown skip + expiry, offline fail-safe, disabled
 *                      knob, legacy-mode short-circuit, unsupported platform.
 *   EXTRACTOR        — include filtering, required-file validation, path
 *                      traversal rejection, symlink rejection, non-gzip input.
 *   KNOB             — BILI_SQLITE_AUTO_DOWNLOAD > storage.sqliteAutoDownload
 *                      > default-true precedence matrix.
 *
 * Everything is local: the registry is a loopback HTTP server serving a
 * hand-built ustar tarball whose sha512 is injected through the spec seam.
 * The end-to-end REAL artifact (pinned 13.0.3 from the production registry)
 * lives in tests/e2e/e2e-sqlite-bootstrap.test.ts behind ACP_TEST_SQLITE_BOOTSTRAP=1.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { rmrf } from "./tmp-rm.ts";
import {
    clearSelfDownloadedEngineForTests,
    openSqliteDatabase,
    registerSelfDownloadedBetterSqlite3,
    setPreferredSqliteEngineForTests,
    setSqliteEnginesUnavailableForTests,
    setSqliteProbeOverridesForTests,
} from "../src/storage/driver.ts";
import {
    BOOTSTRAP_TIMEOUT_MS,
    ensureSqliteEngine,
    extractTgzToDir,
    nodeSqliteUpgradeHint,
    platformTargetKey,
    resetEngineBootstrapForTests,
    setBootstrapTimeoutMsForTests,
    setEngineBootstrapSpecForTests,
    setEngineMirrorsForTests,
    setPlatformKeyForTests,
    type BootstrapOutcome,
} from "../src/storage/engine-bootstrap.ts";
import { resolveSqliteAutoDownload } from "../src/knobs.ts";

// Same hermeticity contract as storage-engine-proofs.test.ts: a developer
// machine's real config/cache/env must not leak into these tests.
const HERMETIC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-boot-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC_ROOT, "no-config.json");
// Absent everywhere now resolves to the shadow DEFAULT (#2815 rollout flip);
// this suite needs the explicit legacy baseline (per-test legs override it).
process.env.BILI_STORAGE_UNIFIED = "legacy";
delete process.env.BILI_SQLITE_AUTO_DOWNLOAD;
delete process.env.BILI_UPDATE_REGISTRY;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_TARGETS = [
    "linux-x64", "linux-arm64",
    "linuxmusl-x64", "linuxmusl-arm64",
    "darwin-x64", "darwin-arm64",
    "win32-x64", "win32-arm64",
];

/** Stub JS stand-in for better-sqlite3's lib/index.js — satisfies the driver's
 *  BetterSqlite3Database surface well enough to drive open/wrap/close. */
const FAKE_LIB_INDEX = `module.exports = class FakeBetterSqlite3 {
    constructor(p) { this.p = p; this.open = true; }
    exec() {}
    prepare() { return { run: () => ({ changes: 1, lastInsertRowid: 1 }), get: () => ({ ok: true }), all: () => [] }; }
    transaction(fn) { const w = () => fn(); w.immediate = w; w.deferred = w; w.exclusive = w; return w; }
    pragma() {}
    close() { this.open = false; }
};`;

interface FakeTarEntry { name: string; content?: Buffer | string; dir?: boolean }

// Fixed-width ascii field writer: the source strings are pre-padded to EXACTLY
// the field width (incl. trailing NUL), so a plain copy is byte-exact.
function putAscii(buf: Buffer, s: string, off: number): void {
    Buffer.from(s, "ascii").copy(buf, off);
}

function ustarHeader(name: string, size: number, typeflag: number): Buffer {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, "ascii");
    putAscii(h, "0000755\0", 100);
    putAscii(h, "0000000\0", 108);
    putAscii(h, "0000000\0", 116);
    putAscii(h, size.toString(8).padStart(11, "0") + "\0", 124);
    putAscii(h, "00000000000\0", 136);
    h.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    putAscii(h, sum.toString(8).padStart(6, "0"), 148);
    putAscii(h, "\0 ", 154);
    h.writeUInt8(typeflag, 156);
    putAscii(h, "ustar\0", 257);
    return h;
}

function buildTgz(entries: FakeTarEntry[]): Buffer {
    const parts: Buffer[] = [];
    for (const e of entries) {
        const content = e.dir ? Buffer.alloc(0) : Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content ?? "", "utf8");
        parts.push(ustarHeader(e.name, content.length, e.dir ? 0x35 : 0x30));
        if (content.length > 0) {
            parts.push(content);
            const pad = (512 - (content.length % 512)) % 512;
            if (pad > 0) parts.push(Buffer.alloc(pad));
        }
    }
    parts.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(parts));
}

/** The fake "better-sqlite3" package: prebuilds for ALL eight targets so the
 *  suite passes on any CI OS/arch; junk.cpp proves the include filter works. */
function fakePackageTgz(): Buffer {
    const entries: FakeTarEntry[] = [
        { name: "package/package.json", content: JSON.stringify({ name: "better-sqlite3", version: "13.0.3" }) },
        { name: "package/lib/index.js", content: FAKE_LIB_INDEX },
        ...ALL_TARGETS.map((t) => ({ name: `package/prebuilds/${t}.node`, content: Buffer.from(`FAKE-NODE-BINARY:${t}`) })),
        { name: "package/src/junk.cpp", content: "int unused;" },
    ];
    return buildTgz(entries);
}

interface MockRegistry {
    base: string;
    requests: () => number;
    close(): Promise<void>;
}

async function startMockRegistry(body: Buffer, status = 200, version = "13.0.3", delayMs = 0): Promise<MockRegistry> {
    let count = 0;
    const server = http.createServer((req, res) => {
        count++;
        if (req.url !== `/better-sqlite3/-/better-sqlite3-${version}.tgz`) {
            res.writeHead(404);
            res.end();
            return;
        }
        const send = (): void => {
            if (res.writableEnded || res.destroyed) return;
            try {
                res.writeHead(status, { "content-type": "application/octet-stream" });
                res.end(body);
            } catch {
                // client aborted the download before we got here — nothing to serve
            }
        };
        if (delayMs > 0) setTimeout(send, delayMs);
        else send();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as AddressInfo;
    return {
        base: `http://127.0.0.1:${addr.port}`,
        requests: () => count,
        close: () => new Promise<void>((r) => {
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => r());
        }),
    };
}

function sha512B64(buf: Buffer): string {
    return createHash("sha512").update(buf).digest("base64");
}

/** Fresh isolated XDG cache dir; returns cleanup. */
function isolateCache(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-boot-cache-"));
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = dir;
    return dir;
}

function restoreCache(prev: string | undefined): void {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
}

/** Reset every module-level seam the suites touch. Call in each test's finally. */
function resetAllSeams(): void {
    setPreferredSqliteEngineForTests(null);
    setSqliteEnginesUnavailableForTests(false);
    setSqliteProbeOverridesForTests(null);
    clearSelfDownloadedEngineForTests();
    setEngineBootstrapSpecForTests(null);
    setEngineMirrorsForTests(null);
    setPlatformKeyForTests(null);
    setBootstrapTimeoutMsForTests(null);
    resetEngineBootstrapForTests();
}

const UNIFIED_ENV = { BILI_STORAGE_UNIFIED: "full" };

async function withRegistry(base: string, fn: () => Promise<void>): Promise<void> {
    // #3338: the engine download now walks a mirror list (configured first,
    // then builtin npm + npmmirror). Pin the list to this one mock so the
    // pre-mirror-era tests stay hermetic — a failing configured mock must
    // fail the bootstrap instead of falling through to the real registries.
    const prev = process.env.BILI_UPDATE_REGISTRY;
    process.env.BILI_UPDATE_REGISTRY = base;
    setEngineMirrorsForTests([base]);
    try {
        await fn();
    } finally {
        if (prev === undefined) delete process.env.BILI_UPDATE_REGISTRY;
        else process.env.BILI_UPDATE_REGISTRY = prev;
        setEngineMirrorsForTests(null);
    }
}

// ---------------------------------------------------------------------------
// RESOLUTION ORDER (driver level)
// ---------------------------------------------------------------------------

test("engine resolution: builtin node:sqlite wins when present (default order, #2833)", () => {
    try {
        resetAllSeams();
        setSqliteProbeOverridesForTests({ builtin: true, host: true });
        const o = openSqliteDatabase(":memory:");
        assert.equal(o.engine, "node:sqlite");
        assert.equal(o.source, "builtin");
        o.db.close();
    } finally {
        resetAllSeams();
    }
});

test("engine resolution: host better-sqlite3 chosen when builtin absent (branch proven by engine or error shape)", () => {
    try {
        resetAllSeams();
        setSqliteProbeOverridesForTests({ builtin: false, host: true });
        // The host branch must be taken: either the package is physically
        // present in this node_modules (dev machines that installed it before
        // #2825 moved it out of dependencies) and opens with source "host",
        // or it is absent (fresh CI npm ci) and the branch fails at require
        // with the [storage:better-sqlite3] shape — a node:sqlite fallback
        // would have succeeded instead, proving the order either way.
        try {
            const o = openSqliteDatabase(":memory:");
            assert.equal(o.engine, "better-sqlite3");
            assert.equal(o.source, "host");
            o.db.close();
        } catch (err) {
            assert.ok((err as Error).message.includes("[storage:better-sqlite3]"),
                `host branch must fail at require or open with the engine-tagged shape: ${err}`);
        }
    } finally {
        resetAllSeams();
    }
});

test("engine resolution: registered self-downloaded loader is usable end-to-end", () => {
    try {
        resetAllSeams();
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        const seen = { paths: [] as string[], open: true };
        registerSelfDownloadedBetterSqlite3(() => (class {
            constructor(p: string) { seen.paths.push(p); }
            exec() {}
            prepare() { return { run: () => ({ changes: 2, lastInsertRowid: 7 }), get: () => ({ v: 1 }), all: () => [] }; }
            transaction(fn: () => unknown): (() => unknown) & { immediate(): unknown; deferred(): unknown; exclusive(): unknown } {
                const w = (() => fn()) as (() => unknown) & { immediate(): unknown; deferred(): unknown; exclusive(): unknown };
                w.immediate = w; w.deferred = w; w.exclusive = w;
                return w;
            }
            pragma() {}
            get open() { return seen.open; }
            close() { seen.open = false; }
        }) as never);
        const o = openSqliteDatabase(":memory:");
        assert.equal(o.engine, "better-sqlite3");
        assert.equal(o.source, "self-downloaded");
        assert.deepEqual(seen.paths, [":memory:"]);
        const r = o.db.prepare("SELECT 1").run();
        assert.equal(r.changes, 2);
        o.db.close();
        assert.equal(seen.open, false);
    } finally {
        resetAllSeams();
    }
});

test("engine resolution: nothing available -> 'no SQLite engine available' (legacy-only contract, #2825)", () => {
    try {
        resetAllSeams();
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        assert.throws(() => openSqliteDatabase(":memory:"), (err: Error) => err.message.includes("no SQLite engine available"));
    } finally {
        resetAllSeams();
    }
});

test("engine resolution: engines-unavailable seam still short-circuits everything (#2823 pin)", () => {
    try {
        resetAllSeams();
        setSqliteEnginesUnavailableForTests(true);
        assert.throws(() => openSqliteDatabase(":memory:"), (err: Error) => err.message.includes("no SQLite engine available"));
    } finally {
        resetAllSeams();
    }
});

// ---------------------------------------------------------------------------
// BOOTSTRAP FLOW (mock registry)
// ---------------------------------------------------------------------------

test("bootstrap: happy path downloads, verifies sha, extracts, registers loader; second call is a cache hit", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.deepEqual(out.status, "downloaded", `expected downloaded, got ${JSON.stringify(out)}`);
            assert.equal(reg!.requests(), 1);

            const target = platformTargetKey();
            const dir = path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-13.0.3");
            assert.ok(fs.existsSync(path.join(dir, "package.json")), "package.json materialized");
            assert.ok(fs.existsSync(path.join(dir, "lib", "index.js")), "lib/index.js materialized");
            assert.ok(fs.existsSync(path.join(dir, "prebuilds", `${target}.node`)), "target prebuilt materialized");
            assert.ok(!fs.existsSync(path.join(dir, "src", "junk.cpp")), "excluded entry must not be materialized");
            assert.ok(!fs.existsSync(path.join(cachePrev, "billion-context", "sqlite", ".bootstrap-failed.json")), "no cooldown marker on success");

            // The registered loader must drive a real open through the driver.
            const o = openSqliteDatabase(":memory:");
            assert.equal(o.engine, "better-sqlite3");
            assert.equal(o.source, "self-downloaded");
            assert.deepEqual(o.db.prepare("SELECT 1").get(), { ok: true });
            o.db.close();

            // Cache hit: no further network traffic.
            resetEngineBootstrapForTests();
            setPreferredSqliteEngineForTests(null);
            const out2 = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out2.status, "cache-hit");
            assert.equal(reg!.requests(), 1, "cache hit must not re-download");
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: unloadable complete cache copy is removed and re-downloaded once (#3135⑤)", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        // Pre-materialize a COMPLETE cache layout whose loader throws on
        // require: cacheUsable() passes, registration fails.
        const target = platformTargetKey();
        const dir = path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-13.0.3");
        fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
        fs.mkdirSync(path.join(dir, "prebuilds"), { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "13.0.3" }));
        fs.writeFileSync(path.join(dir, "lib", "index.js"), "throw new Error('corrupted cache copy');");
        fs.writeFileSync(path.join(dir, "prebuilds", `${target}.node`), Buffer.from("FAKE-NODE-BINARY"));
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.deepEqual(out.status, "downloaded", `expected self-healing re-download, got ${JSON.stringify(out)}`);
            assert.equal(reg!.requests(), 1, "the broken copy must be replaced by one fresh download");
            // The healed copy now loads through the driver.
            const o = openSqliteDatabase(":memory:");
            assert.equal(o.engine, "better-sqlite3");
            assert.equal(o.source, "self-downloaded");
            o.db.close();
            // Second boot: healthy cache hit, no further traffic.
            resetEngineBootstrapForTests();
            setPreferredSqliteEngineForTests(null);
            const out2 = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out2.status, "cache-hit");
            assert.equal(reg!.requests(), 1);
            assert.ok(!fs.existsSync(path.join(cachePrev, "billion-context", "sqlite", ".bootstrap-failed.json")), "no cooldown marker after a successful heal");
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: freshly downloaded-but-unloadable copy arms the cooldown instead of looping (#3135⑤)", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        // The registry serves a package whose loader throws on require; the
        // spec pins THIS tgz's sha so verification passes and extraction
        // succeeds — only the final registration fails.
        const badTgz = buildTgz([
            { name: "package/package.json", content: JSON.stringify({ name: "better-sqlite3", version: "13.0.3" }) },
            { name: "package/lib/index.js", content: "throw new Error('broken build');" },
            ...ALL_TARGETS.map((t) => ({ name: `package/prebuilds/${t}.node`, content: Buffer.from(`FAKE-NODE-BINARY:${t}`) })),
        ]);
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(badTgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        reg = await startMockRegistry(badTgz);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.deepEqual(out.status, "downloaded");
            assert.equal(reg!.requests(), 1);
            const marker = path.join(cachePrev, "billion-context", "sqlite", ".bootstrap-failed.json");
            assert.ok(fs.existsSync(marker), "registration failure after a verified download must arm the cooldown");
            const body = JSON.parse(fs.readFileSync(marker, "utf8")) as { reason?: string };
            assert.match(body.reason ?? "", /failed to load/);
            // Next boot: the rm leg sees the active cooldown and stops — no
            // per-boot re-download loop against a genuinely broken build.
            resetEngineBootstrapForTests();
            setPreferredSqliteEngineForTests(null);
            const out2 = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out2.status, "cooldown");
            assert.equal(reg!.requests(), 1, "cooldown must bound the retry to one download per window");
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: sha512 mismatch quarantines the download and arms the cooldown", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const good = fakePackageTgz();
        const tampered = Buffer.from(good);
        tampered[tampered.length - 1] ^= 0xff;
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(good) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        reg = await startMockRegistry(tampered);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "failed");
            assert.match(out.detail ?? "", /sha512 mismatch/);
            const dir = path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-13.0.3");
            assert.ok(!fs.existsSync(dir), "failed download must leave no cache dir");
            const marker = path.join(cachePrev, "billion-context", "sqlite", ".bootstrap-failed.json");
            assert.ok(fs.existsSync(marker), "cooldown marker written");

            // Cooldown: immediate retry makes NO network call.
            resetEngineBootstrapForTests();
            const out2 = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out2.status, "cooldown");
            assert.equal(reg!.requests(), 1, "cooldown must suppress the retry");
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: expired cooldown re-attempts the download", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        const sqliteDir = path.join(cachePrev, "billion-context", "sqlite");
        fs.mkdirSync(sqliteDir, { recursive: true });
        fs.writeFileSync(path.join(sqliteDir, ".bootstrap-failed.json"), JSON.stringify({ atMs: Date.now() - 7 * 3600_000, reason: "stale" }));
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "downloaded", `expected download after cooldown expiry, got ${JSON.stringify(out)}`);
            assert.equal(reg!.requests(), 1);
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: stale unusable cache dir is replaced instead of looping the cooldown", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        // Partial/corrupt publish from a killed run: dir exists but lacks the
        // target prebuilt, so cacheUsable() is false and rename-over would ENOTEMPTY.
        const dir = path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-13.0.3");
        fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), "{}");
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "downloaded", `expected self-heal download, got ${JSON.stringify(out)}`);
            assert.ok(fs.existsSync(path.join(dir, "prebuilds", `${platformTargetKey()}.node`)), "stale dir replaced by a complete one");
            assert.ok(!fs.existsSync(path.join(cachePrev, "billion-context", "sqlite", ".bootstrap-failed.json")), "self-heal must not arm the cooldown");
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: production download budget comfortably covers an ~11 MB registry fetch (#3338)", () => {
    assert.ok(BOOTSTRAP_TIMEOUT_MS >= 30_000,
        `BOOTSTRAP_TIMEOUT_MS=${BOOTSTRAP_TIMEOUT_MS} too tight for an ~11 MB download over a non-trivial network (was 10 s, see #3338)`);
});

test("bootstrap: a download that outlasts its timeout budget aborts fail-safe and arms the cooldown (#3338)", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        const delayMs = 800;
        setBootstrapTimeoutMsForTests(Math.floor(delayMs / 5));
        reg = await startMockRegistry(tgz, 200, "13.0.3", delayMs);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "failed", `expected timeout failure, got ${JSON.stringify(out)}`);
            assert.match(out.detail ?? "", /abort|time/i, "failure reason names the abort/timeout");
            assert.ok(!fs.existsSync(path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-13.0.3")), "aborted download must not publish a cache dir");
            assert.ok(fs.existsSync(path.join(cachePrev, "billion-context", "sqlite", ".bootstrap-failed.json")), "aborted download arms the cooldown");
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: a slow-but-completing download succeeds once the budget covers it (#3338)", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        const delayMs = 400;
        setBootstrapTimeoutMsForTests(delayMs * 10);
        reg = await startMockRegistry(tgz, 200, "13.0.3", delayMs);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "downloaded", `expected slow download to succeed, got ${JSON.stringify(out)}`);
            assert.ok(fs.existsSync(path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-13.0.3", "package.json")), "slow download materialized");
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: offline (connection refused) degrades fail-safe with cooldown, never throws", async () => {
    const cachePrev = isolateCache();
    try {
        resetAllSeams();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: "irrelevant" });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        await withRegistry("http://127.0.0.1:1", async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "failed");
            assert.ok(!fs.existsSync(path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-13.0.3")));
            const marker = path.join(cachePrev, "billion-context", "sqlite", ".bootstrap-failed.json");
            assert.ok(fs.existsSync(marker), "offline failure arms the cooldown");
        });
    } finally {
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: disabled knob gates the fetch (cached copies would still be used)", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV, BILI_SQLITE_AUTO_DOWNLOAD: "0" } });
            assert.equal(out.status, "disabled");
            assert.equal(reg!.requests(), 0, "disabled knob must not touch the network");
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: legacy mode short-circuits before any probe or fetch", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            // Absent-everywhere now resolves to the shadow DEFAULT (#2815 rollout
            // flip), so the short-circuit needs an EXPLICIT legacy opt-out.
            const out = await ensureSqliteEngine({ env: { BILI_STORAGE_UNIFIED: "legacy" } });
            assert.equal(out.status, "not-needed");
            assert.match(out.detail ?? "", /unified storage disabled/);
            assert.equal(reg!.requests(), 0);
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: builtin present -> not-needed without touching the network", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: true, host: false });
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "not-needed");
            assert.match(out.detail ?? "", /builtin/);
            assert.equal(reg!.requests(), 0);
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: host-provided engine -> not-needed without touching the network", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: true });
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "not-needed");
            assert.match(out.detail ?? "", /host-provided/);
            assert.equal(reg!.requests(), 0);
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: unsupported platform key -> no download attempt", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        setPlatformKeyForTests("freebsd-arm64");
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "unsupported-platform");
            assert.equal(out.detail, "freebsd-arm64");
            assert.equal(reg!.requests(), 0);
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: concurrent callers share one attempt (process-dedup)", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const [a, b] = await Promise.all([
                ensureSqliteEngine({ env: { ...UNIFIED_ENV } }),
                ensureSqliteEngine({ env: { ...UNIFIED_ENV } }),
            ]);
            assert.equal(a.status, "downloaded");
            assert.equal(b.status, "downloaded");
            assert.equal(reg!.requests(), 1, "two callers must share one download");
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

// ---------------------------------------------------------------------------
// EXTRACTOR
// ---------------------------------------------------------------------------

test("extractor: rejects non-gzip input", async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "bili-boot-extract-"));
    try {
        await assert.rejects(
            () => extractTgzToDir(Buffer.from("definitely not gzip"), dest, platformTargetKey()),
            /gunzip failed/,
        );
    } finally {
        rmrf(dest);
    }
});

test("extractor: missing required prebuilt for the target fails loud", async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "bili-boot-extract-"));
    try {
        const entries: FakeTarEntry[] = [
            { name: "package/package.json", content: "{}" },
            { name: "package/lib/index.js", content: FAKE_LIB_INDEX },
            { name: "package/prebuilds/linux-x64.node", content: Buffer.from("x") },
        ];
        await assert.rejects(
            () => extractTgzToDir(buildTgz(entries), dest, "freebsd-arm64"),
            /missing required file/,
        );
    } finally {
        rmrf(dest);
    }
});

test("extractor: path traversal is rejected", async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "bili-boot-extract-"));
    try {
        const entries: FakeTarEntry[] = [
            { name: "package/package.json", content: "{}" },
            { name: "package/lib/index.js", content: FAKE_LIB_INDEX },
            { name: "package/lib/../evil.txt", content: "boom" },
            ...ALL_TARGETS.map((t) => ({ name: `package/prebuilds/${t}.node`, content: Buffer.from("x") })),
        ];
        await assert.rejects(
            () => extractTgzToDir(buildTgz(entries), dest, platformTargetKey()),
            /unsafe tar path/,
        );
    } finally {
        rmrf(dest);
    }
});

test("extractor: symlink entries are rejected (fail loud, no half-extract)", async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "bili-boot-extract-"));
    try {
        const parts: Buffer[] = [];
        const linkName = "package/lib/link.js";
        const linkTarget = "/etc/passwd";
        parts.push(ustarHeader(linkName, linkTarget.length, 0x32));
        parts.push(Buffer.from(linkTarget));
        parts.push(Buffer.alloc(1024));
        await assert.rejects(
            () => extractTgzToDir(gzipSync(Buffer.concat(parts)), dest, platformTargetKey()),
            /unsupported tar entry/,
        );
    } finally {
        rmrf(dest);
    }
});

// ---------------------------------------------------------------------------
// KNOB PRECEDENCE
// ---------------------------------------------------------------------------

test("knob: BILI_SQLITE_AUTO_DOWNLOAD > storage.sqliteAutoDownload > default true", () => {
    assert.equal(resolveSqliteAutoDownload({ BILI_SQLITE_AUTO_DOWNLOAD: "1" }, false), true, "env 1 beats file false");
    assert.equal(resolveSqliteAutoDownload({ BILI_SQLITE_AUTO_DOWNLOAD: "true" }, false), true, "env true beats file false");
    assert.equal(resolveSqliteAutoDownload({ BILI_SQLITE_AUTO_DOWNLOAD: "0" }, true), false, "env 0 beats file true");
    assert.equal(resolveSqliteAutoDownload({ BILI_SQLITE_AUTO_DOWNLOAD: "false" }, true), false, "env false beats file true");
    assert.equal(resolveSqliteAutoDownload({ BILI_SQLITE_AUTO_DOWNLOAD: "yes" }, false), false, "garbage env falls through to file");
    assert.equal(resolveSqliteAutoDownload({ BILI_SQLITE_AUTO_DOWNLOAD: "yes" }, true), true, "garbage env falls through to file");
    assert.equal(resolveSqliteAutoDownload({}, false), false, "file tier honored when env absent");
    assert.equal(resolveSqliteAutoDownload({}, true), true, "file tier honored when env absent");
    assert.equal(resolveSqliteAutoDownload({}, undefined), true, "default is enabled");
    assert.equal(resolveSqliteAutoDownload({ BILI_SQLITE_AUTO_DOWNLOAD: "" }, undefined), true, "blank env = absent");
});

// ---------------------------------------------------------------------------
// platformTargetKey sanity
// ---------------------------------------------------------------------------

test("platformTargetKey: musl detection mirrors binding.js (glibc presence decides)", () => {
    const real = platformTargetKey();
    assert.match(real, /^(linux|linuxmusl|darwin|win32)-(x64|arm64)$/, `unexpected platform key: ${real}`);
    assert.equal(platformTargetKey({ platform: "darwin", arch: "arm64" }), "darwin-arm64");
    assert.equal(platformTargetKey({ platform: "win32", arch: "x64" }), "win32-x64");
});

// ---------------------------------------------------------------------------
// Multi-mirror engine download (#3338 directive 2) + Node upgrade hint (directive 3)
// ---------------------------------------------------------------------------

test("mirror fallback: a failing first mirror falls to the next and the bootstrap succeeds (#3338)", async () => {
    const cachePrev = isolateCache();
    let bad: MockRegistry | null = null;
    let good: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        bad = await startMockRegistry(tgz, 500); // registry up, tarball broken at the HTTP layer
        good = await startMockRegistry(tgz);
        setEngineMirrorsForTests([bad.base, good.base]);
        const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
        assert.equal(out.status, "downloaded", `expected fallback success, got ${JSON.stringify(out)}`);
        assert.ok(bad.requests() >= 1, "the failing mirror was attempted first");
        assert.ok(good.requests() >= 1, "the fallback mirror served the tarball");
        assert.ok(fs.existsSync(path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-13.0.3", "package.json")), "fallback download materialized");
    } finally {
        await bad?.close();
        await good?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("mirror exhaustion: the cooldown reason lists every mirror attempted (#3338)", async () => {
    const cachePrev = isolateCache();
    let bad1: MockRegistry | null = null;
    let bad2: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        bad1 = await startMockRegistry(tgz, 500);
        bad2 = await startMockRegistry(tgz, 503);
        setEngineMirrorsForTests([bad1.base, bad2.base]);
        const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
        assert.equal(out.status, "failed", `expected exhaustion failure, got ${JSON.stringify(out)}`);
        const detail = out.detail ?? "";
        assert.ok(detail.includes(bad1.base), `reason must name the first mirror: ${detail}`);
        assert.ok(detail.includes(bad2.base), `reason must name the second mirror: ${detail}`);
        assert.match(detail, /tried mirrors: /, "reason enumerates the mirror list");
        const marker = path.join(cachePrev, "billion-context", "sqlite", ".bootstrap-failed.json");
        assert.ok(fs.existsSync(marker), "exhaustion arms the cooldown");
    } finally {
        await bad1?.close();
        await bad2?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("mirror list: a configured registry is attempted before the builtins (#3338)", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        reg = await startMockRegistry(tgz);
        // Deliberately NO mirrors override: the production list must put the
        // configured registry first. The mock SUCCEEDS, so the loop breaks
        // before ever reaching the builtin production registries (no network).
        // If the ordering regressed (builtins first), CI's real egress would
        // serve the tarball and this mock would record zero requests.
        const prev = process.env.BILI_UPDATE_REGISTRY;
        process.env.BILI_UPDATE_REGISTRY = reg.base;
        try {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "downloaded", `expected configured-first success, got ${JSON.stringify(out)}`);
            assert.equal(reg!.requests(), 1, "the configured registry was the one (and only) mirror hit");
        } finally {
            if (prev === undefined) delete process.env.BILI_UPDATE_REGISTRY;
            else process.env.BILI_UPDATE_REGISTRY = prev;
        }
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("nodeSqliteUpgradeHint: pins the Node >= 22.5 threshold and the levers (#3338 directive 3)", () => {
    assert.equal(nodeSqliteUpgradeHint("22.5.0"), "", "22.5.0 ships node:sqlite — no hint");
    assert.equal(nodeSqliteUpgradeHint("23.0.0"), "", "23.x ships node:sqlite — no hint");
    assert.equal(nodeSqliteUpgradeHint("24.11.0"), "", "24.x ships node:sqlite — no hint");
    const old = nodeSqliteUpgradeHint("20.20.2");
    assert.match(old, /Node\.js >= 22\.5/, "the #3385 node version gets the upgrade lever");
    assert.match(old, /npmmirror/, "the hint names the builtin mirrors");
    assert.match(old, /BILI_UPDATE_REGISTRY/, "the hint names the registry override");
    assert.match(nodeSqliteUpgradeHint("22.4.9"), /Node\.js >= 22\.5/, "22.4.x predates node:sqlite");
    assert.match(nodeSqliteUpgradeHint("19.9.9"), /Node\.js >= 22\.5/, "19.x predates node:sqlite");
    assert.equal(nodeSqliteUpgradeHint("22.5.1"), "", "22.5.1 ships node:sqlite — no hint");
});
