import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.ts";

// #346: the gost-style `-F <url>` (forward) flag sets bili's upstream proxy.
// bili flags must precede the client name; everything after the client name is
// forwarded to the client.

test("parseArgs: -F before the client sets BILI_UPSTREAM_PROXY (#346)", () => {
    const r = parseArgs(["-F", "http://127.0.0.1:7897", "codex"]);
    assert.equal(r.client, "codex");
    assert.equal(r.overrides.BILI_UPSTREAM_PROXY, "http://127.0.0.1:7897");
    assert.deepEqual(r.clientArgs, []);
});

test("parseArgs: -F after the client is forwarded to the client, not bili (#346)", () => {
    const r = parseArgs(["codex", "-F", "http://127.0.0.1:7897"]);
    assert.equal(r.client, "codex");
    assert.equal(r.overrides.BILI_UPSTREAM_PROXY, undefined);
    assert.deepEqual(r.clientArgs, ["-F", "http://127.0.0.1:7897"]);
});

test("parseArgs: -F works for the start command too (#346)", () => {
    const r = parseArgs(["-F", "http://127.0.0.1:7897", "start"]);
    assert.equal(r.command, "start");
    assert.equal(r.overrides.BILI_UPSTREAM_PROXY, "http://127.0.0.1:7897");
});

test("parseArgs: -F composes with other bili flags before the client (#346)", () => {
    const r = parseArgs(["--port", "9000", "-F", "http://127.0.0.1:7897", "pi"]);
    assert.equal(r.client, "pi");
    assert.equal(r.overrides.ACP_PORT, "9000");
    assert.equal(r.overrides.BILI_UPSTREAM_PROXY, "http://127.0.0.1:7897");
    assert.deepEqual(r.clientArgs, []);
});

test("parseArgs: acp-cache diff takes dump-dir and its flags (#1266)", () => {
    const r = parseArgs(["acp-cache", "diff", "/some/dir", "--json", "--log", "/x/log", "--session", "abc"]);
    assert.equal(r.command, "acp-cache");
    assert.equal(r.acpCacheDir, "/some/dir");
    assert.equal(r.jsonOutput, true);
    assert.equal(r.acpCacheLog, "/x/log");
    assert.equal(r.acpCacheSession, "abc");
});

test("parseArgs: acp-cache diff --no-log (#1266)", () => {
    const r = parseArgs(["acp-cache", "diff", "/some/dir", "--no-log"]);
    assert.equal(r.command, "acp-cache");
    assert.equal(r.acpCacheDir, "/some/dir");
    assert.equal(r.acpCacheNoLog, true);
});

// #1235: `bili doctor` is a first-class command; --json selects the
// machine-readable report.
test("parseArgs: doctor is a command and --json sets doctorJson (#1235)", () => {
    const r = parseArgs(["doctor"]);
    assert.equal(r.command, "doctor");
    assert.equal(r.doctorJson, false);
    assert.equal(r.doctorFix, false, "#3496: --fix off by default — plain doctor stays read-only");
    const j = parseArgs(["--json", "doctor"]);
    assert.equal(j.command, "doctor");
    assert.equal(j.doctorJson, true);
    const f = parseArgs(["doctor", "--fix"]);
    assert.equal(f.command, "doctor");
    assert.equal(f.doctorFix, true);
});

test("parseArgs: informational flags take precedence over subcommand dispatch (#5606)", () => {
    const commands = [
        ["start"], ["update"], ["doctor"], ["export"], ["plugin-register", "example"],
        ["mcp"], ["plugin", "list"], ["plugin", "remove", "codex"], ["test", "codex"],
        ["acp-cache", "diff", "/some/dir"], ["sessions", "ls"], ["sessions", "rm", "example"],
        ["storage", "gc"],
    ];
    for (const [flag, expected] of [["--help", "help"], ["-h", "help"], ["--version", "version"], ["-V", "version"]] as const) {
        for (const args of commands) {
            for (const argv of [[flag, ...args], [...args, flag]]) {
                assert.equal(parseArgs(argv).command, expected, argv.join(" "));
            }
        }
    }
});

test("parseArgs: informational flags bypass incomplete subcommand validation (#5606)", () => {
    for (const args of [["plugin"], ["plugin", "remove"], ["test"], ["acp-cache"], ["acp-cache", "diff"], ["sessions"], ["sessions", "rm"], ["storage"]]) {
        for (const [flag, expected] of [["--help", "help"], ["--version", "version"]] as const) {
            assert.equal(parseArgs([...args, flag]).command, expected, [...args, flag].join(" "));
        }
    }
});

test("parseArgs: launcher flags stay with the client, bili flags stay before it (#5606)", () => {
    for (const flag of ["--help", "-h", "--version", "-V"]) {
        const forwarded = parseArgs(["codex", flag]);
        assert.equal(forwarded.command, "launch");
        assert.deepEqual(forwarded.clientArgs, [flag]);
        assert.equal(parseArgs([flag, "codex"]).command, flag === "--help" || flag === "-h" ? "help" : "version");
    }
    assert.equal(parseArgs(["export", "--output", "--help"]).command, "export");
    assert.equal(parseArgs(["export", "--output", "--help"]).exportOutput, "--help");
});
