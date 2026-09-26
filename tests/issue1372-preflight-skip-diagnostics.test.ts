import assert from "node:assert/strict";
import test from "node:test";
import { createCore, createInitialState, defaultConfig, defaultPrompts, type CompressionCore, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";

// #1372: preflight used to die silently at several skip points (unresolvable
// refs, span without boundary ref, preview creating no block, empty render)
// and reported a hardcoded cause list in the fail-fast message. These tests
// pin the two shapes seen in the wild: a range batch that the plugin compress
// path accepts but whose preflight previews are ALL rejected (zero upstream
// calls, previously zero diagnostics), and a nudge range whose refs belong to
// another session generation (the #1365 brain-split shape).

const SUMMARY = "The preceding work is summarized here with all decisions and remaining tasks preserved for the next turn. No historical tool calls should be repeated.";

function makeOverflowFixture() {
    const core = createCore();
    const config = defaultConfig(272000);
    config.preserveRecentMessages = 5;
    config.preserveRecentTokens = 5000;
    config.compress.minCompressRange = 5000;
    const messages: CoreMessage[] = [
        { id: "early", role: "user", contentType: "text", text: "EARLY ".repeat(100) },
        { id: "covered", role: "assistant", contentType: "text", text: "HIDDEN_RAW ".repeat(80000) },
        ...Array.from({ length: 10 }, (_, i): CoreMessage => ({ id: `middle-${i}`, role: i % 2 ? "assistant" : "user", contentType: "text", text: `MIDDLE_${i} `.repeat(500) })),
        { id: "large-call", role: "assistant", contentType: "tool-call", toolName: "large_result", toolCallId: "large", text: "{}" },
        { id: "large-result", role: "tool", contentType: "tool-result", toolName: "large_result", toolCallId: "large", text: "LATEST_LARGE ".repeat(90000) },
    ];
    const turn = core.processTurn({ messages, state: createInitialState(), config: { ...config, modelContextLimit: 27200000 }, tokenCount: 300000, renderTags: "text-only" });
    const coveredRef = turn.state.messageRefs.byRaw.covered;
    const compressed = core.applyCompression({ messages, state: turn.state, config: { ...config, preserveRecentMessages: 0, preserveRecentTokens: 0 }, ranges: [{ startRef: coveredRef, endRef: coveredRef, summary: SUMMARY }] });
    assert.equal(compressed.result.blocksCreated, 1);
    const session: Session = {
        id: "issue1372-preflight", meta: {}, metadata: {}, state: compressed.state,
        stats: { requests: 1, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 287565, compressCreditTokens: 0, contextTokens: 287565 },
        createdAt: Date.now(), lastSeen: Date.now(), blockContents: new Map(), inFlight: 0, persisted: false,
    };
    return { core, config, messages, session };
}

test("#1372: preflight surfaces the kernel verdict when every preview is rejected, without calling upstream", async () => {
    const { core, config, messages, session } = makeOverflowFixture();
    // A min above maxSummaryLength (default 20000) makes the preview's dummy
    // summary violate the kernel's length gate: every range dies in the preview
    // stage, before any summarization call — exactly where #1372 died silently.
    config.compress.minSummaryLength = 30000;
    const logs: string[] = [];
    const deps: PreflightDeps = {
        core, session, config, prompts: defaultPrompts, protocol: "responses",
        // Port 9 (discard) refuses connections immediately: if preflight ever
        // spent a summarization call, this surfaces as "upstream", not "exhausted".
        url: "http://127.0.0.1:9/v1/chat/completions", headers: {}, model: "test",
        log: (_level, message) => { logs.push(message); },
    };
    const result = await preflightCompress(deps, messages);
    assert.equal(result.compressedRanges, 0, "nothing compressed");
    assert.equal(result.failure?.kind, "exhausted", `honest exhaustion, not an upstream call (got: ${JSON.stringify(result.failure)})`);
    const detail = result.failure?.detail ?? "";
    assert.match(detail, /no range could be compressed/i, detail);
    assert.ok(logs.some((l) => l.includes("preview rejected range") && l.includes("Summary too long")), `warn log must carry the kernel verdict (got: ${logs.join("\n")})`);
    assert.ok(detail.includes("Summary too long"), `failure detail must name the actual cause, not the old boilerplate (got: ${detail})`);
    assert.ok(!detail.includes("(each was below minCompressRange"), "stale boilerplate cause list must not appear when real reasons exist");
});

test("#1372: preflight names unresolvable nudge refs instead of reporting zero viable ranges", async () => {
    const { core, config, messages, session } = makeOverflowFixture();
    // The nudge cites refs from another session generation (brain-split shape,
    // #1365): they resolve to nothing in the current state's ref map.
    const rigged: CompressionCore = {
        ...core,
        processTurn: (input) => {
            const t = core.processTurn(input);
            if (!t.nudge) return t;
            return { ...t, nudge: { ...t.nudge, compressibleRanges: [{ startRef: "m99999", endRef: "m99998", count: 1, tokens: 5000, toolPct: 0, textPct: 1 }] } };
        },
    };
    const logs: string[] = [];
    const deps: PreflightDeps = {
        core: rigged, session, config, prompts: defaultPrompts, protocol: "responses",
        url: "http://127.0.0.1:9/v1/chat/completions", headers: {}, model: "test",
        log: (_level, message) => { logs.push(message); },
    };
    const result = await preflightCompress(deps, messages);
    assert.equal(result.compressedRanges, 0, "nothing compressed");
    assert.equal(result.failure?.kind, "exhausted", `honest exhaustion, not an upstream call (got: ${JSON.stringify(result.failure)})`);
    const detail = result.failure?.detail ?? "";
    assert.match(detail, /start ref m99999 is absent/i, `detail must name the unresolvable ref (got: ${detail})`);
    assert.ok(logs.some((l) => l.includes("skipping range m99999:m99998") && l.toLowerCase().includes("absent")), `warn log must record the skip point (got: ${logs.join("\n")})`);
    assert.equal(session.state.blocks.filter((b) => b.active).length, 1, "no blocks created or destroyed");
});
