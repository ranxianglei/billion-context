// Regenerate scripts/ci-shard-weights.json: measured wall-clock ms per test
// file (single-file node --test runs, small parallel pool so port bands and
// CPU stay close to real CI scheduling). Run from the repo root:
//
//   node scripts/measure-test-durations.mjs
//
// Weights only need to be APPROXIMATELY right — LPT just needs the ranking
// and magnitude of the heavyweights (process-spawning suites), which are
// stable across machines even when absolute times are not. Re-run when CI
// shard balance visibly degrades (new heavy suites landing via the
// line-count fallback). Timeout hits are recorded as the timeout value (a
// lower bound) and listed under "timedOut" for visibility.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const POOL = 5;
const PER_FILE_TIMEOUT_MS = 150_000;
const PRELOAD_ARGS = ["--import", "./tests/preload-storage-baseline.mjs", "--import", "./tests/preload-zone-slot.mjs", "--import", "tsx"];

const files = readdirSync(join(ROOT, "tests"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => `tests/${f}`)
    .sort();

function measureOne(rel) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(
            process.execPath,
            [...PRELOAD_ARGS, "--test", rel],
            { cwd: ROOT, stdio: "ignore" },
        );
        let done = false;
        const finish = (timedOut) => {
            if (done) return;
            done = true;
            resolve({ rel, ms: Math.max(1, Date.now() - t0), timedOut });
        };
        child.on("error", () => finish(false));
        child.on("close", () => finish(false));
        setTimeout(() => {
            child.kill("SIGKILL");
            finish(true);
        }, PER_FILE_TIMEOUT_MS);
    });
}

const results = [];
let next = 0;
async function worker() {
    while (next < files.length) {
        const rel = files[next++];
        process.stdout.write(`\r[${results.length + 1}/${files.length}] ${rel}          `);
        results.push(await measureOne(rel));
    }
}
await Promise.all(Array.from({ length: POOL }, worker));
process.stdout.write("\n");

const ratios = results
    .filter((r) => !r.timedOut)
    .map((r) => r.ms / Math.max(1, readFileSync(join(ROOT, r.rel), "utf8").split("\n").length))
    .sort((a, b) => a - b);
const msPerLineFallback = Math.round(ratios[Math.floor(ratios.length / 2)]);

const out = {
    // schema v1 — read by scripts/ci-shard-partition.mjs
    v: 1,
    platform: `${process.platform}/${process.arch} node ${process.version}`,
    note: "wall-clock ms of single-file node --test runs; regenerate with scripts/measure-test-durations.mjs when shard balance degrades",
    msPerLineFallback,
    timedOut: results.filter((r) => r.timedOut).map((r) => r.rel),
    files: Object.fromEntries(results.map((r) => [r.rel, r.ms]).sort((a, b) => a[0].localeCompare(b[0]))),
};
writeFileSync(join(ROOT, "scripts", "ci-shard-weights.json"), JSON.stringify(out, null, 2) + "\n");

const top = [...results].sort((a, b) => b.ms - a.ms).slice(0, 20);
console.log(`msPerLineFallback=${msPerLineFallback}; top ${top.length} heavyweights:`);
for (const r of top) console.log(`  ${String(r.ms).padStart(7)}ms ${r.timedOut ? "(timeout lower-bound) " : ""}${r.rel}`);
