/**
 * #4449 — release gate for plugin manifest versions.
 *
 * scripts/sync-codex-plugin-version.mjs copies package.json's version into the
 * four plugin manifests (Codex marketplace, Codex plugin, Claude marketplace,
 * Claude plugin); all three publish workflows run `--check` before tag/publish,
 * so this script IS the release gate. These tests pin both directions (gate
 * discipline, #3617): drift must fail --check, and write mode must converge
 * without clobbering the rest of each manifest.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_SRC = path.join(REPO, "scripts", "sync-codex-plugin-version.mjs");

const NEW_VERSION = "0.99.42";
const OLD_VERSION = "0.99.41";

const fixtures: string[] = [];

interface Fixture {
  root: string;
  script: string;
}

function makeFixture(pkgVersion: string, manifestVersion: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-syncgate-"));
  fixtures.push(root);
  const write = (rel: string, data: unknown) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`);
  };

  write("package.json", { name: "billion-context", version: pkgVersion });
  write(".agents/plugins/marketplace.json", {
    name: "billion-context",
    interface: { displayName: "billion-context" },
    plugins: [
      {
        name: "billion-context",
        source: "./plugins/codex",
        version: manifestVersion,
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      },
      {
        name: "some-other-plugin",
        source: "./other",
        version: "9.9.9",
      },
    ],
  });
  write(".claude-plugin/marketplace.json", {
    name: "billion-context",
    plugins: [{ name: "billion-context", source: "./" , version: manifestVersion }],
  });
  write(".claude-plugin/plugin.json", {
    name: "billion-context",
    version: manifestVersion,
    description: "context compression proxy",
  });
  write("plugins/codex/.codex-plugin/plugin.json", {
    name: "billion-context",
    version: manifestVersion,
    description: "codex lane",
  });

  const scriptDir = path.join(root, "scripts");
  fs.mkdirSync(scriptDir, { recursive: true });
  const script = path.join(scriptDir, "sync-codex-plugin-version.mjs");
  fs.copyFileSync(SCRIPT_SRC, script);
  return { root, script };
}

after(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function run(script: string, ...args: string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out, err: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

test("--check fails (exit 1) when every manifest is behind package.json", () => {
  const fx = makeFixture(NEW_VERSION, OLD_VERSION);
  const r = run(fx.script, "--check");
  assert.equal(r.code, 1, `expected drift failure, got ${r.code}\n${r.out}${r.err}`);
  assert.match(r.out, /漂移/, "drifted files must be listed");
  for (const rel of [
    ".agents/plugins/marketplace.json",
    "plugins/codex/.codex-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".claude-plugin/plugin.json",
  ]) {
    assert.ok(r.out.includes(rel), `drift report must name ${rel}`);
  }
});

test("--check passes (exit 0) when everything already matches", () => {
  const fx = makeFixture(NEW_VERSION, NEW_VERSION);
  const r = run(fx.script, "--check");
  assert.equal(r.code, 0, r.out + r.err);
});

test("write mode converges all four manifests, keeps other fields, and is idempotent", () => {
  const fx = makeFixture(NEW_VERSION, OLD_VERSION);
  const r = run(fx.script);
  assert.equal(r.code, 0, r.out + r.err);

  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(fx.root, rel), "utf8"));

  const agents = read(".agents/plugins/marketplace.json");
  const bc = agents.plugins.find((p: { name: string }) => p.name === "billion-context");
  assert.equal(bc.version, NEW_VERSION);
  assert.equal(bc.source, "./plugins/codex", "untouched fields must survive");
  assert.deepEqual(bc.policy, { installation: "AVAILABLE", authentication: "ON_INSTALL" });
  const other = agents.plugins.find((p: { name: string }) => p.name === "some-other-plugin");
  assert.equal(other.version, "9.9.9", "foreign plugin entries must not be rewritten");
  assert.equal(agents.name, "billion-context");

  assert.equal(read(".claude-plugin/marketplace.json").plugins[0].version, NEW_VERSION);
  const claudePlugin = read(".claude-plugin/plugin.json");
  assert.equal(claudePlugin.version, NEW_VERSION);
  assert.equal(claudePlugin.description, "context compression proxy");
  assert.equal(read("plugins/codex/.codex-plugin/plugin.json").version, NEW_VERSION);

  const before = fs.readFileSync(path.join(fx.root, ".agents/plugins/marketplace.json"), "utf8");
  const again = run(fx.script);
  assert.equal(again.code, 0, again.out + again.err);
  assert.equal(fs.readFileSync(path.join(fx.root, ".agents/plugins/marketplace.json"), "utf8"), before, "second run must be a no-op");
  assert.match(again.out, /完成/);

  const recheck = run(fx.script, "--check");
  assert.equal(recheck.code, 0, "post-sync --check must pass");
});

test("marketplace without a billion-context plugin entry is skipped, not drifted", () => {
  const fx = makeFixture(NEW_VERSION, NEW_VERSION);
  const rel = ".claude-plugin/marketplace.json";
  const data = JSON.parse(fs.readFileSync(path.join(fx.root, rel), "utf8"));
  data.plugins = [];
  fs.writeFileSync(path.join(fx.root, rel), `${JSON.stringify(data, null, 2)}\n`);
  const r = run(fx.script, "--check");
  assert.equal(r.code, 0, `missing entry must not fail the gate: ${r.out}${r.err}`);
});

test("a MISSING manifest file fails the gate instead of silently passing (#4725 review)", () => {
  const fx = makeFixture(NEW_VERSION, NEW_VERSION);
  fs.rmSync(path.join(fx.root, ".claude-plugin/plugin.json"));
  const r = run(fx.script, "--check");
  assert.notEqual(r.code, 0, "a missing manifest must be red, not a silent skip that greens the gate");
  assert.match(r.err, /缺少 manifest/, `must name the missing file: ${r.out}${r.err}`);
});
