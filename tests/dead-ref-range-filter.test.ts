import assert from "node:assert/strict";
import { test } from "node:test";
import { excludeDeadRefRanges } from "../src/acp-status.ts";

test("#3192: excludeDeadRefRanges drops only spans that bracket a dead ref", () => {
    const ranges = [
        { startRef: "m00001", endRef: "m00003" },
        { startRef: "m00004", endRef: "m00007" },
        { startRef: "m00008", endRef: "m00010" },
    ];
    // No tombstones -> passthrough (identity, not a copy).
    assert.equal(excludeDeadRefRanges(ranges, undefined), ranges);
    assert.equal(excludeDeadRefRanges(ranges, []), ranges);
    // Interior dead ref kills its span; neighbors survive untouched.
    assert.deepEqual(
        excludeDeadRefRanges(ranges, ["m00005"]).map((r) => [r.startRef, r.endRef]),
        [["m00001", "m00003"], ["m00008", "m00010"]],
    );
    // A dead ref sitting exactly on an endpoint also kills that span.
    assert.deepEqual(
        excludeDeadRefRanges(ranges, ["m00003"]).map((r) => [r.startRef, r.endRef]),
        [["m00004", "m00007"], ["m00008", "m00010"]],
    );
    // Non-ref tombstones (raw ids) never match a mNNNNN span -> no false drop.
    assert.equal(excludeDeadRefRanges(ranges, ["raw-dropped"]).length, 3);
});
