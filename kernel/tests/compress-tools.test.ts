import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPRESS_TOOL,
  COMPRESS_TOOL_OPENAI,
  COMPRESS_TOOL_RESPONSES,
  ACP_TOOLS_OPENAI,
  ACP_TOOLS_ANTHROPIC,
  ACP_TOOLS_RESPONSES,
  ACP_READONLY_TOOLS_RESPONSES,
  ACP_TOOL_NAMES,
  ACP_MUTATING_TOOLS,
  ACP_READONLY_TOOLS,
  ACP_TEXT_OPEN,
  ACP_TEXT_CLOSE,
  ACP_STATUS_OPEN,
  ACP_STATUS_CLOSE,
  ACP_SEARCH_OPEN,
  ACP_SEARCH_CLOSE,
  ACP_DECOMPRESS_OPEN,
  ACP_DECOMPRESS_CLOSE,
  buildCompressSystemPrompt,
  buildCompressTextSystemPrompt,
  buildCompressHybridSystemPrompt,
  parseCompressInput,
} from "../src/compress-tools.js";

test("ACP tool sets classify every ACP tool by mutation semantics", () => {
  assert.deepEqual([...ACP_TOOL_NAMES].sort(), [
    "acp_cache",
    "acp_status",
    "compress",
    "decompress",
    "search_context",
  ]);
  assert.deepEqual([...ACP_MUTATING_TOOLS].sort(), ["compress", "decompress"]);
  assert.deepEqual([...ACP_READONLY_TOOLS].sort(), [
    "acp_cache",
    "acp_status",
    "search_context",
  ]);
});

test("tool arrays expose compress in every wire format", () => {
  const names = (arr: Array<{ name?: string; function?: { name?: string } }>) =>
    arr.map((t) => t.name ?? t.function?.name);
  assert.ok(names(ACP_TOOLS_ANTHROPIC).includes("compress"));
  assert.ok(names(ACP_TOOLS_OPENAI).includes("compress"));
  assert.ok(names(ACP_TOOLS_RESPONSES).includes("compress"));
  assert.equal(names(ACP_READONLY_TOOLS_RESPONSES).includes("compress"), false);
  assert.equal(COMPRESS_TOOL.name, "compress");
  assert.equal(COMPRESS_TOOL_OPENAI.function?.name, "compress");
  assert.deepEqual(
    COMPRESS_TOOL_OPENAI.function.parameters.properties.content.anyOf.map(
      (entry) => entry.type,
    ),
    ["array", "string"],
  );
});

test("text tags are paired delimiters", () => {
  assert.equal(ACP_TEXT_OPEN, "<acp_compress>");
  assert.equal(ACP_TEXT_CLOSE, "</acp_compress>");
  assert.ok(ACP_STATUS_OPEN.startsWith("<acp_status"));
  assert.ok(ACP_STATUS_CLOSE.startsWith("</acp_status"));
  assert.ok(ACP_SEARCH_OPEN.startsWith("<acp_search"));
  assert.ok(ACP_SEARCH_CLOSE.startsWith("</acp_search"));
  assert.ok(ACP_DECOMPRESS_OPEN.startsWith("<acp_decompress"));
  assert.ok(ACP_DECOMPRESS_CLOSE.startsWith("</acp_decompress"));
});

test("prompt builders produce non-empty guidance mentioning the compress tool", () => {
  for (const p of [
    buildCompressSystemPrompt(),
    buildCompressTextSystemPrompt(),
    buildCompressHybridSystemPrompt(),
  ]) {
    assert.ok(p.includes("compress"));
    assert.ok(p.length > 1000);
  }
  assert.ok(buildCompressTextSystemPrompt().includes(ACP_TEXT_OPEN));
  assert.ok(buildCompressHybridSystemPrompt().includes(ACP_TEXT_OPEN));
});

test("parseCompressInput accepts single object, array content, and JSON-string content", () => {
  const warns: string[] = [];
  const onWarn = (m: string) => warns.push(m);
  const range = {
    startId: "m00001",
    endId: "m00005",
    summary: "s",
    topic: "t",
  };
  const single = parseCompressInput(range, "call-1", onWarn);
  assert.equal(single.length, 1);
  assert.equal(single[0]?.compressCallId, "call-1");
  assert.equal(single[0]?.startRef, "m00001");
  assert.equal(single[0]?.endRef, "m00005");
  const arr = parseCompressInput(
    { content: [range, { startId: "m00006", endId: "m00009", summary: "s2" }] },
    "call-2",
    onWarn,
  );
  assert.equal(arr.length, 2);
  assert.equal(arr[1]?.topic, undefined);
  // JSON-string content field (non-strict providers stringify array args)
  const json = parseCompressInput(
    { content: JSON.stringify([range]) },
    "call-3",
    onWarn,
  );
  assert.equal(json.length, 1);
  assert.equal(json[0]?.topic, "t");
  // endId/endRef spellings both accepted
  assert.equal(
    parseCompressInput(
      { startRef: "m1", endRef: "m2", summary: "s" },
      "c",
      onWarn,
    ).length,
    1,
  );
  assert.deepEqual(warns, []);
});

test("parseCompressInput rejects malformed payloads and warns", () => {
  const warns: string[] = [];
  const onWarn = (m: string) => warns.push(m);
  assert.deepEqual(parseCompressInput(null, "c", onWarn), []);
  assert.deepEqual(parseCompressInput({ content: "nope" }, "c", onWarn), []);
  assert.deepEqual(
    parseCompressInput({ content: [{ startId: "m1" }] }, "c", onWarn),
    [],
  );
  assert.ok(warns.length > 0);
});
