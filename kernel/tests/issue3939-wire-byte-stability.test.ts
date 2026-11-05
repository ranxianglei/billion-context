import { test } from "node:test";
import assert from "node:assert/strict";
import { coreToOpenai, openaiToCore } from "../src/wire/openai.js";
import { coreToGoogle, googleToCore } from "../src/wire/google.js";

// #3938 / #3939⑥ — wire byte fidelity. The upstream prefix cache only holds
// when the SAME logical shape serializes to IDENTICAL bytes on every
// request. openaiToCore/coreToOpenai and googleToCore/coreToGoogle are pure
// functions of the request body; these pins make that stability explicit
// (the "explicit canonical" half of the #3939⑥ contract) so any future
// reorder — however well-intentioned — fails here before it breaks a live
// session's cache. Goldens below were characterized against the current
// emission (probe-verified 2026-10-20), not invented.

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
