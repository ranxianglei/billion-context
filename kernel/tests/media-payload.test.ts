import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiToCore, coreToOpenai } from "../src/wire/openai.js";
import type { OpenAIRequestBody } from "../src/wire/openai.js";
import {
  hasMediaPayload,
  hasUnrecoverableMediaPayload,
} from "../src/protected.js";
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
  // #3642 canonical granularity: the text part is its own core carrying the
  // part's bytes verbatim (no "\n" joining anymore); the opaque file part
  // rides the preceding text core's plural sidecar so the rebuild keeps the
  // wire part order. The id derives from the part text.
  assert.equal(msgs[0]?.text, "what is in this file?");
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

test("openai: [file, text, file] keeps every opaque part (#1205)", () => {
  const fileA = { type: "file", file_id: "file-api-aaa" };
  const fileB = { type: "file", file_id: "file-api-bbb" };
  const body = bodyOf([
    {
      role: "user",
      content: [
        fileA,
        { type: "text", text: "compare these files" },
        fileB,
      ],
    },
  ]);
  const { msgs } = openaiToCore(body);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]?.text, "compare these files");
  // The leading-opaque flush must not clobber the part accumulated AFTER
  // the text core: both ride the plural sidecar, relative order intact.
  assert.deepEqual(msgs[0]?.rawOpenaiContentParts, [fileA, fileB]);

  const content = rebuiltUserContent(
    msgs,
  ) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content, [
    { type: "text", text: "compare these files" },
    fileA,
    fileB,
  ]);
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
  // #3642: [text, image] splits into a text core + an image core carrying
  // the canonical "[image]" marker; the singular raw sidecar lives on the
  // image core. The rebuild merges the run back into ONE message with the
  // marker never re-rendered as a text part.
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]?.text, "look");
  assert.equal(msgs[0]?.rawOpenaiContent, undefined);
  assert.equal(msgs[1]?.text, "[image]");
  assert.ok(msgs[1]?.rawOpenaiContent, "singular sidecar preserved");
  assert.equal(
    msgs[1]?.rawOpenaiContentParts,
    undefined,
    "no plural sidecar for a lone image",
  );
  assert.equal(msgs[1]?.imageBase64, IMG_DATA);
  assert.equal(msgs[1]?.imageMediaType, "image/png");

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
  // #3642: each image is its own core with its singular raw sidecar; the
  // rebuild merges the [text, image, image] run back into one message.
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0]?.text, "two pics");
  assert.ok(msgs[1]?.rawOpenaiContent);
  assert.ok(msgs[2]?.rawOpenaiContent);
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

test("hasUnrecoverableMediaPayload pins only media whose bytes bili cannot store", () => {
  assert.equal(
    hasUnrecoverableMediaPayload(textMsg("a", "user", "x")),
    false,
  );
  // OpenAI chat
  assert.equal(
    hasUnrecoverableMediaPayload(mediaUserMsg("b", "x", { imageBase64: "AQ" })),
    false,
    "bare imageBase64 sidecar carries no external ref",
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("c", "x", {
        rawOpenaiContent: { type: "image_url", image_url: { url: DATA_URL } },
      }),
    ),
    false,
    "singular data-URL image is archivable",
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("d", "x", {
        rawOpenaiContent: {
          type: "image_url",
          image_url: { url: "https://example.com/x.png" },
        },
      }),
    ),
    true,
    "remote URL image cannot be archived",
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("e", "x", { rawOpenaiContent: FILE_PART }),
    ),
    true,
    "opaque part in singular slot pins",
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("f", "x", {
        rawOpenaiContentParts: [
          { type: "image_url", image_url: { url: DATA_URL } },
        ],
      }),
    ),
    false,
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("g", "x", {
        rawOpenaiContentParts: [
          { type: "image_url", image_url: { url: DATA_URL } },
          { type: "image_url", image_url: { url: "https://example.com/y.png" } },
        ],
      }),
    ),
    true,
    "one remote URL among inline images pins the whole message",
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("h", "x", { rawOpenaiContentParts: [FILE_PART] }),
    ),
    true,
    "DeepSeek file ref pins (#1205 payload remains unrecoverable)",
  );
  // Anthropic
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("i", "x", {
        rawAnthropicBlock: {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: IMG_DATA },
        },
      }),
    ),
    false,
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("j", "x", {
        rawAnthropicBlock: {
          type: "image",
          source: { type: "url", url: "https://example.com/x.png" },
        },
      }),
    ),
    true,
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("k", "x", {
        rawAnthropicBlock: {
          type: "image",
          source: { type: "url", url: DATA_URL },
        },
      }),
    ),
    false,
    "data: URL in a url source still carries bytes",
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("l", "x", {
        rawAnthropicBlock: { type: "redacted_thinking", data: "xxx" },
      }),
    ),
    false,
    "thinking-family carriers are not media",
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("m", "x", {
        rawAnthropicBlock: {
          type: "tool_result",
          content: [
            {
              type: "document",
              source: { type: "url", url: "https://example.com/d.pdf" },
            },
          ],
        },
      }),
    ),
    true,
    "non-image tool_result content blocks pin",
  );
  // Responses
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("n", "x", {
        rawResponsesItem: {
          content: [{ type: "input_image", image_url: DATA_URL }],
        },
      }),
    ),
    false,
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("o", "x", {
        rawResponsesItem: {
          content: [
            { type: "input_image", image_url: "https://example.com/x.png" },
          ],
        },
      }),
    ),
    true,
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("p", "x", {
        rawResponsesItem: {
          type: "custom_tool_call_output",
          output: [{ type: "input_image", image_url: DATA_URL }],
        },
      }),
    ),
    false,
    "tool-output nested input_image is archivable",
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("q", "x", {
        rawResponsesItem: {
          type: "message",
          content: [{ type: "input_text", text: "hi" }],
        },
      }),
    ),
    false,
  );
  // Google
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("r", "x", {
        rawGoogleParts: [
          { inlineData: { mimeType: "image/png", data: IMG_DATA } },
        ],
      }),
    ),
    false,
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("s", "x", {
        rawGoogleParts: [
          { fileData: { mimeType: "image/png", fileUri: "gs://bucket/img.png" } },
        ],
      }),
    ),
    true,
    "fileData URI ref pins (#2609)",
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("t", "x", {
        rawGoogleParts: [{ videoMetadata: { startTime: "0.0" } }],
      }),
    ),
    true,
    "videoMetadata reference pins",
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("u", "x", {
        rawGoogleParts: [
          {
            functionResponse: {
              name: "screenshot",
              parts: [
                { fileData: { mimeType: "image/png", fileUri: "gs://b/i.png" } },
              ],
            },
          },
        ],
      }),
    ),
    true,
    "nested functionResponse fileData pins",
  );
  assert.equal(
    hasUnrecoverableMediaPayload(
      mediaUserMsg("v", "x", { rawGoogleParts: [{ text: "plain" }] }),
    ),
    false,
  );
});

test("assignRefs folds archivable media like text and pins unrecoverable media", () => {
  const messages = [
    textMsg("a", "user", "alpha"),
    mediaUserMsg("img", "", { imageBase64: IMG_DATA }),
    mediaUserMsg("file", "", { rawOpenaiContentParts: [FILE_PART] }),
    textMsg("b", "assistant", "beta"),
  ];
  const state = createInitialState();
  const res = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
    isProtected: hasUnrecoverableMediaPayload,
  });
  assert.equal(res.map.byRaw["a"], "m00001");
  assert.equal(res.map.byRaw["img"], "m00002");
  assert.equal(res.map.byRaw["file"], BLOCKED_REF);
  assert.equal(res.map.byRaw["b"], "m00003");
});

test("assignRefs migrates a legacy BLOCKED ref to a fresh number when protection lifts", () => {
  const messages = [
    textMsg("a", "user", "alpha"),
    mediaUserMsg("img", "", { imageBase64: IMG_DATA }),
    textMsg("b", "assistant", "beta"),
  ];
  const state = createInitialState();
  // Legacy session shape: the image was pinned under #1188 before #2607 lifted
  // the exemption for archivable media.
  state.messageRefs.byRaw["a"] = "m00001";
  state.messageRefs.byRaw["img"] = BLOCKED_REF;
  state.messageRefs.byRaw["b"] = "m00002";
  const res = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 3,
    isProtected: hasUnrecoverableMediaPayload,
  });
  assert.equal(res.map.byRaw["a"], "m00001");
  assert.equal(res.map.byRaw["img"], "m00003", "fresh number — never a reuse");
  assert.equal(res.map.byRaw["b"], "m00002");
});

test("buildCompressibleRanges spans archivable media (foldable since #2607)", () => {
  const messages = [
    textMsg("a", "user", "alpha ".repeat(50).trim()),
    mediaUserMsg("img", "see attached", { imageBase64: IMG_DATA }),
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
  const mediaIndex = messages.findIndex((m) => m.id === "img");
  assert.ok(
    ranges.compressible.some((r) => {
      const s = refToIndex.get(r.startRef)!;
      const e = refToIndex.get(r.endRef)!;
      return s <= mediaIndex && mediaIndex <= e;
    }),
    "archivable media no longer splits the compressible range",
  );
});

test("buildCompressibleRanges still never spans an unrecoverable media message", () => {
  const messages = [
    textMsg("a", "user", "alpha ".repeat(50).trim()),
    mediaUserMsg("img", "see attached", {
      rawOpenaiContentParts: [FILE_PART],
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
  const mediaIndex = messages.findIndex((m) => m.id === "img");
  for (const r of ranges.compressible) {
    const s = refToIndex.get(r.startRef)!;
    const e = refToIndex.get(r.endRef)!;
    assert.ok(
      !(s <= mediaIndex && mediaIndex <= e),
      `range ${r.startRef}..${r.endRef} must not span the unrecoverable media message`,
    );
  }
  for (const r of ranges.protected) {
    const s = refToIndex.get(r.startRef)!;
    const e = refToIndex.get(r.endRef)!;
    assert.ok(
      !(s <= mediaIndex && mediaIndex <= e),
      "unrecoverable media must not be advertised as protected either",
    );
  }
  assert.ok(
    ranges.compressible.length >= 1,
    "non-media messages stay compressible",
  );
});

test("applyCompression folds archivable media into the block (#2607)", () => {
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
  assert.deepEqual(block.directMessageIds.sort(), ["img", "t1", "t2", "u"]);
  assert.ok(
    !result.result.warnings.some((w) => w.includes("unrecoverable")),
    `no unrecoverable warning expected, got: ${JSON.stringify(result.result.warnings)}`,
  );
});

test("applyCompression excludes unrecoverable media from the block and warns", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    textMsg("u", "user", "the task"),
    textMsg("t1", "assistant", "thinking out loud"),
    mediaUserMsg("img", "see the screenshot", {
      rawOpenaiContentParts: [FILE_PART],
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
    !block.directMessageIds.includes("img"),
    "unrecoverable media not folded",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("img"),
    "unrecoverable media not recorded as covered",
  );
  assert.deepEqual(block.directMessageIds.sort(), ["t1", "t2", "u"]);
  assert.ok(
    result.result.warnings.some((w) => w.includes("unrecoverable media")),
    `warning present, got: ${JSON.stringify(result.result.warnings)}`,
  );
});

// --- Anthropic tool_result embedded media (#366) ---

const TR_IMG = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: IMG_DATA },
};
const TR_IMG_URL = {
  type: "image",
  source: { type: "url", url: "https://example.com/x.png" },
};

function mediaToolResult(
  id: string,
  text: string,
  img: object = TR_IMG,
): CoreMessage {
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
        content: [{ type: "text", text: "done" }, img],
      },
    },
  );
}

test("media predicates split tool_result images by recoverability", () => {
  assert.equal(
    hasMediaPayload(mediaToolResult("r", "done\n")),
    true,
    "image block in content array counts as media payload",
  );
  assert.equal(
    hasUnrecoverableMediaPayload(mediaToolResult("r", "done\n")),
    false,
    "base64 image is archivable",
  );
  assert.equal(
    hasUnrecoverableMediaPayload(mediaToolResult("ru", "done\n", TR_IMG_URL)),
    true,
    "remote URL image cannot be archived",
  );
});

test("buildCompressibleRanges spans an archivable media tool_result with its call (#2607)", () => {
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
  assert.ok(
    ranges.compressible.some((r) => {
      const s = refToIndex.get(r.startRef)!;
      const e = refToIndex.get(r.endRef)!;
      return s <= resIdx && resIdx <= e;
    }),
    "archivable media tool_result no longer splits the range",
  );
  assert.ok(
    ranges.compressible.some((r) => {
      const s = refToIndex.get(r.startRef)!;
      const e = refToIndex.get(r.endRef)!;
      return s <= callIdx && callIdx <= e;
    }),
    "its paired call stays foldable too",
  );
});

test("buildCompressibleRanges still never spans an unrecoverable media tool_result and never strands its call", () => {
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
    mediaToolResult("res", "done\n", TR_IMG_URL),
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
      `range ${r.startRef}..${r.endRef} must not span the unrecoverable media tool_result`,
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

test("applyCompression folds an archivable media tool_result with its paired call (#2607)", () => {
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
  assert.deepEqual(block.directMessageIds.sort(), ["call", "res", "u", "u2"]);
  assert.ok(
    !result.result.warnings.some((w) => w.includes("unrecoverable")),
    `no unrecoverable warning expected, got: ${JSON.stringify(result.result.warnings)}`,
  );
  assert.ok(
    !result.result.warnings.some((w) => w.includes("tool call/result pair")),
    `no pair-withdrawal expected, got: ${JSON.stringify(result.result.warnings)}`,
  );
});

test("applyCompression keeps an unrecoverable media tool_result and its paired call visible together", () => {
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
    mediaToolResult("res", "done\n", TR_IMG_URL),
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
    "unrecoverable media tool_result not folded",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("call"),
    "paired call withdrawn with its result (pair atomicity)",
  );
  assert.ok(
    result.result.warnings.some((w) => w.includes("unrecoverable media")),
    `media warning present, got: ${JSON.stringify(result.result.warnings)}`,
  );
  assert.ok(
    result.result.warnings.some((w) => w.includes("tool call/result pair")),
    `pair-withdrawal warning present, got: ${JSON.stringify(result.result.warnings)}`,
  );
});

test("openai: non-array single-object content never throws (legacy empty-text core)", () => {
  // #2824 corpus regression: some clients emit a lone content-part object
  // instead of an array. Pre-#3642 this mapped to stringContent() === ""
  // with no sidecars; the #3642 per-part rewrite iterated `m.content` and
  // threw TypeError "m.content is not iterable" — a wire-tolerance break
  // (buildIncomingImageIndex catches, but every other consumer would not).
  // Contract: non-array non-string content degrades to the legacy empty-text
  // core, byte-compatible with the old codec, and coreToOpenai still renders
  // a round-trippable body.
  const body = bodyOf([
    {
      role: "user",
      content: {
        type: "image_url",
        image_url: { url: DATA_URL },
      },
    },
  ]);
  const { msgs } = openaiToCore(body);
  assert.equal(msgs.length, 1, "one core, not a throw");
  assert.equal(msgs[0]?.contentType, "text");
  assert.equal(msgs[0]?.text, "", "legacy mapping: stringContent(object) === ''");
  assert.equal(msgs[0]?.imageBase64, undefined, "no image sidecar from non-array content");
  const back = coreToOpenai(msgs as Parameters<typeof coreToOpenai>[0]);
  assert.ok(
    Array.isArray(back) && back.length >= 1,
    "round-trip renders",
  );
});
