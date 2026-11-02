// Regenerates tests/golden/storage-render/*.json. Only valid with an
// intentional render/persist contract change — justify in the PR body.
// Usage (MUST carry the CI preload chain — see the guard below):
//   node --import ./tests/preload-storage-baseline.mjs \
//        --import ./tests/preload-test-env.mjs \
//        --import ./tests/preload-zone-slot.mjs \
//        --import tsx scripts/update-storage-render-goldens.ts
import { tmpdir } from "node:os";

// #5483 CI-red lesson (2026-11-02): regenerated without preload-test-env,
// this script baked THIS MACHINE's ambient state tree into the digests —
// every developer passes locally, every CI container reds (persisted-state
// byte deltas in nudge/tsStamps/stats/metadata sections). The suite runs
// under the hermetic mkdtemp roots from tests/preload-test-env.mjs, so the
// regenerator must too. Fail loudly instead of silently baking drift.
{
    const isolated = [process.env.XDG_STATE_HOME, process.env.BILI_SESSIONS_DIR]
        .some((v) => typeof v === "string" && v.startsWith(tmpdir()));
    if (!isolated) {
        console.error(
            "update-storage-render-goldens: refusing to run outside the CI preload chain —\n"
            + "regenerated goldens must match what the test harness computes. Run:\n"
            + "  node --import ./tests/preload-storage-baseline.mjs \\\n"
            + "       --import ./tests/preload-test-env.mjs \\\n"
            + "       --import ./tests/preload-zone-slot.mjs \\\n"
            + "       --import tsx scripts/update-storage-render-goldens.ts",
        );
        process.exit(1);
    }
}
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { driveWire, WIRES } from "../tests/golden-storage-drive.ts";

// Parity with tests/golden-storage-render.test.ts (#3400): the test pins the
// legacy wire shape before driving, so goldens must be regenerated under the
// same condition — without it every per-turn wire digest drifts by the image-
// rescale delta and the suite reds on the next CI run.
process.env.BILI_IMAGE_RESCALE = "0";
// Parity #2: the test suite also disarms the shadow observability lane
// (#3756) before driving — its metadata blob would otherwise diverge from
// what the committed test run hashes, and every freshly regenerated golden
// would red on the next CI run.
process.env.BILI_SNAPSHOT_SHADOW = "0";

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "golden", "storage-render");
fs.mkdirSync(GOLDEN_DIR, { recursive: true });
for (const wire of WIRES) {
    const record = await driveWire(wire);
    const file = path.join(GOLDEN_DIR, `${wire}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 1) + "\n");
    console.log(`wrote ${file} turns=${record.turns.length} foldAt=${record.foldAt} stateDigest=${record.stateDigest.slice(0, 16)}`);
}
