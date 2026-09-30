import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    dshProfileDepSpec,
    dshProfileDependsOnBili,
    isRegistryDepSpec,
    planDshSpawn,
    refreshDshProfileBundles,
    runDshPlugin,
    _setDshRunnersForTest,
    type DshPlan,
} from "../src/dsh-channel.ts";
import { rmrf } from "./tmp-rm.ts";

// — planDshSpawn (#679 spawn rules) ---------------------------------

test("planDshSpawn: posix passthrough", () => {
    assert.deepEqual(planDshSpawn("dsh", ["plugin", "--profile", "x", "add", "billion-context"], {}, "linux"), { command: "dsh", args: ["plugin", "--profile", "x", "add", "billion-context"] });
});

test("planDshSpawn: win32 bare names and .cmd shims ride comspec /d /s /c", () => {
    const plan = planDshSpawn("dsh", ["plugin", "--profile", "my prof", "add", "C:\\dev\\billion context"], {}, "win32");
    assert.equal(plan.command, "cmd.exe");
    assert.equal(plan.windowsVerbatimArguments, true);
    assert.deepEqual(plan.args, ["/d", "/s", "/c", '"dsh plugin --profile "my prof" add "C:\\dev\\billion context""']);

    // a resolved .exe spawns direct — CreateProcess handles it fine
    assert.deepEqual(planDshSpawn("C:\\tools\\dsh.exe", ["a b"], {}, "win32"), { command: "C:\\tools\\dsh.exe", args: ["a b"] });
    const cmdShim = planDshSpawn("C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd", [], {}, "win32");
    assert.equal(cmdShim.command, "cmd.exe");

    const custom = planDshSpawn("dsh", [], { ...process.env, COMSPEC: "C:\\custom\\cmd.exe" }, "win32");
    assert.equal(custom.command, "C:\\custom\\cmd.exe");
});

// — registry vs local dep specs ---------------------------------------

test("isRegistryDepSpec: registry forms yes, local pins no", () => {
    for (const s of ["^0.1.120", "~0.1.0", "0.1.120", ">=0.1.0", "latest", "dev"]) assert.equal(isRegistryDepSpec(s), true, s);
    for (const s of ["link:/home/u/bc", "link:C:\\dev\\bc", "file:/tmp/bc.tgz", "workspace:*", "git+https://github.com/x/y.git", "github:ranxianglei/billion-context"]) assert.equal(isRegistryDepSpec(s), false, s);
});

test("dshProfileDepSpec / dshProfileDependsOnBili read the manifest dependency", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-depspec-"));
    try {
        assert.equal(dshProfileDepSpec(dir), undefined);
        assert.equal(dshProfileDependsOnBili(dir), false);
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
        assert.equal(dshProfileDepSpec(dir), undefined);
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { "billion-context": "^0.1.120" } }));
        assert.equal(dshProfileDepSpec(dir), "^0.1.120");
        assert.equal(dshProfileDependsOnBili(dir), true);
    } finally {
        rmrf(dir);
    }
});

// — refreshDshProfileBundles ------------------------------------------

type Manifest = { name?: string; dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } };

function makeHome(entries: Record<string, Manifest | undefined>): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-refresh-"));
    for (const [name, manifest] of Object.entries(entries)) {
        fs.mkdirSync(path.join(home, "profiles", name), { recursive: true });
        if (manifest) fs.writeFileSync(path.join(home, "profiles", name, "package.json"), JSON.stringify(manifest));
    }
    return home;
}

/** Records successful calls; profiles in `failNames` throw before recording.
 *  On Windows the plan rides cmd.exe /d /s /c "<line>" — unpack to argv
 *  tokens first so recording is platform-neutral (no spaced test tokens). */
function recordingAsyncRunner(calls: string[], failNames?: Set<string>): (plan: DshPlan) => Promise<{ stdout: string; stderr: string }> {
    return async (plan) => {
        const base = path.basename(plan.command).toLowerCase();
        const tokens = base === "cmd.exe" || base === "cmd"
            ? (plan.args[3] ?? "").replace(/^"|"$/g, "").split(" ").map((t) => t.replace(/^"|"$/g, "")).filter((t) => t.length > 0).slice(1)
            : [...plan.args];
        const name = tokens[tokens.indexOf("--profile") + 1];
        if (failNames?.has(name)) throw Object.assign(new Error("spawn failed"), { status: 1, stderr: "boom" });
        calls.push(tokens.join(" "));
        return { stdout: "", stderr: "" };
    };
}

test("refreshDshProfileBundles: registry-pinned profiles get the exact new version, local pins stay put", async () => {
    const home = makeHome({
        a: { dependencies: { "billion-context": "^0.1.119" } },
        b: { dependencies: { "billion-context": "link:/home/u/dev/bc" } },
        c: {},
        d: { dependencies: { "billion-context": "file:/tmp/bc.tgz" } },
    });
    const calls: string[] = [];
    const logs: string[] = [];
    const log = (level: string, msg: string): void => logs.push(`${level}: ${msg}`);
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        await refreshDshProfileBundles("0.1.121", log, { ...process.env, DSH_HOME: home });
        assert.deepEqual(calls, ["plugin --profile a add billion-context@0.1.121"]);
        assert.ok(logs.some((l) => l.includes("refreshed 1 dsh profile bundle(s) to 0.1.121")));
        assert.ok(logs.some((l) => l.includes("dsh profile b") && l.includes("leaving it alone")));
        assert.ok(logs.some((l) => l.includes("dsh profile d") && l.includes("leaving it alone")));
    } finally {
        _setDshRunnersForTest(undefined);
        rmrf(home);
    }
});

test("refreshDshProfileBundles: one profile's failure does not stop the rest and never throws", async () => {
    const home = makeHome({
        a: { dependencies: { "billion-context": "^0.1.119" } },
        b: { dependencies: { "billion-context": "^0.1.119" } },
    });
    const calls: string[] = [];
    const logs: string[] = [];
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls, new Set(["a"])) });
        await assert.doesNotReject(refreshDshProfileBundles("0.1.121", (l, m) => logs.push(`${l}: ${m}`), { ...process.env, DSH_HOME: home }));
        assert.deepEqual(calls, ["plugin --profile b add billion-context@0.1.121"]);
        const failLog = logs.find((l) => l.startsWith("warn") && l.includes("dsh profile a"));
        assert.ok(failLog, "expected a warn log for the failed profile");
        // #1675: error text renders the executed argv — no duplicated "plugin" token
        assert.ok(failLog.endsWith(`dsh plugin --profile a add billion-context@0.1.121 failed: boom`), failLog);
        assert.ok(!failLog.includes("plugin plugin"), failLog);
        assert.ok(logs.some((l) => l.includes("refreshed 1 dsh profile bundle(s) to 0.1.121")));
    } finally {
        _setDshRunnersForTest(undefined);
        rmrf(home);
    }
});

test("runDshPlugin: failure message renders the executed argv, no duplicated 'plugin' (#1675)", () => {
    try {
        _setDshRunnersForTest({ sync: () => { throw Object.assign(new Error("exit 1"), { status: 1, stderr: "pnpm not found on PATH" }); } });
        assert.throws(
            () => runDshPlugin(["plugin", "--profile", "web", "add", "billion-context@0.1.171"]),
            (err: unknown) => {
                const msg = (err as Error).message;
                assert.equal(msg, "dsh plugin --profile web add billion-context@0.1.171 failed: pnpm not found on PATH");
                assert.ok(!msg.includes("plugin plugin"), msg);
                return true;
            },
        );
    } finally {
        _setDshRunnersForTest(undefined);
    }
});

test("refreshDshProfileBundles: no profiles root or no bili deps → silent no-op", async () => {
    const logs: string[] = [];
    const log = (level: string, msg: string): void => logs.push(`${level}: ${msg}`);
    await refreshDshProfileBundles("0.1.121", log, { ...process.env, DSH_HOME: "/nonexistent-dsh-home-xyz" });
    assert.equal(logs.length, 0);

    const home = makeHome({ a: { dependencies: { other: "^1.0.0" } } });
    try {
        await refreshDshProfileBundles("0.1.121", log, { ...process.env, DSH_HOME: home });
        assert.equal(logs.length, 0);
    } finally {
        rmrf(home);
    }
});
