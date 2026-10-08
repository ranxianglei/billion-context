import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// #2030: knob resolution precedence — env > config file > default.
// The contract under test:
//   1. defaults are unchanged from the pre-migration env-only era;
//   2. a config-file value applies when no env var is set;
//   3. a SET env var (ANY value) always wins over the file tier — including
//      garbage values, which resolve exactly as they did pre-migration
//      (byte-exact backward compat: a stale export neither leaks into nor is
//      shadowed by the file tier);
//   4. a garbage file value falls back to the default (never throws).

const root = mkdtempSync(path.join(tmpdir(), "knobs-precedence-"));
const cfgFile = path.join(root, "billion-context.json");
let previousConfigFile: string | undefined;

function setConfig(obj: unknown): void {
    writeFileSync(cfgFile, JSON.stringify(obj, null, 2), "utf8");
    process.env.BILI_CONFIG_FILE = cfgFile;
}
function clearConfig(): void {
    process.env.BILI_CONFIG_FILE = "/nonexistent/bili-knobs-test-config.json";
}

function withEnv(vars: Record<string, string>, fn: () => void): void {
    const saved: [string, string | undefined][] = [];
    for (const [k, v] of Object.entries(vars)) { saved.push([k, process.env[k]]); process.env[k] = v; }
    try { fn(); } finally {
        for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

previousConfigFile = process.env.BILI_CONFIG_FILE;
process.env.BILI_CONFIG_FILE = cfgFile;

const knobs = await import("../src/knobs.js");
const { UPSTREAM_TIMEOUT_MS, REPLAY_MAX_ATTEMPTS, REPLAY_BASE_DELAY_MS } = await import("../src/fetch-util.js");
const { PROXY_KEEPALIVE_MAX_MS } = await import("../src/upstream-proxy.js");

test("defaults: no env, no file", () => {
    clearConfig();
    assert.equal(knobs.upstreamTimeoutMs(), UPSTREAM_TIMEOUT_MS);
    assert.equal(knobs.replayMaxAttempts(), REPLAY_MAX_ATTEMPTS);
    assert.equal(knobs.replayBaseDelayMs(), REPLAY_BASE_DELAY_MS);
    assert.equal(knobs.maxShrinkPerCompress(), undefined);
    assert.equal(knobs.requestWatchdogBudgetMs(), 2 * UPSTREAM_TIMEOUT_MS);
    assert.equal(knobs.keepAliveTimeoutMs(), 5000);
    assert.equal(knobs.clientErrorBackstopMs(), 30_000);
    assert.equal(knobs.exposureLogIntervalMs(), 3_600_000);
    assert.equal(knobs.streamKeepAliveMs(), 15_000);
    assert.equal(knobs.preflightHoldGraceMs(), 30_000);
    assert.equal(knobs.preflightDeadEndCooldownMs(), 5 * 60_000);
    assert.equal(knobs.proxyKeepAliveMaxMs(), PROXY_KEEPALIVE_MAX_MS);
    assert.equal(knobs.postResponseLingerMs(), 5_000);
    assert.equal(knobs.mitmHandshakeTimeoutMs(), 10_000);
    assert.equal(knobs.persistEnabled(), true);
    assert.equal(knobs.persistZstdEnabled(), false);
    assert.equal(knobs.publicSnapshotCapBytes(), 104_857_600);
    assert.equal(knobs.persistDebounceMs(), 500);
    assert.equal(knobs.persistTailTokens(), 16384);
    assert.equal(knobs.persistEpermAlertThreshold(), 5);
    assert.equal(knobs.persistEpermAlertRepeatMs(), 0);
    assert.equal(knobs.maxSessions(), 256);
    const gc = knobs.gcSettings();
    assert.equal(gc.enabled, false);
    assert.equal(gc.maxAgeMs, 7 * 86_400_000);
    assert.equal(gc.maxTokens, 1_000_000);
    assert.equal(gc.intervalMs, 3_600_000);
    assert.equal(knobs.updateRegistryBase(), undefined);
    assert.equal(knobs.updateCheckIntervalMs(), 180_000);
    assert.equal(knobs.ccrRetrievalTtlMs(), 10 * 60 * 1000);
    assert.equal(knobs.publicSnapshotCapBytes(), 104_857_600);
    assert.equal(knobs.codexCompactMode(), "intercept");
    assert.equal(knobs.decompressTmpCap(), 50);
    assert.equal(knobs.bodyDumpEnabled(), false);
    assert.equal(knobs.dumpReqAllowed(), true);
    assert.equal(knobs.dump4xxEnabled(), false);
    assert.equal(knobs.dump4xxMaxBytes(), 2 * 1024 * 1024);
    assert.equal(knobs.renderNone(), false);
    assert.equal(knobs.noInjectTool(), false);
    assert.equal(knobs.noCompressPrompt(), false);
    assert.equal(knobs.countTokensPassthrough(), false);
    assert.equal(knobs.forceTextProtocol(), false);
    assert.equal(knobs.keepResponseId(), false);
    assert.equal(knobs.noCacheControl(), false);
    assert.equal(knobs.fakeCompletionRetries(), 0);
    assert.equal(knobs.fakeBufCapBytes(), 16 * 1024 * 1024);
});

test("file tier: every migrated block resolves from the config file", () => {
    setConfig({
        network: {
            upstreamTimeoutMs: 60000, requestWatchdogMs: 90000, keepAliveTimeoutMs: 7000,
            clientErrorBackstopMs: 45000, exposureLogIntervalMs: 0, streamKeepAliveMs: 20000,
            preflightHoldMs: 40000, preflightDeadEndCooldownMs: 60000, replayRetryMax: 5,
            replayRetryBaseMs: 250, maxShrinkPerCompress: 0.4, proxyKeepAliveMaxMs: 60000,
            postResponseLingerMs: 12345,
        },
        persist: { enabled: false, zstd: true, debounceMs: 900, tailTokens: 4096, epermAlertThreshold: 9, epermAlertRepeatMs: 1200 },
        sessions: { max: 64, gc: { enabled: true, maxAgeDays: 3, maxTokens: 2000000, intervalMs: 60000 } },
        update: { registry: "https://registry.example.invalid", checkIntervalMs: 2500 },
        diagnostics: {
            dumpBody: true, dumpReq: false, rawDumpDir: "/tmp/knobs-raw", dump4xx: true,
            dump4xxMaxBytes: 4096, renderNone: true, noInjectTool: true, noCompressPrompt: true,
            countTokensPassthrough: true, compressProtocol: "text",
        },
        fakeCompletion: { retries: 2, bufCapBytes: 1048576 },
        plugin: { snapshotCapBytes: 999 },
        codexCompact: "pass",
        ccrRetrievalTtlMs: 300000,
        decompressTmpCap: 7,
        mitm: { handshakeTimeoutMs: 1234 },
        compat: { noCacheControl: true, keepResponseId: true },
    });
    assert.equal(knobs.upstreamTimeoutMs(), 60000);
    assert.equal(knobs.publicSnapshotCapBytes(), 999);
    assert.equal(knobs.requestWatchdogBudgetMs(), 90000);
    assert.equal(knobs.keepAliveTimeoutMs(), 7000);
    assert.equal(knobs.clientErrorBackstopMs(), 45000);
    assert.equal(knobs.exposureLogIntervalMs(), 0);
    assert.equal(knobs.streamKeepAliveMs(), 20000);
    assert.equal(knobs.preflightHoldGraceMs(), 40000);
    assert.equal(knobs.preflightDeadEndCooldownMs(), 60000);
    assert.equal(knobs.replayMaxAttempts(), 5);
    assert.equal(knobs.replayBaseDelayMs(), 250);
    assert.equal(knobs.maxShrinkPerCompress(), 0.4);
    assert.equal(knobs.proxyKeepAliveMaxMs(), 60000);
    assert.equal(knobs.postResponseLingerMs(), 12345);
    assert.equal(knobs.mitmHandshakeTimeoutMs(), 1234);
    assert.equal(knobs.persistEnabled(), false);
    assert.equal(knobs.persistZstdEnabled(), true);
    assert.equal(knobs.persistDebounceMs(), 900);
    assert.equal(knobs.persistTailTokens(), 4096);
    assert.equal(knobs.persistEpermAlertThreshold(), 9);
    assert.equal(knobs.persistEpermAlertRepeatMs(), 1200);
    assert.equal(knobs.maxSessions(), 64);
    const gc = knobs.gcSettings();
    assert.equal(gc.enabled, true);
    assert.equal(gc.maxAgeMs, 3 * 86_400_000);
    assert.equal(gc.maxTokens, 2000000);
    assert.equal(gc.intervalMs, 60000);
    assert.equal(knobs.updateRegistryBase(), "https://registry.example.invalid");
    assert.equal(knobs.updateCheckIntervalMs(), 2500);
    assert.equal(knobs.ccrRetrievalTtlMs(), 300000);
    assert.equal(knobs.codexCompactMode(), "pass");
    assert.equal(knobs.decompressTmpCap(), 7);
    assert.equal(knobs.bodyDumpEnabled(), true);
    assert.equal(knobs.dumpReqAllowed(), false);
    assert.equal(knobs.rawDumpDir(), "/tmp/knobs-raw");
    assert.equal(knobs.dump4xxEnabled(), true);
    assert.equal(knobs.dump4xxMaxBytes(), 4096);
    assert.equal(knobs.renderNone(), true);
    assert.equal(knobs.noInjectTool(), true);
    assert.equal(knobs.noCompressPrompt(), true);
    assert.equal(knobs.countTokensPassthrough(), true);
    assert.equal(knobs.forceTextProtocol(), true);
    assert.equal(knobs.keepResponseId(), true);
    assert.equal(knobs.noCacheControl(), true);
    assert.equal(knobs.fakeCompletionRetries(), 2);
    assert.equal(knobs.fakeBufCapBytes(), 1048576);
});

test("env tier always wins over the file (live test seams)", () => {
    setConfig({ network: { upstreamTimeoutMs: 60000, replayRetryMax: 5, postResponseLingerMs: 12345 }, persist: { enabled: false }, diagnostics: { renderNone: true, compressProtocol: "text" } });
    withEnv({
        BILI_UPSTREAM_TIMEOUT_MS: "999",
        BILI_REPLAY_RETRY_MAX: "2",
        BILI_POST_RESPONSE_LINGER_MS: "777",
        BILI_PERSIST: "1",
        ACP_RENDER_NONE: "",
        ACP_COMPRESS_PROTOCOL: "tools",
    }, () => {
        assert.equal(knobs.upstreamTimeoutMs(), 999);
        assert.equal(knobs.replayMaxAttempts(), 2);
        assert.equal(knobs.postResponseLingerMs(), 777);
        // persistEnabled env tier: only "0"/"false" disable; "1" forces on over file false
        assert.equal(knobs.persistEnabled(), true);
        // a SET (even empty) env var owns the knob: historical truthy check
        // says off, and the file tier is not consulted
        assert.equal(knobs.renderNone(), false);
        // "tools" !== "text" → false; the file's "text" is likewise ignored
        assert.equal(knobs.forceTextProtocol(), false);
    });
    withEnv({ BILI_PERSIST: "false" }, () => {
        assert.equal(knobs.persistEnabled(), false);
    });
});

test("set env owns the knob: garbage env resolves exactly as pre-migration", () => {
    setConfig({ network: { upstreamTimeoutMs: 60000, replayRetryBaseMs: 250, proxyKeepAliveMaxMs: 60000 }, persist: { debounceMs: 900 } });
    setConfig({ plugin: { snapshotCapBytes: 999 } });
    withEnv({
        BILI_UPSTREAM_TIMEOUT_MS: "abc",
        BILI_REPLAY_RETRY_BASE_MS: "xyz",
        BILI_PROXY_KEEPALIVE_MAX_MS: "junk",
        BILI_PERSIST_DEBOUNCE_MS: "soon",
        BILI_PUBLIC_SNAPSHOT_CAP_BYTES: "junk",
    }, () => {
        // each parses exactly as it did before the migration: garbage → default;
        // the file tier is untouched by a stale export
        assert.equal(knobs.upstreamTimeoutMs(), UPSTREAM_TIMEOUT_MS);
        assert.equal(knobs.replayBaseDelayMs(), REPLAY_BASE_DELAY_MS);
        assert.equal(knobs.proxyKeepAliveMaxMs(), PROXY_KEEPALIVE_MAX_MS);
        assert.equal(knobs.persistDebounceMs(), 500);
        assert.equal(knobs.publicSnapshotCapBytes(), 104_857_600);
    });
    // the plugin cap's pre-migration parser (Number(env)) treated "" as 0 —
    // "disables retention" — and that quirk survives byte-exact
    withEnv({ BILI_PUBLIC_SNAPSHOT_CAP_BYTES: "" }, () => {
        assert.equal(knobs.publicSnapshotCapBytes(), 0);
    });
    // loose parsers historically guarded with `if (!raw)`: empty env = unset,
    // so the file tier applies where no value was really given
    setConfig({ network: { requestWatchdogMs: 90000 } });
    withEnv({ BILI_REQUEST_WATCHDOG_MS: "" }, () => {
        assert.equal(knobs.requestWatchdogBudgetMs(), 90000);
    });
});

test("post-response linger: strict parseInt tier — set-but-empty/garbage env never consults the file (#1982)", () => {
    setConfig({ network: { postResponseLingerMs: 12345 } });
    withEnv({ BILI_POST_RESPONSE_LINGER_MS: "junk" }, () => {
        assert.equal(knobs.postResponseLingerMs(), 5_000);
    });
    // pre-migration parser was Number.parseInt(env ?? ""): an EMPTY export parsed
    // to NaN → default, unlike the tIntLoose family where empty means unset
    withEnv({ BILI_POST_RESPONSE_LINGER_MS: "" }, () => {
        assert.equal(knobs.postResponseLingerMs(), 5_000);
    });
});

test("garbage file values fall back to defaults, never throw", () => {
    setConfig({ network: { upstreamTimeoutMs: "fast", replayRetryMax: -3 }, persist: { tailTokens: null }, ccrRetrievalTtlMs: "whenever", plugin: { snapshotCapBytes: "huge" } });
    assert.equal(knobs.upstreamTimeoutMs(), UPSTREAM_TIMEOUT_MS);
    assert.equal(knobs.replayMaxAttempts(), REPLAY_MAX_ATTEMPTS);
    assert.equal(knobs.persistTailTokens(), 16384);
    assert.equal(knobs.ccrRetrievalTtlMs(), 10 * 60 * 1000);
});

test("historical parsing quirks survive migration", () => {
    clearConfig();
    // BILI_NO_CACHE_CONTROL is a TRUTHY string check: even "0" disables caching
    withEnv({ BILI_NO_CACHE_CONTROL: "0" }, () => {
        assert.equal(knobs.noCacheControl(), true);
    });
    // ACP_KEEP_RESPONSE_ID only "1" preserves
    withEnv({ ACP_KEEP_RESPONSE_ID: "true" }, () => {
        assert.equal(knobs.keepResponseId(), false);
    });
    withEnv({ ACP_KEEP_RESPONSE_ID: "1" }, () => {
        assert.equal(knobs.keepResponseId(), true);
    });
    // requestWatchdog: finite-but-negative passes through (operator opt-out)
    withEnv({ BILI_REQUEST_WATCHDOG_MS: "-5" }, () => {
        assert.equal(knobs.requestWatchdogBudgetMs(), -5);
    });
    // proxyKeepAliveMax: 0 = disable, negative = default
    withEnv({ BILI_PROXY_KEEPALIVE_MAX_MS: "0" }, () => {
        assert.equal(knobs.proxyKeepAliveMaxMs(), 0);
    });
    withEnv({ BILI_PROXY_KEEPALIVE_MAX_MS: "-1" }, () => {
        assert.equal(knobs.proxyKeepAliveMaxMs(), PROXY_KEEPALIVE_MAX_MS);
    });
    // gc enable words
    withEnv({ BILI_SESSION_GC: "on" }, () => {
        assert.equal(knobs.gcSettings().enabled, true);
    });
    // codex compact mode normalization
    withEnv({ BILI_CODEX_COMPACT: "PASS" }, () => {
        assert.equal(knobs.codexCompactMode(), "pass");
    });
    // dump4xx cap floor is 1 KiB
    withEnv({ BILI_DUMP_4XX: "1", BILI_DUMP_4XX_MAX_BYTES: "10" }, () => {
        assert.equal(knobs.dump4xxMaxBytes(), 1024);
    });
    // maxShrink range (0,1]
    withEnv({ BILI_MAX_SHRINK_PER_COMPRESS: "1.5" }, () => {
        assert.equal(knobs.maxShrinkPerCompress(), undefined);
    });
});

test("hot reload: rewriting the file between calls changes resolution", () => {
    setConfig({ network: { streamKeepAliveMs: 111 } });
    assert.equal(knobs.streamKeepAliveMs(), 111);
    setConfig({ network: { streamKeepAliveMs: 222 } });
    assert.equal(knobs.streamKeepAliveMs(), 222);
    clearConfig();
    assert.equal(knobs.streamKeepAliveMs(), 15_000);
});

test("teardown", () => {
    if (previousConfigFile === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = previousConfigFile;
    rmSync(root, { recursive: true, force: true });
});
