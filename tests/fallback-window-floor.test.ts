import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #282: when the model window comes from a low-confidence fallback (static
// table / env default) rather than an authoritative source, the
// output-headroom reservation must not push the effective window below
// FALLBACK_EFFECTIVE_WINDOW_FLOOR (100k). Scenario: "deepseek-v4-flash"
// (table: 128k) behind an unlisted relay host, empty registry, client
// max_tokens=64000. Without the floor the effective window is 128k−64k=64k
// and a 50k-token context (78%) trips the OVER-LIMIT nudge (kernel default
// maxContextLimitPct=0.75); with the floor it is 100k (50% → idle, no
// nudge). The nudge is observable as a trailing user message appended to the
// forwarded payload.

function okJson(promptTokens: number): string {
    return JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
    });
}

test("e2e: fallback-derived window is floored at 100k after output-headroom reservation", async () => {
    const received: unknown[][] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            received.push(body.messages ?? []);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson(50_000));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": "floor-sess" };

        // Turn 1: teaches the session its real context size (50k input tokens
        // via the upstream usage report).
        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 64_000, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        // Turn 2: 50k context (per the turn-1 usage report). Effective window
        // = table 128k − 64k max_tokens = 64k WITHOUT the floor (78% →
        // OVER-LIMIT nudge → trailing user message appended to the forwarded
        // payload); WITH the floor it is 100k (50% → idle, no nudge). The
        // forwarded payload always carries the leading compress system
        // message (1 + client messages [+1 nudge]). The long text must sit
        // OUTSIDE the protected recent zone — both preserveRecentMessages=5
        // AND the preserveRecentTokens=5000 tail walk — so 24 ~1000-char
        // filler messages (~6000 tokens) separate it from the tail, giving the
        // OVER-LIMIT nudge viable compressible content to point at.
        const longText = "x".repeat(20_000);
        const filler: { role: "user" | "assistant"; content: string }[] = [];
        for (let i = 1; i <= 12; i++) {
            filler.push({ role: "user", content: `q${i} ` + "f".repeat(997) });
            filler.push({ role: "assistant", content: `a${i} ` + "e".repeat(997) });
        }
        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: "deepseek-v4-flash",
                max_tokens: 64_000,
                messages: [
                    { role: "user", content: "hello" },
                    { role: "assistant", content: "ok" },
                    { role: "user", content: "continue" },
                    { role: "assistant", content: longText },
                    ...filler,
                    { role: "user", content: "now summarize" },
                ],
            }),
        });
        assert.equal(r2.status, 200);
        await r2.text();

        assert.equal(received.length, 2, "both turns reached the upstream");
        assert.equal(received[0].length, 2, "turn 1 forwards system + the single user message");
        assert.equal(received[1].length, 30, "turn 2 appends no nudge at 50% of the floored 100k window (would be 31 at 78% of the unfloored 64k)");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("e2e: per-route context declaration is operator-owned and never floored", async () => {
    const received: unknown[][] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            received.push(body.messages ?? []);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson(50_000));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-v4-flash": { context: 64_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": "floor-sess-2" };

        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 64_000, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        // Operator explicitly declared context=64000 for this model: the
        // reservation is degenerate (maxOutput >= window → no reservation) so
        // the effective window stays the declared 64000 and a 50k context
        // (78%) MUST trip the nudge — the floor must not touch operator-owned
        // values. Same history shape as the first test: long text outside the
        // protected recent zone so the OVER-LIMIT nudge is viable.
        const longText = "y".repeat(20_000);
        const filler: { role: "user" | "assistant"; content: string }[] = [];
        for (let i = 1; i <= 12; i++) {
            filler.push({ role: "user", content: `q${i} ` + "f".repeat(997) });
            filler.push({ role: "assistant", content: `a${i} ` + "e".repeat(997) });
        }
        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: "deepseek-v4-flash",
                max_tokens: 64_000,
                messages: [
                    { role: "user", content: "hello" },
                    { role: "assistant", content: "ok" },
                    { role: "user", content: "continue" },
                    { role: "assistant", content: longText },
                    ...filler,
                    { role: "user", content: "now summarize" },
                ],
            }),
        });
        assert.equal(r2.status, 200);
        await r2.text();

        assert.equal(received.length, 2);
        assert.equal(received[1].length, 31, "operator-declared window is not floored: nudge appended at 78% of 64k");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
