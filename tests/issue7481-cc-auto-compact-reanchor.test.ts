// #7481: CC auto-compact in manual /bili/ mode — after every Claude Code
// auto-compact, the next main-session request resolves to a NEW
// derived-persona lane (zero inherited folds, usage baseline 0) instead of
// re-anchoring on the same lane. The docs claimed this was "usually harmless
// (bili re-derives state from the truncation)" — it is not.
//
// Mechanism: the post-compact request shape is
//   [summary user msg] + [preserved verbatim tail] + [new user prompt]
// with tagChanged true (system text changed). The #5686 shorter-tail rung
// compares the last TAIL_WINDOW cells INCLUDING the trailing new prompt →
// offset by 1 → tailAligns/fragTailEquals mismatch → deterministic fork.
//
// Fix (src/session-resolve.ts): a new tag-change rung that tolerates the
// trailing offset — a byte-identical fragment-verified tail (excluding the
// trailing prompt) cannot belong to a different conversation
// (MESSAGE-IDENTITY), so re-anchor instead of forking.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSessionOrderForTest, resolveSessionOrder } from "../src/session-resolve.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";
const testRoot = mkdtempSync(join(tmpdir(), "bili-7481-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

type M = { role: string; content?: string | null };
const ID = "sess-7481-cc-compact";
const S1 = "You are Claude Code.\nModel: claude-opus-5-5.";
const S2 = "You are Claude Code.\nModel: claude-opus-5-5.\n[compacted]"; // system text changed post-compact
const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

/** Twenty persisted turns (even parity, main-shaped). */
const TURN_TEXTS = Array.from({ length: 20 }, (_, i) => `turn-${i}-` + "c".repeat(64 + i));
const seedHistory: M[] = [
    { role: "system", content: S1 },
    ...TURN_TEXTS.map((t, i): M => ({ role: i % 2 === 0 ? "user" : "assistant", content: t })),
];
/** Verbatim last TEN content cells (seed index 11 = 10th turn). */
const VERBATIM_TAIL = seedHistory.slice(11);

test("#7481: CC auto-compact shape (summary + preserved tail + new prompt, tagChanged) re-anchors instead of forking", () => {
    resetSessionOrderForTest();
    const claim = resolveSessionOrder(ID, seedHistory, S1);
    assert.equal(claim.action, "claim");
    assert.equal(claim.key, ID);

    // CC auto-compact: the head is replaced by a summary, the tail is
    // preserved verbatim, and a new user prompt is appended. The system
    // text changed (tagChanged). The trailing new prompt offsets the tail
    // by 1 — the #5686 rung misses, the new #7481 rung catches it.
    const SUMMARY = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";
    const NEW_PROMPT = "Please continue with the next step.";
    const postCompact: M[] = [
        { role: "system", content: S2 },
        { role: "user", content: SUMMARY },
        ...VERBATIM_TAIL,
        { role: "user", content: NEW_PROMPT },
    ];
    const res = resolveSessionOrder(ID, postCompact, S2);
    assert.equal(res.key, ID, "anchor kept on the raw id — no |sub: fork");
    assert.equal(res.action, "reanchor");
    assert.ok(res.reason?.includes("#7481"), `reason should cite #7481, got: ${res.reason}`);
});

test("#7481 guardrail: shorter + tail-aligned (offset) but NOT fragment-exact still forks (stranger wearing the skeleton)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder(ID, seedHistory, S1);
    const SUMMARY = "This session is being continued from a previous conversation.";
    const NEW_PROMPT = "Please continue.";
    // Mutate the last tail cell — the fragment no longer matches.
    const mutatedTail = VERBATIM_TAIL.slice(0, -1);
    mutatedTail.push({ role: "assistant", content: "mutated tail cell — different conversation, same skeleton" });
    const postCompact: M[] = [
        { role: "system", content: S2 },
        { role: "user", content: SUMMARY },
        ...mutatedTail,
        { role: "user", content: NEW_PROMPT },
    ];
    const res = resolveSessionOrder(ID, postCompact, S2);
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, `${ID}|sub:${fp16(S2)}`);
});

test("#7481: second compact on the re-anchored lane also re-anchors (stays on main)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder(ID, seedHistory, S1);

    // First compact: re-anchor.
    const SUMMARY1 = "This session is being continued from a previous conversation that ran out of context. Part 1.";
    const NEW_PROMPT1 = "Please continue with the next step.";
    const postCompact1: M[] = [
        { role: "system", content: S2 },
        { role: "user", content: SUMMARY1 },
        ...VERBATIM_TAIL,
        { role: "user", content: NEW_PROMPT1 },
    ];
    const r1 = resolveSessionOrder(ID, postCompact1, S2);
    assert.equal(r1.key, ID, "first compact re-anchors");
    assert.equal(r1.action, "reanchor");

    // Continue the conversation: add a few more turns.
    const continuation: M[] = [
        ...postCompact1,
        { role: "assistant", content: "ok, continuing. " + "a".repeat(80) },
        { role: "user", content: "next question. " + "b".repeat(80) },
        { role: "assistant", content: "answer. " + "c".repeat(80) },
    ];
    resolveSessionOrder(ID, continuation, S2);

    // Second compact: the tail is now the last 10 cells of `continuation`.
    const SUMMARY2 = "This session is being continued from a previous conversation that ran out of context. Part 2.";
    const NEW_PROMPT2 = "Please continue further.";
    const verbatimTail2 = continuation.slice(-10);
    const postCompact2: M[] = [
        { role: "system", content: S2 + "\n[compacted again]" },
        { role: "user", content: SUMMARY2 },
        ...verbatimTail2,
        { role: "user", content: NEW_PROMPT2 },
    ];
    const r2 = resolveSessionOrder(ID, postCompact2, S2 + "\n[compacted again]");
    assert.equal(r2.key, ID, "second compact re-anchors — stays on main lane");
    assert.equal(r2.action, "reanchor");
});
