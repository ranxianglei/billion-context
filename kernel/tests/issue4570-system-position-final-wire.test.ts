import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coreToAnthropic,
  healAnthropicSystemPositions,
} from "../src/wire/anthropic.js";
import type {
  AnthropicSystemMessage,
  AnthropicWireMessage,
} from "../src/wire/anthropic.js";
import type { BiliMessage } from "../src/wire/bili-message.js";

// #4570: Anthropic's mid-conversation system rule has two halves, and
// production 400s hit both:
//   "role 'system' must precede an 'assistant' message or end the array"
//     — a legal trailing system left by coreToAnthropic, then host notes /
//       nudges / the retrieval note appended after it.
//   "role 'system' must follow a 'user' message or an 'assistant' message
//    ending in a server tool result"
//     — a fold (compress-loop re-request) removes the user turn before a
//       never-fold sidecar system, leaving it right after an assistant.
// The heal must leave the FINAL wire array obeying both halves without
// dropping user-visible content.

function sys(content: AnthropicSystemMessage["content"]): AnthropicSystemMessage {
  return { role: "system", content };
}

function isDirectiveOnly(m: AnthropicWireMessage): boolean {
  return (
    m.role === "system" &&
    Array.isArray(m.content) &&
    m.content.length === 0 &&
    (m as { output_config?: unknown }).output_config != null
  );
}

function legalPredecessor(m: AnthropicWireMessage | undefined): boolean {
  if (!m) return false;
  if (m.role === "user") return true;
  if (m.role !== "assistant" || !Array.isArray(m.content)) return false;
  const last = m.content[m.content.length - 1] as { type?: unknown } | undefined;
  return (
    typeof last?.type === "string" &&
    last.type !== "tool_result" &&
    last.type.endsWith("_tool_result")
  );
}

/** Every violation of either half of the rule, as Anthropic reports it. */
function violations(messages: AnthropicWireMessage[]): string[] {
  const bad: string[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "system" || isDirectiveOnly(m)) return;
    let p = i - 1;
    while (p >= 0 && messages[p]!.role === "system") p--;
    let k = i + 1;
    while (k < messages.length && messages[k]!.role === "system") k++;
    if (!legalPredecessor(messages[p])) bad.push(`messages.${i}: must follow`);
    const next = messages[k];
    if (next && next.role !== "assistant") bad.push(`messages.${i}: must precede`);
  });
  return bad;
}

function texts(messages: AnthropicWireMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") out.push(m.content);
    else for (const b of m.content as { type?: string; text?: string }[]) if (b.type === "text" && b.text) out.push(b.text);
  }
  return out;
}

const user = (id: string, text: string): BiliMessage => ({ id, role: "user", contentType: "text", text });
const assistant = (id: string, text: string): BiliMessage => ({ id, role: "assistant", contentType: "text", text });
const sidecar = (id: string, raw: AnthropicSystemMessage): BiliMessage => ({
  id,
  role: "system",
  contentType: "text",
  text: texts([raw]).join("\n"),
  rawAnthropicMessage: raw,
});

const TOOL_ADDITION = {
  type: "tool_addition",
  tool: { type: "tool_definition", definition: { name: "t", input_schema: { type: "object" } } },
};

// --- "must precede": the #4570 nudge-turn shape ----------------------------

test("#4570 shape: a note appended after a trailing system is healed on the final array", () => {
  const wire = coreToAnthropic([
    user("u1", "q1"),
    assistant("a1", "a1"),
    user("u2", "q2"),
    sidecar("s1", sys([{ type: "text", text: "<system-reminder>env</system-reminder>" }])),
  ]);
  assert.deepEqual(violations(wire), [], "coreToAnthropic output is legal on its own");
  const sent = healAnthropicSystemPositions([
    ...wire,
    { role: "user", content: "[ACP] nudge: compress now" },
    { role: "user", content: "[retrieval] pending note" },
  ]);
  assert.deepEqual(violations(sent), []);
  assert.deepEqual(texts(sent), ["q1", "a1", "q2", "<system-reminder>env</system-reminder>", "[ACP] nudge: compress now", "[retrieval] pending note"]);
  assert.equal(sent.length, 6);
});

test("#4570 shape: a trailing tool-delta run before a note keeps the text and drops tool deltas", () => {
  const sent = healAnthropicSystemPositions([
    { role: "user", content: "q" },
    sys([{ type: "text", text: "tools updated" }, TOOL_ADDITION] as never),
    sys([TOOL_ADDITION] as never),
    { role: "user", content: "nudge" },
  ]);
  assert.deepEqual(violations(sent), []);
  assert.deepEqual(texts(sent), ["q", "tools updated", "nudge"]);
  assert.ok(!JSON.stringify(sent).includes("tool_addition"));
});

// --- "must follow": a system right after an assistant -----------------------

test("must-follow shape: a sidecar system between two assistants is re-voiced", () => {
  const wire = coreToAnthropic([
    user("u1", "q1"),
    assistant("a1", "a1"),
    sidecar("s1", sys([{ type: "text", text: "mid-session update" }])),
    assistant("a2", "a2"),
    user("u2", "q2"),
  ]);
  assert.deepEqual(violations(wire), []);
  assert.deepEqual(texts(wire), ["q1", "a1", "mid-session update", "a2", "q2"]);
});

test("must-follow shape: a system after an assistant moves past the next user turn", () => {
  const sent = healAnthropicSystemPositions([
    { role: "user", content: "q1" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
    sys([{ type: "text", text: "tools updated" }, TOOL_ADDITION] as never),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ]);
  assert.deepEqual(violations(sent), []);
  assert.equal(sent[3]!.role, "system", "moved whole, tool deltas intact");
  assert.ok(JSON.stringify(sent[3]).includes("tool_addition"));
  assert.equal((sent[2]!.content as { type: string }[])[0]!.type, "tool_result", "tool_result stays right after tool_use");
});

test("must-follow shape: a run of systems after an assistant moves in order", () => {
  const sent = healAnthropicSystemPositions([
    { role: "user", content: "q1" },
    { role: "assistant", content: [{ type: "text", text: "a1" }] },
    sys("first"),
    sys("second"),
    { role: "user", content: "q2" },
  ]);
  assert.deepEqual(violations(sent), []);
  assert.deepEqual(texts(sent), ["q1", "a1", "q2", "first", "second"]);
});

test("must-follow shape: a trailing system after an assistant and a leading system are re-voiced", () => {
  const trailing = healAnthropicSystemPositions([
    { role: "user", content: "q1" },
    { role: "assistant", content: [{ type: "text", text: "a1" }] },
    sys("late update"),
  ]);
  assert.deepEqual(violations(trailing), []);
  assert.deepEqual(texts(trailing), ["q1", "a1", "late update"]);
  const leading = coreToAnthropic([
    sidecar("s0", sys("early")),
    assistant("a0", "ok"),
    user("u1", "q1"),
  ]);
  assert.deepEqual(violations(leading), []);
  assert.deepEqual(texts(leading), ["early", "ok", "q1"]);
});

// --- negative: legal layouts stay verbatim ----------------------------------

test("legal layouts round-trip verbatim", () => {
  const serverResult: AnthropicWireMessage = {
    role: "assistant",
    content: [
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
    ] as never,
  };
  const directive = { role: "system", content: [], output_config: { effort: "high" } } as unknown as AnthropicWireMessage;
  const u = (t: string): AnthropicWireMessage => ({ role: "user", content: t });
  const a = (t: string): AnthropicWireMessage => ({ role: "assistant", content: [{ type: "text", text: t }] });
  const layouts: AnthropicWireMessage[][] = [
    [u("q"), sys("s"), a("a"), u("q2")],
    [u("q"), a("a"), u("q2"), sys("s")],
    [u("q"), sys("s1"), sys("s2"), a("a")],
    [u("q"), directive, sys("s"), a("a")],
    [u("q"), a("a"), directive, a("a2"), u("q2")],
    [u("q"), serverResult, sys("s"), a("a")],
  ];
  for (const layout of layouts) {
    assert.deepEqual(violations(layout), []);
    assert.deepEqual(healAnthropicSystemPositions(layout), layout);
  }
});
