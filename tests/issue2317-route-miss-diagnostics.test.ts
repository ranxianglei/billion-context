import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// #2317: when a request's embedded upstream URL matches NO configured providers
// key, every per-provider override (context, compress.modelContextLimit, …) is
// silently dropped while the registry value happens to look plausible — and the
// preflight 502 then advises "set compress.modelContextLimit explicitly", the one
// knob the operator ALREADY set under a different key. These tests pin the fix:
//   1. hostIdForLog — a distinguishable-but-non-leaking endpoint identifier
//      (port-aware, public verbatim, private fingerprinted);
//   2. findRouteKey — the matched providers key (or proof of a miss);
//   3. buildWindowShrinkNote — the 502 note names the REAL cause on a route-miss
//      instead of the misleading advice, byte-for-byte preserving the old texts;
//   4. warnRouteMissIfNew — the once-per-(upstream,model) loud route-miss warning;
//   5. e2e — a real server drives a route-miss and a route-hit through the proxy
//      and the log surfaces show it.

import { defaultConfig } from "acp-kernel";
import { startServer, buildWindowShrinkNote, warnRouteMissIfNew, _resetRouteMissWarnedForTest } from "../src/server.ts";
import type { ProxyOptions, ProviderRoutes } from "../src/config.ts";
import { findRouteKey } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { hostIdForLog, setMaskHostsEnabled } from "../src/log-mask.ts";

const FP = /^<host:[0-9a-f]{8}>$/;

test("#2317 unit: hostIdForLog keeps relays distinguishable without leaking them", () => {
    // Public API hosts pass through verbatim.
    assert.equal(hostIdForLog("https://api.openai.com/v1/chat/completions"), "api.openai.com");
    assert.equal(hostIdForLog("https://api.anthropic.com/v1/messages"), "api.anthropic.com");
    // Private relays become a stable, non-reversible fingerprint.
    const a = hostIdForLog("https://relay-a.internal/v1");
    const b = hostIdForLog("https://relay-b.org/v1");
    assert.match(a, FP);
    assert.match(b, FP);
    assert.equal(hostIdForLog("https://relay-a.internal/v1"), a, "fingerprint must be deterministic");
    assert.notEqual(a, b, "distinct relays must stay tellable apart");
    // The raw domain must NOT appear anywhere in the fingerprint.
    assert.ok(!a.includes("relay-a.internal") && !b.includes("relay-b.org"));
    // Port-aware: two lanes on one host with different ports stay distinct too.
    const p1 = hostIdForLog("http://127.0.0.1:8001/v1");
    const p2 = hostIdForLog("http://127.0.0.1:8002/v1");
    assert.match(p1, FP);
    assert.notEqual(p1, p2, "same host, different port must fingerprint differently");
    assert.equal(hostIdForLog(""), "<no-host>");
});

test("#2317 unit: hostIdForLog honors the masking-off opt-out", () => {
    try {
        setMaskHostsEnabled(false);
        // Masking disabled → real endpoint (host:port) shown verbatim.
        assert.equal(hostIdForLog("http://127.0.0.1:8001/v1"), "127.0.0.1:8001");
        assert.equal(hostIdForLog("https://relay-a.internal/v1"), "relay-a.internal");
    } finally {
        setMaskHostsEnabled(true);
    }
});

test("#2317 unit: findRouteKey returns the matched key or proves a miss", () => {
    const routes: ProviderRoutes = {
        "https://api.example.com": {},
        "https://api.example.com/v1": {},
    };
    assert.equal(findRouteKey(routes, "https://api.example.com/v1/chat/completions"), "https://api.example.com/v1", "longest prefix wins");
    assert.equal(findRouteKey(routes, "https://api.example.com/other/path"), "https://api.example.com");
    assert.equal(findRouteKey(routes, "https://api.example.com.evil/x"), undefined, "boundary-safe: lookalike host must NOT match");
    assert.equal(findRouteKey(routes, "https://unrelated.host/y"), undefined);
    assert.equal(findRouteKey(routes, undefined), undefined);
    assert.equal(findRouteKey({}, "https://x.com/y"), undefined, "empty table is a miss, not an error");
});

test("#2317 unit: buildWindowShrinkNote preserves the operator and codex-route-hit texts byte-for-byte", () => {
    const head = " Note: bili's effective window 100000 is below the model's full window 200000 — ";
    assert.equal(
        buildWindowShrinkNote({ reason: "operator", limit: 100_000, nativeWindow: 200_000 }),
        head + "your compress.modelContextLimit setting overrides it; if the upstream actually serves the larger window, raise or remove that setting (hot-reloaded, no session restart needed).",
    );
    const codexHit = buildWindowShrinkNote({ reason: "codex", limit: 100_000, nativeWindow: 200_000 });
    assert.equal(codexHit, head + "it was aligned down to codex's own window perception; set compress.modelContextLimit explicitly if your upstream serves the larger window.");
    assert.ok(codexHit.includes("set compress.modelContextLimit explicitly"), "route-HIT codex shrink keeps the explicit-set advice");
});

test("#2317 unit: buildWindowShrinkNote names the real cause on a codex route-miss", () => {
    const note = buildWindowShrinkNote({
        reason: "codex",
        limit: 100_000,
        nativeWindow: 200_000,
        routeMissedConfigured: true,
        upstreamEndpoint: "https://api.openai.com/v1",
        knownKeys: ["https://api.anthropic.com/v1"],
    });
    // The misleading advice must be GONE …
    assert.ok(!note.includes("set compress.modelContextLimit explicitly"), `route-miss must not advise the already-set knob, got: ${note}`);
    // … and the real cause (no matching providers key) named, with the endpoints listed.
    assert.ok(note.includes("matched NO configured providers key"), note);
    assert.ok(note.includes("api.openai.com"), `upstream must be named, got: ${note}`);
    assert.ok(note.includes("api.anthropic.com"), `known keys must be listed, got: ${note}`);
    assert.ok(note.includes("Add a providers entry"), note);
    assert.ok(note.startsWith(" Note: bili's effective window 100000 is below the model's full window 200000"), note);
});

test("#2317 unit: buildWindowShrinkNote stays silent outside a genuine shrink", () => {
    assert.equal(buildWindowShrinkNote({ reason: undefined, limit: 100_000, nativeWindow: 200_000 }), "");
    assert.equal(buildWindowShrinkNote({ reason: "codex", limit: 100_000 }), "");
    assert.equal(buildWindowShrinkNote({ reason: "codex", limit: 200_000, nativeWindow: 200_000 }), "", "limit == native is not a shrink");
    assert.equal(buildWindowShrinkNote({ reason: "codex", limit: 300_000, nativeWindow: 200_000 }), "", "limit > native is not a shrink");
});

test("#2317 unit: warnRouteMissIfNew warns once per (upstream-origin, model)", () => {
    _resetRouteMissWarnedForTest();
    const logs: string[] = [];
    const lg = (_l: string, m: string) => { logs.push(m); };

    assert.equal(warnRouteMissIfNew("http://127.0.0.1:9001", "gpt-x", ["https://relay-a.internal/v1"], lg), true);
    assert.equal(logs.length, 1);
    // Identical (origin, model) → suppressed.
    assert.equal(warnRouteMissIfNew("http://127.0.0.1:9001", "gpt-x", ["https://relay-a.internal/v1"], lg), false);
    assert.equal(logs.length, 1);
    // Different origin (different port on the same host) → warns again.
    assert.equal(warnRouteMissIfNew("http://127.0.0.1:9002", "gpt-x", ["https://relay-a.internal/v1"], lg), true);
    assert.equal(logs.length, 2);
    // Different model on the same origin → warns again.
    assert.equal(warnRouteMissIfNew("http://127.0.0.1:9001", "gpt-y", ["https://relay-a.internal/v1"], lg), true);
    assert.equal(logs.length, 3);

    const msg = logs[0];
    assert.ok(msg.startsWith("[route] no provider route matched "), msg);
    assert.match(msg.match(/<host:[0-9a-f]{8}>/)![0], FP, "incoming upstream must be fingerprinted");
    assert.ok(msg.includes("(model=gpt-x)"), msg);
    assert.ok(msg.includes("known providers keys:"), msg);
    assert.ok(msg.includes("IGNORED"), msg);
    // No domain leak: the private relay host must not appear verbatim.
    assert.ok(!msg.includes("relay-a.internal"), `must not leak the relay domain, got: ${msg}`);

    // Guards: no warn without known keys, origin, or model.
    _resetRouteMissWarnedForTest();
    assert.equal(warnRouteMissIfNew("http://127.0.0.1:9001", "gpt-x", [], lg), false);
    assert.equal(warnRouteMissIfNew(undefined, "gpt-x", ["k"], lg), false);
    assert.equal(warnRouteMissIfNew("http://x", undefined, ["k"], lg), false);
    assert.equal(logs.length, 3, "guards must not emit");
});

const WINDOW = 100_000;
const MODEL_A = "gpt-relay-a";
const MODEL_B = "gpt-relay-b";

function makeUpstream(model: string): http.Server {
    return http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "c2317", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c2317", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c2317", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 } })}\n\n`);
        res.end(`data: [DONE]\n\n`);
    });
}

async function startHarness(): Promise<{ proxy: http.Server; upA: http.Server; upB: http.Server; proxyPort: number; portA: number; portB: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upA = makeUpstream(MODEL_A);
    upA.listen(0, "127.0.0.1");
    await once(upA, "listening");
    const portA = (upA.address() as { port: number }).port;
    const upB = makeUpstream(MODEL_B);
    upB.listen(0, "127.0.0.1");
    await once(upB, "listening");
    const portB = (upB.address() as { port: number }).port;
    // Only relay-A is keyed. Relay-B requests are therefore a ROUTE MISS.
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${portA}`]: { models: { [MODEL_A]: { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxy, upA, upB, proxyPort: (proxy.address() as { port: number }).port, portA, portB };
}

async function drive(proxyPort: number, targetPort: number, model: string, session: string): Promise<void> {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${targetPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model, max_tokens: 100, stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(r.status, 200, `request must succeed, got ${r.status}: ${await r.text().catch(() => "")}`);
    await r.body?.cancel().catch(() => { /* drained */ });
}

test("#2317 e2e: a route-miss is loud in the log and a route-hit shows the matched key", async () => {
    _resetRouteMissWarnedForTest();
    const logs: string[] = [];
    setLogCapture((_level, msg) => { logs.push(msg); });
    const h = await startHarness();
    try {
        // Relay-B is NOT a configured providers key → route miss.
        await drive(h.proxyPort, h.portB, MODEL_B, "s2317-b");
        const routeWarns = logs.filter((l) => l.startsWith("[route] no provider route matched "));
        assert.equal(routeWarns.length, 1, `exactly one route-miss warning, got: ${JSON.stringify(routeWarns)}`);
        assert.ok(routeWarns[0].includes(`(model=${MODEL_B})`), routeWarns[0]);
        assert.ok(routeWarns[0].includes("known providers keys:"), routeWarns[0]);
        assert.match(routeWarns[0].match(/<host:[0-9a-f]{8}>/)![0], FP, "warn must fingerprint the upstream");
        const winB = logs.filter((l) => l.includes(`[window] model=${MODEL_B}`));
        assert.equal(winB.length, 1, `one [window] line for the miss model, got: ${JSON.stringify(winB)}`);
        assert.ok(winB[0].includes("route=miss"), `[window] must label the miss, got: ${winB[0]}`);

        // Relay-A IS the configured key → route hit, no new warning, matched key shown.
        await drive(h.proxyPort, h.portA, MODEL_A, "s2317-a");
        assert.equal(logs.filter((l) => l.startsWith("[route] no provider route matched ")).length, 1, "a route-hit must not warn");
        const winA = logs.filter((l) => l.includes(`[window] model=${MODEL_A}`));
        assert.equal(winA.length, 1, `one [window] line for the hit model, got: ${JSON.stringify(winA)}`);
        assert.ok(!winA[0].includes("route=miss"), `[window] must not label a hit as a miss, got: ${winA[0]}`);
        assert.match(winA[0], /route=<host:[0-9a-f]{8}>/, `[window] must show the matched key fingerprint, got: ${winA[0]}`);
    } finally {
        setLogCapture(null);
        h.proxy.close();
        h.proxy.closeIdleConnections?.();
        h.upA.close();
        h.upA.closeIdleConnections?.();
        h.upB.close();
        h.upB.closeIdleConnections?.();
        await Promise.allSettled([once(h.proxy, "close"), once(h.upA, "close"), once(h.upB, "close")]);
    }
});
