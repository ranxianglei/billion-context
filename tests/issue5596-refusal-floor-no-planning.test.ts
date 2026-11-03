// #5596: the refused dsh compaction replay SIZE (session.metadata.
// dshCompactionRefusedBytes, recorded by the #1729 guard) drove the outgoing
// output budget via the #2490 planning floor (gated since #3384). But those
// bytes are refused and NEVER forwarded — they are not a future input. The
// sticky high-water + the giant-request ground (any client requesting >= 25%
// of the window, the common default) pinned healthy lanes onto the 4096
// capability floor for the session's life: field incident, window 256000,
// requested 128384, refused replay 866760 bytes (floor 216690) -> cap
// floor(256000 - ceil(216690*1.12) - max(2048, ...)) = 1172 < 4096 -> wire
// max_tokens 4096, model cut off mid-sentence at exactly 4096 output tokens,
// lane stuck there until restart. Fix: the clamp plans against the MEASURED
// input of THIS request only (per-request defenses own overflow: preflight /
// egress fuse #4079/#4185); the record stays as a diagnostic watermark
// (acp_status). This file pins both directions: refused bytes no longer plan
// (the incident shapes pass), AND measured near-wall inputs still clamp
// (the #3071 capability floor still binds from measurement).
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

const ctxOf = (over: Partial<Parameters<typeof clampOutgoingOutput>[2]>) =>
    ({
        systemText: "",
        tools: undefined,
        processedMessages: [{ role: "user", text: "hello" } as never],
        lastInputTokens: 0,
        lastInputTokensSource: "usage",
        nativeWindow: 256_000,
        imageTokens: 0,
        ...over,
    }) as Parameters<typeof clampOutgoingOutput>[2];

const clampLog = (lines: string[]): ((level: string, msg: string) => void) =>
    (level, msg) => { if (level === "info" || level === "warn") lines.push(msg); };

test("#5596: the incident sublane shape — measured input 184K gets an honest 39614, not the 4096 plateau", () => {
    // Window 256000, requested 128384 (50% — above the old giant line),
    // measured input 184K. Pre-fix the 216690 refused-replay floor replaced
    // the estimate (cap 1172) and the wire carried 4096. Post-fix the
    // measured input decides: safe 206080, margin 10304 -> cap 39614.
    const rebuilt: Record<string, unknown> = { max_tokens: 128_384 };
    const lines: string[] = [];
    clampOutgoingOutput(rebuilt, "max_tokens", ctxOf({ lastInputTokens: 184_000 }), "s-5596-a", clampLog(lines));
    assert.equal(rebuilt.max_tokens, 39_614, "honest measured-input cap, far above the 4096 plateau");
    assert.match(lines[0] ?? "", /input~184000/);
});

test("#5596: the incident main-session shape — healthy input keeps the full 128384", () => {
    // Same lane family, measured input 100K. Pre-fix the 164287 floor cut the
    // budget to 62797 on every request; post-fix nothing consults the floor.
    const rebuilt: Record<string, unknown> = { max_tokens: 128_384 };
    clampOutgoingOutput(rebuilt, "max_tokens", ctxOf({ lastInputTokens: 100_000 }), "s-5596-b", clampLog([]));
    assert.equal(rebuilt.max_tokens, 128_384, "measured headroom suffices — full budget rides out");
});

test("#5596 (negative direction): a MEASURED near-wall input still clamps to the 4096 plateau", () => {
    // The removal must not disarm the clamp: measured input 240K against a
    // 256K window leaves cap 4000 < 4096 -> floored up to 4096 by the #3071
    // capability bound (min(4096, raw headroom 16000)). This is the legitimate
    // 4096 — driven by bytes actually on the wire, not by refused replays.
    const rebuilt: Record<string, unknown> = { max_tokens: 128_384 };
    clampOutgoingOutput(rebuilt, "max_tokens", ctxOf({ lastInputTokens: 240_000 }), "s-5596-c", clampLog([]));
    assert.equal(rebuilt.max_tokens, 4_096, "measured overflow risk still bounds the budget");
});

test("#5596 (negative direction): beyond the wall the clamp surrenders to preflight", () => {
    const rebuilt: Record<string, unknown> = { max_tokens: 128_384 };
    clampOutgoingOutput(rebuilt, "max_tokens", ctxOf({ lastInputTokens: 252_000 }), "s-5596-d", clampLog([]));
    assert.equal(rebuilt.max_tokens, 128_384, "cap < 1024 -> no clamp (preflight / egress fuse own that regime)");
});

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

test("e2e #5596: a refused compaction envelope records the watermark but does not touch the next turn's budget", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-5596-"));
    const cfgFile = path.join(root, "billion-context.json");
    writeFileSync(cfgFile, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = cfgFile;
    const { ctx, calls, close } = await setup();
    try {
        ctx.headers["x-acp-session"] = "s-5596-e2e";
        const postRaw = (body: string) => fetch(ctx.url, { method: "POST", headers: { ...ctx.headers }, body });

        // Turn 1: seed the session with a small exchange.
        let r = await postRaw(JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }] }));
        assert.equal(r.status, 200, "seed turn accepted");
        await r.text();

        // The dsh compaction envelope (~320KB of core text -> ledger floor
        // ~80K tokens, ABOVE the old 25% giant line of a 100K window): the
        // guard refuses it (default posture) and records the high-water byte
        // count. Pre-#5596 the giant-request ground would have applied this
        // floor to the next turn's planning (cap ~5874 for a 30K request).
        const envelope = JSON.stringify({
            model: "gpt-test",
            stream: true,
            messages: [
                { role: "system", content: "sys" },
                { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} ${"x".repeat(320_000)}` },
            ],
        });
        r = await postRaw(envelope);
        assert.equal(r.status, 422, "guard refuses the compaction call (default)");
        await r.text();
        const s = getSession("s-5596-e2e");
        assert.ok(s, "session exists");
        assert.equal(s.metadata.dshCompactionRefused, true, "refusal flag set");
        assert.equal(s.metadata.dshCompactionRefusedBytes, Buffer.byteLength(envelope), "high-water bytes recorded");
        const floor = Math.ceil(Buffer.byteLength(envelope) / 4);
        assert.ok(floor > E2E_WINDOW * 0.25 && floor < E2E_WINDOW, `floor ${floor} sits in the discriminating band (25%, window)`);

        // Turn 2: a normal short turn with a budget ABOVE the old giant line
        // (30K > 25K). Post-fix the measured input (~a few hundred tokens)
        // decides: the full 30K rides out untouched by the recorded watermark.
        r = await postRaw(JSON.stringify({
            model: "gpt-test",
            stream: true,
            max_tokens: 30_000,
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
        assert.equal(forwarded.maxTokens, 30_000, "#5596: the refused watermark did not starve the budget");
    } finally {
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevConfig;
        await close();
        rmrf(root);
    }
});
