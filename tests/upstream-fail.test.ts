import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { classifyUpstreamFailure, isFailFastUpstreamKind, UPSTREAM_FAIL_HINTS } from "../src/upstream-fail.ts";
import { _resetFetchUtilForTest, fetchWithRetry } from "../src/fetch-util.ts";
import { formatUpstreamError } from "../src/upstream-proxy.ts";
import { proxyKeepAliveMaxMs, PROXY_KEEPALIVE_MAX_MS } from "../src/upstream-proxy.ts";

function listen(server: http.Server): Promise<void> {
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function netError(code: string, message: string, cause?: Error): Error {
    const err = new Error(message, cause === undefined ? undefined : { cause });
    (err as Error & { code?: string }).code = code;
    return err;
}

test("classify: taxonomy covers the three headline kinds from #1263 plus the rest", () => {
    // proxy reset — connect-phase ECONNRESET through a proxy
    assert.equal(classifyUpstreamFailure(netError("ECONNRESET", "socket hang up"), { viaProxy: true }), "proxy-reset");
    // upstream timeout — the idle watchdog's own abort (no external signal)
    const abortErr = new Error("This operation was aborted");
    abortErr.name = "AbortError";
    assert.equal(classifyUpstreamFailure(abortErr), "upstream-timeout");
    // client abort — external signal fired
    assert.equal(classifyUpstreamFailure(abortErr, { externalAborted: true }), "client-abort");
    // same reset, direct connection → upstream suspect
    assert.equal(classifyUpstreamFailure(netError("ECONNRESET", "socket hang up"), { viaProxy: false }), "upstream-reset");
    // wrapped undici chains — classification must see through the cause chain
    const wrapped = new Error("fetch failed", { cause: netError("ECONNRESET", "read ECONNRESET") });
    assert.equal(classifyUpstreamFailure(wrapped, { viaProxy: true }), "proxy-reset");
    const refused = new Error("fetch failed", { cause: netError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:8199") });
    assert.equal(classifyUpstreamFailure(refused), "connect-refused");
    assert.equal(classifyUpstreamFailure(netError("ETIMEDOUT", "connect ETIMEDOUT"), {}), "upstream-timeout");
    assert.equal(classifyUpstreamFailure(netError("UND_ERR_HEADERS_TIMEOUT", "headers timeout")), "upstream-timeout");
    assert.equal(classifyUpstreamFailure(netError("ENOTFOUND", "getaddrinfo ENOTFOUND relay")), "dns");
    assert.equal(classifyUpstreamFailure(netError("EPROTO", "protocol error")), "tls");
    assert.equal(classifyUpstreamFailure(new Error("weird")), "unknown");
    assert.equal(classifyUpstreamFailure(undefined), "unknown");
});

test("classify: fail-fast set is exactly the pre-response replay-safe kinds", () => {
    assert.deepEqual(
        (["proxy-reset", "upstream-reset", "connect-refused"] as const).filter((k) => isFailFastUpstreamKind(k)).length,
        3,
    );
    for (const kind of ["client-abort", "upstream-timeout", "dns", "tls", "unknown"] as const) {
        assert.equal(isFailFastUpstreamKind(kind), false, `${kind} must not be retried`);
    }
    for (const kind of Object.keys(UPSTREAM_FAIL_HINTS)) {
        assert.ok((UPSTREAM_FAIL_HINTS as Record<string, string>)[kind]!.length > 10, `hint exists for ${kind}`);
    }
});

test("fetchWithRetry: pre-response reset is transparently replayed once, then succeeds (#1263)", async () => {
    _resetFetchUtilForTest();
    let hits = 0;
    const upstream = http.createServer((req, res) => {
        hits += 1;
        if (hits === 1) {
            // destroy before any response byte — the classic proxy-recycle shape
            res.destroy();
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    const retries: Array<{ status: number; detail: string }> = [];
    try {
        const { response, clearTimer } = await fetchWithRetry(
            `http://127.0.0.1:${port}/v1/messages`,
            { method: "POST", body: "{}" },
            5000,
            undefined,
            (info) => retries.push({ status: info.status, detail: info.detail }),
        );
        clearTimer();
        assert.equal(response.status, 200);
        assert.equal(hits, 2, "exactly one replay");
        assert.equal(retries.length, 1);
        assert.equal(retries[0]!.status, 0, "network retry carries status 0");
        assert.match(retries[0]!.detail, /reset/);
    } finally {
        await close(upstream);
    }
});

test("fetchWithRetry: idle-budget timeout is NOT replayed (#1263 — never stack wait budgets)", async () => {
    _resetFetchUtilForTest();
    let hits = 0;
    const upstream = http.createServer(() => {
        hits += 1;
        // accept, never respond — trips the idle watchdog at the budget
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    const retries: unknown[] = [];
    try {
        await assert.rejects(
            fetchWithRetry(
                `http://127.0.0.1:${port}/v1/messages`,
                { method: "POST", body: "{}" },
                400,
                undefined,
                (info) => retries.push(info),
            ),
        );
        assert.equal(hits, 1, "no second attempt after a timeout-class failure");
        assert.equal(retries.length, 0);
    } finally {
        await close(upstream);
    }
});

test("fetchWithRetry: BILI_REPLAY_RETRY_MAX=1 keeps legacy fail-fast for network failures (#1263)", async () => {
    _resetFetchUtilForTest();
    const prev = process.env.BILI_REPLAY_RETRY_MAX;
    process.env.BILI_REPLAY_RETRY_MAX = "1";
    let hits = 0;
    const upstream = http.createServer((req, res) => {
        hits += 1;
        res.destroy();
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    const retries: unknown[] = [];
    try {
        await assert.rejects(
            fetchWithRetry(
                `http://127.0.0.1:${port}/v1/messages`,
                { method: "POST", body: "{}" },
                5000,
                undefined,
                (info) => retries.push(info),
            ),
        );
        assert.equal(hits, 1, "legacy fail-fast: no replay when the retry budget is 1");
        assert.equal(retries.length, 0);
    } finally {
        if (prev === undefined) delete process.env.BILI_REPLAY_RETRY_MAX;
        else process.env.BILI_REPLAY_RETRY_MAX = prev;
        await close(upstream);
    }
});

test("fetchWithRetry: external abort is never replayed", async () => {
    _resetFetchUtilForTest();
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    const controller = new AbortController();
    controller.abort();
    const retries: unknown[] = [];
    try {
        await assert.rejects(
            fetchWithRetry(
                `http://127.0.0.1:${port}/v1/messages`,
                { method: "POST", body: "{}" },
                5000,
                controller.signal,
                (info) => retries.push(info),
            ),
        );
        assert.equal(retries.length, 0, "client-abort must not be retried");
    } finally {
        await close(upstream);
    }
});

test("formatUpstreamError: kind and hint lead/trail the line; masking intact", () => {
    const err = netError("ECONNRESET", "read ECONNRESET 10.0.0.5:8443");
    const viaProxy = formatUpstreamError(err, "http://upstream.internal:8199/v1/messages", "http://proxy.internal:3128");
    assert.match(viaProxy, /^kind=proxy-reset /);
    assert.match(viaProxy, /hint=/);
    assert.ok(!viaProxy.includes("upstream.internal"), "upstream hostname stays masked");
    const direct = formatUpstreamError(err, "http://10.0.0.5:8199/v1/messages");
    assert.match(direct, /^kind=upstream-reset /);
    assert.match(direct, /proxy=direct/);
});

test("proxyKeepAliveMaxMs: 55s default, env-tunable, 0 = uncapped", () => {
    const prev = process.env.BILI_PROXY_KEEPALIVE_MAX_MS;
    try {
        delete process.env.BILI_PROXY_KEEPALIVE_MAX_MS;
        assert.equal(proxyKeepAliveMaxMs(), PROXY_KEEPALIVE_MAX_MS);
        assert.equal(PROXY_KEEPALIVE_MAX_MS, 55_000);
        process.env.BILI_PROXY_KEEPALIVE_MAX_MS = "0";
        assert.equal(proxyKeepAliveMaxMs(), 0);
        process.env.BILI_PROXY_KEEPALIVE_MAX_MS = "30000";
        assert.equal(proxyKeepAliveMaxMs(), 30_000);
        process.env.BILI_PROXY_KEEPALIVE_MAX_MS = "garbage";
        assert.equal(proxyKeepAliveMaxMs(), PROXY_KEEPALIVE_MAX_MS);
    } finally {
        if (prev === undefined) delete process.env.BILI_PROXY_KEEPALIVE_MAX_MS;
        else process.env.BILI_PROXY_KEEPALIVE_MAX_MS = prev;
    }
});
