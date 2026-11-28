import { test } from "node:test";
import assert from "node:assert/strict";
import { coreToOpenai, openaiToCore } from "../src/wire/openai.js";
import { coreToGoogle, googleToCore } from "../src/wire/google.js";
import { coreToAnthropic, anthropicToCore } from "../src/wire/anthropic.js";
import { coreToResponses, responsesToCore } from "../src/wire/responses.js";

// #3938 / #3939⑥ — wire byte fidelity. The upstream prefix cache only holds
// when the SAME logical shape serializes to IDENTICAL bytes on every
// request. The four codec pairs below pin that stability explicitly (the
// "explicit canonical" half of the #3939⑥ contract) so any future reorder —
// however well-intentioned — fails here before it breaks a live session's
// cache. Goldens below were characterized against the current emission
// (probe-verified 2026-10-20; anthropic/responses sections added 2026-11-27,
// #7825 — the two lanes this PR changed most had no byte-level pin at all).

const FILE = {
  type: "file",
  file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AAA=" },
};
const CUSTOM = { type: "custom_op", x: 1 };
const IMG = { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } };

function oaRebuild(content: object[]) {
  return coreToOpenai(
    openaiToCore({ messages: [{ role: "user", content }] } as never).msgs,
  );
}

test("openai: [opaque, text] and [text, opaque] both emit the canonical [text, opaque]", () => {
  const expected = [
    { role: "user", content: [{ type: "text", text: "T1" }, FILE] },
  ];
  assert.deepEqual(oaRebuild([FILE, { type: "text", text: "T1" }]), expected);
  assert.deepEqual(oaRebuild([{ type: "text", text: "T1" }, FILE]), expected);
});

test("openai: [opaque, text, opaque] — leading PREPEND lands both opaquers after the text", () => {
  assert.deepEqual(oaRebuild([FILE, { type: "text", text: "T1" }, CUSTOM]), [
    { role: "user", content: [{ type: "text", text: "T1" }, FILE, CUSTOM] },
  ]);
});

test("openai: [opaque, image, text] — image keeps its own core, leading opaque joins the text core", () => {
  assert.deepEqual(oaRebuild([FILE, IMG, { type: "text", text: "T1" }]), [
    { role: "user", content: [IMG, { type: "text", text: "T1" }, FILE] },
  ]);
});

test("openai: [opaque, opaque, text] — both opaquers trail the text, input order kept", () => {
  assert.deepEqual(oaRebuild([FILE, CUSTOM, { type: "text", text: "T1" }]), [
    { role: "user", content: [{ type: "text", text: "T1" }, FILE, CUSTOM] },
  ]);
});

test("openai: opaque-only message keeps the legacy single-part array shape", () => {
  assert.deepEqual(oaRebuild([FILE]), [{ role: "user", content: [FILE] }]);
});

const OA_SHAPES: [string, object[]][] = [
  ["opaque-text", [FILE, { type: "text", text: "T1" }]],
  ["text-opaque", [{ type: "text", text: "T1" }, FILE]],
  ["opaque-text-opaque", [FILE, { type: "text", text: "T1" }, CUSTOM]],
  ["opaque-image-text", [FILE, IMG, { type: "text", text: "T1" }]],
  ["opaque-only", [FILE]],
];
for (const [name, content] of OA_SHAPES) {
  test(`openai: ${name} — appended turns leave the rebuilt prefix byte-identical`, () => {
    const req1 = oaRebuild(content);
    const req2 = coreToOpenai(
      openaiToCore({
        messages: [
          { role: "user", content },
          { role: "assistant", content: "A1" },
          { role: "user", content: "next" },
        ],
      } as never).msgs,
    );
    assert.equal(req2.length, 3);
    // The prefix-cache property: everything the previous request sent goes
    // out byte-for-byte again.
    assert.equal(JSON.stringify(req2.slice(0, req1.length)), JSON.stringify(req1));
  });
}

test("openai: parse is a structural fixed point over rebuild", () => {
  const pick = (m: { [k: string]: unknown }) => ({
    id: m.id,
    ct: m.contentType,
    text: m.text,
    raw: m.rawOpenaiContentParts ?? m.rawOpenaiContent ?? null,
  });
  const body = { messages: [{ role: "user", content: [FILE, { type: "text", text: "T1" }, CUSTOM] }] };
  const once = openaiToCore(body as never).msgs.map(pick);
  const twice = openaiToCore({ messages: coreToOpenai(openaiToCore(body as never).msgs) } as never).msgs.map(pick);
  assert.deepEqual(twice, once);
});

test("openai: repeated parses of one body mint identical ids", () => {
  const body = { messages: [{ role: "user", content: [FILE, { type: "text", text: "T1" }] }] };
  const a = openaiToCore(body as never).msgs.map((m) => m.id);
  const b = openaiToCore(body as never).msgs.map((m) => m.id);
  assert.deepEqual(b, a);
});

const FC = { functionCall: { name: "f", args: { b: 1, a: 2 } } };
const THOUGHT = { thought: true, text: "hmm", thoughtSignature: "SIG" };
const SIGNED_TEXT = { text: "MT", thoughtSignature: "SIGT" };
const FD = { fileData: { fileUri: "https://x/y.bin" } };

function gRebuild(contents: object[]) {
  return coreToGoogle(googleToCore({ contents } as never).msgs);
}

test("google: model run emits the canonical reasoning → text → tool-call order regardless of input order", () => {
  assert.deepEqual(gRebuild([{ role: "model", parts: [FC, THOUGHT, SIGNED_TEXT] }]), [
    { role: "model", parts: [THOUGHT, SIGNED_TEXT, FC] },
  ]);
});

test("google: movable plain text after a functionResponse leads (#3159)", () => {
  assert.deepEqual(
    gRebuild([
      {
        role: "user",
        parts: [
          { functionResponse: { name: "f", response: { output: "ok" }, id: "c1" } },
          { text: "plain after fr" },
        ],
      },
    ]),
    [
      {
        role: "user",
        parts: [
          { text: "plain after fr" },
          { functionResponse: { name: "f", response: { output: "ok" }, id: "c1" } },
        ],
      },
    ],
  );
});

test("google: signed text after a functionResponse stays put (not movable)", () => {
  assert.deepEqual(
    gRebuild([
      {
        role: "user",
        parts: [
          { functionResponse: { name: "f", response: {}, id: "c1" } },
          { text: "signed", thoughtSignature: "S2" },
        ],
      },
    ]),
    [
      {
        role: "user",
        parts: [
          { functionResponse: { name: "f", response: {}, id: "c1" } },
          { text: "signed", thoughtSignature: "S2" },
        ],
      },
    ],
  );
});

test("google: fileData part rides verbatim in place, both input orders emit [text, fileData]", () => {
  const expected = [
    { role: "user", parts: [{ text: "after fd" }, FD] },
  ];
  assert.deepEqual(gRebuild([{ role: "user", parts: [{ text: "after fd" }, FD] }]), expected);
  assert.deepEqual(gRebuild([{ role: "user", parts: [FD, { text: "after fd" }] }]), expected);
});

const G_SHAPES: [string, { role: string; parts: object[] }][] = [
  ["user-filedata-text", { role: "user", parts: [{ text: "look at" }, FD] }],
  ["model-mixed", { role: "model", parts: [THOUGHT, SIGNED_TEXT, FC] }],
];
for (const [name, first] of G_SHAPES) {
  test(`google: ${name} — appended alternating turn leaves the rebuilt prefix byte-identical`, () => {
    const req1 = gRebuild([first]);
    const req2 = gRebuild([
      first,
      first.role === "model"
        ? { role: "user", parts: [{ text: "next" }] }
        : { role: "model", parts: [{ text: "reply" }] },
    ]);
    assert.equal(req2.length, 2);
    assert.equal(JSON.stringify(req2.slice(0, req1.length)), JSON.stringify(req1));
  });
}

test("google: consecutive same-role contents merge into ONE canonical content (required normalization)", () => {
  // Gemini rejects non-alternating roles, so the merge is mandatory; its
  // output order (reasoning → text → tool-call) is the canonical one. No
  // healthy client ever sends these — this pins the normalization itself.
  assert.deepEqual(
    gRebuild([
      { role: "model", parts: [{ text: "A1" }, FC] },
      { role: "model", parts: [{ text: "B1" }] },
    ]),
    [
      {
        role: "model",
        parts: [{ text: "A1" }, { text: "B1" }, { functionCall: { name: "f", args: { b: 1, a: 2 } } }],
      },
    ],
  );
});

test("google: repeated parses of one body mint identical ids", () => {
  const body = { contents: [{ role: "user", parts: [{ text: "after fd" }, FD] }] };
  const a = googleToCore(body as never).msgs.map((m) => m.id);
  const b = googleToCore(body as never).msgs.map((m) => m.id);
  assert.deepEqual(b, a);
});

// ── anthropic ──────────────────────────────────────────────────────────

const A_IMG = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "QQ==" },
};

function aRebuild(messages: object[]) {
  return coreToAnthropic(
    anthropicToCore({ messages } as never).msgs as never,
  );
}

test("anthropic: user [text, image] + unsigned thinking/text rebuild verbatim", () => {
  assert.deepEqual(
    aRebuild([
      { role: "user", content: [{ type: "text", text: "hi" }, A_IMG] },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "T-THINK" }, { type: "text", text: "hello" }],
      },
    ]),
    [
      { role: "user", content: [{ type: "text", text: "hi" }, A_IMG] },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "T-THINK" }, { type: "text", text: "hello" }],
      },
    ],
  );
});

test("anthropic: plain string content normalizes to the text-parts array shape", () => {
  assert.deepEqual(aRebuild([{ role: "user", content: "next" }]), [
    { role: "user", content: [{ type: "text", text: "next" }] },
  ]);
});

test("anthropic: parse is a structural fixed point over rebuild", () => {
  const msgs = anthropicToCore({
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }, A_IMG] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ],
  } as never).msgs;
  const once = anthropicToCore({
    messages: coreToAnthropic(msgs as never),
  } as never).msgs;
  assert.deepEqual(once.map((m) => m.id), msgs.map((m) => m.id));
  assert.deepEqual(once.map((m) => m.text), msgs.map((m) => m.text));
});

test("anthropic: repeated parses of one body mint identical ids", () => {
  const body = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }, A_IMG] }] };
  const a = anthropicToCore(body as never).msgs.map((m) => m.id);
  const b = anthropicToCore(body as never).msgs.map((m) => m.id);
  assert.deepEqual(b, a);
});

// ── responses ──────────────────────────────────────────────────────────

function rRebuild(input: object[]) {
  return coreToResponses(responsesToCore({ input } as never).msgs);
}

test("responses: two single-image user items stay distinct verbatim items (#7824)", () => {
  const itemA = {
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url: "data:image/png;base64,QUJD" }],
  };
  const itemB = {
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url: "data:image/png;base64,RURG" }],
  };
  assert.deepEqual(rRebuild([itemA, itemB]), [itemA, itemB]);
});

test("responses: single [text, image] item rebuilds byte-stable (fullCover path)", () => {
  const item = {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "T" },
      { type: "input_image", image_url: "data:image/png;base64,QUJD" },
    ],
  };
  assert.deepEqual(rRebuild([item]), [item]);
});

test("responses: parse is a structural fixed point over rebuild", () => {
  const msgs = responsesToCore({
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "T" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "A" }] },
    ],
  } as never).msgs;
  const once = responsesToCore({
    input: coreToResponses(msgs),
  } as never).msgs;
  assert.deepEqual(once.map((m) => m.id), msgs.map((m) => m.id));
  assert.deepEqual(once.map((m) => m.text), msgs.map((m) => m.text));
});

test("responses: repeated parses of one body mint identical ids", () => {
  const body = {
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "T" }] },
    ],
  };
  const a = responsesToCore(body as never).msgs.map((m) => m.id);
  const b = responsesToCore(body as never).msgs.map((m) => m.id);
  assert.deepEqual(b, a);
});

// #7825 (PR #7837) — additional byte-stability pins for the two lanes above:
// the mechanisms master's section does not cover — tool_use input insertion
// order, sidecar verbatim blocks (image / redacted_thinking / document),
// cache_control id-keyed map, custom_tool_call set, prefix-cache loops,
// cross-lane image id. Goldens characterized against the current emission
// (probe-verified 2026-11-27), not invented.

const A_DOC = {
  type: "document",
  source: { type: "base64", media_type: "application/pdf", data: "PDF" },
};
const A_TOOL_USE = { type: "tool_use", id: "call_1", name: "f", input: { b: 1, a: 2 } };
const A_TOOL_RESULT = { type: "tool_result", tool_use_id: "call_1", content: "ok" };

function aRebuildFull(messages: object[]) {
  const flat = anthropicToCore({ messages } as never);
  return coreToAnthropic(flat.msgs, flat.cacheControls);
}

test("anthropic: text + tool_use + tool_result round-trips byte-exact (input object keeps insertion order)", () => {
  const body = [
    { role: "user", content: [{ type: "text", text: "T1" }] },
    { role: "assistant", content: [{ type: "text", text: "A1" }, A_TOOL_USE] },
    { role: "user", content: [A_TOOL_RESULT] },
  ];
  // The tool_use input object must keep the host's insertion order
  // ({ b, a }, not { a, b }) — a reorder here desyncs the prefix cache.
  assert.equal(JSON.stringify(aRebuildFull(body)), JSON.stringify(body));
});

test("anthropic: image block rides the sidecar verbatim (never re-laid-out)", () => {
  const body = [{ role: "user", content: [A_IMG, { type: "text", text: "look" }] }];
  assert.equal(JSON.stringify(aRebuildFull(body)), JSON.stringify(body));
});

test("anthropic: redacted_thinking rides the sidecar verbatim (signature-verified, never rewritten)", () => {
  const body = [
    {
      role: "assistant",
      content: [{ type: "redacted_thinking", data: "REDACTED" }, { type: "text", text: "A3" }],
    },
  ];
  assert.equal(JSON.stringify(aRebuildFull(body)), JSON.stringify(body));
});

test("anthropic: unknown top-level block (document) rides the sidecar verbatim", () => {
  const body = [{ role: "user", content: [A_DOC, { type: "text", text: "read" }] }];
  assert.equal(JSON.stringify(aRebuildFull(body)), JSON.stringify(body));
});

test("anthropic: unsigned thinking round-trips as { type: thinking, thinking } (no signature key)", () => {
  const body = [
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "A4" }] },
  ];
  assert.equal(JSON.stringify(aRebuildFull(body)), JSON.stringify(body));
});

test("anthropic: cache_control rides the id-keyed map and is re-attached on rebuild (byte-exact)", () => {
  const body = [
    { role: "user", content: [{ type: "text", text: "T1", cache_control: { type: "ephemeral" } }] },
  ];
  assert.equal(JSON.stringify(aRebuildFull(body)), JSON.stringify(body));
});

const A_SHAPES: [string, object[]][] = [
  ["text", [{ role: "user", content: [{ type: "text", text: "T1" }] }]],
  [
    "cache-control",
    [{ role: "user", content: [{ type: "text", text: "T1", cache_control: { type: "ephemeral" } }] }],
  ],
  [
    "tool-loop",
    [
      { role: "user", content: [{ type: "text", text: "T1" }] },
      { role: "assistant", content: [{ type: "text", text: "A1" }, A_TOOL_USE] },
      { role: "user", content: [A_TOOL_RESULT] },
    ],
  ],
  ["image", [{ role: "user", content: [A_IMG, { type: "text", text: "look" }] }]],
];
for (const [name, first] of A_SHAPES) {
  test(`anthropic: ${name} — appended turns leave the rebuilt prefix byte-identical`, () => {
    const req1 = aRebuildFull(first);
    const req2 = aRebuildFull([
      ...first,
      { role: "assistant", content: [{ type: "text", text: "A1" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]);
    assert.equal(req2.length, req1.length + 2);
    assert.equal(JSON.stringify(req2.slice(0, req1.length)), JSON.stringify(req1));
  });
}

test("anthropic: parse is a structural fixed point over rebuild (full core shape incl. sidecar fields)", () => {
  const pick = (m: { [k: string]: unknown }) => ({
    id: m.id,
    ct: m.contentType,
    text: m.text,
    toolCallId: m.toolCallId ?? null,
    toolName: m.toolName ?? null,
    raw: m.rawAnthropicBlock ?? null,
  });
  const body = { messages: [{ role: "user", content: [A_IMG, { type: "text", text: "T1" }] }] };
  const once = anthropicToCore(body as never).msgs.map(pick);
  const twice = anthropicToCore({
    messages: coreToAnthropic(anthropicToCore(body as never).msgs),
  } as never).msgs.map(pick);
  assert.deepEqual(twice, once);
});

test("anthropic: repeated parses mint identical ids (image-first body)", () => {
  const body = { messages: [{ role: "user", content: [A_IMG, { type: "text", text: "T1" }] }] };
  const a = anthropicToCore(body as never).msgs.map((m) => m.id);
  const b = anthropicToCore(body as never).msgs.map((m) => m.id);
  assert.deepEqual(b, a);
});

const R_IMG = { type: "input_image", image_url: "data:image/png;base64,QQ==" };
const R_FUNC_CALL = { type: "function_call", call_id: "call_1", name: "f", arguments: '{"b":1,"a":2}' };
const R_FUNC_OUT = { type: "function_call_output", call_id: "call_1", output: "ok" };
const R_CT_CALL = { type: "custom_tool_call", call_id: "ct_1", name: "", input: "do it", status: "completed" };
const R_CT_OUT = { type: "custom_tool_call_output", call_id: "ct_1", output: "done" };

function rRebuildFull(input: object[]) {
  const proj = responsesToCore({ input } as never);
  return coreToResponses(proj.msgs, proj.customToolCallIds);
}

test("responses: message + function_call + function_call_output round-trips byte-exact", () => {
  const body = [
    { type: "message", role: "user", content: "T1" },
    R_FUNC_CALL,
    R_FUNC_OUT,
  ];
  assert.equal(JSON.stringify(rRebuildFull(body)), JSON.stringify(body));
});

test("responses: reasoning item re-emits the raw item verbatim (never re-laid-out)", () => {
  const body = [
    { type: "reasoning", id: "rs_1", summary: [] },
    { type: "message", role: "assistant", content: "A2" },
  ];
  assert.equal(JSON.stringify(rRebuildFull(body)), JSON.stringify(body));
});

test("responses: image-only user item is preserved (tracked via [image] placeholder, never vanishes)", () => {
  const body = [{ type: "message", role: "user", content: [R_IMG] }];
  assert.equal(JSON.stringify(rRebuildFull(body)), JSON.stringify(body));
});

test("responses: text+image user message preserves both parts (split cores rebuild verbatim)", () => {
  const body = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "look at" }, R_IMG] },
  ];
  assert.equal(JSON.stringify(rRebuildFull(body)), JSON.stringify(body));
});

test("responses: custom_tool_call canonical form (status present) round-trips byte-exact", () => {
  const body = [R_CT_CALL, R_CT_OUT];
  assert.equal(JSON.stringify(rRebuildFull(body)), JSON.stringify(body));
});

const R_SHAPES: [string, object[], object][] = [
  ["text", [{ type: "message", role: "user", content: "T1" }], { type: "message", role: "assistant", content: "A1" }],
  ["tool-loop", [{ type: "message", role: "user", content: "T1" }, R_FUNC_CALL, R_FUNC_OUT], { type: "message", role: "user", content: "next" }],
  ["image", [{ type: "message", role: "user", content: [R_IMG] }], { type: "message", role: "assistant", content: "A1" }],
  ["custom-tool", [R_CT_CALL, R_CT_OUT], { type: "message", role: "user", content: "next" }],
];
for (const [name, first, append] of R_SHAPES) {
  test(`responses: ${name} — appended turns leave the rebuilt prefix byte-identical`, () => {
    const req1 = rRebuildFull(first);
    const req2 = rRebuildFull([...first, append]);
    assert.equal(req2.length, req1.length + 1);
    assert.equal(JSON.stringify(req2.slice(0, req1.length)), JSON.stringify(req1));
  });
}

test("responses: parse is a structural fixed point over rebuild (full core shape incl. sidecar fields)", () => {
  const pick = (m: { [k: string]: unknown }) => ({
    id: m.id,
    ct: m.contentType,
    text: m.text,
    toolCallId: m.toolCallId ?? null,
    toolName: m.toolName ?? null,
    raw: m.rawResponsesItem ?? null,
  });
  const body = {
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "look at" }, R_IMG] }],
  };
  const once = responsesToCore(body as never).msgs.map(pick);
  const proj = responsesToCore(body as never);
  const twice = responsesToCore({
    input: coreToResponses(proj.msgs, proj.customToolCallIds),
  } as never).msgs.map(pick);
  assert.deepEqual(twice, once);
});

test("responses: repeated parses mint identical ids (text+image body)", () => {
  const body = {
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "look at" }, R_IMG] }],
  };
  const a = responsesToCore(body as never).msgs.map((m) => m.id);
  const b = responsesToCore(body as never).msgs.map((m) => m.id);
  assert.deepEqual(b, a);
});

test("cross-lane: the same image payload mints the same core id on anthropic and responses", () => {
  const aId = anthropicToCore({
    messages: [{ role: "user", content: [A_IMG] }],
  } as never).msgs[0]!.id;
  const rId = responsesToCore({
    input: [{ type: "message", role: "user", content: [R_IMG] }],
  } as never).msgs[0]!.id;
  assert.equal(rId, aId);
});
