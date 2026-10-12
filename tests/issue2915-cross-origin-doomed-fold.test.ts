// #2915: cross-upstream model switch to a SMALLER window dead-ended the
// session. Mechanism chain (each link individually correct):
//   1. turn 1 on route A settles a usage-grade baseline (lastInputTokens,
//      lastInputTokensOrigin = A);
//   2. the switch routes turn 2 to route B with a smaller model window;
//   3. #1933 F2 demotes the cross-origin baseline (baselineFloor = 0);
//   4. #2313 arms probeForEvidence ("forward once to acquire evidence");
//   5. the live context exceeds BOTH #2490 doom bars (max(2MB, window×7.5)
//      bytes of core text) — provably unable to forward as-is;
//   6. PRE-FIX: the doomed guard returned a terminal 502 retryable=false
//      BEFORE any fold ran — the payload was an ordinary over-window
//      CONVERSATION (compressible), not an untrimmable blob, so the correct
//      remedy was the preflight fold, which the branch never attempted.
//      Every retry reproduced the identical 502; the session was unusable
//      until restart or switching back.
// POST-FIX: while anything outside the protected recent zone is foldable
// (same minCompressRange filter the walk applies), the guard falls through
// to the fold machinery instead of refusing. One preflight pass is bounded
// by design (digest: EMERGENCY_ROUND_CAP CPU-only rounds; LLM: a
// summary-call budget scaled to the overshoot), so these tests pin the
// pass-level contract in BOTH regimes — the walk makes real, persisted
// progress and the failure (when the pass alone cannot close the gap) is an
// HONEST verdict ("futile round" / "budget exhausted"), never the old
// misleading "remove your giant paste" terminal — while the raw payload is
// still never forwarded. Recovery continues on subsequent requests, which
// rebuild from the committed, reduced session state. The true-blob case
// (nothing foldable outside the protected zone) must STILL fail fast with
// the trim-it verdict — pinned in issue2490-ledger-floor-doomed-probe.test.ts.
//
// Why no test asserts a one-pass 200 here: any payload crossing the doom
// bar post-truncation holds ≥ ~500K tokens of ~4.07K-char truncation
// previews (truncate-tools.ts caps every candidate and stops at the target,
// so the sum floor is N_msgs × ~4.07K chars). A single pass removes at most
// budget×~4K tokens — below any window the bar admits — and every digest
// fold leaves a ~200-tok block behind, so the block overhead alone exceeds
// small windows. One-pass fit through this branch is unreachable by
// construction; the contract is bounded progress + honest verdict.
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
import { getSession } from "../src/session.ts";

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a long multi-step session across turns; every marker derives from the turn index, so folding loses nothing structural.";

type Call = { stream: boolean; summary: boolean; contentChars: number; body: string };

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

// fixedPromptTokens: report this constant as prompt_tokens on EVERY stream
// (route A needs a fixed 500K settle regardless of the tiny seed payload);
// undefined: report chars/40 (route B settles the REAL post-fold size).
function makeUpstream(fixedPromptTokens?: number): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean; messages?: Array<{ content?: unknown }> } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            const isSummary = /TASK: The conversation segment below/.test(raw);
            const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
            calls.push({ stream: !!parsed.stream, summary: isSummary, contentChars: chars, body: raw });
            if (isSummary) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(chatSse("forwarded answer", { prompt_tokens: fixedPromptTokens ?? Math.max(1, Math.round(chars / 40)), completion_tokens: 3 }));
        });
    });
    return { server, calls };
}

function proxyOptions(routes: Record<string, object>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes as ProxyOptions["routes"],
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20_000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        promptCache: { routing: "auto" },
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

type Env = { urlA: string; urlB: string; portA: number; portB: number; callsA: Call[]; callsB: Call[]; close: () => Promise<void> };

async function setup(windowB: number): Promise<Env> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upA = makeUpstream(500_000);
    upA.server.listen(0, "127.0.0.1");
    await once(upA.server, "listening");
    const portA = (upA.server.address() as { port: number }).port;
    const upB = makeUpstream();
    upB.server.listen(0, "127.0.0.1");
    await once(upB.server, "listening");
    const portB = (upB.server.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({
        [`http://127.0.0.1:${portA}`]: { models: { "big-model": { context: 400_000 } } },
        [`http://127.0.0.1:${portB}`]: { models: { "small-model": { context: windowB } } },
    }));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        urlA: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${portA}/chat/completions`,
        urlB: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${portB}/chat/completions`,
        portA,
        portB,
        callsA: upA.calls,
        callsB: upB.calls,
        close: async () => {
            proxy.close();
            upA.server.close();
            upB.server.close();
            await Promise.allSettled([once(proxy, "close"), once(upA.server, "close"), once(upB.server, "close")]);
        },
    };
}

const headers = (sessionId: string): Record<string, string> => ({ "content-type": "application/json", "x-acp-session": sessionId });

async function seedOnBig(env: Env, sessionId: string): Promise<void> {
    const r = await fetch(env.urlA, {
        method: "POST",
        headers: headers(sessionId),
        body: JSON.stringify({ model: "big-model", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(r.status, 200);
    await r.text();
    const s = getSession(sessionId);
    assert.ok(s, "session exists after the seed turn");
    assert.equal(s.stats.lastInputTokens, 500_000, "the seed settled a 500K usage baseline");
    assert.equal(s.stats.lastInputTokensSource, "usage");
    assert.ok((s.stats.lastInputTokensOrigin ?? "").includes(String(env.portA)), "the baseline is provenanced to route A");
}

function fillerMessages(count: number, charsPerMsg: number): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    const pad = Math.max(1, charsPerMsg - 12);
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}: ` + "f".repeat(pad) });
    }
    return messages;
}

function markedMessages(count: number, charsPerMsg: number): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < count; i++) {
        const unit = `MARKER_${i}_`;
        let content = unit.repeat(Math.ceil(charsPerMsg / unit.length));
        if (content.length > charsPerMsg) content = content.slice(0, charsPerMsg);
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content });
    }
    return messages;
}

// Extreme overshoot (~26x): hundreds of ordinary turns whose POST-truncation
// mass still stands past the doom bar. Every 8K-char turn clears
// truncateLargeToolOutputs' minOutputTokens (1000 tok), so at usage ≥ 95%
// the kernel's emergency-truncate node caps each to a ~4.07K-char preview
// BEFORE preflight sees it — 520 previews ≈ 2.1MB still crosses the absolute
// 2MB bar against a 20K window while every truncated turn stays above
// minCompressRange and therefore foldable. Beyond the 19.2x coverage bound
// the walk rides the deterministic-digest regime (zero upstream calls).
// This particular mass is unrecoverable in ONE pass even in principle —
// its ~120 digest blocks alone cost more than the whole window — so the
// pinned contract is: the guard falls through, the walk folds as far as it
// can at zero upstream cost, progress persists in the session, and the 502
// carries the HONEST futility verdict instead of the old misleading
// trim-it terminal (which fired before any fold ran, pre-fix).
test("e2e #2915: doomed bar with foldable content folds via digests and verdicts honestly (pre-fix: instant terminal 502)", async () => {
    const env = await setup(20_000);
    try {
        await seedOnBig(env, "s-2915-digest");

        const r = await fetch(env.urlB, {
            method: "POST",
            headers: headers("s-2915-digest"),
            body: JSON.stringify({ model: "small-model", stream: true, messages: [
                ...fillerMessages(520, 8_000),
                { role: "user", content: "recent one" },
                { role: "user", content: "final question" },
            ] }),
        });
        assert.equal(r.status, 502, "one pass cannot close a 26x gap — but the refusal is post-fold, not at the guard");
        const parsed = JSON.parse(await r.text()) as { error?: { message?: string; retryable?: boolean } };
        assert.match(parsed.error?.message ?? "", /futile round/, "honest verdict: folding ran and the math says the remainder cannot fit");
        assert.doesNotMatch(parsed.error?.message ?? "", /Remove or trim the oversized content/, "no longer tells the user to trim a giant paste that does not exist");
        assert.equal(parsed.error?.retryable, false, "genuinely unrecoverable in principle (block overhead alone exceeds the window) — terminal is correct here");

        assert.equal(env.callsB.filter((c) => !c.summary).length, 0, "the raw 4.16MB payload was never forwarded (#2490 invariant survives the fall-through)");
        assert.equal(env.callsB.filter((c) => c.summary).length, 0, "~26x overshoot exceeds the coverage bound — digests spend zero upstream calls (#2383)");

        const s = getSession("s-2915-digest");
        assert.ok(s);
        assert.ok(s.state.blocks.some((b) => b.active), "the walk's folds persisted as compression block(s) — the next request starts from the reduced state");
    } finally {
        await env.close();
    }
});

// The real incident's ratio class (~2.3x in production, here ~2.5x) against
// the incident's actual target window (225K): overshoot BELOW the coverage
// bound, so the walk rides the LLM fold path with real summarization calls.
// Same post-truncation bar arithmetic as the digest test: 560 truncated
// previews ≈ 2.3MB > 2MB bar, entryLocal ≈ 820K tok ≈ 2.5x < 19.2x. One pass
// is bounded by the summary-call budget (32 here), so it cannot close an
// ~600K-token gap alone — the pinned contract is: the guard falls through,
// the walk spends its bounded budget on REAL upstream summaries (this is the
// expensive-but-correct regime, unlike the digest test's zero-cost one),
// persists every fold, and the 502 says exactly what happened ("budget was
// exhausted after N rounds") instead of the old instant trim-it terminal.
// The session is NOT dead-ended: each subsequent request rebuilds from the
// committed blocks and continues folding.
test("e2e #2915: doomed bar at incident ratios spends the bounded LLM budget and verdicts honestly (pre-fix: instant terminal 502)", async () => {
    const env = await setup(225_000);
    try {
        await seedOnBig(env, "s-2915-llm");

        const body = JSON.stringify({ model: "small-model", stream: true, messages: [
            ...markedMessages(560, 8_000),
            { role: "user", content: "recent one" },
            { role: "user", content: "final question" },
        ] });
        const r = await fetch(env.urlB, { method: "POST", headers: headers("s-2915-llm"), body });
        assert.equal(r.status, 502, "one bounded pass cannot close a 2.5x gap of ~4K-token turns — but the refusal is post-fold, not at the guard");
        const parsed = JSON.parse(await r.text()) as { error?: { message?: string } };
        assert.match(parsed.error?.message ?? "", /compress budget was exhausted after \d+ rounds/, "honest verdict names the bounded pass that ran");
        assert.doesNotMatch(parsed.error?.message ?? "", /Remove or trim the oversized content/, "no longer tells the user to trim a giant paste that does not exist");

        const summaries = env.callsB.filter((c) => c.summary);
        assert.ok(summaries.length >= 1 && summaries.length <= 32, `the LLM fold path spent its bounded summary budget (got ${summaries.length} calls)`);
        assert.equal(env.callsB.filter((c) => !c.summary).length, 0, "the raw 4.48MB payload was never forwarded (#2490 invariant survives the fall-through)");

        const s = getSession("s-2915-llm");
        assert.ok(s);
        const activeBlocks = s.state.blocks.filter((b) => b.active);
        // Serial walk: exactly one summary call per round, each committing
        // exactly one block — so block count == call count proves every
        // upstream spend persisted as real progress (the next request
        // rebuilds from these blocks, already smaller).
        assert.equal(activeBlocks.length, summaries.length, "each summarization call committed one persisted compression block");
    } finally {
        await env.close();
    }
});
