import { test } from "node:test";
import assert from "node:assert/strict";
import {
    ACP_TEXT_OPEN, ACP_TEXT_CLOSE,
    ACP_STATUS_OPEN, ACP_STATUS_CLOSE,
    ACP_SEARCH_OPEN, ACP_SEARCH_CLOSE,
    ACP_DECOMPRESS_OPEN, ACP_DECOMPRESS_CLOSE,
} from "acp-kernel";
import { extractResponsesTextTriggers } from "../src/compress-tool.ts";
import { compressLoopResponsesJson } from "../src/compress-loop-responses.ts";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore } from "acp-kernel";
import { getSession } from "../src/session.ts";

// #1439: the non-streaming Responses JSON loop kept a private extractTextTriggers
// that only recognized the compress tag, so acp_status / search_context /
// decompress triggers in a non-streaming response were ignored and leaked raw to
// the client while the streaming adapter executed them. Both paths share
// extractResponsesTextTriggers now; these tests pin that parity.

function makeCtx(log: (m: string) => void): Parameters<typeof compressLoopResponsesJson>[1] {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: getSession("fix-1439-session"),
        log,
        textProtocol: true,
    };
}

function jsonResponse(text: string): Record<string, unknown> {
    return {
        id: "resp_fix1439",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    };
}

const unusedOpts = { url: "https://unused.example/responses", headers: { "content-type": "application/json" } };

test("#1439: shared extractor recognizes all four Responses text triggers", () => {
    const text =
        `${ACP_TEXT_OPEN}m00001-m00005${ACP_TEXT_CLOSE} middle ` +
        `${ACP_STATUS_OPEN}${ACP_STATUS_CLOSE} ` +
        `${ACP_SEARCH_OPEN}quantum flux${ACP_SEARCH_CLOSE} ` +
        `${ACP_DECOMPRESS_OPEN}b3${ACP_DECOMPRESS_CLOSE}`;
    const r = extractResponsesTextTriggers(text);
    assert.equal(r.calls.length, 4);
    assert.deepEqual(
        new Set(r.calls.map((c) => c.name)),
        new Set(["compress", "acp_status", "search_context", "decompress"]),
    );
    const byName = Object.fromEntries(r.calls.map((c) => [c.name, c.arguments]));
    assert.equal(byName["search_context"], "quantum flux");
    assert.equal(byName["acp_status"], "{}");
    assert.ok(
        !r.clean.includes(ACP_STATUS_OPEN) && !r.clean.includes(ACP_SEARCH_OPEN) && !r.clean.includes(ACP_DECOMPRESS_OPEN),
        "non-compress triggers stripped from clean text",
    );
    assert.ok(r.clean.includes("middle"), "prose between triggers preserved");
});

test("#1439: non-streaming JSON executes + strips acp_status text trigger (stream parity)", async () => {
    let fetchCalls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(JSON.stringify({ id: "x", status: "completed", output: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
        const out = await compressLoopResponsesJson(
            jsonResponse(`status please ${ACP_STATUS_OPEN}${ACP_STATUS_CLOSE}`),
            makeCtx(() => {}),
            { model: "gpt-4o", input: [{ type: "message", role: "user", content: "status" }] },
            unusedOpts,
        );
        assert.equal(fetchCalls, 0, "read-only trigger must not re-request upstream");
        const joined = JSON.stringify(out.output);
        assert.ok(joined.includes("\u{1F4CA}"), "acp_status text trigger executed and marker surfaced");
        assert.ok(!joined.includes(ACP_STATUS_OPEN), "trigger tag stripped instead of leaked to the client");
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test("#1439: non-streaming JSON executes + strips search_context text trigger (stream parity)", async () => {
    let fetchCalls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(JSON.stringify({ id: "x", status: "completed", output: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
        const out = await compressLoopResponsesJson(
            jsonResponse(`find ${ACP_SEARCH_OPEN}{"query":"quantum flux"}${ACP_SEARCH_CLOSE} thanks`),
            makeCtx(() => {}),
            { model: "gpt-4o", input: [{ type: "message", role: "user", content: "search" }] },
            unusedOpts,
        );
        assert.equal(fetchCalls, 0, "read-only trigger must not re-request upstream");
        const joined = JSON.stringify(out.output);
        assert.ok(joined.includes("\u{1F50D}"), "search_context text trigger executed and marker surfaced");
        assert.ok(!joined.includes(ACP_SEARCH_OPEN), "trigger tag stripped instead of leaked to the client");
    } finally {
        globalThis.fetch = previousFetch;
    }
});
