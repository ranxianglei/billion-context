import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { createAnthropicAdapter } from "../src/loop/adapter-anthropic.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";

const ANSWER = "The requested payload is complete.";
const CLIENT_TOOL = { name: "lookup", description: "Look up one document", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function start(): string {
    return sse("message_start", { type: "message_start", message: { id: "msg_stop", type: "message", role: "assistant", model: "stop-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 27, output_tokens: 1 } } });
}

function textRound(reason: string, sequence?: string | null): string {
    return start()
        + sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
        + sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ANSWER } })
        + sse("content_block_stop", { type: "content_block_stop", index: 0 })
        + sse("message_delta", { type: "message_delta", delta: { stop_reason: reason, ...(sequence !== undefined ? { stop_sequence: sequence } : {}) }, usage: { output_tokens: 7 } })
        + sse("message_stop", { type: "message_stop" });
}

function toolRound(): string {
    return start()
        + sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_internal_status", name: "acp_status", input: {} } })
        + sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } })
        + sse("content_block_stop", { type: "content_block_stop", index: 0 })
        + sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } })
        + sse("message_stop", { type: "message_stop" });
}

function events(raw: string): Array<Record<string, unknown>> {
    return raw.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

function terminal(raw: string): Record<string, unknown> {
    const deltas = events(raw).filter(event => event.type === "message_delta");
    assert.equal(deltas.length, 1);
    assert.equal(events(raw).filter(event => event.type === "message_stop").length, 1);
    return deltas[0].delta as Record<string, unknown>;
}

async function render(adapter: ReturnType<typeof createAnthropicAdapter>, raw: string, round = 1, override?: string, byteChunks = false): Promise<Record<string, unknown>> {
    const bytes = Buffer.from(raw);
    const stream = byteChunks ? new ReadableStream<Uint8Array>({
        start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
        },
    }) : new Response(raw).body!;
    let reason: string | undefined;
    for await (const event of adapter.parseStream(stream, round)) {
        if (event.kind === "done" && event.finishReason !== undefined) reason = event.finishReason;
    }
    return terminal(adapter.emitCompletion({ finishReason: override ?? reason }).toString("utf8"));
}

async function close(server: http.Server): Promise<void> {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function proxyRoundTrip(rounds: string[], sequences?: string[], withTools = true): Promise<{ raw: string; captured: Array<Record<string, unknown>> }> {
    const captured: Array<Record<string, unknown>> = [];
    const upstream = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        const reply = rounds[captured.length - 1];
        if (reply === undefined) {
            res.writeHead(500);
            res.end("Unexpected extra request");
            return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(reply);
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const options: ProxyOptions = {
        port: 0, host: "127.0.0.1", upstream: origin,
        routes: { [origin]: { models: { "stop-test": { context: 100_000 } } } },
        modelContextLimit: 100_000, kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
        autoUpdate: false, mitm: { enabled: false, domains: [] }, compat: { roles: {} },
        streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false,
        updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer(options);
        if (!proxy.listening) await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        const response = await fetch(`http://127.0.0.1:${port}/bili/${origin}/v1/messages`, {
            method: "POST", headers: { "content-type": "application/json", "x-acp-session": randomUUID() },
            body: JSON.stringify({ model: "stop-test", max_tokens: 64, stream: true, messages: [{ role: "user", content: "Return the completed payload." }], ...(withTools ? { tools: [CLIENT_TOOL] } : {}), ...(sequences ? { stop_sequences: sequences } : {}) }),
        });
        const raw = await response.text();
        assert.equal(response.status, 200, raw);
        assert.equal(captured.length, rounds.length, raw);
        for (const request of captured) assert.deepEqual(request.stop_sequences, sequences);
        if (withTools) {
            const names = (captured[0].tools as Array<{ name: string }>).map(tool => tool.name);
            assert.ok(names.includes("lookup") && names.includes("compress"), "exercise the enabled loop, not the no-tools passthrough");
        }
        return { raw, captured };
    } finally {
        if (proxy) await close(proxy);
        await close(upstream);
    }
}

for (const sequence of ["<END>", "完成🚀"]) {
    test(`real HTTP tool-loop completion preserves the matched stop ${sequence}`, async () => {
        const { raw } = await proxyRoundTrip([textRound("stop_sequence", sequence)], ["<OTHER>", sequence]);
        assert.deepEqual(terminal(raw), { stop_reason: "stop_sequence", stop_sequence: sequence });
        const text = events(raw).filter(event => event.type === "content_block_delta").map(event => (event.delta as { text?: string }).text ?? "").join("");
        assert.equal(text, ANSWER);
    });
}

test("real HTTP completion retains the final round's match after an internal tool", async () => {
    const sequence = "</answer>";
    const { raw, captured } = await proxyRoundTrip([toolRound(), textRound("stop_sequence", sequence)], [sequence]);
    const parts = (captured[1].messages as Array<{ content?: unknown }>).flatMap(message => Array.isArray(message.content) ? message.content : []);
    assert.ok(parts.some(part => part.type === "tool_result" && part.tool_use_id === "toolu_internal_status"), "the real status result reached the follow-up request");
    assert.deepEqual(terminal(raw), { stop_reason: "stop_sequence", stop_sequence: sequence });
    assert.ok(raw.includes(ANSWER));
});

test("real HTTP no-tools passthrough preserves its original matched sequence", async () => {
    const { raw } = await proxyRoundTrip([textRound("stop_sequence", "<END>")], ["<END>"], false);
    assert.deepEqual(terminal(raw), { stop_reason: "stop_sequence", stop_sequence: "<END>" });
});

test("real HTTP natural completion still reports null even with configured stop strings", async () => {
    const { raw } = await proxyRoundTrip([textRound("end_turn", null)], ["<UNMATCHED>"]);
    assert.deepEqual(terminal(raw), { stop_reason: "end_turn", stop_sequence: null });
});

test("matched Unicode survives a split at every UTF-8 byte", async () => {
    const sequence = "终点🚀\n\"done\"";
    assert.deepEqual(await render(createAnthropicAdapter({}), textRound("stop_sequence", sequence), 1, undefined, true), { stop_reason: "stop_sequence", stop_sequence: sequence });
});

for (const missing of [undefined, null]) {
    test(`an upstream ${String(missing)} match is not inferred from the requested stop array`, async () => {
        const adapter = createAnthropicAdapter({ stop_sequences: ["<UNREPORTED>"] });
        assert.deepEqual(await render(adapter, textRound("stop_sequence", missing)), { stop_reason: "stop_sequence", stop_sequence: null });
    });
}

test("a newly parsed round clears the preceding round's matched sequence", async () => {
    const adapter = createAnthropicAdapter({});
    assert.equal((await render(adapter, textRound("stop_sequence", "<OLD>"))).stop_sequence, "<OLD>");
    assert.deepEqual(await render(adapter, textRound("stop_sequence"), 2), { stop_reason: "stop_sequence", stop_sequence: null });
    assert.deepEqual(await render(adapter, textRound("end_turn", null), 3), { stop_reason: "end_turn", stop_sequence: null });
});

test("separate adapter instances retain their own matches", async () => {
    const left = createAnthropicAdapter({});
    const right = createAnthropicAdapter({});
    const [a, b] = await Promise.all([render(left, textRound("stop_sequence", "<LEFT>")), render(right, textRound("stop_sequence", "<RIGHT>"))]);
    assert.equal(a.stop_sequence, "<LEFT>");
    assert.equal(b.stop_sequence, "<RIGHT>");
    assert.equal(terminal(left.emitCompletion({ finishReason: "stop_sequence" }).toString()).stop_sequence, "<LEFT>");
});

test("a proxy-imposed length completion never claims a previously observed custom stop", async () => {
    assert.deepEqual(await render(createAnthropicAdapter({}), textRound("stop_sequence", "<OLD>"), 1, "length"), { stop_reason: "max_tokens", stop_sequence: null });
});

test("a later usage-only delta does not erase the matched sequence", async () => {
    const stop = sse("message_stop", { type: "message_stop" });
    const raw = textRound("stop_sequence", "<END>").replace(stop,
        sse("message_delta", { type: "message_delta", delta: {}, usage: { output_tokens: 8 } }) + stop);
    assert.deepEqual(await render(createAnthropicAdapter({}), raw), { stop_reason: "stop_sequence", stop_sequence: "<END>" });
});

test("an explicit null delta clears an earlier matched sequence", async () => {
    const stop = sse("message_stop", { type: "message_stop" });
    const raw = textRound("stop_sequence", "<OLD>").replace(stop,
        sse("message_delta", { type: "message_delta", delta: { stop_sequence: null }, usage: { output_tokens: 8 } }) + stop);
    assert.deepEqual(await render(createAnthropicAdapter({}), raw), { stop_reason: "stop_sequence", stop_sequence: null });
});

test("a retried parse in the same logical round clears the previous attempt's match", async () => {
    const adapter = createAnthropicAdapter({});
    assert.equal((await render(adapter, textRound("stop_sequence", "<OLD>"), 1)).stop_sequence, "<OLD>");
    assert.deepEqual(await render(adapter, textRound("stop_sequence"), 1), { stop_reason: "stop_sequence", stop_sequence: null });
});

test("legacy error completion does not report a previously observed custom stop", async () => {
    const adapter = createAnthropicAdapter({}, undefined, undefined, "completion");
    await render(adapter, textRound("stop_sequence", "<OLD>"));
    assert.deepEqual(terminal(adapter.emitError("upstream failed").toString("utf8")), { stop_reason: "end_turn", stop_sequence: null });
});

for (const sequence of ["", " \n "]) {
    test(`an upstream matched literal ${JSON.stringify(sequence)} is preserved without trimming`, async () => {
        assert.deepEqual(await render(createAnthropicAdapter({}), textRound("stop_sequence", sequence)), { stop_reason: "stop_sequence", stop_sequence: sequence });
    });
}
