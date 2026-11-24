import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { _resetForTest, _setForTest, peekRegistryContext, peekRegistryOutputLimit, scanRegistryCostRow, type CostsShape } from "../src/registry.js";
import snapshot from "../src/registry-snapshot.json" with { type: "json" };

// Run from the repository root with:
// node --expose-gc --import ./tests/preload-test-env.mjs --import tsx scripts/bench-registry-suffix-index.ts
// Use the bundled real roster; no network request or configuration mutation.
const costs = snapshot.costs as CostsShape;
const bareNames = [...new Set(Object.keys(costs).map((key) => key.slice(key.lastIndexOf("/") + 1)))];
const probes = bareNames.slice(0, 500);
const iterations = 5000;
function measure(label: string, names: string[]): void {
    _resetForTest();
    _setForTest(snapshot.models, costs);
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const coldStart = performance.now();
    scanRegistryCostRow(costs, names[0], "relay.example");
    peekRegistryContext(names[0], "relay.example");
    peekRegistryOutputLimit(names[0], "relay.example");
    const coldMs = performance.now() - coldStart;
    global.gc?.();
    const retainedBytes = process.memoryUsage().heapUsed - heapBefore;
    // Warm conflict diagnostics before measurement; output is hashed below.
    for (let i = 0; i < 5000; i++) {
        const name = names[i % names.length];
        scanRegistryCostRow(costs, name, "relay.example");
        peekRegistryContext(name, "relay.example");
        peekRegistryOutputLimit(name, "relay.example");
    }
    global.gc?.();
    const outputs: unknown[] = [];
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    for (let i = 0; i < iterations; i++) {
        const name = names[i % names.length];
        outputs.push([scanRegistryCostRow(costs, name, "relay.example"), peekRegistryContext(name, "relay.example"), peekRegistryOutputLimit(name, "relay.example")]);
    }
    const wallMs = performance.now() - wallStart;
    const cpu = process.cpuUsage(cpuStart);
    console.log(JSON.stringify({label, rows: Object.keys(costs).length, models: Object.keys(snapshot.models).length, names: names.length, iterations, coldMs, retainedBytes, cpuMs: (cpu.user + cpu.system) / 1000, wallMs, digest: createHash("sha256").update(JSON.stringify(outputs)).digest("hex")}));
}
measure("real-roster-relay-models", probes);
measure("unlisted-relay-models", Array.from({length: 100}, (_, i) => `unlisted-benchmark-model-${i}`));
