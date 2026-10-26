// #4427: the storage-legacy-only diagnostics blob lands in a PUBLIC GitHub issue
// body, but its storage section copied raw [storage] bytes (and free-form reason
// strings + the absolute failure-marker path) with NO publish-time redaction —
// unlike the config and conflict-log sections. These tests pin that EVERY byte of
// the storage report now passes the same unconditional publish-boundary net as
// the rest: credential shapes scrubbed, non-public URL hosts masked, and user-
// identifying $HOME prefixes rewritten to ~ — regardless of the local
// BILI_LOG_MASK_HOSTS preference, and equivalently in the copied blob AND the
// prefilled issue body.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { buildDiagnostics } from "../src/web/diagnostics.js";
import { isMaskHostsEnabled, maskPathsForPublish, redactForPublish, setMaskHostsEnabled } from "../src/log-mask.js";
import { bootstrapFailureMarkerPath } from "../src/storage/engine-bootstrap.js";

const ENV_KEYS = ["BILI_CONFIG_FILE", "DSH_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;
type EnvSnap = Record<string, string | undefined>;

function saveEnv(): EnvSnap {
    const snap: EnvSnap = {};
    for (const k of ENV_KEYS) snap[k] = process.env[k];
    return snap;
}

function restoreEnv(snap: EnvSnap): void {
    for (const k of ENV_KEYS) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
    }
}

/** Pin every path-relevant env var (unset ones deleted so homedir fallbacks can
 *  never reach the real machine's dirs) AND $HOME (so os.homedir() is
 *  deterministic); all restored in finally. */
function withEnv<T>(home: string | undefined, overrides: Record<string, string | undefined>, fn: () => T): T {
    const saved = saveEnv();
    const savedHome = process.env.HOME;
    if (home !== undefined) process.env.HOME = home;
    for (const k of ENV_KEYS) {
        if (overrides[k] !== undefined) process.env[k] = overrides[k];
        else delete process.env[k];
    }
    try {
        return fn();
    } finally {
        restoreEnv(saved);
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
    }
}

test("#4427 maskPathsForPublish rewrites this machine's $HOME to ~, anchored on both flanks", () => {
    const savedHome = process.env.HOME;
    process.env.HOME = "/home/alice";
    try {
        assert.equal(maskPathsForPublish("/home/alice/.local/share/billion-context/x.db"), "~/.local/share/billion-context/x.db");
        assert.equal(maskPathsForPublish("open failed at /home/alice/db"), "open failed at ~/db");
        assert.equal(maskPathsForPublish('ENOENT: no such file or directory, open \'/home/alice/index.db\''), "ENOENT: no such file or directory, open '~/index.db'");
        // sibling home: the char after /home/alice is 'x' (a token char), not a separator → untouched
        assert.equal(maskPathsForPublish("/home/alicex/.local"), "/home/alicex/.local", "sibling home left alone");
        // URL pathname: /home/alice sits right after the host token (preceded by '/') → untouched here
        // (host masking is a separate net; the path masker must not corrupt URLs)
        assert.equal(maskPathsForPublish("https://relay.internal/home/alice/doc.pdf"), "https://relay.internal/home/alice/doc.pdf", "URL pathname not rewritten");
        assert.equal(maskPathsForPublish("~/.already-tilded"), "~/.already-tilded", "idempotent on already-tilded text");
    } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
    }
});

test("#4427 redactForPublish composes secret scrub + host mask + home-path strip in one pass", () => {
    const savedHome = process.env.HOME;
    process.env.HOME = "/home/bob";
    try {
        const out = redactForPublish("probe https://user:SecretPass@db.internal:3306/app?token=FAKE_TOKEN at /home/bob/.cache/x authorization: bearer sk-live-abcdef1234567890 failed");
        assert.ok(!out.includes("db.internal"), "private URL host masked");
        assert.ok(!out.includes("SecretPass"), "URL userinfo password dropped");
        assert.ok(!out.includes("FAKE_TOKEN"), "URL query credential dropped");
        assert.ok(out.includes("<private-host>"), "masked-host placeholder present");
        assert.ok(!out.includes("/home/bob"), "home dir stripped from absolute path");
        assert.ok(out.includes("~/.cache/x"), "path stays actionable via ~");
        assert.ok(!out.includes("sk-live-abcdef1234567890"), "bearer token scrubbed");
        assert.ok(out.includes("<masked"), "redaction marker visible");
    } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
    }
});

test("#4427 storage-legacy-only blob leaks no credentials, private hosts, or home paths (unconditional)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-diag-store-root-"));
    const home = mkdtempSync(path.join(os.tmpdir(), "bili-diag-store-home-"));
    const stateHome = path.join(root, "state");
    mkdirSync(path.join(stateHome, "billion-context"), { recursive: true });
    const logFile = path.join(stateHome, "billion-context", "bili.log");
    const longLine = "[storage] " + "E".repeat(300);
    writeFileSync(logFile, [
        `[storage] sidecar probe https://demo:FAKE_PASSWORD@db.internal:3306/app?token=FAKE_TOKEN failed`,
        `[storage] upstream 401 authorization: bearer sk-live-abcdef1234567890 rejected`,
        `[storage] open failed at ${home}/.local/share/billion-context/index.db (EACCES permission denied)`,
        longLine,
        "[storage] index.db healthy (sqlite unified)",
    ].join("\n") + "\n");
    const env = { DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, BILI_CONFIG_FILE: path.join(root, "absent.json") };
    try {
        const rep = withEnv(home, env, () => buildDiagnostics("storage-legacy-only"));
        const blob = rep.blob;

        assert.ok(blob.includes("--- storage ---"), "storage section present");
        assert.ok(blob.includes("[storage] index.db healthy (sqlite unified)"), "benign [storage] line survives verbatim");

        assert.ok(!blob.includes("db.internal"), "private relay host in a [storage] line masked");
        assert.ok(!blob.includes("FAKE_PASSWORD"), "URL userinfo password dropped");
        assert.ok(!blob.includes("token=FAKE_TOKEN"), "URL query credential dropped");
        assert.ok(!blob.includes("sk-live-abcdef1234567890"), "bearer token in a [storage] line scrubbed");
        assert.ok(blob.includes("<masked"), "redaction marker visible in the tail");

        assert.ok(!blob.includes(home), "no absolute home dir in the public blob (#3959 leak)");
        assert.ok(blob.includes("~/.local/share/billion-context/index.db"), "home path preserved as ~ for actionability");

        assert.ok(!blob.includes("E".repeat(300)), "overlong [storage] line truncated");
        for (const l of blob.split("\n")) {
            if (l.startsWith("[storage] ")) assert.ok(l.length <= 240, `published [storage] line bounded, got ${l.length}`);
        }

        assert.equal(new URL(rep.url).searchParams.get("body"), rep.blob, "issue body decodes back to the exact (redacted) blob");
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
});

test("#4427 publish redaction holds even when local host-masking is disabled", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-diag-store-off-"));
    const stateHome = path.join(root, "state");
    mkdirSync(path.join(stateHome, "billion-context"), { recursive: true });
    writeFileSync(path.join(stateHome, "billion-context", "bili.log"),
        "[storage] routed call identified via https://corp-relay.internal.corp/v1/model (ECONNRESET)\n");
    const env = { DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, BILI_CONFIG_FILE: path.join(root, "absent.json") };
    const prev = isMaskHostsEnabled();
    try {
        setMaskHostsEnabled(false); // operator opted out of LOCAL log host-masking
        const blob = withEnv(undefined, env, () => buildDiagnostics("storage-legacy-only")).blob;
        assert.ok(!blob.includes("corp-relay.internal.corp"), "private host masked in PUBLISHED blob despite local switch OFF");
        assert.ok(blob.includes("<private-host>"), "masked-host placeholder present under switch-OFF");
    } finally {
        setMaskHostsEnabled(prev);
        rmSync(root, { recursive: true, force: true });
    }
});

test("#4427 force-retry marker path keeps actionability while shedding the username", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "bili-diag-marker-home-"));
    try {
        // cache root under $HOME → the absolute marker carries the user's home
        // prefix; both the resolve and the redaction must run under the same
        // pinned $HOME (os.homedir() is read live inside redactForPublish).
        const published = withEnv(home, { XDG_CACHE_HOME: path.join(home, ".cache") }, () => {
            const abs = bootstrapFailureMarkerPath();
            assert.ok(abs.startsWith(`${home}${path.sep}.cache${path.sep}billion-context`), "marker resolves under the cache root");
            return redactForPublish(abs);
        });
        assert.equal(published, `~${path.sep}.cache${path.sep}billion-context${path.sep}sqlite${path.sep}.bootstrap-failed.json`, "published marker is ~-anchored, not username-bearing");
        assert.ok(!published.includes(home), "no absolute home dir survives into the public report");
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
