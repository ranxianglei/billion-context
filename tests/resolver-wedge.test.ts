import test from "node:test";
import assert from "node:assert/strict";
import { _resolverWedgeTest, getResolverWedgeState, resolverWedgeRecord } from "../src/resolver-wedge.js";
import { checkTunnelDestination } from "../src/tunnel-guard.js";

const MIN = 60_000;
let clock = 0;

function setup() {
    clock = 1_000_000;
    _resolverWedgeTest().setNow(() => clock);
    _resolverWedgeTest().reset();
}

test("wedge trips only when >=2 previously-green hosts fail every lookup for >=5 min", () => {
    setup();
    const t0 = clock;
    resolverWedgeRecord("api.deepseek.com", true);
    resolverWedgeRecord("api.openai.com", true);
    assert.equal(getResolverWedgeState(), null, "no failures yet");

    resolverWedgeRecord("api.deepseek.com", false);
    resolverWedgeRecord("api.openai.com", false);
    assert.equal(getResolverWedgeState(), null, "the failure streak must SUSTAIN before alarming");

    clock = t0 + 4 * MIN + 59_000;
    assert.equal(getResolverWedgeState(), null, "just under the sustain window");

    clock = t0 + 5 * MIN;
    const s = getResolverWedgeState();
    assert.ok(s, "exactly at the sustain boundary the alarm trips");
    assert.deepEqual(s!.hosts, ["api.deepseek.com", "api.openai.com"], "hosts sorted");
    assert.equal(s!.sinceMs, t0, "sinceMs anchors the earliest streak");
    assert.equal(s!.elapsedMs, 5 * MIN);
});

test("one wedged host never alarms (#3617 negative row)", () => {
    setup();
    resolverWedgeRecord("only.host", true);
    resolverWedgeRecord("only.host", false);
    clock += 60 * MIN;
    assert.equal(getResolverWedgeState(), null);
});

test("hosts that NEVER resolved green in this process do not qualify", () => {
    setup();
    resolverWedgeRecord("typo.upstream", false);
    resolverWedgeRecord("another.dead.name", false);
    clock += 30 * MIN;
    assert.equal(getResolverWedgeState(), null, "a dead name is configuration noise, not resolver corruption");
});

test("recovery of one host drops the alarm below the two-host floor", () => {
    setup();
    resolverWedgeRecord("a.host", true);
    resolverWedgeRecord("b.host", true);
    resolverWedgeRecord("a.host", false);
    resolverWedgeRecord("b.host", false);
    clock += 10 * MIN;
    assert.ok(getResolverWedgeState());
    resolverWedgeRecord("a.host", true);
    assert.equal(getResolverWedgeState(), null, "only b.host remains wedged — under the floor");
});

test("the streak anchors at FIRST failure, later retries do not restart it", () => {
    setup();
    resolverWedgeRecord("x.host", true);
    resolverWedgeRecord("y.host", true);
    const t0 = clock;
    resolverWedgeRecord("x.host", false);
    resolverWedgeRecord("y.host", false);
    clock += 3 * MIN;
    resolverWedgeRecord("x.host", false);
    resolverWedgeRecord("y.host", false);
    clock += 3 * MIN;
    const s = getResolverWedgeState();
    assert.equal(s?.sinceMs, t0);
});

test("checkTunnelDestination feeds the detector: throw-only failures count, an answered-empty lookup proves the resolver alive", async () => {
    setup();
    let throwing = false;
    const resolveHost = async (host: string): Promise<string[]> => {
        if (throwing) {
            throw Object.assign(new Error("query ETIMEDOUT"), { code: "ETIMEDOUT" });
        }
        if (host === "empty.answer") return [];
        return ["93.184.216.34"];
    };
    const ctx: Parameters<typeof checkTunnelDestination>[1] = { clientLoopback: true, selfPort: 8787, allowlist: [], resolveHost, resolveBackoffMs: 1 };

    const v1 = await checkTunnelDestination("https://green.one/model", ctx);
    assert.equal(v1.ok, true);
    assert.equal((await checkTunnelDestination("https://green.two/model", ctx)).ok, true);
    // authoritative empty answer: unresolvable VERDICT, but the resolver ANSWERED.
    const empty = await checkTunnelDestination("https://empty.answer/model", ctx);
    assert.equal(empty.ok, false);
    assert.equal(empty.code, "unresolvable");
    clock += 6 * MIN;
    throwing = true;
    const failClock = clock;
    const f1 = await checkTunnelDestination("https://green.one/model", ctx);
    assert.equal(f1.ok, false);
    assert.equal((f1 as { ok: boolean; code?: string }).code, "unresolvable");
    assert.match(f1.message, /ETIMEDOUT/);
    await checkTunnelDestination("https://green.two/model", ctx);

    assert.equal(getResolverWedgeState(), null, "the streak must sustain the full window from FIRST failure");
    clock += 5 * MIN;
    const s = getResolverWedgeState();
    assert.ok(s, "both formerly-green hosts failing for >5 min must trip");
    assert.deepEqual(s!.hosts, ["green.one", "green.two"], "the empty-answer host never entered the evidence set");
    assert.equal(s!.sinceMs, failClock, "streaks began at first throwing lookup");
});
