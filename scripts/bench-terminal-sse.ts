// Manual benchmark: node --import tsx scripts/bench-terminal-sse.ts [MiB] [chunk-KiB]
// Reports timings; no machine-dependent timing threshold runs in CI.
import { performance } from "node:perf_hooks";
import { observeResponsesTerminalState } from "../src/stream-terminal.ts";

const mib = Number(process.argv[2] ?? 8);
const chunkKiB = Number(process.argv[3] ?? 32);
if (!Number.isFinite(mib) || mib <= 0 || !Number.isFinite(chunkKiB) || chunkKiB <= 0) {
    throw new Error("MiB and chunk-KiB must be positive numbers");
}
const size = Math.max(1, Math.floor(chunkKiB * 1024));
const bytes = new TextEncoder().encode(`event: response.completed\r\ndata: ${JSON.stringify({
    type: "response.completed", response: { output: [{ type: "compaction", encrypted_content: "x".repeat(Math.floor(mib * 1024 * 1024)) }] },
})}\r\n\r\n`);
const elapsed: number[] = [];
for (let round = 0; round < 4; round++) {
    let offset = 0;
    const source = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset === bytes.length) return controller.close();
            controller.enqueue(bytes.subarray(offset, offset + size));
            offset = Math.min(bytes.length, offset + size);
        },
    });
    const start = performance.now();
    if (await observeResponsesTerminalState(source, true) !== "completed") throw new Error("terminal verdict changed");
    const ms = performance.now() - start;
    if (round > 0) elapsed.push(ms);
}
elapsed.sort((a, b) => a - b);
console.log(JSON.stringify({ mib, chunkKiB, samplesMs: elapsed, medianMs: elapsed[1] }));
