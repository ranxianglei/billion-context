// #5340: `bili pack install|remove|list` — installs a pack from an npm
// package (convention: bili-pack.json in the package root). Specs here are
// LOCAL DIRECTORIES so the suite stays deterministic and offline: `npm
// install <dir>` exercises the same code path as a registry spec.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir } from "../src/paths.js";
import { installPackFromNpm, removePackFile, packDirFor, PACK_ENTRY_FILE } from "../src/pack-install.js";
import { listResolvedPacks } from "../src/compress-settings.js";

function fixturePkg(withEntry: boolean, entry?: unknown): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bili-pack-fixture-"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "zz-fixture-pack", version: "1.0.0" }, null, 2));
    if (withEntry) writeFileSync(path.join(dir, PACK_ENTRY_FILE), typeof entry === "string" ? entry : JSON.stringify(entry ?? { promptSections: { philosophy: "fixture" } }));
    return dir;
}

const userPacksDir = path.join(configDir(), "packs");

test("install from a local package dir lands a resolvable user pack", () => {
    const fixture = fixturePkg(true, { name: "zz-fixture-pack", version: "1.0.0", promptSections: { philosophy: "fixture" } });
    const r = installPackFromNpm(fixture);
    assert.equal(r.name, "zz-fixture-pack");
    assert.equal(r.version, "1.0.0");
    assert.ok(existsSync(r.file));
    assert.equal(r.file, path.join(userPacksDir, "zz-fixture-pack.json"));
    const listed = listResolvedPacks();
    const found = listed.find((p) => p.name === "zz-fixture-pack");
    assert.ok(found, "installed pack must appear in the resolved list");
    assert.equal(found?.source.startsWith("file:"), true);
    removePackFile("zz-fixture-pack");
});

test("reinstall refuses without --force and replaces with --force", () => {
    const f1 = fixturePkg(true, { name: "zz-force", promptSections: { philosophy: "first" } });
    installPackFromNpm(f1);
    const file = path.join(userPacksDir, "zz-force.json");
    assert.throws(() => installPackFromNpm(fixturePkg(true, { name: "zz-force", promptSections: { philosophy: "second" } })), /--force/);
    // no silent overwrite without force
    assert.match(readFileSync(file, "utf8"), /first/);
    const r = installPackFromNpm(fixturePkg(true, { name: "zz-force", promptSections: { philosophy: "second" } }), { force: true });
    assert.equal(r.file, file);
    assert.match(readFileSync(file, "utf8"), /second/);
    removePackFile("zz-force");
});

test("a package without bili-pack.json is refused with a clear message", () => {
    const fixture = fixturePkg(false);
    assert.throws(() => installPackFromNpm(fixture), new RegExp(PACK_ENTRY_FILE));
});

test("invalid pack names and empty surfaces are refused, nothing written", () => {
    const badName = fixturePkg(true, { name: "../evil", promptSections: { philosophy: "x" } });
    assert.throws(() => installPackFromNpm(badName), /pack name .* is invalid/);
    const empty = fixturePkg(true, { description: "only unknown fields" });
    assert.throws(() => installPackFromNpm(empty), /no recognized pack fields/);
});

test("remove deletes the file and errors on the second call", () => {
    installPackFromNpm(fixturePkg(true, { name: "zz-remove", promptSections: { philosophy: "x" } }));
    const file = removePackFile("zz-remove");
    assert.ok(!existsSync(file));
    assert.throws(() => removePackFile("zz-remove"), /no pack named/);
    assert.throws(() => removePackFile("../evil"), /invalid pack name/i);
});

test("packDirFor distinguishes project vs user targets", () => {
    assert.equal(packDirFor(false), userPacksDir);
    assert.equal(packDirFor(true), path.join(process.cwd(), ".billion-context", "packs"));
});
