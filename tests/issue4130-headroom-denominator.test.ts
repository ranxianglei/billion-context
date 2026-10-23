import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// #4130: the compression engine judges against the EFFECTIVE window (declared
// window − output-headroom reservation, #896/#2096), but every persistent
// display surface showed that denominator bare — a 200K model judging at 150K
// read as a misidentified window (three rounds of misdiagnosis in the field).
// Fix: handle() records the declared pre-reservation window in
// session.metadata.outputHeadroomBase (cleared when no reservation is active);
// the nudge log line, the /acp panel (before-footer slot), the Web UI session
// bar and the JSON surfaces annotate from that single source. These tests pin:
//   A. the nudge-line annotation (present ⇔ reservation active, exact math);
//   B. the helper guard (display-only reader, never invents values);
//   C. end-to-end: reservation writes the base, a reservation-less request
//      clears it, and the Web data projection follows.

import { defaultConfig } from "acp-kernel";
import { startServer, diagNudge, outputHeadroomBase } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { buildSessionList } from "../src/web/sessions-data.ts";

const NUDGE_TURN = { nudge: { shouldInject: false, reason: "growth below floor", contextUsage: 0.05, tier: null, breakdown: { growth: 0, growthFloor: 50000, nudgeGrowthTokens: 50000, pendingT1: 0, growthReference: 0 } } };

test("#4130 unit: nudge line annotates the effective denominator with the declared window", () => {
    const line = diagNudge(NUDGE_TURN, "s4130", 65256, 150000, "gpt-x", false, false, undefined, 200000);
    assert.ok(line.includes("usage=44% (65256/150000, window 200000 − output reserve 50000)"), `annotation missing/mis-mathed: ${line}`);
});

test("#4130 unit: nudge line keeps the legacy shape when no reservation is recorded", () => {
    const line = diagNudge(NUDGE_TURN, "s4130", 65256, 200000, "gpt-x", false);
    assert.ok(line.includes("usage=33% (65256/200000), growth="), `legacy shape drifted: ${line}`);
    assert.ok(!line.includes("output reserve"), `no annotation expected: ${line}`);
});

test("#4130 unit: annotation suppressed when the base does not exceed the limit", () => {
    const line = diagNudge(NUDGE_TURN, "s4130", 65256, 200000, "gpt-x", false, false, undefined, 200000);
    assert.ok(!line.includes("output reserve"), `equal base must not annotate: ${line}`);
});

test("#4130 unit: outputHeadroomBase passes numbers through and rejects everything else", () => {
    const as = (v: unknown) => ({ metadata: v === undefined ? {} : { outputHeadroomBase: v } }) as unknown as Session;
    assert.equal(outputHeadroomBase(as(200000)), 200000);
    assert.equal(outputHeadroomBase(as(undefined)), undefined);
    assert.equal(outputHeadroomBase(as("200000")), undefined);
    assert.equal(outputHeadroomBase(as(Number.NaN)), undefined);
    assert.equal(outputHeadroomBase({ metadata: {} } as unknown as Session), undefined);
});

const WINDOW = 100_000;
const MODEL = "gpt-basil";

function makeUpstream(): http.Server {
    return http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "c4130", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c4130", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c4130", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 } })}\n\n`);
        res.end(`data: [DONE]\n\n`);
    });
}

async function startHarness(): Promise<{ proxy: http.Server; upstream: http.Server; proxyPort: number; upstreamPort: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: WINDOW } } } },
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
    return { proxy, upstream, proxyPort: (proxy.address() as { port: number }).port, upstreamPort };
}

async function drive(proxyPort: number, upstreamPort: number, session: string, body: Record<string, unknown>): Promise<void> {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "hello" }], ...body }),
    });
    assert.equal(r.status, 200, `request must succeed, got ${r.status}: ${await r.text().catch(() => "")}`);
    await r.body?.cancel().catch(() => { /* drained */ });
}

async function webEntry(session: string) {
    const list = await buildSessionList();
    const entry = list.find((s) => s.id === session);
    assert.ok(entry, `session ${session} must be listed`);
    return entry;
}

test("#4130 e2e: reservation annotates the nudge line and the web projection; a reservation-less request clears both", async () => {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    const h = await startHarness();
    try {
        // max_tokens 30000 > 25% of 100000 -> reserved 25000 -> effective 75000.
        await drive(h.proxyPort, h.upstreamPort, "s4130-e2e", { max_tokens: 30_000 });
        const annotated = logs.filter((l) => l.includes("s4130-e2e") && l.includes("usage=") && l.includes(", window 100000 − output reserve 25000)"));
        assert.equal(annotated.length, 1, `exactly one annotated nudge line expected, got: ${JSON.stringify(logs.filter((l) => l.includes("s4130-e2e") && l.includes("usage=")))}`);
        assert.ok(annotated[0].includes("/75000,"), `denominator must be the effective window, got: ${annotated[0]}`);

        let entry = await webEntry("s4130-e2e");
        assert.equal(entry.contextWindow, 75_000, `web projection must carry the effective denominator, got ${entry.contextWindow}`);
        assert.equal(entry.contextWindowBase, WINDOW, `web projection must carry the declared base, got ${entry.contextWindowBase}`);

        // Same session, request WITHOUT any output budget -> no reservation ->
        // the stale base must be cleared (model-switch safety, same writer).
        logs.length = 0;
        await drive(h.proxyPort, h.upstreamPort, "s4130-e2e", {});
        const bare = logs.filter((l) => l.includes("s4130-e2e") && l.includes("usage="));
        assert.equal(bare.length, 1, `one nudge line expected, got: ${JSON.stringify(bare)}`);
        assert.ok(bare[0].includes("/100000), growth="), `denominator back to the full window, got: ${bare[0]}`);
        assert.ok(!bare[0].includes("output reserve"), `stale annotation must be gone, got: ${bare[0]}`);

        entry = await webEntry("s4130-e2e");
        assert.equal(entry.contextWindow, WINDOW, `effective window restored, got ${entry.contextWindow}`);
        assert.equal(entry.contextWindowBase, undefined, `base must be cleared when no reservation is active, got ${entry.contextWindowBase}`);
    } finally {
        setLogCapture(null);
        h.proxy.close();
        h.proxy.closeIdleConnections?.();
        h.upstream.close();
        h.upstream.closeIdleConnections?.();
        await Promise.allSettled([once(h.proxy, "close"), once(h.upstream, "close")]);
    }
});
