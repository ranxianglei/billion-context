import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";

// #3754: persistent install attribution. Install-success logs are per-process
// ephemeral — after a restart nothing on the machine says WHICH channel put
// the current version on disk (auto-update loop, manual `bili update`, or an
// advisory force-install). These pin the cross-process ledger
// (.last-install.json): every successful in-place install records
// {from, version, source, at} under the install's own cross-process lock;
// reads fail open; unsatisfied/rejected cycles never clobber the record.
//
// CHECK_INTERVAL_MS / THROTTLE_FILE / LOCK_FILE / LAST_INSTALL_FILE are
// module-level consts frozen at import time, so the cache-dir override MUST be
// set before dynamically importing src/update.ts (same discipline as
// update-backoff.test.ts). DSH_HOME is pointed at an empty tree so the
// post-install dsh profile/desktop refresh is a no-op instead of touching
// this machine's real dsh home.
const root = mkdtempSync(path.join(tmpdir(), "bc-issue3754-"));
process.env.XDG_CACHE_HOME = path.join(root, "cache");
process.env.DSH_HOME = path.join(root, "dsh-home");
process.env.BILI_UPDATE_POLICY_URL = "http://127.0.0.1:1/no-policy.json";
process.env.BILI_UPDATE_STAGGER_MIN_MS = "0";
process.env.BILI_UPDATE_STAGGER_MAX_MS = "0";
const { checkForUpdate, forceInstallVersion, getLastInstall, readDiskVersion, registryUrlFor, _resetLastInstallForTest } = await import("../src/update.ts");
const { cacheDir } = await import("../src/paths.ts");

const LAST_INSTALL = path.join(cacheDir(), ".last-install.json");

after(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
    delete process.env.DSH_HOME;
    delete process.env.BILI_UPDATE_POLICY_URL;
    delete process.env.BILI_UPDATE_STAGGER_MIN_MS;
    delete process.env.BILI_UPDATE_STAGGER_MAX_MS;
});

function integrityField(buf: Buffer): string {
    return `sha512-${crypto.createHash("sha512").update(buf).digest("base64")}`;
}

/** A running install at `version` under a uniquely-named dir, like a real host. */
function makeInstallDir(version: string, label: string): string {
    const dir = path.join(root, `install-${label}`);
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
            name: "billion-context",
            version,
            type: "module",
            main: "dist/index.js",
            bin: { bili: "./dist/index.js" },
        }),
    );
    writeFileSync(path.join(dir, "dist", "index.js"), `export const loaded = '${version}';\n`);
    return dir;
}

interface Pkg {
    docUrl: string;
    tarballUrl: string;
    doc: object;
    tgz: Buffer;
}

/** Registry doc + tarball pair for one published version, served hermetically.
 *  `tag` re-keys the doc under a dist-tag URL (the self-updater follows the
 *  dist-tag channel, not the bare version) — defaults to the version itself,
 *  as forceInstallVersion resolves exact versions. */
function makeRegistry(version: string, tag?: string): Pkg {
    const src = path.join(root, `pkg-src-${version}`);
    const pkg = path.join(src, "package");
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({
            name: "billion-context",
            version,
            type: "module",
            main: "dist/index.js",
            bin: { bili: "./dist/index.js" },
        }),
    );
    writeFileSync(path.join(pkg, "dist", "index.js"), `export const loaded = '${version}';\n`);
    const tgzPath = path.join(root, `pkg-${version}.tgz`);
    tar.c({ cwd: src, file: tgzPath, gzip: true, sync: true }, ["package"]);
    const tgz = readFileSync(tgzPath);
    const tarballUrl = `https://registry.test/${version}.tgz`;
    return {
        docUrl: registryUrlFor("billion-context", tag ?? version),
        tarballUrl,
        doc: { version, dist: { tarball: tarballUrl, integrity: integrityField(tgz) } },
        tgz,
    };
}

/** Serve crafted registry docs + tarballs through global fetch; unknown URLs
 *  (e.g. the unroutable policy feed) fall through to the real fetch. */
async function withRegistryFetch(pkgs: Pkg[], fn: () => Promise<void>): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        for (const p of pkgs) {
            if (url === p.docUrl) return new Response(JSON.stringify(p.doc), { status: 200, headers: { "content-type": "application/json" } });
            if (url === p.tarballUrl) return new Response(p.tgz);
        }
        return original(input, init);
    }) as unknown as typeof fetch;
    try {
        await fn();
    } finally {
        globalThis.fetch = original;
    }
}

test("getLastInstall: absent ledger → undefined (fail-open)", async () => {
    await _resetLastInstallForTest();
    assert.equal(await getLastInstall(), undefined);
});

test("getLastInstall: parses a record written by another process, fresh per call", async () => {
    await _resetLastInstallForTest();
    mkdirSync(path.dirname(LAST_INSTALL), { recursive: true });
    writeFileSync(LAST_INSTALL, JSON.stringify({ v: 1, record: { from: "1.2.3", version: "2.0.0", source: "advisory:adv-9", at: 1_750_000_000_000 } }));
    assert.deepEqual(await getLastInstall(), { from: "1.2.3", version: "2.0.0", source: "advisory:adv-9", at: 1_750_000_000_000 });
    // Deliberately uncached: a rewrite by ANOTHER process is visible on the
    // next read without restarting this one.
    writeFileSync(LAST_INSTALL, JSON.stringify({ v: 1, record: { version: "2.1.0", source: "auto-update", at: 1_750_000_000_001 } }));
    const rec = await getLastInstall();
    assert.ok(rec);
    assert.equal(rec.from, undefined);
    assert.equal(rec.version, "2.1.0");
    assert.equal(rec.source, "auto-update");
    assert.equal(rec.at, 1_750_000_000_001);
});

test("getLastInstall: corrupt or malformed ledger → undefined (fail-open)", async () => {
    mkdirSync(path.dirname(LAST_INSTALL), { recursive: true });
    const bad = [
        "not json at all",
        JSON.stringify({ v: 2, record: { version: "1.0.0", source: "manual", at: 1 } }),
        JSON.stringify({ v: 1, record: { version: "1.0.0", source: "manual" } }),
        JSON.stringify({ v: 1, record: { version: 1, source: "manual", at: 1 } }),
        JSON.stringify({ v: 1, record: { version: "1.0.0", source: 7, at: 1 } }),
        JSON.stringify({ v: 1, record: null }),
    ];
    for (const raw of bad) {
        writeFileSync(LAST_INSTALL, raw);
        assert.equal(await getLastInstall(), undefined, `expected fail-open for: ${raw}`);
    }
});

test("checkForUpdate auto-update success records source auto-update", { timeout: 30_000 }, async () => {
    await _resetLastInstallForTest();
    const installDir = makeInstallDir("1.2.3", "auto");
    const pkgs = [makeRegistry("2.0.0", "latest")];
    await withRegistryFetch(pkgs, async () => {
        await checkForUpdate({ packageName: "billion-context", currentVersion: "1.2.3", autoUpdate: true, installDir }, false);
    });
    assert.equal(await readDiskVersion(installDir), "2.0.0", "the install itself must have succeeded");
    const rec = await getLastInstall();
    assert.ok(rec, "ledger must exist after a successful install");
    assert.equal(rec.from, "1.2.3");
    assert.equal(rec.version, "2.0.0");
    assert.equal(rec.source, "auto-update");
    assert.ok(Number.isFinite(rec.at) && rec.at > 0);
});

test("checkForUpdate manual (force) success records source manual", { timeout: 30_000 }, async () => {
    await _resetLastInstallForTest();
    const installDir = makeInstallDir("1.2.3", "manual");
    const pkgs = [makeRegistry("3.0.0", "latest")];
    await withRegistryFetch(pkgs, async () => {
        await checkForUpdate({ packageName: "billion-context", currentVersion: "1.2.3", autoUpdate: false, installDir }, true);
    });
    assert.equal(await readDiskVersion(installDir), "3.0.0", "the install itself must have succeeded");
    const rec = await getLastInstall();
    assert.ok(rec, "ledger must exist after a successful install");
    assert.equal(rec.from, "1.2.3");
    assert.equal(rec.version, "3.0.0");
    assert.equal(rec.source, "manual");
});

test("forceInstallVersion success records source advisory:<id>", { timeout: 30_000 }, async () => {
    await _resetLastInstallForTest();
    const installDir = makeInstallDir("2.0.0", "adv");
    const pkgs = [makeRegistry("1.9.0")];
    await withRegistryFetch(pkgs, async () => {
        const r = await forceInstallVersion("1.9.0", installDir, { packageName: "billion-context", currentVersion: "2.0.0", autoUpdate: true }, "adv-42");
        assert.equal(r.ok, true, r.error);
    });
    // Rollback direction (newer → older) proves the record comes from the
    // advisory channel, not from "follow latest".
    assert.equal(await readDiskVersion(installDir), "1.9.0", "the install itself must have succeeded");
    const rec = await getLastInstall();
    assert.ok(rec, "ledger must exist after a successful install");
    assert.equal(rec.from, "2.0.0");
    assert.equal(rec.version, "1.9.0");
    assert.equal(rec.source, "advisory:adv-42");
});

test("a rejected advisory cycle does not clobber the ledger", { timeout: 60_000 }, async () => {
    await _resetLastInstallForTest();
    const installDir = makeInstallDir("2.0.0", "noop");
    const pkgs = [makeRegistry("1.9.0")];
    await withRegistryFetch(pkgs, async () => {
        const first = await forceInstallVersion("1.9.0", installDir, { packageName: "billion-context", currentVersion: "2.0.0", autoUpdate: true }, "adv-42");
        assert.equal(first.ok, true, first.error);
        const before = await getLastInstall();
        assert.ok(before);
        // Next cycle the disk is already at the target: the pre-lock check
        // rejects it as a misconfigured advisory — and the record of who
        // actually did the install must survive untouched.
        const second = await forceInstallVersion("1.9.0", installDir, { packageName: "billion-context", currentVersion: "1.9.0", autoUpdate: true }, "adv-42");
        assert.equal(second.ok, false);
        const after = await getLastInstall();
        assert.deepEqual(after, before, "a rejected cycle must not rewrite the ledger");
    });
});
