import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicToCore,
  type AnthropicRequestBody,
} from "../src/wire/anthropic.js";
import { openaiToCore, type OpenAIRequestBody } from "../src/wire/openai.js";
import {
  responsesToCore,
  type ResponsesRequestBody,
} from "../src/wire/responses.js";
import { deriveCanonicalMessageId } from "../src/wire/identity.js";
import { applyAbsorb, isAbsorbCandidate } from "../src/absorb.js";
import { isMessageProtected, isNeverPreserveRecent } from "../src/protected.js";
import { defaultConfig } from "../src/config.js";
import { createInitialState } from "../src/state.js";
import { assignRefs, refForRaw } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

function absorbConfig(overrides: Partial<Config["absorb"]> = {}): Config {
  return {
    ...defaultConfig(200000),
    absorb: {
      enabled: true,
      toolName: "absorb",
      minToolTokens: 100,
      contextThresholdPct: 0,
      excludeTools: ["bash"],
      ...overrides,
    },
  };
}

function refsFor(messages: CoreMessage[]) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

// --- Anthropic ---

const ANTHROPIC_TEXT = "x".repeat(480);

function anthropicBody(): AnthropicRequestBody {
  return {
    model: "claude-x",
    messages: [
      { role: "user", content: "run the build" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: ANTHROPIC_TEXT },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_2", name: "compress", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_2", content: "ok" }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_orphan",
            content: "orphaned",
          },
        ],
      },
    ],
  };
}

test("anthropicToCore backfills toolName onto paired tool_results", () => {
  const { msgs } = anthropicToCore(anthropicBody());
  const bashResult = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "tu_1",
  );
  const compressResult = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "tu_2",
  );
  const orphan = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "tu_orphan",
  );
  assert.equal(bashResult?.toolName, "bash");
  assert.equal(compressResult?.toolName, "compress");
  assert.ok(
    orphan && !("toolName" in orphan),
    "unpaired result must not gain a toolName",
  );
});

test("anthropicToCore result ids stay stable under the toolName backfill", () => {
  const { msgs } = anthropicToCore(anthropicBody());
  const bashResult = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "tu_1",
  )!;
  // #3642: canonical seed = toolName + text (the wire pairing id is out —
  // transport plumbing, not content). The backfill stability invariant is
  // unchanged: the seeded toolName is exactly the paired backfill.
  assert.equal(
    bashResult.id,
    deriveCanonicalMessageId("tool", "tool-result", ANTHROPIC_TEXT, {
      toolName: "bash",
    }),
  );
});

test("excludeTools guard fires on wire-projected anthropic results (issue #213)", () => {
  const { msgs } = anthropicToCore(anthropicBody());
  const bashResult = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "tu_1",
  )!;
  assert.equal(
    isAbsorbCandidate(bashResult, absorbConfig({ excludeTools: ["bash"] })),
    false,
  );
  assert.equal(
    isAbsorbCandidate(bashResult, absorbConfig({ excludeTools: [] })),
    true,
  );
});

test("isNeverPreserveRecent and isMessageProtected fire on wire-projected results", () => {
  const { msgs } = anthropicToCore(anthropicBody());
  const bashResult = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "tu_1",
  )!;
  const compressResult = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "tu_2",
  )!;
  assert.equal(isNeverPreserveRecent(bashResult), true);
  assert.equal(isMessageProtected(compressResult, defaultConfig(200000)), true);
});

test("applyAbsorb rejects absorbing an ACP-managed tool result projected from wire", () => {
  const { msgs } = anthropicToCore(anthropicBody());
  const coreMsgs = msgs as CoreMessage[];
  const state = refsFor(coreMsgs);
  const compressResult = coreMsgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "tu_2",
  )!;
  const ref = refForRaw(state.messageRefs, compressResult.id)!;
  const outcome = applyAbsorb({
    ref,
    summary: "distilled",
    messages: coreMsgs,
    state,
    config: defaultConfig(200000),
  });
  assert.equal(outcome.ok, false);
  assert.match(
    outcome.resultText,
    /absorb failed: .* is an ACP-managed tool result/,
  );
});

test("applyAbsorb rejects absorbing a protectedTools-matched result projected from wire", () => {
  const body: AnthropicRequestBody = {
    model: "claude-x",
    messages: [
      { role: "user", content: "secret" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_s", name: "vault_read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_s",
            content: "s".repeat(480),
          },
        ],
      },
    ],
  };
  const { msgs } = anthropicToCore(body);
  const coreMsgs = msgs as CoreMessage[];
  const state = refsFor(coreMsgs);
  const config = { ...defaultConfig(200000), protectedTools: ["vault_*"] };
  const result = coreMsgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "tu_s",
  )!;
  const ref = refForRaw(state.messageRefs, result.id)!;
  const outcome = applyAbsorb({
    ref,
    summary: "distilled",
    messages: coreMsgs,
    state,
    config,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.resultText, /is a protected tool/);
});

// --- OpenAI ---

function openaiBody(): OpenAIRequestBody {
  return {
    model: "gpt-x",
    messages: [
      { role: "user", content: "run" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "y".repeat(480) },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_2",
        name: "legacy_name",
        content: "z",
      },
      { role: "tool", tool_call_id: "call_orphan", content: "w" },
    ],
  };
}

test("openaiToCore backfills toolName onto paired role:tool results", () => {
  const { msgs } = openaiToCore(openaiBody());
  const bashResult = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "call_1",
  );
  const legacyResult = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "call_2",
  );
  const orphan = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "call_orphan",
  );
  assert.equal(bashResult?.toolName, "bash");
  assert.equal(
    legacyResult?.toolName,
    "legacy_name",
    "explicit message.name wins over the call map",
  );
  assert.ok(orphan && !("toolName" in orphan));
});

test("excludeTools guard fires on wire-projected openai results", () => {
  const { msgs } = openaiToCore(openaiBody());
  const bashResult = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "call_1",
  )!;
  assert.equal(
    isAbsorbCandidate(bashResult, absorbConfig({ excludeTools: ["bash"] })),
    false,
  );
  assert.equal(
    isAbsorbCandidate(bashResult, absorbConfig({ excludeTools: [] })),
    true,
  );
});

// --- Responses ---

function responsesBody(): ResponsesRequestBody {
  return {
    model: "gpt-x",
    input: [
      { type: "message", role: "user", content: "run" },
      { type: "function_call", call_id: "fc_1", name: "bash", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "fc_1",
        output: "z".repeat(480),
      },
      {
        type: "custom_tool_call",
        call_id: "ctc_1",
        name: "my_tool",
        input: "{}",
      },
      { type: "custom_tool_call_output", call_id: "ctc_1", output: "out" },
      { type: "custom_tool_call_output", call_id: "ctc_orphan", output: "o" },
    ],
  };
}

test("responsesToCore backfills toolName onto paired call outputs", () => {
  const { msgs } = responsesToCore(responsesBody());
  const fnResult = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "fc_1",
  );
  const customResult = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "ctc_1",
  );
  const orphan = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "ctc_orphan",
  );
  assert.equal(fnResult?.toolName, "bash");
  assert.equal(customResult?.toolName, "my_tool");
  assert.ok(orphan && !("toolName" in orphan));
});

test("responsesToCore output ids stay stable under the toolName backfill", () => {
  const { msgs } = responsesToCore(responsesBody());
  const fnResult = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "fc_1",
  )!;
  // #3642: canonical seed = toolName + text (wire call_id out of the seed).
  assert.equal(
    fnResult.id,
    deriveCanonicalMessageId("tool", "tool-result", "z".repeat(480), {
      toolName: "bash",
    }),
  );
});

test("excludeTools guard fires on wire-projected responses results", () => {
  const { msgs } = responsesToCore(responsesBody());
  const fnResult = msgs.find(
    (m) => m.contentType === "tool-result" && m.toolCallId === "fc_1",
  )!;
  assert.equal(
    isAbsorbCandidate(fnResult, absorbConfig({ excludeTools: ["bash"] })),
    false,
  );
  assert.equal(
    isAbsorbCandidate(fnResult, absorbConfig({ excludeTools: [] })),
    true,
  );
});
