import { test } from "node:test";
import assert from "node:assert/strict";
import { responsesToCore, coreToResponses } from "../src/wire/responses.js";
import type { ResponsesRequestBody } from "../src/wire/responses.js";

// #4166 pins: CURRENT responses-wire behavior for mid-conversation
// system/developer items (issue #4159 family, unreported collateral noted in
// #4165). Unlike the openai codec (which keeps mid system as a positioned
// core), responsesToCore hoists EVERY system/developer message item into
// systemParts (→ instructions) regardless of position: position is destroyed
// and structured parts are flattened by messageContent. The #4166 fix keeps
// the leading-prefix hoist but preserves mid items as sidecar cores.

function roundTrip(input: ResponsesRequestBody["input"]) {
  const flat = responsesToCore({ model: "m", input } as ResponsesRequestBody);
  return { flat, rebuilt: coreToResponses(flat.msgs, flat.customToolCallIds) };
}

test("anchor: leading system/developer items hoist into systemParts", () => {
  const { flat } = roundTrip([
    { type: "message", role: "system", content: "head policy" },
    { type: "message", role: "developer", content: "head dev note" },
    { type: "message", role: "user", content: "hi" },
  ]);
  assert.equal(flat.systemParts.length, 2);
  assert.equal(flat.systemParts[0], "head policy");
  assert.equal(flat.systemParts[1], "head dev note");
  assert.equal(flat.msgs.length, 1);
  assert.equal(flat.msgs[0].role, "user");
});

test("#4166 fixed: MID system item becomes a positioned sidecar core (all modes)", () => {
  const { flat, rebuilt } = roundTrip([
    { type: "message", role: "user", content: "turn 1" },
    { type: "message", role: "user", content: "turn 2" },
    { type: "message", role: "system", content: "mid tool policy" },
    { type: "message", role: "user", content: "turn 3" },
  ]);
  assert.deepEqual(flat.systemParts, []);
  const mid = flat.msgs.find((m) => m.role === "system");
  assert.ok(mid, "positioned core at its place");
  assert.equal(mid.text, "mid tool policy");
  assert.equal(mid.originalRole, "system");
  assert.equal(flat.msgs.indexOf(mid), 2, "original position kept");
  const rb = rebuilt.filter(
    (i) => (i as { type?: string; role?: string }).type === "message",
  );
  const rbSys = rb.filter(
    (i) => (i as { role?: string }).role === "system",
  );
  assert.equal(rbSys.length, 1);
  // consecutive user items rebuild as ONE merged user run (#3642), so the
  // system rides after the merged run — position within the conversation
  // is what matters, not the literal index.
  assert.ok(
    rebuilt.indexOf(rbSys[0]) > 0 && rebuilt.indexOf(rbSys[0]) < rebuilt.length - 1,
    "re-emitted at its conversation position (not hoisted)",
  );
  assert.equal((rbSys[0] as { content?: string }).content, "mid tool policy");
});

test("#4166 fixed: MID system structured parts survive verbatim", () => {
  const { flat, rebuilt } = roundTrip([
    { type: "message", role: "user", content: "turn 1" },
    {
      type: "message",
      role: "system",
      content: [
        { type: "input_text", text: "declared tools:" },
        { type: "tool_addition", name: "web_search" } as never,
      ],
    },
    { type: "message", role: "user", content: "turn 2" },
  ]);
  assert.deepEqual(flat.systemParts, []);
  const mid = flat.msgs.find((m) => m.role === "system");
  assert.ok(mid);
  assert.equal(mid.text, "declared tools:\n");
  const rbJson = JSON.stringify(rebuilt);
  assert.ok(rbJson.includes("web_search"), "block bytes survive the round trip");
  assert.ok(rbJson.includes("tool_addition"));
});

test("#4166: structured mid system is unfoldable (protection), plain one folds", async () => {
  const { hasUnrecoverableMediaPayload } = await import("../src/protected.js");
  const structured = responsesToCore({
    model: "m",
    input: [
      { type: "message", role: "user", content: "q" },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "x" }, { type: "tool_addition", name: "t" } as never],
      },
    ],
  } as never);
  const structuredCore = structured.msgs.find((m) => m.role === "system");
  assert.ok(structuredCore);
  assert.equal(hasUnrecoverableMediaPayload(structuredCore), true);
  const plain = responsesToCore({
    model: "m",
    input: [
      { type: "message", role: "user", content: "q" },
      { type: "message", role: "system", content: "plain policy text" },
    ],
  } as never);
  const plainCore = plain.msgs.find((m) => m.role === "system");
  assert.ok(plainCore);
  assert.equal(hasUnrecoverableMediaPayload(plainCore), false);
  // user cores with a rawResponsesItem sidecar must NOT become unfoldable
  // by this rule — the protection is system-role only.
  const userCore = plain.msgs.find((m) => m.role === "user");
  assert.ok(userCore);
  assert.equal(hasUnrecoverableMediaPayload(userCore), false);
});

test("pin: core system (bili summary carrier path) rebuilds as mid developer", () => {
  const { flat, rebuilt } = roundTrip([
    { type: "message", role: "user", content: "turn 1" },
  ]);
  assert.equal(flat.msgs.length, 1);
  const carrier = {
    id: "raw-carrier",
    role: "system",
    contentType: "text",
    text: "acp_summary: folded 3 messages",
  } as (typeof flat.msgs)[number];
  const out = coreToResponses([...flat.msgs, carrier], flat.customToolCallIds);
  const dev = out.filter(
    (i) =>
      (i as { type?: string; role?: string }).type === "message" &&
      (i as { role?: string }).role === "developer",
  );
  assert.equal(dev.length, 1);
  assert.equal(
    (dev[0] as { content?: string }).content,
    "acp_summary: folded 3 messages",
  );
});
