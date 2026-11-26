// #7806: `bili install <ref>` — install from an arbitrary git ref (PR head /
// branch / tag / master) and auto-pin the result. The subprocess flow is
// exercised OFFLINE with PATH-shim fake git/npm (POSIX shell scripts), so the
// whole clone → build → backup → npm install -g → verify → pin path runs with
// no network and no real binaries. Pure helpers (ref resolution, hermetic env,
// clone-dir hashing, pin duration) are platform-independent.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as tar from "tar";
import { cacheDir } from "../src/paths.js";
import {
    hermeticEnv,
    cloneDirFor,
    resolveRef,
    installFromGitRef,
    installStatus,
    INSTALL_REPO_URL,
} from "../src/git-install.js";
import { readPin, writePin, pinFilePath } from "../src/update-pin.js";
import { checkForUpdate, _resetUpdateThrottleForTest } from "../src/update.js";
import { setLogCapture } from "../src/logger.js";
import { rmrf } from "./tmp-rm.js";

const IS_WIN = process.platform === "win32";

// ---------------------------------------------------------------------------
// Pure helpers (all platforms)
// ---------------------------------------------------------------------------

test("resolveRef: bare PR number → pull/<n>/head, isPr", () => {
    assert.deepEqual(resolveRef("7738"), { gitRef: "pull/7738/head", isPr: true });
    assert.deepEqual(resolveRef(" 7738 "), { gitRef: "pull/7738/head", isPr: true });
});

test("resolveRef: GitHub PR URL → pull/<n>/head, isPr", () => {
    const r = resolveRef("https://github.com/ranxianglei/billion-context/pull/7738");
    assert.deepEqual(r, { gitRef: "pull/7738/head", isPr: true });
    const r2 = resolveRef("http://github.com/ranxianglei/billion-context/pull/42/files");
    assert.deepEqual(r2, { gitRef: "pull/42/head", isPr: true });
});

test("resolveRef: branch / tag / master pass through verbatim, not a PR", () => {
    assert.deepEqual(resolveRef("master"), { gitRef: "master", isPr: false });
    assert.deepEqual(resolveRef("v0.1.216"), { gitRef: "v0.1.216", isPr: false });
    assert.deepEqual(resolveRef("some/feature-branch"), { gitRef: "some/feature-branch", isPr: false });
});

test("resolveRef: empty ref throws", () => {
    assert.throws(() => resolveRef(""), /ref is required/);
    assert.throws(() => resolveRef("   "), /ref is required/);
});

test("hermeticEnv: keeps the whitelist, drops everything else", () => {
    const saved = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
        GIT_DIR: process.env.GIT_DIR,
        NODE_OPTIONS: process.env.NODE_OPTIONS,
        npm_config_registry: process.env.npm_config_registry,
    };
    try {
        process.env.PATH = "/x/bin";
        process.env.HOME = "/x/home";
        process.env.XDG_CACHE_HOME = "/x/cache";
        process.env.npm_config_registry = "https://registry.example";
        process.env.GIT_DIR = "/steered/git";
        process.env.NODE_OPTIONS = "--require=evil";
        const env = hermeticEnv();
        assert.equal(env.PATH, "/x/bin");
        assert.equal(env.HOME, "/x/home");
        assert.equal(env.XDG_CACHE_HOME, "/x/cache");
        assert.equal(env.npm_config_registry, "https://registry.example");
        // steering vars must NOT leak into the subprocess
        assert.equal(env.GIT_DIR, undefined);
        assert.equal(env.NODE_OPTIONS, undefined);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});

test("cloneDirFor: stable per ref, lives under the cache dir", () => {
    const a = cloneDirFor("pull/7738/head");
    const b = cloneDirFor("pull/7738/head");
    const c = cloneDirFor("master");
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.ok(a.startsWith(cacheDir()), `clone dir ${a} must be under ${cacheDir()}`);
    assert.match(path.basename(a), /^[0-9a-f]{12}$/);
});

// ---------------------------------------------------------------------------
// Offline subprocess flow (POSIX only — the fake git/npm are shell scripts)
// ---------------------------------------------------------------------------

const FAKE_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function makeShims(dir: string): void {
    // Fake git: stateless enough to drive ensureClone. `fetch` (re)records a
    // fixed head sha; `rev-parse HEAD` echoes it back.
    const git = `#!/bin/sh
case "$1" in
  init) mkdir -p .git ;;
  fetch) mkdir -p .git; printf '%s' '${FAKE_SHA}' > .git/head-sha ;;
  rev-parse) cat .git/head-sha ;;
esac
exit 0
`;
    // Fake npm: `root -g` reports a deterministic global root under $HOME;
    // `run build` fabricates the built package (dist/index.js + package.json);
    // `install -g <dir> --install-links` REAL-copies the dir into the global
    // root (never a symlink — the #1225 contract the verifier enforces).
    const npm = `#!/bin/sh
GR="$HOME/.fake-global/node_modules"
case "$1" in
  root) echo "$GR" ;;
  run)
    mkdir -p dist
    printf 'module.exports = {};\\n' > dist/index.js
    if [ ! -f package.json ]; then printf '{"name":"billion-context","version":"0.0.0-dev"}\\n' > package.json; fi
    ;;
  install)
    if [ "$2" = "-g" ]; then
      rm -rf "$GR/billion-context"
      mkdir -p "$GR"
      cp -R "$3" "$GR/billion-context"
    fi
    ;;
esac
exit 0
`;
    writeFileSync(path.join(dir, "git"), git);
    writeFileSync(path.join(dir, "npm"), npm);
    chmodSync(path.join(dir, "git"), 0o755);
    chmodSync(path.join(dir, "npm"), 0o755);
}

interface Isolated {
    home: string;
    shim: string;
    globalRoot: string;
    installDir: string;
    pinFile: string;
}

async function withIsolatedEnv(fn: (iso: Isolated) => Promise<void>): Promise<void> {
    const home = mkdtempSync(path.join(os.tmpdir(), "bili-gitinstall-"));
    const shim = path.join(home, "shims");
    mkdirSync(shim, { recursive: true });
    makeShims(shim);
    const globalRoot = path.join(home, ".fake-global", "node_modules");
    const iso: Isolated = {
        home,
        shim,
        globalRoot,
        installDir: path.join(globalRoot, "billion-context"),
        pinFile: path.join(home, ".cache-x", "billion-context", ".pin.json"),
    };
    const vars: Record<string, string> = {
        HOME: home,
        USERPROFILE: home,
        XDG_CACHE_HOME: path.join(home, ".cache-x"),
        XDG_CONFIG_HOME: path.join(home, ".config-x"),
        XDG_DATA_HOME: path.join(home, ".data-x"),
        XDG_STATE_HOME: path.join(home, ".state-x"),
        PATH: `${shim}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
        saved.set(k, process.env[k]);
        process.env[k] = v;
    }
    try {
        await fn(iso);
    } finally {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        rmSync(home, { recursive: true, force: true });
    }
}

test("installFromGitRef: full offline flow installs, verifies, pins (PR ref)", async () => {
    if (IS_WIN) { test.skip("fake git/npm are POSIX shell scripts"); return; }
    await withIsolatedEnv(async (iso) => {
        const r = await installFromGitRef("7738");
        assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
        if (!r.ok) return;
        assert.equal(r.version, "0.0.0-dev");
        assert.equal(r.ref, "pull/7738/head");
        assert.equal(r.sha, FAKE_SHA);
        assert.equal(r.installDir, iso.installDir);
        // real copy, not a symlink
        assert.ok(existsSync(path.join(iso.installDir, "dist", "index.js")));
        assert.ok(!readLink(iso.installDir));
        // pin written with the git source
        const pin = await readPin();
        assert.ok(pin, "pin must be written");
        assert.equal(pin?.version, "0.0.0-dev");
        assert.equal(pin?.source?.kind, "git");
        assert.equal(pin?.source?.ref, "pull/7738/head");
        assert.equal(pin?.source?.sha, FAKE_SHA);
        // default 30-day pin
        assert.ok(pin?.until !== undefined);
        const days = ((pin?.until ?? 0) - pin!.setAt) / 86_400_000;
        assert.ok(Math.abs(days - 30) < 0.01, `default pin ≈ 30 days (got ${days})`);
    });
});

test("installFromGitRef: duration overrides the default pin window", async () => {
    if (IS_WIN) { test.skip("fake git/npm are POSIX shell scripts"); return; }
    await withIsolatedEnv(async (iso) => {
        const r = await installFromGitRef("master", "7d");
        assert.equal(r.ok, true, JSON.stringify(r));
        if (!r.ok) return;
        assert.equal(r.ref, "master");
        const pin = await readPin();
        const days = ((pin?.until ?? 0) - pin!.setAt) / 86_400_000;
        assert.ok(Math.abs(days - 7) < 0.01, `7d pin (got ${days})`);
    });
});

test("installFromGitRef: 'forever' writes an indefinite pin (no until)", async () => {
    if (IS_WIN) { test.skip("fake git/npm are POSIX shell scripts"); return; }
    await withIsolatedEnv(async () => {
        const r = await installFromGitRef("v0.1.216", "forever");
        assert.equal(r.ok, true, JSON.stringify(r));
        if (!r.ok) return;
        assert.equal(r.pinUntil, undefined);
        const pin = await readPin();
        assert.equal(pin?.until, undefined);
    });
});

test("installFromGitRef: a bogus duration is refused before any git work", async () => {
    if (IS_WIN) { test.skip("fake git/npm are POSIX shell scripts"); return; }
    await withIsolatedEnv(async (iso) => {
        const r = await installFromGitRef("7738", "bogus");
        assert.equal(r.ok, false);
        if (r.ok) return;
        assert.match(r.error, /duration/i);
        // nothing installed, no pin
        assert.ok(!existsSync(iso.installDir));
        assert.equal(await readPin(), undefined);
    });
});

test("installFromGitRef: a second install backs up the first (keep last 2)", async () => {
    if (IS_WIN) { test.skip("fake git/npm are POSIX shell scripts"); return; }
    await withIsolatedEnv(async (iso) => {
        const first = await installFromGitRef("7738");
        assert.equal(first.ok, true, JSON.stringify(first));
        assert.equal(first.backupDir, undefined, "no prior install → no backup");
        const second = await installFromGitRef("master");
        assert.equal(second.ok, true, JSON.stringify(second));
        if (!second.ok) return;
        assert.ok(second.backupDir, "second install must back up the first");
        assert.ok(existsSync(second.backupDir!));
        // the live install is the newest
        assert.ok(existsSync(path.join(iso.installDir, "dist", "index.js")));
    });
});

test("installStatus: reports the dev install + active pin after an install", async () => {
    if (IS_WIN) { test.skip("fake git/npm are POSIX shell scripts"); return; }
    await withIsolatedEnv(async () => {
        assert.deepEqual(await installStatus(), { hasDevInstall: false, active: false });
        const r = await installFromGitRef("7738");
        assert.equal(r.ok, true, JSON.stringify(r));
        const st = await installStatus();
        assert.equal(st.hasDevInstall, true);
        assert.equal(st.version, "0.0.0-dev");
        assert.equal(st.ref, "pull/7738/head");
        assert.equal(st.sha, FAKE_SHA);
        assert.equal(st.active, true);
        assert.ok(st.setAt !== undefined);
        assert.ok(st.until !== undefined);
    });
});

test("installStatus: a pin without a git source is not a dev install", async () => {
    if (IS_WIN) { test.skip("fake git/npm are POSIX shell scripts"); return; }
    await withIsolatedEnv(async (iso) => {
        // hand-write a registry-style pin (no source)
        await writePin({ v: 1, version: "9.9.9", setAt: Date.now() });
        const st = await installStatus();
        assert.equal(st.hasDevInstall, false, "a source-less pin is not a dev install");
        assert.ok(existsSync(iso.pinFile));
    });
});

// readLink helper (null when the path is not a symlink)
function readLink(p: string): string | null {
    try {
        return readlinkSync(p);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Pin gate in checkForUpdate (#7806 item 2: the pin is CHECK-ONLY)
//
// A `bili install <ref>` dev build often carries the SAME version as a
// release, so the tag channel alone can't tell it apart. The pin is what keeps
// auto-upgrade from swapping it back: while a pin is active the updater keeps
// DISCOVERING and REPORTING newer versions but never installs them; an
// explicit `bili update` (force) breaks through and clears the pin.
// ---------------------------------------------------------------------------

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

interface PinFixture {
    root: string;
    installDir: string;
    cacheDir: string;
    makeTarball(version: string): { tgz: Buffer; integrity: string };
}

function pinFixture(): PinFixture {
    const root = mkdtempSync(path.join(os.tmpdir(), "bc-pin-gate-"));
    const installDir = path.join(root, "install");
    const cacheDir = path.join(root, "cache");
    mkdirSync(path.join(installDir, "dist"), { recursive: true });
    writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version: "1.2.3", type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }));
    writeFileSync(path.join(installDir, "dist", "index.js"), "export const loaded = '1.2.3';\n");
    return {
        root,
        installDir,
        cacheDir,
        makeTarball(version) {
            const src = path.join(root, "pkg");
            mkdirSync(path.join(src, "package", "dist"), { recursive: true });
            writeFileSync(path.join(src, "package", "package.json"), JSON.stringify({ name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }));
            writeFileSync(path.join(src, "package", "dist", "index.js"), `export const loaded = '${version}';\n`);
            const tgzPath = path.join(root, "pkg.tgz");
            tar.c({ cwd: src, file: tgzPath, gzip: true, sync: true }, ["package"]);
            const tgz = readFileSync(tgzPath);
            return { tgz, integrity: integrityField(tgz) };
        },
    };
}

/** Route global fetch by URL regex; every unmatched URL fails loudly. Returns the fetch count. */
async function withFetch(routes: Array<{ match: RegExp; body: unknown }>, fn: () => Promise<void>): Promise<number> {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((url: string | URL | Request) => {
        calls++;
        const u = String(url);
        for (const route of routes) {
            if (route.match.test(u)) {
                return Promise.resolve(new Response(typeof route.body === "string" || route.body instanceof Buffer ? route.body : JSON.stringify(route.body)));
            }
        }
        return Promise.reject(new Error(`unexpected fetch: ${u}`));
    }) as unknown as typeof fetch;
    try {
        await fn();
    } finally {
        globalThis.fetch = original;
    }
    return calls;
}

test("pin gate: an active pin is CHECK-ONLY — newer version reported, NOT installed", async () => {
    const fx = pinFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    await _resetUpdateThrottleForTest();
    try {
        await writePin({ v: 1, version: "1.2.3", setAt: Date.now(), until: Date.now() + 30 * 86400000, source: { kind: "git", ref: "pull/7738/head", sha: FAKE_SHA } });
        const lines: string[] = [];
        setLogCapture((_level, msg) => { lines.push(msg); });
        let result: { status?: string; latest?: string; note?: string } | undefined;
        try {
            const calls = await withFetch(
                [{ match: /\/billion-context\/latest$/, body: { version: "1.2.9", dist: { tarball: "https://registry.test/pkg-1.2.9.tgz", integrity: integrityField(Buffer.from("x")) } } }],
                async () => {
                    result = await checkForUpdate({ packageName: "billion-context", currentVersion: "1.2.3", autoUpdate: true, installDir: fx.installDir }, false);
                },
            );
            assert.equal(calls, 1, "only the packument was fetched — the tarball was never downloaded");
        } finally {
            setLogCapture(null);
        }
        assert.equal(result?.status, "update-available", "the newer version is still REPORTED");
        assert.equal(result?.latest, "1.2.9");
        assert.match(result?.note ?? "", /pinned/);
        assert.equal(JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version, "1.2.3", "install untouched — the pin holds");
        assert.ok(lines.some((l) => l.includes("holding 1.2.3") && l.includes("pinned")), `must log the hold, got: ${JSON.stringify(lines)}`);
        assert.ok(existsSync(pinFilePath()), "an active pin is NOT swept");
    } finally {
        delete process.env.XDG_CACHE_HOME;
        rmrf(fx.root);
    }
});

test("pin gate: an expired pin is self-swept and auto-upgrade resumes", async () => {
    const fx = pinFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    await _resetUpdateThrottleForTest();
    const { tgz, integrity } = fx.makeTarball("1.2.9");
    try {
        // a pin that already lapsed (until in the past)
        await writePin({ v: 1, version: "1.2.3", setAt: Date.now() - 40 * 86400000, until: Date.now() - 10 * 86400000, source: { kind: "git", ref: "pull/7738/head", sha: FAKE_SHA } });
        const lines: string[] = [];
        setLogCapture((_level, msg) => { lines.push(msg); });
        let result: { status?: string; note?: string } | undefined;
        try {
            await withFetch(
                [
                    { match: /auto-update-policy\.json$/, body: {} },
                    { match: /\/billion-context\/latest$/, body: { version: "1.2.9", dist: { tarball: "https://registry.test/pkg-1.2.9.tgz", integrity } } },
                    { match: /pkg-1\.2\.9\.tgz/, body: tgz },
                ],
                async () => {
                    result = await checkForUpdate({ packageName: "billion-context", currentVersion: "1.2.3", autoUpdate: true, installDir: fx.installDir }, false);
                },
            );
        } finally {
            setLogCapture(null);
        }
        assert.ok(!existsSync(pinFilePath()), "the expired pin was self-swept");
        assert.ok(lines.some((l) => l.includes("released")), `must log the release, got: ${JSON.stringify(lines)}`);
        // the update proceeded PAST the pin gate (into the policy/stagger gate) —
        // it did NOT stop with the pin's "holding" note. The actual install is
        // #3619's staggered-rollout job, not the pin gate's, so we only assert
        // the gate let it through.
        assert.ok(!/pinned/.test(result?.note ?? ""), `must not return the pin hold note, got: ${JSON.stringify(result)}`);
    } finally {
        delete process.env.XDG_CACHE_HOME;
        rmrf(fx.root);
    }
});

test("pin gate: a stale pin (version mismatch) is self-swept and auto-upgrade resumes", async () => {
    const fx = pinFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    await _resetUpdateThrottleForTest();
    const { tgz, integrity } = fx.makeTarball("1.2.9");
    try {
        // a pin on a DIFFERENT version than what's on disk (the build moved on)
        await writePin({ v: 1, version: "9.9.9", setAt: Date.now(), until: Date.now() + 30 * 86400000, source: { kind: "git", ref: "pull/7738/head", sha: FAKE_SHA } });
        const lines: string[] = [];
        setLogCapture((_level, msg) => { lines.push(msg); });
        try {
            await withFetch(
                [
                    { match: /auto-update-policy\.json$/, body: {} },
                    { match: /\/billion-context\/latest$/, body: { version: "1.2.9", dist: { tarball: "https://registry.test/pkg-1.2.9.tgz", integrity } } },
                    { match: /pkg-1\.2\.9\.tgz/, body: tgz },
                ],
                async () => {
                    await checkForUpdate({ packageName: "billion-context", currentVersion: "1.2.3", autoUpdate: true, installDir: fx.installDir }, false);
                },
            );
        } finally {
            setLogCapture(null);
        }
        assert.ok(!existsSync(pinFilePath()), "the stale pin was self-swept");
        assert.ok(lines.some((l) => l.includes("released")), `must log the release, got: ${JSON.stringify(lines)}`);
    } finally {
        delete process.env.XDG_CACHE_HOME;
        rmrf(fx.root);
    }
});
