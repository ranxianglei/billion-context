import test from "node:test";
import assert from "node:assert/strict";
import {
  applySteeringToPrompt,
  clampEffortToFloor,
  classifyTurn,
  decideOutputSteering,
  DEFAULT_OUTPUT_STEERING_CONFIG,
  DEFAULT_STEERING_SENTINEL,
  EFFORT_LADDER,
  renderSteeringBlock,
  resolveOutputSteeringConfig,
  resolveVerbosityLevel,
  VERBOSITY_LEVELS,
  verbosityDirective,
} from "../src/output-steering.js";
import type {
  OutputSteeringConfig,
  StructuralBlock,
  StructuralMessage,
} from "../src/output-steering.js";

const ON: OutputSteeringConfig = {
  enabled: true,
  verbosityLevel: 2,
  effortRouting: true,
};

const userText = (text: string): StructuralMessage => ({ role: "user", text });
const userBlocks = (blocks: StructuralBlock[]): StructuralMessage => ({
  role: "user",
  blocks,
});
const assistant = (): StructuralMessage => ({ role: "assistant" });
const toolResult = (isError = false): StructuralBlock => ({
  kind: "tool_result",
  ...(isError ? { isError: true } : {}),
});
const textBlock = (): StructuralBlock => ({ kind: "text" });

// ---- classifyTurn ----

test("classifyTurn: empty list and non-user last message are unknown", () => {
  assert.equal(classifyTurn([]), "unknown");
  assert.equal(classifyTurn([assistant()]), "unknown");
  assert.equal(classifyTurn([userText("hi"), assistant()]), "unknown");
});

test("classifyTurn: string content — non-empty asks, empty/whitespace unknown", () => {
  assert.equal(classifyTurn([userText("hi")]), "new_user_ask");
  assert.equal(classifyTurn([userText("")]), "unknown");
  assert.equal(classifyTurn([userText("   \n\t")]), "unknown");
});

test("classifyTurn: tool_result composition", () => {
  assert.equal(
    classifyTurn([userBlocks([toolResult()])]),
    "mechanical_continuation",
  );
  assert.equal(
    classifyTurn([userBlocks([toolResult(), toolResult()])]),
    "mechanical_continuation",
  );
  assert.equal(
    classifyTurn([userBlocks([toolResult(true)])]),
    "error_continuation",
  );
  assert.equal(
    classifyTurn([userBlocks([toolResult(), toolResult(true)])]),
    "error_continuation",
  );
});

test("classifyTurn: any user-signal block short-circuits to new_user_ask", () => {
  assert.equal(
    classifyTurn([userBlocks([toolResult(), textBlock()])]),
    "new_user_ask",
  );
  assert.equal(classifyTurn([userBlocks([{ kind: "image" }])]), "new_user_ask");
  assert.equal(
    classifyTurn([userBlocks([{ kind: "document" }])]),
    "new_user_ask",
  );
});

test("classifyTurn: unrecognized composition is unknown, never a guess", () => {
  assert.equal(classifyTurn([userBlocks([])]), "unknown");
  assert.equal(classifyTurn([{ role: "user" }]), "unknown");
  const mystery: StructuralBlock = JSON.parse('{"kind":"mystery_block"}');
  assert.equal(classifyTurn([userBlocks([toolResult(), mystery])]), "unknown");
  const nullBlock: StructuralBlock = JSON.parse("null");
  assert.equal(
    classifyTurn([userBlocks([toolResult(), nullBlock])]),
    "unknown",
  );
});

test("normalize contract: openai trailing-tool fold ⇒ mechanical", () => {
  // Adapter folds trailing role:"tool" messages into one synthetic user message.
  const folded: StructuralMessage[] = [
    userText("hi"),
    assistant(),
    userBlocks([toolResult()]),
  ];
  assert.equal(classifyTurn(folded), "mechanical_continuation");
});

test("normalize contract: responses full-history re-send ⇒ mechanical", () => {
  // Original ask + call + trailing output; backward walk lands on the output.
  const resent: StructuralMessage[] = [
    userText("fix the bug"),
    assistant(),
    userBlocks([toolResult()]),
  ];
  assert.equal(classifyTurn(resent), "mechanical_continuation");
});

test("normalize contract: responses pending call with no output ⇒ unknown", () => {
  const pending: StructuralMessage[] = [userText("do X"), assistant()];
  assert.equal(classifyTurn(pending), "unknown");
});

test("normalize contract: fresh user signal at the tail blocks lowering", () => {
  const fresh: StructuralMessage[] = [
    userText("do X"),
    assistant(),
    userBlocks([toolResult()]),
    userText("now do Y"),
  ];
  assert.equal(classifyTurn(fresh), "new_user_ask");
});

test("normalize contract: google functionResponse-only turn ⇒ mechanical", () => {
  assert.equal(
    classifyTurn([userBlocks([toolResult()])]),
    "mechanical_continuation",
  );
});

// ---- Verbosity levels (byte-stable) ----

test("VERBOSITY_LEVELS are byte-stable across versions (frozen baseline)", () => {
  assert.equal(
    VERBOSITY_LEVELS[1],
    "Skip preamble and postamble. Do not announce what you are about to do or recap what you just did; start with the substance.",
  );
  assert.equal(
    VERBOSITY_LEVELS[2],
    "Skip preamble and postamble; start with the substance. Never restate code, file contents, diffs, or tool output that already appear in this conversation — reference them by path and line instead. After a tool call succeeds, continue without narrating the result.",
  );
  assert.equal(
    VERBOSITY_LEVELS[3],
    "Skip preamble and postamble. Never restate code, file contents, diffs, or tool output already in this conversation — cite the exact file path and line or symbol instead, always; a reference that omits the location is not a reference. Give conclusions only; omit rationale unless the user asks why. Prefer the smallest edit over rewriting whole files. Keep prose to the minimum needed to be unambiguous. Never drop anything the turn or task needs to be correct, including negations (not, never, no, only, except) — shorten how you say it, not what you say. Use full prose for destructive or irreversible actions, security warnings, and any multi-step sequence where brevity would create ambiguity.",
  );
  assert.equal(
    VERBOSITY_LEVELS[4],
    "Minimum tokens. Fragments fine. No preamble, no postamble, no restating context, no rationale. Answer, smallest-possible edits, nothing else. Never drop anything the turn or task needs to be correct, including negations (not, never, no, only, except). Use full prose for destructive or irreversible actions, security warnings, and any multi-step sequence where brevity would create ambiguity.",
  );
  assert.equal(VERBOSITY_LEVELS[0], undefined, "L0 has no directive");
  assert.equal(VERBOSITY_LEVELS[5], undefined);
});

test("verbosityDirective: L0 and out-of-range yield null", () => {
  assert.equal(verbosityDirective(0), null);
  assert.equal(verbosityDirective(5), null);
  assert.equal(verbosityDirective(-1), null);
  assert.equal(verbosityDirective(2.5), null);
  for (const lvl of [1, 2, 3, 4])
    assert.equal(verbosityDirective(lvl), VERBOSITY_LEVELS[lvl]);
});

test("renderSteeringBlock: sentinel-wrapped, distinct per level, custom sentinel supported", () => {
  const l2 = renderSteeringBlock(2)!;
  assert.ok(l2.startsWith(`${DEFAULT_STEERING_SENTINEL}\n`));
  assert.ok(l2.endsWith(`</${DEFAULT_STEERING_SENTINEL.slice(1)}`));
  assert.ok(l2.includes(VERBOSITY_LEVELS[2]!));
  assert.notEqual(renderSteeringBlock(2), renderSteeringBlock(3));
  const bili = renderSteeringBlock(2, "<bili_output_steering>")!;
  assert.ok(bili.startsWith("<bili_output_steering>\n"));
  assert.ok(bili.endsWith("</bili_output_steering>"));
  assert.equal(renderSteeringBlock(0), null);
});

// ---- applySteeringToPrompt (tail-only, idempotent) ----

test("applySteeringToPrompt: appends at the tail, never prepends", () => {
  const block = renderSteeringBlock(2)!;
  const empty = applySteeringToPrompt("", block);
  assert.deepEqual(empty, { updated: block, changed: true });
  const filled = applySteeringToPrompt("You are terse.", block);
  assert.equal(filled.changed, true);
  assert.equal(filled.updated, `You are terse.\n\n${block}`);
  assert.ok(
    !filled.updated.startsWith(DEFAULT_STEERING_SENTINEL),
    "never prepends",
  );
});

test("applySteeringToPrompt: same-level re-apply is a byte-stable no-op (retry safety)", () => {
  const block = renderSteeringBlock(2)!;
  const first = applySteeringToPrompt("You are terse.", block);
  const second = applySteeringToPrompt(first.updated, block);
  assert.equal(second.changed, false);
  assert.equal(second.updated, first.updated);
});

test("applySteeringToPrompt: a level change REPLACES the block in place (no duplication)", () => {
  const first = applySteeringToPrompt(
    "You are terse.",
    renderSteeringBlock(2)!,
  );
  const third = applySteeringToPrompt(first.updated, renderSteeringBlock(3)!);
  assert.equal(third.changed, true);
  assert.equal(
    third.updated.split(DEFAULT_STEERING_SENTINEL).length - 1,
    1,
    "exactly one steering block after a level change",
  );
  assert.ok(third.updated.includes(VERBOSITY_LEVELS[3]!));
  assert.ok(
    !third.updated.includes(VERBOSITY_LEVELS[2]!),
    "old directive removed",
  );
});

test("applySteeringToPrompt: surrounding text after the block is preserved", () => {
  const sent = DEFAULT_STEERING_SENTINEL;
  const close = `</${sent.slice(1)}`;
  const existing = `A\n${sent}\nold directive\n${close}\nB`;
  const placed = applySteeringToPrompt(existing, renderSteeringBlock(2)!);
  assert.equal(placed.changed, true);
  assert.ok(placed.updated.includes("B"), "trailing text survives");
  assert.equal(placed.updated.split(sent).length - 1, 1);
  const again = applySteeringToPrompt(placed.updated, renderSteeringBlock(2)!);
  assert.equal(again.changed, false);
});

test("applySteeringToPrompt: malformed unclosed sentinel is consumed, not duplicated", () => {
  const sent = DEFAULT_STEERING_SENTINEL;
  const block = renderSteeringBlock(2)!;
  const first = applySteeringToPrompt(`x ${sent}\npartial`, block);
  assert.equal(first.changed, true);
  assert.equal(first.updated.split(sent).length - 1, 1);
  const second = applySteeringToPrompt(first.updated, block);
  assert.equal(second.changed, false);
});

// ---- clampEffortToFloor (clamp-only) ----

test("clampEffortToFloor: known ladder values clamp down to low", () => {
  assert.equal(clampEffortToFloor("medium"), "low");
  assert.equal(clampEffortToFloor("high"), "low");
  assert.equal(clampEffortToFloor("xhigh"), "low");
});

test("clampEffortToFloor: never raises — at/below floor stays untouched", () => {
  assert.equal(
    clampEffortToFloor("minimal"),
    null,
    "minimal sits below low — client intent wins",
  );
  assert.equal(clampEffortToFloor("low"), null);
});

test("clampEffortToFloor: absent/unrecognized values are left alone (never injected, never coerced)", () => {
  assert.equal(clampEffortToFloor(undefined), null);
  assert.equal(clampEffortToFloor(null), null);
  assert.equal(clampEffortToFloor(42), null);
  assert.equal(clampEffortToFloor(""), null);
  assert.equal(clampEffortToFloor("off"), null);
  assert.equal(clampEffortToFloor("LOW"), null);
});

test("clampEffortToFloor: custom floor clamps toward it, still never raises", () => {
  assert.equal(clampEffortToFloor("high", "medium"), "medium");
  assert.equal(clampEffortToFloor("xhigh", "medium"), "medium");
  assert.equal(clampEffortToFloor("medium", "medium"), null);
  assert.equal(clampEffortToFloor("low", "medium"), null);
});

test("EFFORT_LADDER is ascending minimal < low < medium < high < xhigh", () => {
  const order = ["minimal", "low", "medium", "high", "xhigh"];
  assert.deepEqual([...EFFORT_LADDER], order);
});

// ---- Config resolution ----

test("DEFAULT_OUTPUT_STEERING_CONFIG is off by default (hard requirement)", () => {
  assert.equal(DEFAULT_OUTPUT_STEERING_CONFIG.enabled, false);
  assert.equal(DEFAULT_OUTPUT_STEERING_CONFIG.verbosityLevel, 2);
  assert.equal(DEFAULT_OUTPUT_STEERING_CONFIG.effortRouting, true);
});

test("resolveVerbosityLevel: omitted takes default WITHOUT warning", () => {
  assert.deepEqual(resolveVerbosityLevel(undefined), { level: 2 });
});

test("resolveVerbosityLevel: valid levels 0-4 pass through untouched", () => {
  for (const n of [0, 1, 2, 3, 4])
    assert.deepEqual(resolveVerbosityLevel(n), { level: n });
});

test("resolveVerbosityLevel: present-but-invalid values warn and fall back", () => {
  for (const bad of [9, -1, 2.5, "high", null]) {
    const r = resolveVerbosityLevel(bad);
    assert.equal(r.level, 2);
    assert.ok(
      r.warning?.includes("must be an integer 0-4"),
      `expected warning for ${JSON.stringify(bad)}, got ${r.warning}`,
    );
  }
});

test("resolveOutputSteeringConfig: non-object falls back to pure defaults", () => {
  for (const v of [undefined, null, "on", [], 42]) {
    const r = resolveOutputSteeringConfig(v);
    assert.deepEqual(
      r.config,
      DEFAULT_OUTPUT_STEERING_CONFIG,
      `${JSON.stringify(v)} → defaults`,
    );
    assert.deepEqual(r.warnings, []);
  }
});

test("resolveOutputSteeringConfig: partial configs fill defaults, malformed fields fall back", () => {
  assert.deepEqual(
    resolveOutputSteeringConfig({}).config,
    DEFAULT_OUTPUT_STEERING_CONFIG,
  );
  assert.deepEqual(resolveOutputSteeringConfig({ enabled: true }).config, {
    enabled: true,
    verbosityLevel: 2,
    effortRouting: true,
  });
  assert.equal(
    resolveOutputSteeringConfig({ enabled: "yes" }).config.enabled,
    false,
    "strict === true",
  );
  assert.equal(
    resolveOutputSteeringConfig({ verbosityLevel: 0 }).config.verbosityLevel,
    0,
  );
  assert.equal(
    resolveOutputSteeringConfig({ verbosityLevel: 4 }).config.verbosityLevel,
    4,
  );
  const bad = resolveOutputSteeringConfig({ verbosityLevel: 9 });
  assert.equal(bad.config.verbosityLevel, 2);
  assert.equal(bad.warnings.length, 1);
  assert.deepEqual(
    resolveOutputSteeringConfig({ effortRouting: false }).config,
    { enabled: false, verbosityLevel: 2, effortRouting: false },
  );
});

// ---- decideOutputSteering ----

const MECH: StructuralMessage[] = [assistant(), userBlocks([toolResult()])];
const ASK: StructuralMessage[] = [assistant(), userText("next question")];
const ERR: StructuralMessage[] = [assistant(), userBlocks([toolResult(true)])];

test("decideOutputSteering: disabled (default) is fully inert even on mechanical turns", () => {
  assert.deepEqual(decideOutputSteering(MECH), {
    turnKind: "mechanical_continuation",
    verbosityLevel: 0,
    lowerEffort: false,
  });
});

test("decideOutputSteering: enabled fires both levers on mechanical continuations", () => {
  assert.deepEqual(decideOutputSteering(MECH, ON), {
    turnKind: "mechanical_continuation",
    verbosityLevel: 2,
    lowerEffort: true,
  });
});

test("decideOutputSteering: effort routing never fires off mechanical turns", () => {
  assert.equal(decideOutputSteering(ASK, ON).lowerEffort, false);
  assert.equal(decideOutputSteering(ERR, ON).lowerEffort, false);
  assert.equal(decideOutputSteering([assistant()], ON).lowerEffort, false);
  assert.equal(decideOutputSteering(ERR, ON).turnKind, "error_continuation");
  assert.equal(decideOutputSteering(ASK, ON).turnKind, "new_user_ask");
});

test("decideOutputSteering: effortRouting sub-switch gates lowering only", () => {
  const cfg: OutputSteeringConfig = {
    enabled: true,
    verbosityLevel: 2,
    effortRouting: false,
  };
  const d = decideOutputSteering(MECH, cfg);
  assert.equal(d.lowerEffort, false);
  assert.equal(d.verbosityLevel, 2, "verbosity unaffected by the sub-switch");
});

test("decideOutputSteering: verbosityLevel 0 disables injection but keeps routing", () => {
  const d = decideOutputSteering(MECH, {
    enabled: true,
    verbosityLevel: 0,
    effortRouting: true,
  });
  assert.deepEqual(d, {
    turnKind: "mechanical_continuation",
    verbosityLevel: 0,
    lowerEffort: true,
  });
});

// ---- End-to-end retry path (idempotency requirement) ----

test("retry path: decide → inject → re-inject is byte-stable; level change replaces in place", () => {
  const d1 = decideOutputSteering(MECH, ON);
  const block = renderSteeringBlock(d1.verbosityLevel)!;
  let prompt = "You are terse.";
  const p1 = applySteeringToPrompt(prompt, block);
  assert.equal(p1.changed, true);
  const p2 = applySteeringToPrompt(p1.updated, block);
  assert.equal(p2.changed, false, "re-applying the same level must not mutate");
  assert.equal(p2.updated, p1.updated, "...and must be byte-identical");
  const p3 = applySteeringToPrompt(p1.updated, renderSteeringBlock(3)!);
  assert.equal(
    p3.updated.split(DEFAULT_STEERING_SENTINEL).length - 1,
    1,
    "no duplicated steering blocks",
  );
});
