import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCompressionState } from "../src/persist/state-merge.js";
import { createInitialState } from "../src/state.js";
import { createCore } from "../src/compress.js";
import { defaultConfig } from "../src/config.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

const OPTIONAL_FIELDS: Partial<CompressionState> = {
  tsStamps: { "msg-1": 1_730_000_000_000 },
  viewLatches: { m00001: { text: "latched" } },
  viewLatchConfigDigest: "digest",
  sweptOrphanCallIds: ["c-orphan"],
  hiddenOrphanRefs: ["m00009"],
  pendingOrphanSweepMinRef: 12,
  emergencyTruncateLatch: [{ ref: "m00002", text: "clipped" }],
  renderDeferredRefs: ["m00003"],
  deadRefs: ["m00004"],
  refLedgerAligned: true,
  timestampsHighWaterRefSeq: 7,
  lastPassIds: ["msg-1"],
};

test("#2388 hydration carries every CompressionState field, optional included", () => {
  const rich: CompressionState = { ...createInitialState(), ...OPTIONAL_FIELDS };
  const merged = mergeCompressionState(JSON.parse(JSON.stringify(rich)));

  // Every key of a fully-populated record survives — no field list to drift.
  for (const key of Object.keys(rich) as (keyof CompressionState)[]) {
    assert.deepEqual(
      merged[key],
      rich[key],
      `hydration dropped or rewrote ${String(key)}`,
    );
  }
  assert.deepEqual(merged, rich);
});

test("#5608-B hydration never carries the one-shot honest-NULL arm across a restart", () => {
  const rich: CompressionState = {
    ...createInitialState(),
    ...OPTIONAL_FIELDS,
    suppressMintingOnce: true,
  };
  const merged = mergeCompressionState(JSON.parse(JSON.stringify(rich)));
  // Process-lifetime only (types.ts; the host's mergeState drops it too):
  // re-arming honest-NULL after a restart would eat genuine first-sight mints
  // of truly new messages on the first post-restart pass.
  assert.equal(
    "suppressMintingOnce" in merged,
    false,
    "suppressMintingOnce must not survive hydration",
  );
});

test("#2388 hydration still fills defaults for a partial record", () => {
  const fresh = createInitialState();
  const merged = mergeCompressionState({ blocks: [] } as CompressionState);
  assert.deepEqual(merged.blocks, []);
  assert.deepEqual(merged.messageRefs, fresh.messageRefs);
  assert.deepEqual(merged.nudge, fresh.nudge);
  assert.deepEqual(merged.stats, fresh.stats);
  assert.equal(merged.nextBlockId, fresh.nextBlockId);
  assert.equal(merged.nextRunId, fresh.nextRunId);
});

test("#2388 hydration keeps rendered timestamp bytes stable (tsStamps survive)", () => {
  const core = createCore({ timestamps: true });
  const config = defaultConfig(100_000, {
    preserveRecentMessages: 1,
    preserveRecentTokens: 0,
  });
  const messages: CoreMessage[] = [
    {
      id: "msg-1",
      role: "user",
      contentType: "text",
      text: "first question with substance",
    },
    {
      id: "msg-2",
      role: "assistant",
      contentType: "text",
      text: "answer body",
    },
    {
      id: "msg-3",
      role: "user",
      contentType: "text",
      text: "current question",
    },
  ];
  const state = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 100,
  }).state;
  const before = core.processTurn({ messages, state, config, tokenCount: 100 });
  const hydrated = mergeCompressionState(JSON.parse(JSON.stringify(state)));
  const after = core.processTurn({
    messages,
    state: hydrated,
    config,
    tokenCount: 100,
  });

  const tags = (result: typeof before) =>
    result.messages.map((message) => (message.text ?? "").split("\n")[0]);
  assert.match(tags(before)[0]!, /time="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"/);
  assert.deepEqual(tags(after), tags(before));
});

test("#2388 hydration keeps swept compress orphans hidden", () => {
  const core = createCore();
  const config = defaultConfig(100_000);
  const messages: CoreMessage[] = [
    {
      id: "o1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "c-o",
      text: JSON.stringify({
        content: "m00001–m00002\nfailed fold attempt",
      }),
    },
    {
      id: "o2",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "c-o",
      text: "Compression failed: range too small",
    },
    {
      id: "u1",
      role: "user",
      contentType: "text",
      text: "continue " + "x".repeat(100),
    },
  ];
  const swept: CompressionState = {
    ...createInitialState(),
    sweptOrphanCallIds: ["c-o"],
    messageRefs: {
      byRaw: { o1: "m00001", o2: "m00002", u1: "m00003" },
      byRef: { m00001: "o1", m00002: "o2", m00003: "u1" },
    },
  };
  const kept = core.processTurn({
    messages,
    state: swept,
    config,
    tokenCount: 100,
  });
  const revived = core.processTurn({
    messages,
    state: mergeCompressionState(JSON.parse(JSON.stringify(kept.state))),
    config,
    tokenCount: 100,
  });
  assert.deepEqual(
    kept.messages.map((message) => message.id),
    ["u1"],
  );
  assert.deepEqual(
    revived.messages.map((message) => message.id),
    ["u1"],
  );
});
