import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const thought = "  Think 你好🔥\n\x3cacp tokens=\"2\" type=\"text\"\x3em00001\x3c/acp\x3e\n[ACP] quoted marker  ";
const signature = "opaque/signature+value==";

function frame(value: Record<string, unknown>, multiline: boolean): string {
    const event = typeof value.type === "string" ? `event: ${value.type}\n` : "";
    return event + JSON.stringify(value, null, multiline ? 2 : undefined).split("\n").map(line => `data: ${line}`).join("\n") + "\n\n";
}

function parseFrames(text: string): Array<Record<string, unknown>> {
    return text.split("\n\n").flatMap(event => {
        const data = event.split("\n").filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).replace(/^ /, "")).join("\n");
        return data.trim() === "" || data.trim() === "[DONE]" ? [] : [JSON.parse(data) as Record<string, unknown>];
    });
}

function anthropic(first: boolean): Array<Record<string, unknown>> {
    return [
        { type: "message_start", message: { id: first ? "msg-first" : "msg-final", role: "assistant", model: "claude-test", usage: { input_tokens: first ? 100 : 60, cache_read_input_tokens: first ? 80 : 40 } } },
        ...(first ? [
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thought } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call-status", name: "acp_status", input: {} } },
            { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
            { type: "content_block_stop", index: 1 },
        ] : [
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Final answer 你好🔥" } },
            { type: "content_block_stop", index: 0 },
        ]),
        { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn" }, usage: { output_tokens: 7 } },
        { type: "message_stop" },
    ];
}

function google(first: boolean): Array<Record<string, unknown>> {
    return first ? [
        { candidates: [{ index: 0, content: { role: "model", parts: [{ thought: true, text: thought, thoughtSignature: signature }] } }] },
        { candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { id: "call-status", name: "acp_status", args: {} }, thoughtSignature: "tool-signature" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7 } },
    ] : [
        { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Final answer 你好🔥" }] } }] },
        { candidates: [{ index: 0, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 7 } },
    ];
}

async function close(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}

for (const protocol of ["openai", "google", "anthropic"] as const) {
    for (const multiline of [false, true]) {
        test(`${protocol} HTTP proxy: ${multiline ? "multiline" : "single-line control"} reply and signed replay`, async () => {
            const calls: Record<string, unknown>[] = [];
            const upstream = http.createServer(async (req, res) => {
                const chunks: Buffer[] = [];
                for await (const chunk of req) chunks.push(Buffer.from(chunk));
                calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
                const first = calls.length === 1;
                const frames = protocol === "anthropic" ? anthropic(first) : protocol === "google" ? google(first) : [
                    { id: "chat-7", choices: [{ index: 0, delta: { content: "Final answer 你好🔥" }, finish_reason: null }] },
                    { id: "chat-7", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 60, completion_tokens: 7 } },
                ];
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(frames.map(value => frame(value, multiline)).join("") + (protocol === "openai" ? "data: [DONE]\n\n" : ""));
            });
            upstream.listen(0, "127.0.0.1");
            await once(upstream, "listening");
            const upstreamPort = (upstream.address() as import("node:net").AddressInfo).port;
            _setStoreForTest(new SessionStore({ enabled: false }));
            setRegistryForTest({});
            const proxy = await startServer({
                port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
                routes: {}, modelContextLimit: 10_000, kernelConfig: defaultConfig(10_000),
                compress: { injectTool: true, injectNudge: true }, sessionHeader: "x-acp-session",
                log: false, debug: false, passthrough: false, autoUpdate: false,
                compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
                autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false,
                releaseNotesCheck: false, mitm: { enabled: false, domains: [] },
            } as unknown as ProxyOptions);
            if (!proxy.listening) await once(proxy, "listening");
            try {
                const proxyPort = (proxy.address() as import("node:net").AddressInfo).port;
                const path = protocol === "openai" ? "/v1/chat/completions" : protocol === "anthropic" ? "/v1/messages" : "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse";
                const body = protocol === "google" ? { contents: [{ role: "user", parts: [{ text: "Report status then answer." }] }] }
                    : { model: protocol === "openai" ? "gpt-test" : "claude-test", stream: true, max_tokens: 2048, messages: [{ role: "user", content: "Report status then answer." }] };
                const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}${path}`, {
                    method: "POST", headers: { "content-type": "application/json", "x-acp-session": `multiline-${protocol}-${multiline}` }, body: JSON.stringify(body),
                });
                const text = await response.text();
                assert.equal(response.status, 200);
                assert.match(text, /Final answer 你好🔥/);
                assert.equal(calls.length, protocol === "openai" ? 1 : 2, "no empty-reply retry; exactly one status continuation on signed wires");
                const frames = parseFrames(text);
                if (protocol === "anthropic") {
                    const deltas = frames.filter(value => value.type === "content_block_delta").map(value => value.delta as Record<string, unknown>);
                    assert.equal(deltas.map(value => value.thinking ?? "").join(""), thought);
                    assert.equal(deltas.map(value => value.signature ?? "").join(""), signature);
                    const messages = calls[1]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
                    const replayed = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(value => value.type === "thinking");
                    assert.ok(replayed);
                    assert.equal(replayed.thinking, thought);
                    assert.equal(replayed.signature, signature);
                    const starts = frames.filter(value => value.type === "content_block_start").map(value => value.index);
                    assert.equal(new Set(starts).size, starts.length, "a continuation cannot reuse a client block index");
                    const start = frames.find(value => value.type === "message_start")!;
                    assert.deepEqual((start.message as Record<string, unknown>).usage, { input_tokens: 0, output_tokens: 0 });
                } else if (protocol === "google") {
                    const parts = frames.flatMap(value => (value.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> } }> | undefined)?.flatMap(candidate => candidate.content?.parts ?? []) ?? []);
                    const visible = parts.find(part => part.thought === true);
                    assert.ok(visible);
                    assert.equal(visible.text, thought);
                    assert.equal(visible.thoughtSignature, signature);
                    const contents = calls[1]!.contents as Array<{ parts: Array<Record<string, unknown>> }>;
                    const replayed = contents.flatMap(content => content.parts).find(part => part.thought === true);
                    assert.ok(replayed);
                    assert.equal(replayed.text, thought);
                    assert.equal(replayed.thoughtSignature, signature);
                    const call = contents.flatMap(content => content.parts).find(part => part.functionCall !== undefined);
                    assert.equal(call?.thoughtSignature, "tool-signature");
                }
            } finally {
                await close(proxy);
                await close(upstream);
            }
        });
    }
}
