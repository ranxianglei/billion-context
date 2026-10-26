import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "../src/index.js";
import {
  collectLatestProtected,
  collectProtectedToolCallIds,
  isMessageLatestProtected,
  isMessageProtected,
  isMessageProtectedWithPairing,
  matchToolPath,
  matchToolMessagePattern,
  toolPathOf,
} from "../src/protected.js";

function skillCall(
  id: string,
  callId: string,
  args: Record<string, unknown> | string,
  toolName = "skill",
): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId: callId,
    text: typeof args === "string" ? args : JSON.stringify(args),
  };
}

function toolCall(
  id: string,
  callId: string,
  toolName: string,
  text: string,
): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId: callId,
    text,
  };
}

function result(id: string, callId: string, toolName?: string): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolCallId: callId,
    toolName,
    text: "ok",
  };
}

test("toolPathOf projects the three client shapes to skill/<name>", () => {
  // opencode: skill({name})
  assert.equal(
    toolPathOf(skillCall("a", "c1", { name: "review-loop" })),
    "skill/review-loop",
  );
  // Claude Code / ZCode: Skill({skill})
  assert.equal(
    toolPathOf(skillCall("b", "c2", { skill: "release-orchestrator" }, "Skill")),
    "skill/release-orchestrator",
  );
  // pi: any tool reading <dir>/<name>/SKILL.md
  assert.equal(
    toolPathOf(
      toolCall(
        "c",
        "c3",
        "read",
        JSON.stringify({ path: "/home/u/.pi/skills/review-loop/SKILL.md" }),
      ),
    ),
    "skill/review-loop",
  );
  // bash cat of a skill file projects too
    assert.equal(
      toolPathOf(toolCall("d", "c4", "bash", JSON.stringify({ command: "cat skills/audit-checklist/SKILL.md" }))),
      "skill/audit-checklist",
    );
  // Windows pi shape: backslash separators (escaped in the raw JSON text)
    assert.equal(
      toolPathOf(
        toolCall(
          "e",
          "c5",
          "read",
          JSON.stringify({ path: "C:\\Users\\u\\.pi\\skills\\release-notes\\SKILL.md" }),
        ),
      ),
      "skill/release-notes",
    );
});

test("toolPathOf degrades to the tool name when no skill identity is found", () => {
  // skill tool with unparseable / invalid args
  assert.equal(toolPathOf(skillCall("a", "c1", "not json")), "skill");
  assert.equal(
    toolPathOf(skillCall("b", "c2", { name: "has space" })),
    "skill",
  );
  assert.equal(toolPathOf(skillCall("c", "c3", { other: 1 })), "skill");
  // ordinary tools stay their own name
  assert.equal(
    toolPathOf(toolCall("d", "c4", "read", JSON.stringify({ path: "/tmp/x.ts" }))),
    "read",
  );
  // tool-result projects to the bare tool name (pairing covers the result half)
  assert.equal(toolPathOf(result("e", "c1", "Skill")), "Skill");
});

test("matchToolPath implements the three path-pattern forms", () => {
  // single segment: node + all descendants, ≡ X/*
  assert.ok(matchToolPath("skill/review-loop", "skill"));
  assert.ok(matchToolPath("skill", "skill"));
  assert.ok(!matchToolPath("read", "skill"));
  // X/* ≡ X
  assert.ok(matchToolPath("skill/review-loop", "skill/*"));
  assert.ok(matchToolPath("skill", "skill/*"));
  assert.ok(!matchToolPath("read", "skill/*"));
  // named path: every load of that one skill
  assert.ok(matchToolPath("skill/release-orchestrator", "skill/release-orchestrator"));
  assert.ok(!matchToolPath("skill/release-orchestrator-v2", "skill/release-orchestrator"));
  // glob inside the name segment, * never crosses /
  assert.ok(matchToolPath("skill/review-loop", "skill/review-*"));
  assert.ok(matchToolPath("skill/review", "skill/review*"));
  assert.ok(!matchToolPath("skill/release", "skill/review-*"));
  assert.ok(!matchToolPath("skill", "skill/review-*"));
  // case-insensitive on both the tool and name segments (#1725)
  assert.ok(matchToolPath("skill/Review-Loop", "SKILL/review-loop"));
  assert.ok(matchToolPath("skill/review-loop", "SKILL/*"));
  // deep pattern never matches a shorter path
  assert.ok(!matchToolPath("skill/review-loop", "skill/review-loop/x"));
});

test("matchToolMessagePattern keeps bare tool-name matches monotonic", () => {
  // a SKILL.md read still matches a plain `read` pattern (pre-path behavior)
  assert.ok(
    matchToolMessagePattern(
      toolCall("a", "c1", "read", JSON.stringify({ path: "skills/x/SKILL.md" })),
      "read",
    ),
  );
  // and the same read now also matches skill patterns via its path
  assert.ok(
    matchToolMessagePattern(
      toolCall("a", "c1", "read", JSON.stringify({ path: "skills/x/SKILL.md" })),
      "skill/x",
    ),
  );
});

test("isMessageProtected matches path patterns for protectedTools", () => {
  const config = { protectedTools: ["skill/release-orchestrator"] };
  assert.ok(
    isMessageProtected(
      skillCall("a", "c1", { skill: "release-orchestrator" }, "Skill"),
      config,
    ),
  );
  assert.ok(
    isMessageProtected(
      toolCall("b", "c2", "read", JSON.stringify({ path: "skills/release-orchestrator/SKILL.md" })),
      config,
    ),
  );
  assert.ok(
    !isMessageProtected(skillCall("c", "c3", { name: "review-loop" }), config),
  );
  // degenerate skill tool call still matches a bare `skill` pattern
  assert.ok(
    isMessageProtected(skillCall("d", "c4", "no json"), {
      protectedTools: ["skill"],
    }),
  );
});

test("collectProtectedToolCallIds + pairing covers results of path-protected calls", () => {
  const config = { protectedTools: ["skill/release-orchestrator"] };
  const messages = [
    skillCall("a", "c1", { skill: "release-orchestrator" }, "Skill"),
    result("b", "c1"),
  ];
  const ids = collectProtectedToolCallIds(messages, config);
  assert.ok(ids.has("c1"));
  // the result half (no toolName) is protected through pairing, not its own name
  assert.ok(!isMessageProtected(messages[1], config));
  assert.ok(isMessageProtectedWithPairing(messages[1], config, ids));
});

test("collectLatestProtected: path patterns keep the latest instance PER path", () => {
  const messages = [
    skillCall("a", "c1", { name: "review-loop" }),
    result("b", "c1"),
    skillCall("c", "c2", { name: "audit-checklist" }),
    result("d", "c2"),
    skillCall("e", "c3", { name: "review-loop" }),
    result("f", "c3"),
  ];
  const latest = collectLatestProtected(messages, {
    protectedLatestTools: ["skill/*"],
  });
  // newest load of EACH skill survives, not just one overall
  assert.ok(!latest.callIds.has("c1"));
  assert.ok(latest.callIds.has("c2"));
  assert.ok(latest.callIds.has("c3"));
  // paired results are covered through the call ids
  assert.ok(isMessageLatestProtected(messages[1], latest) === false);
  assert.ok(isMessageLatestProtected(messages[5], latest));
});

test("collectLatestProtected: plain patterns keep single-latest semantics", () => {
  const messages = [
    skillCall("a", "c1", { name: "review-loop" }),
    skillCall("b", "c2", { name: "audit-checklist" }),
  ];
  const latest = collectLatestProtected(messages, {
    protectedLatestTools: ["skill"],
  });
  assert.ok(!latest.callIds.has("c1"));
  assert.ok(latest.callIds.has("c2"));
});

test("collectLatestProtected: named path pattern tracks its own skill only", () => {
  const messages = [
    skillCall("a", "c1", { name: "review-loop" }),
    skillCall("b", "c2", { name: "release-orchestrator" }, "Skill"),
    skillCall("c", "c3", { name: "review-loop" }),
  ];
  const latest = collectLatestProtected(messages, {
    protectedLatestTools: ["skill/review-*"],
  });
  assert.ok(latest.callIds.has("c3"));
  assert.ok(!latest.callIds.has("c1"));
  assert.ok(!latest.callIds.has("c2"));
});
