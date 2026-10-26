// #2601 B': header-corroborated model-drift absorption. With #2719's
// churn-tolerant continuity, a plain model switch MIGRATES the persona
// anchor. The residual fork shape is the CONJUNCTION: the model switch
// (fp changes) lands in the same window as an unannounced history rewrite
// (chain discontinuity — e.g. dsh local compaction) and the main lane
// still forks. dsh declares its model target on every request via
// x-bili-plugin-model (src/agent/dsh-native.ts); this suite pins the
// absorption rule that consumes BOTH host declarations: the header model
// changed AND the system line-diff is confined to the model identity
// lines → the fp half of the conjunction is absorbed (migrate-model, raw
// key). Anything less — no header, same header model, extra changed lines,
// line-count drift, a genuinely different (review) system — keeps forking.
//
// #2989 dual-run: the rules above are pinned FIRST against the retired
// ladder (src/persona-anchor.ts — characterization 瞄点, production no
// longer calls it since the #2815 wiring swap to
// src/session-resolve.ts). The SAME corpus then runs through the LIVE
// resolver in the "live twin" section below: rows where the two agree
// share one key expectation; designed divergences are marked old→new with
// the #2944 principle that justifies them (order claims, content guards
// only disambiguate; the v2 absorption lane additionally requires
// main-shaped history, and it corroborates on the two host declarations
// WITHOUT parsing the system line-diff).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Hermetic state dirs BEFORE importing the server modules (the prefix
// affinity snapshot persists across runs otherwise — #2719 test idiom).
const testRoot = mkdtempSync(path.join(tmpdir(), "bc-2601-absorb-"));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const { prefixAffinity } = await import("../src/prefix-affinity.ts");
// retired-module pin: persona-anchor — characterization 瞄点 only; production
// routes through src/session-resolve.ts since #2815 (gate: scripts/check-test-import-graph.mjs).
const { resolvePersonaKey, personaAnchorOf, personaNamespace, resetPersonaAnchorsForTest } = await import("../src/persona-anchor.ts");
const { resolveSessionOrder, resetSessionOrderForTest, personaConversationOrder } = await import("../src/session-resolve.ts");

test.after(() => rmSync(testRoot, { recursive: true, force: true }));

const SYSTEM_A = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-4.6.\nWorkspace: /tmp.";
const SYSTEM_B = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-5.3.\nWorkspace: /tmp.";
const SYSTEM_WORKSPACE = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-5.3.\nWorkspace: /other.";
const SYSTEM_EXTRA_LINE = SYSTEM_B + "\nExtra rule line.";
const SYSTEM_DISPLAY_A = "You are DeepSeek Harness, the main coding agent.\nModel: GLM 4.6 Pro.\nWorkspace: /tmp.";
const SYSTEM_DISPLAY_B = "You are DeepSeek Harness, the main coding agent.\nModel: GLM 5.3 Air.\nWorkspace: /tmp.";
const REVIEW_SYSTEM = "You are the final authorization reviewer for exactly one pending tool call.\nAnswer with one word.";

const fpOf = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const forkKey = (conv: string, system: string): string => `${conv}|sub:${fpOf(system)}`;

const msgs = (n: number, tag: string): { role: string; content: string }[] =>
    Array.from({ length: n }, (_, i): { role: string; content: string } => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `${tag}-${i + 1}-` + "z".repeat(120),
    }));

function seed(conv: string, chain: { role: string; content: string }[]): void {
    resetPersonaAnchorsForTest();
    prefixAffinity.forget(conv);
    const fp = prefixAffinity.chainFingerprint(chain);
    assert.ok(fp, "chain fingerprint exists");
    prefixAffinity.note(conv, fp.depth, fp.tailHash, fp.itemHashes, true);
}

test("resolvePersonaKey: a header-corroborated model switch with a discontinued chain MIGRATES (#2601)", () => {
    const conv = "absorb-1";
    const chainA = msgs(6, "a");
    seed(conv, chainA);
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6"), { key: conv, action: "claim" });
    // Same window as an unannounced history rewrite: fresh messages that do
    // not continue the chain (the #2601 residual conjunction).
    const fresh = msgs(2, "fresh-1");
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_B, fresh, "glm-5.3"), { key: conv, action: "migrate-model" });
    assert.equal(personaAnchorOf(conv), fpOf(SYSTEM_B), "anchor migrated to the new system");
});

test("absorption requires BOTH host declarations: header missing on either side forks", () => {
    const conv = "absorb-2";
    const chainA = msgs(6, "b");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    const fresh = msgs(2, "fresh-2");
    // drift without a current header
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_B, fresh, undefined), { key: forkKey(conv, SYSTEM_B), action: "fork" });
    // header present now, but the anchor was claimed without one
    const conv2 = "absorb-2b";
    const chainA2 = msgs(6, "b2");
    seed(conv2, chainA2);
    resolvePersonaKey(conv2, SYSTEM_A, chainA2, undefined);
    assert.deepEqual(resolvePersonaKey(conv2, SYSTEM_B, msgs(2, "fresh-2b"), "glm-5.3"), { key: forkKey(conv2, SYSTEM_B), action: "fork" });
});

test("an unchanged header model does not corroborate a system drift", () => {
    const conv = "absorb-3";
    const chainA = msgs(6, "c");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_B, msgs(2, "fresh-3"), "glm-4.6"), { key: forkKey(conv, SYSTEM_B), action: "fork" });
});

test("a changed non-model line in the diff defeats absorption", () => {
    const conv = "absorb-4";
    const chainA = msgs(6, "d");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_WORKSPACE, msgs(2, "fresh-4"), "glm-5.3"), { key: forkKey(conv, SYSTEM_WORKSPACE), action: "fork" });
});

test("a line-count change defeats absorption", () => {
    const conv = "absorb-5";
    const chainA = msgs(6, "e");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_EXTRA_LINE, msgs(2, "fresh-5"), "glm-5.3"), { key: forkKey(conv, SYSTEM_EXTRA_LINE), action: "fork" });
});

test("folded display-name variants corroborate (header key vs {{model}} render)", () => {
    const conv = "absorb-6";
    const chainA = msgs(6, "f");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_DISPLAY_A, chainA, "glm-4.6-pro");
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_DISPLAY_B, msgs(2, "fresh-6"), "glm-5.3-air"), { key: conv, action: "migrate-model" });
});

test("switching back A→B→A on discontinued chains keeps the raw key", () => {
    const conv = "absorb-7";
    const chainA = msgs(6, "g");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    assert.equal(resolvePersonaKey(conv, SYSTEM_B, msgs(2, "g1"), "glm-5.3").action, "migrate-model");
    assert.equal(resolvePersonaKey(conv, SYSTEM_A, msgs(2, "g2"), "glm-4.6").action, "migrate-model");
    assert.equal(personaAnchorOf(conv), fpOf(SYSTEM_A));
});

test("a continuing history still takes plain migrate (continuity runs first)", () => {
    const conv = "absorb-8";
    const chainA = msgs(6, "h");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    const continuing = [...chainA, { role: "user", content: "next-turn-" + "z".repeat(120) }];
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_B, continuing, "glm-5.3"), { key: conv, action: "migrate" });
});

test("an auto-review system next to a model switch still forks (line-diff is the whole system)", () => {
    const conv = "absorb-9";
    const chainA = msgs(6, "i");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    assert.deepEqual(resolvePersonaKey(conv, REVIEW_SYSTEM, msgs(2, "fresh-9"), "glm-5.3"), { key: forkKey(conv, REVIEW_SYSTEM), action: "fork" });
});

test("a same-system alias re-declaration refreshes the recorded model for a later absorption", () => {
    const conv = "absorb-10";
    const chainA = msgs(6, "j");
    seed(conv, chainA);
    resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6");
    // alias switch: header re-declared, {{model}} render unchanged
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_A, chainA, "glm-4.6-alias"), { key: conv, action: "match" });
    // the NEXT real switch absorbs against the freshest declared name
    assert.deepEqual(resolvePersonaKey(conv, SYSTEM_B, msgs(2, "fresh-10"), "glm-5.3"), { key: conv, action: "migrate-model" });
});

test("personaNamespace surfaces the absorbed migration in the log", () => {
    const conv = "absorb-11";
    const chainA = msgs(6, "k");
    seed(conv, chainA);
    const logs: string[] = [];
    const log = (_l: "info" | "warn" | "error", m: string): void => {
        logs.push(m);
    };
    personaNamespace(conv, SYSTEM_A, chainA, log, "glm-4.6");
    assert.equal(personaNamespace(conv, SYSTEM_B, msgs(2, "fresh-11"), log, "glm-5.3"), conv);
    assert.ok(logs.some((m) => m.includes("header-corroborated model switch") && m.includes("#2601")), "absorbed migration is logged");
});

// ---------------------------------------------------------------------------
// #2989 LIVE TWIN — the same corpus through the wired resolver
// (src/session-resolve.ts, what handle.ts calls since #2815). Shared rows pin
// one key expectation for both; designed divergences are marked old→new with
// the justifying principle. The twin passes the parameters PRODUCTION passes
// (personaTag = system text, declaredModel = x-bili-plugin-model), which the
// old-ladder rows omitted where they were not needed.
// ---------------------------------------------------------------------------

test("live twin: header-corroborated model switch absorbs on MAIN-SHAPED history (the production shape)", () => {
    resetSessionOrderForTest();
    const conv = "twin-absorb-main";
    const chainA = msgs(6, "a");
    assert.equal(resolveSessionOrder(conv, chainA, SYSTEM_A, "glm-4.6").action, "claim");
    // Discontinuous deep history + model header change → reanchor raw
    // (#2601/#2817 branch). The old ladder reached the same raw key via
    // migrate-model after parsing the system line-diff; v2 corroborates on
    // the two host declarations alone (order+id claim, rule 1 — content is
    // never consulted for claiming).
    const freshDeep = msgs(4, "fresh-deep");
    const res = resolveSessionOrder(conv, freshDeep, SYSTEM_B, "glm-5.3");
    assert.equal(res.key, conv, "absorption keeps the raw key");
    assert.equal(res.action, "reanchor");

    // Folded display-name variants (old row absorb-6): v2 compares the
    // DECLARED header values directly — no name-folding machinery needed —
    // and lands on the same raw key.
    resetSessionOrderForTest();
    const conv2 = "twin-absorb-display";
    const chainD = msgs(6, "d");
    resolveSessionOrder(conv2, chainD, SYSTEM_DISPLAY_A, "glm-4.6-pro");
    assert.equal(resolveSessionOrder(conv2, msgs(4, "fresh-d"), SYSTEM_DISPLAY_B, "glm-5.3-air").key, conv2);

    // Alias re-declaration refreshes the recorded model (old row absorb-10)
    // and the NEXT switch absorbs against the freshest declared name — same
    // raw-key outcome as the old ladder's migrate-model.
    resetSessionOrderForTest();
    const conv3 = "twin-absorb-alias";
    const chainJ = msgs(6, "j");
    resolveSessionOrder(conv3, chainJ, SYSTEM_A, "glm-4.6");
    assert.equal(resolveSessionOrder(conv3, chainJ, SYSTEM_A, "glm-4.6-alias").action, "continue");
    assert.equal(resolveSessionOrder(conv3, msgs(4, "fresh-j"), SYSTEM_B, "glm-5.3").key, conv3);

    // Switch back A→B→A across discontinuous main-shaped histories stays on
    // the raw key (old row absorb-7's end state, same key; v2's intermediate
    // steps also ride raw because each step is main-shaped and corroborated,
    // where the old ladder needed two migrate-model hops).
    resetSessionOrderForTest();
    const conv4 = "twin-absorb-back";
    const chainG = msgs(6, "g");
    resolveSessionOrder(conv4, chainG, SYSTEM_A, "glm-4.6");
    assert.equal(resolveSessionOrder(conv4, msgs(4, "g1"), SYSTEM_B, "glm-5.3").key, conv4);
    assert.equal(resolveSessionOrder(conv4, msgs(4, "g2"), SYSTEM_A, "glm-4.6").key, conv4);
});

test("live twin: the mainShaped gate — shallow histories fork where the old ladder absorbed", () => {
    resetSessionOrderForTest();
    const conv = "twin-shallow";
    const chainA = msgs(6, "b");
    resolveSessionOrder(conv, chainA, SYSTEM_A, "glm-4.6");
    // Old row absorb-1: the SAME 2-message discontinuous shape MIGRATES the
    // retired anchor (migrate-model). NEW→forks: v2's absorption lane
    // requires main-shaped evidence (≥3 turns incl. an assistant) — the
    // aux/persona guard rail outranks header corroboration, so a shallow
    // blob can never drag the raw key even with both declarations present
    // (owner rule 3: the guards exist exactly for shapes order alone cannot
    // tell apart; a 2-message blob is indistinguishable from aux traffic).
    const res = resolveSessionOrder(conv, msgs(2, "fresh-1"), SYSTEM_B, "glm-5.3");
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, forkKey(conv, SYSTEM_B));
    // The raw anchor record is untouched by the fork (shared expectation).
    assert.equal(resolveSessionOrder(conv, msgs(2, "back-a"), SYSTEM_A, "glm-4.6").key, conv);

    // Old row absorb-10 shallow half: alias-refresh then a SHALLOW switch
    // still forks here (the refreshed model cannot rescue a non-main-shaped
    // history) — old→new divergence, same principle.
    resetSessionOrderForTest();
    const conv2 = "twin-shallow-alias";
    const chainJ = msgs(6, "j2");
    resolveSessionOrder(conv2, chainJ, SYSTEM_A, "glm-4.6");
    resolveSessionOrder(conv2, chainJ, SYSTEM_A, "glm-4.6-alias");
    assert.equal(resolveSessionOrder(conv2, msgs(2, "fresh-10"), SYSTEM_B, "glm-5.3").action, "derived-persona");
});

test("live twin: controls stay forks — missing / stale / unchanged header declarations", () => {
    // Header missing on the incoming side (old row absorb-2 first arm):
    // shared expectation — the fork key format is byte-identical.
    resetSessionOrderForTest();
    const conv = "twin-no-header";
    const chainA = msgs(6, "c");
    resolveSessionOrder(conv, chainA, SYSTEM_A, "glm-4.6");
    assert.deepEqual(resolveSessionOrder(conv, msgs(2, "fresh-2"), SYSTEM_B, undefined),
        { key: forkKey(conv, SYSTEM_B), action: "derived-persona", reason: "persona text changed without continuing history — persona lane" });

    // Anchor claimed WITHOUT a header declaration (old row absorb-2 second
    // arm): shared expectation at BOTH depths — v2's model branch requires
    // the recorded side to carry a declaration too, so even a deep switch
    // forks, exactly like the old ladder's missing-anchor-model rule.
    resetSessionOrderForTest();
    const conv2 = "twin-no-anchored-model";
    const chainB = msgs(6, "c2");
    resolveSessionOrder(conv2, chainB, SYSTEM_A, undefined);
    assert.equal(resolveSessionOrder(conv2, msgs(2, "fresh-2b"), SYSTEM_B, "glm-5.3").action, "derived-persona");
    assert.equal(resolveSessionOrder(conv2, msgs(4, "fresh-2c"), SYSTEM_B, "glm-5.3").action, "derived-persona",
        "deep history does not rescue a missing anchored declaration either");

    // Unchanged header model does not corroborate (old row absorb-3): shared.
    resetSessionOrderForTest();
    const conv3 = "twin-same-model";
    const chainC = msgs(6, "d2");
    resolveSessionOrder(conv3, chainC, SYSTEM_A, "glm-4.6");
    assert.equal(resolveSessionOrder(conv3, msgs(4, "fresh-3"), SYSTEM_B, "glm-4.6").action, "derived-persona");

    // A genuinely different (review) system next to a model switch forks
    // (old row absorb-9): shared expectation — the review blob is not
    // main-shaped, so v2 never reaches the absorption branch.
    resetSessionOrderForTest();
    const conv4 = "twin-review";
    const chainI = msgs(6, "e2");
    resolveSessionOrder(conv4, chainI, SYSTEM_A, "glm-4.6");
    assert.equal(resolveSessionOrder(conv4, msgs(2, "fresh-9"), REVIEW_SYSTEM, "glm-5.3").key, forkKey(conv4, REVIEW_SYSTEM));
});

test("live twin: v2 does not parse the system line-diff — designed divergence from the old diff rules", () => {
    // Old rows absorb-4/absorb-5 FORK these shapes because the line-diff was
    // not confined to the model identity lines. NEW→reanchors raw on deep
    // histories: the persona tag is a LANE GUARD, not identity material —
    // v2 corroborates the switch on id + x-bili-plugin-model alone and never
    // inspects which system lines moved (owner rule 1: content is not
    // consulted for claiming; the tag only disambiguates lanes order cannot
    // tell apart). Behavioral change vs the retired ladder, pinned here so
    // the relaxation is visible rather than silent. One fresh id per diff
    // class, mirroring the old rows' isolation.
    resetSessionOrderForTest();
    const conv = "twin-nodiff-ws";
    const chainA = msgs(6, "f2");
    resolveSessionOrder(conv, chainA, SYSTEM_A, "glm-4.6");
    assert.equal(resolveSessionOrder(conv, msgs(4, "fresh-4"), SYSTEM_WORKSPACE, "glm-5.3").key, conv,
        "non-model line changed (workspace) + model header change keeps the raw key under v2");

    resetSessionOrderForTest();
    const conv2 = "twin-nodiff-lines";
    const chainB = msgs(6, "f3");
    resolveSessionOrder(conv2, chainB, SYSTEM_A, "glm-4.6");
    assert.equal(resolveSessionOrder(conv2, msgs(4, "fresh-5"), SYSTEM_EXTRA_LINE, "glm-5.3").key, conv2,
        "line-count change + model header change keeps the raw key under v2");
});

test("live twin: continuing history takes the continuation branch before the model branch", () => {
    // Old row absorb-8: a byte-exact continuation + model switch took plain
    // migrate (continuity ran first). Shared outcome — the raw key — but v2
    // reaches it through order+fragment evidence (head aligns AND head
    // fragments match), not through prefix-affinity chains: the persona lane
    // is chain-free since the wiring swap.
    resetSessionOrderForTest();
    const conv = "twin-continue";
    const chainA = msgs(6, "h2");
    resolveSessionOrder(conv, chainA, SYSTEM_A, "glm-4.6");
    const continuing = [...chainA, { role: "user", content: "next-turn-" + "z".repeat(120) }];
    const res = resolveSessionOrder(conv, continuing, SYSTEM_B, "glm-5.3");
    assert.equal(res.key, conv);
    assert.equal(res.action, "reanchor");
    assert.match(res.reason ?? "", /#2241\/#2250/);
});

test("live twin: fork keys are byte-identical to the retired ladder (persistence contract)", () => {
    // Persisted `|sub:` lanes must keep their sessions across the upgrade:
    // both implementations mint `<raw>|sub:<sha256(tag)[0..16]>`.
    resetSessionOrderForTest();
    const conv = "twin-keys";
    resolveSessionOrder(conv, msgs(6, "s"), SYSTEM_A, "glm-4.6");
    const newFork = resolveSessionOrder(conv, msgs(2, "x"), SYSTEM_B, "glm-5.3").key;
    assert.equal(newFork, `${conv}|sub:${fpOf(SYSTEM_B)}`);
    assert.equal(newFork.length, conv.length + "|sub:".length + 16);
});

test("live twin: the wired adapter personaConversationOrder returns the raw key on absorption", () => {
    // handle.ts consumes the adapter, not resolveSessionOrder — pin the
    // exact surface production calls (old row absorb-11's key assertion;
    // the log assertion itself belongs to the retired module's entry point
    // and stays in the section above).
    resetSessionOrderForTest();
    const conv = "twin-adapter";
    const chainA = msgs(6, "m");
    assert.equal(personaConversationOrder(conv, chainA, SYSTEM_A, "glm-4.6"), conv);
    assert.equal(personaConversationOrder(conv, msgs(4, "fresh-m"), SYSTEM_B, "glm-5.3"), conv);
});
