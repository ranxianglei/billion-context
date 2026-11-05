// #4348: successful compress exchanges were permanently exempt from folding
// (ALWAYS_PROTECTED_TOOLS), so a long session accumulates "receipt lace" —
// compress-tool receipts (ref'd tool results) whose paired assistant
// tool-call messages carry NO ref tag, interleaved with re-anchored coverage
// islands. No range over the lace was reclaimable, and once it intermixed
// with covered spans any fold over it died with "Range would split N
// turn(s)". The fix: only the newest COMPRESS_EXCHANGE_KEEP_RECENT compress
// exchanges keep the hard-coded exemption (working memory); older exchanges
// fold like ordinary tool messages — both halves together, with reasoning
// runs kept whole by the existing turn-integrity gate. The summaries the
// model wrote live on verbatim in the rendered block anchors, so folding the
// exchange loses nothing decompress or search relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultConfig } from "../src/config.js";
import { collectAgedCompressCallIds } from "../src/protected.js";
import type { CoreMessage } from "../src/types.js";

function textMsg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

/** Production shape: an assistant turn = reasoning run + tool-call burst,
 *  then the tool result (receipt). The reasoning and the call have NO ref
 *  tag on the wire (assistant tool-call content types never carry one);
 *  only the tool result is ref-addressable. */
function receiptTurn(
  n: number,
  opts: { refd?: boolean; body: string },
): CoreMessage[] {
  const refd = opts.refd ?? true;
  return [
    {
      id: `r${n}`,
      role: "assistant",
      contentType: "reasoning",
      text: `planning fold ${n} `.repeat(30),
    },
    {
      id: `c${n}`,
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: `tc${n}`,
      text: `{"content":[{"startId":"m${n}","endId":"m${n}"}]}`,
    },
    {
      id: `t${n}`,
      role: "tool",
      contentType: "tool-result",
      toolCallId: `tc${n}`,
      text: (refd ? "" : "") + opts.body.repeat(60),
    },
  ];
}

interface Lace {
  core: ReturnType<typeof createCore>;
  state: ReturnType<typeof createInitialState>;
  messages: CoreMessage[];
}

/** Build the lace: a re-anchored island of coverage (one active block over
 *  early messages) followed by uncovered receipt turns separated by plain
 *  filler user/assistant pairs, exactly like the incident session. */
function buildLace(): Lace {
  const core = createCore();
  const state = createInitialState();
  const messages: CoreMessage[] = [];

  messages.push(textMsg("u0", "start the session ".repeat(80), "user"));
  // An island of coverage: messages the active block will cover.
  for (let i = 1; i <= 4; i++) {
    messages.push(textMsg(`island${i}`, `island body ${i} `.repeat(120), i % 2 ? "user" : "assistant"));
  }
  // The lace: three receipt turns, each separated by filler.
  for (const n of [10, 11, 12]) {
    for (const m of receiptTurn(n, { body: `[Compressed m${n} range(s) tokens saved receipt body ${n} ` })) messages.push(m);
    messages.push(textMsg(`gap${n}`, `filler gap after ${n} `.repeat(100), "user"));
  }
  // Aged filler so the lace sits mid-history, outside the protected zone.
  for (let i = 1; i <= 40; i++) {
    messages.push(textMsg(`tail${i}`, `aged filler turn ${i} `.repeat(90), i % 2 ? "user" : "assistant"));
  }
  // NEWEST compress exchanges at the tail: these keep the exemption (the
  // newest COMPRESS_EXCHANGE_KEEP_RECENT=3), so the lace turns above age out
  // and become foldable — the production shape (folds happen all day).
  for (const m of receiptTurn(20, { body: `[Compressed m20 range(s) tokens saved receipt body 20 ` })) messages.push(m);
  messages.push(textMsg("post20", "question after the recent folds ".repeat(80), "user"));
  for (const m of receiptTurn(21, { body: `[Compressed m21 range(s) tokens saved receipt body 21 ` })) messages.push(m);
  messages.push(textMsg("post21", "another question after recent folds ".repeat(80), "user"));
  for (const m of receiptTurn(22, { body: `[Compressed m22 range(s) tokens saved receipt body 22 ` })) messages.push(m);
  messages.push(textMsg("post22", "final recent question ".repeat(80), "user"));

  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  return { core, state, messages };
}

test("#4348: aged compress receipts fold together with their unref'd calls and reasoning", () => {
  const { core, state, messages } = buildLace();
  // First fold the island (normal path) so an active block exists.
  const island = core.applyCompression({
    ranges: [
      {
        startRef: "m00002",
        endRef: "m00005",
        summary: "island summary covering the early exchange in full detail with enough characters to pass the minimum summary length gate",
        topic: "island",
      },
    ],
    messages,
    state,
    config: defaultConfig(),
  });
  assert.ok(island.state.blocks.some((b) => b.active));

  // Now fold the receipt lace: range from the first receipt turn to the last.
  // The receipts are the only ref-addressable members; their calls/reasoning
  // are unref'd. Today this projection withdraws everything and dies with
  // the split fatal; after the fix it must fold cleanly.
  const refs = island.state.messageRefs.byRef;
  const receiptRefs = Object.keys(refs).filter(
    (ref) => ref.startsWith("m"),
  );
  assert.ok(receiptRefs.length > 0, "fixture must produce refs");

  const laceStart = island.state.messageRefs.byRaw["t10"];
  const laceEnd = island.state.messageRefs.byRaw["t12"];
  assert.ok(typeof laceStart === "string" && typeof laceEnd === "string");

  const res = core.applyCompression(
    {
      ranges: [
        {
          startRef: laceStart,
          endRef: laceEnd,
          summary:
            "receipt lace recovery: folds the compression receipts together with their unref'd calls and reasoning runs into one block, turning the incident debris into a single summary",
          topic: "lace",
        },
      ],
      messages,
      state: island.state,
      config: defaultConfig(),
    },
  );
const laceBlock = res.state.blocks.find((b) => b.topic === "lace");
  assert.ok(laceBlock?.active, "lace range must fold into an active block");
  // The whole turn groups fold: receipt AND its unref'd call and reasoning.
  const covered = new Set(laceBlock.effectiveMessageIds);
  assert.ok(covered.has("t10"), "receipt t10 covered");
  assert.ok(covered.has("c10"), "unref'd call c10 covered with it");
  assert.ok(covered.has("r10"), "unref'd reasoning r10 covered with it");
  assert.ok(covered.has("t12") && covered.has("c12"));
});

test("#4348 control: the newest compress exchanges keep the hard-coded exemption", () => {
  const { core, state, messages } = buildLace();
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  const aged = collectAgedCompressCallIds(messages, defaultConfig());
  // The lace turns aged out; the three newest tail exchanges did not.
  for (const n of [10, 11, 12]) assert.ok(aged.has(`tc${n}`), `tc${n} must be aged`);
  for (const n of [20, 21, 22]) assert.ok(!aged.has(`tc${n}`), `tc${n} must stay protected`);
  // And a fold over the newest exchanges is still refused: the blanket
  // exemption holds for them (protected-tool filter + zone).
  const byRaw = state.messageRefs.byRaw;
  const res = core.applyCompression({
    ranges: [
      {
        startRef: byRaw["t20"]!,
        endRef: byRaw["t22"]!,
        summary: "attempting to fold the newest compress exchanges must fail because they keep the hard-coded exemption from folding",
        topic: "recent-exchanges",
      },
    ],
    messages,
    state,
    config: defaultConfig(),
  });
  const folded = res.state.blocks.find((b) => b.topic === "recent-exchanges");
  assert.ok(!folded?.active, "newest exchanges must not fold");
  assert.ok(
    (res.result.errors ?? []).length > 0 || (res.result.warnings ?? []).length > 0,
    "engine must push back on folding the newest exchanges",
  );
});
