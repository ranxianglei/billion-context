// excludeTools is documented as "never absorbable, independent of
// protectedTools" (types.ts AbsorbConfig). The prompt side enforces it in
// isAbsorbCandidate; the execution side (applyAbsorb) used to skip it, so a
// model that called absorb on an un-prompted, excluded result hid it anyway.
//
// Pinned here: the execution side refuses the excluded tool, still accepts an
// in-scope tool (no over-blocking), honours glob patterns, and the refused
// call leaves state.absorbed untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAbsorb, isAbsorbCandidate } from "../src/absorb.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import type { CoreMessage } from "../src/types.js";

const countTokens = (text: string) => Math.ceil(text.length / 4);

function session(toolNames: string[]): CoreMessage[] {
  const messages: CoreMessage[] = [
    { id: "u0", role: "user", contentType: "text", text: "start" },
  ];
  toolNames.forEach((toolName, i) => {
    messages.push({
      id: `c${i}`,
      role: "assistant",
      contentType: "tool-call",
      toolName,
      toolCallId: `call${i}`,
      text: `{"path":"/state/${i}"}`,
    });
    messages.push({
      id: `r${i}`,
      role: "tool",
      contentType: "tool-result",
      toolName,
      toolCallId: `call${i}`,
      text: `payload ${i} ` + "x".repeat(4800),
    });
  });
  messages.push({ id: "u1", role: "user", contentType: "text", text: "next" });
  return messages;
}

function seeded(messages: CoreMessage[], config = defaultConfig(100000, {})) {
  return createCore().processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 5000,
  }).state;
}

test("absorb refuses a result whose tool is listed in excludeTools", () => {
  const messages = session(["durable_read"]);
  const config = defaultConfig(100000, {
    absorb: {
      enabled: true,
      toolName: "acp_absorb",
      minToolTokens: 1000,
      contextThresholdPct: 0,
      excludeTools: ["durable_read"],
    },
  });
  const state = seeded(messages, config);
  const ref = state.messageRefs.byRaw["r0"]!;

  // screening side: no prompt (already true before the fix)
  const candidate = isAbsorbCandidate(messages[1 + 1]!, config);
  assert.equal(candidate, false, "excluded tool must not be an absorb candidate");

  const outcome = applyAbsorb({
    ref,
    summary: "distilled",
    messages,
    state,
    config,
    countTokens,
  });
  assert.equal(outcome.ok, false, "execution side must refuse the same target");
  assert.match(outcome.resultText, /excludeTools/);
  assert.equal(outcome.state.absorbed?.length ?? 0, 0, "no absorb record is written");
});

test("absorb still accepts an in-scope tool when excludeTools names another", () => {
  const messages = session(["read_file"]);
  const config = defaultConfig(100000, {
    absorb: {
      enabled: true,
      toolName: "acp_absorb",
      minToolTokens: 1000,
      contextThresholdPct: 0,
      excludeTools: ["durable_read"],
    },
  });
  const state = seeded(messages, config);
  const outcome = applyAbsorb({
    ref: state.messageRefs.byRaw["r0"]!,
    summary: "distilled",
    messages,
    state,
    config,
    countTokens,
  });
  assert.equal(outcome.ok, true, "unrelated tools keep working");
  assert.equal(outcome.state.absorbed?.length, 1);
});

test("absorb honours glob patterns in excludeTools", () => {
  const messages = session(["durable_read"]);
  const config = defaultConfig(100000, {
    absorb: {
      enabled: true,
      toolName: "acp_absorb",
      minToolTokens: 1000,
      contextThresholdPct: 0,
      excludeTools: ["durable_*"],
    },
  });
  const state = seeded(messages, config);
  const outcome = applyAbsorb({
    ref: state.messageRefs.byRaw["r0"]!,
    summary: "distilled",
    messages,
    state,
    config,
    countTokens,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.resultText, /excludeTools/);
});
