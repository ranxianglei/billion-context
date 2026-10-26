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
import { normalizeUpstreamOrigin } from "../src/util.ts";

// #2313: a 10,341-message/61.5MiB session behind a local OpenAI-compatible
// shim (~200 B/token billing) lost its usage baseline on a route change and
// fell back to lastInputTokensSource="estimate"; preflight then read the
// chars/4 estimate at face value (7.3M-10.3M against a REAL 305K input,
// ~24-34x over — k̂ cannot express 1/24: one-way clamp 0.25-1, samples below
// CALIBRATION_SAMPLE_MIN are discarded), blocked every forward until folding
// finished, folding cannot finish inside the client's ~300s stream-idle
// abort, and the loop never lets a forward through: 0 successful forwards in
// 12h while failed turns ratcheted the estimate meter higher. The fix has two
// halves, pinned here:
//   (a) probe-forward gate: an ESTIMATE may not block the forward — a nonzero
//       baseline with no current-route upstream evidence (baselineFloor === 0
//       after #1492/#1933 F2) forwards once to acquire evidence (usage on
//       success, overflow-arm on a 4xx) instead of folding first;
//   (b) arm origin stamp: armOverflowShrink records the upstream that
//       rejected, so the arm survives the #1933 F2 route gate as
//       current-route evidence — without it the #1195 in-request refold would
//       re-probe the raw body, take a second 400 and lock the session again.
// Also pinned: with evidence present (usage on the current route) the
// fold-first behavior is unchanged, and the window-not-parseable arm
// (fallback branch) carries the same origin stamp as the stated-window arm.

const WINDOW = 20_000;
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment held deterministic load-growth payloads across turns; every marker derives from the turn index, so folding loses nothing.";

type Call = { summary: boolean; stream: boolean; contentChars: number };

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

function bigMessages(count = 30, charsPerMsg = 4_400): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    const pad = Math.max(1, charsPerMsg - 12);
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}: ` + "f".repeat(pad) });
    }
    return messages;
}

// Bills what it receives at a divergent ~200 B/token caliber (chars/40 —
// the #2313 shim profile: the local chars/4 estimate over-reads ~10x).
// firstRejectBody: when set, the FIRST big (>100K chars) non-summary call is
// answered with this 400 body instead.
function makeUpstream(firstRejectBody?: string): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            try {
                const parsed = JSON.parse(raw) as { stream?: boolean; messages?: Array<{ content?: unknown }> };
                const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
                calls.push({ summary: isSummary, stream: !isSummary && !!parsed.stream, contentChars: chars });
                if (isSummary) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
                    return;
                }
                if (firstRejectBody && !isSummary && chars > 100_000 && calls.filter((c) => !c.summary && c.contentChars > 100_000).length === 1) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(firstRejectBody);
                    return;
                }
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(chatSse("forwarded answer", { prompt_tokens: Math.max(1, Math.round(chars / 40)), completion_tokens: 3 }));
            } catch {
                res.writeHead(400, { "content-type": "application/json" });
                res.end('{"error":{"message":"unparseable"}}');
            }
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
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
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

type Ctx = { url: string; headers: Record<string, string>; upstreamPort: number };

async function setup(firstRejectBody?: string): Promise<{ ctx: Ctx; calls: Call[]; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream(firstRejectBody);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } }));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": "" },
            upstreamPort,
        },
        calls,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            upstream.close();
            upstream.closeIdleConnections?.();
            await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
        },
    };
}

const post = (ctx: Ctx, messages: Array<{ role: string; content: string }>) =>
    fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
    });

// Create the session with one real turn, then corrupt its meter into the
// #2313 stuck state: estimate-sourced baseline at phantom scale, measured on
// a route that no longer matches (random loopback port on the shim).
async function seedStuckMeter(ctx: Ctx, sessionId: string, lastInputTokens = 7_300_000): Promise<void> {
    ctx.headers["x-acp-session"] = sessionId;
    const r = await post(ctx, [{ role: "user", content: "hello" }]);
    assert.equal(r.status, 200);
    await r.text();
    const s = getSession(sessionId);
    assert.ok(s, "session exists after turn 1");
    s.stats.lastInputTokens = lastInputTokens;
    s.stats.lastInputTokensSource = "estimate";
    s.stats.lastInputTokensOrigin = "http://127.0.0.1:1";
}

test("e2e #2313 a: estimate-only trigger forwards once instead of folding — success settles a usage baseline", async () => {
    const { ctx, calls, close } = await setup();
    try {
        await seedStuckMeter(ctx, "i2313-a");

        // ~132K chars => ~33K-token estimate vs 20K window: the trigger fires
        // on the estimate channel alone. The probe gate must forward the raw
        // body (exactly one upstream call, zero summarization calls) instead
        // of blocking on folding.
        const r = await post(ctx, bigMessages());
        assert.equal(r.status, 200, "probe forward reaches the upstream");
        await r.text();

        assert.equal(calls.filter((c) => !c.summary).length, 2, "turn 1 + exactly one probe forward");
        assert.equal(calls.filter((c) => c.summary).length, 0, "no summarization call may run before evidence exists");

        const s = getSession("i2313-a");
        assert.ok(s);
        assert.equal(s.stats.lastInputTokensSource, "usage", "the probe's response settles a usage baseline");
        assert.ok((s.stats.lastInputTokens ?? 0) < WINDOW, `baseline returns to the shim's real scale (~3K), got ${s.stats.lastInputTokens}`);
        assert.equal(s.stats.lastInputTokensOrigin, normalizeUpstreamOrigin(`http://127.0.0.1:${ctx.upstreamPort}`));
    } finally {
        await close();
    }
});

test("e2e #2313 b: probe 400 arms current-route evidence (origin-stamped) — the #1195 refold folds within the request", async () => {
    const rejectBody = JSON.stringify({ error: { message: "prompt is too long: 33000 tokens > 20000 maximum" } });
    const { ctx, calls, close } = await setup(rejectBody);
    try {
        await seedStuckMeter(ctx, "i2313-b");

        const r = await post(ctx, bigMessages());
        assert.equal(r.status, 200, "rejected probe + in-request refold recovers the turn");
        await r.text();

        const forwards = calls.filter((c) => !c.summary);
        assert.equal(forwards.length, 3, "turn 1 + raw probe forward + one folded retry");
        assert.ok(calls.some((c) => c.summary), "the refold made summarization call(s)");
        assert.ok(forwards[2]!.contentChars < forwards[1]!.contentChars, "the retry carries the folded payload");

        const s = getSession("i2313-b");
        assert.ok(s);
        // Without the origin stamp the arm keeps the stale #2313 origin, #1933
        // F2 demotes it, the refold re-probes the raw body and the second 400
        // passes through — pin that the arm IS current-route evidence.
        assert.equal(s.stats.lastInputTokensOrigin, normalizeUpstreamOrigin(`http://127.0.0.1:${ctx.upstreamPort}`), "arm origin is stamped from the rejecting upstream");
        assert.equal(s.stats.overflowArmTokens, undefined, "the successful retry's usage report retires the one-shot arm (#1110)");
        assert.equal(s.stats.lastInputTokensSource, "usage", "the folded retry settles the final baseline");
    } finally {
        await close();
    }
});

test("e2e #2313 c: with a current-route usage baseline the fold-first behavior is unchanged", async () => {
    const { ctx, calls, close } = await setup();
    try {
        // Evidence present: usage-grade baseline measured on THIS route.
        ctx.headers["x-acp-session"] = "i2313-c";
        const r1 = await post(ctx, [{ role: "user", content: "hello" }]);
        assert.equal(r1.status, 200);
        await r1.text();
        const s = getSession("i2313-c");
        assert.ok(s);
        assert.equal(s.stats.lastInputTokensSource, "usage");
        s.stats.lastInputTokens = 25_000; // usage-grade, over-window, current route
        s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(`http://127.0.0.1:${ctx.upstreamPort}`);

        const r2 = await post(ctx, bigMessages());
        assert.equal(r2.status, 200);
        await r2.text();

        const forwards = calls.filter((c) => !c.summary);
        const rawChars = bigMessages().reduce((n, m) => n + m.content.length, 0);
        assert.equal(forwards.length, 2, "turn 1 + exactly one (folded) forward");
        assert.ok(calls.some((c) => c.summary), "preflight folds BEFORE forwarding when evidence exists");
        assert.ok(forwards[1]!.contentChars < rawChars, "the forward carries the folded payload");
    } finally {
        await close();
    }
});

test("e2e #2313 d: probe 400 without a parseable window arms the fallback shrink origin-stamped — the #1195 refold still recovers", async () => {
    // No window number in the rejection → armOverflowShrink's fallback branch
    // (arm at min(declared, payload estimate)) — the branch test b's stated-
    // window rejection never reaches. Without ITS origin stamp the arm keeps
    // the stale #2313 origin, #1933 F2 demotes it on the refold's re-prepare,
    // the probe gate re-forwards the raw body and the second 400 passes through.
    const rejectBody = JSON.stringify({ error: { message: "context length exceeded" } });
    const { ctx, calls, close } = await setup(rejectBody);
    try {
        await seedStuckMeter(ctx, "i2313-d");

        const r = await post(ctx, bigMessages());
        assert.equal(r.status, 200, "rejected probe + in-request refold recovers the turn (no stated window)");
        await r.text();

        const forwards = calls.filter((c) => !c.summary);
        assert.equal(forwards.length, 3, "turn 1 + raw probe forward + one folded retry");
        assert.ok(calls.some((c) => c.summary), "the refold made summarization call(s)");
        assert.ok(forwards[2]!.contentChars < forwards[1]!.contentChars, "the retry carries the folded payload");

        const s = getSession("i2313-d");
        assert.ok(s);
        assert.equal(s.stats.lastInputTokensOrigin, normalizeUpstreamOrigin(`http://127.0.0.1:${ctx.upstreamPort}`), "fallback arm origin is stamped from the rejecting upstream");
        assert.equal(s.stats.lastInputTokensSource, "usage", "the folded retry settles the final baseline");
    } finally {
        await close();
    }
});
