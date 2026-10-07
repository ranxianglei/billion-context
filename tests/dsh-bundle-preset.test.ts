import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// #1772: bili ships a byte-copy of dsh's `standard` preset with
// compaction-basic auto-compaction off, and the bundle layer's
// `agent-presets` config override (a) adds the in-package preset root and
// (b) makes it the default. These guards keep the shipped pieces from
// silently drifting apart.

const patchPath = path.join(ROOT, "dsh.bundle.patch.yml");
const presetDir = path.join(ROOT, "dsh-presets", "standard-bili-auto-off");

test("dsh bundle patch registers the bili preset root as default", () => {
    const yaml = fs.readFileSync(patchPath, "utf8");
    const row = yaml.split(/^-\s+id:\s*agent-presets\s*$/m);
    assert.equal(row.length, 2, "exactly one `agent-presets` row");
    const block = row[1]!.split(/^-\s+id:\s*\S+\s*$/m)[0]!;
    assert.match(block, /default:\s*standard-bili-auto-off\b/);
    // Root path must be resolved from the loader ctx `baseUrl` (profile dir),
    // not a baked-in absolute path, and must cover the win32 leading-slash fix.
    assert.match(block, /!!js/);
    assert.match(block, /node_modules\/billion-context\/dsh-presets\//);
    assert.match(block, /win32/);
    assert.match(block, /trust:\s*system/);
});

test("shipped preset disables compaction-basic auto, keeps manual /compact and pruner", () => {
    const preset = fs.readFileSync(path.join(presetDir, "preset.yml"), "utf8");
    assert.match(preset, /^name:\s*标准模式\(bili 托管压缩\)\s*$/m);

    const cordis = fs.readFileSync(path.join(presetDir, "agent.cordis.yml"), "utf8");
    const compactionBasic = cordis.split(/^ {4}- id:\s*compaction-basic\s*$/m);
    assert.equal(compactionBasic.length, 2, "compaction-basic row present");
    const block = compactionBasic[1]!.split(/^ {4}- id:\s*\S+\s*$/m)[0]!;
    assert.match(block, /auto:\s*false/, "auto compaction off");
    assert.match(cordis, /^ {4}- id:\s*command-compact\b/m, "manual /compact stays");
    assert.match(cordis, /^ {4}- id:\s*tool-result-pruner\b/m, "tool-result pruner stays");
});

test("npm package ships dsh-presets and the e2e profile mirrors published files", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.ok((pkg.files as string[]).includes("dsh-presets"));

    const e2e = fs.readFileSync(path.join(ROOT, "tests", "e2e", "e2e-native-dsh.test.ts"), "utf8");
    assert.match(e2e, /"dsh-presets"/, "wireProfile copies dsh-presets like a registry install");
});
