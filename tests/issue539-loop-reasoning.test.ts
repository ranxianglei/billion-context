import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
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
//
// Facts these tests pin (verified against the unfixed loop):
//  - HISTORICAL assistant reasoning_content survives openaiToCore → processTurn →
//    the re-request rebuild verbatim; only the CURRENT round's reasoning was dropped.
//  - compress and acp_status share the same proxyResults append block in the loop,
//    so the one guard fix covers both. compress additionally runs
//    hideConsumedCompressCalls + refreshFolded, which keep `acp_loop_*` records
//    (including the reasoning record) and ride them on top of the fresh fold —
//    the compress path was never signature-safe either, it just usually emits no
//    reasoning before the mechanical call.

type WireMessage = Record<string, unknown>;
type WireToolCall = { function?: { name?: string } };

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

const SSEHeaders = { "content-type": "text/event-stream" };

// Re-request mock: respond(callIndex) lets tests script per-call statuses
// (e.g. a rejected first re-request to drive the degraded retry).
function reFetchProbe(respond: (n: number) => Response): { calls: () => number; bodies: () => string[]; restore: () => void } {
    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body) bodies.push(String(init.body));
        return respond(n);
    }) as typeof fetch;
    return { calls: () => n, bodies: () => bodies, restore: () => { globalThis.fetch = orig; } };
}

function findToolCallAssistant(rb: { messages: WireMessage[] }, toolName: string): WireMessage | undefined {
    return rb.messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && (m.tool_calls as WireToolCall[]).some((tc) => tc.function?.name === toolName));
}

// Mirror of server.prepareOpenai: openaiToCore → processTurn.
function prepare(body: Record<string, unknown>, session: Session) {
    const core = createCore();
    const config = defaultConfig(200000);
    const { msgs, systemText } = openaiToCore(body) as { msgs: CoreMessage[]; systemText: string };
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 100, renderTags: "text-only" });
    session.state = turn.state;
    return { core, config, processed: turn.messages, original: msgs, systemText };
}

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

// Round 1: DeepSeek emits reasoning_content then invokes the acp_status proxy tool.
const ROUND1_STATUS = [
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

test("#539: acp-loop re-request echoes reasoning_content on the proxy-tool assistant message (OpenAI/DeepSeek)", async () => {
    const session = makeSession();
    const { core, config, processed, systemText } = prepare(OPENAI_BODY, session);

    const probe = reFetchProbe(() => new Response(REFETCH_DONE, { status: 200, headers: SSEHeaders }));
    try {
        const adapter = createOpenaiAdapter(OPENAI_BODY, systemText);
        const ctx = { core, config, messages: processed, session, log: () => {}, protocol: "openai" as const };
        for await (const _c of runCompressLoop(new Response(ROUND1_STATUS, { status: 200 }).body!, ctx, OPENAI_BODY, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt(config))) { /* drain */ }
    } finally {
        probe.restore();
    }

    assert.ok(probe.calls() >= 1, "re-request must fire after the proxy tool");
    const rb = JSON.parse(probe.bodies()[0]) as { messages: WireMessage[] };
    const all = JSON.stringify(rb);

    const toolMsg = findToolCallAssistant(rb, "acp_status");
    assert.ok(toolMsg, "re-request must include the assistant message that called acp_status");
    assert.equal(toolMsg!.reasoning_content, "ROUND1-THINKING", "this round's reasoning_content must be echoed back on the tool-call assistant message");

    assert.ok(all.includes("HISTORICAL-REASONING-A"), "historical reasoning A preserved");
    assert.ok(all.includes("HISTORICAL-REASONING-B"), "historical reasoning B preserved");
});

test("#539 compress-variant: current-round reasoning_content survives hideConsumedCompressCalls + refreshFolded on the compress re-request", async () => {
    const session = makeSession();
    const big = (tag: string) => `${tag} ${"x".repeat(5000)}`;
    // The kernel protects the last 5 core messages AND the most recent ~5000
    // tokens (preserveRecentTokens, walked tail-backward). The four big messages
    // after the foldables soak that token budget, leaving m00001–m00002 — the two
    // foldable user payloads — safely outside the protected zone even after
    // openaiToCore splits each reasoning-bearing assistant wire message into
    // reasoning + text core messages.
    const body: Record<string, unknown> = {
        model: "deepseek-chat",
        stream: true,
        messages: [
            { role: "system", content: "You are helpful." },
            // The kernel ALWAYS keeps the first user message (prefix-cache anchor,
            // rebuildMessages firstUserIndex), so the seed occupies that slot and
            // the two foldables are ordinary compressible messages.
            { role: "user", content: "seed: audit the migration, then answer follow-ups." },
            { role: "user", content: big("FOLDABLE-ONE") },
            { role: "user", content: big("FOLDABLE-TWO") },
            { role: "assistant", content: big("OLD-ANSWER") },
            { role: "user", content: big("FOLLOWUP-DETAIL") },
            { role: "assistant", content: big("DETAIL-ANSWER") },
            { role: "user", content: big("LATER-QUESTION") },
            { role: "assistant", content: "short answer A", reasoning_content: "HIST-COMPRESS-A" },
            { role: "user", content: "and B?" },
            { role: "assistant", content: "short answer B", reasoning_content: "HIST-COMPRESS-B" },
            { role: "user", content: "compress the old stuff please" },
        ],
    };
    const { core, config, processed, original, systemText } = prepare(body, session);

    const compressArgs = JSON.stringify({ content: [{ startId: "m00002", endId: "m00003", summary: "SUMMARY-539-COMPRESS: fold the two old user payloads into one dense block." }] });
    const round1 = [
        chunk({ reasoning_content: "ROUND1-THINKING-COMPRESS" }, null),
        chunk({ tool_calls: [{ index: 0, id: "call_c1", type: "function", function: { name: "compress", arguments: compressArgs } }] }, null),
        chunk({}, "tool_calls", { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }),
        "data: [DONE]\n\n",
    ].join("");

    const probe = reFetchProbe(() => new Response(REFETCH_DONE, { status: 200, headers: SSEHeaders }));
    let refreshCalls = 0;
    // The loop does not run the kernel ref-assignment pipeline (in production the
    // proxy populates refs before the loop; processTurn alone left no usable map)
    // — mirror tests/loop-compress.test.ts withRefs so the compress range resolves.
    session.state.messageRefs = assignRefs(processed, { existing: emptyRefMap(), nextIndex: 0 }).map;
    try {
        const adapter = createOpenaiAdapter(body, systemText);
        const ctx = {
            core, config,
            messages: processed,
            session,
            log: () => {},
            protocol: "openai" as const,
            // Host mirror of server.ts refreshFolded: fresh fold from the ORIGINAL
            // messages with the post-compress state + this round's acp_loop_*
            // records riding on top.
            refreshFolded: (current: CoreMessage[]) => {
                refreshCalls++;
                const t = core.processTurn({ messages: original, state: session.state, config, tokenCount: 100, renderTags: "text-only" });
                session.state = t.state;
                const records = current.filter((m) => typeof m.id === "string" && m.id.startsWith("acp_loop_"));
                return [...t.messages, ...records];
            },
        };
        for await (const _c of runCompressLoop(new Response(round1, { status: 200 }).body!, ctx, body, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt(config))) { /* drain */ }
    } finally {
        probe.restore();
    }

    assert.ok(probe.calls() >= 1, "re-request must fire after compress");
    assert.equal(refreshCalls, 1, "compress succeeded and refreshFolded ran (otherwise the fold path is untested)");
    const rb = JSON.parse(probe.bodies()[0]) as { messages: WireMessage[] };
    const all = JSON.stringify(rb);

    const toolMsg = findToolCallAssistant(rb, "compress");
    assert.ok(toolMsg, "re-request must include the assistant message that called compress");
    assert.equal(toolMsg!.reasoning_content, "ROUND1-THINKING-COMPRESS", "current-round reasoning_content must ride on top of the refreshed fold, on the compress tool-call message");

    assert.ok(all.includes("HIST-COMPRESS-A"), "protected-tail historical reasoning A survives the fold");
    assert.ok(all.includes("HIST-COMPRESS-B"), "protected-tail historical reasoning B survives the fold");
    assert.ok(!all.includes("FOLDABLE-ONE"), "folded content is gone (refreshFolded actually re-folded)");
    assert.ok(all.includes("[Compressed m00002"), "compress tool-result rides on top of the fold");
});

// #539 follow-up: the degraded thinking-strip retry is scoped to Anthropic
// (core.ts re-request catch). On OpenAI/DeepSeek thinking mode reasoning_content
// is MANDATORY, so a stripped retry would guarantee another 400 plus a misleading
// error swap — the original rejection must propagate instead.
test("#539 follow-up: rejected re-request (non-transient 4xx, OpenAI) propagates — no thinking-strip retry outside Anthropic", async () => {
    const session = makeSession();
    const { core, config, processed, systemText } = prepare(OPENAI_BODY, session);

    // Body deliberately free of transient markers so fetchWithRetry fails fast;
    // any second request would have to come from the loop's degraded retry.
    const probe = reFetchProbe(() => new Response(JSON.stringify({ error: { message: "policy rejection, not transient" } }), { status: 400 }));
    let out = "";
    try {
        const adapter = createOpenaiAdapter(OPENAI_BODY, systemText);
        const ctx = { core, config, messages: processed, session, log: () => {}, protocol: "openai" as const };
        for await (const c of runCompressLoop(new Response(ROUND1_STATUS, { status: 200 }).body!, ctx, OPENAI_BODY, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt(config))) out += c.toString();
    } finally {
        probe.restore();
    }

    assert.ok(out.includes("upstream error 400"), `original 400 surfaces to the client as an in-stream error event: ${out.slice(0, 200)}`);
    assert.equal(probe.calls(), 1, "no degraded retry on OpenAI — stripping reasoning_content there guarantees another 400");
    const first = JSON.parse(probe.bodies()[0]) as { messages: WireMessage[] };
    assert.equal(findToolCallAssistant(first, "acp_status")!.reasoning_content, "ROUND1-THINKING", "the fix: the (only) re-request DOES carry reasoning_content");
});
