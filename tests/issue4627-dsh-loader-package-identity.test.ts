// #4627: dsh >= 0.2.0-rc.x (@deepseek-ai/dsh-client-modules) resolves every
// active Loader row to its NEAREST package.json and refuses to boot when one
// dsh.client-declaring package has more than one active source
// (ClientModuleRegistry.reconcilePackage: "package billion-context resolves
// from multiple active Loader sources ... remove one entry"). Before this fix
// every carrier mounted bili-native and bili-compaction-gate on the SAME
// billion-context package, so `bili dsh web` (and any profile-bundle install)
// died with "1 required plugin did not activate". These tests replay dsh's
// nearest-package.json walk per row — no real dsh binary needed, because the
// walk IS the guard's input: each carrier must keep the two rows on DISTINCT
// package identities with exactly ONE declaring dsh.client.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeDshAcpPatch, writeDshClientShimFiles, writeDshGateShimFiles } from "../src/launcher.ts";
import { selfPackageRoot } from "../src/plugin-install.js";
import { supportsFileSymlink } from "./platform-capabilities.ts";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

type PkgIdentity = { name?: string; dshClient?: unknown };

function nearestPackageJson(file: string): PkgIdentity {
    let dir = path.dirname(file);
    for (;;) {
        const cand = path.join(dir, "package.json");
        if (fs.existsSync(cand)) {
            const pkg = JSON.parse(fs.readFileSync(cand, "utf8")) as { name?: string; dsh?: { client?: unknown } };
            return { name: pkg.name, dshClient: pkg.dsh?.client };
        }
        const up = path.dirname(dir);
        if (up === dir) throw new Error(`no package.json found walking up from ${dir}`);
        dir = up;
    }
}

function assertOneClientPackage(nativeRowFile: string, gateRowFile: string): void {
    const native = nearestPackageJson(nativeRowFile);
    const gate = nearestPackageJson(gateRowFile);
    assert.notEqual(native.name, gate.name, `both Loader rows resolved to package "${native.name}" (#4627)`);
    assert.equal(gate.name, "billion-context-dsh-gate", `gate row must resolve into its own package identity, got "${gate.name}"`);
    assert.equal(gate.dshClient, undefined, "gate package must declare no dsh.client (#4627)");
    const declaring = [native, gate].filter((p) => p.dshClient !== undefined);
    assert.equal(declaring.length, 1, `exactly one row may declare dsh.client, got ${JSON.stringify({ native, gate })}`);
    assert.equal(declaring[0].name, "billion-context");
}

function hasBuiltGate(): boolean {
    const root = selfPackageRoot();
    return fs.existsSync(path.join(root, "dist", "agent", "dsh-gate", "index.js")) && fs.existsSync(path.join(root, "dist", "agent", "dsh-gate", "package.json"));
}

test("#4627 built artifact: the gate ships under its own package identity without dsh.client", (t) => {
    if (!hasBuiltGate()) {
        t.skip("needs a built dist (npm run build first)");
        return;
    }
    const root = selfPackageRoot();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "dist", "agent", "dsh-gate", "package.json"), "utf8")) as Record<string, unknown>;
    assert.equal(manifest.name, "billion-context-dsh-gate");
    const repoPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string; exports?: Record<string, string> };
    assert.equal(manifest.version, repoPkg.version);
    assert.ok(!("dsh" in manifest), "gate manifest must declare no dsh.client");
    // both public subpaths land on the gate-only identity, never the package root
    assert.equal(repoPkg.exports?.["./dsh-gate"], "./dist/agent/dsh-gate/index.js");
    assert.equal(repoPkg.exports?.["./dsh-compaction-gate"], "./dist/agent/dsh-gate/index.js");
    assertOneClientPackage(path.join(root, "dist", "agent", "dsh-native.js"), path.join(root, "dist", "agent", "dsh-gate", "index.js"));
});

test("#4627 launcher overlay (file lane): the two Loader rows resolve to distinct packages", (t) => {
    if (!hasBuiltGate()) {
        t.skip("needs a built dist (npm run build first)");
        return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4627-filelane-"));
    try {
        const file = writeDshAcpPatch(home);
        assert.ok(file, "overlay patch must be written");
        const txt = fs.readFileSync(file!, "utf8").replaceAll("\r\n", "\n");
        const nativeM = /^ {4}- id: bili-native\n {6}name: (file:\/\/\S+)$/m.exec(txt);
        const gateM = /^ {4}- id: bili-compaction-gate\n {6}name: (file:\/\/\S+)$/m.exec(txt);
        assert.ok(nativeM && gateM, "overlay must carry both Loader rows");
        assertOneClientPackage(fileURLToPath(nativeM![1]), fileURLToPath(gateM![1]));
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(`${home}-bili`, { recursive: true, force: true });
    }
});

test("#4627 launcher overlay (bare lane): the shims keep the two rows on distinct packages", (t) => {
    if (!supportsFileSymlink()) {
        t.skip("symlinks unsupported on this platform");
        return;
    }
    // tmpdir sits INSIDE the checkout: a neutral fixture-root package.json keeps
    // Node's CJS self-name resolution from hijacking "billion-context" to the
    // repo root (same trick as the shim test in tests/launcher.test.ts).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4627-barelane-"));
    try {
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "bili-4627-fixture", version: "0.0.0" }));
        // Fake npm prefix mirroring the PUBLISHED layout: the gate bundle sits
        // in its own nested package dir carrying the manifest that
        // scripts/write-build-info.mjs writes into every tarball.
        const prefixPkg = path.join(dir, "npm-prefix", "node_modules", "billion-context");
        const distAgent = path.join(prefixPkg, "dist", "agent");
        const gateDist = path.join(distAgent, "dsh-gate");
        fs.mkdirSync(gateDist, { recursive: true });
        fs.writeFileSync(path.join(prefixPkg, "package.json"), JSON.stringify({
            name: "billion-context",
            version: "0.0.0",
            type: "module",
            exports: { ".": "./dist/agent/dsh-native.js", "./package.json": "./package.json" },
            dsh: { client: { platform: "web" } },
        }));
        const hostBundle = path.join(distAgent, "dsh-native.js");
        const clientBundle = path.join(distAgent, "dsh-native-client.js");
        const gateBundle = path.join(gateDist, "index.js");
        fs.writeFileSync(hostBundle, "// host stub\n");
        fs.writeFileSync(clientBundle, "// client stub\n");
        fs.writeFileSync(gateBundle, "// gate stub\n");
        fs.writeFileSync(path.join(gateDist, "package.json"), JSON.stringify({
            name: "billion-context-dsh-gate",
            version: "0.0.0",
            type: "module",
            main: "./index.js",
            exports: { ".": "./index.js", "./package.json": "./package.json" },
        }));
        const home = path.join(dir, ".dsh");
        fs.mkdirSync(home);
        assert.equal(writeDshClientShimFiles(path.join(home, "node_modules", "billion-context"), hostBundle, clientBundle, "0.0.0"), true);
        assert.equal(writeDshGateShimFiles(path.join(home, "node_modules", "billion-context-dsh-gate"), gateBundle, "0.0.0"), true);

        const file = writeDshAcpPatch(home, "billion-context");
        assert.ok(file, "overlay patch must be written");
        const txt = fs.readFileSync(file!, "utf8").replaceAll("\r\n", "\n");
        assert.match(txt, /^ {4}- id: bili-compaction-gate\n {6}name: billion-context-dsh-gate$/m);
        // World 1 — literal shim paths (a scanner that walks up without
        // resolving symlinks): each row lands on its own shim package.json.
        const nm = path.join(home, "node_modules");
        assertOneClientPackage(path.join(nm, "billion-context", "index.js"), path.join(nm, "billion-context-dsh-gate", "index.js"));
        // World 2 — Node's CJS resolve REALPATHS the final symlinked file, so
        // the walk starts from the npm-prefix tree instead. The nested gate
        // manifest is what keeps the two rows apart there too.
        const req = createRequire(path.join(home, "probe.cjs"));
        assertOneClientPackage(req.resolve("billion-context"), req.resolve("billion-context-dsh-gate"));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(`${path.join(dir, ".dsh")}-bili`, { recursive: true, force: true });
    }
});

test("#4627 bundle layer: billion-context/dsh-gate resolves into the gate-only package", () => {
    // Same neutral-root guard as above: probe.cjs's nearest package.json must
    // not be the checkout's billion-context or CJS self-reference wins.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4627-bundle-"));
    try {
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "bili-4627-fixture", version: "0.0.0" }));
        const profileNm = path.join(dir, "node_modules", "billion-context");
        const gateDir = path.join(profileNm, "dist", "agent", "dsh-gate");
        fs.mkdirSync(gateDir, { recursive: true });
        fs.writeFileSync(path.join(profileNm, "package.json"), JSON.stringify({
            name: "billion-context",
            version: "0.0.0",
            type: "module",
            exports: { ".": "./dist/agent/dsh-native.js", "./dsh-gate": "./dist/agent/dsh-gate/index.js", "./package.json": "./package.json" },
            dsh: { client: { platform: "web" } },
        }));
        fs.writeFileSync(path.join(profileNm, "dist", "agent", "dsh-native.js"), "// host stub\n");
        fs.writeFileSync(path.join(gateDir, "index.js"), "// gate stub\n");
        fs.writeFileSync(path.join(gateDir, "package.json"), JSON.stringify({
            name: "billion-context-dsh-gate",
            version: "0.0.0",
            type: "module",
            main: "./index.js",
            exports: { ".": "./index.js", "./package.json": "./package.json" },
        }));

        // carrier agreement with the shipped bundle yml: the gate row targets the
        // gate-only subpath, never back at the package root
        const bundleYml = fs.readFileSync(path.join(TESTS_DIR, "..", "dsh.bundle.patch.yml"), "utf8").replaceAll("\r\n", "\n");
        assert.ok(bundleYml.includes("- id: bili-compaction-gate\n      name: billion-context/dsh-gate\n"), "bundle yml must target the gate-only subpath");

        const req = createRequire(path.join(dir, "probe.cjs"));
        assertOneClientPackage(req.resolve("billion-context"), req.resolve("billion-context/dsh-gate"));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
