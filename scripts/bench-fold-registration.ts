// Run from the repository root with the test environment/storage preloads and
// `node --import tsx scripts/bench-fold-registration.ts`. Compare independent
// processes on the base and patched revisions, alternating their order. Only
// recordCacheFoldsFromBlocks is timed; fixture construction and complete
// ledger/report checksums are outside that interval.
import { createHash } from "node:crypto";
import { mock } from "node:test";
import type { CompressionBlock } from "acp-kernel";
import { buildSessionCacheReport, getCacheLedger, recordCacheFoldsFromBlocks } from "../src/cache-ledger.ts";
import { createSession } from "../src/session.ts";

const T0 = Date.parse("2026-11-01T00:00:00Z");
// Keep the report's generatedAt field comparable without omitting any field.
mock.method(Date, "now", () => T0);

function block(id: number): CompressionBlock {
    return {
        blockId: `b${id}`, runId: "fold-benchmark", tier: 1,
        summary: `retained summary ${id}`, startRef: "m00001", endRef: "m00001",
        directMessageIds: ["raw-1"], effectiveMessageIds: ["raw-1"], directBlockIds: [],
        compressedTokens: 1_000 + id, createdAt: T0 + id, survivedCount: 0,
        generation: "young", active: true,
    };
}

function checksum(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const cases = [["cold-batch", 0, 6_000], ["long-history-batch", 6_000, 6_000], ["one-fold", 6_000, 1], ["short-batch", 0, 3]] as const;
function runCase([name, prior, added]: typeof cases[number]) {
    const session = createSession(`bench-${name}`);
    session.state.messageRefs.byRef = { m00001: "raw-1" };
    session.state.messageRefs.byRaw = { "raw-1": "m00001" };
    session.state.tokenSnapshot = { m00001: 10_000 };
    const existing = Array.from({ length: prior }, (_, i) => block(i + 1));
    getCacheLedger(session);
    recordCacheFoldsFromBlocks(session, existing, { V: 50_000, Vp: 40_000 });
    session.state.blocks = existing;
    const incoming = Array.from({ length: added }, (_, i) => block(prior + i + 1));
    session.state.blocks = existing.concat(incoming);
    const start = performance.now();
    recordCacheFoldsFromBlocks(session, incoming, { V: 50_000, Vp: 40_000 });
    const elapsedMs = performance.now() - start;
    const ledger = getCacheLedger(session);
    return {
        name, prior, added, elapsedMs,
        folds: ledger.folds.length, lastBlockId: ledger.lastBlockId,
        ledgerSha256: checksum(ledger), reportSha256: checksum(buildSessionCacheReport(session)),
    };
}
cases.forEach(runCase); // One untimed warmup per scenario in each fresh process.
const results = cases.map(runCase);
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, results }));
