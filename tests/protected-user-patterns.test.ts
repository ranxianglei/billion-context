// Host-marked current-task prompts: a long-lived agent session can have many
// user-role messages after the task instruction (tool-result images, queued
// notes). The kernel's Rule-3 protection only covers the LAST user message, so
// the task prompt itself is otherwise foldable. `protectedUserPatterns` maps a
// literal host marker (e.g. "【本轮消息】") onto the existing
// Config.isMessageProtected hard-exclusion hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignRefs,
  createCore,
  createInitialState,
  defaultConfig,
  emptyRefMap,
  type CoreMessage,
} from "acp-kernel";
import { applyCompressSettings, mergeCompress } from "../src/compress-settings.ts";

function msg(id: string, role: CoreMessage["role"], text: string): CoreMessage {
  return { id, role, contentType: "text", text };
}

const summary =
  "A meaningful summary that captures the key information of the compressed range including file paths and decisions.";

test("protectedUserPatterns excludes a non-last current-task prompt from a fold", () => {
  const messages = [
    msg("old", "user", "old task: log in to the legacy portal"),
    msg("task", "user", "【本轮消息】current task: render the screenshots"),
    msg("tool", "user", "[tool result image]"),
    msg("later", "user", "one more queued note"),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 1 }).map;

  const settings = mergeCompress(undefined, undefined, {
    protectedUserPatterns: ["【本轮消息】"],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    minCompressRangeChars: 0,
  });
  const config = applyCompressSettings(defaultConfig(200_000), 200_000, settings);

  assert.equal(config.isMessageProtected?.(messages[1]!), true, "marked task prompt is hard-protected");
  assert.equal(config.isMessageProtected?.(messages[0]!), false, "ordinary user text stays foldable");

  const result = createCore().applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "m00001", endRef: "m00004", summary }],
  });
  assert.equal(result.result.errors.length, 0, "the range is accepted");
  const block = result.state.blocks[0]!;
  assert.ok(block, "a block was created");
  assert.ok(!block.directMessageIds.includes("task"), "current-task prompt is excluded from direct coverage");
  assert.ok(!block.effectiveMessageIds.includes("task"), "current-task prompt stays visible");
  assert.ok(block.directMessageIds.includes("old"), "older user message still folds");
  assert.ok(block.directMessageIds.includes("later"), "later user message still folds");
});

test("protectedUserPatterns keeps an inherited isMessageProtected predicate", () => {
  const messages = [
    msg("durable", "user", "protected by the lane"),
    msg("task", "user", "【本轮消息】current task"),
  ];
  const settings = mergeCompress(undefined, undefined, {
    protectedUserPatterns: ["【本轮消息】"],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
  });
  const inherited = (m: CoreMessage) => m.id === "durable";
  const config = applyCompressSettings(
    { ...defaultConfig(200_000), isMessageProtected: inherited },
    200_000,
    settings,
  );
  // The resolver must not silently replace a lane predicate with the new one;
  // this mirrors durable-message-guards installing its hook before compression.
  assert.equal(config.isMessageProtected?.(messages[0]!), true, "inherited predicate still fires");
  assert.equal(config.isMessageProtected?.(messages[1]!), true, "new pattern also fires");
});
