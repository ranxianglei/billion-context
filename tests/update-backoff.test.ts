import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// #1603 Defect 2: a persistently failing install must back off instead of
// re-downloading every 3-min cycle forever (pre-fix field behavior: 124× over 12
// days, no backoff/remediation). These pin the bounded-retry fix.
//
// CHECK_INTERVAL_MS / THROTTLE_FILE / LOCK_FILE are module-level consts frozen
// at import time, so the cache-dir override and the shrunk check cadence MUST be
// set before dynamically importing src/update.ts (a static import would hoist
// above them). Cadence = 1ms so repeated cycles don't wait 3 minutes.
const root = mkdtempSync(path.join(tmpdir(), "bc-backoff-test-"));
process.env.XDG_CACHE_HOME = path.join(root, "cache");
process.env.BILI_UPDATE_CHECK_INTERVAL_MS = "1";
const { checkForUpdate, backoffMs, _resetInstallBackoffForTest } = await import("../src/update.ts");
const { setLogCapture } = await import("../src/logger.ts");

test("backoffMs grows exponentially from the base and caps at 6h", () => {
    const min = 60_000;
    assert.equal(backoffMs(3), 5 * min);
    assert.equal(backoffMs(4), 10 * min);
    assert.equal(backoffMs(5), 20 * min);
    assert.equal(backoffMs(6), 40 * min);
    // sub-threshold counts clamp to the base (never applied as a cooldown)
    assert.equal(backoffMs(1), 5 * min);
    assert.equal(backoffMs(2), 5 * min);
    assert.equal(backoffMs(50), 6 * 60 * min);
    assert.equal(backoffMs(1_000_000), 6 * 60 * min);
});

function registryDoc(version: string): object {
    return {
        version,
        dist: {
            tarball: `https://registry.test/${version}.tgz`,
            integrity: "sha512-" + "a".repeat(64),
            shasum: "b".repeat(40),
        },
    };
}

test("checkForUpdate: a persistently failing install backs off instead of retrying every cycle", async () => {
    _resetInstallBackoffForTest();
    const originalFetch = globalThis.fetch;
    const lines: string[] = [];
    setLogCapture((_level, msg) => {
        lines.push(msg);
    });
    try {
        // A package name that resolves to NO package.json up the tree makes
        // findInstallDir return undefined, so installViaTarball fails
        // deterministically BEFORE any download ("cannot determine install
        // directory") — a repeatable failure that never touches disk.
        globalThis.fetch = (async () => new Response(JSON.stringify(registryDoc("9.9.9")))) as unknown as typeof fetch;

        const opts = { packageName: "nonexistent-bc-pkg", currentVersion: "1.2.3", autoUpdate: true };
        // Drive six cycles. Cadence is 1ms; the 5ms spacing clears it reliably.
        for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 5));
            await checkForUpdate(opts, false);
        }

        const downloads = lines.filter((l) => l.includes("new version found")).length;
        const failures = lines.filter((l) => l.includes("install failed") || l.includes("install keeps failing")).length;
        const remediations = lines.filter((l) => l.includes("Backing off")).length;

        // First three attempts run and fail; the rest are silently skipped by the
        // cooldown (pre-fix all six would have downloaded + failed every cycle).
        assert.equal(downloads, 3, `expected 3 attempts, got ${downloads}: ${JSON.stringify(lines)}`);
        assert.equal(failures, 3, `expected 3 failure lines, got ${failures}: ${JSON.stringify(lines)}`);
        assert.equal(remediations, 1, `expected exactly one backoff/remediation line, got ${remediations}: ${JSON.stringify(lines)}`);
        assert.ok(lines.some((l) => l.includes("in a row")), `expected a '(N× in a row)' escalation: ${JSON.stringify(lines)}`);
    } finally {
        globalThis.fetch = originalFetch;
        setLogCapture(null);
        _resetInstallBackoffForTest();
        delete process.env.XDG_CACHE_HOME;
        delete process.env.BILI_UPDATE_CHECK_INTERVAL_MS;
        rmSync(root, { recursive: true, force: true });
    }
});
