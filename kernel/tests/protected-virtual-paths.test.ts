import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMessageProtected,
  collectLatestProtected,
  isMessageLatestProtected,
  virtualToolPathOf,
} from "../src/protected.js";
import { defaultConfig } from "../src/config.js";
import type { CoreMessage } from "../src/types.js";

// #2446 family: host-projected VIRTUAL TOOL PATHS. A host classifier maps
// plain-text durable-state carriers to canonical `durable/<name>` paths via
// Config.messagePathOf; the SAME protectedTools / protectedLatestTools
// pattern machinery that governs tool exchanges then governs them. Tool
// exchanges are never re-projected.

function text(id: string, t: string): CoreMessage {
  return { id, role: "user", contentType: "text", text: t };
}

function toolCall(id: string, toolName: string, callId: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId: callId,
    text: "{}",
  };
}

/** Classifier fixture: `<catalog>` text → durable/skill-catalog, `<rules>` →
 *  durable/agents-md; a tool-call carrying the same marker text must be
 *  IGNORED (projection domain is non-tool messages only). */
function classifier(msg: CoreMessage): string | undefined {
  if (msg.contentType === "tool-call" || msg.contentType === "tool-result") {
    return "should-never-be-consulted";
  }
  if (msg.text?.includes("<catalog>")) return "durable/skill-catalog";
  if (msg.text?.includes("<rules>")) return "durable/agents-md";
  return undefined;
}

function cfg(overrides: Partial<Parameters<typeof isMessageProtected>[1]>) {
  const base = defaultConfig(200_000);
  return { ...base, messagePathOf: classifier, ...overrides } as Parameters<
    typeof isMessageProtected
  >[1];
}

test("virtualToolPathOf: never projects tool exchanges, passes through text", () => {
  const c = { messagePathOf: classifier };
  assert.equal(virtualToolPathOf(text("t1", "<catalog>"), c), "durable/skill-catalog");
  assert.equal(virtualToolPathOf(text("t2", "plain"), c), undefined);
  assert.equal(
    virtualToolPathOf(toolCall("c1", "skill", "call-1"), c),
    undefined,
    "tool-call is never re-projected even when the classifier could match",
  );
  assert.equal(virtualToolPathOf({ ...toolCall("c2", "skill", "call-2"), text: "<catalog>" }, c), undefined);
});

test("protectedTools patterns govern virtual paths: exact, first-segment, and glob", () => {
  const catalog = text("t1", "<catalog>");
  assert.equal(
    isMessageProtected(catalog, cfg({ protectedTools: ["durable/skill-catalog"] })),
    true,
    "exact path pattern protects the matching carrier",
  );
  assert.equal(
    isMessageProtected(catalog, cfg({ protectedTools: ["durable"] })),
    true,
    "a single-segment pattern matches the first path segment (durable ≡ durable/*)",
  );
  assert.equal(
    isMessageProtected(catalog, cfg({ protectedTools: ["durable/*"] })),
    true,
    "glob covers every durable identity",
  );
  assert.equal(
    isMessageProtected(text("t2", "<rules>"), cfg({ protectedTools: ["durable/skill-catalog"] })),
    false,
    "a pattern for ANOTHER identity does not protect this carrier",
  );
  assert.equal(
    isMessageProtected(text("t3", "plain prose"), cfg({ protectedTools: ["durable/*"] })),
    false,
    "unclassified text stays consumable",
  );
  assert.equal(
    isMessageProtected(catalog, cfg({ protectedTools: [] })),
    false,
    "no patterns → no protection (policy lives in config)",
  );
  // Case-insensitivity parity with the tool channel (#1725):
  assert.equal(
    isMessageProtected(catalog, cfg({ protectedTools: ["Durable/Skill-Catalog"] })),
    true,
    "pattern matching stays case-insensitive on both sides",
  );
});

test("virtual-path protection composes with tool-channel protection in one config", () => {
  const c = cfg({ protectedTools: ["read"] });
  assert.equal(isMessageProtected(toolCall("c1", "read", "call-1"), c), true, "tool channel unchanged");
  assert.equal(isMessageProtected(text("t1", "<catalog>"), c), false, "durable/* not configured → text unprotected");
  const c2 = cfg({ protectedTools: ["read", "durable/*"] });
  assert.equal(isMessageProtected(toolCall("c2", "read", "call-2"), c2), true);
  assert.equal(isMessageProtected(text("t2", "<catalog>"), c2), true, "both channels protected together");
});

test("protectedLatestTools path patterns keep the LATEST instance per durable identity", () => {
  const messages = [
    text("a", "<catalog> v1"),
    text("b", "plain filler"),
    text("c", "<catalog> v2"), // newest skill-catalog
    text("d", "<rules> v1"), // only agents-md instance
  ];
  const latest = collectLatestProtected(messages, cfg({ protectedLatestTools: ["durable/*"], protectedTools: [] }));
  assert.equal(isMessageLatestProtected(text("a", "<catalog> v1"), latest), false, "older catalog instance is foldable");
  assert.equal(isMessageLatestProtected(text("c", "<catalog> v2"), latest), true, "newest catalog instance survives");
  assert.equal(isMessageLatestProtected(text("d", "<rules> v1"), latest), true, "every identity keeps its own latest");
  assert.equal(isMessageLatestProtected(text("b", "plain filler"), latest), false);
});

test("protectedLatestTools plain-name patterns: virtual carriers join single-latest semantics", () => {
  const messages = [text("a", "<catalog> v1"), text("b", "<rules> v1"), text("c", "<catalog> v2")];
  const latest = collectLatestProtected(messages, cfg({ protectedLatestTools: ["durable"], protectedTools: [] }));
  assert.equal(isMessageLatestProtected(text("a", "<catalog> v1"), latest), false);
  assert.equal(isMessageLatestProtected(text("b", "<rules> v1"), latest), false, "not the latest durable carrier overall");
  assert.equal(isMessageLatestProtected(text("c", "<catalog> v2"), latest), true, "the LAST durable carrier wins");
});

test("protectedLatestTools for TOOLS is unchanged when a classifier is attached", () => {
  const messages = [
    toolCall("c1", "todo_list", "call-1"),
    toolCall("c2", "todo_list", "call-2"),
    text("t", "<catalog>"),
  ];
  const latest = collectLatestProtected(messages, cfg({ protectedLatestTools: ["todo_list"] }));
  assert.equal(isMessageLatestProtected(messages[0]!, latest), false, "older todo_list still foldable");
  assert.equal(isMessageLatestProtected(messages[1]!, latest), true, "newest todo_list still protected");
  assert.equal(isMessageLatestProtected(messages[2]!, latest), false, "carrier not in latest scope (pattern is tool-only)");
});
