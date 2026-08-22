import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest, pluginReportedContextWindow, queuePluginRegister, takePendingPluginRegister } from "../src/plugin.ts";
import { clientConversationHeader } from "../src/session-id.ts";

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: { body: string; headers: Record<string, string | string[] | undefined> }[];
    close(): Promise<void>;
}

interface SseEvent {
    event: string;
    data: Record<string, unknown>;
}

const UPSTREAM_SYSTEM = "You are a test assistant.";

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseAnthropicSse(raw: string): SseEvent[] {
    const out: SseEvent[] = [];
    for (const block of raw.split("\n\n")) {
        let event = "";
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (!event) continue;
        const jsonStr = dataLines.join("\n").trim();
        try {
            out.push({ event, data: jsonStr ? (JSON.parse(jsonStr) as Record<string, unknown>) : {} });
        } catch {
            out.push({ event, data: { _raw: jsonStr } });
        }
    }
    return out;
}

function textScript(): string[] {
    return [
        anthropicSse("message_start", {
            type: "message_start",
            message: { id: "msg_plug_1", role: "assistant", usage: { input_tokens: 55, cache_read_input_tokens: 11 } },
        }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "plain answer" } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

function compressToolScript(): string[] {
    const compressArgs = JSON.stringify({ startId: "m00001", endId: "m00002", topic: "plugin-e2e-topic", summary: "plugin e2e compress summary" });
    return [
        anthropicSse("message_start", {
            type: "message_start",
            message: { id: "msg_plug_2", role: "assistant", usage: { input_tokens: 55 } },
        }),
        anthropicSse("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_c_1", name: "compress", input: {} },
        }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: compressArgs } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

async function startHarness(scripts: string[][]): Promise<Harness> {
    const captured: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
    let call = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString();
            captured.push({ body, headers: { ...req.headers } });
            let wantsStream = true;
            try {
                wantsStream = (JSON.parse(body) as { stream?: boolean }).stream !== false;
            } catch { /* non-JSON probe */ }
            const script = scripts[Math.min(call, scripts.length - 1)]!;
            call += 1;
            if (!wantsStream) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "msg_plug_json", role: "assistant", content: [{ type: "text", text: "non-stream answer" }], usage: { input_tokens: 55, output_tokens: 9 } }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const line of script) {
                res.write(line);
            }
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
        captured,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

type AnthropicMessage = { role: string; content: string | Array<Record<string, unknown>> };

async function callPluginAnthropic(
    h: Harness,
    conversationId: string,
    messages: AnthropicMessage[],
    opts: { tools?: unknown[]; stream?: boolean; contextWindow?: number } = {},
): Promise<{ raw: string; events: SseEvent[]; json: Record<string, unknown> | undefined }> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bili-plugin": "pi-plugin/0.0.1",
            "x-bili-plugin-conversation": conversationId,
            ...(opts.contextWindow !== undefined ? { "x-bili-plugin-context-window": String(opts.contextWindow) } : {}),
        },
        body: JSON.stringify({
            model: "claude-test",
            max_tokens: 1024,
            stream: opts.stream ?? true,
            system: UPSTREAM_SYSTEM,
            messages,
            ...(opts.tools ? { tools: opts.tools } : {}),
        }),
    });
    assert.equal(resp.status, 200);
    if ((opts.stream ?? true) === false) {
        const json = (await resp.json()) as Record<string, unknown>;
        return { raw: JSON.stringify(json), events: [], json };
    }
    let raw = "";
    for await (const chunk of resp.body) {
        raw += Buffer.from(chunk).toString("utf8");
    }
    return { raw, events: parseAnthropicSse(raw), json: undefined };
}

test("plugin manifest serves the exact wire tool schemas, headers and version", async () => {
    const h = await startHarness([textScript()]);
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/manifest`);
        assert.equal(resp.status, 200);
        const manifest = (await resp.json()) as {
            ok: boolean;
            protocolVersion: number;
            version: string;
            toolNames: string[];
            tools: Record<string, Array<{ name: string }>>;
            headers: { agent: string; conversation: string };
            toolEndpoint: string;
        };
        assert.equal(manifest.ok, true);
        assert.equal(manifest.protocolVersion, 1);
        assert.ok(/^\d+\.\d+\.\d+/.test(manifest.version), `version looks wrong: ${manifest.version}`);
        assert.deepEqual([...manifest.toolNames].sort(), ["acp_status", "compress", "decompress", "search_context"]);
        const names = manifest.tools.anthropic!.map((t) => t.name).sort();
        assert.deepEqual(names, ["acp_status", "compress", "decompress", "search_context"]);
        assert.equal(manifest.tools.openai!.length, 4);
        assert.equal(manifest.tools.responses!.length, 4);
        assert.equal(manifest.headers.agent, "x-bili-plugin");
        assert.equal(manifest.headers.conversation, "x-bili-plugin-conversation");
        assert.equal(manifest.toolEndpoint, "/__bili/plugin/tool");
    } finally {
        await h.close();
    }
});

test("plugin mode: no wire tool injection, philosophy still injected, native compress tool_use passes through untouched", async () => {
    const h = await startHarness([compressToolScript()]);
    try {
        const conv = "plug-conv-native-tool";
        const { events } = await callPluginAnthropic(h, conv, [
            { role: "user", content: "please compress the conversation now" },
        ], { tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: {} } }] });

        assert.equal(h.captured.length, 1, `expected exactly 1 upstream call (no proxy re-request), got ${h.captured.length}`);
        const upstreamReq = JSON.parse(h.captured[0]!.body) as {
            tools?: Array<{ name: string }>;
            system?: string | Array<{ type: string; text?: string }>;
        };
        const upstreamToolNames = upstreamReq.tools?.map((t) => t.name) ?? [];
        assert.deepEqual(upstreamToolNames, ["get_weather"], `plugin mode must not inject wire tools: ${JSON.stringify(upstreamToolNames)}`);
        const sysText = typeof upstreamReq.system === "string" ? upstreamReq.system : (upstreamReq.system ?? []).map((b) => b.text ?? "").join("\n");
        assert.match(sysText, /test assistant/);
        assert.match(sysText, /compress/i);

        const clientToolUses = events.filter(
            (e) => e.event === "content_block_start" && (e.data.content_block as { type?: string; name?: string })?.type === "tool_use",
        );
        assert.equal(clientToolUses.length, 1, "the model's native compress tool_use must reach the client untouched");
        const block = clientToolUses[0]!.data.content_block as { id?: string; name?: string };
        assert.equal(block.id, "toolu_c_1");
        assert.equal(block.name, "compress");
        const jsonDeltas = events
            .filter((e) => e.event === "content_block_delta" && (e.data.delta as { type?: string })?.type === "input_json_delta")
            .map((e) => (e.data.delta as { partial_json?: string }).partial_json ?? "");
        assert.match(jsonDeltas.join(""), /plugin-e2e-topic/);
        assert.equal(events.filter((e) => e.event === "message_stop").length, 1);
    } finally {
        await h.close();
    }
});

test("plugin tool API executes compress under the session lock; next request folds the consumed range", async () => {
    const h = await startHarness([compressToolScript(), textScript()]);
    try {
        const conv = "plug-conv-tool-api";
        // Sizing vs kernel rules: the compressed head must exceed
        // minCompressibleChars (5000), while the protected-zone walk
        // (preserveRecentTokens=5000) must exhaust itself on the tail before
        // reaching back into the head. ~4 chars/token for latin filler.
        const headFiller = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(28);
        const tailFiller = "enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate. ".repeat(28);
        const history: AnthropicMessage[] = [];
        for (let i = 1; i <= 2; i++) {
            history.push({ role: "user", content: `turn-${i}-marker question: ${headFiller}` });
            history.push({ role: "assistant", content: `turn-${i}-marker answer: ${headFiller}` });
        }
        for (let i = 3; i <= 5; i++) {
            history.push({ role: "user", content: `turn-${i} padding question: ${tailFiller}` });
            history.push({ role: "assistant", content: `turn-${i} padding answer: ${tailFiller}` });
        }
        await callPluginAnthropic(h, conv, history);

        const toolResp = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conv,
                tool: "compress",
                args: { content: [{ topic: "plugin-e2e-topic", startId: "m00001", endId: "m00002", summary: "plugin-side compress of the two early turns covering the lorem-ipsum questions and answers" }] },
            }),
        });
        assert.equal(toolResp.status, 200);
        const toolJson = (await toolResp.json()) as { ok: boolean; result: string };
        assert.equal(toolJson.ok, true);
        assert.ok(!/FAILED/i.test(toolJson.result), `compress tool reported failure: ${toolJson.result}`);

        await callPluginAnthropic(h, conv, [
            ...history,
            {
                role: "assistant",
                content: [
                    { type: "tool_use", id: "toolu_c_1", name: "compress", input: { startId: "m00001", endId: "m00002", topic: "plugin-e2e-topic", summary: "plugin-side compress of the two early turns covering the lorem-ipsum questions and answers" } },
                ],
            },
            {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "toolu_c_1", content: toolJson.result }],
            },
        ]);

        assert.equal(h.captured.length, 2);
        const foldedRaw = JSON.parse(h.captured[1]!.body) as { messages: Array<{ role: string; content: unknown }> };
        const folded = JSON.stringify(foldedRaw);
        // acp-kernel 0.0.32 (reverts #18): KEEP_LAST_ORPHANED=2 keeps the newest
        // two orphaned compress call+result pairs visible for failure observability.
        // The plugin-side block carries a plugin_<ts> callId (not the model's
        // tool_use id), so toolu_c_1 is orphaned and stays visible — not hidden.
        assert.ok(folded.includes("toolu_c_1"), `newest orphaned compress tool_use stays visible (KEEP_LAST_ORPHANED=2): ${folded.slice(0, 400)}`);
        assert.ok(foldedRaw.messages.length < 12, `history must shrink after folding: got ${foldedRaw.messages.length}`);
        assert.ok(!folded.includes("turn-1-marker answer"), "compressed range content must be folded away");

        // The summary text deliberately does NOT ride in the wire body
        // (stripKernelSummaries drops acp_summary_* messages — same as wire
        // mode); it lives in block state and must be retrievable via the
        // plugin tool API, which is what the model's search_context sees.
        const searchResp = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv, tool: "search_context", args: { query: "plugin" } }),
        });
        assert.equal(searchResp.status, 200);
        const searchJson = (await searchResp.json()) as { ok: boolean; result: string };
        assert.equal(searchJson.ok, true);
        assert.match(searchJson.result, /plugin-side compress of the two early turns/, "block summary must be retrievable via search_context");
    } finally {
        await h.close();
    }
});

test("plugin tool API error paths: bad JSON, unknown tool, unknown conversation", async () => {
    const h = await startHarness([textScript()]);
    try {
        const badJson = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not json",
        });
        assert.equal(badJson.status, 400);

        const badTool = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: "never-seen", tool: "rm-rf", args: {} }),
        });
        assert.equal(badTool.status, 400);

        const unknownConv = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: "never-seen", tool: "acp_status", args: {} }),
        });
        assert.equal(unknownConv.status, 404);
        const errJson = (await unknownConv.json()) as { ok: boolean; error: string };
        assert.equal(errJson.ok, false);
        assert.match(errJson.error, /unknown plugin conversation/i);
    } finally {
        await h.close();
    }
});

test("plugin mode: streamed response forwards verbatim while usage is sniffed into session stats", async () => {
    const h = await startHarness([textScript()]);
    try {
        const conv = "plug-conv-usage";
        const { raw } = await callPluginAnthropic(h, conv, [{ role: "user", content: "hello" }]);
        assert.match(raw, /plain answer/);

        const stats = (await (await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/stats`)).json()) as {
            sessions?: Array<{ label?: string; inputTokens?: number; requests?: number }>;
        };
        const mine = (stats.sessions ?? []).find((s) => s.label === conv);
        assert.ok(mine, `session for plugin conversation not found: ${JSON.stringify(stats.sessions?.map((s) => s.label))}`);
        assert.equal(mine!.requests, 1);
        // inputTokens is the true TOTAL context (input_tokens + cache_read),
        // so cacheHitPct = cachedTokens/inputTokens is a meaningful ratio.
        assert.equal(mine!.inputTokens, 66, "message_start usage sniffed: total = input_tokens(55) + cache_read(11)");
    } finally {
        await h.close();
    }
});

test("plugin mode: relay-echoed message_delta input_tokens:0 must not zero the sniffed input", async () => {
    // Some relays echo a schema-shaped usage in message_delta with
    // input_tokens: 0 (the spec field is normally absent — message_start is
    // authoritative and the input is fixed within a turn). Merging the 0 used
    // to collapse lastInputTokens to the cached portion only (11 instead of
    // 66) — the nudge denominator then under-reported by ~6x.
    const zeroEchoScript = [
        ...textScript().slice(0, 4), // message_start + content block events
        anthropicSse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 },
        }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
    const h = await startHarness([zeroEchoScript]);
    try {
        const conv = "plug-conv-delta-zero";
        await callPluginAnthropic(h, conv, [{ role: "user", content: "hello" }]);

        const stats = (await (await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/stats`)).json()) as {
            sessions?: Array<{ label?: string; inputTokens?: number; cachedTokens?: number }>;
        };
        const mine = (stats.sessions ?? []).find((s) => s.label === conv);
        assert.ok(mine, "session for plugin conversation not found");
        assert.equal(mine!.inputTokens, 66, "message_start total preserved despite the 0 echoed in message_delta");
        assert.equal(mine!.cachedTokens, 11, "cached portion preserved");
    } finally {
        await h.close();
    }
});

test("plugin mode: non-streaming JSON response passes through and usage is sniffed", async () => {
    const h = await startHarness([textScript()]);
    try {
        const conv = "plug-conv-json";
        const { json } = await callPluginAnthropic(h, conv, [{ role: "user", content: "hello" }], { stream: false });
        assert.equal((json as { content?: Array<{ text?: string }> }).content?.[0]?.text, "non-stream answer");

        const stats = (await (await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/stats`)).json()) as {
            sessions?: Array<{ label?: string; inputTokens?: number }>;
        };
        const mine = (stats.sessions ?? []).find((s) => s.label === conv);
        assert.ok(mine, "session for plugin conversation not found");
        assert.equal(mine!.inputTokens, 55);
    } finally {
        await h.close();
    }
});

test("plugin-protocol headers are honored only from requests announcing x-bili-plugin", () => {
    // x-bili-plugin-context-window: a plain client must not be able to
    // rewrite the nudge denominator by sending a plugin-protocol header.
    assert.equal(
        pluginReportedContextWindow({ "x-bili-plugin-context-window": "50000" }),
        undefined,
        "context-window header without the plugin marker is ignored",
    );
    assert.equal(
        pluginReportedContextWindow({ "x-bili-plugin": "pi-plugin/0.0.1", "x-bili-plugin-context-window": "50000" }),
        50000,
        "plugin marker + reported window is honored",
    );
    assert.equal(
        pluginReportedContextWindow({ "x-bili-plugin": "pi-plugin/0.0.1", "x-bili-plugin-context-window": "junk" }),
        undefined,
        "non-numeric reported window falls back to the cascade",
    );

    // x-bili-plugin-conversation: likewise gated on the marker, while the
    // legacy client headers keep working without any marker.
    assert.equal(
        clientConversationHeader({ "x-bili-plugin-conversation": "steal-me" }),
        undefined,
        "plugin conversation header without the marker is ignored",
    );
    assert.equal(
        clientConversationHeader({ "x-bili-plugin": "pi-plugin/0.0.1", "x-bili-plugin-conversation": "steal-me" }),
        "steal-me",
        "plugin conversation header honored with the marker",
    );
    assert.equal(
        clientConversationHeader({ "x-bili-plugin-conversation": "steal-me", "x-claude-code-session-id": "legacy-1" }),
        "legacy-1",
        "falls through to the legacy client header",
    );
    assert.equal(clientConversationHeader({ "x-session-id": "zcode-1" }), "zcode-1");
});

test("plugin-reported context window becomes the nudge denominator and is visible via status", async () => {
    const h = await startHarness([textScript()]);
    try {
        const conv = "plug-conv-window";
        // claude-test is configured at 400000 in the harness routes; the
        // plugin reports the agent's own 50000 window → must win over the
        // route value (authoritative native source).
        await callPluginAnthropic(h, conv, [{ role: "user", content: "hello" }], { contextWindow: 50000 });

        const missing = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/status`);
        assert.equal(missing.status, 400);

        const unknown = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/status?conversationId=never-seen`);
        assert.equal(unknown.status, 404);

        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/status?conversationId=${conv}`);
        assert.equal(resp.status, 200);
        const status = (await resp.json()) as {
            ok: boolean;
            contextLimit: number | null;
            contextTokens: number;
            requests: number;
            pluginAgent: string | null;
        };
        assert.equal(status.ok, true);
        assert.equal(status.contextLimit, 50000, "plugin-reported window must override the route-configured 400000");
        assert.equal(status.contextTokens, 66, "context level = input 55 + cached 11 (total prompt size the nudge sees)");
        assert.equal(status.requests, 1);
        assert.match(status.pluginAgent ?? "", /pi-plugin/);

        // Without the header the route-configured window (400000) applies.
        const conv2 = "plug-conv-window-default";
        await callPluginAnthropic(h, conv2, [{ role: "user", content: "hello" }]);
        const status2 = (await (await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/status?conversationId=${conv2}`)).json()) as {
            contextLimit: number | null;
        };
        assert.equal(status2.contextLimit, 400000);
    } finally {
        await h.close();
    }
});

test("headless launcher registrations expire after the TTL (no stale poisoning)", () => {
    _resetPluginStateForTest();
    const t0 = Date.now();
    const realNow = Date.now;
    try {
        Date.now = () => t0;
        queuePluginRegister("ttl-stale", "codex", false);
        Date.now = () => t0 + 11 * 60 * 1000;
        queuePluginRegister("ttl-fresh", "codex", false);
        assert.equal(takePendingPluginRegister()?.conversationId, "ttl-fresh", "expired registration dropped, fresh one bound");
        assert.equal(takePendingPluginRegister(), undefined, "queue drained");
    } finally {
        Date.now = realNow;
        _resetPluginStateForTest();
    }
});
