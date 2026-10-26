import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, defaultPrompts, type Config, type CoreMessage } from "acp-kernel";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetForTest as resetRegistryForTest } from "../src/registry.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0, "each attempt releases its upstream idle timer");
    _resetFetchUtilForTest();
    resetRegistryForTest();
});

// #1819: a weak summarizer can regurgitate a verbose re-narration that EXCEEDS
// its own range. The old acceptance gate checked only the flat maxSummaryLength
// cap, so such output was applied as a successful fold and the rebuild landed
// LARGER than the preflight input (越压越大). The gate now rejects any candidate
// whose mass does not shrink its span (NET_SHRINK_TOLERANCE), routing it through
// the existing halving/skip path; the compress receipt additionally reports the
// net context change when a fold grows instead of shrinks.

type Attempted = { port: number; bodies: Array<Record<string, unknown>>; close: () => Promise<void> };

function startSummaryServer(replyText: string): Promise<Attempted> {
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            bodies.push(JSON.parse(raw) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: replyText } }] }));
        });
    });
    server.listen(0, "127.0.0.1");
    return new Promise((resolve) => {
        server.once("listening", () => {
            const { port } = server.address() as { port: number };
            resolve({ port, bodies, close: async () => { server.close(); server.closeIdleConnections?.(); await once(server, "close"); } });
        });
    });
}

function overflowMessages(): CoreMessage[] {
    return [
        { id: "first", role: "user", contentType: "text", text: "Keep the task goal and acceptance criteria." },
        { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(70000) },
        { id: "last", role: "user", contentType: "text", text: "Continue the task." },
    ];
}

test("#1819 preflight: a summary that exceeds its range is rejected, never folded", async () => {
    // Regurgitation fixture: ~100k tokens of pure repetition — far above any
    // span the cascade produces (largest ~60k × 1.05 tolerance).
    const regurgitated = "R".repeat(400_000);
    const attempted = await startSummaryServer(regurgitated);
    const session = getSession(`issue1819-${randomUUID()}`);
    const config = defaultConfig(100_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 }) as Config;
    // Disable the length cap so ONLY the monotonicity guard can reject —
    // otherwise #861's cap would mask the regression.
    config.compress.maxSummaryLength = 0;
    const logs: Array<[string, string]> = [];
    const deps: PreflightDeps = {
        core: createCore(), session, config,
        prompts: defaultPrompts, protocol: "openai",
        url: `http://127.0.0.1:${attempted.port}/v1/messages`,
        headers: {}, model: "weak-local-model",
        log: (level, msg) => { logs.push([level, msg]); },
    };
    try {
        const result = await preflightCompress(deps, overflowMessages());
        assert.equal(result.compressedRanges, 0, "no expanding fold may be accepted");
        assert.equal(session.state.blocks.length, 0, "no block may materialize from regurgitated output");
        // The oversized message is atomic: one span whose rendered content fans
        // out into sub-chunks via splitSummaryContent (~3 calls here). After the
        // assembled candidate is rejected the span cannot halve further (single
        // message), so the walk ends at the floor — bounded by design.
        assert.ok(attempted.bodies.length >= 3, `the cascade summarized the span before giving up (got ${attempted.bodies.length})`);
        assert.ok(result.failure, "preflight must fail fast instead of silently growing the payload");
        assert.equal(result.failure.kind, "exhausted");
        assert.match(result.failure.detail, /regurgitation/, `fail-fast carries the diagnosis: ${result.failure.detail}`);
        const rejections = logs.filter(([, msg]) => msg.includes("does not shrink its range"));
        assert.ok(rejections.length >= 1, "the rejection diagnosis is logged");
    } finally {
        await attempted.close();
    }
});

test("#1819 preflight: a genuinely shrinking summary still folds (no false rejection)", async () => {
    const compact = "SUMMARY: keep the task goal, exact acceptance criteria and next step; the repeated filler output is disposable.";
    const attempted = await startSummaryServer(compact);
    const session = getSession(`issue1819-${randomUUID()}`);
    const config = defaultConfig(100_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 }) as Config;
    config.compress.maxSummaryLength = 0;
    const logs: Array<[string, string]> = [];
    const deps: PreflightDeps = {
        core: createCore(), session, config,
        prompts: defaultPrompts, protocol: "openai",
        url: `http://127.0.0.1:${attempted.port}/v1/messages`,
        headers: {}, model: "weak-local-model",
        log: (level, msg) => { logs.push([level, msg]); },
    };
    try {
        const result = await preflightCompress(deps, overflowMessages());
        assert.equal(result.compressedRanges, 1, `a shrinking fold must land: ${JSON.stringify(result.failure ?? null)}`);
        assert.equal(session.state.blocks.length, 1);
        assert.ok(result.savedTokens > 0, "savings are real and reported");
        assert.ok(!logs.some(([, msg]) => msg.includes("[Net context change") || msg.includes("[No net shrink")),
            "a healthy fold must not carry the growth note");
    } finally {
        await attempted.close();
    }
});

// #2748 supersedes the #1819 manual-path honesty NOTE: a regurgitated (net-
// neutral/expanding) summary on the PLAIN compress path is now REFUSED before
// the state commits, so it neither creates a block nor re-pays the prefix
// cache — instead of committing and appending a "[Net context change]" note.
test("#2748 manual compress: an expanding fold is refused BEFORE commit (state + cache untouched)", () => {
    const core = createCore();
    const config = defaultConfig(200_000) as Config;
    config.compress.maxSummaryLength = 0;
    const session = getSession(`issue2748-${randomUUID()}`);
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({
            id: `h_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${String(i + 1).padStart(5, "0")}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(3000)}`,
        });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const logs: string[] = [];
    const ctx = { core, config, messages: turn.messages, session, log: (msg: string) => { logs.push(msg); } };

    // Regression guard: a genuinely shrinking fold MUST still land — the new
    // gate must not false-reject healthy folds.
    const healthy = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "First summary: messages 1-2 covered the initial phase in detail." }] }), ctx as never);
    assert.equal(healthy.outcome, "applied", `a shrinking fold must apply: ${healthy.text}`);
    assert.match(healthy.text, /~(\d[\d,]*) tokens saved/, `base line stays parseable: ${healthy.text}`);
    assert.ok(!healthy.text.includes("[Net context change") && !healthy.text.includes("[No net shrink"),
        `a shrinking fold claims savings without correction: ${healthy.text}`);
    assert.equal(session.state.blocks.length, 1, "the healthy fold materialized exactly one block");

    // Regurgitation fixture: a summary far larger than its own span — the
    // no-net-shrink case the gate must refuse before any state lands.
    const blocksBefore = session.state.blocks.length;
    const stateRefBefore = session.state;
    const bloated = applyRanges(parseCompressInput({ content: [{ startId: "m00003", endId: "m00004", summary: "R".repeat(40_000) }] }), ctx as never);
    assert.equal(bloated.outcome, "refused", `an expanding fold must be refused, not committed: ${bloated.text}`);
    assert.equal(bloated.reason, "gate:no-net-shrink", `machine-readable reason: ${bloated.reason}`);
    assert.equal(bloated.blocksCreated, 0, "no block is reported as created");
    assert.match(bloated.text, /Compression refused: no net shrink/, `refusal is explicit: ${bloated.text}`);
    assert.match(bloated.text, /Nothing was folded/, "the receipt states nothing was folded");
    assert.match(bloated.text, /Do not re-issue this same range and summary/, "guidance breaks the infinite-retry loop");
    assert.ok(!bloated.text.includes("[Compressed "), `no fake success line: ${bloated.text.slice(0, 120)}`);
    assert.equal(session.state.blocks.length, blocksBefore, "no new block materialized from the expanding fold");
    assert.equal(session.state, stateRefBefore, "state object uncommitted — prefix cache left untouched");
    assert.ok(logs.some((line) => line.includes("compress REFUSED")), "the refusal reaches the server log copy");
});

test("#2748 mixed batch: a net-negative batch is refused wholesale; a net-positive batch applies", () => {
    const core = createCore();
    const config = defaultConfig(200_000) as Config;
    config.compress.maxSummaryLength = 0;
    const session = getSession(`issue2748mix-${randomUUID()}`);
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({
            id: `h_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${String(i + 1).padStart(5, "0")}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(3000)}`,
        });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: (_msg: string) => {} };

    // Two spans, both carrying bloated summaries → aggregate net delta < 0.
    // The batch must be refused as a whole (not silently committed, not
    // misreported as a partial success).
    const negBatch = applyRanges(parseCompressInput({ content: [
        { startId: "m00001", endId: "m00002", summary: "R".repeat(20_000) },
        { startId: "m00003", endId: "m00004", summary: "R".repeat(20_000) },
    ] }), ctx as never);
    assert.equal(negBatch.outcome, "refused", `a net-negative batch must be refused: ${negBatch.text}`);
    assert.equal(negBatch.reason, "gate:no-net-shrink");
    assert.equal(negBatch.blocksCreated, 0);
    assert.equal(session.state.blocks.length, 0, "nothing committed from a net-negative batch");

    // Same spans, now with compact summaries → aggregate net delta > 0 → the
    // batch applies (the net-positive case keeps working end-to-end). The
    // refused batch above committed nothing, so m00001–m00004 are still live
    // and outside the protected recent zone.
    const posBatch = applyRanges(parseCompressInput({ content: [
        { startId: "m00001", endId: "m00002", summary: "Span 1-2 summarized briefly; filler is disposable." },
        { startId: "m00003", endId: "m00004", summary: "Span 3-4 summarized briefly; filler is disposable." },
    ] }), ctx as never);
    assert.equal(posBatch.outcome, "applied", `a net-positive batch must apply: ${posBatch.text}`);
    assert.ok((posBatch.blocksCreated ?? 0) >= 1, `at least one block landed: ${posBatch.text}`);
    assert.ok(session.state.blocks.length >= 1, "committed state gained block(s)");
});
