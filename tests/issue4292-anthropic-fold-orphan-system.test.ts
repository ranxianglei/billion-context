import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicToCore,
  coreToAnthropic,
  type AnthropicBlock,
  type AnthropicSystemMessage,
  type AnthropicWireMessage,
} from "acp-kernel/wire";
import type { BiliMessage } from "acp-kernel/wire";

// #4292 → #4457: a compression fold can cover the assistant messages that
// legitimized a client mid-conversation system. coreToAnthropic ends with a
// POSITION-based backstop: any non-directive system whose first non-system
// follower is neither an assistant nor the array end is healed — re-voiced
// to user with tool_addition/tool_removal blocks stripped (WC-022) and
// dropped when nothing remains. The fold layer keeps these sidecar systems
// out of folds (kernel protected.ts never-fold carve — their tool deltas
// are functional), so folds still orphan them; the backstop also heals
// sessions folded by older builds and positionally-illegal client input.
// Legal layouts
// (assistant next, array end, directive-only anywhere) stay byte-exact.

/** Indices of system entries violating the Anthropic position rule. */
function orphanSystems(messages: AnthropicWireMessage[]): number[] {
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

const CLIENT_SYSTEM: AnthropicSystemMessage = {
  role: "system",
  content: [
    {
      type: "text",
      text: 'Updated system prompt section "tools":\n<tools>…</tools>',
    },
    // tool_addition is not in the typed AnthropicBlock union (it is a
    // system-messages-beta block); the fixture keeps it structurally real.
    {
      type: "tool_addition",
      tool: {
        type: "tool_definition",
        definition: {
          name: "subagent",
          input_schema: { type: "object", properties: {} },
        },
      },
    } as unknown as AnthropicBlock,
  ],
};

const ANCHOR_TEXT = "[Compressed conversation section] early turns folded";

// Pre-fold history: the client system was immediately followed by an
// assistant, so the verbatim re-emission was legal.
const preFoldWire = [
  { role: "user", content: [{ type: "text", text: "enable subagents" }] },
  CLIENT_SYSTEM,
  { role: "assistant", content: [{ type: "text", text: "subagents enabled" }] },
  { role: "user", content: [{ type: "text", text: "run one" }] },
  { role: "assistant", content: [{ type: "text", text: "done" }] },
] as AnthropicWireMessage[];

/** Post-fold core list: the fold covered everything after the client system;
 *  the kernel-rendered anchor (no sidecar) sits at the earliest covered
 *  position — immediately after the orphaned system. */
function postFoldCore(): BiliMessage[] {
  const { msgs } = anthropicToCore({ messages: preFoldWire } as never);
  return [
    msgs[0] as BiliMessage, // user: "enable subagents"
    msgs[1] as BiliMessage, // sidecar system (CLIENT_SYSTEM)
    { id: "anchor", role: "system", contentType: "text", text: ANCHOR_TEXT },
    { id: "tail", role: "user", contentType: "text", text: "next question" },
  ];
}

test("pre-fold wire round-trips byte-identical (no fold, no re-voicing)", () => {
  const { msgs } = anthropicToCore({ messages: preFoldWire } as never);
  const rebuilt = coreToAnthropic(msgs as never);
  assert.deepEqual(rebuilt, preFoldWire);
  assert.deepEqual(orphanSystems(rebuilt), []);
});

test("without the anchor adjacent, the orphaned system heals anyway (#4457 backstop)", () => {
  // The fold covered a DIFFERENT region — no anchor adjacency exists. The
  // #4457 position-based backstop does not need the fold signature: any
  // system whose follower is neither an assistant nor the array end is
  // healed, so this previously-fatal shape survives too.
  const cores = postFoldCore().filter((m) => m.id !== "anchor");
  const rebuilt = coreToAnthropic(cores as never);
  assert.deepEqual(orphanSystems(rebuilt), []);
  assert.equal(rebuilt[1]!.role, "user");
  assert.deepEqual(rebuilt[1]!.content, [
    {
      type: "text",
      text: 'Updated system prompt section "tools":\n<tools>…</tools>',
    },
  ]);
});

test("post-fold: the backstop re-voices the orphan, tool blocks stripped (#4457)", () => {
  const cores = postFoldCore();
  const rebuilt = coreToAnthropic(cores as never);
  assert.deepEqual(
    orphanSystems(rebuilt),
    [],
    "no illegal-position system remains after the fold guard",
  );
  // The orphaned system became a user message: text blocks byte-identical,
  // tool_addition stripped (WC-022 forbids it outside role:system).
  assert.equal(rebuilt[1]!.role, "user");
  assert.deepEqual(rebuilt[1]!.content, [
    {
      type: "text",
      text: 'Updated system prompt section "tools":\n<tools>…</tools>',
    },
  ]);
  // Anchor + tail keep their user mapping with verbatim text.
  assert.deepEqual(rebuilt[2], {
    role: "user",
    content: [
      { type: "text", text: ANCHOR_TEXT },
      { type: "text", text: "next question" },
    ],
  });
  // The session-stored sidecar object was not mutated by the re-voicing.
  assert.equal(
    (cores[1]!.rawAnthropicMessage as AnthropicSystemMessage).role,
    "system",
  );
  assert.equal(
    (cores[1]!.rawAnthropicMessage as AnthropicSystemMessage).content.length,
    2,
    "the stored sidecar keeps its tool block for decompress",
  );
});

test("post-fold with a surviving assistant after the anchor stays fully legal", () => {
  const cores = postFoldCore();
  cores.push({
    id: "a2",
    role: "assistant",
    contentType: "text",
    text: "final answer",
  });
  const rebuilt = coreToAnthropic(cores as never);
  assert.deepEqual(orphanSystems(rebuilt), []);
  assert.equal(rebuilt[1]!.role, "user");
  assert.deepEqual(rebuilt[3], {
    role: "assistant",
    content: [{ type: "text", text: "final answer" }],
  });
});

test("Pi-style trailing system run (no anchor) stays verbatim end-to-end", () => {
  // Pi emits [.., system(tool delta), system(output_config)] at the end of
  // the array; re-voicing those would resurrect the #3410-era rejection
  // ("tool_addition blocks are only permitted within role:system messages").
  const wire = [
    { role: "user", content: [{ type: "text", text: "enable subagents" }] },
    CLIENT_SYSTEM,
    { role: "system", content: [], output_config: { effort: "medium" } },
  ] as AnthropicWireMessage[];
  const { msgs } = anthropicToCore({ messages: wire } as never);
  const rebuilt = coreToAnthropic(msgs as never);
  assert.deepEqual(rebuilt, wire);
});
