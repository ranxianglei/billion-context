// Unit coverage for the measured-weight shard partition
// (scripts/ci-shard-partition.mjs): table-driven weights, fallback for
// unlisted files, LPT balance targeting the heaviest shard, determinism and
// the total-union invariant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileWeight, lineCount, partitionAll } from "../scripts/ci-shard-partition.mjs";

test("fileWeight: measured value wins; unlisted falls back to lineCount x k", () => {
    const table = { msPerLineFallback: 7, files: { "tests/a.test.ts": 12_345 } };
    assert.equal(fileWeight("tests/a.test.ts", table), 12_345);
    const unlisted = fileWeight("tests/does-not-exist.test.ts", table);
    assert.equal(unlisted, 1 * 7, "unreadable file: line floor 1 x k");
    const real = lineCount("tests/ci-shard-weights.test.ts");
    assert.ok(real > 10, "lineCount reads the real file");
});

test("LPT spreads measured heavyweights instead of piling them by lines", () => {
    // 3 spawn-heavy monsters (low line count, huge runtime) + many light files.
    const table = {
        msPerLineFallback: 10,
        files: {
            "tests/h1.test.ts": 60_000,
            "tests/h2.test.ts": 55_000,
            "tests/h3.test.ts": 50_000,
        },
    };
    const light = Array.from({ length: 60 }, (_, i) => `tests/l${i}.test.ts`);
    const files = ["tests/h1.test.ts", "tests/h2.test.ts", "tests/h3.test.ts", ...light];
    // light files do not exist on disk -> lineCount floor 1 -> weight 10 each.
    const bins = partitionAll(files, 3, table);
    assert.deepEqual(
        bins.map((b) => b[0]).sort(),
        ["tests/h1.test.ts", "tests/h2.test.ts", "tests/h3.test.ts"],
        "each monster opens its own bin",
    );
    const loads = bins.map((b) => b.reduce((s, f) => s + fileWeight(f, table), 0));
    assert.ok(Math.max(...loads) - Math.min(...loads) < 10_000, `near-balanced loads: ${loads}`);
});

test("partition is deterministic, total, and every bin disjoint", () => {
    const table = {
        msPerLineFallback: 5,
        files: { "tests/x.test.ts": 100, "tests/y.test.ts": 90, "tests/z.test.ts": 3 },
    };
    const files = ["tests/x.test.ts", "tests/y.test.ts", "tests/z.test.ts"];
    const b1 = partitionAll(files, 2, table);
    const b2 = partitionAll(files, 2, table);
    assert.deepEqual(b1, b2, "same input => same partition");
    assert.deepEqual([...b1].flat().sort(), [...files].sort(), "union == input, nothing dropped");
});

test("checked-in weight table stays honest: every entry is a real test file", () => {
    // A stale entry for a renamed/deleted file silently rots the balance
    // story; this pins table hygiene (regen drops removed files naturally).
    let raw;
    try {
        raw = JSON.parse(readFileSync("scripts/ci-shard-weights.json", "utf8")) as { files?: Record<string, number> };
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // table absent pre-regen: acceptable, skip
        return;
    }
    const onDisk = new Set(readdirSync("tests").filter((f) => f.endsWith(".test.ts")));
    const stale = Object.keys(raw.files ?? {}).filter((f) => !onDisk.has(f.split("/").pop() ?? f));
    assert.deepEqual(stale, [], `weight table references missing files: ${stale.join(", ")}`);
});
