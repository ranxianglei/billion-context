// 2026-11-14 (gate Lane X, master re-review of v0.1.213..36a04a798): in-place
// auto-update was 100%-broken on npm-layout installs (real node_modules with a
// RELATIVE node_modules/.bin symlink, as `npm i -g` lays it down). The #6309
// atomic-swap rewrite (30fb96fb0) did a file backup into backupDir BEFORE the
// atomic rename, so (a) the rename installDir->backupDir always hit
// ENOTEMPTY (non-empty target) — the atomic path could never succeed — and
// (b) the fallback re-copied installDir onto the EXISTING backup tree, where
// libuv's self-copy guard sees .bin/cli -> ../dep/cli.js (a relative symlink
// resolving inside the destination) and aborts with
// ERR_FS_CP_EINVAL "cannot copy ... to a subdirectory of self".
// Result: every `bili update` on such an install reported
// "backup of current install failed (install left untouched)" and stayed on
// the old version forever. These pins: consecutive in-place updates over a
// relative-.bin-symlink layout must succeed, and a corrupt artifact must roll
// back cleanly from the merge-copy backup.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";

const { installViaTarball, readDiskVersion } = await import("../src/update.ts");

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${createHash(alg).update(buf).digest("base64")}`;
}

/** npm-flavored install root: package files + a real node_modules whose
 * .bin entry is a RELATIVE symlink (the exact layout that trips the libuv
 * self-copy guard on re-copy). */
function writeNpmInstall(dir: string, version: string): void {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" } }),
    );
    writeFileSync(path.join(dir, "dist", "index.js"), `export const loaded = '${version}';\n`);
    // the dependency package + npm's relative .bin link to it
    mkdirSync(path.join(dir, "node_modules", "mime"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "mime", "cli.js"), "// dep\n");
    mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
    symlinkSync("../mime/cli.js", path.join(dir, "node_modules", ".bin", "mime"));
}

function makeTgz(root: string, version: string): Buffer {
    const src = path.join(root, "pkg", "package");
    rmSync(path.join(root, "pkg"), { recursive: true, force: true });
    writeNpmInstall(src, version);
    const tgzPath = path.join(root, `pkg-${version}.tgz`);
    tar.c({ cwd: path.join(root, "pkg"), file: tgzPath, gzip: true, sync: true }, ["package"]);
    return readFileSync(tgzPath);
}

test("in-place update over an npm-layout install with a relative .bin symlink succeeds twice in a row (gate Lane X regression)", { timeout: 60_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-inplace-symlink-"));
    const prevXdg = process.env.XDG_CACHE_HOME;
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = prevXdg;
        rmSync(root, { recursive: true, force: true });
    });
    const installDir = path.join(root, "prefix", "node_modules", "billion-context");
    writeNpmInstall(installDir, "1.0.0");
    process.env.XDG_CACHE_HOME = path.join(root, "cache");

    // 1.0.0 -> 2.0.0
    const t2 = makeTgz(root, "2.0.0");
    globalThis.fetch = (() => Promise.resolve(new Response(t2))) as unknown as typeof fetch;
    const r1 = await installViaTarball("2.0.0", "https://registry.test/x.tgz", installDir, integrityField(t2));
    assert.equal(r1.ok, true, r1.error ?? "first update failed without reason");
    assert.equal(await readDiskVersion(installDir), "2.0.0");
    assert.equal(readFileSync(path.join(installDir, "dist", "index.js"), "utf8"), "export const loaded = '2.0.0';\n");

    // 2.0.0 -> 3.0.0 — the second run is where the broken pre-backup layout
    // hit the self-copy EINVAL on every attempt (the install now contains a
    // previous update's relative .bin symlink again).
    const t3 = makeTgz(root, "3.0.0");
    globalThis.fetch = (() => Promise.resolve(new Response(t3))) as unknown as typeof fetch;
    const r2 = await installViaTarball("3.0.0", "https://registry.test/y.tgz", installDir, integrityField(t3));
    assert.equal(r2.ok, true, r2.error ?? "second update failed without reason");
    assert.equal(await readDiskVersion(installDir), "3.0.0");
    assert.equal(readFileSync(path.join(installDir, "dist", "index.js"), "utf8"), "export const loaded = '3.0.0';\n");
});

test("corrupt artifact rolls back to the previous npm-layout copy (merge-copy backup path)", { timeout: 60_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-inplace-rollback-"));
    const prevXdg = process.env.XDG_CACHE_HOME;
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = prevXdg;
        rmSync(root, { recursive: true, force: true });
    });
    const installDir = path.join(root, "prefix", "node_modules", "billion-context");
    writeNpmInstall(installDir, "1.0.0");
    process.env.XDG_CACHE_HOME = path.join(root, "cache");

    // version string in the tarball disagrees with the one being installed
    // -> post-install verification must fail and restore 1.0.0.
    const bad = makeTgz(root, "0.9.9");
    globalThis.fetch = (() => Promise.resolve(new Response(bad))) as unknown as typeof fetch;
    const r = await installViaTarball("2.0.0", "https://registry.test/bad.tgz", installDir, integrityField(bad));
    assert.equal(r.ok, false, "version-drift artifact must be rejected");
    assert.match(r.error ?? "", /version|ROLLBACK/i);
    assert.equal(await readDiskVersion(installDir), "1.0.0", "the previous working copy must be back");
    assert.equal(readFileSync(path.join(installDir, "dist", "index.js"), "utf8"), "export const loaded = '1.0.0';\n");
});
