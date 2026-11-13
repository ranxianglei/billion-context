// #2082 follow-up: the boot smoke was wired into refreshDshDesktopCopy only —
// the lane where ANOTHER bili process refreshes the dsh desktop profile copy.
// When the running proxy IS the desktop copy, hostManagedInstall exempts the
// layout (#1575) and the copy updates itself through the plain self-update
// lanes: checkForUpdate (periodic / `bili update`) and forceInstallVersion
// (advisory force-install, web panel install). Those called installViaTarball
// without bootSmoke, so a tarball whose entry parses but throws at load was
// swapped in under the running dsh — exactly the state the gate exists to
// prevent. These pin that both self lanes arm the smoke when (and only when)
// the install dir is the dsh desktop copy.
//
// CHECK_INTERVAL_MS / THROTTLE_FILE / BACKOFF_STATE_FILE / ... are frozen at
// import time, so the cache-dir override MUST be set before loading
// src/update.ts (same discipline as issue3754-install-attribution.test.ts).
// DSH_HOME points at a per-file tree so the desktop-copy path check resolves
// inside the fixture and never at this machine's real dsh home.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { rmrf } from "./tmp-rm.ts";

const root = mkdtempSync(path.join(tmpdir(), "bc-2082-self-"));
process.env.XDG_CACHE_HOME = path.join(root, "cache");
process.env.DSH_HOME = path.join(root, "dsh-home");
process.env.BILI_UPDATE_POLICY_URL = "http://127.0.0.1:1/no-policy.json";
process.env.BILI_UPDATE_STAGGER_MIN_MS = "0";
process.env.BILI_UPDATE_STAGGER_MAX_MS = "0";
const {
    checkForUpdate,
    forceInstallVersion,
    getLastInstall,
    readDiskVersion,
    registryUrlFor,
    _resetAdvisoryRefusalWarnsForTest,
    _resetInstallBackoffForTest,
    _resetLastInstallForTest,
    _resetPolicyGateForTest,
    _resetUpdateThrottleForTest,
} = await import("../src/update.ts");

after(() => {
    rmrf(root);
    delete process.env.XDG_CACHE_HOME;
    delete process.env.DSH_HOME;
    delete process.env.BILI_UPDATE_POLICY_URL;
    delete process.env.BILI_UPDATE_STAGGER_MIN_MS;
    delete process.env.BILI_UPDATE_STAGGER_MAX_MS;
});

const DESKTOP_COPY = path.join(root, "dsh-home", "profiles", "desktop", "node_modules", "billion-context");

const goodEntry = (version: string): string => `export const loaded = '${version}';\n`;
const BOOT_BROKEN_ENTRY = 'throw new Error("boom at boot (#2082 self-lane fixture)");\n';

function integrityField(buf: Buffer): string {
    return `sha512-${crypto.createHash("sha512").update(buf).digest("base64")}`;
}

function writePkg(dir: string, version: string, entry: string): void {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }),
    );
    writeFileSync(path.join(dir, "dist", "index.js"), entry);
}

/** (Re)seed the dsh desktop profile copy as a real directory at `version` —
 *  the shape it has once bili owns it in place (#1575). */
function seedDesktopCopy(version: string): string {
    rmrf(DESKTOP_COPY);
    writePkg(DESKTOP_COPY, version, goodEntry(version));
    return DESKTOP_COPY;
}

/** A plain (non-dsh) install dir, like a global npm install. */
function seedPlainInstall(version: string, label: string): string {
    const dir = path.join(root, `plain-${label}`, "node_modules", "billion-context");
    writePkg(dir, version, goodEntry(version));
    return dir;
}

interface Pkg { docUrl: string; tarballUrl: string; doc: object; tgz: Buffer; }

let pkgSeq = 0;

/** Registry doc + tarball pair for one published version. `tag` re-keys the
 *  doc under a dist-tag URL (checkForUpdate follows the dist-tag channel);
 *  omitted = the exact-version doc forceInstallVersion resolves. */
function makeRegistry(version: string, entry: string, tag?: string): Pkg {
    const src = path.join(root, `pkg-src-${++pkgSeq}`);
    writePkg(path.join(src, "package"), version, entry);
    const tgzPath = path.join(root, `pkg-${pkgSeq}.tgz`);
    tar.c({ cwd: src, file: tgzPath, gzip: true, sync: true }, ["package"]);
    const tgz = readFileSync(tgzPath);
    const tarballUrl = `https://registry.test/${pkgSeq}/billion-context-${version}.tgz`;
    return {
        docUrl: registryUrlFor("billion-context", tag ?? version),
        tarballUrl,
        doc: { version, dist: { tarball: tarballUrl, integrity: integrityField(tgz) } },
        tgz,
    };
}

/** Serve the crafted registry through global fetch. Anything else (the
 *  unroutable policy feed) is rejected in-process — the policy gate fails
 *  open — so the file never opens a socket. */
async function withRegistryFetch(pkgs: Pkg[], fn: () => Promise<void>): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => {
        const url = String(input);
        for (const p of pkgs) {
            if (url === p.docUrl) return Promise.resolve(new Response(JSON.stringify(p.doc), { status: 200, headers: { "content-type": "application/json" } }));
            if (url === p.tarballUrl) return Promise.resolve(new Response(p.tgz));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
    }) as unknown as typeof fetch;
    try {
        await fn();
    } finally {
        globalThis.fetch = original;
    }
}

async function resetUpdaterState(): Promise<void> {
    await _resetUpdateThrottleForTest();
    await _resetInstallBackoffForTest();
    await _resetLastInstallForTest();
    _resetPolicyGateForTest();
    _resetAdvisoryRefusalWarnsForTest();
}

function assertNoUpdateLitter(installDir: string): void {
    for (const entry of readdirSync(path.dirname(installDir))) {
        assert.equal(entry, path.basename(installDir), `leftover next to the install dir: ${entry}`);
    }
}

test("checkForUpdate from the dsh desktop copy: a boot-broken tarball is rolled back, not swapped in (#2082)", { timeout: 60_000 }, async () => {
    await resetUpdaterState();
    const installDir = seedDesktopCopy("1.2.3");
    const pkgs = [makeRegistry("2.0.0", BOOT_BROKEN_ENTRY, "latest")];
    await withRegistryFetch(pkgs, async () => {
        await checkForUpdate({ packageName: "billion-context", currentVersion: "1.2.3", autoUpdate: true, installDir }, false);
    });
    assert.equal(await readDiskVersion(installDir), "1.2.3", "the working desktop copy must survive a boot-broken tarball");
    assert.equal(readFileSync(path.join(installDir, "dist", "index.js"), "utf8"), goodEntry("1.2.3"));
    assert.equal(await getLastInstall(), undefined, "a rolled-back install must not be attributed as installed");
    assertNoUpdateLitter(installDir);
});

test("checkForUpdate (forced, `bili update`) from the dsh desktop copy: same rollback (#2082)", { timeout: 60_000 }, async () => {
    await resetUpdaterState();
    const installDir = seedDesktopCopy("1.2.3");
    const pkgs = [makeRegistry("2.0.0", BOOT_BROKEN_ENTRY, "latest")];
    await withRegistryFetch(pkgs, async () => {
        await checkForUpdate({ packageName: "billion-context", currentVersion: "1.2.3", autoUpdate: false, installDir }, true);
    });
    assert.equal(await readDiskVersion(installDir), "1.2.3");
    assert.equal(readFileSync(path.join(installDir, "dist", "index.js"), "utf8"), goodEntry("1.2.3"));
    assert.equal(await getLastInstall(), undefined);
});

test("forceInstallVersion onto the dsh desktop copy: a boot-broken tarball fails the install and rolls back (#2082)", { timeout: 60_000 }, async () => {
    await resetUpdaterState();
    const installDir = seedDesktopCopy("2.0.0");
    const pkgs = [makeRegistry("1.9.0", BOOT_BROKEN_ENTRY)];
    await withRegistryFetch(pkgs, async () => {
        const r = await forceInstallVersion("1.9.0", installDir, { packageName: "billion-context", currentVersion: "2.0.0", autoUpdate: true }, "adv-2082");
        assert.equal(r.ok, false, "a boot-broken artifact must not install");
        assert.match(r.error ?? "", /boot smoke/);
        assert.match(r.error ?? "", /boom at boot/);
    });
    assert.equal(await readDiskVersion(installDir), "2.0.0", "the working desktop copy must survive a boot-broken tarball");
    assert.equal(readFileSync(path.join(installDir, "dist", "index.js"), "utf8"), goodEntry("2.0.0"));
    assert.equal(await getLastInstall(), undefined);
    assertNoUpdateLitter(installDir);
});

test("self-update of the dsh desktop copy: a loadable tarball passes the smoke and lands on both lanes (#2082)", { timeout: 60_000 }, async () => {
    await resetUpdaterState();
    const installDir = seedDesktopCopy("1.2.3");
    await withRegistryFetch([makeRegistry("2.0.0", goodEntry("2.0.0"), "latest")], async () => {
        await checkForUpdate({ packageName: "billion-context", currentVersion: "1.2.3", autoUpdate: true, installDir }, false);
    });
    assert.equal(await readDiskVersion(installDir), "2.0.0");
    assert.equal((await getLastInstall())?.source, "auto-update");

    await withRegistryFetch([makeRegistry("1.9.0", goodEntry("1.9.0"))], async () => {
        const r = await forceInstallVersion("1.9.0", installDir, { packageName: "billion-context", currentVersion: "2.0.0", autoUpdate: true }, "adv-2082-ok");
        assert.equal(r.ok, true, r.error);
    });
    assert.equal(await readDiskVersion(installDir), "1.9.0");
    assert.equal((await getLastInstall())?.source, "advisory:adv-2082-ok");
});

test("self-update outside the dsh desktop copy keeps the parse-only verification (scope pin for #2082)", { timeout: 60_000 }, async () => {
    // The smoke is armed for the desktop copy only; a plain install keeps its
    // existing behaviour. This pins the scope of the change, not a claim that
    // parse-only verification is sufficient there.
    await resetUpdaterState();
    const installDir = seedPlainInstall("1.2.3", "auto");
    await withRegistryFetch([makeRegistry("2.0.0", BOOT_BROKEN_ENTRY, "latest")], async () => {
        await checkForUpdate({ packageName: "billion-context", currentVersion: "1.2.3", autoUpdate: true, installDir }, false);
    });
    assert.equal(await readDiskVersion(installDir), "2.0.0");
});
