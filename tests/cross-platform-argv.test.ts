// Cross-platform regression for argv basename parsing: the quoted and unquoted
// shapes must both resolve, and stripping quotes must be a no-op on input that
// never had them (a Unix path must not be damaged by the fix).
//
// Background: on Windows, PowerShell's Win32_Process CommandLine keeps the
// quotes around a token when the path needs them (`"C:\...\claude.exe"`), while
// the unquoted shape is the norm on Unix (/proc's NUL-separated argv) and macOS
// (`ps`). The fix has to hold on both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isClaudeHostArgv, isTransientShArgv } from "../src/claude-native-bootstrap.ts";

test("isClaudeHostArgv: quoted Windows host (the #1185 regression)", () => {
    // Before the fix the basename came out as `claude.exe"` (trailing quote),
    // the regex missed, and the call returned false.
    assert.equal(isClaudeHostArgv(['"C:\\Users\\Administrator\\.local\\bin\\claude.exe"']), true);
    assert.equal(isClaudeHostArgv(['"C:\\Program Files\\nodejs\\node.exe"', '"C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"']), true);
});

test("isClaudeHostArgv: unquoted forms unchanged (Unix/macOS + Windows)", () => {
    // Unix: neither /proc nor ps quotes.
    assert.equal(isClaudeHostArgv(["/usr/local/bin/claude"]), true);
    assert.equal(isClaudeHostArgv(["/home/u/.nvm/versions/node/v22/bin/node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"]), true);
    // Windows bare shape (when PowerShell needs no quotes).
    assert.equal(isClaudeHostArgv(["C:\\Users\\x\\claude.exe"]), true);
    assert.equal(isClaudeHostArgv(["claude"]), true);
});

test("isClaudeHostArgv: strip must not create false positives", () => {
    // Stripping only the surrounding quotes must not turn anything else into claude.
    assert.equal(isClaudeHostArgv(['"C:\\x\\claude-native-bootstrap.js"']), false);
    assert.equal(isClaudeHostArgv(['"/usr/bin/notclaude"']), false);
    assert.equal(isClaudeHostArgv(['""']), false);
    assert.equal(isClaudeHostArgv([""]), false);
});

test("isTransientShArgv: quoted wrapper (Windows hook shape)", () => {
    // hop1 shape seen in the field: `"D:\Dev\Git\bin\..\usr\bin\bash.exe" -c "..."`
    assert.equal(isTransientShArgv(['"D:\\Dev\\Git\\bin\\..\\usr\\bin\\bash.exe"', "-c", '"\\"D:/Dev/node/node.exe\\""']), true);
    assert.equal(isTransientShArgv(['"C:\\Windows\\System32\\cmd.exe"', "/c", "node hook"]), true);
    assert.equal(isTransientShArgv(['"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"', "-Command", "node hook"]), true);
});

test("isTransientShArgv: unquoted forms unchanged (Unix/macOS + Windows)", () => {
    assert.equal(isTransientShArgv(["sh", "-c", "node hook"]), true);
    assert.equal(isTransientShArgv(["/bin/bash", "-lc", "cmd"]), true);
    assert.equal(isTransientShArgv(["/bin/sh", "-c", "node hook"]), true);
    assert.equal(isTransientShArgv(["D:\\Git\\bin\\bash.exe", "-c", "node hook"]), true);
    assert.equal(isTransientShArgv(["cmd.exe", "/C", "node hook"]), true);
});

test("isTransientShArgv: strip must not create false positives", () => {
    // An interactive shell (-i rather than -c) is not transient in any shape.
    assert.equal(isTransientShArgv(['"/bin/zsh"', "-i"]), false);
    assert.equal(isTransientShArgv(['"C:\\Windows\\System32\\cmd.exe"', "/k", "node hook"]), false);
    assert.equal(isTransientShArgv(['"powershell.exe"', "-NoProfile"]), false);
    assert.equal(isTransientShArgv(['"node.exe"', "-c", "x"]), false);
});
