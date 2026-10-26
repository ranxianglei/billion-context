import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore, coreToAnthropic } from "../src/wire/anthropic.js";
import type {
  AnthropicSystemMessage,
  AnthropicWireMessage,
} from "../src/wire/anthropic.js";
import type { BiliMessage } from "../src/wire/bili-message.js";

// #4292/#4457: a fold that covers the assistant messages legitimizing a
// client mid-conversation system message leaves it in a wire position
// Anthropic rejects ("role 'system' must precede an 'assistant' message or
// end the array"), 400ing the session forever. The fold layer keeps these
// sidecar systems out of folds (their tool deltas are functional — see
// protected.ts), so orphans still arise; coreToAnthropic therefore ends
// with a POSITION-based backstop: any non-directive
// system whose first non-system follower is neither an assistant nor the
// array end is healed — re-voiced to user with tool_update blocks stripped
// (WC-022), dropped when nothing remains. Legal layouts (assistant next,
// array end, trailing runs, directive-only anywhere) round-trip verbatim.

function sys(content: AnthropicSystemMessage["content"]): AnthropicSystemMessage {
  return { role: "system", content };
}

/** Indices of system entries that violate the Anthropic position rule
 *  (neither last nor immediately followed by an assistant message). */
function orphans(messages: AnthropicWireMessage[]): number[] {
  const bad: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "system") continue;
    const next = messages[i + 1];
    if (!next || next.role === "assistant") continue;
    bad.push(i);
  }
  return bad;
}

function roundTrip(body: { messages: AnthropicWireMessage[] }) {
  return coreToAnthropic(anthropicToCore(body as never).msgs as never);
}

/** Fold-anchor core: kernel-rendered summary, NO rawAnthropicMessage. */
function anchor(id: string, text: string): BiliMessage {
  return { id, role: "system", contentType: "text", text };
}

const TOOL_ADDITION = {
  type: "tool_addition",
  tool: {
    type: "tool_definition",
    definition: { name: "t", input_schema: { type: "object" } },
  },
};

// --- positive: the fold signature re-voices --------------------------------

test("#4292 shape: sidecar system immediately before the anchor is re-voiced", () => {
  const S = sys([{ type: "text", text: "tools updated mid-session" }]);
  const { msgs } = anthropicToCore({
    messages: [
      { role: "user", content: "q1" },
      S,
      { role: "assistant", content: [{ type: "text", text: "gone" }] },
    ],
  } as never);
  // The fold covered the assistant; the anchor took its earliest position.
  const rebuilt = coreToAnthropic([
    msgs[0] as BiliMessage,
    msgs[1] as BiliMessage,
    anchor("a1", "[Compressed conversation section] gone turn"),
    { id: "t1", role: "user", contentType: "text", text: "next question" },
  ] as never);
  assert.deepEqual(orphans(rebuilt), []);
  assert.equal(rebuilt[1]!.role, "user");
  // Only the role changed — content blocks stay byte-identical.
  assert.deepEqual(rebuilt[1]!.content, S.content);
  // Anchor + tail keep their user mapping, text verbatim.
  assert.deepEqual(rebuilt[2], {
    role: "user",
    content: [
      { type: "text", text: "[Compressed conversation section] gone turn" },
      { type: "text", text: "next question" },
    ],
  });
});

test("consecutive orphaned systems before the anchor heal as a whole run", () => {
  const S1 = sys([{ type: "text", text: "first" }]);
  const S2 = sys([
    { type: "text", text: "second" },
    TOOL_ADDITION,
  ]);
  const rebuilt = coreToAnthropic([
    { id: "u0", role: "user", contentType: "text", text: "q1" },
    { id: "s1", role: "system", contentType: "text", text: "first", rawAnthropicMessage: S1 },
    { id: "s2", role: "system", contentType: "text", text: "second", rawAnthropicMessage: S2 },
    anchor("a1", "[Compressed conversation section] folded"),
    { id: "t1", role: "user", contentType: "text", text: "next" },
  ] as never);
  assert.deepEqual(orphans(rebuilt), []);
  assert.equal(rebuilt[1]!.role, "user");
  assert.deepEqual(rebuilt[1]!.content, S1.content);
  assert.equal(rebuilt[2]!.role, "user");
  // #4457/WC-022: tool_update blocks never survive a demotion to user —
  // the text block alone is re-voiced, byte-identical.
  assert.deepEqual(rebuilt[2]!.content, [{ type: "text", text: "second" }]);
  assert.deepEqual(rebuilt[3], {
    role: "user",
    content: [
      { type: "text", text: "[Compressed conversation section] folded" },
      { type: "text", text: "next" },
    ],
  });
});

test("re-voicing substitutes fresh objects; the stored sidecar is never mutated", () => {
  const S = sys([{ type: "text", text: "delta" }]);
  const sidecarCore: BiliMessage = {
    id: "s1",
    role: "system",
    contentType: "text",
    text: "delta",
    rawAnthropicMessage: S,
  };
  const rebuilt = coreToAnthropic([
    sidecarCore,
    anchor("a1", "[Compressed conversation section] x"),
  ] as never);
  assert.equal(rebuilt[0]!.role, "user");
  assert.equal(S.role, "system");
  assert.equal(sidecarCore.rawAnthropicMessage, S);
});

// --- negative: everything else emits verbatim ------------------------------

test("Pi shape: system run at array end (no anchor after) round-trips verbatim", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    sys([{ type: "text", text: "tools" }, TOOL_ADDITION]),
    sys([{ type: "text", text: "trailing effort" }]),
  ] as AnthropicWireMessage[];
  assert.deepEqual(roundTrip({ messages }), messages);
});

test("sidecar system followed by a plain user message is healed (#4457 shape)", () => {
  // [user, system, user] is exactly the #4457 wire: Anthropic 400s it
  // ("system must precede an assistant message or end the array") — the
  // backstop re-voices it to user instead of forwarding a dead request.
  const messages = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    sys([{ type: "text", text: "between user turns" }]),
    { role: "user", content: [{ type: "text", text: "b" }] },
  ] as AnthropicWireMessage[];
  const rebuilt = coreToAnthropic(anthropicToCore({ messages } as never).msgs as never);
  assert.deepEqual(orphans(rebuilt), []);
  assert.deepEqual(rebuilt, [
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "user", content: [{ type: "text", text: "between user turns" }] },
    { role: "user", content: [{ type: "text", text: "b" }] },
  ]);
});

test("sidecar system immediately followed by an assistant stays verbatim", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    sys([{ type: "text", text: "policy update" }]),
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ] as AnthropicWireMessage[];
  assert.deepEqual(roundTrip({ messages }), messages);
});

test("sidecar system at array end stays verbatim", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    sys([{ type: "text", text: "# Environment\n - Platform: linux" }]),
  ] as AnthropicWireMessage[];
  assert.deepEqual(roundTrip({ messages }), messages);
});

test("directive-only system adjacent to the anchor stays system (legal anywhere)", () => {
  // Re-voicing a pure effort marker would mint an empty-content user that 400s alone.
  const dir = { role: "system", content: [], output_config: { effort: "high" } } as unknown as AnthropicSystemMessage;
  const rebuilt = coreToAnthropic([
    { id: "u0", role: "user", contentType: "text", text: "q1" },
    { id: "s1", role: "system", contentType: "text", text: "[effort]", rawAnthropicMessage: dir },
    anchor("a1", "[Compressed conversation section] x"),
  ] as never);
  assert.equal(rebuilt[1]!.role, "system");
  assert.deepEqual(rebuilt[1]!.content, []);
  assert.equal(rebuilt[2]!.role, "user");
});

test("system separated from a later anchor by a user core is healed too", () => {
  // #4457/S2: the orphaning fold's anchor lands BEFORE the surviving
  // system — no anchor adjacency exists, only the position rule catches it.
  const rebuilt = coreToAnthropic([
    { id: "u0", role: "user", contentType: "text", text: "q1" },
    { id: "s1", role: "system", contentType: "text", text: "mid", rawAnthropicMessage: sys("mid") },
    { id: "u1", role: "user", contentType: "text", text: "gap" },
    anchor("a1", "[Compressed conversation section] x"),
  ] as never);
  assert.deepEqual(orphans(rebuilt), []);
  assert.equal(rebuilt[1]!.role, "user");
  assert.equal(rebuilt[1]!.content, "mid");
});

test("sidecar system before an assistant and a later anchor stays verbatim", () => {
  const rebuilt = coreToAnthropic([
    { id: "s1", role: "system", contentType: "text", text: "mid", rawAnthropicMessage: sys("mid") },
    { id: "a0", role: "assistant", contentType: "text", text: "ok" },
    anchor("a1", "[Compressed conversation section] x"),
  ] as never);
  assert.equal(rebuilt[0]!.role, "system");
});

test("anchor with no preceding systems re-voices nothing", () => {
  assert.deepEqual(
    coreToAnthropic([anchor("a1", "[Compressed conversation section] x")] as never),
    [
      {
        role: "user",
        content: [{ type: "text", text: "[Compressed conversation section] x" }],
      },
    ],
  );
  const rebuilt = coreToAnthropic([
    { id: "u0", role: "user", contentType: "text", text: "q1" },
    anchor("a1", "[Compressed conversation section] x"),
  ] as never);
  assert.deepEqual(rebuilt, [
    {
      role: "user",
      content: [
        { type: "text", text: "q1" },
        { type: "text", text: "[Compressed conversation section] x" },
      ],
    },
  ]);
});

test("edge arrays are unaffected: empty, user-only, assistant-only", () => {
  assert.deepEqual(coreToAnthropic([]), []);
  assert.deepEqual(
    coreToAnthropic([
      { id: "u1", role: "user", contentType: "text", text: "hi" },
    ] as never),
    [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  );
  assert.deepEqual(
    coreToAnthropic([
      { id: "a1", role: "assistant", contentType: "text", text: "hey" },
    ] as never),
    [{ role: "assistant", content: [{ type: "text", text: "hey" }] }],
  );
});

// --- #4457 backstop edges ---------------------------------------------------

test("#4457: tool-block-only orphaned system is dropped, not re-voiced empty", () => {
  const S = sys([TOOL_ADDITION]);
  const rebuilt = coreToAnthropic([
    { id: "u0", role: "user", contentType: "text", text: "q1" },
    { id: "s1", role: "system", contentType: "text", text: "[tool_addition]", rawAnthropicMessage: S },
    { id: "u1", role: "user", contentType: "text", text: "after" },
  ] as never);
  assert.deepEqual(orphans(rebuilt), []);
  // The demotion drops the entry entirely (nothing re-voicable remains);
  // the neighbouring user turns stay separate entries — the backstop
  // never merges.
  assert.deepEqual(rebuilt, [
    { role: "user", content: [{ type: "text", text: "q1" }] },
    { role: "user", content: [{ type: "text", text: "after" }] },
  ]);
});

test("#4457: string-content orphaned system re-voices with the string intact", () => {
  const S = sys("policy delta");
  const rebuilt = coreToAnthropic([
    { id: "u0", role: "user", contentType: "text", text: "q1" },
    { id: "s1", role: "system", contentType: "text", text: "policy delta", rawAnthropicMessage: S },
    { id: "u1", role: "user", contentType: "text", text: "after" },
  ] as never);
  assert.deepEqual(rebuilt[1], { role: "user", content: "policy delta" });
});

test("#4457: consecutive system run is judged by its first non-system follower", () => {
  // Pi's trailing tool-delta + effort-marker run at array end is LEGAL —
  // byte-exact verbatim even though the first system's immediate next is
  // another system, not an assistant.
  const messages = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    sys([{ type: "text", text: "tools" }, TOOL_ADDITION]),
    sys([{ type: "text", text: "trailing effort" }]),
  ] as AnthropicWireMessage[];
  assert.deepEqual(roundTrip({ messages }), messages);
  // The same run followed by a user turn is illegal as a whole — every
  // member is healed (tool blocks stripped, text kept).
  const illegal = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    sys([{ type: "text", text: "tools" }, TOOL_ADDITION]),
    sys([{ type: "text", text: "trailing effort" }]),
    { role: "user", content: [{ type: "text", text: "b" }] },
  ] as AnthropicWireMessage[];
  const rebuilt = coreToAnthropic(anthropicToCore({ messages: illegal } as never).msgs as never);
  assert.deepEqual(orphans(rebuilt), []);
  assert.equal(rebuilt[1]!.role, "user");
  assert.deepEqual(rebuilt[1]!.content, [{ type: "text", text: "tools" }]);
  assert.equal(rebuilt[2]!.role, "user");
  assert.deepEqual(rebuilt[2]!.content, [{ type: "text", text: "trailing effort" }]);
});
