import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import { openaiToCore } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #539: after a proxy tool (e.g. acp_status) executes, the loop RE-REQUESTS upstream
// so the model sees the tool result. On OpenAI/DeepSeek thinking mode the assistant
// message that called the tool MUST echo back its reasoning_content, else DeepSeek
// rejects the whole request with 400 invalid_request_error ("reasoning_content ...
// must be passed back"). The old guard skipped any segment lacking a signature —
// signatures are Anthropic-only, so every non-Anthropic round's reasoning vanished.

const OPENAI_BODY: Record<string, unknown> = {
    model: "deepseek-chat",
    stream: true,
    messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "what is 2+2?" },
        { role: "assistant", content: "4", reasoning_content: "HISTORICAL-REASONING-A" },
        { role: "user", content: "and 3*3?" },
        { role: "assistant", content: "9", reasoning_content: "HISTORICAL-REASONING-B" },
        { role: "user", content: "status please" },
    ],
};

function makeSession(): Session {
    return {
        id: "issue539-loop-test",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 100, contextTokens: 100 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function chunk(delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, unknown>): string {
    const o: Record<string, unknown> = {
        id: "c1", object: "chat.completion.chunk", created: 1, model: "deepseek-chat",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) o.usage = usage;
    return `data: ${JSON.stringify(o)}\n\n`;
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

// Kernel compress.minCompressRange is ~5000 chars; smaller ranges create no block.
const BIG = "x".repeat(5000);

// Round 1: DeepSeek emits reasoning_content then invokes the acp_status proxy tool.
const ROUND1 = [
    chunk({ reasoning_content: "ROUND1-THINKING" }, null),
    chunk({ tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "acp_status", arguments: "{}" } }] }, null),
    chunk({}, "tool_calls", { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }),
    "data: [DONE]\n\n",
].join("");

// Re-request mock returns a clean stop stream so round 2 terminates.
const REFETCH_DONE =
    chunk({ content: "ok done" }, null) +
    chunk({}, "stop", { prompt_tokens: 120, completion_tokens: 3, total_tokens: 123 }) +
    "data: [DONE]\n\n";

const COMPRESS_ARGS = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "SUMMARY-539: kickoff plus consumed span distilled into one dense block." }] });
const ROUND1_COMPRESS = [
    chunk({ reasoning_content: "ROUND1-THINKING-COMPRESS" }, null),
    chunk({ tool_calls: [{ index: 0, id: "call_c", type: "function", function: { name: "compress", arguments: COMPRESS_ARGS } }] }, null),
    chunk({}, "tool_calls", { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }),
    "data: [DONE]\n\n",
].join("");

function reFetchProbe(): { calls: () => number; bodies: () => string[]; restore: () => void } {
    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body) bodies.push(String(init.body));
        return new Response(REFETCH_DONE, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    return { calls: () => n, bodies: () => bodies, restore: () => { globalThis.fetch = orig; } };
}

test("#539: acp-loop re-request echoes reasoning_content on the proxy-tool assistant message (OpenAI/DeepSeek)", async () => {
    const core = createCore();
    const config = defaultConfig(200000);
    const session = makeSession();

    // Build processedMessages the way server.prepareOpenai does: openaiToCore -> processTurn.
    const { msgs, systemText } = openaiToCore(OPENAI_BODY) as { msgs: CoreMessage[]; systemText: string };
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 100, renderTags: "text-only" });
    session.state = turn.state;
    const processedMessages = turn.messages;

    const probe = reFetchProbe();
    try {
        const adapter = createOpenaiAdapter(OPENAI_BODY, systemText);
        const ctx = { core, config, messages: processedMessages, session, log: () => {}, protocol: "openai" as const };
        for await (const _c of runCompressLoop(new Response(ROUND1, { status: 200 }).body!, ctx, OPENAI_BODY, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt(config))) { /* drain */ }
    } finally {
        probe.restore();
    }

    assert.ok(probe.calls() >= 1, "re-request must fire after the proxy tool");
    const rb = JSON.parse(probe.bodies()[0]) as { messages: Array<Record<string, unknown>> };
    const all = JSON.stringify(rb);

    const toolMsg = rb.messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && (m.tool_calls as Array<Record<string, any>>).some((tc) => tc.function?.name === "acp_status"));
    assert.ok(toolMsg, "re-request must include the assistant message that called acp_status");
    assert.equal(toolMsg!.reasoning_content, "ROUND1-THINKING", "this round's reasoning_content must be echoed back on the tool-call assistant message");

    assert.ok(all.includes("HISTORICAL-REASONING-A"), "historical reasoning A preserved");
    assert.ok(all.includes("HISTORICAL-REASONING-B"), "historical reasoning B preserved");
});

test("#539: acp-loop re-request echoes reasoning_content AFTER a successful compress + fold refresh (OpenAI/DeepSeek)", async () => {
    const core = createCore();
    const config = defaultConfig(200000);
    const session = makeSession();
    // 7 messages: the kernel protects the last 5, so m00001/m00002 are compressible.
    const messages: CoreMessage[] = [
        textMsg("raw_1", "user", "task: audit files. " + BIG),
        textMsg("raw_2", "user", "consumed content " + BIG),
        textMsg("raw_3", "user", BIG),
        textMsg("raw_4", "assistant", BIG),
        textMsg("raw_5", "user", BIG),
        textMsg("raw_6", "assistant", BIG),
        textMsg("raw_7", "user", BIG),
    ];
    // The loop does not run the kernel ref-assignment pipeline; pre-populate the ref
    // map so resolveBoundaries finds m00001/m00002 and a real block is created.
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;

    const probe = reFetchProbe();
    let refreshCalls = 0;
    try {
        const adapter = createOpenaiAdapter(OPENAI_BODY, "You are helpful.");
        const ctx = {
            core, config, messages, session, log: () => {}, protocol: "openai" as const,
            refreshFolded: (current: CoreMessage[]): CoreMessage[] => {
                refreshCalls++;
                // Mirror server.ts refreshFolded: fresh post-compress fold + this
                // round's acp_loop_ records (reasoning/call/result) re-appended.
                const records = current.filter((m) => typeof m.id === "string" && m.id.startsWith("acp_loop_"));
                return [
                    textMsg("m00001", "user", "FRESH-FOLDED-VIEW-539 (old span folded away)"),
                    textMsg("m00003", "assistant", "recent tail"),
                    ...records,
                ];
            },
        };
        for await (const _c of runCompressLoop(new Response(ROUND1_COMPRESS, { status: 200 }).body!, ctx, OPENAI_BODY, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt(config))) { /* drain */ }
    } finally {
        probe.restore();
    }

    assert.ok(probe.calls() >= 1, "re-request must fire after the compress");
    const rb = JSON.parse(probe.bodies()[0]) as { messages: Array<Record<string, unknown>> };
    const all = JSON.stringify(rb);
    assert.equal(refreshCalls, 1, "refreshFolded called once for one successful compress");
    assert.ok(all.includes("FRESH-FOLDED-VIEW-539"), "re-request carries the refreshed post-compress fold");
    assert.ok(all.includes("ROUND1-THINKING-COMPRESS"), "this round's reasoning_content survives the compress + fold-refresh into the re-request");
});
