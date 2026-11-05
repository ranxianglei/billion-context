// #3384: the #2490 refused-ledger planning floor was applied UNCONDITIONALLY —
// bili planned every outgoing output budget against the client's raw ledger
// even though its own folds kept the wire small. In the reported session
// (window 1M, DSH profile, default config) the ledger climbed 832K -> 947K
// while the folded wire sat at 8–11%, so the clamp shrank the requested
// budget 128000 -> 5909 over four turns; the model was onlyReasoning /
// canDisableThinking:false, so each clamped budget was eaten entirely by
// thinking -> upstream stopReason=length -> no text, no tool-call, blank GUI
// turns, and DSH (which does not auto-continue on max-tokens) just replayed
// the same dead loop on every "continue". Fix: the floor now engages only on
// one of two independent grounds — the folded view already sits at the
// enforced headroom target, or the requested budget is giant (>= 25% of the
// native window, the #2490 monster-request line). Both protection regimes
// stay pinned here AND in tests/issue2490-ledger-floor-doomed-probe.test.ts
// (giant request) — this file pins the starvation side they left open.
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
import { clampOutgoingOutput } from "../src/server/budget.ts";
import { DSH_COMPACTION_INSTRUCTION_PREFIX } from "../src/server/dsh-compaction-guard.ts";
import { rmrf } from "./tmp-rm.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WINDOW = 1_000_000; // the reported deployment's declared window
const FLOOR = 946_753;    // the incident's final planning floor (refused replay bytes / 4)

type CtxArgs = Parameters<typeof clampOutgoingOutput>[2];

// Mirrors the incident log line "output budget clamped 50670 -> 5909
// (input~89699.41..., planning floor 946753 ..., window=1000000)": folded
// wire ~89.7K (9% of the window), ledger floor 946.7K, modest request.
const incidentCtx = (over: Partial<CtxArgs>): CtxArgs => ({
    systemText: "",
    tools: undefined,
    processedMessages: [{ role: "user", text: "hello" } as never],
    lastInputTokens: 89_699,
    lastInputTokensSource: "usage",
    nativeWindow: WINDOW,
    headroomWindow: WINDOW, // real dsh deployments run headroom ~= declared window
    imageTokens: 0,
    ...over,
}) as CtxArgs;

const clampLog = (lines: string[]): ((level: string, msg: string) => void) =>
    (level, msg) => { if (level === "info" || level === "warn") lines.push(msg); };

test("#3384: the incident shape keeps its full budget — modest request, healthy folded view, huge refused ledger", () => {
    const lines: string[] = [];
    const rebuilt: Record<string, unknown> = { max_tokens: 50_670 };
    clampOutgoingOutput(rebuilt, "max_tokens", incidentCtx({ ledgerFloorTokens: FLOOR }), "s-3384-a", clampLog(lines));
    // Pre-fix this clamped to 5909 (margin ceil(946753*0.05)=47338, cap
    // floor(1000000-946753-47338)=5909) — the starvation the session died in.
    assert.equal(rebuilt.max_tokens, 50_670, "budget untouched below both gate lines");
    assert.equal(lines.length, 0, "no clamp, no log");
});

test("#3384: the giant-request ground still plans against the ledger (#2490 regime preserved)", () => {
    const lines: string[] = [];
    const rebuilt: Record<string, unknown> = { max_tokens: 384_000 };
    // 384K >= 0.25 * 1M — the #2490 incident's own request size.
    clampOutgoingOutput(rebuilt, "max_tokens", incidentCtx({ ledgerFloorTokens: FLOOR }), "s-3384-b", clampLog(lines));
    assert.equal(rebuilt.max_tokens, 5_909, "planned against the refused ledger: cap floor(1M-946753-47338)=5909, above the 4096 capability floor");
    assert.match(lines[0] ?? "", /planning floor 946753 from the refused dsh compaction replay \(#2490\)/);
});

test("#3384: the boundary is inclusive — exactly 25% of the window takes the giant ground", () => {
    const lines: string[] = [];
    const rebuilt: Record<string, unknown> = { max_tokens: 250_000 };
    clampOutgoingOutput(rebuilt, "max_tokens", incidentCtx({ ledgerFloorTokens: FLOOR }), "s-3384-c", clampLog(lines));
    assert.equal(rebuilt.max_tokens, 5_909, "raw == 0.25*window engages the floor (fail-closed side of the line)");
    assert.ok(lines.length >= 1, "the clamp is logged");
});

test("#3384: one token under the giant line stays unclamped while the view is healthy", () => {
    const lines: string[] = [];
    const rebuilt: Record<string, unknown> = { max_tokens: 249_999 };
    clampOutgoingOutput(rebuilt, "max_tokens", incidentCtx({ ledgerFloorTokens: FLOOR }), "s-3384-d", clampLog(lines));
    assert.equal(rebuilt.max_tokens, 249_999, "below the line the ledger must not drive planning");
    assert.equal(lines.length, 0);
});

test("#3384: the view-at-enforced-target ground engages when bili's OWN view reaches the wall", () => {
    const lines: string[] = [];
    const rebuilt: Record<string, unknown> = { max_tokens: 50_670 };
    // Folded view 110K already past an enforced 100K headroom target — the
    // session really is at the wall, so worst-case-ledger planning applies
    // even for a modest request.
    clampOutgoingOutput(rebuilt, "max_tokens", incidentCtx({ headroomWindow: 100_000, lastInputTokens: 110_000, ledgerFloorTokens: FLOOR }), "s-3384-e", clampLog(lines));
    assert.equal(rebuilt.max_tokens, 5_909, "view at the enforced target re-engages the floor");
    assert.match(lines[0] ?? "", /planning floor 946753/);
});

test("#3384: legacy paths stay byte-identical — no refusal recorded, or floor below the folded view", () => {
    const legacy: Record<string, unknown> = { max_tokens: 50_670 };
    clampOutgoingOutput(legacy, "max_tokens", incidentCtx({}), "s-3384-f", clampLog([]));
    assert.equal(legacy.max_tokens, 50_670, "no floor recorded -> unchanged legacy behavior");

    const small: Record<string, unknown> = { max_tokens: 50_670 };
    clampOutgoingOutput(small, "max_tokens", incidentCtx({ ledgerFloorTokens: 10_000 }), "s-3384-g", clampLog([]));
    assert.equal(small.max_tokens, 50_670, "a floor smaller than the folded view changes nothing");
});

// ---------------------------------------------------------------------------
// e2e: refuse a compaction envelope (records the ledger high-water), then a
// normal turn with a modest budget must go out UNCLAMPED. Pre-fix the second
// turn's max_tokens came back ~8056 instead of 20000 (floor ~87.5K against a
// 100K window), which is exactly how the reported session starved.
// ---------------------------------------------------------------------------

const E2E_WINDOW = 100_000;

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

type Call = { maxTokens: number | null; contentChars: number };

function makeUpstream(): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            try {
                const parsed = JSON.parse(raw) as { messages?: Array<{ content?: unknown }>; max_tokens?: number };
                const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
                calls.push({ maxTokens: typeof parsed.max_tokens === "number" ? parsed.max_tokens : null, contentChars: chars });
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
        modelContextLimit: E2E_WINDOW,
        kernelConfig: defaultConfig(E2E_WINDOW, { preserveRecentMessages: 2, preserveRecentTokens: 2000 }),
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

type Ctx = { url: string; headers: Record<string, string> };

async function setup(): Promise<{ ctx: Ctx; calls: Call[]; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: E2E_WINDOW } } } }));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": "" },
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

test("e2e #3384: after a refused compaction envelope, a modest-budget turn goes out unclamped", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3384-"));
    const cfgFile = path.join(root, "billion-context.json");
    writeFileSync(cfgFile, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = cfgFile;
    const { ctx, calls, close } = await setup();
    try {
        ctx.headers["x-acp-session"] = "s-3384-e2e";
        const postRaw = (body: string) => fetch(ctx.url, { method: "POST", headers: { ...ctx.headers }, body });

        // Turn 1: seed the session with a small exchange.
        let r = await postRaw(JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }] }));
        assert.equal(r.status, 200, "seed turn accepted");
        await r.text();

        // The dsh compaction envelope (~350KB of core text -> ledger floor
        // ~87.5K tokens): the guard refuses it (default posture) and records
        // the high-water byte count. The size is chosen so the pre-fix cap
        // floor(100000 - 87.5K - ceil(87.5K*0.05)) = ~8056 sits BELOW the 20K
        // request — this assertion only discriminates in that band.
        const envelope = JSON.stringify({
            model: "gpt-test",
            stream: true,
            messages: [
                { role: "system", content: "sys" },
                { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} ${"x".repeat(350_000)}` },
            ],
        });
        r = await postRaw(envelope);
        assert.equal(r.status, 422, "guard refuses the compaction call (default)");
        await r.text();
        const s = getSession("s-3384-e2e");
        assert.ok(s, "session exists");
        assert.equal(s.metadata.dshCompactionRefused, true, "refusal flag set");
        const floor = Math.ceil(Buffer.byteLength(envelope) / 4);
        assert.equal(s.metadata.dshCompactionRefusedBytes, Buffer.byteLength(envelope), "high-water bytes recorded");
        assert.ok(floor > E2E_WINDOW * 0.25 && floor < E2E_WINDOW, `floor ${floor} sits in the discriminating band (25%, window) of a ${E2E_WINDOW} window`);

        // Turn 2: a normal short turn with a MODERATE budget (20K < 25K = the
        // giant line). Pre-fix the planning basis became the ~87.5K floor and
        // this went out clamped to ~8056 — the reported session's death spiral
        // in miniature. Post-fix the wire is what it is (~a few hundred
        // tokens), so the full 20K rides out.
        r = await postRaw(JSON.stringify({
            model: "gpt-test",
            stream: true,
            max_tokens: 20_000,
            messages: [
                { role: "user", content: "hello" },
                { role: "assistant", content: "forwarded answer" },
                { role: "user", content: "and now?" },
            ],
        }));
        assert.equal(r.status, 200, "normal turn accepted");
        await r.text();

        const forwarded = calls[calls.length - 1];
        assert.ok(forwarded, "the normal turn reached the upstream");
        assert.equal(forwarded.maxTokens, 20_000, "#3384: the refused-ledger floor did not starve a modest budget on a healthy wire");
    } finally {
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevConfig;
        await close();
        rmrf(root);
    }
});
