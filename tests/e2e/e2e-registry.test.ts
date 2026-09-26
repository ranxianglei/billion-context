// Hermetic registry e2e (#1153): exercises the REAL self-update chain —
// dist-tag resolve → tarball download → sha512 verify → staged extract →
// in-place install → disk flip — plus the post-update opencode plugin entry,
// against a local verdaccio. Loopback only, zero secrets, zero tokens.
// Gated like ACP_TEST_E2E so plain `npm test` stays free.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as tar from "tar";
import { startRegistry } from "./registry-fixture.js";

const run = process.env.ACP_TEST_REGISTRY === "1";
const skipReason = !run ? "set ACP_TEST_REGISTRY=1 (hermetic local-registry e2e; loopback only)" : undefined;

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { name: string; version: string; files: string[] };
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

function isolatedEnv(work: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, dir] of [
        ["HOME", "home"],
        ["XDG_CONFIG_HOME", "config"],
        ["XDG_CACHE_HOME", "cache"],
        ["XDG_STATE_HOME", "state"],
        ["XDG_DATA_HOME", "data"],
    ] as const) {
        const p = path.join(work, dir);
        fs.mkdirSync(p, { recursive: true });
        env[key] = p;
    }
    return env;
}

function runBili(installDir: string, args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
    const res = spawnSync(process.execPath, [path.join(installDir, "dist", "index.js"), ...args], {
        encoding: "utf8",
        timeout: 180_000,
        env: { PATH: process.env.PATH ?? "", ...env },
    });
    return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

async function readPkgVersion(dir: string): Promise<string> {
    return (JSON.parse(await fs.promises.readFile(path.join(dir, "package.json"), "utf8")) as { version: string }).version;
}

// Stage a publishable tarball of THIS package at a synthetic version: same
// files field, same dist build, rewritten package.json version.
async function makeFixtureTarball(work: string, version: string): Promise<string> {
    const packs = path.join(work, "packs");
    fs.mkdirSync(packs, { recursive: true });
    const stage = path.join(work, "fixtures", version);
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({ ...PKG, version }, null, 2)}\n`);
    for (const entry of PKG.files) {
        const src = path.join(REPO_ROOT, entry);
        if (fs.existsSync(src)) await fs.promises.cp(src, path.join(stage, entry), { recursive: true });
    }
    const home = path.join(work, "home-pkg");
    fs.mkdirSync(home, { recursive: true });
    const listing = execFileSync("npm", ["pack", "--silent", "--pack-destination", packs], {
        cwd: stage,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: home },
    })
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
// anything) is installed on the host.
function fakeOpencodeBin(work: string): string {
    const bin = path.join(work, "bin", "fake-opencode");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\necho 2.4.0\n");
    fs.chmodSync(bin, 0o755);
    return bin;
}

test("hermetic registry e2e", { skip: skipReason }, async (t) => {
    assert.ok(fs.existsSync(DIST_ENTRY), "dist/index.js missing — run `npm run build` first");
    const workRoot = path.join(process.cwd(), "tmp");
    fs.mkdirSync(workRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(workRoot, "e2e-registry-"));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));

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
        }
        assert.ok(!fs.existsSync(path.join(cache, ".update-lock")), "lock must be released after success");
        assert.ok(fs.existsSync(path.join(installDir, "dist", "agent", "opencode-native.js")), "installed tree keeps the agent entrypoint");
    });

    await t.test("post-update `plugin install opencode` writes the pinned entry and leaves a correct one untouched (#1108)", async () => {
        const res = runBili(installDir, ["plugin", "install", "opencode"], { ...envBase, BILI_UPDATE_REGISTRY: reg.url, BILI_CLIENT_BIN: ocBin });
        assert.equal(res.code, 0, `plugin install failed:\n${res.stdout}\n${res.stderr}`);
        const cfg = JSON.parse(fs.readFileSync(opencodeCfgPath(work), "utf8")) as Record<string, unknown>;
        // #1108/#1143: the entry is an exact version so every boot resolves
        // from local cache — a bare spec re-resolves @latest at boot, the
        // restart-loop trigger. Installing again at the same version must be
        // idempotent (no duplicate, no churn).
        assert.deepEqual(cfg.plugins, [`billion-context@${NEW_VERSION}`]);
        assert.deepEqual(cfg.compaction, { auto: false });
        assert.match(res.stdout, new RegExp(`plugin -> ${escapeRe(`billion-context@${NEW_VERSION}`)} \\(replaced billion-context\\)`));
        // Idempotent: re-running install at the same version neither
        // duplicates nor churns the entry.
        const again = runBili(installDir, ["plugin", "install", "opencode"], { ...envBase, BILI_UPDATE_REGISTRY: reg.url, BILI_CLIENT_BIN: ocBin });
        assert.equal(again.code, 0, `second plugin install failed:\n${again.stdout}\n${again.stderr}`);
        const cfg2 = JSON.parse(fs.readFileSync(opencodeCfgPath(work), "utf8")) as Record<string, unknown>;
        assert.deepEqual(cfg2.plugins, [`billion-context@${NEW_VERSION}`]);
    });

    await t.test("opencode-managed old copy self-updates by re-pinning its entry — not by writing itself (#1108)", async () => {
        // A copy living inside opencode's own tree (#991: never written in
        // place) self-updates through the update check's refusal branch:
        // detect the newer registry version and re-pin the config entry so
        // opencode's manager fetches it at next boot.
        const managedDir = path.join(envBase.XDG_DATA_HOME!, "opencode", "plugin", PKG.name);
        fs.mkdirSync(managedDir, { recursive: true });
        await tar.x({ file: oldTgz, cwd: managedDir, strip: 1 });
        assert.equal(await readPkgVersion(managedDir), OLD_VERSION);

        const cfgFile = opencodeCfgPath(work);
        fs.writeFileSync(cfgFile, `${JSON.stringify({ plugins: [`billion-context@${OLD_VERSION}`] }, null, 2)}\n`);

        const res = runBili(managedDir, ["update"], { ...envBase, BILI_UPDATE_REGISTRY: reg.url });
        assert.equal(res.code, 0, `managed-copy update failed:\n${res.stderr}`);
        assert.match(res.stderr, /install dir is managed by opencode/, "must refuse in-place self-update");
        assert.equal(await readPkgVersion(managedDir), OLD_VERSION, "the opencode-owned copy must NOT be written");
        const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
        assert.deepEqual(cfg.plugins, [`billion-context@${NEW_VERSION}`], "entry re-pinned to the newest registry version");
    });

    await t.test("the pinned entry resolves offline from local cache — zero registry round-trips (#1108)", async () => {
        // Boot-locality is the actual #1108 mechanism: resolving an EXACT
        // spec touches the registry once, and every later resolution of the
        // same spec is served from npm's local tarball cache. Prime the cache
        // (online), then prove a second resolution succeeds with --offline
        // (cache-only: npm errors rather than fetches) and yields byte-identical
        // tarball bytes.
        const packs = path.join(work, "boot-packs");
        fs.mkdirSync(path.join(packs, "online"), { recursive: true });
        fs.mkdirSync(path.join(packs, "offline"), { recursive: true });
        await reg.npm(["pack", `billion-context@${NEW_VERSION}`, "--pack-destination", path.join(packs, "online")]);
        const served = fs.readdirSync(path.join(packs, "online")).filter((f) => f.endsWith(".tgz"));
        assert.equal(served.length, 1, "online pack fetched exactly one tarball");

        await reg.npm(["pack", "--offline", `billion-context@${NEW_VERSION}`, "--pack-destination", path.join(packs, "offline")]);
        const cached = fs.readdirSync(path.join(packs, "offline")).filter((f) => f.endsWith(".tgz"));
        assert.equal(cached.length, 1, "--offline (cache-only) must resolve the exact pinned spec");
        assert.equal(
            fs.readFileSync(path.join(packs, "online", served[0]!)).toString("base64"),
            fs.readFileSync(path.join(packs, "offline", cached[0]!)).toString("base64"),
            "cached tarball must be byte-identical to the registry's",
        );
    });
});
