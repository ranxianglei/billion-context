// #4163: two bare open render tags straddling a chunk boundary — the second
// was handed to the client as body content while the whole-buffer push
// stripped both. Root cause: the #1720 nesting evidence ("more tag structure
// follows in this same chunk") was judged on the CURRENT buffer only; across
// a boundary the later opening accumulated into the live bare-open swallow
// and the #1881 EOF bare-release (or the close-resolution release branch)
// passed it through verbatim — same logical output, different persisted
// bytes per chunking (#3198 cache-seam contract).
//
// Fix: while a bare-open release session is live, a NEW opening inside the
// accumulated span is exactly that nesting evidence arriving late — split the
// span (release the prefix as prose, count the outer opening as dropped
// alone) and re-adjudicate from the inner opening through the normal loop,
// which is the code path the whole-buffer run takes.
import test from "node:test";
import assert from "node:assert/strict";
import { createTagEchoFilter } from "../src/loop/tag-echo-filter.ts";

const O = "\x3cacp\x3e"; // bare open render tag
const C = "\x3c/acp\x3e"; // matching close

function runStream(input: string, splits: number[]): { out: string; dropCount: number } {
    const f = createTagEchoFilter();
    let out = "";
    let pos = 0;
    for (const len of splits) {
        out += f.push(input.slice(pos, pos + len));
        pos += len;
    }
    if (pos < input.length) out += f.push(input.slice(pos));
    out += f.flush();
    return { out, dropCount: f.stats().dropCount };
}

/** Whole push plus every single cut k = 0..len (endpoint cuts degenerate to whole). */
function allCuts(input: string): number[][] {
    const cuts: number[][] = [[input.length]];
    for (let k = 1; k < input.length; k++) cuts.push([k, input.length - k]);
    return cuts;
}

/** Seeded random splittings, sizes 1..40 (same discipline as the #3198 fuzz). */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function randomSplits(input: string, seed: number): number[] {
    const rnd = mulberry32(seed);
    const splits: number[] = [];
    let left = input.length;
    while (left > 0) {
        const n = Math.min(left, 1 + Math.floor(rnd() * 40));
        splits.push(n);
        left -= n;
    }
    return splits;
}

// Each shape pins its settled bytes (whole-buffer AND whole-text mode agree);
// the assertions then require every chunking to reproduce them byte-for-byte.
const SHAPES: Array<{ name: string; text: string; expected: string }> = [
    { name: "two bare opens adjacent (issue repro)", text: `${O}${O}text`, expected: "text" },
    { name: "two bare opens, space between", text: `${O} ${O}text`, expected: " text" },
    { name: "prose between two bare opens", text: `${O}xyz${O}text`, expected: "xyztext" },
    { name: "refs run between two bare opens", text: `${O}m1234${O}text`, expected: "m1234text" },
    { name: "three bare opens adjacent", text: `${O}${O}${O}text`, expected: "text" },
    { name: "bare open wrapping a bare pair", text: `${O}${O}m1234${C}text`, expected: "text" },
    { name: "prose then nested bare pair", text: `${O}junk${O}m1234${C}x`, expected: "junkx" },
    { name: "closed pair then nested bare open", text: `${O}m1234${C}junk${O}`, expected: "junk" },
    { name: "prose head, two bare opens", text: `Answer.\n${O}${O}tail.`, expected: "Answer.\ntail." },
    { name: "case-drifted names, two bare opens #1731", text: "\x3cACP\x3e\x3cACP\x3etext", expected: "text" },
];

test("#4163: issue repro table — whole push and the between-tags cut pin the same bytes", () => {
    for (const s of SHAPES) {
        const whole = runStream(s.text, [s.text.length]);
        assert.equal(whole.out, s.expected, `[${s.name}] whole-buffer output drifted from pinned expectation`);
        // The reported flip point: boundary immediately after the first open.
        const between = runStream(s.text, [s.text.indexOf(O) + O.length, s.text.length - s.text.indexOf(O) - O.length]);
        assert.equal(between.out, s.expected, `[${s.name}] between-tags cut leaked or lost bytes`);
    }
});

test("#4163: every single-cut splitting reproduces the settled bytes", () => {
    for (const s of SHAPES) {
        for (const cuts of allCuts(s.text)) {
            const got = runStream(s.text, cuts);
            assert.equal(
                got.out,
                s.expected,
                `[${s.name}] cuts=${JSON.stringify(cuts)}: got ${JSON.stringify(got.out)}, want ${JSON.stringify(s.expected)}`,
            );
        }
    }
});

test("#4163: seeded random splittings reproduce the settled bytes", () => {
    for (const s of SHAPES) {
        for (let seed = 0; seed < 20; seed++) {
            const got = runStream(s.text, randomSplits(s.text, seed));
            assert.equal(got.out, s.expected, `[${s.name}] random seed ${seed}: got ${JSON.stringify(got.out)}, want ${JSON.stringify(s.expected)}`);
        }
    }
});

test("#4163: logical-artifact count (#2405c) is chunk-invariant for the nested-bare-open family", () => {
    for (const s of SHAPES) {
        const ref = runStream(s.text, [s.text.length]).dropCount;
        for (const cuts of allCuts(s.text)) {
            const got = runStream(s.text, cuts).dropCount;
            assert.equal(got, ref, `[${s.name}] cuts=${JSON.stringify(cuts)}: dropCount ${got} != whole-buffer ${ref}`);
        }
    }
});

test("#4163: single bare opens keep the #1881 prose-wearing semantics under every cut", () => {
    // One bare open, prose body: the open dies, the prose lives — the fix must
    // not turn a lone open into a split trigger (no second opening exists).
    const texts = [
        `see ${O} for details`,
        `lead ${O}m00123 tail`, // bare open, refs-only body -> whole unit dies
    ];
    for (const text of texts) {
        const ref = runStream(text, [text.length]);
        for (const cuts of allCuts(text)) {
            const got = runStream(text, cuts);
            assert.equal(got.out, ref.out, `[${JSON.stringify(text)}] cuts=${JSON.stringify(cuts)}: got ${JSON.stringify(got.out)}, want ${JSON.stringify(ref.out)}`);
            assert.equal(got.dropCount, ref.dropCount, `[${JSON.stringify(text)}] cuts=${JSON.stringify(cuts)}: dropCount differs`);
        }
    }
});

test("#4163: attrs-bearing and wrapped sessions are untouched by the split gate", () => {
    // The gate is bare-open-release-only: an attrs-bearing tail is tag content
    // end-to-end (#644 EOF rule), a wrapped turn discards its payload wholesale.
    // Both stay chunk-deterministic exactly as before the fix.
    const texts = [
        `A \x3cacp tokens="1"\x3em1234${C}B.`,
        `A \x3cacp tokens="1" type="text"\x3e${O}m1234${C}B.`, // nested markup inside an attrs session (pre-existing uniform behavior)
        `A \x3cacp tokens="1" x="y\x3ctool\x3e payload ${C} tail.`, // wrapped odd quotes
    ];
    for (const text of texts) {
        const ref = runStream(text, [text.length]);
        for (const cuts of allCuts(text)) {
            const got = runStream(text, cuts);
            assert.equal(got.out, ref.out, `[${JSON.stringify(text)}] cuts=${JSON.stringify(cuts)}: got ${JSON.stringify(got.out)}, want ${JSON.stringify(ref.out)}`);
        }
    }
});
