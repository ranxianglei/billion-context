import { test } from "node:test";
import assert from "node:assert/strict";
import { createTagEchoFilter } from "../src/loop/tag-echo-filter.ts";

// #4178: a space-joined refs run fed through ONE push used to hit
// catastrophic backtracking in ORPHAN_REF_CLOSE / PARTIAL_TAIL (the REFS_RUN
// separator `\s*[–—,-]?\s*` admits 2^N partitions of the same span). Before
// the unambiguous-separator fix this was ~4× per +2 refs: 22 refs ≈ 0.2s,
// 28 ≈ 11s, 34 ≈ 1.2h. The fix keeps the language identical (equivalence
// corpus in the issue); this test pins the LINEAR cost.
//
// Margins are deliberately generous (CI boxes vary); a regression returns to
// 4×-per-2-refs growth, so 40 refs blows far past 1s.
test("issue4178: space-joined refs run costs linear time, not exponential (#4178)", () => {
    const mk = (n: number, joiner: string): string => Array.from({ length: n }, () => "m1111").join(joiner);

    for (const [label, input] of [
        ["40 space-joined refs", mk(40, " ")],
        ["40 space-joined refs + failing close tail", mk(40, " ") + " </ap"],
        ["40 comma+space refs", mk(40, ", ")],
        ["200 space-joined refs", mk(200, " ")],
        ["200 space-joined refs + failing close tail", mk(200, " ") + " </ap"],
        // dangling joiner + partial ref: exercises the PENDING_REF_SPAN /
        // PARTIAL_TAIL tail arms (aligned to the same unambiguous form)
        ["40 space-joined refs + dangling joiner + partial ref", mk(40, " ") + " - m0"],
    ] as const) {
        const t0 = Date.now();
        const filter = createTagEchoFilter();
        filter.push(input);
        filter.flush();
        const ms = Date.now() - t0;
        assert.ok(ms < 1000, `${label} took ${ms}ms (expected <1000ms linear; #4178 regression would be minutes)`);
    }
});
