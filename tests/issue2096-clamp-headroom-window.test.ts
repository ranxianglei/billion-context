import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// #2096: clampOutgoingOutput sizes max_tokens against the RAW native window
// while preflight/nudge enforce the headroom-adjusted one. That asymmetry is
// INTENTIONAL and load-bearing (budget.ts documents why capping against the
// headroom target would break the #453 guarantee whenever max_tokens > 25% of
// the window) — what was broken are the LOGS:
//   A. [window] labeled the pre-reservation value "effective=" (one string,
//      two meanings inside one incident turn);
//   B. the reserved value nudge/preflight actually judge against never
//      appeared in any log line;
//   C. the clamp advertised "#453 rescue" even when the input already exceeds
//      the enforced target, where ONLY compression can recover the turn.
// These tests pin the honest log surfaces AND pin the cap math on the native
// window (the issue's suggested fix would fail case 2 below).

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { clampOutgoingOutput } from "../src/server/budget.ts";

function runClamp(raw: number, inputTokens: number, nativeWindow: number, headroomWindow?: number): { body: Record<string, unknown>; log: string } {
    const body: Record<string, unknown> = { max_tokens: raw };
    let log = "";
    clampOutgoingOutput(body, "max_tokens", {
        systemText: "", tools: [], processedMessages: [], lastInputTokens: inputTokens, lastInputTokensSource: "usage",
        nativeWindow, imageTokens: 0, headroomWindow,
    }, "s2096", (_l, m) => { log = m; });
    return { body, log };
}

test("#2096 unit: incident-band clamp caps against the native window and says compression is the backstop", () => {
    // Incident numbers: W=1048576, out_raw=393216 (>25% of W), input~807837 —
    // above the headroom target 786432, below the native window.
    const { body, log } = runClamp(393216, 807_837, 1_048_576, 786_432);
    const margin = Math.max(2048, Math.ceil(807_837 * 0.05));
    assert.equal(body.max_tokens, Math.floor(1_048_576 - 807_837 - margin), "cap must be computed against the NATIVE window");
    assert.match(log, /output budget clamped 393216 -> \d+ \(input~807837, window=1048576\)/);
    assert.ok(log.includes("only compression can recover it"), `band log must name compression as the operative backstop, got: ${log}`);
});

test("#2096 unit: below-target input keeps the #453 guarantee the issue's suggested fix would break", () => {
    // Counterexample: after a successful fold to just under the headroom target
    // (786432), capping against that target gives a negative cap -> floor ->
    // no-op -> the raw 393216 goes out with ~780K input -> total > window ->
    // hard 400. Capping against the native window keeps the post-compression
    // turn alive.
    const { body, log } = runClamp(393216, 780_000, 1_048_576, 786_432);
    const margin = Math.max(2048, Math.ceil(780_000 * 0.05));
    assert.equal(body.max_tokens, Math.floor(1_048_576 - 780_000 - margin), "post-fold turn must keep a usable output budget");
    assert.ok(!log.includes("only compression can recover it"), `below-target log must not claim the band, got: ${log}`);
    assert.match(log, /prevents input\+output overflow \(#453\)$/);
});

test("#2096 unit: without headroom info the legacy message is unchanged", () => {
    const { body, log } = runClamp(393216, 807_837, 1_048_576);
    const margin = Math.max(2048, Math.ceil(807_837 * 0.05));
    assert.equal(body.max_tokens, Math.floor(1_048_576 - 807_837 - margin));
    assert.ok(!log.includes("#2096"), `legacy message must stay intact, got: ${log}`);
});

const WINDOW = 100_000;
const MODEL = "gpt-basil";

function makeUpstream(): http.Server {
    return http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "c2096", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c2096", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c2096", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 } })}\n\n`);
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

async function drive(proxyPort: number, upstreamPort: number, session: string, maxTokens: number): Promise<void> {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(r.status, 200, `request must succeed, got ${r.status}: ${await r.text().catch(() => "")}`);
    await r.body?.cancel().catch(() => { /* drained */ });
}

test("#2096 e2e: [window] reports the base, [headroom] reports the enforced effective window, deduped per model|value", async () => {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    const h = await startHarness();
    try {
        // max_tokens 30000 > 25% of 100000 -> reserved = min(30000, 25000) = 25000
        // -> effective 75000.
        await drive(h.proxyPort, h.upstreamPort, "s2096-e2e", 30_000);
        const windowLines = logs.filter((l) => l.includes("[window] model=gpt-basil"));
        assert.equal(windowLines.length, 1, `exactly one [window] line per model, got: ${JSON.stringify(windowLines)}`);
        assert.ok(windowLines[0].includes(`base=${WINDOW}`), `[window] must label the pre-reservation value base=, got: ${windowLines[0]}`);
        assert.ok(!windowLines[0].includes("effective="), `[window] must not reuse the "effective" label, got: ${windowLines[0]}`);
        let headroomLines = logs.filter((l) => l.includes("[headroom] model=gpt-basil: effective window"));
        assert.equal(headroomLines.length, 1, `one [headroom] effective-window line after first reservation, got: ${JSON.stringify(headroomLines)}`);
        assert.ok(headroomLines[0].includes(`effective window ${WINDOW} -> ${WINDOW - 25_000}`), `reserved value must appear, got: ${headroomLines[0]}`);
        assert.ok(headroomLines[0].includes(`reserved ${25_000} for max output 30000`), `reservation math must be stated, got: ${headroomLines[0]}`);

        // Same model|value -> deduped (no second line).
        await drive(h.proxyPort, h.upstreamPort, "s2096-e2e", 30_000);
        headroomLines = logs.filter((l) => l.includes("[headroom] model=gpt-basil: effective window"));
        assert.equal(headroomLines.length, 1, `identical model|value must not re-log, got: ${JSON.stringify(headroomLines)}`);

        // Different max_tokens -> different reserved value -> new line.
        await drive(h.proxyPort, h.upstreamPort, "s2096-e2e", 10_000);
        headroomLines = logs.filter((l) => l.includes("[headroom] model=gpt-basil: effective window"));
        assert.equal(headroomLines.length, 2, `new model|value pair must log once, got: ${JSON.stringify(headroomLines)}`);
        assert.ok(headroomLines[1].includes(`effective window ${WINDOW} -> ${WINDOW - 10_000}`), `second reservation must surface, got: ${headroomLines[1]}`);
    } finally {
        setLogCapture(null);
        h.proxy.close();
        h.proxy.closeIdleConnections?.();
        h.upstream.close();
        h.upstream.closeIdleConnections?.();
        await Promise.allSettled([once(h.proxy, "close"), once(h.upstream, "close")]);
    }
});
