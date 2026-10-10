import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { rmrf } from "./tmp-rm.ts";

// #2507: autoRestartOnUpdate defaults ON for host-spawned resident proxies
// (BILI_LAUNCHER_LANE stamped by every native/lane bootstrap) and OFF for
// manual `bili start` (#811) — without self-activation an auto-update on a
// resident lane installs files that never take effect.
const root = mkdtempSync(path.join(tmpdir(), "bc-issue2507-"));
process.env.XDG_CONFIG_HOME = path.join(root, "config");

const { resolveAutoRestartOnUpdate, loadOptions } = await import("../src/config.ts");

after(() => {
    delete process.env.XDG_CONFIG_HOME;
    rmrf(root);
});

test("resolveAutoRestartOnUpdate: lane-aware default matrix (#2507)", () => {
    // lane-aware default
    assert.equal(resolveAutoRestartOnUpdate({ BILI_LAUNCHER_LANE: "dsh" }, undefined), true);
    assert.equal(resolveAutoRestartOnUpdate({ BILI_LAUNCHER_LANE: "opencode" }, undefined), true);
    assert.equal(resolveAutoRestartOnUpdate({}, undefined), false);
    assert.equal(resolveAutoRestartOnUpdate({ BILI_LAUNCHER_LANE: "" }, undefined), false);
    assert.equal(resolveAutoRestartOnUpdate({ BILI_LAUNCHER_LANE: "   " }, undefined), false);
    // explicit env wins in both directions (any non-"0" value enables — #811 parity)
    assert.equal(resolveAutoRestartOnUpdate({ BILI_LAUNCHER_LANE: "dsh", ACP_AUTO_RESTART_ON_UPDATE: "0" }, undefined), false);
    assert.equal(resolveAutoRestartOnUpdate({ ACP_AUTO_RESTART_ON_UPDATE: "1" }, undefined), true);
    assert.equal(resolveAutoRestartOnUpdate({ BILI_LAUNCHER_LANE: "dsh", ACP_AUTO_RESTART_ON_UPDATE: "yes" }, undefined), true);
    // explicit file values beat the lane default
    assert.equal(resolveAutoRestartOnUpdate({ BILI_LAUNCHER_LANE: "dsh" }, false), false);
    assert.equal(resolveAutoRestartOnUpdate({}, true), true);
});

test("loadOptions: lane env flips the default end-to-end (#2507)", () => {
    assert.equal(loadOptions({ BILI_LAUNCHER_LANE: "pi" }).autoRestartOnUpdate, true);
    assert.equal(loadOptions({}).autoRestartOnUpdate, false);
    assert.equal(loadOptions({ BILI_LAUNCHER_LANE: "pi", ACP_AUTO_RESTART_ON_UPDATE: "0" }).autoRestartOnUpdate, false);
});

test("loadOptions: explicit config-file values stay authoritative on a lane (#2507)", () => {
    const cfgDir = path.join(process.env.XDG_CONFIG_HOME!, "billion-context");
    mkdirSync(cfgDir, { recursive: true });
    const cfgFile = path.join(cfgDir, "billion-context.json");
    writeFileSync(cfgFile, JSON.stringify({ autoRestartOnUpdate: false }));
    assert.equal(loadOptions({ BILI_LAUNCHER_LANE: "pi" }).autoRestartOnUpdate, false);
    writeFileSync(cfgFile, JSON.stringify({ autoRestartOnUpdate: true }));
    assert.equal(loadOptions({}).autoRestartOnUpdate, true);
    // non-boolean garbage in the file falls through to the lane-aware default
    writeFileSync(cfgFile, JSON.stringify({ autoRestartOnUpdate: "yes" }));
    assert.equal(loadOptions({ BILI_LAUNCHER_LANE: "pi" }).autoRestartOnUpdate, true);
    assert.equal(loadOptions({}).autoRestartOnUpdate, false);
});
