import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, createInitialState, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";

// #4740: a pair range [tiny tool-call + oversized tool-result] under a window
// whose 0.6 chunk budget (0.6×16384 = 9830 tok) is SMALLER than the result
// (~13k tok) used to split into [call-only 64-char fragment][result]. The
// fragment's preview is atomically rejected by the kernel minCompressRange
// gate ("Total compressible content too small (64 chars …, min 5000)") — a
// guaranteed-rejected offer every round, and on the batch lane (one span per
// range) the range never folds at all. Reproduced live in gate:local
// (gate-1025, session pfa-b2e6ad642ba303ae: "64 chars"/"77 chars" rejections).
//
// Fix: splitChunks' minUnits floor applies in BOTH baseline regimes — a chunk
// below the min-chars floor is merged forward with the oversized message
// instead of being emitted as a standalone span.
//
// Discriminator: the summarization request must carry BOTH the call marker and
// the result marker (one coherent span), and no "too small" preview rejection
// may appear in the log.

const WINDOW = 16_384;
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the oversized tool result and its call were folded together as one coherent span. " +
    "All decisions and remaining work are preserved; no historical tool calls need repeating.";

const CALL_TEXT = `{"command":"MARKER_CALL_4740_open","pad":"xxxxxxxxxxxxxxxxxx"}`;
const RESULT_TEXT = (`MARKER_RESULT_4740_${"payload_".repeat(10)}\n`).repeat(880); // ≈52k chars ≈13k tok

function pairFixture(): { core: ReturnType<typeof createCore>; config: ReturnType<typeof defaultConfig>; messages: CoreMessage[]; session: Session } {
    const core = createCore();
    const config = defaultConfig(WINDOW, {
        preserveRecentMessages: 1,
        preserveRecentTokens: 2000,
        compress: { minCompressRange: 5000, maxSummaryLength: 20000, minSummaryLength: 50 },
    });
    const messages: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "U1 ".repeat(5000) },
        { id: "u2", role: "user", contentType: "text", text: "U2 ".repeat(5000) },
        { id: "call", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "c1", text: CALL_TEXT },
        { id: "result", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "c1", text: RESULT_TEXT },
        { id: "tail", role: "user", contentType: "text", text: "go on" },
    ];
    const turn = core.processTurn({ messages, state: createInitialState(), config: { ...config, modelContextLimit: WINDOW * 1000 }, tokenCount: 23_000, renderTags: "text-only" });
    const session: Session = {
        id: "issue4740-chunk-fragment", meta: {}, metadata: {}, state: turn.state,
        stats: { requests: 1, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 30_000, compressCreditTokens: 0, contextTokens: 30_000, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        pendingRetrievals: [],
        createdAt: Date.now(), lastSeen: Date.now(), blockContents: new Map(), inFlight: 0, persisted: false,
    };
    return { core, config, messages, session };
}

test("#4740: oversized-result pair range folds as ONE span — no call-only fragment preview rejection", async () => {
    const { core, config, messages, session } = pairFixture();
    const summaryBodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            summaryBodies.push(raw);
            if (raw.includes('"stream":true')) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
                    `data: ${JSON.stringify({ id: "cc1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
                res.end(chunk({ role: "assistant" }, null) + chunk({ content: SUMMARY_TEXT }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "cc2", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const port = (upstream.address() as { port: number }).port;

    const logs: string[] = [];
    const deps: PreflightDeps = {
        core, session, config, prompts: defaultPrompts, protocol: "openai",
        url: `http://127.0.0.1:${port}/v1/chat/completions`, headers: {}, model: "gpt-test",
        log: (_level, message) => { logs.push(message); },
    };
    try {
        const result = await preflightCompress(deps, messages);
        const rejections = logs.filter((l) => l.includes("preview rejected range"));
        assert.ok(
            !rejections.some((l) => l.includes("too small") || l.includes("compressible content")),
            `no guaranteed-rejected fragment preview (got: ${rejections.join(" | ") || "none"})`,
        );
        assert.equal(result.compressedRanges, 1, `the pair range must fold (got ${result.compressedRanges}; failure=${JSON.stringify(result.failure)})`);
        const summaryCall = summaryBodies.find((b) => b.includes("MARKER_RESULT_4740"));
        assert.ok(summaryCall, "a summarization call must carry the oversized result");
        assert.ok(summaryCall.includes("MARKER_CALL_4740_open"), "the span must be the COHERENT pair (call marker present), not a result-only fragment");
    } finally {
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
