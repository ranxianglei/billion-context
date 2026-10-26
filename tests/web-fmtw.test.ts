import test from "node:test";
import assert from "node:assert/strict";
import { WEB_CLIENT } from "../src/web/client.ts";

// fmtW lives inside the browser IIFE (the WEB_CLIENT template literal) and cannot be imported;
// extract it by brace-counting and eval it against a stubbed t().
function extractFn(src: string, name: string): string {
    const marker = `function ${name}(`;
    const start = src.indexOf(marker);
    assert.ok(start !== -1, `${name} not found in WEB_CLIENT`);
    const open = src.indexOf("{", start);
    assert.ok(open !== -1, `${name}: no body brace found`);
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    assert.ok(end !== -1, `${name}: unbalanced braces`);
    return src.slice(start, end);
}

const NONE = "__NONE__";
const fmtW: (n: unknown) => string = new Function("t", `${extractFn(WEB_CLIENT, "fmtW")}; return fmtW;`)(() => NONE) as (n: unknown) => string;

test("#2413: B-tier shows 2 decimals (10M step), not the frozen 1-decimal label", () => {
    // Exact values from the issue's two /__bili/overview samples: under the old toFixed(1) all
    // four rendered "1.2B" for days, so this pins the fix (toFixed(2) must distinguish them).
    assert.equal(fmtW(1_217_870_664), "1.22B");
    assert.equal(fmtW(1_218_020_372), "1.22B");
    assert.equal(fmtW(1_206_336_531), "1.21B");
    assert.equal(fmtW(1_206_486_239), "1.21B");
    assert.equal(fmtW(-1_218_020_372), "-1.22B");
});

test("#2413: B-tier boundary + other tiers unchanged (no drift below 1e9)", () => {
    assert.equal(fmtW(999_999_999), "1000.0M");
    assert.equal(fmtW(1_000_000_000), "1.00B");
    assert.equal(fmtW(12_500_000_000), "12.50B"); // fixed 10M step must survive into the tens of billions
    assert.equal(fmtW(120_000_000), "120.0M");
    assert.equal(fmtW(149_708), "150K");
    assert.equal(fmtW(7_490), "7.5K");
    assert.equal(fmtW(850), "850");
    assert.equal(fmtW(null), NONE); // null branch still delegates to t()
});

test("#2413: gross/net saved cells bind hover tooltips to the exact integer, not fmtW", () => {
    // Pin that the two named overview cells expose the raw cumulative total on hover rather than
    // the coarsened fmtW label — the tooltip is what proves the counter is actually moving.
    assert.match(WEB_CLIENT, /grossEl\.title\s*=\s*o\.grossSavedTotal\s*\?\s*String\(Math\.round\(Number\(o\.grossSavedTotal\)\)\)/);
    assert.match(WEB_CLIENT, /netEl\.title\s*=\s*o\.hasFoldData\s*&&\s*o\.netSavedTotal\s*\?\s*String\(Math\.round\(Number\(o\.netSavedTotal\)\)\)/);
});
