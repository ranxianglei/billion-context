import test from "node:test";
import assert from "node:assert/strict";
import { checkTunnelDestination, workerResolveHost, type ResolveHost } from "../src/tunnel-guard.ts";

/** #5222: a long-lived process can wedge its OWN resolver state permanently
 *  (WSL2 after TUN/VPN switches: main-pool getaddrinfo times out forever while
 *  other processes on the machine resolve fine). The admission guard must then
 *  probe with a fresh worker-thread pool before denying — and the probe's
 *  answer must flow through the SAME range classification as the main pool's.
 *  Gate discipline (#3617): both directions asserted — "triggers when it
 *  should" AND "does NOT trigger when it should not". */

const localIps = () => new Set(["127.0.0.1", "::1"]);
const base = { selfPort: 8787, allowlist: [] as string[], localIps };
const deadPool: ResolveHost = async () => { throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }); };

test("#5222 positive: main pool wedged + fresh worker resolves → admitted (no false deny)", async () => {
    let probeCalls = 0;
    const v = await checkTunnelDestination("https://api.deepseek.com/anthropic/v1/messages", {
        ...base, clientLoopback: true, resolveHost: deadPool, resolveBackoffMs: 1,
        workerProbe: async () => { probeCalls++; return ["14.215.177.38"]; },
    });
    assert.equal(v.ok, true, "a healthy machine must not be denied because THIS process's pool is wedged");
    assert.equal(probeCalls, 1, "one-shot probe — no open-ended worker retries");
});

test("#5222 negative: main pool AND fresh worker fail → unresolvable, message names both failures", async () => {
    const v = await checkTunnelDestination("https://api.deepseek.com/v1/messages", {
        ...base, clientLoopback: true, resolveHost: deadPool, resolveBackoffMs: 1,
        workerProbe: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); },
    });
    assert.equal(v.ok, false);
    assert.equal(v.code, "unresolvable");
    assert.match(v.message, /fresh resolver thread also failed/, "machine-wide outage is distinguishable in the error");
    assert.match(v.message, /upstream proxy/, "remediation hint still offered");
});

test("#5222 disabled: workerFallback:false keeps legacy behavior and never spawns the probe", async () => {
    let called = false;
    const v = await checkTunnelDestination("https://nope.invalid/", {
        ...base, clientLoopback: true, resolveHost: deadPool, resolveBackoffMs: 1,
        workerFallback: false,
        workerProbe: async () => { called = true; return ["1.2.3.4"]; },
    });
    assert.equal(v.ok, false);
    assert.equal(v.code, "unresolvable");
    assert.equal(called, false, "opt-out must not run any probe");
    assert.doesNotMatch(v.message, /fresh resolver thread/, "legacy wording untouched when the stage is off");
});

test("#5222 classification parity: the worker answer still passes every range layer", async () => {
    const priv = await checkTunnelDestination("http://relay.example:9000/v1", {
        ...base, clientLoopback: false, resolveHost: deadPool, resolveBackoffMs: 1,
        workerProbe: async () => ["192.168.1.9"],
    });
    assert.equal(priv.ok, false);
    assert.equal(priv.code, "privateRemote", "private-resolving name denied for remote clients even via the worker path");
    const allowed = await checkTunnelDestination("http://relay.example:9000/v1", {
        ...base, clientLoopback: false, allowlist: ["relay.example"], resolveHost: deadPool, resolveBackoffMs: 1,
        workerProbe: async () => ["192.168.1.9"],
    });
    assert.equal(allowed.ok, true, "allowlist row behaves identically on the worker path");
    const meta = await checkTunnelDestination("http://meta.internal/latest/meta-data/", {
        ...base, clientLoopback: true, resolveHost: deadPool, resolveBackoffMs: 1,
        workerProbe: async () => ["169.254.169.254"],
    });
    assert.equal(meta.ok, false);
    assert.equal(meta.code, "linkLocal", "metadata hard-deny holds on the worker path too");
});

test("#5222 empty worker answer is definitive (the resolver said so)", async () => {
    const v = await checkTunnelDestination("https://empty.answer.invalid/", {
        ...base, clientLoopback: true, resolveHost: deadPool, resolveBackoffMs: 1,
        workerProbe: async () => [],
    });
    assert.equal(v.ok, false);
    assert.equal(v.code, "unresolvable");
    assert.match(v.message, /no addresses/);
});

test("workerResolveHost: real worker plumbing resolves localhost hermetically (fresh-pool lookup works)", async () => {
    const ips = await workerResolveHost("localhost");
    assert.ok(ips.length > 0, "got at least one address");
    assert.ok(ips.some((ip) => ip === "127.0.0.1" || ip === "::1"), `localhost must map into loopback, got ${ips.join(",")}`);
});

test("workerResolveHost: unresolvable name rejects within the bounded budget", async () => {
    await assert.rejects(workerResolveHost(`no-such-bili-${Date.now()}.invalid`));
});
