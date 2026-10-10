// Regenerates tests/golden/storage-render/*.json. Only valid with an
// intentional render/persist contract change — justify in the PR body.
// Usage: node --import tsx scripts/update-storage-render-goldens.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { driveWire, WIRES } from "../tests/golden-storage-drive.ts";

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "golden", "storage-render");
fs.mkdirSync(GOLDEN_DIR, { recursive: true });
for (const wire of WIRES) {
    const record = await driveWire(wire);
    const file = path.join(GOLDEN_DIR, `${wire}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 1) + "\n");
    console.log(`wrote ${file} turns=${record.turns.length} foldAt=${record.foldAt} stateDigest=${record.stateDigest.slice(0, 16)}`);
}
