/** Run with: node --import ./tests/preload-test-env.mjs --import tsx scripts/bench-storage-reactivation.ts [history=30000] [window=4000] [repetitions=10] */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { CoreMessage } from "acp-kernel";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

const history = Number(process.argv[2] ?? 30000);
const window = Number(process.argv[3] ?? 4000);
const repetitions = Number(process.argv[4] ?? 10);
if (![history, window, repetitions].every((n) => Number.isSafeInteger(n) && n > 0) || window > history) {
    throw new Error("Expected positive integer history, window <= history, and repetitions");
}

const root = mkdtempSync(join(tmpdir(), "bili-reactivation-bench-"));
process.env.BILI_CONFIG_FILE = join(root, "no-config.json");
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
const messages: CoreMessage[] = Array.from({ length: history }, (_, i) => ({
    id: "message-" + i, role: "user", contentType: "text", text: "retained transcript message " + i,
    ts: 1_700_000_000_000 + i,
}));
let requests = 0;
const session = (tail: CoreMessage[]): LegacySessionLike => ({
    id: "reactivation-benchmark", createdAt: 1_700_000_000_000, lastSeen: 1_700_000_001_000 + requests,
    meta: { protocol: "openai" }, stats: { requests: ++requests }, metadata: { pluginAgent: "proxy" },
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(), lastMessages: tail, lastMessagesFolded: false,
});
const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const store = UnifiedStore.open(join(root, "index.db"));
try {
    store.ingestSession(planIngest(session(messages)), undefined, { completeLog: true });
    const tail = messages.slice(-window);
    store.ingestSession(planIngest(session(tail)), undefined, { completeLog: true });
    for (let i = 0; i < 2; i++) store.ingestSession(planIngest(session(tail)), undefined, { completeLog: true });

    const cpuStart = process.cpuUsage();
    const started = performance.now();
    for (let i = 0; i < repetitions; i++) {
        store.ingestSession(planIngest(session(tail)), undefined, { completeLog: true });
    }
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuStart);
    const rows = store.getMessages("reactivation-benchmark", { includeRetired: true });
    const live = rows.filter((m) => m.retiredAt === null).length;
    if (rows.length !== history || live !== window) throw new Error("History or live-window count changed");
    const output = {
        rows: rows.map(({ retiredAt, ...row }) => ({ ...row, retired: retiredAt !== null })),
        session: store.getSessionRow("reactivation-benchmark"),
        watermark: store.ingestWatermark("reactivation-benchmark"),
        counts: store.counts(),
        content: store.contentDedupReport(),
    };
    console.log(JSON.stringify({
        node: process.version, history, window, repetitions,
        measured: "planIngest plus full ingestSession; fixture creation, two warmups, and output verification excluded",
        elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000,
        peakRssKiB: process.resourceUsage().maxRSS,
        inputSha256: sha256(messages), outputSha256: sha256(output), rows: rows.length, live,
    }));
} finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
}
