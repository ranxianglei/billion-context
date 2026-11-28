import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { v1UnwrapStream } from "../src/v1internal.ts";

// Run on either revision: node --expose-gc --import tsx scripts/bench-v1internal-framing.mjs [MiB...]
// Measures envelope/framing work only: no image decoding, model call or network.
const sizes = process.argv.slice(2).map(Number);
for (const mode of ["sse", "json"]) {
    for (const size of sizes.length ? sizes : [1, 4, 8]) {
        const response = { candidates: [{ content: { role: "model", parts: [
            { text: "Image result" }, { inlineData: { mimeType: "image/png", data: "A".repeat(size * 1024 * 1024) } },
        ] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 } };
        const envelope = JSON.stringify({ response, traceId: "trace", metadata: {} });
        const wire = Buffer.from(mode === "sse" ? `data: ${envelope}\n\n` : envelope);
        const expected = mode === "sse" ? `data: ${JSON.stringify(response)}\n\n` : JSON.stringify(response);
        const samples = [];
        for (let pass = 0; pass < 4; pass++) {
            globalThis.gc?.();
            let offset = 0;
            const input = new ReadableStream({ pull(controller) {
                if (offset >= wire.length) { controller.close(); return; }
                controller.enqueue(wire.subarray(offset, offset + 16384));
                offset += 16384;
            } });
            const start = performance.now();
            const output = await new Response(v1UnwrapStream(input)).text();
            const elapsed = performance.now() - start;
            assert.equal(output, expected);
            if (pass > 0) samples.push(elapsed);
        }
        samples.sort((a, b) => a - b);
        console.log(JSON.stringify({ mode, payloadMiB: size, inputBytes: wire.length,
            chunkBytes: 16384, medianMs: Number(samples[1].toFixed(2)), byteExact: true }));
    }
}
