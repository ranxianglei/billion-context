// Compare the same Google JSON-array workload in two checkouts, alternating run order.
// node --expose-gc --import tsx scripts/bench-google-array-stream.mjs --baseline-root /path/to/base
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const root = path.resolve(option("--root", path.join(path.dirname(fileURLToPath(import.meta.url)), "..")));
const baselineRoot = option("--baseline-root");
const counts = option("--counts", "1024,2048,4096").split(",").map(Number);
const pairs = Number(option("--pairs", "5"));
assert.ok(counts.every(count => Number.isSafeInteger(count) && count > 0));
assert.ok(Number.isSafeInteger(pairs) && pairs > 0);
assert.equal(typeof global.gc, "function", "run Node with --expose-gc for comparable allocation profiles");

async function source(label, directory) {
    const file = realpathSync(path.join(directory, "src/loop/adapter-google.ts"));
    const sourceSha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    const { createGoogleAdapter } = await import(pathToFileURL(file).href);
    return { label, file, sourceSha256, createGoogleAdapter };
}

const sources = baselineRoot
    ? [await source("baseline", path.resolve(baselineRoot)), await source("candidate", root)]
    : [await source("current", root)];
if (sources.length === 2) assert.notEqual(sources[0].sourceSha256, sources[1].sourceSha256, "baseline and candidate must contain different adapter source");
const json = JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ordinary text ".repeat(72) }] }, index: 0 }] });
const terminal = JSON.stringify({ candidates: [{ finishReason: "STOP", index: 0 }] });

async function measure(source, count, mode, profile = false, trailingChunks = 0) {
    global.gc();
    const heapStart = process.memoryUsage().heapUsed;
    let sent = 0, wireBytes = 0, outputBytes = 0, textEvents = 0, doneEvents = 0, retainedHeapBytes;
    const digest = createHash("sha256");
    const stream = new ReadableStream({ pull(controller) {
        if (sent > count + trailingChunks) return controller.close();
        let text;
        if (sent > count) {
            text = " ".repeat(1024);
            if (profile && sent - count === Math.floor(trailingChunks * 0.75)) {
                global.gc();
                retainedHeapBytes = process.memoryUsage().heapUsed - heapStart;
            }
        } else {
            const value = sent === count ? terminal : json;
            text = mode === "sse" ? `data: ${value}\n\n` : `${sent === 0 ? "[" : ","}${value}${sent === count ? "]" : ""}`;
        }
        const bytes = Buffer.from(text);
        wireBytes += bytes.byteLength;
        controller.enqueue(bytes);
        sent++;
    } });
    const start = performance.now();
    for await (const event of source.createGoogleAdapter({}).parseStream(stream, 1)) {
        const raw = "raw" in event && event.raw ? event.raw : event.kind === "meta" ? event.chunk : undefined;
        if (raw) { outputBytes += raw.byteLength; digest.update(raw); }
        if (event.kind === "done") doneEvents++;
        if (event.kind === "text" && ++textEvents === Math.floor(count * 0.75) && profile && trailingChunks === 0) {
            global.gc();
            retainedHeapBytes = process.memoryUsage().heapUsed - heapStart;
        }
    }
    const elapsedMs = performance.now() - start;
    assert.equal(textEvents, count);
    assert.equal(doneEvents, 1);
    return { source: source.label, mode, count, trailingChunks, wireBytes, outputBytes, digest: digest.digest("hex"), elapsedMs, ...(profile ? { retainedHeapBytes } : {}) };
}

const results = [], profiles = [], controls = [];
const expected = new Map();
function verify(row) {
    const key = row.count;
    const value = `${row.outputBytes}:${row.digest}`;
    if (expected.has(key)) assert.equal(value, expected.get(key), "forwarded bytes must match for every source and framing");
    else expected.set(key, value);
    return row;
}
for (const item of sources) await measure(item, 256, "array");
for (const count of counts) {
    for (let pair = 0; pair < pairs; pair++) {
        const order = pair % 2 === 0 ? sources : [...sources].reverse();
        for (const item of order) results.push({ pair, ...verify(await measure(item, count, "array")) });
    }
    for (const item of sources) {
        profiles.push(verify(await measure(item, count, "array", true)));
        controls.push(verify(await measure(item, count, "sse")));
    }
}
for (const item of sources) profiles.push(verify(await measure(item, 16, "array", true, 4096)));
const medians = sources.flatMap(item => counts.map(count => {
    const times = results.filter(row => row.source === item.label && row.count === count).map(row => row.elapsedMs).sort((a, b) => a - b);
    return { source: item.label, count, medianMs: times[Math.floor(times.length / 2)] };
}));
console.log(JSON.stringify({ node: process.version, platform: process.platform, architecture: process.arch, sources: sources.map(({ createGoogleAdapter: _factory, ...rest }) => rest), pairs, medians, results, profiles, controls }, null, 2));
