import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetForTest as resetRegistryForTest } from "../src/registry.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));

// #1775: the summarization prompt never mentioned compress.maxSummaryLength,
// so verbose models produced over-cap assemblies that were discarded whole —
// the halving retry cannot help (summary length does not scale with input
// size on tool-dense spans), and the range was skipped after ~16 minutes of
// retries with zero output. These tests pin both halves of the fix:
//  1. each chunk's prompt carries a per-chunk character budget spread over
//     the chunks (minus the exact "\n\n" join gaps);
//  2. an over-cap assembly that is still shorter than the folded content is
//     truncated to the cap (line boundary + marker) instead of discarded.
const MAX_SUMMARY = 20000; // kernel default for compress.maxSummaryLength
const OVER = Array.from({ length: 300 }, (_, i) => `Line ${i}: decision D${i} kept; error E${i} noted; path /src/file${i}.ts`).join("\n");
assert.ok(OVER.length > MAX_SUMMARY && OVER.length < 400_000, "fixture summary must sit between the cap and the folded content size");

async function runLengthBudget(opts: { fillerRepeats: number; summaryText: string; maxSummaryLength?: number }) {
    const bodies: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            const body = JSON.parse(raw);
            bodies.push(body);
            assert.equal(body.stream, false, "fixture relies on the non-stream summary path");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: opts.summaryText } }] }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };

    const session = getSession(`summary-budget-${randomUUID()}`);
    const config = defaultConfig(100_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    if (opts.maxSummaryLength !== undefined) config.compress.maxSummaryLength = opts.maxSummaryLength;
    // Measured baseline above the window: deterministic loop trigger in the
    // token-estimate regime regardless of how the payload estimate lands.
    // #1492: the floor only applies to usage-grade baselines, so the source
    // must be marked accordingly.
    session.stats.lastInputTokens = 150_000;
    session.stats.lastInputTokensSource = "usage";
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the task goal." },
        { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(opts.fillerRepeats) },
        { id: "last", role: "user", contentType: "text", text: "Continue the task." },
    ];
    const deps: PreflightDeps = {
        core: createCore(), session, config, prompts: defaultPrompts, protocol: "openai",
        url: `http://127.0.0.1:${port}/v1/messages`, headers: {}, model: "test-model",
        log: (_level, message) => logs.push(message),
    };
    try {
        const result = await preflightCompress(deps, messages);
        return { result, session, bodies, logs };
    } finally {
        server.close();
        await once(server, "close");
    }
}

function systemOf(body: Record<string, unknown>): string {
    const messages = body.messages as Array<{ role: string; content: string }>;
    const system = messages.find((m) => m.role === "system");
    assert.ok(system, "summary call carries the system prompt");
    return system.content;
}

test("#1775 summarizeRange prompt carries a per-chunk length budget spread across the chunks", async () => {
    // 420K chars ≈ 105K tokens vs a 60K-token chunk budget → 2 chunks →
    // budget floor((20000 - 1*2) / 2) = 9999 per chunk.
    const two = await runLengthBudget({ fillerRepeats: 60000, summaryText: "A dense tier-1 summary line that stays comfortably inside any per-chunk character budget." });
    assert.ok(two.bodies.length >= 2, "the oversized filler splits into multiple text chunks");
    const expectedTwo = Math.floor((MAX_SUMMARY - (two.bodies.length - 1) * 2) / two.bodies.length);
    for (const b of two.bodies) {
        assert.ok(systemOf(b).includes(`AT MOST ${expectedTwo} characters`), "every chunk call carries the spread per-chunk budget");
    }
    // 105K chars ≈ 26K tokens < 60K-token budget → single chunk → full cap.
    const one = await runLengthBudget({ fillerRepeats: 15000, summaryText: "A dense tier-1 summary line that stays comfortably inside any per-chunk character budget." });
    assert.equal(one.bodies.length, 1, "small filler stays one chunk");
    assert.ok(systemOf(one.bodies[0]).includes(`AT MOST ${MAX_SUMMARY} characters`), "single chunk gets the full cap");
});

test("#1775 an over-limit assembled summary is truncated to the cap instead of discarding the range", async () => {
    const { result, session, logs } = await runLengthBudget({ fillerRepeats: 60000, summaryText: OVER });
    assert.equal(result.failure, undefined, JSON.stringify(result));
    assert.equal(result.compressedRanges, 1, "the range folds with its rescued summary");
    assert.equal(result.fitsWindow, true);
    const block = session.state.blocks.find((b) => b.active && b.effectiveMessageIds.includes("large"));
    assert.ok(block, "the oversized message is consumed into a block");
    assert.ok(block!.summary.length <= MAX_SUMMARY, `rescued summary respects the cap (got ${block!.summary.length})`);
    assert.ok(block!.summary.endsWith("[truncated]"), block!.summary.slice(-80));
    assert.ok(block!.summary.startsWith(OVER.slice(0, 100)), "truncation preserves the summary prefix");
    assert.ok(logs.some((m) => m.includes("exceeded maxSummaryLength") && m.includes("truncated to")), logs.join("\n"));
});

test("#1775 no rescue when the summary is not shorter than the folded content", async () => {
    // The model expanded the text instead of condensing it: truncating would
    // keep only a fragment of what was already longer than the original, so
    // the old discard behavior must hold.
    const { result, session } = await runLengthBudget({ fillerRepeats: 60000, summaryText: "x\n".repeat(300_000) });
    assert.equal(result.compressedRanges, 0, "no fold may be applied");
    assert.equal(result.fitsWindow, false);
    assert.equal(result.failure?.kind, "exhausted", JSON.stringify(result.failure));
    assert.ok(session.state.blocks.every((b) => !b.effectiveMessageIds.includes("large")), "the original message remains available");
});

test("#1775 a disabled cap (maxSummaryLength = 0) keeps the unlimited behavior", async () => {
    const { result, session, bodies } = await runLengthBudget({ fillerRepeats: 60000, summaryText: OVER, maxSummaryLength: 0 });
    for (const b of bodies) {
        assert.ok(!systemOf(b).includes("LENGTH BUDGET"), "no budget instruction when the cap is disabled");
    }
    assert.equal(result.compressedRanges, 1);
    const block = session.state.blocks.find((b) => b.active && b.effectiveMessageIds.includes("large"));
    assert.ok(block, "the oversized message is folded");
    assert.equal(block!.summary, `${OVER}\n\n${OVER}`, "the assembly passes through unmodified when the cap is disabled");
});
