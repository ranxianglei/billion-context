import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore, coreToAnthropic } from "../src/wire/anthropic.js";
import { deriveCanonicalMessageId } from "../src/wire/identity.js";
import {
  isPlainTextSystemMessage,
  hasMediaPayload,
  hasUnrecoverableMediaPayload,
} from "../src/protected.js";

// Pi (supportsMidConvoToolChanges) declares tools added mid-session as
// `tool_addition` blocks inside mid-conversation `role:"system"` messages,
// and emits empty system messages carrying message-level `output_config`.
// anthropicToCore used to split those into the user/assistant block stream
// and coreToAnthropic re-emitted them as `user` — on 0.1.202 the blocks were
// dropped (tools never reached the model); after #3410 they survived but
// upstream rejected them: "'tool_addition'/'tool_removal' blocks are only
// permitted within `role: \"system\"` messages".

const TOOL_ADDITION = {
  type: "tool_addition",
  tool: {
    type: "tool_definition",
    definition: {
      name: "subagent",
      description: "Delegate to subagents",
      input_schema: { type: "object", properties: {} },
    },
  },
};

const EFFORT = {
  role: "system",
  content: [],
  output_config: { effort: "medium" },
};

const TOOLS_DELTA = {
  role: "system",
  content: [
    {
      type: "text",
      text: 'Updated system prompt section "tools":\n<tools>…</tools>',
    },
    TOOL_ADDITION,
  ],
};

function piBody() {
  return {
    messages: [
      { role: "user", content: [{ type: "text", text: "enable subagents" }] },
      EFFORT,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "subagents_enable",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "Enabled: subagent.",
          },
        ],
      },
      TOOLS_DELTA,
      EFFORT,
    ],
  };
}

test("round-trips pi mid-conversation system messages byte-exact", () => {
  const body = piBody();
  const rebuilt = coreToAnthropic(anthropicToCore(body as never).msgs as never);
  assert.deepEqual(rebuilt, body.messages);
});

test("one core per system wire message, role system, wireIndex kept", () => {
  const msgs = anthropicToCore(piBody() as never).msgs as {
    [k: string]: unknown;
  }[];
  const systems = msgs.filter((m) => m.rawAnthropicMessage !== undefined);
  assert.deepEqual(
    systems.map((m) => [m.role, m.wireIndex]),
    [
      ["system", 1],
      ["system", 4],
      ["system", 5],
    ],
  );
  assert.equal(systems[0]!.text, "[system]");
  assert.match(
    systems[1]!.text as string,
    /^Updated system prompt section "tools":/,
  );
  assert.match(systems[1]!.text as string, /\[tool_addition\]$/);
});

test("system message between two user turns heals to user (#4457)", () => {
  // [user, system, user] is positionally illegal on the anthropic wire —
  // the backstop re-voices it (tool blocks stripped per WC-022) instead of
  // forwarding a request Anthropic guarantees to 400.
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "a" }] },
      TOOLS_DELTA,
      { role: "user", content: [{ type: "text", text: "b" }] },
    ],
  };
  const rebuilt = coreToAnthropic(anthropicToCore(body as never).msgs as never);
  assert.deepEqual(rebuilt, [
    { role: "user", content: [{ type: "text", text: "a" }] },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: 'Updated system prompt section "tools":\n<tools>…</tools>',
        },
      ],
    },
    { role: "user", content: [{ type: "text", text: "b" }] },
  ]);
});

test("string-content system message round-trips", () => {
  const body = {
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: "be brief" },
    ],
  };
  const rebuilt = coreToAnthropic(anthropicToCore(body as never).msgs as never);
  assert.deepEqual(rebuilt[1], { role: "system", content: "be brief" });
});

test("kernel-synthesized system cores (no sidecar) still map to user", () => {
  const rebuilt = coreToAnthropic([
    {
      id: "s1",
      role: "system",
      contentType: "text",
      text: "[Compressed conversation section] x",
    },
  ] as never);
  assert.deepEqual(rebuilt, [
    {
      role: "user",
      content: [{ type: "text", text: "[Compressed conversation section] x" }],
    },
  ]);
});

// Claude Code (2.1.300, tests/fixtures/vertex-anthropic) appends a plain-text
// environment note as a trailing system message — and on that fixture it
// carries the request's ONLY message-level cache_control.
const CC_ENV = {
  role: "system",
  content: [
    {
      type: "text",
      text: "# Environment\n - Platform: linux",
      cache_control: { type: "ephemeral" },
    },
  ],
};

function ccBody() {
  return {
    messages: [
      { role: "user", content: [{ type: "text", text: "say pong" }] },
      CC_ENV,
    ],
  };
}

test("plain-text system message: legacy id, foldable, mark harvested, byte-exact", () => {
  const { msgs, cacheControls } = anthropicToCore(ccBody() as never);
  const sys = msgs[1]!;
  // Same id the pre-fix per-block split minted — zero ref churn on upgrade.
  assert.equal(
    sys.id,
    deriveCanonicalMessageId("system", "text", CC_ENV.content[0]!.text),
  );
  assert.equal(hasUnrecoverableMediaPayload(sys), false);
  assert.equal(isPlainTextSystemMessage(CC_ENV), true);
  // Client-managed caching detection (#1637) reads this map.
  assert.deepEqual(cacheControls.get(sys.id), { type: "ephemeral" });
  assert.deepEqual(coreToAnthropic(msgs, cacheControls)[1], CC_ENV);
});

test("kernel-rewritten plain-text system message rebuilds from core text", () => {
  const { msgs, cacheControls } = anthropicToCore(ccBody() as never);
  const truncated = msgs.map((m, i) =>
    i === 1 ? { ...m, text: "# Environment [truncated]" } : m,
  );
  assert.deepEqual(coreToAnthropic(truncated, cacheControls)[1], {
    role: "system",
    content: [
      {
        type: "text",
        text: "# Environment [truncated]",
        cache_control: { type: "ephemeral" },
      },
    ],
  });
});

test("host-stamped mark lands on the last block; client marks stay put", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }, TOOLS_DELTA, EFFORT],
  };
  const { msgs } = anthropicToCore(body as never);
  const marks = new Map<string, unknown>([
    [msgs[1]!.id, { type: "ephemeral" }],
    [msgs[2]!.id, { type: "ephemeral" }],
  ]);
  const rebuilt = coreToAnthropic(msgs, marks) as {
    content: { cache_control?: unknown }[];
  }[];
  assert.deepEqual(rebuilt[1]!.content[1]!.cache_control, {
    type: "ephemeral",
  });
  assert.equal(rebuilt[1]!.content[0]!.cache_control, undefined);
  // Nothing to carry a mark: the empty output_config message stays verbatim.
  assert.deepEqual(rebuilt[2], EFFORT);
  // The client's own mark is never duplicated or moved.
  const pre = {
    ...TOOLS_DELTA,
    content: [
      { ...TOOLS_DELTA.content[0]!, cache_control: { type: "ephemeral" } },
      TOOL_ADDITION,
    ],
  };
  const flat = anthropicToCore({ messages: [pre] } as never);
  assert.deepEqual(coreToAnthropic(flat.msgs, flat.cacheControls)[0], pre);
});

test("control-plane system cores are never folded; other cores still are", () => {
  const msgs = anthropicToCore(piBody() as never).msgs;
  for (const m of msgs) {
    const sidecar = (m as { rawAnthropicMessage?: unknown })
      .rawAnthropicMessage;
    assert.equal(hasUnrecoverableMediaPayload(m), sidecar !== undefined, m.id);
  }
  assert.equal(hasMediaPayload(msgs[0]!), false);
});

test("ids are deterministic; identical system messages stay distinct", () => {
  const ids = () => anthropicToCore(piBody() as never).msgs.map((m) => m.id);
  assert.deepEqual(ids(), ids());
  const msgs = anthropicToCore(piBody() as never).msgs as {
    [k: string]: unknown;
  }[];
  const effortIds = msgs.filter((m) => m.text === "[system]").map((m) => m.id);
  assert.equal(effortIds.length, 2);
  assert.notEqual(effortIds[0], effortIds[1]);
});

test("parse is a structural fixed point over rebuild", () => {
  const first = anthropicToCore(piBody() as never).msgs;
  const rebuilt = coreToAnthropic(first as never);
  const second = anthropicToCore({ messages: rebuilt } as never).msgs;
  assert.deepEqual(second, first);
});
