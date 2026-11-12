import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { normalizeUpstreamOrigin } from "../src/util.ts";
import { setLogCapture } from "../src/logger.ts";

// #6430: the preflight size model (local estimate × k̂ + usage baseline) diverges
// from the measured usage in BOTH directions, so preflight fires when it
// shouldn't:
//   1. OVERESTIMATE (incident case 1) — a fresh same-route+same-model usage
//      baseline (167K, below the 200K target) is overridden by a stale k̂>1 that
//      inflates the local estimate past the target (raw 151K × 1.47 = 223K) →
//      spurious fold, 13.7s stall. A fresh measurement must win over a stale
//      calibration: when the payload's raw estimate is not bigger than the
//      baseline, the calibrated estimate is capped at the baseline.
//   2. CROSS-MODEL (incident case 2) — a usage baseline measured under a PRIOR
//      model on the same route (282K under opus) carries no model provenance, so
//      it survives the #1933 F2 route demotion and drives the trigger while the
//      current payload's own estimate reads far below the target (~55K on a
//      fable lane) → 303s preflight. The baseline floor must be scoped to the
//      model that measured it, mirroring the k̂ read gate's model dimension.
//
// Both are one mechanism (the baseline floor and the k̂-scaled estimate must be
// scoped to the model that measured them), so they land in one PR. This file pins
// both directions plus the control (a same-model baseline above the window still
// drives preflight — no regression). The trigger's decision is asserted on the
// "reached preflight target" log line (present = fired).

function textOfTokens(n: number): string {
    return "x".repeat(n * 4); // ceil(4n / 4) = n tokens on the chars/4 estimator
}

let LOGS: string[] = [];

function mockUpstream(): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
                `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
            res.end(chunk({ role: "assistant" }, null) + chunk({ content: "forwarded answer" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
        });
    });
}

function proxyOptions(upstreamPort: number, window: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: window } } } } as ProxyOptions["routes"],
        modelContextLimit: window,
        kernelConfig: defaultConfig(window, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 1000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: true,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

async function boot(window: number): Promise<{ proxyPort: number; upstreamPort: number; cleanup: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = mockUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions(upstreamPort, window));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        cleanup: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function post(p: { proxyPort: number; upstreamPort: number }, session: string, model: string, messages: Record<string, unknown>[]): Promise<Response> {
    return fetch(`http://127.0.0.1:${p.proxyPort}/bili/http://127.0.0.1:${p.upstreamPort}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model, stream: true, messages }),
    });
}

// Seed a settled usage baseline (what upstream last billed) with its provenance.
// `model` is the model that measured it; `khat` seeds a matching-origin/model
// calibration factor (the stale k̂>1 from incident case 1).
function seedBaseline(sessionId: string, upstreamPort: number, tokens: number, model: string | undefined, khat?: number): void {
    const s = getSession(sessionId);
    s.stats.lastInputTokens = tokens;
    s.stats.lastInputTokensSource = "usage";
    s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(`http://127.0.0.1:${upstreamPort}`);
    if (model !== undefined) s.stats.lastInputTokensModel = model;
    if (khat !== undefined) {
        s.stats.calibratedEstimate = khat;
        s.stats.calibratedEstimateOrigin = normalizeUpstreamOrigin(`http://127.0.0.1:${upstreamPort}`);
        s.stats.calibratedEstimateModel = model;
    }
}

// The trigger fired when EITHER log is present: "reached preflight target"
// (server.ts:4255, the fold is about to run) or "preflight target reached ...
// but the payload fits with no compressible ranges" (server.ts:4223, the
// trigger crossed the target but the fold found nothing to compress).
function preflightFired(): boolean {
    return LOGS.some((l) => l.includes("reached preflight target") || l.includes("preflight target reached"));
}

test("#6430 Fix A: cross-model usage baseline is demoted — no spurious preflight", async () => {
    LOGS = [];
    setLogCapture((_level, msg) => LOGS.push(msg));
    const p = await boot(100_000);
    try {
        // Baseline measured under model-A (110K, above the 100K window) on the
        // SAME route. The current request runs model-B with a small payload
        // (~10K, well below the window). Pre-fix: the baseline carried no model
        // provenance, so it survived the #1933 F2 route demotion and floored the
        // trigger at 110K >= 100K → spurious preflight. Post-fix: the model
        // mismatch demotes the baseline → the payload's own estimate (10K)
        // judges → no preflight.
        const sessionId = "issue6430-fixA";
        seedBaseline(sessionId, p.upstreamPort, 110_000, "claude-opus-5-5");
        const resp = await post(p, sessionId, "gpt-test", [{ role: "user", content: textOfTokens(10_000) }]);
        const body = await resp.text();
        assert.equal(resp.status, 200, `the small payload must forward: HTTP ${resp.status} ${body.slice(0, 240)}`);
        assert.ok(body.includes("forwarded answer"), "the model reply must reach the client");
        assert.ok(!preflightFired(), `the cross-model baseline must not arm preflight (preflight logs: ${LOGS.filter((l) => l.includes("preflight")).join(" | ").slice(0, 400)})`);
        assert.ok(LOGS.some((l) => l.includes("measured under model claude-opus-5-5") && l.includes("demoting to untrusted")), "the model demotion must be logged");
    } finally {
        setLogCapture(null);
        await p.cleanup();
    }
});

test("#6430 Fix B: a fresh same-model baseline caps a stale k̂ over-correction", async () => {
    LOGS = [];
    setLogCapture((_level, msg) => LOGS.push(msg));
    const p = await boot(40_000);
    try {
        // Same route + same model: the baseline (20K, below the 40K window) is
        // trusted. A stale k̂=3.0 inflates the payload's raw estimate (~14K) to
        // 42K >= 40K → pre-fix the trigger fires on the inflated estimate even
        // though the provider just billed 20K below the target. Post-fix: the
        // raw estimate (14K) is not bigger than the baseline (20K), so the
        // calibrated estimate is capped at the baseline (20K < 40K) → no
        // preflight. Genuine growth (raw > baseline) would leave the estimate
        // untouched and still fold.
        const sessionId = "issue6430-fixB";
        seedBaseline(sessionId, p.upstreamPort, 20_000, "gpt-test", 3.0);
        const resp = await post(p, sessionId, "gpt-test", [{ role: "user", content: textOfTokens(14_000) }]);
        const body = await resp.text();
        assert.equal(resp.status, 200, `the payload must forward (billed below the target): HTTP ${resp.status} ${body.slice(0, 240)}`);
        assert.ok(body.includes("forwarded answer"), "the model reply must reach the client");
        assert.ok(!preflightFired(), `the stale k̂ must not override a fresh same-model baseline (preflight logs: ${LOGS.filter((l) => l.includes("preflight")).join(" | ").slice(0, 400)})`);
    } finally {
        setLogCapture(null);
        await p.cleanup();
    }
});

test("#6430 control: a same-model baseline above the window still drives preflight", async () => {
    LOGS = [];
    setLogCapture((_level, msg) => LOGS.push(msg));
    const p = await boot(100_000);
    try {
        // Same route + same model, baseline (110K) ABOVE the 100K window: the
        // baseline is trusted and must still arm preflight (the fix must not
        // demote a legitimate same-model overflow). The payload is small, so the
        // fold finds nothing to compress and forwards — but the trigger fired.
        const sessionId = "issue6430-control";
        seedBaseline(sessionId, p.upstreamPort, 110_000, "gpt-test");
        const resp = await post(p, sessionId, "gpt-test", [{ role: "user", content: textOfTokens(10_000) }]);
        const body = await resp.text();
        assert.equal(resp.status, 200, `the payload must forward after the (no-op) fold: HTTP ${resp.status} ${body.slice(0, 240)}`);
        assert.ok(body.includes("forwarded answer"), "the model reply must reach the client");
        assert.ok(preflightFired(), `a same-model baseline above the window must still arm preflight (no regression). ALL LOGS:\n${LOGS.join("\n")}`);
    } finally {
        setLogCapture(null);
        await p.cleanup();
    }
});
