import { Jimp } from "jimp";
import { applyImageRescalePass, clearRescaleEncodeCache } from "../src/image-rescale.ts";

if (typeof globalThis.gc !== "function") throw new Error("Run with node --expose-gc");
const count = Number(process.argv[2] ?? 20);
const image = new Jimp({ width: 2400, height: 1600 });
let seed = 42;
for (let i = 0; i < image.bitmap.data.length; i += 4) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  image.bitmap.data[i] = seed & 255;
  image.bitmap.data[i + 1] = (seed >>> 8) & 255;
  image.bitmap.data[i + 2] = (seed >>> 16) & 255;
  image.bitmap.data[i + 3] = 255;
}
const ctx = { session: { state: { messageRefs: { byRaw: {} } } }, sessionId: "bench-image-cache", maxDim: 1600, toolArmed: false, log: () => {} };
async function one(index) {
  image.bitmap.data[0] = index;
  const input = (await image.getBuffer("image/png")).toString("base64");
  const [out] = await applyImageRescalePass([{ id: `image-${index}`, role: "user", contentType: "text", imageBase64: input, imageMediaType: "image/png" }], ctx);
  if (!out || out.imageBase64 === input) throw new Error("Expected a real rescale");
  return { inputBytes: input.length, outputBytes: out.imageBase64.length };
}
async function memoryAfterGc() {
  // V8's external-memory counters can lag one collection. Give reclaimed
  // codec temporaries several collections and event-loop turns to settle.
  for (let i = 0; i < 3; i++) {
    globalThis.gc();
    await new Promise(resolve => setImmediate(resolve));
  }
  return process.memoryUsage();
}
await one(255); // load the encoder before measuring retained cache bytes
clearRescaleEncodeCache();
const before = await memoryAfterGc();
let sizes;
for (let i = 0; i < count; i++) sizes = await one(i);
const retained = await memoryAfterGc();
clearRescaleEncodeCache();
const cleared = await memoryAfterGc();
const mb = bytes => Math.round(bytes / 1024 / 1024 * 10) / 10;
const memory = usage => ({ heapMiB: mb(usage.heapUsed), externalMiB: mb(usage.external), rssMiB: mb(usage.rss) });
console.log(JSON.stringify({ count, sizes, before: memory(before), retained: memory(retained), cleared: memory(cleared), cacheReleaseMiB: mb(retained.heapUsed + retained.external - cleared.heapUsed - cleared.external) }, null, 2));
