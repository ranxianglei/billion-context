/** node --import ./tests/preload-test-env.mjs --import tsx scripts/bench-block-content-reads.ts [blocks=5000] [repetitions=20] */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

const count = Number(process.argv[2] ?? 5000);
const repetitions = Number(process.argv[3] ?? 20);
if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(repetitions) || repetitions < 1) {
    throw new Error("Expected a nonnegative block count and positive repetition count");
}
const root = mkdtempSync(join(tmpdir(), "bili-block-read-bench-"));
process.env.BILI_CONFIG_FILE = join(root, "no-config.json");
const messages: NonNullable<LegacySessionLike["lastMessages"]> = Array.from({ length: count }, (_, i) => ({
    id: `message-${i}`, role: "user", contentType: "text", text: `source message ${i} ` + "retained original text ".repeat(16),
    ts: 1_700_000_000_000 + i,
}));
const blocks: LegacySessionLike["state"]["blocks"] = messages.map((message, i) => ({
    blockId: `b${i + 1}`, runId: "r1", tier: 1, summary: `summary ${i}`,
    directMessageIds: [message.id], effectiveMessageIds: [message.id], directBlockIds: [],
    compressedTokens: 10, createdAt: 1_700_000_000_000 + i, survivedCount: 0, generation: "young", active: true,
}));
const input: LegacySessionLike = {
    id: "block-read-benchmark", createdAt: 1_700_000_000_000, lastSeen: 1_700_000_001_000,
    meta: { protocol: "openai" }, stats: { requests: count }, metadata: {},
    state: { blocks, nextBlockId: count + 1, nextRunId: 2, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(blocks.map((block, i) => [block.blockId, {
        full: { text: messages[i].text!, count: 1 }, one: { text: `short view ${i}`, count: 1 },
    }])),
    lastMessages: messages, lastMessagesFolded: false,
};
const plan = planIngest(input);
plan.session.orphansJson = JSON.stringify({ orphan: { one: null, full: { text: "retained orphan", count: 1 } } });
const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const store = UnifiedStore.open(join(root, "index.db"));
try {
    store.ingestSession(plan, undefined, { completeLog: true });
    const methods: Record<string, () => unknown[]> = {
        full_blocks: () => store.getBlocks(input.id),
        paginated_contents: () => {
            const out = [];
            for (let offset = 0; ; offset += 128) {
                const page = store.getBlockContents(input.id, { limit: 128, offset });
                out.push(...page);
                if (page.length < 128) break;
            }
            return out;
        },
        decoded_map: () => [...store.getBlockContents(input.id)!],
    };
    const results: Record<string, { elapsedMs: number; cpuMs: number; outputSha256: string; rows: number }> = {};
    for (const [method, read] of Object.entries(methods)) {
        read();
        let output: unknown[] = [];
        const cpuStart = process.cpuUsage();
        const started = performance.now();
        for (let i = 0; i < repetitions; i++) output = read();
        const elapsedMs = performance.now() - started;
        const cpu = process.cpuUsage(cpuStart);
        assert.equal(output.length, count + (method === "decoded_map" ? 1 : 0));
        results[method] = { elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, outputSha256: sha256(output), rows: output.length };
    }
    console.log(JSON.stringify({
        node: process.version, blocks: count, repetitions, inputSha256: sha256(plan), results,
        measured: "complete public block-list, all 128-row content pages, and decoded-map reads; setup, one warmup per method, hashing and teardown excluded",
        peakRssKiB: process.resourceUsage().maxRSS,
    }));
} finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
}
