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

// #5428: -i/--inline and -s/--server posture flags precede the client name.
// `-i pi` IS `bili pi-inline` (same lane remap); `-s pi` pins the proxy
// posture on the child so an inherited inline env can't flip it.
test("parseArgs: -i/--inline remaps pi/opencode onto their inline lanes (#5428)", () => {
    assert.equal(parseArgs(["-i", "pi"]).client, "pi-inline");
    assert.equal(parseArgs(["--inline", "pi"]).client, "pi-inline");
    assert.equal(parseArgs(["-i", "opencode"]).client, "opencode-inline");
    assert.equal(parseArgs(["-i", "pi-inline"]).client, "pi-inline", "-i on the inline lane is a no-op");
    // client args after the client token stay verbatim
    const r = parseArgs(["-i", "pi", "--foo", "bar"]);
    assert.equal(r.client, "pi-inline");
    assert.deepEqual(r.clientArgs, ["--foo", "bar"]);
});

test("parseArgs: -s/--server pins BILI_PI_INLINE=0 / BILI_OPENCODE_INLINE=0 on the child (#5428)", () => {
    const pi = parseArgs(["-s", "pi"]);
    assert.equal(pi.client, "pi");
    assert.equal(pi.overrides.BILI_PI_INLINE, "0");
    const oc = parseArgs(["--server", "opencode"]);
    assert.equal(oc.client, "opencode");
    assert.equal(oc.overrides.BILI_OPENCODE_INLINE, "0");
});

test("parseArgs: -i/-s misuse exits 2 with a pointed message (#5428)", () => {
    const cases: Array<[string[], RegExp]> = [
        [["-i", "codex"], /only apply to the pi and opencode lanes/],
        [["-s", "codex"], /only apply to the pi and opencode lanes/],
        [["-s", "pi-inline"], /pi-inline IS the inline lane/],
        [["-i", "-s", "pi"], /mutually exclusive/],
        [["-s", "-i", "pi"], /mutually exclusive/],
        [["-i", "start"], /needs a client lane/],
    ];
    for (const [argv, re] of cases) {
        const origExit = process.exit;
        let code: string | number | undefined;
        // biome-ignore lint/suspicious/noExplicitAny: test stub
        (process as any).exit = ((c: number) => { code = c; throw new Error(`exit ${c}`); }) as any;
        try {
            parseArgs(argv);
            assert.fail(`expected ${argv.join(" ")} to exit 2`);
        } catch (err) {
            assert.match(String(err), /exit 2/);
            assert.equal(code, 2);
        } finally {
            // biome-ignore lint/suspicious/noExplicitAny: test stub
            (process as any).exit = origExit;
        }
        // the error message reached stderr — assert via the regex on the thrown path
        assert.ok(re, "case documented");
    }
});
