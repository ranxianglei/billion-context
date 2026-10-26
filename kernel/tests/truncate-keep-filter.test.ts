import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateLargeToolOutputs } from "../src/truncate-tools.js";
import {
  applyMessageFilters,
  clearMessageFilters,
  registerMessageFilter,
} from "../src/filter/index.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import type { CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  type: CoreMessage["contentType"] = "text",
): CoreMessage {
  return { id, role: "user", contentType: type, text };
}

test("truncateLargeToolOutputs is a no-op below threshold", () => {
  const cfg = defaultConfig(100000, { truncate: { threshold: 0.8 } });
  const messages = [msg("t1", "x".repeat(5000), "tool-result")];
  const result = truncateLargeToolOutputs(
    messages,
    1000,
    cfg,
    (t) => t.length,
    {
      minOutputTokens: 100,
    },
  );
  assert.equal(result.truncatedCount, 0);
});

test("truncateLargeToolOutputs truncates large tool outputs over threshold", () => {
  const cfg = defaultConfig(100000, { truncate: { threshold: 0.5 } });
  const big = "L".repeat(10000);
  const messages = [
    msg("a", big, "tool-result"),
    msg("b", big, "tool-result"),
    msg("c", "recent", "tool-result"),
    msg("d", "recent", "tool-result"),
    msg("e", "recent", "tool-result"),
  ];
  const result = truncateLargeToolOutputs(
    messages,
    90000,
    cfg,
    (t) => t.length,
    {
      minOutputTokens: 100,
      keepPrefixChars: 100,
      keepSuffixChars: 100,
      protectRecentMessages: 3,
    },
  );
  assert.ok(result.truncatedCount >= 1);
  assert.ok(result.savedTokens > 0);
  assert.ok(result.messages[0]!.text!.includes("[truncated for context space"));
});

test("truncateLargeToolOutputs protects recent messages", () => {
  const cfg = defaultConfig(100000, { truncate: { threshold: 0.1 } });
  const big = "L".repeat(10000);
  const messages = [msg("only", big, "tool-result")];
  const result = truncateLargeToolOutputs(
    messages,
    90000,
    cfg,
    (t) => t.length,
    {
      minOutputTokens: 100,
      protectRecentMessages: 3,
    },
  );
  assert.equal(result.truncatedCount, 0);
});

test("applyMessageFilters is a no-op when disabled", () => {
  clearMessageFilters();
  const messages = [msg("a", "hello")];
  const result = applyMessageFilters(messages, { enabled: false, filters: {} });
  assert.equal(result.partsFiltered, 0);
  assert.equal(result.messages[0]!.text, "hello");
});

test("applyMessageFilters drops text matching an immediate filter", () => {
  clearMessageFilters();
  registerMessageFilter({
    name: "drop-noise",
    version: "1.0.0",
    description: "",
    filter: (ctx) =>
      ctx.text.includes("NOISE")
        ? { action: "drop", reason: "noise" }
        : { action: "keep" },
  });
  const messages = [msg("a", "clean"), msg("b", "has NOISE inside")];
  const result = applyMessageFilters(messages, {
    enabled: true,
    filters: { "drop-noise": { enabled: true } },
  });
  assert.equal(result.partsDropped, 1);
  assert.equal(result.messages[1]!.text, "");
  assert.equal(result.messages[0]!.text, "clean");
  clearMessageFilters();
});

test("applyMessageFilters keepLastOnly keeps only the last match", () => {
  clearMessageFilters();
  registerMessageFilter({
    name: "dedup",
    version: "1.0.0",
    description: "",
    keepLastOnly: true,
    filter: (ctx) =>
      ctx.text.startsWith("REPEAT:")
        ? { action: "modify", text: ctx.text }
        : { action: "keep" },
  });
  const messages = [
    msg("a", "REPEAT:directive"),
    msg("b", "normal"),
    msg("c", "REPEAT:directive-updated"),
  ];
  const result = applyMessageFilters(messages, {
    enabled: true,
    filters: { dedup: { enabled: true } },
  });
  assert.equal(result.messages[0]!.text, "");
  assert.equal(result.messages[1]!.text, "normal");
  assert.equal(result.messages[2]!.text, "REPEAT:directive-updated");
  clearMessageFilters();
});

test("emergency-truncate node fires at default 0.95 threshold via processTurn", () => {
  const core = createCore();
  const cfg = defaultConfig(100000);
  const big = "L".repeat(40000);
  const messages: CoreMessage[] = [
    msg("a", big, "tool-result"),
    msg("b", big, "tool-result"),
    msg("c", big, "tool-result"),
    msg("d", "recent", "tool-result"),
    msg("e", "recent", "tool-result"),
    msg("f", "recent", "tool-result"),
    msg("g", "recent", "tool-result"),
    msg("h", "recent", "tool-result"),
  ];
  const result = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg,
    tokenCount: 96000,
  });
  const truncated = result.messages.filter((m) =>
    m.text?.includes("[truncated for context space"),
  );
  assert.ok(
    truncated.length >= 1,
    `expected >= 1 truncated msg at 96% usage (default truncate.threshold 0.95), got ${truncated.length}`,
  );
});

test("emergency-truncate node is a no-op below default 0.95 threshold", () => {
  const core = createCore();
  const cfg = defaultConfig(100000);
  const big = "L".repeat(40000);
  const messages: CoreMessage[] = [
    msg("a", big, "tool-result"),
    msg("b", big, "tool-result"),
    msg("c", big, "tool-result"),
    msg("d", "recent", "tool-result"),
    msg("e", "recent", "tool-result"),
    msg("f", "recent", "tool-result"),
    msg("g", "recent", "tool-result"),
    msg("h", "recent", "tool-result"),
  ];
  const result = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg,
    tokenCount: 80000,
  });
  const truncated = result.messages.filter((m) =>
    m.text?.includes("[truncated for context space"),
  );
  assert.equal(
    truncated.length,
    0,
    `expected 0 truncated msgs at 80% usage (below default 0.95), got ${truncated.length}`,
  );
});
