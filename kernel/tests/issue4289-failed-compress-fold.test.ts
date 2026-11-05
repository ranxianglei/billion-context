// #4289: a compress exchange that applied ZERO ranges (its result starts with
// "[Compression FAILED") is refuse, not metadata — no block carries its
// arguments and decompress never consults it. Both halves of such an exchange
// lose ALL built-in protection (ALWAYS table, protectedTools patterns, host
// tool-hooks) and fold like ordinary messages, so a failing compress loop
// cannot permanently bloat context. Recognition is dialect-aware through
// config.isCompressTool (MCP lanes expose mcp__bili__compress); without the
// recognizer an unknown-dialect exchange stays conservatively pinned.
// Successful and partial receipts start with "[Compressed" and STAY protected
// — those arguments are the on-record summaries decompress restores from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { BLOCKED_REF } from "../src/refs.js";
import { defaultConfig } from "../src/config.js";
import { buildCompressibleRanges } from "../src/recommend.js";
import {
  collectFailedCompressCallIds,
  collectProtectedToolCallIds,
  isFailedCompressResult,
} from "../src/protected.js";
import type { Config, CoreMessage } from "../src/types.js";

const longText = "x".repeat(6000);
const validSummary =
  "A meaningful summary that captures the key information of the compressed range including file paths and decisions.";

function call(
  id: string,
  callId: string,
  args: string,
  toolName = "compress",
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

function result(
  id: string,
  callId: string,
  text: string,
  toolName = "compress",
): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolName,
    toolCallId: callId,
    text,
  };
}

function user(id: string, text = longText): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function cfg(overrides: Partial<Config> = {}): Config {
  return defaultConfig(200000, {
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    // Arms the protection pipeline (hasProtection) without matching anything,
    // mirroring a real host that configures protection hooks.
    protectedTools: ["nomatch-*"],
    ...overrides,
  });
}

function session(): CoreMessage[] {
  return [
    user("u1"),
    // Failed exchange: result applied zero ranges — the #4289 refuse shape.
    call("fc1", "call-failed", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: validSummary }] })),
    result("fr1", "call-failed", `[Compression FAILED: Requested range(s) cannot be anchored. Nothing compressed. [cause: gate:none-resolved]]`),
    user("u2"),
    // Successful exchange: load-bearing metadata, must stay protected.
    call("sc1", "call-ok", JSON.stringify({ content: [{ startId: "m00001", endId: "m00001", summary: validSummary }] })),
    result("sr1", "call-ok", `[Compressed m00001–m00001 → 1 block(s), ~1234 tokens saved.]`),
    user("u3"),
  ];
}

test("#4289 failed compress exchange gets foldable refs; successful stays BLOCKED", () => {
  const core = createCore();
  const turn = core.processTurn({
    messages: session(),
    state: createInitialState(),
    config: cfg(),
    tokenCount: 1000,
  });

  const byRaw = turn.state.messageRefs.byRaw;
  assert.notEqual(byRaw["fc1"], BLOCKED_REF, "failed compress CALL must get a numeric ref");
  assert.notEqual(byRaw["fr1"], BLOCKED_REF, "failed compress RESULT must get a numeric ref");
  assert.equal(byRaw["sc1"], BLOCKED_REF, "successful compress CALL stays BLOCKED");
  assert.equal(byRaw["sr1"], BLOCKED_REF, "successful compress RESULT stays BLOCKED");
});

test("#4289 failed compress exchange folds; successful exchange stays visible in the same range", () => {
  const core = createCore();
  const messages = session();
  const turn = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg(),
    tokenCount: 1000,
  });
  const byRaw = turn.state.messageRefs.byRaw;
  const startRef = byRaw["u1"];
  const endRef = byRaw["u3"];
  assert.ok(typeof startRef === "string" && startRef.startsWith("m"));
  assert.ok(typeof endRef === "string" && endRef.startsWith("m"));

  const applied = core.applyCompression({
    ranges: [{ startRef, endRef, summary: validSummary }],
    messages,
    state: turn.state,
    config: cfg(),
  });

  assert.equal(applied.result.blocksCreated, 1, "the range must fold");
  const block = applied.state.blocks[0]!;
  assert.ok(block.directMessageIds.includes("fc1"), "failed compress call folds into the block");
  assert.ok(block.directMessageIds.includes("fr1"), "failed compress result folds into the block");
  assert.ok(!block.effectiveMessageIds.includes("sc1"), "successful compress call stays visible");
  assert.ok(!block.effectiveMessageIds.includes("sr1"), "successful compress result stays visible");
});

test("#4289 pending compress call (no result yet) stays protected", () => {
  const core = createCore();
  const messages = [user("u1"), call("pc1", "call-pending", "{}"), user("u2")];
  const turn = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg(),
    tokenCount: 1000,
  });

  const ref = turn.state.messageRefs.byRaw["pc1"];
  assert.equal(ref, BLOCKED_REF, "a call with no result yet keeps ALWAYS protection (outcome unknown)");
});

test("#4289 partial receipt starts with [Compressed and stays protected", () => {
  const core = createCore();
  const messages = [
    user("u1"),
    call("pc1", "call-partial", "{}"),
    result("pr1", "call-partial", `[Compressed m00001–m00002 → 1 block(s), ~900 tokens saved.\npartial: 1 applied 1 rejected (kind=ok) reasons=[entry 2: line entry: missing summary after the refs header line]]`),
    user("u2"),
  ];
  const turn = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg(),
    tokenCount: 1000,
  });

  const byRaw = turn.state.messageRefs.byRaw;
  assert.equal(byRaw["pc1"], BLOCKED_REF, "partial compress call stays protected — its args cover the range that DID fold");
  assert.equal(byRaw["pr1"], BLOCKED_REF, "partial compress result stays protected");
});

test("#4289 legacy BLOCKED refs from before the fix self-heal to numeric on the next assignRefs", () => {
  const core = createCore();
  const messages = session();
  // Simulate pre-#4289 state: every compress exchange was assigned BLOCKED.
  const legacy = core.processTurn({
    messages: [user("u1")],
    state: createInitialState(),
    config: cfg({ protectedTools: ["nomatch-*"] }),
    tokenCount: 1000,
  });
  // Force the old shape by pre-seeding refs through a fully-protected pass:
  const oldStyleConfig = cfg();
  const oldTurn = createCore().processTurn({
    messages,
    state: legacy.state,
    config: {
      ...oldStyleConfig,
      // Pre-fix behavior: pretend every compress exchange is protected.
      isMessageProtected: (m) => m.toolName === "compress",
    },
    tokenCount: 1000,
  });
  assert.equal(oldTurn.state.messageRefs.byRaw["fc1"], BLOCKED_REF, "fixture sanity: failed call was BLOCKED pre-fix");

  // The next turn with post-fix code re-runs assignRefs and must migrate the
  // failed exchange off BLOCKED (refs.ts BLOCKED→numeric migration, #2607).
  const healed = core.processTurn({
    messages,
    state: oldTurn.state,
    config: cfg(),
    tokenCount: 1000,
  });

  assert.notEqual(healed.state.messageRefs.byRaw["fc1"], BLOCKED_REF, "failed call must migrate BLOCKED → numeric");
  assert.notEqual(healed.state.messageRefs.byRaw["fr1"], BLOCKED_REF, "failed result must migrate BLOCKED → numeric");
  assert.equal(healed.state.messageRefs.byRaw["sc1"], BLOCKED_REF, "successful exchange stays BLOCKED");
});

test("#4289 unit shapes: isFailedCompressResult / collectFailedCompressCallIds / collectProtectedToolCallIds", () => {
  const failed = result("r", "c1", "[Compression FAILED: nope]");
  assert.ok(isFailedCompressResult(failed));
  assert.ok(!isFailedCompressResult({ ...failed, toolName: "acp_rule" }), "prefix on a non-compress tool is not the signal");
  assert.ok(!isFailedCompressResult({ ...failed, text: "[Compressed m00001–m00002 → 1 block(s), ~10 tokens saved.]" }), "success receipt is not failure");
  assert.ok(!isFailedCompressResult({ ...failed, text: undefined as unknown as string }), "missing text is never failure");

  const messages = [
    call("c1", "call-1", "{}"),
    result("r1", "call-1", "[Compression FAILED: nope]"),
    call("c2", "call-2", "{}"),
    result("r2", "call-2", "[Compressed m00001–m00001 → 1 block(s), ~10 tokens saved.]"),
  ];
  assert.deepEqual([...collectFailedCompressCallIds(messages)], ["call-1"]);

  const protectedIds = collectProtectedToolCallIds(messages, cfg());
  assert.ok(!protectedIds.has("call-1"), "failed compress call is not in the protected set (its result can never be re-protected via pairing)");
  assert.ok(protectedIds.has("call-2"), "successful compress call stays in the protected set");
});

test("#4289 recommend advertises the failed exchange as compressible, not protected", () => {
  const core = createCore();
  const messages = session();
  const turn = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg(),
    tokenCount: 1000,
  });
  const byRaw = turn.state.messageRefs.byRaw;
  const ranges = buildCompressibleRanges(messages, turn.state, cfg());

  assert.ok(
    ranges.compressible.some(
      (r) => r.startRef === byRaw["u1"] && r.endRef === byRaw["fr1"] && r.count === 3,
    ),
    "the span u1..fr1 including the failed exchange must be advertised compressible",
  );
  assert.ok(
    !ranges.protected.some((p) => p.startRef === byRaw["fc1"]),
    "the failed exchange must not be listed as protected",
  );
  // BLOCKED refs consume no advertised slot (recommend.ts skips them; ranges
  // bridge over them and apply carves them out): the successful exchange must
  // contribute NOTHING to the advertised set — all 5 other messages do.
  assert.equal(
    ranges.compressible.reduce((n, r) => n + r.count, 0),
    5,
    "advertised count excludes both halves of the successful exchange",
  );
});

test("#4289 path-pattern protectedTools shape: failed exchange still foldable on the pairing branch", () => {
  const core = createCore();
  const config = cfg({ protectedTools: ["skill/*"] });
  const turn = core.processTurn({
    messages: session(),
    state: createInitialState(),
    config,
    tokenCount: 1000,
  });
  const byRaw = turn.state.messageRefs.byRaw;
  assert.notEqual(byRaw["fc1"], BLOCKED_REF, "path-pattern shape: failed CALL gets a numeric ref");
  assert.notEqual(byRaw["fr1"], BLOCKED_REF, "path-pattern shape: failed RESULT gets a numeric ref");
  assert.equal(byRaw["sc1"], BLOCKED_REF, "successful exchange unaffected");
  assert.equal(byRaw["sr1"], BLOCKED_REF, "successful exchange unaffected");
});

const MCP_TOOL = "mcp__bili__compress";

function mcpHooks() {
  return {
    isToolProtected: (t: string) => t === MCP_TOOL || t === "mcp__bili__acp_rule",
    isCompressTool: (t: string) => t === "compress" || t === MCP_TOOL,
  };
}

function mcpSession(): CoreMessage[] {
  return [
    user("u1"),
    call("fc1", "call-failed", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: validSummary }] }), MCP_TOOL),
    result("fr1", "call-failed", `[Compression FAILED: Requested range(s) cannot be anchored. Nothing compressed. [cause: gate:none-resolved]]`, MCP_TOOL),
    user("u2"),
    call("sc1", "call-ok", JSON.stringify({ content: [{ startId: "m00001", endId: "m00001", summary: validSummary }] }), MCP_TOOL),
    result("sr1", "call-ok", `[Compressed m00001–m00001 → 1 block(s), ~1234 tokens saved.]`, MCP_TOOL),
    user("u3"),
  ];
}

test("#4289 MCP dialect: failed mcp__bili__compress exchange foldable and advertised; successful pinned", () => {
  const core = createCore();
  const messages = mcpSession();
  const config = cfg(mcpHooks());
  const turn = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 1000,
  });
  const byRaw = turn.state.messageRefs.byRaw;
  assert.notEqual(byRaw["fc1"], BLOCKED_REF, "MCP failed CALL gets a numeric ref");
  assert.notEqual(byRaw["fr1"], BLOCKED_REF, "MCP failed RESULT gets a numeric ref");
  assert.equal(byRaw["sc1"], BLOCKED_REF, "MCP successful receipt keeps protection");
  assert.equal(byRaw["sr1"], BLOCKED_REF, "MCP successful receipt keeps protection");

  const ranges = buildCompressibleRanges(messages, turn.state, config);
  assert.ok(
    ranges.compressible.some(
      (r) => r.startRef === byRaw["u1"] && r.endRef === byRaw["fr1"] && r.count === 3,
    ),
    "MCP dialect: the failed exchange span must be advertised compressible",
  );
  assert.ok(
    !ranges.protected.some((p) => p.startRef === byRaw["fc1"]),
    "MCP dialect: the failed exchange must not be listed as protected",
  );
});

test("#4289 MCP name WITHOUT the isCompressTool recognizer stays conservatively pinned", () => {
  const core = createCore();
  const config = cfg({ ...mcpHooks(), isCompressTool: undefined });
  const turn = core.processTurn({
    messages: mcpSession(),
    state: createInitialState(),
    config,
    tokenCount: 1000,
  });
  const byRaw = turn.state.messageRefs.byRaw;
  assert.equal(byRaw["fc1"], BLOCKED_REF, "unidentifiable dialect: host hard-protection hook wins, no risky exemption");
  assert.equal(byRaw["fr1"], BLOCKED_REF, "unidentifiable dialect: host hard-protection hook wins, no risky exemption");
});

test("#4289 dialect-aware recognition units: bare always counts, recognizer extends", () => {
  const mcp = result("r", "call-1", "[Compression FAILED: nope]", MCP_TOOL);
  assert.ok(!isFailedCompressResult(mcp), "without the recognizer the MCP name is NOT recognized (conservative)");
  assert.ok(
    isFailedCompressResult(mcp, { isCompressTool: (t) => t === MCP_TOOL }),
    "with the recognizer the MCP failure IS recognized",
  );
  const bare = result("r2", "c2", "[Compression FAILED: nope]");
  assert.ok(
    isFailedCompressResult(bare, { isCompressTool: (t) => t === MCP_TOOL }),
    "bare compress counts even when the recognizer only claims the dialect (union, never narrower)",
  );
  const msgs = [call("c1", "call-1", "{}", MCP_TOOL), mcp];
  assert.deepEqual([...collectFailedCompressCallIds(msgs)], [], "no recognizer → no ids");
  assert.deepEqual(
    [...collectFailedCompressCallIds(msgs, { isCompressTool: (t) => t === MCP_TOOL })],
    ["call-1"],
    "recognizer → failed MCP call id collected",
  );
});
// #4307: the two refuse gates whose draft parses but commits nothing emit
// "[Compression refused: …" receipts (src/stream.ts gate:coverage-regression /
// gate:no-net-shrink). Zero ranges applied — same dead-draft semantics as
// FAILED, so the exchange must un-protect and fold identically.
const refusedSession = (): CoreMessage[] => [
  user("u1"),
  call("rc1", "call-refused", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: validSummary }] })),
  result("rr1", "call-refused", `[Compression refused: no net shrink — the summary you supplied is not smaller than the range it replaces (committing it would grow the context by 42 token(s)). Nothing was folded: no block was created and the context prefix/cache were left untouched. Do not re-issue this same range and summary; supply a much shorter summary for the range, target a larger span so the summary shrinks it, or continue your task without compressing.]`),
  user("u2"),
  call("rc2", "call-refused-cov", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: validSummary }] })),
  result("rr2", "call-refused-cov", `[Compression refused: coverage regression — folding these ranges would leave 3 already-folded message(s) without any covering block, so the live context view would GROW instead of shrink (and the size estimate can blow past the model window, bricking the session behind permanent preflight rejections). Nothing was folded: no block was created and the context prefix/cache were left untouched. Retry with ranges aligned to whole turns (do not cut through a reasoning/tool-call/result group), target fewer blocks, or continue your task without compressing.]`),
  user("u3"),
  // Successful exchange amid refusals: load-bearing metadata, stays protected.
  call("sc1", "call-ok", JSON.stringify({ content: [{ startId: "m00001", endId: "m00001", summary: validSummary }] })),
  result("sr1", "call-ok", `[Compressed m00001–m00001 → 1 block(s), ~1234 tokens saved.]`),
  user("u4"),
];

test("#4307 refused compress exchanges get foldable refs; successful stays BLOCKED", () => {
  const core = createCore();
  const turn = core.processTurn({
    messages: refusedSession(),
    state: createInitialState(),
    config: cfg(),
    tokenCount: 1000,
  });

  const byRaw = turn.state.messageRefs.byRaw;
  assert.notEqual(byRaw["rc1"], BLOCKED_REF, "refused compress CALL must get a numeric ref");
  assert.notEqual(byRaw["rr1"], BLOCKED_REF, "refused compress RESULT must get a numeric ref");
  assert.notEqual(byRaw["rc2"], BLOCKED_REF, "coverage-regression refused CALL must get a numeric ref");
  assert.notEqual(byRaw["rr2"], BLOCKED_REF, "coverage-regression refused RESULT must get a numeric ref");
  assert.equal(byRaw["sc1"], BLOCKED_REF, "successful compress CALL stays BLOCKED");
  assert.equal(byRaw["sr1"], BLOCKED_REF, "successful compress RESULT stays BLOCKED");
});

test("#4307 refused compress exchanges fold; successful exchange stays visible in the same range", () => {
  const core = createCore();
  const messages = refusedSession();
  const turn = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg(),
    tokenCount: 1000,
  });
  const byRaw = turn.state.messageRefs.byRaw;
  const startRef = byRaw["u1"];
  const endRef = byRaw["u4"];
  assert.ok(typeof startRef === "string" && startRef.startsWith("m"));
  assert.ok(typeof endRef === "string" && endRef.startsWith("m"));

  const applied = core.applyCompression({
    ranges: [{ startRef, endRef, summary: validSummary }],
    messages,
    state: turn.state,
    config: cfg(),
  });

  assert.equal(applied.result.blocksCreated, 1, "the range must fold");
  const block = applied.state.blocks[0]!;
  for (const id of ["rc1", "rr1", "rc2", "rr2"]) {
    assert.ok(block.directMessageIds.includes(id), `refused exchange half ${id} folds into the block`);
  }
  assert.ok(!block.effectiveMessageIds.includes("sc1"), "successful compress call stays visible");
  assert.ok(!block.effectiveMessageIds.includes("sr1"), "successful compress result stays visible");
});

test("#4307 unit shapes: refused receipts recognized as failed by both prefixes", () => {
  const noNetShrink = result("r", "c1", `[Compression refused: no net shrink — the summary you supplied is not smaller than the range it replaces (committing it leaves the context size unchanged). Nothing was folded.]`);
  const coverage = result("r", "c2", `[Compression refused: coverage regression — folding these ranges would leave 1 already-folded message(s) without any covering block.]`);
  assert.ok(isFailedCompressResult(noNetShrink), "gate:no-net-shrink receipt is failure");
  assert.ok(isFailedCompressResult(coverage), "gate:coverage-regression receipt is failure");
  assert.ok(!isFailedCompressResult({ ...noNetShrink, toolName: "acp_rule" }), "refused prefix on a non-compress tool is not the signal");

  const messages = [
    call("c1", "call-refused", "{}"),
    result("r1", "call-refused", noNetShrink.text!),
    call("c2", "call-failed", "{}"),
    result("r2", "call-failed", "[Compression FAILED: nope]"),
    call("c3", "call-ok", "{}"),
    result("r3", "call-ok", "[Compressed m00001–m00001 → 1 block(s), ~10 tokens saved.]"),
  ];
  assert.deepEqual(
    [...collectFailedCompressCallIds(messages)].sort(),
    ["call-failed", "call-refused"],
    "both FAILED and refused call ids are collected",
  );

  const protectedIds = collectProtectedToolCallIds(messages, cfg());
  assert.ok(!protectedIds.has("call-refused"), "refused compress call is not re-protected via pairing");
  assert.ok(!protectedIds.has("call-failed"), "failed compress call is not re-protected via pairing");
  assert.ok(protectedIds.has("call-ok"), "successful compress call stays in the protected set");
});
