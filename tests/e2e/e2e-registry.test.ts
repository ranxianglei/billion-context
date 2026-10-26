// Hermetic registry e2e (#1153): exercises the REAL self-update chain —
// dist-tag resolve → tarball download → sha512 verify → staged extract →
// in-place install → disk flip — plus the post-update opencode plugin entry,
// against a local verdaccio. Loopback only, zero secrets, zero tokens.
// Gated like ACP_TEST_E2E so plain `npm test` stays free.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as tar from "tar";
import { startRegistry } from "./registry-fixture.js";
import { IS_WIN, biliSpawnEnv, fakeVersionBin, isolatedEnv, npmHomeEnv, npmRunSync } from "./crossplat.ts";
import { rmrf } from "../tmp-rm.ts";

const run = process.env.ACP_TEST_REGISTRY === "1";
const skipReason = !run ? "set ACP_TEST_REGISTRY=1 (hermetic local-registry e2e; loopback only)" : undefined;
const REAL_BASELINE = process.env.BILI_E2E_REAL_BASELINE;
const realSkip = !run
    ? skipReason
    : !REAL_BASELINE
      ? "set BILI_E2E_REAL_BASELINE=<published version> (downloads one real tarball from registry.npmjs.org — the only phase that leaves the sandbox)"
      : undefined;

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { name: string; version: string; files: string[]; scripts?: Record<string, string> };
const OLD_VERSION = PKG.version;
const NEW_VERSION = bumpPatch(OLD_VERSION);

function bumpPatch(v: string): string {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) throw new Error(`unexpected version format: ${v}`);
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runBili(installDir: string, args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
    const res = spawnSync(process.execPath, [path.join(installDir, "dist", "index.js"), ...args], {
        encoding: "utf8",
        timeout: 180_000,
        env: biliSpawnEnv(env),
    });
    return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

async function readPkgVersion(dir: string): Promise<string> {
    return (JSON.parse(await fs.promises.readFile(path.join(dir, "package.json"), "utf8")) as { version: string }).version;
}

// Stage a publishable tarball of THIS package at a synthetic version: same
// files field, same dist build, rewritten package.json version.
// `bare` strips runtime dependencies — needed when the REAL npm client
// resolves the tree (`install -g`): the hermetic registry has no uplinks, so
// any dependency fetch would 404. The flip/layout mechanics under test
// don't involve dependency resolution.
async function makeFixtureTarball(work: string, version: string, opts?: { bare?: boolean }): Promise<string> {
    const packs = path.join(work, "packs");
    fs.mkdirSync(packs, { recursive: true });
    const stage = path.join(work, "fixtures", version);
    fs.mkdirSync(stage, { recursive: true });
    const stagedBase = opts?.bare ? { ...PKG, version, dependencies: {}, optionalDependencies: {} } : { ...PKG, version };
    // The staged copy models a PUBLISHED artifact: registry installs never run
    // prepare, and scripts/ is outside `files`, so drop the hook referencing
    // the non-shipped guard script (#2471).
    const stagedPkg = {
        ...stagedBase,
        scripts: Object.fromEntries(Object.entries(stagedBase.scripts ?? {}).filter(([name]) => name !== "prepare")),
    };
    fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`);
    for (const entry of PKG.files) {
        const src = path.join(REPO_ROOT, entry);
        if (fs.existsSync(src)) await fs.promises.cp(src, path.join(stage, entry), { recursive: true });
    }
    const home = path.join(work, "home-pkg");
    fs.mkdirSync(home, { recursive: true });
    const listing = npmRunSync(["pack", "--silent", "--pack-destination", packs], { cwd: stage, env: { PATH: process.env.PATH ?? "", ...npmHomeEnv(home) } })
        .trim()
        .split("\n")
        .pop()
        ?.trim();
    assert.ok(listing?.endsWith(".tgz"), `npm pack produced no tarball for ${version}: ${listing}`);
    return path.join(packs, listing!);
}

// The fake install MUST sit under a node_modules directory: isNpmInstallForm
// (plugin-install.ts) keys off that path shape, and the git-working-tree guard
// needs no .git anywhere in the install itself (npm pack output has none).
async function extractInstall(work: string, tgz: string): Promise<string> {
    const installDir = path.join(work, "global", "node_modules", PKG.name);
    fs.mkdirSync(installDir, { recursive: true });
    await tar.x({ file: tgz, cwd: installDir, strip: 1 });
    return installDir;
}

function opencodeCfgPath(work: string): string {
    return path.join(work, "config", "opencode", "opencode.jsonc");
}

function seedOpencodeConfig(work: string): void {
    const file = opencodeCfgPath(work);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ plugins: ["billion-context"], compaction: { auto: false } }, null, 2)}\n`);
}

// Deterministic host-major probe target: prints a 2.x version so
// detectOpencodeMajor() lands on key "plugins" regardless of what (if
// anything) is installed on the host. Cross-platform: .cmd shim on Windows
// (the product routes .cmd through the shell), shebang script on POSIX.
function fakeOpencodeBin(work: string): string {
    return fakeVersionBin(work, "fake-opencode", "2.4.0");
}

test("hermetic registry e2e", { skip: skipReason }, async (t) => {
    assert.ok(fs.existsSync(DIST_ENTRY), "dist/index.js missing — run `npm run build` first");
    const workRoot = path.join(process.cwd(), "tmp");
    fs.mkdirSync(workRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(workRoot, "e2e-registry-"));
    t.after(() => rmrf(work));

    const reg = await startRegistry(path.join(work, "registry"));
    t.after(() => reg.stop());

    const envBase = isolatedEnv(work);
    seedOpencodeConfig(work);
    const ocBin = fakeOpencodeBin(work);

    const oldTgz = await makeFixtureTarball(work, OLD_VERSION);
    const newTgz = await makeFixtureTarball(work, NEW_VERSION);
    await reg.publish(oldTgz);
    await reg.publish(newTgz);
    const installDir = await extractInstall(work, oldTgz);

    await t.test("registry serves the controlled version sequence with real integrity metadata", async () => {
        const doc = (await (await fetch(`${reg.url}/${PKG.name}/latest`)).json()) as {
            version: string;
            dist?: { tarball?: string; integrity?: string; shasum?: string };
        };
        assert.equal(doc.version, NEW_VERSION);
        assert.ok(doc.dist?.integrity?.startsWith("sha512-"), "verdaccio must serve sha512 integrity");
        assert.ok(doc.dist?.shasum, "shasum present");
        assert.ok(doc.dist?.tarball?.startsWith(reg.url), "tarball URL must point at the local registry");
    });

    await t.test("self-update: old install detects and installs the new version over the real chain", async () => {
        assert.equal(await readPkgVersion(installDir), OLD_VERSION);
        const res = runBili(installDir, ["update"], { ...envBase, BILI_UPDATE_REGISTRY: reg.url });
        assert.equal(res.code, 0, `bili update failed:\n${res.stderr}`);
        assert.match(res.stderr, /\[update\] checking npm registry for /);
        assert.match(res.stderr, new RegExp(`new version found: ${escapeRe(OLD_VERSION)} → ${escapeRe(NEW_VERSION)}, downloading`));
        assert.match(res.stderr, new RegExp(`installed ${escapeRe(OLD_VERSION)} → ${escapeRe(NEW_VERSION)}\\. Restart to finish\\.`));
        assert.equal(await readPkgVersion(installDir), NEW_VERSION, "on-disk version must flip to the published one");
        const cache = path.join(envBase.XDG_CACHE_HOME!, "billion-context");
        for (const entry of fs.readdirSync(cache)) {
            assert.ok(!entry.startsWith(".update-staging"), `leftover staging dir: ${entry}`);
            assert.ok(!entry.startsWith(".update-backup"), `leftover backup dir: ${entry}`);
            assert.ok(!entry.startsWith(".update-wip"), `leftover temp workdir: ${entry}`);
        }
        assert.ok(!fs.existsSync(path.join(cache, ".update-lock")), "lock must be released after success");
        assert.ok(fs.existsSync(path.join(installDir, "dist", "agent", "opencode-native.js")), "installed tree keeps the agent entrypoint");
    });

    await t.test("post-update `plugin install opencode` keeps a valid entry (master semantics)", async () => {
        const res = runBili(installDir, ["plugin", "install", "opencode"], { ...envBase, BILI_UPDATE_REGISTRY: reg.url, BILI_CLIENT_BIN: ocBin });
        assert.equal(res.code, 0, `plugin install failed:\n${res.stdout}\n${res.stderr}`);
        const cfg = JSON.parse(fs.readFileSync(opencodeCfgPath(work), "utf8")) as Record<string, unknown>;
        // Master semantics: npm-form install writes the bare package name and
        // an already-correct entry is left untouched (idempotent).
        // TODO(#1143): once the pinned-entry change lands, replace these with
        // entry === `billion-context@${NEW_VERSION}` (the re-pin assertion).
        assert.deepEqual(cfg.plugins, ["billion-context"]);
        assert.deepEqual(cfg.compaction, { auto: false });
        assert.match(res.stdout, /plugins present/);
    });
});

test("hermetic npm -g install e2e (real npm client, real global layout)", { skip: skipReason }, async (t) => {
    assert.ok(fs.existsSync(DIST_ENTRY), "dist/index.js missing — run `npm run build` first");
    const workRoot = path.join(process.cwd(), "tmp");
    fs.mkdirSync(workRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(workRoot, "e2e-npm-global-"));
    t.after(() => rmrf(work));

    const reg = await startRegistry(path.join(work, "registry"));
    t.after(() => reg.stop());
    await reg.publish(await makeFixtureTarball(work, OLD_VERSION, { bare: true }));
    await reg.publish(await makeFixtureTarball(work, NEW_VERSION, { bare: true }));
    const envBase = isolatedEnv(work);

    // The REAL npm client installing globally into an isolated prefix — not
    // the manual tar extraction the flip test above uses. This is the layout
    // real users get from `npm install -g billion-context`, per platform:
    //   win32:  <prefix>/node_modules/<pkg> + <prefix>/bili.cmd shim
    //   POSIX:  <prefix>/lib/node_modules/<pkg> + <prefix>/bin/bili shim
    const prefix = path.join(work, "npm-global");
    fs.mkdirSync(prefix, { recursive: true });
    await reg.npm(["install", "--global", `${PKG.name}@${OLD_VERSION}`, "--prefix", prefix]);
    const installDir = fs.existsSync(path.join(prefix, "node_modules", PKG.name))
        ? path.join(prefix, "node_modules", PKG.name)
        : path.join(prefix, "lib", "node_modules", PKG.name);
    assert.equal(await readPkgVersion(installDir), OLD_VERSION, `npm -g did not lay the package at ${installDir}`);
    const shim = IS_WIN ? path.join(prefix, "bili.cmd") : path.join(prefix, "bin", "bili");
    assert.ok(fs.existsSync(shim), `npm -g must lay the bili shim at ${shim} for this platform`);

    // Self-update must classify the npm-global layout as bili-owned
    // (hostManagedInstall) and flip it in place over the real chain.
    const res = runBili(installDir, ["update"], { ...envBase, BILI_UPDATE_REGISTRY: reg.url });
    assert.equal(res.code, 0, `bili update failed:\n${res.stderr}`);
    assert.match(res.stderr, new RegExp(`installed ${escapeRe(OLD_VERSION)} → ${escapeRe(NEW_VERSION)}\. Restart to finish\.`));
    assert.equal(await readPkgVersion(installDir), NEW_VERSION, "npm-global on-disk version must flip to the published one");

    // The shim npm laid down still resolves through to the flipped tree.
    // (.cmd shims cannot be spawned without a shell on Windows — route them
    // through cmd like the product's own client probe does.)
    const probe = IS_WIN
        ? spawnSync(`"${shim}" --version`, { shell: true, encoding: "utf8", timeout: 60_000, env: biliSpawnEnv(envBase) })
        : spawnSync(shim, ["--version"], { encoding: "utf8", timeout: 60_000, env: biliSpawnEnv(envBase) });
    const shimVersion = (probe.stdout ?? "").trim();
    // #2345: --version now renders "<semver> (<commit>)" — the flip assertion
    // targets the bare semver (first token), which is what the updater owns.
    const shimSemver = shimVersion.split(/\s+/)[0];
    assert.match(shimSemver, new RegExp(`^v?${escapeRe(NEW_VERSION)}$`), `bili shim must report the flipped version, got: ${JSON.stringify(shimVersion)}`);

    // No-op re-run: already sitting at the registry's latest — must exit
    // clean, say so, and touch nothing on disk (no re-download, no churn).
    const pkgJson = path.join(installDir, "package.json");
    const mtimeBefore = fs.statSync(pkgJson).mtimeMs;
    const noop = runBili(installDir, ["update"], { ...envBase, BILI_UPDATE_REGISTRY: reg.url });
    assert.equal(noop.code, 0, `no-op update failed:\n${noop.stderr}`);
    assert.match(noop.stderr, /\(up to date\)/, "no-op update must log the up-to-date line");
    assert.doesNotMatch(noop.stderr, /Restart to finish/, "no-op update must not claim an install happened");
    assert.equal(await readPkgVersion(installDir), NEW_VERSION);
    assert.equal(fs.statSync(pkgJson).mtimeMs, mtimeBefore, "no-op update must not touch the installed tree");
});

// #1628 verification hardening: three shapes the chain above never drove —
// the unwritable-target failure class (the 12-day retry wall), the
// LIVE-old-code hop (the no-op protocol's object, local form), and dist-level
// resolution from the opencode cache-lane layout.

test("unwritable install dir: real-chain failure is loud, self-explaining, and one line (#1628)", { skip: IS_WIN ? "chmod 0o555 does not deny directory writes on win32" : skipReason }, async (t) => {
    assert.ok(fs.existsSync(DIST_ENTRY), "dist/index.js missing — run `npm run build` first");
    const workRoot = path.join(process.cwd(), "tmp");
    fs.mkdirSync(workRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(workRoot, "e2e-unwritable-"));
    const installRoot = () => path.join(work, "global", "node_modules", PKG.name);
    t.after(() => {
        try {
            fs.chmodSync(installRoot(), 0o755);
        } catch {
            // tree may already be gone
        }
        rmrf(work);
    });

    const reg = await startRegistry(path.join(work, "registry"));
    t.after(() => reg.stop());

    const oldTgz = await makeFixtureTarball(work, OLD_VERSION);
    await reg.publish(oldTgz);
    await reg.publish(await makeFixtureTarball(work, NEW_VERSION));
    const installDir = await extractInstall(work, oldTgz);

    fs.chmodSync(installDir, 0o555);
    const res = runBili(installDir, ["update"], { ...isolatedEnv(work), BILI_UPDATE_REGISTRY: reg.url });
    assert.match(res.stderr, new RegExp(`\\[update\\] install failed: install dir not writable: ${escapeRe(installDir)}`));
    assert.match(res.stderr, /Will retry next cycle/, "the every-cycle retry line stays unchanged");
    const location = res.stderr.split("\n").filter((l) => l.includes("[update] install location:"));
    assert.equal(location.length, 1, "the location diagnostic must fire exactly once per process (#1628)");
    assert.match(location[0]!, new RegExp(`target=${escapeRe(installDir)}`));
    assert.match(location[0]!, /running=/);
    assert.match(location[0]!, /updates only the copy it runs from/);
    assert.equal(await readPkgVersion(installDir), OLD_VERSION, "nothing may flip when the target is unwritable");
    const lockHit = fs.readdirSync(work, { recursive: true }).find((p): p is string => typeof p === "string" && p.endsWith(".update-lock"));
    assert.equal(lockHit, undefined, `update lock leaked after failure: ${lockHit}`);
});

test("real published baseline hops to the new dist: the LIVE old updater over the real chain (#1628 no-op validation, local form)", { skip: realSkip }, async (t) => {
    assert.ok(fs.existsSync(DIST_ENTRY), "dist/index.js missing — run `npm run build` first");
    assert.ok(REAL_BASELINE, "BILI_E2E_REAL_BASELINE must be set (the skip guard should have skipped)");
    const workRoot = path.join(process.cwd(), "tmp");
    fs.mkdirSync(workRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(workRoot, "e2e-real-baseline-"));
    t.after(() => rmrf(work));

    const reg = await startRegistry(path.join(work, "registry"));
    t.after(() => reg.stop());

    // The one deliberate non-hermetic read: the baseline is the REAL published
    // artifact. The no-op protocol validates the live old code doing the hop;
    // a self-built baseline (faked low version of current dist) cannot stand
    // in for it — that hole is exactly why this phase exists.
    const dl = await fetch(`https://registry.npmjs.org/${PKG.name}/-/${PKG.name}-${REAL_BASELINE}.tgz`);
    assert.ok(dl.ok, `could not download ${PKG.name}@${REAL_BASELINE}: HTTP ${dl.status}`);
    const realTgz = path.join(work, `${PKG.name}-${REAL_BASELINE}.tgz`);
    fs.writeFileSync(realTgz, Buffer.from(await dl.arrayBuffer()));

    const realNew = bumpPatch(REAL_BASELINE);
    await reg.publish(await makeFixtureTarball(work, realNew, { bare: true }));
    const installDir = await extractInstall(work, realTgz);
    assert.equal(await readPkgVersion(installDir), REAL_BASELINE);

    const res = runBili(installDir, ["update"], { ...isolatedEnv(work), BILI_UPDATE_REGISTRY: reg.url });
    assert.equal(res.code, 0, `bili update failed:\n${res.stderr}`);
    assert.match(res.stderr, new RegExp(`installed ${escapeRe(REAL_BASELINE)} → ${escapeRe(realNew)}\\. Restart to finish\\.`));
    assert.equal(await readPkgVersion(installDir), realNew, "the real published updater must flip its own tree to the local dist");
});

test("doctor from a simulated opencode cache lane resolves its own running copy (#1628 layout)", { skip: skipReason }, async (t) => {
    assert.ok(fs.existsSync(DIST_ENTRY), "dist/index.js missing — run `npm run build` first");
    const workRoot = path.join(process.cwd(), "tmp");
    fs.mkdirSync(workRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(workRoot, "e2e-lane-doctor-"));
    t.after(() => rmrf(work));

    const reg = await startRegistry(path.join(work, "registry"));
    t.after(() => reg.stop());

    const laneTs = path.join(work, "npm", `${PKG.name}@latest`, "1789577146915");
    fs.mkdirSync(laneTs, { recursive: true });
    fs.writeFileSync(path.join(laneTs, "package.json"), `${JSON.stringify({ dependencies: { [PKG.name]: OLD_VERSION } }, null, 2)}\n`);
    const root = path.join(laneTs, "node_modules", PKG.name);
    fs.mkdirSync(root, { recursive: true });
    await tar.x({ file: await makeFixtureTarball(work, OLD_VERSION), cwd: root, strip: 1 });

    const res = runBili(root, ["doctor", "--json"], { ...isolatedEnv(work), BILI_UPDATE_REGISTRY: reg.url });
    assert.equal(res.code, 0, `doctor failed:\n${res.stdout}\n${res.stderr}`);
    const report = JSON.parse(res.stdout) as { global: { installDir?: string; form?: string } };
    assert.equal(report.global.installDir, fs.realpathSync(root), "doctor must resolve the update target to the RUNNING copy, not a global root (#1628)");
    assert.equal(report.global.form, "npm");
});
