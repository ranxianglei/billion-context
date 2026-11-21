// Run with --import ./tests/preload-test-env.mjs --import tsx.
// Optional argument: module URL relative to this script (for a saved base).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { createSession } from "../src/session.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";

const { executeSearchContext, extractPlanState } = await import(
    new URL(process.argv[2] ?? "../src/decompress-shared.ts", import.meta.url).href
) as typeof import("../src/decompress-shared.ts");
const core = createCore();
const config = applyCompressSettings(defaultConfig(200_000), 200_000, {
    absorb: { enabled: true, minToolTokens: 50 },
    ccr: { enabled: true, minToolTokens: 50 },
}) as Config;
const session = createSession("plan-normalization-benchmark");
const messages: CoreMessage[] = Array.from({ length: 40 }, (_, i) => ({
    id: `history_${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text",
    text: `Historical detail ${i}. ${"retained context evidence. ".repeat(80)}`,
    timestamp: 1_700_000_000_000 + i,
}));
const turn = core.processTurn({ messages, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
session.state = turn.state;
const topics = ["auth", "storage", "validation", "refresh", "ratelimit 缓存路由会话", "metrics"];
applyRanges(parseCompressInput({ content: topics.map((topic, i) => ({
    startId: `m${String(i * 5 + 1).padStart(5, "0")}`,
    endId: `m${String(i * 5 + 5).padStart(5, "0")}`,
    topic: `token ${topic}`, summary: `Historical token ${topic} implementation and verification.`,
})) }), { core, config, messages: turn.messages, session, log: () => {} });
assert.equal(session.state.blocks.filter(b => b.active).length, 6);

function measure(work: () => string) {
    const expected = work();
    for (let i = 0; i < 3; i++) assert.equal(work(), expected);
    const elapsed: number[] = [];
    for (let i = 0; i < 15; i++) {
        const start = performance.now();
        const actual = work();
        elapsed.push(performance.now() - start);
        assert.equal(actual, expected);
    }
    elapsed.sort((a, b) => a - b);
    return {
        medianMs: elapsed[7], minMs: elapsed[0], maxMs: elapsed[14],
        digest: createHash("sha256").update(expected).digest("hex"),
    };
}

const languages = {
    latin: "Implement Ratelimit Middleware And Preserve Session Identity With Tests. ",
    cjk: "实现缓存路由并保留会话身份验证和回归测试。",
    mixed: "实现Cache路由API和Session身份Verification测试。",
};
for (const [language, sentence] of Object.entries(languages)) {
    for (const characters of [1000, 2000, 4000]) {
        const text = sentence.repeat(Math.ceil(characters / sentence.length)).slice(0, characters);
        const plan: CoreMessage[] = [
            { id: "user", role: "user", contentType: "text", text },
            { id: "plan", role: "assistant", contentType: "tool-call", toolName: "TodoWrite",
                text: JSON.stringify({ todos: [{ content: text, status: "in_progress", activeForm: "Implementing the plan" }] }) },
        ];
        const opts = { messages: plan, session, log: () => {}, protectedPatterns: config.protectedLatestTools };
        const search = () => executeSearchContext({ query: "token", limit: 5 }, core, session.state, undefined, opts).text;
        assert.match(search(), /\[plan-aware\]/);
        console.log(JSON.stringify({ language, characters, sources: plan.length, workload: "extract", ...measure(
            () => JSON.stringify([...extractPlanState(plan)!.terms]),
        ) }));
        console.log(JSON.stringify({ language, characters, sources: plan.length, workload: "search", ...measure(search) }));
    }
}
console.log(JSON.stringify({ workload: "plain-search", ...measure(
    () => executeSearchContext({ query: "token", limit: 5 }, core, session.state).text,
) }));
