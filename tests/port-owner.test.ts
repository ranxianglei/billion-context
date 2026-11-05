import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findForeignOwner, holderHintFragment, holderProbeOrigin, mayClobberPointer, probeHolderForHint, probeOwnerInfo, resolvePortClaim, type HealthFetcher } from "../src/port-owner.ts";
import { atomicWriteInstanceFile, isPidAlive, readProxyInstanceFile, type ProxyInstanceFile } from "../src/instance.ts";
import { rmrf } from "./tmp-rm.ts";

const OWN_PID = process.pid;
const FOREIGN_PID = 4_242_424;

function healthFetch(body: unknown): HealthFetcher {
    return async () => ({ ok: true, json: async () => body });
}

function seqFetch(...bodies: unknown[]): { fetchImpl: HealthFetcher; calls: () => number } {
    let n = 0;
    const fetchImpl: HealthFetcher = async () => {
        const body = bodies[Math.min(n, bodies.length - 1)];
        n += 1;
        return { ok: true, json: async () => body };
    };
    return { fetchImpl, calls: () => n };
}

const NO_SLEEP = async (): Promise<void> => {};

test("probeOwnerInfo: extracts pid + instanceId from a health body", async () => {
    const info = await probeOwnerInfo("http://127.0.0.1:9", healthFetch({ ok: true, pid: FOREIGN_PID, instanceId: "abc-123" }));
    assert.deepEqual(info, { pid: FOREIGN_PID, instanceId: "abc-123" });
});

test("probeOwnerInfo: unreachable / not-ok / non-ok bodies yield undefined or unattributable info", async () => {
    const throwing: HealthFetcher = async () => { throw new Error("ECONNREFUSED"); };
    assert.equal(await probeOwnerInfo("http://127.0.0.1:1", throwing), undefined);
    const notOk: HealthFetcher = async () => ({ ok: false, json: async () => ({}) });
    assert.equal(await probeOwnerInfo("http://127.0.0.1:1", notOk), undefined);
    const notHealthy: HealthFetcher = async () => ({ ok: true, json: async () => ({ ok: false, pid: FOREIGN_PID }) });
    assert.equal(await probeOwnerInfo("http://127.0.0.1:1", notHealthy), undefined);
    // pre-#1753 shape: healthy but no pid field — unattributable, NOT foreign
    const noPid: HealthFetcher = async () => ({ ok: true, json: async () => ({ ok: true }) });
    assert.deepEqual(await probeOwnerInfo("http://127.0.0.1:1", noPid), {});
});

test("probeOwnerInfo: pre-registration 503 surfaces reason:'starting' (negative attribution, #2941)", async () => {
    const starting: HealthFetcher = async () => ({ ok: false, json: async () => ({ ok: false, reason: "starting" }) });
    assert.deepEqual(await probeOwnerInfo("http://127.0.0.1:1", starting), { reason: "starting" });
    const noBody: HealthFetcher = async () => ({ ok: false, json: async () => { throw new Error("no body"); } });
    assert.equal(await probeOwnerInfo("http://127.0.0.1:1", noBody), undefined);
});

test("findForeignOwner: 'starting' responder stops the probe loop after one round-trip (#2941 gate window)", async () => {
    let n = 0;
    const fetchImpl: HealthFetcher = async () => {
        n += 1;
        return { ok: false, json: async () => ({ ok: false, reason: "starting" }) };
    };
    const sleeps: number[] = [];
    assert.equal(
        await findForeignOwner("http://127.0.0.1:9", OWN_PID, { attempts: 3, fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); } }),
        undefined,
    );
    assert.equal(n, 1);
    assert.deepEqual(sleeps, []);
});

test("findForeignOwner: own-pid probe keeps looping; a later 'starting' probe stops it", async () => {
    let n = 0;
    const fetchImpl: HealthFetcher = async () => {
        n += 1;
        return n === 1
            ? { ok: true, json: async () => ({ ok: true, pid: OWN_PID }) }
            : { ok: false, json: async () => ({ ok: false, reason: "starting" }) };
    };
    assert.equal(
        await findForeignOwner("http://127.0.0.1:9", OWN_PID, { attempts: 3, fetchImpl, sleepImpl: NO_SLEEP }),
        undefined,
    );
    assert.equal(n, 2);
});

test("findForeignOwner: all probes ours → undefined", async () => {
    const { fetchImpl } = seqFetch({ ok: true, pid: OWN_PID }, { ok: true, pid: OWN_PID }, { ok: true, pid: OWN_PID });
    assert.equal(await findForeignOwner("http://127.0.0.1:9", OWN_PID, { fetchImpl, sleepImpl: NO_SLEEP }), undefined);
});

test("findForeignOwner: connection-distributed co-listener caught on a later probe", async () => {
    const { fetchImpl, calls } = seqFetch({ ok: true, pid: OWN_PID }, { ok: true, pid: FOREIGN_PID, instanceId: "foreign-inst" }, { ok: true, pid: OWN_PID });
    const foreign = await findForeignOwner("http://127.0.0.1:9", OWN_PID, { fetchImpl, sleepImpl: NO_SLEEP });
    assert.deepEqual(foreign, { pid: FOREIGN_PID, instanceId: "foreign-inst" });
    assert.equal(calls(), 2);
});

test("findForeignOwner: unattributable responders are never treated as foreign", async () => {
    const { fetchImpl } = seqFetch({ ok: true }, { ok: true }, { ok: true });
    assert.equal(await findForeignOwner("http://127.0.0.1:9", OWN_PID, { fetchImpl, sleepImpl: NO_SLEEP }), undefined);
});

test("findForeignOwner: unreachable probes → undefined", async () => {
    const throwing: HealthFetcher = async () => { throw new Error("ECONNREFUSED"); };
    assert.equal(await findForeignOwner("http://127.0.0.1:1", OWN_PID, { fetchImpl: throwing, sleepImpl: NO_SLEEP }), undefined);
});

test("findForeignOwner: honors the attempt budget exactly", async () => {
    const { fetchImpl, calls } = seqFetch({ ok: true, pid: OWN_PID });
    const sleeps: number[] = [];
    await findForeignOwner("http://127.0.0.1:9", OWN_PID, { attempts: 5, fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); } });
    assert.equal(calls(), 5);
    assert.deepEqual(sleeps, [100, 100, 100, 100]);
});

test("findForeignOwner: real socket answering a foreign pid is detected", async () => {
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/health") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, pid: FOREIGN_PID, instanceId: "foreign-inst" }));
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
        const foreign = await findForeignOwner(`http://127.0.0.1:${port}`, OWN_PID, { intervalMs: 10 });
        assert.deepEqual(foreign, { pid: FOREIGN_PID, instanceId: "foreign-inst" });
    } finally {
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
    }
});

test("findForeignOwner: real socket answering OUR pid → no foreign owner", async () => {
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/health") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, pid: OWN_PID, instanceId: "own-inst" }));
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
        assert.equal(await findForeignOwner(`http://127.0.0.1:${port}`, OWN_PID, { intervalMs: 10 }), undefined);
    } finally {
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
    }
});

test("resolvePortClaim: sole owner → claimed", async () => {
    const { fetchImpl } = seqFetch({ ok: true, pid: OWN_PID });
    const outcome = await resolvePortClaim({ origin: "http://127.0.0.1:18787", ownPid: OWN_PID, canLadder: true, listenAttempts: 0, maxListenAttempts: 17, probe: { fetchImpl, sleepImpl: NO_SLEEP } });
    assert.deepEqual(outcome, { kind: "claimed" });
});

test("resolvePortClaim: foreign owner + ladder rights → move +1", async () => {
    const { fetchImpl } = seqFetch({ ok: true, pid: FOREIGN_PID });
    const outcome = await resolvePortClaim({ origin: "http://127.0.0.1:18787", ownPid: OWN_PID, canLadder: true, listenAttempts: 0, maxListenAttempts: 17, probe: { fetchImpl, sleepImpl: NO_SLEEP } });
    assert.deepEqual(outcome, { kind: "ladder", nextPort: 18788, foreign: { pid: FOREIGN_PID } });
});

test("resolvePortClaim: exhausted attempt budget → ephemeral port", async () => {
    const { fetchImpl } = seqFetch({ ok: true, pid: FOREIGN_PID });
    const outcome = await resolvePortClaim({ origin: "http://127.0.0.1:18787", ownPid: OWN_PID, canLadder: true, listenAttempts: 16, maxListenAttempts: 17, probe: { fetchImpl, sleepImpl: NO_SLEEP } });
    assert.equal(outcome.kind === "ladder" ? outcome.nextPort : null, 0);
});

test("resolvePortClaim: foreign owner without ladder rights → die naming the foreign pid", async () => {
    const { fetchImpl } = seqFetch({ ok: true, pid: FOREIGN_PID, instanceId: "ffffffff-0000-0000-0000-000000000000" });
    const outcome = await resolvePortClaim({ origin: "http://127.0.0.1:18787", ownPid: OWN_PID, canLadder: false, listenAttempts: 0, maxListenAttempts: 17, probe: { fetchImpl, sleepImpl: NO_SLEEP } });
    assert.equal(outcome.kind, "die");
    if (outcome.kind === "die") {
        assert.match(outcome.message, /18787/);
        assert.match(outcome.message, /pid 4242424/);
        assert.match(outcome.message, /ffffffff/);
    }
});

function holderRecord(over: Partial<ProxyInstanceFile> = {}): ProxyInstanceFile {
    return {
        origin: "http://127.0.0.1:18787",
        instanceId: "inst-holder",
        pid: process.pid,
        startedAt: 1_000,
        host: "127.0.0.1",
        port: 18787,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        ...over,
    };
}

const CANDIDATE = { candidateOrigin: "http://127.0.0.1:18787", candidateInstanceId: "inst-candidate" };
const aliveSelf = (pid: number): boolean => pid === process.pid;
const healthServing = async (): Promise<{ pid?: number; instanceId?: string } | undefined> => ({ pid: process.pid });

test("mayClobberPointer: missing or legacy record → allowed", async () => {
    assert.equal((await mayClobberPointer({ ...CANDIDATE, read: () => undefined, isAlive: aliveSelf, healthOf: healthServing })).allow, true);
    assert.equal((await mayClobberPointer({ ...CANDIDATE, read: () => ({ origin: "http://127.0.0.1:18787" }), isAlive: aliveSelf, healthOf: healthServing })).allow, true);
});

test("mayClobberPointer: same instance re-registering → allowed without health probe", async () => {
    let probed = 0;
    const result = await mayClobberPointer({ ...CANDIDATE, candidateInstanceId: "inst-holder", read: () => holderRecord(), isAlive: aliveSelf, healthOf: async () => { probed += 1; return { pid: process.pid }; } });
    assert.equal(result.allow, true);
    assert.equal(probed, 0);
});

test("mayClobberPointer: cross-address holder → allowed (last-writer-wins by design, #1232)", async () => {
    const result = await mayClobberPointer({ ...CANDIDATE, candidateOrigin: "http://127.0.0.1:18788", read: () => holderRecord(), isAlive: aliveSelf, healthOf: healthServing });
    assert.equal(result.allow, true);
});

test("mayClobberPointer: dead holder pid → allowed, no health probe", async () => {
    let probed = 0;
    const result = await mayClobberPointer({ ...CANDIDATE, read: () => holderRecord({ pid: 4_000_000 }), isAlive: aliveSelf, healthOf: async () => { probed += 1; return { pid: 4_000_000 }; } });
    assert.equal(result.allow, true);
    assert.equal(probed, 0);
});

test("mayClobberPointer: draining predecessor (alive pid, closed listener) → allowed (#1723 takeover intact)", async () => {
    const result = await mayClobberPointer({ ...CANDIDATE, read: () => holderRecord(), isAlive: aliveSelf, healthOf: async () => undefined });
    assert.equal(result.allow, true);
});

test("mayClobberPointer: live holder serving the same address → REFUSED with holder identity", async () => {
    const result = await mayClobberPointer({ ...CANDIDATE, read: () => holderRecord(), isAlive: aliveSelf, healthOf: healthServing });
    assert.equal(result.allow, false);
    assert.deepEqual(result.holder, { pid: process.pid, instanceId: "inst-holder", origin: "http://127.0.0.1:18787" });
});

test("mayClobberPointer: stale record (responder pid ≠ recorded pid) → allowed, overwrite repairs it", async () => {
    const result = await mayClobberPointer({ ...CANDIDATE, read: () => holderRecord(), isAlive: aliveSelf, healthOf: async () => ({ pid: FOREIGN_PID }) });
    assert.equal(result.allow, true);
});

test("mayClobberPointer: end-to-end through the real proxy-origin file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-port-owner-"));
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    try {
        atomicWriteInstanceFile(holderRecord());
        const refused = await mayClobberPointer({ ...CANDIDATE, read: readProxyInstanceFile, isAlive: isPidAlive, healthOf: healthServing });
        assert.equal(refused.allow, false);
        assert.equal(refused.holder?.instanceId, "inst-holder");
        const takenOver = await mayClobberPointer({ ...CANDIDATE, candidateInstanceId: "inst-holder", read: readProxyInstanceFile, isAlive: isPidAlive, healthOf: healthServing });
        assert.equal(takenOver.allow, true);
    } finally {
        if (prev === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prev;
        await rmrf(dir);
    }
});

// ── #4762: EADDRINUSE holder diagnostics (serving vs wedged/dead) ──────────

test("holderProbeOrigin: wildcard binds probe through loopback (#4762)", () => {
    assert.equal(holderProbeOrigin("127.0.0.1", 18789), "http://127.0.0.1:18789");
    assert.equal(holderProbeOrigin("0.0.0.0", 18789), "http://127.0.0.1:18789");
    assert.equal(holderProbeOrigin("::", 18789), "http://127.0.0.1:18789");
});

test("holderHintFragment: serving vs wedged/dead wording, with and without a pid (#4762)", () => {
    const serving = holderHintFragment(true, 4242);
    assert.match(serving, /answered \/__bili\/health \(pid 4242\)/);
    assert.match(serving, /spawner should attach to it/);
    const wedged = holderHintFragment(false, 4242);
    assert.match(wedged, /did NOT answer \/__bili\/health within 2s/);
    assert.match(wedged, /wedged or dead/);
    assert.match(wedged, /taskkill \/PID 4242/);
    assert.match(wedged, /kill it to free the port/);
    assert.match(wedged, /\(#4762\)/);
    const anonymous = holderHintFragment(false);
    assert.doesNotMatch(anonymous, /taskkill/);
    assert.match(anonymous, /netstat\/lsof on the port/);
});

test("probeHolderForHint: live responder pid beats stale registry pid; unresponsive reads as not serving (#4762)", async () => {
    const live = await probeHolderForHint({ origin: "http://127.0.0.1:1", knownPid: 99, fetchImpl: healthFetch({ ok: true, pid: 7 }) });
    assert.match(live, /answered \/__bili\/health \(pid 7\)/);
    assert.doesNotMatch(live, /pid 99/);
    const throwing: HealthFetcher = async () => { throw new Error("ECONNREFUSED"); };
    const dead = await probeHolderForHint({ origin: "http://127.0.0.1:1", knownPid: 99, fetchImpl: throwing });
    assert.match(dead, /did NOT answer \/__bili\/health/);
    assert.match(dead, /taskkill \/PID 99/);
    const starting: HealthFetcher = async () => ({ ok: false, json: async () => ({ ok: false, reason: "starting" }) });
    const pre = await probeHolderForHint({ origin: "http://127.0.0.1:1", knownPid: 99, fetchImpl: starting });
    assert.match(pre, /did NOT answer \/__bili\/health/);
});
