// #3384: the #2490 refused-ledger planning floor was applied UNCONDITIONALLY —
// bili planned every outgoing output budget against the client's raw ledger
// even though its own folds kept the wire small. In the reported session
// (window 1M, DSH profile, default config) the ledger climbed 832K -> 947K
// while the folded wire sat at 8–11%, so the clamp shrank the requested
// budget 128000 -> 5909 over four turns; the model was onlyReasoning /
// canDisableThinking:false, so each clamped budget was eaten entirely by
// thinking -> upstream stopReason=length -> no text, no tool-call, blank GUI
// turns, and DSH (which does not auto-continue on max-tokens) just replayed
// the same dead loop on every "continue". #3384 gated the floor behind two
// grounds (view at the enforced headroom target, or giant request >= 25% of
// the window); #5596 removed the consumption entirely — refused bytes never
// leave bili's door, so they are not a future forwarded input (the sticky
// floor pinned healthy lanes onto the 4096 budget floor; see
// tests/issue5596-refusal-floor-no-planning.test.ts). This file now pins the
// incident shapes post-removal: healthy views keep their full budgets at ANY
// request size, and the measured-input clamp boundaries still hold.
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
    clampOutgoingOutput(rebuilt, "max_tokens", incidentCtx({}), "s-3384-a", clampLog(lines));
    // Under the #2490-era unconditional floor this clamped to 5909 (margin
    // ceil(946753*0.05)=47338, cap floor(1000000-946753-47338)=5909) — the
    // starvation the session died in. Post-#5596 nothing consults the floor.
    assert.equal(rebuilt.max_tokens, 50_670, "budget untouched: refused bytes never plan (#5596)");
    assert.equal(lines.length, 0, "no clamp, no log");
});

test("#3384/#5596: giant-request shapes on a healthy view keep their full budget (the 25% line is gone)", () => {
    const lines: string[] = [];
    // 384K (the #2490 incident's own request size), exactly 25% of the window,
    // and one token under it: under the #3384 gate these took the giant-request
    // ground and planned against the 946753 refused-ledger floor (cap 5909).
    // Post-#5596 the floor is diagnostic-only — measured input 89.7K leaves
    // ~894K headroom, so every size passes untouched. Overflow at giant sizes
    // is owned by preflight / egress fuse (#4079/#4185), not by pre-shrinking
    // the budget from bytes that were never forwarded.
    for (const [req, id] of [[384_000, "b"], [250_000, "c"], [249_999, "d"]] as const) {
        const rebuilt: Record<string, unknown> = { max_tokens: req };
        clampOutgoingOutput(rebuilt, "max_tokens", incidentCtx({}), `s-3384-${id}`, clampLog(lines));
        assert.equal(rebuilt.max_tokens, req, `${req} passes on a healthy view regardless of the refused ledger`);
    }
    assert.equal(lines.length, 0, "no clamp, no log");
});

test("#3384/#5596: view past the enforced target no longer re-engages anything — planning is measured-input only", () => {
    const lines: string[] = [];
    const rebuilt: Record<string, unknown> = { max_tokens: 50_670 };
    // Folded view 110K already past an enforced 100K headroom target: under
    // the #3384 gate this re-engaged the refused-ledger floor (cap 5909).
    // Post-#5596 nothing consults the floor — measured input 110K against a
    // 1M window leaves ample headroom, so the modest budget passes. When
    // bili's own view hits the wall, compression + preflight are the defense.
    clampOutgoingOutput(rebuilt, "max_tokens", incidentCtx({ headroomWindow: 100_000, lastInputTokens: 110_000 }), "s-3384-e", clampLog(lines));
    assert.equal(rebuilt.max_tokens, 50_670, "view-at-wall no longer drives refused-bytes planning (#5596)");
    assert.equal(lines.length, 0);
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
