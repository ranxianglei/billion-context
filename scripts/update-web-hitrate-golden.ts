// #3484: regenerates tests/golden/web-hitrate/small-full.svg.
// Usage: node --import tsx scripts/update-web-hitrate-golden.ts
// Justify any content change in the PR body (wire-contract golden discipline, #1304).
process.env.TZ = "UTC";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { seamEventsOf, smallFixture } from "../tests/web-trajectory-fixture.ts";
import { runWebClient } from "../tests/web-trajectory-harness.ts";

const rejectFetch = async () => ({ ok: false, status: 503, json: async () => ({ error: "stub" }) });

type HitSvgFn = (lines: unknown[], folds: unknown[], seams: unknown[]) => string;

const h = runWebClient({ hash: "#/", fetchImpl: rejectFetch });
const hitSvg = h.window.bili_hitSvg as HitSvgFn | undefined;
if (typeof hitSvg !== "function") throw new Error("window.bili_hitSvg test seam missing in src/web/client.ts");

const fx = smallFixture();
const svg = hitSvg(fx.lines, fx.folds, seamEventsOf(fx.seam));
const file = join(import.meta.dirname, "..", "tests", "golden", "web-hitrate", "small-full.svg");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, svg);
console.log(`wrote ${file} (${svg.length} bytes)`);
