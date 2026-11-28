import assert from "node:assert/strict";
import test from "node:test";
import {
  ANCHOR_SIDECAR_MARKER,
  appendAnchorSidecarSection,
  collectFoldAnchors,
  createCore,
  createInitialState,
  defaultConfig,
  extractMessageAnchors,
  parseAnchorSidecarSection,
  type CoreMessage,
} from "../src/index.js";

function msg(
  id: string,
  role: CoreMessage["role"],
  text: string,
  extra: Partial<CoreMessage> = {},
): CoreMessage {
  return { id, role, contentType: "text", text, ...extra };
}

test("extractMessageAnchors extracts tool paths, inline paths, errors, and durable IDs while rejecting secrets", () => {
  const m1 = msg(
    "m1",
    "assistant",
    JSON.stringify({ file_path: "/repo/src/image-rescale.ts", limit: 50 }),
    { contentType: "tool-call", toolName: "Read", toolCallId: "tc1" },
  );
  const m2 = msg(
    "m2",
    "user",
    [
      "Investigated src/server/prepare-anthropic.ts:142-168 for #7626 at commit 0a133d91 (v0.1.216).",
      "TypeError: Cannot read properties of undefined (reading 'media_type')",
      "ℹ fail 0",
      "Authorization: Bearer sk-live-secret-token-1234567890abcdef",
      "password=super-secret-value-99",
      "signed https://bucket.example.com/a.png?X-Amz-Signature=deadbeef",
    ].join("\n"),
  );

  const anchors = [
    ...extractMessageAnchors(m1),
    ...extractMessageAnchors(m2),
  ];
  const values = anchors.map((a) => `${a.kind}:${a.value}`);

  assert.ok(values.includes("path:/repo/src/image-rescale.ts"));
  assert.ok(values.includes("path:src/server/prepare-anthropic.ts:142-168"));
  assert.ok(
    values.some(
      (v) =>
        v.startsWith("error:") &&
        v.includes("TypeError: Cannot read properties of undefined"),
    ),
  );
  assert.ok(values.includes("id:#7626"));
  assert.ok(values.includes("id:0a133d91"));
  assert.ok(values.includes("id:v0.1.216"));
  // Benign test count line must not pollute error anchors
  assert.ok(!values.some((v) => v.includes("fail 0")));
  // Secret hygiene: none of the secret/token/signed-URL strings may ever leak
  for (const v of values) {
    assert.ok(!v.includes("sk-live-secret"), `secret leaked: ${v}`);
    assert.ok(!v.includes("super-secret"), `password leaked: ${v}`);
    assert.ok(!v.includes("X-Amz-Signature"), `signed URL leaked: ${v}`);
  }
});

test("appendAnchorSidecarSection + parseAnchorSidecarSection are idempotent and bounded by maxSectionChars", () => {
  const anchors = Array.from({ length: 30 }, (_, i) => ({
    kind: "path" as const,
    value: `src/module-${i}/handler-${i}.ts:${i + 10}`,
  }));
  const once = appendAnchorSidecarSection("Summary prose.", anchors, {
    enabled: true,
    maxAnchors: 16,
    maxSectionChars: 360,
  });
  const section = once.slice(once.indexOf(ANCHOR_SIDECAR_MARKER));
  assert.ok(
    section.length <= 360,
    `section exceeded cap: ${section.length} > 360`,
  );
  const parsed = parseAnchorSidecarSection(once);
  assert.ok(parsed.length > 0 && parsed.length < 16);
  // Idempotence: re-appending produces the exact same string
  const twice = appendAnchorSidecarSection(once, parsed, {
    enabled: true,
    maxAnchors: 16,
    maxSectionChars: 360,
  });
  assert.equal(twice, once);
});

test("createCore applyCompression: default-off stays byte-identical; enabled appends deterministic anchors & carries them across T2 distillation and MEDIA REFS", () => {
  const core = createCore();
  const makeHistory = (): CoreMessage[] => [
    msg(
      "u1",
      "user",
      "Fix TypeError in src/image-rescale.ts:173 for #7626 on v0.1.216 with commit 0a133d91. ".repeat(
        10,
      ),
    ),
    {
      ...msg(
        "a1",
        "assistant",
        "Read src/image-rescale.ts:173 and reproduced ERR_IMAGE_INFLATE across 16 samples. ".repeat(
          10,
        ),
      ),
      rawAnthropicBlock: {
        type: "image",
        source: { type: "url", url: "https://cdn.example.com/static/diagram.png" },
      },
    } as CoreMessage,
    msg(
      "u2",
      "user",
      "Now check kernel/src/compress.ts:2038 and fix AssertionError in tests/anchor.test.ts. ".repeat(
        10,
      ),
    ),
    msg(
      "a2",
      "assistant",
      "Verified kernel/src/compress.ts:2038 after #7804. ".repeat(10),
    ),
    msg("u3", "user", "Recent message kept outside protected zone check."),
    msg("a3", "assistant", "Recent assistant reply."),
    msg("u4", "user", "Current user prompt."),
  ];

  // 1. Default OFF: summary is byte-identical (no ANCHORS section)
  const offCfg = defaultConfig(200_000);
  offCfg.preserveRecentMessages = 2;
  offCfg.preserveRecentTokens = 0;
  offCfg.compress.minCompressRange = 50;
  const offHistory = makeHistory();
  const offTurn = core.processTurn({
    messages: offHistory,
    state: createInitialState(),
    config: offCfg,
  });
  const offRes = core.applyCompression({
    messages: offHistory,
    state: offTurn.state,
    config: offCfg,
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00002",
        summary:
          "Prose summary without exact paths or error strings, long enough to satisfy the default minSummaryLength gate.",
      },
    ],
  });
  assert.equal(offRes.result.blocksCreated, 1);
  assert.ok(!offRes.state.blocks[0]!.summary.includes(ANCHOR_SIDECAR_MARKER));

  // 2. Enabled ON: T1 fold appends ANCHORS alongside MEDIA REFS without bleeding
  const onCfg = defaultConfig(200_000);
  onCfg.preserveRecentMessages = 2;
  onCfg.preserveRecentTokens = 0;
  onCfg.compress.minCompressRange = 50;
  onCfg.anchorSidecar = { enabled: true, maxAnchors: 16, maxSectionChars: 1200 };
  const onHistory = makeHistory();
  const onTurn = core.processTurn({
    messages: onHistory,
    state: createInitialState(),
    config: onCfg,
  });
  const t1 = core.applyCompression({
    messages: onHistory,
    state: onTurn.state,
    config: onCfg,
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00002",
        summary: "Short prose for first span that omitted paths and error names.",
      },
      {
        startRef: "m00003",
        endRef: "m00004",
        summary: "Short prose for second span that omitted paths and error names.",
      },
    ],
  });
  assert.equal(t1.state.blocks.length, 2);
  const b1Summary = t1.state.blocks[0]!.summary;
  assert.ok(b1Summary.includes("MEDIA REFS"));
  assert.ok(b1Summary.includes("https://cdn.example.com/static/diagram.png"));
  assert.ok(b1Summary.includes(ANCHOR_SIDECAR_MARKER));
  assert.ok(b1Summary.includes("- path: src/image-rescale.ts:173"));
  assert.ok(b1Summary.includes("ERR_IMAGE_INFLATE"));
  assert.ok(b1Summary.includes("- id: #7626"));

  // 3. T2 distillation across b1..b2 carries forward BOTH MEDIA REFS and ANCHORS
  const turn2 = core.processTurn({
    messages: onHistory,
    state: t1.state,
    config: onCfg,
  });
  const t2 = core.applyCompression({
    messages: onHistory,
    state: turn2.state,
    config: onCfg,
    ranges: [
      {
        startRef: "b1",
        endRef: "b2",
        summary:
          "High-level T2 summary where the model dropped every path, error, and issue id.",
      },
    ],
  });
  const b3 = t2.state.blocks.find((b) => b.blockId === "b3")!;
  assert.equal(b3.tier, 2);
  assert.ok(b3.summary.includes("https://cdn.example.com/static/diagram.png"));
  assert.ok(b3.summary.includes(ANCHOR_SIDECAR_MARKER));
  assert.ok(b3.summary.includes("- path: src/image-rescale.ts:173"));
  assert.ok(b3.summary.includes("- path: kernel/src/compress.ts:2038"));
  assert.ok(b3.summary.includes("- id: #7626"));
  assert.ok(b3.summary.includes("- id: #7804"));

  // 4. Refold (in-place summary rewrite of a restored T1 block) preserves ANCHORS & MEDIA REFS
  const restoredState = {
    ...t1.state,
    blocks: t1.state.blocks.map((b) =>
      b.blockId === "b1" ? { ...b, restoredInline: true } : b,
    ),
  };
  const turn3 = core.processTurn({
    messages: onHistory,
    state: restoredState,
    config: onCfg,
  });
  const refold = core.applyCompression({
    messages: onHistory,
    state: turn3.state,
    config: onCfg,
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00002",
        summary:
          "Refolded prose summary replacing the earlier text while omitting every explicit anchor path and issue number.",
      },
    ],
  });
  const b1After = refold.state.blocks.find((b) => b.blockId === "b1")!;
  assert.equal(b1After.restoredInline, false);
  assert.ok(b1After.summary.includes("https://cdn.example.com/static/diagram.png"));
  assert.ok(b1After.summary.includes(ANCHOR_SIDECAR_MARKER));
  assert.ok(b1After.summary.includes("- path: src/image-rescale.ts:173"));
  assert.ok(b1After.summary.includes("- id: #7626"));

  // Verify balanced collector never throws on empty inputs
  assert.deepEqual(collectFoldAnchors([], []), []);
});
