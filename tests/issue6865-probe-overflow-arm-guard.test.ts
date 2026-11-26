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

// #6865: the #5974 "corrective second pass" probe inside
// preflightCompressIfNeeded writes its local estimate onto the session
// baseline WITHOUT an overflow-arm guard:
//   if (probeTextSize > session.stats.lastInputTokens) {
//       session.stats.lastInputTokens = probeTextSize;
//       session.stats.lastInputTokensSource = "estimate";
//   }
// It runs BEFORE the #5880 fix's guarded post-rebuild anchor, so in the
// caliber-delta case (post-fold local probe slightly above the armed wall,
// but the payload actually fits) the probe demotes the ACTIVE overflow-arm
// tag to "estimate" — and the #5880 guard (which checks for overflow-arm)
// no longer fires. The session then fit-forwards on a stale local estimate
// and sails past the upstream wall → 400 CONTEXT_WINDOW_EXCEEDED → re-arm →
// repeat: the exact livelock #5880 fixed, re-opened on a different path.
// The fix is the 1-line guard the maintainer specified (same doctrine as the
// #5880 fix and relay.ts #2484 armFailureShrink): only write the estimate
// when the current source is not "overflow-arm". Pinned both directions:
//   (a) armed → not demoted (the "overflow-arm" SOURCE tag AND the separately
//       recorded overflowArmTokens ceiling survive the probe — the raw
//       lastInputTokens value legitimately nets DOWN by reclaimed tokens when
//       the fold lands (absorb.ts/stream.ts #252 credit netting), so it is
//       NOT asserted to survive; the guard reads the tag + the ceiling,
//       relay.ts:1832 "guard reads this, not the baseline");
//   (b) unarmed → demoted as before (probe still raises the estimate baseline).
//
// The upstream shim deliberately returns NO usage block: a usage report would
// settle the baseline afterwards (#1595 keeps lastInputTokens when no usage
// lands), washing out exactly the write this test pins.

const WINDOW = 20_000;
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment held deterministic load-growth payloads across turns; every marker derives from the turn index, so folding loses nothing.";

type Call = { summary: boolean; stream: boolean; contentChars: number };

function chatSse(text: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
}

function bigMessages(count = 30, charsPerMsg = 4_400): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    const pad = Math.max(1, charsPerMsg - 12);
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}: ` + "f".repeat(pad) });
    }
    return messages;
}

function makeUpstream(): { server: http.Server; calls: Call[] } {
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
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(chatSse("forwarded answer"));
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

async function setup(): Promise<{ ctx: Ctx; calls: Call[]; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream();
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

// Create the session with one real turn, then arm it exactly as
// armOverflowShrink does after an upstream 400: baseline at the stated
// window, tagged "overflow-arm", stamped with the current-route origin,
// ceiling recorded separately in overflowArmTokens.
async function seedArmed(ctx: Ctx, sessionId: string, armedTokens = WINDOW): Promise<void> {
    ctx.headers["x-acp-session"] = sessionId;
    const r = await post(ctx, [{ role: "user", content: "hello" }]);
    assert.equal(r.status, 200);
    await r.text();
    const s = getSession(sessionId);
    assert.ok(s, "session exists after turn 1");
    s.stats.lastInputTokens = armedTokens;
    s.stats.lastInputTokensSource = "overflow-arm";
    s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(`http://127.0.0.1:${ctx.upstreamPort}`);
    s.stats.overflowArmTokens = armedTokens;
}

// Same shape, but an ordinary usage baseline (no arm): the probe write
// must still demote it to "estimate", exactly as before the fix. (An
// estimate-only baseline never counts as evidence — the #2313 probe-forward
// gate forwards it raw without folding — so the unarmed direction is pinned
// on a usage baseline, which does fold first.)
async function seedUnarmed(ctx: Ctx, sessionId: string, baselineTokens = 15_000): Promise<void> {
    ctx.headers["x-acp-session"] = sessionId;
    const r = await post(ctx, [{ role: "user", content: "hello" }]);
    assert.equal(r.status, 200);
    await r.text();
    const s = getSession(sessionId);
    assert.ok(s, "session exists after turn 1");
    s.stats.lastInputTokens = baselineTokens;
    s.stats.lastInputTokensSource = "usage";
    s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(`http://127.0.0.1:${ctx.upstreamPort}`);
}

test("e2e #6865 a: #5974 probe does NOT demote an active overflow-arm baseline", async () => {
    const { ctx, calls, close } = await setup();
    try {
        await seedArmed(ctx, "i6865-a");

        // ~132K chars => ~33K-token probe rebuild vs the 20K armed wall:
        // the probe write would fire on unfixed code.
        const r = await post(ctx, bigMessages());
        assert.equal(r.status, 200, "the folded turn still forwards");
        await r.text();

        assert.ok(calls.some((c) => c.summary), "preflight folded before forwarding (probe ran inside it)");

        const s = getSession("i6865-a");
        assert.ok(s);
        assert.equal(s.stats.lastInputTokensSource, "overflow-arm", "the probe must not demote the arm to estimate");
        assert.equal(s.stats.overflowArmTokens, WINDOW, "the separately recorded arm ceiling survives the probe");
    } finally {
        await close();
    }
});

test("e2e #6865 b: unarmed usage baseline is still demoted by the probe, as before", async () => {
    const { ctx, calls, close } = await setup();
    try {
        await seedUnarmed(ctx, "i6865-b");

        const r = await post(ctx, bigMessages());
        assert.equal(r.status, 200, "the folded turn still forwards");
        await r.text();

        assert.ok(calls.some((c) => c.summary), "preflight folded before forwarding (probe ran inside it)");

        const s = getSession("i6865-b");
        assert.ok(s);
        assert.equal(s.stats.lastInputTokensSource, "estimate", "unarmed baseline keeps its estimate source");
        assert.ok(
            (s.stats.lastInputTokens ?? 0) > 15_000,
            `probe still raises the unarmed baseline past its 15K seed, got ${s.stats.lastInputTokens}`,
        );
    } finally {
        await close();
    }
});
