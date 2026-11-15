// Run with the repository test/storage preloads and --expose-gc.
// Arguments: total messages, folded prefix, measured repetitions, text repeats.
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { createCore, defaultConfig, assignRefs, emptyRefMap, type CoreMessage } from "acp-kernel";
import { applyRanges, type RewriteCtx } from "../src/stream.js";
import { parseCompressInput } from "../src/compress-tool.js";
import { createSession } from "../src/session.js";

const total = Number(process.argv[2] ?? 12000);
const folded = Number(process.argv[3] ?? 8000);
const repeats = Number(process.argv[4] ?? 3);
const words = Number(process.argv[5] ?? 12);
const messages: CoreMessage[] = Array.from({ length: total }, (_, i) => ({
    id: `history_${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    contentType: "text",
    text: `Historical exchange ${i}: ${"retained context evidence. ".repeat(words)}`,
}));
const rows: Array<{ ms: number; cpuMs: number; digest: string; outcome: string; blocks: number; covered: number }> = [];
for (let repeat = 0; repeat <= repeats; repeat++) {
    const session = createSession(`fold-image-notes-${repeat}`);
    session.state.messageRefs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    const ctx: RewriteCtx = { core: createCore(), config: defaultConfig(2_000_000), messages, session, log: () => {} };
    const parsed = parseCompressInput({ content: [{ startId: "m00001", endId: `m${String(folded).padStart(5, "0")}`, summary: "Completed the historical work and retained the key decisions and results." }] });
    global.gc?.();
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    const result = applyRanges(parsed, ctx, { loopTracking: false });
    const ms = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    const blocks = session.state.blocks.map(({ blockId, summary, directMessageIds, effectiveMessageIds, compressedTokens }) => ({ blockId, summary, directMessageIds, effectiveMessageIds, compressedTokens }));
    if (result.outcome !== "applied" || blocks.length !== 1 || blocks[0].directMessageIds.length !== folded) {
        throw new Error(JSON.stringify({ result, blocks: blocks.map(b => ({ id: b.blockId, covered: b.directMessageIds.length })) }));
    }
    if (repeat > 0) rows.push({ ms, cpuMs: (cpu.user + cpu.system) / 1000, digest: createHash("sha256").update(JSON.stringify({ blocks, result })).digest("hex"), outcome: result.outcome, blocks: blocks.length, covered: blocks[0].directMessageIds.length });
}
process.stdout.write(JSON.stringify({ total, folded, inputBytes: Buffer.byteLength(JSON.stringify(messages)), rows, rssKiB: process.resourceUsage().maxRSS }) + "\n");
