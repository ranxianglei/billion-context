// #1377: Windows PowerShell Win32_Process.CommandLine keeps the surrounding
// quotes on a token whose path needs them (e.g. `"C:\Users\...\claude.exe"`).
// The basename + flag matching used to see a trailing quote (`claude.exe"`)
// and miss BOTH the claude host and the transient sh wrapper, so the watchdog
// watched the dying wrapper and the proxy self-killed ~8s into every session.
// These pin that quoted AND clean argv shapes resolve identically, and that
// quote-stripping creates no false positive (the hook's own script, lookalikes
// and empty names must still be rejected). Pure functions — run on every OS.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    chooseWatchdogParentPid,
    isClaudeHostArgv,
    isTransientShArgv,
    resolveClaudeHostPid,
} from "../src/claude-native-bootstrap.ts";

type Table = Record<number, { argv?: string[]; ppid?: number }>;
function procTable(table: Table): (pid: number) => { argv: string[] | null; ppid: number | null } | null {
    return (pid) => {
        const entry = table[pid];
        if (entry === undefined) return null;
        return { argv: entry.argv ?? null, ppid: entry.ppid ?? null };
    };
}

test("isClaudeHostArgv: quoted Windows CommandLine resolves claude", () => {
    // Exact shape from the diagnostic dump (#1377): the whole path token keeps
    // its surrounding double quotes.
    assert.equal(isClaudeHostArgv(['"C:\\Users\\Administrator\\.local\\bin\\claude.exe"']), true);
    assert.equal(isClaudeHostArgv(['"claude.exe"']), true);
    // Quoted node-form install: node.exe .../@anthropic-ai/claude-code/cli.js.
    assert.equal(isClaudeHostArgv(['"D:\\Dev\\node\\node.exe"', "C:\\x\\node_modules\\@anthropic-ai\\claude-code\\cli.js"]), true);
    // A quoted bare `claude` argument under a quoted node runtime.
    assert.equal(isClaudeHostArgv(['"D:\\Dev\\node\\node.exe"', '"claude"']), true);
});

test("isClaudeHostArgv: unquoted (clean) argv still resolves claude", () => {
    assert.equal(isClaudeHostArgv(["C:\\Users\\x\\.local\\bin\\claude.exe"]), true);
    assert.equal(isClaudeHostArgv(["claude"]), true);
    assert.equal(isClaudeHostArgv([process.execPath, "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"]), true);
});

test("isClaudeHostArgv: quote-stripping creates no false positive", () => {
    // The hook's own script must never match — quoted or not.
    assert.equal(isClaudeHostArgv(['"D:\\Dev\\node\\node.exe"', '".../dist/claude-native-bootstrap.js"']), false);
    assert.equal(isClaudeHostArgv([process.execPath, "/pkg/dist/claude-native-bootstrap.js"]), false);
    // Lookalikes and empty names stay rejected once the quotes are gone.
    assert.equal(isClaudeHostArgv(['"notclaude.exe"']), false);
    assert.equal(isClaudeHostArgv(['"claudeworkflow"']), false);
    assert.equal(isClaudeHostArgv(['""']), false);
    assert.equal(isClaudeHostArgv([]), false);
    // Unrelated node path that merely contains "claude" must not match.
    assert.equal(isClaudeHostArgv(['"D:\\Dev\\node\\node.exe"', '"C:\\home\\x\\claude-notes\\server.js"']), false);
});

test("isTransientShArgv: quoted Windows one-shot wrappers resolve", () => {
    // bash -c wrapper with a quoted path (the user's hop1).
    assert.equal(isTransientShArgv(['"D:\\Dev\\Git\\bin\\..\\usr\\bin\\bash.exe"', "-c", "node hook"]), true);
    // cmd /c and powershell -Command with quoted paths.
    assert.equal(isTransientShArgv(['"C:\\Windows\\System32\\cmd.exe"', "/c", "node hook"]), true);
    assert.equal(isTransientShArgv(['"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"', "-NoProfile", "-Command", "node hook"]), true);
    // Quoted flag cluster (-lc).
    assert.equal(isTransientShArgv(['"D:\\Git\\bin\\bash.exe"', '"-lc"', "cmd"]), true);
});

test("isTransientShArgv: quoted non-transient / non-shell stays false", () => {
    // /k stays open (interactive) — even quoted.
    assert.equal(isTransientShArgv(['"C:\\Windows\\System32\\cmd.exe"', "/k", "node hook"]), false);
    // Interactive shell, no -c.
    assert.equal(isTransientShArgv(['"D:\\Git\\bin\\bash.exe"', "-i"]), false);
    // Not a shell at all.
    assert.equal(isTransientShArgv(['"D:\\Dev\\node\\node.exe"', "-c", "x"]), false);
    assert.equal(isTransientShArgv([]), false);
});

test("resolveClaudeHostPid: walks the user's quoted Windows chain to claude", () => {
    // hop0 hook(node) -> hop1 bash -c -> hop2 bash -> hop3 claude.exe -> hop4 powershell.
    const read = procTable({
        19492: { argv: ['"D:\\Dev\\node\\node.exe"', ".../dist/claude-native-bootstrap.js"], ppid: 26304 },
        26304: { argv: ['"D:\\Dev\\Git\\bin\\..\\usr\\bin\\bash.exe"', "-c", "node .../claude-native-bootstrap.js"], ppid: 25204 },
        25204: { argv: ["D:\\Dev\\Git\\bin\\bash.exe", "-c", "..."], ppid: 4364 },
        4364: { argv: ['"C:\\Users\\Administrator\\.local\\bin\\claude.exe"'], ppid: 460 },
        460: { argv: ['"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"', "-NoLogo", "-NoExit"], ppid: 9284 },
    });
    assert.equal(resolveClaudeHostPid({ read, startPid: 19492 }), 4364);
});

test("chooseWatchdogParentPid: quoted Windows chain → watches claude, not the wrapper", () => {
    // Before #1377 the walk found no host and the direct parent (the wrapper
    // bash) was kept → the ~8s self-kill. Now it resolves the claude host.
    const read = procTable({
        [process.pid]: { argv: ['"D:\\Dev\\node\\node.exe"', ".../claude-native-bootstrap.js"], ppid: 26304 },
        26304: { argv: ['"D:\\Dev\\Git\\bin\\..\\usr\\bin\\bash.exe"', "-c", "node .../claude-native-bootstrap.js"], ppid: 25204 },
        25204: { argv: ["D:\\Dev\\Git\\bin\\bash.exe", "-c", "..."], ppid: 4364 },
        4364: { argv: ['"C:\\Users\\Administrator\\.local\\bin\\claude.exe"'], ppid: 460 },
    });
    assert.equal(chooseWatchdogParentPid({ read, parentPid: 26304 }), 4364);
});

test("chooseWatchdogParentPid: no host + quoted transient wrapper parent → grandparent", () => {
    // resolveClaudeHostPid finds nothing (600 is not claude); the direct
    // parent 500 is a QUOTED transient bash -c → watch its parent 600 instead
    // of re-arming the self-kill on the wrapper.
    const read = procTable({
        [process.pid]: { argv: ['"D:\\Dev\\node\\node.exe"', "hook"], ppid: 500 },
        500: { argv: ['"D:\\Git\\bin\\bash.exe"', "-c", "node hook"], ppid: 600 },
        600: { argv: ["some-other-launcher"], ppid: 1 },
    });
    assert.equal(chooseWatchdogParentPid({ read, parentPid: 500 }), 600);
});
