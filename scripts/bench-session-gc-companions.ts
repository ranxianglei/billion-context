/** Run with: node --import ./tests/preload-test-env.mjs --import tsx scripts/bench-session-gc-companions.ts [sessions=5000] [companions=sessions] [sweeps=3] */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const count = Number(process.argv[2] ?? 5000);
const companions = Number(process.argv[3] ?? count);
const repetitions = Number(process.argv[4] ?? 3);
if (![count, companions, repetitions].every(Number.isSafeInteger)
    || count < 1 || companions < 0 || companions > count || repetitions < 1) {
    throw new Error("Expected positive sessions/sweeps and 0 <= companions <= sessions");
}
const root = mkdtempSync(join(tmpdir(), "bili-gc-bench-"));
const dir = join(root, "sessions");
process.env.BILI_CONFIG_FILE = join(root, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_SESSION_GC = "1";
process.env.BILI_SESSION_GC_MAX_AGE_DAYS = "7";
process.env.BILI_SESSION_GC_MAX_TOKENS = "1000000";
const { SessionStore } = await import("../src/persist.ts");
const { gcSessionFiles } = await import("../src/session-gc.ts");
const now = 1_800_000_000_000;
const day = 86_400_000;
const store = new SessionStore({ dir });
function digest(): string {
    const hash = createHash("sha256");
    for (const namespace of readdirSync(dir).sort()) {
        for (const name of readdirSync(join(dir, namespace)).sort()) {
            const file = join(dir, namespace, name);
            hash.update(relative(dir, file)).update("\0").update(readFileSync(file)).update("\0");
        }
    }
    return hash.digest("hex");
}
try {
    mkdirSync(join(dir, "openai"), { recursive: true });
    mkdirSync(join(dir, "_unknown"), { recursive: true });
    for (let i = 0; i < count; i++) {
        const stem = i.toString(16).padStart(32, "0");
        const session = join(dir, "openai", `api.example.com_${stem}.json`);
        writeFileSync(session, JSON.stringify({ version: 1, id: stem, savedAt: now, state: { blocks: [] }, contextTokens: 12 }));
        utimesSync(session, new Date(now), new Date(now));
        if (i < companions) {
            const companion = join(dir, "_unknown", `${stem}.content-store.json`);
            writeFileSync(companion, JSON.stringify({ version: 1, byHash: { h: `original-${i}` }, byRef: {} }));
            utimesSync(companion, new Date(now - 10 * day), new Date(now - 10 * day));
        }
    }
    const inputSha256 = digest();
    const options = { dir, store, now, imgRoot: join(root, "images") };
    const expected = { removed: 0, kept: count + companions, unreadable: 0, bytesFreed: 0, companionsRemoved: 0, imgDirsRemoved: 0 };
    assert.deepEqual(await gcSessionFiles(options), expected);
    const startCpu = process.cpuUsage();
    const start = performance.now();
    const results = [];
    for (let i = 0; i < repetitions; i++) results.push(await gcSessionFiles(options));
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(startCpu);
    for (const result of results) assert.deepEqual(result, expected);
    const outputSha256 = digest();
    assert.equal(outputSha256, inputSha256, "every path and content byte is retained");
    console.log(JSON.stringify({ node: process.version, sessions: count, companions, repetitions,
        measured: "full gcSessionFiles over real files; fixture setup, one warmup, and digest checks excluded",
        elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, peakRssKiB: process.resourceUsage().maxRSS,
        inputSha256, outputSha256, result: expected }));
} finally {
    store.closeQuietly();
    rmSync(root, { recursive: true, force: true });
}
