import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isOursSessionStartEntry, portableHookCommand } from "../src/plugin-install.ts";

// The SessionStart hook is the one place bili hands a client a SHELL STRING
// rather than an argv array, so the client's shell re-parses our path. The unit
// tests pin the exact spelling; the integration tests below run the produced
// command through every shell the platform actually has, so a "fix" that only
// looks right on paper fails here. See portableHookCommand for the traps.

const EXE = "D:\\Dev\\node\\node.exe";
const JS = "C:\\Users\\u\\AppData\\Local\\Temp\\bili\\claude-native-bootstrap.js";

test("portableHookCommand: plain paths emit a bare token and an unquoted argument", () => {
    assert.equal(
        portableHookCommand(EXE, [JS]),
        "D:/Dev/node/node.exe C:/Users/u/AppData/Local/Temp/bili/claude-native-bootstrap.js",
    );
});

test("portableHookCommand: no backslash survives into the command line", () => {
    // The escape-eating is the bug; assert on the whole emitted string rather
    // than on the pieces, so a future refactor cannot reintroduce one.
    for (const cmd of [
        portableHookCommand(EXE, [JS]),
        portableHookCommand("C:\\Program Files\\nodejs\\node.exe", [JS]),
        portableHookCommand(EXE, ["C:\\a b\\c\\bootstrap.js"]),
        portableHookCommand("C:\\Program Files\\nodejs\\node.exe", ["C:\\a b\\c\\bootstrap.js"]),
    ]) {
        assert.ok(!cmd.includes("\\"), cmd);
    }
});

test("portableHookCommand: an argument with whitespace is quoted (safe in bash, PowerShell and cmd)", () => {
    assert.equal(
        portableHookCommand(EXE, ["C:\\Program Files\\bili\\bootstrap.js"]),
        'D:/Dev/node/node.exe "C:/Program Files/bili/bootstrap.js"',
    );
});

test("portableHookCommand: a command path with whitespace falls back to the & call operator", () => {
    // No spelling covers a spaced command path in all three shells. `&` is what
    // PowerShell needs, and PowerShell is what runs Claude Code's hooks on
    // Windows (see the probe test below).
    assert.equal(
        portableHookCommand("C:\\Program Files\\nodejs\\node.exe", [JS]),
        '& "C:/Program Files/nodejs/node.exe" C:/Users/u/AppData/Local/Temp/bili/claude-native-bootstrap.js',
    );
    assert.equal(
        portableHookCommand("C:\\Program Files\\nodejs\\node.exe", ["C:\\a b\\c.js"]),
        '& "C:/Program Files/nodejs/node.exe" "C:/a b/c.js"',
    );
});

test("portableHookCommand: no arguments, and the bare `node` the kimi hook uses", () => {
    assert.equal(portableHookCommand("node"), "node");
    // The kimi hook resolves `node` through PATH, so it can never need `&` —
    // the one shell the fallback would break (cmd) never sees a spaced command.
    const kimi = portableHookCommand("node", ["C:\\Users\\u\\.kimi\\plugins\\managed\\billion-context\\dist\\kimi\\bootstrap-hook.js"]);
    assert.equal(kimi, "node C:/Users/u/.kimi/plugins/managed/billion-context/dist/kimi/bootstrap-hook.js");
    assert.ok(!kimi.startsWith("& "), kimi);
});

test("isOursSessionStartEntry still matches every form the installer can emit", () => {
    // Uninstall/reinstall detection keys off this regex; if it drifts from the
    // emitted spelling, bili stops recognizing its own hook and leaves orphans.
    const entry = (cmd: string) => ({ hooks: [{ command: cmd }] });
    for (const cmd of [
        portableHookCommand(EXE, [JS]),
        portableHookCommand(EXE, ["C:\\a b\\c\\claude-native-bootstrap.js"]),
        portableHookCommand("C:\\Program Files\\nodejs\\node.exe", ["C:\\a b\\c\\claude-native-bootstrap.js"]),
    ]) {
        assert.equal(isOursSessionStartEntry(entry(cmd)), true, cmd);
    }
    assert.equal(isOursSessionStartEntry({ hooks: [{ command: "echo hi" }] }), false);
});

interface Shell {
    name: string;
    exe: string;
    wrap: (command: string) => string[];
    /** cmd.exe must receive the hook line VERBATIM: Node re-quotes any argv
     *  element containing spaces with `\"`, which cmd does not unescape, so the
     *  default path measures this harness instead of cmd. PowerShell takes the
     *  line as a single `-Command` argument and needs the normal quoting. */
    verbatim?: boolean;
}

/** Every shell that can plausibly run a hook on this platform. Order is
 *  irrelevant; each is skipped individually when its binary is absent. */
function platformShells(): Shell[] {
    if (process.platform === "win32") {
        const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
        const ps = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        return [
            { name: "powershell", exe: fs.existsSync(ps) ? ps : "powershell.exe", wrap: (c) => ["-NoProfile", "-NonInteractive", "-Command", c] },
            { name: "cmd", exe: process.env.ComSpec ?? "cmd.exe", wrap: (c) => ["/d", "/c", c], verbatim: true },
        ];
    }
    return [
        { name: "sh", exe: "sh", wrap: (c) => ["-c", c] },
        { name: "bash", exe: "bash", wrap: (c) => ["-c", c] },
    ];
}

function runInShell(shell: Shell, command: string): { status: number | null; out: string; missing: boolean } {
    const r = spawnSync(shell.exe, shell.wrap(command), {
        encoding: "utf8",
        windowsHide: true,
        windowsVerbatimArguments: shell.verbatim === true,
    });
    return {
        status: r.status,
        out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
        missing: r.error !== undefined && (r.error as NodeJS.ErrnoException).code === "ENOENT",
    };
}

test("the emitted command really runs: bare token + spaced argument, through every shell here", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-hookcmd-"));
    // A space in the directory name forces the argument to be quoted — the
    // common real case, since Windows temp paths and usernames both carry them.
    const dir = path.join(root, "probe dir");
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, "hook-probe.js");
    fs.writeFileSync(probe, "process.stdout.write('HOOKOK');");
    try {
        const command = portableHookCommand(process.execPath, [probe]);
        assert.ok(!command.includes("\\"), command);
        const ran: string[] = [];
        for (const shell of platformShells()) {
            const r = runInShell(shell, command);
            if (r.missing) continue;
            assert.equal(r.status, 0, `${shell.name} exited ${r.status} for: ${command}\n${r.out}`);
            assert.match(r.out, /HOOKOK/, `${shell.name} did not run the probe: ${command}\n${r.out}`);
            ran.push(shell.name);
        }
        assert.ok(ran.length > 0, "no shell available to verify against");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("the & fallback really runs under PowerShell", { skip: process.platform !== "win32" }, () => {
    const ps = platformShells().find((s) => s.name === "powershell");
    assert.ok(ps, "powershell entry missing");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-hookamp-"));
    try {
        // A spaced directory holding a runnable stands in for a node.exe
        // installed under `C:\Program Files` — same shape, no 100MB copy.
        const dir = path.join(root, "Program Files dir");
        fs.mkdirSync(dir, { recursive: true });
        const shim = path.join(dir, "hook-probe.cmd");
        fs.writeFileSync(shim, "@echo off\r\necho HOOKOK\r\n");
        const command = portableHookCommand(shim, []);
        assert.ok(command.startsWith('& "'), command);
        const r = runInShell(ps, command);
        assert.equal(r.status, 0, `${r.status} for: ${command}\n${r.out}`);
        assert.match(r.out, /HOOKOK/, `${command}\n${r.out}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
