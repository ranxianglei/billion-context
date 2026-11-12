import { test } from "node:test";
import assert from "node:assert/strict";
import { decideEaddrinuse, isPortBusyError, postBindCanLadder, UPGRADE_REPLACEMENT_ENV, type EaddrinuseContext } from "../src/listen-policy.ts";

const base: EaddrinuseContext = {
    upgradeReplacement: false,
    twinHolds: false,
    newerHolderHolds: false,
    launchToken: true,
    strictPort: false,
    attempts: 0,
    maxAttempts: 17,
    predecessorTicksLeft: 10,
    predecessorHolds: false,
    lastTriedPort: 18787,
};

test("decideEaddrinuse: upgrade replacement never ladders (#3044)", () => {
    // No predecessor recognized (foreign squatter, same-code peer, or no lane):
    // fail fast on the first hit — the +1 ladder is exactly what stranded the
    // orphan processes of #3044.
    assert.deepEqual(
        decideEaddrinuse({ ...base, upgradeReplacement: true }),
        { kind: "fail-fast", reason: "upgrade-replacement" },
    );
    // A same-lane DIFFERENT-code holder gets the bounded same-port wait
    // (#1723 overlap: the prior instance may still be releasing)...
    assert.deepEqual(
        decideEaddrinuse({ ...base, upgradeReplacement: true, predecessorHolds: true }),
        { kind: "wait-predecessor", port: 18787 },
    );
    // ...but once the budget is spent it still fails fast instead of laddering.
    assert.deepEqual(
        decideEaddrinuse({ ...base, upgradeReplacement: true, predecessorHolds: true, predecessorTicksLeft: 0 }),
        { kind: "fail-fast", reason: "upgrade-replacement" },
    );
    // The replacement contract does not depend on launch token or attempt count.
    assert.deepEqual(
        decideEaddrinuse({ ...base, upgradeReplacement: true, launchToken: false, attempts: 5 }),
        { kind: "fail-fast", reason: "upgrade-replacement" },
    );
});

test("decideEaddrinuse: legacy launcher-child behavior is unchanged", () => {
    // Predecessor overlap still waits out the draining old build on the SAME port.
    assert.deepEqual(
        decideEaddrinuse({ ...base, predecessorHolds: true }),
        { kind: "wait-predecessor", port: 18787 },
    );
    // Plain contention ladders +1...
    assert.deepEqual(decideEaddrinuse(base), { kind: "ladder", nextPort: 18788 });
    // ...and the final attempt asks for an ephemeral port.
    assert.deepEqual(
        decideEaddrinuse({ ...base, attempts: 16 }),
        { kind: "ladder", nextPort: 0 },
    );
    // Exhausted attempts fall through to fail-fast.
    assert.deepEqual(
        decideEaddrinuse({ ...base, attempts: 17 }),
        { kind: "fail-fast", reason: "port-busy" },
    );
});

test("decideEaddrinuse: strict-port and manual launches keep their fail-fast reasons", () => {
    assert.deepEqual(
        decideEaddrinuse({ ...base, strictPort: true }),
        { kind: "fail-fast", reason: "strict-port" },
    );
    // A manual launch (no launch token) was always fail-fast; unchanged.
    assert.deepEqual(
        decideEaddrinuse({ ...base, launchToken: false }),
        { kind: "fail-fast", reason: "port-busy" },
    );
});

test("decideEaddrinuse: env marker name is stable (#3044)", () => {
    assert.equal(UPGRADE_REPLACEMENT_ENV, "BILI_UPGRADE_REPLACEMENT");
});

test("decideEaddrinuse: a proven strictly-newer same-lane holder gets the adopt signal (#4125)", () => {
    // Nothing over there is draining: no wait variant may touch the port...
    assert.deepEqual(
        decideEaddrinuse({ ...base, newerHolderHolds: true }),
        { kind: "fail-fast", reason: "twin-collision" },
    );
    // ...not even a recognized draining predecessor may delay the verdict...
    assert.deepEqual(
        decideEaddrinuse({ ...base, newerHolderHolds: true, predecessorHolds: true }),
        { kind: "fail-fast", reason: "twin-collision" },
    );
    // ...and the upgrade-replacement overlap wait stays out too (the replacement's
    // spawner drives that flow separately — an adoption signal would mislead it).
    assert.deepEqual(
        decideEaddrinuse({ ...base, newerHolderHolds: true, upgradeReplacement: true }),
        { kind: "fail-fast", reason: "twin-collision" },
    );
});

test("postBindCanLadder: a marked upgrade replacement never gains post-bind ladder rights (#3044/#2941)", () => {
    // Launcher child on a contested just-bound port keeps today's move-off
    // right (#2941).
    assert.equal(postBindCanLadder(true, false, false), true);
    // Strict-port and manual launches never laddered; unchanged.
    assert.equal(postBindCanLadder(true, true, false), false);
    assert.equal(postBindCanLadder(false, false, false), false);
    // #3044: the replacement inherits its parent's launch token but must die
    // on a contested port instead of hopping — the orphan shape, via the
    // second hop path.
    assert.equal(postBindCanLadder(true, false, true), false);
});

test("isPortBusyError: Windows cross-family collisions count as busy, real privilege errors do not", () => {
    // Stock contention on every platform.
    assert.equal(isPortBusyError("EADDRINUSE", 18787, "linux"), true);
    assert.equal(isPortBusyError("EADDRINUSE", 18787, "win32"), true);
    // Windows reports a bind collision with a listener held on ANOTHER address
    // family (IPv6 wildcard vs IPv4) as EACCES although the port is not
    // privileged — that must ladder like EADDRINUSE instead of dying with the
    // misleading "requires privileges" hint.
    assert.equal(isPortBusyError("EACCES", 18787, "win32"), true);
    // A genuinely privileged port stays a permission error even on Windows.
    assert.equal(isPortBusyError("EACCES", 443, "win32"), false);
    // POSIX EACCES above 1024 is a real permission error (SELinux/caps), not a collision.
    assert.equal(isPortBusyError("EACCES", 18787, "linux"), false);
    // Unrelated codes never ladder.
    assert.equal(isPortBusyError("EAFNOSUPPORT", 18787, "win32"), false);
    assert.equal(isPortBusyError(undefined, 18787, "win32"), false);
});
