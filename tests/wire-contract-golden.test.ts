// Golden schema snapshots (#1304 item 2). Every tool schema bili or the pinned
// kernel advertises on any wire has a committed snapshot under
// tests/golden/wire-contract/. Comparison is byte-exact on canonical LF text:
// disk content is normalized \r\n → \n first because Windows CI checkouts
// apply autocrlf and materialize committed-LF goldens as CRLF in the worktree
// (first-run failure on windows-latest, run 36102348905). Any schema change
// turns these red; regeneration (node --import tsx
// scripts/update-wire-contract-goldens.ts) is only valid with justification in
// the PR body — silent drift is what #1299 was.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGoldens, canonicalize } from "./wire-contract-inventory.ts";

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "wire-contract");

test("wire-contract goldens: no orphaned snapshot files", () => {
    const onDisk = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).sort();
    const tracked = buildGoldens().map((g) => g.name).sort();
    assert.deepEqual(onDisk, tracked, `tests/golden/wire-contract must contain exactly the tracked goldens (stale files are a drift vector)`);
});

for (const spec of buildGoldens()) {
    test(`wire-contract goldens: ${spec.name} (${spec.layer}) matches committed snapshot`, () => {
        const expected = fs.readFileSync(path.join(GOLDEN_DIR, spec.name), "utf8").replace(/\r\n/g, "\n");
        const actual = canonicalize(spec.build());
        assert.equal(
            actual,
            expected,
            `${spec.name} drifted. If intentional: run \`node --import tsx scripts/update-wire-contract-goldens.ts\`, review the diff, and justify the schema change in the PR body.`,
        );
    });
}
