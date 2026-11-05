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
 *   NODE BANDS       — the #3894 per-major artifact table: Node 20 downloads
 *                      the JS-only 12.9.0 tarball PLUS its ABI-keyed prebuild
 *                      and binds it through `nativeBinding`; a prebuild whose
 *                      ABI does not match the running Node is refused before
 *                      any download; a pinned prebuild-less artifact keeps the
 *                      single-tarball lane and never touches the binary mirror.
 *                      A Node that passes the major floor but predates the
 *                      artifact's N-API version falls through to the next
 *                      band; ABI-keyed artifacts cache per ABI so a second
 *                      runtime never inherits the wrong binding.
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
    extractPrebuildTgz,
    extractTgzToDir,
    nodeMajorSatisfiesFloor,
    pinnedEngineVersionFor,
    nodeSqliteUpgradeHint,
    platformTargetKey,
    resetEngineBootstrapForTests,
    setBootstrapTimeoutMsForTests,
    setEngineBootstrapSpecForTests,
    setEngineMirrorsForTests,
    setPlatformKeyForTests,
    setPrebuildMirrorsForTests,
    type BootstrapOutcome,
} from "../src/storage/engine-bootstrap.ts";
import { resolveSqliteAutoDownload } from "../src/knobs.ts";

// Same hermeticity contract as storage-engine-proofs.test.ts: a developer
// machine's real config/cache/env must not leak into these tests.
const HERMETIC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-boot-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC_ROOT, "no-config.json");
// Absent everywhere now resolves to the full DEFAULT (#3818 flip; before that the
// #2815 rollout flip made shadow the default);
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
    setPrebuildMirrorsForTests(null);
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
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

test("#3818 unloadable cached copy is removed and a pinned download is retried (#3135-5)", async () => {
    let reg: MockRegistry | undefined;
    const cachePrev = process.env.XDG_CACHE_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-boot-cache-"));
    process.env.XDG_CACHE_HOME = dir;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const target = platformTargetKey();
            // A cache that PASSES cacheUsable() (files exist) but cannot load:
            // lib/index.js is present but syntactically broken — exactly the
            // "cached copy unloadable" state after e.g. a truncated copy or a
            // platform change.
            const cached = path.join(dir, "billion-context", "sqlite", "better-sqlite3-13.0.3");
            fs.mkdirSync(path.join(cached, "lib"), { recursive: true });
            fs.mkdirSync(path.join(cached, "prebuilds"), { recursive: true });
            fs.writeFileSync(path.join(cached, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "13.0.3" }));
            fs.writeFileSync(path.join(cached, "lib", "index.js"), "this is { not valid javascript !!!");
            fs.writeFileSync(path.join(cached, "prebuilds", `${target}.node`), Buffer.from("FAKE-NODE-BINARY"));

            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "downloaded", `unloadable cache must be replaced by a pinned re-download, got ${JSON.stringify(out)}`);
            assert.ok(reg!.requests() >= 1, "the pinned mirror was consulted for the retry");
            const o = openSqliteDatabase(":memory:");
            assert.equal(o.engine, "better-sqlite3");
            o.db.close();
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(dir);
    }
});

test("#3818 review: download ok but post-download registration fails -> 'failed' + cooldown, never a lying 'downloaded'", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        // A tarball whose bytes pass sha512 verification and extract cleanly,
        // but whose lib/index.js throws on require — the AV-quarantine /
        // truncated-extract state the #3818 review fix covers.
        const entries: FakeTarEntry[] = [
            { name: "package/package.json", content: JSON.stringify({ name: "better-sqlite3", version: "13.0.3" }) },
            { name: "package/lib/index.js", content: "throw new Error('prebuild broken');" },
            ...ALL_TARGETS.map((t) => ({ name: `package/prebuilds/${t}.node`, content: Buffer.from(`FAKE-NODE-BINARY:${t}`) })),
        ];
        const tgz = buildTgz(entries);
        setEngineBootstrapSpecForTests({ version: "13.0.3", minNodeMajor: 22, sha512Base64: sha512B64(tgz) });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "failed", `registration failure must report failed, got ${JSON.stringify(out)}`);
            assert.match(out.detail ?? "", /post-download registration failed/);
            const dir = path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-13.0.3");
            assert.ok(fs.existsSync(dir), "the verified bytes remain on disk");
            const marker = path.join(cachePrev, "billion-context", "sqlite", ".bootstrap-failed.json");
            assert.ok(fs.existsSync(marker), "cooldown armed for the broken environment");
            // Next boot: the unloadable cache is removed by #3135-5, but the
            // cooldown must still gate any re-download of ~11 MB.
            resetEngineBootstrapForTests();
            const out2 = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out2.status, "cooldown", `cooldown must gate the retry, got ${JSON.stringify(out2)}`);
            assert.equal(reg!.requests(), 1, "no re-download while in cooldown");
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(good), minNodeMajor: 20 });
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: "irrelevant", minNodeMajor: 20 });
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            // Absent-everywhere now resolves to the full DEFAULT (#3818 flip; #2815 rollout
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
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
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
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

// ---------------------------------------------------------------------------
// Artifact Node floor (#3341): better-sqlite3 v13 declares `engines: node >= 22`
// and faults the process on Node 20 instead of failing cleanly, so the pinned
// spec carries that floor and the bootstrap refuses BOTH the download and the
// cached-copy registration below it.
// ---------------------------------------------------------------------------

test("nodeMajorSatisfiesFloor: both directions of the artifact floor (#3341)", () => {
    assert.equal(nodeMajorSatisfiesFloor(22, "20.19.5"), false, "Node 20 is below the v13 floor");
    assert.equal(nodeMajorSatisfiesFloor(22, "18.20.8"), false, "Node 18 is below the v13 floor");
    assert.equal(nodeMajorSatisfiesFloor(22, "22.0.0"), true, "Node 22 satisfies the floor");
    assert.equal(nodeMajorSatisfiesFloor(22, "22.4.9"), true, "the floor is a MAJOR floor - 22.x minors all pass");
    assert.equal(nodeMajorSatisfiesFloor(22, "24.11.0"), true, "Node 24 satisfies the floor");
    assert.equal(nodeMajorSatisfiesFloor(20, "20.19.5"), true, "the predicate tracks the floor it is given, not a hardcoded 22");
    assert.equal(nodeMajorSatisfiesFloor(22, "garbage"), true, "an unparseable runtime must not brick unified storage");
});

test("bootstrap: below the artifact Node floor -> unsupported-node, no download, no cache registration (#3341)", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        // minNodeMajor above ANY Node that could run this suite: the gate must
        // fire regardless of which runtime CI uses (ubuntu/windows x 22/24).
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 99 });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "unsupported-node", `expected the floor gate, got ${JSON.stringify(out)}`);
            assert.match(out.detail ?? "", /better-sqlite3@13\.0\.3 needs Node\.js >= 99/, "the detail names the artifact and its floor");
            assert.equal(reg!.requests(), 0, "below the floor the ~11 MB download must never start");
            assert.ok(!fs.existsSync(path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-13.0.3")), "nothing materialized into the cache");
            assert.ok(!fs.existsSync(path.join(cachePrev, "billion-context", "sqlite", ".bootstrap-failed.json")), "a too-old Node is not a download failure - no cooldown armed");
            assert.throws(() => openSqliteDatabase(":memory:"), /no SQLite engine available/i, "no loader was registered");
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: a cache that already exists is left in place (and unregistered) below the floor (#3341)", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 99 });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        const target = platformTargetKey();
        const cached = path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-13.0.3");
        fs.mkdirSync(path.join(cached, "lib"), { recursive: true });
        fs.mkdirSync(path.join(cached, "prebuilds"), { recursive: true });
        fs.writeFileSync(path.join(cached, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "13.0.3" }));
        fs.writeFileSync(path.join(cached, "lib", "index.js"), FAKE_LIB_INDEX);
        fs.writeFileSync(path.join(cached, "prebuilds", `${target}.node`), Buffer.from("FAKE-NODE-BINARY"));
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "unsupported-node", `expected the floor gate, got ${JSON.stringify(out)}`);
            assert.equal(reg!.requests(), 0, "a cache hit below the floor must not trigger a re-download either");
            assert.ok(fs.existsSync(path.join(cached, "prebuilds", `${target}.node`)), "the cached copy must survive: a Node upgrade makes it valid again");
            assert.throws(() => openSqliteDatabase(":memory:"), /no SQLite engine available/i, "a cache below the floor must never be registered");
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: at/above the artifact Node floor the gate does NOT fire (#3341 negative case)", async () => {
    const cachePrev = isolateCache();
    let reg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        reg = await startMockRegistry(tgz);
        await withRegistry(reg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "downloaded", `a satisfied floor must not block the bootstrap, got ${JSON.stringify(out)}`);
            assert.equal(reg!.requests(), 1, "the download proceeded");
            const o = openSqliteDatabase(":memory:");
            assert.equal(o.engine, "better-sqlite3");
            assert.equal(o.source, "self-downloaded");
            o.db.close();
        });
    } finally {
        await reg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

// ---------------------------------------------------------------------------
// Per-Node-major artifact table (#3894): a JS-only npm tarball (v12 and
// earlier) ships no binding at all, so the bootstrap must ALSO fetch the
// ABI-keyed prebuild and bind it through v12's `nativeBinding` option. Getting
// this wrong is what the whole issue is about: registering a binding whose
// floor/ABI does not match the running Node kills the process uncatchably.
// ---------------------------------------------------------------------------

/** Stub v12 lib: throws unless the loader injected a `nativeBinding` PATH —
 *  the injection is the contract under test, and a path (not an addon object)
 *  keeps `dlopen` inside the constructor v12 itself owns. */
const FAKE_V12_LIB_INDEX = `const fs = require('node:fs');
module.exports = class FakeBetterSqlite3V12 {
    constructor(p, options) {
        if (!options || typeof options.nativeBinding !== 'string') {
            throw new Error('FAKE v12: nativeBinding path was not injected');
        }
        if (!fs.existsSync(options.nativeBinding)) {
            throw new Error('FAKE v12: nativeBinding path does not exist: ' + options.nativeBinding);
        }
        this.bindingPath = options.nativeBinding;
        this.p = p;
        this.open = true;
    }
    exec() {}
    prepare() { return { run: () => ({ changes: 1, lastInsertRowid: 1 }), get: () => ({ ok: true }), all: () => [] }; }
    transaction(fn) { const w = () => fn(); w.immediate = w; w.deferred = w; w.exclusive = w; return w; }
    pragma() {}
    close() { this.open = false; }
};`;

/** JS-only npm tarball shape (v12): package.json + lib/, NO prebuilds/. */
function fakeJsOnlyPackageTgz(): Buffer {
    return buildTgz([
        { name: "package/package.json", content: JSON.stringify({ name: "better-sqlite3", version: "12.9.0" }) },
        { name: "package/lib/index.js", content: FAKE_V12_LIB_INDEX },
        { name: "package/lib/database.js", content: "module.exports = require('./index.js');" },
        { name: "package/deps/sqlite3.c", content: "int unused;" },
    ]);
}

/** ABI-keyed prebuild shape: one `build/Release/better_sqlite3.node`. */
function fakePrebuildTgz(): Buffer {
    return buildTgz([{ name: "build/Release/better_sqlite3.node", content: Buffer.from("FAKE-ABI-NODE-BINARY") }]);
}

async function startMockBinaryMirror(body: Buffer, version: string, abi: string, target: string): Promise<MockRegistry> {
    const expected = `/v${version}/better-sqlite3-v${version}-node-v${abi}-${target}.tar.gz`;
    let count = 0;
    const server = http.createServer((req, res) => {
        count++;
        if (req.url !== expected) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(body);
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

test("extractor: ABI prebuild tarball lands at prebuilds/<target>.node", async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "bili-boot-extract-"));
    try {
        const target = platformTargetKey();
        await extractPrebuildTgz(fakePrebuildTgz(), dest, target);
        assert.ok(fs.existsSync(path.join(dest, "prebuilds", `${target}.node`)), "the binding is published where cacheUsable() and the v12 loader look");
    } finally {
        rmrf(dest);
    }
});

test("extractor: an ABI prebuild tarball with no .node binding fails loud", async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "bili-boot-extract-"));
    try {
        const tgz = buildTgz([{ name: "build/Release/README.md", content: "no binding here" }]);
        await assert.rejects(() => extractPrebuildTgz(tgz, dest, platformTargetKey()), /missing a \.node binding/);
    } finally {
        rmrf(dest);
    }
});

test("bootstrap: a JS-only artifact downloads its ABI prebuild and binds it via nativeBinding (#3894)", async () => {
    const cachePrev = isolateCache();
    let npmReg: MockRegistry | null = null;
    let binReg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const target = platformTargetKey();
        const abi = process.versions.modules;
        const npmTgz = fakeJsOnlyPackageTgz();
        const preTgz = fakePrebuildTgz();
        setEngineBootstrapSpecForTests({
            version: "12.9.0",
            sha512Base64: sha512B64(npmTgz),
            minNodeMajor: 20,
            prebuild: { sha512Base64ByAbi: { [abi]: { [target]: sha512B64(preTgz) } } },
        });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        npmReg = await startMockRegistry(npmTgz, 200, "12.9.0");
        binReg = await startMockBinaryMirror(preTgz, "12.9.0", abi, target);
        setPrebuildMirrorsForTests([binReg.base]);
        await withRegistry(npmReg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "downloaded", `the JS-only lane must install, got ${JSON.stringify(out)}`);
            assert.equal(npmReg!.requests(), 1, "the npm tarball was fetched");
            assert.equal(binReg!.requests(), 1, "the ABI prebuild was fetched from the binary mirror");
            const cached = path.join(cachePrev, "billion-context", "sqlite", `better-sqlite3-12.9.0-abi${abi}`);
            assert.ok(fs.existsSync(path.join(cached, "prebuilds", `${target}.node`)), "the binding is cached next to the JS package");
            const o = openSqliteDatabase(":memory:");
            assert.equal(o.engine, "better-sqlite3");
            assert.equal(o.source, "self-downloaded");
            o.db.close();
        });
    } finally {
        await npmReg?.close();
        await binReg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: a prebuild whose ABI is not this Node is refused before any download (#3894)", async () => {
    const cachePrev = isolateCache();
    let npmReg: MockRegistry | null = null;
    let binReg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const target = platformTargetKey();
        const npmTgz = fakeJsOnlyPackageTgz();
        const preTgz = fakePrebuildTgz();
        setEngineBootstrapSpecForTests({
            version: "12.9.0",
            sha512Base64: sha512B64(npmTgz),
            minNodeMajor: 20,
            prebuild: { sha512Base64ByAbi: { "999": { [target]: sha512B64(preTgz) } } },
        });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        npmReg = await startMockRegistry(npmTgz, 200, "12.9.0");
        binReg = await startMockBinaryMirror(preTgz, "12.9.0", "999", target);
        setPrebuildMirrorsForTests([binReg.base]);
        await withRegistry(npmReg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "unsupported-node", `an ABI mismatch must be refused, got ${JSON.stringify(out)}`);
            assert.match(out.detail ?? "", /no binding for Node ABI \d+/, "the detail names the ABI gap");
            assert.equal(npmReg!.requests(), 0, "neither artifact may be downloaded");
            assert.equal(binReg!.requests(), 0);
            assert.ok(!fs.existsSync(path.join(cachePrev, "billion-context", "sqlite", `better-sqlite3-12.9.0-abi${process.versions.modules}`)), "nothing materialized into the cache");
            assert.throws(() => openSqliteDatabase(":memory:"), /no SQLite engine available/i, "no loader was registered");
        });
    } finally {
        await npmReg?.close();
        await binReg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: a self-contained artifact never touches the binary mirror (#3894 negative case)", async () => {
    const cachePrev = isolateCache();
    let npmReg: MockRegistry | null = null;
    let binReg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20 });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        npmReg = await startMockRegistry(tgz);
        binReg = await startMockBinaryMirror(fakePrebuildTgz(), "13.0.3", process.versions.modules, platformTargetKey());
        setPrebuildMirrorsForTests([binReg.base]);
        await withRegistry(npmReg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "downloaded", `the single-tarball lane must keep working, got ${JSON.stringify(out)}`);
            assert.equal(npmReg!.requests(), 1);
            assert.equal(binReg!.requests(), 0, "a tarball that carries its own prebuilds must not hit the binary mirror");
        });
    } finally {
        await npmReg?.close();
        await binReg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});


// ---------------------------------------------------------------------------
// N-API floor (#3894 follow-up): a binding compiled against N-API 10 cannot be
// dlopen'd by a runtime that only ships N-API 9 - the load faults uncatchably,
// so the band table must fall through to an artifact that DOES match instead
// of trusting the package's `engines.node` major alone. Node 22.0-22.12 is
// exactly that trap: `>= 22` is satisfied, N-API is still 9.
// ---------------------------------------------------------------------------

test("pinnedEngineVersionFor: every Node band picks a loadable artifact (#3894)", () => {
    assert.equal(pinnedEngineVersionFor("20.19.5", "115", "9"), "12.9.0", "Node 20 -> the ABI 115 JS-only lane");
    assert.equal(pinnedEngineVersionFor("22.0.0", "127", "9"), "12.9.0", "Node 22.0-22.12 passes v13's major floor but predates N-API 10 -> must fall back, not dlopen");
    assert.equal(pinnedEngineVersionFor("22.13.0", "127", "9"), "12.9.0", "the whole pre-N-API-10 22.x band falls back");
    assert.equal(pinnedEngineVersionFor("22.14.0", "127", "10"), "13.0.3", "N-API 10 arrives -> the single-tarball v13 lane");
    assert.equal(pinnedEngineVersionFor("23.11.1", "131", "10"), "13.0.3", "Node 23 is above the floor with N-API 10");
    assert.equal(pinnedEngineVersionFor("24.11.0", "137", "10"), "13.0.3", "Node 24 is above the floor with N-API 10");
    assert.equal(pinnedEngineVersionFor("25.2.1", "141", "10"), "13.0.3", "Node 25 is above the floor with N-API 10");
    assert.equal(pinnedEngineVersionFor("21.7.3", "120", "9"), null, "Node 21 has no pinned band -> honest unsupported-node");
    assert.equal(pinnedEngineVersionFor("19.9.0", "111", "8"), null, "Node 19 is below the engines floor");
    assert.equal(pinnedEngineVersionFor("18.20.8", "108", "8"), null, "Node 18 is below the engines floor");
});

test("bootstrap: an artifact whose N-API floor is above this runtime is refused before any download (#3894)", async () => {
    const cachePrev = isolateCache();
    let npmReg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const tgz = fakePackageTgz();
        setEngineBootstrapSpecForTests({ version: "13.0.3", sha512Base64: sha512B64(tgz), minNodeMajor: 20, minNapiVersion: 99 });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        npmReg = await startMockRegistry(tgz);
        await withRegistry(npmReg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "unsupported-node", `an N-API gap must be refused, got ${JSON.stringify(out)}`);
            assert.match(out.detail ?? "", /built against N-API 99/, "the detail names the N-API gap");
            assert.equal(npmReg!.requests(), 0, "the tarball must not be downloaded");
            assert.throws(() => openSqliteDatabase(":memory:"), /no SQLite engine available/i, "no loader was registered");
        });
    } finally {
        await npmReg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: an ABI-keyed artifact keeps one cache dir per ABI so a second runtime fetches its own binding (#3894)", async () => {
    const cachePrev = isolateCache();
    let npmReg: MockRegistry | null = null;
    let binReg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const target = platformTargetKey();
        const abi = process.versions.modules;
        const npmTgz = fakeJsOnlyPackageTgz();
        const preTgz = fakePrebuildTgz();
        // A cache dir from the SAME version but a DIFFERENT ABI: reusing it would
        // hand this runtime the wrong binding, so the bootstrap must not treat it
        // as a cache hit.
        const wrongAbiDir = path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-12.9.0-abi999");
        fs.mkdirSync(path.join(wrongAbiDir, "lib"), { recursive: true });
        fs.mkdirSync(path.join(wrongAbiDir, "prebuilds"), { recursive: true });
        fs.writeFileSync(path.join(wrongAbiDir, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "12.9.0" }));
        fs.writeFileSync(path.join(wrongAbiDir, "lib", "index.js"), FAKE_V12_LIB_INDEX);
        fs.writeFileSync(path.join(wrongAbiDir, "prebuilds", `${target}.node`), Buffer.from("WRONG-ABI"));
        setEngineBootstrapSpecForTests({
            version: "12.9.0",
            sha512Base64: sha512B64(npmTgz),
            minNodeMajor: 20,
            prebuild: { sha512Base64ByAbi: { [abi]: { [target]: sha512B64(preTgz) } } },
        });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        npmReg = await startMockRegistry(npmTgz, 200, "12.9.0");
        binReg = await startMockBinaryMirror(preTgz, "12.9.0", abi, target);
        setPrebuildMirrorsForTests([binReg.base]);
        await withRegistry(npmReg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "downloaded", `a foreign-ABI cache dir must not be reused, got ${JSON.stringify(out)}`);
            assert.equal(npmReg!.requests(), 1, "the JS tarball was fetched into this ABI's own dir");
            const ownDir = path.join(cachePrev, "billion-context", "sqlite", `better-sqlite3-12.9.0-abi${abi}`);
            assert.ok(fs.existsSync(path.join(ownDir, "prebuilds", `${target}.node`)), "this runtime's own binding was published");
            assert.ok(fs.existsSync(wrongAbiDir), "the other ABI's cache dir survives the prune");
        });
    } finally {
        await npmReg?.close();
        await binReg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});

test("bootstrap: pinned sibling cache dirs survive the prune; unpinned ones are still removed (#3894)", async () => {
    const cachePrev = isolateCache();
    let npmReg: MockRegistry | null = null;
    let binReg: MockRegistry | null = null;
    try {
        resetAllSeams();
        const target = platformTargetKey();
        const abi = process.versions.modules;
        const npmTgz = fakeJsOnlyPackageTgz();
        const preTgz = fakePrebuildTgz();
        setEngineBootstrapSpecForTests({
            version: "12.9.0",
            sha512Base64: sha512B64(npmTgz),
            minNodeMajor: 20,
            prebuild: { sha512Base64ByAbi: { [abi]: { [target]: sha512B64(preTgz) } } },
        });
        setSqliteProbeOverridesForTests({ builtin: false, host: false });
        // Pre-existing siblings before this download publishes: the OTHER pinned
        // version's dir must survive the post-publish prune (switching Node
        // majors must not force a re-download), an unpinned legacy version must
        // still be cleaned up.
        const pinnedSibling = path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-13.0.3");
        const staleSibling = path.join(cachePrev, "billion-context", "sqlite", "better-sqlite3-9.9.9");
        fs.mkdirSync(path.join(pinnedSibling, "lib"), { recursive: true });
        fs.writeFileSync(path.join(pinnedSibling, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "13.0.3" }));
        fs.writeFileSync(path.join(pinnedSibling, "lib", "index.js"), FAKE_LIB_INDEX);
        fs.mkdirSync(staleSibling, { recursive: true });
        fs.writeFileSync(path.join(staleSibling, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "9.9.9" }));
        npmReg = await startMockRegistry(npmTgz, 200, "12.9.0");
        binReg = await startMockBinaryMirror(preTgz, "12.9.0", abi, target);
        setPrebuildMirrorsForTests([binReg.base]);
        await withRegistry(npmReg.base, async () => {
            const out = await ensureSqliteEngine({ env: { ...UNIFIED_ENV } });
            assert.equal(out.status, "downloaded", `the JS-only lane must install, got ${JSON.stringify(out)}`);
            assert.ok(fs.existsSync(path.join(pinnedSibling, "package.json")), "the other pinned version's cache dir survives the prune");
            assert.ok(!fs.existsSync(staleSibling), "an unpinned legacy version is still pruned");
        });
    } finally {
        await npmReg?.close();
        await binReg?.close();
        resetAllSeams();
        restoreCache(cachePrev);
        rmrf(cachePrev);
    }
});
