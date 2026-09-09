import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createCore, createInitialState, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { preflightCompress } from "../src/preflight.ts";
import type { Session } from "../src/session.ts";

process.env.NODE_ENV = "test";
const SUMMARY = "The preceding work is summarized here with all decisions and remaining tasks preserved for the next turn. No historical tool calls should be repeated.";

async function runCoveredRange(protectLatest = false, pairBoundary = false, unknownBaseline = false, segmentFailure?: "missing" | "over-limit", maxSummaryLength?: number) {
    const core = createCore();
    const config = defaultConfig(unknownBaseline ? 100000 : 272000);
    config.preserveRecentMessages = 5;
    config.preserveRecentTokens = 5000;
    config.compress.minCompressRange = 5000;
    if (segmentFailure === "over-limit") config.compress.maxSummaryLength = 200;
    if (maxSummaryLength !== undefined) config.compress.maxSummaryLength = maxSummaryLength;
    config.protectedTools = protectLatest ? ["large_result"] : [];
    const messages: CoreMessage[] = [
        { id: "early", role: "user", contentType: "text", text: "EARLY ".repeat(pairBoundary ? 1000 : 100) },
        { id: "covered", role: "assistant", contentType: "text", text: "HIDDEN_RAW ".repeat(80000) },
        ...Array.from({ length: 10 }, (_, i): CoreMessage => ({ id: `middle-${i}`, role: i % 2 ? "assistant" : "user", contentType: "text", text: `MIDDLE_${i} `.repeat(500) })),
        { id: "large-call", role: "assistant", contentType: "tool-call", toolName: "large_result", toolCallId: "large", text: "{}" },
        { id: "large-result", role: "tool", contentType: "tool-result", toolName: "large_result", toolCallId: "large", text: "LATEST_LARGE ".repeat(unknownBaseline ? 10000 : 90000) },
    ];
    const turn = core.processTurn({ messages, state: createInitialState(), config: { ...config, modelContextLimit: 27200000 }, tokenCount: 300000, renderTags: "text-only" });
    const coveredRef = turn.state.messageRefs.byRaw.covered;
    const compressed = core.applyCompression({ messages, state: turn.state, config: { ...config, preserveRecentMessages: 0, preserveRecentTokens: 0 }, ranges: [{ startRef: coveredRef, endRef: coveredRef, summary: SUMMARY }] });
    assert.equal(compressed.result.blocksCreated, 1);
    const session: Session = {
        id: "covered-preflight", meta: {}, metadata: {}, state: compressed.state,
        stats: { requests: 1, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: unknownBaseline ? 0 : 287565, compressCreditTokens: 0, contextTokens: 287565 },
        createdAt: Date.now(), lastSeen: Date.now(), blockContents: new Map(), inFlight: 0, persisted: false,
    };
    const summaries: string[] = [];
    let largeSegments = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: { content: string }[] };
            const content = body.input[0].content;
            summaries.push(content);
            res.setHeader("content-type", "application/json");
            if (content.includes("LATEST_LARGE")) largeSegments += 1;
            res.end(JSON.stringify({ output_text: segmentFailure === "missing" && content.includes("LATEST_LARGE") && largeSegments % 2 === 0 ? "" : SUMMARY }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const logs: string[] = [];
    try {
        const result = await preflightCompress({ core, session, config, prompts: defaultPrompts, protocol: "responses", url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, headers: {}, model: "test", unknownBaseline, log: (_level, message) => logs.push(message) }, messages);
        return { result, summaries, logs, session };
    } finally {
        const closed = once(upstream, "close");
        upstream.close();
        upstream.closeAllConnections();
        await closed;
    }
}

test("preflight skips fully covered raw chunks and relaxes unusable normal ranges to fold a large recent result", async () => {
    const { result, summaries, logs } = await runCoveredRange();
    assert.equal(result.fitsWindow, true, JSON.stringify(result));
    assert.ok(result.compressedRanges > 0);
    assert.ok(summaries.join("").includes("LATEST_LARGE ".repeat(90000)), "the complete tool result, including the pair-expanded tail, must reach the summarizer");
    assert.ok(summaries.every((content) => content.length <= Math.floor(272000 * 0.6) * 4), "each summary input obeys the chunk budget");
    assert.ok(summaries.every((content) => !content.includes("HIDDEN_RAW")), "covered raw chunks must not be resummarized by raw ref");
    assert.ok(logs.some((message) => message.includes("relaxing soft protection")));
    assert.ok(logs.every((message) => !message.includes("already covered")));
});

test("preflight keeps hard-protected tools excluded after unusable normal ranges", async () => {
    const { result, summaries } = await runCoveredRange(true);
    assert.equal(result.fitsWindow, false);
    assert.ok(summaries.every((content) => !content.includes("LATEST_LARGE")));
    assert.ok(summaries.length <= 16, "both protection regimes have bounded summary calls");
});


test("preflight summarizes the complete tool pair before the kernel consumes its expanded result boundary", async () => {
    const { result, summaries } = await runCoveredRange(false, true);
    assert.equal(result.fitsWindow, true);
    assert.ok(summaries.join("").includes("LATEST_LARGE ".repeat(90000)), "no tool-result tail may be folded without entering a summary request");
});

test("unknown-baseline preflight relaxes protection using the conservative upper bound", async () => {
    const { result, summaries } = await runCoveredRange(false, false, true);
    assert.equal(result.fitsWindow, true, JSON.stringify(result));
    assert.ok(summaries.join("").includes("LATEST_LARGE ".repeat(10000)));
});


for (const failure of ["missing", "over-limit"] as const) {
    test(`preflight does not apply an incomplete segmented summary (${failure})`, async () => {
        const { result, session } = await runCoveredRange(false, true, false, failure);
        assert.equal(result.fitsWindow, false);
        assert.ok(session.state.blocks.filter((block) => block.active).every((block) => !block.effectiveMessageIds.includes("large-result")), "the original tool result remains available when any summary part is missing or too long");
    });
}

for (const limit of [0, -1]) {
    test(`preflight accepts unlimited summary length (${limit})`, async () => {
        const { result } = await runCoveredRange(false, true, false, undefined, limit);
        assert.equal(result.fitsWindow, true);
        assert.ok(result.compressedRanges > 0);
    });
}
