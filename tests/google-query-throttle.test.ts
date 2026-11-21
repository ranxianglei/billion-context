import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { closeServers } from "./server-close-guard.ts";
import {
    _resetUpstreamThrottleForTest,
    activeThrottleHolds,
    noteUpstreamThrottle429,
    noteUpstreamThrottleResolved,
    upstreamThrottleGate,
    upstreamThrottlePeekReject,
} from "../src/upstream-throttle.ts";

const rpcPath = "/v1beta/models/gemini-test:generateContent";
const accountA = "synthetic-query-account-a";
const accountB = "synthetic-query-account-b";
const now = 1_000_000;

function enableThrottle(t: TestContext): void {
    const env = {
        BILI_THROTTLE_429: "1",
        BILI_THROTTLE_429_MAX_CONSECUTIVE: "5",
        BILI_THROTTLE_429_BASE_DELAY_MS: "1000",
        BILI_THROTTLE_429_MAX_DELAY_MS: "8000",
        BILI_THROTTLE_429_SCOPE: "credential",
    };
    const saved = new Map(Object.keys(env).map(name => [name, process.env[name]]));
    Object.assign(process.env, env);
    _resetUpstreamThrottleForTest();
    t.after(() => {
        _resetUpstreamThrottleForTest();
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
}

test("a Google query-key 429 holds its account without rejecting another account", t => {
    enableThrottle(t);
    const origin = `https://generativelanguage.googleapis.com${rpcPath}`;
    const first = `${origin}?key=${accountA}`;
    const second = `${origin}?key=${accountB}`;
    noteUpstreamThrottle429(first, {}, "300", now);
    assert.ok(upstreamThrottleGate(first, {}, now + 1).reject);
    assert.equal(upstreamThrottleGate(second, {}, now + 1).reject, undefined);
    assert.equal(upstreamThrottlePeekReject(second, {}, now + 1), undefined);
});

for (const method of ["generateContent", "streamGenerateContent", "countTokens"]) {
    for (const field of ["key", "$key"]) {
        test(`Google ${method} isolates accounts authenticated with ${field}`, t => {
            enableThrottle(t);
            const origin = `https://google-compatible.example/v1/models/test:${method}`;
            const first = `${origin}?${new URLSearchParams({ [field]: accountA, alt: "sse" })}`;
            const second = `${origin}?${new URLSearchParams({ [field]: accountB, alt: "json" })}`;
            noteUpstreamThrottle429(first, {}, "300", now);
            assert.ok(upstreamThrottlePeekReject(first, {}, now + 1));
            assert.equal(upstreamThrottleGate(second, {}, now + 1).reject, undefined);
            noteUpstreamThrottleResolved(second, {}, 200, now + 2);
            assert.ok(upstreamThrottlePeekReject(first, {}, now + 3), "another account's success must not clear the held account");
        });
    }
}

for (const queryFirst of [false, true]) {
    test(`Google header and query authentication identify one account (${queryFirst ? "query" : "header"} first)`, t => {
        enableThrottle(t);
        const origin = `https://google-compatible.example${rpcPath}`;
        const key = "synthetic key +&/=?";
        const query = `${origin}?${new URLSearchParams({ key })}`;
        const headers = { "X-Goog-Api-Key": key };
        noteUpstreamThrottle429(queryFirst ? query : origin, queryFirst ? {} : headers, "300", now);
        assert.ok(upstreamThrottleGate(queryFirst ? origin : query, queryFirst ? headers : {}, now + 1).reject);
    });
}

test("matching repeated Google query aliases preserve the account identity", t => {
    enableThrottle(t);
    const origin = `https://google-compatible.example${rpcPath}`;
    noteUpstreamThrottle429(`${origin}?key=${accountA}&%24key=${accountA}&key=${accountA}`, {}, "300", now);
    assert.ok(upstreamThrottlePeekReject(origin, { "x-goog-api-key": accountA }, now + 1));
    assert.equal(upstreamThrottlePeekReject(`${origin}?key=${accountB}`, {}, now + 1), undefined);
});

test("Google header-authenticated requests retain their existing identity with query parameters", t => {
    enableThrottle(t);
    const origin = `https://google-compatible.example${rpcPath}`;
    const headers = { authorization: "Bearer synthetic-header-account" };
    noteUpstreamThrottle429(`${origin}?key=${accountA}`, headers, "300", now);
    assert.ok(upstreamThrottleGate(`${origin}?key=${accountB}`, headers, now + 1).reject);
    assert.equal(upstreamThrottleGate(`${origin}?key=${accountA}`, { authorization: "Bearer independent-header-account" }, now + 1).reject, undefined);
});

for (const [label, suffix] of [
    ["none", ""],
    ["empty", "?key="],
    ["repeated conflict", `?key=${accountA}&key=${accountB}`],
    ["empty duplicate", `?key=${accountA}&key=`],
    ["alias conflict", `?key=${accountA}&%24key=${accountB}`],
    ["ordinary parameters", "?quotaUser=first&alt=sse"],
]) {
    test(`absent, empty, conflicting, or unrelated Google query values keep the anonymous hold (${label})`, t => {
        enableThrottle(t);
        const origin = `https://google-compatible.example${rpcPath}`;
        noteUpstreamThrottle429(origin + suffix, {}, "300", now);
        assert.ok(upstreamThrottleGate(origin, {}, now + 1).reject);
    });
}

for (const path of ["/v1/chat/completions", "/v1/models", "/v1beta/files", "/something:generateContent"]) {
    test(`a query named key on ${path} does not create a Google account identity`, t => {
        enableThrottle(t);
        const origin = `https://other-provider.example${path}`;
        noteUpstreamThrottle429(`${origin}?key=${accountA}`, {}, "300", now);
        assert.ok(upstreamThrottleGate(`${origin}?key=${accountB}`, {}, now + 1).reject);
    });
}

test("Google query-key terminal holds remain scoped and expose no query credentials", t => {
    enableThrottle(t);
    const origin = `https://google-compatible.example${rpcPath}`;
    const first = `${origin}?key=${accountA}`;
    for (let i = 0; i < 5; i++) noteUpstreamThrottle429(first, {}, "300", now + i);
    const rejected = upstreamThrottleGate(first, {}, now + 10).reject;
    assert.equal(rejected?.status, 424);
    assert.equal(upstreamThrottleGate(`${origin}?key=${accountB}`, {}, now + 10).reject, undefined);
    const diagnostics = JSON.stringify({ holds: activeThrottleHolds(), rejected });
    assert.ok(!diagnostics.includes(accountA));
    assert.ok(!diagnostics.includes("?key="));
});

for (const large of [false, true]) {
    test(`Google query-key account isolation through HTTP (${large ? "pre-ingest" : "forward"} gate)`, { timeout: 20000 }, async t => {
        enableThrottle(t);
        const received: string[] = [];
        const upstream = http.createServer((req, res) => {
            const key = new URL(req.url ?? "/", "http://localhost").searchParams.get("key");
            const account = key === accountA ? "A" : key === accountB ? "B" : "unknown";
            req.resume();
            req.on("end", () => {
                received.push(account);
                if (account === "A") {
                    res.writeHead(429, { "content-type": "application/json", "retry-after": "300" });
                    res.end(JSON.stringify({ error: { code: 429, message: "Synthetic account quota exhausted.", status: "RESOURCE_EXHAUSTED" } }));
                } else {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1, totalTokenCount: 101 } }));
                }
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const address = upstream.address();
        assert.ok(address && typeof address === "object");
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: `http://127.0.0.1:${address.port}`,
            routes: {}, proxy: "", proxyMode: "direct", proxySource: "direct",
            modelContextLimit: 2_000_000, kernelConfig: defaultConfig(2_000_000),
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
            log: false, debug: false, passthrough: false, chainContentDetection: false,
            autoUpdate: false, mitm: { enabled: false, domains: [] },
        };
        let proxy: http.Server | undefined;
        try {
            proxy = await startServer(opts);
            if (!proxy.listening) await once(proxy, "listening");
            const proxyAddress = proxy.address();
            assert.ok(proxyAddress && typeof proxyAddress === "object");
            const post = async (key: string, text: string): Promise<{ status: number; body: string }> => {
                const response = await fetch(`http://127.0.0.1:${proxyAddress.port}${rpcPath}?key=${encodeURIComponent(key)}`, {
                    method: "POST", headers: { "content-type": "application/json", "x-acp-session": `query-key-${key === accountA ? "A" : "B"}` },
                    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }] }),
                });
                return { status: response.status, body: await response.text() };
            };
            const first = await post(accountA, "Hello.");
            const nextText = large ? "ordinary words ".repeat(75000) : "A fresh request.";
            const independent = await post(accountB, nextText);
            const held = await post(accountA, nextText);
            assert.equal(first.status, 429);
            assert.equal(held.status, 429);
            assert.ok(held.body.includes("bili_throttle_hold"));
            assert.equal(independent.status, 200, "the independent account must reach its own available provider quota");
            assert.deepEqual(received, ["A", "B"], "only the held account retry is answered locally");
        } finally {
            await closeServers(proxy ? [proxy, upstream] : [upstream]);
        }
    });
}
