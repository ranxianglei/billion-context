import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createCore, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { ConfiguredSummaryPlan } from "../src/external-summary-runtime.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { preflightCompress } from "../src/preflight.ts";
import { createSession } from "../src/session.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));
const SUMMARY = "The original task, agreed constraints, completed work and next steps are preserved in this compact fixture summary.";

for (const batch of [false, true]) for (const unknownBaseline of [true, false]) test(`preflight fold accounting stays linear in covered message IDs (batch=${batch}, unknown=${unknownBaseline})`, async (t) => {
    const count = 512;
    const messages: CoreMessage[] = Array.from({ length: count }, (_, i) => ({
        id: `raw-${i}`, role: i === 0 || i === count - 1 ? "user" : "assistant", contentType: "text",
        text: `${i}: ${"working context and concrete decisions ".repeat(25)}`,
    }));
    const core = createCore();
    const config = defaultConfig(1_000_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    config.compress.minCompressRange = 100;
    const session = createSession(`preflight-accounting-${batch}`);
    session.state = core.processTurn({ messages, state: session.state, config, tokenCount: 200_000, renderTags: "text-only" }).state;
    session.stats.lastInputTokens = 130_000;
    session.stats.requests = 1;
    const realProcessTurn = core.processTurn.bind(core);
    if (batch) core.processTurn = args => {
        const turn = realProcessTurn(args);
        if (turn.state.blocks.length > 0) return turn;
        const refs = turn.state.messageRefs.byRaw;
        const ranges = [[0, 254], [256, 509]].map(([a, z]) => ({
            startRef: refs[`raw-${a}`]!, endRef: refs[`raw-${z}`]!,
            count: z! - a! + 1, tokens: 60_000, chars: 240_000, toolPct: 0, textPct: 1,
        }));
        return { ...turn, nudge: { ...turn.nudge!, compressibleRanges: ranges } };
    };
    let coveredIdReads = 0;
    const realApply = core.applyCompression.bind(core);
    core.applyCompression = args => {
        const known = new Set(args.state.blocks.map(block => block.blockId));
        const result = realApply(args);
        for (const block of result.state.blocks) if (!known.has(block.blockId)) {
            block.effectiveMessageIds = new Proxy(block.effectiveMessageIds, {
                get(target, key, receiver) {
                    if (typeof key === "string" && /^\d+$/.test(key)) coveredIdReads++;
                    return Reflect.get(target, key, receiver);
                },
            });
        }
        return result;
    };
    let calls = 0;
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            calls++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ output_text: SUMMARY, choices: [{ message: { role: "assistant", content: SUMMARY }, finish_reason: "stop" }] }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const logs: string[] = [];
    try {
        const externalSummary = batch ? new ConfiguredSummaryPlan({ enabled: true, targets: [{ name: "fixture", protocol: "openai", url, model: "fixture", apiKey: "fake" }] }) : undefined;
        const result = await preflightCompress({ core, session, config, prompts: defaultPrompts, protocol: "responses", url, headers: {}, model: "fixture", unknownBaseline, compressionTarget: 5_000, externalSummary, log: (_level, line) => logs.push(line) }, messages);
        assert.equal(calls, batch ? 2 : 1, logs.join("\n"));
        assert.equal(result.fitsWindow, true, logs.join("\n"));
        assert.ok(result.payloadEstimate < 5_000, logs.join("\n"));
        assert.equal(result.compressedRanges, batch ? 2 : 1, logs.join("\n"));
        assert.ok(session.state.blocks.every(block => block.summary === SUMMARY));
        const expected = batch ? [messages.slice(0, 255), messages.slice(256, 510)] : [messages.slice(0, 511)];
        const coverage = session.state.blocks.map(block => [...block.effectiveMessageIds]);
        assert.deepEqual(coverage, expected.map(span => span.map(message => message.id)));
        t.diagnostic(JSON.stringify({ coveredIdReads, calls, result, coverage: coverage.map(ids => ids.length) }));
        assert.ok(coveredIdReads <= count * 100, `covered message IDs were visited ${coveredIdReads} times for ${count} messages`);
    } finally {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
    }
});
