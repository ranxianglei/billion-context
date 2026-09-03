import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, type NudgeDecision } from "acp-kernel";
import { startServer, type ProxyOptions, clampOutputBudget, estimateInputTokens, emergencyNudge } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #453: plugin mode has no hard backstop when the agent ignores the compress
// nudge — context grows past the window and the upstream 400s on input+output.
// Two fixes land here:
//   1) clampOutputBudget/estimateInputTokens — cap the forwarded output budget
//      so input+output can never exceed the window (the hard backstop).
//   2) emergencyNudge — force the nudge every turn once usage hits the
//      escalation line even when the kernel's cadence gate would stay silent.

// ---- pure-helper unit tests -------------------------------------------------

test("clampOutputBudget: reduces an oversized request so input+output fits", () => {
    // window 262144, input ~130k, requested 131072 (the #453 repro shape).
    const capped = clampOutputBudget(131_072, 130_000, 262_144);
    assert.ok(capped !== undefined, "must clamp");
    const margin = Math.max(2048, Math.ceil(130_000 * 0.05));
    assert.equal(capped, 262_144 - 130_000 - margin, "cap = window - input - margin");
    assert.ok(capped < 131_072, "clamped below the requested budget");
    assert.ok((capped ?? 0) + 130_000 <= 262_144, "input + clamped output never exceeds the window");
});

test("clampOutputBudget: no-op when the request already fits", () => {
    assert.equal(clampOutputBudget(8_192, 10_000, 200_000), undefined);
});

test("clampOutputBudget: no-op when input alone nearly fills the window (preflight territory)", () => {
    // input 199k of a 200k window leaves no sane output budget -> leave untouched.
    assert.equal(clampOutputBudget(100_000, 199_000, 200_000), undefined);
});

test("estimateInputTokens: prefers the real previous-turn count when it lags high", () => {
    assert.equal(estimateInputTokens([], "", [], 50_000), 50_000);
});

test("estimateInputTokens: counts system + tools on turn 1 (lastInputTokens=0)", () => {
    const baseline = estimateInputTokens([], "", [], 0);
    const withSystem = estimateInputTokens([], "x".repeat(4_000), [{ name: "tool" }], 0);
    assert.ok(withSystem > baseline, "adding system + tools raises the estimate");
    assert.ok(withSystem > 900, "a 4000-char system contributes ~1000 tokens");
});

function mkNudge(over: Partial<Pick<NudgeDecision, "shouldInject" | "contextUsage" | "compressibleRanges">> = {}): NudgeDecision {
    const breakdown = { usage: 0, growth: 0, growthReference: 0, effectiveThreshold: 0, nudgeGrowthTokens: 0, growthFloor: 0, hasPendingNudge: 0, overLimit: 0, emergencyOverride: 0, pendingT1: 0, pendingT2: 0, pendingT3: 0 };
    return { shouldInject: false, reason: "test", compressibleRanges: [], contextUsage: 0, tier: null, breakdown, ...over };
}

test("emergencyNudge: never overrides an armed nudge", () => {
    assert.equal(emergencyNudge(mkNudge({ shouldInject: true, contextUsage: 0.99, compressibleRanges: [{ startRef: "a", endRef: "b", count: 1, tokens: 1, toolPct: 0, textPct: 0 }] })), false);
});

test("emergencyNudge: fires at the escalation line with compressible content", () => {
    const ranges = [{ startRef: "a", endRef: "b", count: 1, tokens: 1, toolPct: 0, textPct: 0 }];
    assert.equal(emergencyNudge(mkNudge({ contextUsage: 0.75, compressibleRanges: ranges })), true, "0.75 >= 0.70 default");
    assert.equal(emergencyNudge(mkNudge({ contextUsage: 0.6, compressibleRanges: ranges })), false, "below the line");
});

test("emergencyNudge: respects a custom escalation line and empty ranges", () => {
    const ranges = [{ startRef: "a", endRef: "b", count: 1, tokens: 1, toolPct: 0, textPct: 0 }];
    assert.equal(emergencyNudge(mkNudge({ contextUsage: 0.75, compressibleRanges: ranges }), 0.8), false, "0.75 < custom 0.8");
    assert.equal(emergencyNudge(mkNudge({ contextUsage: 0.85, compressibleRanges: ranges }), 0.8), true, "0.85 >= custom 0.8");
    assert.equal(emergencyNudge(mkNudge({ contextUsage: 0.99 })), false, "empty ranges = nothing to offer, no override");
    assert.equal(emergencyNudge(null), false);
    assert.equal(emergencyNudge(undefined), false);
});

// ---- integration: real proxy + upstream -------------------------------------

function okJson(promptTokens: number): string {
    return JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
    });
}

interface DriveOpts {
    sessionId: string;
    window: number;
    turn1PromptTokens: number;
    turn2Body: Record<string, unknown>;
    extraHeaders?: Record<string, string>;
}

async function drive(o: DriveOpts): Promise<{ turn2Body: Record<string, unknown>; turn2MessageCount: number }> {
    const received: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson(o.turn1PromptTokens));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upPort}`]: { models: { m: { context: o.window } } } },
        modelContextLimit: o.window, kernelConfig: defaultConfig(o.window),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const pPort = (proxy.address() as { port: number }).port;

    try {
        const url = `http://127.0.0.1:${pPort}/bili/http://127.0.0.1:${upPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": o.sessionId, ...(o.extraHeaders ?? {}) };
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "m", max_tokens: 20_000, messages: [{ role: "user", content: "hello" }] }) });
        assert.equal(r1.status, 200);
        await r1.text();
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify(o.turn2Body) });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(received.length, 2, "both turns reached the upstream");
        const turn2Body = received[1]!;
        return { turn2Body, turn2MessageCount: ((turn2Body.messages ?? []) as unknown[]).length };
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
}

// A 29-message history shaped so compressible ranges exist (long text well
// outside the protected recent zone) while its CORE estimate stays modest.
function turn2Compressible(): Record<string, unknown>[] {
    const longText = "y".repeat(20_000);
    const filler: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 1; i <= 12; i++) {
        filler.push({ role: "user", content: `q${i} ` + "f".repeat(997) });
        filler.push({ role: "assistant", content: `a${i} ` + "e".repeat(997) });
    }
    return [
        { role: "user", content: "hello" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
        { role: "assistant", content: longText },
        ...filler,
        { role: "user", content: "now summarize" },
    ];
}

test("#453 clamp: oversized max_tokens is reduced when input+system nearly fills the window", async () => {
    // window 100k, requested max_tokens 40k -> reserved window 60k. The core
    // conversation estimates ~48k (under 60k, so preflight skips — it ignores the
    // system), but the 60k-char system pushes the TRUE input past 60k. Only the
    // clamp sees the system, so it lowers max_tokens to keep input+output under 100k.
    const fired = await drive({
        sessionId: "clamp-fire",
        window: 100_000,
        turn1PromptTokens: 5_000,
        turn2Body: {
            model: "m", max_tokens: 40_000,
            messages: [
                { role: "system", content: "z".repeat(60_000) },
                { role: "user", content: "hi" },
                { role: "assistant", content: "y".repeat(192_000) },
                { role: "user", content: "now" },
            ],
        },
    });
    const out = typeof fired.turn2Body.max_tokens === "number" ? fired.turn2Body.max_tokens : undefined;
    assert.ok(out !== undefined, "forwarded body carries a numeric max_tokens");
    assert.ok(out! < 40_000, `max_tokens clamped below the 40k request (got ${out})`);
    assert.ok(out! > 0, "clamped budget stays positive");

    // Control: no oversized system -> input fits -> max_tokens passes through.
    const ctrl = await drive({
        sessionId: "clamp-ctrl",
        window: 100_000,
        turn1PromptTokens: 5_000,
        turn2Body: { model: "m", max_tokens: 40_000, messages: turn2Compressible() },
    });
    assert.equal(ctrl.turn2Body.max_tokens, 40_000, "unclamped when input fits the window");
});

test("#453 escalation: nudge injected at the escalation line though the kernel cadence-stays silent", async () => {
    // window 100k, max_tokens 20k -> reserved 80k. Usage = lastInputTokens/80k.
    // 57.6k -> 72% (>= 0.70 escalation line, < 0.75 over-limit) vs 48k -> 60%.
    // Fresh session: growth not ready, so the kernel arms nothing at either
    // point; only the host-side escalation adds the trailing nudge at 72%.
    const escalated = await drive({ sessionId: "esc-on", window: 100_000, turn1PromptTokens: 57_600, turn2Body: { model: "m", max_tokens: 20_000, messages: turn2Compressible() } });
    const quiet = await drive({ sessionId: "esc-off", window: 100_000, turn1PromptTokens: 48_000, turn2Body: { model: "m", max_tokens: 20_000, messages: turn2Compressible() } });
    assert.equal(escalated.turn2MessageCount, quiet.turn2MessageCount + 1, "escalation adds exactly the trailing nudge message");
});
