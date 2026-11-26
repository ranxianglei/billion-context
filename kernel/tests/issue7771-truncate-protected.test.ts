import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateLargeToolOutputs } from "../src/truncate-tools.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import type { Config, CoreMessage } from "../src/types.js";

const BIG = (tag: string) => `${tag} ` + "x".repeat(12_000);

function config(protectedTools: string[]): Config {
  return defaultConfig(1000, {
    protectedTools,
    truncate: { threshold: 0.5, terminalEscapeAfter: 3 },
  });
}

function toolPair(id: string, toolName: string, text: string): CoreMessage[] {
  return [
    { id: `${id}-call`, role: "assistant", contentType: "tool-call", toolName, toolCallId: id, text: `{"path":"/${id}"}` },
    { id, role: "tool", contentType: "tool-result", toolName, toolCallId: id, text },
  ];
}

test("#7771 protected candidates are spent AFTER unprotected ones", () => {
  const cfg = config(["read_file"]);
  const messages: CoreMessage[] = [
    ...toolPair("p", "read_file", BIG("protected")),
    ...toolPair("u", "search", BIG("plain")),
    { id: "t1", role: "user", contentType: "text", text: "a" },
    { id: "t2", role: "assistant", contentType: "text", text: "b" },
    { id: "t3", role: "user", contentType: "text", text: "c" },
  ];
  const result = truncateLargeToolOutputs(messages, 900, cfg, (text) => Math.ceil(text.length / 4), {
    protectRecentMessages: 3,
    includeTextMessages: true,
    protectedIds: new Set(["p"]),
  });
  assert.deepEqual(result.truncatedIds, ["u"], "unprotected result is clipped first");
  assert.equal(result.truncatedCount, 1);
  assert.ok((result.messages.find((m) => m.id === "p")!.text ?? "").length > 12_000);
});

test("#7771 a sole protected candidate is still clipped rather than overflowing", () => {
  const cfg = config(["read_file"]);
  const messages: CoreMessage[] = [
    ...toolPair("p", "read_file", BIG("protected")),
    { id: "t1", role: "user", contentType: "text", text: "a" },
    { id: "t2", role: "assistant", contentType: "text", text: "b" },
    { id: "t3", role: "user", contentType: "text", text: "c" },
  ];
  const result = truncateLargeToolOutputs(messages, 900, cfg, (text) => Math.ceil(text.length / 4), {
    protectRecentMessages: 3,
    includeTextMessages: true,
    protectedIds: new Set(["p"]),
  });
  assert.deepEqual(result.truncatedIds, ["p"]);
  assert.ok(result.savedTokens > 0);
});

test("#7771 emergency-truncate node honors protectedTools end to end", () => {
  const cfg = config(["read_file"]);
  const core = createCore();
  const messages: CoreMessage[] = [
    ...toolPair("p", "read_file", BIG("DURABLE-STATE")),
    ...toolPair("u", "search", BIG("plain-output")),
    { id: "t1", role: "user", contentType: "text", text: "a" },
    { id: "t2", role: "assistant", contentType: "text", text: "b" },
    { id: "t3", role: "user", contentType: "text", text: "c" },
  ];
  const result = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg,
    tokenCount: 900,
    renderTags: "none",
  });
  const protectedText = result.messages.find((m) => m.id === "p")!.text ?? "";
  const plainText = result.messages.find((m) => m.id === "u")!.text ?? "";
  assert.ok(!protectedText.includes("[truncated for context space]"), "protected result untouched");
  assert.ok(plainText.includes("[truncated for context space]"), "plain result clipped");
  assert.ok(protectedText.length > plainText.length);
});
