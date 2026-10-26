// #991 single-writer: the global self-updater must never overwrite a copy
// owned by a host package manager or a host agent tree (pnpm virtual store,
// pi / opencode / dsh / kimi / omp homes). hostManagedInstall() classifies an
// install dir; checkForUpdate skips such dirs; installViaTarball refuses
// them structurally so direct callers cannot corrupt a store either.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { hostManagedInstall, installViaTarball } from "../src/update.ts";
import { rmrf } from "./tmp-rm.ts";

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

test("hostManagedInstall: pnpm virtual-store paths are pnpm-owned", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-host-guard-"));
    try {
        // dsh profile bundle layout (dsh's pnpm forwarder)
        const dshBundle = path.join(base, ".dsh", "profiles", "default", "node_modules", ".pnpm", "billion-context@0.1.121", "node_modules", "billion-context");
        assert.equal(hostManagedInstall(dshBundle)?.owner, "pnpm");
        // pnpm global layout
        const pnpmGlobal = path.join(base, "pnpm", "global", "5", ".pnpm", "billion-context@0.1.121", "node_modules", "billion-context");
        assert.equal(hostManagedInstall(pnpmGlobal)?.owner, "pnpm");
        assert.match(hostManagedInstall(dshBundle)!.channel, /dsh profiles refresh/);
    } finally {
        rmrf(base);
    }
});

test("hostManagedInstall: host agent homes own their trees", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-host-guard-"));
    try {
        const piDir = path.join(base, "pi-root", "node_modules", "billion-context");
        assert.equal(hostManagedInstall(piDir, { PI_HOME: path.join(base, "pi-root") })?.owner, "pi");
        assert.match(hostManagedInstall(piDir, { PI_HOME: path.join(base, "pi-root") })!.channel, /pi update/);

        const ocDir = path.join(base, "xdg", "opencode", "node_modules", "billion-context");
        assert.equal(hostManagedInstall(ocDir, { XDG_DATA_HOME: path.join(base, "xdg") })?.owner, "opencode");

        const dshDir = path.join(base, "dsh-root", "plugins", "billion-context");
        assert.equal(hostManagedInstall(dshDir, { DSH_HOME: path.join(base, "dsh-root") })?.owner, "dsh");

        const kimiDir = path.join(base, "kimi-root", "plugins", "managed", "billion-context");
        assert.equal(hostManagedInstall(kimiDir, { KIMI_CODE_HOME: path.join(base, "kimi-root") })?.owner, "kimi");

        // PI_CODING_AGENT_DIR relocates BOTH the pi and omp homes (omp is a
        // pi fork and shares the env) — either owner is correct; what matters
        // is the guard fires on that tree.
        const ompDir = path.join(base, "omp-root", "node_modules", "billion-context");
        const ompOwner = hostManagedInstall(ompDir, { PI_CODING_AGENT_DIR: path.join(base, "omp-root") })?.owner;
        assert.ok(ompOwner === "pi" || ompOwner === "omp", `unexpected owner ${ompOwner}`);
    } finally {
        rmrf(base);
    }
});

// #2199/#1234: the opencode v2 CACHE copy (bare "billion-context" entry,
// materialized into ~/.cache/opencode/npm/...) is bili-owned IN PLACE — the
// self-updater must keep updating it — while the opencode DATA-HOME plugin
// tree (~/.local/share/opencode) stays host-managed. The two trees are distinct
// and both custom XDG roots must be honored.
test("hostManagedInstall: opencode cache copy is bili-owned in place (#1234), distinct from the data-home tree", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-host-guard-"));
    try {
        const cacheHome = path.join(base, "xdg-cache");
        const dataHome = path.join(base, "xdg-data");
        // cache layout: <XDG_CACHE_HOME>/opencode/npm/billion-context@<spec>/<ts>/node_modules/billion-context
        const cacheCopy = path.join(cacheHome, "opencode", "npm", "billion-context@latest", "1700000000000", "node_modules", "billion-context");
        assert.equal(hostManagedInstall(cacheCopy, { XDG_CACHE_HOME: cacheHome, XDG_DATA_HOME: dataHome }), undefined, "cache copy stays bili-owned (self-updates in place, #1234)");
        // a pinned spec (not @latest) under a CUSTOM XDG_CACHE_HOME is still the cache copy
        const altCache = path.join(base, "alt-cache", "opencode", "npm", "billion-context@1.2.3", "5", "node_modules", "billion-context");
        assert.equal(hostManagedInstall(altCache, { XDG_CACHE_HOME: path.join(base, "alt-cache") }), undefined, "custom XDG_CACHE_HOME honored");
        // the DATA-HOME plugin tree under a different base is still host-managed
        const dataCopy = path.join(dataHome, "opencode", "node_modules", "billion-context");
        assert.equal(hostManagedInstall(dataCopy, { XDG_DATA_HOME: dataHome })?.owner, "opencode", "data-home tree stays host-managed");
        // same cache tree but NOT at the node_modules/billion-context leaf is not claimed
        const notLeaf = path.join(cacheHome, "opencode", "npm", "billion-context@latest", "1", "node_modules");
        assert.equal(hostManagedInstall(notLeaf, { XDG_CACHE_HOME: cacheHome }), undefined);
    } finally {
        rmrf(base);
    }
});

test("hostManagedInstall: dsh desktop profile copy is bili-owned in place (#1575)", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-host-guard-"));
    try {
        const ds = path.join(base, "dsh-root");
        const env = { DSH_HOME: ds };
        // flat node_modules entry (the pnpm forwarder path the proxy runs from)
        assert.equal(hostManagedInstall(path.join(ds, "profiles", "desktop", "node_modules", "billion-context"), env), undefined);
        // realpath form: the virtual-store target beneath the desktop profile
        assert.equal(hostManagedInstall(path.join(ds, "profiles", "desktop", ".pnpm", "billion-context@0.1.178_x", "node_modules", "billion-context"), env), undefined);
        // identical shape under any OTHER profile stays pnpm-owned
        assert.equal(hostManagedInstall(path.join(ds, "profiles", "web", ".pnpm", "billion-context@0.1.178_x", "node_modules", "billion-context"), env)?.owner, "pnpm");
    } finally {
        rmrf(base);
    }
});

test("hostManagedInstall: bili-owned dirs (npm global layout, scratch) stay updatable", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-host-guard-"));
    try {
        assert.equal(hostManagedInstall(path.join(base, "install")), undefined);
        // plain npm global layout: <home>/.local/lib/node_modules/billion-context
        // must NOT be classified as opencode-owned even though both live under
        // the same XDG-ish tree root.
        assert.equal(hostManagedInstall(path.join(base, "home", ".local", "lib", "node_modules", "billion-context"), { HOME: path.join(base, "home") }), undefined);
    } finally {
        rmrf(base);
    }
});

interface Fixture {
    root: string;
    installDir: string;
    cacheDir: string;
    cleanup(): void;
}

/** A running install at 1.2.3 under `relInstall`, plus scratch cache. */
function makeFixture(relInstall: string): Fixture {
    const root = mkdtempSync(path.join(tmpdir(), "bc-update-guard-"));
    const installDir = path.join(root, relInstall);
    const cacheDir = path.join(root, "cache");
    mkdirSync(path.join(installDir, "dist"), { recursive: true });
    writeFileSync(
        path.join(installDir, "package.json"),
        JSON.stringify({ name: "billion-context", version: "1.2.3", type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }),
    );
    writeFileSync(path.join(installDir, "dist", "index.js"), "export const loaded = '1.2.3';\n");
    return { root, installDir, cacheDir, cleanup: () => rmrf(root) };
}

function makeTarball(root: string, version: string): { tgz: Buffer; integrity: string } {
    const src = path.join(root, "pkg");
    mkdirSync(path.join(src, "package", "dist"), { recursive: true });
    writeFileSync(path.join(src, "package", "package.json"), JSON.stringify({ name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }));
    writeFileSync(path.join(src, "package", "dist", "index.js"), `export const loaded = '${version}';\n`);
    const tgzPath = path.join(root, "pkg.tgz");
    tar.c({ cwd: src, file: tgzPath, gzip: true, sync: true }, ["package"]);
    const tgz = readFileSync(tgzPath);
    return { tgz, integrity: integrityField(tgz) };
}

async function withTarballFetch<T>(tgz: Buffer, fn: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response(tgz))) as unknown as typeof fetch;
    return fn().finally(() => {
        globalThis.fetch = original;
    });
}

test("installViaTarball: refuses a pnpm-store install dir and leaves it untouched", { timeout: 30_000 }, async () => {
    const fx = makeFixture(path.join("node_modules", ".pnpm", "billion-context@1.2.3", "node_modules", "billion-context"));
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    try {
        const { tgz, integrity } = makeTarball(fx.root, "2.0.0");
        const r = await withTarballFetch(tgz, () => installViaTarball("2.0.0", "https://registry.test/x.tgz", fx.installDir, integrity));
        assert.equal(r.ok, false);
        assert.match(r.error ?? "", /pnpm/);
        assert.match(r.error ?? "", /single-writer/);
        assert.equal(JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version, "1.2.3", "store copy untouched");
    } finally {
        delete process.env.XDG_CACHE_HOME;
        fx.cleanup();
    }
});

test("installViaTarball: refuses a pi-owned install dir", { timeout: 30_000 }, async () => {
    const fx = makeFixture(path.join(".pi", "agent", "node_modules", "billion-context"));
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    process.env.PI_HOME = path.join(fx.root, ".pi", "agent");
    try {
        const { tgz, integrity } = makeTarball(fx.root, "2.0.0");
        const r = await withTarballFetch(tgz, () => installViaTarball("2.0.0", "https://registry.test/x.tgz", fx.installDir, integrity));
        assert.equal(r.ok, false);
        assert.match(r.error ?? "", /pi/);
        assert.equal(JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version, "1.2.3", "pi copy untouched");
    } finally {
        delete process.env.XDG_CACHE_HOME;
        delete process.env.PI_HOME;
        fx.cleanup();
    }
});
