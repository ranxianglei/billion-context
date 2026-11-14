import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

import { configFile, resolveConfigFileRef, checkNamedConfigRef } from "../src/paths.ts";
import { parseArgs } from "../src/cli.ts";
import { applyPosturePins } from "../src/launcher.ts";

// -c/--config accepts a bare NAME: <configDir>/NAME.json — per-model/per-purpose
// test configs (dsh-test.json, ework-qq.json, …) switch without env vars.
// Paths keep their exact historical semantics; a typo'd NAME fails fast with
// the available sibling names instead of silently starting on an empty config.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-cfg-name-"));
const configDir = path.join(root, "xdg-config", "billion-context");
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, "billion-context.json"), "{}");
fs.writeFileSync(path.join(configDir, "dsh-test.json"), "{}");
// auxiliary sidecar files must not be advertised as named configs
fs.writeFileSync(path.join(configDir, "billion-context.json.summary-credentials.json"), "{}");

const saved = {
    xdg: process.env.XDG_CONFIG_HOME,
    ref: process.env.BILI_CONFIG_FILE,
    inline: process.env.BILI_PI_INLINE,
};

test.before(() => {
    process.env.XDG_CONFIG_HOME = path.join(root, "xdg-config");
    delete process.env.BILI_CONFIG_FILE;
});

test.after(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
});

test("resolveConfigFileRef: path refs are untouched (separator or CWD file)", () => {
    assert.equal(resolveConfigFileRef("/abs/elsewhere.json"), "/abs/elsewhere.json");
    assert.equal(resolveConfigFileRef("rel/nested.json"), path.resolve("rel", "nested.json"));
    const cwdFile = path.join(process.cwd(), "cfg-name-cwd-probe.json");
    fs.writeFileSync(cwdFile, "{}");
    try {
        assert.equal(resolveConfigFileRef("cfg-name-cwd-probe.json"), cwdFile);
    } finally {
        fs.rmSync(cwdFile, { force: true });
    }
});

test("resolveConfigFileRef: bare NAME maps to <configDir>/NAME.json", () => {
    assert.equal(resolveConfigFileRef("billion-context"), path.join(configDir, "billion-context.json"));
    assert.equal(resolveConfigFileRef("dsh-test"), path.join(configDir, "dsh-test.json"));
});

test("configFile(): BILI_CONFIG_FILE bare name resolves through the same rule", () => {
    process.env.BILI_CONFIG_FILE = "dsh-test";
    assert.equal(configFile(), path.join(configDir, "dsh-test.json"));
    delete process.env.BILI_CONFIG_FILE;
    assert.equal(configFile(), path.join(configDir, "billion-context.json"));
});

test("checkNamedConfigRef: existing name passes (gate on)", () => {
    assert.equal(checkNamedConfigRef("dsh-test"), null);
    assert.equal(checkNamedConfigRef("billion-context"), null);
});

test("checkNamedConfigRef: missing name fails with the sibling list (gate off)", () => {
    const err = checkNamedConfigRef("no-such-model");
    assert.ok(err, "missing named config must produce an error");
    assert.match(err as string, /no-such-model/);
    assert.match(err as string, /dsh-test/);
    assert.match(err as string, /billion-context/);
    assert.ok(!(err as string).includes("summary-credentials"), "auxiliary *.json.*.json sidecars are not named configs");
});

test("checkNamedConfigRef: paths and empty refs keep historical behavior (null)", () => {
    assert.equal(checkNamedConfigRef(""), null);
    assert.equal(checkNamedConfigRef("   "), null);
    assert.equal(checkNamedConfigRef("/abs/does-not-exist.json"), null);
    assert.equal(checkNamedConfigRef("rel/missing.json"), null);
});

test("parseArgs: -c is the short form of --config (start + launch lanes)", () => {
    const start = parseArgs(["start", "-c", "dsh-test"]);
    assert.equal(start.command, "start");
    assert.equal(start.overrides.BILI_CONFIG_FILE, "dsh-test");

    const launch = parseArgs(["-c", "dsh-test", "pi"]);
    assert.equal(launch.client, "pi");
    assert.equal(launch.overrides.BILI_CONFIG_FILE, "dsh-test");

    const long = parseArgs(["--config=dsh-test"]);
    assert.equal(long.overrides.BILI_CONFIG_FILE, "dsh-test");

    // after the client name the flag belongs to the client, not bili
    const forwarded = parseArgs(["pi", "-c", "dsh-test"]);
    assert.equal(forwarded.client, "pi");
    assert.equal(forwarded.overrides.BILI_CONFIG_FILE, undefined);
    assert.deepEqual(forwarded.clientArgs, ["-c", "dsh-test"]);
});

test("applyPosturePins: -c override mirrors into the launcher env the child inherits", () => {
    delete process.env.BILI_CONFIG_FILE;
    applyPosturePins(parseArgs(["-c", "dsh-test", "pi"]).overrides);
    assert.equal(process.env.BILI_CONFIG_FILE, "dsh-test");
    applyPosturePins(parseArgs(["pi"]).overrides);
    assert.equal(process.env.BILI_CONFIG_FILE, "dsh-test", "absent override must not clear the env");
    delete process.env.BILI_CONFIG_FILE;
});
