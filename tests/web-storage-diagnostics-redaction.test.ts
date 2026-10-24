// #4499: the storage-legacy-only diagnostics blob is designed to be copied into a
// PUBLIC GitHub issue, but its storage section used to copy raw bytes with no
// publish-time redaction — unlike the config and conflict-log sections. This pins
// the single publish boundary end-to-end: raw [storage] log lines, the free-form
// reason strings, and the absolute failure-marker path must ALL be scrubbed
// (secrets -> non-public hosts -> $HOME->~) while benign knob facts stay readable.
// Both directions asserted per gate discipline (#3617): leaks scrubbed AND benign
// content preserved. Local surfaces are untouched — this only exercises the blob
// buildDiagnostics hands to the copy button / prefilled issue body.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { buildDiagnostics } from "../src/web/diagnostics.js";
import { _resetStorageRuntimeStatusForTest, recordSidecarOpenFailure } from "../src/storage/runtime-status.js";

const ENV_KEYS = ["BILI_CONFIG_FILE", "DSH_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;

/** Pin every path-relevant env var (unset ones deleted so homedir fallbacks never
 * reach the real machine's dirs); restored in finally. */
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) {
        saved[k] = process.env[k];
        if (overrides[k] !== undefined) process.env[k] = overrides[k];
        else delete process.env[k];
    }
    try { return fn(); } finally {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

const SECRET = "sk-super-secret-value-0000";
const PRIVATE_HOST = "tail-relay.internal";
const HOME = os.homedir();
// A home-rooted marker path is only meaningful when the runtime actually has a
// real home dir to strip (CI/dev machines always do; guard the degenerate "/").
const HOME_IS_REAL = !!HOME && HOME !== "/";
const MARKER_UNDER_HOME = `${HOME}/.cache/billion-context/sqlite/.bootstrap-failed.json`;

test("#4499 storage blob: raw [storage] lines / reasons / absolute marker path scrubbed at the publish boundary", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-store-redact-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stateHome = path.join(root, "state");
    mkdirSync(path.join(stateHome, "billion-context"), { recursive: true });
    // One [storage] line carrying every leak vector at once: an absolute home path,
    // a private relay host, and a credential-shaped token.
    const storageLine = `[storage] open ${MARKER_UNDER_HOME} failed: upstream https://${PRIVATE_HOST}/v1 rejected token=${SECRET}`;
    writeFileSync(path.join(stateHome, "billion-context", "bili.log"), storageLine + "\n");
    // A free-form sidecar-open reason carrying a credential — the other raw-text
    // vector (degradeReason flows verbatim into the blob pre-fix). Host leakage is
    // exercised through the [storage] line's URL above: the publish chain masks
    // http(s) URL hosts; a bare host:port in prose is intentionally out of scope
    // (same narrow-host stance as #4191, shared with the config/conflict sections).
    _resetStorageRuntimeStatusForTest();
    recordSidecarOpenFailure(`better-sqlite3 bootstrap aborted after 3 attempts (api_key=${SECRET})`);
    try {
        const rep = withEnv({ DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root },
            () => buildDiagnostics("storage-legacy-only"));
        const blob = rep.blob;

        // --- leaks scrubbed (both the log tail AND the reason string) ---
        assert.ok(!blob.includes(SECRET), "credential value must not reach the public blob");
        assert.ok(!blob.includes(PRIVATE_HOST), "private relay host must not reach the public blob");
        if (HOME_IS_REAL) {
            assert.ok(!blob.includes(MARKER_UNDER_HOME), "absolute home path (username) must not reach the public blob");
            assert.ok(!blob.includes(HOME), "no raw $HOME anywhere in the blob");
            assert.ok(blob.includes("~/.cache/billion-context/sqlite/.bootstrap-failed.json"), "home path publishes as ~ (recovery stays actionable)");
        }

        // --- benign facts preserved (gate discipline: does NOT over-scrub) ---
        assert.ok(blob.includes("--- storage ---"), "storage section present");
        assert.ok(blob.includes("requested mode:"), "resolved knob stack present");
        assert.ok(blob.includes("effective mode:"), "effective mode present");
        assert.ok(blob.includes("degrade reason:"), "degrade reason label present (text scrubbed, line kept)");
        assert.ok(blob.includes("<private-host>"), "masked-host placeholder present");
        assert.ok(blob.includes("<masked"), "secret-shape redaction marker present");

        // --- single-string invariant: the prefilled body decodes back to the exact blob ---
        const u = new URL(rep.url);
        assert.equal(u.searchParams.get("body"), blob, "issue body derives from the same scrubbed string");
    } finally {
        _resetStorageRuntimeStatusForTest();
    }
});
