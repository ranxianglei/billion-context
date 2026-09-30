import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { ProxyOptions } from "../src/server.ts";

process.env.NODE_ENV = "test";

// #971: launcher env channel for max output — set before the dynamic imports
// below (the server module freezes it at load, mirroring
// LAUNCHER_MODEL_WINDOWS).
process.env.BILI_LAUNCHER_MODEL_MAX_OUTPUTS = JSON.stringify({
    "headroom-launch-model": 80_000,
    "headroom-rank-model": 10_000,
});

const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");

// #924: harnesses that omit every output-budget field (Codex native Responses
// sends no max_output_tokens) previously got NO headroom reservation at all —
// the fallback chain (per-route ModelEntry.output → models.dev registry
// ceiling → 0) must stand in for the missing budget through the SAME capped
// reservation. Numbers: window 200k (authoritative), declared output 80k,
// default pct 0.25 → reserved min(80k, 50k) = 50k → effective 150k. Turn 1
// teaches 120k input tokens via the usage report; on turn 2 that is 80% of
// 150k (≥75% kernel default → OVER-LIMIT nudge appended to the forwarded
// payload, +1 message) but only 60% of the unreserved 200k (no nudge). Same
// observation technique as fallback-window-floor.test.ts.

function okJson(promptTokens: number): string {
    return JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
    });
}

function turn2Messages(): { role: "user" | "assistant"; content: string }[] {
    const longText = "x".repeat(20_000);
    const filler: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 1; i <= 12; i++) {
        filler.push({ role: "user", content: `q${i} ` + "f".repeat(997) });
        filler.push({ role: "assistant", content: `a${i} ` + "e".repeat(997) });
    }
    // The long text sits OUTSIDE both protected zones (preserveRecentMessages=5
    // and the preserveRecentTokens=5000 tail walk) so the OVER-LIMIT nudge has
    // viable compressible content to point at.
    return [
        { role: "user", content: "hello" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
        { role: "assistant", content: longText },
        ...filler,
        { role: "user", content: "now summarize" },
    ];
}

type Scenario = {
    session: string;
    model: string;
    models?: Record<string, { context?: number; output?: number }>;
    registry?: Record<string, { limit?: { context?: number; output?: number } }>;
    maxTokens?: number;
    headers?: Record<string, string>;
};

async function turn2MessageCount(s: Scenario): Promise<number> {
    const received: unknown[][] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            received.push(body.messages ?? []);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson(120_000));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest(s.registry ?? {});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: s.models ? { [`http://127.0.0.1:${upstreamPort}`]: { models: s.models } } : {},
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": s.session, ...(s.headers ?? {}) };
        const budget = s.maxTokens !== undefined ? { max_tokens: s.maxTokens } : {};
        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: s.model, ...budget, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();
        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: s.model, ...budget, messages: turn2Messages() }),
        });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(received.length, 2, "both turns reached the upstream");
        assert.equal(received[0].length, 2, "turn 1 forwards system + the single user message");
        return (received[1] as unknown[]).length;
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
}

test("e2e #924: configured ModelEntry.output stands in for a missing request budget", async () => {
    // 120k / (200k − min(80k, 0.25×200k)=50k) = 80% ≥ 75% → nudge (31);
    // without the fallback it is 60% of 200k → no nudge (30).
    assert.equal(await turn2MessageCount({
        session: "hf-cfg",
        model: "headroom-model-a",
        models: { "headroom-model-a": { context: 200_000, output: 80_000 } },
    }), 31);
});

test("e2e #924: registry output ceiling stands in when nothing is configured", async () => {
    // Window AND budget both come from the registry entry; relay host is
    // unlisted → cross-provider suffix scan finds openai/headroom-model-b.
    assert.equal(await turn2MessageCount({
        session: "hf-reg",
        model: "headroom-model-b",
        registry: { "openai/headroom-model-b": { limit: { context: 200_000, output: 80_000 } } },
    }), 31);
});

test("e2e #924: unknown model keeps today's no-reservation behavior", async () => {
    // No configured output, empty registry, not in the built-in table →
    // budget stays 0 → effective window stays the full 200k → 60% → no nudge.
    assert.equal(await turn2MessageCount({
        session: "hf-unknown",
        model: "zzz-unlisted-model",
    }), 30);
});

test("e2e #924: an explicit request budget outranks the configured output", async () => {
    // max_tokens=10k beats the configured 80k: reserved min(10k, 50k)=10k →
    // effective 190k → 63% < 75% → no nudge (would be 80%/nudge if the
    // fallback clobbered the explicit field).
    assert.equal(await turn2MessageCount({
        session: "hf-explicit",
        model: "headroom-model-a",
        models: { "headroom-model-a": { context: 200_000, output: 80_000 } },
        maxTokens: 10_000,
    }), 30);
});

test("e2e #971: launcher-env max output stands in with nothing configured", async () => {
    // BILI_LAUNCHER_MODEL_MAX_OUTPUTS carries 80k for this model (set before
    // the server import above): reserved min(80k, 50k)=50k → effective 150k →
    // 80% → nudge. Without the channel it stays 60% of the full window → 30.
    assert.equal(await turn2MessageCount({
        session: "hf-launcher",
        model: "headroom-launch-model",
    }), 31);
});

test("e2e #971: runtime-info headers outrank the launcher env", async () => {
    // Plugin headers report 180k while the launcher env carries 10k for the
    // SAME model. The plugin is the per-request truth (its number is what the
    // client actually asks the upstream for): reserved min(180k, 50k)=50k →
    // 150k effective → 80% → nudge (31). If the launcher env wrongly won,
    // reserved 10k → 190k → 63% → 30.
    assert.equal(await turn2MessageCount({
        session: "hf-rank",
        model: "headroom-rank-model",
        headers: {
            "x-bili-plugin": "pi",
            "x-bili-plugin-model": "headroom-rank-model",
            "x-bili-plugin-max-output": "180000",
        },
    }), 31);
});
