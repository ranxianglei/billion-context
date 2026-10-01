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

// #1479: the #762 strict-echo repair was chat-completions-only — normalizeStrictEchoBody
// no-opped on Responses bodies (input[]) and prepareResponses never normalized, so a
// Responses-wire request whose assistant run lost its reasoning item across a compress
// fold was rejected by strict-echo gateways (reasoning_content_missing). Full arc driven
// here: main-path 400 learns the flag → the next main-path forward and the loop
// re-request (whose compress ack pair forms its own orphan run) both carry a blank
// reasoning item at each orphan run start.

interface Captured {
    level: string;
    msg: string;
}

type Item = Record<string, unknown>;

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const ERROR_BODY = JSON.stringify({
    error: { message: "The 'reasoning_content' in the thinking mode must be passed back to the API" },
});

const INPUT_ITEMS = [
    { type: "message", role: "user", content: "what is the weather" },
    { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "thinking about it" }] },
    { type: "message", role: "assistant", content: "let me check" },
    { type: "message", role: "user", content: "and tomorrow?" },
    { type: "function_call", call_id: "call-c1", name: "get_weather", arguments: "{}" },
    { type: "function_call_output", call_id: "call-c1", output: "sunny" },
    { type: "message", role: "assistant", content: "sunny tomorrow too" },
];

function sse(type: string, obj: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

function messageItemEvents(itemId: string, outputIndex: number, text: string): string {
    return [
        sse("response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item: { type: "message", id: itemId, role: "assistant", content: [] } }),
        sse("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: outputIndex, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: outputIndex, delta: text }),
        sse("response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: outputIndex, text }),
        sse("response.content_part.done", { type: "response.content_part.done", item_id: itemId, output_index: outputIndex, part: { type: "output_text", text } }),
        sse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item: { type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text }] } }),
    ].join("");
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

async function postStreamResponses(proxyPort: number, upstreamPort: number): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": "reloop-resp-1" },
        body: JSON.stringify({
            model: "gpt-test",
            input: INPUT_ITEMS,
            stream: true,
        }),
    });
}

const RUN_ITEM_TYPES = new Set(["reasoning", "function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"]);

function isRunItem(it: Item): boolean {
    if (RUN_ITEM_TYPES.has(String(it.type))) return true;
    return it.type === "message" && it.role === "assistant";
}

function isBlankReasoning(it: Item | undefined): boolean {
    if (!it || it.type !== "reasoning") return false;
    const sum = Array.isArray(it.summary) ? (it.summary as { text?: string }[]) : [];
    return sum.length > 0 && sum.every((s) => s.text === "");
}

function orphanRunCount(items: Item[]): number {
    let n = 0;
    let i = 0;
    while (i < items.length) {
        if (!isRunItem(items[i]!)) {
            i++;
            continue;
        }
        let calls = 0;
        let reasoning = 0;
        let j = i;
        while (j < items.length && isRunItem(items[j]!)) {
            const t = String(items[j]!.type);
            if (t === "function_call" || t === "custom_tool_call") calls++;
            else if (t === "reasoning") reasoning++;
            j++;
        }
        if (calls > 0 && reasoning === 0) n++;
        i = j;
    }
    return n;
}

test("#1479: responses-wire main path and loop re-request carry the blank strict-echo repair", async () => {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-reloop-resp-"));
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
            res.write(sse("response.created", { type: "response.created", response: { id: "resp-r1", status: "in_progress", output: [] } }));
            res.write(sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc-loop", call_id: "call-loop-1", name: "compress", arguments: "" } }));
            res.write(sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc-loop", delta: "{\"content\":[]}" }));
            res.write(sse("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: "fc-loop", arguments: "{\"content\":[]}" }));
            res.write(sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc-loop", call_id: "call-loop-1", name: "compress", arguments: "{\"content\":[]}" } }));
            res.write(sse("response.completed", { type: "response.completed", response: { id: "resp-r1", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 5 } } }));
        } else {
            res.write(sse("response.created", { type: "response.created", response: { id: "resp-r2", status: "in_progress", output: [] } }));
            res.write(messageItemEvents("msg-final", 0, "done"));
            res.write(sse("response.completed", { type: "response.completed", response: { id: "resp-r2", status: "completed", output: [], usage: { input_tokens: 200, output_tokens: 3 } } }));
        }
        res.end();
    });
    try {
        const resp1 = await postStreamResponses(proxyPort, upstreamPort);
        assert.equal(resp1.status, 400);
        await resp1.text();
        assert.ok(captured.some((l) => l.msg.includes("learned strictReasoningEcho")), "main-path learner must arm the flag");
        const in1 = (JSON.parse(seenBodies[0]!) as { input: Item[] }).input;
        assert.equal(orphanRunCount(in1), 1, "request 1 shipped the orphan run (the rejection)");

        const resp2 = await postStreamResponses(proxyPort, upstreamPort);
        assert.equal(resp2.status, 200);
        assert.match(resp2.headers.get("content-type") ?? "", /text\/event-stream/);
        const sseText = await resp2.text();
        assert.ok(sseText.includes("response.completed"), "client must receive the completed stream");

        assert.ok(n >= 3, `expected main + re-request upstream hits, saw ${n}`);
        const in2 = (JSON.parse(seenBodies[1]!) as { input: Item[] }).input;
        const c1Idx = in2.findIndex((it) => it.type === "function_call" && it.call_id === "call-c1");
        assert.ok(c1Idx > 0, "main-path body keeps the orphaned function_call");
        assert.ok(isBlankReasoning(in2[c1Idx - 1]), "main path injected the blank echo at the orphan run start");
        assert.equal(orphanRunCount(in2), 0, "main-path body carries no orphan runs");

        const reRequest = JSON.parse(seenBodies[2]!) as { model: string; input: Item[] };
        assert.equal(reRequest.model, "gpt-test");
        const loopFcIdx = reRequest.input.findIndex((it) => it.type === "function_call" && it.name === "compress");
        assert.ok(loopFcIdx > 0, "loop re-request carries the compress ack pair");
        let runStart = loopFcIdx;
        while (runStart > 0 && isRunItem(reRequest.input[runStart - 1])) runStart--;
        assert.ok(
            reRequest.input.slice(runStart, loopFcIdx + 1).some(isBlankReasoning),
            "loop re-request injected the blank echo into the run carrying the compress pair",
        );
        assert.equal(orphanRunCount(reRequest.input), 0, "loop re-request carries no orphan runs");
        assert.ok(
            captured.some((l) => l.msg.includes("[acp-loop]") && l.msg.includes("strict-echo-responses: injected")),
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
