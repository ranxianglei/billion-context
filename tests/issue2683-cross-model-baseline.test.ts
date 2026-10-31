import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// #1688: pin the legacy single-attempt failure budget so a socket drop
// surfaces as bili's 502 immediately (the shape G2 arms from).
process.env.BILI_REPLAY_RETRY_MAX = "1";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest, listSessions, type Session } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

// #2683: session input baselines outlived their measurement context —
// (A) armFailureShrink adopted the char-count UPPER BOUND as the session
// baseline (1.7–4× over-reading surviving as phantom mass), and
// (B) a usage-grade baseline measured under model X kept deciding requests
// for model Y after a mid-session model switch (case: 566,322 billed under a
// 1M-window model judged against a 400k window → two ~3-minute emergency
// folds on a payload already at 62% of the new window). The fixes: the arm
// adopts the billing-caliber READING (k̂-scaled outbound estimate + image
// reserve), and a real model change retires the trusted-grade baseline before
// prepare sizes the nudge and before the preflight trigger runs.

type Msg = { role: string; content: unknown };

const LINE = (i: number) =>
    `const handler_${i} = (req: Request, res: Response) => { res.status(200).json({ status: "ok", id: ${i}, ts: Date.now() }); };`;
const HEAVY = (i: number) => `CODE_${i}_` + LINE(i).repeat(62);

function baseConversation(): Msg[] {
    const msgs: Msg[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: i < 6 ? HEAVY(i) : `note_${i}_short tail ${i}` });
    }
    return msgs;
}

/** Streaming-call verdicts by 1-based index; anything unmatched gets 200 SSE. */
type Verdict = { kind: "ok"; input?: number } | { kind: "destroy" };

function makeRelay(script: Verdict[]) {
    const received: Buffer[] = [];
    let streamingCall = 0;
    let nonStream = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks);
            received.push(raw);
            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(raw.toString("utf8")); } catch { /* non-JSON */ }
            if (parsed.stream !== true) {
                nonStream += 1;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary", type: "message", role: "assistant", model: "claude-relay",
                    content: [{ type: "text", text: "PREFLIGHT SUMMARY: this segment is a cross-model baseline fixture whose every marker is derivable from its turn index." }], stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
                return;
            }
            streamingCall += 1;
            const verdict = script[streamingCall - 1];
            if (verdict?.kind === "destroy") { req.socket.destroy(); return; }
            const input = verdict && verdict.kind === "ok" ? (verdict.input ?? 5000) : 5000;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(
                `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: input } } })}\n\n` +
                `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
                `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
                `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
                `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
                `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
            );
        });
    });
    return { server, received, nonStreamCalls: () => nonStream };
}

interface Harness {
    logs: string[];
    relay: ReturnType<typeof makeRelay>;
    post: (model: string, messages: Msg[]) => Promise<Response>;
    session: () => Session;
    close: () => Promise<void>;
}

async function startHarness(sessionId: string, script: Verdict[], models: Record<string, { context: number }>): Promise<Harness> {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    _resetSessionsForTest();
    const relay = makeRelay(script);
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = (relay.server.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const window = Object.values(models)[0].context;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
        modelContextLimit: window,
        kernelConfig: defaultConfig(window),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
    const headers = { "content-type": "application/json", "x-acp-session": sessionId };
    const post = (model: string, messages: Msg[]) => fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages }),
    });
    const session = (): Session => {
        const s = listSessions().find((x) => x.id === sessionId);
        assert.ok(s, "session exists");
        return s!;
    };
    const close = async () => {
        await new Promise<void>((r) => proxy.close(() => r()));
        await new Promise<void>((r) => relay.server.close(() => r()));
    };
    return { logs, relay, post, session, close };
}

test("#2683 G1: a model switch retires the cross-model usage baseline — no phantom fold, no phantom nudge meter (e2e)", async () => {
    const id = "sess-2683-g1";
    const WINDOW = 400_000;
    const h = await startHarness(id, [
        { kind: "ok", input: 566_000 }, // turn 1 under claude-a bills OVER the window
        { kind: "ok", input: 6_000 },   // turn 2 under claude-b fits comfortably
    ], { "claude-a": { context: WINDOW }, "claude-b": { context: WINDOW } });
    try {
        const base = baseConversation();
        const r1 = await h.post("claude-a", base);
        assert.equal(r1.status, 200, "turn 1 succeeds");
        await r1.text();
        let s = h.session();
        assert.equal(s.stats.lastInputTokens, 566_000, "usage-grade baseline after turn 1");
        assert.equal(s.stats.lastInputTokensSource, "usage");

        const msgs2: Msg[] = [...base, { role: "assistant", content: "ok, done." }, { role: "user", content: "step two?" }];
        const r2 = await h.post("claude-b", msgs2);
        assert.equal(r2.status, 200, "turn 2 recovers");
        await r2.text();

        // The switch fired BEFORE the trigger: the 566k bill of claude-a was
        // retired, so claude-b's fitting payload judged on its OWN estimate
        // never crossed the preflight threshold — zero summarization calls.
        // Pre-fix, the trusted floor pinned decisionTokens at 566,322 ≥ the
        // ~380k target: the loop folded until its budget ran out (~3 minutes
        // live) although the payload sat at ~12k tokens.
        assert.equal(h.relay.nonStreamCalls(), 0, "no preflight fold on the switched turn");
        assert.ok(
            h.logs.some((l) => l.includes(`[${id}] model switched claude-a -> claude-b`) && l.includes("retired cross-model input baseline (566000")),
            "retirement logged with the retired value and both models",
        );
        // The phantom 142% meter (566000/400000) must be gone: nothing may size
        // off the foreign-model bill anymore.
        assert.ok(!h.logs.some((l) => l.includes("(566000/")), "no nudge/preflight line still divides by the switched-out bill");

        s = h.session();
        assert.equal(s.stats.lastInputTokens, 6_000, "the next usage report re-anchors the baseline");
        assert.equal(s.stats.lastInputTokensSource, "usage");
    } finally {
        await h.close();
    }
});

test("#2683 G2: a no-usage network failure arms at the billing-caliber reading, not the char-count bound (e2e)", async () => {
    const id = "sess-2683-g2";
    const WINDOW = 400_000;
    const TEXT_CHARS = 300_000; // dense ASCII: char-count 300k vs chars/4 ≈ 75k
    const h = await startHarness(id, [
        { kind: "destroy" },          // turn 1: socket drop, no usage report
        { kind: "ok", input: 5_000 }, // turn 2: retry recovers
    ], { "claude-m": { context: WINDOW } });
    try {
        const body: Msg[] = [{ role: "user", content: "x".repeat(TEXT_CHARS) }];
        const r1 = await h.post("claude-m", body);
        assert.equal(r1.status, 502, "network failure surfaces as bili's 502");
        await r1.text();

        const s1 = h.session();
        assert.equal(s1.stats.lastInputTokensSource, "estimate", "armed baseline is tagged as an estimate");
        const armed = s1.stats.lastInputTokens;
        // Raw-view scale (well above wire-overhead-only arming, the #1498-F2
        // regression)…
        assert.ok(
            armed >= TEXT_CHARS / 8,
            `arm measures the raw view (>= ${TEXT_CHARS / 8}), got ${armed}`,
        );
        // …but NOT the char-count upper bound (old arm ≥ 300,000 + overhead —
        // the 1.7–4× phantom mass this issue reports).
        assert.ok(
            armed < TEXT_CHARS,
            `arm must not adopt the char-count bound (< ${TEXT_CHARS}), got ${armed}`,
        );
        assert.ok(
            h.logs.some((l) => l.includes("armed emergency shrink with local estimate") && l.includes("(raw outbound reading)")),
            "provenance clause present in the arm log (no k̂ learned yet)",
        );

        const r2 = await h.post("claude-m", body);
        assert.equal(r2.status, 200, "retry recovers");
        await r2.text();
        assert.equal(h.relay.nonStreamCalls(), 0, "fitting retry forwards without folding");
        const s2 = h.session();
        assert.equal(s2.stats.lastInputTokens, 5_000, "real usage report overwrote the armed value");
    } finally {
        await h.close();
    }
});

test("#2683 G3: control — a SAME-MODEL over-window bill keeps its floor: genuine overflow still folds (e2e)", async () => {
    const id = "sess-2683-g3";
    const WINDOW = 100_000;
    const h = await startHarness(id, [
        { kind: "ok", input: 150_000 }, // system+tools-heavy upstream: bills far above the window
        { kind: "ok", input: 150_000 },
    ], { "claude-m": { context: WINDOW } });
    try {
        // Heavy older messages (foldable by the kernel) but a payload whose
        // OWN estimate (~12k tokens) sits far under the budget — only the
        // trusted 150k bill can trip the trigger. If the retirement ever
        // fired without a model change, the floor would vanish and this turn
        // would forward clean with zero summary calls.
        const base = baseConversation();
        const r1 = await h.post("claude-m", base);
        assert.equal(r1.status, 200, "turn 1 succeeds");
        await r1.text();
        assert.equal(h.session().stats.lastInputTokens, 150_000, "trusted baseline stands");

        const msgs2: Msg[] = [...base, { role: "assistant", content: "ok." }, { role: "user", content: "next step?" }];
        const r2 = await h.post("claude-m", msgs2);
        await r2.text();
        assert.ok(!h.logs.some((l) => l.includes("model switched")), "no spurious switch on a same-model turn");
        assert.equal(h.session().stats.lastInputTokensSource, "usage", "baseline NOT retired without a model change");
        assert.ok(
            h.relay.nonStreamCalls() >= 1,
            `genuine over-billing still folds via the trusted floor (summary calls=${h.relay.nonStreamCalls()})`,
        );
        assert.equal(r2.status, 200, "post-fold rebuild fits and forwards");
    } finally {
        await h.close();
    }
});
