import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openaiToCore,
  coreToOpenai,
  injectOpenaiSystem,
} from "../src/wire/openai.js";
import { mirrorOpenaiToCore } from "../src/wire/mirror.js";
import type { MirrorMessage } from "../src/wire/mirror.js";

const conv: Array<Record<string, unknown>> = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi there" },
  { role: "user", content: "what is 2+2" },
  { role: "assistant", content: "4" },
];

test("openaiToCore hoists the contiguous leading system/developer prefix out of the fold space", () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "you are terse" },
      { role: "developer", content: "second system part" },
      ...conv,
    ],
  };
  const { msgs, systemText } = openaiToCore(body as never);
  assert.equal(systemText, "you are terse\n\nsecond system part");
  assert.ok(msgs.length > 0);
  assert.notEqual(msgs[0].role, "system");
  assert.ok(
    msgs.every((m) => m.role !== "system"),
    "no system pieces remain in the fold space",
  );
  // conversation ids unchanged vs a body with no system prefix at all
  const bare = openaiToCore({ model: "m", messages: conv } as never);
  assert.deepEqual(
    msgs.map((m) => m.id),
    bare.msgs.map((m) => m.id),
  );
});

test("openaiToCore with no system prefix returns empty systemText", () => {
  const { systemText } = openaiToCore({ model: "m", messages: conv } as never);
  assert.equal(systemText, "");
});

test("mid-conversation system messages stay in the fold space", () => {
  const { msgs } = openaiToCore({
    model: "m",
    messages: [
      ...conv.slice(0, 2),
      { role: "system", content: "mid-stream system" },
      ...conv.slice(2),
    ],
  } as never);
  assert.equal(
    msgs.filter((m) => m.role === "system").length,
    1,
    "mid-stream system kept as a fold piece",
  );
});

test("system content changes never shift conversation ids (restart regression)", () => {
  // Live wire carries the host system prompt; after restart the prime-fold
  // reconstruction differs. Ids must not depend on system content, or every
  // span fingerprint covering pos 0 breaks and restart replay is rejected.
  const a = openaiToCore({
    model: "m",
    messages: [
      { role: "system", content: "LIVE system, 45k chars of host state" },
      ...conv,
    ],
  } as never);
  const b = openaiToCore({
    model: "m",
    messages: [
      { role: "system", content: "RECONSTRUCTED system, shorter" },
      ...conv,
    ],
  } as never);
  assert.deepEqual(
    a.msgs.map((m) => m.id),
    b.msgs.map((m) => m.id),
  );
});

test("mirrorOpenaiToCore converges with the live space regardless of systemText", () => {
  const t = (text: string): MirrorMessage => ({
    role: "user",
    blocks: [{ type: "text", text }],
  });
  const a = (text: string): MirrorMessage => ({
    role: "assistant",
    blocks: [{ type: "text", text }],
  });
  const view: MirrorMessage[] = [
    t("hello"),
    a("hi there"),
    t("what is 2+2"),
    a("4"),
  ];
  const live = openaiToCore({ model: "m", messages: conv } as never);
  const mirrorA = mirrorOpenaiToCore(view, "live 45k system");
  const mirrorB = mirrorOpenaiToCore(view, "");
  assert.deepEqual(
    mirrorA.map((m) => m.id),
    live.msgs.map((m) => m.id),
  );
  assert.deepEqual(
    mirrorB.map((m) => m.id),
    live.msgs.map((m) => m.id),
  );
});

test("coreToOpenai output has no head system; injectOpenaiSystem re-injects it", () => {
  const { msgs, systemText } = openaiToCore({
    model: "m",
    messages: [{ role: "system", content: "you are terse" }, ...conv],
  } as never);
  const rebuilt = coreToOpenai(msgs);
  assert.notEqual(rebuilt[0]?.role, "system");
  const withSystem = injectOpenaiSystem(rebuilt, [
    systemText,
    "compress prompt",
  ]);
  assert.equal(withSystem[0]?.role, "system");
  assert.match(String(withSystem[0]?.content), /you are terse/);
  assert.match(String(withSystem[0]?.content), /compress prompt/);
});
