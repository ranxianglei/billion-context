import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { CoreMessage, ProcessTurnResult } from "acp-kernel";

// node --import tsx scripts/bench-content-store-adopt.ts <checkout> <store.ts SHA256> <output.json>
const [checkout, expectedSourceSha, outputFile] = process.argv.slice(2);
if (!checkout || !expectedSourceSha || !outputFile) throw new Error("Expected checkout, store.ts SHA256, and output path");
const root = realpathSync(checkout);
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const sourcePath = path.join(root, "src/store.ts");
const sourceSha256 = digest(readFileSync(sourcePath));
assert.equal(sourceSha256, expectedSourceSha, "benchmark must use the intended production source");
const kernelPath = realpathSync(path.join(root, "node_modules/acp-kernel/dist/index.js"));
assert.equal(kernelPath, realpathSync(path.join(root, "kernel/dist/index.js")), "use this checkout's kernel build");
const kernel = await import(pathToFileURL(kernelPath).href) as typeof import("acp-kernel");
const { adoptContentStore } = await import(pathToFileURL(sourcePath).href) as typeof import("../src/store.js");
const { createSession } = await import(pathToFileURL(path.join(root, "src/session.ts")).href) as typeof import("../src/session.js");
const { createCore, createContentStore, createInitialState, assignRefs, defaultConfig, DEFAULT_CCR_CONFIG, storeOriginal, retrieveByRef } = kernel;
const core = createCore();
const config = { ...defaultConfig(200_000), ccr: { ...DEFAULT_CCR_CONFIG, enabled: true, minToolTokens: 50 } };
const original = "Previously stored tool output with exact source evidence. ".repeat(40);
const samples = 5;
const iterations = 50;
function measure(invoke: () => void): { msPerCall: number[]; medianMs: number } {
    for (let i = 0; i < 15; i++) invoke();
    const msPerCall: number[] = [];
    for (let s = 0; s < samples; s++) {
        const start = performance.now();
        for (let i = 0; i < iterations; i++) invoke();
        msPerCall.push((performance.now() - start) / iterations);
    }
    return { msPerCall, medianMs: [...msPerCall].sort((a, b) => a - b)[Math.floor(samples / 2)]! };
}
const rows = [];
for (const count of [0, 100, 1000, 4000]) {
    let store = createContentStore();
    const history: CoreMessage[] = [];
    for (let i = 0; i < count; i++) {
        const id = `historical-result-${i}`;
        store = storeOriginal(store, { ref: `m${String(i + 1).padStart(5, "0")}`, rawId: id, text: original,
            kind: "shell output", toolName: "bash", tokens: 600, head: original.slice(0, 100) });
        history.push({ id, role: "tool", contentType: "tool-result", toolName: "bash", text: original });
    }
    const messages: CoreMessage[] = Array.from({ length: 24 }, (_, i) => ({ id: `live-${i}`,
        role: i % 2 === 0 ? "user" : "assistant", contentType: "text",
        text: `Project checkpoint ${i}: continue using the stored evidence when needed.`, ts: 1_700_000_000_000 + i }));
    const state = createInitialState();
    state.messageRefs = assignRefs([...history, ...messages], { existing: state.messageRefs, nextIndex: 1 }).map;
    const session = createSession(`content-store-bench-${count}`);
    adoptContentStore(session, store);
    session.contentStoreDirty = false;
    const beforeStats = structuredClone(session.stats);
    const beforeDigest = digest(JSON.stringify(store));
    const input = { messages, state, config, tokenCount: 500, contentStore: store, renderTags: "none" as const };
    let turn: ProcessTurnResult = core.processTurn(input);
    assert.equal(turn.contentStore, store);
    const adoption = measure(() => adoptContentStore(session, turn.contentStore));
    const pipeline = measure(() => {
        turn = core.processTurn(input);
        adoptContentStore(session, turn.contentStore);
    });
    assert.equal(session.contentStore, store);
    assert.equal(session.contentStoreDirty, false);
    assert.deepEqual(session.stats, beforeStats);
    assert.equal(digest(JSON.stringify(store)), beforeDigest);
    let scans = 0;
    const observed = { ...store, byRef: new Proxy(store.byRef, { ownKeys(target) { scans++; return Reflect.ownKeys(target); } }) };
    session.contentStore = observed;
    adoptContentStore(session, observed);
    const output = { messages: turn.messages, state: turn.state, nudge: turn.nudge,
        contentStore: store, stats: session.stats, dirty: session.contentStoreDirty,
        retrieval: count ? retrieveByRef(store, "m00001") : null };
    rows.push({ storedRefs: count, storedEnvelopeBytes: Buffer.byteLength(JSON.stringify(store)), liveMessages: messages.length,
        adoption, pipeline, referenceEnumerations: scans, resultDigest: digest(JSON.stringify(output)) });
}
const result = { node: process.version, sourcePath, sourceSha256,
    loadedFunctionSha256: digest(adoptContentStore.toString()), kernelPath,
    kernelBundleSha256: digest(readFileSync(kernelPath)), samples, iterations, rows };
writeFileSync(outputFile, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
