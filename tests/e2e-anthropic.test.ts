import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

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
            message: { id: "msg_antro_1", role: "assistant", usage: { input_tokens: 37, cache_read_input_tokens: 11 } },
        }),
        anthropicSse("ping", { type: "ping" }),
        "[WAIT]",
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
        "[WAIT]",
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }),
        "[WAIT]",
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 7 },
        }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

function namespacedToolScript(): string[] {
    return [
        anthropicSse("message_start", {
            type: "message_start",
            message: { id: "msg_antro_2", role: "assistant", usage: { input_tokens: 41 } },
        }),
        anthropicSse("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_ns_1", name: "agents.spawn_agent", input: {} },
        }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"task"' } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ':"demo"}' } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 9 },
        }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

function compressRound1Script(): string[] {
    const compressArgs = JSON.stringify({ startId: "m00001", endId: "m00002", topic: "e2e", summary: "anthropic e2e compress round trip" });
    return [
        anthropicSse("message_start", {
            type: "message_start",
            message: { id: "msg_antro_3", role: "assistant", usage: { input_tokens: 55 } },
        }),
        anthropicSse("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_c_1", name: "bili_compress", input: {} },
        }),
        anthropicSse("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: compressArgs.slice(0, 20) },
        }),
        anthropicSse("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: compressArgs.slice(20) },
        }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 12 },
        }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

function compressRound2Script(): string[] {
    return [
        anthropicSse("message_start", {
            type: "message_start",
            message: { id: "msg_antro_3", role: "assistant", usage: { input_tokens: 20, cache_read_input_tokens: 5 } },
        }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done after compress" } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 4 },
        }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

async function startHarness(scripts: string[][]): Promise<Harness> {
    const captured: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
    let call = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
            captured.push({ body: Buffer.concat(chunks).toString(), headers: { ...req.headers } });
            res.writeHead(200, { "content-type": "text/event-stream" });
            const script = scripts[Math.min(call, scripts.length - 1)]!;
            call += 1;
            for (const line of script) {
                if (line === "[WAIT]") {
                    await new Promise((r) => setTimeout(r, 40));
                    continue;
                }
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

interface AnthropicUserMessage {
    role: string;
    content: string | Array<Record<string, unknown>>;
}

async function callAnthropic(h: Harness, messages: AnthropicUserMessage[], tools?: unknown[]): Promise<{ raw: string; events: SseEvent[]; arrivals: number[] }> {
    const started = Date.now();
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            model: "claude-test",
            max_tokens: 1024,
            stream: true,
            system: UPSTREAM_SYSTEM,
            messages,
            ...(tools ? { tools } : {}),
        }),
    });
    assert.equal(resp.status, 200);
    const arrivals: number[] = [];
    let raw = "";
    for await (const chunk of resp.body) {
        raw += Buffer.from(chunk).toString("utf8");
        arrivals.push(Date.now() - started);
    }
    return { raw, events: parseAnthropicSse(raw), arrivals };
}

test("e2e anthropic: text streams through with incremental deltas, injected tools + system reach upstream", async () => {
    const h = await startHarness([textScript()]);
    try {
        const { events, arrivals } = await callAnthropic(h, [{ role: "user", content: "hello" }], [
            { name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: {} } },
        ]);

        const deltas = events.filter((e) => e.event === "content_block_delta" && (e.data.delta as { type?: string })?.type === "text_delta");
        assert.ok(deltas.length >= 3, `expected >= 3 text_delta events, got ${deltas.length}`);
        assert.equal(deltas.map((d) => (d.data.delta as { text?: string }).text).join(""), "Hello world!");
        assert.ok(arrivals[arrivals.length - 1]! - arrivals[0]! >= 50, `client stream appears buffered: span=${arrivals[arrivals.length - 1]! - arrivals[0]!}ms`);

        const starts = events.filter((e) => e.event === "content_block_start");
        assert.ok(starts.some((s) => (s.data.content_block as { type?: string })?.type === "text"));
        const msgDeltas = events.filter((e) => e.event === "message_delta");
        assert.ok(msgDeltas.length >= 1, "message_delta terminal event missing");
        assert.equal(events.filter((e) => e.event === "message_stop").length, 1);

        const upstreamReq = JSON.parse(h.captured[0]!.body) as {
            tools?: Array<{ name: string }>;
            system?: string | Array<{ type: string; text?: string }>;
        };
        const upstreamToolNames = upstreamReq.tools?.map((t) => t.name) ?? [];
        for (const expected of ["get_weather", "bili_compress", "bili_decompress", "bili_search_context", "bili_status"]) {
            assert.ok(upstreamToolNames.includes(expected), `upstream tools missing ${expected}: ${JSON.stringify(upstreamToolNames)}`);
        }
        const sysText = typeof upstreamReq.system === "string" ? upstreamReq.system : (upstreamReq.system ?? []).map((b) => b.text ?? "").join("\n");
        assert.match(sysText, /test assistant/);
        assert.match(sysText, /compress/i);
    } finally {
        await h.close();
    }
});

test("e2e anthropic: tool_use reconstruction preserves id, name and full arguments (namespaced tools, issue #143 analog)", async () => {
    const h = await startHarness([namespacedToolScript()]);
    try {
        const { events } = await callAnthropic(h, [{ role: "user", content: "spawn a demo agent" }]);

        const toolStarts = events.filter(
            (e) => e.event === "content_block_start" && (e.data.content_block as { type?: string })?.type === "tool_use",
        );
        assert.equal(toolStarts.length, 1, "expected exactly one tool_use block on client stream");
        const block = toolStarts[0]!.data.content_block as { id?: string; name?: string };
        assert.equal(block.id, "toolu_ns_1", `tool_use id not preserved: ${JSON.stringify(block)}`);
        assert.equal(block.name, "agents.spawn_agent", `tool name not preserved: ${JSON.stringify(block)}`);

        const jsonDeltas = events
            .filter((e) => e.event === "content_block_delta" && (e.data.delta as { type?: string })?.type === "input_json_delta")
            .map((e) => (e.data.delta as { partial_json?: string }).partial_json ?? "");
        assert.equal(jsonDeltas.join(""), '{"task":"demo"}');
        assert.equal(events.filter((e) => e.event === "message_stop").length, 1);
    } finally {
        await h.close();
    }
});

test("e2e anthropic: compress tool_use round-trip — 2nd upstream request carries tool_result, round-2 text reaches client", async () => {
    const h = await startHarness([compressRound1Script(), compressRound2Script()]);
    try {
        const { events } = await callAnthropic(h, [
            { role: "user", content: "please compress the conversation now" },
        ]);

        assert.ok(h.captured.length >= 2, `expected >= 2 upstream requests, got ${h.captured.length}`);

        const secondReq = JSON.parse(h.captured[1]!.body) as { messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> };
        const flat = secondReq.messages.map((m) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content)).flat();
        const toolResults = flat.filter((b) => b.type === "tool_result");
        assert.ok(toolResults.length >= 1, `2nd upstream request has no tool_result block: ${JSON.stringify(secondReq.messages)}`);
        assert.equal((toolResults[0] as { tool_use_id?: string }).tool_use_id, "toolu_c_1");

        const clientText = events
            .filter((e) => e.event === "content_block_delta" && (e.data.delta as { type?: string })?.type === "text_delta")
            .map((e) => (e.data.delta as { text?: string }).text ?? "")
            .join("");
        assert.match(clientText, /Done after compress/);

        const clientToolUses = events.filter(
            (e) => e.event === "content_block_start" && (e.data.content_block as { type?: string; name?: string })?.type === "tool_use",
        );
        assert.equal(clientToolUses.filter((e) => (e.data.content_block as { name?: string }).name === "bili_compress").length, 0, "compress tool_use leaked to client");

        assert.equal(events.filter((e) => e.event === "message_stop").length, 1, "expected exactly one terminal message_stop across both rounds");
    } finally {
        await h.close();
    }
});
