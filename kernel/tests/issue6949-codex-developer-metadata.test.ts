import { test } from "node:test";
import assert from "node:assert/strict";
import { responsesToCore, coreToResponses } from "../src/wire/responses.js";
import type { ResponsesRequestBody } from "../src/wire/responses.js";
import { hasUnrecoverableMediaPayload } from "../src/protected.js";
import { assignRefs, emptyRefMap, BLOCKED_REF } from "../src/refs.js";
import type { CoreMessage } from "../src/types.js";

// #6949: Codex Desktop stamps mid-history developer items with top-level
// `id` + `internal_chat_message_metadata_passthrough` (per-message
// bookkeeping: turn_id, content_item_kinds, provenance). The #4166
// plain-text check only allowed type/role/content, so those plain-text
// items were classified as unrecoverable → BLOCKED ref → permanently
// un-foldable, and their BLOCKED rows poisoned the acp_status range view.
// The fix admits the two known-harmless keys (strict shape checks); every
// other unknown top-level key still pins.

const METADATA = {
  turn_id: "turn_example",
  content_item_kinds: [
    "additional_content.codex_apps_open_page_instructions",
  ],
  content_item_metadata: [{ provenance: { type: "harness", hook: false } }],
} as const;

function midSystemCore(input: ResponsesRequestBody["input"]) {
  const flat = responsesToCore({ model: "m", input } as ResponsesRequestBody);
  const mid = flat.msgs.find((m) => m.role === "system");
  assert.ok(mid, "mid-history item must become a positioned sidecar core");
  return { flat, mid };
}

test("#6949 fixed: developer item with id + metadata passthrough folds (was BLOCKED)", () => {
  const { mid } = midSystemCore([
    { type: "message", role: "user", content: "turn 1" },
    {
      type: "message",
      id: "msg_example",
      role: "developer",
      content: [
        {
          type: "input_text",
          text: "<codex_apps_open_page_instructions>page rules</codex_apps_open_page_instructions>",
        },
      ],
      internal_chat_message_metadata_passthrough: METADATA,
    },
    { type: "message", role: "user", content: "turn 2" },
  ]);
  assert.equal(mid.originalRole, "developer");
  assert.equal(hasUnrecoverableMediaPayload(mid), false);
});

test("#6949 fixed: string-content variant with both fields folds", () => {
  const { mid } = midSystemCore([
    { type: "message", role: "user", content: "q" },
    {
      type: "message",
      id: "msg_example",
      role: "developer",
      content: "time context",
      internal_chat_message_metadata_passthrough: METADATA,
    },
  ]);
  assert.equal(hasUnrecoverableMediaPayload(mid), false);
});

test("#6949: id alone (standard item id) does not pin", () => {
  const { mid } = midSystemCore([
    { type: "message", role: "user", content: "q" },
    {
      type: "message",
      id: "msg_example",
      role: "developer",
      content: "plain policy text",
    },
  ]);
  assert.equal(hasUnrecoverableMediaPayload(mid), false);
});

test("#6949 negative: any OTHER unknown top-level key still pins", () => {
  const { mid } = midSystemCore([
    { type: "message", role: "user", content: "q" },
    {
      type: "message",
      role: "developer",
      content: "plain policy text",
      some_future_field: { structural: true },
    } as never,
  ]);
  assert.equal(hasUnrecoverableMediaPayload(mid), true);
});

test("#6949 negative: wrong value shapes still pin", () => {
  const nonStringId = midSystemCore([
    { type: "message", role: "user", content: "q" },
    {
      type: "message",
      id: 42,
      role: "developer",
      content: "plain policy text",
    } as never,
  ]).mid;
  assert.equal(hasUnrecoverableMediaPayload(nonStringId), true);

  const stringMetadata = midSystemCore([
    { type: "message", role: "user", content: "q" },
    {
      type: "message",
      role: "developer",
      content: "plain policy text",
      internal_chat_message_metadata_passthrough: "not-an-object",
    } as never,
  ]).mid;
  assert.equal(hasUnrecoverableMediaPayload(stringMetadata), true);

  const arrayMetadata = midSystemCore([
    { type: "message", role: "user", content: "q" },
    {
      type: "message",
      role: "developer",
      content: "plain policy text",
      internal_chat_message_metadata_passthrough: [METADATA],
    } as never,
  ]).mid;
  assert.equal(hasUnrecoverableMediaPayload(arrayMetadata), true);
});

test("#6949: structured content with the harmless keys still pins (content check unchanged)", () => {
  const { mid } = midSystemCore([
    { type: "message", role: "user", content: "q" },
    {
      type: "message",
      id: "msg_example",
      role: "developer",
      content: [
        { type: "input_text", text: "declared tools:" },
        { type: "tool_addition", name: "web_search" } as never,
      ],
      internal_chat_message_metadata_passthrough: METADATA,
    },
  ]);
  assert.equal(hasUnrecoverableMediaPayload(mid), true);
});

test("#6949: un-folded item re-emits byte-exact INCLUDING the metadata fields", () => {
  const input = [
    { type: "message", role: "user", content: "turn 1" },
    {
      type: "message",
      id: "msg_example",
      role: "developer",
      content: [
        {
          type: "input_text",
          text: "<codex_apps_open_page_instructions>page rules</codex_apps_open_page_instructions>",
        },
      ],
      internal_chat_message_metadata_passthrough: METADATA,
    },
    { type: "message", role: "user", content: "turn 2" },
  ] as ResponsesRequestBody["input"];
  const flat = responsesToCore({ model: "m", input } as ResponsesRequestBody);
  const rebuilt = coreToResponses(flat.msgs, flat.customToolCallIds);
  const sysDev = rebuilt.filter(
    (i) =>
      (i as { type?: string }).type === "message" &&
      (i as { role?: string }).role === "developer",
  );
  assert.equal(sysDev.length, 1);
  assert.deepEqual(
    sysDev[0],
    input[1],
    "verbatim sidecar round-trip keeps every field",
  );
});

test("#6949: assignRefs mints a numeric ref (not BLOCKED) for the item", () => {
  const { mid } = midSystemCore([
    { type: "message", role: "user", content: "turn 1" },
    {
      type: "message",
      id: "msg_example",
      role: "developer",
      content: [
        {
          type: "input_text",
          text: "<codex_apps_open_page_instructions>page rules</codex_apps_open_page_instructions>",
        },
      ],
      internal_chat_message_metadata_passthrough: METADATA,
    },
    { type: "message", role: "user", content: "turn 2" },
  ]);
  const result = assignRefs([mid as CoreMessage], {
    existing: emptyRefMap(),
    nextIndex: 1,
    isProtected: (m) => hasUnrecoverableMediaPayload(m),
  });
  const ref = result.map.byRaw[mid.id];
  assert.ok(ref, "message must carry a ref");
  assert.notEqual(ref, BLOCKED_REF, "no longer BLOCKED");
  assert.match(ref, /^m\d{5}$/, "numeric mNNNNN ref");
});

// Acceptance follow-up (field audit on Codex CLI 0.169.0, #6949 thread):
// the three CLI plain-text classes that were observed pinned — host skill
// instructions, deferred tool namespaces, turn-aborted notices — all carry
// the same shape (valid id + metadata object + input_text parts) and must
// fold. The predicate is shape-based, so one row per class pins the real
// metadata variants.
test("#6949 acceptance: CLI's three plain-text classes fold (skills / deferred namespaces / turn-aborted)", () => {
  const classes = [
    {
      kind: "additional_content.host_skills.instructions",
      text: "host skill instructions: before entering a review loop, read its SKILL.md and follow the loop steps",
    },
    {
      kind: "additional_content.tools.deferred_namespaces",
      text: "deferred tool namespaces: mcp__search, mcp__files (loaded on demand)",
    },
    {
      kind: "additional_content.generic.turn_aborted",
      text: "the previous turn was aborted by the user before a final answer was produced",
    },
  ];
  for (const { kind, text } of classes) {
    const { mid } = midSystemCore([
      { type: "message", role: "user", content: "q" },
      {
        type: "message",
        id: `msg_cli_${kind}`,
        role: "developer",
        content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: {
          turn_id: "turn_cli",
          content_item_kinds: [kind],
          content_item_metadata: [{ provenance: { type: "harness", hook: false } }],
        },
      },
    ]);
    assert.equal(hasUnrecoverableMediaPayload(mid), false, `${kind} must fold`);
  }
});

// Acceptance follow-up (field audit, #6949 thread): sessions that ALREADY
// carry a stale BLOCKED ref for one of these items must recover on the next
// ref-assignment pass after the upgrade — no new session required. This pins
// the #2607 stale-BLOCKED migration on the exact shape that produced it.
test("#6949 acceptance: pre-existing BLOCKED ref migrates to a numeric ref on re-assignment", () => {
  const flat = responsesToCore({
    model: "m",
    input: [
      { type: "message", role: "user", content: "turn 1" },
      {
        type: "message",
        id: "msg_example",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "<codex_apps_open_page_instructions>page rules</codex_apps_open_page_instructions>",
          },
        ],
        internal_chat_message_metadata_passthrough: METADATA,
      },
      { type: "message", role: "user", content: "turn 2" },
    ],
  } as ResponsesRequestBody);
  const [u1, dev, u2] = flat.msgs;
  assert.equal(dev?.role, "system");
  // Pre-fix session state: neighbors hold numeric refs, the developer item
  // was pinned BLOCKED.
  const existing = {
    byRaw: { [u1!.id]: "m00001", [dev!.id]: BLOCKED_REF, [u2!.id]: "m00002" },
    byRef: { m00001: u1!.id, m00002: u2!.id },
  };
  const result = assignRefs(flat.msgs as CoreMessage[], {
    existing,
    nextIndex: 3,
    isProtected: (m) => hasUnrecoverableMediaPayload(m),
  });
  assert.deepEqual(result.migratedIds, [dev!.id]);
  assert.equal(result.map.byRaw[dev!.id], "m00003", "stale BLOCKED mints a fresh numeric ref");
  assert.equal(result.map.byRef["m00003"], dev!.id);
  assert.equal(result.map.byRaw[u1!.id], "m00001", "neighbors keep their refs");
  assert.equal(result.map.byRaw[u2!.id], "m00002", "neighbors keep their refs");
});
