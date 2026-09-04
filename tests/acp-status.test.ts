import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput, buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeCtx(messages: CoreMessage[]): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "acp-status-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: () => {},
    };
}

function withRefs(ctx: ReturnType<typeof makeCtx>): ReturnType<typeof makeCtx> {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

function makeCtx12(): ReturnType<typeof makeCtx> {
    const msgs: CoreMessage[] = [];
    for (let i = 1; i <= 12; i++) {
        msgs.push(textMsg(`raw_${i}`, i % 2 === 1 ? "user" : "assistant", "x".repeat(5000)));
    }
    return withRefs(makeCtx(msgs));
}

const COMPRESS_ARGS = JSON.stringify({ content: [{ startId: "m00001", endId: "m00006", summary: "ACP-STATUS-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });

function rangesSection(report: string): string {
    const idx = report.indexOf("Compressible ranges");
    return idx === -1 ? "" : report.slice(idx);
}

test("#389: acp_status after compress lists no already-compressed refs, without a new prepare", () => {
    const ctx = makeCtx12();
    const before = handleAcpStatus({}, ctx);
    assert.ok(rangesSection(before).includes("m00001"), "pre-compress report lists m00001 as compressible (fixture sanity)");

    const result = applyRanges(parseCompressInput(JSON.parse(COMPRESS_ARGS)), ctx);
    assert.ok(!result.startsWith("[Compression FAILED"), `compress succeeded (got: ${result.slice(0, 80)})`);
    assert.ok(ctx.session.state.blocks.some((b) => b.blockId === "b1" && b.active), "block b1 active after compress");

    // No new prepare between the compress and this status call — the exact
    // #389 scenario. The report must derive ranges/nudge from live state.
    const after = handleAcpStatus({}, ctx);
    assert.ok(after.includes("b1"), "base report shows the new active block");
    assert.ok(!rangesSection(after).includes("m00001"), "compressed refs must not reappear in Compressible ranges");
    assert.ok(!rangesSection(after).includes("m00006"), "compressed refs must not reappear in Compressible ranges");
    assert.ok(after.includes("Nudge: "), "Nudge line present and derived from live state");
});

test("#389: scope= short-circuit returns the live base report only", () => {
    const ctx = makeCtx12();
    const out = handleAcpStatus({ scope: "uncompressed" }, ctx);
    assert.ok(out.includes("UNCOMPRESSED"), "scope= base report present");
    assert.ok(!out.includes("Compressible ranges"), "scope= output carries no ranges section");
    assert.ok(!out.includes("Nudge:"), "scope= output carries no nudge line");
});

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function fcEvents(outputIndex: number, callId: string, name: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name }, output_index: outputIndex }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args }, output_index: outputIndex }),
    ].join("");
}

test("#389: same-turn loop — acp_status after compress in one round shows live ranges", async () => {
    const ctx = makeCtx12();
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", COMPRESS_ARGS),
        fcEvents(1, "call_s", "acp_status", "{}"),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ].join("");
    const refetch = sse("response.completed", { response: { id: "resp_refetch", status: "completed", output: [], usage: { input_tokens: 8000, output_tokens: 5 } } });
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(refetch, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    try {
        const chunks: Buffer[] = [];
        for await (const chunk of runCompressLoop(new Response(round1, { status: 200 }).body!, ctx, { model: "gpt-4o", input: [], stream: true }, { url: "http://mock", headers: {} }, createResponsesAdapter(), buildCompressSystemPrompt())) {
            chunks.push(chunk);
        }
        const out = Buffer.concat(chunks).toString("utf8");
        const markerIdx = out.indexOf("acp_status result:");
        assert.ok(markerIdx !== -1, "acp_status marker emitted");
        const statusPart = out.slice(markerIdx);
        assert.ok(statusPart.includes("Compressible ranges"), "responses loop acp_status now carries the ranges section");
        assert.ok(statusPart.includes("b1"), "status marker shows the newly created block");
        assert.ok(!statusPart.includes("m00001–m00006"), "compressed range must not be listed as compressible in the same-turn status");
    } finally {
        globalThis.fetch = orig;
    }
});
