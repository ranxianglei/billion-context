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
