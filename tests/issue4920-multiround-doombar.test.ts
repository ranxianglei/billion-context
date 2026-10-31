// #4920: after one budget-exhaustion preflight round (502 retryable=true,
// "the N ranges folded this turn persist — the next attempt starts from a
// smaller baseline", #3918), the VERY NEXT request died at the probe-regime
// doom bar: the previous round's estimate writeback armed the evidence gate,
// which priced the RAW inbound bytes (not the post-fold payload) and answered
// terminal 413 — so multi-round convergence never ran and the session sat
// permanently over-window (field incident: provider switch → 6M raw resend →
// one 31-round fold pass saved 2.5M tok → next attempt 413 → dead).
// Fix pinned here: an over-bar payload is NOT terminal while the session
// carries active fold state AND compressible ranges remain — the walk
// continues; fresh sessions without fold state keep the immediate 413
// (#2490/#2847 semantics preserved). Plus the visibility half: lost fold
// coverage is recorded on the session for acp_status.
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
import { foldDriftOf, getSession, noteFoldDrift } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WINDOW = 60_000; // large enough that the irreducible core (system+tools+recent tail+carriers) fits after the walk
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment held deterministic load-growth payloads across turns; every marker derives from the turn index, so folding loses nothing.";

type Call = { summary: boolean; contentChars: number };

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

// filler/tag make every call's content UNIQUE per turn: identical sequences would
// hash to the SAME message ids across turns, letting stale fold state cover the
// new payload (content-hash identity) and hiding the exact drift the incident hit.
function bigMessages(count: number, charsPerMsg = 4_400, filler = "f", tag = ""): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    const pad = Math.max(1, charsPerMsg - 12 - tag.length);
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `${tag}turn ${i}: ` + filler.repeat(pad) });
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
                const parsed = JSON.parse(raw) as { messages?: Array<{ content?: unknown }> };
                const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
                calls.push({ summary: isSummary, contentChars: chars });
                if (isSummary) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
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

function proxyOptions(routes: Record<string, object>, overrides?: Partial<ProxyOptions>): ProxyOptions {
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
        ...overrides,
    } as ProxyOptions;
}

type Ctx = { url: string; headers: Record<string, string>; upstreamPort: number };

async function setup(overrides?: Partial<ProxyOptions>): Promise<{ ctx: Ctx; calls: Call[]; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } }, overrides));
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

// Turn 1 seeds the session with a usage-grade baseline on THIS route, so turn 2
// enters the fold-first regime (probe gate off) and real fold state gets created.
async function seedFoldState(ctx: Ctx, sessionId: string): Promise<number> {
    ctx.headers["x-acp-session"] = sessionId;
    const r1 = await post(ctx, [{ role: "user", content: "hello" }]);
    assert.equal(r1.status, 200, "seed turn forwards");
    await r1.text();

    // ~88K estimated tokens against a 20K window: preflight must fold. Either
    // outcome (converged 200 or budget-exhausted 502) leaves ACTIVE BLOCKS —
    // that is the precondition the #4920 recovery path keys on.
    const r2 = await post(ctx, bigMessages(80));
    assert.ok(r2.status === 200 || r2.status === 502, `seed-fold turn settles (got ${r2.status})`);
    await r2.text();

    const s = getSession(sessionId);
    assert.ok(s, "session exists");
    assert.ok(s.state.blocks.some((b) => b.active), "turn 2 left active fold state behind");
    return s.state.blocks.filter((b) => b.active).length;
}

test("e2e #4920: over-bar payload WITH active fold state continues the convergence walk instead of dying at the doom bar", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-4920-a-"));
    const lines: string[] = [];
    setLogCapture((_level, msg) => lines.push(msg));
    try {
        const { ctx, calls, close } = await setup({ log: true, logFile: path.join(root, "bili.log") });
        try {
            await seedFoldState(ctx, "s-4920-a");

            // Mirror the 502-path writeback (server.ts, #1820): after a
            // progress-continues round the meter is ESTIMATE-GRADE, which arms
            // the probe gate on the next request (baselineFloor drops to 0).
            const s = getSession("s-4920-a")!;
            s.stats.lastInputTokens = 19_000;
            s.stats.lastInputTokensSource = "estimate";

            const summariesBefore = calls.filter((c) => c.summary).length;

            // 500 msgs × 4.4K chars ≈ 2.2MB core text — past the absolute 2MB
            // doom bar. Distinct filler/tag: the host re-rendered the history
            // after the provider switch, so the incoming ids no longer join the
            // covered set (that is the incident's drift). Pre-fix this exact
            // request returned terminal 413 and the campaign never ran.
            // The client keeps resending its full raw history (proxy mode: the
            // ephemeral tool calls never enter client state) — recovery is a
            // MULTI-ROUND campaign: each attempt folds its budget's worth, the
            // folds persist, the next attempt starts from a smaller baseline
            // (#3918), until the payload fits. Pre-fix the very FIRST attempt
            // died at the doom bar with zero folds and no next attempt existed.
            const attempts: number[] = [];
            let convergedAt = -1;
            for (let i = 0; i < 6 && convergedAt < 0; i++) {
                const r = await post(ctx, bigMessages(500, 4_400, "x", "b"));
                attempts.push(r.status);
                const body = await r.text();
                if (r.status === 200) {
                    convergedAt = i;
                } else if (r.status === 502) {
                    assert.match(body, /next attempt starts from a smaller baseline/, `attempt ${i}: the #3918 progress promise is intact`);
                } else {
                    assert.fail(`attempt ${i}: unexpected status ${r.status} (${body.slice(0, 200)})`);
                }
            }
            assert.ok(convergedAt >= 0, `campaign converged within 6 attempts (statuses: ${attempts.join(",")})`);
            const summariesAfter = calls.filter((c) => c.summary).length;
            assert.ok(summariesAfter > summariesBefore, `the fold walk actually ran (summaries ${summariesBefore} → ${summariesAfter})`);
            assert.ok(lines.some((l) => l.includes("continuing the multi-round convergence walk")), "the new regime change is logged loudly");
            // The visibility half: the coverage gap that caused all of this is
            // now recorded where acp_status can show it.
            const drift = foldDriftOf(getSession("s-4920-a")!);
            assert.ok(drift && drift.expected > drift.matched, "lost fold coverage is recorded on the session for acp_status");
        } finally {
            await close();
        }
    } finally {
        setLogCapture(null);
        rmrf(root);
    }
});

test("e2e #4920: over-bar payload on a FRESH session (no fold state) still fails fast at the doom bar — #2490/#2847 preserved", async () => {
    const { ctx, calls, close } = await setup();
    try {
        ctx.headers["x-acp-session"] = "s-4920-b";
        const r1 = await post(ctx, [{ role: "user", content: "hello" }]);
        assert.equal(r1.status, 200);
        await r1.text();

        // Stuck-meter seed (mirrors issue2490): estimate-grade baseline from a
        // foreign origin → probe gate armed, no fold state anywhere.
        const s = getSession("s-4920-b")!;
        s.stats.lastInputTokens = 7_300_000;
        s.stats.lastInputTokensSource = "estimate";
        s.stats.lastInputTokensOrigin = "http://127.0.0.1:1";
        assert.ok(!s.state.blocks.some((b) => b.active), "precondition: no fold state");

        const r = await post(ctx, bigMessages(500));
        assert.equal(r.status, 413, "fresh-session doom refusal unchanged");
        const body = await r.text();
        assert.match(body, /NOT forwarded even for evidence/, "same operator-facing remedy wording");
        assert.equal(calls.filter((c) => c.summary).length, 0, "no fold walk runs without fold state");
    } finally {
        await close();
    }
});

test("unit #4920: noteFoldDrift/foldDriftOf round-trip and malformed-shape rejection", () => {
    const bag = { metadata: {} as Record<string, unknown> };
    assert.equal(foldDriftOf(bag), undefined, "nothing recorded yet");

    noteFoldDrift(bag, { expected: 6313, matched: 5674 });
    const d = foldDriftOf(bag)!;
    assert.equal(d.matched, 5674);
    assert.equal(d.expected, 6313);
    assert.match(d.at!, /^\d{4}-\d{2}-\d{2}T/);

    // A clean coverage report (nothing missing) is a no-op — the panel line
    // must not appear for healthy sessions.
    const clean = { metadata: {} as Record<string, unknown> };
    noteFoldDrift(clean, { expected: 100, matched: 100 });
    assert.equal(clean.metadata["lastFoldDrift"], undefined, "no drift recorded when coverage is complete");

    // Stored values survive a persistence round-trip as plain JSON — validate
    // defensively on read, never trust the shape.
    const bad = (v: unknown) => foldDriftOf({ metadata: { lastFoldDrift: v } as Record<string, unknown> });
    assert.equal(bad(undefined), undefined);
    assert.equal(bad(null), undefined);
    assert.equal(bad("drift"), undefined);
    assert.equal(bad({ matched: "5", expected: 10, at: "t" }), undefined);
    assert.equal(bad({ matched: 5, expected: 10 }), undefined);
    assert.equal(bad({ matched: 5, expected: 10, at: "2026-01-01T00:00:00Z" }), undefined, "at must be epoch ms");
    assert.equal(bad({ matched: 10, expected: 5, at: "t" }), undefined, "inverted counts are not drift");
});
