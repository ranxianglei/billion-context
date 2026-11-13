// #4829: the fork-adoption body-parse gate must see through supported
// content-encodings. The Codex SSE transport (pi-ai) ships zstd-compressed
// Uint8Array request bodies with a content-encoding header; the old
// plain-text-only parser failed them all, so seeded fork children of long
// compressed conversations could NEVER adopt — resume-inheritance miss →
// multi-million-token preflight compression → client disconnects before the
// model request is forwarded. Pins both directions (#3617): encoded bodies
// reach the adopter protocol, undecodable or unsupported encodings still hit
// the body-parse gate exactly once, and plain-text behavior is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { _maybeForkAdoptBeforeSendForTest, _resetForkGateDiagnosticsForTest, _resetRegisterForTest, type PluginContext } from "../src/agent/dsh-native.ts";
import { resetForkCapabilityCacheForTest } from "../src/agent/fork-adopt.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-issue4829-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;
const logFile = join(testRoot, "billion-context", "bili.log");

// Each positive test needs its OWN child sid: the adopter marks a child done
// after its first terminal outcome, and a later test reusing the sid would be
// silently dropped by the done-set (zero log lines).
function ctxSeeded(sid = "child-sid"): PluginContext {
    return {
        tools: { register: () => undefined },
        commands: { register: () => undefined },
        agents: { currentInitiator: () => ({ session: { id: sid, header: { isSeeded: true, parentSession: "parent-sid" } } }) },
    };
}

const GATE_LINE = /fork adoption for .* (skipped at the \S+ gate|deferred for a side-shaped request)/;

// A main-shaped openai body (tools present, no tiny budget) so only the
// body-parse gate can block adoption.
const mainBody = JSON.stringify({
    model: "gpt-test",
    messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
    ],
    tools: [{ type: "function", function: { name: "bash", description: "d", parameters: { type: "object", properties: {} } } }],
});

function freshScenario(base: string | undefined, toolsReady: boolean): void {
    _resetRegisterForTest(base, toolsReady);
    _resetForkGateDiagnosticsForTest();
    resetForkCapabilityCacheForTest();
    fs.rmSync(logFile, { force: true });
}

function logLines(): string[] {
    try {
        return fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.length > 0);
    } catch {
        return [];
    }
}

// Drive one seeded-child dispatch against a mock proxy that answers every
// route with an empty-capabilities manifest — reaching that manifest probe is
// proof the body passed the parse gate into the adopter protocol (#4215's
// side-shape test uses the same sentinel: "does not advertise the fork
// capability").
async function runAgainstMockProxy(sid: string, init: RequestInit): Promise<string[]> {
    const srv = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ capabilities: {} })); });
    srv.listen(0, "127.0.0.1");
    await once(srv, "listening");
    const addr = srv.address();
    assert(addr && typeof addr === "object");
    try {
        _resetRegisterForTest(`http://127.0.0.1:${addr.port}`, true);
        await _maybeForkAdoptBeforeSendForTest(ctxSeeded(sid), init);
    } finally {
        srv.close();
        srv.closeAllConnections?.();
        await once(srv, "close").catch(() => undefined);
    }
    return logLines();
}

test("zstd-compressed body reaches the adopter protocol (#4829)", async (t) => {
    // The production shape: pi-ai hands fetch a Headers instance + a
    // zstd-compressed Uint8Array body.
    const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync;
    if (typeof zstdCompressSync !== "function") {
        t.skip("native zlib zstd unavailable on this Node build");
        return;
    }
    freshScenario(undefined, true);
    const lines = await runAgainstMockProxy("child-zstd", {
        headers: new Headers({ "content-encoding": "zstd" }),
        body: new Uint8Array(zstdCompressSync(Buffer.from(mainBody))),
    });
    assert.equal(lines.filter((l) => GATE_LINE.test(l)).length, 0, JSON.stringify(lines));
    assert.equal(lines.filter((l) => /does not advertise the fork capability/.test(l)).length, 1, JSON.stringify(lines));
});

test("gzip-compressed body reaches the adopter protocol (#4829)", async () => {
    freshScenario(undefined, true);
    const lines = await runAgainstMockProxy("child-gzip", {
        headers: { "content-encoding": "gzip" },
        body: new Uint8Array(zlib.gzipSync(Buffer.from(mainBody))),
    });
    assert.equal(lines.filter((l) => GATE_LINE.test(l)).length, 0, JSON.stringify(lines));
    assert.equal(lines.filter((l) => /does not advertise the fork capability/.test(l)).length, 1, JSON.stringify(lines));
});

test("undecodable bytes under a supported coding still hit the body-parse gate (#4829 negative)", async () => {
    freshScenario("http://proxy.invalid", true);
    await _maybeForkAdoptBeforeSendForTest(ctxSeeded(), {
        headers: new Headers({ "content-encoding": "zstd" }),
        body: new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xde, 0xad, 0xbe, 0xef]),
    });
    const lines = logLines();
    assert.equal(lines.filter((l) => GATE_LINE.test(l)).length, 1, JSON.stringify(lines));
    assert.match(lines[0]!, /\[warn\].*skipped at the body-parse gate/);
});

test("unsupported coding hits the body-parse gate without guessing (#4829 negative)", async () => {
    freshScenario("http://proxy.invalid", true);
    await _maybeForkAdoptBeforeSendForTest(ctxSeeded(), {
        headers: [["Content-Encoding", "foo"]],
        body: new Uint8Array(Buffer.from(mainBody)),
    });
    const lines = logLines();
    assert.equal(lines.filter((l) => GATE_LINE.test(l)).length, 1, JSON.stringify(lines));
    assert.match(lines[0]!, /\[warn\].*skipped at the body-parse gate/);
});

test("plain-text failures keep hitting the body-parse gate with the updated message (#4829)", async () => {
    freshScenario("http://proxy.invalid", true);
    await _maybeForkAdoptBeforeSendForTest(ctxSeeded(), { body: "not-json" });
    let lines = logLines();
    assert.equal(lines.filter((l) => GATE_LINE.test(l)).length, 1, JSON.stringify(lines));
    assert.match(lines[0]!, /\[warn\].*skipped at the body-parse gate.*after content-encoding decode/);
    // a missing body hits the same gate and does not re-log per shape
    await _maybeForkAdoptBeforeSendForTest(ctxSeeded(), undefined);
    lines = logLines();
    assert.equal(lines.filter((l) => GATE_LINE.test(l)).length, 1);
});
