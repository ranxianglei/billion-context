// #3004: dsh 上下文 700K 不触发压缩 — the decide-gate × self-heal deadlock.
// Field report: five consecutive decision failures exhausted the ladder
// (fallback ready) and five "injected-but-ignored" rounds armed
// suppress-nudge 5ms later; the suppression then gated willInjectNudge, which
// gated the very fallback branch that would have broken it, and release waited
// on compression evidence that only a nudge could prompt — a 4h12m latch at
// zero blocks, context pinned 77% under the wall. Three mechanisms fixed:
//   (A) the ladder's fallback is a failure-recovery path and outranks the
//       suppression (one-shot legacy advisory punch-through, consumeFallback
//       keeps it self-limiting);
//   (B) suppress-nudge gains a wall-clock cap (SELF_HEAL_SUPPRESS_CAP_MS) so
//       the circular wait cannot outlive ten minutes;
//   (C) the self-heal idle streak counts ACTUAL injections
//       (prepared.nudgeOutcome === "injected"), not the pre-gate prediction —
//       model-vetoed rounds no longer arm a suppression the model never saw.
// Plus the starvation shape: the decision side call must not inherit the
// host's reasoning knobs (dsh stamps reasoningEffort:max) or the tiny output
// budget dies before the one-line JSON answer exists ("empty response" ×3 in
// the field report).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, type Session } from "../src/session.ts";
import {
    SELF_HEAL_WINDOW,
    SELF_HEAL_SUPPRESS_CAP_MS,
    evaluateSelfHealRound,
    nudgeSuppressed,
    pluginLaneDegraded,
} from "../src/session-self-heal.ts";
import { DECIDE_FALLBACK_THRESHOLD, stripDecisionReasoningFields } from "../src/nudge-decide.ts";

const noop = () => {};

function mkSession(): Session {
    return {
        id: "s1",
        metadata: {},
        state: { nextBlockId: 1 },
        lastCompress: undefined,
    } as unknown as Session;
}

// ---- unit: stripDecisionReasoningFields ------------------------------------

test("unit: stripDecisionReasoningFields removes each protocol's reasoning knobs and nothing else", () => {
    const openai: Record<string, unknown> = { reasoning_effort: "max", reasoning: { effort: "high" }, thinking: true, max_tokens: 200, stream: false };
    stripDecisionReasoningFields("openai", openai);
    assert.equal(openai.reasoning_effort, undefined);
    assert.equal(openai.reasoning, undefined);
    assert.equal(openai.thinking, undefined);
    assert.equal(openai.max_tokens, 200, "non-reasoning fields untouched");
    assert.equal(openai.stream, false);

    const anthropic: Record<string, unknown> = { thinking: { type: "enabled", budget_tokens: 10_000 }, interleaved_thinking: true, model: "claude-x" };
    stripDecisionReasoningFields("anthropic", anthropic);
    assert.equal(anthropic.thinking, undefined);
    assert.equal(anthropic.interleaved_thinking, undefined);
    assert.equal(anthropic.model, "claude-x");

    const google: Record<string, unknown> = {
        thinkingConfig: { thinkingBudget: 1024 },
        generationConfig: { thinkingConfig: { thinkingBudget: 2048 }, maxOutputTokens: 200 },
    };
    stripDecisionReasoningFields("google", google);
    assert.equal(google.thinkingConfig, undefined);
    assert.deepEqual(google.generationConfig, { maxOutputTokens: 200 }, "nested thinkingConfig stripped, siblings kept");

    const responses: Record<string, unknown> = { reasoning: { effort: "high" }, max_output_tokens: 200 };
    stripDecisionReasoningFields("responses", responses);
    assert.equal(responses.reasoning, undefined);
    assert.equal(responses.max_output_tokens, 200);
});

// ---- unit: suppress-nudge wall-clock cap -----------------------------------

function armSuppress(s: Session): void {
    for (let i = 0; i < SELF_HEAL_WINDOW; i++) {
        evaluateSelfHealRound(s, { pluginHeaderPresent: false, biliToolsDeclared: true, nudgeActive: true, biliToolUses: 0, degradeAvailable: false }, noop);
    }
}

test("unit: suppress-nudge expires after the cap and re-arms only after a fresh window", () => {
    const s = mkSession();
    armSuppress(s);
    assert.equal(nudgeSuppressed(s), true);
    (s.metadata.selfHeal as { since: number }).since = Date.now() - SELF_HEAL_SUPPRESS_CAP_MS - 60_000;
    const logs: string[] = [];
    evaluateSelfHealRound(s, { pluginHeaderPresent: false, biliToolsDeclared: true, nudgeActive: false, biliToolUses: 0, degradeAvailable: false }, (l, m) => logs.push(`${l}:${m}`));
    assert.equal(nudgeSuppressed(s), false, "cap expired → suppression cleared unconditionally");
    assert.equal(s.metadata.selfHeal, undefined, "state cleared");
    assert.ok(logs.some((x) => x.includes("suppression expired")), "expiry is logged");
    // Bounded noise: re-arming costs a FRESH full window of injected idle rounds.
    for (let i = 0; i < SELF_HEAL_WINDOW - 1; i++) {
        evaluateSelfHealRound(s, { pluginHeaderPresent: false, biliToolsDeclared: true, nudgeActive: true, biliToolUses: 0, degradeAvailable: false }, noop);
        assert.equal(nudgeSuppressed(s), false, `round ${i + 1}: not yet re-armed`);
    }
    evaluateSelfHealRound(s, { pluginHeaderPresent: false, biliToolsDeclared: true, nudgeActive: true, biliToolUses: 0, degradeAvailable: false }, noop);
    assert.equal(nudgeSuppressed(s), true, "re-armed after another full window");
});

test("unit: a fresh suppression is untouched by the cap and survives extra rounds", () => {
    const s = mkSession();
    armSuppress(s);
    for (let i = 0; i < 3; i++) {
        evaluateSelfHealRound(s, { pluginHeaderPresent: false, biliToolsDeclared: true, nudgeActive: true, biliToolUses: 0, degradeAvailable: false }, noop);
    }
    assert.equal(nudgeSuppressed(s), true, "fresh latch holds");
    assert.ok((s.metadata.selfHeal as { since: number }).since > Date.now() - SELF_HEAL_SUPPRESS_CAP_MS);
});

test("unit: the cap applies to suppress-nudge only, never to degrade-to-proxy", () => {
    const s = mkSession();
    s.metadata.pluginAgent = "zcode";
    for (let i = 0; i < SELF_HEAL_WINDOW; i++) {
        evaluateSelfHealRound(s, { pluginHeaderPresent: false, biliToolsDeclared: false, nudgeActive: true, biliToolUses: 0, degradeAvailable: true }, noop);
    }
    assert.equal(pluginLaneDegraded(s), true);
    (s.metadata.selfHeal as { since: number }).since = Date.now() - SELF_HEAL_SUPPRESS_CAP_MS - 60_000;
    evaluateSelfHealRound(s, { pluginHeaderPresent: false, biliToolsDeclared: false, nudgeActive: true, biliToolUses: 0, degradeAvailable: true }, noop);
    assert.equal(pluginLaneDegraded(s), true, "degrade recovery is header-driven — no time cap");
});

// ---- e2e harness (openai wire, 64k window — 50k/64k = 78% arms OVER-LIMIT T1) ----

function okJson(promptTokens: number): string {
    return JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
    });
}

// 29-message history ≈ 50k tokens (same shape as nudge-model-decided.test.ts).
function turn2Messages(): Record<string, unknown>[] {
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

const msgLen = (b: Record<string, unknown>): number => (Array.isArray(b.messages) ? (b.messages as unknown[]).length : 0);

interface Harness {
    proxy: http.Server;
    upstream: http.Server;
    send: (messages: Record<string, unknown>[], extra?: Record<string, unknown>) => Promise<number>;
    mains: Record<string, unknown>[];
    sides: Record<string, unknown>[];
    setVerdict: (v: string | null) => void;
}

async function startHarness(sessionId: string, modelDecided: boolean): Promise<Harness> {
    let verdict: string | null = '{"compress": false}';
    const mains: Record<string, unknown>[] = [];
    const sides: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            // The decision call is the only request with the tiny output budget (default 200).
            if (typeof body.max_tokens === "number" && body.max_tokens <= 200) {
                sides.push(body);
                const content = verdict ?? "";
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "chatcmpl-decide",
                    object: "chat.completion",
                    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: content ? "stop" : "length" }],
                    usage: { prompt_tokens: 50_000, completion_tokens: 10, total_tokens: 50_010 },
                }));
                return;
            }
            mains.push(body);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson(50_000));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-v4-flash": { context: 64_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: {
            injectTool: true,
            injectNudge: true,
            ...(modelDecided ? { nudgeModelDecided: true } : {}),
        },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    const send = async (messages: Record<string, unknown>[], extra: Record<string, unknown> = {}): Promise<number> => {
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": sessionId },
            body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 64_000, ...extra, messages }),
        });
        await r.text();
        return r.status;
    };
    return { proxy, upstream, send, mains, sides, setVerdict: (v) => { verdict = v; } };
}

async function closeHarness(h: Harness): Promise<void> {
    h.proxy.close();
    h.proxy.closeIdleConnections?.();
    await once(h.proxy, "close");
    h.upstream.close();
    h.upstream.closeIdleConnections?.();
    await once(h.upstream, "close");
}

// ---- e2e: the deadlock itself ------------------------------------------------

test("#3004: latched suppression + exhausted ladder — the fallback punches through once, the cap reopens the channel", async () => {
    const sessionId = "deadlock-repro";
    const h = await startHarness(sessionId, true);
    try {
        const baseline = [{ role: "user", content: "hello" }];
        assert.equal(await h.send(baseline), 200);
        assert.equal(await h.send(turn2Messages()), 200);
        assert.equal(h.sides.length, 1, "armed round sent the decision call");
        assert.equal(msgLen(h.mains[1]!), 30, "model declined → bare payload (29 + system)");

        // Seed the exact incident state: suppression latched AND the ladder
        // already at fallback (three consecutive decision failures).
        const sess = listSessions().find((x) => x.id === sessionId)!;
        assert.ok(sess, "session exists");
        sess.metadata["nudgeDecideFails"] = DECIDE_FALLBACK_THRESHOLD;
        sess.metadata["selfHeal"] = { detected: "nudge-idle", action: "suppress-nudge", since: Date.now() };

        // Pre-fix: this round — and every round after it — went out bare forever
        // (suppression gated willInjectNudge, which gated the fallback branch).
        assert.equal(await h.send(turn2Messages()), 200);
        assert.equal(msgLen(h.mains[2]!), 31, "the one-shot legacy advisory punched through the latched suppression");
        const r3msgs = h.mains[2]!.messages as Record<string, unknown>[];
        const r3last = typeof r3msgs[r3msgs.length - 1]?.content === "string" ? (r3msgs[r3msgs.length - 1]!.content as string) : "";
        assert.ok(!r3last.includes("[bili-compress-directive]"), "it is the ADVISORY, not a directive");
        assert.equal(sess.metadata["nudgeDecideFails"], 0, "consumeFallback reset the ladder on the same round");
        assert.equal((sess.metadata["selfHeal"] as { action: string } | undefined)?.action, "suppress-nudge", "one-shot: the latch survives its own punch-through");

        // Ladder back in try mode, latch still up: the channel stays quiet
        // (no side call — suppression is doing its job) until the cap expires.
        assert.equal(await h.send(turn2Messages()), 200);
        assert.equal(h.sides.length, 1, "suppressed round sends no decision call");
        assert.equal(msgLen(h.mains[3]!), 30, "bare again — the punch-through was one-shot");

        // Backdate the latch past the cap. The expiry lands AFTER this round's
        // prepare (the hook runs post-prepare), so this round is still bare and
        // the NEXT one runs the gate again.
        (sess.metadata["selfHeal"] as { since: number }).since = Date.now() - SELF_HEAL_SUPPRESS_CAP_MS - 1;
        assert.equal(await h.send(turn2Messages()), 200);
        assert.equal(sess.metadata.selfHeal, undefined, "cap expired — suppression cleared");
        assert.equal(h.sides.length, 1, "the expiring round itself prepared under the old latch");
        assert.equal(await h.send(turn2Messages()), 200);
        assert.equal(h.sides.length, 2, "channel reopened — the decision gate runs again");
        assert.equal(msgLen(h.mains[5]!), 30, "and the model's standing veto still holds on the reopened round");
    } finally {
        await closeHarness(h);
    }
});

// ---- e2e: the starvation shape ----------------------------------------------

test("#3004: the decision side call drops the host's reasoning knobs; the main request keeps them", async () => {
    const sessionId = "starve-shape";
    const h = await startHarness(sessionId, true);
    h.setVerdict(null); // empty content — the field report's "empty response" shape
    try {
        assert.equal(await h.send([{ role: "user", content: "hello" }]), 200);
        assert.equal(await h.send(turn2Messages(), { reasoning_effort: "max" }), 200);
        assert.equal(h.sides.length, 1, "the armed round still asks the model");
        const side = h.sides[0]!;
        assert.equal(side.reasoning_effort, undefined, "side call must not inherit reasoning_effort");
        assert.equal(side.reasoning, undefined);
        assert.equal(side.thinking, undefined);
        assert.equal(msgLen(h.mains[1]!), 30, "an empty answer vetoes the round — never force-compress on garbage");
        const main = h.mains[1]!;
        assert.equal(main.reasoning_effort, "max", "the MAIN request is untouched (host intent preserved)");
        const sess = listSessions().find((x) => x.id === sessionId)!;
        assert.equal(sess.metadata["nudgeDecideFails"], 1, "the hard failure counts toward the ladder");
    } finally {
        await closeHarness(h);
    }
});

// ---- e2e: the false ledger ---------------------------------------------------

test("#3004: model-vetoed rounds credit no idle streak — no spurious suppression", async () => {
    const sessionId = "false-ledger";
    const h = await startHarness(sessionId, true); // default verdict: clean "no"
    try {
        assert.equal(await h.send([{ role: "user", content: "hello" }]), 200);
        for (let i = 0; i < SELF_HEAL_WINDOW + 1; i++) {
            assert.equal(await h.send(turn2Messages()), 200);
        }
        assert.equal(h.sides.length, SELF_HEAL_WINDOW + 1, "every armed round asked the model");
        const sess = listSessions().find((x) => x.id === sessionId)!;
        assert.equal(sess.metadata.selfHeal, undefined, "six vetoed rounds armed nothing — the model never received a nudge, so none was 'ignored'");
    } finally {
        await closeHarness(h);
    }
});
