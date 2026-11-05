// #4491 S1-S3 stakes: the id-set algebra that classifies every row of the
// issue's full-resend alignment table — new id = append, vanished cohort =
// tombstone(reason), same id new bytes = edit, mass refresh = epoch flip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { alignIdSet, looksLikeSummaryCarrier, EPOCH_MIN_LEN, EPOCH_OVERLAP_THRESHOLD, SUMMARY_BATCH_MIN } from "../src/msgid-algebra.js";

test("S1: append-only growth keeps every id and appends in observation order", () => {
    const r = alignIdSet(["a", "b", "c"], ["a", "b", "c", "d", "e"]);
    assert.equal(r.epoch, false);
    assert.equal(r.kept, 3);
    assert.deepEqual(r.appends, ["d", "e"]);
    assert.deepEqual(r.vanished, []);
    assert.deepEqual(r.edits, []);
});

test("S1: nothing vanishes when the observation is a strict extension", () => {
    const cur = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const obs = [...cur, "n0", "n1"];
    const r = alignIdSet(cur, obs);
    assert.equal(r.epoch, false);
    assert.equal(r.kept, 20);
    assert.deepEqual(r.appends, ["n0", "n1"]);
    assert.equal(r.vanished.length, 0);
});

test("S2: a vanished cohort covered by an active block is tombstoned reason=compressed", () => {
    const r = alignIdSet(["a", "b", "c", "x", "y"], ["a", "b", "c"], { coveredIds: new Set(["x", "y"]) });
    assert.equal(r.epoch, false);
    assert.deepEqual(r.vanished, [
        { id: "x", reason: "compressed" },
        { id: "y", reason: "compressed" },
    ]);
});

test("S2: summary-framed message + batch vanish classifies the cohort compressed without coverage", () => {
    // SUMMARY_BATCH_MIN vanished ids in the same observation as a summary carrier
    const gone = Array.from({ length: SUMMARY_BATCH_MIN }, (_, i) => `g${i}`);
    const r = alignIdSet([...gone, "keep"], ["keep"], { summarySeen: true });
    assert.ok(r.vanished.every((v) => v.reason === "compressed"));
    assert.equal(r.vanished.length, SUMMARY_BATCH_MIN);
});

test("S2: a sub-batch vanish without coverage or summary is plain deletion", () => {
    const r = alignIdSet(["a", "b", "c", "gone1", "gone2"], ["a", "b", "c"]);
    assert.deepEqual(r.vanished, [
        { id: "gone1", reason: "deleted" },
        { id: "gone2", reason: "deleted" },
    ]);
});

test("S2: coverage wins over the batch rule per-id (mixed cohort)", () => {
    const r = alignIdSet(["a", "folded", "plain1", "plain2", "plain3"], ["a"], { coveredIds: new Set(["folded"]), summarySeen: true });
    const byId = Object.fromEntries(r.vanished.map((v) => [v.id, v.reason]));
    assert.equal(byId["folded"], "compressed");
    assert.equal(byId["plain1"], "compressed"); // batch rule: 4 vanished >= SUMMARY_BATCH_MIN with a summary carrier
});

test("S2: coverage marks only the ids it covers; the rest stay deleted", () => {
    const r = alignIdSet(["a", "folded", "plain"], ["a"], { coveredIds: new Set(["folded"]) });
    const byId = Object.fromEntries(r.vanished.map((v) => [v.id, v.reason]));
    assert.equal(byId["folded"], "compressed");
    assert.equal(byId["plain"], "deleted");
});

test("edit: same id with a changed content signature is an edit (identity preserved)", () => {
    const cur = new Map([["a", "s1"], ["b", "s2"]]);
    const obs = new Map([["a", "s1-EDITED"], ["b", "s2"]]);
    const r = alignIdSet(["a", "b"], ["a", "b"], { currentSigs: cur, observedSigs: obs });
    assert.deepEqual(r.edits, ["a"]);
    assert.equal(r.kept, 2);
    assert.deepEqual(r.appends, []);
    assert.deepEqual(r.vanished, []);
});

test("edit: an id missing on either sig map is not reported as an edit", () => {
    const cur = new Map([["a", "s1"], ["b", "s2"]]);
    const obs = new Map([["a", "s1-EDITED"]]); // b's observed sig absent
    const r = alignIdSet(["a", "b"], ["a", "b"], { currentSigs: cur, observedSigs: obs });
    assert.deepEqual(r.edits, ["a"]);
});

test("S3: a mass id refresh (low overlap, both sides long) flips the epoch", () => {
    const cur = Array.from({ length: EPOCH_MIN_LEN + 4 }, (_, i) => `old${i}`);
    const obs = Array.from({ length: EPOCH_MIN_LEN + 4 }, (_, i) => `new${i}`);
    const r = alignIdSet(cur, obs);
    assert.equal(r.epoch, true);
    assert.equal(r.kept, 0);
    assert.deepEqual(r.appends, obs); // controlled rebuild: the whole observed set re-seeds
    assert.equal(r.vanished.length, cur.length); // history is NOT dropped — retired, all deleted-classified
    assert.ok(r.vanished.every((v) => v.reason === "deleted"));
});

test("S3: short histories never flip the epoch even at zero overlap", () => {
    const cur = Array.from({ length: EPOCH_MIN_LEN - 1 }, (_, i) => `old${i}`);
    const obs = Array.from({ length: EPOCH_MIN_LEN - 1 }, (_, i) => `new${i}`);
    const r = alignIdSet(cur, obs);
    assert.equal(r.epoch, false);
    assert.equal(r.vanished.length, cur.length);
    assert.equal(r.appends.length, obs.length);
});

test("S3: overlap exactly at the threshold does NOT flip (strict <)", () => {
    // observed = 8 known + 8 unknown → ratio 0.5 == threshold → no epoch
    const cur = [...Array.from({ length: 8 }, (_, i) => `k${i}`), ...Array.from({ length: 8 }, (_, i) => `o${i}`)];
    const obs = [...Array.from({ length: 8 }, (_, i) => `k${i}`), ...Array.from({ length: 8 }, (_, i) => `f${i}`)];
    const r = alignIdSet(cur, obs);
    assert.equal(r.epoch, false);
    assert.equal(EPOCH_OVERLAP_THRESHOLD, 0.5);
});

test("S3: just below the threshold flips", () => {
    // observed = 7 known + 9 unknown (len 16 ≥ min) → ratio 7/16 < 0.5
    const cur = [...Array.from({ length: 7 }, (_, i) => `k${i}`), ...Array.from({ length: 10 }, (_, i) => `o${i}`)];
    const obs = [...Array.from({ length: 7 }, (_, i) => `k${i}`), ...Array.from({ length: 9 }, (_, i) => `f${i}`)];
    const r = alignIdSet(cur, obs);
    assert.equal(r.epoch, true);
});

test("looksLikeSummaryCarrier: compress tool result and acp_summary text both match; prose does not", () => {
    assert.equal(looksLikeSummaryCarrier({ toolName: "compress" }), true);
    assert.equal(looksLikeSummaryCarrier({ text: "<acp_summary>…</acp_summary>" }), true);
    assert.equal(looksLikeSummaryCarrier({ text: "please summarize" }), false);
    assert.equal(looksLikeSummaryCarrier({}), false);
});
