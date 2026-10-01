import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    decodeChildOutput,
    dshProfileDepSpec,
    dshProfileDependsOnBili,
    isRegistryDepSpec,
    planDshSpawn,
    refreshDshProfileBundles,
    resolveDshBinary,
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

// — resolveDshBinary (#1732) ------------------------------------------

test("resolveDshBinary: BILI_DSH_BIN override wins even when the path does not exist", () => {
    assert.equal(resolveDshBinary({ BILI_DSH_BIN: "C:\\odd\\dsh.exe" }, "win32", () => false), "C:\\odd\\dsh.exe");
});

test("resolveDshBinary: win32 PATH hit returns the full path", () => {
    const exists = (p: string): boolean => p === "C:/Users/me/AppData/Roaming/npm/dsh.cmd";
    assert.equal(
        resolveDshBinary({ PATH: "C:/nowhere;C:/Users/me/AppData/Roaming/npm" }, "win32", exists),
        "C:/Users/me/AppData/Roaming/npm/dsh.cmd",
    );
});

test("resolveDshBinary: win32 PATHEXT order decides between same-dir candidates", () => {
    const found = new Set(["C:/tools/dsh.bat", "C:/tools/dsh.exe"]);
    const exists = (p: string): boolean => found.has(p);
    assert.equal(resolveDshBinary({ PATH: "C:/tools" }, "win32", exists), "C:/tools/dsh.exe");
    assert.equal(resolveDshBinary({ PATH: "C:/tools", PATHEXT: ".BAT;.CMD" }, "win32", exists), "C:/tools/dsh.bat");
});

test("resolveDshBinary: win32 GUI-host minimal PATH falls back to %APPDATA%\\npm (#1732)", () => {
    const exists = (p: string): boolean => p === "C:/Users/Administrator/AppData/Roaming/npm/dsh.cmd";
    const env = { PATH: "C:/Windows/System32", APPDATA: "C:/Users/Administrator/AppData/Roaming" };
    assert.equal(
        resolveDshBinary(env, "win32", exists, "C:/Program Files/nodejs/node.exe"),
        "C:/Users/Administrator/AppData/Roaming/npm/dsh.cmd",
    );
});

test("resolveDshBinary: win32 probes the running node's own dir and %LOCALAPPDATA%\\pnpm", () => {
    const byNodeDir = (p: string): boolean => p === "C:/Program Files/nodejs/dsh.cmd";
    assert.equal(
        resolveDshBinary({ PATH: "" }, "win32", byNodeDir, "C:/Program Files/nodejs/node.exe"),
        "C:/Program Files/nodejs/dsh.cmd",
    );
    const byPnpm = (p: string): boolean => p === "C:/Users/u/AppData/Local/pnpm/dsh.cmd";
    assert.equal(
        resolveDshBinary({ PATH: "", LOCALAPPDATA: "C:/Users/u/AppData/Local" }, "win32", byPnpm, "C:/Program Files/nodejs/node.exe"),
        "C:/Users/u/AppData/Local/pnpm/dsh.cmd",
    );
});

test("resolveDshBinary: nothing found anywhere → bare dsh fallback (error path preserved)", () => {
    assert.equal(resolveDshBinary({ PATH: "" }, "win32", () => false, "C:/Program Files/nodejs/node.exe"), "dsh");
    assert.equal(resolveDshBinary({ PATH: "", HOME: "/home/u" }, "linux", () => false, "/usr/bin/node"), "dsh");
});

test("resolveDshBinary: posix PATH hit, ~/.local/bin fallback, PATH beats known locations", () => {
    const onPath = (p: string): boolean => p === "/usr/local/bin/dsh";
    assert.equal(resolveDshBinary({ PATH: "/nonexistent:/usr/local/bin" }, "linux", onPath, "/usr/bin/node"), "/usr/local/bin/dsh");
    const inLocalBin = (p: string): boolean => p === "/home/u/.local/bin/dsh";
    assert.equal(resolveDshBinary({ PATH: "/usr/bin", HOME: "/home/u" }, "linux", inLocalBin, "/usr/bin/node"), "/home/u/.local/bin/dsh");
    const both = new Set(["/opt/homebrew/bin/dsh", "/custom/bin/dsh"]);
    assert.equal(resolveDshBinary({ PATH: "/custom/bin", HOME: "/home/u" }, "linux", (p) => both.has(p), "/usr/bin/node"), "/custom/bin/dsh");
});

test("runDshPlugin: spawns the resolved binary, not a hardcoded bare name (#1732)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-resolve-"));
    try {
        const binName = process.platform === "win32" ? "dsh.cmd" : "dsh";
        fs.writeFileSync(path.join(dir, binName), "");
        const seen: DshPlan[] = [];
        _setDshRunnersForTest({ sync: (plan) => { seen.push(plan); return { stdout: "", stderr: "" }; } });
        const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
        runDshPlugin(["plugin", "--profile", "x", "add", "billion-context"], env);
        const resolved = `${dir}/${binName}`;
        if (process.platform === "win32") {
            // #679: .cmd shims spawn through comspec /d /s /c — the resolved path lives in the wrapped line
            assert.equal(seen[0].command, process.env.COMSPEC?.trim() || "cmd.exe");
            assert.ok(seen[0].args.join(" ").includes(resolved), `wrap line missing ${resolved}: ${seen[0].args.join(" ")}`);
        } else {
            assert.equal(seen[0].command, resolved);
        }
    } finally {
        _setDshRunnersForTest(undefined);
        rmrf(dir);
    }
});

// — decodeChildOutput (#1732 codepage handling) -------------------------

test("decodeChildOutput: ascii and valid UTF-8 pass through unchanged", () => {
    assert.equal(decodeChildOutput(Buffer.from("plain ascii\n")), "plain ascii\n");
    assert.equal(decodeChildOutput(Buffer.from("中文正常输出", "utf8")), "中文正常输出");
    assert.equal(decodeChildOutput(null), "");
    assert.equal(decodeChildOutput(Buffer.alloc(0)), "");
});

test("decodeChildOutput: GBK bytes from Chinese Windows cmd.exe decode instead of mojibake", () => {
    // CP936 bytes of 不是内部或外部命令 — the classic "'dsh' is not recognized" failure text
    const gbk = Buffer.from("b2bbcac7c4dab2bfbbf2cde2b2bfc3fcc1ee", "hex");
    assert.equal(decodeChildOutput(gbk), "不是内部或外部命令");
    // bytes that are neither UTF-8 nor valid GBK degrade lossily rather than throwing
    assert.equal(typeof decodeChildOutput(Buffer.from([0xff, 0xfe, 0x41])), "string");
});

test("decodeChildOutput: pure-trap GBK that is also valid UTF-8 still decodes as GBK", () => {
    // GBK 系统 (cfb5cdb3) is simultaneously valid UTF-8 ("ϵς", Greek) — the
    // strict-utf8 gate would pass and hand back mojibake. The content
    // heuristic (Greek/Cyrillic run + GBK re-read with CJK) must catch it.
    assert.equal(decodeChildOutput(Buffer.from("cfb5cdb3", "hex")), "系统");
    // real cmd.exe sentence mostly made of trap pairs decodes as a whole too
    const sentence = Buffer.from("cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4c2b7beb6a1a3", "hex"); // 系统找不到指定的路径。
    assert.equal(decodeChildOutput(sentence), "系统找不到指定的路径。");
    // genuine UTF-8 CJK output is never re-read as GBK
    assert.equal(decodeChildOutput(Buffer.from("中文正常输出", "utf8")), "中文正常输出");
    // string input (pre-decoded by callers) round-trips
    assert.equal(decodeChildOutput("已解好的字符串"), "已解好的字符串");
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
        assert.ok(failLog.endsWith(`dsh plugin --profile a add billion-context@0.1.121 failed: boom — manual fix: run \`dsh plugin --profile a add billion-context@0.1.121\` from a shell where \`dsh\` resolves (or point BILI_DSH_BIN at dsh's executable)`), failLog);
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
