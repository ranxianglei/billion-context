// #4019: non-stream OpenAI chat-completions must run the same proxy-tool loop as
// the stream path. Before this fix the non-stream path ran a one-shot rewriter
// that understood ONLY compress — every other proxy-owned tool (acp_status /
// search_context / decompress / acp_cache) was passed to the client UNEXECUTED
// (finish_reason:"tool_calls") although the client never declared it, losing the
// model's answer for that turn. These tests pin the loop's three-way gate:
//   - proxy-only round  -> execute + re-request, client gets final text
//   - mixed round       -> surface proxy results, keep real tools, NO re-request
//   - real/no-tool round-> unchanged passthrough, NO re-request (negative gates)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, type Config, type CoreMessage } from "acp-kernel";
import { getSession } from "../src/session.ts";
import { compressLoopOpenaiJson } from "../src/compress-loop-openai.ts";

const UNUSED_URL = "https://unused.example/v1/chat/completions";
const JSON_HEADERS = { "content-type": "application/json" };

function makeCtx(sessionId: string, log: (m: string) => void) {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: getSession(sessionId),
        log,
    };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
    return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function openaiResponse(opts: { content?: string | null; toolCalls?: ReturnType<typeof toolCall>[]; finishReason?: string }): Record<string, unknown> {
    const message: Record<string, unknown> = { role: "assistant", content: opts.content ?? null };
    if (opts.toolCalls && opts.toolCalls.length > 0) message.tool_calls = opts.toolCalls;
    return { choices: [{ message, finish_reason: opts.finishReason ?? (opts.toolCalls?.length ? "tool_calls" : "stop") }] };
}

interface FetchHarness {
    restore(): void;
    count(): number;
    bodies: Record<string, unknown>[];
}

// Stub global fetch (fetchWithRetry falls through to it when no ALS transport is
// set) and serve a scripted queue of JSON responses for each re-request.
function installFetch(responses: Record<string, unknown>[]): FetchHarness {
    let calls = 0;
    const bodies: Record<string, unknown>[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        calls++;
        if (typeof init?.body === "string") bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        const payload = responses[calls - 1] ?? { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] };
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return {
        restore: () => { globalThis.fetch = prev; },
        count: () => calls,
        bodies,
    };
}

function choiceOf(out: Record<string, unknown>): { choice: Record<string, unknown>; message: Record<string, unknown> } {
    const choice = (out.choices as Array<Record<string, unknown>>)[0];
    return { choice, message: choice.message as Record<string, unknown> };
}

test("#4019 non-stream openai: proxy acp_status is executed + re-requested, client gets final text (no undeclared tool_calls)", async () => {
    const h = installFetch([openaiResponse({ content: "AFTER-TOOL-ANSWER", finishReason: "stop" })]);
    try {
        const out = await compressLoopOpenaiJson(
            openaiResponse({ content: null, toolCalls: [toolCall("call_1", "acp_status", {})] }),
            makeCtx("i4019-acp-status", () => {}),
            {},
            { messages: [{ role: "user", content: "please run acp_status" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        assert.equal(h.count(), 1, "exactly one upstream re-request");
        const { choice, message } = choiceOf(out);
        assert.equal(message.tool_calls, undefined, "client must NOT receive undeclared proxy tool_calls");
        assert.equal(choice.finish_reason, "stop");
        assert.match(String(message.content), /AFTER-TOOL-ANSWER/, "final model answer reaches the client");
        // The re-request carried the standard function-calling continuation.
        const msgs = h.bodies[0].messages as Array<Record<string, unknown>>;
        const assistantTurn = msgs.find((m) => m.role === "assistant");
        assert.ok(assistantTurn, "assistant turn appended to the re-request");
        const sentTc = (assistantTurn.tool_calls as Array<Record<string, unknown>>)[0];
        assert.equal((sentTc.function as Record<string, unknown>).name, "acp_status");
        const toolMsg = msgs.find((m) => m.role === "tool");
        assert.ok(toolMsg, "tool-result message appended to the re-request");
        assert.equal(toolMsg.tool_call_id, "call_1");
        // Raw executed result rides the tool message (matches the streaming loop,
        // core.ts:1300); the client-facing marker is stream-only.
        assert.ok(typeof toolMsg.content === "string" && toolMsg.content.length > 0, "executed proxy result fed back to the model");
    } finally {
        h.restore();
    }
});

test("#4019 non-stream openai: proxy search_context + decompress are executed + re-requested too", async () => {
    for (const [name, args] of [["search_context", { query: "flux" }], ["decompress", {}]] as const) {
        const h = installFetch([openaiResponse({ content: `DONE-${name}`, finishReason: "stop" })]);
        try {
            const out = await compressLoopOpenaiJson(
                openaiResponse({ content: null, toolCalls: [toolCall(`c_${name}`, name, args)] }),
                makeCtx(`i4019-${name}`, () => {}),
                {},
                { messages: [{ role: "user", content: `run ${name}` }] },
                { url: UNUSED_URL, headers: JSON_HEADERS },
            );
            assert.equal(h.count(), 1, `${name}: one re-request`);
            const { choice, message } = choiceOf(out);
            assert.equal(message.tool_calls, undefined, `${name}: no undeclared tool_calls leak`);
            assert.equal(choice.finish_reason, "stop");
            assert.match(String(message.content), new RegExp(`DONE-${name}`));
        } finally {
            h.restore();
        }
    }
});

test("#4019 negative gate: a REAL client-declared tool passes through unexecuted, no re-request", async () => {
    const h = installFetch([]);
    try {
        const out = await compressLoopOpenaiJson(
            openaiResponse({ content: null, toolCalls: [toolCall("c1", "get_weather", { city: "Paris" })] }),
            makeCtx("i4019-real-tool", () => {}),
            {},
            { messages: [{ role: "user", content: "weather?" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        assert.equal(h.count(), 0, "a real tool must NOT trigger a proxy re-request");
        const { choice, message } = choiceOf(out);
        const tcs = message.tool_calls as Array<Record<string, unknown>>;
        assert.equal(tcs.length, 1);
        assert.equal((tcs[0].function as Record<string, unknown>).name, "get_weather");
        assert.equal(choice.finish_reason, "tool_calls");
    } finally {
        h.restore();
    }
});

test("#4019 negative gate: a plain-text (no tool call) response round-trips unchanged, no re-request", async () => {
    const h = installFetch([]);
    try {
        const out = await compressLoopOpenaiJson(
            openaiResponse({ content: "hello world", finishReason: "stop" }),
            makeCtx("i4019-plain", () => {}),
            {},
            { messages: [{ role: "user", content: "hi" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        assert.equal(h.count(), 0);
        const { choice, message } = choiceOf(out);
        assert.equal(message.content, "hello world");
        assert.equal(message.tool_calls, undefined);
        assert.equal(choice.finish_reason, "stop");
    } finally {
        h.restore();
    }
});

test("#4019 mixed round: proxy + real tool -> proxy surfaced as text, only real tool kept, NO re-request", async () => {
    const h = installFetch([]);
    try {
        const out = await compressLoopOpenaiJson(
            openaiResponse({
                content: "checking",
                toolCalls: [toolCall("a1", "acp_status", {}), toolCall("w1", "get_weather", { city: "Paris" })],
            }),
            makeCtx("i4019-mixed", () => {}),
            {},
            { messages: [{ role: "user", content: "status + weather?" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        assert.equal(h.count(), 0, "mixed round must NOT re-request (mirrors the streaming gate)");
        const { choice, message } = choiceOf(out);
        const names = (message.tool_calls as Array<Record<string, unknown>>).map((t) => (t.function as Record<string, unknown>).name);
        assert.deepEqual(names, ["get_weather"], "only the real client tool is kept");
        assert.match(String(message.content), /acp_status result/, "proxy result surfaced as assistant text");
        assert.equal(choice.finish_reason, "tool_calls");
    } finally {
        h.restore();
    }
});

test("#4019 non-stream openai: compress is executed + re-requested so the model continues post-compress", async () => {
    const h = installFetch([openaiResponse({ content: "POST-COMPRESS-ANSWER", finishReason: "stop" })]);
    try {
        const out = await compressLoopOpenaiJson(
            openaiResponse({ content: null, toolCalls: [toolCall("c_cmp", "compress", {})] }),
            makeCtx("i4019-compress", () => {}),
            {},
            { messages: [{ role: "user", content: "compress please" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        assert.equal(h.count(), 1, "compress must trigger a re-request (pre-fix behavior stopped at finish=stop here)");
        const { choice, message } = choiceOf(out);
        assert.equal(message.tool_calls, undefined, "no undeclared proxy tool_calls leak");
        assert.equal(choice.finish_reason, "stop");
        assert.match(String(message.content), /POST-COMPRESS-ANSWER/, "model continues after compression");
    } finally {
        h.restore();
    }
});

// #539/#684: OpenAI-wire thinking models (DeepSeek et al.) 400 a re-request that
// drops the assistant turn's reasoning_content. The continuation must echo it back.
test("#4019 non-stream openai: reasoning_content rides the proxy-only continuation verbatim (#539 class)", async () => {
    const h = installFetch([openaiResponse({ content: "FINAL", finishReason: "stop" })]);
    try {
        const initial = openaiResponse({ content: null, toolCalls: [toolCall("call_r", "acp_status", {})] });
        const initialMessage = ((initial.choices as Array<Record<string, unknown>>)[0].message) as Record<string, unknown>;
        initialMessage.reasoning_content = "thinking out loud";
        await compressLoopOpenaiJson(
            initial,
            makeCtx("i4019-reasoning", () => {}),
            {},
            { messages: [{ role: "user", content: "status?" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        const msgs = h.bodies[0].messages as Array<Record<string, unknown>>;
        const assistantTurn = msgs.find((m) => m.role === "assistant");
        assert.ok(assistantTurn, "assistant turn appended to the re-request");
        assert.equal(assistantTurn.reasoning_content, "thinking out loud", "replayed assistant turn must echo reasoning_content back verbatim");
    } finally {
        h.restore();
    }
});
