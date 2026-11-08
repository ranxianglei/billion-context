// #5686 (P1-2 + P1-1): the A∩B composite drift shape — a dsh native
// compaction checkpoint LANDED under bili's feet (overflow-force-compact +
// RETRY of the same in-flight request: head replaced by the checkpoint,
// tail byte-identical and therefore STRICTLY SHORTER overall), arriving on
// a turn whose system prompt dsh re-stamped differently (tagChanged). Every
// existing migration rung loses that shape: head alignment breaks
// (checkpoint ≠ first turn), byte-exact chains lack depth, and the #4778
// positional run is length-gated (`kinds.length >= recorded`). Result: the
// WHOLE MAIN CONVERSATION re-keys onto `<id>|sub:<fp>` — orphaning fold
// state, and because the forked lane's first visible message IS the
// checkpoint sentence, users see "session drifted, new session titled with
// a checkpoint" (#5517/#5656 cluster).
//
// Fix (src/session-resolve.ts): a FIFTH tag-change rung, exact mirror of the
// tag-invariant "truncated head, tail aligned and fragment-verified" branch
// doctrine — a STRICTLY SHORTER incoming whose tail kinds align AND whose
// last ≤TAIL_WINDOW turn fragments are byte-exact re-anchors the raw id
// instead of forking. P1-1 wires the same event through a new optional
// observer on personaConversationOrder so server-side forks finally leave a
// durable log line (they used to be completely silent).
//
// Scope honesty (documented in the issue): this rung rescues the
// overflow-RETRY shape (verbatim shorter tail). A pre-step compaction that
// EXTENDS the tail before resending still forks — safe direction (no
// substrate loss), tracked as a follow-up generalization to tail-containment.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personaConversationOrder, resetSessionOrderForTest, resolveSessionOrder, type SessionOrderResolution } from "../src/session-resolve.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";
const testRoot = mkdtempSync(join(tmpdir(), "bili-5686-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

type M = { role: string; content?: string | null };
const ID = "sess-5686-anchor";
const S1 = "You are DeepSeek Harness.\nModel: GLM-A.";
const S2 = "You are DeepSeek Harness NEXT.\nModel: GLM-B.\nBudget day 2."; // per-turn re-stamp shape
const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const CHECKPOINT = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.";

/** Sixteen persisted turns' worth (even parity, main-shaped). */
const TURN_TEXTS = Array.from({ length: 16 }, (_, i) => `turn-${i}-` + "c".repeat(64 + i));
const seedHistory: M[] = [
    { role: "system", content: S1 },
    ...TURN_TEXTS.map((t, i): M => ({ role: i % 2 === 0 ? "user" : "assistant", content: t })),
];
/** Verbatim last EIGHT content cells (seed index 9 = 8th turn). */
const VERBATIM_TAIL = seedHistory.slice(9);

test("#5686 P1-2: tag-changed STRICTLY-SHORTER verbatim tail re-anchors instead of forking", () => {
    resetSessionOrderForTest();
    const claim = resolveSessionOrder(ID, seedHistory, S1);
    assert.equal(claim.action, "claim");
    assert.equal(claim.key, ID);

    // Overflow-force-compact + retry: the same in-flight request re-sent
    // with the region head replaced by the checkpoint under a re-stamped
    // system prompt. Tail = the last eight cells, byte-identical.
    const retry: M[] = [
        { role: "system", content: S2 },
        { role: "user", content: CHECKPOINT },
        ...VERBATIM_TAIL,
    ];
    const res = resolveSessionOrder(ID, retry, S2);
    assert.equal(res.key, ID, "anchor kept on the raw id — no |sub: fork");
    assert.equal(res.action, "reanchor");
});

test("#5686 guardrail: shorter + tail-aligned but NOT fragment-exact still forks (stranger wearing the skeleton)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder(ID, seedHistory, S1);
    const retry: M[] = [
        { role: "system", content: S2 },
        { role: "user", content: CHECKPOINT },
        ...VERBATIM_TAIL.slice(0, -1),
        { role: "assistant", content: "mutated tail cell — different conversation, same skeleton" },
    ];
    const res = resolveSessionOrder(ID, retry, S2);
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, `${ID}|sub:${fp16(S2)}`);
});

test("#5686 symmetry regression: tag-INvariant shorter verbatim tail re-anchors (pre-existing branch untouched)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder(ID, seedHistory, S1);
    const retry: M[] = [
        { role: "system", content: S1 },
        { role: "user", content: CHECKPOINT },
        ...VERBATIM_TAIL,
    ];
    const res = resolveSessionOrder(ID, retry, S1);
    assert.equal(res.key, ID);
    assert.equal(res.action, "reanchor");
});

test("#5686 P1-1: personaConversationOrder delivers every resolution to the observer", () => {
    resetSessionOrderForTest();
    const seen: SessionOrderResolution[] = [];
    const obs = (_rawId: string, r: SessionOrderResolution): void => { seen.push(r); };
    const k1 = personaConversationOrder(ID, seedHistory, S1, undefined, undefined, undefined, obs);
    assert.equal(k1, ID);
    assert.deepEqual(seen.map((r) => r.action), ["claim"]);

    // Forking shape: tag changed, shorter, NON-verbatim tail, non-aligned
    // kinds run (lucky-skeleton stranger).
    const stranger: M[] = [
        { role: "system", content: S2 },
        { role: "user", content: "fresh unrelated question" },
        { role: "assistant", content: "unrelated answer one" },
        { role: "user", content: "unrelated follow-up two" },
    ];
    const k2 = personaConversationOrder(ID, stranger, S2, undefined, undefined, undefined, obs);
    assert.equal(k2, `${ID}|sub:${fp16(S2)}`);
    assert.deepEqual(seen.map((r) => r.action).slice(-1), ["derived-persona"]);
    assert.equal(seen[seen.length - 1].key, `${ID}|sub:${fp16(S2)}`);
});
