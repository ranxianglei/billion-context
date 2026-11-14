/** node --import ./tests/preload-test-env.mjs --import tsx scripts/bench-session-removal.ts seed <fixture-dir> <sessions>
 *  node --import ./tests/preload-test-env.mjs --import tsx scripts/bench-session-removal.ts run <fixture-dir> <removals> */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../src/persist.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

const [mode, inputDir, amountText] = process.argv.slice(2);
const amount = Number(amountText);
if (!inputDir || !["seed", "run"].includes(mode) || !Number.isSafeInteger(amount) || amount < 1) {
    throw new Error("Expected seed|run, fixture directory, and positive integer session/removal count");
}
const fixture = resolve(inputDir);
process.env.BILI_CONFIG_FILE = join(fixture, "no-config.json");
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_STORAGE_JSON_WRITER = "0";

if (mode === "seed") {
    mkdirSync(fixture, { recursive: true });
    const db = UnifiedStore.open(join(fixture, "index.db"));
    try {
        for (let i = 0; i < amount; i++) {
            const s: LegacySessionLike = {
                id: `session-${String(i).padStart(6, "0")}`,
                createdAt: 1_700_000_000_000, lastSeen: 1_700_000_001_000,
                meta: { protocol: i % 2 ? "openai" : "anthropic", upstreamOrigin: "https://example.test/v1" },
                stats: { requests: 12, contextTokens: 12000, inputTokens: 1000, outputTokens: 500 },
                metadata: { note: "stored metadata ".repeat(64) },
                state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
                blockContents: new Map(), lastMessagesFolded: false,
                lastMessages: [
                    { id: `request-${i}`, role: "user", contentType: "text", text: `request ${i}`, ts: 1_700_000_000_000 },
                    { id: `reply-${i}`, role: "assistant", contentType: "text", text: `reply ${i}`, ts: 1_700_000_000_001 },
                ],
            };
            db.ingestSession(planIngest(s), undefined, { completeLog: true });
        }
        console.log(JSON.stringify({ sessions: db.listSessionIds().length, counts: db.counts() }));
    } finally { db.close(); }
} else {
    const root = mkdtempSync(join(tmpdir(), "bili-removal-bench-"));
    copyFileSync(join(fixture, "index.db"), join(root, "index.db"));
    const inputSha256 = createHash("sha256").update(readFileSync(join(fixture, "index.db"))).digest("hex");
    const store = new SessionStore({ dir: root, debounceMs: 0, log: () => {} });
    let closed = false;
    try {
        const catalog = UnifiedStore.open(join(root, "index.db"));
        let ids: string[];
        try { ids = catalog.listSessionIds().sort(); } finally { catalog.close(); }
        assert.ok(amount < ids.length, "leave one separate session for warmup");
        assert.deepEqual(await store.removeSession(ids.at(-1)!), { envelopeFound: false, unifiedHadRows: true });
        const results: Awaited<ReturnType<SessionStore["removeSession"]>>[] = [];
        const cpuStart = process.cpuUsage();
        const started = performance.now();
        for (let i = 0; i < amount; i++) results.push(await store.removeSession(ids[i]));
        const elapsedMs = performance.now() - started;
        const cpu = process.cpuUsage(cpuStart);
        for (const result of results) assert.deepEqual(result, { envelopeFound: false, unifiedHadRows: true });
        store.closeQuietly();
        closed = true;
        const raw = new DatabaseSync(join(root, "index.db"), { readOnly: true });
        try {
            const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
                .all() as { name: string }[];
            const digest = createHash("sha256");
            const counts: Record<string, number> = {};
            for (const { name } of tables) {
                const rows = raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
                counts[name] = rows.length;
                digest.update(name);
                for (const row of rows.map((value) => JSON.stringify(value)).sort()) digest.update(row);
            }
            assert.equal(counts.sessions, ids.length - amount - 1);
            console.log(JSON.stringify({
                node: process.version, sessions: ids.length, removals: amount,
                measured: "complete sequential removeSession calls; fixture copy, open, one warmup, and full database verification excluded",
                elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, peakRssKiB: process.resourceUsage().maxRSS,
                inputSha256, outputSha256: digest.digest("hex"), counts,
            }));
        } finally { raw.close(); }
    } finally {
        if (!closed) store.closeQuietly();
        rmSync(root, { recursive: true, force: true });
    }
}
