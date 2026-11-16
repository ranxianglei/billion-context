import assert from "node:assert/strict";
import http from "node:http";
import { beforeEach, test } from "node:test";
import {
    getOpenUpstreamCircuits,
    getUpstreamAlerts,
    getUpstreamHealthReport,
    recordUpstreamAlert,
    recordUpstreamCircuitFailure,
    _resetUpstreamAlertsForTest,
    _resetUpstreamCircuitsForTest,
} from "../src/upstream-alerts.ts";

const upstream = "https://example.test/v1/messages";

function wrapped(code: string, depth: number): Error {
    let error: Error = Object.assign(new Error("transport failed"), { code });
    for (let i = 0; i < depth; i++) error = new TypeError("fetch failed", { cause: error });
    return error;
}

beforeEach(() => {
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
});

for (const [code, depth, viaProxy, kind] of [
    ["ECONNREFUSED", 0, false, "connect-refused"],
    ["ECONNREFUSED", 1, false, "connect-refused"],
    ["ENOTFOUND", 3, false, "dns"],
    ["ECONNRESET", 1, true, "proxy-reset"],
    ["UND_ERR_CONNECT_TIMEOUT", 2, false, "connect-timeout"],
    ["CERT_HAS_EXPIRED", 1, false, "tls"],
    ["ENETUNREACH", 7, false, "upstream-unreachable"],
] as const) {
    test(`${code} at cause depth ${depth} reaches alerts and open-circuit health`, () => {
        const error = wrapped(code, depth);
        recordUpstreamAlert(upstream, error, viaProxy);
        assert.equal(getUpstreamAlerts()[0]?.kind, kind);
        assert.equal(getUpstreamAlerts()[0]?.code, code);
        assert.equal(getUpstreamHealthReport().upstreams[0]?.code, code);

        for (let i = 0; i < 3; i++) recordUpstreamCircuitFailure(upstream, error, viaProxy);
        assert.equal(getOpenUpstreamCircuits()[0]?.lastFailure?.code, code);
        assert.equal(getUpstreamHealthReport().upstreams[0]?.code, code);
        assert.equal(getUpstreamHealthReport().upstreams[0]?.kind, kind);
        assert.equal(getUpstreamHealthReport().upstreams[0]?.count, 3);
    });
}

test("an outer nonempty code keeps precedence over its cause", () => {
    const error = Object.assign(new Error("outer refusal", { cause: wrapped("ECONNRESET", 0) }), { code: "ECONNREFUSED" });
    recordUpstreamAlert(upstream, error, false);
    assert.equal(getUpstreamAlerts()[0]?.kind, "connect-refused");
    assert.equal(getUpstreamAlerts()[0]?.code, "ECONNREFUSED");
});

for (const code of ["", 0]) {
    test(`a nonusable outer code ${JSON.stringify(code)} does not hide the cause errno`, () => {
        const error = Object.assign(new Error("wrapper", { cause: wrapped("ECONNRESET", 0) }), { code });
        recordUpstreamAlert(upstream, error, false);
        assert.equal(getUpstreamAlerts()[0]?.kind, "upstream-reset");
        assert.equal(getUpstreamAlerts()[0]?.code, "ECONNRESET");
    });
}

test("a repeated failure updates the same alert with the new nested errno", () => {
    recordUpstreamAlert(upstream, wrapped("ECONNRESET", 0), false);
    recordUpstreamAlert(upstream, wrapped("EPIPE", 1), false);
    assert.equal(getUpstreamAlerts().length, 1);
    assert.equal(getUpstreamAlerts()[0].count, 2);
    assert.equal(getUpstreamAlerts()[0].code, "EPIPE");
});

test("an error beyond the taxonomy's eight-entry cause bound stays unclassified", () => {
    recordUpstreamAlert(upstream, wrapped("ECONNREFUSED", 8), false);
    assert.deepEqual(getUpstreamAlerts(), []);
    for (let i = 0; i < 3; i++) recordUpstreamCircuitFailure(upstream, wrapped("ECONNREFUSED", 0), false);
    recordUpstreamCircuitFailure(upstream, wrapped("ECONNREFUSED", 8), false);
    assert.equal(getOpenUpstreamCircuits()[0]?.lastFailure?.kind, "unknown");
    assert.equal(getOpenUpstreamCircuits()[0]?.lastFailure?.code, undefined);
});

test("a cyclic cause without a code terminates without inventing an errno", () => {
    const error = new Error("cyclic cause");
    error.cause = error;
    recordUpstreamAlert(upstream, error, false);
    assert.deepEqual(getUpstreamAlerts(), []);
    for (let i = 0; i < 3; i++) recordUpstreamCircuitFailure(upstream, wrapped("ECONNREFUSED", 0), false);
    recordUpstreamCircuitFailure(upstream, error, false);
    assert.equal(getOpenUpstreamCircuits()[0]?.lastFailure?.code, undefined);
});

test("native Fetch socket errors retain their actual cause code in both health windows", async () => {
    const server = http.createServer((req) => req.socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/v1/messages`;
    try {
        let failure: unknown;
        try { await fetch(url); } catch (error) { failure = error; }
        assert.ok(failure instanceof TypeError);
        assert.equal((failure as Error & { code?: unknown }).code, undefined);
        assert.ok(failure.cause instanceof Error);
        assert.equal((failure.cause as Error & { code?: unknown }).code, "UND_ERR_SOCKET");
        recordUpstreamAlert(url, failure, false);
        assert.equal(getUpstreamHealthReport().upstreams[0]?.code, "UND_ERR_SOCKET");
        for (let i = 0; i < 3; i++) recordUpstreamCircuitFailure(url, failure, false);
        assert.equal(getOpenUpstreamCircuits()[0]?.lastFailure?.code, "UND_ERR_SOCKET");
        assert.equal(getUpstreamHealthReport().upstreams[0]?.code, "UND_ERR_SOCKET");
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
