// #5719: a FULL compaction (the #3733 authored checkpoint replacing the whole
// head..tail) landing in the SAME TURN as a persona-text drift (dsh restart
// reallocating its GUI port into the system prompt — dsh-side root cause
// tracked separately) made every positional re-anchor rung structurally
// unreachable: the recorded tail is gone by definition, the incoming is
// shorter than the recorded skeleton, and the first post-compaction model
// step carries zero assistant turns. The resolver then forked the LIVE
// conversation onto <id>|sub:<fp16(new tag)> while the parent record froze
// (incident: parent lastSeen stuck, sub lane re-compressing from zero the
// same day, resume-inheritance miss).
//
// The fix is the E5 rung: trust the self-declaration embedded in bili's OWN
// authored checkpoint — the identity header \x3cbili-snapshot v1
// conv="<rawId>" …\x3e forged by src/server/dsh-authored-compaction.ts names
// the exact raw id the checkpoint belongs to. It is the one continuation
// proof that survives a full compaction, so it outranks every positional
// rung. These tests pin the issue's three acceptance criteria plus the
// wire-shape matrix and the foreign-quote boundaries (the #4438 class: a
// checkpoint QUOTED elsewhere in someone else's blob must never
// re-anchor).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";
import { orderSnapshot, resetSessionOrderForTest, resolveSessionOrder, sessionOrderSkeletonOf } from "../src/session-resolve.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

// Hermetic state dirs (same discipline as tests/dsh-persona-continuity.test.ts):
// without these a rerun hydrates the previous run's persisted skeletons.
const testRoot = mkdtempSync(join(tmpdir(), "bili-issue5719-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const ID = "session-64ebc9f9-e957-4f2a-9b02-fe4ff4788225";
const OLD_SYS = "You are DeepSeek Harness.\nWeb GUI at http://127.0.0.1:54042\n" + "A".repeat(512);
// The incident drift: five digits, same byte length, nowhere else different.
const NEW_SYS = OLD_SYS.replace("54042", "62335");
const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

const MARKER = `\x3cbili-snapshot v1 conv="${ID}" seq="147" blocks="b1+b2+b3+b4+b5+b6+b7+b8" \x3e`;
const CHECKPOINT = MARKER + "\nSummary of the folded conversation: built the parser, fixed the off-by-one.";
const PLAIN_CHECKPOINT = "Summary of the folded conversation: built the parser, fixed the off-by-one.";

type Msg = Record<string, unknown>;

/** Deep main-shaped openai history under `sys` (the claim shape). */
const deepHistory = (sys: string, cells = 20): Msg[] => {
    const body: Msg[] = [];
    for (let i = 0; i < cells; i++) body.push({ role: i % 2 === 0 ? "user" : "assistant", content: `cell-${i}-` + "z".repeat(120) });
    return [{ role: "system", content: sys }, ...body];
};

/** Fresh post-compaction scaffolding: NO assistant turns, content sharing
 *  nothing with the recorded skeleton (the incident's turn-3 cells). */
const tailCells = (cells = 12): Msg[] => {
    const body: Msg[] = [];
    for (let i = 0; i < cells; i++) body.push({ role: i % 3 === 0 ? "tool" : "user", content: `post-${i}-` + "q".repeat(80) });
    return body;
};

/** Incident shape: system re-render + the checkpoint replacing the ENTIRE
 *  recorded tail + fresh scaffolding, zero assistant. */
const postCompaction = (sys: string, checkpoint: string): Msg[] =>
    [{ role: "system", content: sys }, { role: "user", content: checkpoint }, ...tailCells()];

test("E5: an authored checkpoint declaring the raw id re-anchors across full compaction + tag drift (acceptance 1)", () => {
    resetSessionOrderForTest();
    const r0 = resolveSessionOrder(ID, deepHistory(OLD_SYS), OLD_SYS);
    assert.equal(r0.action, "claim");
    const before = sessionOrderSkeletonOf(ID);
    assert.ok(before && before.length >= 20, "deep skeleton recorded");

    const r1 = resolveSessionOrder(ID, postCompaction(NEW_SYS, CHECKPOINT), NEW_SYS);
    assert.equal(r1.key, ID, "stays on the raw lane");
    assert.equal(r1.action, "reanchor");
    assert.match(r1.reason ?? "", /#5719/);

    // Parent unfrozen: the recorded skeleton moved to the post-compaction shape.
    const after = sessionOrderSkeletonOf(ID);
    assert.ok(after && after.length < (before?.length ?? 0), "skeleton followed the compacted history");
    assert.notDeepEqual(after, before);
    // No |sub: lane was minted for the drifted tag.
    assert.ok(orderSnapshot().every((e) => !e.id.startsWith(`${ID}|sub:`)), "no sub lane exists");

    // Next request: the tag now matches the recorded one → plain continue.
    const r2 = resolveSessionOrder(ID, postCompaction(NEW_SYS, CHECKPOINT), NEW_SYS);
    assert.equal(r2.key, ID);
    assert.equal(r2.action, "continue");
});

test("control: the SAME shape without the marker still forks (E5 is the only rescuer; the #5686 tail rung cannot reach a fully-erased tail)", () => {
    resetSessionOrderForTest();
    assert.equal(resolveSessionOrder(ID, deepHistory(OLD_SYS), OLD_SYS).action, "claim");
    const before = sessionOrderSkeletonOf(ID);

    const r = resolveSessionOrder(ID, postCompaction(NEW_SYS, PLAIN_CHECKPOINT), NEW_SYS);
    assert.equal(r.action, "derived-persona");
    assert.equal(r.key, `${ID}|sub:${fp16(NEW_SYS)}`);
    // The raw record stayed FROZEN (only the fork lane was written).
    assert.deepEqual(sessionOrderSkeletonOf(ID), before);
});

test("acceptance 2: a foreign persona quoting a checkpoint never re-anchors the raw id", () => {
    resetSessionOrderForTest();
    assert.equal(resolveSessionOrder(ID, deepHistory(OLD_SYS), OLD_SYS).action, "claim");
    const before = sessionOrderSkeletonOf(ID);
    const REVIEW_SYS = "You are the final authorization reviewer for exactly one pending tool call.\nAnswer with one word.";
    const forkKey = `${ID}|sub:${fp16(REVIEW_SYS)}`;

    // (a) the blob quotes a checkpoint declaring ANOTHER id.
    const foreignQuote = `Transcript:\n${MARKER.replace(`conv="${ID}"`, 'conv="session-other-aaaa-bbbb"')}\nDecide: risky?`;
    const ra = resolveSessionOrder(ID, [{ role: "system", content: REVIEW_SYS }, { role: "user", content: foreignQuote }], REVIEW_SYS);
    assert.equal(ra.action, "derived-persona");
    assert.equal(ra.key, forkKey);

    // (b) the blob quotes OUR marker — but in the SECOND user message. The
    //     scan stops at the first user message by design (an authored
    //     checkpoint always REPLACES the head, so it is the first one).
    const lateMarker: Msg[] = [
        { role: "system", content: REVIEW_SYS },
        { role: "user", content: "plain question" },
        { role: "user", content: `quoted:\n${CHECKPOINT}` },
    ];
    const rb = resolveSessionOrder(ID, lateMarker, REVIEW_SYS);
    assert.equal(rb.action, "derived-persona");
    assert.equal(rb.key, forkKey);

    // Raw record untouched by both attempts.
    assert.deepEqual(sessionOrderSkeletonOf(ID), before);
});

test("acceptance 2b: a marker outside a user message does not count (role gate)", () => {
    resetSessionOrderForTest();
    assert.equal(resolveSessionOrder(ID, deepHistory(OLD_SYS), OLD_SYS).action, "claim");
    const r = resolveSessionOrder(
        ID,
        [{ role: "system", content: NEW_SYS + "\n" + MARKER }, { role: "user", content: "plain question" }],
        NEW_SYS,
    );
    assert.equal(r.action, "derived-persona");
    assert.equal(r.key, `${ID}|sub:${fp16(NEW_SYS)}`);
});

test("E5 fires on all four wire shapes (string / openai+anthropic parts / responses item / google parts)", () => {
    const shapes: Array<[string, (cp: string, sys: string) => Msg[]]> = [
        ["openai-string", (cp, sys) => postCompaction(sys, cp)],
        [
            "openai-parts",
            (cp, sys) => [{ role: "system", content: sys }, { role: "user", content: [{ type: "text", text: cp }] }, ...tailCells()],
        ],
        [
            "anthropic-parts",
            (cp, sys) => [{ role: "system", content: sys }, { role: "user", content: [{ type: "text", text: cp }] }, ...tailCells()],
        ],
        [
            "responses-item",
            (cp, sys) => [
                { role: "system", content: sys },
                { type: "message", role: "user", content: [{ type: "input_text", text: cp }] },
                ...tailCells(),
            ],
        ],
        [
            "google-parts",
            (cp, sys) => [{ role: "system", content: sys }, { role: "user", parts: [{ text: cp }] }, ...tailCells()],
        ],
    ];
    for (const [name, build] of shapes) {
        resetSessionOrderForTest();
        assert.equal(resolveSessionOrder(ID, deepHistory(OLD_SYS), OLD_SYS).action, "claim", name);
        const r = resolveSessionOrder(ID, build(CHECKPOINT, NEW_SYS), NEW_SYS);
        assert.equal(r.key, ID, name);
        assert.equal(r.action, "reanchor", name);
        assert.match(r.reason ?? "", /#5719/, name);
    }
});

test("acceptance 3: without any marker the pre-existing rungs are untouched (reasons byte-stable)", () => {
    // The pre-existing tagChanged outcomes, each with its historical reason
    // string, none of them carrying a checkpoint marker. Corpora mirror the
    // suites that own each rung (tests/issue2601-*, tests/issue4778-*,
    // tests/issue5686-tagchanged-shorter-tail-reanchor.*).
    const plain = (n: number, label: string): Msg[] =>
        Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `${label}-${i + 1}-` + "x".repeat(120) }));

    // E1: continuing history under a new system → anchor migrated (#2241/#2250).
    resetSessionOrderForTest();
    assert.equal(resolveSessionOrder("e1", [{ role: "system", content: OLD_SYS }, ...plain(12, "e1")], OLD_SYS).action, "claim");
    const r1 = resolveSessionOrder("e1", [{ role: "system", content: NEW_SYS }, ...plain(12, "e1"), { role: "user", content: "next-" + "w".repeat(64) }], NEW_SYS);
    assert.equal(r1.action, "reanchor");
    assert.match(r1.reason ?? "", /#2241\/#2250/);

    // E2: header-corroborated model switch on fresh deep history.
    resetSessionOrderForTest();
    assert.equal(resolveSessionOrder("e2", [{ role: "system", content: OLD_SYS }, ...plain(12, "e2")], OLD_SYS, "model-a").action, "claim");
    const r2 = resolveSessionOrder("e2", [{ role: "system", content: NEW_SYS }, ...plain(6, "fresh-e2")], NEW_SYS, "model-b");
    assert.equal(r2.action, "reanchor");
    assert.match(r2.reason ?? "", /#2601\/#2817/);

    // E4: host cleared mid-history harness cells; conversation cells keep
    // their indices (#4778).
    resetSessionOrderForTest();
    assert.equal(resolveSessionOrder("e4", [{ role: "system", content: OLD_SYS }, ...plain(12, "e4")], OLD_SYS).action, "claim");
    const e4body = plain(12, "e4").flatMap((m) => [{ role: "system", content: "" }, m]);
    const r4 = resolveSessionOrder("e4", [{ role: "system", content: NEW_SYS }, ...e4body, { role: "user", content: "goal-" + "g".repeat(120) }], NEW_SYS);
    assert.equal(r4.action, "reanchor");
    assert.match(r4.reason ?? "", /#4778/);

    // Fifth rung (#5686): strictly shorter incoming keeping the verbatim tail.
    resetSessionOrderForTest();
    const seedC = [{ role: "system", content: OLD_SYS }, ...plain(16, "c5686")];
    assert.equal(resolveSessionOrder("c5686", seedC, OLD_SYS).action, "claim");
    const r5686 = resolveSessionOrder("c5686", [{ role: "system", content: NEW_SYS }, { role: "user", content: "checkpoint sentence" }, ...seedC.slice(9)], NEW_SYS);
    assert.equal(r5686.action, "reanchor");
    assert.match(r5686.reason ?? "", /#5686/);

    // Fork: nothing aligns → persona lane, historical reason intact.
    resetSessionOrderForTest();
    assert.equal(resolveSessionOrder("fork", deepHistory(OLD_SYS), OLD_SYS).action, "claim");
    const rf = resolveSessionOrder("fork", postCompaction(NEW_SYS, PLAIN_CHECKPOINT), NEW_SYS);
    assert.equal(rf.action, "derived-persona");
    assert.match(rf.reason ?? "", /persona lane/);
});
