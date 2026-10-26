// #3222 必改 2: stripOrphanedToolCalls exempted only the bare "compress" name
// from orphan-call removal, so a pending mcp__bili__compress call (no result
// yet) was stripped while the bare-name twin survived under the same coverage.
// prune now takes isCompressTool (same predicate family as Config.isCompressTool
// / hideConsumedCompressCalls); compress.ts's pruneNode passes the host
// predicate through, and unset options stay byte-identical to before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prune } from "../src/prune.js";
import { createInitialState } from "../src/state.js";
import type { CompressionBlock, CompressionState, CoreMessage } from "../src/types.js";

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

// Active coverage over raw1/raw2 so prune takes the real coverage path
// (covered.size > 0 — without it prune early-returns and never reaches
// stripOrphanedToolCalls).
function stateWithActiveCoverage(): CompressionState {
  const s = createInitialState();
  s.blocks.push(block({ blockId: "b1", effectiveMessageIds: ["raw1", "raw2"] }));
  return s;
}

function seq(callName: string): CoreMessage[] {
  return [
    { id: "raw1", role: "user", contentType: "text", text: "a" },
    { id: "raw2", role: "assistant", contentType: "text", text: "b" },
    { id: "later", role: "user", contentType: "text", text: "c" },
    { id: "pend", role: "assistant", contentType: "tool-call", toolName: callName, toolCallId: "c1", text: "{}" },
  ];
}

test("bare compress pending call survives an active coverage pass (pre-existing behavior)", () => {
  const out = prune(seq("compress"), stateWithActiveCoverage());
  assert.ok(out.some((m) => m.id === "pend"), "pending bare compress call kept");
});

test("#3222: pending mcp__bili__compress call survives with the host predicate (parity with bare name)", () => {
  const out = prune(seq("mcp__bili__compress"), stateWithActiveCoverage(), { isCompressTool: isMcp });
  assert.ok(out.some((m) => m.id === "pend"), "pending MCP compress call kept like its bare-name twin");
});

test("normal orphan calls are still stripped when the predicate is set", () => {
  const out = prune(seq("bash"), stateWithActiveCoverage(), { isCompressTool: isMcp });
  assert.ok(!out.some((m) => m.id === "pend"), "bash orphan still stripped");
});

test("other MCP tools are not misidentified as compress", () => {
  const out = prune(seq("mcp__other__thing"), stateWithActiveCoverage(), { isCompressTool: isMcp });
  assert.ok(!out.some((m) => m.id === "pend"), "foreign MCP tool still orphan-stripped");
});

test("default options stay byte-identical to pre-fix behavior (bare-name only)", () => {
  const mcp = prune(seq("mcp__bili__compress"), stateWithActiveCoverage());
  assert.ok(!mcp.some((m) => m.id === "pend"), "without the predicate the MCP call is still stripped");
  const bare = prune(seq("compress"), stateWithActiveCoverage());
  assert.ok(bare.some((m) => m.id === "pend"), "bare-name exemption unchanged under defaults");
});
