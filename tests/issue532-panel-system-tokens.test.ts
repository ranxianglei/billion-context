import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createInitialState, defaultConfig, defaultCountTokens, type NudgeDecision } from "acp-kernel";
import { buildStatusPanel } from "acp-kernel/panel";
import { startServer, countSystemAndToolsTokens, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";

// #532: the status panel's "Sent to LLM" / Token Breakdown must include the
// outbound system prompt + tool schema, which the kernel breakdown cannot see
// (it rides outside the fold space on every wire).

function makeNudge(bd: { system: number; tool: number; summaries: number; code: number; text: number }): NudgeDecision {
    const total = bd.system + bd.tool + bd.summaries + bd.code + bd.text;
    return {
        shouldInject: false,
        reason: "below threshold",
        compressibleRanges: [],
        contextUsage: 0.5,
        tier: null,
        breakdown: {
            usage: 0.5, growth: 0, growthReference: 0, effectiveThreshold: 0,
            nudgeGrowthTokens: 0, growthFloor: 0, hasPendingNudge: false,
            overLimit: false, emergencyOverride: false, pendingT1: 0, pendingT2: 0, pendingT3: 0,
        },
        contextBreakdown: { ...bd, total, growth: 0 },
    };
}

// formatCompactTokens rounding is at most ±500 for values below 1e6.
const COMPACT_TOL = 502;

function decodeCompact(s: string): number {
    if (/^\d+$/.test(s)) return Number(s);
    const m = s.match(/^(\d+(?:\.\d+)?)([kM])$/);
    assert.ok(m, `unparseable token value: ${s}`);
    return m![2] === "k" ? Math.round(Number(m![1]) * 1_000) : Math.round(Number(m![1]) * 1_000_000);
}

function parseSentTotal(panel: string): number {
    const m = panel.match(/^Sent to LLM \(after compression, est\.\): ([\d.]+[kM]?)(?: \(\d+% of limit\))?$/m);
    assert.ok(m, `sent line missing:\n${panel}`);
    return decodeCompact(m![1]!);
}

function parseRows(panel: string): Map<string, number> {
    const rows = new Map<string, number>();
    for (const m of panel.matchAll(/^ {2}(\w+)\s+[█░]+\s+\d+%\s{2}([\d.]+[kM]?)\s*$/gm)) {
        rows.set(m[1]!, decodeCompact(m[2]!));
    }
    return rows;
}

test("#532 countSystemAndToolsTokens sums system text and JSON tool schema", () => {
    // No content: only the "[]" serialization counts (1 token) — identical
    // arithmetic to estimateInputTokens' pre-refactor body.
    assert.equal(countSystemAndToolsTokens("", []), 1);
    assert.equal(countSystemAndToolsTokens(undefined, undefined), 1);
    const sys = "a".repeat(4000);
    const sysTok = defaultCountTokens(sys);
    const tools = [{ name: "t1", description: "d".repeat(8000) }];
    const toolTok = defaultCountTokens(JSON.stringify(tools));
    assert.equal(countSystemAndToolsTokens(sys, tools), sysTok + toolTok);
    assert.ok(Math.abs((sysTok + toolTok) - defaultCountTokens(sys + JSON.stringify(tools))) <= 1, "per-part counting stays within ceil noise of a single count");
});

test("#532 panel sentTotal includes systemPromptTokens and stays self-consistent", () => {
    const state = createInitialState();
    const nudge = makeNudge({ system: 0, tool: 3_000, summaries: 1_500, code: 700, text: 900 });
    const SYS = 20_000;

    const withSys = buildStatusPanel({
        tokenCount: 60_000,
        systemPromptTokens: SYS,
        state,
        nudge,
        modelContextLimit: 200_000,
        unprunedTokens: 40_000,
        fmtTokens: (n: number) => String(n),
    });
    assert.equal(parseSentTotal(withSys), 6_100 + SYS);
    const rows = parseRows(withSys);
    assert.equal(rows.get("SysPrompt"), SYS, "SysPrompt row must render");
    assert.equal(rows.get("Tool"), 3_000);
    assert.equal(rows.get("Text"), 900);
    assert.equal(rows.get("Code"), 700);
    assert.equal(rows.get("Summaries"), 1_500);
    const sum = [...rows.values()].reduce((a, b) => a + b, 0);
    assert.equal(sum, parseSentTotal(withSys), "breakdown rows must sum to Sent total");
    assert.match(withSys, /Session-only \(compressed originals, est\.\): 13900 /);

    const zero = buildStatusPanel({
        tokenCount: 60_000,
        systemPromptTokens: 0,
        state,
        nudge,
        modelContextLimit: 200_000,
        fmtTokens: (n: number) => String(n),
    });
    assert.equal(parseSentTotal(zero), 6_100);
    assert.equal(parseRows(zero).get("SysPrompt"), undefined, "zero SysPrompt row must be skipped");
});

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    close(): Promise<void>;
}

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function startHarness(): Promise<Harness> {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            if (req.url?.includes("/v1/chat/completions")) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(`data: {"id":"chatcmpl-532","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n`);
                res.write(`data: {"id":"chatcmpl-532","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[],"usage":{"prompt_tokens":55,"completion_tokens":3,"total_tokens":58}}\n\n`);
                res.write(`data: [DONE]\n\n`);
                res.end();
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(anthropicSse("message_start", { type: "message_start", message: { id: "msg_532", role: "assistant", usage: { input_tokens: 55 } } }));
            res.write(anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            res.write(anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
            res.write(anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }));
            res.write(anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }));
            res.write(anthropicSse("message_stop", { type: "message_stop" }));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 }, "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    return {
        proxyPort,
        upstreamPort,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

async function fetchPanel(h: Harness, conversationId: string): Promise<string> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/status?conversationId=${conversationId}`);
    assert.equal(resp.status, 200);
    const status = (await resp.json()) as { ok: boolean; panel?: string };
    assert.equal(status.ok, true);
    assert.ok(typeof status.panel === "string" && status.panel.length > 0, "panel rendered");
    return status.panel!;
}

test("#532 anthropic plugin session: panel counts outbound system+tools (SysPrompt row)", async () => {
    const h = await startHarness();
    try {
        const conv = "issue532-anthropic";
        const clientSystem = "S".repeat(80_000);
        const tools = [{ name: "big_tool", description: "D".repeat(40_000), input_schema: { type: "object" } }];
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-bili-plugin": "pi-plugin/0.0.1",
                "x-bili-plugin-conversation": conv,
            },
            body: JSON.stringify({
                model: "claude-test",
                max_tokens: 1024,
                stream: true,
                system: clientSystem,
                messages: [{ role: "user", content: "hello" }],
                tools,
            }),
        });
        assert.equal(resp.status, 200);
        for await (const _chunk of resp.body) { /* drain */ }

        const panel = await fetchPanel(h, conv);
        const rows = parseRows(panel);
        const vSys = rows.get("SysPrompt");
        assert.notEqual(vSys, undefined, `SysPrompt row must render:\n${panel}`);
        // Floor = client system + tools schema (what the issue calls the ~20k+10k miss);
        // ceiling adds the injected compress prompt (bounded, a few k tokens max).
        const lower = defaultCountTokens(clientSystem) + defaultCountTokens(JSON.stringify(tools));
        assert.ok(vSys! >= lower - COMPACT_TOL, `SysPrompt ${vSys} below floor ${lower} (client system + tools schema)`);
        assert.ok(vSys! <= lower + COMPACT_TOL + 4_000, `SysPrompt ${vSys} far above floor ${lower} (injected compress prompt should stay small)`);
        const sent = parseSentTotal(panel);
        assert.ok(sent >= lower - COMPACT_TOL && sent >= vSys! - 2 * COMPACT_TOL, `Sent ${sent} must cover system+tools (${lower}) plus message text`);
    } finally {
        await h.close();
    }
});

test("#532 openai plugin session: panel counts injected system+tools (SysPrompt row)", async () => {
    const h = await startHarness();
    try {
        const conv = "issue532-openai";
        const clientSystem = "O".repeat(80_000);
        const tools = [{ type: "function", function: { name: "big_tool", description: "E".repeat(40_000), parameters: { type: "object" } } }];
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-bili-plugin": "pi-plugin/0.0.1",
                "x-bili-plugin-conversation": conv,
            },
            body: JSON.stringify({
                model: "gpt-test",
                max_tokens: 1024,
                stream: true,
                messages: [
                    { role: "system", content: clientSystem },
                    { role: "user", content: "hello" },
                ],
                tools,
            }),
        });
        assert.equal(resp.status, 200);
        for await (const _chunk of resp.body) { /* drain */ }

        const panel = await fetchPanel(h, conv);
        const rows = parseRows(panel);
        const vSys = rows.get("SysPrompt");
        assert.notEqual(vSys, undefined, `SysPrompt row must render:\n${panel}`);
        const lower = defaultCountTokens(clientSystem) + defaultCountTokens(JSON.stringify(tools));
        assert.ok(vSys! >= lower - COMPACT_TOL, `SysPrompt ${vSys} below floor ${lower} (client system + tools schema)`);
        assert.ok(vSys! <= lower + COMPACT_TOL + 4_000, `SysPrompt ${vSys} far above floor ${lower} (injected compress prompt should stay small)`);
        const sent = parseSentTotal(panel);
        assert.ok(sent >= lower - COMPACT_TOL && sent >= vSys! - 2 * COMPACT_TOL, `Sent ${sent} must cover system+tools (${lower}) plus message text`);
    } finally {
        await h.close();
    }
});
