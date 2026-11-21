// Server-tool pairing backstop in coreToAnthropic. Server tools (advisor,
// web_search, …) carry server_tool_use + <name>_tool_result inside ONE
// assistant message; anthropicToCore splits each block into its own
// BiliMessage, so a fold can drop one half. Anthropic then 400s the whole
// request: "unexpected tool_use_id found in advisor_tool_result blocks …
// Each advisor_tool_result block must have a corresponding server_tool_use
// block in the same message". Positive AND negative rows (#3617): orphans
// are healed; every legal shape round-trips byte-identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore, coreToAnthropic } from "../src/wire/anthropic.js";
import type { AnthropicWireMessage } from "../src/wire/anthropic.js";

const use = (id: string) => ({
  type: "server_tool_use",
  id,
  name: "advisor",
  input: {},
});
const res = (id: string) => ({
  type: "advisor_tool_result",
  tool_use_id: id,
  content: { type: "advisor_result", text: "advice" },
});
const wire = (messages: unknown[]) => messages as AnthropicWireMessage[];
const roundTrip = (messages: AnthropicWireMessage[]) => {
  const { msgs, cacheControls } = anthropicToCore({
    model: "m",
    max_tokens: 1,
    messages,
  } as never);
  return { msgs, out: coreToAnthropic(msgs, cacheControls) };
};

test("legal server-tool exchanges round-trip byte-identical (negative rows)", () => {
  const messages = wire([
    { role: "user", content: [{ type: "text", text: "q1" }] },
    {
      role: "assistant",
      content: [
        use("srvtoolu_a"),
        res("srvtoolu_a"),
        { type: "text", text: "a1" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "q2" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "searching" },
        {
          type: "server_tool_use",
          id: "srvtoolu_w",
          name: "web_search",
          input: { query: "x" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_w",
          content: [],
        },
        { type: "text", text: "a2" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "q3" }] },
    // Open server call in the LAST message is legal client state — kept.
    { role: "assistant", content: [use("srvtoolu_open")] },
  ]);
  assert.deepEqual(roundTrip(messages).out, messages);
});

test("plain tool_use / tool_result pairs are never touched", () => {
  const messages = wire([
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
    },
  ]);
  assert.deepEqual(roundTrip(messages).out, messages);
});

test("result whose server_tool_use was folded away is dropped", () => {
  const messages = wire([
    { role: "user", content: [{ type: "text", text: "q1" }] },
    {
      role: "assistant",
      content: [
        use("srvtoolu_a"),
        res("srvtoolu_a"),
        { type: "text", text: "a1" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "q2" }] },
  ]);
  const { msgs } = roundTrip(messages);
  // Simulate a fold that covered only the server_tool_use block.
  const folded = msgs.filter(
    (m) =>
      !(m.rawAnthropicBlock as { type?: string } | undefined)?.type?.startsWith(
        "server_tool_use",
      ),
  );
  assert.equal(folded.length, msgs.length - 1);
  const out = coreToAnthropic(folded);
  assert.deepEqual(out[1], {
    role: "assistant",
    content: [{ type: "text", text: "a1" }],
  });
});

test("server_tool_use whose result was folded away is dropped (not in last message)", () => {
  const messages = wire([
    { role: "user", content: [{ type: "text", text: "q1" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "a0" },
        use("srvtoolu_a"),
        res("srvtoolu_a"),
      ],
    },
    { role: "user", content: [{ type: "text", text: "q2" }] },
  ]);
  const { msgs } = roundTrip(messages);
  const folded = msgs.filter(
    (m) =>
      (m.rawAnthropicBlock as { type?: string } | undefined)?.type !==
      "advisor_tool_result",
  );
  const out = coreToAnthropic(folded);
  assert.deepEqual(out[1], {
    role: "assistant",
    content: [{ type: "text", text: "a0" }],
  });
});

test("an assistant message emptied by the heal keeps role alternation via placeholder", () => {
  const messages = wire([
    { role: "user", content: [{ type: "text", text: "q1" }] },
    { role: "assistant", content: [use("srvtoolu_a"), res("srvtoolu_a")] },
    { role: "user", content: [{ type: "text", text: "q2" }] },
  ]);
  const { msgs } = roundTrip(messages);
  const folded = msgs.filter(
    (m) =>
      (m.rawAnthropicBlock as { type?: string } | undefined)?.type !==
      "server_tool_use",
  );
  const out = coreToAnthropic(folded);
  assert.equal(out.length, 3);
  assert.equal(out[1]!.role, "assistant");
  assert.deepEqual(out[1]!.content, [
    { type: "text", text: "(server tool exchange folded)" },
  ]);
});
