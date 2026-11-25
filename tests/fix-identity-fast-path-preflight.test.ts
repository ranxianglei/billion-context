// Identity fast path for preflight doom verdicts (2026-11-22 opencode 413
// incident). The field shape: an identified session whose PRIOR turn was
// ACCEPTED by the upstream at over-window size (billed 824,944 tokens against
// a 786,432 window) got 413'd on the NEXT turn because the local estimate —
// the image channel's pre-shed number ran ~4x over the upstream's actual bill
// (948,600 estimated vs ~229K billed) — said "can never fit, deterministic".
// Policy (user decision, 2026-11-22): when the server knows the conversation
// (identified sid) AND holds REAL upstream reality for the same origin+model
// (a usage bill or an overflow-arm rejection), local doom-math may no longer
// VETO a forward — every deterministic doom verdict converts to "forward the
// outbound as configured"; a genuine upstream 400 is absorbed by the existing
// overflow-arm recovery. The protection chain (and its 413 semantics) stays
// intact when reality is absent or stale: anonymous, first request, origin or
// model changed since the evidence (#1933 F2 / #2117 demotion semantics), or
// an upstream-stated overflow wall (#3450).
//
// Pinned here:
//   A. identified sid + same-origin+model usage evidence ≥ window + a
//      deterministically-doomed IMAGE payload (image mass alone clears the
//      window; no combination of folds closes the gap — the incident's exact
//      walk verdict) → 200 forwarded. An image-dominated payload is caught
//      EARLIER by the #496/#1800 image-arbitration forward (opened by the
//      3c tolerance rule: usage ≥ window = tolerance evidence, not overflow
//      evidence), so the trust-reality family line is the #496/#1800 one.
//   A2. same seed but a TEXT-dominated doomed payload (no images, so the
//      #496/#1800 image hatch cannot intercept) → the identity fast path
//      itself converts the post-fold doom verdict: 200 forwarded, log carries
//      the "identity fast path" line specifically (not the arbitration line).
//   B. same seed but the usage-grade reality is on a FOREIGN origin (#1933 F2
//      demotion: a bill from another provider is not evidence for this lane)
//      → protection chain judges: deterministic 413 retryable:false, log
//      carries the demotion line. The #2847 status contract is untouched.
//   B2. same seed but the session last ran on ANOTHER model (#2117 model gate
//      — a bill on claude-big binds nothing for claude-small) → fast path
//      demoted: deterministic 413 retryable:false, log carries the demotion
//      line, zero new upstream calls.
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
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WINDOW = 20_000;

type Call = { summary: boolean; contentChars: number };

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

/** The deterministically-doomed shape of the incident: a little foldable text
 *  plus image mass ALONE over the window (2 × 16,384 fallback tokens =
 *  32,768 ≥ window 20,000, and ≥ the overflow target). The walk's
 *  futile-round math (preflight.ts) proves no combination of folds can close
 *  the gap — images are not foldable — so the exhaustion is deterministic.
 *  The data URLs decode to one repeated byte: no container signature parses,
 *  so each lands on PIXEL_IMAGE_FALLBACK_TOKENS (the incident's own channel). */
function imagePayload(): Array<{ role: string; content: unknown }> {
    return imagePayloadInner();
}

// Mirrors tests/issue2847-doomed-nonretryable-status.test.ts bigMessages():
// 500 msgs × 4.4K chars ≈ 2.2MB ASCII core text — past BOTH doom bars
// (absolute 2MB floor; 20K window × 7.5 B/token = 150KB ratio bar), and
// image-free so the #2313 image arbitration cannot intercept.
function bigMessages(count = 500, charsPerMsg = 4_400): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    const pad = Math.max(1, charsPerMsg - 12);
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}: ` + "f".repeat(pad) });
    }
    return messages;
}

function imagePayloadInner(): Array<{ role: string; content: unknown }> {
    const b64 = Buffer.alloc(16 * 1024, 0x78).toString("base64");
    const img = (n: number) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}${n}` } });
    return [
        { role: "user", content: "turn 0: " + "f".repeat(1_200) },
        { role: "assistant", content: "ack: " + "e".repeat(1_200) },
        { role: "user", content: [{ type: "text", text: "look at these" }, img(1), img(2)] },
    ];
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
                const parsed = JSON.parse(raw) as { messages?: Array<{ content?: unknown }> };
                const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
                calls.push({ summary: isSummary, contentChars: chars });
                if (isSummary) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: "PREFLIGHT SUMMARY: filler." }, finish_reason: "stop" }] }));
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
        log: true,
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

// sid === null → NO x-acp-session header (anonymous request);
// omitted → inherit ctx.headers (the seeded session).
const post = (ctx: Ctx, messages: Array<{ role: string; content: unknown }>, sid?: string | null) =>
    fetch(ctx.url, {
        method: "POST",
        headers: sid === null ? { "content-type": "application/json" } : { ...ctx.headers },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
    });

// One small turn so the session exists. Then pin the upstream reality the
// fast path consumes: a usage bill of 3× the window — the incident's
// accepted-over-window shape (824,944 billed vs 786,432 window), where a
// "usage ≥ limit" reading must count as TOLERANCE, not as overflow evidence.
// originOverride pins the evidence on a FOREIGN origin (the #1933 demotion
// shape: a bill learned on another provider says nothing about this lane).
// sourceOverride mirrors the #2847 stuck-meter seed (estimate-grade ghost on
// a foreign origin) when a test needs the doom-math veto to stay live.
async function seedTrusted(ctx: Ctx, sessionId: string, opts?: { origin?: string; source?: "usage" | "estimate" }): Promise<void> {
    ctx.headers["x-acp-session"] = sessionId;
    const r = await post(ctx, [{ role: "user", content: "hello" }]);
    assert.equal(r.status, 200);
    await r.text();
    const s = getSession(sessionId);
    assert.ok(s, "session exists after turn 1");
    s.stats.lastInputTokens = 3 * WINDOW;
    s.stats.lastInputTokensSource = opts?.source ?? "usage";
    s.stats.lastInputTokensOrigin = opts?.origin ?? `http://127.0.0.1:${ctx.upstreamPort}`;
}

test("e2e identity fast path: identified sid + same-origin upstream reality outranks local doom-math", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-identity-"));
    const { ctx, calls, close } = await setup();
    const logs: string[] = [];
    setLogCapture((_lvl, msg) => { logs.push(msg); });
    try {
        await seedTrusted(ctx, "s-id-trusted");
        const before = calls.length;

        const r = await post(ctx, imagePayload());
        const body = await r.text();

        // THE fix under test: the deterministic doom verdict (images alone
        // clear the window; zero folds can close the gap) is CONVERTED to a
        // forward because the upstream already accepted this session's
        // payloads on this exact origin — including over-window.
        assert.equal(r.status, 200, `trusted identity must forward the doomed-by-estimate payload (got ${r.status}); body=${body.slice(0, 300)}`);
        assert.match(body, /forwarded answer/, "the payload actually reached the upstream");
        // The upstream saw exactly ONE new non-summary call (the forward
        // itself) — no summary round-trips burned deciding.
        const since = calls.slice(before);
        assert.equal(since.length, 1, `exactly one upstream call for the forward (got ${JSON.stringify(since)})`);
        assert.equal(since[0]!.summary, false);
        // The conversion is auditable in the log. An image-dominated payload
        // with a usage baseline ≥ window is now caught EARLIER by the #496/
        // #1800 image-arbitration forward (opened by the 3c tolerance rule:
        // usage ≥ window = tolerance evidence, not overflow evidence); both
        // lines are the "trust recorded reality over local doom-math" family.
        assert.ok(logs.some((m) => m.includes("identity fast path") || m.includes("arbitrate billing (#496/#1800)")), "log carries the trust-reality forward line");
    } finally {
        setLogCapture(null);
        await close();
        rmrf(root);
    }
});

test("e2e #7537: a TEXT doom verdict (no images) is forwarded with no local estimate-refusal, not via the #496/#1800 hatch", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-identity-"));
    const { ctx, calls, close } = await setup();
    const logs: string[] = [];
    setLogCapture((_lvl, msg) => { logs.push(msg); });
    try {
        await seedTrusted(ctx, "s-id-text-fp");
        const before = calls.length;

        // TEXT-dominated doomed shape (issue2847: 500 msgs × 4.4K chars ≈ 2.2MB
        // — past BOTH doom bars; NO images, so the #496/#1800 image-arbitration
        // hatch cannot intercept). Under #7537 the payload is forwarded with no
        // local estimate-refusal — the upstream's own size verdict is
        // authoritative (test A's image payload is caught earlier by the image
        // hatch, so it does NOT pin this gate — #3617: the positive direction
        // needs its own row).
        const r = await post(ctx, bigMessages());
        const body = await r.text();

        assert.equal(r.status, 200, `trusted same-origin+model TEXT doom must forward (got ${r.status}); body=${body.slice(0, 300)}`);
        assert.match(body, /forwarded answer/, "the payload actually reached the upstream");
        const since = calls.slice(before);
        assert.equal(since.length, 1, `exactly one upstream call for the forward (got ${JSON.stringify(since)})`);
        assert.equal(since[0]!.summary, false);
        // The #7537 no-estimate-refusal forward line specifically — the #496/#1800
        // arbitration line is image-only and must NOT be the carrier for a text payload.
        assert.ok(logs.some((m) => m.includes("forwarding per #7537")), "log carries the #7537 no-estimate-refusal forward line");
        assert.ok(!logs.some((m) => m.includes("arbitrate billing (#496/#1800)")), "the text payload did not ride the image-arbitration hatch");
    } finally {
        setLogCapture(null);
        await close();
        rmrf(root);
    }
});

test("e2e #7537: usage-grade reality on ANOTHER origin no longer vetoes — the payload is forwarded, the upstream decides (#1933 superseded)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-identity-"));
    const { ctx, calls, close } = await setup();
    const logs: string[] = [];
    setLogCapture((_lvl, msg) => { logs.push(msg); });
    try {
        // usage-grade reality exists — but on a FOREIGN origin. The #2847
        // demotion (413 for stale-origin evidence) is SUPERSEDED by #7537: no
        // local estimate-refusal. The payload is forwarded regardless of the
        // evidence's origin — the upstream's own size verdict is authoritative.
        await seedTrusted(ctx, "s-id-stale-origin", { source: "usage", origin: "http://127.0.0.1:1" });
        const before = calls.length;

        // Text-only doomed shape (issue2847: 500 msgs × 4.4K chars ≈ 2.2MB —
        // past BOTH doom bars; NO images, so the #2313 image arbitration
        // cannot intercept).
        const r = await post(ctx, bigMessages());
        const body = await r.text();

        assert.equal(r.status, 200, `stale-origin evidence no longer vetoes — forward (got ${r.status}); body=${body.slice(0, 300)}`);
        assert.match(body, /forwarded answer/, "the payload actually reached the upstream");
        const since = calls.slice(before);
        assert.ok(since.length >= 1, "the payload was forwarded to the upstream");
        assert.ok(logs.some((m) => m.includes("forwarding per #7537")), "log carries the #7537 no-estimate-refusal forward line");
    } finally {
        setLogCapture(null);
        await close();
        rmrf(root);
    }
});

test("e2e #7537: a MODEL change since the last evidence no longer vetoes — the payload is forwarded, the upstream decides (#2117 superseded)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-identity-"));
    const { ctx, calls, close } = await setup();
    const logs: string[] = [];
    setLogCapture((_lvl, msg) => { logs.push(msg); });
    try {
        // Same origin, usage-grade reality ≥ window — but the session last ran
        // on a DIFFERENT model. The #2117 model gate (413 for stale-model
        // evidence) is SUPERSEDED by #7537: no local estimate-refusal. The
        // payload is forwarded regardless of the model — the upstream's own
        // size verdict is authoritative.
        await seedTrusted(ctx, "s-id-stale-model");
        const s = getSession("s-id-stale-model");
        assert.ok(s, "session exists after seed");
        s.stats.lastInputTokensModel = "gpt-other"; // a model the session never billed
        const before = calls.length;

        // Text-only doomed shape (NO images, so the #496/#1800 image
        // arbitration cannot intercept — the model gate is what must judge).
        const r = await post(ctx, bigMessages());
        const body = await r.text();

        assert.equal(r.status, 200, `stale-model evidence no longer vetoes — forward (got ${r.status}); body=${body.slice(0, 300)}`);
        assert.match(body, /forwarded answer/, "the payload actually reached the upstream");
        const since = calls.slice(before);
        assert.ok(since.length >= 1, "the payload was forwarded to the upstream");
        assert.ok(logs.some((m) => m.includes("forwarding per #7537")), "log carries the #7537 no-estimate-refusal forward line");
    } finally {
        setLogCapture(null);
        await close();
        rmrf(root);
    }
});

test("e2e protection chain: anonymous image payload — #2313 forward-once, fast path never opens", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-identity-"));
    const { ctx, calls, close } = await setup();
    const logs: string[] = [];
    setLogCapture((_lvl, msg) => { logs.push(msg); });
    try {
        const before = calls.length;

        // The other half of the operator policy (m00236): no identity → no
        // upstream reality can exist → the protection chain judges. With a
        // doomed-by-estimate IMAGE payload specifically, the pre-existing
        // #496/#1800 image-arbitration hatch answers "forward once, let the
        // upstream arbitrate billing" — the local meter may not veto image
        // mass blindly. The fast path must play NO part: an anonymous
        // session has no identity to fast-path.
        const r = await post(ctx, imagePayload(), null);
        const body = await r.text();

        assert.equal(r.status, 200, `anonymous image payload rides the #496/#1800 arbitration hatch (got ${r.status}); body=${body.slice(0, 300)}`);
        assert.match(body, /forwarded answer/);
        assert.ok(logs.some((m) => m.includes("forwarding for the upstream to arbitrate billing")), "log carries the #496/#1800 forward-once line");
        assert.ok(!logs.some((m) => m.includes("identity fast path")), "no fast-path line for an anonymous session");
        const since = calls.slice(before);
        assert.equal(since.length, 1, `exactly one upstream call (got ${JSON.stringify(since)})`);
        assert.equal(since[0]!.summary, false);
    } finally {
        setLogCapture(null);
        await close();
        rmrf(root);
    }
});
