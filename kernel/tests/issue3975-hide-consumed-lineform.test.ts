// #3975: the compress tool accepts a PLAIN-TEXT line-form `content` string
// (first line "m00100–m00120 topic", remaining lines the summary), but
// hide-consumed's parseCallText only understood object arrays and
// stringified JSON arrays. Plain-text calls therefore mis-resolved as
// orphans: on quiet turns they rode along with their FULL summary text
// (never stubbed), duplicating the acp_summary carrier, and on fold turns
// they were swept as failure residue although they ARE the folded block's
// summary carrier (#1567). The cleanup now reuses the kernel's own line-form
// parser (parseLineContent) so both shapes get identical treatment. These
// tests pin: stubbing of live plain-text carriers (MCP synthetic-id +
// bare-name id-matched lanes), range-based fate resolution incl. fold-sweep
// exemption (#3769), partial-range degradation, all-dead hiding, quiet-turn
// orphan stubbing, and the pre-existing shapes (object array, stringified
// array, unparseable garbage) staying byte-stable where they already were.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import { parseLineContent } from "../src/parse-compress-input.js";
import { createInitialState } from "../src/state.js";
import type {
  CompressionBlock,
  CoreMessage,
} from "../src/types.js";

// Host-injected predicate mirroring src/config.ts isMcpBiliCompress (#2970).
const isMcp = (name: string): boolean =>
  name === "compress" || name === "mcp__bili__compress";

function block(overrides: Partial<CompressionBlock>): CompressionBlock {
  return {
    blockId: "b0",
    runId: "r0",
    tier: 1,
    summary: "summary",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    createdAt: 1000,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

function pair(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
): [CoreMessage, CoreMessage] {
  const call: CoreMessage = {
    id: `call-${toolCallId}`,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId,
    text: JSON.stringify(args),
  };
  const result: CoreMessage = {
    id: `result-${toolCallId}`,
    role: "tool",
    contentType: "tool-result",
    toolCallId,
    text: "ok",
  };
  return [call, result];
}

/** Extract the parsed args object from a (possibly rewritten) call text. */
function argsOf(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const v: unknown = JSON.parse(text.slice(start));
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

test("parseLineContent: normalizes refs exactly like the tool's own parser", () => {
  const entries = parseLineContent("m100–m120 task progress\nfull body");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.startRef, "m00100", "m-refs padded to 5 digits");
  assert.equal(entries[0]!.endRef, "m00120");
  assert.equal(entries[0]!.summary, "full body");
  assert.equal(entries[0]!.header, "m100–m120 task progress");

  const multi = parseLineContent(
    "b2–b5 first\nbody one\nm00200~m00300 second topic\n## Head\nbody two",
  );
  assert.equal(multi.length, 2);
  assert.deepEqual(
    [multi[0]!.startRef, multi[0]!.endRef],
    ["b2", "b5"],
    "block refs stay lowercase, unpadded",
  );
  assert.deepEqual(
    [multi[1]!.startRef, multi[1]!.endRef],
    ["m00200", "m00300"],
  );
  assert.equal(multi[1]!.topic, "second topic");
});

test("parseLineContent: refless garbage stays verbatim and claims no range", () => {
  const entries = parseLineContent("hello world");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.startRef, undefined);
  assert.equal(entries[0]!.source, "hello world");
});

test("#3975 L1: plain-text active carrier (MCP synthetic-id) is stubbed like object arrays", () => {
  const state = createInitialState();
  state.blocks.push(
    block({
      blockId: "b-live",
      compressCallId: "plugin_live",
      active: true,
      startRef: "m00001",
      endRef: "m00050",
    }),
  );
  const longSummary = "x".repeat(500);
  const [call] = pair(
    "mcp__bili__compress",
    "tool_a",
    { content: `m00001–m00050 Task progress\n${longSummary}` },
  );

  const r = hideConsumedCompressCalls(state, [call], isMcp);
  const kept = r.messages.find((m) => m.toolCallId === "tool_a")!;
  const args = argsOf(kept.text!)!;
  assert.equal(typeof args.content, "string", "line-form shape preserved");
  const lines = (args.content as string).split("\n");
  assert.equal(lines[0], "m00001–m00050 Task progress", "header verbatim");
  assert.equal(lines[1]!.length, 200, "long summary stubbed");
  assert.ok(lines[1]!.endsWith("…"));
});

test("#3975 L2: plain-text call resolves by range — fold sweep spares it, sweeps true orphans (#3769)", () => {
  const state = createInitialState();
  state.blocks.push(
    block({
      blockId: "b-live",
      compressCallId: "plugin_live",
      active: true,
      startRef: "m00001",
      endRef: "m00050",
    }),
  );
  // refs: p1=100 c-tool_a=101 r-tool_a=102 p2=103 c-f1=104 r-f1=105
  const msgs: CoreMessage[] = [
    { id: "p1", role: "user", contentType: "text", text: "early" },
    ...pair("mcp__bili__compress", "tool_a", { content: "m00001–m00050 t\nsummary" }),
    { id: "p2", role: "user", contentType: "text", text: "mid" },
    ...pair("mcp__bili__compress", "f1", { content: [{ startId: "mX1", endId: "mY1", summary: "s" }] }),
  ];
  state.messageRefs.byRaw["p1"] = "m00100";
  state.messageRefs.byRaw["call-tool_a"] = "m00101";
  state.messageRefs.byRaw["result-tool_a"] = "m00102";
  state.messageRefs.byRaw["p2"] = "m00103";
  state.messageRefs.byRaw["call-f1"] = "m00104";
  state.messageRefs.byRaw["result-f1"] = "m00105";
  // A fold whose earliest start ref covers everything in this history.
  state.pendingOrphanSweepMinRef = 100;

  const r = hideConsumedCompressCalls(state, msgs, isMcp);
  const kept = new Set(r.messages.map((m) => m.toolCallId));
  assert.ok(kept.has("tool_a"), "plain-text carrier quoting an ACTIVE range is fate=active, not an orphan");
  assert.deepEqual(r.newlySweptCallIds, ["f1"], "the true orphan at/after the fold is swept");
  assert.equal(r.hidden, 2, "swept orphan pair removed (call + result)");
  assert.ok(!kept.has("f1"));
});

test("#3975: partial range invalidation — live entries kept+stubbed, dead entries dropped", () => {
  const state = createInitialState();
  state.blocks.push(
    block({ blockId: "b-live", compressCallId: "plugin_live", active: true, startRef: "m00001", endRef: "m00050" }),
    block({ blockId: "b-dead", compressCallId: "plugin_dead", active: false, startRef: "m00100", endRef: "m00150" }),
  );
  const [call] = pair("mcp__bili__compress", "tool_mix", {
    content: `m00001–m00050 Live topic\n${"a".repeat(500)}\nm00100–m00150 Dead topic\n${"b".repeat(500)}`,
  });

  const r = hideConsumedCompressCalls(state, [call], isMcp);
  const kept = r.messages.find((m) => m.toolCallId === "tool_mix")!;
  const out = argsOf(kept.text!)!.content as string;
  assert.ok(out.includes("m00001"), "live range retained");
  assert.ok(!out.includes("m00100"), "dead range dropped from rendered args");
  const lines = out.split("\n");
  assert.equal(lines.length, 2, "one entry: header + stub");
  assert.equal(lines[1]!.length, 200, "retained summary stubbed");
});

test("#3975: all ranges dead -> inactive carrier hidden entirely", () => {
  const state = createInitialState();
  state.blocks.push(
    block({ blockId: "b-dead", compressCallId: "plugin_dead", active: false, startRef: "m00001", endRef: "m00050" }),
  );
  const msgs = pair("mcp__bili__compress", "tool_dead", { content: "m00001–m00050 t\nsummary" });

  const r = hideConsumedCompressCalls(state, msgs, isMcp);
  assert.equal(r.hidden, 2, "call + result removed");
  assert.ok(!r.messages.some((m) => m.toolCallId === "tool_dead"));
});

test("#3975: failed-fold orphans (plain text) stay visible on a quiet turn but their summaries are stubbed", () => {
  const state = createInitialState();
  const msgs: CoreMessage[] = [];
  // Valid digit refs naming messages that exist nowhere — the calls are orphans
  // by range, not by malformed headers.
  const ranges: Record<string, string> = { f1: "m90001–m90051", f2: "m90002–m90052", f3: "m90003–m90053" };
  for (const id of ["f1", "f2", "f3"]) {
    msgs.push(
      ...pair("mcp__bili__compress", id, {
        content: `${ranges[id]} failed attempt\n${id.repeat(400)}`,
      }),
    );
  }

  const r = hideConsumedCompressCalls(state, msgs, isMcp);
  assert.equal(r.hidden, 0, "quiet turn sweeps nothing (#3769)");
  for (const id of ["f1", "f2", "f3"]) {
    const kept = r.messages.find((m) => m.toolCallId === id)!;
    const out = argsOf(kept.text!)!.content as string;
    const summaryLine = out.split("\n")[1]!;
    assert.equal(summaryLine.length, 200, `${id}: orphan summary stubbed (pre-fix: full text)`);
    assert.ok(summaryLine.endsWith("…"));
  }
});

test("#3975: bare-name proxy lane — id-matched plain-text call is stubbed too", () => {
  const state = createInitialState();
  state.blocks.push(
    block({ blockId: "b-live", compressCallId: "call_1", active: true, startRef: "m00001", endRef: "m00050" }),
  );
  const [call] = pair("compress", "call_1", {
    content: `m00001–m00050 proxy lane\n${"p".repeat(500)}`,
  });

  const r = hideConsumedCompressCalls(state, [call]);
  const kept = r.messages.find((m) => m.toolCallId === "call_1")!;
  const out = argsOf(kept.text!)!.content as string;
  assert.equal(out.split("\n")[1]!.length, 200, "id-matched lane stubs long line-form summaries");
});

test("regression: stringified JSON-array content keeps its shape and stubbing (#230)", () => {
  const state = createInitialState();
  state.blocks.push(
    block({ blockId: "b-live", compressCallId: "plugin_live", active: true, startRef: "m00001", endRef: "m00050" }),
  );
  const inner = JSON.stringify([
    { startId: "m00001", endId: "m00050", summary: "y".repeat(500) },
  ]);
  const [call] = pair("mcp__bili__compress", "tool_s", { content: inner });

  const r = hideConsumedCompressCalls(state, [call], isMcp);
  const kept = r.messages.find((m) => m.toolCallId === "tool_s")!;
  const args = argsOf(kept.text!)!;
  assert.equal(typeof args.content, "string", "stays a string");
  const decoded: unknown = JSON.parse(args.content as string);
  assert.ok(Array.isArray(decoded), "still decodes to an array");
  assert.equal((decoded as { summary: string }[])[0]!.summary.length, 200);
});

test("regression: refless plain-text garbage stays byte-identical (orphan, nothing to stub)", () => {
  const state = createInitialState();
  const text = JSON.stringify({ content: "hello world" });
  const [call, result] = pair("mcp__bili__compress", "tool_g", { content: "hello world" });

  const r = hideConsumedCompressCalls(state, [call, result], isMcp);
  assert.equal(r.hidden, 0);
  assert.equal(r.messages[0]!.text, text, "unparsable-for-ranges args untouched");
  assert.equal(r.messages[1]!.text, "ok");
});
