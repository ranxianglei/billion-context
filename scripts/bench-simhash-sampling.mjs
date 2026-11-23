// Run with: node --max-old-space-size=512 --expose-gc --import tsx scripts/bench-simhash-sampling.mjs [tokens]
import { performance } from "node:perf_hooks";
import { simhashHex } from "../src/affinity-simhash.ts";

const count = Number(process.argv[2] ?? 1_000_000);
if (!Number.isSafeInteger(count) || count < 1) throw new Error("tokens must be a positive safe integer");
const canonical = Array.from({ length: count }, (_, i) => `word${i % 997}`).join(" ");
const timings = [];
let sketch;
for (let i = 0; i < 4; i++) {
    global.gc?.();
    const start = performance.now();
    const result = simhashHex(canonical);
    const elapsed = performance.now() - start;
    if (sketch !== undefined && sketch !== result) throw new Error("unstable sketch");
    sketch = result;
    if (i > 0) timings.push(elapsed);
}
console.log(JSON.stringify({
    count,
    bytes: Buffer.byteLength(canonical),
    sketch,
    timings_ms: timings,
    median_ms: [...timings].sort((a, b) => a - b)[1],
    max_rss_kib: process.resourceUsage().maxRSS,
}));
