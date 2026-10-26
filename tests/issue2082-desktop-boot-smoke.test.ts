// #2082: the dsh desktop profile refresh (refreshDshDesktopCopy, #1575) now
// runs a BOOT SMOKE over the freshly staged copy before committing to it —
// verifyEntries proves the declared entries parse, but a top-level throw or a
// broken import graph is syntactically valid and slips through. The desktop
// copy is what a RUNNING dsh respawns from when its proxy dies; committing an
// unbootable copy turns that respawn into an infinite give-up loop and the
// bili tools vanish until dsh restarts. A failed smoke rolls the working copy
// back to the previous version.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
// #2206: src/update.ts freezes its cache-dir paths (THROTTLE_FILE,
// BACKOFF_STATE_FILE, ...) at import time. The backoff state file is shared
// across processes, so a static import here would freeze the REAL
// ~/.cache paths and have these tests read (and write) the machine's live
// backoff state. Set the override BEFORE loading it — same discipline as
// update-backoff.test.ts / update-owner-lane-backoff.test.ts.
const __cacheRoot = mkdtempSync(path.join(tmpdir(), "bc-2082-smoke-cache-"));
process.env.XDG_CACHE_HOME = path.join(__cacheRoot, "cache");
const { installViaTarball, readDiskVersion, refreshDshDesktopCopy } = await import("../src/update.ts");
import { rmrf } from "./tmp-rm.ts";

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

function writePkg(dir: string, version: string, entry: string): void {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }),
    );
    writeFileSync(path.join(dir, "dist", "index.js"), entry);
}

const GOOD_ENTRY = "export const loaded = '__VERSION__';\n";
const BOOT_BROKEN_ENTRY = 'throw new Error("boom at boot (#2082 fixture)");\n';

/** Windows junctions need no SeCreateSymbolicLinkPrivilege (same trick as
 *  update-desktop-inplace.test.ts). */
function makePnpmLink(target: string, linkPath: string): void {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

interface Fixture { root: string; dshHome: string; storeCopy: string; flat: string; tgz: Buffer; }

function buildFixture(root: string, storeVersion: string, tarballVersion: string, tarballEntry: string): Fixture {
    const dshHome = path.join(root, "dsh-home");
    const profileDir = path.join(dshHome, "profiles", "desktop");
    const storeCopy = path.join(profileDir, ".pnpm", `billion-context@${storeVersion}`, "node_modules", "billion-context");
    writePkg(storeCopy, storeVersion, GOOD_ENTRY.replace("__VERSION__", storeVersion));
    mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });
    const flat = path.join(profileDir, "node_modules", "billion-context");
    makePnpmLink(storeCopy, flat);
    const src = path.join(root, "pkg", "package");
    writePkg(src, tarballVersion, tarballEntry.replace("__VERSION__", tarballVersion));
    const tgzPath = path.join(root, "pkg.tgz");
    tar.c({ cwd: path.join(root, "pkg"), file: tgzPath, gzip: true, sync: true }, ["package"]);
    return { root, dshHome, storeCopy, flat, tgz: readFileSync(tgzPath) };
}

function stubRegistryFetch(tgz: Buffer, tarballUrl: string, version: string, integrity: string): void {
    globalThis.fetch = ((url: unknown) => {
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

function captureLog(): { lines: string[]; log: CaptureLog } {
    const lines: string[] = [];
    const log: CaptureLog = (level, msg) => { lines.push(`${level}: ${msg}`); };
    return { lines, log };
}

test("installViaTarball bootSmoke: an entry that throws at boot fails the install and rolls the copy back (#2082)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-2082-smoke-bad-"));
    const prevDshHome = process.env.DSH_HOME;
    // Isolate the updater's cache dir too (#2106): without it these tests
    // wrote their update temps into the host's real ~/.cache/billion-context,
    // racing every other concurrent test file.
    const prevXdgCacheHome = process.env.XDG_CACHE_HOME;
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        if (prevXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = prevXdgCacheHome;
        rmrf(root);
    });
    try {
        const fx = buildFixture(root, "1.2.3", "2.0.0", BOOT_BROKEN_ENTRY);
        process.env.DSH_HOME = fx.dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        stubRegistryFetch(fx.tgz, "https://registry.test/bc-2.0.0.tgz", "2.0.0", integrityField(fx.tgz));

        const r = await installViaTarball("2.0.0", "https://registry.test/bc-2.0.0.tgz", fx.flat, integrityField(fx.tgz), undefined, undefined, process.env, { bootSmoke: true });
        assert.equal(r.ok, false, "a boot-broken artifact must not install");
        assert.match(r.error ?? "", /boot smoke/);
        assert.match(r.error ?? "", /boom at boot/);

        // the working copy was rolled back to the previous version
        assert.equal(await readDiskVersion(fx.flat), "1.2.3");
        assert.equal(readFileSync(path.join(fx.storeCopy, "dist", "index.js"), "utf8"), "export const loaded = '1.2.3';\n");
        // no displaced-link litter
        for (const entry of readdirSync(path.dirname(fx.flat))) {
            assert.ok(!entry.startsWith("billion-context.pnpm-"), `leftover displaced link: ${entry}`);
        }
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

test("installViaTarball bootSmoke: a loadable entry passes and the copy lands (#2082)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-2082-smoke-ok-"));
    const prevDshHome = process.env.DSH_HOME;
    const prevXdgCacheHome = process.env.XDG_CACHE_HOME;
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        if (prevXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = prevXdgCacheHome;
        rmrf(root);
    });
    try {
        const fx = buildFixture(root, "1.2.3", "2.0.0", GOOD_ENTRY);
        process.env.DSH_HOME = fx.dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        stubRegistryFetch(fx.tgz, "https://registry.test/bc-2.0.0.tgz", "2.0.0", integrityField(fx.tgz));

        const r = await installViaTarball("2.0.0", "https://registry.test/bc-2.0.0.tgz", fx.flat, integrityField(fx.tgz), undefined, undefined, process.env, { bootSmoke: true });
        assert.equal(r.ok, true, r.error ?? "install failed without reason");
        assert.equal(lstatSync(fx.flat).isSymbolicLink(), false, "the pnpm link must be replaced, not followed");
        assert.equal(await readDiskVersion(fx.flat), "2.0.0");
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

test("refreshDshDesktopCopy: a boot-broken registry tarball keeps the working copy and warns loudly (#2082)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-2082-drive-"));
    const prevDshHome = process.env.DSH_HOME;
    const prevXdgCacheHome = process.env.XDG_CACHE_HOME;
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        if (prevXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = prevXdgCacheHome;
        rmrf(root);
    });
    try {
        const fx = buildFixture(root, "1.2.3", "2.0.0", BOOT_BROKEN_ENTRY);
        process.env.DSH_HOME = fx.dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        stubRegistryFetch(fx.tgz, "https://registry.test/bc-2.0.0.tgz", "2.0.0", integrityField(fx.tgz));
        const { lines, log } = captureLog();
        await refreshDshDesktopCopy("2.0.0", log, process.env);

        assert.equal(await readDiskVersion(fx.flat), "1.2.3", "the working copy must survive a boot-broken tarball");
        assert.ok(
            lines.some((l) => l.startsWith("warn:") && l.includes("boot smoke")),
            `expected a boot-smoke warn line, got: ${lines.join(" | ")}`,
        );
        assert.ok(!lines.some((l) => l.includes("in place")), `no in-place success line: ${lines.join(" | ")}`);
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});
