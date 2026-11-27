/**
 * #7824 — coreToResponses silently dropped images when one user run spanned
 * MULTIPLE distinct raw input items: the merge read image parts only from the
 * FIRST carrier's content, so every image (or whole item) from a later item
 * vanished — no error, no log. The Responses wire is a list; the fix emits
 * each distinct raw item verbatim, and an image core without any source part
 * now THROWS instead of vanishing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coreToResponses,
  responsesToCore,
} from "../src/wire/responses.js";

const IMG_A = "data:image/png;base64,QUJD";
const IMG_B = "data:image/png;base64,RURG";

test("two single-image user items in one run: BOTH images survive verbatim", () => {
  const itemA = {
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url: IMG_A }],
  };
  const itemB = {
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url: IMG_B }],
  };
  const out = coreToResponses(responsesToCore({ input: [itemA, itemB] }).msgs);
  // Before the fix this was ONE message with two "[image]" input_text parts
  // — both payloads gone.
  assert.deepEqual(out, [itemA, itemB]);
});

test("text item + image item in one run: text AND image survive", () => {
  const itemT = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "hello" }],
  };
  const itemI = {
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url: IMG_B }],
  };
  const out = coreToResponses(responsesToCore({ input: [itemT, itemI] }).msgs);
  assert.deepEqual(out, [itemT, itemI]);
});

test("single-item [text, image] run stays on the fullCover byte path", () => {
  const item = {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "T" },
      { type: "input_image", image_url: IMG_A },
    ],
  };
  const core = responsesToCore({ input: [item] });
  // split cores: text core has no sidecar, image core is bound at parse
  assert.equal(core.msgs[0]?.text, "T");
  const imgCore = core.msgs[1] as { rawResponseImagePart?: unknown; imagePart?: boolean };
  assert.equal(imgCore.imagePart, true);
  assert.deepEqual(imgCore.rawResponseImagePart, {
    type: "input_image",
    image_url: IMG_A,
  });
  assert.deepEqual(coreToResponses(core.msgs), [item]);
});

test("image core with no source part at all: throw, never a silent drop", () => {
  const raw = {
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url: IMG_A }],
  };
  // Legacy-shaped cores: imagePart flag + raw item, but no per-message
  // binding (pre-fix persisted state), and two of them against one image
  // part — the old cursor exhausted on the second.
  const legacy = () => ({
    id: "m00001",
    role: "user",
    contentType: "text",
    text: "[image]",
    imagePart: true,
    rawResponsesItem: raw,
  });
  assert.throws(
    () => coreToResponses([legacy(), legacy()] as never),
    /refusing to drop content/,
  );
});
