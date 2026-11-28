import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coreToOpenai,
  openaiToCore,
  type OpenAIRequestBody,
} from "../src/wire/openai.js";
import { hasUnrecoverableMediaPayload } from "../src/protected.js";
import { assignRefs, BLOCKED_REF } from "../src/refs.js";
import { createInitialState } from "../src/state.js";

// #6875, codec half (maintainer triage): openaiToCore case "tool" only kept
// stringContent, so a DSH read_image result {type:"image",
// attachment:{attachmentId}} was dropped at parse time and never reached
// extractMediaRefs. The tool branch now retains non-text parts on
// rawOpenaiContentParts (#1205 parity with the user branch) and the rebuild
// re-emits them verbatim; the media-refs half (companion file) recognizes
// the attachmentId as a recoverable handle. Either half alone is wrong:
// retention without recognition would newly pin the message.
const DSH_ID = "sha256:a08caa79deadbeef";
const DSH_PART = {
  type: "image",
  attachment: {
    attachmentId: DSH_ID,
    mediaType: "image/png",
    bytes: 62368,
    width: 896,
    height: 651,
    name: "printwindow_flag0.png",
  },
};

function toolBody(content: unknown): OpenAIRequestBody {
  return {
    messages: [
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "read_image",
        content: content as never,
      },
    ],
  };
}

test("tool results keep their non-text parts on rawOpenaiContentParts (#6875)", () => {
  const parsed = openaiToCore(
    toolBody([{ type: "text", text: "shot" }, DSH_PART]),
  );
  assert.equal(parsed.msgs.length, 1);
  const core = parsed.msgs[0]!;
  assert.equal(core.role, "tool");
  assert.equal(core.contentType, "tool-result");
  // stringContent joins every part with "\n" and non-text parts
  // contribute "" — the trailing newline is the pre-existing join
  // artifact for multi-part tool results, not something this fix adds.
  assert.equal(core.text, "shot\n");
  assert.equal(core.toolName, "read_image");
  assert.deepEqual(
    (core as { rawOpenaiContentParts?: unknown[] }).rawOpenaiContentParts,
    [DSH_PART],
  );
});

test("plain tool results keep the legacy shape — no sidecar (#6875 negative)", () => {
  const str = openaiToCore(toolBody("plain result"));
  assert.equal(str.msgs.length, 1);
  assert.equal(str.msgs[0]!.text, "plain result");
  assert.equal(
    (str.msgs[0] as { rawOpenaiContentParts?: unknown[] })
      .rawOpenaiContentParts,
    undefined,
  );
  const textOnly = openaiToCore(
    toolBody([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
  );
  assert.equal(textOnly.msgs[0]!.text, "a\nb");
  assert.equal(
    (textOnly.msgs[0] as { rawOpenaiContentParts?: unknown[] })
      .rawOpenaiContentParts,
    undefined,
  );
});

test("a retained tool attachment round-trips verbatim; plain stays a string (#6875)", () => {
  const parsed = openaiToCore(
    toolBody([{ type: "text", text: "shot" }, DSH_PART]),
  );
  const rebuilt = coreToOpenai(parsed.msgs);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0]!.role, "tool");
  assert.equal(rebuilt[0]!.tool_call_id, "call_1");
  assert.deepEqual(rebuilt[0]!.content, [
    { type: "text", text: "shot\n" },
    DSH_PART,
  ]);
  const plain = coreToOpenai(openaiToCore(toolBody("plain result")).msgs);
  assert.deepEqual(plain, [
    { role: "tool", tool_call_id: "call_1", content: "plain result" },
  ]);
});

test("an image-only DSH tool result keeps its attachment, empty text (#6875)", () => {
  const parsed = openaiToCore(toolBody([DSH_PART]));
  assert.equal(parsed.msgs.length, 1);
  const core = parsed.msgs[0]!;
  assert.equal(core.text, "");
  assert.deepEqual(
    (core as { rawOpenaiContentParts?: unknown[] }).rawOpenaiContentParts,
    [DSH_PART],
  );
  const rebuilt = coreToOpenai(parsed.msgs);
  assert.deepEqual(rebuilt[0]!.content, [DSH_PART]);
});

test("non-attachment opaque tool parts keep the legacy text-only reduction (#6875)", () => {
  const parsed = openaiToCore(
    toolBody([
      { type: "text", text: "out" },
      { type: "image_url", image_url: { url: "https://example.com/i.png" } },
      { type: "image" },
      { type: "image", attachment: { mediaType: "image/png" } },
    ]),
  );
  const core = parsed.msgs[0]!;
  assert.equal(
    (core as { rawOpenaiContentParts?: unknown[] }).rawOpenaiContentParts,
    undefined,
    "no sidecar — none of these parts is a DSH attachment part",
  );
  const rebuilt = coreToOpenai(parsed.msgs);
  assert.equal(
    typeof rebuilt[0]!.content,
    "string",
    "legacy string-content shape, no parts array",
  );
});

test("a parsed DSH tool result is not unrecoverable media (#6875)", () => {
  const parsed = openaiToCore(
    toolBody([{ type: "text", text: "shot" }, DSH_PART]),
  );
  assert.equal(hasUnrecoverableMediaPayload(parsed.msgs[0]!), false);
});

// Directed repro the maintainer asked for: with both halves in place, a
// stale BLOCKED binding on a DSH tool-result message migrates to a fresh
// number on the next assignRefs pass — no delete-the-library step.
test("stale BLOCKED on a parsed DSH tool result migrates to a fresh number (#6875)", () => {
  const parsed = openaiToCore(
    toolBody([{ type: "text", text: "shot" }, DSH_PART]),
  );
  const core = parsed.msgs[0]!;
  const state = createInitialState();
  state.messageRefs.byRaw[core.id] = BLOCKED_REF;
  const res = assignRefs([core], {
    existing: state.messageRefs,
    nextIndex: 1,
    isProtected: hasUnrecoverableMediaPayload,
  });
  assert.equal(
    res.map.byRaw[core.id],
    "m00001",
    "fresh number — never a reuse",
  );
});
