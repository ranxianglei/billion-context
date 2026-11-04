import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractMediaRefs,
  hasRefRecoverableMediaPayload,
  collectFoldMediaRefs,
  appendMediaRefsSection,
  parseMediaRefsSection,
  MEDIA_REFS_MARKER,
} from "../src/media-refs.js";
import { hasUnrecoverableMediaPayload } from "../src/protected.js";
import { assignRefs, BLOCKED_REF } from "../src/refs.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

const DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAASUVORK5CYII=";
const REMOTE_URL = "https://example.com/screenshot.png";
const FILE_PART = { type: "file", file_id: "file-api-abc123" };

function textMsg(id: string, role: CoreMessage["role"], text: string): CoreMessage {
  return { id, role, contentType: "text", text };
}

function sidecarMsg(id: string, extra: object): CoreMessage {
  return Object.assign(
    { id, role: "user" as const, contentType: "text" as const, text: "" },
    extra,
  );
}

function config(): Config {
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
  };
}

// --- Extraction matrix (#5620): known ref shapes only, conservative ---

test("extractMediaRefs pulls handles from every wire sidecar family", () => {
  assert.deepEqual(
    extractMediaRefs(
      sidecarMsg("a", {
        rawOpenaiContent: { type: "image_url", image_url: { url: REMOTE_URL } },
      }),
    ),
    [REMOTE_URL],
    "openai singular image_url",
  );
  assert.deepEqual(
    extractMediaRefs(sidecarMsg("b", { rawOpenaiContent: FILE_PART })),
    ["file-api-abc123"],
    "openai singular file part",
  );
  assert.deepEqual(
    extractMediaRefs(
      sidecarMsg("c", {
        rawOpenaiContentParts: [
          { type: "image_url", image_url: { url: DATA_URL } },
          { type: "image_url", image_url: { url: REMOTE_URL } },
          FILE_PART,
        ],
      }),
    ),
    [REMOTE_URL, "file-api-abc123"],
    "openai plural — data: URL excluded, order stable, deduped",
  );
  assert.deepEqual(
    extractMediaRefs(
      sidecarMsg("d", {
        rawAnthropicBlock: {
          type: "image",
          source: { type: "url", url: REMOTE_URL },
        },
      }),
    ),
    [REMOTE_URL],
    "anthropic image url source",
  );
  assert.deepEqual(
    extractMediaRefs(
      sidecarMsg("e", {
        rawAnthropicBlock: {
          type: "tool_result",
          content: [
            { type: "text", text: "done" },
            { type: "image", source: { type: "url", url: REMOTE_URL } },
          ],
        },
      }),
    ),
    [REMOTE_URL],
    "anthropic tool_result embedded image",
  );
  assert.deepEqual(
    extractMediaRefs(
      sidecarMsg("f", {
        rawResponsesItem: {
          content: [
            { type: "input_image", image_url: DATA_URL },
            { type: "input_image", image_url: REMOTE_URL },
          ],
        },
      }),
    ),
    [REMOTE_URL],
    "responses content input_image",
  );
  assert.deepEqual(
    extractMediaRefs(
      sidecarMsg("g", {
        rawResponsesItem: { type: "input_image", image_url: REMOTE_URL },
      }),
    ),
    [REMOTE_URL],
    "responses top-level input_image",
  );
  assert.deepEqual(
    extractMediaRefs(
      sidecarMsg("h", {
        rawGoogleParts: [
          { inlineData: { mimeType: "image/png", data: "AQ==" } },
          { fileData: { mimeType: "image/png", fileUri: "gs://bucket/img.png" } },
          {
            functionResponse: {
              name: "screenshot",
              parts: [{ fileData: { mimeType: "image/png", fileUri: "gs://b/i.png" } }],
            },
          },
        ],
      }),
    ),
    ["gs://bucket/img.png", "gs://b/i.png"],
    "google parts incl. nested functionResponse",
  );
  assert.deepEqual(
    extractMediaRefs(textMsg("i", "user", "plain text")),
    [],
    "no sidecars — no handles",
  );
  assert.deepEqual(
    extractMediaRefs(
      sidecarMsg("j", {
        rawGoogleParts: [{ videoMetadata: { startTime: "0.0" } }],
      }),
    ),
    [],
    "videoMetadata carries no fetchable handle",
  );
});

test("hasRefRecoverableMediaPayload splits the old pinned class", () => {
  const refBased = sidecarMsg("r", {
    rawOpenaiContentParts: [FILE_PART],
  });
  const refless = sidecarMsg("x", {
    rawOpenaiContentParts: [{ type: "mystery", blob: "zzz" }],
  });
  assert.equal(hasRefRecoverableMediaPayload(refBased), true);
  assert.equal(hasUnrecoverableMediaPayload(refBased), false, "#5620 flip");
  assert.equal(hasRefRecoverableMediaPayload(refless), false);
  assert.equal(hasUnrecoverableMediaPayload(refless), true, "conservative pin");
});

// --- Section mechanics: deterministic, idempotent, lossless across folds ---

test("appendMediaRefsSection is idempotent and replaces a stale twin", () => {
  const base = "Work summary bullets.";
  const once = appendMediaRefsSection(base, [REMOTE_URL]);
  assert.equal(once, `${base}\n\n${MEDIA_REFS_MARKER}\n- ${REMOTE_URL}`);
  assert.equal(appendMediaRefsSection(once, [REMOTE_URL]), once, "idempotent");
  // A model-written twin (or a stale one from a previous fold) never doubles.
  const stale = `${base}\n\n${MEDIA_REFS_MARKER}\n- https://old.example.com/a.png`;
  const replaced = appendMediaRefsSection(stale, [REMOTE_URL]);
  assert.ok(!replaced.includes("https://old.example.com/a.png"));
  assert.equal(replaced, once);
  assert.equal(appendMediaRefsSection(base, []), base, "empty refs — untouched");
});

test("parseMediaRefsSection round-trips and tolerates absence", () => {
  const s = appendMediaRefsSection("x", [REMOTE_URL, "file-api-abc123"]);
  assert.deepEqual(parseMediaRefsSection(s), [REMOTE_URL, "file-api-abc123"]);
  assert.deepEqual(parseMediaRefsSection("no section here"), []);
});

test("collectFoldMediaRefs unions direct extraction with consumed-block carry", () => {
  const direct = sidecarMsg("d", {
    rawOpenaiContent: { type: "image_url", image_url: { url: REMOTE_URL } },
  });
  const carriedBlock = {
    summary: `old\n\n${MEDIA_REFS_MARKER}\n- file-api-abc123`,
  };
  assert.deepEqual(
    collectFoldMediaRefs([direct, undefined], [carriedBlock as never]),
    [REMOTE_URL, "file-api-abc123"],
  );
  assert.deepEqual(collectFoldMediaRefs([], []), []);
});

// --- Apply path: the handle rides the stored summary, through merges too ---

test("applyCompression records ref-based media handles in the block summary (#5620)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    textMsg("u", "user", "the task"),
    sidecarMsg("img", {
      rawOpenaiContent: { type: "image_url", image_url: { url: REMOTE_URL } },
    }),
    textMsg("t", "assistant", "analyzing"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: "folded work", topic: "t" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.errors.length, 0, JSON.stringify(result.result.errors));
  const block = result.state.blocks[0]!;
  assert.ok(block.summary.includes(MEDIA_REFS_MARKER));
  assert.ok(block.summary.includes(`- ${REMOTE_URL}`));
});

test("a block-boundary merge carries every source block's handles forward (#5620)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    textMsg("u1", "user", "first task"),
    sidecarMsg("img1", {
      rawOpenaiContent: { type: "image_url", image_url: { url: REMOTE_URL } },
    }),
    textMsg("u2", "user", "second task"),
    sidecarMsg("file2", { rawOpenaiContentParts: [FILE_PART] }),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const r1 = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "first fold", topic: "a" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(r1.result.errors.length, 0, JSON.stringify(r1.result.errors));
  const r2 = core.applyCompression({
    ranges: [{ startRef: "m00003", endRef: "m00004", summary: "second fold", topic: "b" }],
    messages,
    state: r1.state,
    config: config(),
  });
  assert.equal(r2.result.errors.length, 0, JSON.stringify(r2.result.errors));

  const merged = core.applyCompression({
    ranges: [{ startRef: "b1", endRef: "b2", summary: "distilled both", topic: "c" }],
    messages,
    state: r2.state,
    config: config(),
  });
  assert.equal(merged.result.errors.length, 0, JSON.stringify(merged.result.errors));
  const final = merged.state.blocks.find((b) => b.active)!;
  assert.deepEqual(final.directBlockIds.sort(), ["b1", "b2"]);
  const refs = parseMediaRefsSection(final.summary);
  assert.deepEqual(
    refs,
    [REMOTE_URL, "file-api-abc123"],
    "both source handles survive the merge verbatim",
  );
});

// --- Legacy sessions: BLOCKED refs minted pre-#5620 migrate to numbers ---

test("legacy BLOCKED ref on ref-based media migrates to a fresh number (#5620)", () => {
  const messages = [
    textMsg("a", "user", "alpha"),
    sidecarMsg("refimg", {
      rawOpenaiContent: { type: "image_url", image_url: { url: REMOTE_URL } },
    }),
    textMsg("b", "assistant", "beta"),
  ];
  const state = createInitialState();
  state.messageRefs.byRaw["a"] = "m00001";
  state.messageRefs.byRaw["refimg"] = BLOCKED_REF;
  state.messageRefs.byRaw["b"] = "m00002";
  const res = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 3,
    isProtected: hasUnrecoverableMediaPayload,
  });
  assert.equal(res.map.byRaw["refimg"], "m00003", "fresh number — never a reuse");
});
