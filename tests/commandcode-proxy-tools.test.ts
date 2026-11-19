import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { createCommandcodeAdapter } from "../src/loop/adapter-commandcode.ts";
import { runCompressLoop, type LoopCtx, type ParsedStreamEvent } from "../src/loop/core.ts";

const PROXY_NAMES = ["acp_retire", "acp_restore", "acp_rewrite", "acp_cache"] as const;
const FINAL_TEXT = "CommandCode continued after the proxy tool receipt.";
const NEW_SUMMARY = "Keep the verified deployment decision and the remaining regression checks.";
const OLD_SUMMARY = "The deployment decision is verified. The original summary also includes repeated setup details and the remaining regression checks.";
const finishLine = JSON.stringify({ type: "finish", finishReason: "stop" });
const callLine = (name: string, input: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "tool-call", toolCallId: `call-${name}`, toolName: name, input });
const stream = (lines: string[]) => new Response(lines.join("\n") + "\n").body!;

async function parse(lines: string[], round = 1, absorbName?: string): Promise<ParsedStreamEvent[]> {
    const events: ParsedStreamEvent[] = [];
    const adapter = createCommandcodeAdapter({ model: "commandcode-test", messages: [] }, undefined, absorbName);
    for await (const event of adapter.parseStream(stream(lines), round)) events.push(event);
    return events;
}

for (const name of PROXY_NAMES) {
    test(`CommandCode classifies ${name} as proxy-owned in initial and continuation rounds`, async () => {
        for (const round of [1, 2]) {
            const events = await parse([callLine(name, { blockId: "b1" }), finishLine], round);
            const calls = events.filter(event => event.kind === "tool_call");
            assert.equal(calls.length, 1);
            assert.equal(calls[0].name, name);
            assert.equal(calls[0].passthrough, undefined);
            assert.equal(events.filter(event => event.kind === "meta").length, 0,
                "proxy-only rounds must not replay calls or finish frames to the client");
            const done = events.find(event => event.kind === "done");
            assert.ok(done);
            assert.ok(!done.suppressCompletion);
        }
    });
}

test("mixed CommandCode calls preserve real lines byte-for-byte and hide every proxy call", async () => {
    const realLines = [
        '{ "type": "tool-call", "toolCallId":"real-1", "toolName":"lookup", "input":{"q":"海 🌊"}, "extra":1 }',
        '{"type":"tool-call","toolCallId":"real-2","toolName":"acp_retire_local","input":{"blockId":"b1"}}',
    ];
    const events = await parse([realLines[0], ...PROXY_NAMES.map(name => callLine(name)), realLines[1], finishLine]);
    const calls = events.filter(event => event.kind === "tool_call");
    assert.equal(calls.length, 6);
    assert.deepEqual(calls.filter(call => call.passthrough).map(call => call.name), ["lookup", "acp_retire_local"]);
    const replayed = events.filter(event => event.kind === "meta").map(event => event.chunk.toString("utf8"));
    assert.deepEqual(replayed, [...realLines, finishLine].map(line => line + "\n"));
});

test("existing compress and configured absorb calls keep proxy-only handling", async () => {
    for (const name of ["compress", "custom_absorb"]) {
        const events = await parse([callLine(name), finishLine], 1, "custom_absorb");
        const calls = events.filter(event => event.kind === "tool_call");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].passthrough, undefined);
        assert.ok(!events.some(event => event.kind === "meta"));
    }
});

function context(name: string, enabled = true): LoopCtx {
    const now = Date.now();
    const ctx: LoopCtx = {
        core: createCore(),
        config: { ...defaultConfig(200_000), blockOps: { enabled } },
        messages: [{ id: "request", role: "user", contentType: "text", text: "Continue the task." }],
        session: {
            id: `commandcode-proxy-${name}-${enabled}`, meta: { protocol: "openai" },
            stats: { requests: 1, tokensSaved: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 50,
                cacheSamples: 1, lastInputTokens: 100, contextTokens: 100, compressCreditTokens: 0,
                retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {}, createdAt: now, lastSeen: now, state: createInitialState(),
            blockContents: new Map(), inFlight: 0, persisted: false, pendingRetrievals: [],
        },
        protocol: "openai", visibilityMarkers: false, log: () => {},
    };
    ctx.session.state.blocks.push({
        blockId: "b1", runId: "r0", tier: 1, topic: "deployment", summary: OLD_SUMMARY,
        directMessageIds: ["original"], effectiveMessageIds: ["original"], directBlockIds: [],
        compressedTokens: 4200, createdAt: now - 1000, survivedCount: 2, generation: "young", active: true,
        ...(name === "acp_restore" ? { retired: true } : {}),
    });
    ctx.session.blockContents.set("b1", { one: null, full: { text: "Original deployment transcript.", count: 1 } });
    return ctx;
}

interface UpstreamBody {
    messages: Array<{ role: string; content?: unknown; tool_call_id?: string;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>;
}

async function runLoop(name: string, input: Record<string, unknown>, ctx: LoopCtx) {
    const requests: UpstreamBody[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as UpstreamBody);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ type: "text-delta", text: FINAL_TEXT }) + "\n" + finishLine + "\n");
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    try {
        const requestBody = { model: "commandcode-test", stream: true, messages: [{ role: "user", content: "Continue the task." }] };
        const chunks: Buffer[] = [];
        for await (const chunk of runCompressLoop(
            stream([callLine(name, input), finishLine]), ctx, requestBody,
            { url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/alpha/generate`, headers: {} },
            createCommandcodeAdapter(requestBody), buildCompressSystemPrompt(),
        )) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf8");
        const events = raw.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
        return { requests, events, raw };
    } finally {
        upstream.closeAllConnections();
        await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    }
}

function assertProxyContinuation(result: Awaited<ReturnType<typeof runLoop>>, name: string, input: Record<string, unknown>) {
    assert.equal(result.requests.length, 1, "the real loop sends one HTTP continuation");
    const messages = result.requests[0].messages;
    const calls = messages.flatMap(message => message.tool_calls ?? []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, name);
    assert.equal(calls[0].id, `call-${name}`);
    assert.deepEqual(JSON.parse(calls[0].function.arguments), input);
    const receipts = messages.filter(message => message.role === "tool");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].tool_call_id, calls[0].id);
    assert.equal(typeof receipts[0].content, "string");
    return String(receipts[0].content);
}

function assertClientCompletion(result: Awaited<ReturnType<typeof runLoop>>) {
    assert.deepEqual(result.events.map(event => event.type), ["text-delta", "finish"],
        "only continuation text and one final completion reach the client, with no proxy tool calls");
    assert.equal(result.events[0].text, FINAL_TEXT);
    assert.doesNotMatch(result.raw, /^data:/m, "CommandCode output stays bare JSONL");
}

for (const name of PROXY_NAMES) {
    test(`CommandCode loop executes ${name} internally and emits only the final completion`, async () => {
        const ctx = context(name);
        const input = name === "acp_cache" ? { detail: "summary" }
            : name === "acp_rewrite" ? { blockId: "b1", summary: NEW_SUMMARY } : { blockId: "b1" };
        const originalContents = structuredClone(ctx.session.blockContents);
        const result = await runLoop(name, input, ctx);
        const receipt = assertProxyContinuation(result, name, input);
        const block = ctx.session.state.blocks[0];
        if (name === "acp_retire") {
            assert.equal(block.retired, true);
            assert.match(receipt, /b1 retired/);
        } else if (name === "acp_restore") {
            assert.equal(block.retired, false);
            assert.match(receipt, /b1 restored/);
        } else if (name === "acp_rewrite") {
            assert.equal(block.summary, NEW_SUMMARY);
            assert.equal(block.previousSummary, OLD_SUMMARY);
            assert.equal(typeof block.rewrittenAt, "number");
            assert.match(receipt, /b1 summary replaced/);
        } else {
            assert.match(receipt, /CACHE INVALIDATION/);
            assert.doesNotMatch(receipt, /acp_cache FAILED/);
            assert.equal(block.summary, OLD_SUMMARY);
            assert.equal(block.retired, undefined);
        }
        assert.deepEqual(ctx.session.blockContents, originalContents, "original transcript bytes are retained");
        assertClientCompletion(result);
    });
}

test("disabled block operations retain core dispatch gating and do not mutate blocks", async () => {
    const ctx = context("acp_retire", false);
    const originalBlocks = structuredClone(ctx.session.state.blocks);
    const input = { blockId: "b1" };
    const result = await runLoop("acp_retire", input, ctx);
    assert.equal(result.requests.length, 0, "the adapter must not enable an opt-in operation");
    assert.deepEqual(ctx.session.state.blocks, originalBlocks);
    assert.deepEqual(result.events.map(event => event.type), ["tool-call", "finish"]);
    assert.equal(result.events[0].toolName, "acp_retire");
    assert.deepEqual(result.events[0].input, input);
});

test("ordinary client tools still terminate without an internal HTTP continuation", async () => {
    const ctx = context("lookup");
    const result = await runLoop("lookup", { q: "deployment" }, ctx);
    assert.equal(result.requests.length, 0);
    assert.deepEqual(result.events.map(event => event.type), ["tool-call", "finish"]);
    assert.equal(result.events[0].toolName, "lookup");
    assert.equal(result.raw, callLine("lookup", { q: "deployment" }) + "\n" + finishLine + "\n");
    assert.equal(ctx.session.state.blocks[0].summary, OLD_SUMMARY);
});
