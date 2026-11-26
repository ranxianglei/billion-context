// #5957: non-stream Anthropic Messages must run the same proxy-tool loop as
// the stream path. Before this fix the non-stream path ran a one-shot rewriter
// that replaced each proxy tool_use with its receipt text and set
// stop_reason "end_turn" — a compress round ended the client turn with the
// receipt and the model never saw the fold result. These tests pin the loop's
// three-way gate on the Anthropic wire:
//   - proxy-only round  -> execute + re-request, client gets final text
//   - mixed round       -> NO re-request (the one-shot rewriter handles it)
//   - real/no-tool round-> unchanged passthrough, NO re-request (negative gates)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, type Config, type CoreMessage } from "acp-kernel";
import { getSession } from "../src/session.ts";
import { MAX_LOOP_ROUNDS } from "../src/loop/index.ts";
import { compressLoopAnthropicJson } from "../src/compress-loop-anthropic.ts";

const UNUSED_URL = "https://unused.example/v1/messages";
const JSON_HEADERS = { "content-type": "application/json", "anthropic-version": "2023-06-01" };

function makeCtx(sessionId: string, log: (m: string) => void) {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: getSession(sessionId),
        log,
    };
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
    return { type: "tool_use", id, name, input };
}

function anthropicResponse(blocks: Array<Record<string, unknown>>, stopReason?: string): Record<string, unknown> {
    return {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: blocks,
        stop_reason: stopReason ?? (blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
        usage: { input_tokens: 10, output_tokens: 5 },
    };
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
        const payload = responses[calls - 1] ?? anthropicResponse([{ type: "text", text: "" }]);
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return {
        restore: () => { globalThis.fetch = prev; },
        count: () => calls,
        bodies,
    };
}

function contentOf(out: Record<string, unknown>): Array<Record<string, unknown>> {
    return out.content as Array<Record<string, unknown>>;
}

test("#5957 non-stream anthropic: proxy acp_status is executed + re-requested, client gets final text (no undeclared tool_use)", async () => {
    const h = installFetch([anthropicResponse([{ type: "text", text: "AFTER-TOOL-ANSWER" }])]);
    try {
        const out = await compressLoopAnthropicJson(
            anthropicResponse([toolUse("call_1", "acp_status", {})]),
            makeCtx("i5957-acp-status", () => {}),
            {},
            { messages: [{ role: "user", content: "please run acp_status" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        assert.equal(h.count(), 1, "exactly one upstream re-request");
        const content = contentOf(out);
        assert.equal(content.find((b) => b.type === "tool_use"), undefined, "client must NOT receive undeclared proxy tool_use");
        assert.match(String(content[0]?.text), /AFTER-TOOL-ANSWER/, "final model answer reaches the client");
        // The re-request carried the assistant/tool_result continuation.
        const msgs = h.bodies[0].messages as Array<Record<string, unknown>>;
        const assistantTurn = msgs[msgs.length - 2];
        assert.equal(assistantTurn.role, "assistant", "assistant turn appended to the re-request");
        const sentBlock = (assistantTurn.content as Array<Record<string, unknown>>)[0];
        assert.equal(sentBlock.type, "tool_use");
        assert.equal(sentBlock.name, "acp_status");
        const userTurn = msgs[msgs.length - 1];
        assert.equal(userTurn.role, "user", "tool_result user turn appended to the re-request");
        const resultBlock = (userTurn.content as Array<Record<string, unknown>>)[0];
        assert.equal(resultBlock.type, "tool_result");
        assert.equal(resultBlock.tool_use_id, "call_1");
        assert.ok(typeof resultBlock.content === "string" && resultBlock.content.length > 0, "executed proxy result fed back to the model");
    } finally {
        h.restore();
    }
});

test("#5957 non-stream anthropic: proxy search_context + decompress are executed + re-requested too", async () => {
    for (const [name, input] of [["search_context", { query: "flux" }], ["decompress", { blockId: "b1" }]] as const) {
        const h = installFetch([anthropicResponse([{ type: "text", text: `DONE-${name}` }])]);
        try {
            const out = await compressLoopAnthropicJson(
                anthropicResponse([toolUse(`c_${name}`, name, { ...input })]),
                makeCtx(`i5957-${name}`, () => {}),
                {},
                { messages: [{ role: "user", content: `run ${name}` }] },
                { url: UNUSED_URL, headers: JSON_HEADERS },
            );
            assert.equal(h.count(), 1, `${name}: one re-request`);
            const content = contentOf(out);
            assert.equal(content.find((b) => b.type === "tool_use"), undefined, `${name}: no undeclared tool_use leak`);
            assert.match(String(content[0]?.text), new RegExp(`DONE-${name}`));
        } finally {
            h.restore();
        }
    }
});

test("#5957 negative gate: a REAL client-declared tool passes through unexecuted, no re-request", async () => {
    const h = installFetch([]);
    try {
        const initial = anthropicResponse([toolUse("c1", "get_weather", { city: "Paris" })]);
        const out = await compressLoopAnthropicJson(
            initial,
            makeCtx("i5957-real-tool", () => {}),
            {},
            { messages: [{ role: "user", content: "weather?" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        assert.equal(h.count(), 0, "a real tool must NOT trigger a proxy re-request");
        assert.deepEqual(out, initial, "response returned untouched for the one-shot rewriter");
    } finally {
        h.restore();
    }
});

test("#5957 negative gate: a plain-text (no tool call) response round-trips unchanged, no re-request", async () => {
    const h = installFetch([]);
    try {
        const initial = anthropicResponse([{ type: "text", text: "hello world" }]);
        const out = await compressLoopAnthropicJson(
            initial,
            makeCtx("i5957-plain", () => {}),
            {},
            { messages: [{ role: "user", content: "hi" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        assert.equal(h.count(), 0);
        assert.deepEqual(out, initial);
    } finally {
        h.restore();
    }
});

test("#5957 mixed round: proxy + real tool -> NO re-request, response left for the one-shot rewriter", async () => {
    const h = installFetch([]);
    try {
        const initial = anthropicResponse([
            { type: "text", text: "checking" },
            toolUse("a1", "acp_status", {}),
            toolUse("w1", "get_weather", { city: "Paris" }),
        ]);
        const out = await compressLoopAnthropicJson(
            initial,
            makeCtx("i5957-mixed", () => {}),
            {},
            { messages: [{ role: "user", content: "status + weather?" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        assert.equal(h.count(), 0, "mixed round must NOT re-request (mirrors the streaming gate)");
        assert.deepEqual(out, initial, "mixed response returned untouched (one-shot rewriter keeps real tools, converts proxy ones)");
    } finally {
        h.restore();
    }
});

test("#5957 two proxy calls in one round -> single re-request carrying both tool_results in order", async () => {
    const h = installFetch([anthropicResponse([{ type: "text", text: "BOTH-DONE" }])]);
    try {
        await compressLoopAnthropicJson(
            anthropicResponse([toolUse("s1", "search_context", { query: "flux" }), toolUse("d1", "decompress", { blockId: "b1" })]),
            makeCtx("i5957-twoway", () => {}),
            {},
            { messages: [{ role: "user", content: "both please" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        assert.equal(h.count(), 1, "two proxy calls in one round produce ONE re-request");
        const msgs = h.bodies[0].messages as Array<Record<string, unknown>>;
        const assistantBlocks = (msgs[msgs.length - 2].content as Array<Record<string, unknown>>);
        assert.deepEqual(assistantBlocks.map((b) => b.id), ["s1", "d1"], "assistant turn replays both tool_use blocks in order");
        const userBlocks = (msgs[msgs.length - 1].content as Array<Record<string, unknown>>);
        assert.deepEqual(userBlocks.map((b) => b.tool_use_id), ["s1", "d1"], "tool_results match their tool_use ids in order");
        assert.ok(userBlocks.every((b) => typeof b.content === "string" && b.content.length > 0), "each tool_result carries its executed result");
    } finally {
        h.restore();
    }
});

// KDD #10: signed thinking blocks are byte-verified on replay — the appended
// assistant turn must carry the original content verbatim, signature included.
test("#5957 signed thinking block rides the replayed assistant turn verbatim (KDD #10)", async () => {
    const h = installFetch([anthropicResponse([{ type: "text", text: "FINAL" }])]);
    try {
        const thinking = { type: "thinking", thinking: "pondering", signature: "sig-abc-123" };
        await compressLoopAnthropicJson(
            anthropicResponse([thinking, toolUse("call_r", "acp_status", {})]),
            makeCtx("i5957-thinking", () => {}),
            {},
            { messages: [{ role: "user", content: "status?" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        const msgs = h.bodies[0].messages as Array<Record<string, unknown>>;
        const assistantContent = msgs[msgs.length - 2].content as Array<Record<string, unknown>>;
        assert.deepEqual(assistantContent[0], thinking, "replayed assistant turn must echo the signed thinking block byte-for-byte");
        assert.equal(assistantContent[1].type, "tool_use");
    } finally {
        h.restore();
    }
});

// The compress receipt rides the tool_result (model-facing carrier), not the
// client-visible turn — the one-shot rewriter only ever sees terminal rounds.
test("#5957 compress executes via the same executor; receipt rides the tool_result, final text reaches the client", async () => {
    const h = installFetch([anthropicResponse([{ type: "text", text: "POST-COMPRESS-ANSWER" }])]);
    try {
        const out = await compressLoopAnthropicJson(
            anthropicResponse([toolUse("c_cmp", "compress", { content: [{ startId: "m00001", endId: "m00007", summary: "Early history.", topic: "Early" }] })]),
            makeCtx("i5957-compress", () => {}),
            {},
            { messages: [{ role: "user", content: "compress please" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        assert.equal(h.count(), 1, "compress must trigger a re-request (pre-fix behavior stopped at end_turn here)");
        const content = contentOf(out);
        assert.equal(content.find((b) => b.type === "tool_use"), undefined, "no undeclared tool_use leak");
        assert.match(String(content[0]?.text), /POST-COMPRESS-ANSWER/, "model continues after compression");
        const msgs = h.bodies[0].messages as Array<Record<string, unknown>>;
        const resultBlock = (msgs[msgs.length - 1].content as Array<Record<string, unknown>>)[0];
        // Empty session: the fold is refused, but the receipt still rides the
        // tool_result exactly as a successful one would.
        assert.match(String(resultBlock.content), /Compression FAILED/, "compress receipt fed back to the model");
    } finally {
        h.restore();
    }
});

// Gate discipline (#3617): the MAX_LOOP_ROUNDS limit gate ships with a row — a
// still-proxy-only response at the limit is NOT executed a second time; it is
// returned untouched so the one-shot rewriter performs the single execution
// (bounded degradation to the pre-fix shape).
test("#5957 limit gate: a still-proxy-only response at MAX_LOOP_ROUNDS defers to the one-shot rewriter", async () => {
    const proxyOnly = () => anthropicResponse([toolUse("c_loop", "acp_status", {})]);
    const h = installFetch(Array.from({ length: MAX_LOOP_ROUNDS }, proxyOnly));
    try {
        const out = await compressLoopAnthropicJson(
            proxyOnly(),
            makeCtx("i5957-limit", () => {}),
            {},
            { messages: [{ role: "user", content: "loop" }] },
            { url: UNUSED_URL, headers: JSON_HEADERS },
        );
        assert.equal(h.count(), MAX_LOOP_ROUNDS - 1, "rounds 1..N-1 execute+re-request; round N breaks at the limit without executing");
        assert.equal(contentOf(out)[0]?.type, "tool_use", "limit response stays proxy-only and unexecuted for the one-shot rewriter");
    } finally {
        h.restore();
    }
});
