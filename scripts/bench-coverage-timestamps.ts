// Run from the repository root after building the kernel:
// node --import ./tests/preload-test-env.mjs --import ./tests/preload-storage-baseline.mjs \
//   --import tsx scripts/bench-coverage-timestamps.ts [messages=20000] [samples=5]
// Measures the public compression path, with timestamps on and persistence off.
// Fixture construction, hashing, and assertions are outside the timed region.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap, formatTagTime, type CoreMessage } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";

const count = Number(process.argv[2] ?? 20_000);
const samples = Number(process.argv[3] ?? 5);
assert.ok(Number.isSafeInteger(count) && count >= 40, "messages must be an integer >= 40");
assert.ok(Number.isSafeInteger(samples) && samples >= 1, "samples must be a positive integer");
const T0 = Date.UTC(2026, 8, 28, 7, 59, 9);
process.env.TZ = "UTC";
process.env.BILI_MESSAGE_TIMESTAMPS = "1";
_setStoreForTest(new SessionStore({ enabled: false }));

function fixture(size: number) {
    const messages: CoreMessage[] = Array.from({ length: size }, (_, i) => ({
        id: `raw${i}`, role: i % 2 ? "assistant" : "user", contentType: "text",
        text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
    }));
    const state = createInitialState();
    state.messageRefs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    state.tsStamps = Object.fromEntries(messages.map((message, i) => [message.id!, T0 + i * 1000]));
    const ctx: RewriteCtx = {
        core: createCore(), config: defaultConfig(20_000_000, { preserveRecentMessages: 5, preserveRecentTokens: 0 }),
        messages,
        session: {
            id: "coverage-time-bench", meta: {}, metadata: {}, state,
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            createdAt: T0, lastSeen: T0, blockContents: new Map(), inFlight: 0, persisted: false, pendingRetrievals: [],
        },
        log: () => {},
    };
    const folded = size - 10;
    const parsed = parseCompressInput({ content: [{
        startId: state.messageRefs.byRaw[messages[0].id!],
        endId: state.messageRefs.byRaw[messages[folded - 1].id!],
        summary: "A deterministic summary of the earlier conversation. ".repeat(3),
    }] });
    return { ctx, parsed, folded };
}

function run(size: number) {
    const { ctx, parsed, folded } = fixture(size);
    const cpu = process.cpuUsage();
    const start = performance.now();
    const result = applyRanges(parsed, ctx);
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    assert.ok(result.text.includes("full summary"), result.text);
    assert.ok(result.text.includes(`[${formatTagTime(T0)} – ${formatTagTime(T0 + (folded - 1) * 1000)}]`), "receipt includes the entire stamped coverage");
    assert.equal(ctx.session.state.blocks[0].effectiveMessageIds.length, folded);
    return {
        elapsedMs, cpuMs: (used.user + used.system) / 1000,
        sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    };
}

run(100);
run(100);
const results = Array.from({ length: samples }, () => run(count));
assert.equal(new Set(results.map((result) => result.sha256)).size, 1, "all receipts are byte-identical");
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({
    node: process.version, messages: count, coveredMessages: count - 10, samples,
    medianElapsedMs: median(results.map((result) => result.elapsedMs)),
    medianCpuMs: median(results.map((result) => result.cpuMs)), results,
}, null, 2));
