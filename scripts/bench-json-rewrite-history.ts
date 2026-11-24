import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import { createSession } from "../src/session.ts";
import { rewriteJsonResponseAsync, type RewriteCtx } from "../src/stream.ts";
import { rewriteOpenaiJsonResponseAsync } from "../src/stream-openai.ts";
import { rewriteResponsesJsonResponseAsync } from "../src/stream-responses.ts";
import { rewriteGoogleJsonResponseAsync } from "../src/stream-google.ts";

// Run in a fresh process for each revision and size, with the test env preload:
// node --import ./tests/preload-test-env.mjs --import tsx scripts/bench-json-rewrite-history.ts 8388608
const bytes = Number(process.argv[2] ?? 8 * 1024 * 1024);
if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("Expected a positive history byte count");
const messages: CoreMessage[] = [];
for (let remaining = bytes; remaining > 0;) {
    const length = Math.min(8192, remaining);
    messages.push({ id: `history-${messages.length}`, role: "assistant", contentType: "text", text: "x".repeat(length) });
    remaining -= length;
}
const ctx: RewriteCtx = {
    core: createCore(), config: defaultConfig(4_000_000), messages,
    session: createSession("json-rewrite-benchmark"), log: () => {},
};
const text = "The requested change is complete. Tests passed.";
const lanes = [
    { name: "anthropic", rewrite: rewriteJsonResponseAsync, body: { content: [{ type: "text", text }], stop_reason: "end_turn" } },
    { name: "openai", rewrite: rewriteOpenaiJsonResponseAsync, body: { choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] } },
    { name: "responses", rewrite: rewriteResponsesJsonResponseAsync, body: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], status: "completed" } },
    { name: "google", rewrite: rewriteGoogleJsonResponseAsync, body: { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] } },
];
const results = [];
for (const armed of [false, true]) {
    ctx.config.absorb!.enabled = armed;
    for (const lane of lanes) {
        const times: number[] = [];
        const digests = new Set<string>();
        for (let run = -2; run < 5; run++) {
            const body = structuredClone(lane.body);
            const started = performance.now();
            const result = await lane.rewrite(body, ctx);
            const elapsed = performance.now() - started;
            if (run >= 0) {
                times.push(elapsed);
                digests.add(createHash("sha256").update(JSON.stringify(result)).digest("hex"));
            }
        }
        if (digests.size !== 1) throw new Error("Output changed between samples");
        results.push({ protocol: lane.name, absorb: armed, timings_ms: times, median_ms: [...times].sort((a, b) => a - b)[2], digest: [...digests][0] });
    }
}
console.log(JSON.stringify({ node: process.version, bytes, messages: messages.length, warmups: 2, samples: 5, results, max_rss_kib: process.resourceUsage().maxRSS }));
