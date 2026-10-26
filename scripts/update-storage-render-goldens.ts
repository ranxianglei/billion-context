// Regenerates tests/golden/storage-render/*.json. Only valid with an
// intentional render/persist contract change — justify in the PR body.
// Usage: node --import tsx scripts/update-storage-render-goldens.ts
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
