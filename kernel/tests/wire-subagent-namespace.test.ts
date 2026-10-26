import { test } from "node:test";
import assert from "node:assert/strict";
import { subagentNamespace } from "../src/wire/responses.js";

test("subagentNamespace: first-seen instructions anchor the identity; identical instructions reuse it", () => {
  const id = "ns-unit-a";
  assert.equal(subagentNamespace(id, "You are Codex, the main agent."), id);
  assert.equal(subagentNamespace(id, "You are Codex, the main agent."), id);
});

test("subagentNamespace: differing instructions map to a stable separate |sub: namespace", () => {
  const id = "ns-unit-b";
  assert.equal(subagentNamespace(id, "main prompt"), id);
  const sub = subagentNamespace(id, "guardian prompt");
  assert.match(sub, /^ns-unit-b\|sub:[0-9a-f]{16}$/);
  assert.equal(
    subagentNamespace(id, "guardian prompt"),
    sub,
    "same subagent instructions reuse the sub namespace",
  );
  assert.notEqual(
    subagentNamespace(id, "reviewer prompt"),
    sub,
    "a different subagent gets its own namespace",
  );
  assert.equal(
    subagentNamespace(id, "main prompt"),
    id,
    "main conversation keeps the anchored namespace",
  );
});

test("subagentNamespace: absent or empty instructions never anchor or split", () => {
  const id = "ns-unit-c";
  assert.equal(subagentNamespace(id, undefined), id);
  assert.equal(subagentNamespace(id, "   "), id);
  assert.equal(subagentNamespace(id, "real prompt"), id);
});

import { createSubagentNamespaces } from "../src/wire/responses.js";

test("createSubagentNamespaces: instances own their anchor state independently", () => {
  const a = createSubagentNamespaces();
  const b = createSubagentNamespaces();
  assert.equal(a.namespaceFor("ns-iso", "main prompt"), "ns-iso");
  assert.equal(
    b.namespaceFor("ns-iso", "other prompt"),
    "ns-iso",
    "b anchors independently — no shared module state",
  );
  const subA = a.namespaceFor("ns-iso", "guardian prompt");
  assert.match(subA, /^ns-iso\|sub:[0-9a-f]{16}$/);
  assert.equal(
    a.namespaceFor("ns-iso", "main prompt"),
    "ns-iso",
    "a keeps its own anchor",
  );
  assert.equal(
    a.namespaceFor("ns-iso", "guardian prompt"),
    subA,
    "stable within the instance",
  );
});

test("createSubagentNamespaces: fresh instance re-anchors (restart semantics documented)", () => {
  const first = createSubagentNamespaces();
  assert.equal(first.namespaceFor("ns-restart", "main prompt"), "ns-restart");
  // Simulated restart: new instance, subagent request arrives FIRST — it
  // becomes the anchor, so the main prompt lands in a |sub: namespace.
  // This is the documented first-seen tradeoff; hosts needing
  // restart-stable namespaces must persist their own instance state.
  const second = createSubagentNamespaces();
  assert.equal(
    second.namespaceFor("ns-restart", "guardian prompt"),
    "ns-restart",
  );
  assert.match(
    second.namespaceFor("ns-restart", "main prompt"),
    /^ns-restart\|sub:[0-9a-f]{16}$/,
  );
});
