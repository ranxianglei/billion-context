import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCore,
  createInitialState,
  defaultConfig,
  BLOCKED_REF,
} from "acp-kernel";
import {
  coreToResponses,
  coreToOpenai,
  coreToAnthropic,
} from "acp-kernel/wire";
import type { CoreMessage } from "acp-kernel";
import { isMcpBiliHardProtected } from "../src/config.js";

test("#5101: hydrated shared latch cannot alter MCP arguments in any outbound codec", () => {
  const toolName = "mcp__bili__acp_rule";
  const args = '{"action":"remove","id":"rule1"}';
  const messages: CoreMessage[] = [
    { id: "user", role: "user", contentType: "text", text: "Start" },
    {
      id: "call",
      role: "assistant",
      contentType: "tool-call",
      toolName,
      toolCallId: "call_test",
      text: args,
    },
    {
      id: "result",
      role: "tool",
      contentType: "tool-result",
      toolName,
      toolCallId: "call_test",
      text: '{"ok":true}',
    },
    { id: "tail", role: "user", contentType: "text", text: "Continue" },
  ];
  const config = {
    ...defaultConfig(10000),
    isToolProtected: isMcpBiliHardProtected,
  };
  const core = createCore();
  const initial = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 100,
  });
  assert.equal(initial.state.messageRefs.byRaw.call, BLOCKED_REF);
  initial.state.emergencyTruncateLatch = [
    { ref: BLOCKED_REF, text: "OLD_RECEIPT_NOT_ARGUMENTS" },
  ];
  const persisted = JSON.parse(
    JSON.stringify(initial.state),
  ) as typeof initial.state;
  const turn = core.processTurn({
    messages,
    state: persisted,
    config,
    tokenCount: 100,
  });
  assert.equal(turn.state.emergencyTruncateLatch, undefined);

  const responses = coreToResponses(turn.messages);
  const call = responses.find(
    (item) => item.type === "function_call" && item.call_id === "call_test",
  );
  assert.equal(call?.arguments, args);
  const output = responses.find(
    (item) =>
      item.type === "function_call_output" && item.call_id === "call_test",
  );
  assert.equal(output?.output, '{"ok":true}');

  const chat = coreToOpenai(turn.messages);
  const chatCall = chat
    .flatMap((message) => message.tool_calls ?? [])
    .find((item) => item.id === "call_test");
  assert.equal(chatCall?.function.arguments, args);
  assert.equal(
    chat.find((message) => message.role === "tool")?.content,
    '{"ok":true}',
  );

  const anthropic = coreToAnthropic(turn.messages);
  const blocks = anthropic.flatMap((message) =>
    typeof message.content === "string" ? [] : message.content,
  );
  const anthropicCall = blocks.find(
    (block) => block.type === "tool_use" && block.id === "call_test",
  );
  assert.ok(anthropicCall && "input" in anthropicCall);
  assert.deepEqual(anthropicCall.input, JSON.parse(args));
  const anthropicOutput = blocks.find(
    (block) =>
      block.type === "tool_result" && block.tool_use_id === "call_test",
  );
  assert.ok(anthropicOutput && "content" in anthropicOutput);
  assert.equal(anthropicOutput.content, '{"ok":true}');
});
