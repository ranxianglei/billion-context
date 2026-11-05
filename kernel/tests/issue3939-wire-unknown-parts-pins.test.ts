import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicToCore,
  coreToAnthropic,
} from "../src/wire/anthropic.js";
import { coreToGoogle, googleToCore } from "../src/wire/google.js";
import {
  coreToResponses,
  responsesToCore,
} from "../src/wire/responses.js";

// Characterization pins for issue #3939 (打桩): each test freezes how ONE
// wire codec treats a part/item type it does not know. The openai line is
// already pinned in tests/media-payload.test.ts (#1205) and is not
// duplicated here. The anthropic pin below was intentionally MOVED by PR-C
// (#3961, #3410): silent drop → verbatim passthrough, per the plan this file
// recorded ("update the anthropic pins IN THE SAME PR").

test("pin: anthropic passes unknown top-level content blocks through verbatim (document survives round trip; moved by #3961 from silent drop)", () => {
  const body = {
    model: "claude-x",
    system: "s",
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "hi" },
          {
            type: "document" as unknown as "text",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "QUJD",
            },
          },
        ],
      },
    ],
  };

  const flat = anthropicToCore(body as never);

  assert.equal(flat.msgs.length, 2);
  assert.equal(flat.msgs[0]!.text, "hi");
  assert.deepEqual(
    (flat.msgs[1] as { rawAnthropicBlock?: unknown }).rawAnthropicBlock,
    body.messages[0]!.content[1],
  );

  const rebuilt = coreToAnthropic(flat.msgs);
  // one message, inbound order preserved, unknown block byte-exact
  assert.equal(rebuilt.length, 1);
  assert.deepEqual(rebuilt[0]!.content, body.messages[0]!.content);
});

test("pin: google preserves unknown parts verbatim via the rawGoogleParts sidecar (fileData round-trips)", () => {
  const body = {
    contents: [
      {
        role: "user" as const,
        parts: [
          { text: "hi" },
          {
            fileData: {
              mimeType: "application/pdf",
              fileUri: "gs://bucket/f.pdf",
            },
          },
        ],
      },
    ],
  };

  const flat = googleToCore(body as never);

  assert.equal(flat.msgs.length, 1);
  assert.equal(flat.msgs[0]!.text, "hi");
  assert.deepEqual(
    (flat.msgs[0] as { rawGoogleParts?: unknown }).rawGoogleParts,
    body.contents[0]!.parts,
  );

  const rebuilt = coreToGoogle(flat.msgs);
  assert.deepEqual(rebuilt, body.contents);
});

test("pin: responses extracts unknown items into flat.preamble; coreToResponses does not re-emit them (host re-attaches)", () => {
  const body = {
    model: "gpt-x",
    input: [
      { type: "custom_thing", payload: 42 } as never,
      {
        type: "message" as const,
        role: "user" as const,
        content: [{ type: "input_text" as const, text: "hi" }],
      },
    ],
  };

  const flat = responsesToCore(body as never);

  assert.deepEqual(flat.preamble, [{ type: "custom_thing", payload: 42 }]);
  assert.equal(flat.msgs.length, 1);
  assert.equal(flat.msgs[0]!.text, "hi");

  const rebuilt = coreToResponses(flat.msgs);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0]!.type, "message");
  assert.ok(!JSON.stringify(rebuilt).includes("custom_thing"));
});
