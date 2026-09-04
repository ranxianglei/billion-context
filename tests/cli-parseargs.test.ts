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

// #521: internal `daemon` subcommand used by bili agent plugins (dsh native).
test("parseArgs: daemon subcommand flags (#521)", () => {
    const r = parseArgs(["daemon", "--fresh", "--json", "--parent-pid", "42"]);
    assert.equal(r.command, "daemon");
    assert.equal(r.daemonFresh, true);
    assert.equal(r.daemonJson, true);
    assert.equal(r.daemonParentPid, "42");
});

test("parseArgs: daemon without flags parses as plain command (#521)", () => {
    const r = parseArgs(["daemon"]);
    assert.equal(r.command, "daemon");
    assert.equal(r.daemonFresh, false);
    assert.equal(r.daemonParentPid, undefined);
});
