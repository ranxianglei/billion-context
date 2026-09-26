import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, createInitialState, defaultConfig, defaultCountTokens, type CoreMessage } from "acp-kernel";
import { anthropicToCore, coreToAnthropic, type AnthropicRequestBody, type BiliMessage } from "acp-kernel/wire";
import { startServer, countSystemAndToolsTokens, projectThinkingMass, type ProxyOptions } from "../src/server.ts";
import { estimateCoreMessages } from "../src/preflight.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";

// #1320: Claude Code sends extended-thinking blocks as SIGNATURE-ONLY entries
// ({type:"thinking", signature}, no visible text). The provider restores and
// bills the hidden thinking tokens, so its usage.input_tokens is correct while
// every local per-message estimate sees empty text — savings receipts miss the
// thinking share and the growth nudge stays idle because compressible mass
// never crosses the 50K threshold. Fix: attribute the provider-vs-local
// residual to the signed blocks via CoreMessage.thinkingTokens (kernel seam).

// ---- unit: projection arithmetic -------------------------------------------

let seq = 0;
function sigOnly(sigLen: number): BiliMessage {
    seq++;
    return { id: `sig-${seq}`, role: "assistant", contentType: "reasoning", thinkingSignature: "s".repeat(sigLen) };
}
function visibleThinking(textLen: number): BiliMessage {
    seq++;
    return { id: `vis-${seq}`, role: "assistant", contentType: "reasoning", text: "t".repeat(textLen), thinkingSignature: "s".repeat(500) };
}
function textMsg(textLen: number): BiliMessage {
    seq++;
    return { id: `txt-${seq}`, role: "user", contentType: "text", text: "x".repeat(textLen) };
}

test("#1320 projectThinkingMass: no-op without signature-only blocks", () => {
    const msgs = [textMsg(1000), visibleThinking(2000)];
    const got = projectThinkingMass(msgs, { providerInputTokens: 999_999, measured: true, systemText: "", tools: [], imageTokens: 0 });
    assert.equal(got, 0);
    for (const m of msgs) assert.equal(m.thinkingTokens, undefined, "nothing projected");
});

test("#1320 projectThinkingMass: no-op without a measured provider total", () => {
    const a = [sigOnly(1000)];
    assert.equal(projectThinkingMass(a, { providerInputTokens: 0, measured: true, systemText: "", tools: [], imageTokens: 0 }), 0);
    const b = [sigOnly(1000)];
    assert.equal(projectThinkingMass(b, { providerInputTokens: 50_000, measured: false, systemText: "", tools: [], imageTokens: 0 }), 0);
    for (const m of [...a, ...b]) assert.equal(m.thinkingTokens, undefined);
});

test("#1320 projectThinkingMass: attributes exactly the residual, weighted by signature length", () => {
    const msgs = [textMsg(4000), sigOnly(3000), sigOnly(1000)];
    const GAP = 60_000;
    const visible = estimateCoreMessages(msgs);
    const overhead = countSystemAndToolsTokens("", []);
    const got = projectThinkingMass(msgs, { providerInputTokens: visible + overhead + GAP, measured: true, systemText: "", tools: [], imageTokens: 0 });
    assert.equal(got, GAP, "total projected equals the unexplained residual");
    const a = msgs[1]!, b = msgs[2]!;
    assert.equal(a.thinkingTokens, Math.floor((GAP * 3000) / 4000), "share proportional to signature length");
    assert.equal(b.thinkingTokens, GAP - a.thinkingTokens!, "remainder goes to the last target");
    assert.equal(a.thinkingTokens! + b.thinkingTokens!, GAP, "shares sum exactly to the gap");
    assert.equal(msgs[0]!.thinkingTokens, undefined, "non-reasoning untouched");
});

test("#1320 projectThinkingMass: clamps at zero when the local estimate already covers the total", () => {
    const msgs = [textMsg(4000), sigOnly(1000)];
    const visible = estimateCoreMessages(msgs);
    const overhead = countSystemAndToolsTokens("", []);
    const got = projectThinkingMass(msgs, { providerInputTokens: visible + overhead - 100, measured: true, systemText: "", tools: [], imageTokens: 0 });
    assert.equal(got, 0);
    assert.equal(msgs[1]!.thinkingTokens, undefined);
});

test("#1320 projectThinkingMass: visible-text reasoning is excluded from attribution but counted in the visible mass", () => {
    const msgs = [visibleThinking(8000), sigOnly(1000)];
    const GAP = 40_000;
    const visible = estimateCoreMessages(msgs);
    const overhead = countSystemAndToolsTokens("", []);
    const got = projectThinkingMass(msgs, { providerInputTokens: visible + overhead + GAP, measured: true, systemText: "", tools: [], imageTokens: 0 });
    assert.equal(got, GAP);
    assert.equal(msgs[0]!.thinkingTokens, undefined, "visible thinking already counted — no double charge");
    assert.equal(msgs[1]!.thinkingTokens, GAP, "full gap rides on the signature-only block");
});

test("#1320 projectThinkingMass: prefers the stored previous-turn outbound overhead", () => {
    const msgs = [sigOnly(1000)];
    const visible = estimateCoreMessages(msgs);
    const recounted = countSystemAndToolsTokens("y".repeat(8000), [{ name: "t", description: "d".repeat(8000) }]);
    const stored = 500;
    const got = projectThinkingMass(msgs, { providerInputTokens: visible + stored + 20_000, measured: true, systemText: "y".repeat(8000), tools: [{ name: "t", description: "d".repeat(8000) }], imageTokens: 0, storedOverhead: stored });
    assert.equal(got, 20_000, "gap computed against the stored overhead, not the inbound recount");
    assert.ok(recounted > stored, "precondition: the two overheads really differ");
});

test("#1320 projectThinkingMass: image tokens shrink the attributed gap", () => {
    const msgs = [sigOnly(1000)];
    const visible = estimateCoreMessages(msgs);
    const overhead = countSystemAndToolsTokens("", []);
    const got = projectThinkingMass(msgs, { providerInputTokens: visible + overhead + 30_000, measured: true, systemText: "", tools: [], imageTokens: 10_000 });
    assert.equal(got, 20_000);
});

// ---- kernel integration: the bug repro -------------------------------------

function buildClaudeCodeBody(rounds: number): AnthropicRequestBody {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "start the task" }];
    for (let i = 0; i < rounds; i++) {
        messages.push({
            role: "assistant",
            content: [
                { type: "thinking", signature: `sig_${i}_${"x".repeat(2000)}` },
                { type: "tool_use", id: `tu_${i}`, name: "bash", input: { command: `ls -la ${i}` } },
            ],
        });
        messages.push({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: `dir listing ${i}: ${"file.txt ".repeat(40)}` }],
        });
    }
    return { model: "claude-test", max_tokens: 1024, system: "S".repeat(4000), messages: messages as never };
}

test("#1320 conversion premise: signature-only blocks become empty-text reasoning cores carrying the signature", () => {
    const { msgs } = anthropicToCore(buildClaudeCodeBody(3));
    const reasoning = msgs.filter((m) => m.contentType === "reasoning");
    assert.equal(reasoning.length, 3);
    for (const m of reasoning) {
        assert.ok(!(typeof m.text === "string" && m.text.trim().length > 0), "no visible thinking text locally");
        assert.ok(typeof m.thinkingSignature === "string" && m.thinkingSignature.length > 0, "signature sidecar present");
    }
});

test("#1320 repro: without projection the compressible mass misses the 50K nudge threshold; with it, the nudge arms", () => {
    const THINKING = 60_000;
    const body = buildClaudeCodeBody(20);
    const systemText = "S".repeat(4000);
    const tools: unknown[] = [{ name: "bash", description: "run a shell command", input_schema: { type: "object" } }];
    const { msgs: msgsA } = anthropicToCore(body);
    const { msgs: msgsB } = anthropicToCore(body);
    const overhead = countSystemAndToolsTokens(systemText, tools);
    const providerTotal = estimateCoreMessages(msgsA) + overhead + THINKING;

    const config = { ...defaultConfig(400_000), preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const core = createCore();

    const turn1A = core.processTurn({ messages: msgsA, state: createInitialState(), config, tokenCount: providerTotal, renderTags: "text-only" });
    const proj = projectThinkingMass(msgsB, { providerInputTokens: providerTotal, measured: true, systemText, tools, imageTokens: 0 });
    assert.equal(proj, THINKING, "full thinking share attributed");
    const turn1B = core.processTurn({ messages: msgsB, state: createInitialState(), config, tokenCount: providerTotal, renderTags: "text-only" });

    const rangeSum = (t: typeof turn1A): number => t.nudge?.compressibleRanges.reduce((s, r) => s + r.tokens, 0) ?? 0;
    const sumA = rangeSum(turn1A);
    const sumB = rangeSum(turn1B);
    assert.ok(sumA < 50_000, `unprojected compressible mass ${sumA} sits below the 50K threshold (the reported symptom)`);
    assert.ok(sumB >= 50_000, `projected compressible mass ${sumB} clears the threshold`);
    assert.ok(sumB - sumA >= THINKING - 1_000, "the difference is the projected thinking share");

    // Second turn establishes the growth reference; growth (provider-measured)
    // clears the interval in BOTH runs — only the compressible mass differs.
    const body2 = buildClaudeCodeBody(21);
    const { msgs: msgsA2 } = anthropicToCore(body2);
    const { msgs: msgsB2 } = anthropicToCore(body2);
    const growth = 61_000;
    const turn2A = core.processTurn({ messages: msgsA2, state: turn1A.state, config, tokenCount: providerTotal + growth, renderTags: "text-only" });
    projectThinkingMass(msgsB2, { providerInputTokens: providerTotal + growth, measured: true, systemText, tools, imageTokens: 0 });
    const turn2B = core.processTurn({ messages: msgsB2, state: turn1B.state, config, tokenCount: providerTotal + growth, renderTags: "text-only" });

    assert.equal(turn2A.nudge?.shouldInject ?? false, false, "unprojected: nudge stays idle despite 61K growth");
    assert.match(turn2A.nudge?.reason ?? "", /compressible/i, `idle reason names the missing mass: "${turn2A.nudge?.reason}"`);
    assert.equal(turn2B.nudge?.shouldInject ?? false, true, "projected: the same growth now arms the tier-1 nudge");
});

test("#1320 wire fidelity: projection never changes the rebuilt Anthropic body", () => {
    const body = buildClaudeCodeBody(4);
    const { msgs: before, cacheControls } = anthropicToCore(body);
    const { msgs: after } = anthropicToCore(body);
    const visible = estimateCoreMessages(after);
    const overhead = countSystemAndToolsTokens("S".repeat(4000), []);
    assert.ok(projectThinkingMass(after, { providerInputTokens: visible + overhead + 50_000, measured: true, systemText: "S".repeat(4000), tools: [], imageTokens: 0 }) > 0);
    const rebuiltBefore = coreToAnthropic(before as CoreMessage[], cacheControls);
    assert.deepEqual(coreToAnthropic(after as CoreMessage[], cacheControls), rebuiltBefore, "metering-only: outbound bytes identical");
    const firstAssistant = (rebuiltBefore as Array<{ role: string; content: Array<{ type: string; signature?: string }> }>).find((m) => m.role === "assistant")!;
    assert.equal(firstAssistant.content[0]?.type, "thinking");
    assert.ok(firstAssistant.content[0]?.signature, "signature round-trips untouched");
});

// ---- server harness: real pipeline -----------------------------------------

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    close(): Promise<void>;
}

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function startHarness(): Promise<Harness> {
    let anthropicRequests = 0;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            ++anthropicRequests;
            // Turn 1 is small; turn 2 carries the Claude-Code-shaped history and
            // the provider reports a total that includes the hidden thinking.
            const inputTokens = anthropicRequests <= 1 ? 100 : 120_000;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(anthropicSse("message_start", { type: "message_start", message: { id: `msg_1320_${anthropicRequests}`, role: "assistant", usage: { input_tokens: inputTokens } } }));
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } } } },
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

async function fetchPanel(h: Harness, conversationId: string): Promise<string> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/status?conversationId=${conversationId}`);
    assert.equal(resp.status, 200);
    const status = (await resp.json()) as { ok: boolean; panel?: string };
    assert.equal(status.ok, true);
    assert.ok(typeof status.panel === "string" && status.panel.length > 0, "panel rendered");
    return status.panel!;
}

test("#1320 pipeline: provider-measured thinking mass reaches the context gauge", async () => {
    const h = await startHarness();
    try {
        const conv = "issue1320-anthropic";
        const system = "S".repeat(20_000);
        const tools = [{ name: "bash", description: "D".repeat(4000), input_schema: { type: "object" } }];
        const post = async (body: Record<string, unknown>): Promise<void> => {
            const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-bili-plugin": "pi-plugin/0.0.1",
                    "x-bili-plugin-conversation": conv,
                },
                body: JSON.stringify(body),
            });
            assert.equal(resp.status, 200);
            for await (const _chunk of resp.body) { /* drain */ }
        };

        await post({ model: "claude-test", max_tokens: 1024, stream: true, system, messages: [{ role: "user", content: "hello" }], tools });

        // Claude-Code-shaped turn 2: signature-only thinking on every assistant
        // turn. The fake provider bills 120K input; the local visible estimate
        // is far smaller — the difference is the hidden thinking share.
        const messages: Array<Record<string, unknown>> = [{ role: "user", content: "hello" }];
        for (let i = 0; i < 15; i++) {
            messages.push({
                role: "assistant",
                content: [
                    { type: "thinking", signature: `sig_${i}_${"x".repeat(2000)}` },
                    { type: "tool_use", id: `tu_${i}`, name: "bash", input: { command: `ls ${i}` } },
                ],
            });
            messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: `listing ${i}: ${"f.txt ".repeat(30)}` }] });
        }
        await post({ model: "claude-test", max_tokens: 1024, stream: true, system, messages, tools });

        // The provider total meters one turn behind (same lag as the nudge's
        // own "previous turn input_tokens" contract): turn 3 is where turn 2's
        // billed 120K gets attributed onto this history's signed blocks.
        await post({ model: "claude-test", max_tokens: 1024, stream: true, system, messages, tools });

        // Local expectation of what is VISIBLE (same estimators as the pipeline).
        const { msgs } = anthropicToCore({ model: "claude-test", messages } as AnthropicRequestBody);
        const visiblePlusOverhead = estimateCoreMessages(msgs) + countSystemAndToolsTokens(system, tools);
        assert.ok(visiblePlusOverhead < 60_000, "test premise: the visible mass is well below the billed total");

        const panel = await fetchPanel(h, conv);
        const sent = parseSentTotal(panel);
        // Pre-fix the gauge showed only the visible mass (~visiblePlusOverhead);
        // post-fix it must carry most of the provider-measured residual.
        assert.ok(sent >= visiblePlusOverhead + 50_000 - COMPACT_TOL, `gauge ${sent} must include the projected thinking mass (visible floor ${visiblePlusOverhead})`);
        assert.ok(sent <= 120_000 + COMPACT_TOL + 8_000, `gauge ${sent} must not exceed the provider total plus injected-content slack`);
    } finally {
        await h.close();
    }
});
