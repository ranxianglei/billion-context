import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

// #762 residual class, loop side: the compress-loop re-request is built by
// adapter.buildRequest from the kernel view, NOT through prepareOpenai, so the
// main-path strict-echo repair never touched it — a rebuilt re-request could
// still ship absent reasoning_content into a strict-echo session (the kernel
// round-trip drops blank echoes). Full arc driven here: main-path 400 learns
// the flag → model-issued compress call triggers a loop re-request whose body
// must carry the blank echo on the split tool-call turn.

interface Captured {
    level: string;
    msg: string;
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const ERROR_BODY = JSON.stringify({
    error: { message: "The 'reasoning_content' in the thinking mode must be passed back to the API" },
});

const CLIENT_MESSAGES = [
    { role: "user", content: "what is the weather" },
    { role: "assistant", content: "let me check", reasoning_content: "thinking about it" },
    { role: "user", content: "and tomorrow?" },
    { role: "assistant", content: "", tool_calls: [{ id: "tc-c1", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "tc-c1", content: "sunny" },
    { role: "user", content: "great" },
];

function sseChunk(id: string, delta: Record<string, unknown>, finishReason?: string, usage?: Record<string, number>): string {
    const chunk: Record<string, unknown> = {
        id,
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-test",
        choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    };
    if (usage) chunk.usage = usage;
    return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function startHarnessLoop(handler: (bodyText: string, res: http.ServerResponse) => void) {
    const upstream = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => handler(b, res));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await new Promise<void>((r) => proxy.on("listening", r));
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, upstream, proxyPort, upstreamPort };
}

async function postStreamChat(proxyPort: number, upstreamPort: number): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": "reloop-1" },
        body: JSON.stringify({
            model: "gpt-test",
            messages: CLIENT_MESSAGES,
            stream: true,
        }),
    });
}

function tcC1(bodyText: string): Record<string, unknown> | undefined {
    const body = JSON.parse(bodyText) as { messages: Record<string, unknown>[] };
    return body.messages.find((m) => Array.isArray(m.tool_calls) && (m.tool_calls as Record<string, unknown>[])[0]?.id === "tc-c1");
}

test("#762: loop re-request carries the blank strict-echo repair", async () => {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-reloop-"));
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    const seenBodies: string[] = [];
    let n = 0;
    const { proxy, upstream, proxyPort, upstreamPort } = await startHarnessLoop((bodyText, res) => {
        n += 1;
        seenBodies.push(bodyText);
        if (n === 1) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(ERROR_BODY);
            return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (n === 2) {
            res.write(sseChunk("c1", { role: "assistant" }));
            res.write(sseChunk("c1", { tool_calls: [{ index: 0, id: "tc-loop", type: "function", function: { name: "compress", arguments: "" } }] }));
            res.write(sseChunk("c1", { tool_calls: [{ index: 0, function: { arguments: "{\"content\":[]}" } }] }));
            res.write(sseChunk("c1", {}, "tool_calls"));
        } else {
            res.write(sseChunk("c2", { content: "done" }));
            res.write(sseChunk("c2", {}, "stop", { prompt_tokens: 10, completion_tokens: 2 }));
        }
        res.write("data: [DONE]\n\n");
        res.end();
    });
    try {
        const resp1 = await postStreamChat(proxyPort, upstreamPort);
        assert.equal(resp1.status, 400);
        await resp1.text();
        assert.ok(captured.some((l) => l.msg.includes("learned strictReasoningEcho")), "main-path learner must arm the flag");
        assert.ok(!("reasoning_content" in tcC1(seenBodies[0]!)!), "request 1 shipped the absent field (the rejection)");

        const resp2 = await postStreamChat(proxyPort, upstreamPort);
        assert.equal(resp2.status, 200);
        assert.match(resp2.headers.get("content-type") ?? "", /text\/event-stream/);
        const sseText = await resp2.text();
        assert.ok(sseText.includes("[DONE]"), "client must receive the completed stream");

        assert.ok(n >= 3, `expected main + re-request upstream hits, saw ${n}`);
        assert.equal(tcC1(seenBodies[1]!)!.reasoning_content, "", "main path normalized before forwarding request 2");
        const reRequest = JSON.parse(seenBodies[2]!) as { model: string };
        assert.equal(reRequest.model, "gpt-test");
        assert.equal(tcC1(seenBodies[2]!)!.reasoning_content, "", "loop re-request must carry the blank echo");
        assert.ok(
            captured.some((l) => l.msg.includes("[acp-loop]") && l.msg.includes("injected blank reasoning_content")),
            "loop-path normalization must log its repair",
        );
        assert.equal(
            captured.filter((l) => l.msg.includes("reasoning-pair-violated")).length,
            1,
            "sentinel fires exactly once (pre-repair only)",
        );
    } finally {
        await close(proxy);
        await close(upstream);
        setLogCapture(null);
        rmrf(stateDir);
    }
});
