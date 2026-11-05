// #4215/C10a: every skipped fork-adoption entry gate must name itself. The
// incident (seeded child with the correct parentSession, ZERO adoption trace
// in the whole log) made "not a fork" vs "a fork we could not see"
// unanswerable from the log. This suite pins both directions of every gate
// (#3617 discipline): the skip line fires when it should, exactly once, and
// plain non-fork traffic stays completely silent.
import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkChildVerdict, _maybeForkAdoptBeforeSendForTest, _resetForkGateDiagnosticsForTest, _resetRegisterForTest, type ForkChildVerdict, type PluginContext } from "../src/agent/dsh-native.ts";
import { resetForkCapabilityCacheForTest } from "../src/agent/fork-adopt.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-issue4215-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;
const logFile = join(testRoot, "billion-context", "bili.log");

type SessionShape = { id?: unknown; header?: { parentSession?: unknown; isSeeded?: unknown } };
type AgentShape = { session?: SessionShape };

function ctxWithInitiator(fn: () => AgentShape | undefined): PluginContext {
    return {
        tools: { register: () => undefined },
        commands: { register: () => undefined },
        agents: { currentInitiator: fn },
    };
}

const ctxNoAgents = (): PluginContext => ({ tools: { register: () => undefined }, commands: { register: () => undefined }, agents: {} });
const ctxNoInitiator = (): PluginContext => ctxWithInitiator(() => undefined);
const ctxThrowing = (): PluginContext => ctxWithInitiator(() => { throw new Error("disposed scope"); });
const ctxPlain = (): PluginContext => ctxWithInitiator(() => ({ session: { id: "plain-sid", header: {} } }));
const ctxSubagent = (): PluginContext => ctxWithInitiator(() => ({ session: { id: "sub-sid", header: { parentSession: "p1", isSeeded: false } } }));
const ctxSeeded = (): PluginContext => ctxWithInitiator(() => ({ session: { id: "child-sid", header: { isSeeded: true, parentSession: "parent-sid" } } }));

const validInit: RequestInit = { body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) };

function freshScenario(base: string | undefined, toolsReady: boolean): void {
    _resetRegisterForTest(base, toolsReady);
    _resetForkGateDiagnosticsForTest();
    fs.rmSync(logFile, { force: true });
}

function logLines(): string[] {
    try {
        return fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.length > 0);
    } catch {
        return [];
    }
}

const GATE_LINE = /fork adoption for .* (skipped at the \S+ gate|deferred for a side-shaped request)/;

test("forkChildVerdict names every shape (#4215)", () => {
    const cases: Array<[string, () => PluginContext, ForkChildVerdict]> = [
        ["threw", ctxThrowing, { ok: false, reason: "initiator-threw", detail: "disposed scope" }],
        ["missing-initiator", ctxNoInitiator, { ok: false, reason: "initiator-missing" }],
        ["no-initiator-accessor", ctxNoAgents, { ok: false, reason: "initiator-missing" }],
        ["agent-no-session", () => ctxWithInitiator(() => ({})), { ok: false, reason: "session-missing" }],
        ["session-no-id", () => ctxWithInitiator(() => ({ session: {} })), { ok: false, reason: "sid-missing" }],
        ["session-bad-id", () => ctxWithInitiator(() => ({ session: { id: 42 } })), { ok: false, reason: "sid-missing" }],
        ["session-empty-id", () => ctxWithInitiator(() => ({ session: { id: "" } })), { ok: false, reason: "sid-missing" }],
        ["no-header", () => ctxWithInitiator(() => ({ session: { id: "s1" } })), { ok: false, reason: "header-missing", sid: "s1" }],
        ["plain-session", ctxPlain, { ok: false, reason: "not-seeded", sid: "plain-sid" }],
        ["subagent-carries-parent-without-isSeeded", ctxSubagent, { ok: false, reason: "not-seeded", sid: "sub-sid" }],
        ["seeded-no-parent", () => ctxWithInitiator(() => ({ session: { id: "s1", header: { isSeeded: true } } })), { ok: false, reason: "parent-missing", sid: "s1" }],
        ["seeded-empty-parent", () => ctxWithInitiator(() => ({ session: { id: "s1", header: { isSeeded: true, parentSession: "" } } })), { ok: false, reason: "parent-missing", sid: "s1" }],
        ["seeded-non-string-parent", () => ctxWithInitiator(() => ({ session: { id: "s1", header: { isSeeded: true, parentSession: 7 } } })), { ok: false, reason: "parent-missing", sid: "s1" }],
        ["seeded-self-parent", () => ctxWithInitiator(() => ({ session: { id: "s1", header: { isSeeded: true, parentSession: "s1" } } })), { ok: false, reason: "parent-is-self", sid: "s1" }],
        ["ok", ctxSeeded, { ok: true, sid: "child-sid", parent: "parent-sid" }],
    ];
    for (const [name, make, expected] of cases) {
        assert.deepEqual(forkChildVerdict(make()), expected, name);
    }
});

test("seeded child blocked at tools-ready: one warn naming the gate; repeats stay one (#4215)", async () => {
    freshScenario("http://proxy.invalid", false);
    await _maybeForkAdoptBeforeSendForTest(ctxSeeded(), validInit);
    let lines = logLines();
    assert.equal(lines.filter((l) => GATE_LINE.test(l)).length, 1, JSON.stringify(lines));
    assert.match(lines[0]!, /\[warn\].*bili-native-dsh: fork adoption for child-sid skipped at the tools-ready gate.*#4215/);
    await _maybeForkAdoptBeforeSendForTest(ctxSeeded(), validInit);
    lines = logLines();
    assert.equal(lines.filter((l) => GATE_LINE.test(l)).length, 1, "throttle holds across requests");
});

test("seeded child with unparseable body: one warn naming the body-parse gate (#4215)", async () => {
    freshScenario("http://proxy.invalid", true);
    await _maybeForkAdoptBeforeSendForTest(ctxSeeded(), { body: "not-json" });
    let lines = logLines();
    assert.equal(lines.filter((l) => GATE_LINE.test(l)).length, 1, JSON.stringify(lines));
    assert.match(lines[0]!, /\[warn\].*skipped at the body-parse gate/);
    // a missing body hits the same gate and does not re-log per shape
    await _maybeForkAdoptBeforeSendForTest(ctxSeeded(), undefined);
    lines = logLines();
    assert.equal(lines.filter((l) => GATE_LINE.test(l)).length, 1);
});

test("side-shaped request: info-level deferral, window stays open (#4215)", async () => {
    freshScenario("http://proxy.invalid", true);
    await _maybeForkAdoptBeforeSendForTest(ctxSeeded(), { body: JSON.stringify({ model: "m", messages: [], max_tokens: 100 }) });
    const lines = logLines();
    assert.equal(lines.filter((l) => GATE_LINE.test(l)).length, 1, JSON.stringify(lines));
    assert.match(lines[0]!, /\[info\].*deferred for a side-shaped request/);
    // the main request after the sidecar reaches the adopter untouched
    resetForkCapabilityCacheForTest();
    const srv = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ capabilities: {} })); });
    srv.listen(0, "127.0.0.1");
    await once(srv, "listening");
    const addr = srv.address();
    assert(addr && typeof addr === "object");
    try {
        _resetRegisterForTest(`http://127.0.0.1:${addr.port}`, true);
        await _maybeForkAdoptBeforeSendForTest(ctxSeeded(), validInit);
    } finally {
        srv.close();
        srv.closeAllConnections?.();
        await once(srv, "close").catch(() => undefined);
    }
    const after = logLines();
    assert.equal(after.filter((l) => /does not advertise the fork capability/.test(l)).length, 1, "main request reached the adopter protocol");
    assert.equal(after.filter((l) => /skipped at the .* gate/.test(l)).length, 0, "no gate fired on the main request");
});

test("seeded child before the proxy origin is known: one warn naming the proxy-base gate (#4215)", async () => {
    freshScenario(undefined, true);
    await _maybeForkAdoptBeforeSendForTest(ctxSeeded(), validInit);
    const lines = logLines();
    assert.equal(lines.filter((l) => GATE_LINE.test(l)).length, 1, JSON.stringify(lines));
    assert.match(lines[0]!, /\[warn\].*skipped at the proxy-base gate/);
});

test("malformed seeded lineage: one warn per anomaly naming what is missing (#4215)", async () => {
    freshScenario("http://proxy.invalid", true);
    await _maybeForkAdoptBeforeSendForTest(ctxWithInitiator(() => ({ session: { id: "a1", header: { isSeeded: true } } })), validInit);
    let lines = logLines();
    assert.equal(lines.filter((l) => /carries no usable parentSession/.test(l)).length, 1, JSON.stringify(lines));
    assert.match(lines[0]!, /\[warn\].*fork adoption for a1 skipped/);
    await _maybeForkAdoptBeforeSendForTest(ctxWithInitiator(() => ({ session: { id: "b1", header: { isSeeded: true, parentSession: "b1" } } })), validInit);
    lines = logLines();
    assert.equal(lines.filter((l) => /carries its own id as parentSession/.test(l)).length, 1);
    // repeat of the same anomaly stays one line
    await _maybeForkAdoptBeforeSendForTest(ctxWithInitiator(() => ({ session: { id: "a1", header: { isSeeded: true } } })), validInit);
    lines = logLines();
    assert.equal(lines.filter((l) => /carries no usable parentSession/.test(l)).length, 1);
});

test("ambient-blind shapes: one info notice per process, naming the split when #4082 is active (#4215)", async () => {
    freshScenario("http://proxy.invalid", true);
    await _maybeForkAdoptBeforeSendForTest(ctxThrowing(), validInit);
    let lines = logLines();
    assert.equal(lines.filter((l) => /fork discovery blind/.test(l)).length, 1, JSON.stringify(lines));
    assert.match(lines[0]!, /\[info\].*ambient currentInitiator threw \(disposed scope\)/);
    // a DIFFERENT blind shape on a later dispatch adds nothing
    await _maybeForkAdoptBeforeSendForTest(ctxNoInitiator(), validInit);
    lines = logLines();
    assert.equal(lines.filter((l) => /fork discovery blind/.test(l)).length, 1);
    // resetting the throttle re-arms the notice (truncate so only post-reset lines count)
    _resetForkGateDiagnosticsForTest();
    fs.rmSync(logFile, { force: true });
    await _maybeForkAdoptBeforeSendForTest(ctxWithInitiator(() => ({ session: {} })), validInit);
    lines = logLines();
    assert.equal(lines.filter((l) => /fork discovery blind/.test(l)).length, 1);
    assert.match(lines[0]!, /the session has no usable id/);
});

test("plain non-fork traffic stays completely silent (#4215 negative direction)", async () => {
    freshScenario("http://proxy.invalid", true);
    await _maybeForkAdoptBeforeSendForTest(ctxPlain(), validInit);
    await _maybeForkAdoptBeforeSendForTest(ctxSubagent(), validInit);
    await _maybeForkAdoptBeforeSendForTest(ctxPlain(), validInit);
    const lines = logLines();
    assert.equal(lines.length, 0, JSON.stringify(lines));
});
