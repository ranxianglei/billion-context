import test from "node:test";
import assert from "node:assert/strict";
import { loadOptions, parseUpstreamProxyMode } from "../src/config.ts";
import { resolveProxyDecision } from "../src/upstream-proxy.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import {
    acquireInFlight,
    getSession,
    releaseInFlight,
    _resetSessionsForTest,
    _sessionsSizeForTest,
} from "../src/session.ts";

const HTTPS_UPSTREAM = "https://upstream.example/v1/messages";

test("parseUpstreamProxyMode: unset -> direct (default), explicit strings preserved", () => {
    assert.equal(parseUpstreamProxyMode(undefined), "direct");
    assert.equal(parseUpstreamProxyMode("direct"), "direct");
    assert.equal(parseUpstreamProxyMode("manual"), "manual");
    assert.equal(parseUpstreamProxyMode("auto"), "auto");
    assert.equal(parseUpstreamProxyMode("garbage"), "direct");
});

test("resolveProxyDecision: default mode (explicitDirect=false) + HTTPS_PROXY -> uses env proxy", () => {
    const decision = resolveProxyDecision({}, "", HTTPS_UPSTREAM, {
        httpsProxy: "http://proxy.example:8080",
        explicitDirect: false,
    });
    assert.equal(decision.source, "HTTPS_PROXY");
    assert.equal(decision.proxy, "http://proxy.example:8080/");
});

test("resolveProxyDecision: default mode (explicitDirect omitted) + HTTPS_PROXY -> uses env proxy", () => {
    const decision = resolveProxyDecision({}, "", HTTPS_UPSTREAM, {
        httpsProxy: "http://proxy.example:8080",
    });
    assert.equal(decision.source, "HTTPS_PROXY");
    assert.equal(decision.proxy, "http://proxy.example:8080/");
});

test("resolveProxyDecision: explicit direct (explicitDirect=true) + HTTPS_PROXY -> direct, env ignored", () => {
    const decision = resolveProxyDecision({}, "", HTTPS_UPSTREAM, {
        httpsProxy: "http://proxy.example:8080",
        explicitDirect: true,
    });
    assert.equal(decision.source, "direct");
    assert.equal(decision.proxy, undefined);
});

test("resolveProxyDecision: default mode + HTTP_PROXY (http target) -> uses HTTP_PROXY", () => {
    const decision = resolveProxyDecision({}, "", "http://upstream.example/v1/messages", {
        httpProxy: "http://proxy.example:8080",
        explicitDirect: false,
    });
    assert.equal(decision.source, "HTTP_PROXY");
    assert.equal(decision.proxy, "http://proxy.example:8080/");
});

test("resolveProxyDecision: default mode + ALL_PROXY fallback -> uses ALL_PROXY", () => {
    const decision = resolveProxyDecision({}, "", HTTPS_UPSTREAM, {
        allProxy: "http://all.example:8080",
        explicitDirect: false,
    });
    assert.equal(decision.source, "ALL_PROXY");
    assert.equal(decision.proxy, "http://all.example:8080/");
});

test("resolveProxyDecision: default mode, no env set -> still direct", () => {
    const decision = resolveProxyDecision({}, "", HTTPS_UPSTREAM, {
        explicitDirect: false,
    });
    assert.equal(decision.source, "direct");
    assert.equal(decision.proxy, undefined);
});

test("resolveProxyDecision: explicit global proxy (manual mode) still wins over env", () => {
    const decision = resolveProxyDecision({}, "http://global.example:9090", HTTPS_UPSTREAM, {
        httpsProxy: "http://proxy.example:8080",
        globalSource: "config",
    });
    assert.equal(decision.source, "config");
    assert.equal(decision.proxy, "http://global.example:9090/");
});

// --- Bug 2: loadOptions rejects out-of-range ports. ---

// 0 is valid: OS-assigned port for the #521 daemon handshake.
for (const bad of ["-1", "99999", "65536", "abc"]) {
    test(`loadOptions: port ${JSON.stringify(bad)} throws`, () => {
        assert.throws(() => loadOptions({ ACP_PORT: bad }), /Invalid port .* must be 0-65535/);
    });
}

for (const good of ["0", "1", "80", "8787", "65535"]) {
    test(`loadOptions: port ${good} accepted`, () => {
        const opts = loadOptions({ ACP_PORT: good });
        assert.equal(opts.port, Number(good));
    });
}

test("loadOptions: PORT env also validated (ACP_PORT absent)", () => {
    assert.throws(() => loadOptions({ PORT: "-1" }), /Invalid port/);
    assert.throws(() => loadOptions({ PORT: "99999" }), /Invalid port/);
});

test("loadOptions: ACP_HOST=localhost is normalized to 127.0.0.1; explicit hosts pass through", () => {
    assert.equal(loadOptions({ ACP_HOST: "localhost" }).host, "127.0.0.1");
    assert.equal(loadOptions({ ACP_HOST: "0.0.0.0" }).host, "0.0.0.0");
    assert.equal(loadOptions({ ACP_HOST: "::1" }).host, "::1");
});

// --- Bug 3: getSession must not exceed MAX_SESSIONS when eviction can't free
//     an in-flight slot; pool-exhausted throws instead of growing the Map. ---

test("getSession: throws when pool exhausted and the only candidate is in-flight", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest(1);
    try {
        const a = getSession("a");
        acquireInFlight(a);
        assert.equal(_sessionsSizeForTest(), 1);
        assert.throws(
            () => getSession("b"),
            /session pool exhausted \(MAX_SESSIONS=1; all in-flight\)/,
        );
        assert.equal(_sessionsSizeForTest(), 1, "pool size must not grow past MAX");
    } finally {
        releaseInFlight(getSession("a"));
        _resetSessionsForTest();
    }
});

test("getSession: evicts an idle session to make room when at MAX", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest(1);
    try {
        const a = getSession("a");
        assert.equal(_sessionsSizeForTest(), 1);
        const b = getSession("b");
        assert.equal(_sessionsSizeForTest(), 1, "eviction must keep pool at MAX");
        assert.notEqual(a.id, b.id);
    } finally {
        _resetSessionsForTest();
    }
});

test("getSession: below MAX, no eviction, no throw", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest(256);
    try {
        getSession("x");
        getSession("y");
        getSession("z");
        assert.equal(_sessionsSizeForTest(), 3);
    } finally {
        _resetSessionsForTest();
    }
});

test("_resetSessionsForTest: clamps MAX to minimum 1 (mirrors module-load clamp)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest(-5);
    try {
        const a = getSession("a");
        acquireInFlight(a);
        assert.throws(() => getSession("b"), /MAX_SESSIONS=1/);
    } finally {
        releaseInFlight(getSession("a"));
        _resetSessionsForTest();
    }
});
