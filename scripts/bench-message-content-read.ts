import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { renderSessionJsonlFromTables } from "../src/export.ts";
import { SqliteBackend } from "../src/storage/backend.ts";
import { UnifiedStore, type IngestSessionInput } from "../src/storage/store.ts";

const count = Number(process.argv[2] ?? 10000);
assert.ok(Number.isSafeInteger(count) && count > 0);
const dir = mkdtempSync(join(tmpdir(), "message-content-read-"));
const store = UnifiedStore.open(join(dir, "index.db"), "node:sqlite");
try {
    const input: IngestSessionInput = {
        session: {
            sessionId: "benchmark", createdAt: 1, updatedAt: 2, nextBlockId: 1, nextRunId: 1,
            metaJson: "{}", statsJson: "{}", metadataJson: "{}", kstateJson: "{}", ccrJson: null,
            tailJson: JSON.stringify({ tailSeqs: Array.from({ length: count }, (_, seq) => seq) }),
        },
        messages: Array.from({ length: count }, (_, seq) => ({
            seq, msgId: `message-${seq}`, ref: `m${seq + 1}`, refNum: seq + 1, role: "user", kind: "text", ts: 1000 + seq,
            content: JSON.stringify({ id: `message-${seq}`, role: "user", contentType: "text", text: `${seq}: ${"stored original 日本語 😀 ".repeat(20)}` }),
        })),
        blocks: [], deadRefs: [], refs: [], ccrEntries: [],
    };
    store.ingestSession(input);
    const selected = input.messages.filter((row) => row.seq % 2 === 1).map((row) => row.seq).reverse();
    const covered = Array.from({ length: Math.ceil(count / 100) }, (_, i) => [i * 100, Math.min(i * 100 + 49, count - 1)] as [number, number]);
    const uncovered = input.messages.filter((row) => row.seq % 100 >= 50).length;
    const backend = new SqliteBackend(store);
    const workloads: { name: string; rows: number; run(): unknown | Promise<unknown> }[] = [
        { name: "getMessages", rows: count, run: () => store.getMessages("benchmark") },
        { name: "getMessagesAt", rows: selected.length, run: () => store.getMessagesAt("benchmark", selected) },
        { name: "uncoveredRows", rows: uncovered, run: () => store.uncoveredRows("benchmark", covered) },
        { name: "jsonlExport", rows: count, run: () => renderSessionJsonlFromTables(backend, "benchmark", false) },
    ];
    const measurements = [];
    for (const workload of workloads) {
        await workload.run();
        const cpuStart = process.cpuUsage();
        const started = performance.now();
        const result = await workload.run();
        const wallMs = performance.now() - started;
        const cpu = process.cpuUsage(cpuStart);
        const serialized = typeof result === "string" ? result : JSON.stringify(result);
        if (typeof result === "string") {
            const records = result.trimEnd().split("\n").map((line) => JSON.parse(line) as { type: string; message?: unknown });
            assert.equal(records.filter((row) => row.type === "message").length, workload.rows);
            assert.deepEqual(records.at(-1)!.message, JSON.parse(input.messages.at(-1)!.content));
        } else {
            assert.ok(Array.isArray(result));
            assert.equal(result.length, workload.rows);
            for (const row of result as { seq: number; content: string }[]) assert.equal(row.content, input.messages[row.seq]!.content);
        }
        measurements.push({ name: workload.name, rows: workload.rows, wallMs, cpuMs: (cpu.user + cpu.system) / 1000,
            outputSha256: createHash("sha256").update(serialized).digest("hex") });
    }
    process.stdout.write(`${JSON.stringify({ count, warmups: 1, measurements })}\n`);
} finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
}
