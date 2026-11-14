import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { observeResponsesTerminalState } from "../src/stream-terminal.ts";

const sizeMiB = Number(process.argv[2] ?? 16);
const chunkKiB = Number(process.argv[3] ?? 64);
const ending = process.argv[4] ?? "lf";
if (!Number.isSafeInteger(sizeMiB) || sizeMiB < 1 || sizeMiB > 128
    || !Number.isSafeInteger(chunkKiB) || chunkKiB < 1 || chunkKiB > 1024
    || !["lf", "crlf", "cr"].includes(ending)) {
    throw new Error("Usage: node --import tsx scripts/bench-terminal-sse.mjs [1..128 MiB] [1..1024 KiB] [lf|crlf|cr]");
}
const eol = { lf: "\n", crlf: "\r\n", cr: "\r" }[ending];
const payload = Buffer.from([
    "event: response.completed",
    `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "compaction", encrypted_content: "a".repeat(sizeMiB << 20) }] } })}`,
    "",
    "",
].join(eol));
const chunkBytes = chunkKiB << 10;
const results = [];
for (let run = 0; run < 3; run++) {
    let offset = 0;
    const stream = new ReadableStream({
        pull(controller) {
            if (offset === payload.length) {
                controller.close();
                return;
            }
            const end = Math.min(offset + chunkBytes, payload.length);
            controller.enqueue(payload.subarray(offset, end));
            offset = end;
        },
    });
    const started = performance.now();
    assert.equal(await observeResponsesTerminalState(stream, true), "completed");
    results.push(performance.now() - started);
}
console.log(JSON.stringify({ node: process.version, bytes: payload.length, chunkBytes, ending, elapsedMs: results }, null, 2));
