// Storage-render goldens (S1). Byte-stable snapshots of what the proxy puts
// on the wire (per-turn sha256 of the canonicalized outbound body) and what
// the storage layer persists (sha256 of the canonicalized session), across a
// fixed scripted conversation with one fold and one mid-history edit, on all
// four wires.
//
// Any drift turns these red. Regeneration (node --import tsx
// scripts/update-storage-render-goldens.ts) is only valid with justification
// in the PR body — during the storage refactor the EXPECTED workflow is:
// Phase 1 dual-write changes must keep these GREEN (render + persisted-state
// digests unchanged); only a deliberate render contract change may regen.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { driveWire, WIRES } from "./golden-storage-drive.ts";

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "storage-render");

test("storage-render goldens: no orphaned snapshot files", () => {
    if (!fs.existsSync(GOLDEN_DIR)) return; // not yet generated
    const onDisk = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).sort();
    const tracked = WIRES.map((w) => `${w}.json`).sort();
    assert.deepEqual(onDisk, tracked, "tests/golden/storage-render must contain exactly the tracked goldens (stale files are a drift vector)");
});

for (const wire of WIRES) {
    test(`storage-render golden (${wire}): wire bodies + persisted state match committed snapshot`, { timeout: 240_000 }, async () => {
        const record = await driveWire(wire);
        const file = path.join(GOLDEN_DIR, `${wire}.json`);
        if (!fs.existsSync(file)) {
            assert.fail(`golden missing: ${file} — run \`node --import tsx scripts/update-storage-render-goldens.ts\` and commit the result`);
        }
        const expected = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
        const actual = JSON.stringify(record, null, 1) + "\n";
        if (actual !== expected) {
            // Pin the most drift-relevant facts in the failure message too.
            const exp = JSON.parse(expected) as { foldAt: number; editedAt: number; stateDigest: string; sectionDigests?: Record<string, string>; stateKeyDigests?: Record<string, string> };
            const secs = record.sectionDigests && exp.sectionDigests
                ? ` sections: ${JSON.stringify(record.sectionDigests)} vs golden ${JSON.stringify(exp.sectionDigests)}`
                : "";
            const keys = record.stateKeyDigests && exp.stateKeyDigests
                ? `; state-key divergence: ${Object.keys(record.stateKeyDigests)
                    .filter((k) => exp.stateKeyDigests?.[k] !== record.stateKeyDigests?.[k])
                    .map((k) => `${k}=${record.stateKeyDigests?.[k]} (golden ${exp.stateKeyDigests?.[k]})`).join(", ") || "none"}`
                : "";
            assert.fail(
                `${wire} render/state drifted. foldAt ${record.foldAt} (golden ${exp.foldAt}), editedAt ${record.editedAt} (golden ${exp.editedAt}), stateDigest ${record.stateDigest.slice(0, 16)} (golden ${exp.stateDigest.slice(0, 16)}).${secs}${keys} ` +
                `If intentional: run \`node --import tsx scripts/update-storage-render-goldens.ts\`, review the diff, justify in the PR body.`,
            );
        }
        // Structural sanity on top of the byte pin (cheap, keeps a regen honest).
        assert.ok(record.foldAt >= 0 && record.editedAt > record.foldAt, `${wire}: script shape (fold then edit)`);
        assert.ok(record.summaryFrom >= 0 && record.summaryFrom <= record.foldAt + 1, `${wire}: summary carrier must appear by the fold round-2 body`);
        assert.equal(record.stateShape.activeBlocks, 1, `${wire}: exactly one active block expected`);
        assert.ok(record.stateShape.blockContents >= 1, `${wire}: block contents must be persisted`);
    });
}
