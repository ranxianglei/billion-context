/** node --import ./tests/preload-test-env.mjs --import tsx scripts/bench-active-block-count.ts [blocks=4000] [repetitions=10] */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { UnifiedStore } from "../src/storage/store.ts";

const count = Number(process.argv[2] ?? 4000);
const repetitions = Number(process.argv[3] ?? 10);
if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(repetitions) || repetitions < 1) {
    throw new Error("Expected a nonnegative block count and positive repetition count");
}
const root = mkdtempSync(join(tmpdir(), "bili-active-count-bench-"));
process.env.BILI_CONFIG_FILE = join(root, "no-config.json");
const messages: NonNullable<LegacySessionLike["lastMessages"]> = Array.from({ length: count }, (_, i) => ({
    id: `message-${i}`, role: "user", contentType: "text", text: `source message ${i} ` + "retained original text ".repeat(100),
    ts: 1_700_000_000_000 + i,
}));
const blocks: LegacySessionLike["state"]["blocks"] = messages.map((message, i) => ({
    blockId: `b${i + 1}`, runId: "r1", tier: 1, summary: `summary ${i}`,
    directMessageIds: [message.id], effectiveMessageIds: [message.id], directBlockIds: [],
    compressedTokens: 10, createdAt: 1_700_000_000_000 + i, survivedCount: 0, generation: "young", active: i % 4 !== 0,
}));
const input: LegacySessionLike = {
    id: "active-count-benchmark", createdAt: 1_700_000_000_000, lastSeen: 1_700_000_001_000,
    meta: { protocol: "openai" }, stats: { requests: count }, metadata: {},
    state: { blocks, nextBlockId: count + 1, nextRunId: 2, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(blocks.map((block, i) => [block.blockId, {
        full: { text: messages[i].text!, count: 1 }, one: { text: `short view ${i} ` + "one ".repeat(128), count: 1 },
    }])),
    lastMessages: messages, lastMessagesFolded: false,
};
const plan = planIngest(input);
const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let shadow: UnifiedShadow | null = null;
const store = UnifiedStore.open(join(root, "index.db"));
try {
    store.ingestSession(plan, undefined, { completeLog: true });
    shadow = UnifiedShadow.maybeOpen(root, { ...process.env, BILI_STORAGE_UNIFIED: "full" });
    assert.ok(shadow);
    shadow.activeBlockCount(input.id);
    const expected = blocks.filter(block => block.active).length;
    let output: number | null = null;
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    for (let i = 0; i < repetitions; i++) output = shadow.activeBlockCount(input.id);
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuStart);
    assert.equal(output, expected);
    console.log(JSON.stringify({
        node: process.version, blocks: count, repetitions, inputSha256: sha256(plan),
        elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, output,
        measured: "complete UnifiedShadow.activeBlockCount calls; real SQLite/CAS; setup, one warmup, hashing and teardown excluded",
    }));
} finally {
    shadow?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
}
