import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { resolveZonePortBase } from "../src/config.ts";
import { decideEaddrinuse, type EaddrinuseContext } from "../src/listen-policy.ts";
import { resolvePortClaim } from "../src/port-owner.ts";

const base: EaddrinuseContext = {
    upgradeReplacement: false, twinHolds: false, newerHolderHolds: false,
    launchToken: true, strictPort: false, attempts: 0, maxAttempts: 17,
    predecessorTicksLeft: 10, predecessorHolds: false,
    lastTriedPort: resolveZonePortBase({ BILI_ZONE_PORT: "65535" }),
};

async function bindRetry(port: number): Promise<void> {
    const server = createServer();
    try {
        // Exercise what the listener does with the decision. The old boundary result is
        // 65536, which throws ERR_SOCKET_BAD_PORT before a listen event can be emitted.
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(port, "127.0.0.1", resolve);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object" && address.port > 0 && address.port <= 65535);
        assert.equal(port, 0, "the OS chooses a free port when the numeric ladder is exhausted");
    } finally {
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

async function foreignClaim(port: number, canLadder = true) {
    return resolvePortClaim({
        origin: `http://127.0.0.1:${port}`, ownPid: 100, canLadder,
        listenAttempts: 0, maxListenAttempts: 17,
        probe: { fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, pid: 200 }) }) },
    });
}

test("a busy highest valid zone port retries on a bindable ephemeral port", async () => {
    assert.equal(base.lastTriedPort, 65535, "the configured zone boundary is valid");
    const action = decideEaddrinuse(base);
    assert.equal(action.kind, "ladder");
    if (action.kind === "ladder") await bindRetry(action.nextPort);
});

test("post-bind foreign ownership at the port boundary retries on a bindable ephemeral port", async () => {
    const action = await foreignClaim(65535);
    assert.equal(action.kind, "ladder");
    if (action.kind === "ladder") await bindRetry(action.nextPort);
});

test("both retry paths still try the last valid numeric port before using an ephemeral port", async () => {
    assert.deepEqual(decideEaddrinuse({ ...base, lastTriedPort: 65534 }), { kind: "ladder", nextPort: 65535 });
    const action = await foreignClaim(65534);
    assert.equal(action.kind === "ladder" ? action.nextPort : undefined, 65535);
});

test("the numeric boundary does not grant retry rights or bypass a predecessor wait", async () => {
    assert.deepEqual(decideEaddrinuse({ ...base, strictPort: true }), { kind: "fail-fast", reason: "strict-port" });
    assert.deepEqual(decideEaddrinuse({ ...base, launchToken: false }), { kind: "fail-fast", reason: "port-busy" });
    assert.deepEqual(decideEaddrinuse({ ...base, upgradeReplacement: true }), { kind: "fail-fast", reason: "upgrade-replacement" });
    assert.deepEqual(decideEaddrinuse({ ...base, predecessorHolds: true }), { kind: "wait-predecessor", port: 65535 });
    assert.equal((await foreignClaim(65535, false)).kind, "die");
});
