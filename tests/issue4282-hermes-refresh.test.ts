// #4282: global auto-update never refreshed the hermes plugin's Python shell
// (__init__.py + plugin.yaml) — its only writers were `bili plugin install|update
//  hermes`, so the shell stayed frozen at install time while dist/ moved on.
// refreshHermesPluginCopy converges it by byte compare; these tests pin both
// directions: rewrites when drifted, stays silent when in step, and never
// creates a plugin dir or touches bili.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// #2206: src/update.ts freezes its cache-dir paths at import time — override
// BEFORE loading it (same discipline as update-desktop-inplace.test.ts).
const __cacheRoot = mkdtempSync(path.join(tmpdir(), "bc-issue4282-cache-"));
process.env.XDG_CACHE_HOME = path.join(__cacheRoot, "cache");
const { refreshHermesPluginCopy } = await import("../src/update.ts");
import type { Logger } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

const SRC_INIT_V1 = "# shell v1\nprint('old')\n";
const SRC_INIT_V2 = "# shell v2\nprint('new')\n";
const SRC_YAML = 'name: billion-context\nversion: "0.0.0"\ndescription: test\n';

function makeInstallDir(root: string, version: string, initBody?: string, withSources = true): string {
    const dir = path.join(root, "install");
    mkdirSync(dir, { recursive: true });
    if (withSources) mkdirSync(path.join(dir, "hermes-plugin"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "billion-context", version }));
    if (withSources) {
        writeFileSync(path.join(dir, "hermes-plugin", "__init__.py"), initBody ?? SRC_INIT_V2);
        writeFileSync(path.join(dir, "hermes-plugin", "plugin.yaml"), SRC_YAML);
    }
    return dir;
}

function makeInstalledPlugin(hermesHome: string, files: Record<string, string>): string {
    const dir = path.join(hermesHome, "plugins", "billion-context");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
    return dir;
}

function collectLog(): [Logger, Array<[string, string]>] {
    const entries: Array<[string, string]> = [];
    const log: Logger = (level, msg) => { entries.push([level, msg]); };
    return [log, entries];
}

test("not installed: no writes, no dir created, silent (#4282)", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-issue4282-a-"));
    t.after(() => rmrf(root));
    const hermesHome = path.join(root, "hermes-home"); // empty home — never created
    const installDir = makeInstallDir(root, "2.0.0");
    const [log, entries] = collectLog();

    await refreshHermesPluginCopy(installDir, { HERMES_HOME: hermesHome }, log);
    await refreshHermesPluginCopy(undefined, { HERMES_HOME: hermesHome }, log);

    assert.equal(existsSync(path.join(hermesHome, "plugins")), false);
    assert.deepEqual(entries, []);
});

test("stale copy: both files rewritten byte-exact, bili.json untouched, restart logged (#4282)", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-issue4282-b-"));
    t.after(() => rmrf(root));
    const hermesHome = path.join(root, "hermes-home");
    const bilijson = JSON.stringify({ proxyScript: "/opt/node/dist/index.js", nodePath: "/opt/node/bin/node" });
    const pluginDir = makeInstalledPlugin(hermesHome, {
        "__init__.py": SRC_INIT_V1,
        "plugin.yaml": 'name: billion-context\nversion: "1.0.0"\ndescription: test\n',
        "bili.json": bilijson,
    });
    const installDir = makeInstallDir(root, "2.0.0");
    const [log, entries] = collectLog();

    await refreshHermesPluginCopy(installDir, { HERMES_HOME: hermesHome }, log);

    assert.equal(readFileSync(path.join(pluginDir, "__init__.py"), "utf-8"), SRC_INIT_V2);
    assert.equal(readFileSync(path.join(pluginDir, "plugin.yaml"), "utf-8"), 'name: billion-context\nversion: "2.0.0"\ndescription: test\n');
    assert.equal(readFileSync(path.join(pluginDir, "bili.json"), "utf-8"), bilijson);
    assert.equal(entries.length, 1);
    assert.equal(entries[0][0], "info");
    assert.match(entries[0][1], /hermes plugin refreshed to 2\.0\.0 — restart hermes to load it/);
});

test("in step: silent, mtimes untouched (#4282)", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-issue4282-c-"));
    t.after(() => rmrf(root));
    const hermesHome = path.join(root, "hermes-home");
    const expectedYaml = SRC_YAML.replace(/^version:.*/m, 'version: "2.0.0"');
    const pluginDir = makeInstalledPlugin(hermesHome, {
        "__init__.py": SRC_INIT_V2,
        "plugin.yaml": expectedYaml,
    });
    const installDir = makeInstallDir(root, "2.0.0");
    const beforeInit = statSync(path.join(pluginDir, "__init__.py")).mtimeMs;
    const beforeYaml = statSync(path.join(pluginDir, "plugin.yaml")).mtimeMs;
    const [log, entries] = collectLog();

    await refreshHermesPluginCopy(installDir, { HERMES_HOME: hermesHome }, log);

    assert.equal(statSync(path.join(pluginDir, "__init__.py")).mtimeMs, beforeInit);
    assert.equal(statSync(path.join(pluginDir, "plugin.yaml")).mtimeMs, beforeYaml);
    assert.deepEqual(entries, []);
});

test("branch-build drift at the same version still converges (byte compare, not version) (#4282)", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-issue4282-d-"));
    t.after(() => rmrf(root));
    const hermesHome = path.join(root, "hermes-home");
    const expectedYaml = SRC_YAML.replace(/^version:.*/m, 'version: "2.0.0"');
    const pluginDir = makeInstalledPlugin(hermesHome, {
        "__init__.py": "# branch build of 2.0.0\nprint('drifted')\n",
        "plugin.yaml": expectedYaml, // version line already matches
    });
    const installDir = makeInstallDir(root, "2.0.0", "# branch build of 2.0.0\nprint('canonical')\n");
    const [log, entries] = collectLog();

    await refreshHermesPluginCopy(installDir, { HERMES_HOME: hermesHome }, log);

    assert.equal(readFileSync(path.join(pluginDir, "__init__.py"), "utf-8"), "# branch build of 2.0.0\nprint('canonical')\n");
    assert.equal(entries.length, 1);
    assert.match(entries[0][1], /refreshed to 2\.0\.0/);
});

test("missing sources in install dir: warns with manual fix, installed files unchanged (#4282)", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-issue4282-e-"));
    t.after(() => rmrf(root));
    const hermesHome = path.join(root, "hermes-home");
    const pluginDir = makeInstalledPlugin(hermesHome, {
        "__init__.py": SRC_INIT_V1,
        "plugin.yaml": 'name: billion-context\nversion: "1.0.0"\ndescription: test\n',
    });
    const installDir = makeInstallDir(root, "2.0.0", undefined, false); // no hermes-plugin/ sources
    const [log, entries] = collectLog();

    await refreshHermesPluginCopy(installDir, { HERMES_HOME: hermesHome }, log);

    assert.equal(readFileSync(path.join(pluginDir, "__init__.py"), "utf-8"), SRC_INIT_V1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0][0], "warn");
    assert.match(entries[0][1], /hermes plugin refresh failed/);
    assert.match(entries[0][1], /bili plugin update hermes/);
});

test("installed dir missing plugin.yaml: recreated from source with current version (#4282)", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-issue4282-f-"));
    t.after(() => rmrf(root));
    const hermesHome = path.join(root, "hermes-home");
    const pluginDir = makeInstalledPlugin(hermesHome, { "__init__.py": SRC_INIT_V2 });
    const installDir = makeInstallDir(root, "3.1.4");
    const [log, entries] = collectLog();

    await refreshHermesPluginCopy(installDir, { HERMES_HOME: hermesHome }, log);

    assert.equal(readFileSync(path.join(pluginDir, "plugin.yaml"), "utf-8"), 'name: billion-context\nversion: "3.1.4"\ndescription: test\n');
    assert.equal(entries.length, 1);
    assert.match(entries[0][1], /refreshed to 3\.1\.4/);
});
