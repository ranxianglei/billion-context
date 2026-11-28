import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractMediaRefs,
  hasRefRecoverableMediaPayload,
  MEDIA_REFS_MARKER,
} from "../src/media-refs.js";
import { hasUnrecoverableMediaPayload } from "../src/protected.js";
import { assignRefs, BLOCKED_REF } from "../src/refs.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

// #6875: DSH read_image / screenshot results carry the image as
// { type: "image", attachment: { attachmentId, mediaType, bytes, ... } } —
// a local blob in the DSH attachment store, addressable by attachmentId
// (blobs verified present by the reporter: 504 attachments, missing = 0).
// The id is a durable re-access handle in the #5620 sense (same class as a
// DeepSeek file_id: a bare id, durable by definition), but extractMediaRefs
// never enumerated the shape, so every such message classified as
// unrecoverable media, pinned forever, and its refs went BLOCKED.
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

function textMsg(
  id: string,
  role: CoreMessage["role"],
  text: string,
): CoreMessage {
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
      tier2GrowthMultiplier: 1.5,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
  };
}

test("extractMediaRefs reads the DSH attachment id from every sidecar family", () => {
  assert.deepEqual(
    extractMediaRefs(sidecarMsg("a", { rawOpenaiContentParts: [DSH_PART] })),
    [DSH_ID],
    "openai plural — the #6875 wire shape (unknown opaque part, #1205)",
  );
  assert.deepEqual(
    extractMediaRefs(sidecarMsg("b", { rawOpenaiContent: DSH_PART })),
    [DSH_ID],
    "openai singular",
  );
  assert.deepEqual(
    extractMediaRefs(
      sidecarMsg("c", {
        rawOpenaiContentParts: [{ type: "text", text: "screenshot" }, DSH_PART],
      }),
    ),
    [DSH_ID],
    "mixed text + attachment parts — only the handle",
  );
});

test("DSH attachment media is ref-recoverable, not unrecoverable (#6875)", () => {
  const openai = sidecarMsg("o", { rawOpenaiContentParts: [DSH_PART] });
  assert.equal(hasRefRecoverableMediaPayload(openai), true);
  assert.equal(
    hasUnrecoverableMediaPayload(openai),
    false,
    "folds like #5620 media",
  );
  const lone = sidecarMsg("p", { rawOpenaiContent: DSH_PART });
  assert.equal(hasRefRecoverableMediaPayload(lone), true);
  assert.equal(
    hasUnrecoverableMediaPayload(lone),
    false,
    "folds like #5620 media",
  );
});

test("an attachment without an id still pins (conservative, #6875)", () => {
  const noId = sidecarMsg("x", {
    rawOpenaiContentParts: [
      { type: "image", attachment: { mediaType: "image/png", bytes: 100 } },
    ],
  });
  assert.deepEqual(extractMediaRefs(noId), []);
  assert.equal(hasRefRecoverableMediaPayload(noId), false);
  assert.equal(
    hasUnrecoverableMediaPayload(noId),
    true,
    "no handle — pre-#5620 pin",
  );
  const emptyId = sidecarMsg("y", {
    rawOpenaiContentParts: [
      { type: "image", attachment: { attachmentId: "" } },
    ],
  });
  assert.deepEqual(extractMediaRefs(emptyId), []);
  assert.equal(hasUnrecoverableMediaPayload(emptyId), true);
  const nonObject = sidecarMsg("z", {
    rawOpenaiContentParts: [{ type: "image", attachment: "sha256:abc" }],
  });
  assert.deepEqual(extractMediaRefs(nonObject), []);
  assert.equal(hasUnrecoverableMediaPayload(nonObject), true);
});

test("a DSH image message gets a numeric ref, never BLOCKED (#6875)", () => {
  const messages = [
    textMsg("a", "user", "alpha"),
    sidecarMsg("dshimg", { rawOpenaiContentParts: [DSH_PART] }),
    textMsg("b", "assistant", "beta"),
  ];
  const state = createInitialState();
  const res = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
    isProtected: hasUnrecoverableMediaPayload,
  });
  assert.equal(res.map.byRaw["dshimg"], "m00002");
});

// #6875 Q2: already-BLOCKED history needs no migration code — protection is
// re-evaluated every compress pass, so a fixed classifier lifts the pin and
// the #2607 migration mints a fresh number on the next pass.
test("legacy BLOCKED ref on DSH attachment media migrates to a fresh number (#6875)", () => {
  const messages = [
    textMsg("a", "user", "alpha"),
    sidecarMsg("dshimg", { rawOpenaiContentParts: [DSH_PART] }),
    textMsg("b", "assistant", "beta"),
  ];
  const state = createInitialState();
  state.messageRefs.byRaw["a"] = "m00001";
  state.messageRefs.byRaw["dshimg"] = BLOCKED_REF;
  state.messageRefs.byRaw["b"] = "m00002";
  const res = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 3,
    isProtected: hasUnrecoverableMediaPayload,
  });
  assert.equal(
    res.map.byRaw["dshimg"],
    "m00003",
    "fresh number — never a reuse",
  );
});

test("applyCompression records the DSH attachment id in the block summary (#6875)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    textMsg("u", "user", "the task"),
    sidecarMsg("img", { rawOpenaiContentParts: [DSH_PART] }),
    textMsg("t", "assistant", "analyzing"),
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
        summary: "folded work",
        topic: "t",
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
  assert.ok(block.summary.includes(MEDIA_REFS_MARKER));
  assert.ok(block.summary.includes(`- ${DSH_ID}`));
});
