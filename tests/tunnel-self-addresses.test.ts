import test from "node:test";
import assert from "node:assert/strict";
import { checkTunnelDestination } from "../src/tunnel-guard.ts";

const localIps = () => new Set(["127.0.0.1", "::1", "192.168.1.5"]);
const context = { selfPort: 8787, clientLoopback: true, allowlist: [], localIps };

test("self admission covers the whole IPv4 loopback range", async () => {
    for (const host of ["127.0.1.1", "127.42.19.8", "127.255.255.254"]) {
        const verdict = await checkTunnelDestination(`http://${host}:8787/v1/models`, context);
        assert.equal(verdict.ok, false, host);
        if (verdict.ok) assert.fail("self destination was admitted");
        assert.equal(verdict.code, "self");
    }
});

test("mapped IPv4 loopback aliases cannot reach the serving port", async () => {
    for (const host of ["[::ffff:127.42.19.8]", "[::ffff:7f2a:1308]"]) {
        const verdict = await checkTunnelDestination(`http://${host}:8787`, context);
        assert.equal(verdict.ok, false, host);
        if (verdict.ok) assert.fail("mapped self destination was admitted");
        assert.equal(verdict.code, "self");
    }
});

test("resolved loopback aliases receive the same self verdict as literals", async () => {
    for (const address of ["127.42.19.8", "::ffff:127.42.19.8", "::ffff:7f2a:1308"]) {
        const verdict = await checkTunnelDestination("http://model.test:8787", {
            ...context, resolveHost: async () => [address],
        });
        assert.equal(verdict.ok, false, address);
        if (verdict.ok) assert.fail("resolved self destination was admitted");
        assert.equal(verdict.code, "self");
    }
});

test("mapped resolver answers match the machine's ordinary interface addresses", async () => {
    for (const address of ["::ffff:192.168.1.5", "::ffff:c0a8:105"]) {
        const verdict = await checkTunnelDestination("http://model.test:8787", {
            ...context, resolveHost: async () => [address],
        });
        assert.equal(verdict.ok, false, address);
        if (verdict.ok) assert.fail("own interface was admitted");
        assert.equal(verdict.code, "self");
    }
});

test("an allowlist cannot exempt a remote client's loopback self destination", async () => {
    const verdict = await checkTunnelDestination("http://127.42.19.8:8787", {
        ...context, clientLoopback: false, allowlist: ["127.42.19.8:8787"],
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) assert.fail("allowlisted self destination was admitted");
    assert.equal(verdict.code, "self");
});

test("other ports and other machines retain their self-hosted upstream behavior", async () => {
    for (const origin of ["http://127.42.19.8:8199", "http://[::ffff:127.42.19.8]:8199", "http://192.168.1.6:8787"]) {
        assert.deepEqual(await checkTunnelDestination(origin, context), { ok: true }, origin);
    }
    assert.deepEqual(await checkTunnelDestination("http://model.test:8199", {
        ...context, resolveHost: async () => ["::ffff:c0a8:105"],
    }), { ok: true });
});
