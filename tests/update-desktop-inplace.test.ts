// #1575 (owner decision): the dsh DESKTOP profile copy is updated IN PLACE by
// bili's own tarball installer. On disk the flat node_modules entry is a pnpm
// symlink/junction into <profile>/.pnpm/billion-context@<ver>/.... The
// installer must displace the LINK itself (fs.cp would follow it into the
// shared, hardlinked, integrity-checked store) and lay down the verified
// package as a real directory at the same path. The store copy underneath
// stays byte-identical.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
// #2206: src/update.ts freezes its cache-dir paths (THROTTLE_FILE,
// BACKOFF_STATE_FILE, ...) at import time — a static import would freeze the
// REAL ~/.cache paths and have these tests read (and write) the machine's
// live cross-process backoff state. Override BEFORE loading it (same
// discipline as update-backoff.test.ts).
const __cacheRoot = mkdtempSync(path.join(tmpdir(), "bc-desktop-inplace-cache-"));
process.env.XDG_CACHE_HOME = path.join(__cacheRoot, "cache");
const { installViaTarball, readDiskVersion, refreshDshDesktopCopy, dshDesktopCopyPathMatches } = await import("../src/update.ts");
import { refreshDshProfileBundles, syncDshProfileManifestSpec } from "../src/dsh-channel.ts";
import { rmrf } from "./tmp-rm.ts";

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

function writePkg(dir: string, version: string): void {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }),
    );
    writeFileSync(path.join(dir, "dist", "index.js"), `export const loaded = '${version}';\n`);
}

/** Create the flat node_modules link the way pnpm does on each platform.
 * Windows directory junctions need no SeCreateSymbolicLinkPrivilege, so the
 * junction path (rename the link itself, never follow it) stays covered on
 * windows runners instead of being skipped (EPERM). */
function makePnpmLink(target: string, linkPath: string): void {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

test("desktop profile copy: link displaced, real dir laid down, .pnpm store untouched (#1575)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-inplace-"));
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
        const dshHome = path.join(root, "dsh-home");
        const profileDir = path.join(dshHome, "profiles", "desktop");
        const storeCopy = path.join(profileDir, ".pnpm", "billion-context@1.2.3", "node_modules", "billion-context");
        const flat = path.join(profileDir, "node_modules", "billion-context");
        writePkg(storeCopy, "1.2.3");
        mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });
        makePnpmLink(storeCopy, flat);
        process.env.DSH_HOME = dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");

        const src = path.join(root, "pkg", "package");
        writePkg(src, "2.0.0");
        const tgzPath = path.join(root, "pkg.tgz");
        tar.c({ cwd: path.join(root, "pkg"), file: tgzPath, gzip: true, sync: true }, ["package"]);
        const tgz = readFileSync(tgzPath);

        globalThis.fetch = (() => Promise.resolve(new Response(tgz))) as unknown as typeof fetch;
        const r = await installViaTarball("2.0.0", "https://registry.test/x.tgz", flat, integrityField(tgz));
        assert.equal(r.ok, true, r.error ?? "install failed without reason");

        assert.equal(lstatSync(flat).isSymbolicLink(), false, "the pnpm link must be replaced, not followed");
        assert.equal(lstatSync(flat).isDirectory(), true);
        assert.equal(await readDiskVersion(flat), "2.0.0");
        assert.equal(readFileSync(path.join(flat, "dist", "index.js"), "utf8"), "export const loaded = '2.0.0';\n");

        // the shared store copy the link pointed into stays byte-identical
        assert.equal(await readDiskVersion(storeCopy), "1.2.3");
        assert.equal(readFileSync(path.join(storeCopy, "dist", "index.js"), "utf8"), "export const loaded = '1.2.3';\n");

        // no displaced-link litter next to the install entry
        for (const entry of readdirSync(path.dirname(flat))) {
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

// —— drive-path coverage: refreshDshDesktopCopy + the channel skip (#1575) —————————

interface DesktopFixture { root: string; dshHome: string; storeCopy: string; flat: string; tgz: Buffer; }

function buildDesktopFixture(root: string, storeVersion: string, tarballVersion: string): DesktopFixture {
    const dshHome = path.join(root, "dsh-home");
    const profileDir = path.join(dshHome, "profiles", "desktop");
    const storeCopy = path.join(profileDir, ".pnpm", `billion-context@${storeVersion}`, "node_modules", "billion-context");
    const flat = path.join(profileDir, "node_modules", "billion-context");
    writePkg(storeCopy, storeVersion);
    mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });
    makePnpmLink(storeCopy, flat);
    const src = path.join(root, "pkg", "package");
    writePkg(src, tarballVersion);
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

// level stays string: must satisfy src/logger.ts Logger (refreshDshDesktopCopy) yet remain assignable to refreshDshProfileBundles' narrower ("info" | "warn") param.
type CaptureLog = (level: string, msg: string) => void;

function captureLog(): { lines: string[]; log: CaptureLog } {
    const lines: string[] = [];
    const log: CaptureLog = (level, msg) => { lines.push(`${level}: ${msg}`); };
    return { lines, log };
}

// #7139: the maturity gate resolves the profile's pnpm policy from the env it
// is given (user ~/.npmrc, global config.yaml, $PREFIX/etc/npmrc). The
// drive-path tests must not see the machine's real config — point
// HOME/XDG_CONFIG_HOME/PREFIX at empty temp dirs.
function hermeticPolicyEnv(root: string): NodeJS.ProcessEnv {
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".config"), { recursive: true });
    return { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PREFIX: path.join(root, "prefix") };
}

test("refreshDshDesktopCopy: stale junction displaced in place through the full drive path (#1575)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-drive-"));
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
        const fx = buildDesktopFixture(root, "1.2.3", "2.0.0");
        process.env.DSH_HOME = fx.dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        stubRegistryFetch(fx.tgz, "https://registry.test/bc-2.0.0.tgz", "2.0.0", integrityField(fx.tgz));
        const { lines, log } = captureLog();
        await refreshDshDesktopCopy("2.0.0", log, hermeticPolicyEnv(root));

        assert.equal(lstatSync(fx.flat).isSymbolicLink(), false, "the pnpm link must be replaced, not followed");
        assert.equal(lstatSync(fx.flat).isDirectory(), true);
        assert.equal(await readDiskVersion(fx.flat), "2.0.0");
        // shared store copy stays byte-identical
        assert.equal(await readDiskVersion(fx.storeCopy), "1.2.3");
        for (const entry of readdirSync(path.dirname(fx.flat))) {
            assert.ok(!entry.startsWith("billion-context.pnpm-"), `leftover displaced link: ${entry}`);
        }
        assert.ok(lines.some((l) => l.startsWith("info:") && l.includes("in place") && l.includes("2.0.0")), `expected an in-place success line, got: ${lines.join(" | ")}`);
        assert.ok(!lines.some((l) => l.startsWith("warn:")), `unexpected warns: ${lines.join(" | ")}`);
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

test("refreshDshDesktopCopy: in-step copy untouched, no registry traffic (#1575)", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-step-"));
    const prevDshHome = process.env.DSH_HOME;
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        rmrf(root);
    });
    const dshHome = path.join(root, "dsh-home");
    const flat = path.join(dshHome, "profiles", "desktop", "node_modules", "billion-context");
    writePkg(flat, "2.0.0");
    process.env.DSH_HOME = dshHome;
    globalThis.fetch = (() => Promise.reject(new Error("no registry traffic expected while in step"))) as unknown as typeof fetch;
    const { lines, log } = captureLog();
    await refreshDshDesktopCopy("2.0.0", log, process.env);
    assert.deepEqual(lines, [], `in-step must be silent, got: ${lines.join(" | ")}`);
    assert.equal(readFileSync(path.join(flat, "dist", "index.js"), "utf8"), "export const loaded = '2.0.0';\n");
});

test("refreshDshDesktopCopy: absent desktop profile returns silently (#1575)", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-absent-"));
    const prevDshHome = process.env.DSH_HOME;
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        rmrf(root);
    });
    const dshHome = path.join(root, "dsh-home");
    mkdirSync(path.join(dshHome, "profiles", "desktop"), { recursive: true });
    process.env.DSH_HOME = dshHome;
    globalThis.fetch = (() => Promise.reject(new Error("no fetch expected when the desktop profile is absent"))) as unknown as typeof fetch;
    const { lines, log } = captureLog();
    await refreshDshDesktopCopy("9.9.9", log, process.env);
    assert.deepEqual(lines, []);
});

test("refreshDshProfileBundles skips the desktop profile without spawning the CLI (#1575)", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-skip-"));
    const prevDshHome = process.env.DSH_HOME;
    t.after(() => {
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        rmrf(root);
    });
    const dshHome = path.join(root, "dsh-home");
    for (const name of ["web", "desktop"]) {
        const dir = path.join(dshHome, "profiles", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `@dsh/profile-${name}`, dependencies: { "billion-context": "^0.1.170" } }));
    }
    process.env.DSH_HOME = dshHome;
    const env = { ...process.env, BILI_DSH_BIN: path.join(root, "no-such-dsh-binary") };
    const { lines, log } = captureLog();
    const result = await refreshDshProfileBundles("2.0.0", log, env);
    assert.deepEqual(result, { refreshed: 0, failed: 1 }); // web's CLI attempt fails (missing binary); desktop was never attempted
    assert.ok(!lines.some((l) => l.includes("profile desktop")), `must not attempt the CLI for desktop: ${lines.join(" | ")}`);
    // control: a non-desktop registry-pinned stale profile DID attempt the CLI,
    // proving this harness detects attempts — the desktop silence above is a skip,
    // not a missing probe.
    assert.ok(lines.some((l) => l.includes("profile web") && l.includes("failed")), `expected the web profile's CLI attempt to fail visibly: ${lines.join(" | ")}`);
});

// —— #2894: the in-place swap must converge the profile's pnpm manifest too ———

test("refreshDshDesktopCopy: manifest spec converges to the installed version, rest of the manifest preserved (#2894)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-manifest-"));
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
        const fx = buildDesktopFixture(root, "0.1.180", "0.1.194");
        const manifestPath = path.join(fx.dshHome, "profiles", "desktop", "package.json");
        writeFileSync(manifestPath, JSON.stringify({
            name: "@dsh/profile-desktop",
            dependencies: { "billion-context": "^0.1.180", "other-dep": "^1.2.3" },
            dsh: { profile: { bundles: ["billion-context"] } },
        }, null, 2) + "\n");
        process.env.DSH_HOME = fx.dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        stubRegistryFetch(fx.tgz, "https://registry.test/bc-0.1.194.tgz", "0.1.194", integrityField(fx.tgz));
        await refreshDshDesktopCopy("0.1.194", captureLog().log, hermeticPolicyEnv(root));

        assert.equal(await readDiskVersion(fx.flat), "0.1.194");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
            name?: string;
            dependencies?: Record<string, string>;
            dsh?: { profile?: { bundles?: string[] } };
        };
        assert.equal(manifest.dependencies?.["billion-context"], "^0.1.194", "the declared spec must follow the installed version so pnpm reconciles forward");
        assert.equal(manifest.dependencies?.["other-dep"], "^1.2.3", "unrelated deps must survive untouched");
        assert.deepEqual(manifest.dsh?.profile?.bundles, ["billion-context"], "the bundle registration must survive untouched");
        assert.equal(manifest.name, "@dsh/profile-desktop");
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

test("refreshDshDesktopCopy converges the lockfile record along with the manifest (#3496)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-ledger-"));
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
        const fx = buildDesktopFixture(root, "0.1.180", "0.1.194");
        const profileDir = path.join(fx.dshHome, "profiles", "desktop");
        writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({
            name: "@dsh/profile-desktop",
            dependencies: { "billion-context": "^0.1.180", "other-dep": "^1.2.3" },
            dsh: { profile: { bundles: ["billion-context"] } },
        }, null, 2) + "\n");
        // The stale record the pre-#3496 self-heal used to leave behind: manifest
        // and lockfile both still naming the old version after the copy swap.
        const lockPath = path.join(profileDir, "pnpm-lock.yaml");
        writeFileSync(lockPath, [
            "lockfileVersion: '9.0'",
            "",
            "importers:",
            "",
            "  .:",
            "    dependencies:",
            "      billion-context:",
            "        specifier: ^0.1.180",
            "        version: 0.1.180",
            "",
            "packages:",
            "",
            "  billion-context@0.1.180:",
            "    resolution: {integrity: sha512-fake==}",
            "",
            "snapshots:",
            "",
            "  billion-context@0.1.180: {}",
            "",
        ].join("\n"));
        process.env.DSH_HOME = fx.dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        stubRegistryFetch(fx.tgz, "https://registry.test/bc-0.1.194.tgz", "0.1.194", integrityField(fx.tgz));
        await refreshDshDesktopCopy("0.1.194", captureLog().log, hermeticPolicyEnv(root));

        assert.equal(await readDiskVersion(fx.flat), "0.1.194");
        const manifest = JSON.parse(readFileSync(path.join(profileDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
        assert.equal(manifest.dependencies?.["billion-context"], "^0.1.194");
        const lockText = readFileSync(lockPath, "utf8");
        assert.match(lockText, /specifier: \^0\.1\.194/, "the lockfile's declared-spec record must follow the in-place swap");
        assert.match(lockText, /version: 0\.1\.194/, "the lockfile's resolved-version record must follow the in-place swap");
        assert.ok(lockText.includes("billion-context@0.1.180:"), "store bookkeeping sections are pnpm's to reconcile — bili leaves them alone");
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

test("syncDshProfileManifestSpec: style-preserving convergence, pins and odd specs respected (#2894)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-spec-"));
    try {
        const writeManifest = (spec: string | undefined, extra = ""): string => {
            const dir = mkdtempSync(path.join(root, "profile-"));
            if (extra !== "malformed") {
                const doc: Record<string, unknown> = { name: "@dsh/profile-test" };
                if (spec !== undefined) doc.dependencies = { "billion-context": spec };
                writeFileSync(path.join(dir, "package.json"), JSON.stringify(doc, null, 2) + "\n");
            } else {
                writeFileSync(path.join(dir, "package.json"), "{ not json");
            }
            return dir;
        };

        // caret bump keeps caret style
        let dir = writeManifest("^0.1.180");
        assert.equal(syncDshProfileManifestSpec(dir, "0.1.194"), undefined);
        assert.equal((JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["billion-context"], "^0.1.194");

        // exact bump keeps exact style
        dir = writeManifest("0.1.180");
        assert.equal(syncDshProfileManifestSpec(dir, "0.1.194"), undefined);
        assert.equal((JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["billion-context"], "0.1.194");

        // already in step: no rewrite at all (bytes unchanged)
        dir = writeManifest("^0.1.194");
        const before = readFileSync(path.join(dir, "package.json"), "utf8");
        assert.equal(syncDshProfileManifestSpec(dir, "0.1.194"), undefined);
        assert.equal(readFileSync(path.join(dir, "package.json"), "utf8"), before);

        // downgrade convergence (advisory rollback direction): the spec must
        // follow DOWN too, or the next reconciliation undoes the rollback
        dir = writeManifest("^2.0.0");
        assert.equal(syncDshProfileManifestSpec(dir, "1.5.0"), undefined);
        assert.equal((JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["billion-context"], "^1.5.0");

        // deliberate local pin respected
        dir = writeManifest("link:/somewhere/dev");
        assert.ok(syncDshProfileManifestSpec(dir, "0.1.194")?.includes("local pin") ?? false);
        assert.equal((JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["billion-context"], "link:/somewhere/dev");

        // dist-tag and non-version ranges left alone
        for (const odd of ["latest", ">=0.1.0", "~0.1.180"]) {
            dir = writeManifest(odd);
            const oddBefore = readFileSync(path.join(dir, "package.json"), "utf8");
            const reason = syncDshProfileManifestSpec(dir, "0.1.194");
            assert.ok(reason !== undefined && reason.includes(odd), `expected ${odd} to be respected, got: ${reason ?? "changed"}`);
            assert.equal(readFileSync(path.join(dir, "package.json"), "utf8"), oddBefore);
        }

        // no dependency declared / malformed / missing file: reason, no throw, no clobber
        dir = writeManifest(undefined);
        assert.ok(syncDshProfileManifestSpec(dir, "0.1.194")?.includes("no billion-context") ?? false);
        dir = writeManifest(undefined, "malformed");
        const malformedBefore = readFileSync(path.join(dir, "package.json"), "utf8");
        assert.ok(syncDshProfileManifestSpec(dir, "0.1.194")?.includes("malformed") ?? false);
        assert.equal(readFileSync(path.join(dir, "package.json"), "utf8"), malformedBefore);
        assert.ok(syncDshProfileManifestSpec(path.join(root, "no-such-profile"), "0.1.194")?.includes("no readable") ?? false);
    } finally {
        rmrf(root);
    }
});

test("syncDshProfileManifestSpec writes atomically — converges and leaves no orphan tmp (#2972-M1)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-atomic-"));
    try {
        const dir = mkdtempSync(path.join(root, "profile-"));
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@dsh/profile-test", dependencies: { "billion-context": "^0.1.195" } }, null, 2) + "\n");
        assert.equal(syncDshProfileManifestSpec(dir, "0.1.196"), undefined);
        assert.equal((JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["billion-context"], "^0.1.196");
        assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")), `orphan tmp file left in ${dir}`);
    } finally {
        rmrf(root);
    }
});

// —— #7139: the pnpm minimumReleaseAge gate on the in-place lane ———

function isoHoursAgo(hours: number): string {
    return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/** Registry stub serving the packument (the gate's publish-time source)
 *  alongside the dist doc + tarball. `time` = the packument's time map;
 *  undefined = no time key at all. */
function stubMaturityRegistryFetch(tgz: Buffer, tarballUrl: string, version: string, integrity: string, time: Record<string, string> | undefined, opts: { failNetwork?: boolean } = {}): { packumentCalls: number } {
    const state = { packumentCalls: 0 };
    globalThis.fetch = ((url: unknown) => {
        const u = String(url);
        if (u.endsWith("/billion-context")) {
            state.packumentCalls++;
            if (opts.failNetwork) return Promise.reject(new Error("network down"));
            const doc: Record<string, unknown> = { name: "billion-context", versions: {} };
            if (time !== undefined) doc.time = time;
            return Promise.resolve(new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } }));
        }
        if (u.endsWith(`/billion-context/${version}`)) {
            return Promise.resolve(new Response(JSON.stringify({ dist: { tarball: tarballUrl, integrity } }), { headers: { "content-type": "application/json" } }));
        }
        if (u === tarballUrl) {
            return Promise.resolve(new Response(tgz));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${u}`));
    }) as unknown as typeof fetch;
    return state;
}

/** The frozen backoff state file (see the #2206 note at the top of this
 *  file) — read straight from disk so the assertion is about what the lane
 *  PERSISTED, not in-process bookkeeping. */
function backoffStrikeCount(version: string): number {
    try {
        const doc = JSON.parse(readFileSync(path.join(__cacheRoot, "cache", "billion-context", ".install-backoff.json"), "utf8")) as { entries?: Record<string, { count?: number }> };
        return doc.entries?.[`owner:dsh-desktop:${version}`]?.count ?? 0;
    } catch {
        return 0;
    }
}

test("refreshDshDesktopCopy: immature release deferred — copy, manifest, lockfile untouched, no strike (#7139)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-maturity-defer-"));
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
        const fx = buildDesktopFixture(root, "1.2.3", "3.0.0");
        const profileDir = path.join(fx.dshHome, "profiles", "desktop");
        const manifestBefore = JSON.stringify({
            name: "@dsh/profile-desktop",
            dependencies: { "billion-context": "^1.2.3" },
            dsh: { profile: { bundles: ["billion-context"] } },
        }, null, 2) + "\n";
        writeFileSync(path.join(profileDir, "package.json"), manifestBefore);
        const lockBefore = [
            "lockfileVersion: '9.0'",
            "",
            "importers:",
            "",
            "  .:",
            "    dependencies:",
            "      billion-context:",
            "        specifier: ^1.2.3",
            "        version: 1.2.3",
            "",
            "packages:",
            "",
            "  billion-context@1.2.3:",
            "    resolution: {integrity: sha512-fake==}",
            "",
            "snapshots:",
            "",
            "  billion-context@1.2.3: {}",
            "",
        ].join("\n");
        writeFileSync(path.join(profileDir, "pnpm-lock.yaml"), lockBefore);
        writeFileSync(path.join(profileDir, "pnpm-workspace.yaml"), "minimumReleaseAge: 1440\n");
        process.env.DSH_HOME = fx.dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        const env = hermeticPolicyEnv(root);
        const publishedAt = isoHoursAgo(1);
        const maturityCalls = stubMaturityRegistryFetch(fx.tgz, "https://registry.test/bc-3.0.0.tgz", "3.0.0", integrityField(fx.tgz), { created: publishedAt, modified: publishedAt, "3.0.0": publishedAt });
        const { lines, log } = captureLog();
        await refreshDshDesktopCopy("3.0.0", log, env);

        assert.equal(lstatSync(fx.flat).isSymbolicLink(), true, "the in-place swap must not have run");
        assert.equal(await readDiskVersion(fx.storeCopy), "1.2.3");
        assert.equal(readFileSync(path.join(profileDir, "package.json"), "utf8"), manifestBefore, "the manifest must be byte-identical");
        assert.equal(readFileSync(path.join(profileDir, "pnpm-lock.yaml"), "utf8"), lockBefore, "the lockfile must be byte-identical");
        assert.equal(maturityCalls.packumentCalls, 1, "the gate must have consulted the registry publish time");
        assert.ok(lines.some((l) => l.startsWith("info:") && l.includes("minimumReleaseAge") && l.includes("deferring")), `expected the deferral line, got: ${lines.join(" | ")}`);
        assert.ok(!lines.some((l) => l.startsWith("warn:")), `unexpected warns: ${lines.join(" | ")}`);
        assert.equal(backoffStrikeCount("3.0.0"), 0, "deferral is not a failure — no backoff strike");
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

test("refreshDshDesktopCopy: minimumReleaseAgeExclude lets the excluded release through (#7139)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-maturity-excluded-"));
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
        const fx = buildDesktopFixture(root, "1.2.3", "3.1.0");
        const profileDir = path.join(fx.dshHome, "profiles", "desktop");
        writeFileSync(path.join(profileDir, "pnpm-workspace.yaml"), [
            "minimumReleaseAge: 1440",
            "minimumReleaseAgeExclude:",
            "  - billion-context",
            "",
        ].join("\n"));
        process.env.DSH_HOME = fx.dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        const publishedAt = isoHoursAgo(1); // immature — but excluded
        const maturityCalls = stubMaturityRegistryFetch(fx.tgz, "https://registry.test/bc-3.1.0.tgz", "3.1.0", integrityField(fx.tgz), { created: publishedAt, modified: publishedAt, "3.1.0": publishedAt });
        const { lines, log } = captureLog();
        await refreshDshDesktopCopy("3.1.0", log, hermeticPolicyEnv(root));

        assert.equal(lstatSync(fx.flat).isSymbolicLink(), false, "the excluded release must install");
        assert.equal(await readDiskVersion(fx.flat), "3.1.0");
        assert.equal(maturityCalls.packumentCalls, 0, "an excluded package must not need the publish time");
        assert.ok(lines.some((l) => l.startsWith("info:") && l.includes("in place")), `expected the in-place success line, got: ${lines.join(" | ")}`);
        assert.ok(!lines.some((l) => l.includes("deferring")), `must not defer an excluded release: ${lines.join(" | ")}`);
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

test("refreshDshDesktopCopy: an exclude for a different version does not lift the gate (#7139)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-maturity-excl-other-"));
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
        const fx = buildDesktopFixture(root, "1.2.3", "3.2.0");
        const profileDir = path.join(fx.dshHome, "profiles", "desktop");
        writeFileSync(path.join(profileDir, "pnpm-workspace.yaml"), [
            "minimumReleaseAge: 1440",
            "minimumReleaseAgeExclude:",
            "  - billion-context@9.9.9",
            "",
        ].join("\n"));
        process.env.DSH_HOME = fx.dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        const publishedAt = isoHoursAgo(1);
        stubMaturityRegistryFetch(fx.tgz, "https://registry.test/bc-3.2.0.tgz", "3.2.0", integrityField(fx.tgz), { created: publishedAt, modified: publishedAt, "3.2.0": publishedAt });
        const { lines, log } = captureLog();
        await refreshDshDesktopCopy("3.2.0", log, hermeticPolicyEnv(root));

        assert.equal(lstatSync(fx.flat).isSymbolicLink(), true, "the unrelated exclude must not lift the gate");
        assert.ok(lines.some((l) => l.startsWith("info:") && l.includes("deferring")), `expected the deferral line, got: ${lines.join(" | ")}`);
        assert.equal(backoffStrikeCount("3.2.0"), 0);
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

test("refreshDshDesktopCopy: a mature release updates and converges the ledgers as usual (#7139)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-maturity-mature-"));
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
        const fx = buildDesktopFixture(root, "1.2.3", "4.0.0");
        const profileDir = path.join(fx.dshHome, "profiles", "desktop");
        writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({
            name: "@dsh/profile-desktop",
            dependencies: { "billion-context": "^1.2.3", "other-dep": "^1.2.3" },
            dsh: { profile: { bundles: ["billion-context"] } },
        }, null, 2) + "\n");
        const lockPath = path.join(profileDir, "pnpm-lock.yaml");
        writeFileSync(lockPath, [
            "lockfileVersion: '9.0'",
            "",
            "importers:",
            "",
            "  .:",
            "    dependencies:",
            "      billion-context:",
            "        specifier: ^1.2.3",
            "        version: 1.2.3",
            "",
            "packages:",
            "",
            "  billion-context@1.2.3:",
            "    resolution: {integrity: sha512-fake==}",
            "",
            "snapshots:",
            "",
            "  billion-context@1.2.3: {}",
            "",
        ].join("\n"));
        writeFileSync(path.join(profileDir, "pnpm-workspace.yaml"), "minimumReleaseAge: 1440\n");
        process.env.DSH_HOME = fx.dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        const publishedAt = isoHoursAgo(48); // outside the 24h window
        stubMaturityRegistryFetch(fx.tgz, "https://registry.test/bc-4.0.0.tgz", "4.0.0", integrityField(fx.tgz), { created: publishedAt, modified: publishedAt, "4.0.0": publishedAt });
        const { lines, log } = captureLog();
        await refreshDshDesktopCopy("4.0.0", log, hermeticPolicyEnv(root));

        assert.equal(lstatSync(fx.flat).isSymbolicLink(), false, "the mature release must install");
        assert.equal(await readDiskVersion(fx.flat), "4.0.0");
        const manifest = JSON.parse(readFileSync(path.join(profileDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
        assert.equal(manifest.dependencies?.["billion-context"], "^4.0.0", "the manifest must converge");
        assert.equal(manifest.dependencies?.["other-dep"], "^1.2.3");
        const lockText = readFileSync(lockPath, "utf8");
        assert.match(lockText, /specifier: \^4\.0\.0/);
        assert.match(lockText, /version: 4\.0\.0/);
        assert.ok(lockText.includes("billion-context@1.2.3:"), "store sections stay pnpm's to reconcile");
        assert.ok(lines.some((l) => l.startsWith("info:") && l.includes("in place")), `expected the in-place success line, got: ${lines.join(" | ")}`);
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

test("refreshDshDesktopCopy: publish time unavailable → fail closed, strike recorded, copy untouched (#7139)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-maturity-notime-"));
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
        const fx = buildDesktopFixture(root, "1.2.3", "5.0.0");
        const profileDir = path.join(fx.dshHome, "profiles", "desktop");
        writeFileSync(path.join(profileDir, "pnpm-workspace.yaml"), "minimumReleaseAge: 1440\n");
        process.env.DSH_HOME = fx.dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        stubMaturityRegistryFetch(fx.tgz, "https://registry.test/bc-5.0.0.tgz", "5.0.0", integrityField(fx.tgz), undefined); // no time key
        const { lines, log } = captureLog();
        await refreshDshDesktopCopy("5.0.0", log, hermeticPolicyEnv(root));

        assert.equal(lstatSync(fx.flat).isSymbolicLink(), true, "fail closed: the swap must not have run");
        assert.equal(await readDiskVersion(fx.storeCopy), "1.2.3");
        assert.ok(lines.some((l) => l.startsWith("warn:") && l.includes("fail closed")), `expected the fail-closed warn, got: ${lines.join(" | ")}`);
        assert.equal(backoffStrikeCount("5.0.0"), 1, "an undatable policy must record a strike (backed-off retry, not silent retry)");
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

test("refreshDshDesktopCopy: registry unreachable → fail closed, strike recorded (#7139)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-maturity-netfail-"));
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
        const fx = buildDesktopFixture(root, "1.2.3", "5.1.0");
        const profileDir = path.join(fx.dshHome, "profiles", "desktop");
        writeFileSync(path.join(profileDir, "pnpm-workspace.yaml"), "minimumReleaseAge: 1440\n");
        process.env.DSH_HOME = fx.dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        stubMaturityRegistryFetch(fx.tgz, "https://registry.test/bc-5.1.0.tgz", "5.1.0", integrityField(fx.tgz), { "5.1.0": isoHoursAgo(48) }, { failNetwork: true });
        const { lines, log } = captureLog();
        await refreshDshDesktopCopy("5.1.0", log, hermeticPolicyEnv(root));

        assert.equal(lstatSync(fx.flat).isSymbolicLink(), true, "fail closed: the swap must not have run");
        assert.ok(lines.some((l) => l.startsWith("warn:") && l.includes("fail closed")), `expected the fail-closed warn, got: ${lines.join(" | ")}`);
        assert.equal(backoffStrikeCount("5.1.0"), 1);
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

test("refreshDshDesktopCopy: malformed maturity policy → fail closed before any registry traffic (#7139)", { timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-desktop-maturity-badpolicy-"));
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
        const fx = buildDesktopFixture(root, "1.2.3", "5.2.0");
        const profileDir = path.join(fx.dshHome, "profiles", "desktop");
        writeFileSync(path.join(profileDir, "pnpm-workspace.yaml"), "minimumReleaseAge: abc\n");
        process.env.DSH_HOME = fx.dshHome;
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        const maturityCalls = stubMaturityRegistryFetch(fx.tgz, "https://registry.test/bc-5.2.0.tgz", "5.2.0", integrityField(fx.tgz), { "5.2.0": isoHoursAgo(48) });
        const { lines, log } = captureLog();
        await refreshDshDesktopCopy("5.2.0", log, hermeticPolicyEnv(root));

        assert.equal(lstatSync(fx.flat).isSymbolicLink(), true, "fail closed: the swap must not have run");
        assert.equal(maturityCalls.packumentCalls, 0, "a malformed policy must fail before any registry traffic");
        assert.ok(lines.some((l) => l.startsWith("warn:") && l.includes("fail closed")), `expected the fail-closed warn, got: ${lines.join(" | ")}`);
        assert.equal(backoffStrikeCount("5.2.0"), 1);
    } catch (e) {
        if (String(e).includes("EPERM")) {
            t.skip("creating directory symlinks requires elevated privileges on this platform");
            return;
        }
        throw e;
    }
});

test("dshDesktopCopyPathMatches honors Windows case-insensitivity (#2972-L3)", () => {
    const anchor = "/home/u/.dsh/profiles/desktop";
    const suffix = "/node_modules/billion-context";
    const hit = "/home/u/.dsh/profiles/desktop/node_modules/billion-context";
    // POSIX (ci=false): byte-exact — exact case matches; a mismatched case on
    // BOTH candidate paths does not (only one matching path is enough to hit).
    assert.equal(dshDesktopCopyPathMatches(hit, hit, anchor, suffix, false), true);
    assert.equal(dshDesktopCopyPathMatches("/HOME/U/.DSH/profiles/Desktop/node_modules/billion-context", "/HOME/U/.DSH/profiles/Desktop/node_modules/billion-context", anchor, suffix, false), false);
    // Windows (ci=true): case must NOT matter — a DSH_HOME spelled differently still matches.
    assert.equal(dshDesktopCopyPathMatches(hit, hit, "/HOME/U/.DSH/profiles/Desktop", suffix, true), true);
    assert.equal(dshDesktopCopyPathMatches("/HOME/U/.DSH/profiles/Desktop/node_modules/billion-context", hit, "/home/u/.dsh/profiles/desktop", suffix, true), true);
    // `real` (resolved symlink) matching also counts; non-members never match.
    assert.equal(dshDesktopCopyPathMatches("/nope", hit, anchor, suffix, false), true);
    assert.equal(dshDesktopCopyPathMatches("/elsewhere/a", "/elsewhere/b", anchor, suffix, true), false);
});
