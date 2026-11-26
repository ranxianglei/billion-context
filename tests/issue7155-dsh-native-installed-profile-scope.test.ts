// #7155: `bili dsh --profile X` used the MACHINE-wide install answer
// (`dshNativeInstalled()` = "any profile has the bundle") to decide whether to
// mount its own --patch overlay. On a machine where a sibling profile has the
// bundle but X does not (a scratch profile created after `bili plugin install
// dsh`, a profile whose dep was removed by hand), the overlay was skipped and
// the launch note described the OTHER profile — so the session ran with zero
// bili entries: no ACP compression tools, no takeover, and native compaction
// armed (which the wire guard then refuses turn after turn).
// Fix: ask about the profile being booted, parsing `--profile` the way dsh
// itself does, and say plainly when the profile lacks the bundle.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dshNativeInstalled } from "../src/plugin-install.ts";
import { dshProfileFromArgs } from "../src/dsh-channel.ts";

function withHome<T>(home: string, fn: () => T): T {
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prev;
    }
}

function profile(dir: string, bundles?: string[]): void {
    fs.mkdirSync(dir, { recursive: true });
    if (bundles !== undefined) {
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dsh: { profile: { bundles } } }));
    }
}

test("#7155 dshNativeInstalled(profile) answers for THAT profile; omitting it stays machine-wide", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-7155-"));
    try {
        withHome(home, () => {
            profile(path.join(home, "profiles", "installed"), ["@deepseek-ai/dsh-base", "billion-context"]);
            profile(path.join(home, "profiles", "scratch"), ["@deepseek-ai/dsh-base"]);
            profile(path.join(home, "profiles", "empty"));

            assert.equal(dshNativeInstalled(), true, "machine-wide answer unchanged (backward compatible)");
            assert.equal(dshNativeInstalled(process.env, "installed"), true);
            assert.equal(dshNativeInstalled(process.env, "scratch"), false, "the booted profile has no bundle");
            assert.equal(dshNativeInstalled(process.env, "empty"), false);
            assert.equal(dshNativeInstalled(process.env, "never-created"), false, "an unknown profile cannot be installed");
            assert.equal(dshNativeInstalled(process.env, ""), true, "empty profile id falls back to the machine-wide answer");
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("#7155 dshNativeInstalled(profile) honours a legacy managed block and a missing profiles root", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-7155-legacy-"));
    try {
        withHome(home, () => {
            assert.equal(dshNativeInstalled(process.env, "anything"), false, "no profiles root at all");
            const legacy = path.join(home, "profiles", "old");
            profile(legacy);
            fs.writeFileSync(path.join(legacy, "cordis.patch.yml"), "# bili begin (managed by billion-context — `bili plugin install dsh`)\n- insert:\n    - id: bili-native\n      name: /opt/bili\n# bili end\n");
            assert.equal(dshNativeInstalled(process.env, "old"), true, "a pre-unification managed block counts for that profile");
            assert.equal(dshNativeInstalled(process.env, "other"), false);
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("#7155 dshProfileFromArgs mirrors dsh's own --profile parsing", () => {
    // A bare first argument abbreviates --profile (dsh's expansion rule).
    assert.equal(dshProfileFromArgs(["web"]), "web");
    assert.equal(dshProfileFromArgs(["headless", "run the tests"]), "headless");
    assert.equal(dshProfileFromArgs(["--profile", "tui"]), "tui");
    assert.equal(dshProfileFromArgs(["--profile=tui"]), "tui");
    assert.equal(dshProfileFromArgs(["--no-open", "--profile", "tui", "--port", "0"]), "tui");
    // `plugin` takes its own required flag; a positional after it is not a profile.
    assert.equal(dshProfileFromArgs(["plugin", "--profile", "x", "add", "billion-context"]), "x");
    assert.equal(dshProfileFromArgs(["plugin", "add", "billion-context"]), undefined);
    // No profile named at all (dsh errors out itself; the caller falls back).
    assert.equal(dshProfileFromArgs([]), undefined);
    assert.equal(dshProfileFromArgs(["--dump-config"]), undefined);
    assert.equal(dshProfileFromArgs(["--profile"]), undefined);
    // `--` terminates launcher flags: what follows belongs to the app.
    assert.equal(dshProfileFromArgs(["--", "--profile", "nope"]), undefined);
});
