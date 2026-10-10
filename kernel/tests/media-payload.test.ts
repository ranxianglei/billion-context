import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiToCore, coreToOpenai } from "../src/wire/openai.js";
import type { OpenAIRequestBody } from "../src/wire/openai.js";
import { googleToCore, coreToGoogle } from "../src/wire/google.js";
import type { GoogleRequestBody } from "../src/wire/google.js";
import { hasMediaPayload } from "../src/protected.js";
import { assignRefs, BLOCKED_REF } from "../src/refs.js";
import { buildCompressibleRanges } from "../src/recommend.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

const IMG_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const DATA_URL = `data:image/png;base64,${IMG_DATA}`;
// DeepSeek Files API attachment ref — an unknown part type on the OpenAI chat wire.
const FILE_PART = { type: "file", file_id: "file-api-abc123" };

function bodyOf(messages: OpenAIRequestBody["messages"]): OpenAIRequestBody {
  return { model: "test", messages };
}

function textMsg(
  id: string,
  role: CoreMessage["role"],
  text: string,
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function mediaUserMsg(id: string, text: string, extra: object): CoreMessage {
  return Object.assign(
    { id, role: "user" as const, contentType: "text" as const, text },
    extra,
  );
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 6000,
      growthCap: 50000,
      minGrowthFloor: 5000,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function rebuiltUserContent(
  msgs: CoreMessage[],
): Array<Record<string, unknown>> | string {
  const rebuilt = coreToOpenai(msgs as Parameters<typeof coreToOpenai>[0]);
  const user = rebuilt.find((m) => m.role === "user")!;
  return user.content as Array<Record<string, unknown>> | string;
}

// --- Wire round-trip: unknown parts must survive (billion-context#1205) ---

test("openai: [text, file] round-trips the file part verbatim", () => {
  const body = bodyOf([
    {
      role: "user",
      content: [{ type: "text", text: "what is in this file?" }, FILE_PART],
    },
  ]);
  const { msgs } = openaiToCore(body);
  assert.equal(msgs.length, 1);
  // Pre-existing stringContent semantics: array entries join with "\n" and
  // non-text entries contribute "" — same as today's [text, image] messages.
  // The id derives from this text, so the shape must not change.
  assert.equal(msgs[0]?.text, "what is in this file?\n");
  assert.deepEqual(
    msgs[0]?.rawOpenaiContentParts,
    [FILE_PART],
    "opaque part rides the plural sidecar",
  );
  assert.equal(
    msgs[0]?.rawOpenaiContent,
    undefined,
    "singular sidecar not used for non-image parts",
  );

  const content = rebuiltUserContent(msgs);
  assert.ok(Array.isArray(content));
  assert.equal((content as Array<Record<string, unknown>>)[0]?.type, "text");
  assert.deepEqual(
    (content as Array<Record<string, unknown>>)[1],
    FILE_PART,
    "file part re-emitted verbatim",
  );
});

test("openai: lone [file] part survives with empty text", () => {
  const body = bodyOf([{ role: "user", content: [FILE_PART] }]);
  const { msgs } = openaiToCore(body);
  assert.equal(msgs[0]?.text, "");
  const content = rebuiltUserContent(msgs);
  assert.ok(Array.isArray(content));
  assert.deepEqual(content, [FILE_PART]);
});

test("openai: [text, file, image] keeps wire order of non-text parts", () => {
  const body = bodyOf([
    {
      role: "user",
      content: [
        { type: "text", text: "compare these" },
        FILE_PART,
        { type: "image_url", image_url: { url: DATA_URL } },
      ],
    },
  ]);
  const { msgs } = openaiToCore(body);
  const content = rebuiltUserContent(msgs);
  assert.ok(Array.isArray(content));
  const types = (content as Array<Record<string, unknown>>).map((p) => p.type);
  assert.deepEqual(types, ["text", "file", "image_url"]);
  assert.deepEqual((content as Array<Record<string, unknown>>)[1], FILE_PART);
});

test("openai: single data-URL image keeps legacy singular sidecar shape", () => {
  const body = bodyOf([
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: DATA_URL } },
      ],
    },
  ]);
  const { msgs } = openaiToCore(body);
  assert.ok(msgs[0]?.rawOpenaiContent, "singular sidecar preserved");
  assert.equal(
    msgs[0]?.rawOpenaiContentParts,
    undefined,
    "no plural sidecar for a lone image",
  );
  assert.equal(msgs[0]?.imageBase64, IMG_DATA);
  assert.equal(msgs[0]?.imageMediaType, "image/png");

  const content = rebuiltUserContent(msgs);
  assert.ok(Array.isArray(content));
  assert.deepEqual((content as Array<Record<string, unknown>>)[1], {
    type: "image_url",
    image_url: { url: DATA_URL },
  });
});

test("openai: multi-image plural sidecar unchanged", () => {
  const body = bodyOf([
    {
      role: "user",
      content: [
        { type: "text", text: "two pics" },
        { type: "image_url", image_url: { url: DATA_URL } },
        { type: "image_url", image_url: { url: "https://example.com/x.png" } },
      ],
    },
  ]);
  const { msgs } = openaiToCore(body);
  assert.equal(msgs[0]?.rawOpenaiContentParts?.length, 2);
  const content = rebuiltUserContent(msgs);
  assert.ok(Array.isArray(content));
  assert.deepEqual(
    (content as Array<Record<string, unknown>>).map((p) => p.type),
    ["text", "image_url", "image_url"],
  );
});

test("openai: plain string and text-only content stay sidecar-free", () => {
  const strBody = bodyOf([{ role: "user", content: "hello" }]);
  const { msgs: strMsgs } = openaiToCore(strBody);
  assert.equal(strMsgs[0]?.rawOpenaiContent, undefined);
  assert.equal(strMsgs[0]?.rawOpenaiContentParts, undefined);
  assert.equal(rebuiltUserContent(strMsgs), "hello");

  const arrBody = bodyOf([
    { role: "user", content: [{ type: "text", text: "just words" }] },
  ]);
  const { msgs: arrMsgs } = openaiToCore(arrBody);
  assert.equal(arrMsgs[0]?.rawOpenaiContentParts, undefined);
  assert.equal(rebuiltUserContent(arrMsgs), "just words");
});

// --- Media payload protection against folding (billion-context#1188) ---

test("hasMediaPayload detects each sidecar carrier and ignores plain/tool-result shapes", () => {
  assert.equal(hasMediaPayload(textMsg("a", "user", "x")), false);
  assert.equal(
    hasMediaPayload(mediaUserMsg("b", "x", { imageBase64: "AQ" })),
    true,
  );
  assert.equal(
    hasMediaPayload(mediaUserMsg("c", "x", { rawOpenaiContent: FILE_PART })),
    true,
  );
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("d", "x", { rawOpenaiContentParts: [FILE_PART] }),
    ),
    true,
  );
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("e", "x", { rawAnthropicBlock: { type: "image" } }),
    ),
    true,
  );
  // The same sidecar field carries structured tool_results — a bare one or a
  // text-only one must NOT count (#366).
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("f", "x", { rawAnthropicBlock: { type: "tool_result" } }),
    ),
    false,
  );
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("j", "x", {
        rawAnthropicBlock: {
          type: "tool_result",
          content: [{ type: "text", text: "done" }],
        },
      }),
    ),
    false,
  );
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("g", "x", {
        rawResponsesItem: { content: [{ type: "input_image" }] },
      }),
    ),
    true,
  );
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("h", "x", {
        rawResponsesItem: { content: [{ type: "input_text" }] },
      }),
    ),
    false,
  );
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("i", "x", { rawResponsesItem: { type: "input_image" } }),
    ),
    true,
  );
});

test("assignRefs gives media messages a BLOCKED ref", () => {
  const messages = [
    textMsg("a", "user", "alpha"),
    mediaUserMsg("img", "", { imageBase64: IMG_DATA }),
    textMsg("b", "assistant", "beta"),
  ];
  const state = createInitialState();
  const res = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
    isProtected: hasMediaPayload,
  });
  assert.equal(res.map.byRaw["a"], "m00001");
  assert.equal(res.map.byRaw["img"], BLOCKED_REF);
  assert.equal(res.map.byRaw["b"], "m00002");
});

test("buildCompressibleRanges never spans a media message", () => {
  const messages = [
    textMsg("a", "user", "alpha ".repeat(50).trim()),
    mediaUserMsg("img", "see attached", { imageBase64: IMG_DATA }),
    textMsg("b", "assistant", "beta ".repeat(50).trim()),
  ];
  const state = createInitialState();
  // Numeric refs for every message (legacy session shape) — protection must
  // hold regardless of ref state.
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const ranges = buildCompressibleRanges(messages, state, config());

  const refToIndex = new Map(
    messages.map((m, i) => [state.messageRefs.byRaw[m.id], i]),
  );
  const mediaIndex = messages.findIndex((m) => m.id === "img");
  for (const r of ranges.compressible) {
    const s = refToIndex.get(r.startRef)!;
    const e = refToIndex.get(r.endRef)!;
    assert.ok(
      !(s <= mediaIndex && mediaIndex <= e),
      `range ${r.startRef}..${r.endRef} must not span the media message`,
    );
  }
  for (const r of ranges.protected) {
    const s = refToIndex.get(r.startRef)!;
    const e = refToIndex.get(r.endRef)!;
    assert.ok(
      !(s <= mediaIndex && mediaIndex <= e),
      "media message must not be advertised as protected either",
    );
  }
  assert.ok(
    ranges.compressible.length >= 1,
    "non-media messages stay compressible",
  );
});

test("applyCompression excludes media messages from the block and warns", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    textMsg("u", "user", "the task"),
    textMsg("t1", "assistant", "thinking out loud"),
    mediaUserMsg("img", "see the screenshot", { imageBase64: IMG_DATA }),
    textMsg("t2", "assistant", "analyzing"),
    textMsg("u2", "user", "and now?"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00004",
        summary: "task + analysis summarized",
        topic: "work",
      },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(
    result.result.errors.length,
    0,
    JSON.stringify(result.result.errors),
  );
  assert.equal(result.state.blocks.length, 1);
  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("img"),
    "media message not folded",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("img"),
    "media message not recorded as covered",
  );
  assert.deepEqual(block.directMessageIds.sort(), ["t1", "t2", "u"]);
  assert.ok(
    result.result.warnings.some((w) => w.includes("image/attachment")),
    `warning present, got: ${JSON.stringify(result.result.warnings)}`,
  );
});

// --- Anthropic tool_result embedded media (#366) ---

const TR_IMG = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: IMG_DATA },
};

function mediaToolResult(id: string, text: string): CoreMessage {
  return Object.assign(
    {
      id,
      role: "tool" as const,
      contentType: "tool-result" as const,
      toolName: "screenshot",
      toolCallId: "t1",
      text,
    },
    {
      rawAnthropicBlock: {
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "text", text: "done" }, TR_IMG],
      },
    },
  );
}

test("hasMediaPayload detects image blocks inside a tool_result sidecar", () => {
  assert.equal(
    hasMediaPayload(mediaToolResult("r", "done\n")),
    true,
    "image block in content array counts as media payload",
  );
});

test("buildCompressibleRanges never spans a media tool_result and never strands its call", () => {
  const messages = [
    textMsg("u", "user", "alpha ".repeat(50).trim()),
    {
      id: "call",
      role: "assistant" as const,
      contentType: "tool-call" as const,
      toolName: "screenshot",
      toolCallId: "t1",
      text: "{}",
    },
    mediaToolResult("res", "done\n"),
    textMsg("b", "assistant", "beta ".repeat(50).trim()),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const ranges = buildCompressibleRanges(messages, state, config());

  const refToIndex = new Map(
    messages.map((m, i) => [state.messageRefs.byRaw[m.id], i]),
  );
  const resIdx = messages.findIndex((m) => m.id === "res");
  const callIdx = messages.findIndex((m) => m.id === "call");
  for (const r of ranges.compressible) {
    const s = refToIndex.get(r.startRef)!;
    const e = refToIndex.get(r.endRef)!;
    assert.ok(
      !(s <= resIdx && resIdx <= e),
      `range ${r.startRef}..${r.endRef} must not span the media tool_result`,
    );
    assert.ok(
      !(s <= callIdx && callIdx <= e),
      `range ${r.startRef}..${r.endRef} must not advertise the call whose result is blocked`,
    );
  }
  assert.ok(
    ranges.compressible.length >= 1,
    "non-media messages stay compressible",
  );
});

test("applyCompression keeps a media tool_result and its paired call visible together", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    textMsg("u", "user", "the task"),
    {
      id: "call",
      role: "assistant" as const,
      contentType: "tool-call" as const,
      toolName: "screenshot",
      toolCallId: "t1",
      text: "{}",
    },
    mediaToolResult("res", "done\n"),
    textMsg("u2", "user", "and now?"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00004",
        summary: "task summarized",
        topic: "work",
      },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(
    result.result.errors.length,
    0,
    JSON.stringify(result.result.errors),
  );
  assert.equal(result.state.blocks.length, 1);
  const block = result.state.blocks[0]!;
  assert.deepEqual(block.directMessageIds.sort(), ["u", "u2"]);
  assert.ok(
    !block.effectiveMessageIds.includes("res"),
    "media tool_result not folded",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("call"),
    "paired call withdrawn with its result (pair atomicity)",
  );
  assert.ok(
    result.result.warnings.some((w) => w.includes("image/attachment")),
    `media warning present, got: ${JSON.stringify(result.result.warnings)}`,
  );
  assert.ok(
    result.result.warnings.some((w) => w.includes("tool call/result pair")),
    `pair-withdrawal warning present, got: ${JSON.stringify(result.result.warnings)}`,
  );
});

// --- Google wire fileData (#2609) ---

const FILE_URI = "https://files.example.com/x.png";
const FILE_DATA_PART = { fileData: { fileUri: FILE_URI, mimeType: "image/png" } };

test("google: [text, fileData] keeps the URL ref on rawGoogleParts and sets no imageBase64", () => {
  const body: GoogleRequestBody = {
    model: "test",
    contents: [
      {
        role: "user",
        parts: [{ text: "what is in this image?" }, FILE_DATA_PART],
      },
    ],
  };
  const { msgs } = googleToCore(body);
  assert.equal(msgs.length, 1);
  const msg = msgs[0]!;
  assert.equal(msg.text, "what is in this image?");
  assert.equal(msg.imageBase64, undefined);
  assert.deepEqual(msg.rawGoogleParts, [
    { text: "what is in this image?" },
    FILE_DATA_PART,
  ]);

  const rebuilt = coreToGoogle([msg]);
  assert.equal(rebuilt.length, 1);
  assert.deepEqual(
    rebuilt[0]?.parts,
    [{ text: "what is in this image?" }, FILE_DATA_PART],
    "fileData re-emitted verbatim",
  );
});

test("hasMediaPayload detects google fileData/inlineData carriers and ignores signature/tool shapes", () => {
  // A URL-referenced file is payload outside msg.text (#2609).
  assert.equal(
    hasMediaPayload(mediaUserMsg("gd1", "", { rawGoogleParts: [FILE_DATA_PART] })),
    true,
    "fileData-only message counts as media",
  );
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("gd2", "see attached", {
        rawGoogleParts: [{ text: "see attached" }, FILE_DATA_PART],
      }),
    ),
    true,
  );
  // inlineData without an extracted imageBase64 sidecar also counts.
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("gd3", "", {
        rawGoogleParts: [{ inlineData: { mimeType: "image/png", data: IMG_DATA } }],
      }),
    ),
    true,
  );
  // Text parts may carry thoughtSignature (KDD #10) — signature metadata is
  // not a payload; thinking parts likewise.
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("gd4", "hello", {
        rawGoogleParts: [{ text: "hello", thoughtSignature: "sig-abc" }],
      }),
    ),
    false,
    "text + signature must not count",
  );
  assert.equal(
    hasMediaPayload({
      id: "gd5",
      role: "assistant",
      contentType: "reasoning",
      text: "hmm",
      rawGoogleParts: [{ text: "hmm", thought: true, thoughtSignature: "sig-def" }],
      googleThoughtSignature: "sig-def",
    }),
    false,
    "thinking + signature must not count",
  );
  // Tool pair members are not media payloads.
  assert.equal(
    hasMediaPayload({
      id: "gd6",
      role: "assistant",
      contentType: "tool-call",
      toolName: "f",
      toolCallId: "t1",
      text: "{}",
      rawGoogleParts: [
        { functionCall: { name: "f", args: {} }, thoughtSignature: "sig-ghi" },
      ],
    }),
    false,
  );
  // Nested media inside a tool response counts — same family as #366.
  assert.equal(
    hasMediaPayload({
      id: "gd7",
      role: "tool",
      contentType: "tool-result",
      toolName: "fetch",
      toolCallId: "t2",
      text: "{}",
      rawGoogleParts: [
        { functionResponse: { name: "fetch", response: {}, parts: [FILE_DATA_PART] } },
      ],
    }),
    true,
    "nested fileData in functionResponse.parts counts",
  );
  assert.equal(
    hasMediaPayload({
      id: "gd8",
      role: "tool",
      contentType: "tool-result",
      toolName: "fetch",
      toolCallId: "t3",
      text: "{}",
      rawGoogleParts: [
        {
          functionResponse: { name: "fetch", response: {}, parts: [{ text: "ok" }] },
        },
      ],
    }),
    false,
    "nested text-only response must not count",
  );
});

test("assignRefs gives a google fileData message a BLOCKED ref", () => {
  const messages = [
    textMsg("a", "user", "alpha"),
    mediaUserMsg("gimg", "", { rawGoogleParts: [FILE_DATA_PART] }),
    textMsg("b", "assistant", "beta"),
  ];
  const state = createInitialState();
  const res = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
    isProtected: hasMediaPayload,
  });
  assert.equal(res.map.byRaw["a"], "m00001");
  assert.equal(res.map.byRaw["gimg"], BLOCKED_REF);
  assert.equal(res.map.byRaw["b"], "m00002");
});

test("buildCompressibleRanges never spans a google fileData message", () => {
  const messages = [
    textMsg("a", "user", "alpha ".repeat(50).trim()),
    mediaUserMsg("gimg", "see attached", {
      rawGoogleParts: [{ text: "see attached" }, FILE_DATA_PART],
    }),
    textMsg("b", "assistant", "beta ".repeat(50).trim()),
  ];
  const state = createInitialState();
  // Numeric refs for every message (legacy session shape) — protection must
  // hold regardless of ref state.
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const ranges = buildCompressibleRanges(messages, state, config());

  const refToIndex = new Map(
    messages.map((m, i) => [state.messageRefs.byRaw[m.id], i]),
  );
  const mediaIndex = messages.findIndex((m) => m.id === "gimg");
  for (const r of ranges.compressible) {
    const s = refToIndex.get(r.startRef)!;
    const e = refToIndex.get(r.endRef)!;
    assert.ok(
      !(s <= mediaIndex && mediaIndex <= e),
      `range ${r.startRef}..${r.endRef} must not span the fileData message`,
    );
  }
  for (const r of ranges.protected) {
    const s = refToIndex.get(r.startRef)!;
    const e = refToIndex.get(r.endRef)!;
    assert.ok(
      !(s <= mediaIndex && mediaIndex <= e),
      "fileData message must not be advertised as protected either",
    );
  }
  assert.ok(
    ranges.compressible.length >= 1,
    "non-media messages stay compressible",
  );
});

test("applyCompression excludes a google fileData message from the block and warns", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    textMsg("u", "user", "the task"),
    textMsg("t1", "assistant", "thinking out loud"),
    mediaUserMsg("gimg", "see the screenshot", {
      rawGoogleParts: [{ text: "see the screenshot" }, FILE_DATA_PART],
    }),
    textMsg("t2", "assistant", "analyzing"),
    textMsg("u2", "user", "and now?"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00004",
        summary: "task + analysis summarized",
        topic: "work",
      },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(
    result.result.errors.length,
    0,
    JSON.stringify(result.result.errors),
  );
  assert.equal(result.state.blocks.length, 1);
  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("gimg"),
    "fileData message not folded",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("gimg"),
    "fileData message not recorded as covered",
  );
  assert.deepEqual(block.directMessageIds.sort(), ["t1", "t2", "u"]);
  assert.ok(
    result.result.warnings.some((w) => w.includes("image/attachment")),
    `warning present, got: ${JSON.stringify(result.result.warnings)}`,
  );
});

test("google: a fileData reference survives a fold of the surrounding range byte-stable", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    textMsg("u", "user", "the task"),
    mediaUserMsg("gimg", "see the screenshot", {
      rawGoogleParts: [{ text: "see the screenshot" }, FILE_DATA_PART],
    }),
    textMsg("t2", "assistant", "analyzing"),
    textMsg("u2", "user", "and now?"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00003",
        summary: "task + analysis summarized",
        topic: "work",
      },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(
    result.result.errors.length,
    0,
    JSON.stringify(result.result.errors),
  );
  const block = result.state.blocks[0]!;
  assert.ok(!block.directMessageIds.includes("gimg"));
  assert.ok(!block.effectiveMessageIds.includes("gimg"));

  const folded = new Set([...block.directMessageIds, ...block.effectiveMessageIds]);
  const survivors = messages.filter((m) => !folded.has(m.id));
  const flatParts = coreToGoogle(survivors).flatMap((c) => c.parts);
  assert.deepEqual(
    flatParts.filter((p) => p.fileData !== undefined),
    [FILE_DATA_PART],
    "rebuilt wire still carries the fileData ref verbatim",
  );
});
