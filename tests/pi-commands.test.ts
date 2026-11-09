import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePiCommands, piCommandsEnabled, PI_COMMAND_NAMES, DEFAULT_PI_COMMANDS } from "../src/agent/pi-subagents.ts";
import { loadConfigFile } from "../src/config.ts";

// pi.commands surface tests. resolvePiCommands is a pure function over its
// argument; piCommandsEnabled reads the config FILE, so BILI_CONFIG_FILE is
// redirected to a hermetic path (same pattern as pi-subagents-wiring.test.ts).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pi-commands-home-"));
process.env.HOME = HOME;
const BILI_CONFIG_FILE = path.join(HOME, "billion-context.json");
process.env.BILI_CONFIG_FILE = BILI_CONFIG_FILE;

function writeConfig(value: unknown): void {
    if (value === undefined) fs.rmSync(BILI_CONFIG_FILE, { force: true });
    else fs.writeFileSync(BILI_CONFIG_FILE, JSON.stringify({ pi: { commands: value } }));
}

test("resolvePiCommands: undefined → default surface (acp, acp-cache)", () => {
    assert.deepEqual(resolvePiCommands(undefined), DEFAULT_PI_COMMANDS);
    assert.deepEqual([...DEFAULT_PI_COMMANDS], ["acp", "acp-cache"]);
});

test("resolvePiCommands: false and [] register nothing", () => {
    assert.deepEqual(resolvePiCommands(false), []);
    assert.deepEqual(resolvePiCommands([]), []);
});

test("resolvePiCommands: true registers all four", () => {
    assert.deepEqual(resolvePiCommands(true), [...PI_COMMAND_NAMES]);
    assert.deepEqual([...PI_COMMAND_NAMES], ["acp", "acp-cache", "acp-rule", "acp-fleet"]);
});

test("resolvePiCommands: explicit list keeps known names, dedupes, drops unknown with one warning", () => {
    const errors: string[] = [];
    const saved = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
        assert.deepEqual(resolvePiCommands(["acp-rule", "acp-fleet", "nope", "acp-rule"]), ["acp-rule", "acp-fleet"]);
    } finally {
        console.error = saved;
    }
    assert.equal(errors.length, 1, "one warning for the unknown entry");
    assert.match(errors[0]!, /nope/);
    assert.match(errors[0]!, /acp-fleet/);
    // Second call with another unknown stays silent (one-shot flag).
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
        assert.deepEqual(resolvePiCommands(["also-bogus"]), []);
    } finally {
        console.error = saved;
    }
    assert.equal(errors.length, 1);
});

test("resolvePiCommands: wrong type warns once and falls back to the default", () => {
    const errors: string[] = [];
    const saved = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
        assert.deepEqual(resolvePiCommands("yes"), [...DEFAULT_PI_COMMANDS]);
        assert.deepEqual(resolvePiCommands(42), [...DEFAULT_PI_COMMANDS]);
        assert.deepEqual(resolvePiCommands({ acp: true }), [...DEFAULT_PI_COMMANDS]);
    } finally {
        console.error = saved;
    }
    assert.equal(errors.length, 1, "one wrong-type warning despite three bad values");
    assert.match(errors[0]!, /must be an array/);
});

test("piCommandsEnabled: reads the config file per call (edits apply without restart)", () => {
    writeConfig(["acp"]);
    assert.deepEqual([...piCommandsEnabled()], ["acp"]);
    writeConfig(true);
    assert.deepEqual([...piCommandsEnabled()].sort(), ["acp", "acp-cache", "acp-fleet", "acp-rule"]);
    writeConfig([]);
    assert.equal(piCommandsEnabled().size, 0);
    writeConfig(undefined);
    assert.deepEqual([...piCommandsEnabled()], ["acp", "acp-cache"]);
    // Sanity: the hermetic file is what loadConfigFile sees.
    assert.equal(loadConfigFile().pi?.commands, undefined);
});
