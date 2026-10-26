import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// #3461 problem 2 (real-model stress test, dsh/pi lanes, qwen3.8-27b @ sglang):
// a session pinned over its window with less foldable mass than the deficit had
// NO exit — preflight answered 502 (read as transient by status-code-driven
// headless hosts, which spun through 5+ doomed rounds) while the EMERGENCY
// tier-1 nudge override re-armed on EVERY request (measured 7 injections in
// 1 second). Pinned here:
//   1. unit — emergencyNudgeArmed: the override injects once per state; it
//      re-arms only on a landed reduction, a full flat-growth step of new
//      content, or the 10-minute wall-clock safety valve. Kernel-driven
//      injections (shouldInject=true) never pass through the gate.
//   2. e2e — a payload that can never fit (oversized system prompt, nothing
//      foldable left) fails fast 413 non-retryable instead of 502, and the
//      dead-end cooldown replays the same verdict without touching the
//      upstream again.

import { defaultConfig, type NudgeDecision } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest, type Session } from "../src/session.ts";
import { emergencyNudgeArmed } from "../src/server/budget.ts";
import { SELF_HEAL_SUPPRESS_CAP_MS } from "../src/session-self-heal.ts";

// ---- Part A: unit — the emergency override backoff gate ---------------------

function mkSession(): Session {
    return {
        id: "s3461",
        metadata: {},
        state: { nextBlockId: 1 },
        lastCompress: undefined,
    } as unknown as Session;
}

/** Over-limit (>= 0.7 escalation line), kernel declined (cadence), one
 * executable range — the exact shape that made the pure check fire every
 * request in the field report. */
function overLimitDeclined(usage = 0.85): NudgeDecision {
    return { shouldInject: false, contextUsage: usage, compressibleRanges: [{ chars: 20_000 }] } as unknown as NudgeDecision;
}

test("#3461 unit: seven identical doomed retries inject the emergency nudge exactly once", () => {
    const s = mkSession();
    const results = Array.from({ length: 7 }, () => emergencyNudgeArmed(s, overLimitDeclined(), 0, 90_000));
    assert.deepEqual(results, [true, false, false, false, false, false, false], "first retry arms, the rest stay quiet");
    const gate = s.metadata["emergencyNudgeGate"] as Record<string, unknown>;
    assert.equal(gate["tokens"], 90_000, "gate stamped with the injecting token count");
    assert.equal(gate["reductionKey"], "1:0", "gate stamps the reduction fingerprint");
    assert.equal(typeof gate["at"], "number");
});

test("#3461 unit: a landed reduction re-arms the emergency nudge", () => {
    const s = mkSession();
    assert.equal(emergencyNudgeArmed(s, overLimitDeclined(), 0, 90_000), true);
    assert.equal(emergencyNudgeArmed(s, overLimitDeclined(), 0, 90_000), false);
    s.state.nextBlockId = 2; // committed fold advanced the block cursor
    assert.equal(emergencyNudgeArmed(s, overLimitDeclined(), 0, 90_000), true, "shrunken payload still needs the prompt");
    assert.equal(emergencyNudgeArmed(s, overLimitDeclined(), 0, 90_000), false, "and stays quiet again until the next change");
});

test("#3461 unit: only a full flat-growth step re-arms (no window rescaling)", () => {
    const s = mkSession();
    assert.equal(emergencyNudgeArmed(s, overLimitDeclined(), 0, 90_000), true);
    assert.equal(emergencyNudgeArmed(s, overLimitDeclined(), 0, 90_000 + 49_999), false, "sub-step growth is noise");
    assert.equal(emergencyNudgeArmed(s, overLimitDeclined(), 0, 90_000 + 50_000), true, "a full 50K step is new content worth advising about");
    const s2 = mkSession();
    assert.equal(emergencyNudgeArmed(s2, overLimitDeclined(), 0, 1_000, 1_000), true);
    assert.equal(emergencyNudgeArmed(s2, overLimitDeclined(), 0, 1_999, 1_000), false);
    assert.equal(emergencyNudgeArmed(s2, overLimitDeclined(), 0, 2_000, 1_000), true, "honors the caller-supplied growth step");
});

test("#3461 unit: wall-clock safety valve re-arms once after the cap", () => {
    const realNow = Date.now;
    let fake = 1_000_000;
    Date.now = () => fake;
    try {
        const s = mkSession();
        assert.equal(emergencyNudgeArmed(s, overLimitDeclined(), 0, 90_000), true);
        fake += 9 * 60_000;
        assert.equal(emergencyNudgeArmed(s, overLimitDeclined(), 0, 90_000), false, "under the cap: quiet");
        fake += 2 * 60_000; // total >= SELF_HEAL_SUPPRESS_CAP_MS (10 min)
        assert.ok(fake - 1_000_000 >= SELF_HEAL_SUPPRESS_CAP_MS, "test clock crossed the cap");
        assert.equal(emergencyNudgeArmed(s, overLimitDeclined(), 0, 90_000), true, "permanently stuck sessions still get periodic reminders");
        assert.equal(emergencyNudgeArmed(s, overLimitDeclined(), 0, 90_000), false, "the valve fires once, then the gate holds again");
    } finally {
        Date.now = realNow;
    }
});

test("#3461 unit: below the escalation line the gate never arms or stamps", () => {
    const s = mkSession();
    assert.equal(emergencyNudgeArmed(s, overLimitDeclined(0.5), 0, 90_000), false);
    assert.equal(emergencyNudgeArmed(s, overLimitDeclined(0.69), 0, 90_000), false);
    assert.equal(s.metadata["emergencyNudgeGate"], undefined, "no state written for a declined pure check");
});

test("#3461 unit: kernel-driven injections never pass through the gate", () => {
    const s = mkSession();
    const kernelDriven = { shouldInject: true, contextUsage: 0.9, compressibleRanges: [{ chars: 20_000 }] } as unknown as NudgeDecision;
    assert.equal(emergencyNudgeArmed(s, kernelDriven, 0, 90_000), false, "call sites OR shouldInject in BEFORE the emergency arm");
    assert.equal(s.metadata["emergencyNudgeGate"], undefined, "and must not consume the emergency gate");
});

test("#3461 unit: no executable range keeps the pure-check refusal", () => {
    const s = mkSession();
    const none = { shouldInject: false, contextUsage: 0.9, compressibleRanges: [] } as unknown as NudgeDecision;
    assert.equal(emergencyNudgeArmed(s, none, 0, 90_000), false);
    assert.equal(s.metadata["emergencyNudgeGate"], undefined);
});

// ---- Part B: e2e — deterministic exhaustion answers 413, not 502 ------------

// 8k keeps the fixed compress surface (system section + tool schemas, ~4.6k
// tokens measured — see issue #3461 problem 3) inside the window so turn 1
// fits, while the 60k-char system swap on turn 2 still overshoots by ~2.5x.
const WINDOW = 8_000;

function okSse(inputTokens: number): string {
    const start: Record<string, unknown> = { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } };
    const delta: Record<string, unknown> = { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } };
    return (
        `event: message_start\ndata: ${JSON.stringify(start)}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify(delta)}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

type Msg = { role: string; content: unknown };

test("#3461 e2e: a payload that can never fit fails fast 413 non-retryable, cooldown replays without upstream calls", async () => {
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    let upstreamCalls = 0;
    const server = http.createServer((_req, res) => {
        upstreamCalls += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(okSse(500));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${port}`]: { models: { "claude-relay": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const id = "sess-3461-exhausted";
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/http://127.0.0.1:${port}/v1/messages`;
    const headers = { "content-type": "application/json", "x-acp-session": id };
    const post = (system: string, messages: Msg[]) => fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system, messages }),
    });
    try {
        // Turn 1: normal-sized payload, succeeds, arms the usage-grade baseline
        // and route evidence (so turn 2 takes the sizing path, not the
        // fresh-session forward-once arbitration).
        const smallSystem = "You are a helpful assistant.";
        const r1 = await post(smallSystem, [{ role: "user", content: "go?" }]);
        assert.equal(r1.status, 200, "turn 1 succeeds");
        await r1.text();

        // Turn 2: the client swaps in an oversized system prompt (~60k chars ≈
        // well over the 4k window) on top of the short history. The system
        // prompt is never foldable and the three history messages sit inside
        // the protected recent zone — no combination of folds closes the gap,
        // so the walk exhausts deterministically.
        const hugeSystem = "S".repeat(60_000);
        const r2 = await post(hugeSystem, [{ role: "user", content: "go?" }, { role: "assistant", content: "ok" }, { role: "user", content: "again?" }]);
        const j2 = (await r2.json()) as Record<string, unknown>;
        assert.equal(r2.status, 413, `deterministic exhaustion must answer 413 (pre-#3461: 502), got ${r2.status}: ${JSON.stringify(j2)}`);
        const err = j2["error"] as Record<string, unknown>;
        assert.match(String(err?.["message"]), /NOT forwarded/, "the diagnostic says the payload was not forwarded");
        assert.match(String(err?.["message"]), /exhaust|window|session/i, "the diagnostic carries the exhaustion reason");

        // Turn 3 (#4079): identical payload re-runs the deterministic exhaustion
        // check — same local 413, no marker, and still zero upstream traffic.
        const before = upstreamCalls;
        const r3 = await post(hugeSystem, [{ role: "user", content: "go?" }, { role: "assistant", content: "ok" }, { role: "user", content: "again?" }]);
        assert.equal(r3.status, 413, "the deterministic 413 verdict replays");
        await r3.text();
        assert.equal(upstreamCalls, before, "a deterministic local refusal must not touch the upstream");
        const s = listSessions().find((x) => x.id === id);
        assert.ok(s, "session exists");
        assert.equal(s!.metadata?.preflightDeadEnd, undefined, "(#4079) no dead-end marker is written anymore");
    } finally {
        await new Promise<void>((r) => proxy.close(() => r()));
        await new Promise<void>((r) => server.close(() => r()));
    }
});
