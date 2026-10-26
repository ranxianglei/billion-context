// #2944: session-resolve v2 — order+id claim on the WIRE-NEUTRAL domain.
//
// The SAME scenario corpus runs through BOTH implementations:
//   OLD: src/persona-anchor.ts (the fp ladder — behavior pinned FIRST as
//        the 瞄点; these assertions must pass against the current file
//        untouched — stage 1 of #2942 neutralizeToolPrompts is NOT on this
//        branch and is intentionally not pinned here)
//   NEW: src/session-resolve.ts (order+id claim; skeleton = neutralTurns
//        kinds — content-blind by construction, all four wires covered,
//        leading system run / client markers / image placeholders stripped
//        by the #2791 projection)
// Rows where the two agree share one expectation; designed divergences are
// marked old→new with the #2944 principle that justifies them.
//
// Special proofs (特殊代码证明) required by the owner:
//   P1 50% mid-conversation content churn, same order + same length →
//      SAME session (old: raw via migrate/fp-equal; new: continue — the
//      skeleton never saw the churn).
//   P2 shallow review blob under a claimed id → NEVER claims raw
//      (old: fork |sub:<fp>; new: rides/forks per the recorded branches —
//      the #1916 race died because reviews arrive on an already-claimed
//      id, never at first sight; first sight always claims (codex #316)).
//   P3 head truncation (native compaction) under same id → raw +
//      re-anchor (old: raw via fp-equal rescue; new: reanchor).
//   P4 growth → continue raw (both).
//   P5 deep main-shaped history sharing nothing with the recorded
//      skeleton → derived, not raw (guard rail).
//   P6 (new, v2-only) cross-wire: the SAME logical conversation rendered on
//      all four wires yields the IDENTICAL skeleton and the identical
//      resolution sequence — v1's raw-field kind strings could never do
//      this (block-type strings differ per wire).
//   P7 (new, v2-only) leading-system add/remove + client-marker turn
//      injection leave the skeleton unchanged (host machinery, not
//      conversation shape).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic dirs BEFORE imports (same idiom as the issue2601 suite).
const XDG = mkdtempSync(join(tmpdir(), "issue2944v2-"));
process.env.XDG_DATA_HOME = join(XDG, "data");
process.env.XDG_STATE_HOME = join(XDG, "state");
process.env.BILI_PERSIST = "0";
process.env.NODE_ENV = "test";

const { prefixAffinity } = await import("../src/prefix-affinity.ts");
// retired-module pin: persona-anchor — intentional dual-run 瞄点 (this suite
// is the #2989 pattern: OLD ladder characterized beside the live resolver);
// production routes through src/session-resolve.ts since #2815.
const { resetPersonaAnchorsForTest, resolvePersonaKey } = await import("../src/persona-anchor.ts");
const { resolveSessionOrder, resetSessionOrderForTest, sessionOrderSkeletonOf, orderSkeletonOf } = await import("../src/session-resolve.ts");
import type { SessionOrderResolution } from "../src/session-resolve.ts";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);
const skel8 = (kinds: string[]): string => createHash("sha256").update(kinds.join("\u0000")).digest("hex").slice(0, 8);
const skel16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

type Msg = { role: string; content: string };

/** Alternating user/assistant turns, ~120 chars each. */
function msgs(n: number, tag = "m"): Msg[] {
    const out: Msg[] = [];
    for (let i = 0; i < n; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        out.push({ role, content: `${tag} #${i} — ${tag} message body with enough prose to be a realistic cell ${"x".repeat(80)}` });
    }
    return out;
}

/** Rewrites the content of every even-indexed message (50% churn) while
 *  keeping roles, order and length identical. */
function churn50(list: Msg[]): Msg[] {
    return list.map((m, i) => (i % 2 === 0 ? { ...m, content: `REWRITTEN ${i}: completely different words, same slot ${"y".repeat(80)}` } : m));
}

// Shared system inputs — the NEW resolver never receives them; they exist
// so the corpus is identical for the OLD run.
const BASE_SYSTEM = "You are dsh, a desktop shell agent. " + "ambient config line. ".repeat(40);
const DRIFTED_SYSTEM = BASE_SYSTEM.replace("ambient config line.", "ambient config line (v2 with more words).");
const REVIEW_SYSTEM = "You are an automated reviewer. Output only XML verdict tags.";
const conv = "session-2944v2";

function seedChain(id: string, chain: Msg[]): void {
    resetPersonaAnchorsForTest();
    prefixAffinity.forget(id);
    const fp = prefixAffinity.chainFingerprint(chain);
    if (fp) prefixAffinity.note(id, fp.depth, fp.tailHash, fp.itemHashes, true);
}

// ---------------------------------------------------------------------------
// OLD resolver: characterization pins (瞄点) — current ladder, untouched.
test("old ladder: characterization pins", () => {
    // S1: first sight claims raw.
    seedChain(conv, msgs(6, "seed"));
    assert.equal(resolvePersonaKey(conv, BASE_SYSTEM, msgs(6, "seed")).key, conv);

    // S2: fp equal → match raw.
    assert.equal(resolvePersonaKey(conv, BASE_SYSTEM, msgs(10, "seed")).key, conv);

    // S3: fp drift + chain continues → migrate raw (anchor moves).
    const s3 = resolvePersonaKey(conv, DRIFTED_SYSTEM, msgs(10, "seed"));
    assert.equal(s3.key, conv);
    assert.equal(s3.action, "migrate");

    // S4: fp drift + 50% content churn + chain continues → still raw
    //     (migrate — the ladder keys REPRESENTATION and forgives via chain).
    assert.equal(resolvePersonaKey(conv, DRIFTED_SYSTEM, churn50(msgs(10, "seed"))).key, conv);

    // S5: truncated history under same id → raw (fp-equal rescue).
    assert.equal(resolvePersonaKey(conv, DRIFTED_SYSTEM, msgs(6, "seed").slice(3)).key, conv);

    // S6: review blob under a claimed id → fork |sub:<fp>.
    const blob = msgs(1, "review-blob").map((m) => ({ ...m, role: "user" }));
    assert.equal(resolvePersonaKey(conv, REVIEW_SYSTEM, blob).key, `${conv}|sub:${sha(REVIEW_SYSTEM)}`);
});

// ---------------------------------------------------------------------------
// NEW resolver: same corpus, order+id semantics.
test("new resolver: same corpus, order+id semantics", () => {
    resetSessionOrderForTest();

    // S1: first sight, main-shaped → claim raw.
    assert.equal(resolveSessionOrder(conv, msgs(6, "seed")).key, conv);

    // S2/P4: growth → continue raw.
    const s2 = resolveSessionOrder(conv, msgs(10, "seed"));
    assert.equal(s2.key, conv);
    assert.equal(s2.action, "continue");

    // S3: system drift invisible — the resolver takes no system input at
    //     all; the history is IDENTICAL to S2 → continue (old→new: the old
    //     ladder had to MIGRATE through chain-continuity to get here).
    const s3: SessionOrderResolution = resolveSessionOrder(conv, msgs(10, "seed"));
    assert.equal(s3.key, conv);
    assert.equal(s3.action, "continue");

    // S4/P1: 50% content churn, same kinds → SAME session. The recorded
    // skeleton is content-blind: the churn leaves it byte-identical
    // (old→new: old needed the chainContinues rescue → migrate).
    const s4 = resolveSessionOrder(conv, churn50(msgs(10, "seed")));
    assert.equal(s4.key, conv);
    assert.equal(s4.action, "continue");
    assert.deepEqual(sessionOrderSkeletonOf(conv), orderSkeletonOf(msgs(10, "seed")));

    // S5/P3: truncated head, tail aligns → raw + reanchor; the skeleton
    // follows the host's truth (re-anchored to the truncated kinds).
    // S5/P3: truncated head, tail aligns → raw + reanchor. The truncated
    //     history is a VERBATIM SUFFIX of the recorded one (recorded =
    //     churn50(msgs(10)) after S4; slice(7) keeps its last three turns
    //     byte-identical — what native compaction actually produces, and
    //     exactly what the fragment guard verifies).
    const s5 = resolveSessionOrder(conv, churn50(msgs(10, "seed")).slice(7));
    assert.equal(s5.key, conv);
    assert.equal(s5.action, "reanchor");
    assert.deepEqual(sessionOrderSkeletonOf(conv), orderSkeletonOf(churn50(msgs(10, "seed")).slice(7)));

    // S6/P2: shallow blob under claimed id, TAG-LESS (the module-level
    // corpus calls the resolver without a persona tag): rides the raw key —
    // the old ladder's non-anchoring path for system-less calls. A REAL
    // dsh review carries the REVIEW_POLICY system, which the wired
    // resolver sees as a different personaTag and forks onto
    // `|sub:<fp16(tag)>` (pinned in the dsh-persona e2e suites).
    const blob = msgs(1, "review-blob").map((m) => ({ ...m, role: "user" }));
    const s6 = resolveSessionOrder(conv, blob);
    assert.equal(s6.key, conv);
    assert.equal(s6.action, "continue");
    // The same blob WITH a persona tag forks onto the stable lane key.
    const s6b = resolveSessionOrder(conv, blob, "You are the reviewer.");
    assert.equal(s6b.key, `${conv}|sub:${skel16("You are the reviewer.")}`);
    assert.equal(s6b.action, "derived-persona");
});

// P5 guard rail: deep main-shaped history sharing NOTHING with the recorded
// skeleton under the same id → derived-task, never raw. The task key is
// DISCRIMINATED by skeleton hash (v2.1): two different strangers never
// share one compression session.
test("P5: deep main-shaped stranger → derived-task (skeleton-hash key)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder(conv, msgs(8, "seed"));
    const stranger: Msg[] = [];
    const roles = ["user", "user", "user", "assistant", "user", "assistant", "user", "assistant", "assistant"];
    roles.forEach((r, i) => stranger.push({ role: r, content: `stranger ${i} ${"z".repeat(60)}` }));
    const res = resolveSessionOrder(conv, stranger);
    assert.equal(res.key, `${conv}|sub:task:${skel8(orderSkeletonOf(stranger))}`);
    assert.equal(res.action, "derived-task");
    // The same stranger replaying across passes keeps a STABLE key.
    assert.equal(resolveSessionOrder(conv, stranger).key, res.key);
});

// ---------------------------------------------------------------------------
// P8 (v2.1): mixed traffic under ONE main id — the real-corpus proof
// scenarios (/tmp/mixed-traffic.mjs), pinned. Two holes the order-only v2
// draft had and the fragment guard rail closes:
//   (a) a codex-style subagent replay (#150 id reuse) is SHORTER with an
//       alternating tail that ALIGNs — order-identical to genuine head
//       truncation. Only the tail CONTENT fragments separate them: genuine
//       compaction keeps the old tail messages verbatim (frags equal), a
//       subagent carries different content (frags differ).
//   (b) two different subagents under one main id must not collide on one
//       |sub:task key — the skeleton-hash discriminator splits them.
test("P8: mixed traffic — subagent replays never steal the raw key", () => {
    resetSessionOrderForTest();
    const main = msgs(7, "seed"); // u a u a u a u
    assert.equal(resolveSessionOrder(conv, main).action, "claim");

    // Subagent A: shorter, tail aligns by alternation, different content →
    // the fragment guard fails the raw branch → derived-task.
    const subA: Msg[] = [
        { role: "user", content: `subagent question about the codebase ${"s".repeat(80)}` },
        { role: "assistant", content: `subagent answer ${"s".repeat(80)}` },
        { role: "user", content: `subagent follow-up ${"s".repeat(80)}` },
    ];
    const rA = resolveSessionOrder(conv, subA);
    assert.equal(rA.action, "derived-task");
    assert.equal(rA.key, `${conv}|sub:task:${skel8(orderSkeletonOf(subA))}`);
    // Replay of the SAME subagent keeps the stable key.
    assert.equal(resolveSessionOrder(conv, subA).key, rA.key);

    // Subagent B: a different shape → a different task key (no collision).
    const subB: Msg[] = [
        { role: "user", content: `second subagent ${"w".repeat(80)}` },
        { role: "user", content: `more context ${"w".repeat(80)}` },
        { role: "assistant", content: `second answer ${"w".repeat(80)}` },
        { role: "user", content: `second follow-up ${"w".repeat(80)}` },
        { role: "assistant", content: `done ${"w".repeat(80)}` },
    ];
    const rB = resolveSessionOrder(conv, subB);
    assert.equal(rB.action, "derived-task");
    assert.notEqual(rB.key, rA.key);

    // Aux title traffic, tag-less → rides raw (old non-anchoring path);
    // with its title persona tag → its own stable lane (production shape).
    const aux: Msg[] = [{ role: "user", content: `generate a title for this conversation ${"t".repeat(80)}` }];
    assert.equal(resolveSessionOrder(conv, aux).key, conv);
    const rAux = resolveSessionOrder(conv, aux, "You are a title generator.");
    assert.equal(rAux.action, "derived-persona");
    assert.equal(rAux.key, `${conv}|sub:${skel16("You are a title generator.")}`);

    // The main conversation keeps flowing on the raw key through all of it.
    const rMain = resolveSessionOrder(conv, msgs(9, "seed"));
    assert.equal(rMain.action, "continue");
    assert.equal(rMain.key, conv);

    // Genuine truncation (dsh native compaction): head cut, the surviving
    // tail messages VERBATIM → fragment guard passes → raw + reanchor.
    const truncated = msgs(9, "seed").slice(6); // last 3 turns, verbatim objects
    const rTr = resolveSessionOrder(conv, truncated);
    assert.equal(rTr.action, "reanchor");
    assert.equal(rTr.key, conv);
});

// Aux traffic FIRST (before any main claim) must never claim raw.
test("shallow-first: aux blob on virgin id → derived-aux, raw unclaimed", () => {
    resetSessionOrderForTest();
    const blob = msgs(1, "x").map((m) => ({ ...m, role: "user" }));
    const res = resolveSessionOrder("session-virgin", blob);
    assert.equal(res.action, "derived-aux");
    assert.equal(res.key, "session-virgin|sub:aux");
    // The blob records NOTHING under the raw id — only a main-shaped
    // history may establish the skeleton.
    assert.equal(sessionOrderSkeletonOf("session-virgin"), undefined);
    // And the main conversation arriving afterwards still claims raw.
    const main = resolveSessionOrder("session-virgin", msgs(6, "main"));
    assert.equal(main.action, "claim");
    assert.equal(main.key, "session-virgin");
    assert.deepEqual(sessionOrderSkeletonOf("session-virgin"), orderSkeletonOf(msgs(6, "main")));
});

// Skeleton is content-blind by construction: kinds of a churned history are
// identical to the original, on every wire shape.
test("orderSkeletonOf ignores content, keeps role/tool shape", () => {
    const a = msgs(6, "seed");
    const b = churn50(a);
    assert.deepEqual(orderSkeletonOf(a), orderSkeletonOf(b));
    // Tool turns are their own skeleton cells on every wire (shape, not
    // content — the tool NAME/ARGS live in text/calls, not in kind).
    const openaiTool = [
        { role: "user", content: "list the files" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "assistant", content: "done" },
    ];
    const anthropicTool = [
        { role: "user", content: [{ type: "text", text: "list the files" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    assert.deepEqual(orderSkeletonOf(openaiTool), ["user", "assistant", "tool", "assistant"]);
    assert.deepEqual(orderSkeletonOf(anthropicTool), ["user", "assistant", "tool", "assistant"]);
});

// ---------------------------------------------------------------------------
// P6 (v2-only): the SAME logical conversation, rendered on all four wires,
// yields the IDENTICAL skeleton — and the resolution sequence is identical
// (claim on first sight, continue on growth). v1's raw-field kind strings
// were per-wire ("assistant:tool_use" vs "assistant:tool_calls") and could
// never pass this proof.
test("P6: cross-wire — same conversation, four renderings, one skeleton", () => {
    // Logical conversation: u0 a0 u1 A(tool c1) T(c1) a2 u3 a3
    const openai = [
        { role: "user", content: "u0 question" },
        { role: "assistant", content: "a0 answer" },
        { role: "user", content: "u1 run the tool" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "assistant", content: "a2 done" },
        { role: "user", content: "u3 follow up" },
        { role: "assistant", content: "a3 final" },
    ];
    const anthropic = [
        { role: "user", content: [{ type: "text", text: "u0 question" }] },
        { role: "assistant", content: [{ type: "text", text: "a0 answer" }] },
        { role: "user", content: [{ type: "text", text: "u1 run the tool" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
        { role: "assistant", content: [{ type: "text", text: "a2 done" }] },
        { role: "user", content: [{ type: "text", text: "u3 follow up" }] },
        { role: "assistant", content: [{ type: "text", text: "a3 final" }] },
    ];
    const google = [
        { role: "user", parts: [{ text: "u0 question" }] },
        { role: "model", parts: [{ text: "a0 answer" }] },
        { role: "user", parts: [{ text: "u1 run the tool" }] },
        { role: "model", parts: [{ functionCall: { name: "bash", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { response: { output: "ok" } } }] },
        { role: "model", parts: [{ text: "a2 done" }] },
        { role: "user", parts: [{ text: "u3 follow up" }] },
        { role: "model", parts: [{ text: "a3 final" }] },
    ];
    const responses = [
        { type: "message", role: "user", content: "u0 question" },
        { type: "message", role: "assistant", content: "a0 answer" },
        { type: "message", role: "user", content: "u1 run the tool" },
        { type: "function_call", call_id: "c1", name: "bash", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
        { type: "message", role: "assistant", content: "a2 done" },
        { type: "message", role: "user", content: "u3 follow up" },
        { type: "message", role: "assistant", content: "a3 final" },
    ];
    const expected = ["user", "assistant", "user", "assistant", "tool", "assistant", "user", "assistant"];
    assert.deepEqual(orderSkeletonOf(openai), expected);
    assert.deepEqual(orderSkeletonOf(anthropic), expected);
    assert.deepEqual(orderSkeletonOf(google), expected);
    assert.deepEqual(orderSkeletonOf(responses), expected);

    // Identity across wires: claim on wire A, GROW on wire B → continue.
    // (A stateless client switched protocol mid-conversation — #2791's
    // scenario — keeps the raw key and its fold ledger.)
    resetSessionOrderForTest();
    const id = "cross-wire-conv";
    assert.equal(resolveSessionOrder(id, openai).action, "claim");
    const grownAnthropic = [...anthropic, { role: "user", content: [{ type: "text", text: "u4 next" }] }, { role: "assistant", content: [{ type: "text", text: "a4" }] }];
    const res = resolveSessionOrder(id, grownAnthropic);
    assert.equal(res.action, "continue");
    assert.equal(res.key, id);
    const grownGoogle = [...google, { role: "user", parts: [{ text: "u4 next" }] }, { role: "model", parts: [{ text: "a4" }] }];
    assert.equal(resolveSessionOrder(id, grownGoogle).action, "continue");
    const grownResponses = [...responses, { type: "message", role: "user", content: "u4 next" }, { type: "message", role: "assistant", content: "a4" }];
    assert.equal(resolveSessionOrder(id, grownResponses).action, "continue");
});

// ---------------------------------------------------------------------------
// P7 (v2-only): host machinery must not move the skeleton.
test("P7: leading-system add/remove + client-marker turn leave the skeleton unchanged", () => {
    const base = msgs(6, "seed");
    const withSystem = [
        { role: "system", content: "You are dsh. " + "harness state: date cwd budget. ".repeat(20) },
        ...base,
    ];
    const withMarker = [
        ...base.slice(0, 4),
        { role: "user", content: "[model changed: glm-5.3 → qwen3.8-27b]" },
        ...base.slice(4),
    ];
    assert.deepEqual(orderSkeletonOf(withSystem), orderSkeletonOf(base));
    assert.deepEqual(orderSkeletonOf(withMarker), orderSkeletonOf(base));

    // And the resolver agrees: claim the base, then arrive with system
    // rows and a marker turn injected → continue (v1 would misalign the
    // skeleton and derive |sub:task).
    resetSessionOrderForTest();
    const id = "machinery-conv";
    assert.equal(resolveSessionOrder(id, base).action, "claim");
    const res = resolveSessionOrder(id, [...withSystem.slice(0, 1), ...withMarker]);
    assert.equal(res.action, "continue");
    assert.equal(res.key, id);
});

// ---------------------------------------------------------------------------
// Owner review of #2815, finding ①: post-restart persona race. After a
// restart the in-memory skeleton is cold; a shallow tagged aux request
// (title/review) can claim the virgin raw id FIRST, and the main
// conversation then arrives tagChanged with headFragsEqual false — without
// the persisted-chain rung it forks off the raw key for the process
// lifetime (#2156 form). The persisted prefix-affinity chain (kept intact
// by the append-only discipline — the shallow blob note cannot clobber the
// deeper entry) must migrate the main lane back onto raw.
test("post-restart persona race: shallow aux claims first, persisted chain saves the main lane", () => {
    resetSessionOrderForTest();
    const id = "race-restart-1";
    prefixAffinity.forget(id);
    // Pre-restart: the MAIN conversation ran under this id — its chain is
    // persisted (importSnapshot at boot; seeded here via note()).
    const mainHistory = msgs(8, "main");
    const fp2 = prefixAffinity.chainFingerprint(mainHistory);
    assert.ok(fp2);
    prefixAffinity.note(id, fp2.depth, fp2.tailHash, fp2.itemHashes, true);
    // Post-restart: skeleton cold. The aux request arrives first and claims
    // the virgin raw id (tag present → claim).
    const blob = msgs(1, "aux-blob").map((m) => ({ ...m, role: "user" }));
    const a = resolveSessionOrder(id, blob, "You generate a short chat title.");
    assert.equal(a.key, id);
    assert.equal(a.action, "claim");
    // The main conversation arrives: tagChanged, headAligns trivially true
    // (recorded is one user turn), headFragsEqual false (blob ≠ main user0),
    // same model → no header corroboration. The persisted chain continues →
    // migrate back onto raw instead of forking to a persona lane.
    const b = resolveSessionOrder(id, mainHistory, BASE_SYSTEM);
    assert.equal(b.key, id);
    assert.equal(b.action, "reanchor");
    assert.match(b.reason ?? "", /persisted chain/);
    // Subsequent main turns keep continuing raw.
    const c = resolveSessionOrder(id, [...mainHistory, { role: "user", content: "next main turn after the race" }], BASE_SYSTEM);
    assert.equal(c.key, id);
    assert.equal(c.action, "continue");
    prefixAffinity.forget(id);
});

test("post-restart race control: no chain evidence → persona lane (unchanged)", () => {
    resetSessionOrderForTest();
    const id = "race-restart-2";
    prefixAffinity.forget(id);
    // Same race shape, but the id carries NO persisted chain (never a main
    // session, or the entry was evicted): the designed divergence stands.
    const blob = msgs(1, "aux-blob").map((m) => ({ ...m, role: "user" }));
    const a = resolveSessionOrder(id, blob, "You generate a short chat title.");
    assert.equal(a.action, "claim");
    const b = resolveSessionOrder(id, msgs(8, "main"), BASE_SYSTEM);
    assert.equal(b.action, "derived-persona");
    assert.equal(b.key, `${id}|sub:${skel16(BASE_SYSTEM)}`);
    prefixAffinity.forget(id);
});
