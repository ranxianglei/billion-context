import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateLargeToolOutputs } from "../src/truncate-tools.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import type { CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  type: CoreMessage["contentType"] = "text",
  extra: Partial<CoreMessage> = {},
): CoreMessage {
  return { id, role: "user", contentType: type, text, ...extra };
}

// #7771: the emergency-truncate path must hard-exclude protected tool-results
// (Kernel Boundary rule 6) exactly like the fold path — config.protectedTools
// means "this content must not be compressed away", and clipping it at the
// 95% watermark was the one lane that destroyed it.

test("isProtected: a protected size-qualified candidate is never clipped", () => {
  const cfg = defaultConfig(100000, { truncate: { threshold: 0.5 } });
  const big = "L".repeat(10000);
  const messages = [msg("prot", big, "tool-result")];
  const result = truncateLargeToolOutputs(
    messages,
    90000,
    cfg,
    (t) => t.length,
    {
      minOutputTokens: 100,
      keepPrefixChars: 100,
      keepSuffixChars: 100,
      protectRecentMessages: 0,
      isProtected: (m) => m.id === "prot",
    },
  );
  assert.equal(result.truncatedCount, 0);
  assert.equal(result.savedTokens, 0);
  assert.equal(result.messages[0]!.text, big);
  assert.equal(result.protectedExcluded, 1);
  // The protected candidate is NOT a truncatable candidate.
  assert.equal(result.candidatesFound, 0);
});

test("isProtected: non-protected candidates are still clipped alongside protected ones", () => {
  const cfg = defaultConfig(100000, { truncate: { threshold: 0.5 } });
  const big = "L".repeat(10000);
  const messages = [
    msg("prot", big, "tool-result"),
    msg("free", big, "tool-result"),
  ];
  const result = truncateLargeToolOutputs(
    messages,
    90000,
    cfg,
    (t) => t.length,
    {
      minOutputTokens: 100,
      keepPrefixChars: 100,
      keepSuffixChars: 100,
      protectRecentMessages: 0,
      isProtected: (m) => m.id === "prot",
    },
  );
  const prot = result.messages.find((m) => m.id === "prot")!;
  const free = result.messages.find((m) => m.id === "free")!;
  // Protected stays byte-identical; the free one is clipped.
  assert.equal(prot.text, big);
  assert.ok(free.text!.includes("[truncated for context space"));
  assert.equal(result.truncatedCount, 1);
  assert.equal(result.savedTokens > 0, true);
  assert.equal(result.protectedExcluded, 1);
  assert.deepEqual(result.truncatedIds, ["free"]);
});

test("isProtected: protectedExcluded counts every protected size-qualified candidate", () => {
  const cfg = defaultConfig(100000, { truncate: { threshold: 0.5 } });
  const big = "L".repeat(10000);
  const messages = [
    msg("p1", big, "tool-result"),
    msg("p2", big, "tool-result"),
    msg("p3", big, "tool-result"),
  ];
  const result = truncateLargeToolOutputs(
    messages,
    90000,
    cfg,
    (t) => t.length,
    {
      minOutputTokens: 100,
      keepPrefixChars: 100,
      keepSuffixChars: 100,
      protectRecentMessages: 0,
      isProtected: (m) => m.id.startsWith("p"),
    },
  );
  assert.equal(result.truncatedCount, 0);
  assert.equal(result.protectedExcluded, 3);
  assert.equal(result.candidatesFound, 0);
});

test("no isProtected: legacy behavior unchanged (everything size-qualified is clipped)", () => {
  const cfg = defaultConfig(100000, { truncate: { threshold: 0.5 } });
  const big = "L".repeat(10000);
  const messages = [msg("a", big, "tool-result")];
  const result = truncateLargeToolOutputs(
    messages,
    90000,
    cfg,
    (t) => t.length,
    {
      minOutputTokens: 100,
      keepPrefixChars: 100,
      keepSuffixChars: 100,
      protectRecentMessages: 0,
    },
  );
  assert.ok(result.truncatedCount >= 1);
  assert.equal(result.protectedExcluded, 0);
});

// Integration: the exact repro from the issue. A read_file tool-result that
// the host declared protected must survive the emergency-truncate watermark
// untouched — before the fix it was clipped to prefix+marker+suffix.
test("processTurn: protected tool-result survives the emergency watermark (#7771 repro)", () => {
  const core = createCore();
  const config = defaultConfig(1000, {
    protectedTools: ["read_file"],
    truncate: { threshold: 0.5, terminalEscapeAfter: 3 },
  });
  const big = "DURABLE-STATE " + "d".repeat(12_000);
  const messages: CoreMessage[] = [
    { id: "u0", role: "user", contentType: "text", text: "task" },
    {
      id: "c0",
      role: "assistant",
      contentType: "tool-call",
      toolName: "read_file",
      toolCallId: "cp",
      text: '{"path":"/durable"}',
    },
    {
      id: "tp",
      role: "tool",
      contentType: "tool-result",
      toolName: "read_file",
      toolCallId: "cp",
      text: big,
    },
    { id: "u1", role: "user", contentType: "text", text: "ok" },
    { id: "a1", role: "assistant", contentType: "text", text: "done" },
    { id: "u2", role: "user", contentType: "text", text: "next" },
  ];
  const r = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 900,
    renderTags: "none",
  });
  const out = r.messages.find((m) => m.id === "tp")!;
  // The protected result must be byte-identical — no truncation marker.
  assert.equal(out.text, big);
  assert.ok(!out.text!.includes("[truncated for context space"));
});
