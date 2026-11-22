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
import { effectiveConfig, storeEffectiveConfig, type Session } from "../src/session.ts";

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
  // The resolver must not silently replace a lane predicate with the new one:
  // a lane that installs Config.isMessageProtected (the kernel's host hook,
  // #2419) keeps it firing alongside the patterns.
  assert.equal(config.isMessageProtected?.(messages[0]!), true, "inherited predicate still fires");
  assert.equal(config.isMessageProtected?.(messages[1]!), true, "new pattern also fires");
});

test("protectedUserPatterns survives the session-stamp round-trip (plugin tool path)", () => {
  // The wire path resolves the predicate in applyCompressSettings, but the
  // plugin tool path (compress/acp_status) re-reads the session stamp through
  // effectiveConfig — and storeEffectiveConfig strips function fields for
  // clone-safety. The predicate must be restored from the clone-safe data
  // field, or protectedUserPatterns is silently inert in plugin mode.
  const settings = mergeCompress(undefined, undefined, {
    protectedUserPatterns: ["【本轮消息】"],
  });
  const wireConfig = applyCompressSettings(defaultConfig(200_000), 200_000, settings);
  const marked = msg("task", "user", "【本轮消息】current task");
  const plain = msg("old", "user", "old task");
  assert.equal(wireConfig.isMessageProtected?.(marked), true, "wire path protects the marked prompt");

  const session = { metadata: {} } as unknown as Session;
  storeEffectiveConfig(session, wireConfig);
  const pluginPathConfig = effectiveConfig(session, { ...defaultConfig(200_000) });

  assert.equal(pluginPathConfig.isMessageProtected?.(marked), true, "plugin tool path still protects the marked prompt");
  assert.equal(pluginPathConfig.isMessageProtected?.(plain), false, "ordinary user text stays foldable");
});
