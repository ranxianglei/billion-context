import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadOptions } from "../src/config.ts";
import { formatUpstreamError, resolveProxyDecision } from "../src/upstream-proxy.ts";
import { UPSTREAM_FAIL_HINTS, hintWithSkippedProxy, redactedSkippedProxy } from "../src/upstream-fail.ts";
import { _resetUpstreamAlertsForTest, getUpstreamAlerts, recordUpstreamAlert } from "../src/upstream-alerts.ts";

// Hermetic state isolation for loadOptions (same pattern as the #1012 suite).
function withSandboxEnv(mutate: (env: NodeJS.ProcessEnv) => void, run: () => void): void {
    const prev = { ...process.env };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2809-home-"));
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_CACHE_HOME = path.join(home, ".cache");
    process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
    fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
    try {
        mutate(process.env);
        run();
    } finally {
        process.env = prev;
    }
}

function netError(code: string, message: string): Error {
    const err = new Error(message);
    (err as Error & { code?: string }).code = code;
    return err;
}

const TARGET = "https://relay.example.com/v1/chat/completions";
const ENV_PROXY = "http://user:pass@127.0.0.1:7890";
const SYS_PROXY = "http://127.0.0.1:7897";

test("resolveProxyDecision: unset mode (defaultDirect) names the skipped env proxy", () => {
    const d = resolveProxyDecision({}, "", TARGET, {
        biliPort: 42422,
        explicitDirect: true,
        defaultDirect: true,
        httpsProxy: ENV_PROXY,
        systemProxy: { enabled: false },
    });
    // egress decision is STILL direct — only the diagnostic payload changed
    assert.equal(d.source, "direct");
    assert.equal(d.proxy, undefined);
    assert.deepEqual(d.skippedProxy, { proxy: "http://user:pass@127.0.0.1:7890/", source: "HTTPS_PROXY" });
});

test("resolveProxyDecision: unset mode names the skipped Windows system proxy", () => {
    const d = resolveProxyDecision({}, "", TARGET, {
        biliPort: 42422,
        explicitDirect: true,
        defaultDirect: true,
        systemProxy: { enabled: true, https: SYS_PROXY, bypass: "localhost;127.*;" },
    });
    assert.equal(d.source, "direct");
    assert.deepEqual(d.skippedProxy, { proxy: `${SYS_PROXY}/`, source: "windows-system" });
});

test("resolveProxyDecision: NO_PROXY / ProxyOverride exclusion means no skipped note (user intent)", () => {
    // The decision itself stays the short-circuit's "direct" (egress + log
    // line unchanged vs before #2809); the PEEK just finds no proxy worth
    // naming when the user's own exclusion lists cover the host.
    // user's own NO_PROXY excludes the host → direct IS their preference
    const d1 = resolveProxyDecision({}, "", TARGET, {
        biliPort: 42422,
        explicitDirect: true,
        defaultDirect: true,
        httpsProxy: ENV_PROXY,
        noProxy: "relay.example.com",
        systemProxy: { enabled: false },
    });
    assert.equal(d1.source, "direct");
    assert.equal(d1.skippedProxy, undefined);

    // Clash-style windows bypass list excludes loopback targets
    const d2 = resolveProxyDecision({}, "", "https://127.0.0.1:8443/v1/messages", {
        biliPort: 42422,
        explicitDirect: true,
        defaultDirect: true,
        systemProxy: { enabled: true, https: SYS_PROXY, bypass: "localhost;127.*;<local>" },
    });
    assert.equal(d2.source, "direct");
    assert.equal(d2.skippedProxy, undefined);
});

test("resolveProxyDecision: EXPLICIT direct mode never nags (#2809 Q3)", () => {
    const d = resolveProxyDecision({}, "", TARGET, {
        biliPort: 42422,
        explicitDirect: true,
        defaultDirect: false,
        httpsProxy: ENV_PROXY,
        systemProxy: { enabled: false },
    });
    assert.deepEqual(d, { source: "direct" });
});

test("resolveProxyDecision: auto mode and empty-env defaults keep today's exact shape", () => {
    // auto mode: the tail runs for real, no diagnostic field at all
    const auto = resolveProxyDecision({}, undefined, TARGET, {
        biliPort: 42422,
        httpsProxy: ENV_PROXY,
        systemProxy: { enabled: false },
    });
    assert.deepEqual(auto, { proxy: "http://user:pass@127.0.0.1:7890/", source: "HTTPS_PROXY" });

    // nothing available anywhere → plain direct, byte-identical to before
    const bare = resolveProxyDecision({}, "", TARGET, {
        biliPort: 42422,
        explicitDirect: true,
        defaultDirect: true,
        systemProxy: { enabled: false },
    });
    assert.deepEqual(bare, { source: "direct" });
});

test("hintWithSkippedProxy: fail-fast kinds gain the suffix, others never do", () => {
    const skipped = { proxy: ENV_PROXY, source: "HTTPS_PROXY" };
    const annotated = hintWithSkippedProxy("connect-timeout", skipped);
    assert.ok(annotated.startsWith(UPSTREAM_FAIL_HINTS["connect-timeout"]));
    assert.match(annotated, /available proxy http:\/\/\*\*\*:\*\*\*@127\.0\.0\.1:7890 \(HTTPS_PROXY\)/);
    assert.match(annotated, /"upstreamProxyMode": "auto"/);
    assert.match(annotated, /BILI_UPSTREAM_PROXY_MODE=auto/);
    assert.ok(!annotated.includes("user:pass"), "credentials stay masked in the hint");

    // no info → byte-identical legacy hint (regression guard)
    assert.equal(hintWithSkippedProxy("connect-timeout", undefined), UPSTREAM_FAIL_HINTS["connect-timeout"]);
    // post-connect failure may have run on a working path → no misleading note
    assert.equal(hintWithSkippedProxy("upstream-timeout", skipped), UPSTREAM_FAIL_HINTS["upstream-timeout"]);
    assert.equal(hintWithSkippedProxy("unknown", skipped), UPSTREAM_FAIL_HINTS["unknown"]);
});

test("redactedSkippedProxy: masks credentials and drops the normalization slash", () => {
    assert.equal(redactedSkippedProxy({ proxy: "http://user:pass@127.0.0.1:7890/", source: "x" }), "http://***:***@127.0.0.1:7890");
    assert.equal(redactedSkippedProxy({ proxy: "http://127.0.0.1:7890/", source: "x" }), "http://127.0.0.1:7890");
});

test("formatUpstreamError: skipped note lands in the hint part, masking intact", () => {
    const err = netError("UND_ERR_CONNECT_TIMEOUT", "connect ETIMEDOUT 10.0.0.5:8443");
    const url = "http://10.0.0.5:8443/v1/messages";

    const plain = formatUpstreamError(err, url);
    assert.ok(plain.endsWith(`hint=${UPSTREAM_FAIL_HINTS["connect-timeout"]}`), "no-skipped output is byte-identical to before");

    const noted = formatUpstreamError(err, url, undefined, { proxy: ENV_PROXY, source: "HTTPS_PROXY" });
    assert.match(noted, /^kind=connect-timeout /);
    assert.match(noted, /proxy=direct/);
    assert.ok(noted.includes("http://***:***@127.0.0.1:7890"), "skipped proxy named, masked");
    assert.ok(!noted.includes("user:pass"), "credentials never reach the log line");
    assert.ok(!noted.includes("10.0.0.5") || noted.includes("(masked)"), "upstream host masking unchanged");
});

test("recordUpstreamAlert: structured skipped fields ride along for the localized banner", () => {
    _resetUpstreamAlertsForTest();
    const err = netError("UND_ERR_CONNECT_TIMEOUT", "connect timed out");
    recordUpstreamAlert(TARGET, err, false, { proxy: ENV_PROXY, source: "HTTPS_PROXY" });
    let [a] = getUpstreamAlerts();
    assert.ok(a, "alert recorded");
    assert.equal(a.kind, "connect-timeout");
    assert.equal(a.skippedProxy, "http://***:***@127.0.0.1:7890");
    assert.equal(a.skippedSource, "HTTPS_PROXY");
    assert.ok(a.hint.startsWith(UPSTREAM_FAIL_HINTS["connect-timeout"]));
    assert.match(a.hint, /available proxy http:\/\/\*\*\*:\*\*\*@127\.0\.0\.1:7890/);

    // repeat refreshes count AND keeps the diagnostic (same decision per host)
    recordUpstreamAlert(TARGET, err, false, { proxy: ENV_PROXY, source: "HTTPS_PROXY" });
    [a] = getUpstreamAlerts();
    assert.equal(a.count, 2);
    assert.equal(a.skippedProxy, "http://***:***@127.0.0.1:7890");

    // a failure WITHOUT skipped info keeps the legacy shape (no stray fields)
    _resetUpstreamAlertsForTest();
    recordUpstreamAlert(TARGET, netError("ECONNREFUSED", "connect ECONNREFUSED"), false);
    [a] = getUpstreamAlerts();
    assert.equal(a.skippedProxy, undefined);
    assert.equal(a.skippedSource, undefined);
    assert.equal(a.hint, UPSTREAM_FAIL_HINTS["connect-refused"]);
});

test("loadOptions: defaultDirect tracks UNSET mode only (model path)", () => {
    // unset mode + available env proxy → the full #2809 scenario end-to-end
    withSandboxEnv(() => {}, () => {
        const opts = loadOptions({ ACP_PORT: "42422", HTTPS_PROXY: ENV_PROXY });
        assert.equal(opts.proxyFallback?.explicitDirect, true);
        assert.equal(opts.proxyFallback?.defaultDirect, true);
        const d = resolveProxyDecision({}, opts.proxy, TARGET, opts.proxyFallback!);
        assert.equal(d.source, "direct");
        assert.equal(d.skippedProxy?.source, "HTTPS_PROXY");
        // aux fallback inherits defaultDirect but its explicitDirect=false, so
        // the short-circuit (and thus the peek) can never fire for aux egress
        const aux = resolveProxyDecision({}, opts.proxy, TARGET, opts.auxProxyFallback!);
        assert.equal(aux.skippedProxy, undefined);
    });

    // EXPLICIT "direct" mode → no nag even with an available proxy
    withSandboxEnv(() => {}, () => {
        const opts = loadOptions({ ACP_PORT: "42422", BILI_UPSTREAM_PROXY_MODE: "direct", HTTPS_PROXY: ENV_PROXY });
        assert.equal(opts.proxyFallback?.defaultDirect, false);
        const d = resolveProxyDecision({}, opts.proxy, TARGET, opts.proxyFallback!);
        assert.deepEqual(d, { source: "direct" });
    });

    // explicit proxy set (mode still unset) → defaultDirect false, nothing skipped
    withSandboxEnv(() => {}, () => {
        const opts = loadOptions({ ACP_PORT: "42422", BILI_UPSTREAM_PROXY: "http://explicit:3128", HTTPS_PROXY: ENV_PROXY });
        assert.equal(opts.proxyFallback?.defaultDirect, false);
        const d = resolveProxyDecision({}, opts.proxy, TARGET, opts.proxyFallback!);
        assert.equal(d.source, "bili-env");
        assert.equal(d.skippedProxy, undefined);
    });

    // unset mode but NO proxy anywhere → plain direct, no diagnostic field
    withSandboxEnv((env) => {
        delete env.HTTPS_PROXY;
        delete env.HTTP_PROXY;
        delete env.ALL_PROXY;
    }, () => {
        const opts = loadOptions({ ACP_PORT: "42422" });
        assert.equal(opts.proxyFallback?.defaultDirect, true);
        const d = resolveProxyDecision({}, opts.proxy, TARGET, { ...opts.proxyFallback!, systemProxy: { enabled: false } });
        assert.deepEqual(d, { source: "direct" });
    });
});
