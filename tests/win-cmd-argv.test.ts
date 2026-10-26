// #2196: launching Codex through its default npm shim (codex.cmd) re-fed user
// argv into cmd.exe's line parser — embedded double quotes split tokens,
// %VAR% expanded, &|<>^() executed, empty args vanished. Fix: the codex path
// bypasses the shell (native codex.exe, or the official npm package's JS entry
// under Node), and every remaining comspec wrap site (launcher + dsh channel)
// refuses argv the line parser cannot carry verbatim instead of mangling it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
    planClientSpawn,
    resolveClientCommand,
    resolveCodexOfficialJsEntry,
    resolveOnPath,
    runClient,
    type SpawnChild,
    type SpawnFn,
} from "../src/launcher.ts";
import { planDshSpawn } from "../src/dsh-channel.ts";
import { winCmdUnsafeToken } from "../src/win-cmd.ts";
import { rmrf } from "./tmp-rm.ts";

const WIN_ENV: NodeJS.ProcessEnv = { COMSPEC: "C:\\Windows\\System32\\cmd.exe" };

function fakeChild(exitCode = 0): SpawnChild {
    return {
        pid: 42424,
        unref() {},
        kill() {
            return true;
        },
        on(event, listener) {
            if (event === "exit") setImmediate(() => listener(exitCode, null));
            return undefined;
        },
    };
}

function captureSpawn(): { captured: { cmd?: string; args?: readonly string[] }; spawnImpl: SpawnFn } {
    const captured: { cmd?: string; args?: readonly string[] } = {};
    const spawnImpl: SpawnFn = (cmd, args) => {
        captured.cmd = cmd;
        captured.args = [...args];
        return fakeChild();
    };
    return { captured, spawnImpl };
}

// ---- the safe-set predicate itself ----------------------------------------

test("winCmdUnsafeToken: the safe set passes", () => {
    const safe = [
        "hello",
        "hello world",
        "-c",
        "a;b,c=d",
        String.raw`C:\x\y\z`,
        "tailbs-nospace\\",
        String.raw`even trailing \\ with space`,
        "!VAR! delayed expansion marker",
        "tab\there",
        "unicode ✓ 日本語 🎉",
    ];
    for (const t of safe) assert.equal(winCmdUnsafeToken(t), undefined, `expected safe: ${JSON.stringify(t)}`);
});

test("winCmdUnsafeToken: every #2196 corruption class is refused", () => {
    const unsafe: Array<[string, string]> = [
        ["", "an empty argument"],
        ['key="value"', "a double quote"],
        ["literal %COMSPEC% marker", "% (cmd.exe expands %VAR%)"],
        ["hello&rem", "cmd metacharacters (& | < > ^ ( ))"],
        ["a|b", "cmd metacharacters (& | < > ^ ( ))"],
        ["a<b", "cmd metacharacters (& | < > ^ ( ))"],
        ["a>b", "cmd metacharacters (& | < > ^ ( ))"],
        ["a^b", "cmd metacharacters (& | < > ^ ( ))"],
        ["(a)", "cmd metacharacters (& | < > ^ ( ))"],
        ["line\nbreak", "a line break"],
        ["odd trailing \\", "an odd number of trailing backslashes"],
    ];
    for (const [token, reason] of unsafe) {
        assert.equal(winCmdUnsafeToken(token), reason, `expected unsafe: ${JSON.stringify(token)}`);
    }
});

// ---- planClientSpawn guard --------------------------------------------------

test("planClientSpawn win32: safe argv keeps the exact #679 plan (byte-identical regression pin)", () => {
    const p = planClientSpawn(String.raw`C:\npm\codex.cmd`, ["exec", "hello world"], WIN_ENV, "win32");
    assert.equal(p.command, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(p.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(p.args[3], String.raw`"C:\npm\codex.cmd exec "hello world""`);
    assert.equal(p.windowsVerbatimArguments, true);
});

test("planClientSpawn win32: '!' and other non-metacharacters stay allowed on the comspec path", () => {
    const p = planClientSpawn("tool.cmd", ["!VAR!", "a;b,c=d"], WIN_ENV, "win32");
    assert.equal(p.command, "C:\\Windows\\System32\\cmd.exe");
    assert.equal(p.args[3], '"tool.cmd !VAR! a;b,c=d"');
});

test("planClientSpawn win32: .exe direct spawn never triggers the guard (Node encodes argv losslessly)", () => {
    const p = planClientSpawn(String.raw`C:\Program Files\nodejs\node.exe`, ['a"b', "c%d", "e&f", ""], WIN_ENV, "win32");
    assert.equal(p.command, String.raw`C:\Program Files\nodejs\node.exe`);
    assert.deepEqual(p.args, ['a"b', "c%d", "e&f", ""]);
    assert.equal(p.windowsVerbatimArguments, undefined);
});

test("planClientSpawn: non-win32 never triggers the guard", () => {
    const p = planClientSpawn("/usr/local/bin/tool.sh", ['a"b', "c&d"], {}, "linux");
    assert.deepEqual(p, { command: "/usr/local/bin/tool.sh", args: ['a"b', "c&d"] });
});

for (const [label, args] of [
    ["embedded double quotes (the issue repro)", ["exec", 'Please say "hello world" exactly']],
    ["TOML -c value", ["-c", 'model_providers.demo.name="My Provider"', "exec", "hello"]],
    ["empty argument", ["exec", ""]],
    ["%VAR%", ["exec", "literal %COMSPEC% marker"]],
    ["& metacharacter", ["exec", "hello&rem"]],
    ["odd trailing backslash", ["exec", "odd tail \\"]],
] as const) {
    test(`planClientSpawn win32: refuses ${label} on the comspec path with an actionable error`, () => {
        assert.throws(
            () => planClientSpawn(String.raw`C:\npm\codex.cmd`, [...args], WIN_ENV, "win32"),
            (err: Error) => {
                assert.ok(err.message.includes("BILI_CLIENT_BIN"), `hint missing: ${err.message}`);
                return true;
            },
        );
    });
}

test("planClientSpawn win32: the refusal names the position and class but never the token content", () => {
    try {
        planClientSpawn("tool.cmd", ['sk-live-supersecret-123 "quoted"'], WIN_ENV, "win32");
        assert.fail("must throw");
    } catch (err) {
        const msg = (err as Error).message;
        assert.ok(msg.includes("argument #0"), `position missing: ${msg}`);
        assert.ok(msg.includes("double quote"), `class missing: ${msg}`);
        assert.ok(!msg.includes("sk-live-supersecret-123"), "token content must not leak into the error");
    }
});

test("planClientSpawn win32: an unsafe COMMAND path is refused too", () => {
    assert.throws(
        () => planClientSpawn(String.raw`C:\bad&dir\tool.cmd`, [], WIN_ENV, "win32"),
        (err: Error) => err.message.includes("resolved command"),
    );
});

test("runClient win32: the issue repro refuses before any spawn happens", async () => {
    const { captured, spawnImpl } = captureSpawn();
    let threw: unknown;
    try {
        await runClient(String.raw`C:\npm\codex.cmd`, ["exec", 'Please say "hello world" exactly'], WIN_ENV, {
            spawnImpl,
            platform: "win32",
        });
    } catch (err) {
        threw = err;
    }
    assert.ok(threw instanceof Error, "must throw/reject");
    assert.ok((threw as Error).message.includes("BILI_CLIENT_BIN"));
    assert.equal(captured.cmd, undefined, "spawn must never be reached");
});

// ---- dsh channel shares the same contract -----------------------------------

test("planDshSpawn win32: safe profile args keep the #679 plan", () => {
    const p = planDshSpawn(String.raw`C:\tools\dsh.cmd`, ["plugin", "--profile", "my profile", "add", "billion-context"], WIN_ENV, "win32");
    assert.equal(p.command, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(p.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(p.args[3], String.raw`"C:\tools\dsh.cmd plugin --profile "my profile" add billion-context"`);
});

test("planDshSpawn win32: a metacharacter-laden profile name is refused, not mangled", () => {
    assert.throws(
        () => planDshSpawn(String.raw`C:\tools\dsh.cmd`, ["plugin", "--profile", "p&q", "add", "billion-context"], WIN_ENV, "win32"),
        (err: Error) => err.message.includes("BILI_DSH_BIN"),
    );
});

test("planDshSpawn non-win32: untouched", () => {
    const p = planDshSpawn("/usr/local/bin/dsh", ["plugin", "--profile", "p&q"], {}, "linux");
    assert.deepEqual(p, { command: "/usr/local/bin/dsh", args: ["plugin", "--profile", "p&q"] });
});

// ---- official npm layout detection -------------------------------------------

const NPM_SHIM_TEXT = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "set dp0=%~dp0",
    "EXIT /b",
    ":start",
    "setlocal",
    "call :find_dp0",
    String.raw`"%dp0%\node_modules\@openai\codex\bin\codex.js" %*`,
].join("\r\n");

function makeNpmLayout(root: string, opts: { name?: string; bin?: unknown; binFile?: boolean; shimText?: string; pkgJsonRaw?: string } = {}): { shim: string; entry: string } {
    const globalDir = path.join(root, "npm-global");
    const pkgDir = path.join(globalDir, "node_modules", "@openai", "codex");
    fs.mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
    const entry = path.join(pkgDir, "bin", "codex.js");
    if (opts.binFile !== false) fs.writeFileSync(entry, "// fake official codex entry\n");
    const pkgJson = opts.pkgJsonRaw ?? JSON.stringify({ name: opts.name ?? "@openai/codex", version: "0.160.0", bin: opts.bin ?? { codex: "bin/codex.js" } });
    fs.writeFileSync(path.join(pkgDir, "package.json"), pkgJson);
    const shim = path.join(globalDir, "codex.cmd");
    fs.writeFileSync(shim, opts.shimText ?? NPM_SHIM_TEXT);
    return { shim, entry };
}

test("resolveCodexOfficialJsEntry: full trusted npm layout resolves the JS entry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2196-layout-"));
    try {
        const { shim, entry } = makeNpmLayout(root);
        assert.equal(resolveCodexOfficialJsEntry(shim), entry);
    } finally {
        rmrf(root);
    }
});

test("resolveCodexOfficialJsEntry: string-form bin field also resolves", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2196-layout-"));
    try {
        const { shim, entry } = makeNpmLayout(root, { bin: "bin/codex.js" });
        assert.equal(resolveCodexOfficialJsEntry(shim), entry);
    } finally {
        rmrf(root);
    }
});

test("resolveCodexOfficialJsEntry: anything off the trusted layout stays undefined", () => {
    const cases: Array<[string, (r: string) => string]> = [
        ["wrong package name", (r) => makeNpmLayout(r, { name: "@evil/codex" }).shim],
        ["bin without codex key", (r) => makeNpmLayout(r, { bin: { other: "bin/codex.js" } }).shim],
        ["bin pointing at a missing file", (r) => makeNpmLayout(r, { binFile: false }).shim],
        ["malformed package.json", (r) => makeNpmLayout(r, { pkgJsonRaw: "{not json" }).shim],
        ["shim text not referencing the package", (r) => makeNpmLayout(r, { shimText: "@echo off\r\nnode capture.mjs %*\r\n" }).shim],
        ["missing package.json", (r) => {
            const { shim } = makeNpmLayout(r);
            fs.rmSync(path.join(r, "npm-global", "node_modules", "@openai", "codex", "package.json"));
            return shim;
        }],
    ];
    for (const [label, build] of cases) {
        const r = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2196-layout-"));
        try {
            assert.equal(resolveCodexOfficialJsEntry(build(r)), undefined, label);
        } finally {
            rmrf(r);
        }
    }
});

// ---- codex resolution order ----------------------------------------------------

function makePathEnv(dirs: string[]): NodeJS.ProcessEnv {
    return { PATH: dirs.join(path.delimiter) };
}

test("resolveClientCommand codex win32: npm shim with trusted layout upgrades to node + official JS entry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2196-resolve-"));
    try {
        const { shim, entry } = makeNpmLayout(root);
        const resolved = resolveClientCommand("codex", makePathEnv([path.dirname(shim)]), "win32");
        assert.equal(resolved.command, process.execPath);
        assert.deepEqual(resolved.prefixArgs, [entry]);
    } finally {
        rmrf(root);
    }
});

test("resolveClientCommand codex win32: native codex.exe beats the shim in the same directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2196-resolve-"));
    try {
        const { shim } = makeNpmLayout(root);
        const dir = path.dirname(shim);
        const exe = path.join(dir, "codex.exe");
        fs.writeFileSync(exe, "");
        const resolved = resolveClientCommand("codex", makePathEnv([dir]), "win32");
        assert.equal(resolved.command, exe, "exe-first within a directory — no shell layer at all");
        assert.deepEqual(resolved.prefixArgs, []);
    } finally {
        rmrf(root);
    }
});

test("resolveClientCommand codex win32: earlier PATH directory still wins overall (cmd there beats exe later)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2196-resolve-"));
    try {
        const dirA = path.join(root, "a");
        const dirB = path.join(root, "b");
        fs.mkdirSync(dirA, { recursive: true });
        fs.mkdirSync(dirB, { recursive: true });
        const cmdA = path.join(dirA, "codex.cmd");
        fs.writeFileSync(cmdA, NPM_SHIM_TEXT);
        const exeB = path.join(dirB, "codex.exe");
        fs.writeFileSync(exeB, "");
        const resolved = resolveClientCommand("codex", makePathEnv([dirA, dirB]), "win32");
        assert.equal(resolved.command, cmdA, "earliest-dir rule preserved — the guard downstream decides safety");
    } finally {
        rmrf(root);
    }
});

test("resolveClientCommand codex win32: shim without trusted layout keeps the legacy cmd path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2196-resolve-"));
    try {
        const dir = path.join(root, "bin");
        fs.mkdirSync(dir, { recursive: true });
        const shim = path.join(dir, "codex.cmd");
        fs.writeFileSync(shim, "@echo off\r\nnode capture.mjs %*\r\n");
        const resolved = resolveClientCommand("codex", makePathEnv([dir]), "win32");
        assert.equal(resolved.command, shim);
        assert.deepEqual(resolved.prefixArgs, []);
    } finally {
        rmrf(root);
    }
});

test("resolveClientCommand codex win32: no codex anywhere falls through to the bare-name fallback", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2196-resolve-"));
    try {
        const resolved = resolveClientCommand("codex", makePathEnv([root]), "win32");
        assert.deepEqual(resolved, { command: "codex", prefixArgs: [] });
    } finally {
        rmrf(root);
    }
});

test("resolveClientCommand: BILI_CLIENT_BIN override still wins over the codex branch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2196-resolve-"));
    try {
        const { entry } = makeNpmLayout(root);
        const env = makePathEnv([path.dirname(path.join(root, "npm-global", "codex.cmd"))]);
        env.BILI_CLIENT_BIN = "my-codex";
        const resolved = resolveClientCommand("codex", env, "win32");
        assert.equal(resolved.command, "my-codex");
        assert.deepEqual(resolved.prefixArgs, []);
        assert.notEqual(resolved.command, process.execPath);
        assert.notEqual(resolved.prefixArgs[0], entry);
    } finally {
        rmrf(root);
    }
});

test("resolveClientCommand: non-codex clients are untouched by the win32 branch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2196-resolve-"));
    try {
        const dir = path.join(root, "bin");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "claude.cmd"), "@echo off\r\n");
        // A trusted codex layout sits on the same PATH — it must not leak
        // onto another client's launch (the codex branch is client-scoped).
        makeNpmLayout(root);
        const resolved = resolveClientCommand("claude", makePathEnv([dir, path.join(root, "npm-global")]), "win32");
        assert.notEqual(resolved.command, process.execPath, "no node-entry hijack for non-codex clients");
        assert.deepEqual(resolved.prefixArgs, []);
    } finally {
        rmrf(root);
    }
});

// ---- real round-trips (Windows only) ---------------------------------------------
// These are the acceptance lane: the child process's RECEIVED argv must equal
// the caller's array item-by-item — not the constructed command line.

const ARGV_CORPUS: string[][] = [
    [],
    ["exec", "hello world"],
    ["exec", 'Please say "hello world" exactly'],
    ["-c", 'model_providers.demo.name="My Provider"', "exec", "hello"],
    ["--json", '{"a": 1, "b": [true, null]}'],
    ["exec", ""],
    ["exec", "unicode ✓ 日本語 🎉"],
    ["exec", "trailing backslash \\"],
    ["exec", String.raw`even trailing \\ ok`],
    ["exec", "literal %COMSPEC% marker"],
    ["exec", "delayed !VAR! marker"],
    ["exec", "meta & | < > ^ ( ) chars"],
];

const CAPTURE_SCRIPT = 'require("node:fs").writeFileSync(process.env.CAPTURE_OUT, JSON.stringify(process.argv.slice(2)));';

async function roundTripVia(label: string, command: string, prefixArgs: string[], corpus: string[], outFile: string): Promise<void> {
    const code = await runClient(command, [...prefixArgs, ...corpus], { ...process.env, CAPTURE_OUT: outFile }, { platform: "win32" });
    assert.equal(code, 0, `${label}: exit 0`);
    const seen = JSON.parse(fs.readFileSync(outFile, "utf8")) as string[];
    assert.deepEqual(seen, corpus, `${label}: received argv must equal the caller array item-by-item`);
}

test("#2196 real win32: node + official-wrapper-shaped entry carries the full corpus verbatim", { skip: process.platform !== "win32" }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2196-rt-"));
    try {
        // A fake @openai/codex whose bin/codex.js mirrors the real wrapper's
        // forwarding semantics (spawn/record process.argv.slice(2)): detection
        // picks it up exactly like the production install.
        const { entry } = makeNpmLayout(root);
        fs.writeFileSync(entry, CAPTURE_SCRIPT);
        const resolved = resolveClientCommand("codex", makePathEnv([path.dirname(path.join(root, "npm-global", "codex.cmd"))]), "win32");
        assert.equal(resolved.command, process.execPath);
        assert.deepEqual(resolved.prefixArgs, [entry]);
        for (const corpus of ARGV_CORPUS) {
            const outFile = path.join(root, `argv-${t.name}-${ARGV_CORPUS.indexOf(corpus)}.json`);
            await roundTripVia(JSON.stringify(corpus), resolved.command, resolved.prefixArgs, corpus, outFile);
        }
    } finally {
        rmrf(root);
    }
});

test("#2196 real win32: the direct-spawn leg alone is lossless for the full corpus", { skip: process.platform !== "win32" }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2196-rt-"));
    try {
        const script = path.join(root, "capture.cjs");
        fs.writeFileSync(script, CAPTURE_SCRIPT);
        for (const corpus of ARGV_CORPUS) {
            const outFile = path.join(root, `direct-${ARGV_CORPUS.indexOf(corpus)}.json`);
            await roundTripVia(JSON.stringify(corpus), process.execPath, [script], corpus, outFile);
        }
    } finally {
        rmrf(root);
    }
});

test("#2196 real win32: a global @openai/codex install is detected (production layout check)", { skip: process.platform !== "win32" }, () => {
    const shim = resolveOnPath("codex", process.env);
    if (!shim || !/\.cmd$/i.test(shim)) return; // not installed here — CI installs it
    const entry = resolveCodexOfficialJsEntry(shim);
    assert.ok(entry, "the production npm layout must match the detector");
    const expected = path.join(path.dirname(shim), "node_modules", "@openai", "codex");
    const pkgJson = JSON.parse(fs.readFileSync(path.join(expected, "package.json"), "utf8")) as { name: string; bin: unknown };
    assert.equal(pkgJson.name, "@openai/codex");
    const resolved = resolveClientCommand("codex", process.env, "win32");
    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.prefixArgs, [entry]);
});

test("#2196 real win32: the official wrapper answers --help through plain node (probe path intact)", { skip: process.platform !== "win32" }, () => {
    const shim = resolveOnPath("codex", process.env);
    if (!shim || !/\.cmd$/i.test(shim)) return;
    const entry = resolveCodexOfficialJsEntry(shim);
    if (!entry) return;
    // The production launch shape for this path is exactly `node <entry> <args>`
    // — prove the official wrapper boots its vendor binary through it, offline.
    const res = spawnSync(process.execPath, [entry, "--help"], { timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    if (res.status !== 0 || res.error) {
        assert.fail(`wrapper --help exited ${res.status} (${res.error ?? ""}): ${res.stderr?.toString("utf8").slice(0, 300) ?? ""}`);
    }
    assert.ok(res.stdout.toString("utf8").length > 0);
});
