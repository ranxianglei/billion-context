import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createCore, defaultConfig } from "acp-kernel";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { createCommandcodeAdapter } from "../src/loop/adapter-commandcode.ts";
import { runCompressLoop, type LoopCtx, type ParsedStreamEvent } from "../src/loop/core.ts";
import { _setStoreForTest, SessionStore } from "../src/persist.ts";
import { pipePluginJsonlWithStrip } from "../src/plugin.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { createSession } from "../src/session.ts";

const textLine = JSON.stringify({ type: "text-delta", text: "Ready 海 🌊" });
const finishLine = '{ "type":"finish", "finishReason":"stop", "totalUsage":{"inputTokens":31,"outputTokens":7,"inputTokenDetails":{"cacheReadTokens":13}} }';
const errorLine = '{ "type":"error", "error":"upstream_failed", "message":"Provider stopped" }';
const ignoredLine = JSON.stringify({ type: "text-delta", text: "must not follow a terminal" });
const requestBody = { model: "commandcode-test", stream: true, messages: [{ role: "user", content: "Continue the task." }] };

function heldStream(lines: string[]) {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(value) { controller = value; value.enqueue(new TextEncoder().encode(lines.join("\n") + "\n")); },
        cancel() { cancelled = true; },
    });
    return { stream, cancelled: () => cancelled, close() { if (!cancelled) controller.close(); } };
}

async function beforeEof(work: Promise<void>, source: ReturnType<typeof heldStream>, release?: () => Promise<unknown>): Promise<void> {
    let completed = false;
    const observed = work.then(() => { completed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const completedBeforeEof = completed;
    source.close();
    await release?.();
    await observed;
    assert.ok(completedBeforeEof, "a received terminal must finish consumption while HTTP EOF is still withheld (WC-1)");
}

function collector() {
    const chunks: Buffer[] = [];
    let ends = 0;
    let ended = false;
    const response = {
        destroyed: false, get writableEnded() { return ended; },
        write(chunk: Buffer) { chunks.push(chunk); return true; },
        end() { ends++; ended = true; return this; },
    } as unknown as http.ServerResponse;
    return { response, output: () => Buffer.concat(chunks).toString("utf8"), ends: () => ends };
}

for (const [name, terminal] of [["finish", finishLine], ["error", errorLine]] as const) {
    test(`CommandCode adapter stops at ${name} without reading past the terminal or waiting for EOF`, async () => {
        const source = heldStream([textLine, terminal, ignoredLine]);
        const events: ParsedStreamEvent[] = [];
        const adapter = createCommandcodeAdapter(requestBody);
        await beforeEof((async () => {
            for await (const event of adapter.parseStream(source.stream, 1)) events.push(event);
        })(), source);
        assert.equal(source.stream.locked, false, "the loop can release the finished attempt");
        assert.deepEqual(events.filter(event => event.kind === "text").map(event => event.delta), ["Ready 海 🌊"]);
        assert.equal(events.at(-1)?.kind, name === "finish" ? "done" : "error");
        if (name === "finish") assert.deepEqual(events.find(event => event.kind === "usage"), {
            kind: "usage", inputTokens: 31, outputTokens: 7, cachedTokens: 13,
        });
    });

    test(`CommandCode plugin pipe settles and closes at ${name} without HTTP EOF`, async () => {
        _setStoreForTest(new SessionStore({ enabled: false }));
        const session = createSession(`commandcode-terminal-plugin-${name}`);
        const source = heldStream([textLine, terminal, ignoredLine]);
        const { response, output, ends } = collector();
        await beforeEof(pipePluginJsonlWithStrip(source.stream, response, session), source);
        assert.equal(ends(), 1);
        assert.equal(source.cancelled(), true, "a terminal releases the upstream body");
        assert.equal(source.stream.locked, false);
        assert.equal(output(), textLine + "\n" + terminal + "\n");
        assert.equal(session.stats.inputTokens, name === "finish" ? 31 : 0);
        assert.equal(session.stats.outputTokens, name === "finish" ? 7 : 0);
        assert.equal(session.stats.cachedTokens, name === "finish" ? 13 : 0);
    });
}

test("CommandCode plugin terminal does not wait for a dump tee sibling to finish", async () => {
    const source = heldStream([textLine, finishLine]);
    const [forward, dump] = source.stream.tee();
    const { response, output, ends } = collector();
    await beforeEof(pipePluginJsonlWithStrip(forward, response), source, () => dump.cancel());
    assert.equal(ends(), 1);
    assert.equal(output(), textLine + "\n" + finishLine + "\n");
});

async function listen(server: http.Server): Promise<number> {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return (server.address() as AddressInfo).port;
}

async function close(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}

for (const injectTool of [true, false]) {
    test(`CommandCode HTTP ${injectTool ? "proxy loop" : "non-injected pipe"} completes while upstream withholds EOF`, { timeout: 15_000 }, async () => {
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const upstream = http.createServer((request, response) => {
            request.resume();
            request.on("end", () => {
                response.writeHead(200, { "content-type": "application/json" });
                response.write(textLine + "\n" + finishLine + "\n");
            });
        });
        const port = await listen(upstream);
        const proxy = await startServer({
            port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${port}`]: {} },
            modelEndpoints: [{ match: `http://127.0.0.1:${port}/alpha/generate`, wire: "commandcode" }],
            modelContextLimit: 200_000, kernelConfig: defaultConfig(200_000),
            compress: { injectTool, injectNudge: false }, promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
            autoUpdate: false, mitm: { enabled: false, domains: [] },
        } as ProxyOptions);
        if (!proxy.listening) await once(proxy, "listening");
        try {
            const response = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/bili/http://127.0.0.1:${port}/alpha/generate`, {
                method: "POST", signal: AbortSignal.timeout(5000),
                headers: { "content-type": "application/json", "x-acp-session": `commandcode-terminal-http-${injectTool}` },
                body: JSON.stringify({ params: { ...requestBody, messages: [{ role: "user", content: [{ type: "text", text: "Continue the task." }] }] } }),
            });
            assert.equal(response.status, 200);
            const lines = (await response.text()).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
            assert.deepEqual(lines.map(line => line.type), ["text-delta", "finish"]);
            assert.equal(lines[0].text, "Ready 海 🌊");
            assert.deepEqual(lines[1].totalUsage, { inputTokens: 31, outputTokens: 7, inputTokenDetails: { cacheReadTokens: 13 } });
        } finally {
            await close(proxy);
            await close(upstream);
        }
    });
}

test("CommandCode loop executes a proxy tool and fetches its continuation before the previous HTTP response ends", { timeout: 15_000 }, async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const requests: Array<Record<string, unknown>> = [];
    const call = JSON.stringify({ type: "tool-call", toolCallId: "status-call", toolName: "acp_status", input: {} });
    const upstream = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            response.writeHead(200, { "content-type": "application/json" });
            response.write((requests.length === 1 ? call : textLine) + "\n" + finishLine + "\n");
        });
    });
    const port = await listen(upstream);
    const signal = AbortSignal.timeout(5000);
    try {
        const url = `http://127.0.0.1:${port}/alpha/generate`;
        const initial = await fetch(url, { method: "POST", body: JSON.stringify(requestBody), signal });
        assert.ok(initial.body);
        const context: LoopCtx = {
            core: createCore(), config: defaultConfig(200_000),
            messages: [{ id: "request", role: "user", contentType: "text", text: "Continue the task." }],
            session: createSession("commandcode-terminal-loop"), protocol: "openai", visibilityMarkers: false, log: () => {},
        };
        const chunks: Buffer[] = [];
        for await (const chunk of runCompressLoop(initial.body, context, requestBody,
            { url, headers: {} }, createCommandcodeAdapter(requestBody), buildCompressSystemPrompt(), signal)) chunks.push(chunk);
        assert.equal(requests.length, 2, "the first finish releases the proxy tool and its HTTP continuation");
        const messages = requests[1].messages as Array<{ role: string; tool_call_id?: string; content?: string }>;
        const receipt = messages.find(message => message.role === "tool");
        assert.equal(receipt?.tool_call_id, "status-call");
        assert.ok(receipt?.content && receipt.content.length > 0);
        const lines = Buffer.concat(chunks).toString("utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
        assert.deepEqual(lines.map(line => line.type), ["text-delta", "finish"]);
        assert.equal(lines[0].text, "Ready 海 🌊");
    } finally {
        await close(upstream);
    }
});
