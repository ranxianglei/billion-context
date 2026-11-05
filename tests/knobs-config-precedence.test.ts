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

test("#3128 limits: defaults 5/10/5 GiB, file tier, env precedence, garbage falls back", () => {
    clearConfig();
    assert.equal(knobs.limitsReceiveBytes(), 5 * 1024 * 1024 * 1024);
    assert.equal(knobs.limitsDecodedBytes(), 10 * 1024 * 1024 * 1024);
    assert.equal(knobs.limitsOutboundBytes(), 5 * 1024 * 1024 * 1024);

    setConfig({ network: { receiveBodyBytes: 111, decodedBodyBytes: 222, outboundBodyBytes: 333 } });
    assert.equal(knobs.limitsReceiveBytes(), 111);
    assert.equal(knobs.limitsDecodedBytes(), 222);
    assert.equal(knobs.limitsOutboundBytes(), 333);

    withEnv({ BILI_RECEIVE_BODY_BYTES: "999", BILI_DECODED_BODY_BYTES: "888", BILI_OUTBOUND_BODY_BYTES: "777" }, () => {
        assert.equal(knobs.limitsReceiveBytes(), 999);
        assert.equal(knobs.limitsDecodedBytes(), 888);
        assert.equal(knobs.limitsOutboundBytes(), 777);
    });

    // non-numeric / non-positive values resolve to the default and never throw
    setConfig({ network: { receiveBodyBytes: "big", decodedBodyBytes: -3, outboundBodyBytes: 0 } });
    assert.equal(knobs.limitsReceiveBytes(), 5 * 1024 * 1024 * 1024);
    assert.equal(knobs.limitsDecodedBytes(), 10 * 1024 * 1024 * 1024);
    assert.equal(knobs.limitsOutboundBytes(), 5 * 1024 * 1024 * 1024);
    withEnv({ BILI_RECEIVE_BODY_BYTES: "junk" }, () => {
        assert.equal(knobs.limitsReceiveBytes(), 5 * 1024 * 1024 * 1024);
    });
    clearConfig();
});

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
    // (#4079) the #726 dead-end cooldown knob was removed with the mechanism.
    assert.equal(knobs.proxyKeepAliveMaxMs(), PROXY_KEEPALIVE_MAX_MS);
    assert.equal(knobs.postResponseLingerMs(), 5_000);
    assert.equal(knobs.allowPrivateHttpProviders(), false);
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
            preflightHoldMs: 40000, replayRetryMax: 5,
            replayRetryBaseMs: 250, maxShrinkPerCompress: 0.4, proxyKeepAliveMaxMs: 60000,
            postResponseLingerMs: 12345, allowPrivateHttpProviders: true,
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
    assert.equal(knobs.replayMaxAttempts(), 5);
    assert.equal(knobs.replayBaseDelayMs(), 250);
    assert.equal(knobs.maxShrinkPerCompress(), 0.4);
    assert.equal(knobs.proxyKeepAliveMaxMs(), 60000);
    assert.equal(knobs.postResponseLingerMs(), 12345);
    assert.equal(knobs.allowPrivateHttpProviders(), true);
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

test("dump GC caps: default off, floors, explicit-off env wins (#2412)", () => {
    clearConfig();
    assert.equal(knobs.dumpGcMaxTotalBytes(), null);
    assert.equal(knobs.dumpGcMaxAgeMs(), null);

    setConfig({ diagnostics: { maxTotalBytes: 8 * 1024 * 1024, maxAgeDays: 7 } });
    assert.equal(knobs.dumpGcMaxTotalBytes(), 8 * 1024 * 1024);
    assert.equal(knobs.dumpGcMaxAgeMs(), 7 * 86_400_000);

    // floors: 1 MiB for bytes, 1 h for age
    setConfig({ diagnostics: { maxTotalBytes: 1024, maxAgeDays: 0.001 } });
    assert.equal(knobs.dumpGcMaxTotalBytes(), 1 << 20);
    assert.equal(knobs.dumpGcMaxAgeMs(), (1 / 24) * 86_400_000);

    // 0/negative file values = off
    setConfig({ diagnostics: { maxTotalBytes: 0, maxAgeDays: -3 } });
    assert.equal(knobs.dumpGcMaxTotalBytes(), null);
    assert.equal(knobs.dumpGcMaxAgeMs(), null);

    // a SET env var always wins over the file tier — including explicit off
    setConfig({ diagnostics: { maxTotalBytes: 8 * 1024 * 1024, maxAgeDays: 7 } });
    withEnv({ BILI_DUMP_MAX_TOTAL_BYTES: "16777216", BILI_DUMP_MAX_AGE_DAYS: "3" }, () => {
        assert.equal(knobs.dumpGcMaxTotalBytes(), 16777216);
        assert.equal(knobs.dumpGcMaxAgeMs(), 3 * 86_400_000);
    });
    withEnv({ BILI_DUMP_MAX_TOTAL_BYTES: "0" }, () => {
        assert.equal(knobs.dumpGcMaxTotalBytes(), null);
    });
    withEnv({ BILI_DUMP_MAX_TOTAL_BYTES: "garbage" }, () => {
        assert.equal(knobs.dumpGcMaxTotalBytes(), null);
    });
    withEnv({ BILI_DUMP_MAX_AGE_DAYS: "-1" }, () => {
        assert.equal(knobs.dumpGcMaxAgeMs(), null);
    });
    clearConfig();
});

test("sessions warm/resident budgets: file tier + env precedence (#2803)", () => {
    clearConfig();
    // #3050 R3 ②-0: warm set is off by default (lazy first touch) — set warmMax to opt back in
    assert.equal(knobs.sessionWarmMax(), 0);
    assert.equal(knobs.sessionWarmMaxBytes(), 64 * 1024 * 1024);
    assert.equal(knobs.sessionResidentMaxBytes(), 512 * 1024 * 1024);

    setConfig({ sessions: { warmMax: 3, warmMaxBytes: 123456, residentMaxBytes: 777 } });
    assert.equal(knobs.sessionWarmMax(), 3);
    assert.equal(knobs.sessionWarmMaxBytes(), 123456);
    assert.equal(knobs.sessionResidentMaxBytes(), 777);

    // explicit 0 is honored (warm nothing / zero budget) — not swallowed by `|| default`
    setConfig({ sessions: { warmMax: 0, warmMaxBytes: 0, residentMaxBytes: 0 } });
    assert.equal(knobs.sessionWarmMax(), 0);
    assert.equal(knobs.sessionWarmMaxBytes(), 0);
    assert.equal(knobs.sessionResidentMaxBytes(), 0);

    // garbage / negative file values fall back to the defaults
    setConfig({ sessions: { warmMax: -2, warmMaxBytes: "big", residentMaxBytes: -1 } });
    assert.equal(knobs.sessionWarmMax(), 0);
    assert.equal(knobs.sessionWarmMaxBytes(), 64 * 1024 * 1024);
    assert.equal(knobs.sessionResidentMaxBytes(), 512 * 1024 * 1024);

    withEnv({ BILI_SESSION_WARM_MAX: "5", BILI_SESSION_WARM_MAX_BYTES: "999", BILI_SESSION_RESIDENT_MAX_BYTES: "42" }, () => {
        assert.equal(knobs.sessionWarmMax(), 5);
        assert.equal(knobs.sessionWarmMaxBytes(), 999);
        assert.equal(knobs.sessionResidentMaxBytes(), 42);
    });
    withEnv({ BILI_SESSION_WARM_MAX: "garbage" }, () => {
        assert.equal(knobs.sessionWarmMax(), 0);
    });
    clearConfig();
});

test("#2984 allowPrivateHttpProviders: positive env judgment, file tier, env wins", () => {
    clearConfig();
    assert.equal(knobs.allowPrivateHttpProviders(), false, "default off");
    setConfig({ network: { allowPrivateHttpProviders: true } });
    assert.equal(knobs.allowPrivateHttpProviders(), true, "file tier");
    withEnv({ BILI_ALLOW_PRIVATE_HTTP_PROVIDERS: "0" }, () => {
        assert.equal(knobs.allowPrivateHttpProviders(), false, "set env owns the knob: explicit off beats file on");
    });
    withEnv({ BILI_ALLOW_PRIVATE_HTTP_PROVIDERS: "true" }, () => {
        assert.equal(knobs.allowPrivateHttpProviders(), true);
    });
    setConfig({});
    withEnv({ BILI_ALLOW_PRIVATE_HTTP_PROVIDERS: "yes" }, () => {
        assert.equal(knobs.allowPrivateHttpProviders(), false, "only 1/true enable — garbage env is off");
    });
    clearConfig();
});

test("#3331 guardrail knobs: bash-timeout default 60 (#3066 anti-hang), file tier, env wins; 0 disables; cap/repetition defaults on", () => {
    clearConfig();
    assert.equal(knobs.guardrailBashTimeout(), 60, "default 60s — #3066 owner intent, unsupervised bash hung pi sessions");
    assert.equal(knobs.guardrailMaxOutputBytes(), 50_000, "default cap 50KB");
    assert.equal(knobs.guardrailRepetition(), true, "loop-breaker default on");

    setConfig({ guardrails: { bashTimeout: 45, maxOutputBytes: 12345, repetition: false } });
    assert.equal(knobs.guardrailBashTimeout(), 45, "file tier");
    assert.equal(knobs.guardrailMaxOutputBytes(), 12345, "file tier");
    assert.equal(knobs.guardrailRepetition(), false, "file tier");

    withEnv({ BILI_GUARDRAIL_BASH_TIMEOUT: "120" }, () => {
        assert.equal(knobs.guardrailBashTimeout(), 120, "env wins");
    });
    withEnv({ BILI_GUARDRAIL_BASH_TIMEOUT: "0" }, () => {
        assert.equal(knobs.guardrailBashTimeout(), undefined, "0 = off (pi-native), even with the file tier on");
    });
    withEnv({ BILI_GUARDRAIL_MAX_OUTPUT_BYTES: "0" }, () => {
        assert.equal(knobs.guardrailMaxOutputBytes(), undefined, "0 disables the cap");
    });
    withEnv({ BILI_GUARDRAIL_REPETITION: "0" }, () => {
        assert.equal(knobs.guardrailRepetition(), false, "env off beats file off/on alike");
    });
    clearConfig();
});

test("#3406 text-run threshold knob: default 200 (#3260 parity), file tier, env wins; 0 disables", () => {
    clearConfig();
    assert.equal(knobs.guardrailTextRunThreshold(), 200, "default 200 — unchanged from the pre-knob constant");
    assert.equal(knobs.DEFAULT_TEXT_RUN_THRESHOLD, 200, "exported default pins the documented 200");

    setConfig({ guardrails: { textRunThreshold: 500 } });
    assert.equal(knobs.guardrailTextRunThreshold(), 500, "file tier");

    withEnv({ BILI_GUARDRAIL_TEXT_RUN_THRESHOLD: "1000" }, () => {
        assert.equal(knobs.guardrailTextRunThreshold(), 1000, "env wins over the file tier");
    });
    withEnv({ BILI_GUARDRAIL_TEXT_RUN_THRESHOLD: "250.9" }, () => {
        assert.equal(knobs.guardrailTextRunThreshold(), 250, "fractional floors");
    });
    withEnv({ BILI_GUARDRAIL_TEXT_RUN_THRESHOLD: "0" }, () => {
        assert.equal(knobs.guardrailTextRunThreshold(), 0, "0 = lane off, even with the file tier set");
    });
    withEnv({ BILI_GUARDRAIL_TEXT_RUN_THRESHOLD: "-5" }, () => {
        assert.equal(knobs.guardrailTextRunThreshold(), 0, "negative = off (same convention as bashTimeout)");
    });
    withEnv({ BILI_GUARDRAIL_TEXT_RUN_THRESHOLD: "garbage" }, () => {
        assert.equal(knobs.guardrailTextRunThreshold(), 200, "garbage env falls back to the default, not off");
    });
    setConfig({ guardrails: { textRunThreshold: 0 } });
    assert.equal(knobs.guardrailTextRunThreshold(), 0, "file tier 0 disables too");
    setConfig({ guardrails: { textRunThreshold: "big" } });
    assert.equal(knobs.guardrailTextRunThreshold(), 200, "garbage file value falls back to the default");
    clearConfig();
});

test("#3619 stagger knobs: undefined default (caller composes), ms file tier, duration STRINGS in the file tier, env raw ms", () => {
    clearConfig();
    assert.equal(knobs.updateStaggerMinDelayMs(), undefined, "no local setting — caller composes remote+builtin");
    assert.equal(knobs.updateStaggerMaxDelayMs(), undefined);

    setConfig({ update: { staggerMinDelayMs: 900_000, staggerMaxDelayMs: 43_200_000 } });
    assert.equal(knobs.updateStaggerMinDelayMs(), 900_000, "numeric file tier = raw ms");
    assert.equal(knobs.updateStaggerMaxDelayMs(), 43_200_000);

    setConfig({ update: { staggerMinDelayMs: "15m", staggerMaxDelayMs: "12h" } });
    assert.equal(knobs.updateStaggerMinDelayMs(), 900_000, "string file tier parsed (#3619)");
    assert.equal(knobs.updateStaggerMaxDelayMs(), 43_200_000);

    setConfig({ update: { staggerMinDelayMs: "1d12h", staggerMaxDelayMs: "2d" } });
    assert.equal(knobs.updateStaggerMinDelayMs(), 129_600_000, "combined segments");

    withEnv({ BILI_UPDATE_STAGGER_MIN_MS: "0" }, () => {
        assert.equal(knobs.updateStaggerMinDelayMs(), 0, "env 0 wins over the file tier (legacy immediate)");
    });
    withEnv({ BILI_UPDATE_STAGGER_MIN_MS: "not-a-number" }, () => {
        assert.equal(knobs.updateStaggerMinDelayMs(), undefined, "garbage env = not set (env tier stays raw ms)");
    });
    setConfig({ update: { staggerMinDelayMs: "garbage" } });
    assert.equal(knobs.updateStaggerMinDelayMs(), undefined, "garbage file value = not set, never guessed");
    setConfig({ update: { staggerMinDelayMs: 0 } });
    assert.equal(knobs.updateStaggerMinDelayMs(), 0, "file tier 0 is a valid explicit opt-out");
    clearConfig();
});

test("teardown", () => {
    if (previousConfigFile === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = previousConfigFile;
    rmSync(root, { recursive: true, force: true });
});
