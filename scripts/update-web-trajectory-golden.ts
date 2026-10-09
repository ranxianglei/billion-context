// #2489: regenerates tests/golden/web-trajectory/small-full.svg.
// Usage: node --import tsx scripts/update-web-trajectory-golden.ts
// Justify any content change in the PR body (wire-contract golden discipline, #1304).
process.env.TZ = "UTC";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { seamEventsOf, smallFixture } from "../tests/web-trajectory-fixture.ts";
import { runWebClient } from "../tests/web-trajectory-harness.ts";

const rejectFetch = async () => ({ ok: false, status: 503, json: async () => ({ error: "stub" }) });

type TrajSvgFn = (lines: unknown[], folds: unknown[], win: number, baseIn: number, seams: unknown[]) => string;

const h = runWebClient({ hash: "#/", fetchImpl: rejectFetch });
const trajSvg = h.window.bili_trajSvg as TrajSvgFn | undefined;
if (typeof trajSvg !== "function") throw new Error("window.bili_trajSvg test seam missing in src/web/client.ts");

const fx = smallFixture();
const svg = trajSvg(fx.lines, fx.folds, fx.win, fx.baseIn, seamEventsOf(fx.seam));
const file = join(import.meta.dirname, "..", "tests", "golden", "web-trajectory", "small-full.svg");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, svg);
console.log(`wrote ${file} (${svg.length} bytes)`);
