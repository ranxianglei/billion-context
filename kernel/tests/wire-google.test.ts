import { test } from "node:test";
import assert from "node:assert/strict";
import {
  conversationSignalGoogle,
  coreToGoogle,
  googleSystemText,
  googleToCore,
  injectGoogleSystem,
  normalizeGoogleUserPartOrder,
  type GooglePart,
  type GoogleRequestBody,
} from "../src/wire/google.js";
import {
  WIRE_FORMATS,
  detectWireFormat,
  isWireFormat,
} from "../src/wire/formats.js";

const IMG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
// Gemini 3 attaches an opaque signature to text and thinking parts; the client
// resends it verbatim (and sends this sentinel when its compat required it on
// the first functionCall).
const SENTINEL = "skip_thought_signature_validator";

function ompBody(): GoogleRequestBody {
  return {
    contents: [
      {
        role: "user",
        parts: [
          { text: "run the tests" },
          { inlineData: { mimeType: "image/png", data: IMG } },
        ],
      },
      {
        role: "model",
        parts: [
          {
            thought: true,
            text: "List the files first.",
            thoughtSignature: "sig-think",
          },
          {
            text: "Listing the tree.",
            thoughtSignature: "sig-text",
            videoMetadata: { fps: 24 },
          },
          { executableCode: { language: "PYTHON", code: "print(1)" } },
          {
            functionCall: {
              name: "bash",
              args: { cmd: "ls" },
              id: "call_list",
            },
            thoughtSignature: SENTINEL,
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "bash",
              response: { output: "a.ts\nb.ts" },
              id: "call_list",
            },
          },
          {
            functionResponse: {
              name: "bash",
              response: { output: "second, no id" },
            },
          },
        ],
      },
    ],
    systemInstruction: {
      parts: [{ text: "You are omp." }, { text: "Be terse." }],
    },
    tools: [
      {
        functionDeclarations: [
          { name: "bash", description: "run", parameters: { type: "object" } },
        ],
      },
    ],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    generationConfig: { temperature: 1, maxOutputTokens: 4096 },
  };
}

/** Read `contents` off a body returned by the stripper through a runtime guard,
 *  so a shape regression fails loudly instead of reading undefined. */
function rebuiltContents(body: unknown): unknown[] {
  if (typeof body === "object" && body !== null && "contents" in body) {
    const contents = body.contents;
    if (Array.isArray(contents)) return contents;
  }
  throw new Error("rebuilt body has no contents array");
}

test("google: systemInstruction is hoisted out of the fold space", () => {
  const body = ompBody();
  const flat = googleToCore(body);
  assert.equal(googleSystemText(body), "You are omp.\n\nBe terse.");
  assert.equal(flat.systemText, "You are omp.\n\nBe terse.");
  assert.equal(flat.msgs.filter((m) => m.role === "system").length, 0);
  assert.ok(!flat.msgs.some((m) => (m.text ?? "").includes("You are omp.")));
});

test("google: model maps to assistant, user to user, thought parts to reasoning", () => {
  const { msgs } = googleToCore(ompBody());
  // #3642 canonical granularity: every content part is its own core (the
  // anthropic codec's model), so the [text, image] user content yields two
  // user cores and the model turn yields reasoning + text (the opaque
  // executableCode part rides the preceding text core's raw sidecar).
  assert.deepEqual(
    msgs.map((m) => `${m.role}/${m.contentType}`),
    [
      "user/text",
      "user/text",
      "assistant/reasoning",
      "assistant/text",
      "assistant/tool-call",
      "tool/tool-result",
      "tool/tool-result",
    ],
  );
  assert.equal(msgs[0]!.text, "run the tests");
  assert.equal(msgs[0]!.imageMediaType, undefined);
  assert.equal(msgs[1]!.text, "[image]");
  assert.equal(msgs[1]!.imageMediaType, "image/png");
  assert.equal(msgs[1]!.imageBase64, IMG);
  assert.equal(msgs[2]!.text, "List the files first.");
  assert.equal(msgs[4]!.toolName, "bash");
  assert.equal(msgs[4]!.toolCallId, "call_list");
  assert.equal(msgs[4]!.text, '{"cmd":"ls"}');
  // #3658: google functionResponse single-key {output} objects unwrap into
  // plain text — the tool-result core text is "a.ts\nb.ts", not a JSON blob.
  assert.equal(msgs[5]!.text, "a.ts\nb.ts");
});

test("google: functionResponse parts become tool cores ahead of the user core", () => {
  const body: GoogleRequestBody = {
    contents: [
      {
        role: "user",
        parts: [
          { functionResponse: { name: "bash", response: { output: "ok" } } },
          { text: "and now" },
        ],
      },
    ],
  };
  const { msgs } = googleToCore(body);
  assert.deepEqual(
    msgs.map((m) => `${m.role}/${m.contentType}`),
    ["tool/tool-result", "user/text"],
  );
  assert.equal(msgs[1]!.text, "and now");
});

test("google: full round-trip preserves signatures, ids and unknown part fields", () => {
  const body = ompBody();
  const rebuilt = coreToGoogle(googleToCore(body).msgs);
  // The strongest form: the rebuilt contents ARE the request the client sent.
  assert.deepEqual(rebuilt, body.contents);
  assert.deepEqual(
    rebuilt.map((c) => c.role),
    ["user", "model", "user"],
  );
  const modelParts = rebuilt[1]!.parts;
  assert.deepEqual(modelParts[0], {
    thought: true,
    text: "List the files first.",
    thoughtSignature: "sig-think",
  });
  assert.equal(modelParts[1]!.thoughtSignature, "sig-text");
  assert.deepEqual(modelParts[1]!.videoMetadata, { fps: 24 });
  assert.deepEqual(modelParts[2]!.executableCode, {
    language: "PYTHON",
    code: "print(1)",
  });
  assert.equal(modelParts[3]!.thoughtSignature, SENTINEL);
  assert.deepEqual(modelParts[3]!.functionCall, {
    name: "bash",
    args: { cmd: "ls" },
    id: "call_list",
  });
  const userParts = rebuilt[2]!.parts;
  assert.deepEqual(userParts[0]!.functionResponse, {
    name: "bash",
    response: { output: "a.ts\nb.ts" },
    id: "call_list",
  });
  assert.deepEqual(userParts[1]!.functionResponse, {
    name: "bash",
    response: { output: "second, no id" },
  });
});

test("google: rebuilt contents alternate roles (consecutive same-side cores merge)", () => {
  const body: GoogleRequestBody = {
    contents: [
      { role: "user", parts: [{ text: "one" }] },
      { role: "user", parts: [{ text: "two" }] },
      { role: "model", parts: [{ text: "a" }] },
      { role: "model", parts: [{ text: "b" }] },
      { role: "user", parts: [{ text: "three" }] },
    ],
  };
  const { msgs } = googleToCore(body);
  const contents = coreToGoogle(msgs);
  assert.deepEqual(
    contents.map((c) => c.role),
    ["user", "model", "user"],
  );
  assert.deepEqual(contents[0]!.parts, [{ text: "one" }, { text: "two" }]);
  assert.deepEqual(contents[1]!.parts, [{ text: "a" }, { text: "b" }]);
  assert.ok(contents.length < msgs.length);
  for (let i = 1; i < contents.length; i++)
    assert.notEqual(contents[i]!.role, contents[i - 1]!.role);
});

test("google: model content rebuilds parts in reasoning/text/tool-call order", () => {
  const body: GoogleRequestBody = {
    contents: [
      { role: "user", parts: [{ text: "go" }] },
      {
        role: "model",
        parts: [
          { functionCall: { name: "read", args: { path: "a" }, id: "c1" } },
          { text: "after the call" },
          { thought: true, text: "thinking" },
        ],
      },
    ],
  };
  const contents = coreToGoogle(googleToCore(body).msgs);
  assert.deepEqual(contents[1]!.parts, [
    { thought: true, text: "thinking" },
    { text: "after the call" },
    { functionCall: { name: "read", args: { path: "a" }, id: "c1" } },
  ]);
});

test("google: ids and synthesized toolCallIds are deterministic across passes", () => {
  const first = googleToCore(ompBody());
  const second = googleToCore(structuredClone(ompBody()));
  assert.deepEqual(first.msgs, second.msgs);
  assert.deepEqual(
    first.msgs.map((m) => m.id),
    second.msgs.map((m) => m.id),
  );
  assert.deepEqual(
    first.msgs.map((m) => m.toolCallId),
    second.msgs.map((m) => m.toolCallId),
  );
});

test("google: a functionResponse without an id pairs with the earliest unmatched call", () => {
  const body: GoogleRequestBody = {
    contents: [
      { role: "user", parts: [{ text: "go" }] },
      {
        role: "model",
        parts: [
          { functionCall: { name: "grep", args: { q: "x" } } },
          { functionCall: { name: "grep", args: { q: "y" } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "grep", response: { output: "hit" } } },
        ],
      },
    ],
  };
  const calls = googleToCore(body).msgs.filter(
    (m) => m.contentType === "tool-call",
  );
  const result = googleToCore(body).msgs.find(
    (m) => m.contentType === "tool-result",
  );
  assert.equal(calls[0]!.toolCallId, result!.toolCallId);
  assert.notEqual(calls[0]!.toolCallId, calls[1]!.toolCallId);
  assert.equal(
    result!.toolCallId,
    googleToCore(structuredClone(body)).msgs.find(
      (m) => m.contentType === "tool-result",
    )!.toolCallId,
  );
});

test("google: sidecar signature and image rebuild a core that lost its raw parts", () => {
  const { msgs } = googleToCore(ompBody());
  // Simulate a core whose raw parts array is gone (a host-set message), where
  // only the scalar sidecars remain.
  const rebuilt = coreToGoogle(msgs.map(({ rawGoogleParts, ...rest }) => rest));
  // #3642: the [text, image] user run rebuilds as ONE content with the
  // text part first and the image core's sidecar re-rendered as inlineData
  // (the "[image]" marker never re-renders as a text part).
  assert.deepEqual(rebuilt[0]!.parts, [
    { text: "run the tests" },
    { inlineData: { mimeType: "image/png", data: IMG } },
  ]);
  assert.deepEqual(rebuilt[1]!.parts, [
    {
      text: "List the files first.",
      thought: true,
      thoughtSignature: "sig-think",
    },
    { text: "Listing the tree.", thoughtSignature: "sig-text" },
    {
      functionCall: { name: "bash", args: { cmd: "ls" }, id: "call_list" },
      thoughtSignature: SENTINEL,
    },
  ]);
  assert.deepEqual(rebuilt[2]!.parts, [
    {
      functionResponse: {
        name: "bash",
        response: { output: "a.ts\nb.ts" },
        id: "call_list",
      },
    },
    {
      functionResponse: {
        name: "bash",
        response: { output: "second, no id" },
        id: msgs[6]!.toolCallId,
      },
    },
  ]);
});

test("detectWireFormat routes Gemini bodies by their contents array", () => {
  assert.equal(detectWireFormat({ contents: [] }), "google");
  assert.equal(detectWireFormat(ompBody()), "google");
  assert.ok(WIRE_FORMATS.includes("google"));
  assert.ok(isWireFormat("google"));
  assert.equal(
    detectWireFormat({ messages: [{ role: "user", content: "hi" }] }),
    "openai",
  );
  assert.equal(detectWireFormat({ input: [] }), "responses");
  assert.equal(detectWireFormat(null), undefined);
});

test("conversationSignalGoogle prefers the header over the content fingerprint", () => {
  const body = ompBody();
  assert.equal(conversationSignalGoogle(body, "  sess-42  "), "sess-42");
  const fingerprint = conversationSignalGoogle(body);
  assert.equal(fingerprint, conversationSignalGoogle(structuredClone(body)));
  assert.notEqual(
    fingerprint,
    conversationSignalGoogle({
      contents: [{ role: "user", parts: [{ text: "other" }] }],
    }),
  );
});

test("injectGoogleSystem goes into the leading user content, else prepends one", () => {
  const contents = [{ role: "user", parts: [{ text: "hi" }] }];
  assert.deepEqual(injectGoogleSystem(contents, ["S"]), [
    { role: "user", parts: [{ text: "S" }, { text: "hi" }] },
  ]);
  assert.deepEqual(
    injectGoogleSystem([{ role: "model", parts: [{ text: "m" }] }], ["S"]),
    [
      { role: "user", parts: [{ text: "S" }] },
      { role: "model", parts: [{ text: "m" }] },
    ],
  );
  assert.equal(injectGoogleSystem(contents, []), contents);
});

test("google: edited core text re-renders plain while sibling raw parts and signature survive", () => {
  const body: GoogleRequestBody = {
    contents: [
      { role: "user", parts: [{ text: "go" }] },
      {
        role: "model",
        parts: [
          { text: "hello", thoughtSignature: "sig-t" },
          { videoMetadata: { startOffset: 0 } },
        ],
      },
    ],
  };
  const { msgs } = googleToCore(body);
  const modelText = msgs.find(
    (m) => m.role === "assistant" && m.contentType === "text",
  )!;
  assert.equal(modelText.googleThoughtSignature, "sig-t");
  modelText.text = "hello [m00002]";
  const contents = coreToGoogle(msgs);
  assert.deepEqual(contents[1]!.parts, [
    { text: "hello [m00002]", thoughtSignature: "sig-t" },
    { videoMetadata: { startOffset: 0 } },
  ]);
});

test("normalizeGoogleUserPartOrder: stable partition; signed/thought/non-text parts never move", () => {
  const fr: GooglePart = {
    functionResponse: { name: "add", response: { result: 66 }, id: "c1" },
  };
  const pure: GooglePart[] = [
    { text: "hello" },
    { inlineData: { mimeType: "image/png", data: "x" } },
  ];
  assert.equal(normalizeGoogleUserPartOrder(pure), pure);
  assert.deepEqual(
    normalizeGoogleUserPartOrder([
      fr,
      { text: "nudge" },
      { inlineData: { mimeType: "image/png", data: "x" } },
      { text: "more" },
    ]),
    [
      { text: "nudge" },
      { text: "more" },
      fr,
      { inlineData: { mimeType: "image/png", data: "x" } },
    ],
  );
  const signed: GooglePart = { text: "signed", thoughtSignature: "sig" };
  const thought: GooglePart = { text: "thinking", thought: true };
  assert.deepEqual(
    normalizeGoogleUserPartOrder([fr, signed, thought, { text: "plain" }]),
    [{ text: "plain" }, fr, signed, thought],
  );
});

test("coreToGoogle rebuilds a mixed user run with plain text before functionResponse parts (#3159)", () => {
  const body: GoogleRequestBody = {
    contents: [
      { role: "user", parts: [{ text: "go" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "add", args: { a: 37, b: 29 }, id: "c1" } }],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "add", response: { result: 66 }, id: "c1" } },
          { text: "nudge" },
        ],
      },
    ],
  };
  const contents = coreToGoogle(googleToCore(body).msgs);
  assert.deepEqual(contents[2]!.parts, [
    { text: "nudge" },
    { functionResponse: { name: "add", response: { result: 66 }, id: "c1" } },
  ]);
});

test("an already-safe user part order round-trips byte-identical through coreToGoogle (#3159)", () => {
  const body: GoogleRequestBody = {
    contents: [
      { role: "user", parts: [{ text: "go" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "add", args: { a: 37, b: 29 }, id: "c1" } }],
      },
      {
        role: "user",
        parts: [
          { text: "nudge" },
          { functionResponse: { name: "add", response: { result: 66 }, id: "c1" } },
        ],
      },
    ],
  };
  assert.deepEqual(coreToGoogle(googleToCore(body).msgs), body.contents);
});
