import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Owner report 2026-11-09: dsh's iot-thinking plugin issues one extra
// compress/rewrite call after every reply; both calls share one session lane,
// so the step waits seconds after its first byte. The registry exposes that as
// a warn notice, gated on "installed AND still enabled" (disabling the plugin
// removes the wait, so the notice must go away with it).
// Hermetic: fresh DSH_HOME (no profiles), state and config isolated.

const home = fs.mkdtempSync(path.join(os.tmpdir(), "iot-incompat-home-"));
process.env.DSH_HOME = home;
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "iot-incompat-state-"));
process.env.BILI_CONFIG_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "iot-incompat-cfg-")), "absent.json");

const { NOTICES, probeDshIotThinking, dshIotThinkingActive } = await import("../src/notices.ts");
const { IOT_INCOMPAT_NOTICE_ID, dismissUpgradeNotice } = await import("../src/pck-notice.ts");

const entry = () => {
    const found = NOTICES.find((n) => n.id === IOT_INCOMPAT_NOTICE_ID);
    assert.ok(found, "registry carries the iot-incompat entry");
    return found;
};
const writeConfig = (doc: unknown): void => {
    const dir = path.join(home, "plugin-data", "iot-thinking");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(doc));
};

test("no dsh profiles ⇒ not detected, notice inactive", () => {
    assert.equal(probeDshIotThinking(process.env), false);
    assert.equal(dshIotThinkingActive(process.env), false);
    assert.equal(entry().active(), false);
});

test("installed with no config yet ⇒ active (plugin default is enabled)", () => {
    const pkg = path.join(home, "profiles", "web", "node_modules", "dsh-plugin-iot-thinking");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "dsh-plugin-iot-thinking", version: "0.2.0" }));
    assert.equal(probeDshIotThinking(process.env), true);
    assert.equal(dshIotThinkingActive(process.env), true);
    assert.equal(entry().active(), true);
});

test("explicit enabled:false ⇒ installed but silent", () => {
    writeConfig({ enabled: false });
    assert.equal(probeDshIotThinking(process.env), true);
    assert.equal(dshIotThinkingActive(process.env), false);
    assert.equal(entry().active(), false);
});

test("turning it back on ⇒ notice returns", () => {
    writeConfig({ enabled: true });
    assert.equal(dshIotThinkingActive(process.env), true);
    assert.equal(entry().active(), true);
});

test("dismissal hides the notice for later polls", () => {
    assert.equal(dismissUpgradeNotice(IOT_INCOMPAT_NOTICE_ID, process.env), true);
    assert.equal(entry().active(), false);
});

test("a different dsh home without profiles probes clean", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "iot-incompat-home2-"));
    assert.equal(probeDshIotThinking({ ...process.env, DSH_HOME: other }), false);
});
