import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { safePrefix, safeSuffix, scrubLoneSurrogates } from "../src/text-safe.js";
import { saltedMsgIdForLog, summaryFingerprintLine, summaryFingerprintLogLine } from "../src/stream.js";

const EMOJI = "\u{1F4E5}"; // D83D DCE5
const loneSurrogateRe = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function assertNoLoneSurrogate(s: string, msg: string): void {
    assert.ok(!loneSurrogateRe.test(s), `${msg}: found lone surrogate half in ${JSON.stringify(s)}`);
}

test("safePrefix: ASCII passthrough", () => {
    assert.equal(safePrefix("abcdefghij", 4), "abcd");
    assert.equal(safePrefix("abc", 10), "abc");
    assert.equal(safePrefix("", 5), "");
});

test("safePrefix: cut landing on a high surrogate backs off one unit (#816 semantics)", () => {
    // index 29 is the high half of the pair — back off so it ends on 'x'
    const s = "x".repeat(29) + EMOJI + "y".repeat(5);
    const out = safePrefix(s, 30);
    assert.equal(out, "x".repeat(29));
    assertNoLoneSurrogate(out, "prefix");
});

test("safeSuffix: cut starting on a low surrogate advances one unit", () => {
    // length 101, cut point 1 lands on the low half — advance past the pair
    const s = EMOJI + "x".repeat(99);
    const out = safeSuffix(s, 100);
    assert.equal(out, "x".repeat(99));
    assertNoLoneSurrogate(out, "suffix");
});

test("safeSuffix: ASCII + full-string passthrough", () => {
    assert.equal(safeSuffix("abcdefghij", 4), "ghij");
    assert.equal(safeSuffix("abc", 10), "abc");
    assert.equal(safeSuffix("", 5), "");
});

test("scrubLoneSurrogates: lone halves become U+FFFD, pairs preserved", () => {
    const loneHigh = "a\ud83db";
    const loneLow = "a\udce5b";
    assert.equal(scrubLoneSurrogates(loneHigh), "a\ufffdb");
    assert.equal(scrubLoneSurrogates(loneLow), "a\ufffdb");
    assert.equal(scrubLoneSurrogates(`a${EMOJI}b`), `a${EMOJI}b`);
});

test("#1615 repro A: fingerprint with head cut on a high surrogate round-trips JSON", () => {
    const summary = "x".repeat(29) + EMOJI + "y".repeat(5) + " tail body";
    const line = summaryFingerprintLine("b1", summary);
    assertNoLoneSurrogate(line, "repro A");
    const parsed = JSON.parse(JSON.stringify({ line })) as { line: string };
    assert.ok(parsed.line.includes("summary"), "fingerprint content retained");
});

test("#1615 repro B: fingerprint with tail cut on a low surrogate round-trips JSON", () => {
    const summary = "head body " + EMOJI + "x".repeat(99);
    const line = summaryFingerprintLine("b2", summary);
    assertNoLoneSurrogate(line, "repro B");
    JSON.parse(JSON.stringify({ line }));
});

test("fingerprint: ASCII summaries are byte-identical to the pre-fix format", () => {
    const summary = "plain ascii summary with no emoji inside";
    const line = summaryFingerprintLine("b3", summary);
    assert.equal(line, ` \u00b7 b3 summary ${summary.length}ch \u00b7 head "${summary.slice(0, 30)}" \u2026 tail "${summary.slice(-100)}"`);
});

test("fingerprint: emoji fully inside a window is preserved verbatim", () => {
    const summary = `before ${EMOJI} after`;
    const line = summaryFingerprintLine("b4", summary);
    assert.ok(line.includes(EMOJI), "intact pair survives the excerpt");
    assertNoLoneSurrogate(line, "intact pair");
});

test("#1718: log fingerprint line carries length only — never head/tail excerpts", () => {
    const summary = "TASK AS OF /home/dev/proj/src/foo.ts branch feature/x — pass 3 of 5";
    const line = summaryFingerprintLogLine("b9", summary);
    assert.equal(line, ` \u00b7 b9 summary ${summary.length}ch`);
    assert.ok(!line.includes("/home/dev"), "no path fragment");
    assert.ok(!line.includes("feature/x"), "no task-state fragment");
    assert.ok(!line.includes("head "), "no excerpt markers at all");
});

test("#1718: saltedMsgIdForLog is deterministic, input-free, and salt-sensitive", () => {
    const id = "h_deadbeefcafe0123";
    const a = saltedMsgIdForLog(id);
    assert.match(a, /^x_[0-9a-f]{10}$/, `shape: ${a}`);
    assert.equal(a, saltedMsgIdForLog(id), "stable within one process");
    assert.notEqual(a, saltedMsgIdForLog("h_deadbeefcafe0124"), "different input → different output");
    assert.ok(!a.includes("deadbeef") && !a.includes(id), "no raw-id substring leaks through");
    assert.notEqual(
        saltedMsgIdForLog(id, "salt-A"),
        saltedMsgIdForLog(id, "salt-B"),
        "different process salts break cross-run correlation",
    );
});

// #816 → #828 → #1615: every recurrence was NEW hand-sliced text. Ratchet:
// raw negative .slice(-N) sites may not appear in src/ outside the allowlist
// (arrays are code-unit-safe; text-safe.ts owns the clamped string cuts).
test("family gate: no raw negative string slices outside the allowlist", () => {
    const allowlist = new Map<string, RegExp[]>([
        ["src/conflict-watch.ts", [/events\.slice\(-10\)/]], // array receiver
        ["src/text-safe.ts", [/\.slice\(/]], // the clamped implementation itself
    ]);
    const srcDir = path.join(import.meta.dirname, "..", "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".ts")) files.push(p);
        }
    };
    walk(srcDir);
    const offenders: string[] = [];
    for (const f of files) {
        // #1629: path.relative yields backslashes on Windows — normalize to
        // forward slashes so the allowlist keys match on every platform.
        const rel = path.relative(path.join(srcDir, ".."), f).split(path.sep).join("/");
        const patterns = allowlist.get(rel) ?? [];
        for (const line of fs.readFileSync(f, "utf8").split("\n")) {
            if (!/\.slice\(-\d+\)/.test(line)) continue;
            if (patterns.some((re) => re.test(line))) continue;
            offenders.push(`${rel}: ${line.trim()}`);
        }
    }
    assert.deepEqual(offenders, [], "raw .slice(-N) on strings reintroduces the #816/#1615 family — use safeSuffix from src/text-safe.ts");
});
