import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport } from "../src/report.js";
import { createInitialState } from "../src/state.js";
import { defaultCountTokens } from "../src/tokenize.js";
import { indexToRef } from "../src/refs.js";
import type { CoreMessage } from "../src/types.js";

const messages: CoreMessage[] = [
  {
    id: "m1",
    role: "user",
    contentType: "text",
    text: "hello world, enough text to register",
  },
];

function stateWithBlock(): ReturnType<typeof createInitialState> {
  const state = createInitialState();
  messages.forEach((m, i) => {
    const ref = indexToRef(i + 1);
    state.messageRefs.byRaw[m.id] = ref;
    state.messageRefs.byRef[ref] = m.id;
  });
  state.blocks.push({
    blockId: "b1",
    runId: "r1",
    tier: 2,
    summary: "folded history",
    directMessageIds: ["m1"],
    effectiveMessageIds: ["m1"],
    directBlockIds: [],
    compressedTokens: 40,
    createdAt: 1,
    survivedCount: 0,
    generation: "young",
    active: true,
  });
  return state;
}

const noMeta = buildStatusReport(
  createInitialState(),
  messages,
  defaultCountTokens,
);

test("overview renders a leading ACTIVE SURFACE line when meta is declared", () => {
  const report = buildStatusReport(
    createInitialState(),
    messages,
    defaultCountTokens,
    {
      meta: {
        pack: "lean",
        packVersion: "3",
        host: "billion-context-pi 0.1.69",
      },
    },
  );
  const lines = report.split("\n");
  assert.equal(
    lines[0],
    "ACTIVE SURFACE: pack=lean v3 | host=billion-context-pi 0.1.69",
  );
  assert.equal(lines[1], "");
  assert.equal(lines[2], "CONTEXT BREAKDOWN");
});

test("overview stays byte-identical when no meta is passed", () => {
  const report = buildStatusReport(
    createInitialState(),
    messages,
    defaultCountTokens,
    {
      meta: undefined,
    },
  );
  assert.equal(report, noMeta);
  assert.ok(!report.includes("ACTIVE SURFACE"));
});

test("meta without host or version renders pack only", () => {
  const report = buildStatusReport(
    createInitialState(),
    messages,
    defaultCountTokens,
    {
      meta: { pack: "default" },
    },
  );
  assert.ok(report.includes("ACTIVE SURFACE: pack=default\n"));
});

test("meta with only host renders host only", () => {
  const report = buildStatusReport(
    createInitialState(),
    messages,
    defaultCountTokens,
    {
      meta: { host: "billion-context" },
    },
  );
  assert.ok(report.includes("ACTIVE SURFACE: host=billion-context\n"));
});

test("empty meta object renders nothing", () => {
  const report = buildStatusReport(
    createInitialState(),
    messages,
    defaultCountTokens,
    { meta: {} },
  );
  assert.equal(report, noMeta);
});

test("compressed drilldown renders a leading ACTIVE SURFACE line", () => {
  const state = stateWithBlock();
  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "compressed",
    meta: { pack: "lean", packVersion: "3" },
  });
  const lines = report.split("\n");
  assert.equal(lines[0], "ACTIVE SURFACE: pack=lean v3");
  assert.equal(lines[1], "");
  assert.ok((lines[2] ?? "").startsWith("COMPRESSED — 1 blocks"));
});

test("uncompressed views never get the surface line", () => {
  const state = stateWithBlock();
  const options = [
    { scope: "uncompressed" as const },
    { scope: "uncompressed" as const, view: "messages" as const },
  ];
  for (const o of options) {
    const report = buildStatusReport(state, messages, defaultCountTokens, {
      ...o,
      meta: { pack: "lean", packVersion: "3", host: "billion-context" },
    });
    assert.ok(!report.includes("ACTIVE SURFACE"));
  }
});
