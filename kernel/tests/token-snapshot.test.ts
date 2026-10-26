import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { syncBlocks } from "../src/sync.js";
import {
  renderWithSnapshot,
  renderVisibleRefs,
  renderRefsNode,
} from "../src/render-refs.js";
import { runPipeline, makeIO } from "../src/pipeline.js";
import { defaultConfig } from "../src/config.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

function msg(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function stateWithRefs(messages: CoreMessage[]): CompressionState {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

// Density recalibration must not churn rendered <acp tokens> tags: the whole
// point of tokenSnapshot (issue #96, 方案 A). First render writes, later
// renders reuse the recorded count even when countTokens changes.
test("renderWithSnapshot: token count is stable across countTokens changes", () => {
  const messages = [
    msg("a", "你好世界这是一段中文消息"),
    msg("b", "hello world"),
  ];
  const state = stateWithRefs(messages);

  const slow = (t: string) => Math.ceil(t.length / 2); // CJK-ish density 2
  const fast = (t: string) => Math.ceil(t.length / 4); // legacy density 1

  const r1 = renderWithSnapshot(messages, state, slow, "all");
  const snapshot = r1.tokenSnapshot;
  assert.ok(Object.keys(snapshot).length >= 2, "first render records entries");

  // Second render with a different countTokens: same tokens from snapshot.
  const r2 = renderWithSnapshot(
    messages,
    { ...state, tokenSnapshot: snapshot },
    fast,
    "all",
  );
  assert.deepEqual(r2.tokenSnapshot, snapshot, "snapshot unchanged on hit");
  const tokens1 = [...r1.messages.map((m) => m.text ?? "")].map((t) =>
    Number(/\stokens="(\d+)"/.exec(t)?.[1]),
  );
  const tokens2 = [...r2.messages.map((m) => m.text ?? "")].map((t) =>
    Number(/\stokens="(\d+)"/.exec(t)?.[1]),
  );
  assert.deepEqual(tokens2, tokens1, "rendered tag token counts identical");

  // Sanity: the recorded count came from the FIRST renderer, not the second.
  const fresh = renderWithSnapshot(
    messages,
    { ...state, tokenSnapshot: {} },
    fast,
    "all",
  );
  assert.notDeepEqual(
    fresh.messages.map((m) => /\stokens="(\d+)"/.exec(m.text ?? "")?.[1]),
    tokens1.map(String),
    "a cold snapshot would have used the second renderer's smaller counts",
  );
});

// Legacy entry point must keep recomputing (snapshot = null): unchanged
// behavior for existing callers that do not opt into snapshotting.
test("renderVisibleRefs keeps live recompute (no snapshot)", () => {
  const messages = [msg("a", "中文消息中文消息"), msg("b", "hello")];
  const state = stateWithRefs(messages);
  const slow = (t: string) => Math.ceil(t.length / 2);
  const fast = (t: string) => Math.ceil(t.length / 4);

  const a = renderVisibleRefs(messages, state, slow, "all");
  const b = renderVisibleRefs(messages, state, fast, "all");
  const ta = a.map((m) => /\stokens="(\d+)"/.exec(m.text ?? "")?.[1]);
  const tb = b.map((m) => /\stokens="(\d+)"/.exec(m.text ?? "")?.[1]);
  assert.notDeepEqual(ta, tb, "live mode reflects the current countTokens");
});

// G1 regression: syncBlocks rebuilds state and must preserve tokenSnapshot,
// otherwise render-refs (which runs AFTER sync-blocks) sees an empty snapshot
// every turn and the whole scheme collapses.
test("syncBlocks preserves tokenSnapshot", () => {
  const messages = [
    msg("a", "hello world this is a longer message for tokens"),
  ];
  const state = stateWithRefs(messages);
  const { messages: rendered, tokenSnapshot } = renderWithSnapshot(
    messages,
    state,
    (t) => Math.ceil(t.length / 2),
    "all",
  );
  const withSnapshot = { ...state, tokenSnapshot };

  const synced = syncBlocks(rendered, withSnapshot);
  assert.deepEqual(
    synced.state.tokenSnapshot,
    tokenSnapshot,
    "syncBlocks must carry the snapshot through",
  );
  // And the input state must not be aliased (deep-clone contract).
  assert.notEqual(synced.state.tokenSnapshot, tokenSnapshot);
});

// G2 regression: cloneState runs inside applyCompression — a compression must
// not drop the snapshot.
test("compression preserves tokenSnapshot", () => {
  const messages = [
    msg("a", "first message content here"),
    msg("b", "second message content"),
  ];
  const state = stateWithRefs(messages);
  const { messages: rendered, tokenSnapshot } = renderWithSnapshot(
    messages,
    state,
    (t) => Math.ceil(t.length / 2),
    "all",
  );
  const withSnapshot = { ...state, tokenSnapshot };

  const core = createCore();
  const result = core.applyCompression({
    messages: rendered,
    state: withSnapshot,
    config: defaultConfig(),
    ranges: [{ startRef: "a", endRef: "a", summary: "compressed" }],
    countTokens: (t) => Math.ceil(t.length / 2),
  });
  assert.deepEqual(
    result.state.tokenSnapshot,
    tokenSnapshot,
    "applyCompression clone must carry the snapshot through",
  );
});

// Full pipeline (assign-refs → sync-blocks → … → render-refs): after several
// processTurn runs the snapshot persists and the rendered tags stay stable
// even as countTokens drifts (density calibration).
test("processTurn: snapshot persists across turns and stabilizes tags", () => {
  const core = createCore();
  let state = createInitialState();
  let messages = [
    msg("a", "第一轮消息内容比较长一些"),
    msg("b", "第二轮 hello world"),
  ];

  let firstTagTokens: (string | undefined)[];
  for (let turn = 0; turn < 4; turn++) {
    const ctx = {
      config: defaultConfig(),
      countTokens:
        turn % 2 === 0
          ? (t: string) => Math.ceil(t.length / 2)
          : (t: string) => Math.ceil(t.length / 4),
    };
    const io = makeIO(messages, state);
    state = io.state;
    const result = runPipeline(core.defaultNodes(), io, ctx);
    state = result.state;
    messages = result.messages;

    const tags = messages.map(
      (m) => /\stokens="(\d+)"/.exec(m.text ?? "")?.[1],
    );
    if (turn === 0) {
      firstTagTokens = tags;
      assert.ok(
        tags.every((t) => t !== undefined),
        "all messages tagged on first render",
      );
    } else {
      assert.deepEqual(
        tags,
        firstTagTokens!,
        `turn ${turn}: rendered tags stable despite countTokens flip`,
      );
    }
  }
  assert.ok(
    Object.keys(state.tokenSnapshot).length >= 2,
    "snapshot accumulated across turns",
  );
});

// F1 compat: a state without tokenSnapshot (old .acp.json) must not crash —
// renderWithSnapshot treats it as an empty snapshot and the pipeline fills it.
test("old state without tokenSnapshot is tolerated", () => {
  const messages = [msg("a", "hello world legacy state")];
  const legacy = stateWithRefs(messages);
  delete (legacy as Partial<CompressionState>).tokenSnapshot;

  const { messages: rendered, tokenSnapshot } = renderWithSnapshot(
    messages,
    legacy,
    (t) => Math.ceil(t.length / 2),
    "all",
  );
  assert.equal(Object.keys(tokenSnapshot).length, messages.length);
  assert.ok(rendered[0].text?.includes('tokens="'));
});

// H3: steady-state (all snapshot hits) must not replace the state object —
// the node returns the same state reference so the adapter avoids a save.
test("renderRefsNode: steady-state hit does not churn the state object", () => {
  const messages = [msg("a", "hello world"), msg("b", "second message")];
  const state = stateWithRefs(messages);
  const { messages: rendered, tokenSnapshot } = renderWithSnapshot(
    messages,
    state,
    (t) => Math.ceil(t.length / 2),
    "all",
  );
  const filled = { ...state, tokenSnapshot };

  const io = makeIO(rendered, filled);
  const ctx = { config: defaultConfig(), countTokens: (t: string) => t.length };
  const out = renderRefsNode.run(io, ctx);
  assert.equal(
    out.state,
    filled,
    "all-hit render must reuse the same state object",
  );
});

test("syncBlocks prunes tokenSnapshot entries for absent messages", () => {
  const messages = [
    msg("a", "first message here"),
    msg("b", "second message here"),
  ];
  const state = stateWithRefs(messages);
  const { tokenSnapshot } = renderWithSnapshot(
    messages,
    state,
    (t) => Math.ceil(t.length / 2),
    "all",
  );
  const synced = syncBlocks([msg("b", "second message here")], {
    ...state,
    tokenSnapshot,
  });
  assert.equal(
    "m00001" in synced.state.tokenSnapshot,
    false,
    "absent 'a' entry must be pruned",
  );
  assert.equal(
    "m00002" in synced.state.tokenSnapshot,
    true,
    "present 'b' entry must be retained",
  );
});
