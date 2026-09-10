import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    buildWindowsCommandLine,
    planClientSpawn,
    quoteWinToken,
    runClient,
    type SpawnChild,
    type SpawnFn,
} from "../src/launcher.ts";

// #679: on Windows the launcher spawned with shell:true and unquoted args, so
// cmd.exe re-split the line on whitespace — a space in the resolved client or
// -e path truncated the launch (loud) or the extension path (silent: the
// extension never loads, compression never activates).

test("quoteWinToken: space-free tokens stay bare (byte-identical to the old shell:true line)", () => {
    assert.equal(quoteWinToken("C:\\bin\\code.cmd"), "C:\\bin\\code.cmd");
    assert.equal(quoteWinToken("-e"), "-e");
    assert.equal(quoteWinToken(""), "");
});

test("quoteWinToken: whitespace-bearing tokens get wrapped in double quotes", () => {
    assert.equal(quoteWinToken("C:\\Program Files\\nodejs\\node.exe"), '"C:\\Program Files\\nodejs\\node.exe"');
    assert.equal(quoteWinToken("C:\\My Docs\\a.txt"), '"C:\\My Docs\\a.txt"');
    assert.equal(quoteWinToken("a\tb"), '"a\tb"');
});

test("quoteWinToken: embedded double quotes stay bare (cmd.exe has no quote escape — today's behavior preserved)", () => {
    assert.equal(quoteWinToken('key="value"'), 'key="value"');
    assert.equal(quoteWinToken('C:\\x "q" y'), 'C:\\x "q" y');
});

test("buildWindowsCommandLine: outer pair for cmd /s, inner tokens quoted only when needed", () => {
    assert.equal(buildWindowsCommandLine("pi", ["-e", "/ext.js"]), '"pi -e /ext.js"');
    assert.equal(
        buildWindowsCommandLine("C:\\Users\\John Doe\\omp\\omp.exe", ["-e", "C:\\Users\\John Doe\\ext.js"]),
        '""C:\\Users\\John Doe\\omp\\omp.exe" -e "C:\\Users\\John Doe\\ext.js""',
    );
    assert.equal(
        buildWindowsCommandLine("C:\\bin\\code.cmd", ["--file", "C:\\My Docs\\a.txt"]),
        '"C:\\bin\\code.cmd --file "C:\\My Docs\\a.txt""',
    );
});

const WIN_ENV: NodeJS.ProcessEnv = { COMSPEC: "C:\\Windows\\System32\\cmd.exe" };

test("planClientSpawn: non-win32 always spawns directly, untouched", () => {
    assert.deepEqual(planClientSpawn("/usr/bin/codex", ["--foo"], {}, "linux"), {
        command: "/usr/bin/codex",
        args: ["--foo"],
    });
});

test("planClientSpawn win32: .exe spawns directly even when spaced — the OS quotes the executable and argv itself", () => {
    assert.deepEqual(
        planClientSpawn("C:\\Program Files\\nodejs\\node.exe", ["C:\\Users\\John Doe\\cli.js"], WIN_ENV, "win32"),
        { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Users\\John Doe\\cli.js"] },
    );
    assert.deepEqual(
        planClientSpawn("C:\\TOOLS\\NODE.EXE", [], WIN_ENV, "win32"),
        { command: "C:\\TOOLS\\NODE.EXE", args: [] },
    );
});

test("planClientSpawn win32: .cmd/.bat shims route through comspec /d /s /c with verbatim quoting", () => {
    for (const shim of ["C:\\npm\\codex.cmd", "C:\\npm\\claude.BAT"]) {
        const p = planClientSpawn(shim, ["-e", "C:\\John Doe\\ext.js"], WIN_ENV, "win32");
        assert.equal(p.command, "C:\\Windows\\System32\\cmd.exe");
        assert.deepEqual(p.args.slice(0, 3), ["/d", "/s", "/c"]);
        assert.equal(p.args[3], buildWindowsCommandLine(shim, ["-e", "C:\\John Doe\\ext.js"]));
        assert.equal(p.windowsVerbatimArguments, true);
    }
});

test("planClientSpawn win32: unset COMSPEC falls back to cmd.exe", () => {
    const p = planClientSpawn("tool.cmd", [], {}, "win32");
    assert.equal(p.command, "cmd.exe");
    assert.equal(p.windowsVerbatimArguments, true);
});

test("planClientSpawn win32: a COMSPEC with spaces is used verbatim as the program", () => {
    const p = planClientSpawn("tool.cmd", [], { COMSPEC: "C:\\My Tools\\cmd.exe" }, "win32");
    assert.equal(p.command, "C:\\My Tools\\cmd.exe");
    assert.deepEqual(p.args.slice(0, 3), ["/d", "/s", "/c"]);
});

test("planClientSpawn win32: unresolved bare names and extensionless paths keep cmd's PATHEXT resolution", () => {
    for (const c of ["codex", "C:\\tools\\extensionless", "C:\\tools\\.hidden"]) {
        const p = planClientSpawn(c, [], WIN_ENV, "win32");
        assert.equal(p.command, "C:\\Windows\\System32\\cmd.exe");
        assert.equal(p.windowsVerbatimArguments, true);
    }
});

function fakeChild(exitCode = 0, signal: string | null = null): SpawnChild {
    return {
        pid: 42424,
        unref() {},
        kill() {
            return true;
        },
        on(event, listener) {
            if (event === "exit") setImmediate(() => listener(exitCode, signal));
            return undefined;
        },
    };
}

interface CapturedSpawn {
    cmd?: string;
    args?: readonly string[];
    options?: { shell?: boolean; windowsVerbatimArguments?: boolean };
}

function captureSpawn(): { captured: CapturedSpawn; spawnImpl: SpawnFn } {
    const captured: CapturedSpawn = {};
    const spawnImpl: SpawnFn = (cmd, args, options) => {
        captured.cmd = cmd;
        captured.args = [...args];
        captured.options = options;
        return fakeChild();
    };
    return { captured, spawnImpl };
}

test("runClient win32: .cmd shim → comspec spawn, verbatim on, NO shell option (DEP0190 gone)", async () => {
    const { captured, spawnImpl } = captureSpawn();
    const shim = "C:\\Users\\John Doe\\AppData\\npm\\omp.cmd";
    const extArg = "C:\\Users\\John Doe\\ext.js";
    const code = await runClient(shim, ["-e", extArg], WIN_ENV, {
        spawnImpl,
        platform: "win32",
    });
    assert.equal(code, 0);
    assert.equal(captured.cmd, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(captured.args?.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(captured.args?.[3], '""C:\\Users\\John Doe\\AppData\\npm\\omp.cmd" -e "C:\\Users\\John Doe\\ext.js""');
    assert.equal(captured.options?.shell, undefined, "shell:true must be gone");
    assert.equal(captured.options?.windowsVerbatimArguments, true);
});

test("runClient win32: spaced .exe → direct spawn, args passed through intact", async () => {
    const { captured, spawnImpl } = captureSpawn();
    const exe = "C:\\Users\\John Doe\\AppData\\Local\\omp\\omp.exe";
    const ext = "C:\\Users\\John Doe\\ext.js";
    const code = await runClient(exe, ["-e", ext], {}, { spawnImpl, platform: "win32" });
    assert.equal(code, 0);
    assert.equal(captured.cmd, exe);
    assert.deepEqual(captured.args, ["-e", ext]);
    assert.equal(captured.options?.shell, undefined);
    assert.equal(captured.options?.windowsVerbatimArguments, undefined);
});

test("runClient posix: passthrough unchanged, exit code propagates", async () => {
    const { captured, spawnImpl } = captureSpawn();
    const code = await runClient("/usr/local/bin/pi", ["-e", "/x/y.js"], { PATH: "/usr/bin" }, {
        spawnImpl,
        platform: "linux",
    });
    assert.equal(code, 0);
    assert.equal(captured.cmd, "/usr/local/bin/pi");
    assert.deepEqual(captured.args, ["-e", "/x/y.js"]);
    assert.equal(captured.options?.shell, undefined);
});

test("runClient: exit code and signal mapping unchanged", async () => {
    const codeOf = (exitCode: number, signal: string | null) =>
        new Promise<number>((resolve, reject) => {
            const impl: SpawnFn = () => fakeChild(exitCode, signal);
            runClient("/bin/x", [], {}, { spawnImpl: impl }).then(resolve, reject);
        });
    assert.equal(await codeOf(7, null), 7);
    assert.equal(await codeOf(0, "SIGINT"), 130);
});

// Real launches — only meaningful on Windows, skipped everywhere else.

test("#679 real win32: spaced .cmd shim receives its spaced args intact", { skip: process.platform !== "win32" }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-679-"));
    try {
        const clientDir = path.join(root, "client dir");
        fs.mkdirSync(clientDir, { recursive: true });
        const client = path.join(clientDir, "client.cmd");
        fs.writeFileSync(client, '@echo off\r\n> "%~dp0argv.txt" echo(%*\r\n');
        const argPath = path.join(root, "my docs", "ext file.js");
        const code = await runClient(client, ["-e", argPath], process.env);
        assert.equal(code, 0);
        const seen = fs.readFileSync(path.join(clientDir, "argv.txt"), "utf8");
        assert.ok(seen.includes(argPath), `shim saw "${seen}" — spaced arg must survive intact`);
        assert.ok(seen.includes("-e"), "flag survives too");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("#679 real win32: spaced .exe spawns directly with spaced argv", { skip: process.platform !== "win32" }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-679-"));
    try {
        const outDir = path.join(root, "out dir");
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, "argv.json");
        const script = `require("fs").writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(process.argv))`;
        // node -e consumes the script string (it never lands in process.argv); a
        // trailing arg does. The marker carries spaces AND quotes, so surviving
        // the round-trip proves direct-spawn quoting on win32.
        const marker = 'MARK spaced "quoted" arg';
        const code = await runClient(process.execPath, ["-e", script, marker], process.env);
        assert.equal(code, 0);
        const argv = JSON.parse(fs.readFileSync(outFile, "utf8")) as string[];
        assert.equal(argv.length, 2);
        assert.equal(argv[0], process.execPath);
        assert.equal(argv[1], marker, "spaced+quoted arg must round-trip intact");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
