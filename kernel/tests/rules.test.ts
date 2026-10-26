import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RULE_TOOL_NAME,
  DEFAULT_RULE_LIMITS,
  listRules,
  allocateRuleId,
  resolveRuleLimits,
  addRule,
  removeRule,
  clearRules,
  formatRulesForPrompt,
  formatRulesList,
} from "../src/rules.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { mergeCompressionState } from "../src/persist/state-merge.js";
import { defaultConfig, validateConfig } from "../src/config.js";
import { ALWAYS_PROTECTED_TOOLS } from "../src/protected.js";
import type { Config, CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function toolCall(
  id: string,
  toolName: string,
  callId: string,
  args: string,
): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId: callId,
    text: args,
  };
}

function toolResult(id: string, callId: string, text: string): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolCallId: callId,
    text,
  };
}

const longText = "x".repeat(6000);
const validSummary =
  "A meaningful summary that captures the key information of the compressed range including file paths and decisions.";

function cfg(overrides: Partial<Config> = {}): Config {
  return defaultConfig(200000, {
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    ...overrides,
  });
}

test("RULE_TOOL_NAME and ALWAYS_PROTECTED_TOOLS expose acp_rule", () => {
  assert.equal(RULE_TOOL_NAME, "acp_rule");
  assert.ok((ALWAYS_PROTECTED_TOOLS as readonly string[]).includes("acp_rule"));
});

test("addRule mutates state in place and issues rule1 first", () => {
  const state = createInitialState();
  const result = addRule(state, "  always run tests before pushing  ");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.rule.id, "rule1");
    assert.equal(result.rule.text, "always run tests before pushing");
  }
  assert.deepEqual(listRules(state), [
    { id: "rule1", text: "always run tests before pushing" },
  ]);
  assert.equal(state.nextRuleId, 2);
});

test("addRule rejects empty text", () => {
  const state = createInitialState();
  const result = addRule(state, "   ");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /empty/);
  assert.equal(listRules(state).length, 0);
});

test("addRule rejects over-length text against the resolved limit", () => {
  const state = createInitialState();
  const long = "y".repeat(301);
  const fail = addRule(state, long);
  assert.equal(fail.ok, false);
  if (!fail.ok)
    assert.match(fail.error, /301 chars exceeds the 300-char limit/);
  const pass = addRule(state, "y".repeat(301), { maxRuleChars: 400 });
  assert.equal(pass.ok, true);
});

test("addRule deduplicates identical content and points at the existing id", () => {
  const state = createInitialState();
  addRule(state, "never force-push");
  const dup = addRule(state, "never force-push");
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.match(dup.error, /rule1/);
  assert.equal(listRules(state).length, 1);
});

test("addRule enforces the count cap", () => {
  const state = createInitialState();
  for (let i = 0; i < 2; i++) addRule(state, `rule text ${i}`);
  const third = addRule(state, "one too many", { maxRules: 2 });
  assert.equal(third.ok, false);
  if (!third.ok)
    assert.match(third.ok === true ? "" : third.error, /limit reached \(2\)/);
  assert.equal(listRules(state).length, 2);
});

test("rule ids are never re-issued after remove/clear", () => {
  const state = createInitialState();
  addRule(state, "a");
  addRule(state, "b");
  removeRule(state, "rule2");
  const next = addRule(state, "c");
  assert.equal(next.ok, true);
  if (next.ok) assert.equal(next.rule.id, "rule3");
  clearRules(state);
  const afterClear = addRule(state, "d");
  assert.equal(afterClear.ok, true);
  if (afterClear.ok) assert.equal(afterClear.rule.id, "rule4");
});

test("allocateRuleId backfills from the highest surviving id on hand-crafted states", () => {
  const state = createInitialState();
  state.rules = [{ id: "rule7", text: "hand-crafted" }];
  state.nextRuleId = undefined;
  assert.equal(allocateRuleId(state), "rule8");
  assert.equal(state.nextRuleId, undefined, "allocateRuleId is pure");
});

test("resolveRuleLimits: defaults and config overrides", () => {
  assert.deepEqual(resolveRuleLimits(), { maxRules: 50, maxRuleChars: 300 });
  assert.deepEqual(resolveRuleLimits({}), { maxRules: 50, maxRuleChars: 300 });
  assert.deepEqual(
    resolveRuleLimits({
      rules: { enabled: true, maxRules: 10, maxRuleChars: 120 },
    }),
    { maxRules: 10, maxRuleChars: 120 },
  );
  assert.deepEqual(DEFAULT_RULE_LIMITS, { maxRules: 50, maxRuleChars: 300 });
});

test("removeRule / clearRules mutate state and report", () => {
  const state = createInitialState();
  addRule(state, "keep");
  addRule(state, "drop");
  const removed = removeRule(state, " rule2 ");
  assert.equal(removed.ok, true);
  if (removed.ok) assert.equal(removed.rule.id, "rule2");
  const missing = removeRule(state, "rule99");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /no rule with id/);
  const cleared = clearRules(state);
  assert.deepEqual(cleared, { ok: true, count: 1 });
  assert.equal(listRules(state).length, 0);
});

test("formatRulesForPrompt returns empty string for zero-token cost when empty", () => {
  const state = createInitialState();
  assert.equal(formatRulesForPrompt(state), "");
  addRule(state, "always run tests");
  const rendered = formatRulesForPrompt(state);
  assert.match(rendered, /Persistent rules/);
  assert.match(rendered, /- \[rule1\] always run tests/);
});

test("formatRulesList renders a plain numbered list for tool results", () => {
  const out = formatRulesList([
    { id: "rule1", text: "first" },
    { id: "rule2", text: "second" },
  ]);
  assert.equal(out, "1. [rule1] first\n2. [rule2] second");
});

test("validateConfig rejects malformed rules limits", () => {
  const base = cfg();
  assert.deepEqual(validateConfig({ ...base, rules: { maxRules: 0 } }), [
    "rules.maxRules must be >= 1",
  ]);
  assert.deepEqual(validateConfig({ ...base, rules: { maxRuleChars: -5 } }), [
    "rules.maxRuleChars must be >= 1",
  ]);
  assert.deepEqual(validateConfig({ ...base, rules: { enabled: true } }), []);
});

test("acp_rule tool-call + result are hard-excluded from compression ranges", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    toolCall("b", "acp_rule", "call1", '{"rule":"always run tests"}'),
    toolResult("c", "call1", "Recorded rule1: always run tests"),
    msg("d", longText),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: validSummary }],
    messages,
    state,
    config: cfg(),
  });

  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);
  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("b"),
    "acp_rule tool-call excluded",
  );
  assert.ok(
    !block.directMessageIds.includes("c"),
    "acp_rule tool-result excluded",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("b"),
    "excluded from effective coverage (Bug 39)",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("c"),
    "excluded from effective coverage (Bug 39)",
  );
  assert.ok(
    block.directMessageIds.includes("a"),
    "regular msg 'a' remains compressible",
  );
  assert.ok(
    block.directMessageIds.includes("d"),
    "regular msg 'd' remains compressible",
  );
});

test("mergeCompressionState carries rules with fresh-state fallbacks", () => {
  const legacy = createInitialState();
  delete legacy.rules;
  delete legacy.nextRuleId;
  const merged = mergeCompressionState(
    JSON.parse(JSON.stringify(legacy)) as typeof legacy,
  );
  assert.deepEqual(merged.rules, []);
  assert.equal(merged.nextRuleId, 1);

  const withRules = createInitialState();
  addRule(withRules, "persisted rule");
  const merged2 = mergeCompressionState(
    JSON.parse(JSON.stringify(withRules)) as typeof withRules,
  );
  assert.deepEqual(merged2.rules, [{ id: "rule1", text: "persisted rule" }]);
  assert.equal(merged2.nextRuleId, 2);
});
