// #2989 live twins: the persona/session-order ladder pinned to the LIVE
// resolver (src/session-resolve.ts) that production wires since #2815
// (ddf366b4). The unit suites that used to pin this surface
// (dsh-persona-continuity, issue2601-model-drift-absorption,
// issue2601-persona-fork-lineage) drive the RETIRED src/persona-anchor.ts
// module — kept as behavioral reference, but they cannot see regressions in
// the live code path. These twins mirror their scenarios one level down the
// stack so the ladder stays pinned where it runs.
//
// Old-vs-new parity was probed exhaustively before writing this file
// (see PR for the probe matrix): every pinned scenario agrees at the key
// level except two DESIGNED divergences, both pinned here explicitly —
//   (a) header-corroborated absorption is LOOSER than the old
//       modelDriftAbsorbed (old required a line-confined system diff; the
//       live resolver absorbs ANY persona-text change that coincides with a
//       declared model switch, #2601/#2817) — test "wild persona rewrite
//       WITH a declared model switch absorbs";
//   (b) a tag-less shallow first sight derives |sub:aux instead of riding
//       the raw key (#2944: shallow strangers never claim) — library-level
//       only, production call sites guard personaTag !== "".
// Fork-lane byte continuity (persisted pre-upgrade |sub: lanes keep their
// sessions) is pinned against a locally computed sha256-16, not the retired
// module, so this contract survives persona-anchor's eventual removal.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolveSessionOrder, resetSessionOrderForTest } from "../src/session-resolve.ts";
import { prefixAffinity } from "../src/prefix-affinity.ts";

type Msg = Record<string, unknown>;
const u = (t: string): Msg => ({ role: "user", content: t });
const a = (t: string): Msg => ({ role: "assistant", content: t });

const SYS = "You are dsh main persona. Model identity: {{model}}. Workspace rules apply.";
const SYS2 = "You are the REVIEW persona. Strict policy only. No workspace context.";
const mainHist: Msg[] = [u("main q1"), a("main a1"), u("main q2"), a("main a2")];

const sha16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

function seedChain(id: string, chain: Msg[]): void {
    prefixAffinity.forget(id);
    const fp = prefixAffinity.chainFingerprint(chain);
    if (fp) prefixAffinity.note(id, fp.depth, fp.tailHash, fp.itemHashes, true);
}

test("first sight: main-shaped history claims the raw key", () => {
    resetSessionOrderForTest();
    const res = resolveSessionOrder("twin-conv", mainHist, SYS, "glm-5.3");
    assert.equal(res.key, "twin-conv");
    assert.equal(res.action, "claim");
});

test("first sight: shallow history WITH a persona tag claims (codex turn-1 shape)", () => {
    resetSessionOrderForTest();
    const res = resolveSessionOrder("twin-conv", [u("first turn")], "codex instructions v1");
    assert.equal(res.key, "twin-conv");
    assert.equal(res.action, "claim");
});

test("first sight: tag-less shallow history derives |sub:aux (never claims raw) — #2944 designed divergence (b)", () => {
    resetSessionOrderForTest();
    const res = resolveSessionOrder("twin-conv", [u("lone review blob")], "");
    assert.equal(res.key, "twin-conv|sub:aux");
    assert.equal(res.action, "derived-aux");
});

test("repeat and shallow fp-equal traffic keep riding the raw key", () => {
    resetSessionOrderForTest();
    assert.equal(resolveSessionOrder("twin-conv", mainHist, SYS, "glm-5.3").key, "twin-conv");
    assert.equal(resolveSessionOrder("twin-conv", mainHist, SYS, "glm-5.3").key, "twin-conv");
    const shallow = resolveSessionOrder("twin-conv", [u("aux probe")], SYS);
    assert.equal(shallow.key, "twin-conv");
    assert.equal(shallow.action, "continue");
});

test("persona drift without continuation forks onto byte-identical |sub:<sha256-16> (upgrade lane continuity)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder("twin-conv", mainHist, SYS, "glm-5.3");
    const stranger = [u("review blob q"), a("review verdict")];
    const res = resolveSessionOrder("twin-conv", stranger, SYS2);
    assert.equal(res.key, `twin-conv|sub:${sha16(SYS2)}`, "fork lane must equal the retired ladder's <rawId>|sub:<sha256(system)[0..16]> so persisted fork lanes survive the #2815 swap");
    assert.equal(res.action, "derived-persona");
    // the fork lane is stable across successive calls of the same persona
    const again = resolveSessionOrder("twin-conv", [...stranger, u("review 2")], SYS2);
    assert.equal(again.key, `twin-conv|sub:${sha16(SYS2)}`);
});

test("grown history, same persona, prefix-aligned: continue", () => {
    resetSessionOrderForTest();
    resolveSessionOrder("twin-conv", mainHist, SYS, "glm-5.3");
    const res = resolveSessionOrder("twin-conv", [...mainHist, u("main q3"), a("main a3")], SYS, "glm-5.3");
    assert.equal(res.key, "twin-conv");
    assert.equal(res.action, "continue");
});

test("grown history with a rewritten head and verbatim tail re-anchors (native compaction shape)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder("twin-conv", mainHist, SYS, "glm-5.3");
    const compacted = [u("[summary of folded early turns]"), u("main q2"), a("main a2"), u("main q3")];
    const res = resolveSessionOrder("twin-conv", compacted, SYS, "glm-5.3");
    assert.equal(res.key, "twin-conv");
    assert.equal(res.action, "reanchor");
});

test("model switch with a line-confined system drift and the same history migrates (#2601 header corroboration)", () => {
    resetSessionOrderForTest();
    const sysA = "line1 stable\nmodel glm-5.3\nline3 stable";
    const sysB = "line1 stable\nmodel glm-6.0\nline3 stable";
    resolveSessionOrder("twin-conv", mainHist, sysA, "glm-5.3");
    const res = resolveSessionOrder("twin-conv", mainHist, sysB, "glm-6.0");
    assert.equal(res.key, "twin-conv");
    assert.equal(res.action, "reanchor");
    assert.match(res.reason ?? "", /#2241|#2250|#2601/);
});

test("wild persona rewrite WITH a declared model switch absorbs — designed divergence (a), LOOSER than the retired ladder", () => {
    resetSessionOrderForTest();
    resolveSessionOrder("twin-conv", mainHist, "old persona\nmodel glm-5.3", "glm-5.3");
    // The old modelDriftAbsorbed required a line-confined diff and FORKED
    // this shape; the live resolver treats the host-declared model change
    // (x-bili-plugin-model) as corroboration for ANY persona-text change in
    // the same window (#2601/#2817) — pinned here as deliberate. If this
    // looseness ever mis-absorbs a genuine persona swap that happens to
    // coincide with a model switch, tighten HERE first.
    const res = resolveSessionOrder(
        "twin-conv",
        [u("compaction summary replacing the head"), u("main q2"), a("main a2")],
        "COMPLETELY different persona text now\nwith new lines\nmodel glm-6.0",
        "glm-6.0",
    );
    assert.equal(res.key, "twin-conv", "the two host declarations corroborate — migrate, do not fork");
    assert.equal(res.action, "reanchor");
});

test("control: the same wild rewrite WITHOUT a declared model switch still forks", () => {
    resetSessionOrderForTest();
    resolveSessionOrder("twin-conv", mainHist, "old persona text", "glm-5.3");
    const res = resolveSessionOrder(
        "twin-conv",
        [u("compaction summary replacing the head"), u("main q2"), a("main a2")],
        "COMPLETELY different persona text now\nwith new lines",
        "glm-5.3",
    );
    assert.equal(res.key, `twin-conv|sub:${sha16("COMPLETELY different persona text now\nwith new lines")}`);
    assert.equal(res.action, "derived-persona");
});

test("post-restart persona race: tag-changed main history that continues the persisted chain migrates (#2988 finding ①)", () => {
    resetSessionOrderForTest();
    // Restart happened: skeleton cold; a shallow aux WITH its own tag claimed
    // the virgin raw id first; the pre-restart chain lives in prefix-affinity.
    resolveSessionOrder("twin-conv", [u("title request")], "title-gen sidecar system");
    seedChain("twin-conv", mainHist);
    const res = resolveSessionOrder("twin-conv", mainHist, SYS, "glm-5.3");
    assert.equal(res.key, "twin-conv", "the persisted chain is the tiebreaker — the main lane must not fork for the process lifetime");
    assert.equal(res.action, "reanchor");
});

test("control for the race: no persisted chain → the tag-changed main history forks", () => {
    resetSessionOrderForTest();
    prefixAffinity.forget("twin-conv"); // the previous test seeded a chain under this id
    resolveSessionOrder("twin-conv", [u("title request")], "title-gen sidecar system");
    const res = resolveSessionOrder("twin-conv", mainHist, SYS, "glm-5.3");
    assert.equal(res.key, `twin-conv|sub:${sha16(SYS)}`);
    assert.equal(res.action, "derived-persona");
});

test("shorter history with a verbatim tail re-anchors (head truncation)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder("twin-conv", mainHist, SYS, "glm-5.3");
    const res = resolveSessionOrder("twin-conv", [u("main q2"), a("main a2"), u("main q3")], SYS, "glm-5.3");
    assert.equal(res.key, "twin-conv");
    assert.equal(res.action, "reanchor");
});

test("shorter history with a divergent tail and no persona tag derives a task lane (#150 id-reuse guard)", () => {
    resetSessionOrderForTest();
    // tag-less claim needs a main-shaped first sight
    resolveSessionOrder("twin-conv", mainHist, "");
    const res = resolveSessionOrder("twin-conv", [u("different subagent q"), a("different subagent a"), u("different tail")], "");
    assert.match(res.key, /^twin-conv\|sub:task:[0-9a-f]{8}$/);
    assert.equal(res.action, "derived-task");
});
