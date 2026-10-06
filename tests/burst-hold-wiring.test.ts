import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #1491 wiring regression: the four protocol handlers (prepareAnthropic,
// prepareOpenai, prepareGoogle, prepareResponses) must each consult
// holdGrowthNudge before appending a growth nudge. The unit tests in
// burst-hold.test.ts pin the gate itself; these pin the WIRING — a burst-
// shaped trailing window (parallel tool results) holds the nudge while the
// same token mass in steady alternation still injects it. The growth floor is
// flattened low (nudgeGrowthTokens: 300) so a single turn arms the nudge, and
// the window is huge (400k) so usage stays far under both the emergency line
// and the hold ceiling — the only variable is the burst shape.
// Mutation contract: deleting the holdGrowth factor from ANY of the four
// willInjectNudge expressions must redden that lane's burst case.

const NUDGE_MARKER = "efficiency nudge to compress early";

function filler(i: number): string {
    return `L${i}_` + "payload ".repeat(1500);
}

type Lane = {
    name: string;
    warmupBody: () => string;
    path: string;
    steadyBody: () => string;
    burstBody: () => string;
    /** Non-stream upstream reply; the usage line is size-driven so the big
     *  payload turns advance the kernel's growth reference (warmup 1K, payload 41K). */
    reply: (inputTokens: number) => string;
};

const anthropicLane: Lane = {
    warmupBody: () => JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: false, messages: [{ role: "user", content: "warm up" }] }),
    name: "anthropic",
    path: "/v1/messages",
    steadyBody: () => JSON.stringify({
        model: "claude-small", max_tokens: 1024, stream: false,
        messages: [
            { role: "user", content: "run the steady loop " + filler(1) },
            ...Array.from({ length: 6 }, (_, i) => [
                { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "shell", input: { cmd: `echo ${i}` } }] },
                { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `out ${i} ` + filler(i + 2) }] },
            ]).flat(),
            { role: "user", content: "and summarize " + filler(9) },
        ],
    }),
    burstBody: () => JSON.stringify({
        model: "claude-small", max_tokens: 1024, stream: false,
        messages: [
            { role: "user", content: "run the batch " + filler(1) },
            { role: "assistant", content: [
                { type: "tool_use", id: "t0", name: "shell", input: { cmd: "ls" } },
                { type: "tool_use", id: "t1", name: "read", input: {} },
            ] },
            { role: "user", content: Array.from({ length: 10 }, (_, i) => ({ type: "tool_result", tool_use_id: `t${i % 2}`, content: `res ${i} ` + filler(i + 2) })) },
            { role: "user", content: "now summarize " + filler(13) },
        ],
    }),
    reply: (inputTokens: number) => JSON.stringify({
        id: "msg-x", type: "message", role: "assistant", model: "claude-small",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
        usage: { input_tokens: inputTokens, output_tokens: 5 },
    }),
};

const openaiLane: Lane = {
    warmupBody: () => JSON.stringify({ model: "gpt-small", max_tokens: 1024, stream: false, messages: [{ role: "user", content: "warm up" }] }),
    name: "openai-chat",
    path: "/v1/chat/completions",
    steadyBody: () => JSON.stringify({
        model: "gpt-small", max_tokens: 1024, stream: false,
        messages: [
            { role: "user", content: "run the steady loop " + filler(1) },
            ...Array.from({ length: 6 }, (_, i) => [
                { role: "assistant", content: null, tool_calls: [{ id: `t${i}`, type: "function", function: { name: "shell", arguments: `{"i":${i}}` } }] },
                { role: "tool", tool_call_id: `t${i}`, content: `out ${i} ` + filler(i + 2) },
            ]).flat(),
            { role: "user", content: "and summarize " + filler(9) },
        ],
    }),
    burstBody: () => JSON.stringify({
        model: "gpt-small", max_tokens: 1024, stream: false,
        messages: [
            { role: "user", content: "run the batch " + filler(1) },
            { role: "assistant", content: null, tool_calls: [
                { id: "t0", type: "function", function: { name: "shell", arguments: "{}" } },
                { id: "t1", type: "function", function: { name: "read", arguments: "{}" } },
            ] },
            ...Array.from({ length: 10 }, (_, i) => ({ role: "tool", tool_call_id: `t${i % 2}`, content: `res ${i} ` + filler(i + 2) })),
            { role: "user", content: "now summarize " + filler(13) },
        ],
    }),
    reply: (inputTokens: number) => JSON.stringify({
        id: "chatcmpl-x", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: inputTokens, completion_tokens: 3, total_tokens: inputTokens + 3 },
    }),
};

const googleLane: Lane = {
    warmupBody: () => JSON.stringify({ contents: [{ role: "user", parts: [{ text: "warm up" }] }] }),
    name: "google",
    path: "/v1beta/models/gemini-small:generateContent",
    steadyBody: () => JSON.stringify({
        contents: [
            { role: "user", parts: [{ text: "run the steady loop " + filler(1) }] },
            ...Array.from({ length: 6 }, (_, i) => [
                { role: "model", parts: [{ functionCall: { name: "shell", args: { i }, id: `t${i}` } }] },
                { role: "user", parts: [{ functionResponse: { name: "shell", response: { out: `out ${i} ` + filler(i + 2) } } }] },
            ]).flat(),
            { role: "user", parts: [{ text: "and summarize " + filler(9) }] },
        ],
    }),
    burstBody: () => JSON.stringify({
        contents: [
            { role: "user", parts: [{ text: "run the batch " + filler(1) }] },
            { role: "model", parts: [
                { functionCall: { name: "shell", args: {}, id: "t0" } },
                { functionCall: { name: "read", args: {}, id: "t1" } },
            ] },
            { role: "user", parts: Array.from({ length: 10 }, (_, i) => ({ functionResponse: { name: "shell", response: { out: `res ${i} ` + filler(i + 2) } } })) },
            { role: "user", parts: [{ text: "now summarize " + filler(13) }] },
        ],
    }),
    reply: (inputTokens: number) => JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: inputTokens, candidatesTokenCount: 3 },
    }),
};

const responsesLane: Lane = {
    warmupBody: () => JSON.stringify({ model: "gpt-resp", stream: false, instructions: "You are the test coding agent.", input: [{ type: "message", role: "user", content: "warm up" }] }),
    name: "responses",
    path: "/v1/responses",
    steadyBody: () => JSON.stringify({
        model: "gpt-resp", stream: false, instructions: "You are the test coding agent.",
        input: [
            { type: "message", role: "user", content: "run the steady loop " + filler(1) },
            ...Array.from({ length: 6 }, (_, i) => [
                { type: "function_call", id: `f${i}`, call_id: `t${i}`, name: "shell", arguments: `{"i":${i}}` },
                { type: "function_call_output", id: `o${i}`, call_id: `t${i}`, output: `out ${i} ` + filler(i + 2) },
            ]).flat(),
            { type: "message", role: "user", content: "and summarize " + filler(9) },
        ],
    }),
    burstBody: () => JSON.stringify({
        model: "gpt-resp", stream: false, instructions: "You are the test coding agent.",
        input: [
            { type: "message", role: "user", content: "run the batch " + filler(1) },
            { type: "function_call", id: "f0", call_id: "t0", name: "shell", arguments: "{}" },
            { type: "function_call", id: "f1", call_id: "t1", name: "read", arguments: "{}" },
            ...Array.from({ length: 10 }, (_, i) => ({ type: "function_call_output", id: `o${i}`, call_id: `t${i % 2}`, output: `res ${i} ` + filler(i + 2) })),
            { type: "message", role: "user", content: "now summarize " + filler(13) },
        ],
    }),
    reply: (inputTokens: number) => JSON.stringify({
        id: "resp-x", object: "response", status: "completed", model: "gpt-resp",
        output: [{ type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: inputTokens, output_tokens: 3, total_tokens: inputTokens + 3 },
    }),
};

const LANES: Lane[] = [anthropicLane, openaiLane, googleLane, responsesLane];

function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: 400_000 }, "gpt-small": { context: 400_000 }, "gemini-small": { context: 400_000 }, "gpt-resp": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true, nudgeGrowthTokens: 300 },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

for (const lane of LANES) {
    test(`#1491 wiring (${lane.name}): steady alternation injects the growth nudge, parallel burst holds it`, async () => {
        const forwards: string[] = [];
        const upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                forwards.push(raw);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(lane.reply(raw.length > 50_000 ? 41_000 : 1_000));
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = upstream.address().port;

        const proxy = await startProxy(upstreamPort);
        await once(proxy, "listening");
        const proxyPort = proxy.address().port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}${lane.path}`;

        const post = (body: string, session: string) => fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": session },
            body,
        });

        try {
            // Three-turn chain per scenario (the kernel's growth reference is
            // usage-line driven, so the decision can only fire on the turn
            // AFTER the big payload's usage line lands):
            //   warmup (1K usage, baseline) -> payload (41K usage) -> probe
            //   (same body again; decideNudge sees growth 40K >= 20K floor,
            //   usage 10% under the 0.7 hold ceiling).
            const run = async (body: () => string, session: string, expectNudge: boolean, label: string) => {
                for (const b of [lane.warmupBody(), body(), body()]) {
                    const r = await post(b, session);
                    assert.equal(r.status, 200, `${label} forwarded (${lane.name})`);
                    await r.text();
                }
                const probe = forwards[forwards.length - 1]!;
                assert.equal(probe.includes(NUDGE_MARKER), expectNudge,
                    `${lane.name} ${label}: growth nudge ${expectNudge ? "missing" : "not held"}`);
            };

            // Control: steady assistant/tool alternation (share 0.5 < 0.55) —
            // the growth nudge IS injected (proves the chain arms it).
            await run(lane.steadyBody, `bh-steady-${lane.name}`, true, "steady");

            // Burst: trailing parallel batch (10 results / 12-message window,
            // share 0.83 >= 0.55, usage 10% < 0.7 ceiling) — same token mass,
            // same armed nudge, but the wiring must HOLD it so the model
            // finishes its tool burst.
            await run(lane.burstBody, `bh-burst-${lane.name}`, false, "burst");
        } finally {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        }
    });
}
