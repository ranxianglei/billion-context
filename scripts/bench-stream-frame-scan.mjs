import { performance } from "node:perf_hooks";
import { createGoogleAdapter } from "../src/loop/adapter-google.ts";

const chunkSize = 16 * 1024;
const sizes = process.argv.slice(2).map(Number);
for (const size of sizes.length ? sizes : [1, 4, 8]) {
  const payload = "A".repeat(size * 1024 * 1024);
  const wire = Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Generated image." }, { inlineData: { mimeType: "image/png", data: payload } }] } }] })}\n\ndata: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }] })}\n\n`);
  const times = [];
  for (let pass = 0; pass < 4; pass++) {
    let at = 0;
    const stream = new ReadableStream({ pull(controller) {
      if (at >= wire.length) return controller.close();
      controller.enqueue(wire.subarray(at, at + chunkSize));
      at += chunkSize;
    } });
    const adapter = createGoogleAdapter({}, undefined, undefined, "gemini-test");
    let outputBytes = 0;
    const start = performance.now();
    for await (const event of adapter.parseStream(stream, 1)) {
      if (event.kind === "meta") outputBytes += event.chunk.length;
      else if ("raw" in event && event.raw) outputBytes += event.raw.length;
    }
    const elapsed = performance.now() - start;
    if (outputBytes < payload.length) throw new Error("Image frame was not forwarded");
    if (pass > 0) times.push(elapsed);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ payloadMiB: size, wireBytes: wire.length, networkChunkBytes: chunkSize, medianMs: Number(times[1].toFixed(2)) }));
}
