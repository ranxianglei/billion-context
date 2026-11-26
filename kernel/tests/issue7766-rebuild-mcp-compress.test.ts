import { test } from "node:test";
import assert from "node:assert/strict";
import { rebuildCompressionState } from "../src/rebuild.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import type { Config, CoreMessage } from "../src/types.js";

function configWith(predicate?: (name: string) => boolean): Config {
  return defaultConfig(100_000, {
    preserveRecentMessages: 1,
    preserveRecentTokens: 0,
    compress: {
      minCompressRange: 100,
      maxSummaryLength: 20_000,
      minSummaryLength: 10,
    },
    ...(predicate ? { isCompressTool: predicate } : {}),
  });
}

function history(toolName: string): CoreMessage[] {
  const summary =
    "summary of the first exchange, long enough for the rebuild probe " +
    "s".repeat(40);
  const args = JSON.stringify({
    content: `m00001–m00002 topic\n${summary}`,
  });
  return [
    {
      id: "u1",
      role: "user",
      contentType: "text",
      text: "one " + "x".repeat(400),
    },
    {
      id: "a1",
      role: "assistant",
      contentType: "text",
      text: "two " + "y".repeat(400),
    },
    {
      id: "c1",
      role: "assistant",
      contentType: "tool-call",
      toolName,
      toolCallId: "call-1",
      text: args,
    },
    {
      id: "r1",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "call-1",
      text: "Compression applied.",
    },
    {
      id: "u2",
      role: "user",
      contentType: "text",
      text: "three " + "z".repeat(400),
    },
  ];
}

test("#7766 rebuild recognizes the MCP-dialect compress name via isCompressTool", () => {
  const isMcp = (name: string) =>
    name === "compress" || name.endsWith("bili__compress");
  for (const name of ["compress", "mcp__bili__compress"]) {
    const result = rebuildCompressionState(
      createInitialState(),
      history(name),
      configWith(isMcp),
    );
    assert.equal(
      result.blocksRebuilt,
      1,
      `${name} must rebuild exactly one block`,
    );
    const block = result.state.blocks[0];
    assert.equal(block?.blockId, "b1");
    assert.deepEqual(block?.directMessageIds, ["u1", "a1"]);
  }
});

test("#7766 without the predicate only the bare name is recognized (unchanged)", () => {
  const bare = rebuildCompressionState(
    createInitialState(),
    history("compress"),
    configWith(),
  );
  const mcp = rebuildCompressionState(
    createInitialState(),
    history("mcp__bili__compress"),
    configWith(),
  );
  assert.equal(bare.blocksRebuilt, 1);
  assert.equal(mcp.blocksRebuilt, 0);
});
