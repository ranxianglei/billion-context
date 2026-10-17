// #2192: the owner-managed update lanes (dsh desktop in-place copy, dsh profile
// bundles, pi npm copy) bypassed the #1603 InstallBackoff — a persistently
// failing lane retried every check cycle forever, and the desktop lane
// re-downloaded its full tarball on every attempt (~480×/day at the default
// cadence). These pin the fix:
//   (a) a failing desktop refresh is a no-op inside the backoff window — no
//       registry call, no download;
//   (b) success resets the lane's key;
//   (c) profile/pi lanes get the same bounded retry with their existing
//       behavior preserved, keyed per lane+version;
//   (d) host-managed instances throttle on their own marker file with the
//       slower owner-lane cadence instead of the global 3-min one.
//
// THROTTLE_FILE / LOCK_FILE / OWNER_THROTTLE_FILE are module-level consts
// frozen at import time, so the cache-dir override MUST be set before
// dynamically importing src/update.ts (same discipline as
// update-backoff.test.ts).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { PiPlan } from "../src/pi-channel.ts";
import type { DshPlan } from "../src/dsh-channel.ts";
import { rmrf } from "./tmp-rm.ts";

const root = mkdtempSync(path.join(tmpdir(), "bc-owner-lane-backoff-"));
process.env.XDG_CACHE_HOME = path.join(root, "cache");
// #3619: the profile/pi lanes now pass through the update-policy gate before
// the backoff logic — stagger 0/0 + an unroutable policy URL keep this suite
// hermetic (same discipline as update-dsh-self-refresh.test.ts).
process.env.BILI_UPDATE_STAGGER_MIN_MS = "0";
process.env.BILI_UPDATE_STAGGER_MAX_MS = "0";
process.env.BILI_UPDATE_POLICY_URL = "http://127.0.0.1:1/no-policy.json";

const {
    refreshDshDesktopCopy,
    refreshPiNpmCopy,
    convergeDshProfileBundles,
    checkForUpdate,
    _resetInstallBackoffForTest,
    _resetUpdateThrottleForTest,
    _installBackoffStateForTest,
    _backoffCooldownForTest,
    _reloadBackoffsForTest,
    clearOwnerLaneBackoff,
    ownerLaneKey,
    ownerLaneIntervalMs,
} = await import("../src/update.ts");
const { _setPiRunnersForTest } = await import("../src/pi-channel.ts");
const { _setDshRunnersForTest } = await import("../src/dsh-channel.ts");
const { setLogCapture } = await import("../src/logger.ts");

after(() => {
    delete process.env.XDG_CACHE_HOME;
    delete process.env.BILI_UPDATE_STAGGER_MIN_MS;
    delete process.env.BILI_UPDATE_STAGGER_MAX_MS;
    delete process.env.BILI_UPDATE_POLICY_URL;
    rmrf(root);
});

// — shared fixtures (shapes mirrored from update-desktop-inplace.test.ts) ————

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

/** The laid-down package's dist/index.js. The stock form boots clean under
 *  the boot smoke; pass something that exits non-zero to make
 *  installViaTarball fail AFTER the full download (the bandwidth-burning
 *  failure shape from the field repro). */
function writePkg(dir: string, version: string, entry: string = `export const loaded = '${version}';\n`): void {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }),
    );
    writeFileSync(path.join(dir, "dist", "index.js"), entry);
}

function makePnpmLink(target: string, linkPath: string): void {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

interface DesktopFixture { dshHome: string; flat: string; tgz: Buffer; }

function buildDesktopFixture(base: string, storeVersion: string, tarballVersion: string, entry?: string): DesktopFixture {
    const dshHome = path.join(base, "dsh-home");
    const profileDir = path.join(dshHome, "profiles", "desktop");
    const storeCopy = path.join(profileDir, ".pnpm", `billion-context@${storeVersion}`, "node_modules", "billion-context");
    const flat = path.join(profileDir, "node_modules", "billion-context");
    writePkg(storeCopy, storeVersion);
    mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });
    makePnpmLink(storeCopy, flat);
    const src = path.join(base, "pkg", "package");
    writePkg(src, tarballVersion, entry);
    const tgzPath = path.join(base, "pkg.tgz");
    tar.c({ cwd: path.join(base, "pkg"), file: tgzPath, gzip: true, sync: true }, ["package"]);
    return { dshHome, flat, tgz: readFileSync(tgzPath) };
}

function stubRegistryFetch(tgz: Buffer, tarballUrl: string, version: string, integrity: string, hits: { count: number }): void {
    globalThis.fetch = ((url: unknown) => {
        hits.count += 1;
        const u = String(url);
        if (u.endsWith(`/billion-context/${version}`)) {
            return Promise.resolve(new Response(JSON.stringify({ dist: { tarball: tarballUrl, integrity } }), { headers: { "content-type": "application/json" } }));
        }
        if (u === tarballUrl) {
            return Promise.resolve(new Response(tgz));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${u}`));
    }) as unknown as typeof fetch;
}

type CaptureLog = (level: string, msg: string) => void;

/** Taps both logging channels into one array: the injected log param AND the
 * module-level loggerLog via setLogCapture — recordInstallFailure reports
 * through loggerLog, not the injected log, so backoff streak/escalation lines
 * only land there. */
function captureAll(): { lines: string[]; log: CaptureLog } {
    const lines: string[] = [];
    const log: CaptureLog = (level, msg) => { lines.push(`${level}: ${msg}`); };
    setLogCapture((_level, msg) => { lines.push(msg); });
    return { lines, log };
}

// — (a)+(b) desktop lane —————————————————————————————————————————————————————————

test("desktop lane: a persistently failing refresh backs off — silent no-op inside the window (#2192)", { timeout: 60_000 }, async (t) => {
    await _resetInstallBackoffForTest();
    const base = mkdtempSync(path.join(root, "t1-"));
    const prevDshHome = process.env.DSH_HOME;
    const originalFetch = globalThis.fetch;
    t.after(() => {
        setLogCapture(null);
        globalThis.fetch = originalFetch;
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        rmrf(base);
    });
    try {
        // store copy at 1.2.3; the 2.0.0 tarball's entry exits non-zero, so
        // every attempt downloads fully and then fails at the boot smoke.
        const fx = buildDesktopFixture(base, "1.2.3", "2.0.0", 'console.error("smoke-broken"); process.exitCode = 3;\n');
        process.env.DSH_HOME = fx.dshHome;
        const hits = { count: 0 };
        stubRegistryFetch(fx.tgz, "https://registry.test/bc-2.0.0.tgz", "2.0.0", integrityField(fx.tgz), hits);
        const { lines, log } = captureAll();

        for (let i = 0; i < 4; i++) await refreshDshDesktopCopy("2.0.0", log, process.env);

        // three attempts × (version doc + tarball); the fourth call is a
        // silent no-op inside the backoff window (pre-fix: attempt four of
        // ~480/day).
        assert.equal(hits.count, 6, `expected 6 registry hits after 4 calls, got ${hits.count}: ${lines.join(" | ")}`);
        assert.ok(lines.some((l) => l.includes("keeps failing")), `expected an escalation line: ${lines.join(" | ")}`);
        assert.ok(lines.some((l) => l.includes("Backing off")), `expected the backoff announcement: ${lines.join(" | ")}`);
        assert.ok(lines.some((l) => l.includes("recreate the desktop profile")), `expected the desktop-specific actionable hint: ${lines.join(" | ")}`);

        // proof the cooldown attempt touches nothing: fetch now throws.
        globalThis.fetch = (() => Promise.reject(new Error("network must not be touched inside the backoff window"))) as unknown as typeof fetch;
        await refreshDshDesktopCopy("2.0.0", log, process.env);
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

test("desktop lane: success resets the owner-lane key, a fresh streak starts over (#2192)", { timeout: 60_000 }, async (t) => {
    await _resetInstallBackoffForTest();
    const base = mkdtempSync(path.join(root, "t2-"));
    const prevDshHome = process.env.DSH_HOME;
    const originalFetch = globalThis.fetch;
    t.after(() => {
        setLogCapture(null);
        globalThis.fetch = originalFetch;
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        rmrf(base);
    });
    try {
        const key = ownerLaneKey("dsh-desktop", "2.0.0");
        const badFx = buildDesktopFixture(path.join(base, "bad"), "1.2.3", "2.0.0", 'process.exitCode = 3;\n');
        const goodFx = buildDesktopFixture(path.join(base, "good"), "1.2.3", "2.0.0");
        const hits = { count: 0 };
        const { lines, log } = captureAll();

        process.env.DSH_HOME = badFx.dshHome;
        stubRegistryFetch(badFx.tgz, "https://registry.test/bad.tgz", "2.0.0", integrityField(badFx.tgz), hits);
        await refreshDshDesktopCopy("2.0.0", log, process.env);
        await refreshDshDesktopCopy("2.0.0", log, process.env);
        assert.equal(_installBackoffStateForTest()[key]?.count, 2, "two strikes recorded below the threshold");

        // same stale copy, healthy tarball → success clears the key
        process.env.DSH_HOME = goodFx.dshHome;
        stubRegistryFetch(goodFx.tgz, "https://registry.test/good.tgz", "2.0.0", integrityField(goodFx.tgz), hits);
        await refreshDshDesktopCopy("2.0.0", log, process.env);
        assert.ok(lines.some((l) => l.startsWith("info:") && l.includes("in place")), `success line missing: ${lines.join(" | ")}`);
        assert.equal(_installBackoffStateForTest()[key], undefined, "success must clear the lane's key");

        // a fresh failure streak starts over from one strike
        process.env.DSH_HOME = badFx.dshHome;
        stubRegistryFetch(badFx.tgz, "https://registry.test/bad2.tgz", "2.0.0", integrityField(badFx.tgz), hits);
        await refreshDshDesktopCopy("2.0.0", log, process.env);
        assert.equal(_installBackoffStateForTest()[key]?.count, 1, "streak restarts after a reset");
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

// — (c) profile + pi lanes —————————————————————————————————————————————————————

test("profile lane: repeated bundle failures back off per lane+version; new version re-arms; lanes independent (#2192)", { timeout: 60_000 }, async (t) => {
    await _resetInstallBackoffForTest();
    const base = mkdtempSync(path.join(root, "t3-"));
    t.after(() => {
        setLogCapture(null);
        _setDshRunnersForTest(undefined);
        _setPiRunnersForTest(undefined);
        rmrf(base);
    });
    try {
        const dshHome = path.join(base, "dsh");
        const aDir = path.join(dshHome, "profiles", "a");
        const installDir = path.join(aDir, "node_modules", "billion-context");
        mkdirSync(installDir, { recursive: true });
        writeFileSync(path.join(aDir, "package.json"), JSON.stringify({ private: true, dependencies: { "billion-context": "^1.0.0" } }));
        writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version: "1.0.0" }));
        const env = { ...process.env, DSH_HOME: dshHome };

        const calls: string[] = [];
        _setDshRunnersForTest({
            async: async (plan: DshPlan) => {
                calls.push(plan.args.join(" "));
                throw Object.assign(new Error("exit 1"), { status: 1, stderr: "plugin channel down" });
            },
        });
        const { lines, log } = captureAll();

        for (let i = 0; i < 4; i++) await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 3, `expected 3 CLI attempts, got ${calls.length}: ${lines.join(" | ")}`);
        const key = ownerLaneKey("dsh-profile", "2.0.0");
        assert.equal(_installBackoffStateForTest()[key]?.count, 3, "third strike arms the cooldown");
        assert.ok(lines.some((l) => l.includes("keeps failing") && l.includes("dsh plugin --profile")), `expected the profile-specific actionable hint: ${lines.join(" | ")}`);

        // a new version re-arms the lane even mid-cooldown (the key is per version)
        await convergeDshProfileBundles("/nonexistent", "3.0.0", env, log);
        assert.equal(calls.length, 4, "new version must re-arm the lane");

        // the pi lane keeps attempting while the profile lane is cooling down
        const piHome = path.join(base, "pi-home");
        const piCopy = path.join(piHome, "npm", "node_modules", "billion-context");
        mkdirSync(piCopy, { recursive: true });
        writeFileSync(path.join(piCopy, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.139" }));
        writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: ["npm:billion-context"] }));
        const piCalls: string[] = [];
        _setPiRunnersForTest({
            async: async () => {
                piCalls.push("spawned");
                throw Object.assign(new Error("exit 1"), { status: 1, stderr: "pi down" });
            },
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ version: "0.1.140" })))) as unknown as typeof fetch;
        try {
            await refreshPiNpmCopy(piCopy, { packageName: "billion-context", currentVersion: "0.1.139", autoUpdate: true }, { ...env, PI_CODING_AGENT_DIR: piHome }, log);
        } finally {
            globalThis.fetch = originalFetch;
        }
        assert.equal(piCalls.length, 1, "the pi lane is not affected by the profile lane's cooldown");
    } finally {
        _setDshRunnersForTest(undefined);
        _setPiRunnersForTest(undefined);
    }
});

// — (d2) mixed outcome pins the lane semantics: ANY failed profile is a strike (#2192)

test("a partial failure (some profiles refreshed, one broken) still records a lane strike (#2192)", { timeout: 60_000 }, async (t) => {
    await _resetInstallBackoffForTest();
    const base = mkdtempSync(path.join(root, "t4b-"));
    t.after(() => {
        setLogCapture(null);
        _setDshRunnersForTest(undefined);
        rmrf(base);
    });
    const dshHome = path.join(base, "dsh");
    for (const name of ["a", "b"]) {
        const pDir = path.join(dshHome, "profiles", name);
        const install = path.join(pDir, "node_modules", "billion-context");
        mkdirSync(install, { recursive: true });
        writeFileSync(path.join(pDir, "package.json"), JSON.stringify({ private: true, dependencies: { "billion-context": "^1.0.0" } }));
        writeFileSync(path.join(install, "package.json"), JSON.stringify({ name: "billion-context", version: "1.0.0" }));
    }
    const env = { ...process.env, DSH_HOME: dshHome };
    const calls: string[] = [];
    const failingFor = (broken: string) => async (plan: DshPlan) => {
        // windows wraps the whole invocation into one cmd.exe line token
        // (planDshSpawn → ["/d","/s","/c","\"…dsh.cmd\" plugin --profile b …"]),
        // so match on the joined string instead of indexing the args array
        const joined = plan.args.join(" ");
        const m = /--profile (\S+)/.exec(joined);
        const target = m?.[1] ?? "?";
        calls.push(`${target}:${joined}`);
        if (target === broken) throw Object.assign(new Error("exit 1"), { status: 1, stderr: "plugin channel down" });
        return { stdout: "", stderr: "" };
    };
    try {
        const { log } = captureAll();
        const key = ownerLaneKey("dsh-profile", "2.0.0");
        _setDshRunnersForTest({ async: failingFor("b") });

        // converge #1: profile a converges, b fails — a PARTIAL failure must
        // still count as a lane strike (runProfileBundlesRefresh strikes on any
        // res.failed > 0; the PR-body claim "partial success → no strike" was
        // wrong and this test pins the shipped semantics).
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 2, `both profiles attempted once: ${calls.join(" | ")}`);
        assert.equal(_installBackoffStateForTest()[key]?.count, 1, "a partial failure (1 of 2 profiles) records a strike");

        // strikes accumulate the same way as total failures; third strike arms
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(_installBackoffStateForTest()[key]?.count, 3, "third partial failure arms the cooldown");
        // once armed the whole lane is gated — even healthy profile a stops spawning
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 6, "an armed lane must not spawn for ANY profile, healthy ones included");

        // manual disarm + repairing b lets the lane run again and a clean pass clears the key
        await clearOwnerLaneBackoff("dsh-profile", "2.0.0");
        _setDshRunnersForTest({ async: failingFor("none") });
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 8, "a disarmed, repaired lane attempts both profiles again");
        assert.equal(_installBackoffStateForTest()[key], undefined, "a clean run clears the lane key");
    } finally {
        _setDshRunnersForTest(undefined);
    }
});

test("pi lane: bounded retries, existing manual-fix warn preserved, success clears, new version re-arms (#2192)", async (t) => {
    await _resetInstallBackoffForTest();
    const base = mkdtempSync(path.join(root, "t3b-"));
    const originalFetch = globalThis.fetch;
    t.after(() => {
        setLogCapture(null);
        _setPiRunnersForTest(undefined);
        globalThis.fetch = originalFetch;
        rmrf(base);
    });
    const piHome = path.join(base, "pi");
    const installDir = path.join(piHome, "npm", "node_modules", "billion-context");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.139" }));
    writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: ["npm:billion-context"] }));
    const env = { ...process.env, PI_CODING_AGENT_DIR: piHome };
    const opts = { packageName: "billion-context", currentVersion: "0.1.139", autoUpdate: true };
    const { lines, log } = captureAll();
    const calls: string[] = [];
    let latest = "0.1.140";
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ version: latest })))) as unknown as typeof fetch;

    const failingRunner = async (plan: PiPlan) => {
        calls.push(plan.args.join(" "));
        throw Object.assign(new Error("exit 1"), { status: 1, stderr: "pi down" });
    };
    const okRunner = async (plan: PiPlan) => {
        calls.push(plan.args.join(" "));
        return { stdout: "", stderr: "" };
    };
    try {
        // two strikes, below the threshold
        _setPiRunnersForTest({ async: failingRunner });
        await refreshPiNpmCopy(installDir, opts, env, log);
        await refreshPiNpmCopy(installDir, opts, env, log);
        const key = ownerLaneKey("pi-npm", "0.1.140");
        assert.equal(calls.length, 2);
        assert.equal(_installBackoffStateForTest()[key]?.count, 2, "two strikes recorded below the threshold");

        // a healthy channel still runs and clears the key
        _setPiRunnersForTest({ async: okRunner });
        await refreshPiNpmCopy(installDir, opts, env, log);
        assert.equal(calls.length, 3);
        assert.ok(lines.some((l) => l.includes("refreshed to 0.1.140")), `success line missing: ${lines.join(" | ")}`);
        assert.equal(_installBackoffStateForTest()[key], undefined, "success must clear the lane's key");

        // three strikes arm the cooldown; the fourth call is a silent no-op
        _setPiRunnersForTest({ async: failingRunner });
        await refreshPiNpmCopy(installDir, opts, env, log);
        await refreshPiNpmCopy(installDir, opts, env, log);
        await refreshPiNpmCopy(installDir, opts, env, log);
        assert.equal(calls.length, 6);
        assert.equal(_installBackoffStateForTest()[key]?.count, 3, "third strike arms the cooldown");
        assert.ok(lines.some((l) => l.includes("keeps failing") && l.includes("BILI_PI_BIN")), `expected the pi-specific actionable hint: ${lines.join(" | ")}`);
        // the pre-existing manual-fix warn stays intact: one per failed spawn
        // (2 in the first phase + 3 here)
        assert.equal(lines.filter((l) => l.includes("manual fix: run `pi update --extension npm:billion-context`")).length, 5, "every failed spawn keeps its manual-fix warn");
        const staleBefore = lines.filter((l) => l.includes("pi npm copy is stale")).length;
        await refreshPiNpmCopy(installDir, opts, env, log);
        assert.equal(calls.length, 6, "fourth call inside the window must not spawn");
        assert.equal(lines.filter((l) => l.includes("pi npm copy is stale")).length, staleBefore, "cooldown call is fully silent — not even the stale transition logs");

        // a new version re-arms the lane even mid-cooldown
        latest = "0.1.141";
        await refreshPiNpmCopy(installDir, opts, env, log);
        assert.equal(calls.length, 7, "new version must re-arm the lane");
    } finally {
        _setPiRunnersForTest(undefined);
    }
});

// — (d) host-managed throttle marker ———————————————————————————————————————————

test("host-managed instances throttle on their own marker with the owner-lane cadence (#2192)", async (t) => {
    await _resetInstallBackoffForTest();
    await _resetUpdateThrottleForTest();
    const base = mkdtempSync(path.join(root, "t4-"));
    const prevDshHome = process.env.DSH_HOME;
    const originalFetch = globalThis.fetch;
    const captured: string[] = [];
    setLogCapture((_l, msg) => { captured.push(msg); });
    t.after(() => {
        setLogCapture(null);
        globalThis.fetch = originalFetch;
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        rmrf(base);
    });
    try {
        const dshHome = path.join(base, "dsh");
        const aDir = path.join(dshHome, "profiles", "a");
        const installDir = path.join(aDir, "node_modules", "billion-context");
        mkdirSync(installDir, { recursive: true });
        writeFileSync(path.join(aDir, "package.json"), JSON.stringify({ private: true, dependencies: { "billion-context": "^1.0.0" } }));
        writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version: "1.0.0" }));
        process.env.DSH_HOME = dshHome;

        const hits = { count: 0 };
        globalThis.fetch = (() => {
            hits.count += 1;
            return Promise.resolve(new Response(JSON.stringify({ version: "1.0.0" })));
        }) as unknown as typeof fetch;
        const opts = { packageName: "billion-context", currentVersion: "1.0.0", autoUpdate: true, installDir };
        const ownerMarker = path.join(process.env.XDG_CACHE_HOME!, "billion-context", ".owner-update-check");
        const globalMarker = path.join(process.env.XDG_CACHE_HOME!, "billion-context", ".update-check");

        await checkForUpdate(opts, false);
        const afterFirst = hits.count;
        assert.ok(afterFirst > 0, "first cycle runs (first check ignores throttle)");
        assert.ok(existsSync(ownerMarker), "owner lane writes its own marker");
        assert.ok(!existsSync(globalMarker), "owner lane never writes the global marker");

        await checkForUpdate(opts, false);
        assert.equal(hits.count, afterFirst, "second immediate cycle is throttled — zero registry traffic");
        assert.ok(captured.some((l) => l.includes("throttled")), `expected a throttle notice: ${captured.join(" | ")}`);

        await checkForUpdate(opts, true);
        const afterForce = hits.count;
        assert.ok(afterForce > afterFirst, "force bypasses the owner throttle");

        await _resetUpdateThrottleForTest();
        await checkForUpdate(opts, false);
        assert.ok(hits.count > afterForce, "reset re-enables non-forced cycles");

        // global-lane control: a plain scratch install still uses the global marker
        await _resetUpdateThrottleForTest();
        const gDir = path.join(base, "global", "node_modules", "billion-context");
        mkdirSync(gDir, { recursive: true });
        writeFileSync(path.join(gDir, "package.json"), JSON.stringify({ name: "billion-context", version: "1.0.0" }));
        const beforeGlobal = hits.count;
        await checkForUpdate({ ...opts, installDir: gDir }, false);
        assert.ok(hits.count > beforeGlobal, "global lane still checks normally");
        assert.ok(existsSync(globalMarker), "global lane writes the global marker");
    } finally {
        setLogCapture(null);
    }
});

test("ownerLaneIntervalMs: 10 min floor, 5 min jitter ceiling (#2192, owner cadence call 2026-10-07)", () => {
    assert.equal(ownerLaneIntervalMs(() => 0), 10 * 60_000);
    assert.equal(ownerLaneIntervalMs(() => 1), 15 * 60_000);
    assert.equal(ownerLaneIntervalMs(() => 0.5), 12 * 60_000 + 30_000);
});

// — (e) cross-process streak sharing + manual-repair disarm (#2192 follow-up) —

function stateFilePath(): string {
    return path.join(process.env.XDG_CACHE_HOME!, "billion-context", ".install-backoff.json");
}

function readStateFile(): { entries: Record<string, { count: number; nextRetryAt: number }> } {
    return JSON.parse(readFileSync(stateFilePath(), "utf-8")) as { entries: Record<string, { count: number; nextRetryAt: number }> };
}

test("streaks are shared across bili processes via the cache-dir state file; a manual fix disarms immediately (#2192)", { timeout: 60_000 }, async (t) => {
    await _resetInstallBackoffForTest();
    const base = mkdtempSync(path.join(root, "t5-"));
    t.after(() => {
        setLogCapture(null);
        _setDshRunnersForTest(undefined);
        rmrf(base);
    });
    const dshHome = path.join(base, "dsh");
    const aDir = path.join(dshHome, "profiles", "a");
    const installDir = path.join(aDir, "node_modules", "billion-context");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(path.join(aDir, "package.json"), JSON.stringify({ private: true, dependencies: { "billion-context": "^1.0.0" } }));
    writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version: "1.0.0" }));
    const env = { ...process.env, DSH_HOME: dshHome };

    const calls: string[] = [];
    const failing = async (plan: DshPlan) => {
        calls.push(plan.args.join(" "));
        throw Object.assign(new Error("exit 1"), { status: 1, stderr: "plugin channel down" });
    };
    const healthy = async (plan: DshPlan) => {
        calls.push(plan.args.join(" "));
        return { stdout: "", stderr: "" };
    };
    try {
        _setDshRunnersForTest({ async: failing });
        const { log } = captureAll();
        const key = ownerLaneKey("dsh-profile", "2.0.0");

        // arm the cooldown (3 strikes) in "process one"
        for (let i = 0; i < 3; i++) await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 3);
        assert.equal(_installBackoffStateForTest()[key]?.count, 3, "third strike arms the cooldown");
        assert.ok(existsSync(stateFilePath()), "armed cooldown must be persisted to the cache-dir state file");
        assert.equal(readStateFile().entries[key]?.count, 3, "the state file carries the armed streak");

        // "process two" — fresh in-memory map, same state file on disk — honors
        // the cooldown written by process one (pre-fix: k instances each burned
        // their own 3-strike budget, multiplying the retry rate k×).
        _reloadBackoffsForTest();
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 3, "a fresh process must honor the shared cooldown — no 4th spawn");

        // a successful manual repair (`bili plugin update`) disarms the lane
        // immediately instead of waiting out the ≤6 h window
        await clearOwnerLaneBackoff("dsh-profile", "2.0.0");
        assert.equal(_installBackoffStateForTest()[key], undefined, "manual clear wipes the armed entry");
        _reloadBackoffsForTest();
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 4, "disarmed lane attempts again");

        // and a healthy run clears the streak for good — the state file drops
        // the key once nothing is cooling down
        _setDshRunnersForTest({ async: healthy });
        await convergeDshProfileBundles("/nonexistent", "2.0.0", env, log);
        assert.equal(calls.length, 5);
        const persisted = existsSync(stateFilePath()) ? readStateFile().entries[key] : undefined;
        assert.equal(persisted, undefined, "success must drop the key from the state file");
    } finally {
        _setDshRunnersForTest(undefined);
    }
});

// — (f) the state file can never silence a lane (#2192 follow-up) —

test("a corrupt or clock-skewed backoff state file biases toward retrying, never silence (#2192)", { timeout: 60_000 }, async (t) => {
    await _resetInstallBackoffForTest();
    const base = mkdtempSync(path.join(root, "t6-"));
    const prevDshHome = process.env.DSH_HOME;
    const originalFetch = globalThis.fetch;
    t.after(() => {
        setLogCapture(null);
        globalThis.fetch = originalFetch;
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        rmrf(base);
    });
    try {
        const fx = buildDesktopFixture(base, "1.2.3", "2.0.0"); // healthy tarball
        process.env.DSH_HOME = fx.dshHome;
        const hits = { count: 0 };
        stubRegistryFetch(fx.tgz, "https://registry.test/bc-2.0.0.tgz", "2.0.0", integrityField(fx.tgz), hits);
        const { lines, log } = captureAll();
        const key = ownerLaneKey("dsh-desktop", "2.0.0");

        // (1) garbage file — not even valid JSON: dropped, lane attempts
        mkdirSync(path.dirname(stateFilePath()), { recursive: true });
        writeFileSync(stateFilePath(), "{{{not json at all");
        _reloadBackoffsForTest();
        await refreshDshDesktopCopy("2.0.0", log, process.env);
        assert.ok(hits.count > 0, `a corrupt state file must not stop the lane: ${lines.join(" | ")}`);
        assert.ok(lines.some((l) => l.startsWith("info:") && l.includes("in place")), `healthy refresh expected: ${lines.join(" | ")}`);
        assert.equal(_installBackoffStateForTest()[key], undefined, "success clears the lane key");

        // (2) clock-skew guard: an armed cooldown dated 90 days out can only be
        // a jumped clock or bit rot — dropped so the lane re-arms instead of
        // going silent for months
        const far = Date.now() + 90 * 24 * 60 * 60 * 1000;
        writeFileSync(stateFilePath(), JSON.stringify({ v: 1, entries: { [key]: { count: 9, nextRetryAt: far, updatedAt: Date.now() } } }));
        // reset the disk to stale so the refresh actually has work to do
        const fx2 = buildDesktopFixture(path.join(base, "again"), "1.2.3", "2.0.0");
        process.env.DSH_HOME = fx2.dshHome;
        stubRegistryFetch(fx2.tgz, "https://registry.test/bc2-2.0.0.tgz", "2.0.0", integrityField(fx2.tgz), hits);
        const hitsBefore = hits.count;
        _reloadBackoffsForTest();
        // non-vacuous: prove the skew entry is dropped AT LOAD/GATE TIME, not
        // merely overwritten by a later persist racing the file
        assert.equal(await _backoffCooldownForTest(key), false, "a clock-skewed entry must be dropped at the gate, never obeyed");
        assert.equal(_installBackoffStateForTest()[key], undefined, "the skew entry must not live in the map after load");
        await refreshDshDesktopCopy("2.0.0", log, process.env);
        assert.ok(hits.count > hitsBefore, `a clock-skewed state entry must be dropped, not obeyed: ${lines.join(" | ")}`);
        assert.ok(_installBackoffStateForTest()[key] === undefined, "the healthy run cleared the lane key");
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});
