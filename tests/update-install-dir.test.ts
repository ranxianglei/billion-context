// #1628: install-dir resolution must always land on the RUNNING copy. Pins the
// opencode npm cache-lane layout (`pkg@latest/<ts>/` wrapper without a `name`
// field + node_modules/pkg) where the 12-day /usr/lib retry wall (#1603
// defect 2) was misattributed to a resolution error: the walk resolves the
// lane copy correctly, refuses foreign ancestors when the running copy's own
// root is corrupt, and never falls back to a global prefix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "../src/logger.ts";
import { findInstallDir, findPackageRoot, describeInstallLocation, logInstallLocationOnce, _resetInstallLocationForTest } from "../src/update.ts";

const PKG = "billion-context";

function writePkg(dir: string, obj: unknown): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(obj));
}

/** Real opencode cache-lane shape for spec ("latest" or a version):
 *  <base>/npm/billion-context@<spec>/<ts>/package.json  {"dependencies":{...}} (no name)
 *  <base>/npm/billion-context@<spec>/<ts>/node_modules/billion-context/{package.json,dist/index.js} */
function makeCacheLane(base: string, spec: string): string {
    const tsDir = path.join(base, "npm", `${PKG}@${spec}`, "1789577146915");
    writePkg(tsDir, { dependencies: { [PKG]: "0.1.129" } });
    const root = path.join(tsDir, "node_modules", PKG);
    writePkg(root, { name: PKG, version: "0.1.129", main: "dist/index.js" });
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(root, "dist", "index.js"), "");
    return root;
}

test("findPackageRoot: opencode cache-lane layout resolves to the running copy, not a global root", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-installdir-"));
    try {
        for (const spec of ["latest", "0.1.129"]) {
            const root = makeCacheLane(base, spec);
            assert.equal(await findPackageRoot(path.join(root, "dist"), PKG), root);
            assert.equal(await findPackageRoot(root, PKG), root);
            const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")) as { name?: string };
            assert.equal(pkg.name, PKG);
        }
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test("findPackageRoot: symlinked lane hop resolves through the link", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-installdir-"));
    try {
        const realRoot = makeCacheLane(base, "real");
        const laneNm = path.join(base, "lane", "npm", `${PKG}@latest`, "1789577146915", "node_modules");
        mkdirSync(laneNm, { recursive: true });
        const link = path.join(laneNm, PKG);
        symlinkSync(realRoot, link, "junction");
        assert.equal(await findPackageRoot(path.join(link, "dist"), PKG), link);
        assert.equal(realpathSync(link), realpathSync(realRoot));
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test("findPackageRoot: corrupt running root refuses a foreign named ancestor instead of adopting an outer same-name copy", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-installdir-"));
    try {
        // Exact 12-day shape (#1603 defect 2): the running copy's own root is
        // missing/corrupt, it sits under a DIFFERENT named package, which sits
        // under a legitimate billion-context install (a global prefix or dev
        // checkout). The old walk kept climbing past the foreign boundary and
        // adopted the outer same-name copy — i.e. targeted /usr/lib/node_modules
        // while running from elsewhere. The walk must stop at the foreign
        // boundary and refuse (undefined) instead.
        const outerBc = path.join(base, PKG);
        writePkg(outerBc, { name: PKG, version: "9.9.9" });
        const foreign = path.join(outerBc, "sub");
        writePkg(foreign, { name: "some-outer-package", version: "9.9.9" });
        const corruptRoot = path.join(foreign, "node_modules", PKG);
        mkdirSync(path.join(corruptRoot, "dist"), { recursive: true });
        writeFileSync(path.join(corruptRoot, "dist", "index.js"), "");
        assert.equal(await findPackageRoot(path.join(corruptRoot, "dist"), PKG), undefined);
        // control: with the running copy's own package.json present, the same
        // tree resolves to the running copy and never reaches the foreign one
        writePkg(corruptRoot, { name: PKG, version: "0.1.129" });
        assert.equal(await findPackageRoot(path.join(corruptRoot, "dist"), PKG), corruptRoot);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test("findPackageRoot: nameless package.json is not a package boundary (walk continues past it)", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-installdir-"));
    try {
        // Contrast to the foreign-named refusal above: a package.json WITHOUT
        // a name field (opencode cache-lane wrappers are exactly this shape)
        // carries no package identity, so the walk must continue past it —
        // adoption of a genuine same-name ancestor above is unchanged from
        // pre-#1628 behavior and must not be tightened into a refusal.
        const outerBc = path.join(base, PKG);
        writePkg(outerBc, { name: PKG, version: "9.9.9" });
        const nameless = path.join(outerBc, "sub");
        writePkg(nameless, { dependencies: { [PKG]: "0.1.129" } });
        mkdirSync(path.join(nameless, "dist"), { recursive: true });
        assert.equal(await findPackageRoot(path.join(nameless, "dist"), PKG), outerBc);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test("findInstallDir: resolves this running copy's own root", async () => {
    const dir = await findInstallDir(PKG);
    assert.ok(dir, "expected the running module to resolve its own package root");
    const pkg = JSON.parse(readFileSync(path.join(dir!, "package.json"), "utf-8")) as { name?: string };
    assert.equal(pkg.name, PKG);
});

test("describeInstallLocation: names target, symlink real, and running module", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-installdir-"));
    try {
        const real = path.join(base, "global", "node_modules", PKG);
        writePkg(real, { name: PKG, version: "0.1.129" });
        mkdirSync(path.join(real, "dist"), { recursive: true });
        const entry = path.join(real, "dist", "index.js");
        writeFileSync(entry, "");

        const plain = describeInstallLocation(real, entry);
        assert.match(plain, new RegExp(`target=${real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        assert.match(plain, /running=/);
        assert.doesNotMatch(plain, /real=/);

        const link = path.join(base, "link");
        symlinkSync(real, link, "junction");
        const viaLink = describeInstallLocation(link, entry);
        assert.match(viaLink, /real=/);
        assert.match(viaLink, new RegExp(realpathSync(link).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

        const unresolved = describeInstallLocation(undefined, entry);
        assert.match(unresolved, /target=<unresolved>/);
        assert.match(unresolved, /running=/);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test("logInstallLocationOnce: one self-explaining line per process naming both paths", () => {
    _resetInstallLocationForTest();
    const lines: string[] = [];
    const log: Logger = (_level, msg) => lines.push(msg);
    logInstallLocationOnce("/usr/lib/node_modules/billion-context", PKG, log);
    logInstallLocationOnce("/usr/lib/node_modules/billion-context", PKG, log);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[update\] install location: target=\/usr\/lib\/node_modules\/billion-context running=/);
    assert.match(lines[0], /running=/);
    assert.match(lines[0], /not being updated here/);

    _resetInstallLocationForTest();
    logInstallLocationOnce(undefined, PKG, log);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /target=<unresolved>/);
    _resetInstallLocationForTest();
});
