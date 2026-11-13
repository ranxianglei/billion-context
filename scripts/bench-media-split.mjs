// Run with: node --expose-gc --import tsx scripts/bench-media-split.mjs [count]
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { splitMediaContent } from "../src/storage/identity.ts";

const count = Number(process.argv[2] ?? 20_000);
if (!Number.isSafeInteger(count) || count < 1 || count > 0xffff_ffff) {
    throw new Error("count must be a positive 32-bit integer");
}
const urls = Array.from({ length: count }, (_, i) => {
    const prefix = Buffer.alloc(6);
    prefix.writeUInt32BE(i, 2);
    return `data:image/png;base64,${prefix.toString("base64")}${"A".repeat(2040)}`;
});
const content = JSON.stringify({ rawResponsesItem: urls });
const timings = [];
let digest;
for (let i = 0; i < 4; i++) {
    global.gc?.();
    const started = performance.now();
    const result = splitMediaContent(content);
    const ms = performance.now() - started;
    if (result.media.length !== count) throw new Error(`expected ${count} media rows`);
    const signature = createHash("sha256").update(JSON.stringify(result)).digest("hex");
    if (digest && digest !== signature) throw new Error("non-deterministic output");
    digest = signature;
    if (i > 0) timings.push(ms);
}
console.log(JSON.stringify({
    count,
    bytes: Buffer.byteLength(content),
    timings_ms: timings,
    median_ms: [...timings].sort((a, b) => a - b)[1],
    digest,
}));
