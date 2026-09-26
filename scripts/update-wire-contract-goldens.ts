// Regenerates the wire-contract golden snapshots (#1304 item 2).
// Run ONLY when a served tool schema change is intended; review the resulting
// diff and justify every changed line in the PR body.
//   node --import tsx scripts/update-wire-contract-goldens.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGoldens, canonicalize } from "../tests/wire-contract-inventory.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..", "tests", "golden", "wire-contract");
fs.mkdirSync(dir, { recursive: true });

let count = 0;
for (const spec of buildGoldens()) {
    const file = path.join(dir, spec.name);
    fs.writeFileSync(file, canonicalize(spec.build()));
    console.log(`wrote ${path.relative(process.cwd(), file)} (${spec.layer})`);
    count++;
}
console.log(`${count} golden file(s) regenerated`);
