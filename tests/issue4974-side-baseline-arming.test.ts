// #4974: one ~10KB auxiliary request pinned the whole session baseline to
// 5412 — the nudge reported 1% while preflight 413'd on 9.24MB of core text
// (livelock). The incident's request rode the FULL pipeline (it was not
// side-classified), so three gates are pinned here, each covering a leg of
// the chain:
//   (A) armFailureShrink had no sidePassthrough gate: a FAILED side-lane
//       request armed the MAIN session's meter with the side payload's size,
//       breaking the #388 lane contract. Pinned in
//       tests/side-lane-invariants.test.ts (L) — the gate consumes the lane
//       decision, so the #2170 pairing rule puts it in the dedicated
//       side-lane suite (main-request failures must still arm there too,
//       negative direction #3617).
//   (B) prepare-anthropic wrote localInputEstimate/lastLocalTextEstimate
//       with no title-gen gate (openai/responses lanes already gate): a
//       max_tokens<=200 full-pipeline request left its tiny measurement
//       behind whenever the forward never ran (preflight fail-fast),
//       poisoning the next turn's min(est, raw) nudge view. Pinned through
//       the fail-fast window, where the relay main-lane stamp cannot
//       overwrite the prepare-time write.
//   (C) preflight's #2313 probe branch trusted ANY estimate-grade baseline:
//       a stale-small one (payload >= 8x the baseline — the incident's exact
//       shape: 5412-tok arm vs a 9.24MB payload) sent a foldable session
//       into the doomed byte-gate 413 instead of the fold-first path. This
//       guard is what breaks the reported livelock. A comparable payload
//       must keep the forward-once probe (negative direction, #3617).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest, getSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { setLogCapture } from "../src/logger.ts";

const testRoot = mkdtempSync(join(tmpdir(), "bili-4974-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

type Msg = { role: string; content: string };

function freshRunDir(): string {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60_000 });
    _setStoreForTest(store);
    setRegistryForTest({});
    return dir;
}

async function mockUpstream(): Promise<{ url: string; close: () => void }> {
    return await new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                if (/TASK: The conversation segment below/.test(raw)) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: "msg_sum", role: "assistant", content: [{ type: "text", text: "PREFLIGHT SUMMARY: segment folded." }] }));
                    return;
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10_000, output_tokens: 10 } }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({
            url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
            close: () => server.close(),
        }));
    });
}

function baseOptions(upstreamUrl: string, contextWindow: number, logFile: string, model = "claude-test"): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: upstreamUrl,
        routes: { [upstreamUrl]: { models: { [model]: { context: contextWindow } } } },
        modelContextLimit: contextWindow,
        kernelConfig: defaultConfig(contextWindow, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        logFile,
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
        mitm: { enabled: false, domains: [] },
    };
}

async function startWith(options: ProxyOptions): Promise<{ origin: string; close: () => Promise<void> }> {
    const proxy = await startServer(options);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    return {
        origin,
        close: async () => {
            proxy.close();
            (proxy as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();
            await once(proxy, "close");
        },
    };
}

// ---------------------------------------------------------------------------
// (B) the prepare-time meter gate, proxy-mode anthropic wire

test("(B) a title-gen-shaped request must not leave its measurement behind (#4974)", async () => {
    const dir = freshRunDir();
    const upstream = await mockUpstream();
    let running: Awaited<ReturnType<typeof startWith>> | null = null;
    try {
        running = await startWith(baseOptions(upstream.url, 40_000, join(dir, "bili.log")));
        const url = `${running.origin}/bili/${upstream.url}/v1/messages`;
        // A host-declared MAIN agent (x-bili-plugin-agent: main) vetoes the side
        // lane even at <=200 budget, and without tools the #3438 output-budget
        // restore leaves max_tokens untouched — so prepareAnthropic genuinely
        // sees the title-gen shape. One over-window message makes preflight
        // fail-fast BEFORE any forward, so the relay main-lane stamp cannot
        // overwrite whatever the prepare-time write did (or didn't do).
        const send = async (conv: string, maxTokens: number): Promise<number> => {
            const r = await fetch(url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-acp-session": conv,
                    "x-bili-plugin": "dsh",
                    "x-bili-plugin-conversation": conv,
                    "x-bili-plugin-agent": "main",
                },
                body: JSON.stringify({ model: "claude-test", max_tokens: maxTokens, system: "MAIN OPERATING SYSTEM", messages: [{ role: "user", content: "x".repeat(300_000) }] }),
            });
            await r.text();
            return r.status;
        };
        // (B+) title-gen budget: the meter writes must be skipped
        const s1 = await send("titlegen", 100);
        assert.ok(s1 === 413 || s1 === 502, `the over-window request fail-fasts locally (${s1})`);
        const t1 = getSession("titlegen")!;
        assert.ok((t1.stats.localInputEstimate ?? 0) === 0, `a title-gen-shaped request must not write localInputEstimate (${t1.stats.localInputEstimate})`);
        assert.equal(t1.stats.lastLocalTextEstimate, undefined, "a title-gen-shaped request must not write lastLocalTextEstimate");
        // (B-) normal budget, same payload: the writes happen (the gate
        // discriminates on the budget shape, not the size)
        const s2 = await send("normalgen", 256);
        assert.ok(s2 === 413 || s2 === 502, `the over-window request fail-fasts locally (${s2})`);
        const t2 = getSession("normalgen")!;
        assert.ok((t2.stats.localInputEstimate ?? 0) > 0, "a normal-budget request must still measure the conversation");
        assert.ok((t2.stats.lastLocalTextEstimate ?? 0) > 0, "a normal-budget request must still note the billed-caliber twin");
    } finally {
        await running?.close();
        upstream.close();
    }
});

// ---------------------------------------------------------------------------
// (C) the probe-branch stale-small guard, OpenAI chat wire (SSE mock, #2490 pattern)

const WINDOW = 40_000;
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment held deterministic load-growth payloads across turns; every marker derives from the turn index, so folding loses nothing.";

type Call = { summary: boolean; contentChars: number };

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

function bigMessages(count: number, charsPerMsg: number): Msg[] {
    const messages: Msg[] = [];
    const pad = Math.max(1, charsPerMsg - 12);
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}: ` + "f".repeat(pad) });
    }
    return messages;
}

type Ctx = { url: string; headers: Record<string, string>; sessionId: string };

async function openaiHarness(sessionId: string, overrides?: Partial<ProxyOptions>): Promise<{ ctx: Ctx; calls: Call[]; setForceStatus: (n: number | null) => void; close: () => Promise<void> }> {
    const dir = freshRunDir();
    const calls: Call[] = [];
    let forced: number | null = null;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            try {
                const parsed = JSON.parse(raw) as { messages?: Array<{ content?: unknown }> };
                const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
                calls.push({ summary: isSummary, contentChars: chars });
                if (forced !== null) {
                    res.writeHead(forced, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { message: "forced failure" } }));
                    return;
                }
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
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const options = baseOptions(`http://127.0.0.1:${upstreamPort}`, WINDOW, join(dir, "bili.log"), "gpt-test");
    const proxy = await startServer({ ...options, upstream: "http://127.0.0.1", ...overrides });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": sessionId },
            sessionId,
        },
        calls,
        setForceStatus: (n: number | null) => { forced = n; },
        close: async () => {
            proxy.close();
            (proxy as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();
            upstream.close();
            upstream.closeAllConnections?.();
            await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
        },
    };
}

const post = (ctx: Ctx, messages: Msg[]) =>
    fetch(ctx.url, { method: "POST", headers: { ...ctx.headers }, body: JSON.stringify({ model: "gpt-test", stream: true, messages }) });

// Arms an estimate-grade baseline B the way the incident did: one failed turn
// whose outbound was measured but never confirmed by usage.
async function armBaseline(ctx: Ctx, setForceStatus: (n: number | null) => void): Promise<number> {
    setForceStatus(500);
    const r = await post(ctx, bigMessages(20, 5_000));
    assert.equal(r.status, 500, "the arming turn fails upstream");
    await r.text();
    setForceStatus(null);
    const s = getSession(ctx.sessionId);
    assert.ok(s, "session exists after the armed turn");
    const b = s!.stats.lastInputTokens;
    assert.ok(b > 0 && s!.stats.lastInputTokensSource === "estimate", `armed with an estimate-grade baseline (~${b})`);
    return b;
}

test("(C) stale-small estimate baseline takes the fold-first path, not the doomed probe 413 (#4974)", async () => {
    const lines: string[] = [];
    setLogCapture((_l, msg) => lines.push(msg));
    try {
        const { ctx, calls, setForceStatus, close } = await openaiHarness("s-c1");
        try {
            const b = await armBaseline(ctx, setForceStatus);
            // Stale-small: core text ~8x+ the baseline AND past the 2MB doomed bar,
            // so the pre-fix code died in the probe byte-gate with the refusal pinned.
            const huge = bigMessages(100, 22_000);
            assert.ok(huge.length * 22_000 >= 8 * b, "sanity: the payload towers over the baseline");
            const r = await post(ctx, huge);
            assert.notEqual(r.status, 413, "a foldable session with a stale-small baseline must not hit the doomed probe gate");
            assert.equal(r.status, 200, "preflight folded the payload under the window and forwarded");
            await r.text();
            assert.ok(calls.some((c) => c.summary), "folding spent summarization calls (the fold-first path ran)");
            assert.ok(lines.some((l) => l.includes("preflight compressing before forward")), "the fold-first path logged its intent");
            assert.ok(!lines.some((l) => l.includes("preflight fail-fast 413")), "no doomed-gate 413 was emitted");
            const finalCall = calls.at(-1)!;
            assert.ok(!finalCall.summary && finalCall.contentChars < WINDOW * 4, `the forwarded payload shrank under the window (${finalCall.contentChars} chars)`);
        } finally {
            await close();
        }
    } finally {
        setLogCapture(null);
    }
});

test("(C-) comparable payload keeps the #2313 forward-once probe (no over-suppression)", async () => {
    const lines: string[] = [];
    setLogCapture((_l, msg) => lines.push(msg));
    try {
        const { ctx, calls, setForceStatus, close } = await openaiHarness("s-c2");
        try {
            const b = await armBaseline(ctx, setForceStatus);
            // Below the 8x stale-small bar yet over the trigger line: the probe bet
            // stays alive exactly where #2313 needs it.
            const targetChars = Math.floor(b * 8 * 0.9);
            const msgs = bigMessages(Math.ceil(targetChars / 5_000), 5_000);
            const before = calls.length;
            const r = await post(ctx, msgs);
            assert.equal(r.status, 200);
            await r.text();
            assert.ok(lines.some((l) => l.includes("forwarding once to acquire usage/overflow evidence")), "the estimate-only forward-once still fires for plausible payloads");
            assert.ok(calls.length > before && !calls.at(-1)!.summary, "the payload was forwarded, not folded first");
        } finally {
            await close();
        }
    } finally {
        setLogCapture(null);
    }
});
