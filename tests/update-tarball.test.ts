import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { installViaTarball, declaredEntryRelPaths } from "../src/update.ts";

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

interface Fixture {
    root: string;
    installDir: string;
    cacheDir: string;
    makeTarball(files: Record<string, string>): { tgz: Buffer; integrity: string };
}

/** A running install at 1.2.3 plus a scratch cache dir, like a real host. */
function makeFixture(): Fixture {
    const root = mkdtempSync(path.join(tmpdir(), "bc-update-test-"));
    const installDir = path.join(root, "install");
    const cacheDir = path.join(root, "cache");
    mkdirSync(path.join(installDir, "dist"), { recursive: true });
    writeFileSync(
        path.join(installDir, "package.json"),
        JSON.stringify({
            name: "billion-context",
            version: "1.2.3",
            type: "module",
            main: "dist/index.js",
            bin: { bili: "./dist/index.js" },
        }),
    );
    writeFileSync(path.join(installDir, "dist", "index.js"), "export const loaded = '1.2.3';\n");
    return {
        root,
        installDir,
        cacheDir,
        makeTarball(files) {
            const src = path.join(root, "pkg");
            mkdirSync(path.join(src, "package"), { recursive: true });
            for (const [rel, body] of Object.entries(files)) {
                const dest = path.join(src, "package", rel);
                mkdirSync(path.dirname(dest), { recursive: true });
                writeFileSync(dest, body);
            }
            const tgzPath = path.join(root, "pkg.tgz");
            tar.c({ cwd: src, file: tgzPath, gzip: true, sync: true }, ["package"]);
            const tgz = readFileSync(tgzPath);
            return { tgz, integrity: integrityField(tgz) };
        },
    };
}

/** Serve a crafted tarball through global fetch; never touch the network. */
function withTarballFetch<T>(tgz: Buffer, fn: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response(tgz))) as unknown as typeof fetch;
    return fn().finally(() => {
        globalThis.fetch = original;
    });
}

/** v2.0.0 package.json for tarball payloads. */
function pkgJson(version: string): string {
    return JSON.stringify({
        name: "billion-context",
        version,
        type: "module",
        main: "dist/index.js",
        bin: { bili: "./dist/index.js" },
    });
}

test("declaredEntryRelPaths: main plus bin values (string and map), deduped", () => {
    assert.deepEqual(
        declaredEntryRelPaths({ main: "dist/index.js", bin: { bili: "dist/index.js", proxy: "./dist/proxy.js" } }),
        ["dist/index.js", "./dist/proxy.js"],
    );
    assert.deepEqual(declaredEntryRelPaths({ bin: "cli.js" }), ["cli.js"]);
    assert.deepEqual(declaredEntryRelPaths({}), []);
});

test("installViaTarball: clean tarball installs and removes the backup", { timeout: 30_000 }, async () => {
    const fx = makeFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    try {
        const { tgz, integrity } = fx.makeTarball({
            "package.json": pkgJson("2.0.0"),
            "dist/index.js": "export const loaded = '2.0.0';\n",
        });
        const r = await withTarballFetch(
            tgz,
            () => installViaTarball("2.0.0", "https://registry.test/x.tgz", fx.installDir, integrity),
        );
        assert.equal(r.ok, true, r.error);
        assert.equal(JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version, "2.0.0");
        assert.equal(readFileSync(path.join(fx.installDir, "dist", "index.js"), "utf-8"), "export const loaded = '2.0.0';\n");
        assert.equal(existsSync(path.join(fx.cacheDir, "billion-context", ".update-backup-2.0.0")), false, "backup must be removed on success");
    } finally {
        delete process.env.XDG_CACHE_HOME;
        rmSync(fx.root, { recursive: true, force: true });
    }
});

test("installViaTarball: syntax-broken entry is rejected in staging, install untouched", { timeout: 30_000 }, async () => {
    const fx = makeFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    try {
        const { tgz, integrity } = fx.makeTarball({
            "package.json": pkgJson("2.0.0"),
            "dist/index.js": "export const broken = (!;\n",
        });
        const r = await withTarballFetch(
            tgz,
            () => installViaTarball("2.0.0", "https://registry.test/x.tgz", fx.installDir, integrity),
        );
        assert.equal(r.ok, false);
        assert.match(r.error ?? "", /staging verification failed: entry does not parse/);
        // The anti-brick guarantee: the running install is byte-for-byte intact.
        assert.equal(JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version, "1.2.3");
        assert.match(readFileSync(path.join(fx.installDir, "dist", "index.js"), "utf-8"), /1\.2\.3/);
    } finally {
        delete process.env.XDG_CACHE_HOME;
        rmSync(fx.root, { recursive: true, force: true });
    }
});

test("installViaTarball: tarball missing its declared entry is rejected in staging", { timeout: 30_000 }, async () => {
    const fx = makeFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    try {
        // package.json declares dist/index.js but the tarball ships no dist/.
        const { tgz, integrity } = fx.makeTarball({ "package.json": pkgJson("2.0.0") });
        const r = await withTarballFetch(
            tgz,
            () => installViaTarball("2.0.0", "https://registry.test/x.tgz", fx.installDir, integrity),
        );
        assert.equal(r.ok, false);
        assert.match(r.error ?? "", /staging verification failed: entry missing: dist\/index\.js/);
        assert.equal(JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version, "1.2.3");
    } finally {
        delete process.env.XDG_CACHE_HOME;
        rmSync(fx.root, { recursive: true, force: true });
    }
});
