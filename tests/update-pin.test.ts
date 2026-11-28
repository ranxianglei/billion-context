// #6804: local version pin + tag-channel auto-upgrade.
//
// Two layers under test:
//  1. src/update-pin.ts — the state module itself (file shape, fail-open
//     reads, self-sweeping expiry/staleness, duration vocabulary).
//  2. the guard in checkForUpdate (src/update.ts) — a pinned version is
//     CHECK-ONLY (reported, never installed), an installed prerelease/temp
//     build is never auto-swept to a release, force/explicit installs break
//     through and clear the pin.
//
// CHECK_INTERVAL_MS / THROTTLE_FILE / ... are frozen at import time in
// src/update.ts, so the cache-dir override MUST be set before loading it
// (same discipline as issue2082-self-update-boot-smoke.test.ts).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { rmrf } from "./tmp-rm.ts";
import type { UpdateCheckOutcome } from "../src/update.ts";

const root = mkdtempSync(path.join(tmpdir(), "bc-6804-pin-"));
process.env.XDG_CACHE_HOME = path.join(root, "cache");
process.env.DSH_HOME = path.join(root, "dsh-home");
process.env.BILI_UPDATE_POLICY_URL = "http://127.0.0.1:1/no-policy.json";
process.env.BILI_UPDATE_STAGGER_MIN_MS = "0";
process.env.BILI_UPDATE_STAGGER_MAX_MS = "0";
const {
    checkForUpdate,
    forceInstallVersion,
    isPrereleaseVersion,
    readDiskVersion,
    registryUrlFor,
    _resetAdvisoryRefusalWarnsForTest,
    _resetInstallBackoffForTest,
    _resetLastInstallForTest,
    _resetPolicyGateForTest,
    _resetUpdateThrottleForTest,
} = await import("../src/update.ts");
const { clearPin, formatPinUntil, parsePinDuration, pinFilePath, readPin, resolvePinState, writePin } = await import("../src/update-pin.ts");

after(() => {
    rmrf(root);
    delete process.env.XDG_CACHE_HOME;
    delete process.env.DSH_HOME;
    delete process.env.BILI_UPDATE_POLICY_URL;
    delete process.env.BILI_UPDATE_STAGGER_MIN_MS;
    delete process.env.BILI_UPDATE_STAGGER_MAX_MS;
});

// ---------------------------------------------------------------------------
// Layer 1: the update-pin module
// ---------------------------------------------------------------------------

test("isPrereleaseVersion: prerelease parts count, build metadata does not (#6804)", () => {
    assert.equal(isPrereleaseVersion("0.1.215-pr.202.1"), true, "CI temp-build shape");
    assert.equal(isPrereleaseVersion("1.2.3-rc.1"), true, "generic prerelease");
    assert.equal(isPrereleaseVersion("0.1.215"), false, "plain release");
    assert.equal(isPrereleaseVersion("0.1.215+build.5"), false, "build metadata is a release");
    assert.equal(isPrereleaseVersion("0.1.215+build.5-pr.1"), false, "a dash inside build metadata is still a release");
    assert.equal(isPrereleaseVersion("1.0.0-pr.1+build.9"), true, "prerelease before the + counts, build after it does not");
    assert.equal(isPrereleaseVersion("not-a-version"), false, "unparseable is not a prerelease");
});

test("parsePinDuration: forever/empty = indefinite, #3619 durations, garbage rejected (#6804)", () => {
    assert.deepEqual(parsePinDuration(undefined), {});
    assert.deepEqual(parsePinDuration(""), {});
    assert.deepEqual(parsePinDuration("forever"), {});
    assert.deepEqual(parsePinDuration("1h"), { ms: 3_600_000 });
    assert.deepEqual(parsePinDuration("7d"), { ms: 7 * 86_400_000 });
    assert.deepEqual(parsePinDuration("1d12h"), { ms: (24 + 12) * 3_600_000 });
    assert.match((parsePinDuration("0h") as { error: string }).error, /invalid pin duration/);
    assert.match((parsePinDuration("banana") as { error: string }).error, /invalid pin duration/);
});

test("formatPinUntil: indefinite vs an ISO deadline (#6804)", () => {
    assert.equal(formatPinUntil({}), "indefinite");
    assert.ok(formatPinUntil({ until: 1_700_000_000_000 }).startsWith("until "));
});

test("readPin: absent and corrupt files fail open and are left in place (#6804)", async () => {
    assert.equal(await readPin(), undefined, "absent file = no pin");
    const p = pinFilePath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, "{ not json", "utf8");
    assert.equal(await readPin(), undefined, "corrupt file = no pin");
    assert.equal(readFileSync(p, "utf8"), "{ not json", "a read never destroys the file");
    await clearPin();
});

test("writePin/readPin round-trip, with and without expiry (#6804)", async () => {
    await writePin({ v: 1, version: "1.2.3", setAt: 100 });
    assert.deepEqual(await readPin(), { v: 1, version: "1.2.3", setAt: 100 });
    await writePin({ v: 1, version: "1.2.3", setAt: 100, until: 200 });
    assert.deepEqual(await readPin(), { v: 1, version: "1.2.3", setAt: 100, until: 200 });
    // an until <= setAt is unshaped and dropped (readPin normalizes)
    await writePin({ v: 1, version: "1.2.3", setAt: 100, until: 50 });
    assert.deepEqual(await readPin(), { v: 1, version: "1.2.3", setAt: 100 });
    assert.equal(await clearPin(), true, "clearPin reports a removed file");
    assert.equal(await clearPin(), false, "clearPin reports nothing to remove");
});

test("resolvePinState: active / expired / stale / unknown-version (#6804)", async () => {
    const now = 1_700_000_000_000;
    await writePin({ v: 1, version: "1.2.3", setAt: now - 100 });
    assert.deepEqual((await resolvePinState("1.2.3", now)).kind, "active");
    assert.deepEqual((await resolvePinState("1.2.3", now)).kind, "active", "indefinite pin stays active");

    await writePin({ v: 1, version: "1.2.3", setAt: now - 100, until: now - 1 });
    assert.deepEqual((await resolvePinState("1.2.3", now)).kind, "expired");
    assert.equal(await readPin(), undefined, "an expired pin is swept off disk");

    await writePin({ v: 1, version: "0.9.0", setAt: now - 100 });
    assert.deepEqual((await resolvePinState("1.2.3", now)).kind, "stale");
    assert.equal(await readPin(), undefined, "a stale pin (version mismatch) is swept off disk");

    // Unknown installed version: the file is preserved — never destroy state
    // we cannot verify.
    await writePin({ v: 1, version: "1.2.3", setAt: now - 100 });
    assert.deepEqual((await resolvePinState(undefined, now)).kind, "none");
    assert.deepEqual(await readPin(), { v: 1, version: "1.2.3", setAt: now - 100 }, "the record survives an unverifiable resolve");
    await clearPin();
});

// ---------------------------------------------------------------------------
// Layer 2: the guard in checkForUpdate
// ---------------------------------------------------------------------------

const goodEntry = (version: string): string => `export const loaded = '${version}';\n`;

function writePkg(dir: string, version: string, entry: string): void {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }),
    );
    writeFileSync(path.join(dir, "dist", "index.js"), entry);
}

function seedPlainInstall(version: string, label: string): string {
    const dir = path.join(root, `plain-${label}`, "node_modules", "billion-context");
    rmrf(dir);
    writePkg(dir, version, goodEntry(version));
    return dir;
}

interface Pkg { docUrl: string; tarballUrl: string; doc: object; tgz: Buffer; }

let pkgSeq = 0;

function integrityField(buf: Buffer): string {
    return `sha512-${crypto.createHash("sha512").update(buf).digest("base64")}`;
}

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

test("a pinned release is check-only: newer reported, never auto-installed (#6804)", { timeout: 60_000 }, async () => {
    await resetUpdaterState();
    const installDir = seedPlainInstall("1.0.0", "pin-hold");
    await writePin({ v: 1, version: "1.0.0", setAt: Date.now() });
    await withRegistryFetch([makeRegistry("2.0.0", goodEntry("2.0.0"), "latest")], async () => {
        await checkForUpdate({ packageName: "billion-context", currentVersion: "1.0.0", autoUpdate: true, installDir }, false);
    });
    assert.equal(await readDiskVersion(installDir), "1.0.0", "the pin must hold the version");
    assert.ok(existsSync(pinFilePath()), "the pin file stays in place while active");
});

test("a pinned release through checkOnly: structured update-available + pin note (#6804)", { timeout: 60_000 }, async () => {
    await resetUpdaterState();
    const installDir = seedPlainInstall("1.0.0", "pin-checkonly");
    await writePin({ v: 1, version: "1.0.0", setAt: Date.now(), until: Date.now() + 3_600_000 });
    let outcome: UpdateCheckOutcome | undefined;
    await withRegistryFetch([makeRegistry("2.0.0", goodEntry("2.0.0"), "latest")], async () => {
        outcome = await checkForUpdate({ packageName: "billion-context", currentVersion: "1.0.0", autoUpdate: true, installDir }, false, true);
    });
    assert.equal(outcome?.status, "update-available", "the check still REPORTS the newer version");
    assert.equal(outcome?.latest, "2.0.0");
    assert.match(outcome?.note ?? "", /pinned/);
    assert.equal(await readDiskVersion(installDir), "1.0.0");
});

test("an expired pin releases: the update proceeds and the record is swept (#6804)", { timeout: 60_000 }, async () => {
    await resetUpdaterState();
    const installDir = seedPlainInstall("1.0.0", "pin-expired");
    await writePin({ v: 1, version: "1.0.0", setAt: Date.now() - 7_200_000, until: Date.now() - 1000 });
    await withRegistryFetch([makeRegistry("2.0.0", goodEntry("2.0.0"), "latest")], async () => {
        await checkForUpdate({ packageName: "billion-context", currentVersion: "1.0.0", autoUpdate: true, installDir }, false);
    });
    assert.equal(await readDiskVersion(installDir), "2.0.0", "auto-upgrade resumes once the pin expires");
    assert.equal(await readPin(), undefined, "the expired record is swept");
});

test("a stale pin (version moved underneath it) is swept and the update proceeds (#6804)", { timeout: 60_000 }, async () => {
    await resetUpdaterState();
    const installDir = seedPlainInstall("1.0.0", "pin-stale");
    await writePin({ v: 1, version: "0.5.0", setAt: Date.now() - 1000 });
    await withRegistryFetch([makeRegistry("2.0.0", goodEntry("2.0.0"), "latest")], async () => {
        await checkForUpdate({ packageName: "billion-context", currentVersion: "1.0.0", autoUpdate: true, installDir }, false);
    });
    assert.equal(await readDiskVersion(installDir), "2.0.0");
    assert.equal(await readPin(), undefined);
});

test("an installed temp build is never auto-swept to a release (tag channel only, #6804)", { timeout: 60_000 }, async () => {
    await resetUpdaterState();
    const installDir = seedPlainInstall("1.0.0-pr.3", "temp-build");
    let outcome: UpdateCheckOutcome | undefined;
    await withRegistryFetch([makeRegistry("2.0.0", goodEntry("2.0.0"), "latest")], async () => {
        outcome = await checkForUpdate({ packageName: "billion-context", currentVersion: "1.0.0-pr.3", autoUpdate: true, installDir }, false, true);
    });
    assert.equal(outcome?.status, "update-available", "the release is still REPORTED");
    assert.equal(outcome?.latest, "2.0.0");
    assert.match(outcome?.note ?? "", /temp build/);
    assert.equal(await readDiskVersion(installDir), "1.0.0-pr.3", "no auto-install onto a deliberately chosen temp build");
    assert.equal(await readPin(), undefined, "no pin was ever set — the guard is stateless");
});

test("a prerelease channel (updateTag=dev) still moves between temp builds (#6804)", { timeout: 60_000 }, async () => {
    await resetUpdaterState();
    const installDir = seedPlainInstall("1.0.0-pr.3", "temp-channel");
    await withRegistryFetch([makeRegistry("1.0.0-pr.4", goodEntry("1.0.0-pr.4"), "dev")], async () => {
        await checkForUpdate({ packageName: "billion-context", currentVersion: "1.0.0-pr.3", autoUpdate: true, installDir, updateTag: "dev" }, false);
    });
    assert.equal(await readDiskVersion(installDir), "1.0.0-pr.4", "temp→temp on a prerelease channel is a normal update");
});

test("an explicit bili update (force) breaks through a pin and clears it (#6804)", { timeout: 60_000 }, async () => {
    await resetUpdaterState();
    const installDir = seedPlainInstall("1.0.0", "force-through");
    await writePin({ v: 1, version: "1.0.0", setAt: Date.now() });
    await withRegistryFetch([makeRegistry("2.0.0", goodEntry("2.0.0"), "latest")], async () => {
        await checkForUpdate({ packageName: "billion-context", currentVersion: "1.0.0", autoUpdate: true, installDir }, true);
    });
    assert.equal(await readDiskVersion(installDir), "2.0.0");
    assert.equal(await readPin(), undefined, "a successful forced install clears the pin");
});

test("forceInstallVersion (advisory / panel lane) also clears a local pin (#6804)", { timeout: 60_000 }, async () => {
    await resetUpdaterState();
    const installDir = seedPlainInstall("2.0.0", "force-clear");
    await writePin({ v: 1, version: "2.0.0", setAt: Date.now() });
    await withRegistryFetch([makeRegistry("3.0.0", goodEntry("3.0.0"))], async () => {
        const r = await forceInstallVersion("3.0.0", installDir, { packageName: "billion-context", currentVersion: "2.0.0", autoUpdate: true }, "adv-6804", "manual-web");
        assert.equal(r.ok, true, r.error);
    });
    assert.equal(await readDiskVersion(installDir), "3.0.0");
    assert.equal(await readPin(), undefined, "owner-directed repair beats a local pin and sweeps the record");
});

test("forceInstallVersion: allowSameVersion repairs a broken install AT the current version; advisory lane stays refused (#7806 review P1)", { timeout: 60_000 }, async () => {
    await resetUpdaterState();
    // The documented repair path: `bili update <v> --force` when the disk
    // already reports v (partial install, missing dist/). The advisory-lane
    // guard ("target == current ⇒ misconfigured advisory") must NOT apply to
    // the human-directed manual lane.
    const repairDir = seedPlainInstall("4.0.0", "force-repair");
    await withRegistryFetch([makeRegistry("4.0.0", goodEntry("4.0.0"))], async () => {
        const refused = await forceInstallVersion("4.0.0", repairDir, { packageName: "billion-context", currentVersion: "4.0.0", autoUpdate: true }, "adv-repair", "manual-cli");
        assert.equal(refused.ok, false);
        assert.match(refused.error ?? "", /misconfigured advisory/);

        const repaired = await forceInstallVersion("4.0.0", repairDir, { packageName: "billion-context", currentVersion: "4.0.0", autoUpdate: true }, "manual", "manual-cli", { allowSameVersion: true });
        assert.equal(repaired.ok, true, repaired.error);
    });
    assert.equal(await readDiskVersion(repairDir), "4.0.0");
});
