// #4254: circuit-open / connect-refused egress diagnosability. The client renders
// the `error` STRING, but bili answered every proxy failure with the constant
// "acp-proxy failure" while the real cause sat in `detail`/`upstreamFailure`/alerts.
// These tests pin the fix: informative `error` (legacy prefix kept), 503+Retry-After
// for a circuit-open fail-fast (initial failures stay 502, overflow stays 413),
// loopback-exempt host display, word-boundary truncation, and the fail-fast log throttle.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildProxyFailureResponse,
    withUpstreamFailure,
    markExpectedFailFast,
    isExpectedFailFast,
} from "../src/upstream-fail.ts";
import { isLoopbackHost, maskHostPortForDisplay } from "../src/log-mask.ts";
import {
    _resetUpstreamCircuitsForTest,
    _setCircuitCooldownForTest,
    recordUpstreamCircuitFailure,
    getOpenUpstreamCircuits,
    noteCircuitFailFastLog,
    upstreamCircuitRetryAfterSeconds,
} from "../src/upstream-alerts.ts";

function refused(): Error {
    return Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:8443"), { code: "ECONNREFUSED" });
}

// --- egress response builder ---------------------------------------------------

test("#4254 egress: unstructured error keeps the legacy constant + 502 (byte-identical)", () => {
    const msg = "boom";
    const { status, headers, body } = buildProxyFailureResponse(msg, new Error(msg));
    assert.equal(status, 502);
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers["retry-after"], undefined);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(parsed.error, "acp-proxy failure");
    assert.equal(parsed.detail, "boom");
    assert.ok(!("upstreamFailure" in parsed), "no structured slice => field omitted, as before");
});

test("#4254 egress: context-overflow doom keeps 413 (#2847)", () => {
    const { status, body } = buildProxyFailureResponse("payload exceeds the model window", new Error("x"));
    assert.equal(status, 413);
    assert.equal((JSON.parse(body) as { error?: string }).error, "acp-proxy failure");
});

test("#4254 egress: connect-refused initial failure is informative but STAYS 502", () => {
    const err = withUpstreamFailure(new Error("upstream request failed"), { kind: "connect-refused", code: "ECONNREFUSED", host: "127.0.0.1:7864" });
    const { status, headers, body } = buildProxyFailureResponse(String(err), err);
    assert.equal(status, 502, "initial transport failure is not a circuit-open fail-fast");
    assert.equal(headers["retry-after"], undefined);
    const parsed = JSON.parse(body) as { error?: string; upstreamFailure?: Record<string, unknown> };
    assert.equal(parsed.error, "acp-proxy failure: connect-refused ECONNREFUSED 127.0.0.1:7864");
    assert.equal(parsed.upstreamFailure?.kind, "connect-refused");
    assert.equal(parsed.upstreamFailure?.host, "127.0.0.1:7864");
    assert.equal(parsed.upstreamFailure?.circuitOpen, undefined);
});

test("#4254 egress: circuit-open fail-fast answers 503 + Retry-After, names the endpoint", () => {
    const err = withUpstreamFailure(new Error("upstream circuit open"), { kind: "connect-refused", code: "ECONNREFUSED", host: "10.0.0.5:8443", circuitOpen: true, retryAfterSeconds: 60 });
    const { status, headers, body } = buildProxyFailureResponse(String(err), err);
    assert.equal(status, 503);
    assert.equal(headers["retry-after"], "60");
    const parsed = JSON.parse(body) as { error?: string; upstreamFailure?: Record<string, unknown> };
    assert.match(parsed.error ?? "", /^acp-proxy failure: connect-refused ECONNREFUSED 10\.0\.0\.5:8443 \(circuit open, next probe \+60s\)$/);
    assert.equal(parsed.upstreamFailure?.circuitOpen, true);
    assert.equal(parsed.upstreamFailure?.retryAfterSeconds, 60);
});

test("#4254 egress: circuit-open without a scheduled probe still 503, no Retry-After", () => {
    const err = withUpstreamFailure(new Error("upstream circuit open"), { kind: "dns", circuitOpen: true });
    const { status, headers, body } = buildProxyFailureResponse(String(err), err);
    assert.equal(status, 503);
    assert.equal(headers["retry-after"], undefined);
    assert.match((JSON.parse(body) as { error?: string }).error ?? "", /circuit open/);
});

test("#4254 egress: expected-fail-fast marker round-trips and stays off JSON.stringify", () => {
    const plain = new Error("x");
    assert.equal(isExpectedFailFast(plain), false);
    assert.equal(isExpectedFailFast(undefined), false);
    assert.equal(isExpectedFailFast(null), false);
    const marked = markExpectedFailFast(plain);
    assert.equal(isExpectedFailFast(marked), true);
    assert.equal(JSON.stringify(plain), "{}", "marker is non-enumerable");
});

// --- host display rule (loopback-exempt) ---------------------------------------

test("#4254 display: loopback verbatim, non-public private masked, public passes through", () => {
    assert.equal(maskHostPortForDisplay("127.0.0.1:7864"), "127.0.0.1:7864");
    assert.equal(maskHostPortForDisplay("localhost:8443"), "localhost:8443");
    assert.equal(maskHostPortForDisplay("[::1]:9000"), "[::1]:9000");
    assert.equal(maskHostPortForDisplay("10.0.0.5:8443"), "<private-host>:8443");
    assert.equal(maskHostPortForDisplay("dead-host.invalid:8443"), "<private-host>:8443", "non-public (.invalid) host masks");
    assert.equal(maskHostPortForDisplay("api.openai.com:443"), "api.openai.com:443", "public LLM API host passes through");
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("[::1]"), true);
    assert.equal(isLoopbackHost("localHOST"), true);
    assert.equal(isLoopbackHost("10.0.0.5"), false);
    assert.equal(isLoopbackHost("dead-host.invalid"), false);
});

// --- circuit state accessors ---------------------------------------------------

test("#4254 circuit: last-failure detail truncates at a token boundary, not mid-word", () => {
    _resetUpstreamCircuitsForTest();
    const url = "http://dead-host.invalid:8443/v1/chat/completions";
    const detail = "alpha beta gamma delta ".repeat(20); // ~460 chars, regular token spacing
    assert.ok(detail.length > 240, "fixture exceeds the cap");
    for (let i = 0; i < 3; i++) recordUpstreamCircuitFailure(url, refused(), false, detail);
    const out = getOpenUpstreamCircuits()[0].lastFailure!.detail!;
    assert.ok(out.endsWith("…"), "truncated detail ends with an ellipsis");
    assert.ok(out.length <= 241, "within cap + ellipsis");
    const core = out.slice(0, -1);
    assert.ok(detail.startsWith(core), "kept a strict prefix of the original");
    assert.equal(detail[core.length], " ", "stopped exactly at a whitespace boundary (no mid-token cut)");
    _resetUpstreamCircuitsForTest();
});

test("#4254 circuit: Retry-After reflects the next-probe ETA; fail-fast warn throttles to one/window", () => {
    _resetUpstreamCircuitsForTest();
    _setCircuitCooldownForTest(60_000);
    const url = "http://dead-host.invalid:8443/v1/chat/completions";
    for (let i = 0; i < 3; i++) recordUpstreamCircuitFailure(url, refused(), false, "kind=connect-refused hint=x");
    const ra = upstreamCircuitRetryAfterSeconds(url);
    assert.ok(ra !== undefined && ra >= 1 && ra <= 60, `retry-after within the cooldown window, got ${ra}`);
    assert.equal(noteCircuitFailFastLog(url), true, "first fail-fast warn within the window logs");
    assert.equal(noteCircuitFailFastLog(url), false, "a second one immediately after is suppressed");
    _resetUpstreamCircuitsForTest();
});
